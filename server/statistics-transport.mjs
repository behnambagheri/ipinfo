import { spawn } from 'node:child_process';

// curl supplies the container's HTTP/HTTPS/SOCKS transport. Secrets go through
// stdin config, never argv, shell interpolation, diagnostics, or response errors.
const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
export async function statisticsFetch(url, options, proxy, { allowHTTP = false, proxyCAFile } = {}) {
  const args = ['-q', '--silent', '--globoff', '--max-time', '5', '--connect-timeout', '5', '--proto', allowHTTP ? '=http,https' : '=https', '--write-out', '\n%{http_code}', '--config', '-'];
  if (proxyCAFile) args.push('--proxy-cacert', proxyCAFile);
  const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, NO_PROXY: '', no_proxy: '' }, signal: options.signal });
  child.stdin.on('error', () => {});
  let config = `url = ${quote(url)}\nproxy = ${quote(proxy)}\nnoproxy = ""\nrequest = ${quote(options.method)}\n`;
  for (const [name, value] of Object.entries(options.headers)) config += `header = ${quote(name + ': ' + value)}\n`;
  if (options.body) config += `data = ${quote(options.body)}\n`;
  child.stdin.end(config);
  const completion = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('Statistics transport failed')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Statistics transport failed')));
  });
  completion.catch(() => {});
  let size = 0; const chunks = [];
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > 65536) throw new Error('Statistics response is too large');
      chunks.push(chunk);
    }
    await completion;
    const body = Buffer.concat(chunks);
    const status = Number(body.subarray(-3).toString());
    if (!Number.isInteger(status) || status < 200 || status > 599 || body.at(-4) !== 10) throw new Error('Invalid statistics response');
    // No --location: a redirect must never forward the reporting credential.
    return new Response(body.subarray(0, -4), { status, headers: { 'Content-Type': 'application/json' } });
  } catch {
    child.kill('SIGTERM'); await completion.catch(() => {});
    throw new Error('Statistics transport failed');
  }
}
