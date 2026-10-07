import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Reader } from 'mmdb-lib';
import { pathToFileURL } from 'node:url';
import { MMDBReader } from '../worker/mmdb.mjs';

const RELEASE_URL = 'https://api.github.com/repos/P3TERX/GeoLite.mmdb/releases/latest';
const names = ['ASN', 'City', 'Country'];
const output = 'dist/geolite2';
const assetDirectory = 'dist/geolite2-assets';
const chunkSize = 4 * 1024 * 1024;

export async function packageGeoLiteAssets(manifest) {
  manifest.chunkSize = chunkSize;
  await rm(assetDirectory, { recursive: true, force: true });
  for (const name of names) {
    const bytes = await readFile(`${output}/GeoLite2-${name}.mmdb`);
    const meta = manifest.databases[name];
    if (bytes.length !== meta.size || createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error(`Database changed before packaging: ${name}`);
    const parts = `${assetDirectory}/__geoip/${meta.key}.parts`;
    await mkdir(parts, { recursive: true });
    for (let offset = 0, part = 0; offset < bytes.length; offset += chunkSize, part++) {
      await writeFile(`${parts}/${part}.bin`, bytes.subarray(offset, offset + chunkSize));
    }
    // Index the first 16 bits for IPv4 and IPv6, avoiding large cold tree reads.
    const reader = new MMDBReader({}, meta);
    let ipv4Root = 0;
    if (meta.ipVersion === 6) for (let bit = 0; bit < 96 && ipv4Root < meta.nodeCount; bit++) ipv4Root = reader.child(bytes, ipv4Root, 0);
    const roots = meta.ipVersion === 6 ? [ipv4Root, 0] : [0];
    const index = Buffer.alloc(roots.length * 65536 * 4);
    for (let table = 0; table < roots.length; table++) {
      let nodes = [roots[table]];
      for (let level = 0; level < 16; level++) {
        const next = new Array(nodes.length * 2);
        for (let i = 0; i < nodes.length; i++) {
          next[i * 2] = nodes[i] < meta.nodeCount ? reader.child(bytes, nodes[i], 0) : nodes[i];
          next[i * 2 + 1] = nodes[i] < meta.nodeCount ? reader.child(bytes, nodes[i], 1) : nodes[i];
        }
        nodes = next;
      }
      for (let i = 0; i < nodes.length; i++) index.writeUInt32BE(nodes[i], (table * 65536 + i) * 4);
    }
    meta.indexKey = `${meta.key}.index`;
    await writeFile(`${assetDirectory}/__geoip/${meta.indexKey}`, index);
  }
  await writeFile(`${assetDirectory}/__geoip/${manifest.release}/manifest.json`, JSON.stringify(manifest) + '\n');
  await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}

export function databaseMetadata(bytes, name, key) {
  const reader = new Reader(bytes);
  const m = reader.metadata;
  if (m.databaseType !== `GeoLite2-${name}` || m.binaryFormatMajorVersion !== 2 || ![4, 6].includes(m.ipVersion) ||
      !Number.isFinite(m.buildEpoch.getTime())) throw new Error(`Invalid GeoLite2-${name} database`);
  return { key, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    databaseType: m.databaseType, buildEpoch: m.buildEpoch.toISOString(),
    ipVersion: m.ipVersion, recordSize: m.recordSize, nodeCount: m.nodeCount, treeSize: m.searchTreeSize };
}

async function download(asset, name) {
  if (!/^sha256:[a-f0-9]{64}$/.test(asset?.digest || '') ||
      !asset.browser_download_url?.startsWith('https://github.com/P3TERX/GeoLite.mmdb/releases/download/')) {
    throw new Error(`Missing trusted URL or SHA-256 for GeoLite2-${name}`);
  }
  const path = `${output}/GeoLite2-${name}.mmdb`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
      const hash = createHash('sha256');
      const checksum = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), checksum, createWriteStream(`${path}.tmp`));
      if (hash.digest('hex') !== asset.digest.slice(7)) throw new Error(`SHA-256 mismatch for ${name}`);
      await rename(`${path}.tmp`, path);
      return;
    } catch (error) { if (attempt === 3) throw error; }
  }
}

export async function prepareGeoLite2() {
  await mkdir(output, { recursive: true });
  await rm(`${output}/manifest.json`, { force: true });
  // Resolve latest once; all three files must belong to that same release.
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(RELEASE_URL, { headers, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`);
  const latest = await response.json();
  if (!/^[A-Za-z0-9._-]+$/.test(latest.tag_name || '')) throw new Error('Invalid release tag');
  const databases = {};
  for (const name of names) {
    await download(latest.assets.find(asset => asset.name === `GeoLite2-${name}.mmdb`), name);
    databases[name] = databaseMetadata(await readFile(`${output}/GeoLite2-${name}.mmdb`), name);
    const age = Date.now() - Date.parse(databases[name].buildEpoch);
    if (age > 30 * 86400000 || age < -86400000) throw new Error(`GeoLite2-${name} has a stale or future build date: ${databases[name].buildEpoch}`);
    console.log(`Verified ${name}, database built ${databases[name].buildEpoch}.`);
  }
  if (Object.values(databases).reduce((sum, db) => sum + db.treeSize, 0) > 64 * 1024 * 1024) {
    throw new Error('GeoLite2 search trees exceed Worker memory budget');
  }
  const digest = createHash('sha256').update(names.map(name => databases[name].sha256).join('')).digest('hex');
  const release = `geolite2/${latest.tag_name}-${digest.slice(0, 16)}`;
  for (const name of names) databases[name].key = `${release}/GeoLite2-${name}.mmdb`;
  const manifest = { schema: 1, release, upstreamTag: latest.tag_name, downloadedAt: new Date().toISOString(), chunkSize, databases };
  // Each deployment owns its asset set; only current files are uploaded.
  await packageGeoLiteAssets(manifest);
  console.log(`Prepared ${release}; verified all three SHA-256 digests.`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `release=${release}\n`);
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareGeoLite2();
