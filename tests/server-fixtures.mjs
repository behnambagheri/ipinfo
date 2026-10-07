import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Reader } from 'mmdb-lib';
import { names, sha256 } from '../server/databases.mjs';

// Rebuild fixture metadata only. Search trees and records remain MaxMind's real fixtures.
function encode(value) {
  if (typeof value === 'string') {
    const data = Buffer.from(value);
    if (data.length > 28) throw new Error('Test string too long');
    return Buffer.concat([Buffer.from([64 + data.length]), data]);
  }
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value);
    return Buffer.concat([Buffer.from([196]), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([value.length, 4]), ...value.map(encode)]);
  return Buffer.concat([Buffer.from([224 + Object.keys(value).length]), ...Object.entries(value).flatMap(([key, item]) => [encode(key), encode(item)])]);
}
export async function fixtureBytes(name, epoch) {
  const file = name === 'ASN' ? 'GeoLite2-ASN-Test' : `GeoIP2-${name}-Test`;
  const bytes = await readFile(new URL(`./fixtures/${file}.mmdb`, import.meta.url));
  const metadata = new Reader(bytes).metadata;
  const marker = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);
  const end = bytes.lastIndexOf(marker) + marker.length;
  const rebuilt = encode({ node_count: metadata.nodeCount, record_size: metadata.recordSize, ip_version: metadata.ipVersion,
    database_type: `GeoLite2-${name}`, languages: ['en'], binary_format_major_version: 2, binary_format_minor_version: 0,
    build_epoch: epoch ?? Math.floor(metadata.buildEpoch.getTime() / 1000), description: { en: 'IPinfo test database' } });
  return Buffer.concat([bytes.subarray(0, end), rebuilt]);
}
export async function writeFixtures(directory, epoch) {
  await mkdir(directory, { recursive: true });
  const paths = {};
  const checksums = {};
  for (const name of names) {
    const bytes = await fixtureBytes(name, epoch);
    paths[name] = join(directory, `GeoLite2-${name}.mmdb`);
    await writeFile(paths[name], bytes);
    checksums[name] = sha256(bytes);
  }
  return { paths, checksums };
}
