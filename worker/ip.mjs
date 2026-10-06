export function normalizeIP(value) {
  if (typeof value !== 'string' || value.length > 45) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const bytes = value.split('.');
    return bytes.every(byte => Number(byte) <= 255 && String(Number(byte)) === byte) ? value : null;
  }
  if (!/^[0-9a-f:.]+$/i.test(value) || !value.includes(':')) return null;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
}
export function decimalIP(ip) {
  if (!ip.includes(':')) return ip.split('.').reduce((acc, byte) => acc * 256 + Number(byte), 0);
  const halves = ip.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  // IPv6 integers exceed JSON's safe integer range, so return an exact string.
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(`0x${group}`), 0n).toString();
}
export function privateIP(ip) {
  if (ip.includes(':')) {
    if (/^::ffff:/.test(ip)) {
      const groups = ip.slice(7).split(':');
      if (groups.length === 2) {
        const n = parseInt(groups[0], 16) * 65536 + parseInt(groups[1], 16);
        return privateIP([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
      }
    }
    return ip === '::' || ip === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(ip) || ip.startsWith('2001:db8:');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || ip.startsWith('192.0.2.') || ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.');
}
