import { normalizeIP } from './ip.mjs';
import { workerSite, containerSite } from './statistics.mjs';
import { authorized, boundedJSON } from './statistics-store.mjs';

export const rateLimitPath = '/internal/rate-limit';
const validSite = site => [workerSite, containerSite].includes(site);
export function validateRateLimit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['site', 'max_requests', 'window_seconds'].includes(key)) ||
      !validSite(value.site) || !Number.isSafeInteger(value.max_requests) || value.max_requests < 0 || value.max_requests > 1000000 ||
      !Number.isSafeInteger(value.window_seconds) || value.window_seconds < 1 || value.window_seconds > 86400) throw new Error('Invalid rate limit');
  return value;
}
export class WorkerRateLimits {
  constructor(database) { this.database = database; }
  async settings(site) {
    if (!validSite(site)) throw new Error('Invalid site');
    const db = this.database.withSession?.('first-primary') || this.database;
    const { results } = await db.prepare('SELECT site, max_requests, window_seconds FROM rate_limit_settings WHERE site = ?').bind(site).all();
    return results[0] || { site, max_requests: 0, window_seconds: 60 };
  }
  async save(value) {
    const { site, max_requests, window_seconds } = validateRateLimit(value);
    await this.database.prepare(`INSERT INTO rate_limit_settings (site, max_requests, window_seconds, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT (site) DO UPDATE SET max_requests = excluded.max_requests, window_seconds = excluded.window_seconds, revision = excluded.revision`)
      .bind(site, max_requests, window_seconds, crypto.randomUUID()).run();
    return value;
  }
  async check(site, sourceIP, now = new Date()) {
    const ip = normalizeIP(sourceIP);
    if (!validSite(site) || !ip) throw new Error('Invalid rate-limit identity');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${site}/${ip}`));
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const timestamp = now.getTime();
    // Read the current policy and consume a slot in one atomic statement. This
    // also serializes concurrent requests across Worker instances and replicas.
    const { results } = await this.database.prepare(`INSERT INTO rate_limit_buckets (site, ip_key, revision, requests, expires_at)
      SELECT site, ?, revision, 1, ? + window_seconds * 1000 FROM rate_limit_settings WHERE site = ? AND max_requests > 0
      ON CONFLICT (site, ip_key) DO UPDATE SET
        requests = CASE WHEN rate_limit_buckets.revision != excluded.revision OR expires_at <= ? THEN 1
          ELSE MIN(requests + 1, (SELECT max_requests + 1 FROM rate_limit_settings WHERE site = excluded.site)) END,
        expires_at = CASE WHEN rate_limit_buckets.revision != excluded.revision OR expires_at <= ? THEN excluded.expires_at ELSE expires_at END,
        revision = excluded.revision
      RETURNING requests, expires_at, (SELECT max_requests FROM rate_limit_settings WHERE site = ?) AS max_requests`)
      .bind(key, timestamp, site, timestamp, timestamp, site).all();
    const row = results[0];
    return { allowed: !row || row.requests <= row.max_requests, retry_after: row && row.requests > row.max_requests ? Math.max(1, Math.ceil((row.expires_at - timestamp) / 1000)) : 0 };
  }
  async prune(now = new Date()) {
    await this.database.prepare('DELETE FROM rate_limit_buckets WHERE expires_at <= ?').bind(now.getTime()).run();
  }
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value) + '\n', { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function rateLimitCollectionResponse(request, env, limits) {
  if (new URL(request.url).pathname !== rateLimitPath) return null;
  if (!await authorized(request, env.IPINFO_STATS_REPORT_TOKEN)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!limits) return json({ error: 'Rate limits are unavailable.' }, 503);
  let ip;
  try {
    const value = await boundedJSON(request, 1024);
    if (!value || Object.keys(value).some(key => key !== 'ip') || !(ip = normalizeIP(value.ip))) throw new Error('Invalid IP');
  } catch { return json({ error: 'Provide a valid source IP.' }, 400); }
  // The reporting token can consume only container slots, never edit policies.
  try { return json(await limits.check(containerSite, ip)); }
  catch { return json({ error: 'Rate limits are temporarily unavailable.' }, 503); }
}
