'use strict';

/**
 * BrowserEnvironment — the FIRST question the Targeting flow asks.
 *
 * THE REQUIREMENT THIS FILE ENCODES
 * ---------------------------------
 *   «وقتی کاربر روی آیکون 🎯 Target This Field کلیک می‌کند، اولین مرحله باید
 *    انتخاب Browser Environment باشد، نه Connection Mode.»
 *
 * Before this existed, pressing the crosshair went straight to
 * `openRealBrowser()` — the Remote browser, always, with no question asked. The
 * user never got to say "actually, use MY Chrome". Meanwhile the pairing code
 * lived behind a SEPARATE button ("Connect Inspector") further down the same
 * row, so the two halves of one workflow were two unrelated controls and
 * nothing tied the code to the browser it was for.
 *
 * So the branch point is now a first-class, server-side decision:
 *
 *     🎯 Target This Field
 *              ↓
 *     LOCAL BROWSER  |  REMOTE BROWSER
 *              ↓
 *     Authorization  — only when it is actually needed
 *              ↓
 *          Targeting
 *
 * WHY THIS MODULE IS PURE
 * -----------------------
 * It holds no state, opens no browser and touches no registry. It answers one
 * question — «given this environment and this pairing state, what happens
 * next?» — as a total function. That is deliberate: the branch is the part of
 * the feature most likely to be got subtly wrong (issue a code when one is not
 * needed, or skip one when it IS needed), and a pure function is the only shape
 * that can be exhaustively tested without a browser, a socket or a clock.
 *
 * The routes in mode.routes.ts do the effectful parts (mint the code, grant the
 * binding, open the browser) and consult this file for WHICH of them to do.
 *
 * THREE CONCEPTS THAT MUST NOT BE CONFLATED
 * -----------------------------------------
 * The requirement is explicit that these are different things, and the previous
 * design blurred all three into `sessionId`:
 *
 *   BrowserEnvironment  LOCAL / REMOTE — WHICH BROWSER does the picking, named
 *                       from the PROJECT's point of view: LOCAL is the runtime
 *                       on this same server, REMOTE is a browser on a machine
 *                       this server does not own. THIS FILE. Chosen per run.
 *                       Never to be confused with where the BACKEND is, which
 *                       is not a user choice at all.
 *   Session / Handoff   The Remote⇄Local transfer plumbing (SessionHandoff,
 *                       `as_…` ids, tab snapshots). Untouched by this file, and
 *                       deliberately NOT the routing mechanism for a pick.
 *   targetFieldId       WHERE the data lands: `node_<nodeId>__<fieldKey>__<sfx>`.
 *                       Owned by TargetFieldRegistry.
 *
 * Nothing here reads a sessionId, which is what makes «a mode switch must not
 * invalidate a Target Field» true by construction rather than by convention.
 */

/** The two environments. There is no third, and no 'auto'. */
export type BrowserEnvironmentName = 'local' | 'remote';

export const BROWSER_ENVIRONMENTS: readonly BrowserEnvironmentName[] = [
  'local',
  'remote',
] as const;

/** Is this string one of the two environments? Used to validate request bodies. */
export function isBrowserEnvironment(value: unknown): value is BrowserEnvironmentName {
  return value === 'local' || value === 'remote';
}

/**
 * Coerce anything into an environment.
 *
 * Deliberately total and defaulting to `remote`: remote is the environment with
 * no prerequisites — no extension to install, no agent, no pairing — so a
 * malformed request degrades into the one that always works rather than into a
 * 500 or into a promise of a local browser that is not there.
 */
export function normalizeBrowserEnvironment(
  value: unknown,
  fallback: BrowserEnvironmentName = 'remote',
): BrowserEnvironmentName {
  if (isBrowserEnvironment(value)) return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'local') return 'local';
  if (s === 'remote') return 'remote';
  return fallback;
}

/**
 * What the Targeting flow does next.
 *
 *   targeting — go straight to picking. The browser is this server's own.
 *   authorize — issue an Authorization Code and wait for a browser on ANOTHER
 *               machine to redeem it.
 *
 * ── WHY `authorize` IS BACK, AND WHY THAT IS NOT A REGRESSION ─────────────────
 * A previous revision reduced this union to `'targeting'` alone, on the stated
 * grounds that «both browsers belong to this server, so there is no trust gap
 * for a code to bridge». The premise was half right, and the half that was
 * wrong is the bug this revision fixes: it had the two environments INVERTED.
 *
 * REPORTED:
 *
 *   «وقتی روی پیکر می‌زنم و باکس بالا می‌آید که لوکال می‌خواهی یا ریموت، وقتی
 *    لوکال می‌زنم باید مرورگر لوکال سرور بالا بیاید ولی برعکس است.
 *    و منطقی‌تر است این عمل.»
 *
 * And it IS the more logical naming, because the names are stated from the
 * PROJECT's point of view — the only point of view the server can actually
 * speak from:
 *
 *   LOCAL BROWSER   local TO THE PROJECT: the browser runtime on the same
 *                   server/infrastructure this application runs on. One
 *                   machine, one trust domain, loopback address, this
 *                   process's own token. Nothing to type — and a code here
 *                   really would be the empty ceremony the previous revision
 *                   described.
 *
 *   REMOTE BROWSER  remote FROM THE PROJECT: a browser on a machine this
 *                   server does not own and cannot launch — typically the
 *                   operator's own desktop, running the side-loaded extension.
 *                   TWO machines, so there is a real trust gap, and it is
 *                   bridged the only way it can be: the server mints an
 *                   Authorization Code, and the far end proves itself by
 *                   redeeming it against a Base URL it must be told.
 *
 * So `authorize` is not the resurrection of a deleted flow. It is that flow
 * restored to the environment it was always describing, after having been
 * attached to the wrong one. What the previous revision correctly deleted was
 * a code on the SERVER-LOCAL browser; that stays deleted, permanently, and is
 * enforced by `planTargeting` returning `needsAuthorization: false` for LOCAL.
 */
export type TargetingStep = 'targeting' | 'authorize';

/** The facts the decision is made from. Everything else is irrelevant to it. */
export interface TargetingConditions {
  environment: BrowserEnvironmentName;
  /**
   * Is THIS Target Field already paired with an Inspector?
   *
   * Asked about the stable pairing identity, not the ephemeral delivery id —
   * see TargetFieldRegistry's `pairingKey`. If it were asked about the
   * ephemeral id, re-opening the node would mint a fresh suffix and the answer
   * would always be "no", which is exactly the "asks for a code every single
   * time" behaviour the requirement forbids.
   */
  paired: boolean;
  /** Is a local browser reachable right now (agent connected / extension seen)? */
  localAvailable?: boolean;
  /** Has the operator turned local mode off for this whole instance? */
  localEnabled?: boolean;
}

export interface TargetingPlan {
  environment: BrowserEnvironmentName;
  step: TargetingStep;
  /**
   * Must the operator be given an Authorization Code to redeem elsewhere?
   *
   *   LOCAL   false — one machine, loopback, this process's own token.
   *   REMOTE  true  — a different machine has to prove it is allowed in.
   *
   * This is the flag that used to be permanently `false`. It was pinned to
   * `false` while LOCAL was believed to mean "the server's browser" AND REMOTE
   * was believed to mean the same thing — under that reading nothing anywhere
   * needed a code, which is true but was reached from an inverted premise.
   * With the environments the right way round the answer genuinely differs, so
   * the type is a plain `boolean` again.
   */
  needsAuthorization: boolean;
  /**
   * Should the server open ITS OWN browser for this run?
   *
   * ── RENAMED, AND THE RENAME IS THE FIX ───────────────────────────────────
   * This field was called `opensRemoteBrowser` and was true for `remote`. Both
   * halves of that were wrong once the names are read from the project's point
   * of view, and the name itself is what made the inversion so easy to keep:
   * "opens remote browser" reads as self-evidently belonging to REMOTE, so
   * nobody re-checked whether the browser being opened was actually remote.
   *
   * It is not. The only browser this server can launch is the one on its own
   * infrastructure — which is the LOCAL one. A browser on the operator's
   * desktop cannot be launched from here at all; the operator opens it
   * themselves and connects inward.
   *
   *   LOCAL   true  — launch it (or reuse it if it is already up).
   *   REMOTE  false — there is nothing here to launch.
   */
  opensServerBrowser: boolean;
  /**
   * May the server bind this Inspector itself, with no code?
   *
   * True for LOCAL only. The server may vouch for a browser it launched itself,
   * on its own infrastructure, seeded with its own token. It may not vouch for
   * a browser on a machine it has never seen — that is what the code is for.
   */
  serverMayGrant: boolean;
  /**
   * Must an approval prompt be raised INSIDE the browser before a picked
   * element may be delivered?
   *
   * ── RENAMED from `needsRemoteApproval`, and moved to the other environment ──
   * The old name said "remote", and it was true for `remote`. Under the correct
   * reading the prompt belongs to the SERVER-LOCAL browser, for a reason that
   * has nothing to do with trust and everything to do with ambiguity:
   *
   *   «ممکنه کاربر مرورگر ریموت رو از فیلد قبلی هنوز باز نگه داشته و الان که
   *    فیلد جدید می‌خواد مرورگر دوباره بالا بیاد، به جای اینکه مرورگر دوباره
   *    بالا بیاد … یه الرت توی صفحه مرورگر بالا میاد که بهمون میگه فیلد جدید
   *    فلانه، آیا می‌خواد ست بشه»
   *
   * The server's browser is ONE long-lived, shared window. It survives across
   * targeting runs, so when the operator targets a second field it is already
   * open and already bound to the first one. Nothing in the address it holds
   * says which of the two the next pick belongs to, so a human has to say. The
   * prompt names the node and the field and waits.
   *
   * The browser on the operator's own machine has no such ambiguity: it
   * redeemed a code that named exactly one Target Field, so the code IS the
   * disambiguation and a second prompt would ask a question already answered.
   *
   *   LOCAL   true  — the shared server browser: name the field, then bind.
   *   REMOTE  false — the redeemed code already named it.
   */
  needsInPageApproval: boolean;
  /**
   * A stable key naming why the plan is what it is, never a sentence — the UI
   * renders fa/en itself. Empty when nothing noteworthy happened.
   */
  note:
  | ''
  | 'already_paired'
  /** LOCAL: the browser runtime on this server. Resolved internally. */
  | 'server_local_browser'
  /** REMOTE: a browser on another machine. Needs a code and a Base URL. */
  | 'operator_owned_browser'
  | 'local_disabled'
  | 'local_unavailable';
}

/**
 * Decide what happens after the user picks an environment.
 *
 * ── THE NAMES ARE READ FROM THE PROJECT'S POINT OF VIEW ──────────────────────
 * That single sentence decides every line below, and getting it backwards is
 * the defect this revision repairs.
 *
 *   LOCAL BROWSER   The browser runtime on the SAME server/infrastructure this
 *                   application runs on — local *to the project*. This server
 *                   can launch it, so it does. Address is its own loopback on
 *                   its own configured port; credential is its own token;
 *                   neither is ever shown to or asked of the operator. No code,
 *                   no Base URL box. It DOES raise an in-page approval prompt,
 *                   because it is one shared window that outlives a single
 *                   targeting run.
 *
 *   REMOTE BROWSER  A browser on a machine this server does not own — remote
 *                   *from the project*, typically the operator's own desktop
 *                   running the side-loaded extension. This server cannot
 *                   launch it and cannot vouch for it, so the operator is given
 *                   an Authorization Code and tells that browser which Base URL
 *                   to redeem it against. No in-page prompt: the code already
 *                   named exactly one field.
 *
 * The previous revision had both of these attached to the opposite id, which is
 * why pressing LOCAL launched nothing and pressing REMOTE launched the server's
 * own Chromium.
 *
 * WHY THIS MODULE IS STILL PURE
 * -----------------------------
 * It holds no state, opens no browser and touches no registry. The branch is
 * the part of the feature most likely to be got subtly wrong — as it just was —
 * and a total function is the only shape that can be exhaustively tested
 * without a browser, a socket or a clock. The routes do the effectful parts and
 * consult this file for WHICH of them to do.
 */
export function planTargeting(conditions: TargetingConditions): TargetingPlan {
  const environment = normalizeBrowserEnvironment(conditions?.environment);

  // ── REMOTE — a browser on somebody else's machine ─────────────────────────
  //
  // Two machines, so a real trust gap, bridged by a code the far end redeems
  // against a Base URL it must be told. Nothing here is launched locally and
  // nothing is granted without the redemption.
  if (environment === 'remote') {
    return {
      environment,
      step: 'authorize',
      needsAuthorization: true,
      opensServerBrowser: false,
      serverMayGrant: false,
      // The redeemed code named one field. Asking again in-page would be a
      // second answer to a settled question.
      needsInPageApproval: false,
      note: 'operator_owned_browser',
    };
  }

  // ── LOCAL — this server's own browser runtime ─────────────────────────────
  const enabled = conditions.localEnabled !== false;
  const available = conditions.localAvailable !== false;

  if (!enabled || !available) {
    return {
      environment,
      step: 'targeting',
      // A refusal must not ask for a code: the remedy for "switched off" is
      // turning it on, never transcribing a secret. The caller 409s on the note.
      needsAuthorization: false,
      opensServerBrowser: false,
      serverMayGrant: false,
      needsInPageApproval: false,
      note: !enabled ? 'local_disabled' : 'local_unavailable',
    };
  }

  return {
    environment,
    step: 'targeting',
    // One machine. A code here would ask the operator to copy a secret out of
    // one of the server's own windows and back into another of them in order to
    // prove they are themselves — the empty ceremony that was correctly deleted
    // and stays deleted.
    needsAuthorization: false,
    // The only browser this server CAN launch. `openOrReuse` semantics live in
    // the caller: if it is already up, it is reused rather than relaunched.
    opensServerBrowser: true,
    // Its own infrastructure, its own token — it may vouch for it.
    serverMayGrant: true,
    // The shared-window disambiguation. See TargetingPlan.needsInPageApproval.
    needsInPageApproval: true,
    note: conditions.paired ? 'already_paired' : 'server_local_browser',
  };
}

/** One environment as the chooser renders it. */
export interface EnvironmentOption {
  id: BrowserEnvironmentName;
  /** Can it be chosen at all right now? */
  available: boolean;
  /** Is this Target Field already paired in this environment? */
  paired: boolean;
  /**
   * Would choosing it hand the operator an Authorization Code?
   *
   * True for REMOTE only. The chooser uses it to warn honestly, up front, that
   * one card leads to a short setup and the other does not.
   */
  needsAuthorization: boolean;
  /**
   * Would choosing it raise an approval prompt inside the browser?
   *
   * True for LOCAL only — the shared server window has to be told which field
   * the next pick belongs to. Formerly `needsRemoteApproval`, which named the
   * wrong environment.
   */
  needsInPageApproval: boolean;
  /**
   * Would choosing it launch (or reuse) the server's own browser?
   *
   * True for LOCAL only. Surfaced so the card can say "a browser will open on
   * the server" instead of the operator discovering it.
   */
  opensServerBrowser: boolean;
  /** Why it is unavailable, or '' when it is fine. */
  note: TargetingPlan['note'];
}

/**
 * Both options, as the chooser needs them.
 *
 * Built from `planTargeting` rather than hand-written so the dialog can never
 * disagree with what actually happens on selection. A chooser that promised
 * "no code needed" and then produced one would be worse than no chooser — and
 * for a while it did exactly that, in the other direction: it labelled the
 * server's own browser REMOTE.
 */
export function environmentOptions(conditions: {
  paired: boolean;
  localAvailable?: boolean;
  localEnabled?: boolean;
}): EnvironmentOption[] {
  return BROWSER_ENVIRONMENTS.map((id) => {
    const plan = planTargeting({ ...conditions, environment: id });
    return {
      id,
      available: plan.note !== 'local_disabled' && plan.note !== 'local_unavailable',
      // LOCAL is server-granted, so it is effectively always paired: this server
      // binds its own browser and never asks the operator to establish that by
      // hand. REMOTE must report the field's REAL pairing state, because there
      // the pairing is what a redeemed code created — claiming it exists when it
      // does not is what would hide the setup step from the operator.
      paired: plan.serverMayGrant ? true : conditions.paired,
      needsAuthorization: plan.needsAuthorization,
      needsInPageApproval: plan.needsInPageApproval,
      opensServerBrowser: plan.opensServerBrowser,
      note: plan.note === 'local_disabled' || plan.note === 'local_unavailable'
        ? plan.note
        : '',
    };
  });
}
