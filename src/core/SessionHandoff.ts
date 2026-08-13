/**
 * SessionHandoff — move a live browser session between the SERVER and the
 * USER'S OWN MACHINE without it becoming a different session.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT WAS ASKED FOR
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The operator's requirement, verbatim on the point that matters most:
 *
 *   «نکته مهم: Remote و Local نباید دو Session مستقل باشند؛ هر دو باید به یک
 *    Automation Session و همان Node Automation روی Server متصل باشند. کاربر
 *    نباید درگیر جزئیات فنی این جابه‌جایی شود.»
 *
 *   "Remote and Local must NOT be two independent sessions; both must attach to
 *    ONE Automation Session and the same Node Automation on the server. The user
 *    must not be exposed to the technical details of this switch."
 *
 * and the feeling it should produce:
 *
 *   "the same Remote Browser moved from the Server to my own Windows with one
 *    click" — same tabs, same order, same active tab, still logged in.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE SESSION IS ALREADY ONE — AND WHAT WAS ACTUALLY MISSING
 * ══════════════════════════════════════════════════════════════════════════
 *
 * It would be easy to over-build this. The automation session is ALREADY
 * single: `BrowserAdapter.acquireContext(userId)` is the only way anything gets
 * a browser, `browserModes` holds one mode per user, and `InspectorHub` holds
 * one active node per user. Switching mode flips a name in a registry — it does
 * not create, destroy or fork a session, and the ~3100 lines of node logic in
 * pipeline.ts contain no mode checks at all. So "one Automation Session across
 * both modes" is a property the architecture already had.
 *
 * What was genuinely missing is that the two modes shared no BROWSER STATE.
 * Switching to local gave the user a correct session attached to a browser
 * showing none of their work: different tabs, different cookies, nothing where
 * they left it. Technically one session; experientially a new browser. That gap
 * is what this file closes, and it is deliberately the ONLY thing it does:
 *
 *   1. an explicit, stable AUTOMATION SESSION ID that survives mode switches,
 *      so both sides can PROVE they are on the same session rather than be
 *      asked to trust it;
 *   2. a SNAPSHOT of what the user can see — tab URLs, their order, which one
 *      was in front — plus the cookies/localStorage that make those tabs
 *      logged in;
 *   3. a PAIRING CODE so the extension can join that session without the user
 *      pasting an API key into a browser extension.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A PAIRING CODE AND NOT THE API KEY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The API key is the credential that grants FULL control of the instance: it
 * drives a real browser, reads and writes the download directory, and runs
 * workflows. Asking a user to paste it into a browser extension is asking them
 * to put an unrevocable master key into the most-attacked surface on their
 * machine, where every other extension with `storage` permission may reach it.
 *
 * A pairing code is the opposite trade in every dimension: it is short-lived
 * (PAIRING_TTL_MS), SINGLE-USE, scoped to one session, and revocable on its
 * own. Redeeming it returns a long random session token which is what the
 * extension actually stores. So a stolen code is worth almost nothing (it
 * expires in minutes and dies the moment it is used once), and a stolen token
 * is worth one session rather than the whole instance.
 *
 * The code alphabet excludes 0/O/1/I/L because a human reads it off a screen
 * and types it into another window; "was that a one or an I" is a support
 * ticket, and an ambiguous character in a single-use code means the code is
 * now burned and they have to start over.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY *NOT* PROMISED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `HandoffSnapshot.limits` reports what could not come across, and the UI shows
 * it. This is the load-bearing honesty of the feature. Some things genuinely
 * cannot transfer, and claiming otherwise would be worse than saying so:
 *
 *   - HttpOnly cookies for a domain the browser never visits again cannot be
 *     injected into a Chrome we do not launch ourselves.
 *   - Unsubmitted form input, scroll position and in-page JS state are not in
 *     any snapshot; they live in the renderer we are leaving behind.
 *   - Tabs beyond MAX_SAVED_TABS are dropped, matching the existing cap.
 *
 * So the promise made here is precise: the same PAGES, in the same ORDER, with
 * the same LOGINS, and the automation session unbroken. Not a memory dump of a
 * renderer process.
 */

import crypto from 'crypto';

import { type SavedTab, sanitizeTabs, MAX_SAVED_TABS } from './BrowserTabs';
import { type BrowserModeName } from './BrowserMode';

/**
 * How long a pairing code is worth anything.
 *
 * Five minutes is the span of "I clicked Switch to Local, the install page
 * opened, I installed the extension, I clicked Pair". Long enough not to expire
 * mid-install on a slow connection; short enough that a code left on a shared
 * screen or in a screenshot is dead before it can be used.
 */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * How long a captured snapshot is worth applying.
 *
 * Longer than the pairing TTL because the snapshot is taken BEFORE the install
 * detour and applied after it. Ten minutes bounds the staleness: restoring tabs
 * from an hour ago would not feel like "my browser moved", it would feel like a
 * confusing resurrection of old work.
 */
export const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/**
 * Human-typeable alphabet: no 0/O, no 1/I/L.
 *
 * See the header — an ambiguous character in a SINGLE-USE code costs the user
 * the code itself, not just a retry.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Cookies/localStorage in Playwright's `storageState` shape. */
export interface HandoffStorage {
  cookies?: unknown[];
  origins?: unknown[];
}

/** What could not be carried across, so the UI can say so out loud. */
export interface HandoffLimits {
  /** Tabs dropped because of MAX_SAVED_TABS. */
  tabsDropped: number;
  /** True when no cookie/localStorage state could be captured at all. */
  storageMissing: boolean;
  /** Stable keys the UI renders in fa/en; never sentences. */
  notes: Array<'tabs_capped' | 'storage_unavailable' | 'no_tabs'>;
}

/**
 * Everything needed to make the other browser look like this one.
 *
 * Note what is NOT here: no handles, no sockets, no page objects. A snapshot is
 * inert data, so a stale or malformed one can never do worse than "you land on
 * your tabs but not logged in".
 */
export interface HandoffSnapshot {
  /** The session this belongs to — the anti-crossover check. */
  sessionId: string;
  /** Which side it was taken from. */
  fromMode: BrowserModeName;
  capturedAt: number;
  /** Same URLs, same order; exactly one carries `active`. */
  tabs: SavedTab[];
  storage?: HandoffStorage;
  limits: HandoffLimits;
}

/** A pairing code as handed to the user, plus the token it will yield. */
export interface Pairing {
  code: string;
  /** The long secret the extension stores. Never shown to the user. */
  token: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  /** Single-use: set the moment it is redeemed. */
  redeemedAt: number;
}

/** The public view of a pairing — the token is omitted until redemption. */
export interface PairingOffer {
  code: string;
  sessionId: string;
  expiresAt: number;
  expiresInMs: number;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * A plain `===` on a token returns faster the earlier it differs, which over
 * many attempts reveals the prefix. `timingSafeEqual` needs equal lengths, so
 * length is checked first — that leaks only the length, which is a constant
 * here anyway.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** A pairing code: short, unambiguous, and drawn from a CSPRNG. */
export function generatePairingCode(length = CODE_LENGTH): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Format a code for display: `ABCD-EFGH` reads and types far better. */
export function formatPairingCode(code: string): string {
  const c = String(code || '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/**
 * Accept a code the way a human will actually type it.
 *
 * Strips the display dash, trims, upper-cases. Users paste `abcd-efgh`, type a
 * trailing space, or use lower case; refusing any of those would be a refusal
 * over formatting, and the user would reasonably read it as "the code is wrong".
 */
export function normalizePairingCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

/**
 * Build the limits report for a captured tab list.
 *
 * Pure and separate so the honesty of the feature is unit-testable without a
 * browser: the UI's "3 tabs could not be moved" comes from here.
 */
export function describeLimits(
  rawTabCount: number,
  keptTabs: SavedTab[],
  hasStorage: boolean,
): HandoffLimits {
  const notes: HandoffLimits['notes'] = [];
  const dropped = Math.max(0, rawTabCount - keptTabs.length);
  if (dropped > 0) notes.push('tabs_capped');
  if (!hasStorage) notes.push('storage_unavailable');
  if (keptTabs.length === 0) notes.push('no_tabs');
  return { tabsDropped: dropped, storageMissing: !hasStorage, notes };
}

/**
 * Turn raw page URLs into a snapshot.
 *
 * Order is preserved exactly, because "same tabs in the same order" was an
 * explicit requirement — a set would have been the natural data structure and
 * would have quietly broken it. `sanitizeTabs` then applies the same scheme
 * allow-list and single-active-tab invariant the existing restore path uses, so
 * a handoff cannot reopen something a normal session restore would refuse.
 */
export function buildSnapshot(opts: {
  sessionId: string;
  fromMode: BrowserModeName;
  tabs: Array<{ url: string; title?: string; active?: boolean }>;
  storage?: HandoffStorage;
  now?: number;
}): HandoffSnapshot {
  const raw = Array.isArray(opts.tabs) ? opts.tabs : [];
  const tabs = sanitizeTabs(raw);
  const hasStorage = Boolean(
    opts.storage
    && ((opts.storage.cookies && opts.storage.cookies.length)
      || (opts.storage.origins && opts.storage.origins.length)),
  );
  return {
    sessionId: opts.sessionId,
    fromMode: opts.fromMode,
    capturedAt: opts.now ?? Date.now(),
    tabs,
    ...(hasStorage ? { storage: opts.storage } : {}),
    limits: describeLimits(raw.length, tabs, hasStorage),
  };
}

/** Is this snapshot still fresh enough to apply? */
export function snapshotIsFresh(snap: HandoffSnapshot | null, now = Date.now()): boolean {
  if (!snap) return false;
  return now - snap.capturedAt <= SNAPSHOT_TTL_MS;
}

/**
 * The registry of automation sessions, pairings and pending handoffs.
 *
 * IN MEMORY, for the same reason BrowserModeRegistry is: everything here
 * describes live things in THIS process — a socket to the user's machine, a
 * context we hold open. Persisting a pairing to Redis would let a fresh process
 * hand out a token for a session whose browser it has no connection to, which
 * is precisely the lie this module exists to prevent.
 *
 * The automation session ID, by contrast, is STABLE per user for the life of
 * the process and is deliberately NOT reissued on a mode switch. That
 * stability is the mechanical expression of "Remote and Local are not two
 * sessions": both sides quote the same ID, and any component can verify it.
 */
export class SessionHandoffRegistry {
  private sessions = new Map<string, string>();
  private pairings = new Map<string, Pairing>();
  private snapshots = new Map<string, HandoffSnapshot>();
  /** Tokens the extension presents, mapped to their user. */
  private tokens = new Map<string, { userId: string; sessionId: string; issuedAt: number }>();

  /**
   * This user's automation session ID, created once and then never changed.
   *
   * Not derived from the mode, and not reissued when the mode flips — that is
   * the whole point. A switch that minted a new ID would be a switch that
   * created a new session, which is exactly what was forbidden.
   */
  sessionId(userId: string): string {
    const existing = this.sessions.get(userId);
    if (existing) return existing;
    const id = `as_${crypto.randomBytes(12).toString('hex')}`;
    this.sessions.set(userId, id);
    return id;
  }

  /**
   * Issue a pairing code for this user's session.
   *
   * Any previous unredeemed code for the same user is dropped. Two live codes
   * for one session means a user staring at a screen showing one code while
   * their extension is happily accepting another — and it doubles the window in
   * which a leaked code is useful.
   */
  issuePairing(userId: string, now = Date.now()): PairingOffer {
    for (const [code, p] of [...this.pairings]) {
      if (p.userId === userId && !p.redeemedAt) this.pairings.delete(code);
    }

    const sessionId = this.sessionId(userId);
    let code = generatePairingCode();
    // Collisions are vanishingly unlikely (31^8) but a collision would hand one
    // user's session to another, so it is checked rather than assumed.
    while (this.pairings.has(code)) code = generatePairingCode();

    const pairing: Pairing = {
      code,
      token: `st_${crypto.randomBytes(24).toString('hex')}`,
      userId,
      sessionId,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      redeemedAt: 0,
    };
    this.pairings.set(code, pairing);
    return {
      code,
      sessionId,
      expiresAt: pairing.expiresAt,
      expiresInMs: PAIRING_TTL_MS,
    };
  }

  /**
   * Redeem a code for a session token. SINGLE USE.
   *
   * Every refusal is a distinct reason rather than a generic failure, because
   * the three cases need different actions from the user: `expired` means press
   * the button again, `already_used` means someone or something else consumed
   * it (worth noticing), and `unknown` means a typo.
   */
  redeemPairing(
    codeInput: unknown,
    now = Date.now(),
  ):
    | { ok: true; token: string; userId: string; sessionId: string }
    | { ok: false; reason: 'unknown' | 'expired' | 'already_used' } {
    const code = normalizePairingCode(codeInput);
    if (!code) return { ok: false, reason: 'unknown' };

    // Constant-time lookup over the live codes: a plain map `get` would leak
    // whether a prefix exists through timing on a large table.
    let found: Pairing | null = null;
    for (const p of this.pairings.values()) {
      if (secretsMatch(p.code, code)) found = p;
    }
    if (!found) return { ok: false, reason: 'unknown' };
    if (found.redeemedAt) return { ok: false, reason: 'already_used' };
    if (now > found.expiresAt) {
      this.pairings.delete(found.code);
      return { ok: false, reason: 'expired' };
    }

    found.redeemedAt = now;
    this.tokens.set(found.token, {
      userId: found.userId,
      sessionId: found.sessionId,
      issuedAt: now,
    });
    // The code is KEPT, as a spent tombstone, until `sweep` retires it.
    //
    // Deleting it here looks tidier and is what an earlier version did, but it
    // made the `already_used` branch above unreachable: a replayed code came
    // back as `unknown`, i.e. the extension told the user "check what you
    // typed" for the one case that is not a typo. A code being presented twice
    // is the signal that it leaked, and it is exactly the signal that must not
    // be rounded down to a spelling mistake. The tombstone cannot be redeemed
    // (`redeemedAt` is checked first), so retaining it widens no replay window
    // -- it only preserves the ability to say what happened.
    return { ok: true, token: found.token, userId: found.userId, sessionId: found.sessionId };
  }

  /** Whose session does this token belong to? null when it is not ours. */
  resolveToken(tokenInput: unknown): { userId: string; sessionId: string } | null {
    const token = String(tokenInput ?? '');
    if (!token) return null;
    for (const [known, meta] of this.tokens) {
      if (secretsMatch(known, token)) return { userId: meta.userId, sessionId: meta.sessionId };
    }
    return null;
  }

  /** Revoke a token (the user pressed Disconnect, or lost the machine). */
  revokeToken(tokenInput: unknown): boolean {
    const token = String(tokenInput ?? '');
    for (const known of [...this.tokens.keys()]) {
      if (secretsMatch(known, token)) { this.tokens.delete(known); return true; }
    }
    return false;
  }

  /** Store the snapshot the other side will apply. */
  putSnapshot(userId: string, snap: HandoffSnapshot): void {
    this.snapshots.set(userId, snap);
  }

  /**
   * Read the pending snapshot WITHOUT consuming it.
   *
   * Peek is the default for the same reason the inspector inbox peeks: a client
   * that asks and then fails to apply the result — a reload mid-restore, a
   * service worker recycled by Chrome — must not have destroyed the only copy of
   * where the user's tabs were.
   */
  peekSnapshot(userId: string, now = Date.now()): HandoffSnapshot | null {
    const snap = this.snapshots.get(userId) || null;
    if (!snap) return null;
    if (!snapshotIsFresh(snap, now)) { this.snapshots.delete(userId); return null; }
    return snap;
  }

  /** Take the snapshot and clear it — for a client that commits to applying it. */
  takeSnapshot(userId: string, now = Date.now()): HandoffSnapshot | null {
    const snap = this.peekSnapshot(userId, now);
    if (snap) this.snapshots.delete(userId);
    return snap;
  }

  clearSnapshot(userId: string): void {
    this.snapshots.delete(userId);
  }

  /** Drop expired codes and stale snapshots. Cheap; called from the routes. */
  sweep(now = Date.now()): void {
    // Spent codes are retired by EXPIRY, not the instant they are redeemed.
    // Dropping them on redemption would erase the tombstone that lets a
    // replayed code be reported as `already_used` rather than as a typo, and
    // `sweep()` runs at the top of the pair route -- so an eager sweep here
    // would defeat that within milliseconds. A redeemed code is unusable
    // regardless, so the only thing this retention buys is an honest message.
    for (const [code, p] of [...this.pairings]) {
      if (now > p.expiresAt) this.pairings.delete(code);
    }
    for (const [userId, snap] of [...this.snapshots]) {
      if (!snapshotIsFresh(snap, now)) this.snapshots.delete(userId);
    }
  }

  /** Test helper. */
  reset(): void {
    this.sessions.clear();
    this.pairings.clear();
    this.snapshots.clear();
    this.tokens.clear();
  }
}

/**
 * The process-wide registry.
 *
 * Singleton because the session identity it hands out must be the same one
 * every component sees; two registries would issue two IDs for one user and
 * reintroduce exactly the "two independent sessions" this file prevents.
 */
export const sessionHandoff = new SessionHandoffRegistry();

export { MAX_SAVED_TABS };
