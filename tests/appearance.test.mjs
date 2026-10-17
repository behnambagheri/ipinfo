import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageDatabase } from './helpers/usage-db.mjs';
import { WorkerAppearance, appearanceCollectionResponse, accents, themeColors, appearancePath } from '../worker/appearance.mjs';
import { workerSite, containerSite } from '../worker/statistics.mjs';
import { adminResponse } from '../worker/admin.mjs';
import { handleRequest } from '../worker/index.mjs';
import { handleCloudflareRequest } from '../worker/cloudflare.mjs';
import { ContainerAppearance } from '../server/appearance.mjs';

const token = 't'.repeat(64);
const html = (context = {}, path = '/') => handleRequest(new Request(`https://${workerSite}${path}`, { headers: { Accept: 'text/html', 'CF-Connecting-IP': '1.1.1.1' } }), {}, context).then(response => response.text());

test('accents and theme colors match the vendored design system tokens', async () => {
  const tokens = await readFile('public/ds/v1/tokens.css', 'utf8');
  assert.equal(themeColors.blue, /:root \{[\s\S]*?--bb-accent-light: (#[0-9a-f]{6});/.exec(tokens)[1]);
  for (const accent of accents.filter(value => value !== 'blue')) {
    assert.equal(themeColors[accent], new RegExp(`\\[data-product='${accent}'\\] \\{\\s*--bb-accent-light: (#[0-9a-f]{6});`).exec(tokens)?.[1], accent);
  }
});

test('accents are stored per site, validated, cached briefly, and default to blue', async t => {
  const { db, sqlite } = await usageDatabase(t);
  let clock = 0;
  const appearance = new WorkerAppearance(db, { cache: new Map(), ttlMs: 1000, now: () => clock });
  assert.deepEqual(await appearance.settings(workerSite), { site: workerSite, accent: 'blue' });
  assert.deepEqual(await appearance.save({ site: containerSite, accent: 'violet' }), { site: containerSite, accent: 'violet' });
  assert.equal(await appearance.accent(containerSite), 'violet');
  assert.equal(await appearance.accent(workerSite), 'blue');
  for (const value of [{ site: workerSite, accent: 'orange' }, { site: 'example.com', accent: 'teal' }, { site: workerSite, accent: 'teal', extra: 1 }]) {
    await assert.rejects(appearance.save(value));
  }
  // Another isolate's save is picked up after the cache expires.
  sqlite.prepare("INSERT INTO appearance_settings (site, accent) VALUES (?, 'cyan')").run(workerSite);
  assert.equal(await appearance.accent(workerSite), 'blue');
  clock = 1001;
  assert.equal(await appearance.accent(workerSite), 'cyan');
  // Storage failures keep the last known accent rather than failing the page.
  const broken = new WorkerAppearance({ prepare() { throw new Error('D1 down'); } }, { cache: new Map([[workerSite, { accent: 'teal', expires: 0 }]]), now: () => 5 });
  assert.equal(await broken.accent(workerSite), 'teal');
  assert.equal(await new WorkerAppearance({ prepare() { throw new Error('D1 down'); } }, { cache: new Map() }).accent(workerSite), 'blue');
});

test('admin accent settings require authentication, same-origin writes, and valid accents', async t => {
  const { db } = await usageDatabase(t);
  const appearance = new WorkerAppearance(db, { cache: new Map() });
  const options = { appearance, authorize: async () => true };
  const write = (body, headers = { Origin: `https://${workerSite}` }, query = `?site=${containerSite}`) => new Request(`https://${workerSite}/admin/appearance.json${query}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await adminResponse(new Request(`https://${workerSite}/admin/appearance.json`), {}, undefined, { appearance, authorize: async () => false })).status, 403);
  assert.deepEqual(await (await adminResponse(new Request(`https://${workerSite}/admin/appearance.json`), {}, undefined, options)).json(), { site: workerSite, accent: 'blue' });
  const saved = await adminResponse(write({ site: containerSite, accent: 'fuchsia' }), {}, undefined, options);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { site: containerSite, accent: 'fuchsia' });
  assert.equal(await appearance.accent(containerSite), 'fuchsia');
  assert.equal((await adminResponse(write({ site: containerSite, accent: 'teal' }, { Origin: 'https://evil.example' }), {}, undefined, options)).status, 403);
  assert.equal((await adminResponse(write({ site: containerSite, accent: 'teal' }, { Origin: `https://${workerSite}`, 'Sec-Fetch-Site': 'cross-site' }), {}, undefined, options)).status, 403);
  assert.equal((await adminResponse(write({ site: containerSite, accent: 'orange' }), {}, undefined, options)).status, 400);
  assert.equal((await adminResponse(write({ site: workerSite, accent: 'teal' }), {}, undefined, options)).status, 400);
  assert.equal((await adminResponse(new Request(`https://${workerSite}/admin/appearance.json?site=example.com`), {}, undefined, options)).status, 400);
  assert.equal((await adminResponse(new Request(`https://${workerSite}/admin/appearance.json`), {}, undefined, { authorize: async () => true })).status, 503);
});

test('the container reads only its own accent with the reporting token', async t => {
  const { db } = await usageDatabase(t);
  const appearance = new WorkerAppearance(db, { cache: new Map() });
  await appearance.save({ site: containerSite, accent: 'indigo' });
  const env = { IPINFO_STATS_REPORT_TOKEN: token };
  const read = (headers = { Authorization: `Bearer ${token}` }, method = 'GET') => appearanceCollectionResponse(new Request(`https://${workerSite}${appearancePath}`, { method, headers }), env, appearance);
  assert.equal((await read({})).status, 401);
  assert.equal((await read({ Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await read(undefined, 'POST')).status, 405);
  assert.deepEqual(await (await read()).json(), { site: containerSite, accent: 'indigo' });
  assert.equal(await appearanceCollectionResponse(new Request(`https://${workerSite}/ip`), env, appearance), null);
  // Through the Worker entry point, the same D1 binding drives both the page accent and the internal endpoint.
  await appearance.save({ site: workerSite, accent: 'cyan' });
  const page = await handleCloudflareRequest(new Request(`https://${workerSite}/`, { headers: { Accept: 'text/html', 'CF-Connecting-IP': '1.1.1.1' } }), { USAGE_DB: db, ...env });
  assert.match(await page.text(), /data-product="(cyan|blue)"/);
  const internal = await handleCloudflareRequest(new Request(`https://${workerSite}${appearancePath}`, { headers: { Authorization: `Bearer ${token}` } }), { USAGE_DB: db, ...env });
  assert.deepEqual(await internal.json(), { site: containerSite, accent: 'indigo' });
});

test('pages render the chosen accent and theme color, and API responses never read it', async () => {
  let reads = 0;
  const context = { accent: async () => { reads++; return 'teal'; } };
  const page = await html(context);
  assert.match(page, /<html lang="en" data-product="teal">/);
  assert.match(page, /<meta name="theme-color" content="#0f766e" \/>/);
  assert.equal(reads, 1);
  for (const path of ['/ip', '/json', '/country']) await handleRequest(new Request(`https://${workerSite}${path}`, { headers: { 'CF-Connecting-IP': '1.1.1.1' } }), {}, context);
  assert.equal(reads, 1);
  for (const accent of [async () => 'orange', async () => { throw new Error('Unavailable'); }, async () => '"><script>']) {
    const fallback = await html({ accent });
    assert.match(fallback, /<html lang="en" data-product="blue">/);
    assert.ok(!fallback.includes('"><script>'));
  }
  const statistics = { site: workerSite, snapshot: async () => ({}), record() {} };
  assert.match(await html({ statistics, accent: () => 'fuchsia' }, '/stats'), /<html lang="en" data-product="fuchsia">/);
});

test('the container follows the Worker accent, persists it, and keeps it while the Worker is unreachable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ipinfo-appearance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { endpoint: `https://${workerSite}/internal/usage`, token, proxy: '', directory };
  const requests = [];
  let reply = () => Response.json({ site: containerSite, accent: 'violet' });
  const fetcher = async (url, options) => { requests.push([url, options]); return reply(); };
  const appearance = await new ContainerAppearance(config, { fetcher }).initialize();
  assert.equal(appearance.accent(), 'blue');
  await appearance.refresh();
  assert.equal(appearance.accent(), 'violet');
  assert.equal(requests[0][0], `https://${workerSite}${appearancePath}`);
  assert.equal(requests[0][1].headers.Authorization, `Bearer ${token}`);
  for (const failure of [() => { throw new Error('Offline'); }, () => new Response('{}', { status: 503 }), () => Response.json({ site: workerSite, accent: 'teal' }), () => Response.json({ site: containerSite, accent: 'orange' })]) {
    reply = failure;
    await appearance.refresh();
    assert.equal(appearance.accent(), 'violet');
  }
  // A restart during an outage keeps the last accent saved on the statistics volume.
  reply = () => { throw new Error('Offline'); };
  const restarted = await new ContainerAppearance(config, { fetcher }).initialize();
  assert.equal(restarted.accent(), 'violet');
});
