import { handleRequest } from './index.mjs';
import { checkPort } from './port-check.mjs';

export async function handleCloudflareRequest(request, env = {}, context = {}, connectSocket) {
  const enabled = [true, 'true', '1'].includes(env.IPINFO_PORT_LOOKUP ?? env.ECHOIP_PORT_LOOKUP);
  const runtime = { waitUntil: context.waitUntil?.bind(context) };
  if (enabled) runtime.portCheck = async value => {
    const connect = connectSocket ?? (await import('cloudflare:sockets')).connect;
    // Only the edge-provided visitor address can be tested; query IPs are ignored.
    return checkPort(request.headers.get('CF-Connecting-IP'), value, connect);
  };
  return handleRequest(request, env, runtime);
}

export default { fetch: handleCloudflareRequest };
