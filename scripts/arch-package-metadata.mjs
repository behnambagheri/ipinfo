import { createReadStream, createWriteStream } from "node:fs";
import { rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { list, Parser, Pack, Header, ReadEntry } from "tar";

// nFPM 2.47 does not emit Arch optdepends. Preserve its payload and add the
// optional GUI libraries, updating .MTREE's checksum of .PKGINFO as well.
export async function addArchOptionalDependencies(archive, dependencies) {
  const metadata = new Map();
  await list({ file: archive, onReadEntry(entry) {
    if (![".PKGINFO", ".MTREE"].includes(entry.path)) return;
    const chunks = [];
    entry.on("data", (chunk) => chunks.push(chunk));
    entry.on("end", () => metadata.set(entry.path, Buffer.concat(chunks)));
  } });
  if (metadata.size !== 2) throw new Error("Missing Arch package metadata.");
  const pkginfo = Buffer.from(`${metadata.get(".PKGINFO").toString()}${dependencies.map((dependency) => `optdepend = ${dependency}\n`).join("")}`);
  const md5 = createHash("md5").update(pkginfo).digest("hex");
  const sha256 = createHash("sha256").update(pkginfo).digest("hex");
  const original = gunzipSync(metadata.get(".MTREE")).toString();
  const mtree = original.replace(/^(\.\/\.PKGINFO .*?)size=\d+ type=file md5digest=\w+ sha256digest=\w+$/m,
    `$1size=${pkginfo.length} type=file md5digest=${md5} sha256digest=${sha256}`);
  if (mtree === original) throw new Error("Could not update Arch metadata checksum.");
  metadata.set(".PKGINFO", pkginfo);
  metadata.set(".MTREE", gzipSync(mtree));
  const output = `${archive}.metadata`;
  const pack = new Pack({ zstd: true, strict: true });
  const writing = pipeline(pack, createWriteStream(output));
  const parser = new Parser({ strict: true, onReadEntry(entry) {
    const replacement = metadata.get(entry.path);
    if (!replacement) { pack.add(entry); return; }
    const rewritten = new ReadEntry(new Header({ path: entry.path, mode: entry.mode, uid: entry.uid,
      gid: entry.gid, mtime: entry.mtime, size: replacement.length, type: "File" }));
    pack.add(rewritten);
    rewritten.end(replacement);
    entry.resume();
  } });
  parser.on("end", () => pack.end());
  try {
    await pipeline(createReadStream(archive), parser);
    await writing;
  } catch (error) {
    pack.destroy(error);
    await writing.catch(() => {});
    throw error;
  }
  await rename(output, archive);
}
