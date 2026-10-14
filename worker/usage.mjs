export function renderUsage(url, context = {}) {
  const command = (path = '', flags = '') => `curl ${flags ? flags + ' ' : ''}'${(url.origin + path).replaceAll("'", "'\\''")}'`;
  const endpoints = [
    ['/, /ip', 'Your public IP address'],
    ['/json', 'All available IP information as JSON'],
    ['/ip-decimal', 'IP address as a decimal number'],
    ['/country', 'Country name'],
    ['/country-iso', 'Two-letter country code'],
    ['/country-ir', 'Whether the address is in Iran (true/false)'],
    ['/city', 'City name'],
    ['/region-name', 'Region name'],
    ['/region-code', 'Region code'],
    ['/postal-code', 'Postal code'],
    ['/asn', 'Autonomous system number (e.g. AS15169)'],
    ['/asn-org', 'Network organization'],
    ['/timezone', 'Time zone'],
    ['/coordinates', 'Latitude,longitude'],
    ['/latitude', 'Latitude'],
    ['/longitude', 'Longitude'],
    ['/user-agent', 'Your request User-Agent'],
    ['/database-info', 'Database build dates and update status'],
    ['/healthz, /health', 'Service health and build revision'],
    ['/usage', 'This guide'],
    ['/openapi.json', 'OpenAPI 3.1 description of this API'],
    ['/llms.txt', 'API summary for AI agents (Markdown)'],
    ['/mcp', 'MCP server for AI agents (Streamable HTTP, POST)'],
  ];
  if (context.portCheck) endpoints.push(['/port/<number>', 'TCP port check on your connecting IP']);
  if (context.statistics) endpoints.push(['/stats', 'Usage statistics page'], ['/stats.json', 'Usage statistics as JSON']);
  return `IPinfo - Usage
==============
${url.origin}

QUICK START
  ${command()}
  ${command('/json')}
  ${command('/country')}
  ${command('/asn-org')}

ENDPOINTS
${endpoints.map(([path, description]) => `  ${path.padEnd(20)} ${description}`).join('\n')}

CUSTOM IP LOOKUP
${context.disableCustomIP ? '  Custom IP lookups are disabled on this service.' : `  Append ?ip=<address> to any IP lookup endpoint.
  ${command('/json?ip=8.8.8.8')}
  ${command('/json?ip=2606:4700:4700::1111')}
  ${command('/country?ip=8.8.8.8')}`}

JSON AND SCRIPTING
  ${command('', "-H 'Accept: application/json'")}
  ${command('/json', '-fsS')} | jq -r '.ip'
  ${command('/ip', '-fsS')}
  -f returns a failure exit code for HTTP errors; -sS hides progress
  while keeping error messages visible. The jq example requires jq.

IPV4 AND IPV6
  ${command('', '-4')}
  ${command('', '-6')}
  These flags choose curl's connection family. IPv6 needs a working
  IPv6 connection. A VPN or proxy may forward over a different family.

PORT TESTING
${context.portCheck ? `  ${command('/port/443')}
  Checks a TCP port (1-65535) on your connecting IP and returns JSON.
  The ?ip= parameter is ignored for port checks.` : '  Port testing is disabled or unavailable on this service.'}

AI AGENTS (MCP)
  claude mcp add --transport http ipinfo ${url.origin}/mcp
  codex mcp add ipinfo --url ${url.origin}/mcp
  Other MCP clients can connect to ${url.origin}/mcp (Streamable HTTP,
  no authentication). Tools: lookup_ip, get_database_info${context.portCheck ? ', check_port' : ''}.
  Agent docs: ${url.origin}/llms.txt and ${url.origin}/openapi.json

NOTES
  With no ?ip= parameter, lookups use the IP visible to this service.
  Location is approximate; unavailable fields return HTTP 404 and are
  omitted from JSON. IPv6 decimal values are strings in JSON.
  GET and HEAD are supported; OPTIONS returns the CORS policy.
  Open ${url.origin}/ in a browser for the interactive interface.
`;
}
