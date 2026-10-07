import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Reader } from 'mmdb-lib';
import { MMDBReader, PageCache } from '../worker/mmdb.mjs';
import { fixtureMetadata, fixtureEnvironment, plain } from './helpers/geoip.mjs';

test('Storage MMDB reader matches reference for all supported node widths, IPv4, IPv6 and typed records', async () => {
  for (const name of ['GeoIP2-City-Test', 'GeoIP2-Country-Test', 'GeoLite2-ASN-Test',
    'MaxMind-DB-test-ipv4-24', 'MaxMind-DB-test-mixed-32', 'MaxMind-DB-test-decoder']) {
    const bytes = await readFile(new URL(`fixtures/${name}.mmdb`, import.meta.url));
    const reference = new Reader(bytes);
    let reads = 0;
    const bucket = { async get(key, { range }) {
      reads++;
      const result = bytes.subarray(range.offset, range.offset + range.length);
      return { arrayBuffer: async () => result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) };
    } };
    const reader = new MMDBReader(bucket, fixtureMetadata(bytes, name));
    const addresses = ['1.1.1.1', '1.0.0.1', '81.2.69.160', '89.160.20.112', '8.8.8.8', '255.255.255.255'];
    if (reference.metadata.ipVersion === 6) addresses.push('2001:218::', '2001:220::', '::1:ffff:ffff', '::ffff:512:45a0', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    for (const ip of addresses) assert.deepEqual(plain(await reader.get(ip)), plain(reference.get(ip)), `${name}: ${ip}`);
    const before = reads;
    for (const ip of addresses) await reader.get(ip);
    assert.equal(reads, before, 'Warm reads should reuse search tree and pages');
    if (reference.metadata.ipVersion === 4) assert.equal(await reader.get('2001:218::'), null);
  }
});

test('records spanning data pages are read completely, and cache stays bounded', async () => {
  const bytes = new Uint8Array(66 * 65536);
  const offset = 65535;
  bytes.set([0x45, 104, 101, 108, 108, 111], offset);
  const bucket = { async get(key, { range }) {
    return { arrayBuffer: async () => bytes.slice(range.offset, range.offset + range.length).buffer };
  } };
  const cache = new PageCache();
  const reader = new MMDBReader(bucket, { key: 'test', size: bytes.length, treeSize: 6, nodeCount: 1, recordSize: 24, ipVersion: 4 }, cache);
  assert.equal((await reader.decode(offset)).value, 'hello');
  for (let i = 1; i < 66; i++) await reader.bytes(i * 65536, 1);
  assert.equal(cache.pages.size, 64);
  assert.equal(cache.pending.size, 0);
  await assert.rejects(reader.bytes(bytes.length, 1), /Invalid MMDB/);
});

test('corrupt ranges and pointer chains fail; failed tree reads can retry', async () => {
  const env = fixtureEnvironment();
  const meta = env.manifest.databases.City;
  const reader = new MMDBReader({ get: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) }, meta);
  await assert.rejects(reader.get('81.2.69.160'), /Truncated/);
  reader.bucket = env.GEOIP;
  assert.equal((await reader.get('81.2.69.160')).country.iso_code, 'GB');
  const corrupt = new Uint8Array(100);
  corrupt.set([0x20, 0], 22);
  const cyclic = new MMDBReader({ get: async (key, { range }) => ({ arrayBuffer: async () => corrupt.slice(range.offset, range.offset + range.length).buffer }) },
    { key: 'cycle', size: 100, treeSize: 6, nodeCount: 1, recordSize: 24, ipVersion: 4 });
  await assert.rejects(cyclic.decode(22), /pointer chain/);
});

test('concurrent lookups share tree loading and pending storage data pages', async () => {
  const env = fixtureEnvironment();
  const reader = new MMDBReader(env.GEOIP, env.manifest.databases.City);
  const results = await Promise.all(Array.from({ length: 10 }, () => reader.get('81.2.69.160')));
  assert.ok(results.every(record => record.country.iso_code === 'GB'));
  assert.equal(env.calls.length, 2);
});
