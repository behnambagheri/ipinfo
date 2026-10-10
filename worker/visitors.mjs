import { normalizeIP } from './ip.mjs';
import { workerSite, containerSite, validateReport } from './statistics.mjs';

export const visitorReportPath = '/internal/visitors';
export const visitorRetentionDays = 30;
export const visitorsEnabled = env => [true, 'true', '1'].includes(env.IPINFO_VISITOR_STATS_ENABLED);
export function retentionStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - visitorRetentionDays + 1)).toISOString().slice(0, 10);
}
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) : '';
export function visitorEvent(event, ip, data = {}) {
  ip = normalizeIP(ip);
  if (!event || !ip) return null;
  return { ...event, ip, country: clean(data.country), city: clean(data.city), provider: clean(data.asn_org) };
}
export function validateVisitorReport(value, now = new Date()) {
  if (!value || Object.keys(value).some(key => !['source', 'rows'].includes(key)) || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 100) throw new Error('Invalid visitor report');
  const keys = new Set();
  for (const row of value.rows) {
    if (!row || typeof row.ip !== 'string' || Object.keys(row).some(key => !['day', 'ip', 'country', 'city', 'provider', 'web', 'api', 'errors', 'first_seen', 'last_seen'].includes(key)) || normalizeIP(row.ip) !== row.ip ||
        ['country', 'city', 'provider'].some(key => typeof row[key] !== 'string' || row[key].length > 256 || clean(row[key]) !== row[key])) throw new Error('Invalid visitor row');
    const { ip, country, city, provider, ...counts } = row;
    validateReport({ source: value.source, rows: [counts] }, now);
    const key = `${row.day}/${ip}`;
    if (keys.has(key)) throw new Error('Duplicate visitor row');
    keys.add(key);
  }
  return value;
}
export function visitorFilters(url, now = new Date()) {
  const site = url.searchParams.get('site') || workerSite;
  const earliest = retentionStart(now), today = now.toISOString().slice(0, 10);
  const from = url.searchParams.get('from') || earliest, to = url.searchParams.get('to') || today;
  const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  const pageText = url.searchParams.get('page') || '1';
  const page = Number(pageText), search = (url.searchParams.get('q') || '').trim();
  if (![workerSite, containerSite].includes(site) || !validDay(from) || !validDay(to) || from < earliest || to > today || from > to ||
      !/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 100000 || search.length > 256) throw new Error('Invalid visitor filters');
  return { site, from, to, page, page_size: 50, search };
}
