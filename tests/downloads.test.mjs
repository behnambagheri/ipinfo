import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as netServer, createConnection } from 'node:net';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download } from '../server/downloads.mjs';
import { DatabaseUpdater } from '../server/updates.mjs';
import { LocalDatabases, openDatabases, names, sha256 } from '../server/databases.mjs';
import { fixtureBytes, writeFixtures } from './server-fixtures.mjs';

async function listen(t, server) {
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
test('release metadata and all three database assets download through the configured HTTP proxy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ipinfo-proxy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { paths } = await writeFixtures(join(root, 'bundled'), 1700000000);
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await fixtureBytes(name, 1750000000)])));
  const tag = 'test-release';
  const latest = { tag_name: tag, assets: names.map(name => ({ name: `GeoLite2-${name}.mmdb`, digest: `sha256:${sha256(files[name])}`, browser_download_url: `https://github.com/P3TERX/GeoLite.mmdb/releases/download/${tag}/GeoLite2-${name}.mmdb` })) };
  const seen = [];
  const port = await listen(t, createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    assert.match(req.url, /^http:\/\/upstream.invalid\//);
    res.end(req.url.endsWith('/latest') ? JSON.stringify(latest) : files[/GeoLite2-(\w+)\.mmdb$/.exec(req.url)[1]]);
  }));
  const proxy = `http://user:password@127.0.0.1:${port}`;
  const databases = new LocalDatabases(await openDatabases(paths));
  const updater = await new DatabaseUpdater(databases, { directory: join(root, 'updates'), env: { IPINFO_DATABASE_UPDATE_PROXY: proxy },
    downloadFile: (url, options) => download(`http://upstream.invalid/${url.includes('api.github.com') ? 'latest' : url.split('/').at(-1)}`, { ...options, allowHTTP: true }) }).initialize();
  assert.equal(await updater.check(), true);
  assert.equal(seen.length, 4); assert.ok(seen.every(req => req.auth === 'Basic ' + Buffer.from('user:password').toString('base64')));
  assert.equal(databases.lookup('81.2.69.160').city, 'London');
  assert.ok(!JSON.stringify(updater.status).includes('password'));
});
test('HTTPS proxy connections verify the proxy certificate and transfer the response', async t => {
  const proxyCAFile = new URL('./fixtures/proxy/cert.pem', import.meta.url).pathname;
  const port = await listen(t, httpsServer({ key: await readFile(new URL('./fixtures/proxy/key.pem', import.meta.url)), cert: await readFile(proxyCAFile) }, (req, res) => res.end('through HTTPS proxy')));
  const result = await download('http://upstream.invalid/latest', { allowHTTP: true, proxy: `https://127.0.0.1:${port}`, proxyCAFile });
  assert.equal(result.toString(), 'through HTTPS proxy');
});
test('SOCKS5 and SOCKS5h update transports connect successfully', async t => {
  const origin = await listen(t, createServer((req, res) => res.end('through SOCKS proxy')));
  let handshakes = 0;
  const port = await listen(t, netServer(socket => {
    let buffer = Buffer.alloc(0); let phase = 0;
    const handshake = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 0 && buffer.length >= 2 + buffer[1]) {
        const length = 2 + buffer[1]; buffer = buffer.subarray(length); socket.write(Buffer.from([5, 0])); phase = 1;
      }
      if (phase === 1 && buffer.length >= 5) {
        const type = buffer[3]; const length = type === 1 ? 10 : type === 3 ? 7 + buffer[4] : 22;
        if (buffer.length < length) return;
        handshakes++;
        const upstream = createConnection({ host: '127.0.0.1', port: origin }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          socket.off('data', handshake); if (buffer.length > length) upstream.write(buffer.subarray(length));
          socket.pipe(upstream); upstream.pipe(socket);
        });
        socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); phase = 2;
      }
    };
    socket.on('data', handshake);
  }));
  for (const protocol of ['socks5', 'socks5h']) {
    const result = await download(`http://127.0.0.1:${origin}/latest`, { allowHTTP: true, proxy: `${protocol}://127.0.0.1:${port}` });
    assert.equal(result.toString(), 'through SOCKS proxy');
  }
  assert.equal(handshakes, 2);
});
test('failed and oversized downloads return a credential-free error', async t => {
  const port = await listen(t, createServer((req, res) => res.end('x'.repeat(10000))));
  await assert.rejects(download(`http://127.0.0.1:${port}`, { allowHTTP: true, maxBytes: 10 }), /Database download failed/);
  await assert.rejects(download('https://example.invalid', { proxy: 'http://user:secret@127.0.0.1:1' }), error => error.message === 'Database download failed');
});
