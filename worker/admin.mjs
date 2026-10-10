import { authorizedAdmin } from './admin-auth.mjs';
import { visitorFilters } from './visitors.mjs';
import { renderAdmin } from './admin-page.generated.mjs';

const headers = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
function reply(value, status = 200, html = false, head = false) {
  return new Response(head ? null : html ? value : JSON.stringify(value) + '\n', {
    status, headers: { ...headers, 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' },
  });
}
export async function adminResponse(request, env, visitors, { authorize = authorizedAdmin, now = new Date() } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return null;
  const head = request.method === 'HEAD';
  // Authenticate every admin path before reading storage or rendering private UI.
  if (!await authorize(request, env)) return reply({ error: 'Private dashboard access is required.' }, 403, false, head);
  if (!['GET', 'HEAD'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405, false, head);
  if (url.pathname === '/admin/usage') return reply(renderAdmin({}), 200, true, head);
  if (url.pathname !== '/admin/usage.json') return reply({ error: 'Not found' }, 404, false, head);
  if (!visitors) return reply({ error: 'Visitor recording is disabled.' }, 503, false, head);
  let filters;
  try { filters = visitorFilters(url, now); }
  catch { return reply({ error: 'Choose one site and a valid date range within the last 30 reporting days.' }, 400, false, head); }
  try { return reply(await visitors.list(filters, now), 200, false, head); }
  catch { return reply({ error: 'Visitor statistics are temporarily unavailable.' }, 503, false, head); }
}
