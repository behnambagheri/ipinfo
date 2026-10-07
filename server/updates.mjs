import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { updateConfig } from './config.mjs';
import { download } from './downloads.mjs';
import { names, openDatabases, generationID } from './databases.mjs';

const releaseURL = 'https://api.github.com/repos/P3TERX/GeoLite.mmdb/releases/latest';
const pathsAt = directory => Object.fromEntries(names.map(name => [name, join(directory, `GeoLite2-${name}.mmdb`)]));
const validChecksums = value => names.every(name => /^[a-f0-9]{64}$/.test(value?.[name] || ''));
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export async function atomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class DatabaseUpdater {
  constructor(databases, { env = process.env, directory, downloadFile = download, now = Date.now } = {}) {
    this.databases = databases; this.env = env; this.directory = directory; this.download = downloadFile; this.now = now;
    this.status = { enabled: false, interval: '168h', proxy_in_use: false };
    this.lastAttempt = null; this.failed = false; this.closed = false;
  }
  async initialize(receiptFile) {
    if (receiptFile) {
      try {
        const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
        if (validDate(receipt.last_successful_update) && names.every(name => receipt.checksums?.[name] === this.databases.state.checksums[name])) this.status.last_successful_update = receipt.last_successful_update;
      } catch { /* A missing build receipt does not invalidate the databases. */ }
    }
    await this.reloadConfig();
    if (this.databases.state.updatable) {
      try {
        const state = JSON.parse(await readFile(join(this.directory, 'current.json'), 'utf8'));
        if (!/^[a-f0-9]{64}$/.test(state.generation || '') || !validChecksums(state.checksums) || generationID(state.checksums) !== state.generation || !validDate(state.last_successful_update)) throw new Error('Invalid saved generation');
        const restored = await openDatabases(pathsAt(join(this.directory, 'generations', state.generation)), { strict: true, checksums: state.checksums, previous: this.databases.state, now: this.now() });
        this.databases.activate(restored);
        this.status.last_successful_update = state.last_successful_update;
      } catch (error) {
        if (error.code !== 'ENOENT') this.status.last_error = 'Saved database update could not be restored; bundled databases remain active.';
      }
    }
    return this;
  }
  async reloadConfig() {
    try {
      const config = await updateConfig(this.env);
      this.config = config;
      Object.assign(this.status, { enabled: config.enabled && this.databases.state.updatable, interval: config.interval, proxy_in_use: Boolean(config.proxy) });
      return true;
    } catch {
      this.status.last_error = 'Invalid database update configuration.';
      return false;
    }
  }
  start() {
    const tick = async () => {
      if (this.closed) return;
      await this.tick();
      if (!this.closed) this.timer = setTimeout(tick, Math.min(this.config?.intervalMs || 60000, 60000));
    };
    this.loop = tick();
  }
  async tick() {
    if (!await this.reloadConfig() || this.closed || !this.status.enabled) return;
    const interval = this.failed ? Math.min(this.config.intervalMs, 3600000) : this.config.intervalMs;
    if (this.lastAttempt === null || this.now() - this.lastAttempt >= interval) await this.check();
  }
  async stop() {
    this.closed = true; clearTimeout(this.timer); this.controller?.abort();
    await this.pending?.catch(() => {});
  }
  check() {
    if (this.pending) return this.pending;
    this.pending = this.performCheck().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async performCheck() {
    if (!this.status.enabled || !this.config) return false;
    this.lastAttempt = this.now(); this.status.last_attempt = new Date(this.lastAttempt).toISOString();
    const config = { ...this.config };
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller.abort(), 15 * 60000);
    let stage;
    try {
      const options = { proxy: config.proxy, signal: this.controller.signal };
      const bytes = await this.download(releaseURL, { ...options, maxBytes: 1024 * 1024, timeoutSeconds: 60 });
      const latest = JSON.parse(bytes.toString('utf8'));
      const tag = latest.tag_name;
      if (typeof tag !== 'string' || tag.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag) || !Array.isArray(latest.assets)) throw new Error('Invalid release');
      const assets = {};
      const checksums = {};
      for (const name of names) {
        const filename = `GeoLite2-${name}.mmdb`;
        const asset = latest.assets.find(value => value.name === filename);
        if (asset?.browser_download_url !== `https://github.com/P3TERX/GeoLite.mmdb/releases/download/${tag}/${filename}` || !/^sha256:[a-f0-9]{64}$/.test(asset?.digest || '')) throw new Error('Invalid release asset');
        assets[name] = asset.browser_download_url; checksums[name] = asset.digest.slice(7);
      }
      if (!names.every(name => checksums[name] === this.databases.state.checksums[name])) {
        await mkdir(join(this.directory, 'generations'), { recursive: true, mode: 0o750 });
        // Clean only owned interrupted stages; one process owns each update directory.
        for (const file of await readdir(this.directory)) if (file.startsWith('.download-')) await rm(join(this.directory, file), { recursive: true, force: true });
        stage = await mkdtemp(join(this.directory, '.download-'));
        const paths = pathsAt(stage);
        for (const name of names) {
          await this.download(assets[name], { ...options, path: paths[name] });
          const handle = await open(paths[name], 'r');
          try { await handle.sync(); } finally { await handle.close(); }
        }
        const candidate = await openDatabases(paths, { checksums, strict: true, previous: this.databases.state, now: this.now() });
        const generation = candidate.generation;
        const destination = join(this.directory, 'generations', generation);
        try { await rename(stage, destination); stage = undefined; }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          await openDatabases(pathsAt(destination), { checksums, strict: true, previous: this.databases.state, now: this.now() });
        }
        const updated = new Date(this.now()).toISOString();
        await atomicJSON(join(this.directory, 'current.json'), { generation, release: tag, checksums, last_successful_update: updated });
        const previous = this.databases.state.generation;
        this.databases.activate(candidate);
        this.status.last_successful_update = updated;
        // Cleanup is best-effort after successful activation; keep one previous generation.
        for (const file of await readdir(join(this.directory, 'generations')).catch(() => [])) {
          if (/^[a-f0-9]{64}$/.test(file) && file !== generation && file !== previous) await rm(join(this.directory, 'generations', file), { recursive: true, force: true }).catch(() => {});
        }
      }
      this.status.last_successful_check = new Date(this.now()).toISOString();
      delete this.status.last_error; this.failed = false;
      return true;
    } catch {
      // Do not include upstream, filesystem, or proxy errors that could disclose credentials.
      this.status.last_error = 'Database update failed; current databases remain active.';
      this.failed = true;
      return false;
    } finally {
      clearTimeout(timeout);
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
}
