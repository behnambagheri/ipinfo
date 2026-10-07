import test from 'node:test';
import assert from 'node:assert/strict';
import { geoIPRecord } from '../worker/geoip.mjs';
import { handleRequest } from '../worker/index.mjs';

test('GeoLite2 country_ir uses the country ISO code, including country database fallback', async () => {
  for (const iso of ['IR', 'DE', 'US', undefined]) {
    const data = geoIPRecord('8.8.8.8', null, null, { country: { iso_code: iso, is_in_european_union: true } }, 'test');
    assert.equal(data.country_ir, iso === 'IR'); assert.ok(!('country_eu' in data));
    const response = await handleRequest(new Request('https://ip.example/country-ir?ip=8.8.8.8'), { LOCAL_GEOIP: { lookup: () => data } });
    assert.equal(response.status, 200); assert.equal(await response.text(), `${iso === 'IR'}\n`);
  }
});
