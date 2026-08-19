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
 *   targeting — go straight to picking. Nothing else is required.
 *
 * ── WHY THIS UNION HAS EXACTLY ONE MEMBER ─────────────────────────────────────
 * It used to have two. The other was `authorize`: issue an Authorization Code,
 * render it in the dashboard, and wait for a human to retype it into the
 * extension's popup. That step existed to bridge a TRUST GAP BETWEEN TWO
 * MACHINES — the server, and the operator's own laptop running its own Chrome.
 *
 * That gap does not exist in this product. `LOCAL BROWSER` means the Browser
 * Runtime ON THE SAME SERVER / INFRASTRUCTURE THAT THIS APPLICATION RUNS ON:
 *
 *     «منظور از LOCAL BROWSER در این محصول، Browser Runtime روی همان
 *      Server/Infrastructure است که Plyr روی آن اجرا می‌شود.»
 *
 * So both environments are now one machine, and a code in either of them asks
 * the operator to copy a secret out of one of the server's own windows and back
 * into another of the server's own windows in order to prove they are
 * themselves. There is no reading of that under which it is security; it is
 * ceremony, and it was the reported defect.
 *
 * A one-member union is the enforcement, not a comment: `step` cannot be
 * assigned 'authorize' anywhere, so the deleted flow cannot be reintroduced by
 * accident in a branch nobody re-reads.
 */
export type TargetingStep = 'targeting';

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
   * Must the user type an Authorization Code before picking?
   *
   * PERMANENTLY FALSE, in both environments, and kept in the shape on purpose:
   * every consumer (the chooser's badges, the routes, the tests) already reads
   * this field, and deleting it would turn a decided answer into an absent one —
   * `undefined` is falsy, so a stale reader would appear to agree while actually
   * having stopped asking. A literal `false` type makes the guarantee checkable
   * by the compiler instead of by inspection.
   *
   * See TargetingStep for why no environment can need a code any more.
   */
  needsAuthorization: false;
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
   * TRUE IN BOTH ENVIRONMENTS, and it is not a shortcut — it is a statement
   * about who owns the browser. Both browsers are launched BY this server, on
   * this server's own infrastructure, running a copy of the extension this
   * server side-loaded and pre-seeded with its own token (see
   * InspectorExtension.bootstrapSource). There is exactly one machine in the
   * picture, so there is no trust gap for a code to bridge.
   *
   * It was true only for `remote` while LOCAL was believed to mean "the
   * operator's own laptop". That belief is what produced the credential form.
   */
  serverMayGrant: boolean;
  /**
   * Must the server raise a Remote Approval prompt inside the browser before
   * the picked element may be delivered?
   *
   * ── THE ONE ASYMMETRY LEFT BETWEEN LOCAL AND REMOTE ──────────────────────
   *   LOCAL   false — «no Alert … automatic connection»
   *   REMOTE  true  — «Remote Approval Alert … on approval the Browser binds
   *                    to the current Target Field»
   *
   * The asymmetry is real and not an oversight. The REMOTE browser is a shared,
   * long-lived Chromium that survives across targeting runs and can be pointed
   * at a DIFFERENT field while the operator is still looking at the previous
   * one (see the target-reuse requirement). The prompt is what names WHICH
   * field the next pick belongs to, so the extension never chooses a
   * destination for itself.
   *
   * The LOCAL runtime is resolved per run, internally, and is never handed a
   * second competing destination — so there is nothing for a human to
   * disambiguate, and a prompt there would be exactly the "Alert" the
   * requirement forbids.
   */
  needsRemoteApproval: boolean;
  /**
   * A stable key naming why the plan is what it is, never a sentence — the UI
   * renders fa/en itself. Empty when nothing noteworthy happened.
   */
  note:
  | ''
  | 'already_paired'
  // The LOCAL browser runs on this server, so choosing it resolves the internal
  // runtime + backend context automatically. REPLACES 'pairing_required', which
  // named a code this flow no longer has.
  | 'server_local_browser'
  | 'server_owned_browser'
  | 'local_disabled'
  | 'local_unavailable';
}

/**
 * Decide what happens after the user picks an environment.
 *
 * ── BOTH BROWSERS BELONG TO THIS SERVER ──────────────────────────────────────
 * That single fact decides everything below, and it is the correction this
 * function exists to encode:
 *
 *   LOCAL BROWSER   the Browser Runtime on the SAME server this app runs on.
 *                   Resolved internally: the backend address is this process's
 *                   own loopback, the credential is this process's own token,
 *                   and neither is ever shown to or asked of the operator.
 *                   No code. No approval prompt. No alert.
 *
 *   REMOTE BROWSER  the headed Chromium this server launches on its own
 *                   display/remote infrastructure. Address resolved from the
 *                   server's public configuration. No code. But it DOES raise a
 *                   Remote Approval prompt, because that browser is shared
 *                   across targeting runs and the prompt is what names which
 *                   field the next pick belongs to.
 *
 * Neither environment can ever return `step:'authorize'` — that step no longer
 * exists (see TargetingStep). The previous `LOCAL → Authorization Code → pair`
 * flow modelled a trust gap between two machines, and in this product there is
 * only ever one machine.
 *
 * `local_disabled` / `local_unavailable` are still reported as NOTES on a plan
 * that STILL SAYS `local`, rather than being silently rewritten to `remote`. A
 * silent downgrade is precisely the lie this subsystem exists to avoid: the user
 * would be told "Targeting" while the server quietly pointed a different browser
 * at a different page. The caller refuses and shows the reason.
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
      needsRemoteApproval: true,
      note: 'server_owned_browser',
    };
  }

  // ── LOCAL — the browser runtime on THIS server ────────────────────────────
  const enabled = conditions.localEnabled !== false;
  const available = conditions.localAvailable !== false;

  if (!enabled || !available) {
    return {
      environment,
      step: 'targeting',
      // Even a refusal must not ask for a code: the remedy for "switched off"
      // is turning it on, never retyping a secret. The caller 409s on the note.
      needsAuthorization: false,
      opensRemoteBrowser: false,
      serverMayGrant: false,
      needsRemoteApproval: false,
      note: !enabled ? 'local_disabled' : 'local_unavailable',
    };
  }

  // Paired or not, the answer is the same — which is the whole correction.
  //
  // The distinction used to matter because an unpaired field had to mint a code
  // first. Now the server grants the binding itself in both cases, so `paired`
  // only changes the WORDING of the note, never the work. It is still reported
  // so the UI can say "reconnected" rather than "connected" without inventing
  // the difference client-side.
  return {
    environment,
    step: 'targeting',
    needsAuthorization: false,
    opensRemoteBrowser: false,
    // The LOCAL runtime is this server's own browser, so this server binds it —
    // exactly as it does for REMOTE. This flag flipping to true for LOCAL is
    // what removes the Authorization Code from the flow.
    serverMayGrant: true,
    // «no Alert» — the LOCAL half of the closing clarification.
    needsRemoteApproval: false,
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
   * Would choosing it ask for an Authorization Code?
   *
   * PERMANENTLY FALSE for both options. Retained so the chooser's badge code
   * keeps reading a decided answer rather than an absent one — see
   * TargetingPlan.needsAuthorization.
   */
  needsAuthorization: false;
  /**
   * Would choosing it raise a Remote Approval prompt in the browser?
   *
   * The one thing that genuinely differs between the two cards, so the chooser
   * can label REMOTE honestly ("you will be asked to approve there") and LOCAL
   * honestly (nothing to approve) without either hard-coding the rule.
   */
  needsRemoteApproval: boolean;
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
      // BOTH environments are server-granted now, so both are effectively always
      // paired: this server binds the browser itself in either case and the
      // operator is never asked to establish the pairing by hand.
      paired: plan.serverMayGrant ? true : conditions.paired,
      needsAuthorization: plan.needsAuthorization,
      needsRemoteApproval: plan.needsRemoteApproval,
      note: plan.note === 'local_disabled' || plan.note === 'local_unavailable'
        ? plan.note
        : '',
    };
  });
}
