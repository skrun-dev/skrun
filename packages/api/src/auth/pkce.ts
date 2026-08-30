import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Verify a PKCE (RFC 7636) `code_verifier` against a stored S256 `code_challenge`
 * — i.e. `base64url(SHA-256(verifier)) === challenge` — in constant time.
 *
 * Returns false on empty inputs or a length mismatch, so a wrong/absent verifier
 * can never authorize a device-code token exchange. The CLI generates the verifier
 * (it never leaves the CLI) and sends the challenge at `device/code`; the server
 * checks the verifier here at the token poll.
 */
export function verifyChallenge(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
