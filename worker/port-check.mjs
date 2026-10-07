import { normalizeIP, privateIP } from './ip.mjs';

function fail(message, status) { throw Object.assign(new Error(message), { status }); }

export async function checkPort(clientIP, value, connect, timeoutMs = 5000) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) fail('Provide a TCP port between 1 and 65535.', 400);
  const ip = normalizeIP(clientIP);
  if (!ip) fail('Client IP is unavailable.', 503);
  const port = Number(value);
  const result = { ip, port, reachable: false, status: 'unknown' };
  if (privateIP(ip) || port === 25) return { ...result, status: 'blocked', error: 'Cloudflare does not permit this TCP destination.' };
  let socket;
  let timer;
  try {
    socket = connect({ hostname: ip.includes(':') ? `[${ip}]` : ip, port }, { secureTransport: 'off' });
    socket.closed.catch(() => {});
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Connection timed out'), { timedOut: true })), timeoutMs); }),
    ]);
    return { ...result, reachable: true, status: 'open' };
  } catch (error) {
    const message = String(error.message || '');
    if (error.timedOut || /timed? ?out|timeout/i.test(message)) return { ...result, status: 'timeout' };
    if (/prohibited|disallowed|cannot connect to the specified address|loop detected/i.test(message)) return { ...result, status: 'blocked', error: 'Cloudflare does not permit this TCP destination.' };
    if (/refused/i.test(message)) return { ...result, status: 'refused' };
    return { ...result, error: 'The TCP connection could not be established.' };
  } finally {
    clearTimeout(timer);
    if (socket) await socket.close().catch(() => {});
  }
}
