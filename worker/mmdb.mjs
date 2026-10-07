// MaxMind DB v2 reader backed by storage range reads. A small prefix index skips
// the upper tree levels; tree and data pages share a bounded cache.
const PAGE_SIZE = 64 * 1024;
const MAX_PAGES = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function uint(bytes) {
  return bytes.reduce((value, byte) => value * 256 + byte, 0);
}

export class PageCache {
  pages = new Map();
  pending = new Map();
  async get(key, read) {
    if (this.pages.has(key)) {
      const value = this.pages.get(key);
      this.pages.delete(key);
      this.pages.set(key, value);
      return value;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = read().then(value => {
      this.pages.set(key, value);
      if (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }
}

export class MMDBReader {
  constructor(bucket, metadata, cache = new PageCache()) {
    this.bucket = bucket;
    this.meta = metadata;
    this.cache = cache;
    const { size, nodeCount, recordSize, ipVersion, treeSize } = metadata;
    if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(nodeCount) || nodeCount <= 0 ||
        ![24, 28, 32].includes(recordSize) || ![4, 6].includes(ipVersion) ||
        treeSize !== nodeCount * recordSize / 4 || treeSize + 16 >= size) throw new Error('Invalid MMDB metadata');
    this.dataStart = treeSize + 16;
  }

  async range(offset, length) {
    const object = await this.bucket.get(this.meta.key, { range: { offset, length } });
    if (!object) throw new Error('GeoLite2 object missing');
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== length) throw new Error('Truncated GeoLite2 range');
    return bytes;
  }

  async tree() {
    if (!this.treePromise) {
      this.treePromise = this.range(0, this.meta.treeSize).catch(error => {
        this.treePromise = undefined;
        throw error;
      });
    }
    return this.treePromise;
  }

  async read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
        length < 0 || length > 1024 * 1024 || offset + length > this.meta.size) throw new Error('Invalid MMDB data range');
    if (length === 0) return new Uint8Array();
    const pageStart = Math.floor(offset / PAGE_SIZE) * PAGE_SIZE;
    const page = await this.cache.get(`${this.meta.key}:${pageStart}`, () =>
      this.range(pageStart, Math.min(PAGE_SIZE, this.meta.size - pageStart)));
    const start = offset - pageStart;
    if (start + length <= page.length) return page.subarray(start, start + length);
    const result = new Uint8Array(length);
    const firstLength = page.length - start;
    result.set(page.subarray(start));
    result.set(await this.read(offset + firstLength, length - firstLength), firstLength);
    return result;
  }

  async bytes(offset, length) {
    if (offset < this.dataStart) throw new Error('Invalid MMDB data range');
    return this.read(offset, length);
  }

  async index() {
    if (!this.indexPromise) this.indexPromise = (async () => {
      const object = await this.bucket.get(this.meta.indexKey);
      if (!object) throw new Error('GeoLite2 prefix index missing');
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.length !== (this.meta.ipVersion === 6 ? 2 : 1) * 65536 * 4) throw new Error('Invalid GeoLite2 prefix index');
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    })().catch(error => { this.indexPromise = undefined; throw error; });
    return this.indexPromise;
  }

  child(tree, node, bit) {
    const start = node * this.meta.recordSize / 4;
    if (this.meta.recordSize === 28) {
      return bit ? (tree[start + 3] & 15) * 16777216 + uint(tree.subarray(start + 4, start + 7))
        : (tree[start + 3] >> 4) * 16777216 + uint(tree.subarray(start, start + 3));
    }
    const width = this.meta.recordSize / 8;
    return uint(tree.subarray(start + bit * width, start + (bit + 1) * width));
  }

  async get(ip) {
    const ipv6 = ip.includes(':');
    if (ipv6 && this.meta.ipVersion === 4) return null;
    const indexed = Boolean(this.meta.indexKey);
    const tree = indexed ? null : await this.tree();
    let node = 0;
    if (!indexed && !ipv6 && this.meta.ipVersion === 6) {
      for (let bit = 0; bit < 96 && node < this.meta.nodeCount; bit++) node = this.child(tree, node, 0);
    }
    let bytes;
    if (ipv6) {
      const [left, right] = ip.split('::');
      const a = left ? left.split(':') : [];
      const b = right ? right.split(':') : [];
      const groups = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
      bytes = groups.flatMap(group => { const n = parseInt(group, 16); return [n >> 8, n & 255]; });
    } else bytes = ip.split('.').map(Number);
    if (indexed) {
      const table = ipv6 ? 65536 : 0;
      node = (await this.index()).getUint32((table + bytes[0] * 256 + bytes[1]) * 4);
    }
    for (let bit = indexed ? 16 : 0; bit < bytes.length * 8 && node < this.meta.nodeCount; bit++) {
      const side = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
      if (indexed) {
        const width = this.meta.recordSize / 4;
        const record = await this.read(node * width, width);
        node = this.child(record, 0, side);
      } else node = this.child(tree, node, side);
    }
    if (node <= this.meta.nodeCount) return null;
    const offset = this.meta.treeSize + node - this.meta.nodeCount;
    return (await this.decode(offset)).value;
  }

  async decode(offset, depth = 0, budget = { remaining: 10000 }) {
    if (depth > 64 || --budget.remaining < 0) throw new Error('MMDB record exceeds decoding limits');
    const control = (await this.bytes(offset++, 1))[0];
    let type = control >> 5;
    if (type === 1) {
      const width = ((control >> 3) & 3) + 1;
      const packed = uint(await this.bytes(offset, width));
      const pointer = this.dataStart + (width === 4 ? packed : (control & 7) * 256 ** width + packed + [0, 0, 2048, 526336][width]);
      // MaxMind forbids pointers to pointers; bound recursion even for corrupt input.
      if ((await this.bytes(pointer, 1))[0] >> 5 === 1) throw new Error('Invalid MMDB pointer chain');
      return { value: (await this.decode(pointer, depth + 1, budget)).value, offset: offset + width };
    }
    if (type === 0) type = (await this.bytes(offset++, 1))[0] + 7;
    let size = control & 31;
    if (size >= 29) {
      const width = size - 28;
      size = [29, 285, 65821][width - 1] + uint(await this.bytes(offset, width));
      offset += width;
    }
    if (type === 7 || type === 11) {
      if (size > 10000) throw new Error('Oversized MMDB collection');
      const value = type === 7 ? Object.create(null) : [];
      for (let i = 0; i < size; i++) {
        let key;
        if (type === 7) {
          const decoded = await this.decode(offset, depth + 1, budget);
          if (typeof decoded.value !== 'string') throw new Error('Invalid MMDB map key');
          key = decoded.value;
          offset = decoded.offset;
        }
        const decoded = await this.decode(offset, depth + 1, budget);
        if (type === 7) value[key] = decoded.value;
        else value.push(decoded.value);
        offset = decoded.offset;
      }
      return { value, offset };
    }
    if (type === 14) {
      if (size > 1) throw new Error('Invalid MMDB boolean');
      return { value: size === 1, offset };
    }
    const bytes = await this.bytes(offset, size);
    let value;
    if (type === 2) value = utf8.decode(bytes);
    else if (type === 4) value = bytes.slice();
    else if ((type === 3 && size === 8) || (type === 15 && size === 4)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      value = type === 3 ? view.getFloat64(0) : view.getFloat32(0);
    } else if ([5, 6, 8, 9, 10].includes(type)) {
      const maxSize = { 5: 2, 6: 4, 8: 4, 9: 8, 10: 16 }[type];
      if (size > maxSize) throw new Error('Invalid MMDB integer');
      if (type === 9 || type === 10) value = bytes.reduce((n, byte) => n * 256n + BigInt(byte), 0n);
      else {
        value = uint(bytes);
        if (type === 8 && value >= 2147483648) value -= 4294967296;
      }
    } else throw new Error(`Unsupported MMDB type ${type}`);
    return { value, offset: offset + size };
  }
}
