import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = (await readFile(new URL('../html/network.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
function page(ip = '8.8.8.8', path = '/', fetcher = () => { throw new Error('Unexpected background request'); }) {
  function element(dataset = {}) {
    const classes = new Set();
    return { dataset, textContent: '', disabled: false, attributes: {}, listeners: {},
      classList: { replace: (a, b) => { classes.delete(a); classes.add(b); }, toggle: (name, active) => active ? classes.add(name) : classes.delete(name) },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      replaceChildren(...nodes) { this.children = nodes; this.textContent = nodes.map(node => node.textContent).join(''); },
    };
  }
  const buttons = ['auto', '4', '6'].map(ipFamily => element({ ipFamily }));
  const elements = Object.fromEntries(['ip-address', 'ip-title', 'family-controls', 'family-status'].map(id => [id, element()]));
  elements['ip-address'].dataset.ip = ip;
  elements['family-controls'].querySelectorAll = () => buttons;
  const navigations = [];
  const document = { getElementById: id => elements[id], createTextNode: textContent => ({ textContent }), createElement: tagName => ({ tagName, textContent: '' }) };
  runInNewContext(script, { document, window: { location: { href: `https://ip.bea.sh${path}`, assign: value => navigations.push(value) } }, URL, AbortController, setTimeout, clearTimeout, fetch: fetcher });
  return { elements, buttons, navigations, click: family => buttons.find(button => button.dataset.ipFamily === family).listeners.click() };
}
test('Auto preserves the default without detection requests and clears an explicit lookup when selected', async () => {
  const initial = page();
  assert.equal(initial.buttons[0].attributes['aria-pressed'], 'true');
  const lookup = page('1.1.1.1', '/?ip=1.1.1.1&family=4');
  await lookup.click('auto');
  assert.equal(lookup.navigations[0], 'https://ip.bea.sh/');
});
test('IPv4 detection uses the browser-only IPv4 endpoint and loads the detected address on this site', async () => {
  let called = false;
  const browser = page('::1', '/', async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.ipify.org?format=json');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return Response.json({ ip: '8.8.4.4' });
  });
  assert.equal(called, false);
  await browser.click('4');
  assert.equal(browser.navigations[0], 'https://ip.bea.sh/?ip=8.8.4.4&family=4');
});
test('IPv6 preserves the full address and wraps at hextet boundaries', async () => {
  const ip = '2a05:d016:132:9300:ee44:7663:fbeb:cfa8';
  const browser = page(ip, `/?ip=${ip}&family=6`, async url => {
    assert.equal(url, 'https://api6.ipify.org?format=json');
    return Response.json({ ip });
  });
  assert.equal(browser.elements['ip-address'].textContent, ip);
  assert.equal(browser.elements['ip-address'].children.filter(node => node.tagName === 'wbr').length, 7);
  assert.equal(browser.elements['ip-title'].textContent, 'Your IPv6 address');
  await browser.click('6');
  assert.equal(new URL(browser.navigations[0]).searchParams.get('ip'), ip);
  assert.equal(browser.buttons[2].attributes['aria-pressed'], 'true');
});
test('missing IPv6 or a wrong address version keeps the current page usable', async () => {
  for (const fetcher of [async () => { throw new TypeError('Network unavailable'); }, async () => Response.json({ ip: '8.8.8.8' })]) {
    const browser = page('8.8.8.8', '/', fetcher);
    await browser.click('6');
    assert.equal(browser.navigations.length, 0);
    assert.match(browser.elements['family-status'].textContent, /Could not detect your IPv6 address/);
    assert.equal(browser.buttons.every(button => !button.disabled), true);
    assert.equal(browser.elements['family-controls'].attributes['aria-busy'], 'false');
    assert.equal(browser.buttons[0].attributes['aria-pressed'], 'true');
  }
});
