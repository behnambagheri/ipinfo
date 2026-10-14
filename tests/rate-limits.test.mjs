import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageDatabase } from './helpers/usage-db.mjs';
import { WorkerRateLimits, rateLimitCollectionResponse } from '../worker/rate-limits.mjs';
import { workerSite, containerSite } from '../worker/statistics.mjs';
import { handleCloudflareRequest } from '../worker/cloudflare.mjs';
import { adminResponse } from '../worker/admin.mjs';
import { ContainerRateLimits } from '../server/rate-limits.mjs';
import { createHTTPServer } from '../server/index.mjs';
import { serverConfig } from '../server/config.mjs';
import { LocalDatabases, openDatabases } from '../server/databases.mjs';
import { writeFixtures } from './server-fixtures.mjs';

const now = new Date('2026-10-14T12:00:00Z'), token = 't'.repeat(64);
const policy = (site = workerSite, max_requests = 1, window_seconds = 60) => ({ site, max_requests, window_seconds });
const request = (path = '/ip', options = {}) => new Request(`https://${workerSite}${path}`, { headers: { 'CF-Connecting-IP': '8.8.8.8' }, ...options });

test('rate limits are durable, atomic, per site and normalized source IP, and expire at the exact boundary', async t => {
  const { db, sqlite } = await usageDatabase(t), limits = new WorkerRateLimits(db);
  assert.deepEqual(await limits.settings(workerSite), policy(workerSite, 0));
  for (let i = 0; i < 3; i++) assert.equal((await limits.check(workerSite, '8.8.8.8', now)).allowed, true);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM rate_limit_buckets').get().count, 0);
  await limits.save(policy());
  const decisions = await Promise.all(Array.from({ length: 20 }, () => new WorkerRateLimits(db).check(workerSite, '8.8.8.8', now)));
  assert.equal(decisions.filter(value => value.allowed).length, 1);
  assert.equal(decisions[1].retry_after, 60);
  assert.equal((await limits.check(workerSite, '8.8.8.8', new Date(now.getTime() + 59000))).retry_after, 1);
  assert.equal((await limits.check(workerSite, '8.8.8.8', new Date(now.getTime() + 60000))).allowed, true);
  const fractionalStart = new Date(now.getTime() + 999);
  assert.equal((await limits.check(workerSite, '9.9.9.9', fractionalStart)).allowed, true);
  assert.equal((await limits.check(workerSite, '9.9.9.9', new Date(fractionalStart.getTime() + 59999))).retry_after, 1);
  assert.equal((await limits.check(workerSite, '9.9.9.9', new Date(fractionalStart.getTime() + 60000))).allowed, true);
  assert.equal((await limits.check(workerSite, '1.1.1.1', now)).allowed, true);
  assert.equal((await limits.check(containerSite, '8.8.8.8', now)).allowed, true);
  assert.equal((await limits.check(workerSite, '2606:4700:4700::1111', now)).allowed, true);
  assert.equal((await limits.check(workerSite, '2606:4700:4700:0:0:0:0:1111', now)).allowed, false);
  assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM rate_limit_buckets').all()).includes('8.8.8.8'));
  await limits.prune(new Date(now.getTime() + 121000));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM rate_limit_buckets').get().count, 0);
});

test('saving custom rates resets windows; no limit takes effect immediately without deleting history', async t => {
  const { db } = await usageDatabase(t), limits = new WorkerRateLimits(db);
  await limits.save(policy());
  await limits.check(workerSite, '8.8.8.8', now);
  await limits.save(policy(workerSite, 2, 3600));
  assert.equal((await limits.check(workerSite, '8.8.8.8', now)).allowed, true);
  assert.equal((await limits.check(workerSite, '8.8.8.8', now)).allowed, true);
  assert.equal((await limits.check(workerSite, '8.8.8.8', now)).retry_after, 3600);
  await limits.save(policy(workerSite, 0));
  assert.equal((await limits.check(workerSite, '8.8.8.8', now)).allowed, true);
  await limits.save(policy());
  assert.equal((await limits.check(workerSite, '8.8.8.8', now)).allowed, true);
  for (const value of [policy('other'), policy(workerSite, -1), policy(workerSite, 1.2), policy(workerSite, '1'), policy(workerSite, 1000001), policy(workerSite, 1, 0), policy(workerSite, 1, 86401), { ...policy(), extra: true }]) {
    await assert.rejects(limits.save(value));
  }
});

test('admin route and settings enforce authentication, same-origin saves, validation and private responses', async t => {
  const { db } = await usageDatabase(t), limits = new WorkerRateLimits(db);
  const options = { limits, authorize: async () => true };
  const write = (value = policy(), headers = {}, query = '') => request('/admin/rate-limit.json' + query, { method: 'PUT', headers: { Origin: `https://${workerSite}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await adminResponse(request('/admin'), {}, undefined, options)).status, 200);
  assert.equal((await adminResponse(request('/admin/usage'), {}, undefined, options)).headers.get('Location'), '/admin');
  const saved = await adminResponse(write(), {}, undefined, options);
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), policy());
  assert.match(saved.headers.get('Cache-Control'), /private, no-store/);
  assert.equal(saved.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await adminResponse(write(policy(), { Origin: 'https://evil.example' }), {}, undefined, options)).status, 403);
  assert.equal((await adminResponse(write(policy(), { Origin: '' }), {}, undefined, options)).status, 403);
  assert.equal((await adminResponse(write(policy(), { 'Sec-Fetch-Site': 'cross-site' }), {}, undefined, options)).status, 403);
  assert.equal((await adminResponse(write(policy(workerSite, -1)), {}, undefined, options)).status, 400);
  assert.equal((await adminResponse(write(policy(), {}, '?site=' + containerSite), {}, undefined, options)).status, 400);
  assert.equal((await adminResponse(request('/admin/rate-limit.json?site=all'), {}, undefined, options)).status, 400);
  assert.equal((await adminResponse(request('/admin/rate-limit.json', { method: 'HEAD' }), {}, undefined, options)).body, null);
  assert.equal((await adminResponse(write(), {}, undefined, { limits })).status, 403);
  assert.equal((await handleCloudflareRequest(write(), { USAGE_DB: db, IPINFO_STATS_REPORT_TOKEN: token })).status, 403);
});

test('Worker checks before diagnostics, uses source identity, returns 429 and excludes support endpoints', async t => {
  const { db } = await usageDatabase(t), limits = new WorkerRateLimits(db);
  await limits.save(policy());
  const env = { USAGE_DB: db, LOCAL_GEOIP: { lookup: ip => ({ ip }) } };
  assert.equal((await handleCloudflareRequest(request('/ip?ip=1.1.1.1'), env)).status, 200);
  const denied = await handleCloudflareRequest(request('/ip?ip=9.9.9.9'), env);
  assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('Retry-After')) > 0);
  assert.equal((await denied.json()).retry_after, Number(denied.headers.get('Retry-After')));
  assert.equal((await handleCloudflareRequest(request('/json', { method: 'HEAD', headers: { 'CF-Connecting-IP': '8.8.8.8' } }), env)).body, null);
  for (const path of ['/healthz', '/usage', '/stats.json', '/brand/ipinfo.svg', '/missing']) {
    assert.notEqual((await handleCloudflareRequest(request(path), env)).status, 429, path);
  }
  assert.equal((await handleCloudflareRequest(request('/ip', { method: 'OPTIONS' }), env)).status, 204);
  assert.equal((await handleCloudflareRequest(request('/ip', { headers: { 'CF-Connecting-IP': '1.1.1.1', 'X-Forwarded-For': '8.8.8.8' } }), env)).status, 200);
  const broken = { USAGE_DB: { prepare() { throw new Error('Offline'); } } };
  assert.equal((await handleCloudflareRequest(request('/ip'), broken)).status, 503);
  assert.equal((await handleCloudflareRequest(request('/healthz'), broken)).status, 200);
});

test('container replicas share the central budget over authenticated transport and reject unavailable limits', async t => {
  const { db } = await usageDatabase(t), limits = new WorkerRateLimits(db);
  await limits.save(policy(containerSite));
  const config = { endpoint: `https://${workerSite}/internal/usage`, token };
  const fetcher = (url, options) => rateLimitCollectionResponse(new Request(url, options), { IPINFO_STATS_REPORT_TOKEN: token }, limits);
  const one = new ContainerRateLimits(config, { fetcher }), two = new ContainerRateLimits(config, { fetcher });
  assert.equal((await one.check('8.8.8.8')).allowed, true);
  assert.equal((await two.check('8.8.8.8')).allowed, false);
  assert.equal((await two.check('1.1.1.1')).allowed, true);
  assert.equal((await limits.check(workerSite, '8.8.8.8')).allowed, true);
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-rate-limits-'));
  const { paths } = await writeFixtures(directory);
  const server = createHTTPServer(new LocalDatabases(await openDatabases(paths), 0), { status: {} }, serverConfig({ IPINFO_REVERSE_LOOKUP: 'false' }), undefined, one);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/ip')).status, 200);
  assert.equal((await fetch(origin + '/json')).status, 429);
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  assert.equal((await rateLimitCollectionResponse(request('/internal/rate-limit', { method: 'POST' }), {}, limits)).status, 401);
  for (const body of [{ ip: 'bad' }, { ip: '8.8.8.8', site: workerSite }]) {
    const response = await fetcher(`https://${workerSite}/internal/rate-limit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  for (const value of [{ allowed: true }, { allowed: false, retry_after: 0 }, { allowed: true, retry_after: 60 }, { allowed: false, retry_after: 86401 }]) {
    await assert.rejects(new ContainerRateLimits(config, { fetcher: async () => Response.json(value) }).check('8.8.8.8'));
  }
  await assert.rejects(new ContainerRateLimits(config, { fetcher: async () => new Response('', { status: 503 }) }).check('8.8.8.8'));
});
