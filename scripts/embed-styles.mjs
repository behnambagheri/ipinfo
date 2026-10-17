import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Every page links the vendored design system, then the IPinfo page stylesheet, in this order.
// Each ?v= is a content hash, so browsers refetch a stylesheet only when that file changes.
const stylesheets = ["ds/v1/tokens.css", "ds/v1/base.css", "ds/v1/components.css", "styles.css"];
const links = [];
for (const path of stylesheets) {
  const version = createHash("sha256").update(await readFile(`public/${path}`)).digest("hex").slice(0, 10);
  links.push(`<link rel="stylesheet" href="/${path}?v=${version}" />`);
}
await writeFile("html/styles.html", `${links.join("\n")}\n`);
