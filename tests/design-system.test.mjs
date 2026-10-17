import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleRequest } from '../worker/index.mjs';
import { renderStatistics } from '../worker/statistics-page.generated.mjs';
import { renderAdmin } from '../worker/admin-page.generated.mjs';

const origin = 'https://ip.bea.sh';
const order = ['/ds/v1/tokens.css', '/ds/v1/base.css', '/ds/v1/components.css', '/styles.css'];
const stylesheets = html => [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)\?v=[0-9a-f]{10}"/g)].map(match => match[1]);

test('every page loads the vendored design system, then the site stylesheet, with the teal accent', async () => {
  const home = await (await handleRequest(new Request(origin, { headers: { Accept: 'text/html', 'CF-Connecting-IP': '1.1.1.1' } }))).text();
  for (const html of [home, renderStatistics({ Site: 'ip.bea.sh' }), renderAdmin({})]) {
    assert.deepEqual(stylesheets(html), order);
    assert.match(html, /<html lang="en" data-product="teal">/);
    assert.match(html, /class="bb-header"/);
    assert.match(html, /id="theme-toggle" class="bb-theme-toggle"/);
    assert.match(html, /localStorage\.getItem\("bb-theme"\)/);
    assert.ok(!/\b(btn|card-body|base-content|daisy)/.test(html));
  }
  assert.match(home, /class="bb-footer site-footer"/);
  assert.match(home, /href="https:\/\/bea\.sh"/);
  // The offline page is cached alone by the service worker, so its styles are inline.
  const offline = await (await handleRequest(new Request(`${origin}/offline.html`))).text();
  assert.match(offline, /--bb-accent-light/);
  assert.match(offline, /url\('\/ds\/v1\/fonts\/space-grotesk\/SpaceGrotesk-latin\.woff2'\)/);
});

test('design system stylesheets, fonts, and brand mark are served from this app with correct types', async () => {
  for (const path of order) {
    const response = await handleRequest(new Request(`${origin}${path}?v=1`));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8', path);
    assert.equal(await response.text(), await readFile(`public${path}`, 'utf8'), path);
    assert.match(response.headers.get('content-security-policy'), /style-src 'self'/);
  }
  const base = await readFile('public/ds/v1/base.css', 'utf8');
  for (const [, font] of base.matchAll(/url\('([^']+)'\)/g)) {
    const response = await handleRequest(new Request(`${origin}/ds/v1/${font}`));
    assert.equal(response.status, 200, font);
    assert.equal(response.headers.get('content-type'), 'font/woff2', font);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'wOF2', font);
  }
  assert.match((await handleRequest(new Request(`${origin}/`, { headers: { Accept: 'text/html', 'CF-Connecting-IP': '1.1.1.1' } }))).headers.get('content-security-policy'), /font-src 'self'/);
  const mark = await handleRequest(new Request(`${origin}/brand/bb-mark.svg`));
  assert.equal(mark.headers.get('content-type'), 'image/svg+xml');
  assert.match(await readFile('public/ds/VERSION.txt', 'utf8'), /^Commit: [0-9a-f]{40}$/m);
});

test('the site stylesheet uses design-system tokens instead of hardcoded colors or fonts', async () => {
  const css = (await readFile('public/styles.css', 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css));
  assert.ok(!/font-family:(?!\s*var\(--bb-font-)/.test(css));
});
