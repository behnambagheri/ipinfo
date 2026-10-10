import { workerSite, containerSite } from './statistics.mjs';
import { retentionStart, validateVisitorReport, visitorReportPath, visitorsEnabled } from './visitors.mjs';
import { authorized, boundedJSON } from './statistics-store.mjs';

export class WorkerVisitors {
  constructor(database) { this.database = database; }
  statement(site, source, row, cumulative = false) {
    const counts = cumulative ? 'MAX(web, excluded.web), api = MAX(api, excluded.api), errors = MAX(errors, excluded.errors)' : 'web + excluded.web, api = api + excluded.api, errors = errors + excluded.errors';
    return this.database.prepare(`INSERT INTO usage_ip_daily (site, source, day, ip, country, city, provider, web, api, errors, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (site, source, day, ip) DO UPDATE SET web = ${counts},
      country = CASE WHEN excluded.last_seen >= last_seen THEN excluded.country ELSE country END,
      city = CASE WHEN excluded.last_seen >= last_seen THEN excluded.city ELSE city END,
      provider = CASE WHEN excluded.last_seen >= last_seen THEN excluded.provider ELSE provider END,
      first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)
      ${cumulative ? 'WHERE excluded.web > web OR excluded.api > api OR excluded.errors > errors OR excluded.last_seen > last_seen' : ''}`)
      .bind(site, source, row.day, row.ip, row.country, row.city, row.provider, row.web, row.api, row.errors, row.first_seen, row.last_seen);
  }
  async record(row) { await this.statement(workerSite, 'edge', row).run(); }
  async collect(value, now = new Date()) {
    const { source, rows } = validateVisitorReport(value, now);
    const fresh = rows.filter(row => row.day >= retentionStart(now));
    if (fresh.length) await this.database.batch(fresh.map(row => this.statement(containerSite, source, row, true)));
  }
  async prune(now = new Date()) {
    await this.database.prepare('DELETE FROM usage_ip_daily WHERE day < ?').bind(retentionStart(now)).run();
  }
  async list(filters, now = new Date()) {
    const { site, from, to, page, page_size, search } = filters;
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const where = `site = ? AND day BETWEEN ? AND ? AND day >= ? AND (? = '' OR ip LIKE ? ESCAPE '\\' OR country LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR provider LIKE ? ESCAPE '\\')`;
    const params = [site, from, to, retentionStart(now), search, pattern, pattern, pattern, pattern];
    const db = this.database.withSession?.('first-primary') || this.database;
    const result = await db.batch([
      db.prepare(`WITH filtered AS (SELECT * FROM usage_ip_daily WHERE ${where}),
        counts AS (SELECT ip, SUM(web) AS web, SUM(api) AS api, SUM(errors) AS errors, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen FROM filtered GROUP BY ip),
        metadata AS (SELECT ip, country, city, provider, ROW_NUMBER() OVER (PARTITION BY ip ORDER BY last_seen DESC, source) AS position FROM filtered)
        SELECT counts.*, counts.web + counts.api AS total, metadata.country, metadata.city, metadata.provider FROM counts JOIN metadata USING (ip)
        WHERE metadata.position = 1 ORDER BY total DESC, ip LIMIT ? OFFSET ?`).bind(...params, page_size, (page - 1) * page_size),
      db.prepare(`SELECT COUNT(DISTINCT ip) AS matched_ips, COALESCE(SUM(web), 0) AS web, COALESCE(SUM(api), 0) AS api, COALESCE(SUM(errors), 0) AS errors FROM usage_ip_daily WHERE ${where}`).bind(...params),
    ]);
    const { matched_ips, ...counts } = result[1].results[0];
    return { ...filters, retention_days: 30, timezone: 'UTC', earliest_day: retentionStart(now), updated_at: now.toISOString(),
      matched_ips, totals: { ...counts, total: counts.web + counts.api }, rows: result[0].results };
  }
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value) + '\n', { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function visitorCollectionResponse(request, env, visitors) {
  if (new URL(request.url).pathname !== visitorReportPath) return null;
  if (!await authorized(request, env.IPINFO_STATS_REPORT_TOKEN)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!visitorsEnabled(env) || !visitors) return json({ error: 'Visitor recording is disabled.' }, 503);
  let report;
  try { report = validateVisitorReport(await boundedJSON(request, 524288)); }
  catch { return json({ error: 'Invalid visitor report.' }, 400); }
  try { await visitors.collect(report); return json({ accepted: true }); }
  catch { return json({ error: 'Visitor storage is unavailable.' }, 503); }
}
