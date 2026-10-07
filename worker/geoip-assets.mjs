// Static Assets are attached to a Worker version. The binding is internal;
// the public request handler never serves the database paths.
const CHUNK_SIZE = 4 * 1024 * 1024;
const stores = new WeakMap();

export function geoIPAssets(env) {
  const binding = env.GEOIP_ASSETS;
  const release = env.GEOIP_RELEASE;
  if (!binding || !/^geolite2\/[A-Za-z0-9._-]+$/.test(release || '')) throw new Error('GeoLite2 assets are not configured');
  let state = stores.get(binding);
  if (!state || state.release !== release) {
    let manifestPromise;
    const fetchAsset = async (key, range) => {
      const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
      const response = await binding.fetch(new Request(`https://geoip-assets.invalid/__geoip/${key}`, { headers }));
      if (!response.ok) throw new Error(`GeoLite2 asset unavailable: HTTP ${response.status}`);
      return response;
    };
    const manifest = () => {
      if (!manifestPromise) manifestPromise = fetchAsset(`${release}/manifest.json`).then(response => response.json())
        .then(value => {
          if (value.schema !== 1 || value.release !== release || value.chunkSize !== CHUNK_SIZE) throw new Error('Invalid GeoLite2 asset manifest');
          return value;
        }).catch(error => { manifestPromise = undefined; throw error; });
      return manifestPromise;
    };
    const store = {
      async get(key, options = {}) {
        const meta = await manifest();
        if (key === `${release}/manifest.json`) return { json: async () => meta };
        const index = Object.values(meta.databases || {}).find(db => db.indexKey === key);
        if (index) {
          const response = await fetchAsset(key);
          return { arrayBuffer: () => response.arrayBuffer() };
        }
        const db = Object.values(meta.databases || {}).find(db => db.key === key);
        if (!db || !options.range) return null;
        const { offset, length } = options.range;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || offset + length > db.size) {
          throw new Error('Invalid GeoLite2 asset range');
        }
        const bytes = new Uint8Array(length);
        let written = 0;
        while (written < length) {
          const position = offset + written;
          const chunk = Math.floor(position / CHUNK_SIZE);
          const start = position % CHUNK_SIZE;
          const take = Math.min(length - written, CHUNK_SIZE - start);
          const response = await fetchAsset(`${key}.parts/${chunk}.bin`, { offset: start, length: take });
          const part = new Uint8Array(await response.arrayBuffer());
          let selected;
          if (response.status === 206) {
            if (part.length !== take) throw new Error('Truncated GeoLite2 asset range');
            selected = part;
          } else {
            // Some local asset servers return the whole chunk despite Range.
            const expected = Math.min(CHUNK_SIZE, db.size - chunk * CHUNK_SIZE);
            if (part.length !== expected) throw new Error('Truncated GeoLite2 asset chunk');
            selected = part.subarray(start, start + take);
          }
          bytes.set(selected, written);
          written += take;
        }
        return { arrayBuffer: async () => bytes.buffer };
      },
    };
    state = { release, store };
    stores.set(binding, state);
  }
  return state.store;
}
