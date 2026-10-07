import { setTimeout } from 'node:timers/promises';

const revision = process.env.EXPECTED_REVISION;
const databaseRelease = process.env.EXPECTED_GEOIP_RELEASE;
if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('EXPECTED_REVISION must be a full Git commit SHA.');
if (!/^geolite2\/[A-Za-z0-9._-]+$/.test(databaseRelease || '')) throw new Error('EXPECTED_GEOIP_RELEASE must identify a GeoLite2 release.');
const url = 'https://ip.bea.sh/healthz';
let observed = 'No response';
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
    const health = await response.json();
    if (response.ok && health.status === 'ok' && health.revision === revision && health.database_release === databaseRelease) {
      const metadata = await fetch('https://ip.bea.sh/database-info', { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
      const info = await metadata.json();
      if (!metadata.ok || info.release !== databaseRelease || ['ASN', 'City', 'Country'].some(name => !Number.isFinite(Date.parse(info.databases?.[name] || '')))) {
        throw new Error('Live database dates are unavailable');
      }
      for (const ip of ['8.8.8.8', '2606:4700:4700::1111', '6.6.6.6']) {
        const lookup = await fetch(`https://ip.bea.sh/json?ip=${ip}`, { signal: AbortSignal.timeout(20000), redirect: 'error', cache: 'no-store' });
        const data = await lookup.json();
        if (!lookup.ok || data.ip !== ip || data.source !== 'GeoLite2' || data.database_release !== databaseRelease ||
            !(data.country_iso || data.asn)) throw new Error(`Live GeoLite2 lookup failed for ${ip}`);
      }
      console.log(`Verified ${url} is running ${revision}.`);
      console.log(`Verified IPv4 and IPv6 GeoLite2 lookups on ${databaseRelease}.`);
      process.exit(0);
    }
    observed = `HTTP ${response.status}, revision ${health.revision || 'unavailable'}, database ${health.database_release || 'unavailable'}`;
  } catch (error) {
    observed = error.message;
  }
  console.log(`Waiting for deployment (${attempt}/12): ${observed}`);
  if (attempt < 12) await setTimeout(5000);
}
throw new Error(`Worker did not serve revision ${revision}: ${observed}`);
