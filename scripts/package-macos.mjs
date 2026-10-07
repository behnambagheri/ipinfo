import { readFile, writeFile, mkdir, rm, cp, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

if (process.platform !== 'darwin') throw new Error('The macOS app must be built on macOS.');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a numeric semantic version for the macOS release.');
const output = resolve('dist/macos');
const app = join(output, 'IPinfo.app');
const build = join(output, 'build');
await rm(app, { recursive: true, force: true });
await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
await mkdir(join(app, 'Contents/Resources'), { recursive: true });
await mkdir(join(app, 'Contents/Helpers'), { recursive: true });
await mkdir(build, { recursive: true });
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
const swift = ['-O', '-sdk', sdk, '-module-cache-path', join(build, 'module-cache')];
await writeFile(join(build, 'Version.swift'), `enum IPinfoVersion { static let value = ${JSON.stringify(version)} }\n`);
run('swiftc', [...swift, 'macos/Settings.swift', 'macos/Diagnostics.swift', 'macos/CLI.swift', 'tests/macos/DiagnosticsTests.swift', '-o', join(build, 'tests')]);
run(join(build, 'tests'), []);
for (const arch of ['arm64', 'x86_64']) {
  run('swiftc', [...swift, '-target', `${arch}-apple-macos13.0`, 'macos/Settings.swift', 'macos/Diagnostics.swift', 'macos/CLI.swift', 'macos/App.swift', '-o', join(build, `IPinfo-${arch}`)]);
  run('swiftc', [...swift, '-target', `${arch}-apple-macos13.0`, 'macos/Settings.swift', 'macos/Diagnostics.swift', 'macos/CLI.swift', 'macos/Command.swift', join(build, 'Version.swift'), '-o', join(build, `ipinfo-${arch}`)]);
}
run('lipo', ['-create', join(build, 'IPinfo-arm64'), join(build, 'IPinfo-x86_64'), '-output', join(app, 'Contents/MacOS/IPinfo')]);
run('lipo', ['-create', join(build, 'ipinfo-arm64'), join(build, 'ipinfo-x86_64'), '-output', join(app, 'Contents/Helpers/ipinfo')]);
run(join(app, 'Contents/Helpers/ipinfo'), ['--version']);
run(join(app, 'Contents/Helpers/ipinfo'), ['--help']);
await writeFile(join(app, 'Contents/Info.plist'), (await readFile('macos/Info.plist', 'utf8')).replaceAll('__VERSION__', version));
await writeFile(join(app, 'Contents/Resources/THIRD_PARTY_NOTICES.md'), await readFile('THIRD_PARTY_NOTICES.md'));

const iconset = join(build, 'IPinfo.iconset');
await mkdir(iconset, { recursive: true });
const logo = await readFile('public/brand/ipinfo.svg', 'utf8');
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const png = new Resvg(logo, { fitTo: { mode: 'width', value: size * scale } }).render().asPng();
    await writeFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), png);
  }
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(app, 'Contents/Resources/IPinfo.icns')]);
// A Developer ID identity may be supplied in a properly configured signing environment.
// Ad-hoc signing preserves bundle integrity but does not provide Gatekeeper approval.
const identity = process.env.MACOS_SIGNING_IDENTITY || '-';
const profile = process.env.MACOS_NOTARY_PROFILE;
const notaryKeychain = process.env.MACOS_NOTARY_KEYCHAIN ? ['--keychain', process.env.MACOS_NOTARY_KEYCHAIN] : [];
if (profile && identity === '-') throw new Error('Notarization requires a Developer ID Application identity.');
const sign = file => run('codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']), file]);
sign(join(app, 'Contents/Helpers/ipinfo'));
sign(app);
run('codesign', ['--verify', '--deep', '--strict', app]);
if (profile) {
  const submission = join(build, 'notarization.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, submission]);
  run('xcrun', ['notarytool', 'submit', submission, '--keychain-profile', profile, ...notaryKeychain, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose', app]);
}
const filename = `IPinfo-${version}-universal.zip`;
const archive = join(output, filename);
await rm(archive, { force: true });
run('ditto', ['-c', '-k', '--keepParent', app, archive]);
const dmgName = `IPinfo-${version}-universal.dmg`;
const dmg = join(output, dmgName);
const diskContents = join(build, 'disk');
await rm(diskContents, { recursive: true, force: true });
await mkdir(diskContents, { recursive: true });
await cp(app, join(diskContents, 'IPinfo.app'), { recursive: true });
await symlink('/Applications', join(diskContents, 'Applications'));
await writeFile(join(diskContents, 'README.txt'), `IPinfo ${version}\n\nDrag IPinfo.app to Applications.\nHomebrew also installs the terminal command:\n  brew install --cask behnambagheri/tap/ipinfo\n\nFor a manual install, run:\n  /Applications/IPinfo.app/Contents/Helpers/ipinfo\n  /Applications/IPinfo.app/Contents/Helpers/ipinfo 1.2.3.4\n\n${profile ? 'Developer ID signed and Apple-notarized.' : `${identity === '-' ? 'Ad-hoc' : 'Developer ID'} signed; not Apple-notarized. First launch may require approval in System Settings > Privacy & Security > Open Anyway.\n\nIf macOS blocks the app and you trust this download, you can remove its\ndownload quarantine attribute in Terminal after installing it:\n  sudo /usr/bin/xattr -r -d com.apple.quarantine "/Applications/IPinfo.app"\n  open "/Applications/IPinfo.app"\nAdjust the app path if you installed it elsewhere.`}\n`);
await rm(dmg, { force: true });
run('hdiutil', ['create', '-volname', `IPinfo ${version}`, '-srcfolder', diskContents, '-format', 'UDZO', '-ov', dmg]);
if (identity !== '-') sign(dmg);
if (profile) {
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, ...notaryKeychain, '--wait']);
  run('xcrun', ['stapler', 'staple', dmg]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', dmg]);
}
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const digest = await hash(archive);
await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${filename}\n${await hash(dmg)}  ${dmgName}\n`);
await writeFile(join(output, 'distribution-status.json'), JSON.stringify({ version, developer_id_signed: identity !== '-', notarized: Boolean(profile) }, null, 2) + '\n');
const template = await readFile('packaging/ipinfo.rb.in', 'utf8');
const caveats = profile ? '' : `  caveats <<~EOS\n    This release is ${identity === '-' ? 'ad-hoc' : 'Developer ID'} signed and is not Apple-notarized.\n    macOS may require approval in System Settings > Privacy & Security\n    > Open Anyway before its first launch.\n\n    If macOS blocks the app and you trust this download, you can remove its\n    download quarantine attribute in Terminal:\n      sudo /usr/bin/xattr -r -d com.apple.quarantine "#{appdir}/IPinfo.app"\n      open "#{appdir}/IPinfo.app"\n  EOS`;
await writeFile(join(output, 'ipinfo.rb'), template.replaceAll('__VERSION__', version).replaceAll('__SHA256__', digest).replaceAll('__CAVEATS__', caveats).replace(/\n\nend\n$/, '\nend\n'));
console.log(`Packaged ${archive}\nSHA-256: ${digest}\nGenerated ${join(output, 'ipinfo.rb')}`);
