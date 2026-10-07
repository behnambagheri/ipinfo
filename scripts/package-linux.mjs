import { readFile, writeFile, mkdir, readdir, lstat, readlink, chmod, rename, access, mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extract } from "tar";
import { addArchOptionalDependencies } from "./arch-package-metadata.mjs";

// nFPM creates all three formats without requiring a native build host.
const nfpmVersion = "2.47.0";
const tools = {
  "darwin-arm64": ["Darwin_arm64", "e8c9d1d9ac218eeed479375143dc46b8d51a2b8dbba8e2f9f15ecc8faa2e404b"],
  "linux-arm64": ["Linux_arm64", "1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c"],
  "linux-x64": ["Linux_x86_64", "0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783"],
};
const target = process.argv[2];
if (!/^linux-(x64|arm64)$/.test(target || "")) throw new Error("Pass linux-x64 or linux-arm64; build package:desktop first.");
const cpu = target.endsWith("x64") ? "amd64" : "arm64";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const output = resolve("dist/desktop", `linux-${cpu}`);
const distribution = join(output, `IPinfo-${version}-linux-${cpu}`);
await lstat(join(distribution, "ipinfo"));
const host = tools[`${process.platform}-${process.arch}`];
if (!host) throw new Error("Build Linux packages on Linux AMD64/ARM64 or macOS ARM64.");
const cache = resolve("dist/desktop/.cache", `nfpm-${nfpmVersion}`);
await mkdir(cache, { recursive: true });
const filename = `nfpm_${nfpmVersion}_${host[0]}.tar.gz`;
const archive = join(cache, filename);
let data;
try { data = await readFile(archive); } catch { /* Download the pinned build tool below. */ }
if (!data || createHash("sha256").update(data).digest("hex") !== host[1]) {
  const response = await fetch(`https://github.com/goreleaser/nfpm/releases/download/v${nfpmVersion}/${filename}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Could not download ${filename}`);
  data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== host[1]) throw new Error("nFPM checksum mismatch.");
  await writeFile(archive, data);
}
const installation = join(cache, host[0]);
const nfpm = join(installation, "nfpm");
try { await access(nfpm); } catch {
  // Never overwrite a running build tool. Atomic installation also permits
  // concurrent architecture builds to share this download safely.
  const temporary = await mkdtemp(join(cache, "extract-"));
  await extract({ file: archive, cwd: temporary });
  await chmod(join(temporary, "nfpm"), 0o755);
  try { await rename(temporary, installation); } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await access(nfpm).catch(() => { throw error; });
  }
}

const contents = [];
async function addTree(path, destination) {
  contents.push({ dst: destination, type: "dir", file_info: { mode: 0o755 } });
  for (const entry of await readdir(path, { withFileTypes: true })) {
    // The user installer and archive-specific instructions do not belong in a system package.
    if (destination === "/opt/bea-ipinfo" && ["install.sh", "README.txt"].includes(entry.name)) continue;
    const src = join(path, entry.name);
    const dst = `${destination}/${entry.name}`;
    if (entry.isDirectory()) await addTree(src, dst);
    else if (entry.isSymbolicLink()) contents.push({ src: await readlink(src), dst, type: "symlink" });
    else contents.push({ src, dst, file_info: { mode: entry.name === "chrome-sandbox" ? 0o4755 : (await lstat(src)).mode & 0o777, owner: "root", group: "root" } });
  }
}
await addTree(distribution, "/opt/bea-ipinfo");
contents.push(
  { src: "/opt/bea-ipinfo/ipinfo", dst: "/usr/bin/ipinfo", type: "symlink" },
  { src: "/opt/bea-ipinfo/IPinfo-GUI", dst: "/usr/bin/ipinfo-gui", type: "symlink" },
  { src: resolve("packaging/ipinfo.desktop"), dst: "/usr/share/applications/bea-ipinfo.desktop", file_info: { mode: 0o644 } },
  { src: resolve("public/brand/ipinfo.svg"), dst: "/usr/share/icons/hicolor/scalable/apps/bea-ipinfo.svg", file_info: { mode: 0o644 } },
);
const config = {
  name: "bea-ipinfo", arch: cpu, platform: "linux", version, release: "1", section: "net", priority: "optional",
  maintainer: "Behnam Bagheri <behnambagheri@users.noreply.github.com>", vendor: "bea.sh",
  homepage: "https://github.com/behnambagheri/ipinfo",
  // The project has no declared project-wide license; do not invent an open-source license.
  license: "Unknown",
  description: "IP and network diagnostics with a graphical app and standalone CLI.\nQueries ip.bea.sh and ip.behnam.pro with shared source and timeout settings.",
  contents,
  overrides: {
    deb: { depends: ["libc6 (>= 2.28)", "libstdc++6", "ca-certificates"], recommends: ["libgtk-3-0", "libnss3", "libasound2 | libasound2t64", "libgbm1", "libxss1", "libxtst6", "libx11-xcb1", "libdrm2"] },
    rpm: { depends: ["glibc >= 2.28", "libstdc++", "ca-certificates"], recommends: ["gtk3", "nss", "alsa-lib", "mesa-libgbm", "libXScrnSaver", "libXtst", "libX11", "libdrm"] },
    archlinux: { depends: ["glibc", "gcc-libs", "ca-certificates"] },
  },
  deb: { compression: "gzip" }, rpm: { compression: "gzip", buildhost: "ipinfo-build" },
  archlinux: { packager: "Behnam Bagheri <behnambagheri@users.noreply.github.com>" },
};
const configuration = join(output, "build", "nfpm.json");
await writeFile(configuration, JSON.stringify(config, null, 2));
const packages = [
  ["deb", `bea-ipinfo_${version}-1_${cpu}.deb`],
  ["rpm", `bea-ipinfo-${version}-1.${cpu === "amd64" ? "x86_64" : "aarch64"}.rpm`],
  ["archlinux", `bea-ipinfo-${version}-1-${cpu === "amd64" ? "x86_64" : "aarch64"}.pkg.tar.zst`],
];
const sums = [];
for (const [format, name] of packages) {
  const destination = join(output, name);
  const temporary = `${destination}.tmp`;
  execFileSync(nfpm, ["package", "--config", configuration, "--packager", format, "--target", temporary], { stdio: "inherit" });
  if (format === "archlinux") await addArchOptionalDependencies(temporary,
    ["gtk3: graphical interface", "nss: graphical interface", "alsa-lib: graphical interface", "mesa: graphical interface", "libxss: graphical interface", "libxtst: graphical interface", "libx11: graphical interface"]);
  await rename(temporary, destination);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  sums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(join(output, `SHA256SUMS-packages-linux-${cpu}`), `${sums.join("\n")}\n`);
console.log(`Built Debian, RPM, and Arch packages for ${cpu}.`);
