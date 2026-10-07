import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Pass credentials through stdin, never shell text, process arguments, or logs.
const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
export async function download(url, { proxy = '', path, maxBytes = 128 * 1024 * 1024, timeoutSeconds = 300, signal, allowHTTP = false, proxyCAFile } = {}) {
  const args = ['-q', '--fail', '--silent', '--location', '--globoff', '--max-redirs', '6', '--connect-timeout', '15', '--max-time', String(timeoutSeconds),
    '--proto', allowHTTP ? '=http,https' : '=https', '--proto-redir', allowHTTP ? '=http,https' : '=https', '--config', '-'];
  if (proxyCAFile) args.push('--proxy-cacert', proxyCAFile);
  const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, NO_PROXY: '', no_proxy: '' }, signal });
  child.stdin.on('error', () => {});
  child.stdin.end(`url = ${quote(url)}\nproxy = ${quote(proxy)}\nnoproxy = ""\nheader = "Accept: application/vnd.github+json"\nuser-agent = "bea-ipinfo"\n`);
  const completion = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('Database download failed')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Database download failed')));
  });
  // Attach immediately so a failed spawn cannot cause an unhandled rejection.
  completion.catch(() => {});
  let size = 0;
  const chunks = [];
  const output = path ? createWriteStream(path, { flags: 'wx', mode: 0o600 }) : null;
  const sink = new Writable({ write(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) return callback(new Error('Database download exceeds size limit'));
    if (output) output.write(chunk, callback);
    else { chunks.push(chunk); callback(); }
  }, final(callback) { if (output) output.end(callback); else callback(); }, destroy(error, callback) { output?.destroy(); callback(error); } });
  if (output) output.on('error', error => sink.destroy(error));
  try {
    await pipeline(child.stdout, sink);
    await completion;
    return path ? undefined : Buffer.concat(chunks);
  } catch {
    child.kill('SIGTERM');
    await completion.catch(() => {});
    throw new Error('Database download failed');
  }
}
