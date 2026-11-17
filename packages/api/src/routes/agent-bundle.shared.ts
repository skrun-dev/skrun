/**
 * Test-support module, not a test file: bundles a push accepts — a valid
 * `agent.yaml` and a `SKILL.md`, packed as the CLI packs them — for a test
 * that pushes a bundle without caring what it holds. A push refuses a bundle
 * that does not load; a test that means a run to meet such a bundle, as one
 * stored before that refusal can still be, writes it with `storeVersion`
 * (`stored-version.shared.ts`) instead.
 */
import { packAgentTar } from "@skrun-dev/schema";

/**
 * The `agent.yaml` of a minimal agent: one string input `q`, one string
 * output `answer`, and `extra` lines after them (an `environment:` block, say).
 */
export function minimalAgentYaml(name = "test-agent", extra: readonly string[] = []): string {
  return [
    `name: ${name}`,
    "version: 1.0.0",
    "model:",
    "  provider: anthropic",
    "  name: claude-sonnet-4-6",
    "inputs:",
    "  - name: q",
    "    type: string",
    "outputs:",
    "  - name: answer",
    "    type: string",
    ...extra,
  ].join("\n");
}

/**
 * `head` — a minimal agent's `agent.yaml` by default — weighing exactly `bytes`
 * bytes: a YAML comment line pads it with `fill`, one character, `x` by
 * default, as many times as the size takes, each counted in its UTF-8 bytes.
 * Throws when the size cannot be reached that way.
 */
export function agentYamlOfSize(
  bytes: number,
  head: string = minimalAgentYaml(),
  fill = "x",
): string {
  const start = `${head}\n# `;
  const room = bytes - Buffer.byteLength(start);
  const unit = Buffer.byteLength(fill);
  if (room < 0 || room % unit !== 0) {
    throw new Error(
      `an agent.yaml of ${bytes} bytes cannot be padded with ${JSON.stringify(fill)}`,
    );
  }
  return start + fill.repeat(room / unit);
}

/** A bundle a push accepts: `agentYaml` — a minimal agent's by default — and a `SKILL.md`. */
export function validBundle(
  name = "test-agent",
  agentYaml: string = minimalAgentYaml(name),
): Promise<Buffer> {
  return packAgentTar([
    { name: "agent.yaml", content: Buffer.from(agentYaml) },
    { name: "SKILL.md", content: Buffer.from(`# ${name}\n`) },
  ]);
}

/** The gzip header's flag byte, and its bit for a comment field (RFC 1952, 2.3.1). */
const GZIP_FLG_OFFSET = 3;
const GZIP_FCOMMENT = 0x10;
/** The fixed part of a gzip header: what a field follows. */
const GZIP_FIXED_HEADER = 10;

/**
 * `bundle` — as `packAgentTar` packs it — weighing exactly `bytes` bytes, for
 * a test of what a push's size decides: the account's storage. A comment
 * field is put in its gzip header (RFC 1952, `FCOMMENT`), as long as the size
 * takes: every gzip reader skips it, and what the archive holds is unchanged.
 * Throws below the size of `bundle` plus one byte.
 */
export function withSize(bundle: Buffer, bytes: number): Buffer {
  if (bundle[GZIP_FLG_OFFSET] !== 0) {
    throw new Error("the bundle's gzip header already carries a field");
  }
  // The comment, then its terminating zero byte.
  const commentBytes = bytes - bundle.length - 1;
  if (commentBytes < 0) {
    throw new Error(`this bundle weighs at least ${bundle.length + 1} bytes; ${bytes} asked`);
  }
  const header = Buffer.from(bundle.subarray(0, GZIP_FIXED_HEADER));
  header[GZIP_FLG_OFFSET] = GZIP_FCOMMENT;
  return Buffer.concat([
    header,
    Buffer.alloc(commentBytes, "x"),
    Buffer.from([0]),
    bundle.subarray(GZIP_FIXED_HEADER),
  ]);
}

/** `validBundle(name)`, weighing exactly `bytes` bytes (see `withSize`). */
export async function validBundleOfSize(bytes: number, name = "test-agent"): Promise<Buffer> {
  return withSize(await validBundle(name), bytes);
}
