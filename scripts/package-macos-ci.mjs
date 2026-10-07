import { execFileSync } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const keys = ['MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD', 'MACOS_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const configured = keys.filter(key => process.env[key]);
if (configured.length === 0) {
  console.log('Apple signing credentials are not configured; building an ad-hoc-signed release.');
  await import('./package-macos.mjs');
} else {
  if (configured.length !== keys.length) throw new Error('All six signing and notarization secrets must be configured together.');
  if (!process.env.MACOS_SIGNING_IDENTITY.startsWith('Developer ID Application:')) {
    throw new Error('Use a Developer ID Application signing identity.');
  }
  // Never echo secret arguments or include execFileSync error objects in CI logs.
  const run = (command, args) => {
    try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error(`Apple credential setup failed in ${command}. Check the configured secrets.`); }
  };
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary) throw new Error('This credential setup is intended for an ephemeral GitHub macOS runner.');
  const keychain = join(temporary, 'ipinfo-signing.keychain-db');
  const certificate = join(temporary, 'ipinfo-signing.p12');
  const password = randomBytes(32).toString('hex');
  const previous = run('security', ['list-keychains', '-d', 'user']).match(/"([^"]+)"/g)?.map(value => value.slice(1, -1)) || [];
  let created = false;
  try {
    await writeFile(certificate, Buffer.from(process.env.MACOS_CERTIFICATE_P12_BASE64, 'base64'), { mode: 0o600 });
    run('security', ['create-keychain', '-p', password, keychain]);
    created = true;
    run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    run('security', ['unlock-keychain', '-p', password, keychain]);
    run('security', ['import', certificate, '-P', process.env.MACOS_CERTIFICATE_PASSWORD, '-t', 'cert', '-f', 'pkcs12', '-k', keychain, '-T', '/usr/bin/codesign']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...previous]);
    run('xcrun', ['notarytool', 'store-credentials', 'ipinfo-notary', '--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD, '--keychain', keychain]);
    process.env.MACOS_NOTARY_PROFILE = 'ipinfo-notary';
    process.env.MACOS_NOTARY_KEYCHAIN = keychain;
    await import('./package-macos.mjs');
  } finally {
    run('security', ['list-keychains', '-d', 'user', '-s', ...previous]);
    if (created) run('security', ['delete-keychain', keychain]);
    await rm(certificate, { force: true });
  }
}
