import { render } from './render.generated.mjs';
import { templateData } from './render.mjs';
import { normalizeIP, decimalIP, privateIP } from './ip.mjs';
import { assets } from './assets.generated.mjs';

const fields = new Map(['ip', 'ip_decimal', 'country', 'country_iso', 'country_eu', 'city', 'region_name', 'region_code', 'postal_code', 'asn', 'asn_org', 'timezone', 'latitude', 'longitude', 'user_agent'].map(key => [`/${key.replaceAll('_', '-')}`, key]));
const countries = new Intl.DisplayNames(['en'], { type: 'region' });
const countryCodes = new Map();
for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  const code = a + b;
  const name = countries.of(code);
  if (name !== code && code !== 'ZZ') countryCodes.set(name, new Intl.Locale(`und-${code}`).region);
}
const euCountries = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' '));
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self' https://api.ipify.org https://api6.ipify.org; frame-src https://www.openstreetmap.org; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Access-Control-Allow-Origin': '*',
};
function response(body, status = 200, type = 'text/plain; charset=utf-8', head = false) {
  return new Response(head ? null : body, { status, headers: { ...securityHeaders, 'Content-Type': type } });
}
function json(data, status = 200, head = false) { return response(JSON.stringify(data, null, 2) + '\n', status, 'application/json; charset=utf-8', head); }
function number(value) { return value === undefined || value === null || value === '' ? undefined : Number.isFinite(Number(value)) ? Number(value) : undefined; }
function publicASN(value) {
  const asn = number(value);
  // IANA reserves these values for private use, documentation, or protocol purposes.
  if (!Number.isInteger(asn) || asn <= 0 || asn >= 4294967295 || asn === 23456 ||
      (asn >= 64496 && asn <= 65551) || asn >= 4200000000) return undefined;
  return `AS${asn}`;
}
function visitorData(ip, request) {
  const cf = request.cf || {};
  const country = /^[A-Z]{2}$/.test(cf.country || '') ? cf.country : undefined;
  return { ip, ip_decimal: decimalIP(ip), country: country ? countries.of(country) : undefined, country_iso: country, country_eu: cf.isEUCountry === '1', city: cf.city, region_name: cf.region, region_code: cf.regionCode, postal_code: cf.postalCode, timezone: cf.timezone, latitude: number(cf.latitude), longitude: number(cf.longitude), asn: cf.asn ? `AS${cf.asn}` : undefined, asn_org: cf.asOrganization, user_agent: request.headers.get('user-agent') || '', source: 'Cloudflare' };
}
async function lookup(ip, context, fetcher) {
  if (privateIP(ip)) return { ip, ip_decimal: decimalIP(ip), source: 'Reserved address' };
  const key = new Request(`https://ipinfo-cache.invalid/lookup/${encodeURIComponent(ip)}`);
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(key);
  if (cached) return cached.json();
  let data;
  try {
    const result = await providerJSON(`https://ipwho.is/${encodeURIComponent(ip)}`, fetcher);
    if (!result.success || normalizeIP(result.ip) !== ip) throw new Error('Lookup provider could not resolve this address');
    data = { ip, ip_decimal: decimalIP(ip), country: result.country, country_iso: result.country_code, country_eu: result.is_eu, city: result.city, region_name: result.region, region_code: result.region_code, postal_code: result.postal, timezone: result.timezone?.id, latitude: number(result.latitude), longitude: number(result.longitude), asn: result.connection?.asn ? `AS${result.connection.asn}` : undefined, asn_org: result.connection?.org, source: 'IPWHOIS' };
  } catch {
    // Free provider quotas can be shared by unrelated Workers using the same outbound address.
    try {
      const result = await providerJSON(`https://ip.guide/${encodeURIComponent(ip)}`, fetcher);
      if (normalizeIP(result.ip) !== ip || !result.network) throw new Error('Fallback provider could not resolve this address');
      const location = result.location || {};
      const network = result.network.autonomous_system || {};
      const country = countryCodes.get(location.country);
      data = { ip, ip_decimal: decimalIP(ip), country: location.country || undefined, country_iso: country, country_eu: country ? euCountries.has(country) : undefined, city: location.city || undefined, timezone: location.timezone || undefined, latitude: number(location.latitude), longitude: number(location.longitude), asn: network.asn ? `AS${network.asn}` : undefined, asn_org: network.organization, source: 'IP Guide' };
    } catch {
      // IP Guide can return 404 even when another provider has geolocation data.
      const result = await providerJSON(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`, fetcher);
      if (normalizeIP(result.ip) !== ip) throw new Error('Fallback provider returned a different address');
      const country = /^[A-Z]{2}$/.test(result.country_code || '') && countryCodes.has(countries.of(result.country_code)) ? result.country_code : undefined;
      const asn = publicASN(result.asn);
      if (!country && !asn) throw new Error('Fallback provider could not resolve this address');
      const organization = typeof result.organization_name === 'string' && !/^unknown$/i.test(result.organization_name.trim()) ? result.organization_name : undefined;
      data = { ip, ip_decimal: decimalIP(ip), country: country ? countries.of(country) : undefined, country_iso: country, country_eu: country ? euCountries.has(country) : undefined, city: result.city || undefined, region_name: result.region || undefined, timezone: result.timezone || undefined, latitude: number(result.latitude), longitude: number(result.longitude), asn, asn_org: organization, source: 'GeoJS' };
    }
  }
  if (cache && context?.waitUntil) context.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } })));
  return data;
}
async function providerJSON(url, fetcher) {
  // Workers supports manual redirects. Never follow an upstream redirect to a different host.
  const upstream = await fetcher(url, { signal: AbortSignal.timeout(4000), redirect: 'manual', headers: { Accept: 'application/json' } });
  if (!upstream.ok) throw new Error('Lookup provider unavailable');
  return upstream.json();
}
export async function handleRequest(request, env = {}, context = {}, fetcher = fetch) {
  const head = request.method === 'HEAD';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...securityHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Accept' } });
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return json({ status: 'ok', revision: env.BUILD_REVISION }, 200, head);
  if (url.pathname === '/favicon.ico') return new Response(null, { status: 204, headers: securityHeaders });
  const asset = assets.get(url.pathname);
  if (asset) return new Response(head ? null : Uint8Array.from(atob(asset.body), char => char.charCodeAt(0)), {
    headers: { ...securityHeaders, 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ...(url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) },
  });
  if (url.pathname.startsWith('/port/')) return json({ error: 'Port testing is available only in the self-hosted container.' }, 501, head);
  if (!['/', '/json', '/coordinates'].includes(url.pathname) && !fields.has(url.pathname)) return json({ error: 'Not found' }, 404, head);
  const explicit = Boolean(url.searchParams.get('ip')?.trim());
  // Cloudflare overwrites CF-Connecting-IP at the edge. Never trust forwarded headers.
  const ip = normalizeIP(explicit ? url.searchParams.get('ip').trim() : request.headers.get('CF-Connecting-IP'));
  if (!ip) return json({ error: explicit ? 'Provide a valid IPv4 or IPv6 address.' : 'Client IP is unavailable.' }, explicit ? 400 : 503, head);
  let data;
  try { data = explicit ? await lookup(ip, context, fetcher) : visitorData(ip, request); }
  catch {
    const error = 'IP lookup is temporarily unavailable. Please try again later.';
    if (url.pathname === '/' && request.headers.get('accept')?.includes('text/html') && !request.headers.get('accept')?.includes('application/json')) {
      const view = templateData({ ip, ip_decimal: decimalIP(ip), error }, request, explicit);
      Object.assign(view, { LookupError: error, LookupRetryURL: url.href });
      return response(render(view), 502, 'text/html; charset=utf-8', head);
    }
    return json({ error }, 502, head);
  }
  if (url.pathname === '/json' || (url.pathname === '/' && request.headers.get('accept')?.includes('application/json'))) return json(data, 200, head);
  if (url.pathname === '/' && request.headers.get('accept')?.includes('text/html')) return response(render(templateData(data, request, explicit)), 200, 'text/html; charset=utf-8', head);
  if (url.pathname === '/coordinates') return Number.isFinite(data.latitude) && Number.isFinite(data.longitude) ? response(`${data.latitude},${data.longitude}\n`, 200, undefined, head) : response('Location data is unavailable.\n', 404, undefined, head);
  const value = data[fields.get(url.pathname) || 'ip'];
  return value !== undefined && value !== null ? response(`${value}\n`, 200, undefined, head) : response('Data is unavailable for this address.\n', 404, undefined, head);
}
export default { fetch: handleRequest };
