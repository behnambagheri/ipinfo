import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { containerSite, reportPath, validateReport } from '../worker/statistics.mjs';
import { statisticsFetch } from './statistics-transport.mjs';
import { visitorsEnabled } from '../worker/visitors.mjs';
import { ContainerVisitors } from './visitors.mjs';

// Each process owns one file. Atomic rename works on the cluster's shared NFS volume;
// replicas never edit each other's files and can safely resend the same cumulative counts.
export async function atomicJSON(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  }
  finally { await unlink(temporary).catch(() => {}); }
}
export function statisticsConfig(env = process.env) {
  const endpoint = env.IPINFO_STATS_ENDPOINT || '';
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== 'ip.bea.sh' || url.pathname !== reportPath || url.port || url.username || url.password || url.search || url.hash) throw new Error('Invalid statistics endpoint');
  const token = env.IPINFO_STATS_REPORT_TOKEN || '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Invalid statistics reporting token');
  const proxy = env.IPINFO_STATS_PROXY || '';
  if (typeof proxy !== 'string' || /[\r\n\0]/.test(proxy)) throw new Error('Invalid statistics proxy');
  if (proxy) {
    const proxyURL = new URL(proxy);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxyURL.protocol) || !proxyURL.hostname || proxyURL.hash || proxyURL.search || (proxyURL.pathname && proxyURL.pathname !== '/')) throw new Error('Invalid statistics proxy');
  }
  return { endpoint: url.href, token, proxy, visitorIPs: visitorsEnabled(env), directory: env.IPINFO_STATS_DIR || '/var/lib/ipinfo/statistics' };
}
export class ContainerStatistics {
  site = containerSite;
  constructor(config, { fetcher = config.proxy ? (url, options) => statisticsFetch(url, options, config.proxy) : fetch, intervalMs = 60000, now = () => new Date() } = {}) {
    this.config = config; this.fetcher = fetcher; this.intervalMs = intervalMs; this.now = now;
    this.source = randomUUID(); this.rows = new Map(); this.sent = new Map(); this.persisting = Promise.resolve();
    this.cached = null; this.syncing = null; this.lastError = null;
    if (config.visitorIPs) this.visitors = new ContainerVisitors(config, this.source, fetcher, now);
  }
  async initialize() {
    await mkdir(this.config.directory, { recursive: true });
    await this.visitors?.initialize();
    try {
      const cached = JSON.parse(await readFile(join(this.config.directory, 'snapshot.json'), 'utf8'));
      if (validSnapshot(cached)) this.cached = cached;
    } catch { /* A new volume has no saved snapshot yet. */ }
    return this;
  }
  record(event) {
    const previous = this.rows.get(event.day);
    this.rows.set(event.day, previous ? { ...previous, web: previous.web + event.web, api: previous.api + event.api,
      errors: previous.errors + event.errors, first_seen: previous.first_seen < event.first_seen ? previous.first_seen : event.first_seen,
      last_seen: previous.last_seen > event.last_seen ? previous.last_seen : event.last_seen } : { ...event });
    const report = { source: this.source, rows: [...this.rows.values()] };
    this.persisting = this.persisting.catch(() => {}).then(() => atomicJSON(join(this.config.directory, `${this.source}.json`), report));
    return this.persisting;
  }
  async request(method, report) {
    const result = await this.fetcher(this.config.endpoint, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${this.config.token}`, ...(report ? { 'Content-Type': 'application/json' } : {}) },
      ...(report ? { body: JSON.stringify(report) } : {}) });
    if (!result.ok) throw new Error('Statistics synchronization failed');
    const value = await result.json();
    if (!validSnapshot(value)) throw new Error('Unexpected statistics response');
    return value;
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = Promise.all([
      this.synchronize().catch(() => { this.lastError = 'Statistics synchronization is temporarily unavailable.'; }),
      this.visitors?.sync().catch(() => { console.warn('Visitor synchronization is temporarily unavailable.'); }),
    ])
      .finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async synchronize() {
    try { await this.persisting; }
    catch {
      // Retry a transient disk failure even if no new diagnostic request arrives.
      if (this.rows.size) await atomicJSON(join(this.config.directory, `${this.source}.json`), { source: this.source, rows: [...this.rows.values()] });
    }
    const files = (await readdir(this.config.directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    for (const name of files) {
      const content = await readFile(join(this.config.directory, name), 'utf8');
      const digest = createHash('sha256').update(content).digest('hex');
      if (this.sent.get(name) === digest) continue;
      const value = JSON.parse(content);
      if (value.source + '.json' !== name || !Array.isArray(value.rows)) throw new Error('Invalid stored report');
      for (let offset = 0; offset < value.rows.length; offset += 30) {
        const report = validateReport({ source: value.source, rows: value.rows.slice(offset, offset + 30) }, this.now());
        this.cached = await this.request('POST', report);
      }
      this.sent.set(name, digest);
    }
    // Refresh even with no local traffic, so each replica sees the other replica's usage.
    this.cached = await this.request('GET');
    await atomicJSON(join(this.config.directory, 'snapshot.json'), this.cached);
    this.lastError = null;
  }
  snapshot() {
    if (!this.cached) throw new Error('Statistics are not synchronized yet');
    const age = this.now().getTime() - Date.parse(this.cached.updated_at);
    return { ...this.cached, stale: Boolean(this.lastError || age > this.intervalMs * 2) };
  }
  start() {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.intervalMs);
    this.timer.unref();
  }
  async stop() { clearInterval(this.timer); await this.persisting.catch(() => {}); await this.syncing; await this.sync(); }
}
function validSnapshot(value) {
  return value?.site === containerSite && value.metric === 'diagnostic_get_requests' && value.timezone === 'UTC' &&
    typeof value.updated_at === 'string' && Number.isFinite(Date.parse(value.updated_at)) && Array.isArray(value.daily) && value.daily.length === 30 &&
    [value.all_time, value.today, value.last_30_days, ...value.daily].every(row => row && ['total', 'web', 'api', 'errors'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0) && row.total === row.web + row.api && row.errors <= row.total);
}
