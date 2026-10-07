import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Reader } from 'mmdb-lib';
import { MMDBReader, PageCache } from '../worker/mmdb.mjs';
import { handleRequest } from '../worker/index.mjs';
import { localGeoIP } from './local-geoip.mjs';
import { localGeoIPAssets } from './local-geoip-assets.mjs';

const env = await localGeoIP();
const cache = new PageCache();
const addresses = ['8.8.8.8', '1.1.1.1', '6.6.6.6', '77.74.202.63', '81.2.69.160', '127.0.0.1',
  '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:808:808', '::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'];
// Deterministic samples exercise varied tree branches and data pointers.
let seed = 123456789;
for (let i = 0; i < 100; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  addresses.push([seed >>> 24, (seed >>> 16) & 255, (seed >>> 8) & 255, seed & 255].join('.'));
  addresses.push(`2${(seed & 4095).toString(16).padStart(3, '0')}:${(seed >>> 16).toString(16)}::1`);
}
let matches = 0;
for (const name of ['ASN', 'City', 'Country']) {
  const reference = new Reader(await readFile(`dist/geolite2/GeoLite2-${name}.mmdb`));
  const reader = new MMDBReader(env.GEOIP, env.manifest.databases[name], cache);
  for (const ip of addresses) {
    const before = env.GEOIP.reads;
    const actual = await reader.get(ip);
    const expected = reference.get(ip);
    assert.deepEqual(actual === null ? null : JSON.parse(JSON.stringify(actual)), expected, `${name}: ${ip}`);
    assert.ok(env.GEOIP.reads - before < 40, `Too many storage reads for ${name}: ${ip}`);
    matches++;
  }
  console.log(`Verified ${name}: ${reference.metadata.buildEpoch.toISOString()}, tree ${reader.meta.treeSize} bytes.`);
}
for (const ip of addresses.slice(0, 5)) {
  // Fresh readers/page cache exercise each request's cold asset operation budget.
  const fresh = await localGeoIPAssets();
  const response = await handleRequest(new Request(`https://ip.bea.sh/json?ip=${ip}`), fresh);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.source, 'GeoLite2');
  assert.equal(data.database_release, env.GEOIP_RELEASE);
  assert.ok(data.country_iso || data.asn, `No location or ASN for ${ip}`);
  assert.ok(fresh.GEOIP_ASSETS.reads < 50, `Cold lookup needs ${fresh.GEOIP_ASSETS.reads} asset reads`);
  console.log(`Verified cold lookup ${ip}: ${fresh.GEOIP_ASSETS.reads} asset reads.`);
}
console.log(`Passed ${matches} raw MMDB comparisons and five cold Worker lookups.`);
