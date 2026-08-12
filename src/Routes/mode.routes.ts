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
  type BrowserModeName,
} from '../core/BrowserMode';
import { localBridges, agentConnectPath, defaultAgentCdpPort } from '../core/LocalBridge';
import { forgetLocalConnection } from '../core/BrowserAdapter';
import { inspectorHub, type InspectorRefusal } from '../core/InspectorHub';

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
