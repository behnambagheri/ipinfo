import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { usageDatabase } from './helpers/usage-db.mjs';
import { usageEvent, workerSite, containerSite } from '../worker/statistics.mjs';
import { visitorEvent, validateVisitorReport, visitorFilters, retentionStart } from '../worker/visitors.mjs';
import { WorkerVisitors, visitorCollectionResponse } from '../worker/visitors-store.mjs';
import { WorkerStatistics, collectionResponse } from '../worker/statistics-store.mjs';
import { authorizedAdmin } from '../worker/admin-auth.mjs';
import { adminResponse } from '../worker/admin.mjs';
import { handleCloudflareRequest } from '../worker/cloudflare.mjs';
import { handleRequest } from '../worker/index.mjs';
import { ContainerStatistics } from '../server/statistics.mjs';
import { createHTTPServer } from '../server/index.mjs';
import { serverConfig } from '../server/config.mjs';
import { LocalDatabases, openDatabases } from '../server/databases.mjs';
import { writeFixtures } from './server-fixtures.mjs';

const token = 't'.repeat(64), now = new Date('2026-10-10T12:00:00.000Z');
const env = { IPINFO_STATS_REPORT_TOKEN: token, IPINFO_VISITOR_STATS_ENABLED: 'true' };
const request = (path, headers = {}) => new Request(`https://${workerSite}${path}`, { headers: { 'CF-Connecting-IP': '8.8.8.8', ...headers } });
const event = (ip = '8.8.8.8', time = now, data = { country: 'United States', city: 'Mountain View', asn_org: 'Google LLC' }) => visitorEvent(usageEvent(request('/json'), new Response(''), time), ip, data);
const filters = (query = '', time = now) => visitorFilters(new URL(`https://${workerSite}/admin/usage.json?${query}`), time);

test('private counts preserve source identity, response classification and missing geolocation', async () => {
  const recorded = [], aggregate = [];
  const lookup = [];
  const response = await handleRequest(request('/json?ip=1.1.1.1', { 'X-Forwarded-For': '9.9.9.9' }), { LOCAL_GEOIP: { lookup(ip) { lookup.push(ip); return { ip, country: ip === '8.8.8.8' ? 'United States' : 'Australia', city: 'Test city', asn_org: 'Test provider' }; } } },
    { visitors: { record(row) { recorded.push(row); } }, statistics: { record(row) { aggregate.push(row); } } });
  assert.equal(response.status, 200); assert.equal((await response.json()).ip, '1.1.1.1');
  assert.deepEqual(lookup, ['1.1.1.1', '8.8.8.8']);
  assert.equal(recorded[0].ip, '8.8.8.8'); assert.equal(recorded[0].country, 'United States');
  assert.equal(recorded[0].provider, 'Test provider'); assert.equal(aggregate[0].ip, undefined);
  await handleRequest(request('/country'), { LOCAL_GEOIP: { lookup() { throw new Error('Offline'); } } }, { visitors: { record(row) { recorded.push(row); } } });
  assert.equal(recorded[1].errors, 1); assert.equal(recorded[1].country, '');
  for (const path of ['/stats', '/admin/usage', '/admin/usage.json', '/internal/visitors', '/healthz']) await handleRequest(request(path), {}, { visitors: { record() { assert.fail('Excluded route counted'); } } });
  assert.equal(visitorEvent(usageEvent(request('/json'), new Response('')), 'not-an-ip'), null);
  const ipv6 = visitorEvent(usageEvent(request('/json'), new Response('')), '2606:4700:0000:0000:0000:0000:0000:1111');
  assert.equal(ipv6.ip, '2606:4700::1111');
});

test('Cloudflare source metadata comes from trusted edge fields and recording failures preserve responses', async t => {
  const { db } = await usageDatabase(t);
  const req = request('/json?ip=invalid', { 'X-Forwarded-For': '9.9.9.9' });
  req.cf = { country: 'IR', city: 'Tehran', asOrganization: 'Example network' };
  const response = await handleCloudflareRequest(req, { ...env, USAGE_DB: db });
  assert.equal(response.status, 400);
  const data = await new WorkerVisitors(db).list(filters());
  assert.equal(data.rows[0].ip, '8.8.8.8'); assert.equal(data.rows[0].country, 'Iran');
  assert.equal(data.rows[0].city, 'Tehran'); assert.equal(data.rows[0].provider, 'Example network');
  assert.equal(data.rows[0].errors, 1);
  assert.equal((await handleRequest(request('/ip'), {}, { visitors: { record() { throw new Error('Offline'); } } })).status, 200);
  const disabled = await handleCloudflareRequest(request('/ip'), { USAGE_DB: db });
  assert.equal(disabled.status, 200); assert.equal((await new WorkerVisitors(db).list(filters())).totals.total, 1);
});

test('SQLite aggregation is site scoped, ranked, paginated and idempotent across replicas and out-of-order reports', async t => {
  const { db } = await usageDatabase(t), visitors = new WorkerVisitors(db);
  await visitors.record(event()); await visitors.record(event());
  await visitors.record(event('1.1.1.1', now, { country: 'Australia', city: 'Sydney', asn_org: 'Cloudflare' }));
  const report = { source: randomUUID(), rows: [{ ...event(), web: 3, api: 4, errors: 2 }] };
  await visitors.collect(report, now); await visitors.collect(report, now);
  await visitors.collect({ ...report, rows: [{ ...event('8.8.8.8', new Date('2026-10-10T11:00:00.000Z'), { country: 'Old', city: 'Old', asn_org: 'Old' }), api: 1 }] }, now);
  await visitors.collect({ source: randomUUID(), rows: [event()] }, now);
  const worker = await visitors.list(filters());
  assert.equal(worker.totals.total, 3); assert.equal(worker.rows[0].total, 2); assert.equal(worker.matched_ips, 2);
  const container = await visitors.list(filters(`site=${containerSite}`));
  assert.equal(container.totals.total, 8); assert.equal(container.rows[0].provider, 'Google LLC'); assert.equal(container.rows[0].web, 3);
  assert.equal((await visitors.list(filters('q=Sydney'))).rows[0].ip, '1.1.1.1');
  assert.equal((await visitors.list(filters('q=%25'))).matched_ips, 0);
  assert.equal((await visitors.list(filters('q=%27%20OR%201=1--'))).matched_ips, 0);
  for (let i = 0; i < 51; i++) await visitors.record(event(`11.0.0.${i}`));
  const second = await visitors.list(filters('page=2'));
  assert.equal(second.rows.length, 3); assert.equal(second.matched_ips, 53); assert.equal(second.totals.total, 54);
  const publicData = await new WorkerStatistics(db).read();
  assert.equal(publicData.all_time.total, 0); assert.equal(JSON.stringify(publicData).includes('8.8.8.8'), false);
});

test('expiry removes only IP records and stale replays cannot recreate expired data', async t => {
  const { db, sqlite } = await usageDatabase(t), visitors = new WorkerVisitors(db), stats = new WorkerStatistics(db);
  const old = event('1.1.1.1', new Date('2026-09-10T12:00:00.000Z'));
  const boundary = event('8.8.8.8', new Date('2026-09-11T00:00:00.000Z'));
  await visitors.record(old); await visitors.record(boundary); await stats.record(old);
  assert.equal(retentionStart(now), '2026-09-11');
  assert.equal((await visitors.list(filters())).matched_ips, 1);
  await visitors.prune(now);
  await visitors.collect({ source: randomUUID(), rows: [old] }, now);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM usage_ip_daily').get().n, 1);
  assert.equal((await stats.read(workerSite, now)).all_time.total, 1);
  for (const query of ['from=2026-09-10', 'to=2026-10-11', 'from=2026-02-30', 'site=combined', 'page=0', 'page=abc', 'from=2026-10-10&to=2026-10-09']) assert.throws(() => filters(query), query);
});

test('collector rejects unauthenticated reads, untrusted identities and invalid reports', async t => {
  const { db } = await usageDatabase(t), visitors = new WorkerVisitors(db);
  const report = { source: randomUUID(), rows: [event('8.8.8.8', new Date())] };
  const send = (value, headers = {}, method = 'POST') => visitorCollectionResponse(new Request(`https://${workerSite}/internal/visitors`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(value) } : {}) }), env, visitors);
  assert.equal((await send(report)).status, 401);
  assert.equal((await send(report, { Authorization: `Bearer ${token}` }, 'GET')).status, 405);
  assert.equal((await send({ ...report, site: workerSite }, { Authorization: `Bearer ${token}` })).status, 400);
  assert.equal((await send(report, { Authorization: `Bearer ${token}` })).status, 200);
  for (const row of [{ ...event(), ip: null }, { ...event(), ip: 'invalid' }, { ...event(), provider: 'x'.repeat(257) }, { ...event(), city: 'bad\ncity' }]) assert.throws(() => validateVisitorReport({ source: report.source, rows: [row] }, now));
  assert.throws(() => validateVisitorReport({ ...report, rows: [event(), event()] }, now));
});

test('signed Access tokens require the configured issuer, application, expiry and email', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test'; jwk.alg = 'RS256';
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const auth = { IPINFO_ACCESS_ISSUER: 'https://example.cloudflareaccess.com', IPINFO_ACCESS_AUD: 'private-usage', IPINFO_ADMIN_EMAILS: 'owner@example.com,second@example.com' };
  const seconds = Math.floor(now.getTime() / 1000);
  const signed = overrides => new SignJWT({ email: 'owner@example.com', iss: auth.IPINFO_ACCESS_ISSUER, aud: [auth.IPINFO_ACCESS_AUD], sub: 'owner', iat: seconds, exp: seconds + 3600, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
  const check = async overrides => authorizedAdmin(request('/admin/usage', { 'Cf-Access-Jwt-Assertion': await signed(overrides) }), auth, { keySet, now });
  assert.equal(await check({}), true); assert.equal(await check({ email: 'second@example.com' }), true);
  for (const overrides of [{ email: 'other@example.com' }, { iss: 'https://evil.cloudflareaccess.com' }, { aud: ['another-app'] }, { exp: seconds - 1 }, { nbf: seconds + 60 }, { email: undefined }]) assert.equal(await check(overrides), false);
  assert.equal(await authorizedAdmin(request('/admin/usage', { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' }), auth, { keySet, now }), false);
  assert.equal(await authorizedAdmin(request('/admin/usage', { 'Cf-Access-Jwt-Assertion': await signed({}) }), {}, { keySet, now }), false);
  const { privateKey: attacker } = await generateKeyPair('RS256');
  const forgery = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(attacker);
  assert.equal(await authorizedAdmin(request('/admin/usage', { 'Cf-Access-Jwt-Assertion': forgery }), auth, { keySet, now }), false);
});

test('dashboard and every admin data path fail closed, avoid public CORS and reject invalid filters', async t => {
  const { db } = await usageDatabase(t), visitors = new WorkerVisitors(db);
  await visitors.record(event());
  for (const path of ['/admin', '/admin/usage', '/admin/usage.json', '/admin/other', '/admin/usage.json?site=ip.behnam.pro']) {
    const response = await handleCloudflareRequest(request(path, { 'Cf-Access-Authenticated-User-Email': 'owner@example.com', Authorization: `Bearer ${token}` }), { ...env, USAGE_DB: db });
    assert.equal(response.status, 403); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await response.text()).includes('8.8.8.8'), false); assert.match(response.headers.get('Cache-Control'), /no-store/);
  }
  const options = { authorize: async () => true, now };
  const html = await adminResponse(request('/admin/usage'), {}, visitors, options);
  assert.equal(html.status, 200); assert.match(await html.text(), /Country.*City.*Provider/s);
  const json = await adminResponse(request('/admin/usage.json'), {}, visitors, options);
  assert.equal((await json.json()).rows[0].ip, '8.8.8.8');
  assert.equal((await adminResponse(request('/admin/usage.json?site=combined'), {}, visitors, options)).status, 400);
  assert.equal((await adminResponse(request('/admin/usage.json'), {}, undefined, options)).status, 503);
  assert.equal((await adminResponse(new Request(`https://${workerSite}/admin/usage.json`, { method: 'HEAD' }), {}, visitors, options)).body, null);
});

test('container reports survive restarts, retry and concurrent replica resends without double counting; disk files expire', async t => {
  const { db } = await usageDatabase(t), visitors = new WorkerVisitors(db), stats = new WorkerStatistics(db);
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-private-visitors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = new Date(), offline = false;
  const fetcher = (url, options) => {
    if (offline) throw new Error('Offline');
    const req = new Request(url, options);
    return new URL(url).pathname === '/internal/visitors' ? visitorCollectionResponse(req, env, visitors) : collectionResponse(req, env, stats);
  };
  const config = { directory, endpoint: `https://${workerSite}/internal/usage`, token, visitorIPs: true };
  const first = await new ContainerStatistics(config, { fetcher, now: () => time }).initialize();
  const second = await new ContainerStatistics(config, { fetcher, now: () => time }).initialize();
  await first.visitors.record(event('8.8.8.8', time)); await second.visitors.record(event('8.8.8.8', time));
  await first.record(usageEvent(request('/ip'), new Response(''), time));
  offline = true; await first.sync();
  offline = false; await first.sync(); await second.sync();
  const restarted = await new ContainerStatistics(config, { fetcher, now: () => time }).initialize();
  await restarted.sync(); await first.sync();
  const data = await visitors.list(filters(`site=${containerSite}`, time), time);
  assert.equal(data.totals.total, 2); assert.equal(data.rows[0].provider, 'Google LLC');
  assert.equal((await stats.read(containerSite, time)).all_time.total, 1);
  const files = await readdir(join(directory, 'visitors'));
  assert.equal(files.length, 2);
  for (const file of files) assert.equal((await stat(join(directory, 'visitors', file))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, 'snapshot.json'), 'utf8')).includes('8.8.8.8'), false);
  time = new Date(time.getTime() + 30 * 86400000); await first.sync();
  assert.equal((await readdir(join(directory, 'visitors'))).length, 0);
});

test('container HTTP runtime reports the trusted source with real GeoLite2 metadata and excludes lookup targets and private reads', async t => {
  const { db } = await usageDatabase(t), visitors = new WorkerVisitors(db), stats = new WorkerStatistics(db);
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-private-http-'));
  const { paths } = await writeFixtures(join(directory, 'databases'));
  const databases = new LocalDatabases(await openDatabases(paths), 10);
  const local = await new ContainerStatistics({ directory: join(directory, 'stats'), endpoint: `https://${workerSite}/internal/usage`, token, visitorIPs: true }, {
    fetcher: (url, options) => new URL(url).pathname === '/internal/visitors' ? visitorCollectionResponse(new Request(url, options), env, visitors) : collectionResponse(new Request(url, options), env, stats),
  }).initialize();
  const server = createHTTPServer(databases, { status: {} }, serverConfig({ IPINFO_REVERSE_LOOKUP: 'false', IPINFO_TRUSTED_HEADERS: 'X-Real-IP' }), local);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(origin + '/json?ip=1.1.1.1', { headers: { 'X-Real-IP': '81.2.69.160', 'CF-Connecting-IP': '8.8.8.8' } });
  assert.equal((await result.json()).ip, '1.1.1.1');
  assert.equal((await fetch(origin + '/admin/usage.json')).status, 404);
  await local.sync();
  const data = await visitors.list(filters(`site=${containerSite}`, new Date()));
  const expected = databases.lookup('81.2.69.160');
  assert.equal(data.matched_ips, 1); assert.equal(data.rows[0].ip, '81.2.69.160');
  assert.equal(data.rows[0].country, expected.country); assert.equal(data.rows[0].city, 'London');
  assert.equal(data.rows[0].provider, expected.asn_org || '');
  assert.equal((await visitors.list(filters('', new Date()))).matched_ips, 0);
});
