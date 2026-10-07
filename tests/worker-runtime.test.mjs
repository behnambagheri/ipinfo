import test from 'node:test';
import assert from 'node:assert/strict';
import { LookupCache, lookupCache } from '../worker/lookup-cache.mjs';
import { handleCloudflareRequest } from '../worker/cloudflare.mjs';
import { fixtureEnvironment } from './helpers/geoip.mjs';
import { checkPort } from '../worker/port-check.mjs';

function socket(opened = Promise.resolve()) {
  return { opened, closed: Promise.resolve(), closes: 0, async close() { this.closes++; } };
}
function request(path, headers = {}, method = 'GET') {
  return new Request(`https://ip.bea.sh${path}`, { method, headers: { 'CF-Connecting-IP': '8.8.8.8', ...headers } });
}
test('bounded lookup cache evicts least recently used entries and expires results', () => {
  const cache = new LookupCache(1000, 100);
  for (let i = 0; i < 1000; i++) cache.set(String(i), { ip: String(i) }, 0);
  cache.get('0', 1);
  cache.set('1000', { ip: '1000' }, 1);
  assert.equal(cache.entries.size, 1000);
  assert.equal(cache.get('1', 2), undefined);
  assert.deepEqual(cache.get('0', 2), { ip: '0' });
  assert.equal(cache.get('0', 100), undefined);
  const disabled = new LookupCache(0);
  disabled.set('ip', {});
  assert.equal(disabled.entries.size, 0);
});
test('Worker cache skips repeated lookups, invalidates by release, and keeps user agents fresh', async () => {
  const env = { ...fixtureEnvironment(), ECHOIP_CACHE_SIZE: '1000' };
  await handleCloudflareRequest(request('/json?ip=81.2.69.160', { 'User-Agent': 'first' }), env);
  const calls = env.calls.length;
  const cache = lookupCache(env);
  assert.equal(cache.entries.size, 1);
  const saved = cache.get('81.2.69.160');
  cache.set('81.2.69.160', { ...saved, city: 'Cached result' });
  const result = await handleCloudflareRequest(request('/json?ip=81.2.69.160', { 'User-Agent': 'second' }), env);
  assert.equal(env.calls.length, calls);
  const data = await result.json();
  assert.equal(data.user_agent, 'second');
  assert.equal(data.city, 'Cached result');
  env.GEOIP_RELEASE = 'geolite2/new';
  assert.equal((await handleCloudflareRequest(request('/json?ip=81.2.69.160'), env)).status, 502);
  const disabled = { ...fixtureEnvironment(), ECHOIP_CACHE_SIZE: '0' };
  await handleCloudflareRequest(request('/json?ip=81.2.69.160'), disabled);
  await handleCloudflareRequest(request('/json?ip=81.2.69.160'), disabled);
  assert.equal(lookupCache(disabled).entries.size, 0);
});
test('enabled port checks use only the visitor IP and expose the shared UI option', async () => {
  const env = { ECHOIP_PORT_LOOKUP: 'true' };
  const connection = socket();
  let destination;
  const result = await handleCloudflareRequest(request('/port/443?ip=1.1.1.1', { 'X-Real-IP': '1.0.0.1' }), env, {}, value => { destination = value; return connection; });
  assert.deepEqual(destination, { hostname: '8.8.8.8', port: 443 });
  assert.deepEqual(await result.json(), { ip: '8.8.8.8', port: 443, reachable: true, status: 'open' });
  assert.equal(connection.closes, 1);
  const ipv6 = '2606:4700:4700::1111';
  const v6 = await handleCloudflareRequest(request('/port/443', { 'CF-Connecting-IP': ipv6 }), env, {}, value => { destination = value; return socket(); });
  assert.equal(destination.hostname, `[${ipv6}]`);
  assert.equal((await v6.json()).ip, ipv6);
  const html = await (await handleCloudflareRequest(request('/', { Accept: 'text/html' }), env)).text();
  assert.match(html, /value="port"/);
  assert.equal((await handleCloudflareRequest(request('/port/443'), { ECHOIP_PORT_LOOKUP: 'false' })).status, 501);
  for (const path of ['/port/0', '/port/65536', '/port/abc', '/port/80/443']) {
    assert.equal((await handleCloudflareRequest(request(path), env, {}, () => { throw new Error('Must not connect'); })).status, 400);
  }
});
test('TCP checks report restrictions, refusal and timeout, and always close sockets', async () => {
  for (const [message, status] of [['Connection refused', 'refused'], ['proxy request failed, cannot connect to the specified address', 'blocked'], ['Something else', 'unknown']]) {
    const connection = socket(Promise.reject(new Error(message)));
    const result = await checkPort('8.8.8.8', '443', () => connection);
    assert.equal(result.status, status); assert.equal(result.reachable, false); assert.equal(connection.closes, 1);
  }
  const connection = socket(new Promise(() => {}));
  assert.equal((await checkPort('8.8.8.8', '443', () => connection, 5)).status, 'timeout');
  assert.equal(connection.closes, 1);
  for (const [ip, port] of [['8.8.8.8', '25'], ['127.0.0.1', '80'], ['::ffff:192.168.1.1', '443']]) {
    assert.equal((await checkPort(ip, port, () => { throw new Error('Must not connect'); })).status, 'blocked');
  }
});
