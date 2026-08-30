/**
 * mode.routes — the HTTP surface for the browser mode switch and the Inspector.
 *
 * TWO GROUPS OF ROUTES, ONE THEME
 * -------------------------------
 *   /browser-mode/*  — which browser drives this user's automation.
 *   /inspector/*     — where a picked element goes.
 *
 * The theme is that both refuse rather than guess. Asking for a local browser
 * that is not connected returns 409 with a reason, not a 200 that fails on the
 * next click. Submitting an element with no active node returns 409 with
 * `no_active_node`, not a delivery into whichever node happened to be open.
 *
 * WHY THESE EXIST WHEN THERE IS ALSO A WEBSOCKET
 * ---------------------------------------------
 * The socket (`/inspector/ws`) is a speed optimisation over this. These routes
 * are the contract:
 *
 *   - The extension is a background service worker. It can `fetch`; giving it a
 *     socket to maintain across service-worker restarts would be strictly more
 *     code for strictly less reliability.
 *   - Corporate proxies that break WebSockets are common, and a user behind one
 *     must still be able to pick elements.
 *
 * So the socket pushes what these routes also serve, and neither is the only way.
 */

import { Router, type Response } from 'express';

import { config } from '../config';
import { SINGLE_USER_ID, type AuthenticatedRequest } from '../middleware/auth';
import {
  browserModes,
  reportBrowserMode,
  isBrowserMode,
  normalizeBrowserMode,
  type BrowserModeName,
} from '../core/BrowserMode';
import { localBridges, agentConnectPath, defaultAgentCdpPort } from '../core/LocalBridge';
// PublicBaseUrl is no longer imported here: the only consumer was
// advertisedBaseUrl(), which existed to print an address beside an
// Authorization Code. Both are gone — see the notes at the removal sites.
import { forgetLocalConnection } from '../core/BrowserAdapter';
import { inspectorHub, type InspectorRefusal } from '../core/InspectorHub';
import { targetFields, pairingKeyFor } from '../core/TargetFieldRegistry';
import { inspectorAuth } from '../core/InspectorAuthorization';
import { remoteTargetConsent } from '../core/RemoteTargetConsent';
import { resolveBaseUrl, requestHints } from '../core/PublicBaseUrl';
import {
  planTargeting,
  type TargetingStep,
  environmentOptions,
  normalizeBrowserEnvironment,
} from '../core/BrowserEnvironment';
import {
  syncDecision,
  extensionFieldIdFromRequest,
} from '../core/FieldIdentity';
import {
  sessionHandoff,
  formatPairingCode,
  buildSnapshot,
  type HandoffSnapshot,
} from '../core/SessionHandoff';
import { loadTabs } from '../core/BrowserTabs';
import { loadStorageState } from '../core/BrowserProfile';
import { liveBrowserSessions } from '../core/LiveSessions';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Whose session is this?
 *
 * ONLY from the authenticated key, NEVER from the body or a query parameter.
 * This is not a style preference: a body-supplied userId would let account A
 * claim a node as account B and then receive the elements B picks off B's
 * logged-in pages. The picked data is the payload, so the identity has to come
 * from the credential.
 */
function resolveUserId(req: AuthenticatedRequest): string {
  if (config.IS_SINGLE_USER) return SINGLE_USER_ID;
  return req.apiKeyUserId || SINGLE_USER_ID;
}

/**
 * Refusal reasons as stable keys plus an English fallback sentence.
 *
 * Keys (not sentences) cross the wire so the UI can render fa/en itself; the
 * message is here for API clients and logs, which have no dictionary.
 */
const SWITCH_NOTES: Record<string, string> = {
  local_disabled:
    'Local Browser mode is turned off on this server.',
  local_unavailable:
    'No local browser is connected. Start the Local Browser Agent on your machine, then try again.',
  already_in_mode:
    'Already in this mode.',
};

/**
 * Why a pairing code was refused.
 *
 * Three distinct sentences because they call for three different actions, and a
 * single "invalid code" would hide which one applies: expired means press the
 * button again, already-used means something else consumed it (worth noticing —
 * it is the only one that might indicate a leak), unknown means a typo.
 */
const PAIR_MESSAGES: Record<'unknown' | 'expired' | 'already_used', string> = {
  unknown:
    'That pairing code was not recognised. Check the code shown in the app and try again.',
  expired:
    'That pairing code has expired. Press "Switch to Local" again to get a fresh one.',
  already_used:
    'That pairing code has already been used. Press "Switch to Local" again for a new one.',
};

/**
 * Where the extension comes from, generated from config so it cannot drift out
 * of step with the server the user is actually talking to.
 *
 * `unpacked` is listed first and is not an afterthought: this is a self-hosted
 * project, so most users are loading the folder from their own clone rather than
 * installing from a store listing that may not exist for their build. Telling
 * them to visit a store page that 404s would be the least useful possible
 * instruction.
 */
function describeExtensionInstall(): {
  storeUrl: string;
  unpackedPath: string;
  downloadPath: string;
  steps: string[];
} {
  return {
    storeUrl: config.EXTENSION_STORE_URL || '',
    unpackedPath: 'extension/',
    downloadPath: '/extension/download',
    steps: [
      'Open chrome://extensions in Chrome.',
      'Turn on Developer mode (top right).',
      'Click "Load unpacked" and choose the extension/ folder.',
      'Click the extension, then enter the pairing code shown in the app.',
    ],
  };
}

/**
 * Snapshot what the user can see right now, from the best source available.
 *
 * TWO SOURCES, IN THIS ORDER, and the order is the point:
 *
 *   1. the LIVE session, when the user has the browser open. This is the only
 *      source that knows the CURRENT tab strip and which tab is in front, and it
 *      is also the only one that can produce fresh cookies.
 *   2. the PERSISTED tab list plus saved storage state. This is what makes the
 *      switch work for a user who is not staring at the live view — pressing
 *      "Switch to Local" from the workflow editor must still move their pages,
 *      and falling back here is the difference between "it works from anywhere"
 *      and "it works only on one screen".
 *
 * Always returns a snapshot, even an empty one. An empty snapshot is a truthful
 * "there was nothing open to move" and `limits.notes` says `no_tabs`; throwing
 * would turn a user with a fresh browser into an error message.
 */
async function captureCurrentSnapshot(
  userId: string,
  sessionId: string,
  target: BrowserModeName,
): Promise<HandoffSnapshot> {
  const fromMode: BrowserModeName = target === 'local' ? 'remote' : 'local';

  const live = liveBrowserSessions.forUser(userId);
  if (live) {
    try {
      const snap = await live.snapshotForHandoff(sessionId);
      return { ...snap, fromMode };
    } catch {
      // Fall through to the persisted copy rather than fail the switch.
    }
  }

  const [tabs, storage] = await Promise.all([
    loadTabs(userId).catch(() => []),
    loadStorageState(userId).catch(() => undefined),
  ]);

  return buildSnapshot({
    sessionId,
    fromMode,
    tabs,
    storage: storage as { cookies?: unknown[]; origins?: unknown[] } | undefined,
  });
}

/**
 * §27 error codes and their English sentences.
 *
 * The KEY is what crosses the wire, so the extension and the web UI can render
 * their own fa/en text; the sentence is here for API clients and logs, which have
 * no dictionary. The codes are the spec's own strings rather than internal names,
 * so a message table and an extension `switch` key off the same value with no
 * translation layer in between to drift.
 *
 * `BACKEND_UNREACHABLE` and `INVALID_API_KEY` are absent on purpose: the first
 * can only be observed by the client (a server that answers is by definition
 * reachable) and the second is produced by the auth middleware before any route
 * runs. Inventing them here would mean two places could disagree.
 */
const REFUSAL_MESSAGES: Record<InspectorRefusal, string> = {
  TARGET_FIELD_NOT_FOUND:
    'Target Field unavailable. The authorized Field no longer exists — re-open the node and press its picker button again.',
  TARGET_NOT_AUTHORIZED:
    'Target not authorized. This Inspector is not bound to the requested Field — use the crosshair on the field in the project (and approve the request if this is the remote browser).',
  ELEMENT_INSPECTION_FAILED:
    'Unable to inspect element. Try selecting the element again.',
  ATTRIBUTE_SEND_FAILED:
    'Unable to send attribute. Select one attribute with a value, then retry the send.',
};

/**
 * What to tell the operator when a code is refused.
 *
 * Restored with `/inspector/pair`, and the two reasons are kept apart because
 * they call for different actions: an expired code needs a new one, a wrong one
 * needs re-reading. Collapsing them into "invalid code" is what makes an
 * operator retype a correct code over and over.
 *
 * Reachable only in REMOTE. LOCAL never issues a code, so it can never refuse
 * one — see planTargeting.
 */
const AUTHORIZATION_MESSAGES: Record<string, string> = {
  INVALID_AUTHORIZATION_CODE:
    'That authorization code is not valid. Check it, or choose Remote Browser again for a new one.',
  AUTHORIZATION_EXPIRED:
    'That authorization code has expired. Choose Remote Browser again to get a new one.',
};

/**
 * Why a Target Field could not be registered.
 *
 * `undeclared_field` is the interesting one. It is not a pedantic check: on save
 * `coerceParams()` keeps only the keys the action declares, so a value written to
 * an undeclared key would show up in the editor and then vanish on run — a node
 * that looks configured and runs unconfigured. Refusing at registration is the
 * only point where that is still visible to the user.
 */
const REGISTER_MESSAGES: Record<string, string> = {
  invalid_node_id:
    'nodeId is required and must be a plain identifier.',
  invalid_field_key:
    'fieldKey is required and must be a plain identifier.',
  unknown_action:
    'action is not a known action id.',
  undeclared_field:
    'That field is not declared by this action, so a value written to it would be discarded on save.',
};

/**
 * Why a chosen Browser Environment cannot be used right now.
 *
 * Reported as a REFUSAL rather than being quietly swapped for the other
 * environment. A silent downgrade would tell the user "Targeting" while the
 * server pointed a different browser at a different page — the precise class of
 * lie this whole subsystem exists to prevent.
 */
const ENVIRONMENT_MESSAGES: Record<string, string> = {
  local_disabled:
    'Local Browser targeting is turned off on this server. Choose Remote Browser, or enable local mode.',
  local_unavailable:
    'No local browser is connected. Install the Inspector extension and start your local browser, then try again.',
};

/* advertisedBaseUrl() is removed along with the code-issuing routes.
 *
 * Its whole purpose was to print an address NEXT TO an Authorization Code,
 * because a code with no address is not usable by hand. Nothing is typed by
 * hand any more:
 *
 *   LOCAL  the server IS the backend the browser runs beside; it resolves its
 *          own internal address (InspectorExtension.serverBaseUrl()).
 *   REMOTE the server writes its own public address into bootstrap.config.js
 *          when it side-loads the extension.
 *
 * The remaining consumer of a "what address am I on?" answer is the browser
 * SESSION handoff, which resolves it at its own call site. */

/**
 * Whose targets should THIS extension be shown?
 *
 * Not simply `resolveUserId(req)`, and that difference is a bug fix rather than
 * a refinement.
 *
 * An Authorization Code is minted by the DASHBOARD, for the dashboard's account,
 * and redeemed by the EXTENSION, which authenticates with its own key. Redemption
 * deliberately records the dashboard's account on the binding
 * (`Binding.userId = <the user the code was issued for>`) precisely so the
 * extension inherits the destination rather than being able to name one.
 *
 * `/inspector/session` then had to answer two questions at once, and answered
 * them in two different scopes:
 *
 *   authorized — from the KEY  (found the binding  → the popup went online)
 *   targets    — from the USER (resolved from the extension's own key mapping)
 *
 * Whenever the extension's key mapped to a different account than the dashboard's
 * — a separate extension key, `API_TOKEN_USER_ID` set on one side only, an env
 * admin key (`env_root`) on the other — `authorized` was true while `targets` was
 * empty. The popup therefore reported "online", showed nothing under "Connected
 * to target", and left Send matte, because Send is gated on
 * `live = authorized && target`. Three symptoms, one scope mismatch.
 *
 * So the owner is taken from the BINDINGS the code created: they are the
 * authoritative record of which account this extension was authorized into. The
 * caller's own resolved id is kept first in the list, so the ordinary
 * single-account case is completely unchanged, and nothing here lets a client
 * ASSERT an identity — the ids come only from bindings the server itself wrote
 * after a code it itself issued was redeemed.
 */
function sessionOwners(req: AuthenticatedRequest, bindings: { userId: string }[]): string[] {
  const own = resolveUserId(req);
  const owners = [own];
  for (const b of bindings) {
    const id = String(b?.userId || '');
    if (id && !owners.includes(id)) owners.push(id);
  }
  return owners;
}

/**
 * Which account owns the destination this submission names?
 *
 * The same scope mismatch as sessionOwners(), on the write side. A pick is
 * delivered into the TARGET OWNER's inbox, because that is the account whose
 * dashboard has the node open and is polling for it. Resolving the owner from
 * the extension's own key mapping would queue the delivery under an account
 * nobody is watching: the send would return 200 and the value would never
 * appear — a silent mis-delivery, which is the one outcome this subsystem is
 * built to make impossible.
 *
 * Falls back to the caller's own id when no binding claims the target, so an
 * unauthorized submission is still refused by `submit()` exactly as before
 * (TARGET_FIELD_NOT_FOUND / TARGET_NOT_AUTHORIZED) rather than being reported
 * differently. Only ids the server itself wrote onto a binding are ever
 * considered — never anything from the request body.
 */
function ownerForTarget(req: AuthenticatedRequest, targetFieldId: string): string {
  const own = resolveUserId(req);
  const id = String(targetFieldId || '');
  if (!id) return own;
  for (const owner of sessionOwners(req, inspectorAuth.bindingsFor(req.apiKey || ''))) {
    if (targetFields.resolve(owner, id)) return owner;
  }
  return own;
}

export const createModeRoutes = (): Router => {
  const router = Router();

  // ════════════════════════════════════════════════════════════════
  // Browser mode
  // ════════════════════════════════════════════════════════════════

  /**
   * Everything the mode switch UI needs, in one request.
   *
   * Includes the agent connect path and CDP port so the "how do I connect my
   * local browser?" instructions are generated from the server's own config
   * rather than duplicated in the frontend, where they would drift.
   */
  router.get('/browser-mode', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    res.json({
      success: true,
      ...reportBrowserMode(userId),
      bridge: localBridges.info(userId),
      agent: {
        path: agentConnectPath(),
        cdpPort: defaultAgentCdpPort(),
      },
    });
  });

  /**
   * Switch mode.
   *
   * 409 on a refusal, because "I could not do what you asked" is not a success.
   * A 200 here would be the exact lie that leaves a UI showing "Local Browser"
   * while every job runs on the server.
   *
   * `already_in_mode` is the one note that returns 200: nothing failed, there
   * was simply nothing to do.
   */
  router.post('/browser-mode', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const requested = (req.body || {}).mode;

    if (!isBrowserMode(requested)) {
      res.status(400).json({
        success: false,
        error: 'mode must be "remote" or "local"',
      });
      return;
    }

    const result = browserModes.set(userId, requested as BrowserModeName);

    // Leaving local mode: drop the cached CDP attachment. Keeping it would hold
    // a socket to a browser this user is no longer driving, and would make a
    // later switch back reuse a handle that may have died in between.
    if (result.changed && result.mode === 'remote') {
      forgetLocalConnection(userId);
    }

    const refused = !result.changed && result.note !== '' && result.note !== 'already_in_mode';
    res.status(refused ? 409 : 200).json({
      success: !refused,
      ...result,
      message: result.note ? SWITCH_NOTES[result.note] || '' : '',
      ...reportBrowserMode(userId),
      bridge: localBridges.info(userId),
    });
  });

  /**
   * Can I use this mode right now? A cheap pre-flight so the UI can disable an
   * option instead of offering it and then failing.
   */
  router.get('/browser-mode/available/:mode', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const mode = req.params.mode;
    if (!isBrowserMode(mode)) {
      res.status(400).json({ success: false, error: 'unknown mode' });
      return;
    }
    // Remote is the floor: it needs nothing from the user's machine, so it is
    // always available, including as the escape hatch from a dead local browser.
    const available = mode === 'remote' || localBridges.isConnected(userId);
    res.json({ success: true, mode, available });
  });

  /**
   * Deliberately disconnect the local agent ("Disconnect" in the UI).
   *
   * The agent is a program on the user's own machine; the honest way to stop
   * using it is to drop the tunnel from this side too, rather than leaving a
   * socket open that nothing intends to use.
   */
  router.post('/browser-mode/local/disconnect', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    forgetLocalConnection(userId);
    const dropped = localBridges.disconnect(userId);
    res.json({
      success: true,
      dropped,
      ...reportBrowserMode(userId),
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Session handoff — Remote ⇄ Local, one automation session
  // ════════════════════════════════════════════════════════════════

  /**
   * Who am I, and what is waiting to be moved?
   *
   * The `sessionId` here is the answer to the operator's central requirement:
   * both modes report the SAME automation session id, so "Remote and Local are
   * not two sessions" is something a client can verify rather than be told.
   */
  router.get('/browser-mode/session', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    sessionHandoff.sweep();
    const pending = sessionHandoff.peekSnapshot(userId);
    res.json({
      success: true,
      sessionId: sessionHandoff.sessionId(userId),
      ...reportBrowserMode(userId),
      bridge: localBridges.info(userId),
      pendingHandoff: pending
        ? {
          fromMode: pending.fromMode,
          capturedAt: pending.capturedAt,
          tabCount: pending.tabs.length,
          limits: pending.limits,
        }
        : null,
    });
  });

  /**
   * Begin a switch: snapshot the browser the user is looking at NOW.
   *
   * Capture happens BEFORE the extension install detour, not after, and that
   * ordering is the whole reason this is a separate call. By the time a user has
   * installed an extension and come back, the remote session may have been
   * reaped — and then there would be nothing left to move. Taking the snapshot
   * on the click freezes their tabs while they still exist.
   *
   * Returns a pairing code only when one is needed (going to local). Switching
   * back to remote needs no pairing: the server already has the browser.
   */
  router.post('/browser-mode/handoff/start', async (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const target = normalizeBrowserMode((req.body || {}).to, 'local');
    const sessionId = sessionHandoff.sessionId(userId);

    const snapshot = await captureCurrentSnapshot(userId, sessionId, target);
    sessionHandoff.putSnapshot(userId, snapshot);

    // Only the local side needs to prove who it is; the server side is already
    // authenticated by the API key on this very request.
    const pairing = target === 'local' ? sessionHandoff.issuePairing(userId) : null;

    res.json({
      success: true,
      sessionId,
      to: target,
      captured: {
        fromMode: snapshot.fromMode,
        tabCount: snapshot.tabs.length,
        limits: snapshot.limits,
      },
      ...(pairing
        ? {
          pairing: {
            code: pairing.code,
            display: formatPairingCode(pairing.code),
            expiresAt: pairing.expiresAt,
            expiresInMs: pairing.expiresInMs,
          },
          extension: describeExtensionInstall(),
        }
        : {}),
    });
  });

  /**
   * The extension redeems a pairing code for a session token.
   *
   * UNAUTHENTICATED BY DESIGN, and this is the security-critical decision in the
   * whole feature. The point of a pairing code is that the extension does NOT
   * need the API key — that key grants full control of the instance, and pasting
   * it into a browser extension puts an unrevocable master credential on the
   * most-attacked surface of the user's machine. What guards this route instead
   * is the code itself: 31^8 possibilities, single-use, five-minute TTL,
   * compared in constant time, and only ever issued to an already-authenticated
   * caller. A brute force must therefore land inside a five-minute window on a
   * code that dies the instant it is used once.
   */
  router.post('/browser-mode/handoff/pair', (req: AuthenticatedRequest, res: Response) => {
    sessionHandoff.sweep();
    const result = sessionHandoff.redeemPairing((req.body || {}).code);

    if (!result.ok) {
      // 410 for a code that WAS valid and is now gone, 404 for one that never
      // existed: "press the button again" and "check what you typed" are
      // different actions, and a single generic error would hide which applies.
      const status = result.reason === 'unknown' ? 404 : 410;
      res.status(status).json({
        success: false,
        reason: result.reason,
        error: PAIR_MESSAGES[result.reason],
      });
      return;
    }

    res.json({
      success: true,
      token: result.token,
      sessionId: result.sessionId,
      /** So the extension can label itself with the session it joined. */
      mode: browserModes.modeOf(result.userId),
    });
  });

  /**
   * The extension collects the tabs and cookies to restore.
   *
   * Authenticated by the session token, not the API key. PEEKS by default for
   * the same reason the inspector inbox does: a service worker that Chrome
   * recycles mid-restore must be able to ask again, and a drain-by-default would
   * have destroyed the only record of where the user's tabs were. `?drain=1` is
   * for a client that has committed to applying the result.
   */
  router.get('/browser-mode/handoff/pull', (req: AuthenticatedRequest, res: Response) => {
    const owner = sessionHandoff.resolveToken(
      req.get('x-session-token') || (req.query.token as string) || '',
    );
    if (!owner) {
      res.status(401).json({
        success: false,
        error: 'This browser is not paired with a session. Pair it again from the app.',
      });
      return;
    }

    const drain = String(req.query.drain || '') === '1';
    const snap = drain
      ? sessionHandoff.takeSnapshot(owner.userId)
      : sessionHandoff.peekSnapshot(owner.userId);

    if (!snap) {
      res.json({ success: true, sessionId: owner.sessionId, snapshot: null, expired: true });
      return;
    }

    res.json({
      success: true,
      sessionId: owner.sessionId,
      snapshot: {
        fromMode: snap.fromMode,
        capturedAt: snap.capturedAt,
        // Same URLs, same order; exactly one carries `active`.
        tabs: snap.tabs,
        storage: snap.storage || null,
        limits: snap.limits,
      },
    });
  });

  /**
   * The local side reports what it managed to restore, and the switch completes.
   *
   * The mode flips HERE rather than at /handoff/start, and that ordering is the
   * guarantee that a switch never breaks the session: until the other browser
   * has actually opened the tabs, the user stays in a mode that works. A switch
   * that flipped the registry first would leave anyone whose install failed
   * stranded in a mode with no browser behind it.
   */
  router.post('/browser-mode/handoff/complete', (req: AuthenticatedRequest, res: Response) => {
    const body = req.body || {};
    // Either credential is acceptable: the extension has a session token, and
    // the app itself (switching BACK to remote) has the API key.
    const owner = sessionHandoff.resolveToken(req.get('x-session-token') || body.token || '');
    const userId = owner ? owner.userId : resolveUserId(req);
    const target = normalizeBrowserMode(body.to, owner ? 'local' : 'remote');

    const result = browserModes.set(userId, target);
    if (result.changed && result.mode === 'remote') forgetLocalConnection(userId);

    // The snapshot has served its purpose; holding it would let a later,
    // unrelated pair replay someone's tab list.
    if (result.changed) sessionHandoff.clearSnapshot(userId);

    const refused = !result.changed && result.note !== '' && result.note !== 'already_in_mode';
    res.status(refused ? 409 : 200).json({
      success: !refused,
      sessionId: sessionHandoff.sessionId(userId),
      restored: {
        tabs: Number(body.restoredTabs) || 0,
        activeTab: Boolean(body.activeTabRestored),
      },
      ...result,
      message: result.note ? SWITCH_NOTES[result.note] || '' : '',
      ...reportBrowserMode(userId),
    });
  });

  /** Abandon a switch: drop the snapshot and any unredeemed code. */
  router.post('/browser-mode/handoff/cancel', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    sessionHandoff.clearSnapshot(userId);
    sessionHandoff.sweep();
    res.json({ success: true, sessionId: sessionHandoff.sessionId(userId) });
  });

  /** Where to get the extension. Generated from config so it cannot drift. */
  router.get('/browser-mode/extension', (_req: AuthenticatedRequest, res: Response) => {
    res.json({ success: true, ...describeExtensionInstall() });
  });

  /**
   * Download the extension as a zip.
   *
   * THIS EXISTS BECAUSE THE PATH WAS ALREADY ADVERTISED. `describeExtensionInstall`
   * returned `downloadPath: '/extension/download'` while no such route existed, so
   * the install screen offered a link that 404s -- and the request was explicitly
   * that installing be EASY. An install step that dead-ends is worse than no link
   * at all, because the user cannot tell whether they or the server is at fault.
   *
   * Zipped with the system `zip` rather than a new npm dependency: this is one
   * route, `zip` is present on every image this runs on, and adding a package to
   * the dependency tree for it would be the larger change. If `zip` is missing the
   * route says so and points at the unpacked folder, which still works.
   *
   * `-x` excludes the generated bootstrap: it carries the settings the SERVER
   * seeds into the remote browser's copy (including an API key). Shipping that in
   * a download every user can fetch would hand one user's credential to the next,
   * so the exclusion is a security boundary, not tidiness.
   */
  router.get('/extension/download', async (_req: AuthenticatedRequest, res: Response) => {
    const source = path.resolve(process.cwd(), 'extension');
    try {
      const st = await fs.stat(source);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch {
      res.status(404).json({
        success: false,
        error: 'The extension folder is not present in this deployment.',
        ...describeExtensionInstall(),
      });
      return;
    }

    const out = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ab-ext-')),
      'automation-backend-extension.zip',
    );

    execFile(
      'zip',
      ['-r', '-q', out, '.', '-x', 'bootstrap.config.js', '-x', '*/.DS_Store'],
      { cwd: source, timeout: 30_000 },
      (err) => {
        if (err) {
          res.status(500).json({
            success: false,
            error: 'Could not package the extension on the server. '
              + 'Load the unpacked extension/ folder instead — it works the same.',
            ...describeExtensionInstall(),
          });
          return;
        }
        // download() sets Content-Disposition, so the browser saves rather than
        // renders it. The temp dir is removed afterwards either way: a failed
        // send still leaves a file behind, and this route can be hit repeatedly.
        res.download(out, 'automation-backend-extension.zip', () => {
          void fs.rm(path.dirname(out), { recursive: true, force: true });
        });
      },
    );
  });

  // ════════════════════════════════════════════════════════════════
  // Inspector
  // ════════════════════════════════════════════════════════════════

  /**
   * What is the extension attached to, and what is waiting for an element?
   *
   * This is the request the extension makes on open, and it answers the
   * requirement that the extension identify its Browser/Automation session
   * rather than assume one.
   */
  router.get('/inspector/session', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const report = reportBrowserMode(userId);

    // Read the bindings FIRST: they name every account this extension was
    // authorized into, and the target list has to be gathered in those same
    // scopes or the two halves of this answer contradict each other. See
    // sessionOwners() for the failure that produced.
    const authorized = inspectorAuth.bindingsFor(req.apiKey || '');
    const owners = sessionOwners(req, authorized);

    // De-duplicated by id: two owners can legitimately resolve to the same
    // account (the ordinary case), and a target listed twice would be counted
    // twice by the popup's "N fields open".
    const seen = new Set<string>();
    const targets = [];
    for (const owner of owners) {
      for (const t of targetFields.list(owner)) {
        if (seen.has(t.targetFieldId)) continue;
        seen.add(t.targetFieldId);
        targets.push(t);
      }
    }

    res.json({
      success: true,
      userId,
      mode: report.mode,
      modes: report.modes,
      localAvailable: report.localAvailable,
      bridge: localBridges.info(userId),
      // Every live destination, not one "current" node. Several must be able to
      // coexist, so a single-valued answer here would misdescribe the state.
      targets,
      // What THIS extension may write to. A different key gets a different list.
      authorized,
      // The DURABLE half of the same answer.
      //
      // `authorized` lists ADDRESSES (targetFieldId), which are re-minted every
      // time a node is re-opened and expire in hours. `pairings` lists the
      // stable Extension⇄Field identities, which survive that and expire in
      // days. The popup needs both to tell the truth: a field can be genuinely
      // paired — so no new code will ever be asked for — while its current
      // address has not been handed over yet. Showing only `authorized` made
      // that state look like "not paired", which is exactly the misreport the
      // persistence requirement exists to prevent.
      pairings: inspectorAuth.pairingsFor(req.apiKey || ''),
      pending: inspectorHub.peek(userId).length,
    });
  });

  // ════════════════════════════════════════════════════════════════
  // Targeting — the LOCAL / REMOTE branch that now opens the flow
  // ════════════════════════════════════════════════════════════════

  /**
   * Can Local Browser be chosen for TARGETING right now?
   *
   * Deliberately NOT `reportBrowserMode().localAvailable`. That flag asks
   * whether a Local Browser AGENT is connected over CDP so this server can DRIVE
   * the user's Chrome — the automation question. Targeting asks something much
   * weaker: whether the user may point their own already-open browser at an
   * element and have the extension post it back. No agent, no CDP and no
   * automation session are involved in that.
   *
   * Tying the two together would also be circular. The extension's presence is
   * what the Authorization Code proves; refusing to offer the code until we can
   * already see the extension would mean it could never be paired the first
   * time. So the only gate is the operator's own switch.
   */
  const localTargetingEnabled = (): boolean => reportBrowserMode(SINGLE_USER_ID).localEnabled;

  /**
   * The address a browser ON ANOTHER MACHINE must reach this server on.
   *
   * REMOTE-only. The operator is shown this rather than asked for it:
   *
   *   «بیس یو ار ال هم خودش پروژه ست می‌کنه»
   *
   * Deliberately NOT loopback — see PublicBaseUrl, which prefers a configured
   * domain, then the proxy's forwarded host, then a detected LAN address, and
   * only falls back to loopback when there is genuinely nothing better. A
   * loopback address handed to a browser on someone's desktop points at THEIR
   * machine, which is the one failure this resolver exists to avoid.
   */
  const publicBaseUrl = (req: AuthenticatedRequest): string => resolveBaseUrl({
    configuredDomain: config.PUBLIC_DOMAIN,
    port: config.PORT,
    request: requestHints(req as unknown as { headers?: Record<string, unknown> }),
  }).baseUrl;

  /**
   * Step ONE of the Targeting flow: what are my choices for this field?
   *
   *   «وقتی کاربر روی آیکون 🎯 Target This Field کلیک می‌کند، اولین مرحله باید
   *    انتخاب Browser Environment باشد، نه Connection Mode.»
   *
   * A READ. It answers "which environments are offered, and would each ask me
   * for a code?" without registering anything, because merely opening a chooser
   * the user may cancel must not mint a destination or a pairing.
   *
   * That is why it takes nodeId/fieldKey rather than a targetFieldId: at this
   * point in the flow no target exists yet. The stable `pairingKey` is computed
   * from those same three facts, which is exactly what makes the answer to
   * "already paired?" survive the node being closed and re-opened.
   */
  router.get('/inspector/targeting/options', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const nodeId = String(req.query.nodeId || '');
    const fieldKey = String(req.query.fieldKey || '');
    const workflowId = String(req.query.workflowId || '') || undefined;

    // ── ANSWERING WITHOUT A FIELD IS THE POINT, NOT AN ABUSE ─────────────
    // This returned 400 whenever nodeId/fieldKey were absent, and that is what
    // made the browser chooser unreachable: the extension popup asks this the
    // instant it opens, which is necessarily BEFORE a field has been targeted.
    // A 400 there left the popup with no options to draw, so the operator saw an
    // error token where the LOCAL / REMOTE radios were supposed to be.
    //
    // WHICH BROWSERS THIS SERVER OFFERS is not a per-field fact. It is one
    // setting (is the local runtime enabled?) plus the fixed catalogue in
    // BrowserEnvironment.ts. So it is answerable, and answering it registers
    // nothing whatsoever.
    //
    // WHAT IS STILL REFUSED, deliberately: inventing a field. No pairingKey is
    // computed, `paired` is reported false, and `fieldScoped: false` says so out
    // loud — so a caller can never read "not paired" here as "this field is not
    // paired". There is no field.
    const fieldScoped = Boolean(nodeId && fieldKey);
    if (!fieldScoped) {
      const localEnabledOnly = localTargetingEnabled();
      res.json({
        success: true,
        fieldScoped: false,
        pairingKey: '',
        paired: false,
        localEnabled: localEnabledOnly,
        options: environmentOptions({
          paired: false,
          localEnabled: localEnabledOnly,
          localAvailable: true,
        }),
        mode: browserModes.modeOf(userId),
      });
      return;
    }

    const pairingKey = pairingKeyFor(nodeId, fieldKey, workflowId);
    const paired = inspectorAuth.isPairedForUser(userId, pairingKey);
    const localEnabled = localTargetingEnabled();

    res.json({
      success: true,
      // Marked, so the two answers this route can give are never confused: a
      // field-scoped `paired` is a real answer about a real field.
      fieldScoped: true,
      pairingKey,
      paired,
      localEnabled,
      // Built by the same function the chooser's own selection will run through,
      // so the dialog can never promise "no code needed" and then produce one.
      options: environmentOptions({ paired, localEnabled, localAvailable: true }),
      // The AUTOMATION mode, included only so a status line can mention it. It
      // is a different concept and must not be read as the environment.
      mode: browserModes.modeOf(userId),
    });
  });

  /**
   * Step TWO: the user picked an environment. Register the destination and say
   * what happens next.
   *
   * ONE route rather than "register" plus "decide", because the two must not be
   * able to disagree. The environment is recorded ON the target, so every later
   * delivery reports the browser the value genuinely came from rather than one
   * the extension asserted.
   *
   * BOTH environments return `step: 'targeting'` and no code. The server owns
   * both browsers and the extension inside each, so it binds the Inspector
   * itself either way.
   *
   * LOCAL   — the browser on THIS server. Bound here, before this route answers:
   *           `paired: true`, `runtime: 'server-local'`, `consent: null`. Any
   *           pairing that outlived its old address is re-pointed rather than
   *           re-established, so re-opening a node is silent.
   * REMOTE  — the headed Chromium this server launches. Also bound by the
   *           server, but it raises a Remote Approval prompt first, because that
   *           browser is long-lived and shared across targeting runs and the
   *           prompt is what names which field the next pick belongs to.
   *
   * WHAT IS NO LONGER HERE: the "not paired? mint a code for THIS field" branch.
   * It was the reported defect — see the block above `if (plan.serverMayGrant)`.
   */
  router.post('/inspector/targeting/begin', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const body = req.body || {};
    const environment = normalizeBrowserEnvironment(body.environment);

    const registration = targetFields.register(userId, {
      nodeId: body.nodeId,
      fieldKey: body.fieldKey,
      action: body.action,
      workflowId: body.workflowId,
      label: body.label,
      environment,
    });

    if (!registration.ok || !registration.target) {
      const reason = String(registration.reason || 'invalid_node_id');
      res.status(400).json({
        success: false,
        reason,
        error: REGISTER_MESSAGES[reason] || 'The target field could not be registered.',
        declared: registration.declared,
      });
      return;
    }

    const target = registration.target;
    const paired = inspectorAuth.isPairedForUser(userId, target.pairingKey);
    const plan = planTargeting({
      environment,
      paired,
      localEnabled: localTargetingEnabled(),
      localAvailable: true,
    });

    // ── FIELD IDENTITY — the one comparison both branches below obey ────────
    //
    //   «Project همیشه Source of Truth است. Project > Extension.»
    //
    // The Project's id is `target.targetFieldId`, minted by the registry from
    // workflow+node+field just above. The Extension's is whatever it declared on
    // the request — or null, when it declared nothing OR when the caller is the
    // Dashboard, which runs in a different browser and CANNOT read the
    // extension's chrome.storage.local. Both of those are MISMATCH by the rule,
    // which is the safe direction: a prompt or a code that turns out to have been
    // unnecessary, rather than a browser silently declared bound to a field it
    // has never heard of.
    //
    // Computed ONCE, here, before the environment branch. Each branch then acts
    // on `identity.requiresSync` and neither re-derives the test, so LOCAL and
    // REMOTE cannot drift into disagreeing about what a match is.
    //
    // NOTE what this is NOT keyed on: whether anything CHANGED. Re-opening the
    // same field is a new run but a MATCH, and must therefore be silent —
    //   «این سیستم نباید با هر تغییر کوچک، Authorization جدید تولید کند.»
    // WHICH id is compared is the whole correctness of this feature, and the
    // obvious choice is the WRONG one. `target.targetFieldId` carries a
    // `crypto.randomBytes(4)` suffix and is re-minted on EVERY registration —
    // background.js documents it as "the ADDRESS … re-minted whenever the node is
    // re-opened". Comparing it could therefore never once return MATCH, and the
    // feature would silently degrade into exactly the behaviour it was written
    // to remove: a prompt or a code on every single visit.
    //
    // `pairingKey` is the STABLE identity — `tf:${workflowId}:${nodeId}:${fieldKey}`,
    // derived from the same three facts every time, which is what lets "the same
    // field" mean anything at all across two visits. It is the id the extension
    // durably stores as `ab_pairingKey`, and the one this comparison uses.
    const identity = syncDecision(
      target.pairingKey,
      extensionFieldIdFromRequest(req),
    );

    // Refuse loudly instead of silently falling back to the other environment.
    if (plan.note === 'local_disabled' || plan.note === 'local_unavailable') {
      res.status(409).json({
        success: false,
        reason: plan.note,
        error: ENVIRONMENT_MESSAGES[plan.note],
        environment,
        target,
        plan,
      });
      return;
    }

    // ── LOCAL — this server's OWN browser runtime ────────────────────────────
    //
    // REPORTED, and the reason this branch and the next were swapped:
    //
    //   «وقتی لوکال می‌زنم باید مرورگر لوکال سرور بالا بیاید ولی برعکس است»
    //
    // LOCAL is named from the PROJECT's point of view: the browser on the same
    // server/infrastructure this process runs on. So LOCAL is the environment
    // that launches a browser here, and the one that needs no credential —
    // there is one machine, one trust domain, and the address is this process's
    // own loopback on its own configured port.
    //
    // The previous revision had this attached to `remote`, which is why
    // pressing LOCAL launched nothing at all.
    if (plan.serverMayGrant) {
      inspectorAuth.grant(
        // The browser runs the extension THIS server side-loaded, seeded with
        // THIS server's token (InspectorExtension.bootstrapSource). Granting to
        // that same token is therefore granting to the client that will actually
        // submit, not to an arbitrary caller.
        config.API_TOKEN,
        userId,
        target.targetFieldId,
        target.pairingKey,
      );
      // The dashboard's own key may differ from the seeded one in a multi-key
      // setup; bind it too so a pick made through it is not refused.
      if (req.apiKey && req.apiKey !== config.API_TOKEN) {
        inspectorAuth.grant(req.apiKey, userId, target.targetFieldId, target.pairingKey);
      }

      // Re-point any pairing that outlived its old address. `paired` only
      // changes the WORDING the UI shows ("reconnected" vs "connected"), never
      // whether the field works — which is what makes re-opening a node silent
      // instead of a second round of setup.
      const rebound = inspectorAuth.rebindForUser(
        userId,
        target.targetFieldId,
        target.pairingKey,
      );

      // ── The in-page prompt, and why it belongs HERE and not to REMOTE ───────
      //
      //   «ممکنه کاربر مرورگر ریموت رو از فیلد قبلی هنوز باز نگه داشته و الان که
      //    فیلد جدید می‌خواد … به جای اینکه مرورگر دوباره بالا بیاد، یه الرت توی
      //    صفحه مرورگر بالا میاد که بهمون میگه فیلد جدید فلانه، آیا می‌خواد ست
      //    بشه — و کاربر با تایید خودش مطمئن می‌شه که کار ست شده»
      //
      // The server's browser is ONE shared, long-lived window. It outlives a
      // single targeting run, so when the operator targets a second field it is
      // already open and already holding the first field's address. Nothing in
      // that address says which of the two the next pick belongs to, so a human
      // has to say — and the prompt names the node and the field so they can
      // confirm the system is aiming where they think.
      //
      // Idempotent per field: asking again for the same field refreshes the
      // existing prompt rather than stacking a second one.
      //
      // ── RAISED ONLY ON MISMATCH ─────────────────────────────────────────
      //
      //   «LOCAL: بدون Alert وقتی MATCH است؛ در Local فقط در صورت Mismatch،
      //    Alert نمایش داده می‌شود»
      //
      // This used to fire unconditionally, and that was the defect: an extension
      // ALREADY holding this exact field was asked to confirm a move to the
      // field it was already on. There is nothing for the human to decide there,
      // and asking anyway trains them to approve prompts without reading them —
      // which is precisely how a real mismatch later gets waved through.
      //
      // A MATCH therefore produces `consent: null` below. Note what that does
      // NOT mean: it is not a signal to hide the Connection card or change the
      // chooser — «Connection/Browser UI را با Authorization قاطی نکن.» The card's
      // visibility follows the existing UI design and is not derived from this.
      //
      // BROWSER LAUNCH IS A SEPARATE CONCERN and is deliberately NOT gated on
      // the verdict. Per the report it does not matter whether the browser was
      // already up — «فرق نمی‌کنه مرورگر بالا باشه یا نباشه»: an already-running
      // local browser is REUSED (the field shown in a new tab) and only an
      // absent one is launched. That reuse/launch decision belongs to the caller
      // via `openServerBrowser`, which stays TRUE on a MATCH — the operator
      // still needs to SEE the field, they just do not need to re-approve it.
      const consent = identity.requiresSync
        ? remoteTargetConsent.request({
          userId,
          targetFieldId: target.targetFieldId,
          pairingKey: target.pairingKey,
          nodeId: target.nodeId,
          fieldKey: target.fieldKey,
          label: target.label,
          action: target.action,
          // Stamped so a prompt can only ever be delivered to the browser it is
          // addressed to. This branch is LOCAL-only — `plan.serverMayGrant` is
          // true for no other environment — so the value is a constant, not a
          // pass-through of anything a caller sent.
          environment: 'local',
        })
        : null;

      // A field that now MATCHES must not leave an older prompt for itself
      // sitting unanswered in the browser. Approving that stale card later would
      // re-settle a binding that is already correct, and — worse — would make
      // the prompt look required after all.
      if (!identity.requiresSync) {
        remoteTargetConsent.clearForPairing(userId, target.pairingKey);
      }

      res.json({
        success: true,
        environment,
        step: 'targeting',
        plan,
        target,
        paired: true,
        rebound,
        // Stated positively so the dashboard can render the automatic
        // progression ("runtime ready → target resolved → connected") instead of
        // inferring "nothing to do" from a set of absent fields.
        runtime: 'server-local',
        // TRUE for LOCAL — this is the browser this server can actually launch.
        // Named `openServerBrowser`; the old `openRemoteBrowser` said the
        // opposite of what it did.
        openServerBrowser: true,
        // ── ZERO AUTHORIZATION SURFACE IN LOCAL ─────────────────────────────────
        //
        //   «LOCAL هیچ Authorization‌ای ندارد.» — no code, no generate, no
        //   refresh, no field for it, ever.
        //
        // Stated as an explicit `null` rather than by omission, and it is `null`
        // on BOTH verdicts: a LOCAL mismatch is settled by the operator
        // approving the prompt above, never by transcribing anything. LOCAL means
        // the Project and the browser are on the SAME customer server, so there
        // is no trust gap between two machines for a code to bridge — and the
        // Base URL is likewise the PROJECT's to set, not the operator's to type.
        authorization: null,
        // The comparison that decided the prompt, reported so the dashboard can
        // say WHY it is or is not asking. Informational: no client may recompute
        // the verdict from it, and no UI card's visibility depends on it.
        identity: {
          verdict: identity.verdict,
          matched: identity.matched,
          reason: identity.reason,
          projectFieldId: identity.projectFieldId,
          extensionFieldId: identity.extensionFieldId,
        },
        // The prompt to answer inside that browser, so the dashboard can say
        // "approve it there" and poll for the outcome instead of claiming the
        // field is ready before anyone agreed.
        consent: consent
          ? {
            consentId: consent.request.consentId,
            state: consent.request.state,
            expiresAt: consent.request.expiresAt,
            // TRUE when the prompt was already on screen for this field. The
            // dashboard uses it to say "still waiting" rather than repeating
            // "look at the browser" — the repeat case in the report.
            reused: consent.reused,
            nodeId: consent.request.nodeId,
            fieldKey: consent.request.fieldKey,
          }
          : null,
      });
      return;
    }

    // ── REMOTE — a browser on a machine this server does not own ─────────────
    //
    //   «در مورد ریموت فرق دارد … ما هم به یک اتورایز نیاز داریم تا تایید بشه
    //    که فرد خودش است و هم به یک بیس یو ار ال، چون سرور و سیستم شخصی دو تا
    //    ارتباط ریموتی دارند و ارتباط مستقیم با پلاگین مرورگر رو نمی‌شه رفت»
    //
    // That is a real trust gap between two machines, and it is bridged the only
    // way it can be: a one-time Authorization Code, plus the Base URL the far
    // end must reach this server on. Both are shown to the operator, who carries
    // them to the extension in their own browser.
    //
    // NO GRANT HAPPENS HERE. This server will not vouch for a browser it has
    // never seen; the binding is created when the code is redeemed at
    // POST /inspector/pair, and not before. That is the whole difference from
    // the LOCAL branch above.
    //
    // And no in-page prompt: the redeemed code named exactly one Target Field,
    // so a second question would re-ask something already answered.
    //
    // ── MINTED ONLY ON MISMATCH ───────────────────────────────────────────
    //
    //   «REMOTE: بدون Authorization جدید وقتی MATCH است؛ در Remote فقط در صورت
    //    Mismatch، Authorization جدید Generate می‌شود»
    //
    // A COMMENT HERE PREVIOUSLY ARGUED THE OPPOSITE, under the heading "WHY A
    // FRESH CODE PER FIELD IS CORRECT, NOT A NUISANCE". That was wrong, and it
    // is worth naming the error precisely because it is easy to repeat: the old
    // text observed what the unconditional `issue()` below happened to DO and
    // then promoted that result into a design rule. The actual rule is
    //
    //   «این سیستم نباید با هر تغییر کوچک، Authorization جدید تولید کند.»
    //
    // and the criterion is MATCH vs MISMATCH, never "did the field change". The
    // half the old comment got right is that the code carries the destination —
    // which is exactly why it is needed when the extension is pointed somewhere
    // ELSE (or nowhere), and exactly why it is pure friction when the extension
    // is already on this field.
    //
    // NOTE the argument order: (userId, targetFieldId, now, pairingKey). Passing
    // the pairing key THIRD would silently make it the clock, and the resulting
    // code would expire at a nonsense time. `Date.now()` is stated explicitly
    // rather than defaulted so the fourth argument can be reached at all.
    //
    // The pairing key is what makes «دفعات بعد دیگر Authorization Code لازم نیست»
    // true: it is derived from workflow+node+field, so the durable pairing the
    // redemption creates survives the node being closed and re-opened — and on
    // the next visit that same field is a MATCH, so nothing is minted at all.
    const issued = identity.requiresSync
      ? inspectorAuth.issue(
        userId,
        target.targetFieldId,
        Date.now(),
        target.pairingKey,
      )
      : null;
    // `issue` returns null only for a blank userId/targetFieldId, both of which
    // were validated above — but it is a nullable type, so it is checked rather
    // than asserted away.
    //
    // Guarded on `requiresSync` as well, because on a MATCH `issued` is null BY
    // DESIGN and must not be mistaken for the failure case. Without that
    // conjunct, every matching REMOTE field would answer HTTP 500 — turning
    // "nothing needed doing" into an error, which is the exact opposite of the
    // required behaviour.
    if (identity.requiresSync && !issued) {
      res.status(500).json({
        success: false,
        reason: 'ATTRIBUTE_SEND_FAILED',
        error: 'An authorization code could not be issued. Try again.',
        environment,
        target,
      });
      return;
    }

    // Any stale LOCAL prompt for this same field is dropped. Without this, a
    // field targeted in LOCAL and then re-targeted in REMOTE would leave an
    // approval card sitting in the server's browser that, if approved later,
    // would re-bind a destination the operator has already moved on from.
    remoteTargetConsent.clearForPairing(userId, target.pairingKey);

    res.json({
      success: true,
      environment,
      // ── THE STEP DEPENDS ON THE VERDICT ────────────────────────────────────
      //
      // MISMATCH → 'authorize': there is a code to carry and a step left to do.
      // MATCH    → 'targeting': the extension is already pointed at this exact
      //              field, so it is usable NOW and there is nothing to
      //              transcribe. Reporting 'authorize' on a match would send the
      //              dashboard looking for a code that was deliberately not
      //              minted, and the operator would sit waiting for a box that
      //              never fills.
      step: identity.requiresSync ? 'authorize' : 'targeting',
      plan,
      target,
      // TRUE only on a MATCH — a durable pairing already covers this field, so
      // the field really is ready to use. On a MISMATCH the field is NOT usable
      // yet, and saying so is the point: the operator has a step left to do.
      paired: !identity.requiresSync,
      // This server launches nothing for REMOTE. The browser is on the
      // operator's own machine; nothing here can reach it.
      openServerBrowser: false,
      // No in-page prompt in REMOTE, on either verdict — the prompt is LOCAL's
      // settling act, a code is REMOTE's.
      consent: null,
      // The comparison that decided whether a code was minted, reported so the
      // dashboard can say WHY. Informational only: no client recomputes the
      // verdict, and no card's visibility is derived from it —
      // «Connection/Browser UI را با Authorization قاطی نکن.»
      identity: {
        verdict: identity.verdict,
        matched: identity.matched,
        reason: identity.reason,
        projectFieldId: identity.projectFieldId,
        extensionFieldId: identity.extensionFieldId,
      },
      // What the operator carries to the other browser — and `null` on a MATCH,
      // which is the whole requirement:
      //   «REMOTE: بدون Authorization جدید وقتی MATCH است»
      // Note the Base URL is NOT part of this object's purpose in REMOTE: it is
      // the operator's to set, because a browser on their machine may have to
      // reach this server on a different IP, domain or port per install. It is
      // reported here only as the server's best suggestion.
      authorization: issued
        ? {
          code: issued.code,
          expiresAt: issued.expiresAt,
          // The address that browser must reach THIS server on. Offered as the
          // server's own resolution, but in REMOTE the operator may override it
          // — nothing here can know how their network routes to us.
          baseUrl: publicBaseUrl(req),
          nodeId: target.nodeId,
          fieldKey: target.fieldKey,
          label: target.label,
        }
        : null,
    });
    return;

    // ── UNREACHABLE BY CONSTRUCTION ──────────────────────────────────────────
    //
    // Both environments answer above: LOCAL through the `serverMayGrant` branch,
    // REMOTE through the authorization branch that follows it. The only plans
    // that reach neither are `local_disabled` / `local_unavailable`, and those
    // 409'd earlier in this handler.
    //
    // Kept as an explicit 500 rather than deleted so a future plan shape that
    // forgets to decide fails loudly here instead of silently returning
    // `undefined` and leaving the dashboard waiting forever.
    res.status(500).json({
      success: false,
      reason: 'ATTRIBUTE_SEND_FAILED',
      error: 'The targeting plan could not be carried out. Try again.',
      plan,
    });
  });

  /**
   * Poll: is this Target Field attached to an Inspector yet?
   *
   * WHAT THIS NO LONGER ASKS. It used to mean "has the user finished typing the
   * Authorization Code into the extension", and it answered `step:'authorize'`
   * until they had. Both halves of that are gone: LOCAL is the browser on THIS
   * server, so the server attaches it during `targeting/begin` and this route
   * reports `paired:true` on the very first poll.
   *
   * It is still worth polling, because REMOTE genuinely resolves later — the
   * approval prompt is answered inside the other browser, and this is the only
   * party that sees both sides. A socket push covers the same ground when one is
   * available; this is the path that still works behind a proxy that breaks
   * WebSockets.
   *
   * `step` is typed as TargetingStep, whose single member is 'targeting'. That is
   * what stops this route from quietly resurrecting the deleted step: there is no
   * other value it is allowed to hold.
   */
  router.get('/inspector/targeting/status', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const targetFieldId = String(req.query.targetFieldId || '');
    const target = targetFields.resolve(userId, targetFieldId);

    if (!target) {
      res.status(404).json({
        success: false,
        reason: 'TARGET_FIELD_NOT_FOUND',
        error: REFUSAL_MESSAGES.TARGET_FIELD_NOT_FOUND,
      });
      return;
    }

    const paired = inspectorAuth.isPairedForUser(userId, target.pairingKey);
    const step: TargetingStep = 'targeting';
    res.json({
      success: true,
      target,
      environment: target.environment,
      paired,
      // Not `paired ? … : 'authorize'` any more. Nothing is pending a code, so
      // an unpaired field is simply a field that is not attached YET — reported
      // by `paired`, which is the flag the dialog actually reads.
      step,
    });
  });

  /**
   * Deliberately forget a pairing — the user's own "unpair this field".
   *
   * Exists as its own route precisely so that nothing ELSE has to do it. Closing
   * a node, switching modes and expiring an address all leave the pairing alone;
   * only an explicit request here removes it. That separation is what makes the
   * persistence in the requirement real rather than best-effort.
   */
  router.post('/inspector/targeting/unpair', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const body = req.body || {};
    const pairingKey = String(body.pairingKey || '')
      || pairingKeyFor(String(body.nodeId || ''), String(body.fieldKey || ''), body.workflowId);

    // Only a pairing this user actually holds may be dropped; otherwise the
    // route would confirm whether an arbitrary key exists.
    if (!inspectorAuth.isPairedForUser(userId, pairingKey)) {
      res.json({ success: true, unpaired: 0, pairingKey });
      return;
    }
    // An unanswered prompt about a field the user just unpaired must not stay on
    // screen: approving it would re-attach the destination they deliberately
    // detached, one press after detaching it.
    remoteTargetConsent.clearForPairing(userId, pairingKey);

    res.json({ success: true, unpaired: inspectorAuth.unpair(pairingKey), pairingKey });
  });

  // ════════════════════════════════════════════════════════════════
  // Consent — how the REMOTE browser learns which field it is aiming at
  // ════════════════════════════════════════════════════════════════
  //
  // REPORTED, and the reason these three routes exist:
  //
  //   «موقعی که کاربر مرورگر روی سرور بالا اومد توی همون صفحه مرورگر یه الرت
  //    بالا بیاد و از کاربر اجازه اتصال به نود/فیلد رو بگیره و وقتی کاربر اجازه
  //    داد پلاگین خودش کد اتورایزش جایگزین میشه و اتصالشو اکتیو میکنه»
  //
  // Read as a protocol, that is: the browser ASKS what it is being requested to
  // do (GET), the human ANSWERS (POST decide), and the dashboard WATCHES for the
  // outcome (GET status). The extension never names a destination in any of the
  // three — it names a `consentId` it was handed, and the server maps that to
  // the field it decided on before the prompt existed.

  /**
   * What is this browser being asked to connect to?
   *
   * Polled by the extension inside the remote browser. Returns the FULL list of
   * outstanding prompts, not one "current" question, because the two-node case
   * in the report is precisely a case with two of them, and a single-valued
   * answer would have to silently choose.
   *
   * Scoped by the same `sessionOwners()` rule the session route uses: the
   * extension's own key may map to a different account than the dashboard that
   * raised the prompt, and asking in the wrong scope is how a prompt raised by
   * the panel became invisible to the browser it was raised for.
   */
  router.get('/inspector/consent', (req: AuthenticatedRequest, res: Response) => {
    const owners = sessionOwners(req, inspectorAuth.bindingsFor(req.apiKey || ''));

    // WHICH browser is asking?
    //
    // The extension in the operator's own Chrome and the one inside the server's
    // browser are the same build, polling this same path, authenticated into the
    // same account. Nothing about the REQUEST distinguishes them, so the client
    // states it, and a client that states 'local' is served no remote prompt.
    //
    // That is the enforcement point for «LOCAL = NO Remote Approval Alert». It
    // belongs here rather than in the UI because a prompt withheld from view but
    // still returned by the API is still delivered -- to the next poller, minutes
    // later, which is exactly the reported symptom.
    //
    // Absent or unrecognised means "do not filter": older extension builds send
    // nothing, and the remote browser runs whichever build was side-loaded into
    // it. Only an explicit 'local' narrows the list.
    //
    // normalizeBrowserEnvironment() is deliberately NOT used: its contract is to
    // fall back to a real environment ('remote' by default), which is right for
    // the targeting flow but wrong here, where "said nothing" must stay distinct
    // from "said remote".
    const declared = String(req.query.environment ?? req.header('x-browser-environment') ?? '')
      .trim()
      .toLowerCase();
    const filter: 'local' | 'remote' | '' = declared === 'local'
      ? 'local'
      : (declared === 'remote' ? 'remote' : '');

    const seen = new Set<string>();
    const requests = [];
    for (const owner of owners) {
      for (const r of remoteTargetConsent.pendingFor(owner, Date.now(), filter)) {
        if (seen.has(r.consentId)) continue;
        seen.add(r.consentId);
        requests.push(r);
      }
    }

    res.json({ success: true, count: requests.length, requests });
  });

  /**
   * The human's answer.
   *
   * THIS is where a consent becomes authority, and it is deliberately the same
   * shape as redeeming a code: the server looks up what it already decided, and
   * grants exactly that. The body carries a `consentId` and an `approve` flag —
   * never a target — so the rule «The Extension must NEVER be able to choose an
   * arbitrary Target Field» holds here as strictly as it does on /inspector/pair.
   *
   * The response carries the target so the extension can store the id it must
   * put on its next submit, which is the value that was never being written and
   * the direct cause of the reported failure.
   */
  router.post('/inspector/consent/decide', (req: AuthenticatedRequest, res: Response) => {
    const body = req.body || {};
    const consentId = String(body.consentId || '');
    const approve = body.approve !== false;

    const current = remoteTargetConsent.get(consentId);
    if (!current) {
      res.status(404).json({
        success: false,
        reason: 'consent_not_found',
        error: 'That request is no longer waiting for an answer. Press the field’s picker again.',
      });
      return;
    }

    // Answer only what was asked of an account this caller is actually in. A
    // consentId is unguessable, but "unguessable" is not an authorization model.
    const owners = new Set(sessionOwners(req, inspectorAuth.bindingsFor(req.apiKey || '')));
    if (!owners.has(current.userId)) {
      res.status(403).json({
        success: false,
        reason: 'consent_not_yours',
        error: 'That request was not addressed to this browser.',
      });
      return;
    }

    const decision = remoteTargetConsent.decide(consentId, approve);
    if (!decision.ok) {
      const reason = decision.reason || 'consent_not_found';
      res.status(reason === 'expired' ? 410 : 409).json({
        success: false,
        reason,
        error: reason === 'expired'
          ? 'That request timed out. Press the field’s picker again to ask afresh.'
          : 'That request has already been answered.',
        state: decision.request?.state,
      });
      return;
    }

    const request = decision.request!;

    if (!approve) {
      res.json({ success: true, approved: false, consentId: request.consentId });
      return;
    }

    // Bind the CALLER's key, not the seeded one: whoever answered the prompt is
    // the client that will submit, and binding anything else would authorize a
    // different client than the one the human just consented for.
    const binding = inspectorAuth.grant(
      req.apiKey || '',
      request.userId,
      request.targetFieldId,
      request.pairingKey,
    );

    // The target record is looked up rather than reconstructed from the prompt:
    // it carries the label and action the extension shows in its own UI, and a
    // field that expired between the ask and the answer must be reported as
    // gone instead of bound.
    const target = targetFields.resolve(request.userId, request.targetFieldId);
    if (!target) {
      res.status(409).json({
        success: false,
        reason: 'TARGET_FIELD_NOT_FOUND',
        error: 'That field is no longer open. Press its picker again.',
      });
      return;
    }

    res.json({
      success: true,
      approved: true,
      consentId: request.consentId,
      // The two values the extension stores — the address it must send to, and
      // the durable identity that keeps it from being asked again.
      targetFieldId: request.targetFieldId,
      pairingKey: request.pairingKey,
      binding,
      target,
    });
  });

  /**
   * Has the prompt been answered yet?
   *
   * For the DASHBOARD, which raised it and cannot see the remote browser. Same
   * reason `/inspector/targeting/status` exists for the LOCAL flow: the party
   * that asked is not the party that answers, and the server is the only one
   * that sees both.
   */
  router.get('/inspector/consent/status', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const consentId = String(req.query.consentId || '');
    const current = remoteTargetConsent.get(consentId);

    if (!current || current.userId !== userId) {
      // 200 with a state, not 404: "gone" is a legitimate answer to "how is it
      // going?", and a polling dashboard should not have to treat it as an error.
      res.json({ success: true, state: 'expired', found: false });
      return;
    }

    res.json({
      success: true,
      found: true,
      state: current.state,
      consentId: current.consentId,
      nodeId: current.nodeId,
      fieldKey: current.fieldKey,
      targetFieldId: current.state === 'approved' ? current.targetFieldId : '',
      expiresAt: current.expiresAt,
    });
  });

  /**
   * Register a Target Field. Sent by the workflow UI when a field's picker is
   * pressed — never by the extension.
   *
   * The id is minted HERE, including its random suffix. If the client supplied
   * it, it could re-register a suffix it had seen before and revive a destination
   * the user had closed, which is exactly the stale delivery the suffix exists to
   * prevent. `fieldKey` is checked against the action's declared params for the
   * reason spelled out on REGISTER_MESSAGES.
   */
  router.post('/inspector/target', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const body = req.body || {};
    const registration = targetFields.register(userId, {
      nodeId: body.nodeId,
      fieldKey: body.fieldKey,
      action: body.action,
      workflowId: body.workflowId,
      label: body.label,
      // Accepted here too so a caller that already knows its environment need
      // not go through the chooser. Absent means `remote`, which preserves the
      // exact behaviour every existing caller of this route relied on.
      environment: body.environment,
    });

    if (!registration.ok || !registration.target) {
      const reason = String(registration.reason || 'invalid_node_id');
      res.status(400).json({
        success: false,
        reason,
        error: REGISTER_MESSAGES[reason] || 'The target field could not be registered.',
        // For `undeclared_field`, name what IS declared: the caller is a UI that
        // must tell the user what to fix, and a bare refusal cannot.
        declared: registration.declared,
      });
      return;
    }

    res.json({
      success: true,
      target: registration.target,
      // Whether this field is ALREADY paired, so a caller can skip the code.
      paired: inspectorAuth.isPairedForUser(userId, registration.target.pairingKey),
      mode: browserModes.modeOf(userId),
    });
  });

  /**
   * Forget one Target Field (node closed, or the user cancelled).
   *
   * Scoped to a single id BY DESIGN, and it revokes only that id's bindings.
   * Closing one node must not disturb another node's live destination — the
   * single-slot claim this replaced could not express that.
   *
   * DROPS THE ADDRESS, KEEPS THE PAIRING. `revoke()` removes the binding to this
   * now-dead `targetFieldId`; the durable Extension⇄Field pairing, filed under
   * the stable `pairingKey`, is deliberately untouched.
   *
   * That distinction is the fix for the behaviour the requirement complains
   * about. This route fires on every NDV close — including the automatic
   * `sendBeacon` on page unload — so treating it as "the user wants to unpair"
   * meant a fresh Authorization Code every single time the node was re-opened.
   * Closing a panel is not a decision to revoke trust. Only
   * `/inspector/targeting/unpair` means that.
   */
  router.post('/inspector/target/release', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const targetFieldId = String((req.body || {}).targetFieldId || '');
    const released = targetFields.unregister(userId, targetFieldId);
    const revoked = released ? inspectorAuth.revoke(targetFieldId) : 0;
    res.json({ success: true, released, revoked, targets: targetFields.list(userId) });
  });

  /**
   * Redeem an Authorization Code. THE REMOTE HALF OF THE CONTRACT.
   *
   * ── WHY THIS ROUTE EXISTS AGAIN ────────────────────────────────────────────
   * A previous revision deleted `/inspector/authorize` and `/inspector/pair`
   * together, reasoning that «both browsers belong to this server, so neither
   * environment has anything for the operator to transcribe». The reasoning was
   * sound; the premise was inverted. REMOTE does not mean "the browser this
   * server launches" — it means the opposite:
   *
   *   «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند و ارتباط مستقیم با پلاگین
   *    مرورگر رو نمی‌شه رفت، پس ما هم به یک اتورایز نیاز داریم تا تایید بشه که
   *    فرد خودش است و هم به یک بیس یو ار ال»
   *
   * There really are two machines in the REMOTE case, and this server really
   * cannot reach into a browser on someone's desktop. A code carried by the
   * operator is the only thing that closes that gap. So this is not a deleted
   * flow growing back: it is the flow restored to the one environment that
   * always needed it.
   *
   * `/inspector/authorize` is deliberately NOT restored alongside it. Minting is
   * not a separate operator action any more — `/inspector/targeting/begin`
   * issues the code as part of choosing REMOTE, so there is no way to obtain a
   * code without having named the field it is for. A standalone minting endpoint
   * would be a code with no destination attached, which is exactly the loose
   * "Connect Inspector" button that the Targeting flow replaced.
   *
   * THE EXTENSION AUTHENTICATES WITH ITS OWN KEY, and the binding is filed
   * against that key — so redeeming a code proves "this client, for that one
   * field", never "this client, for anything it later asks about". The standing
   * rule holds: «The Extension must NEVER be able to choose an arbitrary Target
   * Field.» It names a code; the SERVER decides what that code meant.
   */
  router.post('/inspector/pair', (req: AuthenticatedRequest, res: Response) => {
    const body = req.body || {};
    const code = String(body.code || '');
    // The caller's own key when it HAS one — a server-seeded extension, or the
    // dashboard — so an already-authenticated client keeps its identity and the
    // bindings filed against it.
    const apiKey = String(req.apiKey || '');

    // ── A KEYLESS CALLER IS THE NORMAL CASE HERE, NOT AN ERROR ──────────────
    //
    // This route used to answer 401 when `req.apiKey` was empty. REPORTED:
    //
    //   «در حالت ریموت وقتی ادرس و کد اتورایز رو وارد کردم این ارور رو داد در
    //    حالی که هر دو درست بودن»
    //
    // …and both really were correct. A REMOTE extension is installed by hand
    // from artifacts/, so it carries no `bootstrap.config.js` and therefore no
    // key; the refusal fired before the code was examined, and the popup's
    // fallback sentence blamed the code. Worse, the 401 was dressed as
    // INVALID_AUTHORIZATION_CODE — reporting a wrong secret for an absent one.
    //
    // The check is gone rather than relaxed, because requiring a key to redeem a
    // code is self-contradictory: REMOTE's premise is that the two machines
    // share no channel but the operator. `redeem()` now identifies a keyless
    // caller by minting it a scoped client token, and the CODE is the proof —
    // which is exactly what a single-use, 5-minute, high-entropy secret is for.
    const result = inspectorAuth.redeem(apiKey, code);

    if (!result.ok) {
      const reason = String(result.reason || 'INVALID_AUTHORIZATION_CODE');
      // 403 rather than 400: the request was well-formed, the credential was
      // not accepted. The two reasons are kept distinct because "ask for a new
      // code" and "check what you typed" are different instructions.
      res.status(403).json({
        success: false,
        reason,
        error: AUTHORIZATION_MESSAGES[reason]
          || 'That authorization code was not accepted.',
      });
      return;
    }

    // The extension learns its destination HERE, and only here. This is the
    // value it will address every subsequent submit with — the answer to
    // «ظاهرا نمیدونه به کدوم فیلد باید ارسال بشه» for the REMOTE case, exactly
    // as the in-page prompt is the answer for LOCAL.
    // The destination comes off the BINDING the server just created, not off
    // anything the caller sent. `redeem` resolved the code to a field itself, so
    // this response is the server telling the extension what it decided.
    res.json({
      success: true,
      paired: true,
      environment: 'remote',
      targetFieldId: result.binding.targetFieldId,
      userId: result.binding.userId,
      // ── THE CREDENTIAL FOR EVERYTHING AFTER THIS ────────────────────────
      //
      // Present ONLY when the caller had no API key, which is the hand-installed
      // REMOTE case. This is the single moment the value exists — the server
      // keeps a lookup entry, never the means to re-derive it — so an extension
      // that fails to store it must redeem another code.
      //
      // It is NOT the server's API_TOKEN and grants none of its powers: it is
      // accepted on the element-submission and status paths only, and even there
      // the server consults its own binding table to decide which fields this
      // client may write to. See the inspector auth middleware in src/index.ts.
      //
      // Omitted entirely for a keyed caller, so a dashboard never receives a
      // second credential it has no use for.
      ...(result.clientToken ? { clientToken: result.clientToken } : {}),
    });
  });

  /**
   * The extension sends the ONE radio-selected attribute. THE route this whole
   * feature exists for.
   *
   * 409 with a §27 code on refusal. «Do not silently redirect to another Field» —
   * so a submission that cannot be placed correctly is not placed at all, and the
   * user sees why instead of a pick that vanished.
   */
  router.post('/inspector/element', (req: AuthenticatedRequest, res: Response) => {
    const body = req.body || {};
    // The TARGET's account, not merely the caller's — see ownerForTarget(). The
    // delivery has to be queued where the dashboard that opened the field is
    // looking, or a 200 hides a pick that never arrives.
    const userId = ownerForTarget(req, String(body.targetFieldId || ''));

    const result = inspectorHub.submit(userId, {
      targetFieldId: body.targetFieldId,
      // From the credential, never from the body: a body-supplied key would let
      // any caller claim another client's pairing.
      apiKey: req.apiKey || '',
      element: body.element,
      displayAttributes: body.displayAttributes,
      sendAttribute: body.sendAttribute,
      mode: body.mode || browserModes.modeOf(userId),
    });

    if (!result.ok) {
      const reason = result.reason as InspectorRefusal;
      res.status(409).json({
        success: false,
        reason,
        error: REFUSAL_MESSAGES[reason] || 'The element could not be delivered.',
        targets: targetFields.list(userId),
      });
      return;
    }

    const delivery = result.delivery!;
    // The §24 success shape: naming the field, the attribute and the value is
    // what proves to the user it did not go elsewhere.
    res.json({
      success: true,
      targetFieldId: delivery.target.targetFieldId,
      nodeName: delivery.target.label || delivery.target.nodeId,
      fieldName: delivery.target.fieldKey,
      attribute: delivery.attribute,
      value: delivery.value,
      delivery,
    });
  });

  /**
   * The WebSocket-less path to picks.
   *
   * Defaults to PEEK, not drain: a client that asks and then fails to apply the
   * result (a reload mid-flight) must not have destroyed the only copy. `?drain=1`
   * is for a client that commits to applying what it receives.
   */
  router.get('/inspector/inbox', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const drain = String(req.query.drain || '') === '1'
      || String(req.query.drain || '').toLowerCase() === 'true';
    const items = drain ? inspectorHub.drain(userId) : inspectorHub.peek(userId);
    res.json({ success: true, drained: drain, count: items.length, items });
  });

  /** Applied one: remove it so a later poll does not re-apply it. */
  router.post('/inspector/ack', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const id = (req.body || {}).id;
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ success: false, error: 'id is required' });
      return;
    }
    res.json({ success: true, acked: inspectorHub.ack(userId, id) });
  });

  return router;
};
