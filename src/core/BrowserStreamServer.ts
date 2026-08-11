'use strict';

import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { URL } from 'url';

import { LiveBrowserManager, LiveBrowserSession } from './LiveBrowser';
import type { Mods } from './BrowserInput';
import { authorizeLive } from './LiveServer';

// ════════════════════════════════════════════════════════════════
// BrowserStreamServer (Step 12) — WebSocket endpoint /browser/ws.
// ----------------------------------------------------------------
// Each connection owns one interactive LiveBrowserSession. Outbound:
// JSON control events + binary-ish JSON screencast frames (base64).
// Inbound: JSON commands { t: 'navigate'|'click'|'move'|'type'|'key'|
// 'scroll'|'picker'|'pickStep'|'verify', ... } which are replayed on
// the server browser.
//
// Auth re-uses authorizeLive (same rules as the live event channel):
// env/admin key => full access; user key => must own the userId.
// This server does NOT register its own 'upgrade' listener; index.ts
// multiplexes /live/ws and /browser/ws through one handler and calls
// handleUpgrade() here. That avoids two listeners both destroying
// sockets they don't recognise.
// ════════════════════════════════════════════════════════════════

export class BrowserStreamServer {
  private wss: WebSocketServer;
  constructor(private readonly manager: LiveBrowserManager) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  // Does this upgrade request belong to us?
  matches(pathname: string): boolean {
    return pathname === '/browser/ws';
  }

  // Register an 'upgrade' listener that ONLY handles /browser/ws and
  // ignores (returns without destroying) any other path, so it can
  // coexist with LiveServer's own upgrade listener on the same server.
  attach(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let pathname = '';
      try { pathname = new URL(req.url || '', 'http://localhost').pathname; }
      catch { return; }
      if (!this.matches(pathname)) return; // not ours; LiveServer may handle it
      this.handleUpgrade(req, socket, head);
    });
  }

  // Called by the multiplexed upgrade handler in index.ts.
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let parsed: URL;
    try {
      parsed = new URL(req.url || '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    const userId = parsed.searchParams.get('userId') || '';
    const apiKey = parsed.searchParams.get('api_key')
      || (req.headers['x-api-key'] as string | undefined);

    if (!userId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    authorizeLive(apiKey, userId).then((auth) => {
      if (!auth.ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.onConnection(ws, userId);
      });
    }).catch(() => {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  }

  private send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ t: type, ...data })); } catch { /* ignore */ }
    }
  }

  private async onConnection(ws: WebSocket, userId: string): Promise<void> {
    let session: LiveBrowserSession;
    try {
      session = this.manager.create(userId);
    } catch (e) {
      this.send(ws, 'error', { message: (e as Error).message });
      try { ws.close(1011, 'no_session'); } catch { /* ignore */ }
      return;
    }

    // Wire session output to this socket.
    session.setSinks(
      (frame) => this.send(ws, 'frame', { ...frame }),
      (type, data) => {
        this.send(ws, type, data);
        // ── A dead session must not leave a live-looking socket ────────────
        // MEASURED (Ask #13): when the idle timer fired, the session closed but
        // this socket stayed OPEN (readyState 1). `handleCommand` starts with
        // `if (session.isClosed()) return;`, so from that moment every command
        // the user sent — tabNew, navigate, even ping — was dropped in total
        // silence while the UI still read "connected". That is the whole of the
        // reported crash: a window that looks fine, answers nothing, and can
        // only be fixed by closing and reopening it.
        //
        // `expired` is the session's own announcement that it has gone. Closing
        // the socket on it converts an invisible death into an ordinary
        // disconnect: the client's `onclose` runs, the status says so, and
        // Reconnect builds a new session. A user who can see what happened has
        // a way out; a user staring at a frozen canvas does not.
        //
        // 4000 is the first application-defined close code, and the reason is
        // sent with it so the client can say something true rather than guess.
        if (type === 'expired') {
          try { ws.close(4000, 'session_expired'); } catch { /* already gone */ }
        }
      }
    );

    // Heartbeat.
    const sock = ws as WebSocket & { __alive?: boolean };
    sock.__alive = true;
    ws.on('pong', () => { sock.__alive = true; });

    const cleanup = async () => {
      await this.manager.destroy(session.id).catch(() => {});
    };
    ws.on('close', () => { void cleanup(); });
    ws.on('error', () => { /* close handler cleans up */ });

    // ════════════════════════════════════════════════════════════════
    // The message listener is attached BEFORE `session.start()`, and
    // anything that arrives while the browser is still booting is
    // QUEUED instead of dropped.
    //
    // WHY: `session.start()` launches a context + page + CDP screencast,
    // which takes ~300-900 ms. The client sends its first command from
    // `ws.onopen` — for the Element Picker window that command is the
    // `navigate` carrying the URL the user typed (browser-view.js
    // `connect()`). `ws` only delivers frames to listeners registered at
    // the time they arrive, so with the listener attached after `start()`
    // that first navigate was silently thrown away: the picker window
    // opened on `about:blank`, the address never loaded, and the only
    // symptom was a black stage — no error anywhere.
    // ════════════════════════════════════════════════════════════════
    let started = false;
    const pending: Array<{ t?: string; [k: string]: unknown }> = [];
    ws.on('message', (raw: RawData) => {
      let msg: { t?: string; [k: string]: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (!started) {
        // Cap the queue: a client that spams while we boot must not grow
        // an unbounded buffer. 50 is far more than a real open sends.
        if (pending.length < 50) pending.push(msg);
        return;
      }
      // MEASURED 2026-08-03: this was a bare `void`, with no catch. Every command
      // the user sends arrives here, so ANY command that rejected became an
      // unhandledRejection — and src/index.ts answers unhandledRejection with a
      // graceful shutdown of the entire process. One tab that lost its CDP target
      // therefore killed the server for everyone, and the only way back was the
      // manual restart the GLOBAL MANDATE exists to abolish. The replay path
      // below always had its `.catch`; the hot path did not, which is why this
      // only ever bit real users and never the tests.
      //
      // A failed command is reported to the client that sent it and nothing else
      // happens. The session stays up, and the UI shows a real state rather than
      // going quiet.
      void this.handleCommand(session, msg).catch((e: unknown) => {
        const detail = (e as Error)?.message || String(e);
        try {
          this.send(ws, 'error', { message: 'command_failed', command: msg.t, detail });
        } catch { /* the socket is gone; there is nobody left to tell */ }
      });
    });

    // Start the browser session (creates context/page + screencast).
    try {
      await session.start();
    } catch (e) {
      this.send(ws, 'error', { message: 'browser_unavailable: ' + (e as Error).message });
      await cleanup();
      try { ws.close(1011, 'browser_unavailable'); } catch { /* ignore */ }
      return;
    }

    started = true;
    // Replay in arrival order, sequentially: `navigate` then `picker` must
    // not race, or the picker script is injected into the page we are
    // leaving.
    for (const msg of pending.splice(0)) {
      if (session.isClosed()) break;
      await this.handleCommand(session, msg).catch(() => {});
    }
  }

  private async handleCommand(
    session: LiveBrowserSession,
    msg: { t?: string; [k: string]: unknown }
  ): Promise<void> {
    if (session.isClosed()) return;
    const num = (v: unknown, d = 0): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    /**
     * Modifier keys, as the client reports them.
     *
     * Sent as four booleans rather than a bitmask because the client reads them
     * straight off a DOM event (`ev.ctrlKey` &c.), and translating on the client
     * would mean two places had to agree on the bit values. `modifierMask` in
     * BrowserInput is the single place that knows Alt=1 Ctrl=2 Meta=4 Shift=8.
     */
    const mods = (v: unknown): Mods => {
      const m = (v || {}) as Record<string, unknown>;
      return { alt: !!m.alt, ctrl: !!m.ctrl, meta: !!m.meta, shift: !!m.shift };
    };
    switch (msg.t) {
      case 'navigate':
        await session.navigate(String(msg.url || ''));
        break;
      // History. The picker window browses for real, so it needs the controls a
      // browser has; without Back, following a link into the wrong page left
      // retyping the URL as the only way out.
      case 'back':
        await session.back();
        break;
      case 'forward':
        await session.forward();
        break;
      // `hard` is Ctrl+Shift+R — a cache-bypassing reload. Chrome has both and
      // the difference is the whole reason the second one exists: a normal reload
      // of a page whose stylesheet is cached shows you the same broken page again.
      case 'reload':
        await session.reload({ hard: !!msg.hard });
        break;
      // ── Mouse ─────────────────────────────────────────────────────────
      // `button` (left/middle/right/back/forward), `clickCount` (2 = double,
      // 3 = triple, which is how a paragraph gets selected) and modifiers all
      // travel, because all of them change what the click MEANS: Ctrl+click is
      // "open in a new tab", middle-click is "open in a background tab",
      // Shift+click extends a selection. A click command that carried only x/y
      // could express exactly one of the things a mouse does.
      case 'click':
        await session.click(num(msg.x), num(msg.y), {
          button: msg.button,
          clickCount: msg.clickCount,
          mods: mods(msg.mods),
        });
        break;
      case 'move':
        await session.move(num(msg.x), num(msg.y), {
          mods: mods(msg.mods),
          buttons: num(msg.buttons),
        });
        break;
      // Press, move, release — one command, because the three halves have to
      // reach the same page in order. This is text selection, slider dragging,
      // drag & drop and file-drag upload, none of which a click can express.
      // MEASURED 2026-08-03 (tools/probe-live-parity.js): this only read flat
      // `x,y,x2,y2`, but public/js/browser-view.js has always sent
      // `from:{x,y}, to:{x,y}`. So every real drag arrived as 0,0 → 0,0 and did
      // nothing at all: no drag-to-select text, no sliders, no drag & drop. It
      // failed SILENTLY, which is why it survived — the command was accepted, a
      // gesture was dispatched, and it just happened to be a zero-length one in
      // the corner of the page. A protocol mismatch between the only client and
      // the only server is invisible to any test that exercises one side alone;
      // it took driving the real socket to see it.
      //
      // Both shapes are accepted now. The nested form is what the client sends
      // and is preferred; the flat form stays supported so a probe or an older
      // client is not broken by the fix.
      case 'drag': {
        const pt = (nested: unknown, fx: unknown, fy: unknown) => {
          const o = nested as { x?: unknown; y?: unknown } | null | undefined;
          return o && typeof o === 'object'
            ? { x: num(o.x), y: num(o.y) }
            : { x: num(fx), y: num(fy) };
        };
        await session.drag(
          pt(msg.from, msg.x, msg.y),
          pt(msg.to, msg.x2, msg.y2),
          { button: msg.button, mods: mods(msg.mods), steps: num(msg.steps, 12) },
        );
        break;
      }
      // `dx` is Shift+Scroll / a trackpad's horizontal axis. Without it a wide
      // table or a horizontal carousel simply could not be scrolled.
      case 'scroll':
        await session.scroll(num(msg.x), num(msg.y), num(msg.dy), {
          dx: num(msg.dx),
          mods: mods(msg.mods),
        });
        break;
      case 'pinch':
        await session.pinch(num(msg.x), num(msg.y), num(msg.scale, 1));
        break;
      // Real browser zoom (Ctrl + / − / 0). MEASURED: this is
      // Emulation.setDeviceMetricsOverride, not setPageScaleFactor — the latter
      // cannot go below 100% and does not reflow the page.
      case 'zoom':
        await session.setZoom(
          msg.level === undefined
            ? (String(msg.dir || 'reset') as 'in' | 'out' | 'reset')
            : num(msg.level, 1),
        );
        break;
      // The right-click menu. The server fires a REAL right-click first (so the
      // page's own contextmenu handler and its preventDefault are honoured) and
      // then reports what is under the cursor, so the menu can offer
      // "Open link in new tab" only when there is a link.
      case 'contextMenu':
        await session.contextMenuAt(num(msg.x), num(msg.y));
        break;
      // Double/triple click semantics, done through Selection.modify rather than
      // by guessing at word boundaries client-side.
      case 'expandSelection':
        await session.expandSelection(msg.unit === 'paragraph' ? 'paragraph' : 'word');
        break;
      case 'type':
        await session.type(String(msg.text || ''));
        break;
      // Every key, with every modifier — NOT a whitelist. The old client sent
      // nine named keys and dropped anything with Ctrl/Alt/Meta held, which meant
      // F5, Home, End, Ctrl+F, Ctrl+A and the whole function row did nothing.
      // The client sends `autoRepeat` (the CDP field name); this used to read
      // only `repeat`, so a held key never told Blink it was a repeat. Same class
      // of silent client/server mismatch as `drag` above — accept both.
      case 'key':
        await session.key(String(msg.key || ''), mods(msg.mods), {
          autoRepeat: !!(msg.autoRepeat ?? msg.repeat),
        });
        break;
      // ── Clipboard bridge ──────────────────────────────────────────────
      // The canvas is a picture of a browser on another machine, so Ctrl+C and
      // Ctrl+V cross a machine boundary that nothing else in this protocol
      // crosses: the text has to travel as a message.
      case 'paste':
        await session.paste(String(msg.text || ''));
        break;
      case 'copy':
        await session.readClipboard();
        break;
      case 'selectAll':
        await session.selectAll();
        break;
      // ── "Save image as" / "Save link as" ──────────────────────────────
      // The context menu can save a target the page never downloaded. The
      // fetch runs on the SERVER through the context's own request client:
      // measured, an injected cross-origin `<a download>` makes Chrome
      // NAVIGATE instead of downloading, and an in-page fetch() is refused by
      // CORS. See LiveBrowser.saveUrl.
      case 'saveUrl':
        await session.saveUrl(String(msg.url || ''), String(msg.name || ''));
        break;
      // ── Remote file upload ────────────────────────────────────────────
      // `tokens`, never paths — see RemoteUploads for why a path here would be
      // an arbitrary-file-read on the server.
      case 'fileAccept':
        await session.acceptFiles(
          Array.isArray(msg.tokens) ? (msg.tokens as unknown[]).map(String) : [],
        );
        break;
      case 'fileCancel':
        await session.cancelFileChooser();
        break;
      case 'picker':
        await session.setPicker(!!msg.on);
        break;
      // Element-picker refinements (the ↑/↓ arrows and the double-check button
      // in the picker panel). Both answer on the picker's own channels.
      case 'pickStep':
        await session.pickStep(String(msg.dir || 'up'));
        break;
      case 'verify':
        await session.verifySelector(String(msg.selector || ''));
        break;
      // ── Tabs ──────────────────────────────────────────────────────────
      // The session owns a LIST of pages now, so "open this somewhere" no longer
      // has to mean "over the top of whatever the user was doing". That was a
      // real loss, not a nuisance: opening a cookie extension's popup used to
      // navigate the active tab away from the page the cookies were FOR.
      //
      // An empty `url` is legal and means about:blank — the same thing Ctrl+T
      // does in a real browser.
      case 'tabNew':
        await session.newTab(String(msg.url || ''));
        break;
      case 'tabSelect':
        await session.selectTab(String(msg.id || ''));
        break;
      // No `force` from the client: a close request from the UI must always be
      // allowed to raise the page's beforeunload prompt. Forcing is something
      // only the server does, after the user has answered that prompt.
      case 'tabClose':
        await session.closeTab(String(msg.id || ''));
        break;
      // Drag-to-reorder.
      case 'tabMove':
        await session.moveTab(String(msg.id || ''), num(msg.index));
        break;
      case 'tabDuplicate':
        await session.duplicateTab(String(msg.id || ''));
        break;
      case 'tabPin':
        await session.pinTab(
          String(msg.id || ''),
          msg.pinned === undefined ? undefined : !!msg.pinned,
        );
        break;
      case 'tabMute':
        await session.muteTab(
          String(msg.id || ''),
          msg.muted === undefined ? undefined : !!msg.muted,
        );
        break;
      case 'tabCloseOthers':
        await session.closeOtherTabs(String(msg.id || ''));
        break;
      case 'tabCloseRight':
        await session.closeTabsToRight(String(msg.id || ''));
        break;
      // Ctrl+Shift+T. "I closed the wrong tab" is one of the most common things
      // anyone does in a browser, and without this the only recovery was
      // remembering the URL — which is what the tab was remembering for them.
      case 'tabReopen':
        await session.reopenClosedTab();
        break;
      // Ctrl+Tab / Ctrl+Shift+Tab.
      case 'tabCycle':
        await session.cycleTab(num(msg.dir, 1) < 0 ? -1 : 1);
        break;
      // ── Page dialogs ──────────────────────────────────────────────────
      // alert / confirm / prompt / beforeunload. Before this, a page that opened
      // one locked its tab in silence: Playwright blocks waiting for an answer
      // nobody could give, so the canvas froze with no error of any kind.
      case 'dialogAnswer':
        await session.answerDialog(!!msg.accept, String(msg.text || ''));
        break;
      // ── HTTP basic auth ───────────────────────────────────────────────
      // The native credentials window can never appear in a screencast, so a 401
      // site was simply unreachable.
      case 'authAnswer':
        await session.answerAuth(
          !!msg.accept,
          String(msg.username || ''),
          String(msg.password || ''),
        );
        break;
      // ── Downloads ─────────────────────────────────────────────────────
      // Dismissing a shelf row also deletes the file: keeping bytes the user
      // believes are gone is not something a browser should do.
      case 'downloadClear':
        session.clearDownload(String(msg.token || ''));
        break;
      // ── Reconnect ─────────────────────────────────────────────────────
      // Rebuilds the screencast (and the page behind it, if that is what died)
      // WITHOUT dropping the socket. The old "restart" reused the same dead page
      // handle, which is why pressing it after an extension refreshed the tab
      // changed nothing at all; and closing/reopening the window worked only by
      // throwing away the tab list, which is what we are now keeping.
      case 'resync':
        await session.resync();
        break;
      // A silent liveness check, used by the client's stall watchdog before it
      // shows the user anything. Answers `alive` for a page that is merely
      // static (the common case — a screencast sends no frames when nothing
      // repaints) and escalates to a real recovery only when the page is gone.
      case 'ping':
        await session.ping();
        break;
      // "Forget this browser session": deletes the saved cookies so the next
      // open starts anonymous again.
      case 'forgetSession':
        await session.forgetSession();
        break;
      default:
        // unknown command: ignore
        break;
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.wss.clients.forEach((ws) => { try { ws.close(1001, 'shutdown'); } catch { /* ignore */ } });
      await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    } catch { /* ignore */ }
    await this.manager.shutdown().catch(() => {});
  }
}
