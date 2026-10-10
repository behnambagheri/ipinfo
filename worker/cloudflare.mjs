import { handleRequest } from './index.mjs';
import { checkPort } from './port-check.mjs';
import { WorkerStatistics, collectionResponse } from './statistics-store.mjs';
import { WorkerVisitors, visitorCollectionResponse } from './visitors-store.mjs';
import { visitorsEnabled } from './visitors.mjs';
import { adminResponse } from './admin.mjs';

export async function handleCloudflareRequest(request, env = {}, context = {}, connectSocket) {
  const enabled = [true, 'true', '1'].includes(env.IPINFO_PORT_LOOKUP ?? env.ECHOIP_PORT_LOOKUP);
  const runtime = { waitUntil: context.waitUntil?.bind(context) };
  if (env.USAGE_DB) runtime.statistics = new WorkerStatistics(env.USAGE_DB);
  if (env.USAGE_DB && visitorsEnabled(env)) runtime.visitors = new WorkerVisitors(env.USAGE_DB);
  const admin = await adminResponse(request, env, runtime.visitors);
  if (admin) return admin;
  const visitorReport = await visitorCollectionResponse(request, env, runtime.visitors);
  if (visitorReport) return visitorReport;
  const collected = await collectionResponse(request, env, runtime.statistics);
  if (collected) return collected;
  if (enabled) runtime.portCheck = async value => {
    const connect = connectSocket ?? (await import('cloudflare:sockets')).connect;
    // Only the edge-provided visitor address can be tested; query IPs are ignored.
    return checkPort(request.headers.get('CF-Connecting-IP'), value, connect);
  };
  return handleRequest(request, env, runtime);
}

export default {
  fetch: handleCloudflareRequest,
  async scheduled(controller, env, context) {
    if (env.USAGE_DB) context.waitUntil(new WorkerVisitors(env.USAGE_DB).prune(new Date(controller.scheduledTime)));
  },
};
