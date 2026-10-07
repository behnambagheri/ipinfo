import { readFile } from 'node:fs/promises';

// Old environment names remain aliases during migration; this service has no echoip dependency.
export function setting(env, name, fallback) {
  return env[`IPINFO_${name}`] ?? env[`ECHOIP_${name}`] ?? fallback;
}
export function boolean(value) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new Error('Boolean settings require true, false, 1, or 0');
}
export function duration(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) throw new Error('Invalid update interval');
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const ms = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)].reduce((sum, [, n, unit]) => sum + Number(n) * units[unit], 0);
  if (!Number.isSafeInteger(ms) || ms < 1000) throw new Error('Update interval must be at least one second');
  return ms;
}
export async function updateConfig(env) {
  let config = {};
  const file = setting(env, 'DATABASE_UPDATE_CONFIG', '');
  if (file) {
    const content = await readFile(file, 'utf8');
    if (content.length > 65536) throw new Error('Update configuration is too large');
    config = JSON.parse(content);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid update configuration');
  }
  const enabled = boolean(setting(env, 'DATABASE_UPDATE_ENABLED', config.enabled ?? true));
  const interval = setting(env, 'DATABASE_UPDATE_INTERVAL', config.interval ?? '168h');
  const intervalMs = duration(interval);
  const proxy = setting(env, 'DATABASE_UPDATE_PROXY', config.proxy ?? '');
  if (typeof proxy !== 'string' || /[\r\n\0]/.test(proxy)) throw new Error('Invalid update proxy');
  if (proxy) {
    const url = new URL(proxy);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname || url.hash || url.search || (url.pathname && url.pathname !== '/')) throw new Error('Invalid update proxy');
  }
  return { enabled, interval, intervalMs, proxy };
}
export function serverConfig(env = process.env) {
  const listen = setting(env, 'LISTEN', ':8080');
  const match = /^(?:(\[[^\]]+\]|[^:]*):)?(\d+)$/.exec(listen);
  if (!match || Number(match[2]) > 65535) throw new Error('Invalid IPINFO_LISTEN');
  const headers = setting(env, 'TRUSTED_HEADERS', '').split(',').filter(Boolean);
  if (headers.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new Error('Invalid trusted header');
  const cacheSize = Number(setting(env, 'CACHE_SIZE', '0'));
  if (!Number.isInteger(cacheSize) || cacheSize < 0 || cacheSize > 100000) throw new Error('Invalid cache size');
  return { host: match[1]?.replace(/^\[|\]$/g, '') || '0.0.0.0', port: Number(match[2]), headers,
    reverseLookup: boolean(setting(env, 'REVERSE_LOOKUP', 'true')),
    portLookup: boolean(setting(env, 'PORT_LOOKUP', 'false')),
    disableCustomIP: boolean(setting(env, 'DISABLE_CUSTOM_IP', 'false')), cacheSize,
    databasePaths: Object.fromEntries(['ASN', 'City', 'Country'].map(name => [name, setting(env, `${name.toUpperCase()}_DATABASE`, `/data/geolite2/GeoLite2-${name}.mmdb`)])),
    updateDirectory: setting(env, 'DATABASE_UPDATE_DIR', '/var/lib/ipinfo/geolite2'),
    revision: env.BUILD_REVISION || 'development' };
}
