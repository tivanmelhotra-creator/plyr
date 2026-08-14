'use strict';

/**
 * InspectorAuthorization — a one-time code that binds an Inspector client to a
 * Target Field, and the durable binding it produces.
 *
 * THE SHAPE THE REQUIREMENT ASKS FOR
 * ----------------------------------
 *   «Authorization Code فقط برای pairing/authorization اولیه Target Field باشد.
 *    Authorization Code برای هر ارسال value استفاده نشود. بعد از pairing موفق:
 *    API Key → authorized Target Field binding برقرار بماند.»
 *
 * So there are two distinct objects here, and keeping them distinct is the whole
 * design:
 *
 *   CODE     — short, human-typable, SINGLE USE, short-lived. Proves that the
 *              person holding the extension is the person looking at the field.
 *   BINDING  — durable. After redemption, "this API key is authorized for that
 *              Target Field", and every later send needs only the API key.
 *
 * WHY A CODE AT ALL, WHEN THE API KEY ALREADY AUTHENTICATES
 * -------------------------------------------------------
 * The API key answers "which account is this?". It cannot answer "which of the
 * fields this account has open did the human mean?". Without a deliberate
 * pairing step the server would have to guess — most-recently-opened, or
 * whatever the client asserts — and a value written into the wrong field is the
 * exact silent mis-delivery this subsystem exists to prevent. The code makes the
 * choice an explicit act the user performs once per destination.
 *
 * WHY SINGLE USE
 * --------------
 * A code is read off one screen and typed into another; it passes through
 * clipboards and, in remote mode, a screencast. Reuse would turn a
 * short-lived proof into a standing credential for a specific field. Redeeming
 * consumes it: a second attempt with the same code is refused even inside the
 * TTL, so a copy that leaked afterwards is worthless.
 *
 * WHY BINDINGS ARE PER (client, targetField) AND NOT PER CLIENT
 * ------------------------------------------------------------
 * Several Target Fields must be able to exist at once, and unregistering one
 * must not disturb another. If a client had a single "current" binding, opening
 * a second field would silently revoke the first — which is the single-slot
 * behaviour that was just removed from the claim layer. So bindings are a SET,
 * and revocation is always by one id.
 *
 * IN MEMORY, and identified by a hash of the API key rather than the key itself:
 * the map is only ever asked "is this key bound to that field?", which a digest
 * answers just as well, and a heap dump then contains no usable credential.
 */

import crypto from 'node:crypto';
import { generatePairingCode, secretsMatch } from './SessionHandoff';

/** How long a code may sit unredeemed. Long enough to type, short enough to matter. */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a binding survives without use.
 *
 * Deliberately longer than the code TTL and independent of any Session: a user
 * may pair once and then pick elements for a long stretch. The Target Field's
 * own TTL is the real ceiling — a binding to a target that has expired resolves
 * to nothing anyway, so this only bounds the map's growth.
 */
export const BINDING_TTL_MS = 12 * 60 * 60 * 1000;

/** A code waiting to be redeemed. Never returned to a client after issue. */
interface PendingCode {
  code: string;
  userId: string;
  targetFieldId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthorizationOffer {
  code: string;
  targetFieldId: string;
  expiresAt: number;
  expiresInMs: number;
}

export interface Binding {
  userId: string;
  targetFieldId: string;
  boundAt: number;
}

export type RedeemFailure =
  | 'INVALID_AUTHORIZATION_CODE'
  | 'AUTHORIZATION_EXPIRED';

export type RedeemResult =
  | { ok: true; binding: Binding }
  | { ok: false; reason: RedeemFailure };

/**
 * Identify an API key without storing it.
 *
 * Truncated SHA-256: the map needs equality, not reversibility. Full length
 * would be equally fine; 32 hex chars keeps log lines readable.
 */
function clientIdOf(apiKey: string): string {
  return crypto.createHash('sha256').update(String(apiKey || ''), 'utf8')
    .digest('hex').slice(0, 32);
}

function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

export class InspectorAuthorizationRegistry {
  /** code -> pending offer. Keyed by code because redemption arrives with one. */
  private pending = new Map<string, PendingCode>();
  /** clientId -> targetFieldId -> binding. A SET per client, never one slot. */
  private bindings = new Map<string, Map<string, Binding>>();

  /**
   * Issue a code for one Target Field.
   *
   * Any previous unredeemed code for the SAME user+target is dropped first, so
   * pressing "Authorize" twice cannot leave two valid codes for one destination
   * — the older one on a stale screen would otherwise still work.
   */
  issue(userId: string, targetFieldId: string, now = Date.now()): AuthorizationOffer | null {
    const owner = clean(userId, 200);
    const target = clean(targetFieldId, 400);
    if (!owner || !target) return null;

    for (const [code, p] of this.pending) {
      if (p.userId === owner && p.targetFieldId === target) this.pending.delete(code);
    }

    // Collision-checked: a duplicate would let one redemption consume another
    // user's offer.
    let code = generatePairingCode();
    let guard = 0;
    while (this.pending.has(code) && guard < 10) { code = generatePairingCode(); guard += 1; }

    const expiresAt = now + AUTH_CODE_TTL_MS;
    this.pending.set(code, { code, userId: owner, targetFieldId: target, issuedAt: now, expiresAt });
    return { code, targetFieldId: target, expiresAt, expiresInMs: AUTH_CODE_TTL_MS };
  }

  /**
   * Redeem a code and create the durable binding.
   *
   * Compared in constant time and scanned rather than looked up directly: a
   * `Map.get` on a user-supplied code is fine for correctness, but the scan lets
   * the comparison itself be timing-safe, matching how session tokens are
   * checked elsewhere in this project.
   *
   * `expired` is reported separately from `invalid` on purpose — §27 requires
   * distinct messages, and "ask for a new code" is a different instruction from
   * "check what you typed".
   */
  redeem(apiKey: string, codeInput: string, now = Date.now()): RedeemResult {
    const key = clean(apiKey, 400);
    const code = clean(codeInput, 32).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!key || !code) return { ok: false, reason: 'INVALID_AUTHORIZATION_CODE' };

    let found: PendingCode | null = null;
    for (const p of this.pending.values()) {
      if (secretsMatch(p.code, code)) { found = p; break; }
    }
    if (!found) return { ok: false, reason: 'INVALID_AUTHORIZATION_CODE' };

    // Consumed either way: an expired code must not linger to be retried.
    this.pending.delete(found.code);
    if (now > found.expiresAt) return { ok: false, reason: 'AUTHORIZATION_EXPIRED' };

    const clientId = clientIdOf(key);
    let mine = this.bindings.get(clientId);
    if (!mine) { mine = new Map(); this.bindings.set(clientId, mine); }

    const binding: Binding = {
      userId: found.userId,
      targetFieldId: found.targetFieldId,
      boundAt: now,
    };
    mine.set(found.targetFieldId, binding);
    return { ok: true, binding };
  }

  /**
   * Is this API key authorized for this Target Field?
   *
   * The question every ordinary send asks. `userId` is verified too, so a key
   * that was re-issued to a different account cannot inherit a binding.
   */
  isAuthorized(apiKey: string, userId: string, targetFieldId: string, now = Date.now()): boolean {
    const mine = this.bindings.get(clientIdOf(clean(apiKey, 400)));
    if (!mine) return false;
    const b = mine.get(clean(targetFieldId, 400));
    if (!b) return false;
    if (b.userId !== clean(userId, 200)) return false;
    if (now - b.boundAt > BINDING_TTL_MS) { mine.delete(b.targetFieldId); return false; }
    return true;
  }

  /**
   * Drop one binding.
   *
   * Called when a Target Field is unregistered. Scoped to a single id: this is
   * the mechanism by which closing one node cannot revoke another node's
   * authorization.
   */
  revoke(targetFieldId: string): number {
    const target = clean(targetFieldId, 400);
    let removed = 0;
    for (const [clientId, mine] of this.bindings) {
      if (mine.delete(target)) removed += 1;
      if (!mine.size) this.bindings.delete(clientId);
    }
    return removed;
  }

  /** Every target this key may write to, for a status view. */
  bindingsFor(apiKey: string): Binding[] {
    const mine = this.bindings.get(clientIdOf(clean(apiKey, 400)));
    return mine ? [...mine.values()].map((b) => ({ ...b })) : [];
  }

  /** Is a code still waiting? For a UI countdown, never for authorization. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Drop expired codes and bindings. */
  sweep(now = Date.now()): void {
    for (const [code, p] of this.pending) {
      if (now > p.expiresAt) this.pending.delete(code);
    }
    for (const [clientId, mine] of this.bindings) {
      for (const [target, b] of mine) {
        if (now - b.boundAt > BINDING_TTL_MS) mine.delete(target);
      }
      if (!mine.size) this.bindings.delete(clientId);
    }
  }

  clear(): void {
    this.pending.clear();
    this.bindings.clear();
  }
}

export const inspectorAuth = new InspectorAuthorizationRegistry();
