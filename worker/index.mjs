import { render } from './render.generated.mjs';
import { templateData } from './render.mjs';
import { normalizeIP, decimalIP } from './ip.mjs';
import { assets } from './assets.generated.mjs';
import { lookupGeoIP, databaseInfo } from './geoip.mjs';
import { renderStatistics } from './statistics-page.generated.mjs';
import { usageEvent } from './statistics.mjs';
import { renderUsage } from './usage.mjs';

const fields = new Map(['ip', 'ip_decimal', 'country', 'country_iso', 'country_ir', 'city', 'region_name', 'region_code', 'postal_code', 'asn', 'asn_org', 'timezone', 'latitude', 'longitude', 'user_agent'].map(key => [`/${key.replaceAll('_', '-')}`, key]));
const countries = new Intl.DisplayNames(['en'], { type: 'region' });
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
function visitorData(ip, request) {
  const cf = request.cf || {};
  const country = /^[A-Z]{2}$/.test(cf.country || '') ? cf.country : undefined;
  return { ip, ip_decimal: decimalIP(ip), country: country ? countries.of(country) : undefined, country_iso: country, country_ir: country === 'IR', city: cf.city, region_name: cf.region, region_code: cf.regionCode, postal_code: cf.postalCode, timezone: cf.timezone, latitude: number(cf.latitude), longitude: number(cf.longitude), asn: cf.asn ? `AS${cf.asn}` : undefined, asn_org: cf.asOrganization, user_agent: request.headers.get('user-agent') || '', source: 'Cloudflare' };
}
export async function handleRequest(request, env = {}, context = {}) {
  const result = await diagnosticResponse(request, env, context);
  if (context.statistics) {
    const event = usageEvent(request, result);
    if (event) {
      // Recording never turns a successful diagnostic into an error response.
      const pending = Promise.resolve().then(() => context.statistics.record(event)).catch(() => {
        console.warn('Usage recording is temporarily unavailable.');
      });
      if (context.waitUntil) context.waitUntil(pending);
      else await pending;
    }
  }
  return result;
}
async function diagnosticResponse(request, env = {}, context = {}) {
  const head = request.method === 'HEAD';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...securityHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Accept' } });
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  const url = new URL(request.url);
  if (url.pathname === '/usage') return response(renderUsage(url, context), 200, undefined, head);
  if (['/stats', '/stats.json'].includes(url.pathname)) {
    if (!context.statistics) return json({ error: 'Statistics are not configured.' }, 503, head);
    if (url.pathname === '/stats') return response(renderStatistics({ Site: context.statistics.site }), 200, 'text/html; charset=utf-8', head);
    try { return json(await context.statistics.snapshot(), 200, head); }
    catch { return json({ error: 'Statistics are temporarily unavailable.' }, 503, head); }
  }
  if (['/healthz', '/health'].includes(url.pathname)) return json({ status: 'ok', revision: env.BUILD_REVISION, database_release: env.GEOIP_RELEASE }, 200, head);
  if (url.pathname === '/database-info') {
    try { return json(await (env.LOCAL_GEOIP ? env.LOCAL_GEOIP.info() : databaseInfo(env)), 200, head); }
    catch { return json({ error: 'Database dates are unavailable.' }, 503, head); }
  }
  const asset = assets.get(url.pathname);
  if (asset) return new Response(head ? null : Uint8Array.from(atob(asset.body), char => char.charCodeAt(0)), {
    headers: { ...securityHeaders, 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ...(url.pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) },
  });
  if (url.pathname.startsWith('/port/')) {
    if (context.portCheck) {
      try { return json(await context.portCheck(url.pathname.slice(6)), 200, head); }
      catch (error) { return json({ error: error.status ? error.message : 'Port testing is temporarily unavailable.' }, error.status || 502, head); }
    }
    return json({ error: 'Port testing is disabled or unavailable in this deployment.' }, 501, head);
  }
  if (!['/', '/json', '/coordinates'].includes(url.pathname) && !fields.has(url.pathname)) return json({ error: 'Not found' }, 404, head);
  const explicit = Boolean(url.searchParams.get('ip')?.trim());
  if (explicit && context.disableCustomIP) return json({ error: 'Custom IP lookups are disabled.' }, 400, head);
  // Cloudflare overwrites CF-Connecting-IP at the edge. Never trust forwarded headers.
  const ip = normalizeIP(explicit ? url.searchParams.get('ip').trim() : (context.clientIP ?? request.headers.get('CF-Connecting-IP')));
  if (!ip) return json({ error: explicit ? 'Provide a valid IPv4 or IPv6 address.' : 'Client IP is unavailable.' }, explicit ? 400 : 503, head);
  let data;
  try {
    data = env.LOCAL_GEOIP ? await env.LOCAL_GEOIP.lookup(ip) : explicit ? await lookupGeoIP(ip, env, context) : visitorData(ip, request);
    data = { ...data, user_agent: request.headers.get('user-agent') || '' };
    if (context.hostname) data.hostname = await context.hostname(ip);
  }
  catch {
    const error = 'IP lookup is temporarily unavailable. Please try again later.';
    if (url.pathname === '/' && request.headers.get('accept')?.includes('text/html') && !request.headers.get('accept')?.includes('application/json')) {
      const view = templateData({ ip, ip_decimal: decimalIP(ip), error }, request, explicit, context);
      Object.assign(view, { LookupError: error, LookupRetryURL: url.href });
      return response(render(view), 502, 'text/html; charset=utf-8', head);
    }
    return json({ error }, 502, head);
  }
  if (url.pathname === '/json' || (url.pathname === '/' && request.headers.get('accept')?.includes('application/json'))) return json(data, 200, head);
  if (url.pathname === '/' && request.headers.get('accept')?.includes('text/html')) return response(render(templateData(data, request, explicit, context)), 200, 'text/html; charset=utf-8', head);
  if (url.pathname === '/coordinates') return Number.isFinite(data.latitude) && Number.isFinite(data.longitude) ? response(`${data.latitude},${data.longitude}\n`, 200, undefined, head) : response('Location data is unavailable.\n', 404, undefined, head);
  const value = data[fields.get(url.pathname) || 'ip'];
  return value !== undefined && value !== null ? response(`${value}\n`, 200, undefined, head) : response('Data is unavailable for this address.\n', 404, undefined, head);
}
export default { fetch: handleRequest };
