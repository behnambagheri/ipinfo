import { MMDBReader, PageCache } from './mmdb.mjs';
import { decimalIP, privateIP } from './ip.mjs';
import { geoIPAssets } from './geoip-assets.mjs';

const readers = new WeakMap();
const MAX_TREE_BYTES = 64 * 1024 * 1024;
async function databases(env) {
  const bucket = env.GEOIP || geoIPAssets(env);
  const release = env.GEOIP_RELEASE;
  if (!bucket || !/^geolite2\/[A-Za-z0-9._-]+$/.test(release || '')) throw new Error('GeoLite2 storage is not configured');
  let state = readers.get(bucket);
  if (!state || state.release !== release) {
    state = { release, promise: (async () => {
      const object = await bucket.get(`${release}/manifest.json`);
      if (!object) throw new Error('GeoLite2 manifest missing');
      const manifest = await object.json();
      if (manifest.schema !== 1 || manifest.release !== release) throw new Error('Invalid GeoLite2 manifest');
      const cache = new PageCache();
      let totalTreeBytes = 0;
      const result = {};
      for (const name of ['ASN', 'City', 'Country']) {
        const meta = manifest.databases?.[name];
        if (meta?.key !== `${release}/GeoLite2-${name}.mmdb`) throw new Error('Invalid GeoLite2 object key');
        if (meta.indexKey && meta.indexKey !== `${meta.key}.index`) throw new Error('Invalid GeoLite2 index key');
        result[name] = new MMDBReader(bucket, meta, cache);
        totalTreeBytes += meta.treeSize;
      }
      if (totalTreeBytes > MAX_TREE_BYTES) throw new Error('GeoLite2 search trees exceed Worker memory budget');
      result.manifest = manifest;
      return result;
    })() };
    readers.set(bucket, state);
    state.promise.catch(() => { if (readers.get(bucket) === state) readers.delete(bucket); });
  }
  return state.promise;
}

export async function databaseInfo(env) {
  const db = await databases(env);
  const downloaded = db.manifest.downloadedAt;
  return { source: 'GeoLite2', release: env.GEOIP_RELEASE,
    updates: { enabled: false, last_successful_update: typeof downloaded === 'string' && Number.isFinite(Date.parse(downloaded)) ? new Date(downloaded).toISOString() : undefined },
    databases: Object.fromEntries(
    ['ASN', 'City', 'Country'].flatMap(name => {
      const value = db[name].meta.buildEpoch;
      return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? [[name, new Date(value).toISOString()]] : [];
    }),
  ) };
}

export async function lookupGeoIP(ip, env, context = {}) {
  if (privateIP(ip)) return { ip, ip_decimal: decimalIP(ip), source: 'Reserved address' };
  // Versioning prevents a new database release from reusing old geolocation results.
  const key = new Request(`https://ipinfo-cache.invalid/${env.GEOIP_RELEASE}/lookup/${encodeURIComponent(ip)}`);
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(key);
  if (cached) return cached.json();
  const db = await databases(env);
  const city = await db.City.get(ip);
  const asn = await db.ASN.get(ip);
  const countryRecord = city?.country ? city : await db.Country.get(ip);
  const country = countryRecord?.country;
  const region = city?.subdivisions?.at(-1);
  const data = {
    ip, ip_decimal: decimalIP(ip), source: 'GeoLite2', database_release: env.GEOIP_RELEASE,
    country: country?.names?.en, country_iso: country?.iso_code, country_eu: country?.is_in_european_union ?? false,
    city: city?.city?.names?.en, region_name: region?.names?.en, region_code: region?.iso_code,
    postal_code: city?.postal?.code, timezone: city?.location?.time_zone,
    latitude: city?.location?.latitude, longitude: city?.location?.longitude,
    asn: asn?.autonomous_system_number ? `AS${asn.autonomous_system_number}` : undefined,
    asn_org: asn?.autonomous_system_organization,
  };
  if (cache && context.waitUntil) context.waitUntil(cache.put(key, new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
  })));
  return data;
}
