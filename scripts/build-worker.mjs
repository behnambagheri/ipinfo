import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

// Compile our shared HTML template syntax into an ES module.
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
// Both runtimes retain the page and show a retry action on database failures.
const lookupError = await readFile('worker/lookup-error.html', 'utf8');
async function compile(name, output, exportName, decorate = source => source) {
  const source = decorate(await inline(name));
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
  await writeFile(output, `import { escapeHTML, scriptString } from './render.mjs';\nexport const ${exportName} = data => ${expression(root)};\n`);
}
await compile('index.html', 'worker/render.generated.mjs', 'render', source => source.replace('<section aria-labelledby="ip-title"', `${lookupError}<section aria-labelledby="ip-title"`));
await compile('statistics.html', 'worker/statistics-page.generated.mjs', 'renderStatistics');
await compile('admin.html', 'worker/admin-page.generated.mjs', 'renderAdmin');
await build({ entryPoints: ['worker/cloudflare.mjs'], outfile: 'dist/worker.mjs', bundle: true, external: ['cloudflare:sockets'], format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await build({ entryPoints: ['server/index.mjs'], outfile: 'dist/server.mjs', bundle: true, format: 'esm', platform: 'node', target: 'node24', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
console.log('Built Worker and container service from the shared IPinfo handler and templates.');
