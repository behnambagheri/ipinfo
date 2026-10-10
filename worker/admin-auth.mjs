import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
export async function authorizedAdmin(request, env, { keySet, now = new Date() } = {}) {
  const issuer = env.IPINFO_ACCESS_ISSUER;
  const audience = env.IPINFO_ACCESS_AUD;
  const emails = (env.IPINFO_ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  // Missing configuration, provider errors and forged identity headers all fail closed.
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') || !audience || !emails.length) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) return false;
  try {
    if (!keySet) {
      if (!keySets.has(issuer)) {
        if (keySets.size >= 4) keySets.clear();
        keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }));
      }
      keySet = keySets.get(issuer);
    }
    const { payload } = await jwtVerify(token, keySet, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'], currentDate: now });
    return typeof payload.email === 'string' && emails.includes(payload.email.toLowerCase());
  } catch { return false; }
}
