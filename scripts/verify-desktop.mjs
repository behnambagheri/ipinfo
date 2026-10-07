import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos-test" : "linux";
const cpu = process.arch === "x64" ? "amd64" : process.arch;
const { version } = JSON.parse(readFileSync("package.json"));
const folder = resolve("dist/desktop", `${osName}-${cpu}`, `IPinfo-${version}-${osName}-${cpu}`);
const cli = join(folder, process.platform === "win32" ? "ipinfo.exe" : "ipinfo");
const home = mkdtempSync(join(tmpdir(), "ipinfo-package-test-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home };
const execute = (args) => spawnSync(cli, args, { env, encoding: "utf8", timeout: 15000 });
try {
  assert.equal(execute(["--version"]).status, 0);
  assert.match(execute(["--help"]).stdout, /--source/);
  assert.equal(execute(["invalid"]).status, 2);
  assert.equal(execute(["--timeout", "31"]).status, 2);
  assert.equal(execute(["config", "--source", "ip.behnam.pro", "--timeout", "1"]).status, 0);
  assert.deepEqual(JSON.parse(execute(["config"]).stdout), { source: "ip.behnam.pro", timeout: 1 });
  console.log("Standalone CLI smoke test passed.");
  const gui = process.platform === "win32" ? join(folder, "IPinfo-GUI.exe")
    : process.platform === "darwin" ? join(folder, "IPinfo.app/Contents/MacOS/IPinfo-GUI") : join(folder, "IPinfo-GUI");
  const log = join(home, "electron.log");
  try {
    execFileSync(gui, ["--smoke-test", "--enable-logging=file", `--log-file=${log}`,
      ...(["linux", "win32"].includes(process.platform) ? ["--disable-gpu"] : [])],
    { env, stdio: "inherit", timeout: 45000 });
  } catch (error) {
    try { console.error(readFileSync(log, "utf8").slice(-20000)); } catch { /* No Chromium log was created. */ }
    throw error;
  }
} finally { rmSync(home, { recursive: true, force: true }); }
