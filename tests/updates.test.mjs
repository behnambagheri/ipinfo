import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabases, openDatabases, sha256, names } from '../server/databases.mjs';
import { DatabaseUpdater } from '../server/updates.mjs';
import { updateConfig, serverConfig } from '../server/config.mjs';
import { fixtureBytes, writeFixtures } from './server-fixtures.mjs';

const timestamp = Date.parse('2026-10-07T12:00:00Z');
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ipinfo-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { paths, checksums } = await writeFixtures(join(root, 'bundled'), Math.floor(timestamp / 1000) - 86400);
  const receipt = join(root, 'bundled', 'release.json');
  await writeFile(receipt, JSON.stringify({ checksums, last_successful_update: new Date(timestamp - 10000).toISOString() }));
  const databases = new LocalDatabases(await openDatabases(paths), 8);
  const buffers = Object.fromEntries(await Promise.all(names.map(async name => [name, await fixtureBytes(name, Math.floor(timestamp / 1000))])));
  const latest = { tag_name: '2026.10.07', assets: names.map(name => ({ name: `GeoLite2-${name}.mmdb`, digest: `sha256:${sha256(buffers[name])}`, browser_download_url: `https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.10.07/GeoLite2-${name}.mmdb` })) };
  const requests = [];
  const downloader = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('api.github.com')) return Buffer.from(JSON.stringify(latest));
    const name = /GeoLite2-(\w+)\.mmdb$/.exec(url)[1];
    await writeFile(options.path, buffers[name]);
  };
  const directory = join(root, 'updates');
  const env = { IPINFO_DATABASE_UPDATE_PROXY: 'http://user:secret@localhost:3128' };
  const updater = await new DatabaseUpdater(databases, { env, directory, downloadFile: downloader, now: () => timestamp }).initialize(receipt);
  t.after(() => updater.stop());
  return { root, paths, receipt, databases, buffers, latest, requests, downloader, updater, env, directory };
}

test('updater atomically activates verified files, invalidates caches, and restores them after restart', async t => {
  const s = await setup(t);
  const before = s.databases.release;
  s.databases.lookup('81.2.69.160'); assert.equal(s.databases.cache.size, 1);
  assert.equal(await s.updater.check(), true);
  assert.notEqual(s.databases.release, before); assert.equal(s.databases.cache.size, 0);
  assert.equal(s.requests.length, 4); assert.ok(s.requests.every(request => request.options.proxy === s.env.IPINFO_DATABASE_UPDATE_PROXY));
  assert.equal(s.updater.status.last_successful_update, new Date(timestamp).toISOString());
  assert.equal(s.databases.lookup('81.2.69.160').country_iso, 'GB');
  const persisted = JSON.parse(await readFile(join(s.directory, 'current.json'), 'utf8'));
  assert.equal(persisted.generation, s.databases.state.generation);
  const restarted = new LocalDatabases(await openDatabases(s.paths));
  const updater = await new DatabaseUpdater(restarted, { env: s.env, directory: s.directory, now: () => timestamp }).initialize(s.receipt);
  assert.equal(restarted.release, s.databases.release); assert.equal(updater.status.last_successful_update, s.updater.status.last_successful_update);
  assert.equal(await s.updater.check(), true); assert.equal(s.requests.length, 5);
  assert.equal(s.updater.status.last_successful_update, new Date(timestamp).toISOString());
});
test('corrupt, interrupted, backwards and future updates preserve active files and successful timestamp', async t => {
  for (const failure of ['checksum', 'download', 'backwards', 'future', 'type']) {
    const s = await setup(t); const before = s.databases.release; const updated = s.updater.status.last_successful_update;
    if (failure === 'download') s.updater.download = async () => { throw new Error('http://user:secret@proxy'); };
    else if (failure === 'checksum') s.buffers.City = Buffer.from('broken');
    else {
      s.buffers.City = await fixtureBytes('City', Math.floor(timestamp / 1000) + (failure === 'future' ? 172800 : failure === 'backwards' ? -172800 : 0));
      if (failure === 'type') s.buffers.City = await fixtureBytes('ASN', Math.floor(timestamp / 1000));
      s.latest.assets.find(asset => asset.name.includes('City')).digest = `sha256:${sha256(s.buffers.City)}`;
    }
    assert.equal(await s.updater.check(), false, failure);
    assert.equal(s.databases.release, before); assert.equal(s.updater.status.last_successful_update, updated);
    assert.equal(s.databases.lookup('81.2.69.160').country_iso, 'GB');
    assert.ok(!JSON.stringify(s.updater.status).includes('secret'));
    const remaining = await readdir(s.directory).catch(() => []); assert.ok(!remaining.some(name => name.startsWith('.download-')));
  }
});
test('changed intervals and enabled state reload without restart; explicit env takes precedence', async t => {
  const s = await setup(t);
  const config = join(s.root, 'updates.json'); s.env.IPINFO_DATABASE_UPDATE_CONFIG = config;
  await writeFile(config, JSON.stringify({ enabled: false, interval: '24h', proxy: 'socks5h://localhost:1080' }));
  await s.updater.tick(); assert.equal(s.requests.length, 0); assert.equal(s.updater.status.enabled, false); assert.equal(s.updater.status.interval, '24h');
  await writeFile(config, JSON.stringify({ enabled: true, interval: '2s' }));
  await s.updater.tick(); assert.equal(s.requests.length, 4);
  s.updater.now = () => timestamp + 1999; await s.updater.tick(); assert.equal(s.requests.length, 4);
  s.updater.now = () => timestamp + 2000; await s.updater.tick(); assert.equal(s.requests.length, 5);
  const configured = await updateConfig(s.env); assert.equal(configured.proxy, s.env.IPINFO_DATABASE_UPDATE_PROXY);
  await writeFile(config, '{invalid'); await s.updater.tick(); assert.equal(s.requests.length, 5);
  assert.equal(s.updater.status.last_error, 'Invalid database update configuration.');
});
test('scheduler performs its initial check and retries failures without blocking lookups', async t => {
  const s = await setup(t); s.env.IPINFO_DATABASE_UPDATE_INTERVAL = '1s';
  const started = Date.now(); s.updater.now = () => timestamp + Date.now() - started;
  let calls = 0; s.updater.download = async () => { calls++; throw new Error('Offline'); };
  s.updater.start();
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.ok(calls >= 2); assert.equal(s.databases.lookup('81.2.69.160').city, 'London');
  await s.updater.stop(); const stopped = calls;
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, stopped);
});
test('invalid persisted generations cannot replace bundled databases', async t => {
  const s = await setup(t); await s.updater.check();
  const stateFile = join(s.directory, 'current.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(join(s.directory, 'generations', state.generation, 'GeoLite2-ASN.mmdb'), 'corrupted');
  const local = new LocalDatabases(await openDatabases(s.paths));
  const updater = await new DatabaseUpdater(local, { env: s.env, directory: s.directory }).initialize(s.receipt);
  assert.notEqual(local.release, s.databases.release); assert.match(updater.status.last_error, /could not be restored/);
});
test('configuration aliases preserve existing deployment settings without echoip runtime', async () => {
  const config = serverConfig({ ECHOIP_LISTEN: ':9000', ECHOIP_TRUSTED_HEADERS: 'X-Real-IP', IPINFO_LISTEN: ':8081' });
  assert.equal(config.port, 8081); assert.deepEqual(config.headers, ['X-Real-IP']);
  assert.equal((await updateConfig({})).intervalMs, 7 * 86400000);
  for (const interval of ['0s', '1', '-1h', '24hours', '999999999999999999h']) await assert.rejects(updateConfig({ IPINFO_DATABASE_UPDATE_INTERVAL: interval }));
  for (const proxy of ['ftp://proxy', 'http://proxy/path', 'http://proxy\nheader']) await assert.rejects(updateConfig({ IPINFO_DATABASE_UPDATE_PROXY: proxy }));
});
