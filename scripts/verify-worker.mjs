import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function verifyWorker({ revision, databaseRelease, fetcher = fetch, log = console.log, attempts = 12, delay = () => setTimeout(5000) }) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('EXPECTED_REVISION must be a full Git commit SHA.');
  if (!/^geolite2\/[A-Za-z0-9._-]+$/.test(databaseRelease || '')) throw new Error('EXPECTED_GEOIP_RELEASE must identify a GeoLite2 release.');
  const url = 'https://ip.bea.sh/healthz';
  let observed = 'No response';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
      const health = await response.json();
      if (response.ok && health.status === 'ok' && health.revision === revision && health.database_release === databaseRelease) {
        const metadata = await fetcher('https://ip.bea.sh/database-info', { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
        const info = await metadata.json();
        if (!metadata.ok || info.release !== databaseRelease || ['ASN', 'City', 'Country'].some(name => !Number.isFinite(Date.parse(info.databases?.[name] || '')))) {
          throw new Error('Live database dates are unavailable');
        }
        const verified = [], limited = [];
        for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '6.6.6.6']) {
          const lookup = await fetcher(`https://ip.bea.sh/json?ip=${ip}`, { signal: AbortSignal.timeout(20000), redirect: 'error', cache: 'no-store' });
          const data = await lookup.json();
          if (lookup.status === 429) {
            const retry = data.retry_after;
            if (data.error !== 'Rate limit exceeded. Please try again later.' || !Number.isSafeInteger(retry) || retry < 1 || retry > 86400 ||
                lookup.headers.get('Retry-After') !== String(retry)) throw new Error(`Invalid rate-limit response for ${ip}`);
            limited.push(ip);
            continue;
          }
          if (!lookup.ok || data.ip !== ip || data.source !== 'GeoLite2' || data.database_release !== databaseRelease ||
              !(data.country_iso || data.asn)) throw new Error(`Live GeoLite2 lookup failed for ${ip}`);
          verified.push(ip);
        }
        const statistics = await fetcher('https://ip.bea.sh/stats.json?site=ip.behnam.pro', { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
        const usage = await statistics.json();
        if (!statistics.ok || statistics.headers.get('cache-control') !== 'no-store' || usage.site !== 'ip.bea.sh' || usage.timezone !== 'UTC' ||
            usage.metric !== 'diagnostic_get_requests' || usage.daily?.length !== 30 || !Number.isSafeInteger(usage.all_time?.total)) {
          throw new Error('Live site statistics are unavailable or have the wrong site identity');
        }
        log(`Verified ${url} is running ${revision}.`);
        if (verified.length) log(`Verified GeoLite2 lookups on ${databaseRelease}: ${verified.join(', ')}.`);
        if (limited.length) log(`Active rate limit prevented geolocation verification for: ${limited.join(', ')}. Validated HTTP 429 and Retry-After instead.`);
        log('Verified independent ip.bea.sh statistics.');
        return { verified, limited };
      }
      observed = `HTTP ${response.status}, revision ${health.revision || 'unavailable'}, database ${health.database_release || 'unavailable'}`;
    } catch (error) {
      observed = error.message;
    }
    log(`Waiting for deployment (${attempt}/${attempts}): ${observed}`);
    if (attempt < attempts) await delay();
  }
  throw new Error(`Worker verification failed for revision ${revision}: ${observed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyWorker({ revision: process.env.EXPECTED_REVISION, databaseRelease: process.env.EXPECTED_GEOIP_RELEASE });
}
