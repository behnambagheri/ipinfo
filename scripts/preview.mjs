import { createServer } from 'node:http';
import { handleRequest } from '../dist/worker.mjs';
// Local preview reports the actual loopback peer; it does not invent geolocation.
createServer(async (incoming, outgoing) => {
  const headers = new Headers(incoming.headers);
  headers.set('CF-Connecting-IP', incoming.socket.remoteAddress || '127.0.0.1');
  const request = new Request(`http://localhost:8787${incoming.url}`, { method: incoming.method, headers });
  const result = await handleRequest(request);
  outgoing.writeHead(result.status, Object.fromEntries(result.headers));
  outgoing.end(await result.text());
}).listen(8787, '127.0.0.1', () => console.log('Preview: http://localhost:8787'));
