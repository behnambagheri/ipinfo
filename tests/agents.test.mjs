import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker/index.mjs';
import { fixtureEnvironment } from './helpers/geoip.mjs';
import { createHTTPServer } from '../server/index.mjs';

function request(path = '/', init = {}) {
  const value = new Request(`https://ip.bea.sh${path}`, { ...init, headers: { 'CF-Connecting-IP': '8.8.8.8', ...init.headers } });
  Object.defineProperty(value, 'cf', { value: { country: 'US', asn: 15169, asOrganization: 'Google LLC' } });
  return value;
}
function rpc(message, headers = {}) {
  return request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(message) });
}

test('discovery documents describe the requesting origin and advertise each other', async () => {
  const llms = await handleRequest(request('/llms.txt'));
  assert.equal(llms.status, 200); assert.match(llms.headers.get('content-type'), /^text\/markdown/);
  const text = await llms.text();
  assert.match(text, /^# IPinfo\n\n> /); assert.match(text, /https:\/\/ip\.bea\.sh\/openapi\.json/); assert.match(text, /https:\/\/ip\.bea\.sh\/mcp/);
  assert.ok(!text.includes('check_port'));

  const spec = await (await handleRequest(request('/openapi.json'))).json();
  assert.equal(spec.openapi, '3.1.0'); assert.equal(spec.servers[0].url, 'https://ip.bea.sh');
  assert.ok(spec.paths['/json'] && spec.paths['/asn-org'] && spec.paths['/coordinates']); assert.ok(!spec.paths['/port/{port}']);
  const withPorts = await (await handleRequest(request('/openapi.json'), {}, { portCheck: async () => ({}) })).json();
  assert.ok(withPorts.paths['/port/{port}']);

  const catalog = await handleRequest(request('/.well-known/api-catalog'));
  assert.match(catalog.headers.get('content-type'), /^application\/linkset\+json/);
  assert.equal((await catalog.json()).linkset[0]['service-desc'][0].href, 'https://ip.bea.sh/openapi.json');

  const robots = await (await handleRequest(request('/robots.txt'))).text();
  assert.match(robots, /Disallow: \/admin/); assert.match(robots, /Disallow: \/internal\//);
  assert.match(robots, /^Sitemap: https:\/\/ip\.bea\.sh\/sitemap\.xml$/m);
  const map = await handleRequest(request('/sitemap.xml'));
  assert.match(map.headers.get('content-type'), /^application\/xml/); assert.match(await map.text(), /<loc>https:\/\/ip\.bea\.sh\/<\/loc>/);
  assert.match((await handleRequest(request('/json'))).headers.get('link'), /<\/openapi\.json>; rel="service-desc"/);
});

test('discovery documents are not counted or rate limited', async () => {
  const recorded = [];
  const context = { statistics: { site: 'ip.bea.sh', record: event => recorded.push(event), snapshot: async () => ({}) }, rateLimit: async () => ({ allowed: false, retry_after: 60 }) };
  for (const path of ['/llms.txt', '/openapi.json', '/.well-known/api-catalog', '/robots.txt', '/sitemap.xml']) assert.equal((await handleRequest(request(path), {}, context)).status, 200);
  assert.equal(recorded.length, 0);
});

test('MCP initializes, lists read-only tools, and acknowledges notifications', async () => {
  const init = await handleRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }));
  assert.equal(init.status, 200);
  const { result } = await init.json();
  assert.equal(result.protocolVersion, '2025-06-18'); assert.equal(result.serverInfo.name, 'ipinfo'); assert.ok(result.capabilities.tools);
  const unknown = await (await handleRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }))).json();
  assert.equal(unknown.result.protocolVersion, '2025-11-25');

  assert.equal((await handleRequest(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202);
  const listed = (await (await handleRequest(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }))).json()).result.tools;
  assert.deepEqual(listed.map(tool => tool.name), ['lookup_ip', 'get_database_info']);
  assert.ok(listed.every(tool => tool.annotations.readOnlyHint));
  const disabled = (await (await handleRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }), {}, { disableCustomIP: true, portCheck: async () => ({}) })).json()).result.tools;
  assert.deepEqual(disabled.map(tool => tool.name), ['lookup_ip', 'get_database_info', 'check_port']);
  assert.deepEqual(disabled[0].inputSchema.properties, {});
});

test('MCP lookup_ip uses the shared handler for visitor and explicit lookups', async () => {
  const visitor = (await (await handleRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup_ip', arguments: {} } }))).json()).result;
  assert.equal(visitor.structuredContent.ip, '8.8.8.8'); assert.equal(visitor.structuredContent.asn_org, 'Google LLC');
  assert.equal(JSON.parse(visitor.content[0].text).ip, '8.8.8.8'); assert.ok(!visitor.isError);

  const explicit = (await (await handleRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup_ip', arguments: { ip: '81.2.69.160' } } }), fixtureEnvironment())).json()).result;
  assert.equal(explicit.structuredContent.ip, '81.2.69.160'); assert.equal(explicit.structuredContent.country_iso, 'GB');

  const invalid = (await (await handleRequest(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lookup_ip', arguments: { ip: 'not-an-ip' } } }))).json()).result;
  assert.equal(invalid.isError, true); assert.match(invalid.structuredContent.error, /valid IPv4 or IPv6/);
});

test('MCP tool calls are rate limited and counted as API requests', async () => {
  const recorded = [];
  const context = { statistics: { site: 'ip.bea.sh', record: event => recorded.push(event) }, rateLimit: async () => ({ allowed: false, retry_after: 30 }) };
  const body = await (await handleRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup_ip', arguments: {} } }), {}, context)).json();
  assert.equal(body.result.isError, true); assert.equal(body.result.structuredContent.retry_after, 30);
  assert.equal(recorded.length, 1); assert.equal(recorded[0].api, 1); assert.equal(recorded[0].errors, 1);
  await handleRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), {}, context);
  assert.equal(recorded.length, 1);
});

test('MCP rejects invalid transport usage with JSON-RPC errors', async () => {
  const get = await handleRequest(request('/mcp'));
  assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
  const options = await handleRequest(request('/mcp', { method: 'OPTIONS' }));
  assert.equal(options.status, 204); assert.match(options.headers.get('access-control-allow-headers'), /Mcp-Protocol-Version/);
  const parse = await handleRequest(request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }));
  assert.equal(parse.status, 400); assert.equal((await parse.json()).error.code, -32700);
  assert.equal((await (await handleRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' }))).json()).error.code, -32601);
  assert.equal((await (await handleRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } }))).json()).error.code, -32602);
  assert.equal((await handleRequest(rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).status, 400);
  assert.equal((await handleRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' }))).status, 400);
  assert.equal((await handleRequest(request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(70000) }))).status, 413);
});

test('container forwards bounded MCP request bodies through the shared handler', async t => {
  const server = createHTTPServer({ lookup: async ip => ({ ip, country_iso: 'GB' }), info: () => ({}) }, {}, { headers: [], disableCustomIP: false, portLookup: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const result = await (await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup_ip', arguments: { ip: '81.2.69.160' } } }))).json();
  assert.equal(result.result.structuredContent.ip, '81.2.69.160'); assert.equal(result.result.structuredContent.country_iso, 'GB');
  assert.equal((await post('x'.repeat(70000))).status, 413);
  assert.equal(await (await fetch(origin + '/ip')).text(), '127.0.0.1\n');
});

test('usage guide shows MCP setup commands for the requesting origin', async () => {
  const text = await (await handleRequest(request('/usage'))).text();
  assert.ok(text.includes('claude mcp add --transport http ipinfo https://ip.bea.sh/mcp'));
  assert.ok(text.includes('codex mcp add ipinfo --url https://ip.bea.sh/mcp'));
  assert.ok(!text.includes('check_port'));
});

test('the page names one canonical URL for every host and lookup', async () => {
  const page = async (path, context) => (await handleRequest(request(path, { headers: { Accept: 'text/html' } }), {}, context)).text();
  assert.match(await page('/'), /<link rel="canonical" href="https:\/\/ip\.bea\.sh\/" \/>/);
  const mirrored = await page('/', { canonicalOrigin: 'https://example.com' });
  assert.match(mirrored, /<link rel="canonical" href="https:\/\/example\.com\/" \/>/); assert.match(mirrored, /"url":"https:\/\/example\.com\/"/);
  assert.match(mirrored, /<meta property="og:image" content="https:\/\/example\.com\/icons\/icon-512\.png" \/>/);
});
