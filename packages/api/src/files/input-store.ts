import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkrunError } from "@skrun-dev/schema";

const DEFAULT_MAX_SIZE_MB = 25;
const INPUT_DIR_NAME = "skrun-inputs";

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function getMaxInputSizeBytes(): number {
  return readEnvInt("INPUT_FILES_MAX_SIZE_MB", DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
}

export function getInputStoreDir(): string {
  return join(tmpdir(), INPUT_DIR_NAME);
}

export interface WriteInputResult {
  file_id: string;
  path: string;
  size: number;
}

export function writeInputFile(bytes: Buffer): WriteInputResult {
  const maxSize = getMaxInputSizeBytes();
  if (bytes.length > maxSize) {
    throw new SkrunError(
      "FILE_TOO_LARGE",
      `Input file size ${bytes.length} bytes exceeds limit of ${maxSize} bytes (${maxSize / (1024 * 1024)} MB)`,
    );
  }

  const dir = getInputStoreDir();
  mkdirSync(dir, { recursive: true });

  const fileId = `fil_${randomUUID().replace(/-/g, "")}`;
  const path = join(dir, fileId);
  writeFileSync(path, bytes);

  return { file_id: fileId, path, size: bytes.length };
}
