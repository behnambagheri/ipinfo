export function configuredOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
export function networkSettings(env = {}) {
  return { auto: configuredOrigin(env.IPINFO_AUTO_URL) || '', ipv4: configuredOrigin(env.IPINFO_IPV4_URL) || '', ipv6: configuredOrigin(env.IPINFO_IPV6_URL) || '' };
}
// This returns a routing decision only. Never fetch an address-discovery service server-side.
export function familyDecision(url, ip, env = {}) {
  const values = url.searchParams.getAll('family');
  if (values.length > 1 || (values.length && !['', 'auto', '4', '6'].includes(values[0]))) return { status: 400, error: 'family must be auto, 4, or 6, and supplied only once.' };
  const selected = ['4', '6'].includes(values[0]) ? values[0] : null;
  if (selected && url.searchParams.has('ip')) return { status: 400, error: 'family selects your connection and cannot be combined with an explicit ip lookup.' };
  const actual = ip?.includes(':') ? '6' : ip ? '4' : null;
  const required = env.IPINFO_REQUIRED_FAMILY;
  if (['4', '6'].includes(required) && actual !== required) return { status: 409, error: `This endpoint requires an IPv${required} connection. Your connection uses IPv${actual || 'unknown'}.` };
  if (!selected || actual === selected) return null;
  if (!actual) return { status: 503, error: 'Client IP is unavailable.' };
  if (url.searchParams.has('_family_redirect')) return { status: 409, error: `The configured IPv${selected} endpoint received IPv${actual}. Check its DNS and proxy routing.` };
  const origin = configuredOrigin(env[`IPINFO_IPV${selected}_URL`]);
  if (!origin || origin === url.origin || (url.protocol === 'https:' && !origin.startsWith('https:'))) return { status: 503, error: `IPv${selected} switching is unavailable: configure a reachable IPv${selected}-only endpoint for this deployment.` };
  const target = new URL(origin);
  target.pathname = url.pathname;
  target.search = url.search;
  target.searchParams.set('family', selected);
  target.searchParams.set('_family_redirect', selected);
  return { status: 307, location: target.href };
}
