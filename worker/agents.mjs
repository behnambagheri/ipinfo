// Machine-readable discovery documents for AI agents and API tooling.
// Every document reflects the requesting origin and this deployment's optional features.
import pkg from '../package.json' with { type: 'json' };

export const discoveryLinks = '</openapi.json>; rel="service-desc"; type="application/openapi+json", </llms.txt>; rel="describedby"; type="text/markdown", </.well-known/api-catalog>; rel="api-catalog"';

export const lookupFields = [
  ['/ip', 'ip', 'IP address'],
  ['/ip-decimal', 'ip_decimal', 'IP address as a decimal number (IPv6 as an exact string)'],
  ['/country', 'country', 'Country name'],
  ['/country-iso', 'country_iso', 'ISO 3166-1 alpha-2 country code'],
  ['/country-ir', 'country_ir', 'Whether the address is in Iran (true/false)'],
  ['/city', 'city', 'City name'],
  ['/region-name', 'region_name', 'Region name'],
  ['/region-code', 'region_code', 'Region code'],
  ['/postal-code', 'postal_code', 'Postal code'],
  ['/asn', 'asn', 'Autonomous system number, e.g. AS15169'],
  ['/asn-org', 'asn_org', 'Network organization'],
  ['/timezone', 'timezone', 'IANA time zone'],
  ['/latitude', 'latitude', 'Approximate latitude'],
  ['/longitude', 'longitude', 'Approximate longitude'],
  ['/user-agent', 'user_agent', 'Raw request User-Agent'],
];

export function renderLlms(url, context = {}) {
  const o = url.origin;
  const custom = !context.disableCustomIP;
  return `# IPinfo

> Free, keyless IP address and network lookup API: public IP, approximate geolocation (country, region, city, coordinates, time zone), and ASN/network organization, from self-hosted GeoLite2 databases. No account, API key, or cookies.

Without \`?ip=\`, every lookup describes the IP address that connected to this service (the caller's public IP).${custom ? ' Add `?ip=<IPv4 or IPv6>` to look up any address.' : ' Custom IP lookups are disabled on this deployment.'} Geolocation is approximate and may reflect a VPN or provider. Private/reserved addresses return only the address.

## Quick start

- \`curl ${o}/json\` — all available fields as JSON
- \`curl ${o}/ip\` — plain-text IP address${custom ? `
- \`curl '${o}/json?ip=8.8.8.8'\` — look up a specific address` : ''}
- \`curl ${o}/country-iso\` — a single field as plain text

## API

- [OpenAPI 3.1 description](${o}/openapi.json): machine-readable schema for every endpoint
- [Usage guide](${o}/usage): terminal-friendly plain-text reference with examples
- [MCP server](${o}/mcp): Streamable HTTP Model Context Protocol endpoint (stateless, no auth) with tools \`lookup_ip\`, \`get_database_info\`${context.portCheck ? ', `check_port`' : ''}

## Behavior

- JSON omits unavailable fields; single-field endpoints return HTTP 404 when a value is unavailable.
- Errors are JSON objects with an \`error\` message. Invalid addresses return 400.
- HTTP 429 means the per-source-IP rate limit was reached; wait \`Retry-After\` seconds.
- Responses are never cached (\`Cache-Control: no-store\`); CORS is open to all origins.
- GET and HEAD are supported on lookup routes.

## Optional

- [Database info](${o}/database-info): GeoLite2 build dates and update status
- [Health](${o}/healthz): service status and build revision${context.statistics ? `
- [Statistics](${o}/stats.json): aggregate request counters for this deployment` : ''}
`;
}

const errorResponse = description => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const ipParameter = { $ref: '#/components/parameters/ip' };

export function openAPI(url, context = {}) {
  const lookupErrors = { 400: errorResponse('Invalid IP address, or custom lookups disabled'), 429: { $ref: '#/components/responses/RateLimited' }, 502: errorResponse('Geolocation database unavailable') };
  const parameters = context.disableCustomIP ? [] : [ipParameter];
  const paths = {
    '/json': { get: { operationId: 'lookupJSON', summary: 'All available information for an IP address', parameters,
      responses: { 200: { description: 'IP information; unavailable fields are omitted', content: { 'application/json': { schema: { $ref: '#/components/schemas/IPInfo' } } } }, ...lookupErrors } } },
    '/coordinates': { get: { operationId: 'getCoordinates', summary: 'Approximate coordinates as "latitude,longitude"', parameters,
      responses: { 200: { description: 'Coordinates', content: { 'text/plain': { schema: { type: 'string', example: '37.751,-97.822' } } } }, 404: { description: 'Location unavailable' }, ...lookupErrors } } },
  };
  for (const [path, key, summary] of lookupFields) {
    paths[path] = { get: { operationId: `get_${key}`, summary, parameters,
      responses: { 200: { description: summary, content: { 'text/plain': { schema: { type: 'string' } } } }, 404: { description: 'Value unavailable for this address' }, ...lookupErrors } } };
  }
  paths['/database-info'] = { get: { operationId: 'getDatabaseInfo', summary: 'GeoLite2 database build dates and update status', responses: { 200: { description: 'Database metadata', content: { 'application/json': { schema: { type: 'object' } } } }, 503: errorResponse('Unavailable') } } };
  paths['/healthz'] = { get: { operationId: 'getHealth', summary: 'Service health, build revision, and active database release', responses: { 200: { description: 'Healthy', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, revision: { type: 'string' }, database_release: { type: 'string' } } } } } } } } };
  paths['/usage'] = { get: { operationId: 'getUsage', summary: 'Plain-text usage guide', responses: { 200: { description: 'Guide', content: { 'text/plain': { schema: { type: 'string' } } } } } } };
  if (context.portCheck) paths['/port/{port}'] = { get: { operationId: 'checkPort', summary: "Check a TCP port on the caller's own connecting IP (?ip= is ignored)",
    parameters: [{ name: 'port', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 65535 } }],
    responses: { 200: { description: 'Port check result', content: { 'application/json': { schema: { type: 'object', properties: { ip: { type: 'string' }, port: { type: 'integer' }, reachable: { type: 'boolean' }, status: { type: 'string' }, elapsed_ms: { type: 'integer' } } } } } }, 400: errorResponse('Invalid port'), 429: { $ref: '#/components/responses/RateLimited' } } } };
  if (context.statistics) paths['/stats.json'] = { get: { operationId: 'getStatistics', summary: 'Aggregate request counters for this deployment', responses: { 200: { description: 'Statistics', content: { 'application/json': { schema: { type: 'object' } } } }, 503: errorResponse('Unavailable') } } };
  const properties = Object.fromEntries(lookupFields.map(([, key, description]) => [key, { type: key === 'latitude' || key === 'longitude' ? 'number' : key === 'country_ir' ? 'boolean' : 'string', description }]));
  properties.ip_decimal = { oneOf: [{ type: 'integer' }, { type: 'string' }], description: 'Decimal IP; IPv6 values are strings to preserve precision' };
  properties.hostname = { type: 'string', description: 'Reverse DNS name, when enabled and available' };
  return {
    openapi: '3.1.0',
    info: { title: 'IPinfo', version: pkg.version, description: `Keyless IP address, geolocation, and ASN lookup. Without the ip parameter, lookups describe the caller's public IP. Plain-text guide: ${url.origin}/usage. MCP endpoint: ${url.origin}/mcp.` },
    servers: [{ url: url.origin }],
    paths,
    components: {
      parameters: { ip: { name: 'ip', in: 'query', required: false, description: "IPv4 or IPv6 address to look up; omit to use the caller's IP", schema: { type: 'string' }, examples: { ipv4: { value: '8.8.8.8' }, ipv6: { value: '2606:4700:4700::1111' } } } },
      responses: { RateLimited: { description: 'Rate limit exceeded', headers: { 'Retry-After': { schema: { type: 'integer' } } }, content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/Error' }, { type: 'object', properties: { retry_after: { type: 'integer' } } }] } } } } },
      schemas: { IPInfo: { type: 'object', required: ['ip'], properties }, Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } },
    },
  };
}

// RFC 9727 API catalog in RFC 9264 linkset format.
export function apiCatalog(url) {
  const o = url.origin;
  return { linkset: [{ anchor: `${o}/`,
    'service-desc': [{ href: `${o}/openapi.json`, type: 'application/openapi+json' }],
    'service-doc': [{ href: `${o}/usage`, type: 'text/plain' }, { href: `${o}/llms.txt`, type: 'text/markdown' }],
    status: [{ href: `${o}/healthz`, type: 'application/json' }] }] };
}

export function robots(url) {
  return `User-agent: *
Allow: /
Disallow: /admin
Disallow: /internal/

Sitemap: ${url.origin}/sitemap.xml

# API description for agents: ${url.origin}/llms.txt
`;
}

export function sitemap(url) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${url.origin}/</loc></url>
</urlset>
`;
}
