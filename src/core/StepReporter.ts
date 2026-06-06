// ════════════════════════════════════════════════════════════════
// StepReporter (Step 29) — two-channel live reporting, pure core.
// ----------------------------------------------------------------
// Channel 1 (outbound webhook): in addition to the existing job-level
// webhook, every step event (start/done/error/retry) can be delivered
// live to the client URL (e.g. an n8n "Automation Backend Trigger"
// node) signed with the SAME HMAC scheme as job webhooks.
//
// Channel 2 (shareable live link): a per-job share token, signed over
// "<userId>:<jobId>:<exp>", lets a recipient open a read-only live view
// (/live/view/...) without handing out an API key. The token is
// verified constant-time and is expiry-bounded.
//
// This module is DOM-free and side-effect-free so it can be unit tested
// directly (no network, no Redis). Delivery + wiring live in
// webhook.service.ts and index.ts.
// ════════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from 'crypto';
import { SIGNATURE_PREFIX } from '../utils/signature';

// ── Step event taxonomy mirrored from LiveBus (the subset that is
// meaningful as an *outbound per-step* report). 'log' and the job.*
// events are handled by the existing job webhook, not here.
export type StepEventType =
  | 'step.start'
  | 'step.done'
  | 'step.error'
  | 'step.retry';

export const STEP_EVENT_TYPES: readonly StepEventType[] = [
  'step.start',
  'step.done',
  'step.error',
  'step.retry'
];

// Only these event types are eligible for outbound per-step delivery.
export function isStepEventType(type: string | undefined | null): type is StepEventType {
  return !!type && (STEP_EVENT_TYPES as readonly string[]).includes(type);
}

// ── Per-step webhook payload ────────────────────────────────────
// A flat, n8n-friendly envelope. `event` matches the live event type so
// a single n8n Trigger node can filter on step.start/step.done/...
export interface StepWebhookPayload {
  event: StepEventType;
  jobId: string;
  userId: string;
  /** 1-based step index within the (flattened) workflow run. */
  index: number;
  /** Action id of the node (e.g. 'goto', 'click', 'trigger_webhook'). */
  action: string | null;
  /** True for step.done with a successful step; absent for start. */
  success?: boolean;
  durationMs?: number;
  /** Item-flow summary (Step 21 shape) when available on step.done. */
  inputItemCount?: number;
  outputItemCount?: number;
  outputSample?: unknown;
  outputTruncated?: boolean;
  /** Present on step.error / step.retry. */
  error?: string;
  /** Present on step.retry. */
  attempt?: number;
  maxTries?: number;
  timestamp: string;
}

export interface StepEventInput {
  type: string;
  jobId: string;
  userId: string;
  data?: Record<string, unknown> | undefined;
  /** Override timestamp (mainly for deterministic tests). */
  timestamp?: string;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Build the outbound per-step webhook payload from a live step event.
 * Returns null when the event is not a per-step event (so callers can
 * cheaply skip job.* / log events). The shape is intentionally flat and
 * stable so n8n expressions like `{{$json.outputItemCount}}` just work.
 */
export function buildStepWebhookPayload(input: StepEventInput): StepWebhookPayload | null {
  if (!isStepEventType(input.type)) return null;
  const d = (input.data && typeof input.data === 'object') ? input.data : {};
  const idx = asNumber(d.index) ?? 0;
  const payload: StepWebhookPayload = {
    event: input.type,
    jobId: String(input.jobId),
    userId: String(input.userId),
    index: idx,
    action: asString(d.action) ?? null,
    timestamp: input.timestamp || new Date().toISOString()
  };

  const success = d.success;
  if (typeof success === 'boolean') payload.success = success;

  const dur = asNumber(d.durationMs);
  if (dur !== undefined) payload.durationMs = dur;

  const inCount = asNumber(d.inputItemCount);
  if (inCount !== undefined) payload.inputItemCount = inCount;
  const outCount = asNumber(d.outputItemCount);
  if (outCount !== undefined) payload.outputItemCount = outCount;
  if ('outputSample' in d) payload.outputSample = d.outputSample;
  if (typeof d.outputTruncated === 'boolean') payload.outputTruncated = d.outputTruncated;

  const err = asString(d.error);
  if (err !== undefined) payload.error = err;

  const attempt = asNumber(d.attempt);
  if (attempt !== undefined) payload.attempt = attempt;
  const maxTries = asNumber(d.maxTries);
  if (maxTries !== undefined) payload.maxTries = maxTries;

  return payload;
}

/**
 * Decide whether a given step event should be delivered, honoring an
 * optional allow-list of event types (mirrors the n8n Trigger node's
 * multiOptions "events" filter). Empty/undefined list = deliver all
 * per-step events. Non-step events are never delivered here.
 */
export function shouldDeliverStepEvent(
  type: string,
  selected?: readonly string[] | null
): boolean {
  if (!isStepEventType(type)) return false;
  if (!selected || selected.length === 0) return true;
  return selected.includes(type);
}

// ════════════════════════════════════════════════════════════════
// Shareable live-link token (Channel 2)
// ----------------------------------------------------------------
// Token format (URL-safe):  <userId>.<jobId>.<exp>.<sig>
//   sig = HMAC_SHA256(secret, "<userId>:<jobId>:<exp>") hex (no prefix)
// We base64url-encode userId/jobId so dots inside them never break the
// split. `exp` is unix-seconds; 0 means "no expiry".
// ════════════════════════════════════════════════════════════════

export const DEFAULT_SHARE_TTL_SEC = 24 * 60 * 60; // 24h
export const MAX_SHARE_TTL_SEC = 30 * 24 * 60 * 60; // 30d hard cap

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(norm, 'base64').toString('utf8');
}

function shareSigningInput(userId: string, jobId: string, exp: number): string {
  return `${userId}:${jobId}:${exp}`;
}

export interface ShareTokenParts {
  userId: string;
  jobId: string;
  exp: number; // unix seconds, 0 = no expiry
}

/**
 * Mint a signed, URL-safe share token for a (userId, jobId) live view.
 * `ttlSec` clamps to [0, MAX_SHARE_TTL_SEC]; 0 = never expires. `nowSec`
 * is injectable for deterministic tests.
 */
export function buildShareToken(
  userId: string,
  jobId: string,
  secret: string,
  ttlSec: number = DEFAULT_SHARE_TTL_SEC,
  nowSec: number = Math.floor(Date.now() / 1000)
): string {
  if (!secret) throw new Error('share token secret is required');
  let ttl = Number.isFinite(ttlSec) ? Math.floor(ttlSec) : DEFAULT_SHARE_TTL_SEC;
  if (ttl < 0) ttl = 0;
  if (ttl > MAX_SHARE_TTL_SEC) ttl = MAX_SHARE_TTL_SEC;
  const exp = ttl === 0 ? 0 : nowSec + ttl;
  const sig = createHmac('sha256', secret)
    .update(shareSigningInput(userId, jobId, exp), 'utf8')
    .digest('hex');
  return `${b64urlEncode(userId)}.${b64urlEncode(jobId)}.${exp}.${sig}`;
}

export interface ShareVerifyResult {
  ok: boolean;
  reason?: 'malformed' | 'bad_signature' | 'expired';
  parts?: ShareTokenParts;
}

/**
 * Verify a share token constant-time. On success returns the decoded
 * (userId, jobId, exp). `nowSec` is injectable for deterministic tests.
 */
export function verifyShareToken(
  token: string | undefined | null,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000)
): ShareVerifyResult {
  if (!token || !secret) return { ok: false, reason: 'malformed' };
  // Tolerate an accidental sha256= prefix on the signature segment.
  const segs = token.split('.');
  if (segs.length !== 4) return { ok: false, reason: 'malformed' };
  const [encUser, encJob, expStr, rawSig] = segs;
  let userId: string;
  let jobId: string;
  try {
    userId = b64urlDecode(encUser);
    jobId = b64urlDecode(encJob);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!userId || !jobId) return { ok: false, reason: 'malformed' };
  if (!/^\d+$/.test(expStr)) return { ok: false, reason: 'malformed' };
  const exp = parseInt(expStr, 10);
  const providedSig = rawSig.startsWith(SIGNATURE_PREFIX)
    ? rawSig.slice(SIGNATURE_PREFIX.length)
    : rawSig;
  const expectedSig = createHmac('sha256', secret)
    .update(shareSigningInput(userId, jobId, exp), 'utf8')
    .digest('hex');
  if (providedSig.length !== expectedSig.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  let sigOk: boolean;
  try {
    sigOk = timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };
  if (exp !== 0 && nowSec >= exp) {
    return { ok: false, reason: 'expired', parts: { userId, jobId, exp } };
  }
  return { ok: true, parts: { userId, jobId, exp } };
}
