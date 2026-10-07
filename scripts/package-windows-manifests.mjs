import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`Missing value for ${name}`);
  return resolve(args[index + 1]);
}
const assets = option("--assets", null);
const output = option("--output", resolve("dist/package-managers"));
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const identifier = "BehnamBagheri.IPinfo";
const url = `https://github.com/behnambagheri/ipinfo/releases/download/v${version}/`;
const installers = [];
const architecture = {};
for (const [cpu, winget, scoop] of [["amd64", "x64", "64bit"], ["arm64", "arm64", "arm64"]]) {
  const folder = `IPinfo-${version}-windows-${cpu}`;
  const name = `${folder}.zip`;
  const file = assets ? join(assets, name) : resolve("dist/desktop", `windows-${cpu}`, name);
  await access(file);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const hash = digest.digest("hex");
  architecture[scoop] = { url: url + name, hash, extract_dir: folder };
  installers.push(`- Architecture: ${winget}\n  InstallerUrl: ${url}${name}\n  InstallerSha256: ${hash.toUpperCase()}\n  NestedInstallerFiles:\n  - RelativeFilePath: ${folder}/ipinfo.exe\n    PortableCommandAlias: ipinfo\n  - RelativeFilePath: ${folder}/IPinfo-GUI.exe\n    PortableCommandAlias: ipinfo-gui`);
}
const wingetDirectory = join(output, "winget", "manifests", "b", "BehnamBagheri", "IPinfo", version);
await mkdir(wingetDirectory, { recursive: true });
const header = `PackageIdentifier: ${identifier}\nPackageVersion: ${version}\n`;
await writeFile(join(wingetDirectory, `${identifier}.yaml`), `${header}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.9.0\n`);
await writeFile(join(wingetDirectory, `${identifier}.installer.yaml`), `${header}InstallerType: zip\nNestedInstallerType: portable\nScope: user\nMinimumOSVersion: 10.0.19041.0\nUpgradeBehavior: uninstallPrevious\nCommands:\n- ipinfo\n- ipinfo-gui\nInstallers:\n${installers.join("\n")}\nManifestType: installer\nManifestVersion: 1.9.0\n`);
await writeFile(join(wingetDirectory, `${identifier}.locale.en-US.yaml`), `${header}PackageLocale: en-US\nPublisher: Behnam Bagheri\nPublisherUrl: https://github.com/behnambagheri\nPackageName: IPinfo\nPackageUrl: https://github.com/behnambagheri/ipinfo\nLicense: Unknown\nShortDescription: IP and network diagnostics with a graphical app and standalone CLI.\nMoniker: bea-ipinfo\nTags:\n- ip\n- network\n- diagnostics\nManifestType: defaultLocale\nManifestVersion: 1.9.0\n`);
await writeFile(join(output, "ipinfo.json"), JSON.stringify({
  version, description: "IP and network diagnostics with a graphical app and standalone CLI.",
  homepage: "https://github.com/behnambagheri/ipinfo", license: "Unknown", architecture,
  bin: ["ipinfo.exe", ["IPinfo-GUI.exe", "ipinfo-gui"]], shortcuts: [["IPinfo-GUI.exe", "IPinfo"]],
  notes: "GUI and CLI share settings in %APPDATA%\\IPinfo. Settings are retained when upgrading or uninstalling.",
}, null, 2) + "\n");
console.log(`Generated WinGet manifests and Scoop manifest for ${version}, using the actual Windows ZIP checksums.`);
