import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
await mkdir(build, { recursive: true });
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
const swift = ['-O', '-sdk', sdk, '-module-cache-path', join(build, 'module-cache')];
run('swiftc', [...swift, 'macos/Diagnostics.swift', 'tests/macos/DiagnosticsTests.swift', '-o', join(build, 'tests')]);
run(join(build, 'tests'), []);
for (const arch of ['arm64', 'x86_64']) {
  run('swiftc', [...swift, '-target', `${arch}-apple-macos13.0`, 'macos/Diagnostics.swift', 'macos/App.swift', '-o', join(build, `IPinfo-${arch}`)]);
}
run('lipo', ['-create', join(build, 'IPinfo-arm64'), join(build, 'IPinfo-x86_64'), '-output', join(app, 'Contents/MacOS/IPinfo')]);
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
run('codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']), app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
if (process.env.MACOS_NOTARY_PROFILE) {
  const submission = join(build, 'notarization.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, submission]);
  run('xcrun', ['notarytool', 'submit', submission, '--keychain-profile', process.env.MACOS_NOTARY_PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
}
const filename = `IPinfo-${version}-universal.zip`;
const archive = join(output, filename);
await rm(archive, { force: true });
run('ditto', ['-c', '-k', '--keepParent', app, archive]);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(join(output, 'SHA256SUMS'), `${digest}  ${filename}\n`);
const template = await readFile('packaging/ipinfo.rb.in', 'utf8');
await writeFile(join(output, 'ipinfo.rb'), template.replaceAll('__VERSION__', version).replaceAll('__SHA256__', digest));
console.log(`Packaged ${archive}\nSHA-256: ${digest}\nGenerated ${join(output, 'ipinfo.rb')}`);
