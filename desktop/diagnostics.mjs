import { isIP } from "node:net";

export const hosts = ["ip.bea.sh", "ip.behnam.pro"];
export const fields = [
  ["country", "Country"], ["country_iso", "Country code"], ["country_ir", "In Iran"],
  ["city", "City"], ["region_name", "Region"], ["region_code", "Region code"],
  ["postal_code", "Postal code"], ["timezone", "Time zone"],
  ["latitude", "Latitude"], ["longitude", "Longitude"],
  ["asn", "ASN"], ["asn_org", "Network"],
];
export const invalidResponse = "The service returned an invalid IP lookup response.";

export function canonicalIP(value) {
  if (typeof value !== "string" || !isIP(value) || value.includes("%")) return null;
  return isIP(value) === 4 ? value : new URL(`http://[${value}]/`).hostname.slice(1, -1);
}

function comparable(data) {
  const result = { ip: canonicalIP(data.ip) };
  for (const [key] of fields) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") result[key] = data[key];
  }
  return JSON.stringify(result);
}

export function compare(results) {
  const identical = results.length === 2 && results.every((result) => result.data) && comparable(results[0].data) === comparable(results[1].data);
  const failed = results.some((result) => !result.data);
  return {
    results, identical, visible: identical ? [results[0]] : results,
    exitCode: failed ? 1 : 0,
    message: results.length === 1 ? `Using ${results[0].host}.` : identical ? "Both services match. Showing ip.bea.sh."
      : failed ? "Comparison incomplete. Both service statuses are shown."
        : "The results differ. Both services are shown.",
  };
}

export async function check(ip, { fetchImpl = globalThis.fetch, timeout = 5, source = "auto" } = {}) {
  if (ip && !canonicalIP(ip)) throw new Error("Provide a valid IPv4 or IPv6 address.");
  if (!["auto", ...hosts].includes(source) || !Number.isInteger(timeout) || timeout < 1 || timeout > 30) throw new Error("Invalid lookup settings.");
  return compare(await Promise.all((source === "auto" ? hosts : [source]).map(async (host) => {
    try {
      const url = new URL(`https://${host}/json`);
      if (ip) url.searchParams.set("ip", canonicalIP(ip));
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "IPinfo-desktop" },
        signal: AbortSignal.timeout(timeout * 1000), redirect: "error",
      });
      if (response.status !== 200) throw new Error(`The service returned HTTP ${response.status}.`);
      if (!response.body) throw new Error(invalidResponse);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 65536) { await response.body.cancel().catch(() => {}); throw new Error(invalidResponse); }
        chunks.push(Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || Array.isArray(data) || typeof data !== "object" || !canonicalIP(data.ip)
        || Object.hasOwn(data, "error") || Object.values(data).some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))
        || (ip && canonicalIP(data.ip) !== canonicalIP(ip))) throw new Error(invalidResponse);
      return { host, data };
    } catch (error) {
      const message = error.name === "TimeoutError" || error.name === "AbortError"
        ? "The request timed out. Refresh to try again."
        : error.message === invalidResponse || /^The service returned HTTP \d+\.$/.test(error.message)
          ? error.message : error instanceof SyntaxError ? invalidResponse
            : "Could not reach this service. Check your connection and refresh.";
      return { host, error: message };
    }
  })));
}

export function safe(value) { return String(value).replace(/[\p{Cc}\p{Cf}]/gu, " "); }
export function display(value) { return typeof value === "boolean" ? value ? "Yes" : "No" : safe(value); }
export function textOutput(report) {
  return report.visible.map(({ host, data, error }) => {
    if (!data) return `${host}\n  Error: ${safe(error)}`;
    const lines = [host, `  IP: ${safe(data.ip)}`];
    for (const [key, title] of [...fields, ["hostname", "Reverse DNS"]]) {
      if (data[key] !== undefined && data[key] !== null && data[key] !== "") lines.push(`  ${title}: ${display(data[key])}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}
export function jsonOutput(report) {
  return JSON.stringify(Object.fromEntries(report.visible.map(({ host, data, error }) => [host, data ?? { error }])), null, 2);
}
