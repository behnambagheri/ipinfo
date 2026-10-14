// Stateless Model Context Protocol server over Streamable HTTP (JSON responses only, no SSE).
// Tool calls are replayed as ordinary GET requests so rate limits and usage statistics apply unchanged.
import pkg from '../package.json' with { type: 'json' };

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const maxBody = 65536;
export const mcpCorsHeaders = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function tools(context) {
  const list = [
    { name: 'lookup_ip', title: 'Look up an IP address',
      description: context.disableCustomIP
        ? "Return the public IP address of the machine making this MCP request, with approximate geolocation (country, region, city, coordinates, time zone) and ASN/network organization. Fields that are unavailable are omitted."
        : "Return approximate geolocation (country, region, city, coordinates, time zone) and ASN/network organization for an IPv4 or IPv6 address. Omit `ip` to describe the public IP of the machine making this MCP request. Private/reserved addresses return only the address; unavailable fields are omitted.",
      inputSchema: { type: 'object', properties: context.disableCustomIP ? {} : { ip: { type: 'string', description: 'IPv4 or IPv6 address, e.g. 8.8.8.8 or 2606:4700:4700::1111' } }, additionalProperties: false },
      annotations },
    { name: 'get_database_info', title: 'Geolocation database info', description: 'Return GeoLite2 database build dates and update status for this service.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations },
  ];
  if (context.portCheck) list.push({ name: 'check_port', title: 'Check a TCP port',
    description: 'Check whether a TCP port is reachable on the public IP of the machine making this MCP request. It cannot test any other host.',
    inputSchema: { type: 'object', properties: { port: { type: 'integer', minimum: 1, maximum: 65535 } }, required: ['port'], additionalProperties: false },
    annotations: { ...annotations, idempotentHint: false } });
  return list;
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

async function callTool(params, request, context, dispatch) {
  const { name, arguments: args = {} } = params || {};
  if (!tools(context).some(tool => tool.name === name)) return { code: -32602, message: `Unknown tool: ${name}` };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { code: -32602, message: 'Tool arguments must be an object.' };
  const url = new URL(request.url);
  if (name === 'lookup_ip') {
    if (args.ip !== undefined && typeof args.ip !== 'string') return { code: -32602, message: 'ip must be a string.' };
    url.pathname = '/json'; url.search = args.ip?.trim() ? `?ip=${encodeURIComponent(args.ip.trim())}` : '';
  } else if (name === 'get_database_info') { url.pathname = '/database-info'; url.search = ''; }
  else {
    if (!Number.isInteger(args.port)) return { code: -32602, message: 'port must be an integer.' };
    url.pathname = `/port/${args.port}`; url.search = '';
  }
  const headers = new Headers(request.headers);
  headers.set('Accept', 'application/json');
  for (const key of ['Content-Type', 'Content-Length', 'Mcp-Protocol-Version', 'Mcp-Session-Id']) headers.delete(key);
  const inner = new Request(url, { method: 'GET', headers });
  if (request.cf) Object.defineProperty(inner, 'cf', { value: request.cf });
  const response = await dispatch(inner);
  let data;
  try { data = await response.json(); } catch { data = { error: 'Unexpected response.' }; }
  const result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  if (!response.ok) result.isError = true;
  return { result };
}

async function handleMessage(message, request, context, dispatch) {
  // Client responses to server requests are accepted; this server never sends requests.
  if (message?.jsonrpc === '2.0' && message.method === undefined && ('result' in message || 'error' in message)) return null;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid Request');
  const { id, method, params } = message;
  // Notifications (no id) never receive a response.
  if (id === undefined) return null;
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return rpcResult(id, { protocolVersion: versions.includes(requested) ? requested : versions[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ipinfo', title: 'IPinfo', version: pkg.version, websiteUrl: new URL(request.url).origin },
        instructions: 'Read-only IP address lookups: geolocation and ASN for any IPv4/IPv6 address, or for the caller when no address is given. Geolocation is approximate.' });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: tools(context) });
    case 'tools/call': {
      const outcome = await callTool(params, request, context, dispatch);
      return outcome.result ? rpcResult(id, outcome.result) : rpcError(id, outcome.code, outcome.message);
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function mcpResponse(request, context, dispatch, headers) {
  const reply = (body, status = 200, extra = {}) => new Response(body === null ? null : JSON.stringify(body) + '\n', { status, headers: { ...headers, ...mcpCorsHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, ...mcpCorsHeaders } });
  // This server never opens server-initiated SSE streams and keeps no sessions.
  if (request.method !== 'POST') return reply(rpcError(null, -32000, 'Method not allowed. Send JSON-RPC messages with POST.'), 405, { Allow: 'POST, OPTIONS' });
  const version = request.headers.get('mcp-protocol-version');
  if (version && !versions.includes(version)) return reply(rpcError(null, -32000, `Unsupported MCP-Protocol-Version: ${version}`), 400);
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return reply(rpcError(null, -32700, 'Content-Type must be application/json.'), 415);
  const text = await request.text();
  if (text.length > maxBody) return reply(rpcError(null, -32600, 'Request body is too large.'), 413);
  let message;
  try { message = JSON.parse(text); } catch { return reply(rpcError(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(message)) return reply(rpcError(null, -32600, 'JSON-RPC batches are not supported.'), 400);
  const result = await handleMessage(message, request, context, dispatch);
  return result === null ? reply(null, 202) : reply(result);
}
