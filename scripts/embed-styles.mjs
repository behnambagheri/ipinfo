import { readFile, writeFile } from "node:fs/promises";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const source = await readFile("ui/styles.css", "utf8");
const result = await postcss([tailwindcss({ optimize: true })]).process(source, {
  from: "ui/styles.css",
});
await writeFile("html/styles.html", `<style>\n${result.css}\n</style>\n`);
