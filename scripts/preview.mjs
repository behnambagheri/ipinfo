import { createServer } from 'node:http';
import worker from '../dist/worker.mjs';
import { localGeoIPAssets } from './local-geoip-assets.mjs';
let env = {};
try { env = await localGeoIPAssets(); }
catch { console.log('Custom lookups require npm run geoip:prepare; visitor IP detection is available.'); }
// Local preview reports the actual loopback peer; it does not invent geolocation.
createServer(async (incoming, outgoing) => {
  const headers = new Headers(incoming.headers);
  headers.set('CF-Connecting-IP', incoming.socket.remoteAddress || '127.0.0.1');
  const chunks = [];
  if (incoming.method === 'POST') for await (const chunk of incoming) chunks.push(chunk);
  const request = new Request(`http://localhost:8787${incoming.url}`, { method: incoming.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const result = await worker.fetch(request, env, {});
  outgoing.writeHead(result.status, Object.fromEntries(result.headers));
  outgoing.end(Buffer.from(await result.arrayBuffer()));
}).listen(8787, '127.0.0.1', () => console.log('Preview: http://localhost:8787'));
