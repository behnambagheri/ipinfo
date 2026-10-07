export const workerSite = 'ip.bea.sh';
export const containerSite = 'ip.behnam.pro';
export const reportPath = '/internal/usage';
const routes = new Set(['/', '/ip', '/json', '/ip-decimal', '/country', '/country-iso', '/country-ir', '/city', '/region-name', '/region-code', '/postal-code', '/asn', '/asn-org', '/timezone', '/coordinates', '/latitude', '/longitude', '/user-agent']);

// Count diagnostic GET requests only; assets, probes, and statistics cannot inflate usage.
export function usageEvent(request, result, now = new Date()) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' || (!routes.has(path) && !path.startsWith('/port/'))) return null;
  const timestamp = now.toISOString();
  return { day: timestamp.slice(0, 10), web: Number(result.headers.get('content-type')?.startsWith('text/html') === true),
    api: Number(result.headers.get('content-type')?.startsWith('text/html') !== true), errors: Number(result.status >= 400),
    first_seen: timestamp, last_seen: timestamp };
}
export function totals(rows) {
  const value = rows.reduce((sum, row) => ({ web: sum.web + Number(row.web), api: sum.api + Number(row.api), errors: sum.errors + Number(row.errors) }), { web: 0, api: 0, errors: 0 });
  return { total: value.web + value.api, ...value };
}
export function snapshot(site, summary, rows, now = new Date()) {
  const daily = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29 + index)).toISOString().slice(0, 10);
    return { day, ...totals(rows.filter(row => row.day === day)) };
  });
  return { site, metric: 'diagnostic_get_requests', timezone: 'UTC', started_at: summary.first_seen || null,
    last_request_at: summary.last_seen || null, updated_at: now.toISOString(), stale: false,
    all_time: totals([summary]), today: totals(daily.slice(-1)), last_30_days: totals(daily), daily };
}
export function validateReport(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['source', 'rows'].includes(key)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.source || '') ||
      !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 30) throw new Error('Invalid usage report');
  const days = new Set();
  for (const row of value.rows) {
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => !['day', 'web', 'api', 'errors', 'first_seen', 'last_seen'].includes(key))) throw new Error('Invalid usage row');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day || '') || !Number.isFinite(Date.parse(row.day)) || new Date(row.day).toISOString().slice(0, 10) !== row.day || row.day > now.toISOString().slice(0, 10) || days.has(row.day)) throw new Error('Invalid usage day');
    days.add(row.day);
    if (['web', 'api', 'errors'].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 1e12) || row.errors > row.web + row.api || row.web + row.api === 0) throw new Error('Invalid usage counts');
    for (const key of ['first_seen', 'last_seen']) {
      if (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key])) || new Date(row[key]).toISOString() !== row[key] || row[key].slice(0, 10) !== row.day || Date.parse(row[key]) > now.getTime() + 300000) throw new Error('Invalid usage timestamp');
    }
    if (row.first_seen > row.last_seen) throw new Error('Invalid usage interval');
  }
  return value;
}
