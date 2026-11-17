import { describe, expect, it } from "vitest";
import { getModelCapabilities, MODEL_CAPABILITIES } from "../capability.js";
import * as schema from "../index.js";
import { findRetiredModels, RETIRED_MODELS, type RetiredModel } from "./retired-models.js";

type Input = "image" | "document" | "audio";

const LIST: RetiredModel[] = [
  {
    provider: "openai",
    id: "gpt-witness-old",
    retiredOn: "2026-05-07",
    replacement: "gpt-witness-new",
  },
  {
    provider: "openai",
    id: "gpt-witness-soon",
    retiredOn: "2026-10-23",
    replacement: "gpt-witness-new",
  },
  { provider: "groq", id: "witness/compound", retiredOn: "2026-09-21" },
  {
    provider: "groq",
    id: "witness-llama-70b",
    retiredOn: "2026-08-16",
    replacement: "openai/gpt-oss-120b",
    note: "on its free and developer tiers",
  },
  {
    provider: "xai",
    id: "grok-witness-redirected",
    retiredOn: "2026-05-15",
    replacement: "grok-witness-current",
    redirectsTo: "grok-witness-current",
  },
  {
    provider: "xai",
    id: "grok-witness-redirecting",
    retiredOn: "2026-11-02",
    replacement: "grok-witness-current",
    redirectsTo: "grok-witness-current",
  },
];
const TODAY = "2026-10-05";

const on = (provider: string, name: string) =>
  ({ model: { provider, name } }) as Parameters<typeof findRetiredModels>[0];

describe("findRetiredModels", () => {
  it("names a retired model, the day it was retired and its replacement", () => {
    expect(findRetiredModels(on("openai", "gpt-witness-old"), LIST, TODAY)).toEqual([
      {
        code: "MODEL_RETIRED",
        file: "agent.yaml",
        field: "model.name",
        message:
          "model openai/gpt-witness-old was retired by its provider on 2026-05-07: a call to it fails — use openai/gpt-witness-new instead.",
      },
    ]);
  });

  it("says a retirement still to come is to come", () => {
    const [issue] = findRetiredModels(on("openai", "gpt-witness-soon"), LIST, TODAY);
    expect(issue?.message).toBe(
      "model openai/gpt-witness-soon retires on 2026-10-23: from that day, a call to it fails — use openai/gpt-witness-new instead.",
    );
  });

  // Out of the catalog before its day, as models.dev marks it deprecated:
  // the list warns from now, and no row of the matrix is left to price or
  // flag it.
  it.each([
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
  ])("warns that anthropic/%s retires on 2026-11-30, for claude-sonnet-5-5", (id) => {
    const [issue] = findRetiredModels(on("anthropic", id), RETIRED_MODELS, "2026-11-17");
    expect(issue?.message).toBe(
      `model anthropic/${id} retires on 2026-11-30: from that day, a call to it fails — use anthropic/claude-sonnet-5-5 instead.`,
    );
    expect(getModelCapabilities("anthropic", id)).toBeUndefined();
  });

  it("says retired on the day itself", () => {
    const [issue] = findRetiredModels(on("openai", "gpt-witness-soon"), LIST, "2026-10-23");
    expect(issue?.message).toContain("was retired by its provider on 2026-10-23");
  });

  it("names the fallback, by its own field, when it is the one retired", () => {
    const config = {
      model: {
        provider: "openai",
        name: "gpt-witness-new",
        fallback: { provider: "openai", name: "gpt-witness-old" },
      },
    } as Parameters<typeof findRetiredModels>[0];
    const issues = findRetiredModels(config, LIST, TODAY);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("model.fallback.name");
    expect(issues[0]?.message).toMatch(/^fallback model openai\/gpt-witness-old /);
  });

  it("warns on both when the model and its fallback are retired", () => {
    const config = {
      model: {
        provider: "openai",
        name: "gpt-witness-old",
        fallback: { provider: "openai", name: "gpt-witness-soon" },
      },
    } as Parameters<typeof findRetiredModels>[0];
    expect(findRetiredModels(config, LIST, TODAY).map((i) => i.field)).toEqual([
      "model.name",
      "model.fallback.name",
    ]);
  });

  it("matches the exact id only: a model that extends a retired id is not warned", () => {
    for (const name of ["gpt-witness-old-mini", "gpt-witness-old-2026-01-01", "gpt-witness"]) {
      expect(findRetiredModels(on("openai", name), LIST, TODAY), name).toEqual([]);
    }
  });

  it("matches the provider too: the same id under another provider is not warned", () => {
    expect(findRetiredModels(on("groq", "gpt-witness-old"), LIST, TODAY)).toEqual([]);
  });

  it("says when no replacement is named", () => {
    const [issue] = findRetiredModels(on("groq", "witness/compound"), LIST, TODAY);
    expect(issue?.message).toBe(
      "model groq/witness/compound was retired by its provider on 2026-09-21: a call to it fails — no replacement named: pick a current model.",
    );
  });

  it("carries the note after the day", () => {
    const [issue] = findRetiredModels(on("groq", "witness-llama-70b"), LIST, TODAY);
    expect(issue?.message).toBe(
      "model groq/witness-llama-70b was retired by its provider on 2026-08-16 (on its free and developer tiers): a call to it fails — use groq/openai/gpt-oss-120b instead.",
    );
  });

  it("says which model a redirected id now runs, at whose price, and never that a call fails", () => {
    const [issue] = findRetiredModels(on("xai", "grok-witness-redirected"), LIST, TODAY);
    expect(issue?.message).not.toContain("fails");
    expect(issue?.message).toBe(
      "model xai/grok-witness-redirected was retired by its provider on 2026-05-15: the provider now serves it as xai/grok-witness-current, at that model's price — use xai/grok-witness-current instead.",
    );
  });

  it("says a redirect still to come is to come", () => {
    const [issue] = findRetiredModels(on("xai", "grok-witness-redirecting"), LIST, TODAY);
    expect(issue?.message).not.toContain("fails");
    expect(issue?.message).toBe(
      "model xai/grok-witness-redirecting retires on 2026-11-02: from that day, the provider serves it as xai/grok-witness-current, at that model's price — use xai/grok-witness-current instead.",
    );
  });
});

describe("RETIRED_MODELS", () => {
  it("names each model once, by an exact id, with a day", () => {
    const keys = RETIRED_MODELS.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of RETIRED_MODELS) {
      expect(m.id, m.id).toMatch(/^\S+$/);
      expect(m.retiredOn, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${m.retiredOn}T00:00:00Z`)), m.id).toBe(false);
    }
  });

  it("recommends no model that is itself on the list", () => {
    const listed = new Set(RETIRED_MODELS.map((m) => `${m.provider}/${m.id}`));
    for (const m of RETIRED_MODELS) {
      if (m.replacement === undefined) continue;
      expect(m.replacement, m.id).not.toBe(m.id);
      expect(listed.has(`${m.provider}/${m.replacement}`), `${m.id} → ${m.replacement}`).toBe(
        false,
      );
    }
  });

  // The inputs beyond text that the capability matrix gives, or gave, each
  // retired id through a row of its own model: a row for the id itself, for
  // the id it is a dated form of (gpt-4o for gpt-4o-2024-08-06), or for the
  // family that covered it. A model that took text only is left out, as is
  // an id that only ever fell under another model's row by prefix
  // (gpt-4o-mini-audio-preview under gpt-4o-mini).
  const took = (inputs: readonly Input[], ids: readonly string[]) =>
    Object.fromEntries(ids.map((id) => [id, inputs]));
  const TOOK: Record<string, readonly Input[]> = {
    ...took(
      ["image", "document"],
      [
        "anthropic/claude-sonnet-4-20250514",
        "anthropic/claude-sonnet-4-0",
        "anthropic/claude-opus-4-20250514",
        "anthropic/claude-opus-4-0",
        "anthropic/claude-3-7-sonnet-20250219",
        "anthropic/claude-3-5-sonnet-20241022",
        "anthropic/claude-3-5-sonnet-20240620",
        "anthropic/claude-3-5-sonnet-latest",
        "anthropic/claude-3-5-haiku-20241022",
        "anthropic/claude-3-opus-20240229",
        "anthropic/claude-opus-4-1-20250805",
        "anthropic/claude-opus-4-1",
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-sonnet-4-5-20250929",
        // Dated forms of gpt-4o and gpt-4o-mini, under those rows.
        "openai/gpt-4o-2024-05-13",
        "openai/gpt-4o-2024-08-06",
        "openai/gpt-4o-2024-11-20",
        "openai/gpt-4o-mini-2024-07-18",
        // Dated forms of gpt-5, gpt-5-mini, gpt-5-nano and gpt-5.4-nano,
        // under those rows.
        "openai/gpt-5-2025-08-07",
        "openai/gpt-5-mini-2025-08-07",
        "openai/gpt-5-nano-2025-08-07",
        "openai/gpt-5.4-nano-2026-03-17",
        // gpt-5-pro and gpt-5.3-codex had rows of their own until the
        // catalog dropped the models the Responses API alone serves.
        "openai/gpt-5-pro",
        "openai/gpt-5-pro-2025-10-06",
        "openai/gpt-5.3-codex",
      ],
    ),
    ...took(
      ["image"],
      [
        "anthropic/claude-3-haiku-20240307",
        "openai/o1",
        "openai/o1-2024-12-17",
        "openai/gpt-4-turbo",
        "openai/gpt-4-turbo-2024-04-09",
        "mistral/mistral-medium-2508",
        "mistral/mistral-small-2506",
        "mistral/pixtral-large-2411",
        "mistral/pixtral-large-latest",
        "mistral/pixtral-12b-2409",
        "mistral/pixtral-12b",
        "groq/meta-llama/llama-4-scout-17b-16e-instruct",
        "groq/llama-3.2-90b-vision-preview",
        "groq/llama-3.2-11b-vision-preview",
      ],
    ),
    ...took(
      ["image", "document", "audio"],
      [
        "google/gemini-3.1-flash-lite-preview",
        "google/gemini-3.7-flash",
        "google/gemini-3.5-flash",
        // A key of the matrix, under that id, until the 3.x ids took their
        // `-preview` suffix.
        "google/gemini-3.1-flash-lite",
        // Previews of Gemini 2.5 Pro, Flash and Flash-Lite, under those rows.
        "google/gemini-2.5-pro-preview-03-25",
        "google/gemini-2.5-pro-preview-05-06",
        "google/gemini-2.5-pro-preview-06-05",
        "google/gemini-2.5-flash-preview-05-20",
        "google/gemini-2.5-flash-preview-09-25",
        "google/gemini-2.5-flash-lite-preview-09-2025",
      ],
    ),
    ...took(
      ["audio"],
      [
        "openai/gpt-audio",
        "openai/gpt-audio-2025-08-28",
        "openai/gpt-4o-audio-preview",
        "openai/gpt-4o-audio-preview-2025-06-03",
        "openai/gpt-4o-audio-preview-2024-12-17",
      ],
    ),
  };

  it("recommends a model of the capability matrix that takes every input the retired one took — or none, and says why", () => {
    const listed = RETIRED_MODELS.map((m) => `${m.provider}/${m.id}`);
    for (const id of Object.keys(TOOK)) {
      expect(listed, `${id} has inputs here but is not on the list`).toContain(id);
    }
    const problems: string[] = [];
    for (const m of RETIRED_MODELS) {
      const key = `${m.provider}/${m.id}`;
      const inputs = TOOK[key] ?? [];
      if (m.replacement === undefined) {
        if (inputs.length > 0 && m.note === undefined) {
          problems.push(`${key}: no replacement, and no note saying why`);
        }
        continue;
      }
      const caps = getModelCapabilities(m.provider, m.replacement);
      if (caps === undefined) {
        problems.push(`${key} → ${m.replacement}: no row of the capability matrix`);
        continue;
      }
      for (const input of inputs) {
        if (!caps[input]) problems.push(`${key} took ${input}; ${m.replacement} does not`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("redirects an id only to a model of its provider that is not on the list itself", () => {
    const listed = new Set(RETIRED_MODELS.map((m) => `${m.provider}/${m.id}`));
    for (const m of RETIRED_MODELS) {
      if (m.redirectsTo === undefined) continue;
      expect(m.redirectsTo, m.id).toMatch(/^\S+$/);
      expect(m.redirectsTo, m.id).not.toBe(m.id);
      expect(listed.has(`${m.provider}/${m.redirectsTo}`), `${m.id} → ${m.redirectsTo}`).toBe(
        false,
      );
    }
  });

  // A retired id that extends a key of the capability matrix takes that key's
  // row — its flags, and the inputs it is refused — until the day it retires.
  // Pinned id by id, so that a change of what an entry resolves to shows here:
  // a row added, removed or renamed in the matrix, or an entry added.
  it("resolves each id to no row of the capability matrix, except the ones pinned here", () => {
    const takesARow: Record<string, string> = {
      "openai/gpt-4o-audio-preview": "gpt-4o",
      "openai/gpt-4o-audio-preview-2025-06-03": "gpt-4o",
      "openai/gpt-4o-audio-preview-2024-12-17": "gpt-4o",
      "openai/gpt-4o-mini-audio-preview": "gpt-4o-mini",
      "openai/gpt-4o-mini-audio-preview-2024-12-17": "gpt-4o-mini",
      "openai/gpt-4o-2024-05-13": "gpt-4o",
      "openai/gpt-4o-2024-08-06": "gpt-4o",
      "openai/gpt-4o-2024-11-20": "gpt-4o",
      "openai/gpt-4o-mini-2024-07-18": "gpt-4o-mini",
      "openai/gpt-5-2025-08-07": "gpt-5",
      "openai/gpt-5-mini-2025-08-07": "gpt-5-mini",
      "openai/gpt-5-nano-2025-08-07": "gpt-5-nano",
      "openai/gpt-5-pro": "gpt-5",
      "openai/gpt-5-pro-2025-10-06": "gpt-5",
      "openai/gpt-5.4-nano-2026-03-17": "gpt-5.4-nano",
      "google/gemini-2.5-pro-preview-03-25": "gemini-2.5-pro",
      "google/gemini-2.5-pro-preview-05-06": "gemini-2.5-pro",
      "google/gemini-2.5-pro-preview-06-05": "gemini-2.5-pro",
      "google/gemini-2.5-flash-preview-05-20": "gemini-2.5-flash",
      "google/gemini-2.5-flash-preview-09-25": "gemini-2.5-flash",
      "google/gemini-2.5-flash-lite-preview-09-2025": "gemini-2.5-flash-lite",
    };
    const rowOf = (m: RetiredModel): string | null => {
      const caps = getModelCapabilities(m.provider, m.id);
      if (caps === undefined) return null;
      const row = Object.entries(MODEL_CAPABILITIES[m.provider]).find(([, c]) => c === caps);
      return row?.[0] ?? "(a row the matrix does not list)";
    };
    const listed = RETIRED_MODELS.map((m) => `${m.provider}/${m.id}`);
    for (const pinned of Object.keys(takesARow)) {
      expect(listed, `${pinned} is pinned but not on the list`).toContain(pinned);
    }
    expect(
      Object.fromEntries(RETIRED_MODELS.map((m) => [`${m.provider}/${m.id}`, rowOf(m)])),
    ).toEqual(Object.fromEntries(listed.map((id) => [id, takesARow[id] ?? null])));
  });

  it("is exported by the package entry point, with its lookup", () => {
    expect(schema.RETIRED_MODELS).toBe(RETIRED_MODELS);
    expect(schema.findRetiredModels).toBe(findRetiredModels);
  });
});
