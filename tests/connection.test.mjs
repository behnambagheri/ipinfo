import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = (await readFile(new URL('../html/network.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
function page(ip = '8.8.8.8', path = '/', fetcher = () => { throw new Error('Unexpected background request'); }, settings = { auto: 'https://ip.bea.sh', ipv4: 'https://v4.example.com', ipv6: 'https://v6.example.com' }) {
  function element(dataset = {}) {
    const classes = new Set();
    return { dataset, classes, textContent: '', disabled: false, attributes: {}, listeners: {},
      classList: { replace: (a, b) => { classes.delete(a); classes.add(b); }, toggle: (name, active) => active ? classes.add(name) : classes.delete(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      replaceChildren(...nodes) { this.children = nodes; this.textContent = nodes.map(node => node.textContent).join(''); },
    };
  }
  const buttons = ['auto', '4', '6'].map(ipFamily => element({ ipFamily }));
  const elements = Object.fromEntries(['ip-address', 'ip-title', 'family-controls', 'family-status'].map(id => [id, element()]));
  elements['ip-address'].dataset.ip = ip;
  elements['family-controls'].classes.add('hidden');
  elements['family-controls'].querySelectorAll = () => buttons;
  if (new URL(path, 'https://ip.bea.sh').searchParams.has('ip')) {
    elements['show-my-ip'] = element();
    elements['show-my-ip'].classes.add('hidden');
  }
  const navigations = [];
  const document = { getElementById: id => elements[id], createTextNode: textContent => ({ textContent }), createElement: tagName => ({ tagName, textContent: '' }) };
  runInNewContext(script.replace("{{ .NetworkConfig }}", JSON.stringify(JSON.stringify(settings))), { document, window: { location: { href: `https://ip.bea.sh${path}`, assign: value => navigations.push(value) } }, URL, AbortController, AbortSignal, setTimeout, clearTimeout, fetch: fetcher });
  return { elements, buttons, navigations, click: family => buttons.find(button => button.dataset.ipFamily === family).listeners.click() };
}
test('Auto preserves the default without detection requests and clears a visitor family selection', async () => {
  const initial = page();
  assert.equal(initial.buttons[0].attributes['aria-pressed'], 'true');
  const lookup = page('1.1.1.1', '/?family=4');
  await lookup.click('auto');
  assert.equal(lookup.navigations[0], 'https://ip.bea.sh/');
});
test('manual IPv4 and IPv6 lookups hide the selector without changing address rendering', () => {
  for (const ip of ['8.8.8.8', '2606:4700:4700::1111']) {
    const browser = page(ip, `/?ip=${ip}`);
    assert.equal(browser.elements['family-controls'].classes.has('hidden'), true);
    assert.equal(browser.elements['family-controls'].classes.has('flex'), false);
    assert.equal(browser.buttons.every(button => !button.listeners.click), true);
    assert.equal(browser.elements['ip-title'].textContent, '');
    if (ip.includes(':')) assert.equal(browser.elements['ip-address'].textContent, ip);
  }
});
test('invalid family markers cannot turn an explicit lookup into a visitor family selection', () => {
  for (const marker of ['auto', 'invalid', '4', '6']) {
    const browser = page('1.1.1.1', `/?ip=1.1.1.1&family=${marker}`);
    assert.equal(browser.elements['family-controls'].classes.has('hidden'), true);
    assert.equal(browser.buttons.every(button => !button.listeners.click), true);
  }
});
test('Show my IP appears only when a manual lookup differs from the connection IP', async () => {
  for (const visitorIP of ['1.1.1.1', '8.8.8.8']) {
    const browser = page('1.1.1.1', '/?ip=1.1.1.1', async (url, options) => {
      assert.equal(url, 'https://ip.bea.sh/ip');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      return new Response(visitorIP + '\n');
    });
    await new Promise(setImmediate);
    assert.equal(browser.elements['show-my-ip'].classes.has('hidden'), visitorIP === '1.1.1.1');
    assert.equal(browser.elements['family-controls'].classes.has('hidden'), true);
  }
});
test('Show my IP stays hidden during a visitor family selection without a connection check', () => {
  let requests = 0;
  const browser = page('2606:4700:4700::1111', '/?family=6', () => { requests++; });
  assert.equal(requests, 0);
  assert.equal(browser.elements['show-my-ip']?.classes.has('hidden') ?? true, true);
  assert.equal(browser.elements['family-controls'].classes.has('flex'), true);
});
test('an unavailable or invalid connection response does not reveal Show my IP', async () => {
  for (const fetcher of [async () => { throw new Error('Offline'); }, async () => new Response('Unavailable', { status: 503 }), async () => new Response('Not an IP')]) {
    const browser = page('1.1.1.1', '/?ip=1.1.1.1', fetcher);
    await new Promise(setImmediate);
    assert.equal(browser.elements['show-my-ip']?.classes.has('hidden') ?? true, true);
  }
});
test('IPv4 selection uses this service API and navigates only to its configured endpoint', async () => {
  let called = false;
  const browser = page('::1', '/', async (url, options) => {
    called = true;
    assert.equal(url, 'https://ip.bea.sh/json?family=4');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    const response = Response.json({ ip: '8.8.4.4' });
    Object.defineProperty(response, 'url', { value: 'https://v4.example.com/json?family=4&_family_redirect=4' });
    return response;
  });
  assert.equal(called, false);
  await browser.click('4');
  assert.equal(browser.navigations[0], 'https://v4.example.com/?family=4&_family_redirect=4');
});
for (const [family, ip] of [['4', '8.8.8.8'], ['6', '2a05:d016:132:9300:ee44:7663:fbeb:cfa8']]) {
  test(`clicking IPv${family} when Auto already has IPv${family} makes no request, navigation, or UI change`, async () => {
    let requests = 0;
    const browser = page(ip, '/', () => { requests++; throw new Error('Must not fetch'); });
    const before = JSON.stringify({
      status: browser.elements['family-status'].textContent,
      title: browser.elements['ip-title'].textContent,
      controls: browser.elements['family-controls'].attributes,
      buttons: browser.buttons.map(button => ({ attributes: button.attributes, disabled: button.disabled })),
    });
    await browser.click(family);
    assert.equal(requests, 0);
    assert.equal(browser.navigations.length, 0);
    assert.equal(JSON.stringify({
      status: browser.elements['family-status'].textContent,
      title: browser.elements['ip-title'].textContent,
      controls: browser.elements['family-controls'].attributes,
      buttons: browser.buttons.map(button => ({ attributes: button.attributes, disabled: button.disabled })),
    }), before);
  });
}
test('IPv6 preserves the full address and wraps at hextet boundaries', async () => {
  const ip = '2a05:d016:132:9300:ee44:7663:fbeb:cfa8';
  const browser = page(ip, '/?family=6');
  assert.equal(browser.elements['ip-address'].textContent, ip);
  assert.equal(browser.elements['ip-address'].children.filter(node => node.tagName === 'wbr').length, 7);
  assert.equal(browser.elements['ip-title'].textContent, 'Your IPv6 address');
  await browser.click('6');
  assert.equal(browser.navigations.length, 0);
  assert.equal(browser.buttons[2].attributes['aria-pressed'], 'true');
});
test('missing IPv6 or a wrong address version keeps the current page usable', async () => {
  for (const fetcher of [async () => { throw new TypeError('Network unavailable'); }, async () => Response.json({ ip: '8.8.8.8' })]) {
    const browser = page('8.8.8.8', '/', fetcher);
    await browser.click('6');
    assert.equal(browser.navigations.length, 0);
    assert.match(browser.elements['family-status'].textContent, /Could not connect over IPv6/);
    assert.equal(browser.buttons.every(button => !button.disabled), true);
    assert.equal(browser.elements['family-controls'].attributes['aria-busy'], 'false');
    assert.equal(browser.buttons[0].attributes['aria-pressed'], 'true');
  }
});

test('unconfigured switching makes no request and preserves the current address', async () => {
  const browser = page('::1', '/', () => { throw new Error('Must not fetch'); }, {});
  await browser.click('4');
  assert.equal(browser.navigations.length, 0);
  assert.match(browser.elements['family-status'].textContent, /IPv4 switching is unavailable/);
});
test('unexpected redirect targets cannot navigate away from the configured service', async () => {
  const browser = page('::1', '/', async () => {
    const response = Response.json({ ip: '8.8.8.8' });
    Object.defineProperty(response, 'url', { value: 'https://untrusted.example/json?family=4' });
    return response;
  });
  await browser.click('4');
  assert.equal(browser.navigations.length, 0);
  assert.match(browser.elements['family-status'].textContent, /Could not connect/);
});
