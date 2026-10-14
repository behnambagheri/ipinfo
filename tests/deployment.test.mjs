import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWorker } from '../scripts/verify-worker.mjs';

const revision = 'a'.repeat(40), databaseRelease = 'geolite2/test';
function fetcher(lookup = ip => Response.json({ ip, source: 'GeoLite2', database_release: databaseRelease, country_iso: 'US' })) {
  return async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/healthz') return Response.json({ status: 'ok', revision, database_release: databaseRelease });
    if (parsed.pathname === '/database-info') return Response.json({ release: databaseRelease, databases: { ASN: '2026-10-14', City: '2026-10-14', Country: '2026-10-14' } });
    if (parsed.pathname === '/stats.json') return Response.json({ site: 'ip.bea.sh', timezone: 'UTC', metric: 'diagnostic_get_requests', daily: Array(30).fill({}), all_time: { total: 1 } }, { headers: { 'Cache-Control': 'no-store' } });
    if (parsed.pathname === '/json') return lookup(parsed.searchParams.get('ip'));
    assert.fail('Unexpected verification URL');
  };
}
const limited = () => Response.json({ error: 'Rate limit exceeded. Please try again later.', retry_after: 60 }, { status: 429, headers: { 'Retry-After': '60' } });
const options = { revision, databaseRelease, log() {}, attempts: 1 };

test('deployment verifier validates live lookups when the rate limit is unlimited', async () => {
  const result = await verifyWorker({ ...options, fetcher: fetcher() });
  assert.deepEqual(result, { verified: ['8.8.8.8', '2606:4700:4700::1111', '6.6.6.6'], limited: [] });
});
test('valid rate limits do not fail deployment or claim blocked lookups were verified', async () => {
  const messages = [];
  const result = await verifyWorker({ ...options, log: value => messages.push(value), fetcher: fetcher(ip => ip === '8.8.8.8' ? Response.json({ ip, source: 'GeoLite2', database_release: databaseRelease, asn: 'AS15169' }) : limited()) });
  assert.deepEqual(result.verified, ['8.8.8.8']); assert.equal(result.limited.length, 2);
  assert.ok(messages.some(message => message.includes('prevented geolocation verification')));
  assert.equal((await verifyWorker({ ...options, fetcher: fetcher(limited) })).verified.length, 0);
});
test('deployment verifier still rejects lookup failures and malformed or inconsistent rate limits', async () => {
  for (const response of [() => Response.json({ error: 'Offline' }, { status: 502 }),
    () => Response.json({ retry_after: 60 }, { status: 429, headers: { 'Retry-After': '60' } }),
    () => Response.json({ error: 'Rate limit exceeded. Please try again later.', retry_after: 60 }, { status: 429, headers: { 'Retry-After': '1' } }),
    () => Response.json({ ip: 'wrong', source: 'GeoLite2', database_release: databaseRelease, asn: 'AS15169' })]) {
    await assert.rejects(verifyWorker({ ...options, fetcher: fetcher(response) }), /verification failed/);
  }
});
