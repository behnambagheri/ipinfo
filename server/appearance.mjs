import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appearancePath, defaultAccent, validAccent } from '../worker/appearance.mjs';
import { containerSite } from '../worker/statistics.mjs';
import { statisticsFetch } from './statistics-transport.mjs';
import { atomicJSON } from './statistics.mjs';

// The container follows the accent chosen in the Worker admin panel. Pages never wait for the
// Worker: they use the last accent fetched (saved on the statistics volume), else the default.
export class ContainerAppearance {
  constructor(config, { fetcher = config.proxy ? (url, options) => statisticsFetch(url, options, config.proxy) : fetch, intervalMs = 60000 } = {}) {
    this.config = config; this.fetcher = fetcher; this.intervalMs = intervalMs;
    this.endpoint = new URL(appearancePath, config.endpoint).href;
    this.file = join(config.directory, 'appearance.json');
    this.current = defaultAccent;
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (validAccent(saved?.accent)) this.current = saved.accent;
    } catch { /* A new volume has no saved accent yet. */ }
    return this;
  }
  accent() { return this.current; }
  async refresh() {
    try {
      const response = await this.fetcher(this.endpoint, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${this.config.token}`, Accept: 'application/json' } });
      if (!response.ok) return;
      const value = await response.json();
      if (value?.site !== containerSite || !validAccent(value.accent) || value.accent === this.current) return;
      this.current = value.accent;
      await atomicJSON(this.file, { accent: value.accent });
    } catch { /* Keep the current accent while the Worker is unreachable. */ }
  }
  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }
}
