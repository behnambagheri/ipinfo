import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Reader } from 'mmdb-lib';
import { geoIPRecord } from '../worker/geoip.mjs';
import { decimalIP, privateIP } from '../worker/ip.mjs';

export const names = ['ASN', 'City', 'Country'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const generationID = checksums => sha256(names.map(name => checksums[name] || '').join(''));

export async function openDatabases(paths, { checksums, strict = false, previous, now = Date.now() } = {}) {
  const readers = {};
  const dates = {};
  const digests = {};
  let total = 0;
  for (const name of names) {
    if (!paths[name]) continue;
    const size = (await stat(paths[name])).size;
    total += size;
    if (size < 32 || total > 192 * 1024 * 1024) throw new Error('Database size exceeds limits');
    const bytes = await readFile(paths[name]);
    digests[name] = sha256(bytes);
    if (checksums && digests[name] !== checksums[name]) throw new Error('Database checksum mismatch');
    const reader = new Reader(bytes);
    const m = reader.metadata;
    if (m.binaryFormatMajorVersion !== 2 || ![4, 6].includes(m.ipVersion) || !Number.isFinite(m.buildEpoch.getTime()) ||
        (strict ? m.databaseType !== `GeoLite2-${name}` : !m.databaseType.includes(name))) throw new Error('Invalid database type');
    if (strict && (m.buildEpoch.getTime() > now + 86400000 || m.buildEpoch.getTime() < Date.parse(previous?.dates[name] || '1970-01-01'))) throw new Error('Database build date is older or in the future');
    // Exercise both address families before activating this generation.
    reader.get('8.8.8.8');
    if (m.ipVersion === 6) reader.get('2606:4700:4700::1111');
    readers[name] = reader;
    dates[name] = m.buildEpoch.toISOString();
  }
  return { readers, dates, checksums: digests, generation: generationID(digests),
    updatable: names.every(name => readers[name]?.metadata.databaseType === `GeoLite2-${name}`) };
}

export class LocalDatabases {
  constructor(state, cacheSize = 0) { this.state = state; this.cacheSize = cacheSize; this.cache = new Map(); }
  activate(state) { this.state = state; this.cache.clear(); }
  lookup(ip) {
    if (privateIP(ip)) return { ip, ip_decimal: decimalIP(ip), source: 'Reserved address', country_ir: false };
    const state = this.state;
    if (this.cache.has(ip)) {
      const value = this.cache.get(ip); this.cache.delete(ip); this.cache.set(ip, value);
      return { ...value };
    }
    const city = state.readers.City?.get(ip);
    const asn = state.readers.ASN?.get(ip);
    const country = city?.country ? city : state.readers.Country?.get(ip);
    const value = geoIPRecord(ip, city, asn, country, this.release);
    if (this.cacheSize) {
      this.cache.set(ip, value);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    }
    return { ...value };
  }
  get release() { return `geolite2/${this.state.generation}`; }
  info(updates = {}) { return { source: 'GeoLite2', release: this.release, databases: { ...this.state.dates }, updates: { ...updates } }; }
}
