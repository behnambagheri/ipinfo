import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const helper = (await readFile(new URL('../html/local-time.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
const page = await readFile(new URL('../html/statistics.html', import.meta.url), 'utf8');
const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
function browserIntl(zone) {
  return { NumberFormat: Intl.NumberFormat, DateTimeFormat: function(locale, options) { return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); } };
}
function element() {
  return { textContent: '', dataset: {}, children: [], attributes: {}, append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {} };
}
test('statistics renders timestamps and complete reporting intervals in the browser time zone without changing counters', async () => {
  for (const [zone, offset] of [['Asia/Tehran', 'GMT+3:30'], ['Asia/Kathmandu', 'GMT+5:45'], ['America/New_York', 'EDT'], ['UTC', 'UTC']]) {
    const nodes = new Map();
    const counts = ['all_time.total', 'today.total', 'last_30_days.total', 'all_time.web', 'all_time.api', 'all_time.errors'].map(key => ({ ...element(), dataset: { stat: key } }));
    const data = { site: 'ip.bea.sh', timezone: 'UTC', updated_at: '2026-10-07T11:30:00Z', started_at: '2026-10-07T00:00:00Z',
      all_time: { total: 12, web: 5, api: 7, errors: 1 }, today: { total: 12 }, last_30_days: { total: 12 },
      daily: Array.from({ length: 30 }, (_, index) => ({ day: new Date(Date.UTC(2026, 8, 8 + index)).toISOString().slice(0, 10), total: index === 29 ? 12 : 0, web: index === 29 ? 5 : 0, api: index === 29 ? 7 : 0, errors: index === 29 ? 1 : 0 })) };
    // The final reporting day is October 7 in the API; older rows remain unchanged.
    data.daily.at(-1).day = '2026-10-07';
    const original = JSON.stringify(data);
    const context = { window: {}, Intl: browserIntl(zone), AbortSignal,
      document: { body: { dataset: { statisticsSite: 'ip.bea.sh' } }, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
        querySelectorAll: () => counts, createElement: element, createElementNS: element },
      fetch: async (path, options) => { assert.equal(path, '/stats.json'); assert.equal(options.cache, 'no-store'); return Response.json(data); } };
    runInNewContext(helper + script, context);
    await new Promise(setImmediate);
    assert.equal(nodes.get('refresh-statistics').disabled, false);
    assert.match(nodes.get('statistics-status').textContent, new RegExp(offset.replace('+', '\\+')));
    assert.equal(nodes.get('statistics-timezone').textContent, 'Times shown in your time zone: ' + new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone);
    assert.equal(nodes.get('statistics-started').textContent, 'First recorded request: ' + context.window.IPinfoTime.timestamp(data.started_at));
    assert.equal(nodes.get('statistics-day-window').textContent, context.window.IPinfoTime.reportingWindow('2026-10-07'));
    assert.equal(nodes.get('statistics-days').children[0].children[0].textContent, context.window.IPinfoTime.reportingWindow('2026-10-07'));
    assert.equal(nodes.get('statistics-chart').children.at(-1).children[0].textContent, context.window.IPinfoTime.reportingWindow('2026-10-07') + ': 12 requests');
    assert.deepEqual(counts.map(node => node.textContent), ['12', '12', '12', '5', '7', '1']);
    assert.equal(JSON.stringify(data), original);
    if (zone === 'Asia/Tehran') assert.match(nodes.get('statistics-day-window').textContent, /Oct 7, 2026, 3:30 AM GMT\+3:30 – Oct 8, 2026, 3:30 AM GMT\+3:30/);
    if (zone === 'America/New_York') assert.match(nodes.get('statistics-day-window').textContent, /Oct 6, 2026, 8:00 PM EDT – Oct 7, 2026, 8:00 PM EDT/);
  }
});
test('reporting windows preserve their true boundaries through a daylight saving transition', () => {
  const context = { window: {}, Intl: browserIntl('America/New_York') };
  runInNewContext(helper, context);
  assert.match(context.window.IPinfoTime.reportingWindow('2026-03-08'), /Mar 7, 2026, 7:00 PM EST – Mar 8, 2026, 8:00 PM EDT/);
});
test('footer statistics tooltip uses the local timestamp while retaining the site-scoped total', async () => {
  const footer = (await readFile(new URL('../html/statistics-footer.html', import.meta.url), 'utf8')).match(/<script>([\s\S]*?)<\/script>/)[1];
  const node = { dataset: { site: 'ip.bea.sh' } };
  const context = { window: {}, Intl: browserIntl('Asia/Tehran'), AbortSignal,
    document: { getElementById: () => node }, fetch: async () => Response.json({ site: 'ip.bea.sh', all_time: { total: 12 }, updated_at: '2026-10-07T11:30:00Z' }) };
  runInNewContext(helper + footer, context); await new Promise(setImmediate);
  assert.equal(node.textContent, '12 recorded requests');
  assert.equal(node.title, 'Statistics updated: Oct 7, 2026, 3:00 PM GMT+3:30');
});
