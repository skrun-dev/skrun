import { createHmac } from "node:crypto";
import type { Logger } from "@skrun-dev/runtime";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 4s, 16s (base^2 per retry)
const DEFAULT_SIGNING_KEY = "skrun-dev-webhook-secret";

/**
 * Deliver a webhook payload with HMAC-SHA256 signature and retry logic.
 * Retries up to 3 times with exponential backoff on non-2xx responses.
 */
export async function deliverWebhook(
  url: string,
  payload: object,
  signingKey?: string,
  logger?: Logger,
): Promise<void> {
  const key = signingKey ?? process.env.WEBHOOK_SIGNING_KEY ?? DEFAULT_SIGNING_KEY;
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", key).update(body).digest("hex");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Skrun-Signature": `sha256=${signature}`,
        },
        body,
      });

      if (res.ok) return;

      logger?.warn(
        {
          event: "webhook_retry",
          url,
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
          url,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
          error: err instanceof Error ? err.message : String(err),
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
    { event: "webhook_exhausted", url, attempts: MAX_RETRIES + 1 },
    `Webhook delivery failed after ${MAX_RETRIES + 1} attempts`,
  );
}
