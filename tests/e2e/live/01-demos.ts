/**
 * Phase 01 — demo agents end-to-end against a real LLM.
 *
 * Pushes each demo to the dev/ namespace, runs it, asserts the output shape.
 * seo-audit also exercises the stateful KV path with a second run that must
 * remember the prior score.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { postRun, REGISTRY, ROOT, results, TOKEN, testAgent } from "./_ctx.js";

export async function run(): Promise<void> {
  console.log("Testing code-review...");
  await testAgent(
    "code-review",
    "Real file review",
    {
      code: readFileSync(join(ROOT, "packages/runtime/src/llm/router.ts"), "utf-8").slice(0, 2000),
    },
    (res) => {
      if (res.status !== "completed") return `Expected completed, got ${res.status}`;
      const output = res.output as Record<string, unknown>;
      if (typeof output?.score !== "number") return "Missing score in output";
      return null;
    },
  );

  console.log("Testing pdf-processing...");
  {
    // pdf-processing v1.1.0+ is vision-native: it expects a `pdf: file/document`
    // input, not the legacy `{task, content}` strings. Upload tests/fixtures/sample.pdf
    // and pass it as a file_id reference per the multimodal wire format.
    const pdfBytes = readFileSync(join(ROOT, "tests/fixtures/sample.pdf"));
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }),
      "sample.pdf",
    );
    const uploadRes = await fetch(`${REGISTRY}/api/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });
    if (!uploadRes.ok) {
      throw new Error(`pdf-processing fixture upload failed: ${uploadRes.status}`);
    }
    const { file_id: pdfFileId } = (await uploadRes.json()) as { file_id: string };

    await testAgent(
      "pdf-processing",
      "Document extraction (vision)",
      {
        pdf: [{ type: "file", source: "id", file_id: pdfFileId }],
        task: "extract",
      },
      (res) => {
        if (res.status !== "completed") return `Expected completed, got ${res.status}`;
        return null;
      },
    );
  }

  console.log("Testing data-analyst...");
  await testAgent(
    "data-analyst",
    "Typed I/O (CSV)",
    {
      data: "month,revenue\nJan,10000\nFeb,12000\nMar,15000",
      format: "csv",
      question: "Revenue trend?",
    },
    (res) => {
      if (res.status !== "completed") return `Expected completed, got ${res.status}`;
      const output = res.output as Record<string, unknown>;
      if (!output?.analysis) return "Missing analysis in output";
      return null;
    },
  );

  console.log("Testing seo-audit (run 1 — first audit)...");
  await testAgent(
    "seo-audit",
    "State — first audit",
    { website_url: "https://example.com" },
    (res) => {
      if (res.status !== "completed") return `Expected completed, got ${res.status}`;
      const output = res.output as Record<string, unknown>;
      if (typeof output?.score !== "number") return "Missing score";
      return null;
    },
  );

  // seo-audit run 2 — must remember!
  // Need to push again (same version conflict — use a trick: different version)
  console.log("Testing seo-audit (run 2 — should remember)...");
  const seoDir = join(ROOT, "agents/seo-audit");
  const _seoOriginal = readFileSync(join(seoDir, "agent.yaml"), "utf-8");
  // Already pushed from run 1, just call /run again
  const seoRes2 = await postRun("dev", "seo-audit", { website_url: "https://example.com" });
  const seoOutput2 = seoRes2.output as Record<string, unknown>;
  results.push({
    agent: "seo-audit",
    feature: "State — remembers previous",
    passed:
      seoRes2.status === "completed" &&
      typeof seoOutput2?.previous_score === "number" &&
      (seoOutput2?.previous_score as number) > 0,
    duration: (seoRes2.duration_ms as number) ?? 0,
    cost: ((seoRes2.cost as Record<string, number>)?.estimated as number) ?? 0,
    detail: `score=${seoOutput2?.score}, previous=${seoOutput2?.previous_score}, trend=${seoOutput2?.trend}`,
  });

  console.log("Testing email-drafter...");
  await testAgent(
    "email-drafter",
    "Business email",
    { context: "Follow up on proposal", tone: "formal", recipient: "VP Engineering" },
    (res) => {
      if (res.status !== "completed") return `Expected completed, got ${res.status}`;
      const output = res.output as Record<string, unknown>;
      if (!output?.subject) return "Missing subject";
      if (!output?.body) return "Missing body";
      return null;
    },
  );

  console.log("Testing web-scraper (Playwright MCP)...");
  await testAgent(
    "web-scraper",
    "MCP — headless browser",
    { url: "https://example.com", question: "What is this page about?" },
    (res) => {
      if (res.status !== "completed") return `Expected completed, got ${res.status}`;
      return null;
    },
  );
}
