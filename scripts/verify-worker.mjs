import { setTimeout } from 'node:timers/promises';

const revision = process.env.EXPECTED_REVISION;
if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('EXPECTED_REVISION must be a full Git commit SHA.');
const url = 'https://ip.bea.sh/healthz';
let observed = 'No response';
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
    const health = await response.json();
    if (response.ok && health.status === 'ok' && health.revision === revision) {
      console.log(`Verified ${url} is running ${revision}.`);
      process.exit(0);
    }
    observed = `HTTP ${response.status}, revision ${health.revision || 'unavailable'}`;
  } catch (error) {
    observed = error.message;
  }
  console.log(`Waiting for deployment (${attempt}/12): ${observed}`);
  if (attempt < 12) await setTimeout(5000);
}
throw new Error(`Worker did not serve revision ${revision}: ${observed}`);
