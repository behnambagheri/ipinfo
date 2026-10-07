import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/index.mjs';
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
  assert.ok(!html.includes('{{')); assert.ok(!html.includes('value="port"')); assert.match(html, /Cloudflare, IPWHOIS, IP Guide and GeoJS/);
  assert.ok(result.headers.has('Content-Security-Policy'));
});
test('missing geolocation produces a useful map placeholder', async () => {
  const req = new Request('https://ip.bea.sh/', { headers: { Accept: 'text/html', 'CF-Connecting-IP': '127.0.0.1' } });
  const html = await (await handleRequest(req)).text();
  assert.match(html, /Location unavailable/); assert.ok(!html.includes('<iframe'));
});
test('explicit public lookup is validated and normalized to the existing API shape', async () => {
  let called;
  const result = await handleRequest(request('/json?ip=1.1.1.1'), {}, {}, async url => {
    called = url;
    return Response.json({ ip: '1.1.1.1', success: true, country: 'Australia', country_code: 'AU', connection: { asn: 13335, org: 'Cloudflare' }, latitude: -33.8, longitude: 151.2 });
  });
  assert.equal(called, 'https://ipwho.is/1.1.1.1');
  const data = await result.json(); assert.equal(data.ip, '1.1.1.1'); assert.equal(data.asn, 'AS13335'); assert.equal(data.country_iso, 'AU');
});
test('invalid custom IP never reaches a provider, private lookups stay local, and provider failures return 502', async () => {
  const forbidden = () => { throw new Error('Must not fetch'); };
  assert.equal((await handleRequest(request('/json?ip=example.com'), {}, {}, forbidden)).status, 400);
  const local = await handleRequest(request('/json?ip=192.168.1.1'), {}, {}, forbidden);
  assert.equal(local.status, 200); assert.equal((await local.json()).source, 'Reserved address');
  assert.equal((await handleRequest(request('/json?ip=1.1.1.1'), {}, {}, async () => new Response('', { status: 429 }))).status, 502);
  let calls = 0;
  const redirected = await handleRequest(request('/json?ip=1.1.1.1'), {}, {}, async (url, options) => {
    calls++;
    assert.ok(['https://ipwho.is/1.1.1.1', 'https://ip.guide/1.1.1.1', 'https://get.geojs.io/v1/ip/geo/1.1.1.1.json'].includes(url));
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } });
  });
  assert.equal(redirected.status, 502); assert.equal(calls, 3);
});
test('provider throttling falls back without inventing missing geolocation', async () => {
  const fetcher = async url => url.startsWith('https://ipwho.is/')
    ? new Response('', { status: 429 })
    : Response.json({ ip: '2606:4700:4700::1111', network: { autonomous_system: { asn: 13335, organization: 'Cloudflare' } }, location: { country: null, latitude: null, longitude: null } });
  const result = await handleRequest(request('/json?ip=2606:4700:4700::1111'), {}, {}, fetcher);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.source, 'IP Guide'); assert.equal(data.asn, 'AS13335'); assert.equal(typeof data.ip_decimal, 'string');
  assert.equal(data.country_iso, undefined); assert.equal(data.latitude, undefined);
  const located = await handleRequest(request('/json?ip=1.1.1.1'), {}, {}, async url => url.startsWith('https://ipwho.is/')
    ? new Response('', { status: 429 })
    : Response.json({ ip: '1.1.1.1', network: {}, location: { country: 'United Kingdom', latitude: 51.5, longitude: -0.1 } }));
  const locatedData = await located.json();
  assert.equal(locatedData.country_iso, 'GB'); assert.equal(locatedData.country_eu, false);
});
test('6.6.6.6 remains usable when the primary fails and IP Guide has no record', async () => {
  const urls = [];
  const result = await handleRequest(request('/json?ip=6.6.6.6'), {}, {}, async url => {
    urls.push(url);
    if (url.startsWith('https://ipwho.is/')) return new Response('', { status: 429 });
    if (url.startsWith('https://ip.guide/')) return new Response('', { status: 404 });
    return Response.json({ ip: '6.6.6.6', country: 'United States', country_code: 'US', asn: 64512, organization_name: 'Unknown', latitude: '37.751', longitude: '-97.822', timezone: 'America/Chicago' });
  });
  assert.deepEqual(urls, ['https://ipwho.is/6.6.6.6', 'https://ip.guide/6.6.6.6', 'https://get.geojs.io/v1/ip/geo/6.6.6.6.json']);
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.ip, '6.6.6.6'); assert.equal(data.ip_decimal, 101058054);
  assert.equal(data.source, 'GeoJS'); assert.equal(data.country, 'United States'); assert.equal(data.country_eu, false);
  assert.equal(data.latitude, 37.751); assert.equal(data.timezone, 'America/Chicago');
  assert.equal(data.asn, undefined); assert.equal(data.asn_org, undefined); assert.equal(data.city, undefined);
});
test('GeoJS accepts IPv6 but rejects mismatched addresses and empty results', async () => {
  const ip = '2606:4700:4700::1111';
  const fetcher = data => async url => url.startsWith('https://get.geojs.io/') ? Response.json(data) : new Response('', { status: 503 });
  const result = await handleRequest(request(`/json?ip=${ip}`), {}, {}, fetcher({ ip, asn: 13335, organization_name: 'Cloudflare', latitude: null, longitude: null }));
  const data = await result.json();
  assert.equal(result.status, 200); assert.equal(data.source, 'GeoJS'); assert.equal(data.asn, 'AS13335');
  assert.equal(typeof data.ip_decimal, 'string'); assert.equal(data.country, undefined); assert.equal(data.latitude, undefined);
  for (const invalid of [{ ip: '1.1.1.1', country_code: 'US' }, { ip, country_code: 'ZZ', asn: 64512 }, { ip, error: 'No record' }]) {
    assert.equal((await handleRequest(request(`/json?ip=${ip}`), {}, {}, fetcher(invalid))).status, 502);
  }
});
test('lookup outages keep the browser interface and retry link while the API retains 502 JSON', async () => {
  const unavailable = async () => new Response('', { status: 503 });
  const result = await handleRequest(request('/?ip=6.6.6.6', { Accept: 'text/html' }), {}, {}, unavailable);
  assert.equal(result.status, 502); assert.match(result.headers.get('content-type'), /^text\/html/);
  const html = await result.text();
  assert.match(html, /role="alert"/); assert.match(html, /Lookup unavailable/); assert.match(html, /Retry lookup/);
  assert.match(html, /href="https:\/\/ip.bea.sh\/\?ip=6.6.6.6"/);
  assert.match(html, /id="ip-address" data-ip="6.6.6.6"/); assert.match(html, /id="lookup-ip"/); assert.match(html, /id="show-my-ip"/);
  assert.ok(!html.includes('<iframe')); assert.ok(!html.includes('{{'));
  const api = await handleRequest(request('/json?ip=6.6.6.6', { Accept: 'text/html' }), {}, {}, unavailable);
  assert.equal(api.status, 502); assert.match(api.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await api.json(), { error: 'IP lookup is temporarily unavailable. Please try again later.' });
  const negotiated = await handleRequest(request('/?ip=6.6.6.6', { Accept: 'application/json' }), {}, {}, unavailable);
  assert.match(negotiated.headers.get('content-type'), /^application\/json/);
  const head = await handleRequest(request('/?ip=6.6.6.6', { Accept: 'text/html' }, 'HEAD'), {}, {}, unavailable);
  assert.equal(head.status, 502); assert.equal(await head.text(), '');
});
test('unsupported endpoints, methods, HEAD, and unavailable client IP are explicit', async () => {
  assert.equal((await handleRequest(request('/unknown'))).status, 404);
  assert.equal((await handleRequest(request('/port/80'))).status, 501);
  assert.equal((await handleRequest(request('/', {}, 'POST'))).status, 405);
  assert.equal(await (await handleRequest(request('/json', {}, 'HEAD'))).text(), '');
  assert.equal((await handleRequest(new Request('https://ip.bea.sh/json'))).status, 503);
  assert.equal((await handleRequest(request('/healthz'))).status, 200);
});
test('deployment health identifies the running revision without IP metadata or upstream requests', async () => {
  const revision = 'a'.repeat(40);
  const result = await handleRequest(new Request('https://ip.bea.sh/healthz'), { BUILD_REVISION: revision }, {}, () => { throw new Error('Must not fetch'); });
  assert.deepEqual(await result.json(), { status: 'ok', revision });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(await (await handleRequest(request('/healthz', {}, 'HEAD'), { BUILD_REVISION: revision })).text(), '');
});
