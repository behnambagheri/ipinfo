import { handleRequest } from './index.mjs';
import { checkPort } from './port-check.mjs';
import { WorkerStatistics, collectionResponse } from './statistics-store.mjs';
import { WorkerVisitors, visitorCollectionResponse } from './visitors-store.mjs';
import { visitorsEnabled } from './visitors.mjs';
import { adminResponse } from './admin.mjs';
import { WorkerRateLimits, rateLimitCollectionResponse } from './rate-limits.mjs';
import { WorkerAppearance, appearanceCollectionResponse } from './appearance.mjs';
import { workerSite } from './statistics.mjs';
import { canonicalOrigin } from './render.mjs';

export async function handleCloudflareRequest(request, env = {}, context = {}, connectSocket) {
  const enabled = [true, 'true', '1'].includes(env.IPINFO_PORT_LOOKUP ?? env.ECHOIP_PORT_LOOKUP);
  const runtime = { waitUntil: context.waitUntil?.bind(context) };
  if (env.IPINFO_CANONICAL_URL) runtime.canonicalOrigin = canonicalOrigin(env.IPINFO_CANONICAL_URL);
  if (env.USAGE_DB) runtime.statistics = new WorkerStatistics(env.USAGE_DB);
  if (env.USAGE_DB && visitorsEnabled(env)) runtime.visitors = new WorkerVisitors(env.USAGE_DB);
  const limits = env.USAGE_DB ? new WorkerRateLimits(env.USAGE_DB) : undefined;
  if (limits) runtime.rateLimit = ip => limits.check(workerSite, ip);
  const appearance = env.USAGE_DB ? new WorkerAppearance(env.USAGE_DB) : undefined;
  if (appearance) runtime.accent = () => appearance.accent(workerSite);
  const admin = await adminResponse(request, env, runtime.visitors, { limits, appearance });
  if (admin) return admin;
  const accent = await appearanceCollectionResponse(request, env, appearance);
  if (accent) return accent;
  const limited = await rateLimitCollectionResponse(request, env, limits);
  if (limited) return limited;
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
    if (env.USAGE_DB) context.waitUntil(new WorkerRateLimits(env.USAGE_DB).prune(new Date(controller.scheduledTime)));
  },
};
