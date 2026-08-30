import { createHash, randomBytes } from "node:crypto";

/**
 * Generate a PKCE (RFC 7636) verifier + S256 challenge for the device-login flow.
 *
 * The `verifier` (43-char base64url — the RFC 7636 minimum length) NEVER leaves
 * the CLI; only the `challenge` is sent to the server at `device/code`. The server
 * checks the verifier against the stored challenge at the token poll, so a captured
 * device_code is useless without the verifier.
 */
export function generatePkce(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}
