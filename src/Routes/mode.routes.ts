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
import { forgetLocalConnection } from '../core/BrowserAdapter';
import { inspectorHub, type InspectorRefusal } from '../core/InspectorHub';
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

const REFUSAL_MESSAGES: Record<InspectorRefusal, string> = {
  no_active_node:
    'No node is waiting for an element. Open a node in the workflow editor and press its picker button first.',
  stale_session:
    'That pick belongs to an older editing session. Re-open the node and pick again.',
  empty_selection:
    'No attributes were selected. Tick at least one attribute before confirming.',
  invalid_element:
    'The element data was incomplete and could not be used.',
};

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
    res.json({
      success: true,
      userId,
      mode: report.mode,
      modes: report.modes,
      localAvailable: report.localAvailable,
      bridge: localBridges.info(userId),
      activeNode: inspectorHub.activeNode(userId),
      pending: inspectorHub.peek(userId).length,
    });
  });

  /** "Session S is editing node N." Sent by the workflow UI, not the extension. */
  router.post('/inspector/claim', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const body = req.body || {};
    const session = inspectorHub.claim(userId, {
      sessionId: body.sessionId,
      nodeId: body.nodeId,
      action: body.action,
      workflowId: body.workflowId,
      field: body.field,
      label: body.label,
    });

    if (!session) {
      res.status(400).json({
        success: false,
        error: 'sessionId and nodeId are both required',
      });
      return;
    }
    res.json({ success: true, activeNode: session, mode: browserModes.modeOf(userId) });
  });

  /** Stop waiting for an element (node closed, or the user cancelled). */
  router.post('/inspector/release', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const released = inspectorHub.release(userId, (req.body || {}).sessionId);
    res.json({ success: true, released, activeNode: inspectorHub.activeNode(userId) });
  });

  /**
   * The extension confirms a pick. THE route this whole feature exists for.
   *
   * 409 with the reason on refusal. The user then sees "no node is waiting"
   * instead of a pick that vanished, which is the difference between a UI they
   * can learn and one they distrust.
   */
  router.post('/inspector/element', (req: AuthenticatedRequest, res: Response) => {
    const userId = resolveUserId(req);
    const body = req.body || {};

    const result = inspectorHub.submit(userId, {
      sessionId: body.sessionId,
      element: body.element,
      selected: body.selected,
      mode: body.mode || browserModes.modeOf(userId),
    });

    if (!result.ok) {
      const reason = result.reason as InspectorRefusal;
      res.status(409).json({
        success: false,
        reason,
        error: REFUSAL_MESSAGES[reason] || 'The element could not be delivered.',
        activeNode: inspectorHub.activeNode(userId),
      });
      return;
    }

    res.json({
      success: true,
      delivery: result.delivery,
      // Echoed so the extension can show "added to: Click #buy" — a confirmation
      // naming the actual destination is what proves it did not go elsewhere.
      activeNode: result.delivery?.session,
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
