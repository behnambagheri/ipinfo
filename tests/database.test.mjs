import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = (await readFile(new URL('../html/metadata.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
async function datesPage(fetcher) {
  const times = ['ASN', 'City', 'Country'].map(database => ({ dataset: { database }, textContent: 'Unavailable' }));
  let hidden = true;
  const common = { hidden: true, classList: { remove: () => { common.hidden = false; } } };
  const details = { hidden: false, classList: { add: () => { details.hidden = true; } } };
  const shared = {};
  const section = { querySelectorAll: () => times,
    querySelector: selector => ({ 'time[data-database-shared]': shared, '[data-database-common]': common, '[data-database-details]': details })[selector],
    classList: { remove: () => { hidden = false; } } };
  runInNewContext(script, { document: { getElementById: () => section }, window: { location: { origin: 'https://ip.behnam.pro' } },
    URL, AbortSignal, fetch: fetcher });
  await new Promise(setImmediate);
  return { times, common, details, shared, get hidden() { return hidden; } };
}

test('footer shows each actual database build date in UTC using only the local metadata endpoint', async () => {
  const page = await datesPage(async (url, options) => {
    assert.equal(url.href, 'https://ip.behnam.pro/database-info');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return Response.json({ databases: { ASN: '2026-10-05T23:30:00Z', City: '2026-10-06T21:21:33Z', Country: '2026-10-06T21:21:33Z' } });
  });
  assert.equal(page.hidden, false);
  assert.equal(page.times[0].textContent, 'Oct 5, 2026');
  assert.equal(page.times[1].textContent, 'Oct 6, 2026');
  assert.equal(page.times[0].dateTime, '2026-10-05T23:30:00.000Z');
  assert.match(page.times[0].title, /UTC/);
  assert.equal(page.common.hidden, true);
  assert.equal(page.details.hidden, false);
});

test('matching UTC dates collapse to one date despite different build times', async () => {
  const page = await datesPage(async () => Response.json({ databases: {
    ASN: '2026-10-06T08:15:27Z', City: '2026-10-06T21:21:33Z', Country: '2026-10-06T21:21:33Z',
  } }));
  assert.equal(page.common.hidden, false);
  assert.equal(page.details.hidden, true);
  assert.equal(page.shared.textContent, 'Oct 6, 2026');
  assert.equal(page.shared.dateTime, '2026-10-06');
  assert.match(page.shared.title, /ASN: 2026-10-06T08:15:27/);
});

test('missing or failed metadata does not invent dates or interfere with the page', async () => {
  for (const fetcher of [async () => { throw new Error('Offline'); }, async () => new Response(null, { status: 503 }),
    async () => Response.json({ databases: { ASN: 'invalid', City: null } })]) {
    assert.equal((await datesPage(fetcher)).hidden, true);
  }
  const partial = await datesPage(async () => Response.json({ databases: { ASN: '2026-10-06T08:15:27Z' } }));
  assert.equal(partial.hidden, false);
  assert.equal(partial.times[1].textContent, 'Unavailable');
  assert.equal(partial.common.hidden, true);
  assert.equal(partial.details.hidden, false);
});
