import { readFile, writeFile, mkdir, rm, cp, chmod, readdir, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { packager } from "@electron/packager";
import { inject } from "postject";
import { create as createTar, extract } from "tar";
import { ZipFile } from "yazl";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { Resvg } from "@resvg/resvg-js";

export const nodeVersion = "24.21.0";
export const electronVersion = "44.6.0";
const root = resolve(".");
const target = process.argv[2] || `${process.platform}-${process.arch}`;
if (!/^(linux|win32|darwin)-(x64|arm64)$/.test(target)) throw new Error("Target must be linux-x64, linux-arm64, win32-x64, or win32-arm64.");
const [platform, arch] = target.split("-");
const osName = platform === "win32" ? "windows" : platform === "darwin" ? "macos-test" : "linux";
const cpuName = arch === "x64" ? "amd64" : arch;
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const output = resolve("dist/desktop", `${osName}-${cpuName}`);
const work = join(output, "build");
const cache = resolve("dist/desktop/.cache");
await mkdir(cache, { recursive: true });
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

async function downloadNode(relative) {
  const path = join(cache, `node-${nodeVersion}-${relative.replaceAll("/", "-")}`);
  const base = `https://nodejs.org/dist/v${nodeVersion}/`;
  const manifest = await fetch(`${base}SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
  if (!manifest.ok) throw new Error("Could not download Node.js checksums.");
  const entry = (await manifest.text()).split("\n").find((line) => line.endsWith(`  ${relative}`));
  if (!entry) throw new Error(`No checksum for ${relative}`);
  const expected = entry.split(/\s+/)[0];
  let contents;
  try { contents = await readFile(path); } catch { /* Download uncached runtime below. */ }
  if (!contents || createHash("sha256").update(contents).digest("hex") !== expected) {
    console.log(`Downloading Node.js ${nodeVersion}: ${relative}`);
    const response = await fetch(base + relative, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Could not download ${relative}`);
    contents = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(contents).digest("hex") !== expected) throw new Error("Node.js checksum mismatch.");
    await writeFile(path, contents);
  }
  return path;
}
async function nodeBinary(os, architecture) {
  if (os === "win32") return downloadNode(`win-${architecture}/node.exe`);
  const filename = `node-v${nodeVersion}-${os}-${architecture}.tar.gz`;
  const archive = await downloadNode(filename);
  const directory = join(cache, `runtime-${os}-${architecture}`);
  await mkdir(directory, { recursive: true });
  await extract({ file: archive, cwd: directory });
  return join(directory, `node-v${nodeVersion}-${os}-${architecture}`, "bin", "node");
}
const hostNode = await nodeBinary(process.platform, process.arch);
const runtime = await nodeBinary(platform, arch);
const command = join(work, "command.cjs");
await build({ entryPoints: ["desktop/command.mjs"], outfile: command, bundle: true, platform: "node", format: "cjs", target: "node24", define: { IPINFO_VERSION: JSON.stringify(version) } });
const blob = join(work, "sea.blob");
const seaConfig = join(work, "sea.json");
await writeFile(seaConfig, JSON.stringify({ main: command, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, execArgvExtension: "none" }));
run(hostNode, ["--experimental-sea-config", seaConfig]);
const cliName = platform === "win32" ? "ipinfo.exe" : "ipinfo";
const cli = join(work, cliName);
await cp(runtime, cli);
if (platform === "darwin") run("codesign", ["--remove-signature", cli]);
await inject(cli, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (platform !== "win32") await chmod(cli, 0o755);
if (platform === "win32") {
  // Injection invalidates Node's upstream signature. Remove its PE security
  // directory so this executable is correctly identified as unsigned.
  const binary = await readFile(cli);
  const optional = binary.readUInt32LE(0x3c) + 24;
  const directories = optional + (binary.readUInt16LE(optional) === 0x20b ? 112 : 96);
  binary.fill(0, directories + 32, directories + 40);
  await writeFile(cli, binary);
}
if (platform === "darwin") run("codesign", ["--sign", "-", cli]);

const appSource = join(work, "app");
await mkdir(appSource, { recursive: true });
await writeFile(join(appSource, "package.json"), JSON.stringify({ name: "ipinfo-desktop", productName: "IPinfo", version, main: "main.mjs", type: "module" }));
for (const file of ["main.mjs", "diagnostics.mjs", "settings.mjs", "preload.cjs", "index.html"]) await cp(join("desktop", file), join(appSource, file));
await build({ entryPoints: ["desktop/renderer.mjs"], outfile: join(appSource, "renderer.js"), bundle: true, platform: "browser", target: "chrome144" });
const css = await postcss([tailwindcss({ optimize: true })]).process(await readFile("desktop/styles.css", "utf8"), { from: resolve("desktop/styles.css") });
await writeFile(join(appSource, "styles.css"), css.css);
const png = new Resvg(await readFile("public/brand/ipinfo.svg", "utf8"), { fitTo: { mode: "width", value: 256 } }).render().asPng();
await writeFile(join(appSource, "icon.png"), png);
// Windows ICO supports a PNG payload; avoid platform-specific icon tools.
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14); icoHeader.writeUInt32LE(22, 18);
const icon = join(work, "icon.ico");
await writeFile(icon, Buffer.concat([icoHeader, png]));
console.log(`Packaging Electron ${electronVersion}: ${target}`);
const [gui] = await packager({ dir: appSource, out: join(work, "runtime"), name: "IPinfo", executableName: "IPinfo-GUI", platform, arch, electronVersion,
  overwrite: true, asar: true, prune: false, ...(platform === "win32" ? { icon, win32metadata: { CompanyName: "bea.sh", FileDescription: "IPinfo network diagnostics", ProductName: "IPinfo" } } : {}),
});
const folderName = `IPinfo-${version}-${osName}-${cpuName}`;
const distribution = join(output, folderName);
await rm(distribution, { recursive: true, force: true });
await cp(gui, distribution, { recursive: true, dereference: false, verbatimSymlinks: true });
await chmod(distribution, 0o755);
await cp(cli, join(distribution, cliName));
await cp("THIRD_PARTY_NOTICES.md", join(distribution, "THIRD_PARTY_NOTICES.md"));
await writeFile(join(distribution, "LICENSE.ui.txt"), (await Promise.all(["daisyui", "tailwindcss"].map(async (name) => `${name}\n\n${await readFile(join(root, "node_modules", name, "LICENSE"), "utf8")}`))).join("\n\n"));
await cp("public/brand/ipinfo.svg", join(distribution, "ipinfo.svg"));
// Retain the complete runtime licenses for the injected Node.js executable.
const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`, { signal: AbortSignal.timeout(30000) });
if (!nodeLicense.ok) throw new Error("Could not download Node.js license.");
await writeFile(join(distribution, "LICENSE.node.txt"), await nodeLicense.text());
if (platform === "linux") { await cp("packaging/install-linux.sh", join(distribution, "install.sh")); await chmod(join(distribution, "install.sh"), 0o755); }
if (platform === "win32") await cp("packaging/install-windows.ps1", join(distribution, "install.ps1"));
await writeFile(join(distribution, "README.txt"), `IPinfo ${version} — ${osName} ${cpuName}\n\nThis download includes both interfaces. No Node.js installation is needed.\nCLI: ${platform === "win32" ? ".\\ipinfo.exe" : "./ipinfo"} [--json] [IP_ADDRESS]\nGUI: ${platform === "win32" ? "IPinfo-GUI.exe" : "./IPinfo-GUI"}\n\nDefault source: Auto (both services concurrently). Timeout: 5 seconds per service.\n  ipinfo config --source ip.bea.sh\n  ipinfo config --source ip.behnam.pro\n  ipinfo config --source auto --timeout 5\nSettings are shared with the GUI. --source and --timeout without config override only one lookup.\n\n${platform === "linux" ? "Optional user installation: ./install.sh\nCLI works on servers without a desktop or graphical libraries.\nGUI requires a graphical session, desktop libraries, and Chromium sandbox support.\nUse a current glibc-based distribution (Ubuntu 22.04+ recommended); Alpine/musl is unsupported.\n" : platform === "win32" ? "Optional user installation: run install.ps1 in PowerShell.\nRestart your terminal after installation. Windows 10 or newer is required.\n" : "Local macOS test package; macOS releases use the native Swift app.\n"}`);

async function zipDirectory(directory, destination) {
  const zip = new ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(destination));
  async function add(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const filename = join(path, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await add(filename, `${name}/`);
      else zip.addFile(filename, name, { mode: (await stat(filename)).mode });
    }
  }
  await add(directory, `${folderName}/`); zip.end(); await writing;
}
const archiveName = folderName + (platform === "win32" ? ".zip" : ".tar.gz");
const archive = join(output, archiveName);
if (platform === "win32") await zipDirectory(distribution, archive);
else await createTar({ gzip: true, file: archive, cwd: output }, [folderName]);
const digest = createHash("sha256");
for await (const chunk of createReadStream(archive)) digest.update(chunk);
await writeFile(join(output, `SHA256SUMS-${osName}-${cpuName}`), `${digest.digest("hex")}  ${archiveName}\n`);
console.log(`Packaged ${archive}`);
if (process.platform === platform && process.arch === arch) {
  run(join(distribution, cliName), ["--version"]);
  run(join(distribution, cliName), ["--help"]);
}
