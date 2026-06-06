import { verifyWebhookSignature } from '../utils/signature';
import type { WorkflowItem } from './WorkflowItems';

/**
 * TriggerEngine — pure, dependency-light trigger core (Step 28, n8n Model B).
 *
 * A "trigger" is the entry point of a saved workflow. We support four kinds:
 *   - manual    : fired from the panel / API, optional data payload.
 *   - webhook   : a unique inbound URL; body/headers/query become input items.
 *   - schedule  : BullMQ repeatable (cron) — fired by the scheduler.
 *   - telegram  : an inbound Telegram message activates the workflow.
 *
 * This module is intentionally free of Express / BullMQ / Redis imports so it
 * can be unit-tested in a plain `node` environment. It does two jobs:
 *   1. Normalize a raw trigger node's config into a clean shape.
 *   2. Map an inbound request (body/headers/query) into the workflow's initial
 *      `items[]` stream (n8n injects trigger data as the first node's input).
 *   3. Authorize an inbound trigger (HMAC signature or a path/secret token).
 */

export type TriggerKind = 'manual' | 'webhook' | 'schedule' | 'telegram';

const KNOWN_KINDS: TriggerKind[] = ['manual', 'webhook', 'schedule', 'telegram'];

// Map a trigger *action id* (as used by the UI catalog) to its kind.
const ACTION_TO_KIND: Record<string, TriggerKind> = {
  trigger_manual: 'manual',
  trigger_webhook: 'webhook',
  trigger_schedule: 'schedule',
  trigger_telegram: 'telegram',
  // tolerant aliases
  manual_trigger: 'manual',
  webhook_trigger: 'webhook',
  schedule_trigger: 'schedule',
  cron_trigger: 'schedule',
  telegram_trigger: 'telegram',
};

export interface NormalizedTrigger {
  kind: TriggerKind;
  enabled: boolean;
  /** webhook: HTTP method filter (any when '*'). */
  method: string;
  /** schedule: cron expression (5-6 fields). */
  cron: string;
  /** schedule: IANA timezone string (best-effort; engine does not validate TZ db). */
  timezone: string;
  /** telegram: bot token (kept opaque here; never logged by this module). */
  hasToken: boolean;
}

function toBool(v: unknown, fallback = false): boolean {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

/**
 * Resolve a trigger node (or its raw config object) into a clean shape.
 * Tolerant of missing/garbage input.
 */
export function normalizeTrigger(node: any): NormalizedTrigger {
  const n = node || {};
  const rawKind =
    (typeof n.kind === 'string' && n.kind) ||
    (typeof n.triggerKind === 'string' && n.triggerKind) ||
    (typeof n.action === 'string' && ACTION_TO_KIND[n.action]) ||
    (typeof n.id === 'string' && ACTION_TO_KIND[n.id]) ||
    '';
  const kind: TriggerKind = (KNOWN_KINDS as string[]).indexOf(rawKind) >= 0
    ? (rawKind as TriggerKind)
    : 'manual';

  const method = (typeof n.method === 'string' && n.method.trim())
    ? n.method.trim().toUpperCase()
    : '*';

  const cron = (typeof n.cron === 'string' ? n.cron : '').trim();
  const timezone = (typeof n.timezone === 'string' && n.timezone.trim())
    ? n.timezone.trim()
    : 'UTC';

  const hasToken = !!(n.token || n.botToken || n.telegramToken);

  return {
    kind,
    enabled: toBool(n.enabled, true),
    method,
    cron,
    timezone,
    hasToken,
  };
}

/** Is this action id a trigger node? */
export function isTriggerAction(actionId: unknown): boolean {
  return typeof actionId === 'string' && actionId in ACTION_TO_KIND;
}

export interface InboundRequest {
  body?: unknown;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  method?: string;
}

/**
 * Map an inbound trigger request into the workflow's initial item stream.
 *
 * n8n semantics: the trigger node emits items that the first real node
 * receives as input. We build ONE item whose `json` carries the structured
 * request, mirroring n8n's Webhook node output:
 *   { body, headers, query, method }
 *
 * If the body is itself an array, we emit one item per element (each wrapped
 * with the same headers/query/method envelope under `json`). If the body is a
 * plain object, its keys are spread to the top level for ergonomic access
 * (e.g. `{{$json.foo}}`), with the full envelope preserved under reserved keys.
 */
export function buildItemsFromTrigger(req: InboundRequest | null | undefined): WorkflowItem[] {
  const r = req || {};
  const headers = (r.headers && typeof r.headers === 'object') ? r.headers : {};
  const query = (r.query && typeof r.query === 'object') ? r.query : {};
  const method = (typeof r.method === 'string' ? r.method : '').toUpperCase();

  const envelope = (payload: Record<string, unknown>): WorkflowItem => ({
    json: {
      ...payload,
      body: payload,
      headers,
      query,
      method,
    },
  });

  const body = r.body;

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return [{ json: { body: [], headers, query, method } }];
    }
    return body.map((el) => {
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        return envelope(el as Record<string, unknown>);
      }
      return { json: { value: el, headers, query, method } };
    });
  }

  if (body && typeof body === 'object') {
    return [envelope(body as Record<string, unknown>)];
  }

  if (body === undefined || body === null) {
    // No body — still emit a single item carrying the request envelope so the
    // first node runs exactly once (n8n behaviour).
    return [{ json: { headers, query, method } }];
  }

  // Primitive body.
  return [{ json: { value: body, headers, query, method } }];
}

/**
 * Build the initial items for a manual / API run. `data` may be:
 *   - undefined/null   → a single empty item (default n8n start).
 *   - an array         → one item per element.
 *   - an object        → a single item with that object as json.
 *   - a primitive      → a single item under { value }.
 */
export function buildManualItems(data: unknown): WorkflowItem[] {
  if (data === undefined || data === null) return [{ json: {} }];
  if (Array.isArray(data)) {
    if (data.length === 0) return [{ json: {} }];
    return data.map((el) =>
      el && typeof el === 'object' && !Array.isArray(el)
        ? { json: { ...(el as Record<string, unknown>) } }
        : { json: { value: el } }
    );
  }
  if (typeof data === 'object') return [{ json: { ...(data as Record<string, unknown>) } }];
  return [{ json: { value: data } }];
}

const CRON_FIELDS_MIN = 5;
const CRON_FIELDS_MAX = 6;

/**
 * Lightweight cron shape validation (matches the backend Zod check). Detailed
 * scheduling validity is enforced downstream by BullMQ's parser; here we just
 * assert the field count and reject obviously-empty input.
 */
export function validateCron(cron: unknown): { valid: boolean; error?: string } {
  if (typeof cron !== 'string') return { valid: false, error: 'Cron expression required' };
  const trimmed = cron.trim();
  if (!trimmed) return { valid: false, error: 'Cron expression required' };
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length < CRON_FIELDS_MIN || parts.length > CRON_FIELDS_MAX) {
    return {
      valid: false,
      error: 'Invalid cron format. Expected 5-6 parts: "minute hour day month weekday"',
    };
  }
  return { valid: true };
}

export interface TriggerAuthInput {
  /** Raw request body string used for HMAC (must be the exact bytes received). */
  rawBody?: string;
  /** Value of the X-Signature header (with or without sha256= prefix). */
  signature?: string | null;
  /** A path/query token presented by the caller. */
  providedToken?: string | null;
}

export interface TriggerAuthConfig {
  /** HMAC secret; when set, an X-Signature over rawBody is required+verified. */
  secret?: string | null;
  /** A static token that must match providedToken; when set, it is required. */
  token?: string | null;
}

/**
 * Authorize an inbound trigger. Rules:
 *   - If a `secret` is configured, the HMAC signature over rawBody MUST verify.
 *   - If a `token` is configured, the providedToken MUST match (constant-ish).
 *   - If neither is configured, the trigger is OPEN (returns true) — callers
 *     that require auth should pre-check and refuse to expose open webhooks.
 * Both checks (when configured) must pass.
 */
export function verifyTriggerAuth(
  input: TriggerAuthInput,
  cfg: TriggerAuthConfig
): boolean {
  const secret = cfg && typeof cfg.secret === 'string' ? cfg.secret : '';
  const token = cfg && typeof cfg.token === 'string' ? cfg.token : '';

  if (secret) {
    const ok = verifyWebhookSignature(input?.rawBody ?? '', secret, input?.signature ?? null);
    if (!ok) return false;
  }
  if (token) {
    const provided = input?.providedToken ?? '';
    if (!provided || provided.length !== token.length) return false;
    // length-checked equality; tokens are not secrets-grade but this avoids the
    // most trivial early-exit timing leak for equal-length inputs.
    let mismatch = 0;
    for (let i = 0; i < token.length; i++) {
      mismatch |= token.charCodeAt(i) ^ provided.charCodeAt(i);
    }
    if (mismatch !== 0) return false;
  }
  return true;
}
