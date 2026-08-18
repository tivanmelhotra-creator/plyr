/**
 * RemoteTargetConsent — the missing half of REMOTE targeting.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS TO FIX
 * ══════════════════════════════════════════════════════════════════════════
 *
 * REPORTED, and correct:
 *
 *   «مرورگر ریموت یعنی مرورگری که روی سرور قرار داره … اگر کد اتورایز رو وارد
 *    نکنم … ظاهرا نمیدونه به کدوم فیلد باید ارسال بشه — Connection failed: network»
 *
 * The insight in that report is the one the previous design missed: **the
 * browser on the server is, from the extension's point of view, a LOCAL
 * browser.** It runs the very same `extension/`, and that extension decides
 * where a pick goes by reading ONE value out of `chrome.storage.local`:
 *
 *     ab_targetFieldId   (extension/background.js — getTargetFieldId)
 *
 * That value is written in exactly one place — `inspectorPair()`, after an
 * Authorization Code is redeemed. REMOTE deliberately issues no code
 * («برای REMOTE BROWSER نیازی به Authorization Code نیست»), so in REMOTE the
 * value was never written and `sendElement` refused locally with
 * `TARGET_NOT_AUTHORIZED` before any request was made.
 *
 * So the server was doing its half correctly — `/inspector/targeting/begin`
 * granted a binding to the seeded token, and a submit carrying the id really
 * did land (proved by `targeting-routes.test.ts`, "binds the caller so a pick
 * actually lands"). What was missing is that **nothing ever told the extension
 * which id to carry.** The server knew the destination; the client that had to
 * name it did not.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A CONSENT PROMPT AND NOT AN AUTO-FILL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The obvious shortcut is to have `/inspector/session` return "and your current
 * target is X", letting the extension adopt it silently. That is rejected, for
 * the reason the report itself identifies:
 *
 *   «تو فرض کن من قراره دوتا نود که یعنی دو تا فیلد با نودهای متفاوت باید
 *    المان/اتربیوت براش پر کنم … و الان نمیدونه کدوم فیلد باید ارسال بشه»
 *
 * With two fields open there IS no "current" target — a single-valued answer
 * would have to pick one, and picking the most-recent silently means the
 * operator's pick lands in the node they are no longer looking at, with a
 * success message. That is worse than the refusal it replaces: a refusal is
 * visible, a mis-delivery is not. MEASURED on this build before the fix:
 * `/inspector/session` returned `authorized: [nodeA…, nodeB…]` — two live
 * bindings, no ordering that means anything to the operator.
 *
 * It would also break the standing rule that survives from the spec:
 *
 *   «The Extension must NEVER be able to choose an arbitrary Target Field.»
 *
 * An extension that adopts whatever the session lists has chosen — it just did
 * the choosing by reading a list instead of by naming an id.
 *
 * So the destination is still decided by the SERVER, and it still takes a human
 * act to attach it. The act simply stops being "read an 8-character code off
 * one screen and type it into another" and becomes "press Allow on the prompt
 * that names the node and field", which is the operator's own proposal:
 *
 *   «توی همون صفحه مرورگر یه الرت بالا بیاد و از کاربر اجازه اتصال به نود/فیلد
 *    رو بگیره و وقتی کاربر اجازه داد پلاگین خودش کد اتوارایزش جایگزین میشه»
 *
 * A code and a consent are the same security object — a one-time, server-issued,
 * expiring, single-target grant that only a human can complete. This one is just
 * addressed to a browser the server can already reach, so it can be delivered
 * instead of transcribed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS, PRECISELY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A short-lived queue of "the dashboard would like this browser to send its next
 * pick to <node> → <field>", per user, awaiting an answer. It holds NO
 * authority: approving does not grant anything here. The route calls
 * `inspectorAuth.grant(...)` on approval, exactly as the code path does on
 * redeem, so there is one place where trust is created and this is not it.
 *
 * IDEMPOTENT PER FIELD, which is the second half of the report:
 *
 *   «اگر حتی مرورگر بالا موند و فیلد عوض شد و همون ریموت باز انتخاب شد … مرورگر
 *    مجدد بالا نمیاد و فقط الرت بالا میاد در حالت تکراری»
 *
 * Asking twice for the SAME field replaces the pending request rather than
 * queueing a second one — two prompts for one field is a bug, not a reminder.
 * Asking for a DIFFERENT field queues alongside it, because those are two
 * genuinely different questions and answering one must not answer the other.
 */

import { randomBytes } from 'crypto';

/** How long an unanswered prompt stays askable. */
export const CONSENT_TTL_MS = 5 * 60 * 1000;

/**
 * How long an ANSWERED request stays readable.
 *
 * Not zero: the dashboard polls for the outcome, and a decision deleted the
 * instant it was made would leave the poller unable to distinguish "approved"
 * from "expired" — the two outcomes with opposite next steps.
 */
export const CONSENT_DECISION_TTL_MS = 60 * 1000;

/** The most prompts one user may have outstanding. */
export const CONSENT_MAX_PER_USER = 10;

export type ConsentState = 'pending' | 'approved' | 'denied' | 'expired';

/** What the browser is being asked, and what came of it. */
export interface ConsentRequest {
  /** Opaque handle. The answer names this, never a target id. */
  consentId: string;
  userId: string;
  /** The destination, decided by the server before the prompt was raised. */
  targetFieldId: string;
  /** The durable identity, so approval can record a pairing like a redeem does. */
  pairingKey: string;
  /** ── Shown to the human, so the prompt can be verified, not merely trusted ── */
  nodeId: string;
  fieldKey: string;
  /** The node's human label when the dashboard supplied one. */
  label: string;
  /** The node's action id — "Click", "Type" — for the same reason. */
  action: string;
  state: ConsentState;
  requestedAt: number;
  expiresAt: number;
  /** When it was answered. `0` while pending. */
  decidedAt: number;
}

/** The public view. Identical today; named so the wire shape can be pinned. */
export type ConsentView = ConsentRequest;

/**
 * What a browser is allowed to SEE while a prompt is still unanswered.
 *
 * Deliberately the full request MINUS `targetFieldId` and `pairingKey`.
 *
 * The whole point of the handshake is that approval is what hands over the
 * destination. If the pending list carried the destination, an extension could
 * read the address out of the list it polls and submit straight to it, never
 * rendering a prompt and never asking the human anything — which is exactly the
 * standing prohibition «The Extension must NEVER be able to choose an arbitrary
 * Target Field», re-entered through the one door built to enforce it.
 *
 * Everything a human needs in order to answer — which node, which field, which
 * action, how long it is good for — is still here. Only the machine-usable
 * address is withheld, and only until Allow is pressed.
 */
export type ConsentPrompt = Omit<ConsentRequest, 'targetFieldId' | 'pairingKey'>;

/** Drop the address from a request, leaving the human-readable question. */
function toPrompt(r: ConsentRequest): ConsentPrompt {
  const { targetFieldId: _address, pairingKey: _pairing, ...prompt } = r;
  return prompt;
}

export interface ConsentDecision {
  ok: boolean;
  reason?: 'not_found' | 'expired' | 'already_decided';
  request?: ConsentRequest;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function newConsentId(): string {
  return 'cns_' + randomBytes(12).toString('hex');
}

/**
 * The registry.
 *
 * In-memory and per-process, like `InspectorAuthorizationRegistry` and
 * `TargetFieldRegistry` beside it. A prompt is a live conversation with a
 * browser window; surviving a restart would mean re-raising a question about a
 * dashboard that is no longer open.
 */
export class RemoteTargetConsentRegistry {
  /** consentId -> request. One flat map: every lookup arrives with an id. */
  private requests = new Map<string, ConsentRequest>();

  /**
   * Raise (or refresh) the prompt for one field.
   *
   * Returns the request and whether it was already outstanding, because the two
   * cases read differently to the operator: a fresh prompt is "look at the
   * browser", a repeat is "the prompt is still there, still waiting".
   */
  request(
    input: {
      userId: string;
      targetFieldId: string;
      pairingKey?: string;
      nodeId?: string;
      fieldKey?: string;
      label?: string;
      action?: string;
    },
    now = Date.now(),
  ): { request: ConsentRequest; reused: boolean } | null {
    const userId = clean(input.userId, 200);
    const targetFieldId = clean(input.targetFieldId, 400);
    if (!userId || !targetFieldId) return null;

    this.sweep(now);

    const pairingKey = clean(input.pairingKey, 600) || targetFieldId;

    // Same FIELD, still pending? Refresh it rather than stacking a duplicate.
    // Keyed on the pairing key, not the address: re-opening the node re-mints
    // the address, and the operator would see two prompts for what is, to them,
    // one field.
    for (const existing of this.requests.values()) {
      if (
        existing.userId === userId
        && existing.pairingKey === pairingKey
        && existing.state === 'pending'
      ) {
        // The address may have been re-minted since; the prompt must point at
        // the CURRENT one or approval would bind a dead destination.
        existing.targetFieldId = targetFieldId;
        existing.expiresAt = now + CONSENT_TTL_MS;
        existing.nodeId = clean(input.nodeId, 200) || existing.nodeId;
        existing.fieldKey = clean(input.fieldKey, 200) || existing.fieldKey;
        existing.label = clean(input.label, 200) || existing.label;
        existing.action = clean(input.action, 200) || existing.action;
        return { request: { ...existing }, reused: true };
      }
    }

    // Bounded. A dashboard in a reload loop must not be able to grow this map
    // without limit, and the OLDEST pending prompt is the one least likely to
    // still be on screen.
    const mine = [...this.requests.values()].filter((r) => r.userId === userId);
    if (mine.length >= CONSENT_MAX_PER_USER) {
      const oldest = mine
        .filter((r) => r.state === 'pending')
        .sort((a, b) => a.requestedAt - b.requestedAt)[0]
        || mine.sort((a, b) => a.requestedAt - b.requestedAt)[0];
      if (oldest) this.requests.delete(oldest.consentId);
    }

    const request: ConsentRequest = {
      consentId: newConsentId(),
      userId,
      targetFieldId,
      pairingKey,
      nodeId: clean(input.nodeId, 200),
      fieldKey: clean(input.fieldKey, 200),
      label: clean(input.label, 200),
      action: clean(input.action, 200),
      state: 'pending',
      requestedAt: now,
      expiresAt: now + CONSENT_TTL_MS,
      decidedAt: 0,
    };
    this.requests.set(request.consentId, request);
    return { request: { ...request }, reused: false };
  }

  /**
   * Everything this user is currently being asked, oldest first.
   *
   * Oldest first because the browser renders them as a stack and the operator
   * should answer the question they were asked first — not the one that happens
   * to have been added last.
   */
  pendingFor(userId: string, now = Date.now()): ConsentPrompt[] {
    this.sweep(now);
    const owner = clean(userId, 200);
    return [...this.requests.values()]
      .filter((r) => r.userId === owner && r.state === 'pending')
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map(toPrompt);
  }

  /** One request by id, whatever its state. `null` when unknown or swept. */
  get(consentId: string, now = Date.now()): ConsentView | null {
    this.sweep(now);
    const r = this.requests.get(clean(consentId, 100));
    return r ? { ...r } : null;
  }

  /**
   * Record the human's answer.
   *
   * Grants NOTHING. The caller performs the grant, so authority is created in
   * one place (`InspectorAuthorization`) whether it arrived by code or by
   * consent. A decision is final: answering twice is refused rather than
   * silently re-applied, because the second answer may be a stale screen.
   */
  decide(
    consentId: string,
    approve: boolean,
    now = Date.now(),
  ): ConsentDecision {
    this.sweep(now);
    const r = this.requests.get(clean(consentId, 100));
    if (!r) return { ok: false, reason: 'not_found' };
    if (r.state !== 'pending') {
      return {
        ok: false,
        reason: r.state === 'expired' ? 'expired' : 'already_decided',
        request: { ...r },
      };
    }
    if (now >= r.expiresAt) {
      r.state = 'expired';
      r.decidedAt = now;
      return { ok: false, reason: 'expired', request: { ...r } };
    }
    r.state = approve ? 'approved' : 'denied';
    r.decidedAt = now;
    return { ok: true, request: { ...r } };
  }

  /** Drop everything for one user — used when a field is unpaired. */
  clearForUser(userId: string): number {
    const owner = clean(userId, 200);
    let n = 0;
    for (const [id, r] of this.requests) {
      if (r.userId === owner) { this.requests.delete(id); n += 1; }
    }
    return n;
  }

  /**
   * Drop the prompt(s) for one FIELD.
   *
   * Called when a field stops being a destination: an unanswered question about
   * a field nobody is targeting any more must not stay on screen, because
   * approving it would bind something the dashboard has forgotten.
   */
  clearForPairing(userId: string, pairingKey: string): number {
    const owner = clean(userId, 200);
    const pk = clean(pairingKey, 600);
    let n = 0;
    for (const [id, r] of this.requests) {
      if (r.userId === owner && r.pairingKey === pk) { this.requests.delete(id); n += 1; }
    }
    return n;
  }

  /** Test/diagnostic surface. */
  size(): number { return this.requests.size; }

  /** Test-only reset, mirroring the other registries. */
  resetForTests(): void { this.requests.clear(); }

  /**
   * Expire what is past its time and forget what has been read long enough.
   *
   * Called on every entry point rather than on a timer: a timer in a module
   * this small is one more thing to shut down in tests, and the map is bounded
   * by CONSENT_MAX_PER_USER so the scan is cheap.
   */
  private sweep(now: number): void {
    for (const [id, r] of this.requests) {
      if (r.state === 'pending' && now >= r.expiresAt) {
        r.state = 'expired';
        r.decidedAt = now;
        continue;
      }
      if (r.state !== 'pending' && now - r.decidedAt >= CONSENT_DECISION_TTL_MS) {
        this.requests.delete(id);
      }
    }
  }
}

export const remoteTargetConsent = new RemoteTargetConsentRegistry();
