import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LLMRouter } from "../../llm/router.js";
import { ToolRegistry } from "../../tools/registry.js";
import { FlyioAdapter, type PresignedStorageAdapter } from "./adapter.js";
import type { FlyMachinesApi } from "./fly-api.js";
import { RUN_OUTPUTS_PREFIX, runOutputKey, runOutputsArchiveKey } from "./output-keys.js";
import { uploadOutputs } from "./outputs-upload.js";

/** A string literal that starts with the output prefix, old or new, in any quote style. */
const PREFIX_LITERAL = /[`'"]_?runs\//;

const SRC_ROOT = join(import.meta.dirname, "..", "..");
const KEYS_MODULE = join(import.meta.dirname, "output-keys.ts");
/** The api package's sources, next to this one in the repository — public, like these. */
const API_SRC_ROOT = join(SRC_ROOT, "..", "..", "api", "src");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function spyStorage(): PresignedStorageAdapter & {
  put: ReturnType<typeof vi.fn>;
  getPresignedDownloadUrl: ReturnType<typeof vi.fn>;
  getPresignedUploadUrl: ReturnType<typeof vi.fn>;
} {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    getPresignedDownloadUrl: vi.fn().mockResolvedValue("https://storage.example/get"),
    getPresignedUploadUrl: vi.fn().mockResolvedValue("https://storage.example/put"),
  };
}

/** Exposes the adapter's presigning step, which the run paths call before `/init`. */
class PresignProbe extends FlyioAdapter {
  presign(bundleKey: string, runId: string) {
    return this.presignRunUrls(bundleKey, runId, 60);
  }
}

describe("run output keys have one definition, under _runs/", () => {
  it("builds a file key under the run's outputs", () => {
    expect(RUN_OUTPUTS_PREFIX).toBe("_runs/");
    expect(runOutputKey("r1", "d/b.csv")).toBe("_runs/r1/outputs/d/b.csv");
  });

  it("builds the archive key next to the outputs directory", () => {
    expect(runOutputsArchiveKey("r1")).toBe("_runs/r1/outputs.tar.gz");
  });

  it("concatenates the name as given, never normalising it", () => {
    expect(runOutputKey("r1", "a/../b")).toBe("_runs/r1/outputs/a/../b");
    expect(runOutputKey("r1", "./x")).toBe("_runs/r1/outputs/./x");
    expect(runOutputKey("r1", "a//b")).toBe("_runs/r1/outputs/a//b");
  });

  it("the upload writer stores and presigns each file at the key the function gives", async () => {
    const storage = spyStorage();
    // In path order, as a runner lists them.
    const manifest = [
      { path: "d/b.csv", size: 3, mimeType: "text/csv" },
      { path: "report.pdf", size: 3, mimeType: "application/pdf" },
    ];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/outputs/collect")) {
        return new Response(JSON.stringify({ files: manifest }), { status: 200 });
      }
      return new Response(Buffer.from("abc"), { status: 200 });
    }) as unknown as typeof fetch;

    await uploadOutputs({
      runId: "r1",
      runnerBaseUrl: "http://runner:9000",
      storage,
      fetchImpl,
    });

    const expected = manifest.map((f) => runOutputKey("r1", f.path));
    expect(storage.put.mock.calls.map((call) => call[0])).toEqual(expected);
    expect(storage.getPresignedDownloadUrl.mock.calls.map((call) => call[0])).toEqual(expected);
  });

  it("the adapter presigns the archive upload at the key the function gives", async () => {
    const storage = spyStorage();
    const adapter = new PresignProbe(
      {} as FlyMachinesApi,
      storage,
      new LLMRouter(),
      new ToolRegistry(),
    );

    await adapter.presign("ns/agent/1.0.0.agent", "r1");

    expect(storage.getPresignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(storage.getPresignedUploadUrl.mock.calls[0]?.[0]).toBe(runOutputsArchiveKey("r1"));
  });

  it("no other runtime source file spells the prefix", () => {
    const files = sourceFiles(SRC_ROOT);
    // The sweep must see the two writers, or an empty scan would pass.
    expect(files).toContain(join(import.meta.dirname, "outputs-upload.ts"));
    expect(files).toContain(join(import.meta.dirname, "adapter.ts"));
    // And the pattern must recognise the one definition, or it detects nothing.
    expect(readFileSync(KEYS_MODULE, "utf8")).toMatch(PREFIX_LITERAL);

    const offenders = files
      .filter((file) => file !== KEYS_MODULE)
      .filter((file) => PREFIX_LITERAL.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });

  // The api builds these keys too — to delete a run's outputs, and whatever
  // deletes them next — and must build them with the functions above, never by
  // spelling the prefix: a key spelled twice is a key that drifts.
  it("no api source file spells the prefix either", () => {
    const files = sourceFiles(API_SRC_ROOT);
    // The sweep must see a module that builds keys, or an empty scan would pass.
    expect(files).toContain(join(API_SRC_ROOT, "files", "output-purge.ts"));

    const offenders = files
      .filter((file) => PREFIX_LITERAL.test(readFileSync(file, "utf8")))
      .map((file) => relative(API_SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
