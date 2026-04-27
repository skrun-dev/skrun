// Write a Semgrep rule artifact (rule.yml | tests.md | README.md) to SKRUN_OUTPUT_DIR.
// Input (stdin JSON): { filename, content }
// Output (stdout JSON): { path, bytes }

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALLOWED_FILENAMES = ["rule.yml", "tests.md", "README.md"] as const;

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
});

process.stdin.on("end", () => {
  try {
    const args = JSON.parse(buf);
    const filename: string = args.filename;
    const content: string = args.content;

    if (!filename || typeof filename !== "string") {
      throw new Error("filename is required and must be a string");
    }
    if (typeof content !== "string") {
      throw new Error("content must be a string");
    }
    if (!ALLOWED_FILENAMES.includes(filename as (typeof ALLOWED_FILENAMES)[number])) {
      throw new Error(`filename must be one of ${ALLOWED_FILENAMES.join(", ")} (got: ${filename})`);
    }

    const outputDir = process.env.SKRUN_OUTPUT_DIR;
    if (!outputDir) {
      throw new Error("SKRUN_OUTPUT_DIR is not set — runtime is responsible for providing this");
    }

    mkdirSync(outputDir, { recursive: true });
    const fullPath = join(outputDir, filename);
    writeFileSync(fullPath, content, "utf-8");

    process.stdout.write(
      JSON.stringify({ path: fullPath, bytes: Buffer.byteLength(content, "utf-8") }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message }));
  }
});
