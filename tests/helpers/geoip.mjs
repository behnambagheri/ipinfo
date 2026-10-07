import { readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';

export function fixtureMetadata(bytes, key) {
  const m = new Reader(bytes).metadata;
  return { key, size: bytes.length, nodeCount: m.nodeCount, recordSize: m.recordSize, ipVersion: m.ipVersion, treeSize: m.searchTreeSize };
}

export function fixtureEnvironment(release = 'geolite2/test') {
  const files = new Map();
  const databases = {};
  for (const [name, file] of [['City', 'GeoIP2-City-Test'], ['Country', 'GeoIP2-Country-Test'], ['ASN', 'GeoLite2-ASN-Test']]) {
    const bytes = readFileSync(new URL(`../fixtures/${file}.mmdb`, import.meta.url));
    const key = `${release}/GeoLite2-${name}.mmdb`;
    files.set(key, bytes);
    databases[name] = fixtureMetadata(bytes, key);
  }
  const manifest = { schema: 1, release, databases };
  const calls = [];
  return { GEOIP_RELEASE: release, calls, files, manifest, GEOIP: {
    async get(key, options = {}) {
      calls.push({ key, options });
      if (key === `${release}/manifest.json`) return { json: async () => structuredClone(manifest) };
      const bytes = files.get(key);
      if (!bytes) return null;
      const offset = options.range?.offset ?? 0;
      const length = options.range?.length ?? bytes.length;
      const range = bytes.subarray(offset, offset + length);
      return { arrayBuffer: async () => range.buffer.slice(range.byteOffset, range.byteOffset + range.byteLength) };
    },
  } };
}

export function plain(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}
