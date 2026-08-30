// Generates `legacy-handrolled.agent` — a `.agent` bundle produced by the
// PRE-migration hand-rolled ustar writer (a faithful replica of the logic that
// lived in `packages/cli/src/commands/build.ts` before the tar-stream migration,
// post-6.9 so entry names are already POSIX). This is the ground truth for the
// new reader's registry read-back test (RT-1 / SC-8): bundles already stored in
// the registry are hand-rolled ustar, and the tar-stream reader must parse them.
//
// Run once to (re)generate the committed fixture:
//   node packages/schema/tests/fixtures/gen-legacy-fixture.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// Verbatim replica of the pre-migration `createTarEntry` (POSIX ustar).
function createTarEntry(filePath, content) {
  const header = Buffer.alloc(512);
  const posixPath = filePath.split(/[\\/]/).join("/");
  const nameBytes = Buffer.from(posixPath, "utf-8");
  nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));
  Buffer.from("0000644\0").copy(header, 100); // mode
  Buffer.from("0001000\0").copy(header, 108); // uid
  Buffer.from("0001000\0").copy(header, 116); // gid
  Buffer.from(`${content.length.toString(8).padStart(11, "0")}\0`).copy(header, 124); // size
  Buffer.from("00000000000\0").copy(header, 136); // mtime
  header[156] = 48; // type: regular file
  Buffer.from("ustar\0").copy(header, 257); // magic
  Buffer.from("00").copy(header, 263); // version
  Buffer.from("        ").copy(header, 148); // checksum field = spaces
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);
  const paddingSize = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(paddingSize)]);
}

// Text + a nested script + a raw binary asset (bytes 0..255) for binary fidelity.
const files = [
  [
    "SKILL.md",
    Buffer.from("# Legacy fixture\n\nHand-rolled bundle used to prove registry read-back.\n"),
  ],
  ["agent.yaml", Buffer.from("name: legacy-fixture\nversion: 0.0.1\n")],
  ["scripts/probe.py", Buffer.from("print('hello from scripts/')\n")],
  ["assets/logo.bin", Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
];

const parts = files.map(([name, content]) => createTarEntry(name, content));
parts.push(Buffer.alloc(1024)); // end-of-archive: two zero blocks
const gz = gzipSync(Buffer.concat(parts));

const out = join(dirname(fileURLToPath(import.meta.url)), "legacy-handrolled.agent");
writeFileSync(out, gz);
console.log(`wrote ${out} (${gz.length} bytes)`);
