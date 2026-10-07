import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export async function localGeoIPAssets(directory = 'dist/geolite2-assets', release) {
  const root = resolve(directory);
  if (!release) release = JSON.parse(await readFile('dist/geolite2/manifest.json', 'utf8')).release;
  let reads = 0;
  return { GEOIP_RELEASE: release, GEOIP_ASSETS: {
    get reads() { return reads; },
    async fetch(request) {
      reads++;
      const path = resolve(root, '.' + new URL(request.url).pathname);
      if (!path.startsWith(root + sep)) return new Response(null, { status: 404 });
      let bytes;
      try { bytes = await readFile(path); }
      catch (error) { if (error.code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
      const range = request.headers.get('Range')?.match(/^bytes=(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (start > end || start >= bytes.length) return new Response(null, { status: 416 });
        const last = Math.min(end, bytes.length - 1);
        return new Response(bytes.subarray(start, last + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${last}/${bytes.length}` } });
      }
      return new Response(bytes);
    },
  } };
}
