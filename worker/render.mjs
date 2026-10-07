export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
export function scriptString(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
export function templateData(data, request, explicit, context = {}) {
  const mapping = { IP: 'ip', IPDecimal: 'ip_decimal', Hostname: 'hostname', Country: 'country', CountryISO: 'country_iso', CountryIR: 'country_ir', City: 'city', RegionName: 'region_name', RegionCode: 'region_code', MetroCode: 'metro_code', PostalCode: 'postal_code', ASN: 'asn', ASNOrg: 'asn_org', Timezone: 'timezone', Latitude: 'latitude', Longitude: 'longitude' };
  const output = Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, data[value]]));
  Object.assign(output, { JSON: JSON.stringify(data), Host: new URL(request.url).origin, ExplicitLookup: explicit, NoCustomIP: Boolean(context.disableCustomIP), Port: Boolean(context.portCheck), Sponsor: false, UserAgent: { RawValue: request.headers.get('user-agent') || '' } });
  if (Number.isFinite(data.latitude) && Number.isFinite(data.longitude)) {
    Object.assign(output, { BoxLonLeft: Math.max(-180, data.longitude - 0.1), BoxLonRight: Math.min(180, data.longitude + 0.1), BoxLatBottom: Math.max(-90, data.latitude - 0.1), BoxLatTop: Math.min(90, data.latitude + 0.1) });
  }
  return output;
}
