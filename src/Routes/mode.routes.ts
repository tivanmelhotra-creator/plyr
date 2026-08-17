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
import { resolveBaseUrl, requestHints } from '../core/PublicBaseUrl';
import { forgetLocalConnection } from '../core/BrowserAdapter';
import { inspectorHub, type InspectorRefusal } from '../core/InspectorHub';
import { targetFields, pairingKeyFor } from '../core/TargetFieldRegistry';
import { inspectorAuth } from '../core/InspectorAuthorization';
import {
  planTargeting,
  environmentOptions,
  normalizeBrowserEnvironment,
} from '../core/BrowserEnvironment';
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
    'Target not authorized. This Inspector is not authorized for the requested Field — request a new Authorization Code.',
  ELEMENT_INSPECTION_FAILED:
    'Unable to inspect element. Try selecting the element again.',
  ATTRIBUTE_SEND_FAILED:
    'Unable to send attribute. Select one attribute with a value, then retry the send.',
};

/** The pairing-step failures, kept beside the send-step ones for one lookup. */
const AUTHORIZATION_MESSAGES: Record<string, string> = {
  INVALID_AUTHORIZATION_CODE:
    'Authorization code invalid. Request a new Authorization Code.',
  AUTHORIZATION_EXPIRED:
    'Authorization code expired. Start a new Inspector authorization.',
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

/**
 * The address to put beside an Authorization Code.
 *
 * A code with no address is not usable: the operator has to type BOTH into the
 * extension, and previously only the code was shown. Every route that issues a
 * code goes through here, so the two issue sites cannot drift into advertising
 * different addresses — which would be worse than showing nothing, because the
 * operator would have no way to tell which one to believe.
 *
 * The request is passed in because the address the operator's own browser
 * reached the panel on is better evidence than anything this process can detect
 * about itself: it already accounts for reverse proxies, published container
 * ports and tunnels.
 */
function advertisedBaseUrl(req: AuthenticatedRequest) {
  return resolveBaseUrl({
    configuredDomain: config.PUBLIC_DOMAIN,
    port: config.PORT,
    request: requestHints(req as unknown as {
      headers?: Record<string, unknown>;
      socket?: { encrypted?: boolean };
    }),
  });
}

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

    if (!nodeId || !fieldKey) {
      res.status(400).json({
        success: false,
        reason: 'invalid_node_id',
        error: 'nodeId and fieldKey are required.',
      });
      return;
    }

    const pairingKey = pairingKeyFor(nodeId, fieldKey, workflowId);
    const paired = inspectorAuth.isPairedForUser(userId, pairingKey);
    const localEnabled = localTargetingEnabled();

    res.json({
      success: true,
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
   * REMOTE  — the server owns that Chromium and the extension inside it, so it
   *           binds the Inspector itself and returns `step: 'targeting'`. No
   *           code, exactly as the requirement states.
   * LOCAL   — already paired? Re-point the existing pairing at the new address
   *           and go straight to targeting. Not paired? Mint a code for THIS
   *           field, and only this field.
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

    // ── REMOTE: server-owned browser, server-granted binding, no code ────────
    if (plan.serverMayGrant) {
      inspectorAuth.grant(
        // The remote Chromium runs the extension THIS server side-loaded, seeded
        // with THIS server's token (InspectorExtension.bootstrapSource). Granting
        // to that same token is therefore granting to the client that will
        // actually submit, not to an arbitrary caller.
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

      res.json({
        success: true,
        environment,
        step: 'targeting',
        plan,
        target,
        paired: true,
        openRemoteBrowser: true,
      });
      return;
    }

    // ── LOCAL, already paired: refresh the address, ask for nothing ──────────
    if (!plan.needsAuthorization) {
      // The pairing outlived the old address; this hands it the new one. Without
      // it the user would be correctly told "no code needed" and then find that
      // nothing could be delivered — trust with no address is not usable.
      const rebound = inspectorAuth.rebindForUser(userId, target.targetFieldId, target.pairingKey);
      res.json({
        success: true,
        environment,
        step: 'targeting',
        plan,
        target,
        paired: true,
        rebound,
        openRemoteBrowser: false,
      });
      return;
    }

    // ── LOCAL, first time for THIS field: issue a code ───────────────────────
    const offer = inspectorAuth.issue(userId, target.targetFieldId, Date.now(), target.pairingKey);
    if (!offer) {
      res.status(500).json({
        success: false,
        reason: 'ATTRIBUTE_SEND_FAILED',
        error: 'The authorization code could not be issued. Try again.',
      });
      return;
    }

    // The code is half of what the operator needs; this is the other half.
    // Sent alongside rather than left to the UI to guess, because only the
    // server knows its own configured domain and listening port.
    const base = advertisedBaseUrl(req);

    res.json({
      success: true,
      environment,
      step: 'authorize',
      plan,
      target,
      paired: false,
      openRemoteBrowser: false,
      code: offer.code,
      display: formatPairingCode(offer.code),
      expiresAt: offer.expiresAt,
      expiresInMs: offer.expiresInMs,
      baseUrl: base.baseUrl,
      // How the address was arrived at, so the dialog can say "detected" rather
      // than presenting a guess with the same confidence as a configured domain.
      baseUrlSource: base.source,
    });
  });

  /**
   * Poll: has the user finished typing the code into the extension yet?
   *
   * The dashboard cannot observe the extension directly — they are different
   * browsers, which is the entire point of LOCAL. So the chooser asks the server,
   * which is the only party that sees both sides. A socket push covers the same
   * ground when one is available; this is the path that still works behind a
   * proxy that breaks WebSockets.
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
    res.json({
      success: true,
      target,
      environment: target.environment,
      paired,
      step: paired ? 'targeting' : 'authorize',
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
    res.json({ success: true, unpaired: inspectorAuth.unpair(pairingKey), pairingKey });
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
   * Issue a one-time Authorization Code for one Target Field.
   *
   * The API key already answers "which account is this?". It cannot answer "which
   * of the fields this account has open did the human mean?" — and without a
   * deliberate pairing step the server would have to guess. The code makes that
   * choice an explicit act, performed once per destination.
   */
  router.post('/inspector/authorize', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const targetFieldId = String((req.body || {}).targetFieldId || '');

    // Authorize only a target that actually exists and belongs to this account.
    // Issuing a code for an unknown id would let a caller discover valid ids by
    // watching which ones produce a code.
    const target = targetFields.resolve(userId, targetFieldId);
    if (!target) {
      res.status(404).json({
        success: false,
        reason: 'TARGET_FIELD_NOT_FOUND',
        error: REFUSAL_MESSAGES.TARGET_FIELD_NOT_FOUND,
      });
      return;
    }

    // File the offer under the target's STABLE pairing key, not just its
    // address.
    //
    // `issue()` falls back to the targetFieldId when no pairing key is given,
    // and that fallback is wrong here: a targetFieldId is re-minted on every
    // NDV open, so a pairing filed under it is dead the moment the operator
    // closes the panel — and they are asked for a second code for a field they
    // already paired. This legacy route predates the pairing key and was still
    // taking that fallback, which quietly broke «دفعات بعد برای همان Extension
    // و همان Target Field، دیگر نیازی به Authorization Code جدید نیست» for
    // anyone pairing through it rather than through the LOCAL/REMOTE chooser.
    // The target is already resolved above, so its stable identity is right
    // here to be used.
    const offer = inspectorAuth.issue(userId, target.targetFieldId, Date.now(), target.pairingKey);
    if (!offer) {
      res.status(500).json({
        success: false,
        reason: 'ATTRIBUTE_SEND_FAILED',
        error: 'The authorization code could not be issued. Try again.',
      });
      return;
    }

    const base = advertisedBaseUrl(req);

    res.json({
      success: true,
      // Grouped for display, like the handoff code. The raw form is included
      // because that is what `redeem` compares.
      code: offer.code,
      display: formatPairingCode(offer.code),
      target,
      expiresAt: offer.expiresAt,
      expiresInMs: offer.expiresInMs,
      // Same pair as the targeting route: a code is not usable without the
      // address it belongs to, and this legacy route's callers need it just as
      // much as the new one's.
      baseUrl: base.baseUrl,
      baseUrlSource: base.source,
    });
  });

  /**
   * Redeem the code — the extension's one-time pairing step.
   *
   * The target is taken from the CODE, never from the body. §8: «The Extension
   * must NEVER be able to choose an arbitrary Target Field.» After this, ordinary
   * sends need only the API key.
   */
  router.post('/inspector/pair', (req: AuthenticatedRequest, res: Response) => {
    const body = req.body || {};
    const apiKey = req.apiKey || '';
    const result = inspectorAuth.redeem(apiKey, String(body.code || ''));

    if (!result.ok) {
      const reason = result.reason;
      // 403, not 409: the credential presented is not sufficient. Expired and
      // invalid are reported separately because "ask for a new code" and "check
      // what you typed" are different instructions.
      res.status(403).json({
        success: false,
        reason,
        error: AUTHORIZATION_MESSAGES[reason] || 'The authorization code was refused.',
      });
      return;
    }

    // Resolved for display so the extension can show the destination it is now
    // bound to, rather than an opaque id.
    const target = targetFields.resolve(result.binding.userId, result.binding.targetFieldId);
    res.json({
      success: true,
      binding: result.binding,
      target,
      mode: browserModes.modeOf(result.binding.userId),
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
