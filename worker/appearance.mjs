import { workerSite, containerSite } from './statistics.mjs';
import { authorized } from './statistics-store.mjs';

// Product accents from the design system (public/ds/v1/tokens.css); blue is its default.
export const accents = ['blue', 'teal', 'cyan', 'indigo', 'violet', 'fuchsia'];
export const defaultAccent = 'blue';
// Light-theme --bb-accent values from tokens.css, for the browser theme-color meta tag.
export const themeColors = { blue: '#2563eb', teal: '#0f766e', cyan: '#0e7490', indigo: '#4f46e5', violet: '#7c3aed', fuchsia: '#a21caf' };
export const appearancePath = '/internal/appearance';
const validSite = site => [workerSite, containerSite].includes(site);
export function validAccent(value) { return accents.includes(value); }
export function validateAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['site', 'accent'].includes(key)) || !validSite(value.site) || !validAccent(value.accent)) throw new Error('Invalid appearance');
  return value;
}
// Template fields for a page in the given accent; anything unexpected falls back to the default.
export function appearanceFields(accent) {
  const value = validAccent(accent) ? accent : defaultAccent;
  return { Accent: value, ThemeColor: themeColors[value] };
}

// Rendered pages read the accent through a short per-isolate cache, so a page view rarely touches D1.
const sharedCache = new Map();
export class WorkerAppearance {
  constructor(database, { cache = sharedCache, ttlMs = 30000, now = () => Date.now() } = {}) {
    this.database = database; this.cache = cache; this.ttlMs = ttlMs; this.now = now;
  }
  async settings(site) {
    if (!validSite(site)) throw new Error('Invalid site');
    const db = this.database.withSession?.('first-primary') || this.database;
    const { results } = await db.prepare('SELECT site, accent FROM appearance_settings WHERE site = ?').bind(site).all();
    const value = results[0] || { site, accent: defaultAccent };
    this.cache.set(site, { accent: value.accent, expires: this.now() + this.ttlMs });
    return value;
  }
  async save(value) {
    const { site, accent } = validateAppearance(value);
    await this.database.prepare(`INSERT INTO appearance_settings (site, accent) VALUES (?, ?)
      ON CONFLICT (site) DO UPDATE SET accent = excluded.accent`).bind(site, accent).run();
    this.cache.set(site, { accent, expires: this.now() + this.ttlMs });
    return { site, accent };
  }
  async accent(site) {
    const cached = this.cache.get(site);
    if (cached && cached.expires > this.now()) return cached.accent;
    // A storage failure never blocks a page: keep the last known accent, else the default.
    try { return (await this.settings(site)).accent; }
    catch { return cached?.accent || defaultAccent; }
  }
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value) + '\n', { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
// The container reads its own accent with the statistics reporting token; it cannot change settings.
export async function appearanceCollectionResponse(request, env, appearance) {
  if (new URL(request.url).pathname !== appearancePath) return null;
  if (!await authorized(request, env.IPINFO_STATS_REPORT_TOKEN)) return json({ error: 'Unauthorized' }, 401);
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!appearance) return json({ error: 'Appearance settings are unavailable.' }, 503);
  try { return json({ site: containerSite, accent: await appearance.accent(containerSite) }); }
  catch { return json({ error: 'Appearance settings are temporarily unavailable.' }, 503); }
}
