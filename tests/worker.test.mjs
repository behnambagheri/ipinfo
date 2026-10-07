import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/index.mjs';
import { fixtureEnvironment } from './helpers/geoip.mjs';
import { normalizeIP, decimalIP, privateIP } from '../worker/ip.mjs';
function request(path = '/', headers = {}, method = 'GET') {
  const value = new Request(`https://ip.bea.sh${path}`, { headers: { 'CF-Connecting-IP': '8.8.8.8', ...headers }, method });
  Object.defineProperty(value, 'cf', { value: { country: 'US', city: 'Mountain View', asn: 15169, asOrganization: 'Google LLC', latitude: '37.4', longitude: '-122.1', timezone: 'America/Los_Angeles' } });
  return value;
}
test('IP parsing accepts IPv4 and IPv6 and rejects injection/ambiguous inputs', () => {
  assert.equal(normalizeIP('2606:4700:4700::1111'), '2606:4700:4700::1111');
  assert.equal(normalizeIP('::ffff:192.168.1.1'), '::ffff:c0a8:101');
  for (const ip of ['999.1.1.1', '01.2.3.4', 'https://example.com', '::1%eth0', '<script>', '1:2:3']) assert.equal(normalizeIP(ip), null);
  assert.equal(decimalIP('8.8.8.8'), 134744072);
  assert.equal(decimalIP('::1'), '1');
  assert.equal(decimalIP('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), '340282366920938463463374607431768211455');
  assert.equal(privateIP(normalizeIP('::ffff:192.168.1.1')), true);
});
test('visitor JSON uses Cloudflare metadata and ignores spoofed forwarding headers', async () => {
  const result = await handleRequest(request('/json', { 'X-Forwarded-For': '203.0.113.1', 'X-Real-IP': '203.0.113.2' }));
  const data = await result.json();
  assert.equal(data.ip, '8.8.8.8'); assert.equal(data.country_iso, 'US'); assert.equal(data.asn, 'AS15169');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('content negotiation returns plain IP to curl and JSON when requested', async () => {
  assert.equal(await (await handleRequest(request())).text(), '8.8.8.8\n');
  assert.equal((await (await handleRequest(request('/', { Accept: 'application/json' }))).json()).ip, '8.8.8.8');
  assert.equal(await (await handleRequest(request('/asn-org'))).text(), 'Google LLC\n');
});
test('shared HTML renders safely with an initially hidden map and hides container-only port feature', async () => {
  const result = await handleRequest(request('/', { Accept: 'text/html', 'User-Agent': '</script><script>alert(1)</script>' }));
  const html = await result.text();
  assert.match(html, /IPinfo — bea.sh/); assert.match(html, /openstreetmap.org\/export\/embed/);
  assert.match(html, /id="toggle-map"[^>]*aria-expanded="false"[^>]*>Show on map<\/button>/);
  assert.match(html, /id="map-section"[^>]*class="[^"]*hidden"/);
  assert.match(html, /<iframe[^>]*data-src="https:\/\/www\.openstreetmap\.org\/export\/embed/);
  assert.ok(!/<iframe[^>]*\ssrc=/.test(html));
  assert.match(html, /&lt;\/script&gt;/); assert.ok(!html.includes('</script><script>alert(1)</script>'));
  assert.ok(!html.includes('{{')); assert.ok(!html.includes('value="port"')); assert.match(html, /Cloudflare and GeoLite2/);
  assert.ok(result.headers.has('Content-Security-Policy'));
});
test('missing geolocation produces a useful map placeholder', async () => {
  const req = new Request('https://ip.bea.sh/', { headers: { Accept: 'text/html', 'CF-Connecting-IP': '127.0.0.1' } });
  const html = await (await handleRequest(req)).text();
  assert.match(html, /Location unavailable/); assert.ok(!html.includes('<iframe'));
});
test('explicit public lookup reads owned databases and preserves API fields', async () => {
  const env = fixtureEnvironment();
  const result = await handleRequest(request('/json?ip=81.2.69.160'), env);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.ip, '81.2.69.160'); assert.equal(data.city, 'London'); assert.equal(data.country_iso, 'GB');
  assert.equal(data.region_code, 'ENG'); assert.equal(data.timezone, 'Europe/London');
  assert.equal(data.source, 'GeoLite2'); assert.equal(data.database_release, env.GEOIP_RELEASE);
  assert.ok(env.calls.every(call => call.key.startsWith(env.GEOIP_RELEASE + '/')));
  const asn = await (await handleRequest(request('/json?ip=1.0.0.1'), env)).json();
  assert.equal(asn.asn, 'AS15169'); assert.equal(asn.asn_org, 'Google Inc.');
});
test('invalid and reserved custom IPs do not contact storage; missing configuration returns 502', async () => {
  const env = { GEOIP: { get() { throw new Error('Must not read storage'); } }, GEOIP_RELEASE: 'geolite2/test' };
  assert.equal((await handleRequest(request('/json?ip=example.com'), env)).status, 400);
  const local = await handleRequest(request('/json?ip=192.168.1.1'), env);
  assert.equal(local.status, 200); assert.equal((await local.json()).source, 'Reserved address');
  assert.equal((await handleRequest(request('/json?ip=1.1.1.1'))).status, 502);
});
test('unknown public addresses stay usable without invented location or ASN', async () => {
  const result = await handleRequest(request('/json?ip=6.6.6.6'), fixtureEnvironment());
  const data = await result.json();
  assert.equal(result.status, 200); assert.equal(data.ip, '6.6.6.6'); assert.equal(data.source, 'GeoLite2');
  assert.equal(data.city, undefined); assert.equal(data.latitude, undefined); assert.equal(data.asn, undefined);
  const ipv6 = await (await handleRequest(request('/json?ip=2606:4700:4700::1111'), fixtureEnvironment())).json();
  assert.equal(typeof ipv6.ip_decimal, 'string'); assert.equal(ipv6.source, 'GeoLite2');
});
test('storage failures preserve browser UI and retry link, while APIs return 502', async () => {
  const env = { GEOIP_RELEASE: 'geolite2/missing', GEOIP: { get: async () => null } };
  const result = await handleRequest(request('/?ip=6.6.6.6', { Accept: 'text/html' }), env);
  assert.equal(result.status, 502); assert.match(result.headers.get('content-type'), /^text\/html/);
  const html = await result.text();
  assert.match(html, /role="alert"/); assert.match(html, /Lookup unavailable/); assert.match(html, /Retry lookup/);
  assert.match(html, /href="https:\/\/ip.bea.sh\/\?ip=6.6.6.6"/);
  assert.match(html, /id="ip-address" data-ip="6.6.6.6"/); assert.match(html, /id="lookup-ip"/);
  assert.ok(!html.includes('<iframe')); assert.ok(!html.includes('{{'));
  const api = await handleRequest(request('/json?ip=6.6.6.6'), env);
  assert.deepEqual(await api.json(), { error: 'IP lookup is temporarily unavailable. Please try again later.' });
  assert.equal(await (await handleRequest(request('/?ip=6.6.6.6', { Accept: 'text/html' }, 'HEAD'), env)).text(), '');
});
test('database release changes cannot reuse stale lookup results', async () => {
  const saved = globalThis.caches;
  const entries = new Map();
  const pending = [];
  globalThis.caches = { default: { match: async key => entries.get(key.url)?.clone(), put: async (key, value) => entries.set(key.url, value) } };
  try {
    const context = { waitUntil: value => pending.push(value) };
    const first = fixtureEnvironment('geolite2/first');
    await handleRequest(request('/json?ip=81.2.69.160'), first, context);
    await Promise.all(pending);
    const before = first.calls.length;
    await handleRequest(request('/json?ip=81.2.69.160'), first, context);
    assert.equal(first.calls.length, before);
    const second = fixtureEnvironment('geolite2/second');
    const data = await (await handleRequest(request('/json?ip=81.2.69.160'), second, context)).json();
    assert.equal(data.database_release, 'geolite2/second'); assert.ok(second.calls.length > 0);
  } finally { globalThis.caches = saved; }
});
test('invalid manifests and memory budgets fail safely; repaired storage can retry', async () => {
  const env = fixtureEnvironment();
  env.manifest.schema = 99;
  assert.equal((await handleRequest(request('/json?ip=81.2.69.160'), env)).status, 502);
  env.manifest.schema = 1;
  assert.equal((await handleRequest(request('/json?ip=81.2.69.160'), env)).status, 200);
  const tooLarge = fixtureEnvironment();
  tooLarge.manifest.databases.City.nodeCount = 11000000;
  tooLarge.manifest.databases.City.treeSize = 77000000;
  tooLarge.manifest.databases.City.size = 78000000;
  assert.equal((await handleRequest(request('/json?ip=81.2.69.160'), tooLarge)).status, 502);
});
test('unsupported endpoints, methods, HEAD, and unavailable client IP are explicit', async () => {
  assert.equal((await handleRequest(request('/unknown'))).status, 404);
  assert.equal((await handleRequest(request('/port/80'))).status, 501);
  assert.equal((await handleRequest(request('/', {}, 'POST'))).status, 405);
  assert.equal(await (await handleRequest(request('/json', {}, 'HEAD'))).text(), '');
  assert.equal((await handleRequest(new Request('https://ip.bea.sh/json'))).status, 503);
  assert.equal((await handleRequest(request('/healthz'))).status, 200);
});
test('database dates come from deployed MMDB metadata without client IP or database page reads', async () => {
  const env = fixtureEnvironment();
  env.manifest.databases.ASN.buildEpoch = '2026-10-05T08:15:27.000Z';
  env.manifest.databases.City.buildEpoch = '2026-10-06T21:21:33.000Z';
  env.manifest.databases.Country.buildEpoch = '2026-10-06T21:21:33.000Z';
  const response = await handleRequest(new Request('https://ip.bea.sh/database-info'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { source: 'GeoLite2', release: env.GEOIP_RELEASE, databases: {
    ASN: '2026-10-05T08:15:27.000Z', City: '2026-10-06T21:21:33.000Z', Country: '2026-10-06T21:21:33.000Z',
  } });
  assert.equal(env.calls.length, 1);
  assert.equal(await (await handleRequest(new Request('https://ip.bea.sh/database-info', { method: 'HEAD' }), env)).text(), '');
  assert.equal((await handleRequest(new Request('https://ip.bea.sh/database-info'))).status, 503);
});
test('deployment health identifies the running revision without IP metadata or upstream requests', async () => {
  const revision = 'a'.repeat(40);
  const result = await handleRequest(new Request('https://ip.bea.sh/healthz'), { BUILD_REVISION: revision }, {}, () => { throw new Error('Must not fetch'); });
  assert.deepEqual(await result.json(), { status: 'ok', revision });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(await (await handleRequest(request('/healthz', {}, 'HEAD'), { BUILD_REVISION: revision })).text(), '');
});
