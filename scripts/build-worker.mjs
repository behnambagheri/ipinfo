import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

// Compile the small Go-template subset used by echoip into an ES module.
// Both deployments share the exact same HTML, interaction scripts, and CSS.
async function inline(name) {
  let text = await readFile(`html/${name}`, 'utf8');
  const matches = [...text.matchAll(/{{\s*template "([\w.-]+)" \.\s*}}/g)];
  for (const match of matches) text = text.replace(match[0], await inline(match[1]));
  return text;
}
function field(value) {
  if (!/^\.[A-Za-z][A-Za-z0-9.]*$/.test(value)) throw new Error(`Unsupported template field: ${value}`);
  return value.slice(1).split('.').reduce((acc, key) => `${acc}?.${key}`, 'data');
}
function condition(text) {
  const parts = text.split(/\s+/);
  if (parts[0] === 'not') return `!(${condition(parts.slice(1).join(' '))})`;
  if (parts[0] === 'or') return `(${parts.slice(1).map(field).join(' || ')})`;
  return field(text);
}
// The container resolves addresses locally; this alert handles Worker database lookup failures.
const lookupError = await readFile('worker/lookup-error.html', 'utf8');
const source = (await inline('index.html')).replaceAll('echoip and GeoLite2', 'Cloudflare and GeoLite2').replaceAll("Port checks test the connection's IP address.", 'Custom lookups use GeoLite2 databases.').replace('<section aria-labelledby="ip-title"', `${lookupError}<section aria-labelledby="ip-title"`);
const root = [];
const stack = [{ children: root }];
let cursor = 0;
for (const match of source.matchAll(/{{\s*(.*?)\s*}}/gs)) {
  const current = stack.at(-1);
  current.children.push(JSON.stringify(source.slice(cursor, match.index)));
  const token = match[1].trim();
  if (token.startsWith('if ')) {
    const node = { condition: condition(token.slice(3)), yes: [], no: [] };
    current.children.push(node);
    stack.push({ node, children: node.yes });
  } else if (token === 'else') {
    if (stack.length === 1) throw new Error('Unmatched else');
    stack.at(-1).children = stack.at(-1).node.no;
  } else if (token === 'end') {
    if (stack.length === 1) throw new Error('Unmatched end');
    stack.pop();
  } else {
    current.children.push(`${token === '.JSON' ? 'scriptString' : 'escapeHTML'}(${field(token)})`);
  }
  cursor = match.index + match[0].length;
}
if (stack.length !== 1) throw new Error('Unclosed template condition');
root.push(JSON.stringify(source.slice(cursor)));
function expression(nodes) {
  return nodes.map(node => typeof node === 'string' ? node : `(${node.condition} ? ${expression(node.yes)} : ${expression(node.no)})`).join(' + ') || '""';
}
await mkdir('dist', { recursive: true });
await writeFile('worker/render.generated.mjs', `import { escapeHTML, scriptString } from './render.mjs';\nexport const render = data => ${expression(root)};\n`);
await build({ entryPoints: ['worker/index.mjs'], outfile: 'dist/worker.mjs', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
console.log('Built dist/worker.mjs from the shared echoip templates.');
