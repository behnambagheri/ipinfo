import { rateLimitPath } from '../worker/rate-limits.mjs';
import { statisticsFetch } from './statistics-transport.mjs';

export class ContainerRateLimits {
  constructor(config, { fetcher = config.proxy ? (url, options) => statisticsFetch(url, options, config.proxy) : fetch } = {}) {
    this.config = config; this.fetcher = fetcher;
    this.endpoint = new URL(rateLimitPath, config.endpoint).href;
  }
  async check(ip) {
    const response = await this.fetcher(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) });
    if (!response.ok) throw new Error('Rate limits are unavailable');
    const value = await response.json();
    if (typeof value?.allowed !== 'boolean' || !Number.isSafeInteger(value.retry_after) || value.retry_after < 0 || value.retry_after > 86400 ||
        (value.allowed ? value.retry_after !== 0 : value.retry_after === 0)) throw new Error('Invalid rate-limit response');
    return value;
  }
}
