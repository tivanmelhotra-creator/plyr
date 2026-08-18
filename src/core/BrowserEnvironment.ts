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
 *   BrowserEnvironment  LOCAL / REMOTE — whose Chrome the user will point at.
 *                       THIS FILE. Chosen per Targeting run.
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
 *   authorize — LEGACY shape, kept in the union so older cached plans still
 *               typecheck. The planner no longer PRODUCES it for LOCAL: under
 *               the corrected contract LOCAL BROWSER is the SERVER-LOCAL
 *               browser runtime — same machine as Plyr, internal and
 *               automatic — so there is no second browser to bridge with a
 *               code, and no code is ever issued. (`/inspector/authorize` and
 *               `/inspector/pair` still exist for older clients that already
 *               hold a code screen; new clients never receive `authorize`.)
 *   targeting — go straight to picking. Nothing else is required.
 */
export type TargetingStep = 'authorize' | 'targeting';

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
  /** Must the user type an Authorization Code before picking? */
  needsAuthorization: boolean;
  /**
   * Should the server open ITS browser for this run?
   *
   * True only for `remote`. In `local` the user already has the page open in
   * their own Chrome, and opening a server browser they did not ask for is the
   * bug this whole change exists to fix.
   */
  opensRemoteBrowser: boolean;
  /**
   * May the server bind this Inspector itself, with no code?
   *
   * True for BOTH environments under the corrected contract, and it is not a
   * shortcut — it is a statement about who owns the browser:
   *
   *   remote — the remote Chromium is launched BY this server, with a copy of
   *            the extension this server side-loaded and pre-seeded with its
   *            own token (see InspectorExtension.bootstrapSource).
   *   local  — the SERVER-LOCAL browser runtime: the browser runs on the SAME
   *            server/infrastructure as Plyr. Same single machine, same
   *            absence of a trust gap for a code to bridge.
   *
   * A code exists to bridge a trust gap between two machines. In both
   * environments there is only one machine, so a code would ask the user to
   * copy a secret from one of the server's windows into another of the
   * server's windows to prove they are themselves.
   */
  serverMayGrant: boolean;
  /**
   * A stable key naming why the plan is what it is, never a sentence — the UI
   * renders fa/en itself. Empty when nothing noteworthy happened.
   */
  note:
  | ''
  | 'already_paired'
  | 'pairing_required'
  | 'server_owned_browser'
  | 'local_disabled'
  | 'local_unavailable'
  | 'server_local_browser';
}

/**
 * Decide what happens after the user picks an environment.
 *
 * REMOTE — never authorizes. The server owns the browser and the extension
 * inside it, so it binds the Inspector itself and goes straight to picking.
 *
 * LOCAL — never authorizes EITHER. Under the corrected contract, LOCAL BROWSER
 * is the SERVER-LOCAL BROWSER RUNTIME: the browser runs on the SAME
 * server/infrastructure as Plyr, and the connection is internal and automatic.
 * The PR16 flow (LOCAL = the user's own browser elsewhere, paired by a typed
 * Authorization Code) was rejected: there is no second machine, so there is
 * nothing for a code to prove. A DIFFERENT field still gets its own pairing
 * record — the isolation the requirement asks for — it is simply granted by
 * the server instead of typed by a human.
 *
 * `local_disabled` / `local_unavailable` are reported as NOTES on a plan that
 * still says `local`, rather than being silently rewritten to `remote`. A
 * silent downgrade is precisely the lie this subsystem exists to avoid: the
 * user would be told "Targeting" while the server quietly pointed a different
 * browser at a different page. The caller refuses and shows the reason.
 */
export function planTargeting(conditions: TargetingConditions): TargetingPlan {
  const environment = normalizeBrowserEnvironment(conditions?.environment);

  if (environment === 'remote') {
    return {
      environment,
      step: 'targeting',
      needsAuthorization: false,
      opensRemoteBrowser: true,
      serverMayGrant: true,
      note: 'server_owned_browser',
    };
  }

  // ── LOCAL = SERVER-LOCAL browser runtime ───────────────────────────────────
  const enabled = conditions.localEnabled !== false;
  const available = conditions.localAvailable !== false;

  if (!enabled || !available) {
    return {
      environment,
      step: 'authorize',
      // Unreachable is NOT "already fine": the honest answer is that the user
      // still has work to do before a pick can happen — but that work is never
      // typing a code. The disabled/unavailable note is the whole message.
      needsAuthorization: false,
      opensRemoteBrowser: false,
      serverMayGrant: false,
      note: !enabled ? 'local_disabled' : 'local_unavailable',
    };
  }

  if (conditions.paired) {
    return {
      environment,
      step: 'targeting',
      needsAuthorization: false,
      opensRemoteBrowser: false,
      serverMayGrant: true,
      note: 'already_paired',
    };
  }

  // First time for THIS field: the server binds it internally. No code, no
  // Base URL, no API Key, no Authorization field — nothing for the user to do.
  return {
    environment,
    step: 'targeting',
    needsAuthorization: false,
    opensRemoteBrowser: false,
    serverMayGrant: true,
    note: 'server_local_browser',
  };
}

/** One environment as the chooser renders it. */
export interface EnvironmentOption {
  id: BrowserEnvironmentName;
  /** Can it be chosen at all right now? */
  available: boolean;
  /** Is this Target Field already paired in this environment? */
  paired: boolean;
  /** Would choosing it ask for an Authorization Code? */
  needsAuthorization: boolean;
  /** Why it is unavailable, or '' when it is fine. */
  note: TargetingPlan['note'];
}

/**
 * Both options, as the chooser needs them.
 *
 * Built from `planTargeting` rather than hand-written so the dialog can never
 * disagree with what actually happens on selection. A chooser that promised
 * "no code needed" and then produced one would be worse than no chooser.
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
      // Remote is server-granted, so it is effectively always paired.
      paired: id === 'remote' ? true : conditions.paired,
      needsAuthorization: plan.needsAuthorization,
      note: plan.note === 'local_disabled' || plan.note === 'local_unavailable'
        ? plan.note
        : '',
    };
  });
}
