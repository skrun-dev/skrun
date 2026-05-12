import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CapabilityValidationOutcome,
  getModelCapabilities,
  MODEL_CAPABILITIES,
  type ModelCapabilities,
  validateAgentCapabilities,
} from "./capability.js";
import type { AgentConfig } from "./schemas/agent-config.js";

/**
 * Parse the capability matrix table out of docs/agent-yaml.md and return
 * a map { provider -> Set<modelId> }. Used by VT-3 (docs ↔ code parity).
 *
 * Expected format: a markdown table with header row
 *   | Provider | Model | image | document | audio |
 * followed by data rows, where the second column contains one or more
 * model IDs separated by ` / `.
 */
function parseDocsMatrix(): Map<string, Set<string>> {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const md = readFileSync(join(repoRoot, "docs", "agent-yaml.md"), "utf-8");
  const lines = md.split(/\r?\n/);

  const headerIdx = lines.findIndex((l) =>
    /^\|\s*Provider\s*\|\s*Model\s*\|\s*image\s*\|\s*document\s*\|\s*audio\s*\|/i.test(l),
  );
  if (headerIdx < 0) throw new Error("docs/agent-yaml.md: capability matrix header not found");

  const result = new Map<string, Set<string>>();
  // Skip the header (idx) and the separator (idx+1). Stop at first blank or
  // non-table line.
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim());
    // Layout: ["", provider, models, image, document, audio, ""]
    if (cells.length < 6) continue;
    const provider = cells[1];
    const modelsCell = cells[2];
    if (!provider || !modelsCell) continue;
    const ids = modelsCell
      .split(" / ")
      .map((s) => s.trim())
      .filter(Boolean);
    let set = result.get(provider);
    if (!set) {
      set = new Set();
      result.set(provider, set);
    }
    for (const id of ids) set.add(id);
  }
  return result;
}

function makeAgentConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "dev/test-agent",
    version: "0.1.0",
    model: { provider: "anthropic", name: "claude-3-7-sonnet" },
    tools: [],
    mcp_servers: [],
    inputs: [{ name: "q", type: "string", required: true }],
    outputs: [{ name: "answer", type: "string" }],
    environment: {},
    context_mode: "skill",
    state: {},
    tests: [],
    ...overrides,
  } as AgentConfig;
}

describe("getModelCapabilities", () => {
  it("returns the matrix entry for an exact match (claude-3-7-sonnet)", () => {
    const caps = getModelCapabilities("anthropic", "claude-3-7-sonnet");
    expect(caps).toEqual({
      image: true,
      document: true,
      audio: false,
      caching: true,
    } satisfies ModelCapabilities);
  });

  it("returns capabilities for a versioned model name via longest-prefix match", () => {
    const caps = getModelCapabilities("anthropic", "claude-3-7-sonnet-20250219");
    expect(caps).toEqual({ image: true, document: true, audio: false, caching: true });
  });

  it("returns capabilities for Gemini (full multimodal)", () => {
    const caps = getModelCapabilities("google", "gemini-2.5-flash");
    expect(caps).toEqual({ image: true, document: true, audio: true, caching: true });
  });

  it("returns audio-only for gpt-4o-audio-preview", () => {
    const caps = getModelCapabilities("openai", "gpt-4o-audio-preview");
    expect(caps).toEqual({ image: false, document: false, audio: true, caching: true });
  });

  it("returns image-only for Mistral large-3 (caching=false: no native caching)", () => {
    const caps = getModelCapabilities("mistral", "mistral-large-3");
    expect(caps).toEqual({ image: true, document: false, audio: false, caching: false });
  });

  it("returns image-only for xAI grok-4.3 (caching=true: implicit + x-grok-conv-id)", () => {
    const caps = getModelCapabilities("xai", "grok-4.3");
    expect(caps).toEqual({ image: true, document: false, audio: false, caching: true });
  });

  it("returns undefined for an unknown model (self-hosted bypass)", () => {
    const caps = getModelCapabilities("meta", "llama-99-custom");
    expect(caps).toBeUndefined();
  });

  it("returns undefined for an unknown anthropic model", () => {
    const caps = getModelCapabilities("anthropic", "claude-100-quantum");
    expect(caps).toBeUndefined();
  });

  it("does not falsely match similar prefixes (gpt-4obanana ≠ gpt-4o)", () => {
    const caps = getModelCapabilities("openai", "gpt-4obanana");
    expect(caps).toBeUndefined();
  });

  it("MODEL_CAPABILITIES is exposed as a readable matrix", () => {
    expect(MODEL_CAPABILITIES.anthropic["claude-3-7-sonnet"]).toBeDefined();
    expect(MODEL_CAPABILITIES.google["gemini-2.5-flash"]).toBeDefined();
    expect(MODEL_CAPABILITIES.openai["gpt-4o-mini"]).toBeDefined();
  });

  // VT-1 coverage: every live entry in the matrix resolves to its own capabilities
  // via getModelCapabilities (catches a regression where a key is added but the
  // function fails to return it for some reason).
  it("every live MODEL_CAPABILITIES entry is resolvable via getModelCapabilities", () => {
    for (const [provider, models] of Object.entries(MODEL_CAPABILITIES)) {
      for (const modelName of Object.keys(models)) {
        const caps = getModelCapabilities(
          provider as Parameters<typeof getModelCapabilities>[0],
          modelName,
        );
        expect(caps, `${provider}/${modelName}`).toBeDefined();
        expect(caps).toEqual(models[modelName]);
      }
    }
  });

  // VT-1 coverage: snapshot/dated model IDs resolve to their base entry via
  // longest-prefix match (essential for date-suffixed releases like
  // claude-opus-4-7-20260416 or gpt-5.5-2026-04-23).
  it.each([
    ["anthropic", "claude-opus-4-7-20260416", "claude-opus-4-7"],
    ["anthropic", "claude-sonnet-4-6-20260301", "claude-sonnet-4-6"],
    ["anthropic", "claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["openai", "gpt-5.5-2026-04-23", "gpt-5.5"],
    ["openai", "gpt-audio-2025-08-28", "gpt-audio"],
    ["google", "gemini-3.1-pro-preview-002", "gemini-3.1-pro-preview"],
    ["google", "gemini-3-flash-preview-001", "gemini-3-flash-preview"],
    ["mistral", "mistral-medium-3.5-2026-02", "mistral-medium-3.5"],
    ["xai", "grok-4.3-2026-04", "grok-4.3"],
    ["xai", "grok-4.20-multi-agent-beta", "grok-4.20-multi-agent"],
  ] as const)("snapshot %s/%s resolves to base %s", (provider, snapshotName, baseName) => {
    const snapCaps = getModelCapabilities(provider, snapshotName);
    const baseCaps = getModelCapabilities(provider, baseName);
    expect(snapCaps).toBeDefined();
    expect(snapCaps).toEqual(baseCaps);
  });

  // RT-2 (regression) — deprecated / phantom IDs that have NO surviving
  // prefix-parent return undefined (not silently mapped to a back-compat alias).
  // Catches accidental re-introduction of stale entries during future refreshes.
  // Note: grok-4.3-fast is excluded from this test because prefix matching
  // resolves it to grok-4.3 (any "<base>-<suffix>" looks like a snapshot to
  // the function). The lint script `check-stale-model-ids.ts` catches that
  // case at the doc level instead.
  it.each([
    ["xai", "grok-4-vision"], // never existed
    ["xai", "grok-4-mini"], // never existed
    ["mistral", "pixtral-large-latest"], // deprecated 2026, folded
    ["mistral", "pixtral-12b"], // deprecated 2026, folded
    ["mistral", "mistral-medium-3.1"], // renamed to 3.5
    ["groq", "llama-guard-4-12b"], // deprecated 2026-02-10
    ["groq", "llama-3.2-90b-vision-preview"], // removed from Groq catalog 2026-05
    ["groq", "llama-3.2-11b-vision-preview"], // removed from Groq catalog 2026-05
  ] as const)("deprecated/phantom %s/%s returns undefined", (provider, name) => {
    expect(getModelCapabilities(provider, name)).toBeUndefined();
  });

  // Documents the known prefix-matching limitation: a phantom ID that looks
  // like a snapshot of a real model (`<real-model>-<suffix>`) resolves to the
  // real model. This is acceptable because (a) it's a fail-safe (no crash),
  // (b) the lint script catches it at the doc level, (c) detecting "phantom
  // suffix" vs "snapshot suffix" from the name alone is not feasible.
  it("phantom ID with real-model prefix silently resolves (acceptable limitation)", () => {
    const phantom = getModelCapabilities("xai", "grok-4.3-fast");
    const real = getModelCapabilities("xai", "grok-4.3");
    expect(phantom).toEqual(real);
  });

  // VT-1 (#68 prompt-caching) — every entry in the matrix has the `caching`
  // boolean field. Catches a regression where a new entry is added without it
  // (TypeScript would already fail, but this also asserts the value is a
  // proper boolean, not undefined or some other truthy value).
  it("every MODEL_CAPABILITIES entry has a boolean `caching` field", () => {
    for (const [provider, models] of Object.entries(MODEL_CAPABILITIES)) {
      for (const [modelName, caps] of Object.entries(models)) {
        expect(typeof caps.caching, `${provider}/${modelName}.caching`).toBe("boolean");
      }
    }
  });

  // VT-1 (#68 prompt-caching) — Mistral entries are all caching=false (no
  // native API as of May 2026). Locks in the data point — if Mistral ever
  // adds caching, this test breaks and the developer must verify the new API
  // shape before flipping the flag.
  it("all Mistral entries have caching=false (verified May 2026)", () => {
    for (const [modelName, caps] of Object.entries(MODEL_CAPABILITIES.mistral)) {
      expect(caps.caching, `mistral/${modelName}`).toBe(false);
    }
  });

  // VT-1 (#68 prompt-caching) — Groq caching is limited to `openai/gpt-oss-*`
  // family (+ kimi-k2 once added to matrix). Llama / Qwen / compound = false.
  // Locks in the docs-verified per-model split.
  it("Groq caching is limited to openai/gpt-oss-* family", () => {
    const groq = MODEL_CAPABILITIES.groq;
    // Supported (caching=true)
    expect(groq["openai/gpt-oss-120b"]?.caching).toBe(true);
    expect(groq["openai/gpt-oss-20b"]?.caching).toBe(true);
    expect(groq["openai/gpt-oss-safeguard-20b"]?.caching).toBe(true);
    // Unprefixed back-compat aliases also true
    expect(groq["gpt-oss-120b"]?.caching).toBe(true);
    expect(groq["gpt-oss-20b"]?.caching).toBe(true);
    // Unsupported (caching=false)
    expect(groq["llama-4-scout-17b-16e-instruct"]?.caching).toBe(false);
    expect(groq["qwen/qwen3-32b"]?.caching).toBe(false);
    expect(groq["llama-3.3-70b-versatile"]?.caching).toBe(false);
    expect(groq["groq/compound"]?.caching).toBe(false);
  });

  // VT-3 (docs ↔ code parity) — every model in capability.ts must appear in
  // docs/agent-yaml.md and vice versa. Catches drift between source-of-truth
  // and the most-visible doc surface.
  it("docs/agent-yaml.md capability matrix matches MODEL_CAPABILITIES (per-provider set equality)", () => {
    const docs = parseDocsMatrix();
    for (const [provider, models] of Object.entries(MODEL_CAPABILITIES)) {
      const codeSet = new Set(Object.keys(models));
      if (codeSet.size === 0) continue; // skip providers with no entries (e.g. meta)
      const docsSet = docs.get(provider);
      expect(
        docsSet,
        `provider '${provider}' missing from docs/agent-yaml.md matrix`,
      ).toBeDefined();
      if (!docsSet) continue;
      const inCodeNotDocs = [...codeSet].filter((id) => !docsSet.has(id));
      const inDocsNotCode = [...docsSet].filter((id) => !codeSet.has(id));
      expect(
        inCodeNotDocs,
        `models in code but missing from docs (${provider}): ${inCodeNotDocs.join(", ")}`,
      ).toEqual([]);
      expect(
        inDocsNotCode,
        `models in docs but missing from code (${provider}): ${inDocsNotCode.join(", ")}`,
      ).toEqual([]);
    }
  });

  // VT-13 (#68 prompt-caching, docs ↔ code parity for the new `cache` column).
  // Asserts that for every model in MODEL_CAPABILITIES, the `cache` column
  // in `docs/agent-yaml.md` matches the `caching` boolean in code
  // (true/false). Catches drift between code and docs for the per-model
  // caching support split (Groq especially: only gpt-oss-* are true,
  // Llama/Qwen are false — easy to mis-document).
  it("docs/agent-yaml.md `cache` column matches MODEL_CAPABILITIES.caching (per-model)", () => {
    const cacheByModel = parseDocsCacheColumn();
    for (const [provider, models] of Object.entries(MODEL_CAPABILITIES)) {
      for (const [modelName, caps] of Object.entries(models)) {
        const docsValue = cacheByModel.get(`${provider}/${modelName}`);
        expect(
          docsValue,
          `${provider}/${modelName}: missing 'cache' column entry in docs/agent-yaml.md`,
        ).toBeDefined();
        expect(
          docsValue,
          `${provider}/${modelName}: cache column mismatch (docs=${docsValue}, code=${caps.caching})`,
        ).toBe(caps.caching);
      }
    }
  });
});

/**
 * Parse the `cache` column from the capability matrix table in
 * docs/agent-yaml.md. Returns a map { "provider/modelId" -> boolean }.
 *
 * Used by VT-13 (it.skip until Task 7.2 lands the column). Mirrors the shape
 * of `parseDocsMatrix` but specifically for the cache column. Expected
 * format: extends the existing matrix table with a new "cache" column, e.g.
 *
 *   | Provider | Model | image | document | audio | cache |
 *   | -------- | ----- | ----- | -------- | ----- | ----- |
 *   | anthropic | claude-opus-4-7 | ✓ | ✓ |   | ✓ |
 *
 * Truthy markers (`✓`, `Y`, `yes`, `true`) → true; everything else → false.
 */
function parseDocsCacheColumn(): Map<string, boolean> {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const md = readFileSync(join(repoRoot, "docs", "agent-yaml.md"), "utf-8");
  const lines = md.split(/\r?\n/);

  const headerIdx = lines.findIndex((l) =>
    /^\|\s*Provider\s*\|\s*Model\s*\|\s*image\s*\|\s*document\s*\|\s*audio\s*\|\s*cache\s*\|/i.test(
      l,
    ),
  );
  if (headerIdx < 0) {
    throw new Error(
      "docs/agent-yaml.md: capability matrix `cache` column header not found (Task 7.2 must land it before un-skipping VT-13)",
    );
  }

  const TRUTHY = new Set(["✓", "y", "yes", "true", "✔"]);
  const result = new Map<string, boolean>();
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim());
    // Layout: ["", provider, models, image, document, audio, cache, ""]
    if (cells.length < 7) continue;
    const provider = cells[1];
    const modelsCell = cells[2];
    const cacheCell = cells[6]?.toLowerCase() ?? "";
    if (!provider || !modelsCell) continue;
    const cacheBool = TRUTHY.has(cacheCell);
    const ids = modelsCell
      .split(" / ")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      result.set(`${provider}/${id}`, cacheBool);
    }
  }
  return result;
}

describe("validateAgentCapabilities", () => {
  it("returns {ok:true} when no file inputs are declared", () => {
    const config = makeAgentConfig({});
    const result = validateAgentCapabilities(config);
    expect(result).toEqual({ ok: true } satisfies CapabilityValidationOutcome);
  });

  it("returns {ok:true} when primary model supports all declared file media", () => {
    const config = makeAgentConfig({
      model: { provider: "anthropic", name: "claude-3-7-sonnet" },
      inputs: [{ name: "photo", type: "file", media: "image", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok:false} when primary model lacks audio support (Claude + audio)", () => {
    const config = makeAgentConfig({
      model: { provider: "anthropic", name: "claude-3-7-sonnet" },
      inputs: [{ name: "voice", type: "file", media: "audio", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("voice");
      expect(result.errors[0]).toContain("audio");
      expect(result.errors[0]).toContain("anthropic/claude-3-7-sonnet");
      expect(result.errors[0]).toContain("primary");
    }
  });

  it("checks fallback model independently of primary", () => {
    const config = makeAgentConfig({
      model: {
        provider: "google",
        name: "gemini-2.5-flash",
        fallback: { provider: "anthropic", name: "claude-3-7-sonnet" },
      },
      inputs: [{ name: "voice", type: "file", media: "audio", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("fallback");
      expect(result.errors[0]).toContain("anthropic/claude-3-7-sonnet");
    }
  });

  it("reports both primary and fallback failures distinctly", () => {
    const config = makeAgentConfig({
      model: {
        provider: "mistral",
        name: "mistral-large-3",
        fallback: { provider: "groq", name: "llama-4-scout-17b-16e-instruct" },
      },
      inputs: [{ name: "doc", type: "file", media: "document", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors.some((e) => e.includes("primary") && e.includes("mistral"))).toBe(true);
      expect(result.errors.some((e) => e.includes("fallback") && e.includes("groq"))).toBe(true);
    }
  });

  it("returns {ok:true} for unknown provider+model (self-hosted bypass)", () => {
    const config = makeAgentConfig({
      model: { provider: "meta", name: "llama-99-self-hosted", base_url: "http://localhost:8080" },
      inputs: [{ name: "voice", type: "file", media: "audio", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result).toEqual({ ok: true });
  });
});
