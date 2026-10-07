import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { reverse } from 'node:dns/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { handleRequest } from '../worker/index.mjs';
import { normalizeIP } from '../worker/ip.mjs';
import { serverConfig } from './config.mjs';
import { LocalDatabases, openDatabases } from './databases.mjs';
import { DatabaseUpdater } from './updates.mjs';

export function clientIP(incoming, headers) {
  for (const name of headers) {
    const value = incoming.headers[name.toLowerCase()];
    if (!value) continue;
    const first = (Array.isArray(value) ? value[0] : value).split(',')[0].trim();
    const clean = /^\[([^\]]+)\](?::\d+)?$/.exec(first)?.[1] || (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(first) ? first.split(':')[0] : first);
    if (normalizeIP(clean)) return clean;
  }
  const peer = incoming.socket.remoteAddress?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return normalizeIP(peer);
}
async function hostname(ip) {
  let timer;
  try { return await Promise.race([reverse(ip).then(names => names[0]), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
  catch { return undefined; }
  finally { clearTimeout(timer); }
}
function checkPort(ip, value) {
  if (!ip || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw Object.assign(new Error('Provide a valid TCP port between 1 and 65535.'), { status: 400 });
  const port = Number(value);
  return new Promise(resolve => {
    const started = performance.now();
    const socket = createConnection({ host: ip, port });
    const finish = (reachable, status) => {
      if (socket.destroyed) return;
      socket.destroy(); resolve({ ip, port, reachable, status, elapsed_ms: Math.round(performance.now() - started) });
    };
    socket.setTimeout(3000, () => finish(false, 'timeout'));
    socket.once('connect', () => finish(true, 'open'));
    socket.once('error', error => { socket.destroy(); resolve({ ip, port, reachable: false, status: error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable', elapsed_ms: Math.round(performance.now() - started) }); });
  });
}
export function createHTTPServer(databases, updater, config) {
  const env = { BUILD_REVISION: config.revision, get GEOIP_RELEASE() { return databases.release; },
    LOCAL_GEOIP: { lookup: ip => databases.lookup(ip), info: () => databases.info(updater.status) } };
  return createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (incoming, outgoing) => {
    try {
      // Use only the path from the request target; no external origin is fetched.
      if (!incoming.url.startsWith('/')) { outgoing.writeHead(400); outgoing.end(); return; }
      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) requestHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      const host = incoming.headers.host || 'localhost';
      const secure = incoming.socket.encrypted || (config.headers.length > 0 && incoming.headers['x-forwarded-proto'] === 'https');
      const request = new Request(`${secure ? 'https' : 'http'}://${host}${incoming.url}`, { method: incoming.method, headers: requestHeaders });
      const ip = clientIP(incoming, config.headers);
      const context = { clientIP: ip || '', disableCustomIP: config.disableCustomIP,
        hostname: config.reverseLookup ? hostname : undefined,
        portCheck: config.portLookup ? value => checkPort(ip, value) : undefined };
      const result = await handleRequest(request, env, context);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end('{"error":"Request could not be processed."}\n');
    } finally { incoming.resume(); }
  });
}
export async function startServer(env = process.env) {
  const config = serverConfig(env);
  const databases = new LocalDatabases(await openDatabases(config.databasePaths), config.cacheSize);
  const updater = await new DatabaseUpdater(databases, { env, directory: config.updateDirectory }).initialize(join(dirname(config.databasePaths.ASN || '/data/geolite2/ASN'), 'release.json'));
  const server = createHTTPServer(databases, updater, config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  updater.start();
  return { server, databases, updater, async close() { await updater.stop(); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const service = await startServer();
    console.log(`IPinfo listening on port ${service.server.address().port}; revision ${process.env.BUILD_REVISION || 'development'}`);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); process.exit(0); });
  } catch { console.error('IPinfo could not start; check configuration and database files.'); process.exitCode = 1; }
}
