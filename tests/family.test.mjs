import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/index.mjs';
import { configuredOrigin } from '../worker/family.mjs';

const forbidden = () => { throw new Error('Family selection must not fetch a discovery provider'); };
function request(path, ip = '8.8.8.8', method = 'GET', origin = 'https://ip.bea.sh') {
  return new Request(origin + path, { method, headers: { 'CF-Connecting-IP': ip } });
}
test('default, auto and matching families preserve the visitor address without upstream requests', async () => {
  for (const [ip, family] of [['8.8.8.8', '4'], ['2606:4700:4700::1111', '6']]) {
    for (const suffix of ['', '?family=auto', `?family=${family}`]) {
      const result = await handleRequest(request('/json' + suffix, ip), {}, {}, forbidden);
      assert.equal(result.status, 200);
      assert.equal((await result.json()).ip, ip);
    }
  }
});
test('invalid, duplicate and explicit-lookup family selections return 400 before lookup', async () => {
  for (const query of ['family=ipv4', 'family=5', 'family=4&family=4', 'family=auto&family=6', 'family=4&ip=1.1.1.1', 'family=6&ip=']) {
    assert.equal((await handleRequest(request('/json?' + query), {}, {}, forbidden)).status, 400);
  }
});
test('mismatch without a family endpoint returns 503 rather than another-family address', async () => {
  const result = await handleRequest(request('/json?family=6'), {}, {}, forbidden);
  assert.equal(result.status, 503);
  assert.match((await result.json()).error, /IPv6 switching is unavailable/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('configured switching redirects the client and preserves the endpoint, query and Accept negotiation', async () => {
  for (const [ip, family] of [['8.8.8.8', '6'], ['::1', '4']]) {
    const env = { [`IPINFO_IPV${family}_URL`]: `https://v${family}.example.com` };
    for (const path of ['/ip', '/json', '/country', '/']) {
      const result = await handleRequest(request(`${path}?family=${family}&unused=a%26b`, ip), env, {}, forbidden);
      assert.equal(result.status, 307);
      const target = new URL(result.headers.get('location'));
      assert.equal(target.origin, env[`IPINFO_IPV${family}_URL`]);
      assert.equal(target.pathname, path);
      assert.equal(target.searchParams.get('family'), family);
      assert.equal(target.searchParams.get('unused'), 'a&b');
      assert.equal(target.searchParams.get('_family_redirect'), family);
      assert.equal(result.headers.get('access-control-allow-origin'), '*');
      const follow = await handleRequest(request(target.pathname + target.search, family === '4' ? '8.8.4.4' : '::1', 'GET', target.origin), env, {}, forbidden);
      assert.notEqual(follow.status, 307);
    }
  }
});
test('wrong family after a redirect stops with 409 instead of looping', async () => {
  const result = await handleRequest(request('/json?family=6&_family_redirect=6'), { IPINFO_IPV6_URL: 'https://v6.example.com' }, {}, forbidden);
  assert.equal(result.status, 409);
});
test('dedicated endpoint enforces its family even without an explicit selection', async () => {
  assert.equal((await handleRequest(request('/json'), { IPINFO_REQUIRED_FAMILY: '6' }, {}, forbidden)).status, 409);
  assert.equal((await handleRequest(request('/json', '::1'), { IPINFO_REQUIRED_FAMILY: '6' }, {}, forbidden)).status, 200);
});
test('unsafe, same-origin and insecure redirect configuration fails closed', async () => {
  for (const endpoint of ['http://v6.example.com', 'https://ip.bea.sh', 'https://user:pass@v6.example.com', 'https://v6.example.com/path', 'https://v6.example.com?secret=value', 'javascript:alert(1)']) {
    assert.equal((await handleRequest(request('/ip?family=6'), { IPINFO_IPV6_URL: endpoint }, {}, forbidden)).status, 503);
  }
  assert.equal(configuredOrigin('https://v6.example.com/'), 'https://v6.example.com');
});
test('HEAD preserves family status and redirects without response bodies', async () => {
  for (const [path, env, status] of [['/ip?family=6', {}, 503], ['/ip?family=6', { IPINFO_IPV6_URL: 'https://v6.example.com' }, 307], ['/ip?family=4', {}, 200]]) {
    const result = await handleRequest(request(path, '8.8.8.8', 'HEAD'), env, {}, forbidden);
    assert.equal(result.status, status);
    assert.equal(await result.text(), '');
  }
});
test('HTML uses only configured first-party origins in its CSP and safely embeds network settings', async () => {
  const req = request('/');
  req.headers.set('Accept', 'text/html');
  const result = await handleRequest(req, { IPINFO_IPV6_URL: 'https://v6.example.com', IPINFO_IPV4_URL: 'https://bad.example/path' }, {}, forbidden);
  const html = await result.text();
  assert.ok(!html.includes('ipify'));
  assert.match(result.headers.get('content-security-policy'), /connect-src 'self' https:\/\/v6.example.com;/);
  assert.ok(!result.headers.get('content-security-policy').includes('bad.example'));
  assert.match(html, /family=4/);
});
