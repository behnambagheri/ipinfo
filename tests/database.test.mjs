import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = (await readFile(new URL('../html/metadata.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
const localTime = (await readFile(new URL('../html/local-time.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
async function datesPage(fetcher, zone = 'Asia/Tehran') {
  const times = ['ASN', 'City', 'Country'].map(database => ({ dataset: { database }, textContent: 'Unavailable' }));
  let hidden = true;
  const common = { hidden: true, classList: { remove: () => { common.hidden = false; } } };
  const details = { hidden: false, classList: { add: () => { details.hidden = true; } } };
  const shared = {};
  const success = { hidden: true, classList: { remove: () => { success.hidden = false; } } };
  const successTime = {};
  const section = { querySelectorAll: () => times,
    querySelector: selector => ({ 'time[data-database-shared]': shared, '[data-database-common]': common, '[data-database-details]': details,
      '[data-database-success]': success, 'time[data-database-success-time]': successTime })[selector],
    classList: { remove: () => { hidden = false; } } };
  runInNewContext(localTime + script, { document: { getElementById: () => section }, window: { location: { origin: 'https://ip.behnam.pro' } },
    Intl: { DateTimeFormat: function(locale, options) { return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); } },
    URL, AbortSignal, fetch: fetcher });
  await new Promise(setImmediate);
  return { times, common, details, shared, success, successTime, get hidden() { return hidden; } };
}

test('footer shows each database build date in the browser time zone using only the local metadata endpoint', async () => {
  const page = await datesPage(async (url, options) => {
    assert.equal(url.href, 'https://ip.behnam.pro/database-info');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return Response.json({ databases: { ASN: '2026-10-05T23:30:00Z', City: '2026-10-06T21:21:33Z', Country: '2026-10-06T21:21:33Z' } });
  });
  assert.equal(page.hidden, false);
  assert.equal(page.times[0].textContent, 'Oct 6, 2026');
  assert.equal(page.times[1].textContent, 'Oct 7, 2026');
  assert.equal(page.times[0].dateTime, '2026-10-05T23:30:00.000Z');
  assert.match(page.times[0].title, /GMT\+3:30/);
  assert.equal(page.common.hidden, true);
  assert.equal(page.details.hidden, false);
});

test('different UTC dates collapse when they share the same local calendar day', async () => {
  const page = await datesPage(async () => Response.json({ databases: {
    ASN: '2026-10-05T23:30:00Z', City: '2026-10-06T08:15:27Z', Country: '2026-10-06T08:15:27Z',
  } }));
  assert.equal(page.common.hidden, false);
  assert.equal(page.details.hidden, true);
  assert.equal(page.shared.textContent, 'Oct 6, 2026');
  assert.equal(page.shared.dateTime, '2026-10-05T23:30:00.000Z');
  assert.match(page.shared.title, /ASN: Oct 6, 2026, 3:00 AM GMT\+3:30/);
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

test('successful update time is displayed separately from database build dates', async () => {
  const page = await datesPage(async () => Response.json({ databases: { ASN: '2026-10-06T08:15:27Z', City: '2026-10-06T21:21:33Z', Country: '2026-10-06T21:21:33Z' },
    updates: { last_successful_update: '2026-10-07T11:30:00Z', last_successful_check: '2026-10-08T12:00:00Z' } }));
  assert.equal(page.details.hidden, false);
  assert.equal(page.success.hidden, false);
  assert.equal(page.successTime.dateTime, '2026-10-07T11:30:00.000Z');
  assert.match(page.successTime.textContent, /Oct 7, 2026/);
  assert.match(page.successTime.textContent, /3:00 PM GMT\+3:30/);
  assert.equal(page.successTime.title, 'Your time zone: Asia/Tehran');
});
test('footer supports negative offsets, daylight saving transitions, and UTC browser settings', async () => {
  for (const [zone, date, expected] of [
    ['America/New_York', '2026-03-08T06:30:00Z', /1:30 AM EST/],
    ['America/New_York', '2026-03-08T07:30:00Z', /3:30 AM EDT/],
    ['UTC', '2026-03-08T07:30:00Z', /7:30 AM UTC/],
  ]) {
    const page = await datesPage(async () => Response.json({ updates: { last_successful_update: date } }), zone);
    assert.match(page.successTime.textContent, expected);
    assert.equal(page.successTime.dateTime, new Date(date).toISOString());
  }
});
