import { workerSite, containerSite, reportPath, snapshot, validateReport } from './statistics.mjs';

export class WorkerStatistics {
  site = workerSite;
  constructor(database) { this.database = database; }
  async record(event) {
    await this.database.prepare(`INSERT INTO usage_daily (site, source, day, web, api, errors, first_seen, last_seen) VALUES (?, 'edge', ?, ?, ?, ?, ?, ?)
      ON CONFLICT (site, source, day) DO UPDATE SET web = web + excluded.web, api = api + excluded.api, errors = errors + excluded.errors,
      first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`)
      .bind(this.site, event.day, event.web, event.api, event.errors, event.first_seen, event.last_seen).run();
  }
  async read(site = this.site, now = new Date()) {
    const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)).toISOString().slice(0, 10);
    // Always query the primary: a stale replica must not acknowledge an uncommitted report.
    const db = this.database.withSession?.('first-primary') || this.database;
    const results = await db.batch([
      db.prepare('SELECT COALESCE(SUM(web), 0) AS web, COALESCE(SUM(api), 0) AS api, COALESCE(SUM(errors), 0) AS errors, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen FROM usage_daily WHERE site = ?').bind(site),
      db.prepare('SELECT day, SUM(web) AS web, SUM(api) AS api, SUM(errors) AS errors FROM usage_daily WHERE site = ? AND day >= ? GROUP BY day ORDER BY day').bind(site, firstDay),
    ]);
    return snapshot(site, results[0].results[0], results[1].results, now);
  }
  snapshot() { return this.read(); }
  async collect(value) {
    const { source, rows } = validateReport(value);
    // Cumulative snapshots are monotonic. Repeated and out-of-order reports never add twice.
    await this.database.batch(rows.map(row => this.database.prepare(`INSERT INTO usage_daily (site, source, day, web, api, errors, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (site, source, day) DO UPDATE SET web = MAX(web, excluded.web), api = MAX(api, excluded.api), errors = MAX(errors, excluded.errors),
      first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)
      WHERE excluded.web > web OR excluded.api > api OR excluded.errors > errors`)
      .bind(containerSite, source, row.day, row.web, row.api, row.errors, row.first_seen, row.last_seen)));
  }
}

async function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const supplied = request.headers.get('authorization') || '';
  if (supplied.length > 512) return false;
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([`Bearer ${secret}`, supplied].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(expected), b = new Uint8Array(actual);
  return a.reduce((diff, byte, index) => diff | (byte ^ b[index]), 0) === 0;
}
async function boundedJSON(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body) throw new Error('Expected JSON');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); throw new Error('Report too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value) + '\n', { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function collectionResponse(request, env, statistics) {
  if (new URL(request.url).pathname !== reportPath) return null;
  if (!await authorized(request, env.IPINFO_STATS_REPORT_TOKEN)) return json({ error: 'Unauthorized' }, 401);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  if (!statistics) return json({ error: 'Statistics are unavailable.' }, 503);
  if (request.method === 'POST') {
    let report;
    try { report = validateReport(await boundedJSON(request)); }
    catch { return json({ error: 'Invalid usage report.' }, 400); }
    try { await statistics.collect(report); }
    catch { return json({ error: 'Statistics storage is unavailable.' }, 503); }
  }
  try { return json(await statistics.read(containerSite)); }
  catch { return json({ error: 'Statistics storage is unavailable.' }, 503); }
}
