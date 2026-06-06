import { config } from '../config';
import type { WebhookPayload } from '../types';
import type { StepWebhookPayload } from '../core/StepReporter';
import { signWebhookBody } from '../utils/signature';

export const sendWebhook = async (
  url: string,
  payload: WebhookPayload,
  maxRetries: number = config.WEBHOOK_MAX_RETRIES
): Promise<void> => {
  const baseBackoff = config.WEBHOOK_RETRY_BACKOFF_MS;

  // [F3] Serialize the body ONCE so the signature is computed over the exact
  // bytes we transmit. When WEBHOOK_SECRET is set, attach HMAC headers so the
  // receiver (e.g. an n8n Webhook node) can verify authenticity + freshness.
  const rawBody = JSON.stringify(payload);
  const signatureHeaders: Record<string, string> = {};
  if (config.WEBHOOK_SECRET) {
    signatureHeaders['X-Signature'] = signWebhookBody(rawBody, config.WEBHOOK_SECRET);
    signatureHeaders['X-Webhook-Timestamp'] = String(Math.floor(Date.now() / 1000));
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `AutomationBackend/${config.VERSION}`,
          'X-Webhook-Attempt': String(attempt),
          ...signatureHeaders
        },
        body: rawBody,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        if (attempt > 1) {
          console.log(`[WEBHOOK] ✓ Sent to ${url} (succeeded on attempt ${attempt})`);
        } else {
          console.log(`[WEBHOOK] ✓ Sent to ${url}`);
        }
        return;
      }

      // Don't retry client errors (except 429)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        console.log(`[WEBHOOK] ✗ Client error ${response.status} from ${url}, not retrying`);
        return;
      }

      throw new Error(`HTTP ${response.status}`);

    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      const isLastAttempt = attempt === maxRetries;
      const errorMsg = error.name === 'AbortError' ? 'Timeout' : error.message;

      if (isLastAttempt) {
        console.log(`[WEBHOOK] ✗ Failed to send to ${url} after ${maxRetries} attempts: ${errorMsg}`);
        return;
      }

      const delay = baseBackoff * Math.pow(2, attempt - 1);
      console.log(`[WEBHOOK] ⚠️ Attempt ${attempt} failed (${errorMsg}), retrying in ${delay}ms...`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// ════════════════════════════════════════════════════════════════
// Step 29: per-step outbound webhook (two-channel live reporting).
// ----------------------------------------------------------------
// Delivers a single step event (start/done/error/retry) to the job's
// webhook URL using the SAME HMAC scheme + retry/backoff as the job
// webhook. The event type is also surfaced in the `X-Webhook-Event`
// header so receivers can route without parsing the body. Best-effort:
// never throws into the pipeline (errors are logged and swallowed).
// ════════════════════════════════════════════════════════════════
export const sendStepWebhook = async (
  url: string,
  payload: StepWebhookPayload,
  maxRetries: number = config.WEBHOOK_MAX_RETRIES
): Promise<void> => {
  const baseBackoff = config.WEBHOOK_RETRY_BACKOFF_MS;
  const rawBody = JSON.stringify(payload);
  const signatureHeaders: Record<string, string> = {};
  if (config.WEBHOOK_SECRET) {
    signatureHeaders['X-Signature'] = signWebhookBody(rawBody, config.WEBHOOK_SECRET);
    signatureHeaders['X-Webhook-Timestamp'] = String(Math.floor(Date.now() / 1000));
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `AutomationBackend/${config.VERSION}`,
          'X-Webhook-Attempt': String(attempt),
          'X-Webhook-Event': payload.event,
          ...signatureHeaders
        },
        body: rawBody,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) return;
      // Don't retry client errors (except 429).
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        const errorMsg = error.name === 'AbortError' ? 'Timeout' : error.message;
        console.log(`[STEP-WEBHOOK] \u2717 ${payload.event} step ${payload.index} -> ${url} failed after ${maxRetries} attempts: ${errorMsg}`);
        return;
      }
      const delay = baseBackoff * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};
