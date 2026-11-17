import { createHmac } from "node:crypto";
import { type Logger, safeFetch } from "@skrun-dev/runtime";
import { errorFields } from "./error-fields.js";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 4s, 16s (base^2 per retry)
const WEBHOOK_TIMEOUT_MS = 10_000; // per-attempt bound — an unresponsive endpoint aborts

/** What a log line writes for a webhook URL it cannot reduce to an origin. */
const UNPARSEABLE_URL = "(unparseable webhook URL, not logged)";

/**
 * What a log line may say about a webhook: its origin, that is its scheme, host
 * and port. A webhook URL can carry its secret in the path (Slack and Discord
 * do) or in the query, so nothing past the origin is ever written. A value that
 * does not parse, or whose scheme has no origin, is not written at all.
 */
function webhookOrigin(url: string): string {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "null";
  }
  return origin === "null" ? UNPARSEABLE_URL : origin;
}

/**
 * Whether webhook delivery may target private/loopback hosts. Fail-closed: off
 * unless SKRUN_ALLOW_LOCAL_WEBHOOKS is explicitly "true" (local webhook
 * testing). The request-intake check in routes/run.ts reads the same flag, so a
 * developer who sets it can exercise http://localhost webhooks end to end.
 */
export function localWebhooksAllowed(): boolean {
  return process.env.SKRUN_ALLOW_LOCAL_WEBHOOKS === "true";
}

/**
 * Deliver a webhook payload with HMAC-SHA256 signature and retry logic.
 * Retries up to 3 times with exponential backoff on non-2xx responses.
 * Its log lines name the webhook by its origin only, and a failed attempt by
 * the error's class and code.
 */
export async function deliverWebhook(
  url: string,
  payload: object,
  signingKey?: string,
  logger?: Logger,
): Promise<void> {
  const key = signingKey ?? process.env.WEBHOOK_SIGNING_KEY;
  if (!key) {
    throw new Error(
      "WEBHOOK_SIGNING_KEY is not configured — refusing to deliver webhook with an insecure default. " +
        "Set the WEBHOOK_SIGNING_KEY environment variable (see .env.example).",
    );
  }
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", key).update(body).digest("hex");
  const origin = webhookOrigin(url);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await safeFetch(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Skrun-Signature": `sha256=${signature}`,
          },
          body,
        },
        {
          timeoutMs: WEBHOOK_TIMEOUT_MS,
          followRedirects: false,
          allowPrivateHosts: localWebhooksAllowed(),
        },
      );

      if (res.ok) return;

      logger?.warn(
        {
          event: "webhook_retry",
          url: origin,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          status: res.status,
        },
        `Webhook delivery failed (HTTP ${res.status})`,
      );
    } catch (err) {
      logger?.warn(
        {
          event: "webhook_retry",
          url: origin,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          ...errorFields(err),
        },
        "Webhook delivery failed (network error)",
      );
    }

    if (attempt < MAX_RETRIES) {
      const delay = BACKOFF_BASE_MS * 4 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger?.error(
    { event: "webhook_exhausted", url: origin, attempts: MAX_RETRIES + 1 },
    `Webhook delivery failed after ${MAX_RETRIES + 1} attempts`,
  );
}
