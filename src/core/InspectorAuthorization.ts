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

/**
 * How long a PAIRING survives — the durable half of the requirement.
 *
 *   «بعد از موفقیت، اتصال بین Extension/API Key و Target Field برقرار و ماندگار
 *    می‌شود. دفعات بعد برای همان Extension و همان Target Field، دیگر
 *    Authorization Code لازم نیست.»
 *
 * Much longer than BINDING_TTL_MS, and that difference is the point. A BINDING
 * says "this key may write to this ADDRESS right now" and dies with the address.
 * A PAIRING says "this Extension and this FIELD know each other", and must
 * outlive every address the field is ever given — otherwise closing the node
 * for lunch would cost another code, which is the behaviour being removed.
 *
 * Still bounded, and still in memory: an entry nobody has touched for a month is
 * indistinguishable from abandoned, and a restart is an honest reset rather than
 * a stale grant nobody can see or revoke.
 */
export const PAIRING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A code waiting to be redeemed. Never returned to a client after issue. */
interface PendingCode {
  code: string;
  userId: string;
  targetFieldId: string;
  /**
   * The STABLE identity the resulting pairing is filed under. Captured at issue
   * time because the ephemeral `targetFieldId` above may well be gone by the
   * time the user finishes typing — the pairing must survive that.
   */
  pairingKey: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AuthorizationOffer {
  code: string;
  targetFieldId: string;
  pairingKey: string;
  expiresAt: number;
  expiresInMs: number;
}

export interface Binding {
  userId: string;
  targetFieldId: string;
  boundAt: number;
}

/** The durable Extension⇄Target-Field relationship. Keyed by pairingKey. */
export interface Pairing {
  userId: string;
  pairingKey: string;
  /** The address current at pairing time. Informational only — never authority. */
  targetFieldId: string;
  pairedAt: number;
  /**
   * How the pairing came to exist.
   *
   *   code   — the user typed an Authorization Code (LOCAL first use).
   *   server — the server granted it because it owns the browser (REMOTE).
   *
   * Kept apart so a status view can tell the user the truth about why they were
   * not asked for anything, and so an audit can distinguish a human act from an
   * automatic one.
   */
  via: 'code' | 'server';
}

export type RedeemFailure =
  | 'INVALID_AUTHORIZATION_CODE'
  | 'AUTHORIZATION_EXPIRED';

export type RedeemResult =
  | { ok: true; binding: Binding; clientToken?: string }
  | { ok: false; reason: RedeemFailure };

/**
 * A CLIENT TOKEN — the credential a redeemed code produces.
 *
 * ── WHY THIS TYPE HAD TO EXIST ─────────────────────────────────────────────
 * REPORTED, with a correct Base URL and a correct code:
 *
 *   «در حالت ریموت وقتی ادرس و کد اتورایز رو وارد کردم این ارور رو داد در حالی
 *    که هر دو درست بودن — That authorization code was not accepted.»
 *
 * The code was never examined. `/inspector/pair` sits behind the global API-key
 * middleware, and a REMOTE extension is one the operator installed by hand:
 * there is no `bootstrap.config.js` in it, so `ab_apiKey` is empty and the
 * request arrived unauthenticated. The middleware answered 401 before the route
 * ran, and the popup printed its generic fallback sentence — reporting a bad
 * code for what was actually a missing credential.
 *
 * That is a contradiction in the design rather than a slip. REMOTE's entire
 * premise is «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند» — two machines, no
 * channel between them but the operator. Requiring the far end to ALREADY hold
 * this server's key to redeem a code makes the code pointless: anything holding
 * the key needs no code, and anything lacking it cannot redeem one.
 *
 * ── THE RESOLUTION ─────────────────────────────────────────────────────────
 * THE CODE IS THE CREDENTIAL, once, and redeeming it mints a narrow token that
 * the extension uses for everything afterwards. So:
 *
 *   - the code proves "the human holding this browser is the human who was
 *     looking at that field on the dashboard" — which is exactly what a
 *     transcribed one-time secret can prove, and all it needs to prove;
 *   - the token that comes back is NOT the server's API_TOKEN and grants none
 *     of its powers. It is accepted on the inspector's element-submission path
 *     alone, and only for target fields this client has actually paired with.
 *
 * The standing rule is untouched: «The Extension must NEVER be able to choose an
 * arbitrary Target Field.» The token identifies a client; the SERVER still
 * decides, from its own binding table, which fields that client may write to.
 */
export interface ClientToken {
  token: string;
  /** The client identity this token stands in for — same space as clientIdOf(). */
  clientId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

/** Prefix so the token is recognisable in a log and cannot be confused for a key. */
const CLIENT_TOKEN_PREFIX = 'ict_';

/**
 * How long a client token lives.
 *
 * Matched to PAIRING_TTL_MS, because the two describe the same relationship: the
 * pairing says this extension and this field know each other, and the token is
 * how the extension proves it is that extension. A token that died first would
 * silently demote a live pairing into "not accepted" — the very failure this
 * whole change exists to remove.
 */
export const CLIENT_TOKEN_TTL_MS = PAIRING_TTL_MS;

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
   * clientId -> pairingKey -> pairing. The durable half.
   *
   * Separate map, not a flag on Binding, because the two have different
   * lifetimes and different keys: a binding is per ADDRESS and dies with it, a
   * pairing is per FIELD and must not. Merging them is exactly how the previous
   * build lost the pairing every time the node was re-opened.
   */
  private pairings = new Map<string, Map<string, Pairing>>();
  /**
   * token -> the client it identifies. The credential a redeemed code mints.
   *
   * Keyed by the token because that is what arrives on a request. Stored in full
   * rather than hashed — unlike an API key, this value is MINTED here and never
   * seen anywhere else, so the map is its only record and there is nothing to
   * protect it from that hashing would help with. (Hashing the key in the maps
   * above is worth it because that key exists in the operator's .env too.)
   */
  private clientTokens = new Map<string, ClientToken>();

  /**
   * Issue a code for one Target Field.
   *
   * Any previous unredeemed code for the SAME user+target is dropped first, so
   * pressing "Authorize" twice cannot leave two valid codes for one destination
   * — the older one on a stale screen would otherwise still work.
   *
   * `pairingKey` is the stable identity the resulting pairing is filed under. It
   * is optional and falls back to the targetFieldId so every pre-existing caller
   * keeps its old semantics; callers that want the pairing to PERSIST across NDV
   * re-opens must pass the registry's `pairingKey`.
   */
  issue(
    userId: string,
    targetFieldId: string,
    now = Date.now(),
    pairingKey?: string,
  ): AuthorizationOffer | null {
    const owner = clean(userId, 200);
    const target = clean(targetFieldId, 400);
    if (!owner || !target) return null;
    const pk = clean(pairingKey, 600) || target;

    for (const [code, p] of this.pending) {
      if (p.userId === owner && p.targetFieldId === target) this.pending.delete(code);
    }

    // Collision-checked: a duplicate would let one redemption consume another
    // user's offer.
    let code = generatePairingCode();
    let guard = 0;
    while (this.pending.has(code) && guard < 10) { code = generatePairingCode(); guard += 1; }

    const expiresAt = now + AUTH_CODE_TTL_MS;
    this.pending.set(code, {
      code, userId: owner, targetFieldId: target, pairingKey: pk, issuedAt: now, expiresAt,
    });
    return { code, targetFieldId: target, pairingKey: pk, expiresAt, expiresInMs: AUTH_CODE_TTL_MS };
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
    // ── AN EMPTY KEY IS NO LONGER A REFUSAL ────────────────────────────────
    //
    // It used to be, and that was the reported bug: a hand-installed REMOTE
    // extension has no key, so this returned INVALID_AUTHORIZATION_CODE for a
    // code that was perfectly valid — blaming the code for a missing credential.
    //
    // A keyless caller is now identified by the code itself. The client id is
    // derived from a freshly minted secret below, so two keyless extensions get
    // two distinct identities rather than colliding on the digest of ''.
    if (!code) return { ok: false, reason: 'INVALID_AUTHORIZATION_CODE' };

    let found: PendingCode | null = null;
    for (const p of this.pending.values()) {
      if (secretsMatch(p.code, code)) { found = p; break; }
    }
    if (!found) return { ok: false, reason: 'INVALID_AUTHORIZATION_CODE' };

    // Consumed either way: an expired code must not linger to be retried.
    this.pending.delete(found.code);
    if (now > found.expiresAt) return { ok: false, reason: 'AUTHORIZATION_EXPIRED' };

    // ── WHO IS THIS CLIENT? ────────────────────────────────────────────────
    //
    // With a key, the client is that key — unchanged, so a dashboard or a
    // server-seeded extension keeps exactly the identity it had.
    //
    // Without one, the client is a NEW identity minted here. It cannot be
    // `clientIdOf('')`: every keyless extension in the world would hash to that
    // same value, and one operator's binding would answer for another's. The
    // token issued below is the only way to present this identity again, which
    // is what makes it a credential rather than a guess.
    const clientSecret = key || `${CLIENT_TOKEN_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
    const clientId = clientIdOf(clientSecret);
    let mine = this.bindings.get(clientId);
    if (!mine) { mine = new Map(); this.bindings.set(clientId, mine); }

    const binding: Binding = {
      userId: found.userId,
      targetFieldId: found.targetFieldId,
      boundAt: now,
    };
    mine.set(found.targetFieldId, binding);

    // …and the durable half. This is the line that makes «دفعات بعد دیگر
    // Authorization Code لازم نیست» true: the address above will be replaced
    // the next time the node is opened, but this record is filed under an
    // identity that does not change, so the next visit finds it.
    this.recordPairing(clientId, {
      userId: found.userId,
      pairingKey: found.pairingKey,
      targetFieldId: found.targetFieldId,
      pairedAt: now,
      via: 'code',
    });

    // ── THE TOKEN, ISSUED ONLY TO A CALLER THAT HAD NO KEY ─────────────────
    //
    // A caller that already authenticated needs nothing further, and handing it
    // a second credential would be pure surface area. A keyless caller gets the
    // token that lets it come back — this is the single moment its identity is
    // expressible, so if it is not returned here it is lost.
    if (!key) {
      const ct: ClientToken = {
        token: clientSecret,
        clientId,
        userId: found.userId,
        issuedAt: now,
        expiresAt: now + CLIENT_TOKEN_TTL_MS,
      };
      this.clientTokens.set(ct.token, ct);
      return { ok: true, binding, clientToken: ct.token };
    }

    return { ok: true, binding };
  }

  /**
   * Authorize with no code, because the server owns the browser.
   *
   * The REMOTE branch of the requirement: «برای REMOTE BROWSER نیازی به
   * Authorization Code نیست». That is not a relaxation of security — the remote
   * Chromium is launched by this process, with an extension this process
   * side-loaded and pre-seeded with this process's own token (see
   * InspectorExtension). A code there would ask the user to copy a secret out of
   * one of the server's windows and into another of the server's windows to
   * prove they are themselves.
   *
   * Deliberately NOT reachable from a request body: routes call this only after
   * `planTargeting()` has returned `serverMayGrant`, which is only ever true for
   * `remote`. A client cannot ask to be granted.
   */
  grant(
    apiKey: string,
    userId: string,
    targetFieldId: string,
    pairingKey?: string,
    now = Date.now(),
  ): Binding | null {
    const key = clean(apiKey, 400);
    const owner = clean(userId, 200);
    const target = clean(targetFieldId, 400);
    if (!key || !owner || !target) return null;

    const clientId = clientIdOf(key);
    let mine = this.bindings.get(clientId);
    if (!mine) { mine = new Map(); this.bindings.set(clientId, mine); }

    const binding: Binding = { userId: owner, targetFieldId: target, boundAt: now };
    mine.set(target, binding);

    this.recordPairing(clientId, {
      userId: owner,
      pairingKey: clean(pairingKey, 600) || target,
      targetFieldId: target,
      pairedAt: now,
      via: 'server',
    });

    return { ...binding };
  }

  /**
   * Has this Extension already paired with this Target Field?
   *
   * THE question the chooser asks before deciding whether to mint a code, and
   * the reason `pairingKey` exists. Asked about the stable identity, so
   * re-opening the node answers "yes" — which is the whole requirement.
   */
  isPaired(apiKey: string, userId: string, pairingKey: string, now = Date.now()): boolean {
    const mine = this.pairings.get(clientIdOf(clean(apiKey, 400)));
    if (!mine) return false;
    const p = mine.get(clean(pairingKey, 600));
    if (!p) return false;
    if (p.userId !== clean(userId, 200)) return false;
    if (now - p.pairedAt > PAIRING_TTL_MS) { mine.delete(p.pairingKey); return false; }
    return true;
  }

  /**
   * Is ANY Inspector client of this user paired with this field?
   *
   * The same question as `isPaired`, asked from the other side of the wire, and
   * both are needed because the two askers hold different credentials.
   *
   * The EXTENSION asks `isPaired` — it knows its own key and wants to know what
   * IT may write to. The DASHBOARD asks this one: it is deciding whether to put
   * an Authorization Code on screen, and it genuinely cannot know which
   * extension the user will type it into. Requiring the dashboard's key to match
   * would make the answer "no" whenever the two are configured with different
   * keys, and the user would be handed a code for a pairing that already exists
   * — the exact papercut this change removes.
   *
   * Still scoped to the USER, so this leaks nothing across accounts: the most it
   * reveals to its own owner is that one of their own extensions is paired.
   */
  isPairedForUser(userId: string, pairingKey: string, now = Date.now()): boolean {
    const owner = clean(userId, 200);
    const pk = clean(pairingKey, 600);
    if (!owner || !pk) return false;
    for (const mine of this.pairings.values()) {
      const p = mine.get(pk);
      if (!p || p.userId !== owner) continue;
      if (now - p.pairedAt > PAIRING_TTL_MS) { mine.delete(pk); continue; }
      return true;
    }
    return false;
  }

  /**
   * Point every client already paired with this field at its NEW address.
   *
   * The return visit, in one call. The pairing survived; the `targetFieldId` did
   * not, because `register()` mints a fresh suffix each time. Without this the
   * user would be correctly told "no code needed" and then find that nothing
   * could actually be delivered — trust with no address is not usable.
   *
   * Returns how many clients were re-pointed, so the caller can tell "refreshed
   * an existing pairing" from "there was nothing to refresh".
   */
  rebindForUser(
    userId: string,
    targetFieldId: string,
    pairingKey: string,
    now = Date.now(),
  ): number {
    const owner = clean(userId, 200);
    const target = clean(targetFieldId, 400);
    const pk = clean(pairingKey, 600);
    if (!owner || !target || !pk) return 0;

    let count = 0;
    for (const [clientId, pairs] of this.pairings) {
      const p = pairs.get(pk);
      if (!p || p.userId !== owner) continue;
      if (now - p.pairedAt > PAIRING_TTL_MS) { pairs.delete(pk); continue; }

      let mine = this.bindings.get(clientId);
      if (!mine) { mine = new Map(); this.bindings.set(clientId, mine); }
      mine.set(target, { userId: owner, targetFieldId: target, boundAt: now });

      p.targetFieldId = target;
      p.pairedAt = now;
      count += 1;
    }
    return count;
  }

  /**
   * Re-issue the live binding for an already-paired field.
   *
   * The bridge between the two lifetimes. On a return visit the pairing is
   * intact but the ADDRESS is brand new, so nothing may be delivered yet. Rather
   * than asking for a code the user has already given, the server re-points the
   * existing pairing at the new address.
   *
   * Refuses when there is no pairing — it can only refresh trust that already
   * exists, never create it.
   */
  rebind(
    apiKey: string,
    userId: string,
    targetFieldId: string,
    pairingKey: string,
    now = Date.now(),
  ): Binding | null {
    if (!this.isPaired(apiKey, userId, pairingKey, now)) return null;

    const clientId = clientIdOf(clean(apiKey, 400));
    const owner = clean(userId, 200);
    const target = clean(targetFieldId, 400);
    if (!target) return null;

    let mine = this.bindings.get(clientId);
    if (!mine) { mine = new Map(); this.bindings.set(clientId, mine); }
    const binding: Binding = { userId: owner, targetFieldId: target, boundAt: now };
    mine.set(target, binding);

    // Keep the pairing pointed at the address it now serves, and refresh its
    // clock: a field in active use should not age out mid-session.
    const pairs = this.pairings.get(clientId);
    const existing = pairs?.get(clean(pairingKey, 600));
    if (existing) { existing.targetFieldId = target; existing.pairedAt = now; }

    return { ...binding };
  }

  /**
   * Forget one pairing — the deliberate "unpair", never a side effect.
   *
   * Separate from `revoke` because the two mean different things: `revoke` drops
   * an address that no longer exists, which happens constantly and must NOT cost
   * the user a new code; this drops the relationship itself, which should happen
   * only when a human asks for it.
   */
  unpair(pairingKey: string): number {
    const pk = clean(pairingKey, 600);
    let removed = 0;
    for (const [clientId, mine] of this.pairings) {
      if (mine.delete(pk)) removed += 1;
      if (!mine.size) this.pairings.delete(clientId);
    }
    return removed;
  }

  /** Every field this key is paired with, for a status view. */
  pairingsFor(apiKey: string): Pairing[] {
    const mine = this.pairings.get(clientIdOf(clean(apiKey, 400)));
    return mine ? [...mine.values()].map((p) => ({ ...p })) : [];
  }

  private recordPairing(clientId: string, pairing: Pairing): void {
    let mine = this.pairings.get(clientId);
    if (!mine) { mine = new Map(); this.pairings.set(clientId, mine); }
    mine.set(pairing.pairingKey, pairing);
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
   *
   * Drops the ADDRESS only. The PAIRING is untouched, deliberately — closing an
   * NDV is not the user saying "forget this extension", and treating it as such
   * is what forced a new code on every visit. Use `unpair()` for that.
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

  /**
   * Resolve a client token to the client it identifies, or null.
   *
   * THE ONLY WAY A TOKEN BECOMES AUTHORITY. Note what it deliberately does not
   * do: it does not say what the client may write to. The caller must still ask
   * `isAuthorized(token, targetFieldId)`, which consults the binding table — so
   * a valid token for client A cannot reach client B's field, and the rule «The
   * Extension must NEVER be able to choose an arbitrary Target Field» survives
   * the introduction of a credential the extension holds.
   *
   * Expiry is enforced here rather than only in `sweep()`, because a sweep runs
   * on a timer and this runs on every request: a token that expired one second
   * ago must not be honoured just because the broom has not come round yet.
   */
  resolveClientToken(token: unknown, now = Date.now()): ClientToken | null {
    const t = clean(token, 200);
    if (!t) return null;
    const ct = this.clientTokens.get(t);
    if (!ct) return null;
    if (now > ct.expiresAt) { this.clientTokens.delete(t); return null; }
    return { ...ct };
  }

  /**
   * Is this token a recognised client at all? A cheap boolean for middleware
   * that only needs to decide whether to let the request reach a route.
   */
  isClientToken(token: unknown, now = Date.now()): boolean {
    return this.resolveClientToken(token, now) !== null;
  }

  /** Forget one client token — the extension unpaired, or the operator revoked it. */
  revokeClientToken(token: unknown): boolean {
    const t = clean(token, 200);
    return t ? this.clientTokens.delete(t) : false;
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
    for (const [clientId, mine] of this.pairings) {
      for (const [pk, p] of mine) {
        if (now - p.pairedAt > PAIRING_TTL_MS) mine.delete(pk);
      }
      if (!mine.size) this.pairings.delete(clientId);
    }
    // Client tokens expire too. `resolveClientToken` already refuses an expired
    // one on the request path, so this is purely about not growing the map
    // forever — the correctness is enforced where it is read, not here.
    for (const [token, ct] of this.clientTokens) {
      if (now > ct.expiresAt) this.clientTokens.delete(token);
    }
  }

  clear(): void {
    this.pending.clear();
    this.bindings.clear();
    this.pairings.clear();
    this.clientTokens.clear();
  }
}

export const inspectorAuth = new InspectorAuthorizationRegistry();
