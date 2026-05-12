/**
 * Phase 11 — multimodal direct router calls + receipts-to-expenses end-to-end (#56).
 *
 * VT-25..28 bypass the registry/run flow and call LLMRouter directly with
 * SkrunPart[] userContent — testing provider translation (Skrun → Anthropic
 * content blocks / OpenAI input_image,_file,_audio / Gemini parts) on real
 * LLMs. Cheaper + faster than full registry tests since we skip bundle
 * build/push.
 *
 * VT-29 is the full /run flow with 3 receipt JPEGs uploaded via POST
 * /api/files, file_id refs in the input — asserts xlsx + pdf produced and
 * total_amount > 0.
 *
 * Each scenario is gated on the matching provider API key.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, ROOT, results, skrun, TOKEN } from "./_ctx.js";

/** Best-effort delete of dev/<slug>@<version>. 204/404 OK; anything else logs warn. Per #77. */
async function cleanupVersion(agentSlug: string, version: string): Promise<void> {
  try {
    const res = await fetch(`${REGISTRY}/api/agents/dev/${agentSlug}/versions/${version}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status !== 204 && res.status !== 404) {
      console.warn(
        `cleanup: unexpected ${res.status} deleting dev/${agentSlug}/versions/${version}`,
      );
    }
  } catch (err) {
    console.warn(
      `cleanup: error deleting dev/${agentSlug}/versions/${version}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function testMultimodalDirect(
  agentLabel: string,
  feature: string,
  modelConfig: { provider: string; name: string },
  userContent: Array<
    | { kind: "text"; text: string }
    | { kind: "image" | "document" | "audio"; media_type: string; bytes: Uint8Array }
  >,
  expectedKeyword: string,
): Promise<void> {
  const start = Date.now();
  try {
    const { LLMRouter } = await import("../../../packages/runtime/dist/index.js");
    const router = new LLMRouter();
    const result = (await router.call(
      modelConfig as Parameters<typeof router.call>[0],
      "You are a helpful assistant. Answer concisely.",
      userContent as Parameters<typeof router.call>[2],
    )) as { content: string; estimatedCost: number };

    const passed = result.content.toLowerCase().includes(expectedKeyword.toLowerCase());
    results.push({
      agent: agentLabel,
      feature,
      passed,
      duration: Date.now() - start,
      cost: result.estimatedCost ?? 0,
      detail: passed
        ? `expected="${expectedKeyword}" found in: "${result.content.slice(0, 100).replace(/\n/g, " ")}..."`
        : `expected "${expectedKeyword}" NOT in: "${result.content.slice(0, 200).replace(/\n/g, " ")}"`,
    });
  } catch (err) {
    results.push({
      agent: agentLabel,
      feature,
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function uploadReceiptFile(filename: string): Promise<string> {
  const path = join(ROOT, "agents/receipts-to-expenses/fixtures/sample-receipts", filename);
  const bytes = readFileSync(path);
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), filename);
  const res = await fetch(`${REGISTRY}/api/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`Upload failed for ${filename}: ${res.status}`);
  const body = (await res.json()) as { file_id: string };
  return body.file_id;
}

export async function run(): Promise<void> {
  // VT-25: Anthropic vision (sample-image.jpg → describes a cat)
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Testing VT-25 Anthropic vision...");
    const imageBytes = readFileSync(join(ROOT, "tests/fixtures/sample-image.jpg"));
    await testMultimodalDirect(
      "#56-vt25",
      "Anthropic vision (sample-image.jpg)",
      { provider: "anthropic", name: "claude-3-5-sonnet-latest" },
      [
        { kind: "text", text: "What animal is in this image? Answer in one word." },
        {
          kind: "image",
          media_type: "image/jpeg",
          bytes: new Uint8Array(imageBytes),
        },
      ],
      "cat",
    );
  } else {
    console.log("Skipping VT-25: ANTHROPIC_API_KEY not set");
  }

  // VT-26: OpenAI vision
  if (process.env.OPENAI_API_KEY) {
    console.log("Testing VT-26 OpenAI vision...");
    const imageBytes = readFileSync(join(ROOT, "tests/fixtures/sample-image.jpg"));
    await testMultimodalDirect(
      "#56-vt26",
      "OpenAI vision (sample-image.jpg)",
      { provider: "openai", name: "gpt-4o-mini" },
      [
        { kind: "text", text: "What animal is in this image? Answer in one word." },
        {
          kind: "image",
          media_type: "image/jpeg",
          bytes: new Uint8Array(imageBytes),
        },
      ],
      "cat",
    );
  } else {
    console.log("Skipping VT-26: OPENAI_API_KEY not set");
  }

  // VT-27: Gemini PDF (3-page document with sentinel "TROPICAL_BANANA_2026" on page 2)
  if (process.env.GOOGLE_API_KEY) {
    console.log("Testing VT-27 Gemini PDF...");
    const pdfBytes = readFileSync(join(ROOT, "tests/fixtures/sample.pdf"));
    await testMultimodalDirect(
      "#56-vt27",
      "Gemini PDF (sample.pdf)",
      { provider: "google", name: "gemini-2.5-flash" },
      [
        {
          kind: "text",
          text: "What is the unique passphrase mentioned in this document? Answer with just the passphrase.",
        },
        {
          kind: "document",
          media_type: "application/pdf",
          bytes: new Uint8Array(pdfBytes),
        },
      ],
      "TROPICAL_BANANA_2026",
    );
  } else {
    console.log("Skipping VT-27: GOOGLE_API_KEY not set");
  }

  // VT-28: Gemini audio (~20s WAV with TTS saying "PINEAPPLE-ATLAS-2026")
  if (process.env.GOOGLE_API_KEY) {
    console.log("Testing VT-28 Gemini audio...");
    const wavBytes = readFileSync(join(ROOT, "tests/fixtures/sample.wav"));
    await testMultimodalDirect(
      "#56-vt28",
      "Gemini audio (sample.wav)",
      { provider: "google", name: "gemini-2.5-flash" },
      [
        {
          kind: "text",
          text: "What is the audio keyword mentioned in this recording? Answer with just the keyword.",
        },
        {
          kind: "audio",
          media_type: "audio/wav",
          bytes: new Uint8Array(wavBytes),
        },
      ],
      "PINEAPPLE",
    );
  } else {
    console.log("Skipping VT-28: GOOGLE_API_KEY not set");
  }

  // VT-29: receipts-to-expenses v0.2.0 — full /run flow with 3 receipt JPEGs.
  // Pushes the agent, uploads each receipt via POST /api/files, then runs with
  // the file_id refs. Asserts xlsx + pdf produced and total_amount > 0.
  if (process.env.GOOGLE_API_KEY) {
    console.log("Testing VT-29 receipts-to-expenses v0.2.0 end-to-end...");
    const start = Date.now();
    const dir = join(ROOT, "agents/receipts-to-expenses");
    const yamlPath = join(dir, "agent.yaml");
    const originalYaml = readFileSync(yamlPath, "utf-8");
    const stableVersion = "9.9.9";

    // DELETE-first per #77: clean slate before push (handles bundle content changes
    // across runs — the legacy "force 9.9.99 + ignore 409" pattern silently used
    // stale content if the bundle changed).
    await cleanupVersion("receipts-to-expenses", stableVersion);

    const patched = originalYaml.replace(/^version: .+$/m, `version: ${stableVersion}`);
    writeFileSync(yamlPath, patched, "utf-8");

    try {
      skrun(["build"], dir);
      skrun(["push"], dir);

      // Upload 3 receipt images
      const fileIds = await Promise.all([
        uploadReceiptFile("01-restaurant.jpg"),
        uploadReceiptFile("02-uber.jpg"),
        uploadReceiptFile("03-saas.jpg"),
      ]);

      // Run with file_id references
      const runRes = await fetch(`${REGISTRY}/api/agents/dev/receipts-to-expenses/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            receipts: fileIds.map((id) => ({ type: "file", source: "id", file_id: id })),
            month: "2026-04",
          },
        }),
      });
      const runBody = (await runRes.json()) as Record<string, unknown>;
      const output = (runBody.output ?? {}) as Record<string, unknown>;
      const total = output.total_amount as number | undefined;
      const xlsxPath = output.expenses_xlsx_path as string | undefined;
      const pdfPath = output.summary_pdf_path as string | undefined;
      const receiptCount = output.receipt_count as number | undefined;

      let detail = "";
      let passed = false;
      if (runBody.status !== "completed") {
        detail = `status=${runBody.status}, error=${(runBody.error as { message?: string })?.message ?? "unknown"}`;
      } else if (!xlsxPath || !pdfPath) {
        detail = `missing artifacts: xlsx=${xlsxPath}, pdf=${pdfPath}`;
      } else if (typeof total !== "number" || total <= 0) {
        detail = `expected total_amount > 0, got ${total}`;
      } else if (receiptCount !== 3) {
        detail = `expected receipt_count=3, got ${receiptCount}`;
      } else {
        passed = true;
        detail = `total=${total}, count=${receiptCount}, xlsx=${xlsxPath}, pdf=${pdfPath}`;
      }

      results.push({
        agent: "#56-vt29",
        feature: "receipts-to-expenses v0.2.0 end-to-end",
        passed,
        duration: Date.now() - start,
        cost: ((runBody.cost as Record<string, number>)?.estimated as number) ?? 0,
        detail,
      });
    } catch (err) {
      results.push({
        agent: "#56-vt29",
        feature: "receipts-to-expenses v0.2.0 end-to-end",
        passed: false,
        duration: Date.now() - start,
        cost: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      writeFileSync(yamlPath, originalYaml, "utf-8");
      await cleanupVersion("receipts-to-expenses", stableVersion);
    }
  } else {
    console.log("Skipping VT-29: GOOGLE_API_KEY not set");
  }
}
