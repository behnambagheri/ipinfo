import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { handleRequest } from '../worker/index.mjs';

test('PWA assets are available without visitor metadata, with correct binary bytes and headers', async () => {
  const origin = 'https://ip.bea.sh';
  const response = await handleRequest(new Request(`${origin}/manifest.webmanifest`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/manifest+json');
  const manifest = await response.json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const result = await handleRequest(new Request(origin + icon.src));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await result.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
    assert.equal((await handleRequest(new Request(origin + icon.src, { method: 'HEAD' }))).status, 200);
  }
  const favicon = Buffer.from(await (await handleRequest(new Request(`${origin}/favicon.ico`))).arrayBuffer());
  assert.equal(favicon.readUInt16LE(2), 1);
  assert.equal(favicon.readUInt16LE(4), 3);
  const sw = await handleRequest(new Request(`${origin}/sw.js`));
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
  assert.ok(!(await sw.text()).includes('__ASSET_VERSION__'));
  assert.equal(await (await handleRequest(new Request(`${origin}/sw.js`, { method: 'HEAD' }))).text(), '');
  const html = await (await handleRequest(new Request(origin, { headers: { Accept: 'text/html', 'CF-Connecting-IP': '1.1.1.1' } }))).text();
  assert.match(html, /href="\/manifest.webmanifest"/);
  assert.match(html, /href="\/favicon.ico"/);
  const policy = sw.headers.get('content-security-policy');
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /manifest-src 'self'/);
  const offline = await (await handleRequest(new Request(`${origin}/offline.html`))).text();
  assert.match(offline, /You’re offline/);
  assert.ok(!offline.includes('{{'));
  assert.ok(!offline.includes('1.1.1.1'));
});

async function serviceWorker() {
  const listeners = new Map();
  const stores = new Map();
  const writes = [];
  const calls = [];
  let fail = false;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async addAll(paths) { for (const path of paths) { writes.push(path); store.set(path, new Response(path === '/offline.html' ? 'Offline fallback' : 'Static asset')); } },
        async match(request) { return store.get(typeof request === 'string' ? request : new URL(request.url).pathname)?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  runInNewContext(await readFile('dist/public/sw.js', 'utf8'), {
    self: { location: { origin: 'https://ip.bea.sh' }, addEventListener: (name, callback) => listeners.set(name, callback), skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches, URL, Response,
    fetch: async (request, options) => { calls.push({ request, options }); if (fail) throw new TypeError('Offline'); return new Response('Live IP data'); },
  });
  async function lifecycle(name) { let promise; listeners.get(name)({ waitUntil(value) { promise = value; } }); await promise; }
  function request(path, mode = 'cors', method = 'GET') {
    let promise;
    listeners.get('fetch')({ request: { url: new URL(path, 'https://ip.bea.sh').href, method, mode }, respondWith(value) { promise = value; } });
    return promise;
  }
  await lifecycle('install');
  return { writes, stores, calls, lifecycle, request, offline() { fail = true; } };
}

test('service worker caches only public assets and removes only its own old caches', async () => {
  const sw = await serviceWorker();
  assert.ok(sw.writes.includes('/offline.html'));
  assert.ok(sw.writes.includes('/brand/ipinfo.svg'));
  assert.ok(!sw.writes.some(path => path === '/' || path.startsWith('/json') || path.includes('?')));
  sw.stores.set('ipinfo-assets-old', new Map());
  sw.stores.set('another-app', new Map());
  await sw.lifecycle('activate');
  assert.equal(sw.stores.has('ipinfo-assets-old'), false);
  assert.equal(sw.stores.has('another-app'), true);
});

test('app navigation always uses fresh data and falls back offline without caching visitor pages', async () => {
  const sw = await serviceWorker();
  for (const path of ['/', '/?ip=8.8.8.8&family=4']) {
    assert.equal(await (await sw.request(path, 'navigate')).text(), 'Live IP data');
    assert.equal(sw.calls.at(-1).options.cache, 'no-store');
  }
  sw.offline();
  assert.equal(await (await sw.request('/?ip=8.8.8.8', 'navigate')).text(), 'Offline fallback');
  assert.equal(sw.writes.includes('/'), false);
  assert.equal(await (await sw.request('/brand/ipinfo.svg')).text(), 'Static asset');
});

test('API, external requests, non-GET requests, and unknown assets bypass the service worker', async () => {
  const sw = await serviceWorker();
  for (const [path, mode, method] of [
    ['/json', 'navigate', 'GET'], ['/json?ip=8.8.8.8', 'cors', 'GET'], ['/ip', 'cors', 'GET'],
    ['https://api.ipify.org?format=json', 'cors', 'GET'], ['/healthz', 'cors', 'GET'],
    ['/manifest.webmanifest', 'cors', 'POST'], ['/brand/ipinfo.svg?extra=1', 'cors', 'GET'],
  ]) assert.equal(sw.request(path, mode, method), undefined);
  assert.equal(sw.calls.length, 0);
});

const pwaSource = (await readFile('html/pwa.html', 'utf8')).split('<script>')[1].split('</script>')[0];
function installPage({ secure = true, standalone = false, registrationFails = false } = {}) {
  const events = {};
  const registrations = [];
  const buttons = [0, 1].map(() => ({ hidden: true, disabled: false, classList: { toggle(name, value) { buttons[this.index].hidden = value; }, index: 0 }, addEventListener(name, callback) { this[name] = callback; } }));
  buttons.forEach((button, index) => { button.classList.index = index; });
  const dialog = { opened: false, showModal() { this.opened = true; }, close() { this.opened = false; } };
  const navigator = { serviceWorker: { register(...args) { registrations.push(args); return registrationFails ? Promise.reject(new Error('Storage blocked')) : Promise.resolve(); } } };
  runInNewContext(pwaSource, {
    document: { querySelectorAll: () => buttons, getElementById: () => dialog }, navigator,
    matchMedia: () => ({ matches: standalone, addEventListener() {} }),
    window: { isSecureContext: secure, addEventListener(name, callback) { events[name] = callback; } },
  });
  return { buttons, dialog, events, registrations };
}

test('installation offers manual instructions, uses native prompts, and hides after installation', async () => {
  const page = installPage();
  assert.ok(page.buttons.every(button => !button.hidden));
  assert.equal(page.registrations[0][0], '/sw.js');
  await page.buttons[0].click();
  assert.equal(page.dialog.opened, true);
  page.dialog.close();
  let prompted = 0;
  let prevented = false;
  page.events.beforeinstallprompt({ preventDefault() { prevented = true; }, async prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  await page.buttons[1].click();
  assert.equal(prevented, true);
  assert.equal(prompted, 1);
  assert.equal(page.dialog.opened, false);
  assert.ok(page.buttons.every(button => !button.disabled));
  await page.buttons[0].click();
  assert.equal(page.dialog.opened, true);
  page.events.appinstalled();
  assert.equal(page.dialog.opened, false);
  assert.ok(page.buttons.every(button => button.hidden));
});

test('standalone apps hide install controls and insecure origins do not register workers', async () => {
  assert.ok(installPage({ standalone: true }).buttons.every(button => button.hidden));
  const insecure = installPage({ secure: false });
  assert.ok(insecure.buttons.every(button => button.hidden));
  assert.equal(insecure.registrations.length, 0);
  const blocked = installPage({ registrationFails: true });
  await blocked.buttons[0].click();
  assert.equal(blocked.dialog.opened, true);
});
