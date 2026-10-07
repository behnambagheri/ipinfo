const caches = new WeakMap();

export class LookupCache {
  constructor(capacity, ttl = 86400000) {
    this.capacity = capacity;
    this.ttl = ttl;
    this.entries = new Map();
  }
  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= now) return undefined;
    this.entries.set(key, entry);
    return { ...entry.value };
  }
  set(key, value, now = Date.now()) {
    if (!this.capacity) return;
    this.entries.delete(key);
    this.entries.set(key, { value: { ...value }, expires: now + this.ttl });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value);
  }
}

export function lookupCache(env) {
  const configured = env.IPINFO_CACHE_SIZE ?? env.ECHOIP_CACHE_SIZE;
  if (configured === undefined) return undefined;
  const capacity = Number(configured);
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 100000) throw new Error('Invalid lookup cache size');
  const storage = env.GEOIP || env.GEOIP_ASSETS;
  if (!storage) return new LookupCache(0);
  let state = caches.get(storage);
  if (!state || state.release !== env.GEOIP_RELEASE || state.cache.capacity !== capacity) {
    state = { release: env.GEOIP_RELEASE, cache: new LookupCache(capacity) };
    caches.set(storage, state);
  }
  return state.cache;
}
