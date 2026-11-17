import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptsTemperature,
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
    name: "test-agent",
    version: "0.1.0",
    model: { provider: "anthropic", name: "claude-sonnet-5-5" },
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
  it("returns the matrix entry for an exact match (claude-sonnet-4-6)", () => {
    const caps = getModelCapabilities("anthropic", "claude-sonnet-4-6");
    expect(caps).toEqual({
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
    } satisfies ModelCapabilities);
  });

  it("returns capabilities for a versioned model name via longest-prefix match", () => {
    const caps = getModelCapabilities("anthropic", "claude-haiku-4-5-20251001");
    expect(caps).toEqual({
      image: true,
      document: true,
      audio: false,
      caching: true,
      temperature: true,
    });
  });

  it("returns capabilities for Gemini (full multimodal)", () => {
    const caps = getModelCapabilities("google", "gemini-2.5-flash");
    expect(caps).toEqual({
      image: true,
      document: true,
      audio: true,
      caching: true,
      temperature: true,
    });
  });

  it("returns audio-only for gpt-audio-1.5, with no caching (no cached-input rate)", () => {
    const caps = getModelCapabilities("openai", "gpt-audio-1.5");
    expect(caps).toEqual({
      image: false,
      document: false,
      audio: true,
      caching: false,
      temperature: true,
    });
  });

  it("returns image-only for Mistral Large 3 by its dated id (caching=true: prompt_cache_key)", () => {
    const caps = getModelCapabilities("mistral", "mistral-large-2512");
    expect(caps).toEqual({
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    });
  });

  it("returns image-only for xAI grok-4.3 (caching=true: implicit + x-grok-conv-id)", () => {
    const caps = getModelCapabilities("xai", "grok-4.3");
    expect(caps).toEqual({
      image: true,
      document: false,
      audio: false,
      caching: true,
      temperature: true,
    });
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
    expect(MODEL_CAPABILITIES.anthropic["claude-sonnet-5-5"]).toBeDefined();
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
    ["openai", "gpt-4o-2024-08-06", "gpt-4o"],
    ["google", "gemini-3.1-pro-preview-002", "gemini-3.1-pro-preview"],
    ["google", "gemini-3-flash-preview-001", "gemini-3-flash-preview"],
    ["mistral", "mistral-medium-2604-01", "mistral-medium-2604"],
    ["xai", "grok-4.3-2026-04", "grok-4.3"],
    ["anthropic", "claude-opus-4-5-20251101", "claude-opus-4-5"],
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
    // Retired, their row gone: no shorter key takes them either.
    ["anthropic", "claude-opus-4-20250514"], // its family key, claude-opus-4, is gone
    ["anthropic", "claude-3-7-sonnet-20250219"],
    ["anthropic", "claude-3-5-sonnet-latest"],
    ["google", "gemini-3.1-flash-lite-preview"],
    ["openai", "o1"],
    ["openai", "gpt-4-turbo"],
    ["openai", "gpt-audio"], // not gpt-audio-1.5: no key extends into another
    ["mistral", "mistral-large-3"], // a commercial name, not an API id
    ["groq", "llama-3.3-70b-versatile"],
    ["xai", "grok-4.1-fast"], // never an API id
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

  it("every MODEL_CAPABILITIES entry says whether the model accepts a temperature", () => {
    for (const [provider, models] of Object.entries(MODEL_CAPABILITIES)) {
      for (const [modelName, caps] of Object.entries(models)) {
        expect(typeof caps.temperature, `${provider}/${modelName}.temperature`).toBe("boolean");
      }
    }
  });

  it("the models whose provider refuses or ignores a temperature are marked, the others accept one", () => {
    const refusing = Object.entries(MODEL_CAPABILITIES).flatMap(([provider, models]) =>
      Object.entries(models).flatMap(([name, caps]) =>
        caps.temperature ? [] : [`${provider}/${name}`],
      ),
    );
    expect(refusing.sort()).toEqual(
      [
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-fable-5-2",
        "anthropic/claude-mythos-5-2",
        "anthropic/claude-fable-5-1",
        "anthropic/claude-mythos-5-1",
        "anthropic/claude-fable-5",
        "anthropic/claude-mythos-5",
        "anthropic/claude-opus-5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-4-8",
        "anthropic/claude-opus-4-7",
        "anthropic/claude-haiku-5-5",
        "google/gemini-4-argon",
        "google/gemini-3.8-flash",
        "google/gemini-3.6-flash",
        "openai/gpt-6.1-sol",
        "openai/gpt-6.1-terra",
        "openai/gpt-6-astra",
        "openai/gpt-6-sol",
        "openai/gpt-6-luna",
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-terra",
        "openai/gpt-5.6-luna",
        "openai/gpt-5.5",
        "openai/gpt-5",
        "openai/gpt-5-mini",
        "openai/gpt-5-nano",
      ].sort(),
    );
    // A dated id takes its base model's flag.
    expect(getModelCapabilities("anthropic", "claude-opus-4-7-20260416")?.temperature).toBe(false);
  });

  it("the models that refuse a forced tool choice are marked false, and no row says true", () => {
    const marked = Object.entries(MODEL_CAPABILITIES).flatMap(([provider, models]) =>
      Object.entries(models).flatMap(([name, caps]) => {
        if (!("forcedToolChoice" in caps)) return [];
        expect(caps.forcedToolChoice, `${provider}/${name}`).toBe(false);
        return [`${provider}/${name}`];
      }),
    );
    // The six Claude models Anthropic's page on thinking names: they reject
    // forced tool use on every request.
    expect(marked.sort()).toEqual(
      [
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-fable-5-2",
        "anthropic/claude-mythos-5-2",
        "anthropic/claude-fable-5-1",
        "anthropic/claude-mythos-5-1",
      ].sort(),
    );
  });

  // Claude Fable 5.2 and Mythos 5.2 extend claude-fable-5 and claude-mythos-5,
  // which accept a forced tool choice: without rows of their own they would
  // take those rows, and a forced choice would reach Anthropic, which answers
  // 400 on every request.
  it.each([
    "claude-fable-5-2",
    "claude-mythos-5-2",
  ])("%s resolves to a row that refuses a forced tool choice", (model) => {
    expect(getModelCapabilities("anthropic", model)?.forcedToolChoice).toBe(false);
  });

  // Mistral caches a repeated prefix on every model, and the adapter wires it
  // (prompt_cache_key, cached_tokens): every Mistral entry says so.
  it("all Mistral entries have caching=true", () => {
    for (const [modelName, caps] of Object.entries(MODEL_CAPABILITIES.mistral)) {
      expect(caps.caching, `mistral/${modelName}`).toBe(true);
    }
  });

  // Groq caches its `openai/gpt-oss-*` family, listed by Groq's own ids: the
  // only Groq models in the matrix, each caching=true.
  it("Groq lists its openai/gpt-oss-* family by Groq's ids, each with caching", () => {
    const groq = MODEL_CAPABILITIES.groq;
    expect(Object.keys(groq).sort()).toEqual(
      ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-safeguard-20b"].sort(),
    );
    for (const [name, caps] of Object.entries(groq)) {
      expect(caps.caching, `groq/${name}`).toBe(true);
    }
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

describe("acceptsTemperature", () => {
  it.each([
    ["anthropic", "claude-sonnet-4-6", true],
    ["anthropic", "claude-opus-4-7-20260416", false],
    ["google", "gemini-2.5-flash", true],
    ["google", "gemini-3.8-flash", false],
  ] as const)("a model the matrix lists takes its row's flag: %s/%s → %s", (provider, name, expected) => {
    expect(acceptsTemperature(provider, name)).toBe(expected);
    // Behind a declared base_url too: the row says what the model takes.
    expect(acceptsTemperature(provider, name, "https://llm.example.test/v1")).toBe(expected);
  });

  it.each([
    ["anthropic", "claude-unlisted-9", false],
    ["google", "gemini-9.9-flash", false],
    ["openai", "gpt-9-unlisted", false],
    ["mistral", "mistral-unlisted-9", true],
    ["groq", "groq-unlisted-9", true],
    ["xai", "grok-unlisted-9", true],
    ["meta", "llama-unlisted-9", true],
  ] as const)("a model the matrix does not list, at its provider's own API, takes its provider's default: %s/%s → %s", (provider, name, expected) => {
    expect(getModelCapabilities(provider, name)).toBeUndefined();
    expect(acceptsTemperature(provider, name)).toBe(expected);
  });

  it.each([
    ["anthropic", "llama3.1:8b"],
    ["google", "gemma3:4b"],
    ["openai", "qwen3:8b"],
  ] as const)("a model the matrix does not list, behind a declared base_url, gets it whatever the provider: %s/%s", (provider, name) => {
    expect(acceptsTemperature(provider, name, "http://localhost:11434/v1")).toBe(true);
  });
});

describe("validateAgentCapabilities", () => {
  it("returns {ok:true} when no file inputs are declared", () => {
    const config = makeAgentConfig({});
    const result = validateAgentCapabilities(config);
    expect(result).toEqual({ ok: true } satisfies CapabilityValidationOutcome);
  });

  it("returns {ok:true} when primary model supports all declared file media", () => {
    const config = makeAgentConfig({
      model: { provider: "anthropic", name: "claude-sonnet-5-5" },
      inputs: [{ name: "photo", type: "file", media: "image", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok:false} when primary model lacks audio support (Claude + audio)", () => {
    const config = makeAgentConfig({
      model: { provider: "anthropic", name: "claude-sonnet-5-5" },
      inputs: [{ name: "voice", type: "file", media: "audio", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("voice");
      expect(result.errors[0]).toContain("audio");
      expect(result.errors[0]).toContain("anthropic/claude-sonnet-5-5");
      expect(result.errors[0]).toContain("primary");
    }
  });

  it("checks fallback model independently of primary", () => {
    const config = makeAgentConfig({
      model: {
        provider: "google",
        name: "gemini-2.5-flash",
        fallback: { provider: "anthropic", name: "claude-sonnet-5-5" },
      },
      inputs: [{ name: "voice", type: "file", media: "audio", max_count: 1, required: true }],
    });
    const result = validateAgentCapabilities(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("fallback");
      expect(result.errors[0]).toContain("anthropic/claude-sonnet-5-5");
    }
  });

  it("reports both primary and fallback failures distinctly", () => {
    const config = makeAgentConfig({
      model: {
        provider: "mistral",
        name: "mistral-large-2512",
        fallback: { provider: "groq", name: "openai/gpt-oss-120b" },
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
