import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerStatistics, collectionResponse } from '../worker/statistics-store.mjs';
import { usageEvent, workerSite, containerSite, reportPath, validateReport } from '../worker/statistics.mjs';
import { handleCloudflareRequest } from '../worker/cloudflare.mjs';
import { handleRequest } from '../worker/index.mjs';
import { ContainerStatistics, statisticsConfig } from '../server/statistics.mjs';
import { createHTTPServer } from '../server/index.mjs';
import { serverConfig } from '../server/config.mjs';
import { LocalDatabases, openDatabases } from '../server/databases.mjs';
import { writeFixtures } from './server-fixtures.mjs';

const token = 't'.repeat(64);
const request = (path = '/json', options = {}) => new Request(`https://${workerSite}${path}`, { headers: { 'CF-Connecting-IP': '8.8.8.8' }, ...options });
const event = (type = 'api', now = new Date(), status = 200) => usageEvent(request(type === 'web' ? '/' : '/json'), new Response('', { status, headers: { 'Content-Type': type === 'web' ? 'text/html' : 'application/json' } }), now);
async function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../migrations/0001_usage.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return { bind(...parameters) {
        return { async run() { statement.run(...parameters); return { success: true }; },
          async all() { return { results: statement.all(...parameters), success: true }; } };
      } };
    },
    withSession(mode) { assert.equal(mode, 'first-primary'); return db; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const item of statements) results.push(await item.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, sqlite, stats: new WorkerStatistics(db) };
}

test('diagnostic GETs distinguish response formats and exclude assets, probes and statistics', () => {
  for (const path of ['/json', '/ip', '/country-ir', '/user-agent', '/port/443']) assert.equal(usageEvent(request(path), new Response('')).api, 1);
  for (const path of ['/stats', '/stats.json', '/healthz', '/health', '/database-info', '/icons/icon-192.png', '/sw.js', '/missing', reportPath]) assert.equal(usageEvent(request(path), new Response('')), null, path);
  for (const method of ['HEAD', 'OPTIONS', 'POST']) assert.equal(usageEvent(request('/json', { method }), new Response('')), null);
  assert.equal(event('web', new Date(), 502).web, 1);
  assert.equal(event('web', new Date(), 502).errors, 1);
  assert.equal(event('api').errors, 0);
});
test('atomic increments, independent sites, UTC day boundaries and 30-day summaries use real SQLite', async t => {
  const { stats } = await database(t);
  const now = new Date('2026-10-07T00:00:00.000Z');
  await Promise.all(Array.from({ length: 50 }, (_, i) => stats.record(event(i % 2 ? 'web' : 'api', now, i === 0 ? 400 : 200))));
  await stats.record(event('api', new Date('2026-10-06T23:59:59.999Z')));
  await stats.record(event('api', new Date('2026-09-01T00:00:00.000Z')));
  const value = await stats.read(workerSite, now);
  assert.equal(value.site, workerSite); assert.equal(value.all_time.total, 52);
  assert.deepEqual(value.today, { total: 50, web: 25, api: 25, errors: 1 });
  assert.equal(value.last_30_days.total, 51); assert.equal(value.daily.length, 30);
  assert.equal(value.daily[0].day, '2026-09-08'); assert.equal(value.daily.at(-1).day, '2026-10-07');
  assert.equal((await stats.read(containerSite, now)).all_time.total, 0);
});
test('duplicate, older and concurrent replica reports never double count or alter the Worker site', async t => {
  const { stats } = await database(t);
  const row = { ...event(), web: 3, api: 7, errors: 2 };
  const report = { source: randomUUID(), rows: [row] };
  await stats.record(event('web'));
  await stats.collect(report); await stats.collect(report);
  await stats.collect({ ...report, rows: [{ ...row, web: 1, api: 2, errors: 0 }] });
  await stats.collect({ source: randomUUID(), rows: [{ ...row, web: 1, api: 1, errors: 0 }] });
  assert.deepEqual((await stats.read(containerSite)).all_time, { total: 12, web: 4, api: 8, errors: 2 });
  assert.equal((await stats.read(workerSite)).all_time.total, 1);
});
test('collector fixes site identity from authentication and rejects spoofing, malformed and oversized reports', async t => {
  const { stats } = await database(t);
  const env = { IPINFO_STATS_REPORT_TOKEN: token };
  const report = { source: randomUUID(), rows: [event()] };
  const post = body => request(reportPath + '?site=ip.bea.sh', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await collectionResponse(request(reportPath), env, stats)).status, 401);
  assert.equal((await collectionResponse(post(report), {}, stats)).status, 401);
  assert.equal((await collectionResponse(post({ ...report, site: workerSite }), env, stats)).status, 400);
  assert.equal((await collectionResponse(post({ ...report, source: 'edge' }), env, stats)).status, 400);
  assert.equal((await collectionResponse(post({ ...report, rows: [{ ...event(), web: -1 }] }), env, stats)).status, 400);
  assert.equal((await collectionResponse(post({ ...report, padding: 'x'.repeat(17000) }), env, stats)).status, 400);
  const response = await collectionResponse(post(report), env, stats);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).site, containerSite);
  assert.equal((await stats.read(workerSite)).all_time.total, 0);
});
test('invalid counts, future and duplicate days cannot enter storage', () => {
  const report = { source: randomUUID(), rows: [event()] };
  for (const changes of [{ errors: 2 }, { web: 0.5 }, { api: Number.MAX_SAFE_INTEGER }, { day: '2026-02-30' }, { day: '2999-01-01' }, { last_seen: 'not-a-date' }]) assert.throws(() => validateReport({ ...report, rows: [{ ...report.rows[0], ...changes }] }));
  assert.throws(() => validateReport({ ...report, rows: [...report.rows, ...report.rows] }));
});
test('public statistics ignore site selectors and do not increase their own counters', async t => {
  const { db, stats } = await database(t);
  const env = { USAGE_DB: db };
  const pending = [];
  await handleCloudflareRequest(request('/', { headers: { 'CF-Connecting-IP': '8.8.8.8', Accept: 'text/html' } }), env, { waitUntil: value => pending.push(value) });
  await Promise.all(pending);
  for (const path of ['/stats.json?site=ip.behnam.pro', '/stats?site=ip.behnam.pro', '/healthz']) {
    const response = await handleCloudflareRequest(request(path), env);
    assert.equal(response.status, 200);
    if (path.startsWith('/stats.json')) assert.equal((await response.json()).site, workerSite);
    else if (path.startsWith('/stats?')) { const html = await response.text(); assert.match(html, /data-statistics-site="ip.bea.sh"/); assert.ok(!html.includes('ip.behnam.pro')); }
  }
  assert.equal((await stats.read()).all_time.total, 1);
  const head = await handleCloudflareRequest(request('/stats.json', { method: 'HEAD' }), env);
  assert.equal(await head.text(), '');
});
test('failed counter writes leave diagnostics working and unconfigured statistics return an explicit 503', async () => {
  const env = {};
  const result = await handleRequest(request('/ip'), env, { statistics: { record: async () => { throw new Error('quota exceeded'); } } });
  assert.equal(result.status, 200); assert.equal(await result.text(), '8.8.8.8\n');
  assert.equal((await handleRequest(request('/stats.json'), env)).status, 503);
});
test('durable shared spool recovers across processes, combines replicas, retries lost acknowledgements and marks stale snapshots', async t => {
  const { stats } = await database(t);
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-statistics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failure = null;
  const fetcher = async (url, options) => {
    if (failure === 'offline') throw new Error('offline');
    const response = await collectionResponse(new Request(url, options), { IPINFO_STATS_REPORT_TOKEN: token }, stats);
    if (failure === 'lost-ack') throw new Error('response lost');
    return response;
  };
  const config = { directory, endpoint: `https://${workerSite}${reportPath}`, token };
  const first = await new ContainerStatistics(config, { fetcher }).initialize();
  const second = await new ContainerStatistics(config, { fetcher }).initialize();
  await Promise.all([first.record(event('web')), first.record(event('api')), second.record(event('api'))]);
  const files = await readdir(directory); assert.equal(files.filter(name => name.endsWith('.json')).length, 2);
  const contents = await readFile(join(directory, first.source + '.json'), 'utf8');
  assert.ok(!contents.includes(token)); assert.ok(!contents.includes('8.8.8.8')); assert.ok(!contents.includes('user_agent'));
  failure = 'offline'; await first.sync(); assert.throws(() => first.snapshot());
  // A replacement replica scans persisted files from the previous processes.
  const replacement = await new ContainerStatistics(config, { fetcher }).initialize();
  failure = 'lost-ack'; await replacement.sync();
  assert.ok((await stats.read(containerSite)).all_time.total > 0);
  failure = null; await replacement.sync();
  assert.equal(replacement.snapshot().all_time.total, 3);
  await second.record(event('api')); await replacement.sync(); await first.sync();
  assert.equal(replacement.snapshot().all_time.total, 4); assert.equal(first.snapshot().all_time.total, 4);
  assert.equal((await stats.read(workerSite)).all_time.total, 0);
  failure = 'offline'; await first.sync(); assert.equal(first.snapshot().stale, true); assert.equal(first.snapshot().all_time.total, 4);
  const restarted = await new ContainerStatistics(config, { fetcher }).initialize(); assert.equal(restarted.snapshot().all_time.total, 4);
});
test('container refuses wrong-site snapshots and invalid collector configuration', async t => {
  assert.equal(statisticsConfig({}), null);
  assert.throws(() => statisticsConfig({ IPINFO_STATS_ENDPOINT: `http://${workerSite}${reportPath}`, IPINFO_STATS_REPORT_TOKEN: token }));
  assert.throws(() => statisticsConfig({ IPINFO_STATS_ENDPOINT: `https://evil.example${reportPath}`, IPINFO_STATS_REPORT_TOKEN: token }));
  assert.throws(() => statisticsConfig({ IPINFO_STATS_ENDPOINT: `https://${workerSite}${reportPath}?site=x`, IPINFO_STATS_REPORT_TOKEN: token }));
  assert.throws(() => statisticsConfig({ IPINFO_STATS_ENDPOINT: `https://${workerSite}${reportPath}`, IPINFO_STATS_REPORT_TOKEN: 'short' }));
  const { stats } = await database(t);
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-statistics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = await new ContainerStatistics({ directory, endpoint: `https://${workerSite}${reportPath}`, token }, { fetcher: async () => Response.json(await stats.read(workerSite)) }).initialize();
  await local.record(event()); await local.sync(); assert.throws(() => local.snapshot());
});
test('enabled container HTTP adapter records diagnostics and exposes only its own statistics', async t => {
  const { stats } = await database(t);
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-statistics-http-'));
  const { paths } = await writeFixtures(join(directory, 'databases'));
  const config = { directory: join(directory, 'statistics'), endpoint: `https://${workerSite}${reportPath}`, token };
  const local = await new ContainerStatistics(config, { fetcher: (url, options) => collectionResponse(new Request(url, options), { IPINFO_STATS_REPORT_TOKEN: token }, stats) }).initialize();
  const databases = new LocalDatabases(await openDatabases(paths), 0);
  const server = createHTTPServer(databases, { status: {} }, serverConfig({ IPINFO_REVERSE_LOOKUP: 'false' }), local);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/stats.json')).status, 503);
  const html = await (await fetch(origin + '/', { headers: { Accept: 'text/html' } })).text();
  assert.match(html, /id="usage-count" data-site="ip.behnam.pro"/);
  await fetch(origin + '/ip');
  await local.sync();
  const value = await (await fetch(origin + '/stats.json?site=ip.bea.sh')).json();
  assert.equal(value.site, containerSite); assert.deepEqual(value.all_time, { total: 2, web: 1, api: 1, errors: 0 });
  assert.equal((await stats.read(workerSite)).all_time.total, 0);
  assert.match(await (await fetch(origin + '/stats')).text(), /data-statistics-site="ip.behnam.pro"/);
});
