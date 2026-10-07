import { open, readFile } from 'node:fs/promises';

// Storage interface for reference verification; read only requested bytes.
export async function localGeoIP(directory = 'dist/geolite2') {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  let reads = 0;
  const files = new Map(Object.values(manifest.databases).map(meta => [meta.key, `${directory}/${meta.key.split('/').at(-1)}`]));
  for (const meta of Object.values(manifest.databases)) if (meta.indexKey) files.set(meta.indexKey, `dist/geolite2-assets/__geoip/${meta.indexKey}`);
  const bucket = {
    get reads() { return reads; },
    async get(key, options = {}) {
      reads++;
      if (key === `${manifest.release}/manifest.json`) return { json: async () => structuredClone(manifest) };
      const path = files.get(key);
      if (!path) return null;
      const file = await open(path);
      try {
        const { size } = await file.stat();
        const offset = options.range?.offset ?? 0;
        const length = Math.min(options.range?.length ?? size, size - offset);
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await file.read(bytes, 0, length, offset);
        return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytesRead) };
      } finally { await file.close(); }
    },
  };
  return { GEOIP: bucket, GEOIP_RELEASE: manifest.release, manifest };
}
