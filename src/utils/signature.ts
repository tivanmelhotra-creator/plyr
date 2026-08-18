// ============================================================
// Webhook HMAC signing (F3 - outgoing webhook hardening)
//
// When WEBHOOK_SECRET is configured, every outgoing webhook body is signed so
// the receiver (any HTTP webhook endpoint) can verify authenticity. We compute
// HMAC-SHA256 over the EXACT serialized JSON body that is sent on the wire and
// expose it as `X-Signature: sha256=<hex>`. A `X-Webhook-Timestamp` header
// (unix seconds) is also emitted so receivers can reject stale replays.
//
// Verification (receiver side, pseudo):
//   expected = HMAC_SHA256(secret, rawBody)
//   valid = timingSafeEqual(expected, hexFromHeader("X-Signature"))
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';

export const SIGNATURE_PREFIX = 'sha256=';

/**
 * Compute the hex HMAC-SHA256 of `body` keyed by `secret`.
 * Returns the prefixed form (`sha256=<hex>`) ready for the X-Signature header.
 */
export const signWebhookBody = (body: string, secret: string): string => {
  const digest = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
};

/**
 * Constant-time verification of a received `X-Signature` value against `body`.
 * Accepts the header with or without the `sha256=` prefix. Returns false on any
 * length/format mismatch rather than throwing, so callers can branch cleanly.
 */
export const verifyWebhookSignature = (
  body: string,
  secret: string,
  signature: string | undefined | null
): boolean => {
  if (!signature) return false;
  const provided = signature.startsWith(SIGNATURE_PREFIX)
    ? signature.slice(SIGNATURE_PREFIX.length)
    : signature;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  // Hex strings of differing length cannot match; bail before timingSafeEqual
  // (which throws on length mismatch).
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
};
