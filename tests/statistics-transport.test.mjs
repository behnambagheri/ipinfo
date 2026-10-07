import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { statisticsFetch } from '../server/statistics-transport.mjs';
import { statisticsConfig } from '../server/statistics.mjs';

async function proxy(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const token = 'test'.repeat(16);
test('proxy transport preserves authenticated JSON POST and GET with actual curl', async t => {
  const seen = [];
  const endpoint = await proxy(t, async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    seen.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(request.method === 'POST' ? 200 : 401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ site: 'ip.behnam.pro' }));
  });
  const options = { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'with "quotes" and \\ characters', rows: [] }) };
  const result = await statisticsFetch('http://collector.invalid/internal/usage', options, endpoint, { allowHTTP: true });
  assert.equal(result.status, 200); assert.equal((await result.json()).site, 'ip.behnam.pro');
  assert.equal(seen[0].headers.authorization, 'Bearer ' + token); assert.equal(seen[0].headers['content-type'], 'application/json');
  assert.equal(seen[0].body, options.body); assert.equal(seen[0].url, 'http://collector.invalid/internal/usage');
  const get = await statisticsFetch('http://collector.invalid/internal/usage', { method: 'GET', headers: { Authorization: 'Bearer ' + token } }, endpoint, { allowHTTP: true });
  assert.equal(get.status, 401); assert.equal(seen[1].body, '');
});
test('statistics proxy rejects redirects without forwarding the token and bounds responses', async t => {
  let requests = 0;
  const endpoint = await proxy(t, (request, response) => {
    requests++;
    if (request.url.endsWith('/large')) response.end('x'.repeat(70000));
    else { response.writeHead(302, { Location: 'http://other.invalid/stolen' }); response.end('redirect'); }
  });
  const options = { method: 'GET', headers: { Authorization: 'Bearer ' + token } };
  const result = await statisticsFetch('http://collector.invalid/internal/usage', options, endpoint, { allowHTTP: true });
  assert.equal(result.status, 302); assert.equal(requests, 1);
  await assert.rejects(statisticsFetch('http://collector.invalid/large', options, endpoint, { allowHTTP: true }), error => error.message === 'Statistics transport failed');
  await assert.rejects(statisticsFetch('https://collector.invalid', options, 'http://user:password@127.0.0.1:1'), error => error.message === 'Statistics transport failed');
});
test('statistics proxy settings accept supported transports and reject config injection', () => {
  const env = { IPINFO_STATS_ENDPOINT: 'https://ip.bea.sh/internal/usage', IPINFO_STATS_REPORT_TOKEN: token };
  for (const protocol of ['http', 'https', 'socks5', 'socks5h']) assert.equal(statisticsConfig({ ...env, IPINFO_STATS_PROXY: `${protocol}://proxy.example:7890` }).proxy, `${protocol}://proxy.example:7890`);
  for (const value of ['http://proxy.example\nheader=bad', 'ftp://proxy.example', 'http://proxy.example/path', 'http://proxy.example?query=1']) assert.throws(() => statisticsConfig({ ...env, IPINFO_STATS_PROXY: value }));
});
