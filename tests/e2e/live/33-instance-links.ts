/**
 * Phase 33 — the instance's links, as the dashboard reads them, on the live
 * registry.
 *
 * `GET /api/instance` answers any credential with `{ links: { docs, terms,
 * privacy } }`: `docs` a non-empty string (`/docs` when the operator sets no
 * docs address), `terms` and `privacy` each a non-empty string or `null` when
 * not set. A request with no credential gets `401`. The registry runs on
 * whatever the suite's environment sets, so the phase asserts the shape, never
 * the values, and prints all three in its PASS line. It pushes nothing and
 * calls no model.
 */

import { REGISTRY, results, TOKEN } from "./_ctx.js";

const FEATURE = "GET /api/instance serves the instance's links, and 401 with no credential";

/** A link as the route serves it: a non-empty string — or, for terms and privacy, `null`. */
function isLink(value: unknown, nullable: boolean): boolean {
  if (typeof value === "string") return value.length > 0;
  return nullable && value === null;
}

export async function run(): Promise<void> {
  console.log("Testing GET /api/instance...");
  const start = Date.now();
  try {
    const res = await fetch(`${REGISTRY}/api/instance`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { links?: Record<string, unknown> };
    const links = body.links ?? {};
    const keys = Object.keys(links).sort().join(",");

    const anonymous = await fetch(`${REGISTRY}/api/instance`);
    await anonymous.text();

    const passed =
      res.status === 200 &&
      keys === "docs,privacy,terms" &&
      isLink(links.docs, false) &&
      isLink(links.terms, true) &&
      isLink(links.privacy, true) &&
      anonymous.status === 401;
    results.push({
      agent: "instance",
      feature: FEATURE,
      passed,
      duration: Date.now() - start,
      cost: 0,
      detail:
        `status=${res.status} anonymous=${anonymous.status} keys=${keys} ` +
        `docs=${JSON.stringify(links.docs)} terms=${JSON.stringify(links.terms)} ` +
        `privacy=${JSON.stringify(links.privacy)}`,
    });
  } catch (err) {
    results.push({
      agent: "instance",
      feature: FEATURE,
      passed: false,
      duration: Date.now() - start,
      cost: 0,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
