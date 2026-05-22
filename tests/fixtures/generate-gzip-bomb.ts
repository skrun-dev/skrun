/**
 * SEC-010 — generate a deterministic gzip-bomb fixture for the bundle defense
 * test. Produces a small `.gz` file (~50-100 KB on disk) that decompresses
 * into a buffer > 50 MB — exceeding the BUNDLE_MAX_DECOMPRESSED_MB cap.
 *
 * Run once, the resulting `gzip-bomb-50mb.gz` is committed alongside this
 * script so the test suite has a stable fixture without needing to
 * regenerate it (and without anyone needing to know the exact size /
 * compression ratio that produced it).
 *
 * Usage:
 *   pnpm tsx tests/fixtures/generate-gzip-bomb.ts
 *
 * Idempotent — re-running overwrites the existing file with identical bytes
 * (gzip is deterministic for a fixed input + level + dictionary).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const TARGET_DECOMPRESSED_BYTES = 60 * 1024 * 1024; // 60 MB > 50 MB cap

// A 1 MB buffer of zeros. Zeros compress to ~1 KB at gzip's best level, so
// 60× this buffer concatenated will produce a tiny `.gz` that decompresses
// to 60 MB — well above the 50 MB defense threshold.
const ONE_MB_ZEROS = Buffer.alloc(1024 * 1024, 0);
const decompressed = Buffer.concat(Array(60).fill(ONE_MB_ZEROS));

if (decompressed.length < TARGET_DECOMPRESSED_BYTES) {
  throw new Error(
    `Fixture sanity: built ${decompressed.length} bytes, expected >= ${TARGET_DECOMPRESSED_BYTES}.`,
  );
}

const compressed = gzipSync(decompressed, { level: 9 });
const outPath = join(import.meta.dirname, "gzip-bomb-50mb.gz");
writeFileSync(outPath, compressed);

console.log(
  `Wrote ${outPath}: ${compressed.length} bytes on disk → ${decompressed.length} bytes decompressed (ratio ${(decompressed.length / compressed.length).toFixed(0)}×)`,
);
