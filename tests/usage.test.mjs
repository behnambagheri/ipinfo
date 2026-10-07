import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/index.mjs';
import { handleCloudflareRequest } from '../worker/cloudflare.mjs';
import { createHTTPServer } from '../server/index.mjs';

test('usage is plain text for CLI and browser clients without IP or database access', async () => {
  const env = { LOCAL_GEOIP: { lookup() { throw new Error('Usage must not look up an IP'); } } };
  let recorded = 0;
  for (const headers of [{ 'User-Agent': 'curl/8.0', Accept: '*/*' }, { Accept: 'text/html' }, { Accept: 'application/json' }]) {
    const result = await handleRequest(new Request('https://ip.bea.sh/usage?ip=invalid', { headers }), env,
      { statistics: { record() { recorded++; } } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const text = await result.text();
    assert.ok(text.startsWith('IPinfo - Usage\n==============\n'));
    for (const example of ["curl 'https://ip.bea.sh'", "curl 'https://ip.bea.sh/json?ip=8.8.8.8'", "curl -6 'https://ip.bea.sh'", '/coordinates', '/country-ir', '/stats.json']) assert.ok(text.includes(example), example);
    assert.ok(!text.includes('<html'));
    assert.ok(!text.includes('\x1b'));
    assert.ok(text.endsWith('\n'));
  }
  assert.equal(recorded, 0);
});

test('usage reflects deployment origin and disabled capabilities', async () => {
  const result = await handleRequest(new Request('http://ip.behnam.pro:8080/usage'), {}, { disableCustomIP: true });
  const text = await result.text();
  assert.ok(text.includes("curl 'http://ip.behnam.pro:8080/json'"));
  assert.ok(text.includes('Custom IP lookups are disabled'));
  assert.ok(text.includes('Port testing is disabled or unavailable'));
  assert.ok(!text.includes('?ip=8.8.8.8'));
  assert.ok(!text.includes('/port/443'));
  assert.ok(!text.includes('/stats'));
});

test('Worker usage describes enabled port checks without opening sockets', async () => {
  const result = await handleCloudflareRequest(new Request('https://ip.bea.sh/usage'), { IPINFO_PORT_LOOKUP: 'true' }, {},
    () => { throw new Error('Usage must not open sockets'); });
  const text = await result.text();
  assert.ok(text.includes("curl 'https://ip.bea.sh/port/443'"));
  assert.ok(text.includes('The ?ip= parameter is ignored for port checks.'));
});

test('usage supports HEAD and OPTIONS and rejects unsupported methods', async () => {
  const head = await handleRequest(new Request('https://ip.bea.sh/usage', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await head.text(), '');
  assert.equal((await handleRequest(new Request('https://ip.bea.sh/usage', { method: 'OPTIONS' }))).status, 204);
  assert.equal((await handleRequest(new Request('https://ip.bea.sh/usage', { method: 'POST' }))).status, 405);
});

test('container serves usage over HTTP without consulting databases', async t => {
  const server = createHTTPServer({ lookup() { throw new Error('Usage must not look up an IP'); } }, {},
    { headers: [], disableCustomIP: false, portLookup: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(origin + '/usage', { headers: { 'User-Agent': 'curl/8.0' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'text/plain; charset=utf-8');
  const text = await result.text();
  assert.ok(text.includes(`curl '${origin}/json'`));
  assert.ok(text.includes(`curl '${origin}/port/443'`));
});
