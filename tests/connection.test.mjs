import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = (await readFile(new URL('../html/network.html', import.meta.url), 'utf8')).replace(/^<script>\s*|\s*<\/script>\s*$/g, '');
function page(ip = '8.8.8.8', path = '/', fetcher = () => { throw new Error('Unexpected background request'); }) {
  function element(dataset = {}) {
    const classes = new Set();
    return { dataset, classes, textContent: '',
      classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name) },
      replaceChildren(...nodes) { this.children = nodes; this.textContent = nodes.map(node => node.textContent).join(''); },
    };
  }
  const elements = { 'ip-address': element({ ip }) };
  if (new URL(path, 'https://ip.bea.sh').searchParams.has('ip')) {
    elements['show-my-ip'] = element();
    elements['show-my-ip'].classes.add('hidden');
  }
  const document = { getElementById: id => elements[id], createTextNode: textContent => ({ textContent }), createElement: tagName => ({ tagName, textContent: '' }) };
  runInNewContext(script, { document, window: { location: { href: `https://ip.bea.sh${path}` } }, URL, AbortSignal, fetch: fetcher });
  return { elements };
}
test('the visitor page performs no background discovery requests', () => {
  let requests = 0;
  const browser = page('8.8.8.8', '/', () => { requests++; });
  assert.equal(requests, 0);
  assert.equal(browser.elements['show-my-ip'], undefined);
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
  }
});
test('an unavailable or invalid connection response does not reveal Show my IP', async () => {
  for (const fetcher of [async () => { throw new Error('Offline'); }, async () => new Response('Unavailable', { status: 503 }), async () => new Response('Not an IP')]) {
    const browser = page('1.1.1.1', '/?ip=1.1.1.1', fetcher);
    await new Promise(setImmediate);
    assert.equal(browser.elements['show-my-ip'].classes.has('hidden'), true);
  }
});
test('IPv6 preserves the full address and wraps at hextet boundaries', () => {
  const ip = '2a05:d016:132:9300:ee44:7663:fbeb:cfa8';
  const browser = page(ip);
  assert.equal(browser.elements['ip-address'].textContent, ip);
  assert.equal(browser.elements['ip-address'].children.filter(node => node.tagName === 'wbr').length, 7);
});
