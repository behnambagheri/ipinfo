import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalIP, compare, check, hosts, textOutput } from "../desktop/diagnostics.mjs";
import { parseOptions, runCLI } from "../desktop/cli.mjs";
import { defaults, loadSettings, saveSettings } from "../desktop/settings.mjs";

const data = { ip: "1.2.3.4", country: "Australia", country_iso: "AU", asn: 13335, country_ir: false };
const results = (other = data) => [{ host: hosts[0], data }, { host: hosts[1], data: other }];
test("desktop comparison follows the macOS equality contract", () => {
  assert.equal(compare(results({ ...data, source: "different", user_agent: "other", hostname: "container", decimalIP: 1 })).identical, true);
  assert.equal(compare(results({ ...data, city: "Sydney" })).visible.length, 2);
  assert.equal(compare(results({ ...data, city: "" })).visible.length, 1);
  assert.equal(compare(results({ ...data, asn: "13335" })).identical, false);
  assert.equal(compare([{ host: hosts[0], error: "Unavailable" }, { host: hosts[1], error: "Unavailable" }]).identical, false);
  assert.equal(compare([{ host: hosts[1], data }]).visible[0].host, hosts[1]);
  assert.equal(compare([{ host: hosts[1], data }]).message, "Using ip.behnam.pro.");
  assert.equal(canonicalIP("2606:4700:4700:0:0:0:0:1111"), canonicalIP("2606:4700:4700::1111"));
  for (const invalid of ["1.2.3", "01.2.3.4", "https://ip.bea.sh", "fe80::1%en0", "1.2.3.4\n"]) assert.equal(canonicalIP(invalid), null);
});
test("desktop transport queries both hosts concurrently and validates explicit IP responses", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.redirect, "error");
    if (calls.length === 2) release();
    await gate;
    return Response.json(data);
  };
  assert.equal((await check("1.2.3.4", { fetchImpl })).visible.length, 1);
  assert.deepEqual(calls.map((url) => [url.host, url.searchParams.get("ip")]), hosts.map((host) => [host, "1.2.3.4"]));
  const wrongIP = await check("8.8.8.8", { fetchImpl: async () => Response.json(data) });
  assert.equal(wrongIP.exitCode, 1);
});
test("single-source selection never contacts the other endpoint", async () => {
  for (const source of hosts) {
    const calls = [];
    const report = await check(undefined, { source, fetchImpl: async (url) => { calls.push(url.host); return Response.json(data); } });
    assert.deepEqual(calls, [source]); assert.equal(report.visible.length, 1); assert.equal(report.exitCode, 0);
  }
});
test("an unavailable endpoint times out without losing the working result", async () => {
  const started = Date.now();
  const report = await check(undefined, { timeout: 1, fetchImpl: async (url, { signal }) => {
    if (url.host === hosts[0]) return Response.json(data);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  assert.ok(Date.now() - started < 2000);
  assert.equal(report.visible[0].data.ip, data.ip);
  assert.match(report.visible[1].error, /timed out/); assert.equal(report.exitCode, 1);
});
test("malformed, oversized and failed responses are never considered matches", async () => {
  for (const response of [() => new Response("broken"), () => Response.json({ ip: "invalid" }), () => Response.json({ ...data, error: "No" }),
    () => Response.json({ ...data, nested: [] }), () => new Response("x".repeat(65537)), () => new Response("", { status: 503 })]) {
    const report = await check(undefined, { fetchImpl: async () => response() });
    assert.equal(report.exitCode, 1); assert.equal(report.identical, false);
  }
  assert.doesNotMatch(textOutput(compare(results({ ...data, country: "\x1b[31mFake\x00" }))), /[\x00\x1b]/);
});
test("CLI validates options before any lookup and handles JSON, help and source overrides", async () => {
  for (const args of [["--source", "bad"], ["--timeout", "0"], ["--timeout", "31"], ["--timeout", "1.5"], ["--source"], ["--bad"], ["1.2.3.4", "8.8.8.8"], ["config", "1.2.3.4"]]) assert.throws(() => parseOptions(args));
  assert.equal(parseOptions(["--source", hosts[1], "--timeout", "3"]).source, hosts[1]);
  let invoked = false; const output = [];
  const dependencies = { version: "test", stdout: (value) => output.push(value), stderr: (value) => output.push(value), readSettings: async () => defaults,
    lookup: async (ip, settings) => { invoked = true; assert.equal(ip, "1.2.3.4"); assert.equal(settings.source, hosts[1]); return compare(results()); } };
  assert.equal(await runCLI(["bad"], dependencies), 2); assert.equal(invoked, false);
  assert.equal(await runCLI(["--help"], dependencies), 0); assert.equal(invoked, false);
  assert.equal(await runCLI(["--json", "--source", hosts[1], "1.2.3.4"], dependencies), 0);
  assert.deepEqual(Object.keys(JSON.parse(output.at(-1))), [hosts[0]]);
});
test("GUI and CLI settings persist only the validated source and timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ipinfo-settings-")); const path = join(directory, "settings.json");
  try {
    assert.deepEqual(await loadSettings(path), defaults);
    let lookedUp = false;
    assert.equal(await runCLI(["config", "--source", hosts[1], "--timeout", "2"], {
      version: "test", readSettings: () => loadSettings(path), writeSettings: (value) => saveSettings(value, path), stdout: () => {},
      lookup: () => { lookedUp = true; },
    }), 0);
    assert.equal(lookedUp, false);
    assert.deepEqual(await loadSettings(path), { source: hosts[1], timeout: 2 });
    assert.deepEqual(JSON.parse(await readFile(path)), { source: hosts[1], timeout: 2 });
    await assert.rejects(saveSettings({ source: "unknown", timeout: 5 }, path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
