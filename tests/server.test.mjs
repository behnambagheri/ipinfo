import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHTTPServer, clientIP } from '../server/index.mjs';
import { LocalDatabases, openDatabases } from '../server/databases.mjs';
import { serverConfig } from '../server/config.mjs';
import { handleRequest } from '../worker/index.mjs';
import { fixtureEnvironment } from './helpers/geoip.mjs';
import { writeFixtures } from './server-fixtures.mjs';

async function localServer(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-server-'));
  const { paths } = await writeFixtures(directory);
  const databases = new LocalDatabases(await openDatabases(paths), 8);
  const config = { ...serverConfig({ IPINFO_REVERSE_LOOKUP: 'false' }), port: 0, ...extra };
  const server = createHTTPServer(databases, { status: { enabled: true, interval: '168h' } }, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { server, databases, origin: `http://127.0.0.1:${server.address().port}` };
}

test('Docker adapter and Worker have identical explicit lookup schema, fields, and assets', async t => {
  const { origin } = await localServer(t);
  const env = fixtureEnvironment();
  for (const ip of ['81.2.69.160', '2606:4700:4700::1111', '6.6.6.6', '127.0.0.1']) {
    const local = await (await fetch(`${origin}/json?ip=${ip}`, { headers: { 'User-Agent': 'parity' } })).json();
    const worker = await (await handleRequest(new Request(`https://ip.example/json?ip=${ip}`, { headers: { 'User-Agent': 'parity' } }), env)).json();
    delete local.database_release; delete worker.database_release;
    assert.deepEqual(local, worker);
  }
  for (const route of ['/ip', '/ip-decimal', '/country', '/country-iso', '/country-ir', '/city', '/region-name', '/region-code', '/postal-code', '/asn', '/asn-org', '/timezone', '/latitude', '/longitude', '/coordinates', '/user-agent', '/manifest.webmanifest', '/sw.js', '/favicon.ico', '/offline.html']) {
    const path = `${route}?ip=81.2.69.160`;
    const local = await fetch(origin + path, { headers: { 'User-Agent': 'parity' } });
    const worker = await handleRequest(new Request('https://ip.example' + path, { headers: { 'User-Agent': 'parity' } }), env);
    assert.equal(local.status, worker.status, route);
    assert.deepEqual(Buffer.from(await local.arrayBuffer()), Buffer.from(await worker.arrayBuffer()), route);
  }
});
test('local visitor lookup uses only the configured proxy header and local database', async t => {
  const { origin } = await localServer(t, { headers: ['X-Real-IP'] });
  const data = await (await fetch(origin + '/json', { headers: { 'X-Real-IP': '81.2.69.160', 'CF-Connecting-IP': '8.8.8.8' } })).json();
  assert.equal(data.ip, '81.2.69.160'); assert.equal(data.country_iso, 'GB'); assert.equal(data.source, 'GeoLite2');
  const { origin: untrusted } = await localServer(t);
  assert.equal(await (await fetch(untrusted + '/ip', { headers: { 'X-Real-IP': '8.8.8.8', 'CF-Connecting-IP': '8.8.8.8' } })).text(), '127.0.0.1\n');
  assert.equal(clientIP({ headers: { 'x-forwarded-for': '[2001:4860:4860::8888]:1234, 127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }, ['X-Forwarded-For']), '2001:4860:4860::8888');
});
test('container health, metadata, error handling, HEAD and custom lookup configuration', async t => {
  const { origin, databases } = await localServer(t, { revision: 'test-revision' });
  for (const route of ['/health', '/healthz']) {
    const data = await (await fetch(origin + route)).json(); assert.equal(data.revision, 'test-revision'); assert.equal(data.database_release, databases.release);
  }
  const info = await (await fetch(origin + '/database-info')).json();
  assert.equal(info.updates.interval, '168h'); assert.equal(Object.keys(info.databases).length, 3);
  assert.equal((await fetch(origin + '/json?ip=bad')).status, 400);
  assert.equal((await fetch(origin + '/missing')).status, 404);
  assert.equal((await fetch(origin + '/port/80')).status, 501);
  assert.equal((await fetch(origin + '/json', { method: 'POST', body: 'test' })).status, 405);
  assert.equal((await fetch(origin + '/json', { method: 'OPTIONS' })).status, 204);
  assert.equal(await (await fetch(origin + '/json', { method: 'HEAD' })).text(), '');
  const html = await (await fetch(origin + '/?ip=81.2.69.160', { headers: { Accept: 'text/html' } })).text();
  assert.match(html, /IPinfo — bea.sh/); assert.match(html, /London/); assert.ok(!html.includes('{{')); assert.ok(!html.includes('echoip'));
  const { origin: restricted } = await localServer(t, { disableCustomIP: true });
  assert.equal((await fetch(restricted + '/json?ip=8.8.8.8')).status, 400);
});
test('optional container port checks connect only to the requesting peer', async t => {
  const target = createServer((req, res) => res.end());
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const { origin } = await localServer(t, { portLookup: true });
  const result = await (await fetch(`${origin}/port/${target.address().port}?ip=8.8.8.8`)).json();
  assert.equal(result.ip, '127.0.0.1'); assert.equal(result.reachable, true); assert.equal(result.status, 'open');
});
