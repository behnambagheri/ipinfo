import test from 'node:test';
import assert from 'node:assert/strict';
import { geoIPAssets } from '../worker/geoip-assets.mjs';
import { handleRequest } from '../worker/index.mjs';
import { fixtureEnvironment } from './helpers/geoip.mjs';

function assetsEnvironment(partial = true) {
  const fixture = fixtureEnvironment();
  const manifest = { ...fixture.manifest, chunkSize: 4 * 1024 * 1024 };
  const calls = [];
  const binding = { async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (path === `/__geoip/${manifest.release}/manifest.json`) return Response.json(manifest);
    const key = path.slice('/__geoip/'.length).replace(/\.parts\/0\.bin$/, '');
    const bytes = fixture.files.get(key);
    if (!bytes) return new Response(null, { status: 404 });
    const range = request.headers.get('Range')?.match(/^bytes=(\d+)-(\d+)$/);
    return partial && range ? new Response(bytes.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(bytes);
  } };
  return { GEOIP_ASSETS: binding, GEOIP_RELEASE: manifest.release, manifest, calls };
}

test('static-asset-backed lookups work with partial and whole-chunk responses', async () => {
  for (const partial of [true, false]) {
    const env = assetsEnvironment(partial);
    const response = await handleRequest(new Request('https://ip.bea.sh/json?ip=81.2.69.160'), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).city, 'London');
    assert.ok(env.calls.every(path => path.startsWith(`/__geoip/${env.GEOIP_RELEASE}/`)));
    const leaked = await handleRequest(new Request(`https://ip.bea.sh/__geoip/${env.GEOIP_RELEASE}/manifest.json`), env);
    assert.equal(leaked.status, 404);
  }
});

test('asset storage rejects wrong manifests and missing/truncated chunks', async () => {
  const env = assetsEnvironment();
  env.manifest.chunkSize = 1;
  await assert.rejects(geoIPAssets(env).get(`${env.GEOIP_RELEASE}/manifest.json`), /Invalid GeoLite2 asset manifest/);
  env.manifest.chunkSize = 4 * 1024 * 1024;
  const store = geoIPAssets(env);
  assert.equal(await store.get('other-release/data.mmdb', { range: { offset: 0, length: 1 } }), null);
  const meta = env.manifest.databases.City;
  await assert.rejects(store.get(meta.key, { range: { offset: meta.size, length: 1 } }), /Invalid GeoLite2 asset range/);
  const missing = { GEOIP_RELEASE: 'geolite2/test', GEOIP_ASSETS: { fetch: async () => new Response(null, { status: 404 }) } };
  await assert.rejects(geoIPAssets(missing).get('geolite2/test/manifest.json'), /unavailable/);
});
