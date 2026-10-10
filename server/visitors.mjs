import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { retentionStart, validateVisitorReport, visitorReportPath } from '../worker/visitors.mjs';
import { atomicJSON } from './statistics.mjs';

const shardForIP = ip => (createHash('sha256').update(ip).digest()[0] % 64).toString(16).padStart(2, '0');

// A process owns its daily shards; expired files can be removed without rewriting
// a live replica's cumulative counts. The collector acknowledges duplicate batches safely.
// Sharding avoids rewriting every visitor's data on each diagnostic request.
export class ContainerVisitors {
  constructor(config, source, fetcher, now = () => new Date()) {
    this.directory = join(config.directory, 'visitors');
    this.endpoint = new URL(visitorReportPath, config.endpoint).href;
    this.token = config.token; this.source = source; this.fetcher = fetcher; this.now = now;
    this.rows = new Map(); this.sent = new Map(); this.persisting = Promise.resolve();
  }
  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  persistShard(key) {
    // Recheck at write time: a queued write must not recreate an expired file.
    if (key.slice(0, 10) < retentionStart(this.now())) return;
    return atomicJSON(join(this.directory, `${this.source}-${key}.json`), { source: this.source, rows: [...this.rows.get(key).values()] });
  }
  record(row) {
    if (row.day < retentionStart(this.now())) return;
    const key = `${row.day}-${shardForIP(row.ip)}`;
    if (!this.rows.has(key)) this.rows.set(key, new Map());
    const daily = this.rows.get(key), previous = daily.get(row.ip);
    daily.set(row.ip, previous ? { ...(row.last_seen >= previous.last_seen ? row : previous), web: previous.web + row.web, api: previous.api + row.api,
      errors: previous.errors + row.errors, first_seen: previous.first_seen < row.first_seen ? previous.first_seen : row.first_seen,
      last_seen: previous.last_seen > row.last_seen ? previous.last_seen : row.last_seen } : { ...row });
    this.persisting = this.persisting.catch(() => {}).then(() => this.persistShard(key));
    return this.persisting;
  }
  async sync() {
    try { await this.persisting; }
    catch { for (const key of this.rows.keys()) await this.persistShard(key); }
    const earliest = retentionStart(this.now());
    for (const key of this.rows.keys()) if (key.slice(0, 10) < earliest) this.rows.delete(key);
    const files = (await readdir(this.directory)).sort();
    for (const name of files) {
      const match = /^([0-9a-f-]{36})-(\d{4}-\d{2}-\d{2})-([0-3][0-9a-f])\.json$/.exec(name);
      if (!match) continue;
      if (match[2] < earliest) { await unlink(join(this.directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; }); this.sent.delete(name); continue; }
      let content;
      try { content = await readFile(join(this.directory, name), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const digest = createHash('sha256').update(content).digest('hex');
      if (this.sent.get(name) === digest) continue;
      const report = JSON.parse(content);
      if (report.source !== match[1] || !Array.isArray(report.rows) || report.rows.some(row => row.day !== match[2] || typeof row.ip !== 'string' || shardForIP(row.ip) !== match[3])) throw new Error('Invalid saved visitor report');
      for (let offset = 0; offset < report.rows.length; offset += 100) {
        const batch = validateVisitorReport({ source: report.source, rows: report.rows.slice(offset, offset + 100) }, this.now());
        const response = await this.fetcher(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
        if (!response.ok || (await response.json()).accepted !== true) throw new Error('Visitor synchronization failed');
      }
      this.sent.set(name, digest);
    }
  }
}
