import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

const logo = await readFile('public/brand/ipinfo.svg', 'utf8');
await mkdir('public/icons', { recursive: true });
const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
for (const size of [192, 512]) await writeFile(`public/icons/icon-${size}.png`, png(logo, size));
await writeFile('public/icons/apple-touch-icon.png', png(logo, 180));
// A full-bleed background and inset mark keep the entire symbol inside the maskable safe zone.
const maskable = logo.replace('<rect width="512" height="512" rx="120" fill="url(#blue)"/>', '<rect width="512" height="512" fill="url(#blue)"/><g transform="translate(51.2 51.2) scale(.8)">').replace('</svg>', '</g></svg>');
await writeFile('public/icons/icon-maskable-512.png', png(maskable, 512));

const sizes = [16, 32, 48];
const images = sizes.map(size => png(logo, size));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
await writeFile('public/favicon.ico', Buffer.concat([header, ...images]));

let offline = await readFile('html/offline.html', 'utf8');
for (const name of ['theme.html', 'styles.html']) offline = offline.replace(`{{ template "${name}" . }}`, await readFile(`html/${name}`, 'utf8'));
await writeFile('public/offline.html', offline);

const types = { svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', webmanifest: 'application/manifest+json', js: 'text/javascript; charset=utf-8', html: 'text/html; charset=utf-8' };
const assets = [];
async function collect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (path !== 'public/sw.js') assets.push([path.slice('public/'.length), { type: types[path.split('.').at(-1)], body: (await readFile(path)).toString('base64') }]);
  }
}
await collect('public');
const swSource = await readFile('public/sw.js', 'utf8');
const version = createHash('sha256').update(JSON.stringify(assets)).update(swSource).digest('hex').slice(0, 16);
const sw = swSource.replace('__ASSET_VERSION__', version);
// The container embeds this same service worker; leave the source placeholder unchanged.
await mkdir('dist/public', { recursive: true });
const { cp } = await import('node:fs/promises');
await cp('public', 'dist/public', { recursive: true });
await writeFile('dist/public/sw.js', sw);
assets.push(['sw.js', { type: types.js, body: Buffer.from(sw).toString('base64') }]);
await mkdir('worker', { recursive: true });
await writeFile('worker/assets.generated.mjs', `export const assets = new Map(${JSON.stringify(assets.map(([path, asset]) => [`/${path}`, asset]))});\n`);
console.log(`Built logo, favicon, PWA icons, and app assets (${version}).`);
