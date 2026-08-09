/**
 * browser-tabs.test.ts — multi-tab support and reload survival for the
 * interactive (simulated) browser.
 *
 * Two reported bugs are pinned here, both of which had the same root cause:
 * the session owned exactly ONE Page and ONE CDPSession for its whole life.
 *
 *   Bug 1 — a cookie-import extension refreshes the page (Chrome does this
 *           automatically after an import). The Page died, but nothing was
 *           listening for that, so the socket stayed open, the UI still said
 *           "connected", and every command silently went nowhere. The in-window
 *           restart re-ran against the same dead handle, which is why it never
 *           helped; only closing and reopening the window worked.
 *
 *   Bug 2 — opening an extension's popup navigated the ACTIVE tab, throwing away
 *           the page the extension was being opened for. Pages the site opened
 *           for itself (target=_blank, window.open, OAuth) were never adopted at
 *           all, so a login the user had just started was invisible.
 *
 * These are static/contract tests plus real unit tests for the persistence
 * layer. They deliberately do NOT launch Chromium: the seams that broke are
 * wiring seams (listener present or absent, command routed or not), and those
 * are exactly what drifts silently. Live-Chromium behaviour is covered by
 * tests/unit/picker-drive.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const liveBrowser = read('src/core/LiveBrowser.ts');
const browserTabs = read('src/core/BrowserTabs.ts');
const streamServer = read('src/core/BrowserStreamServer.ts');
const browserView = read('public/js/browser-view.js');
const i18n = read('public/js/i18n.js');
const styles = read('public/css/styles.css');

// ══════════════════════════════════════════════════════════════════════════
// The persistence layer, exercised for real.
// ══════════════════════════════════════════════════════════════════════════

describe('BrowserTabs persistence', () => {
  let dir = '';
  let mod: typeof import('../../src/core/BrowserTabs');
  let cfg: typeof import('../../src/config');

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'abtabs-'));
    cfg = await import('../../src/config');
    // The path helper reads PROFILES_DIR at CALL time, not at import time, so
    // pointing it at a temp dir here is enough — no module cache surgery.
    (cfg.config as { PROFILES_DIR: string }).PROFILES_DIR = dir;
    mod = await import('../../src/core/BrowserTabs');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips a tab list', async () => {
    const ok = await mod.saveTabs('u1', [
      { url: 'https://a.example/one', title: 'One' },
      { url: 'https://b.example/two', title: 'Two', active: true },
    ]);
    expect(ok).toBe(true);
    const back = await mod.loadTabs('u1');
    expect(back.map((t) => t.url)).toEqual([
      'https://a.example/one',
      'https://b.example/two',
    ]);
    expect(back.find((t) => t.active)?.url).toBe('https://b.example/two');
  });

  it('keeps each user\'s tabs separate', async () => {
    // The interactive browser is per-user; leaking one user's tabs into another
    // user's window would disclose where they had been.
    await mod.saveTabs('alice', [{ url: 'https://alice.example/' }]);
    await mod.saveTabs('bob', [{ url: 'https://bob.example/' }]);
    expect((await mod.loadTabs('alice')).map((t) => t.url)).toEqual(['https://alice.example/']);
    expect((await mod.loadTabs('bob')).map((t) => t.url)).toEqual(['https://bob.example/']);
  });

  it('a missing or corrupt file means "no tabs", never a throw', async () => {
    expect(await mod.loadTabs('never-saved')).toEqual([]);
    await fs.mkdir(join(dir, 'sessions'), { recursive: true });
    await fs.writeFile(mod.tabsStatePath('broken'), '{not json', 'utf8');
    expect(await mod.loadTabs('broken')).toEqual([]);
  });

  it('clearTabs is part of "forget this browser session"', async () => {
    await mod.saveTabs('u2', [{ url: 'https://x.example/' }]);
    expect((await mod.loadTabs('u2')).length).toBe(1);
    await mod.clearTabs('u2');
    expect(await mod.loadTabs('u2')).toEqual([]);
  });

  it('a userId cannot escape the sessions directory', async () => {
    // The id reaches us from an authenticated socket, but path traversal in a
    // filename is never acceptable regardless of who supplied it.
    const p = mod.tabsStatePath('../../etc/passwd');
    expect(p.includes('..')).toBe(false);
    expect(p.startsWith(join(dir, 'sessions'))).toBe(true);
  });
});

describe('BrowserTabs.sanitizeTabs', () => {
  let mod: typeof import('../../src/core/BrowserTabs');
  beforeEach(async () => { mod = await import('../../src/core/BrowserTabs'); });

  it('refuses file:// — this list is replayed unattended at session start', () => {
    // A poisoned tab list would otherwise become an automatic read of the
    // server's disk, which is the same reason `navigate` refuses the scheme.
    const out = mod.sanitizeTabs([
      { url: 'file:///etc/passwd' },
      { url: 'https://ok.example/' },
    ]);
    expect(out.map((t) => t.url)).toEqual(['https://ok.example/']);
  });

  it('refuses javascript: and data:', () => {
    const out = mod.sanitizeTabs([
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,<script>x</script>' },
    ]);
    expect(out).toEqual([]);
  });

  it('allows chrome-extension:// — an extension page is the point', () => {
    // Driving a cookie extension's popup from inside the canvas is the whole
    // reason this window can show a non-http page at all.
    const out = mod.sanitizeTabs([{ url: 'chrome-extension://abcdef/popup.html' }]);
    expect(out.length).toBe(1);
  });

  it('drops about:blank (there is nothing to restore)', () => {
    expect(mod.sanitizeTabs([{ url: 'about:blank' }])).toEqual([]);
  });

  it('caps the list at MAX_SAVED_TABS', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://e.example/${i}` }));
    expect(mod.sanitizeTabs(many).length).toBe(mod.MAX_SAVED_TABS);
  });

  it('dedupes identical URLs', () => {
    const out = mod.sanitizeTabs([
      { url: 'https://same.example/' },
      { url: 'https://same.example/' },
    ]);
    expect(out.length).toBe(1);
  });

  it('always ends with EXACTLY one active tab', () => {
    // Zero active tabs leaves the restore with no idea what to show first; two
    // would race two focus() calls onto two different pages.
    const none = mod.sanitizeTabs([{ url: 'https://a.example/' }, { url: 'https://b.example/' }]);
    expect(none.filter((t) => t.active).length).toBe(1);
    const two = mod.sanitizeTabs([
      { url: 'https://a.example/', active: true },
      { url: 'https://b.example/', active: true },
    ]);
    expect(two.filter((t) => t.active).length).toBe(1);
  });

  it('survives garbage input', () => {
    expect(mod.sanitizeTabs(null)).toEqual([]);
    expect(mod.sanitizeTabs('nope')).toEqual([]);
    expect(mod.sanitizeTabs([null, 42, 'x', {}])).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Bug 1: surviving the reload that a cookie extension triggers.
// ══════════════════════════════════════════════════════════════════════════

describe('LiveBrowser survives a page that dies under it', () => {
  it('listens for BOTH crash and close on every page', () => {
    // Their absence WAS the bug: nothing in the old session could observe a page
    // dying, so the socket stayed open and the UI kept claiming "connected".
    expect(liveBrowser).toMatch(/page\.on\('crash'/);
    expect(liveBrowser).toMatch(/page\.on\('close'/);
    // Both must lead to a recovery, not just a log line.
    const crash = liveBrowser.slice(liveBrowser.indexOf("page.on('crash'"));
    expect(crash.slice(0, 400)).toContain('this.recover(');
  });

  it('polls for a page that is dead but not `isClosed()`', () => {
    // A tab that is REPLACED (chrome.tabs.update, a location swap into a new
    // renderer) leaves a Page whose transport is dead while Playwright still
    // reports it open. No event fires for that state at all.
    expect(liveBrowser).toContain('HEALTH_POLL_MS');
    expect(liveBrowser).toMatch(/function isPageAlive/);
    expect(liveBrowser).toMatch(/private startHealthWatch\(\)/);
    // The probe must be a real round-trip, not a property read.
    const probe = liveBrowser.slice(liveBrowser.indexOf('async function isPageAlive'));
    expect(probe.slice(0, 600)).toContain('page.title()');
  });

  it('treats a merely SLOW page as alive', () => {
    // A page running a long synchronous script must not be torn down; a page
    // whose target is gone rejects immediately rather than timing out, so the
    // timeout branch only ever means "busy".
    const probe = liveBrowser.slice(liveBrowser.indexOf('async function isPageAlive'));
    expect(probe.slice(0, 700)).toContain("'__slow'");
  });

  it('rebinds a FRESH CDPSession rather than reusing the old one', () => {
    // Reusing it was the quiet half of the bug: the transport still existed, so
    // nothing threw, and every Input.dispatchMouseEvent went to a target with no
    // renderer behind it.
    expect(liveBrowser).toMatch(/private async bindCdp\(page: Page\)/);
    expect(liveBrowser).toContain('this.context.newCDPSession(page)');
    // It must also track WHICH page it is attached to, or "is this stale?" has
    // no answer.
    expect(liveBrowser).toMatch(/private cdpPage: Page \| null/);
    // Frames from a session that is no longer the current one must be dropped,
    // or a background tab paints over the tab the user is looking at.
    expect(liveBrowser).toContain('if (cdp !== this.cdp) return;');
  });

  it('serialises recovery so concurrent triggers cannot race', () => {
    // An extension that reloads the tab produces a `close` AND a failing probe
    // within the same tick; two recoveries would bind two CDP sessions to two
    // different pages.
    expect(liveBrowser).toMatch(/private recovering: Promise<boolean> \| null/);
    expect(liveBrowser).toContain('if (this.recovering) return this.recovering;');
  });

  it('self-heals on the first failing command', () => {
    // Every input command used to have its own `catch { /* ignore */ }`, so the
    // first click after the tab died was swallowed and the window stayed broken.
    expect(liveBrowser).toMatch(/private async withPage\(/);
    expect(liveBrowser).toMatch(/private async withCdp\(/);
    // Navigation now goes through a QUEUE as well as `withPage`: two navigate
    // commands close together used to make the second abort the first and report
    // `net::ERR_ABORTED` (measured, tools/probe-nav.js) — a double-clicked Go
    // button was enough. So navigate/back/forward/reload must reach the page via
    // the nav machinery, and that machinery must itself be recovery-guarded.
    for (const m of ['navigate', 'back', 'forward', 'reload']) {
      const body = liveBrowser.slice(liveBrowser.indexOf(`async ${m}(`), liveBrowser.indexOf(`async ${m}(`) + 900);
      expect(
        /this\.withPage\(/.test(body) || /this\.(queueNav|runNav)\(/.test(body),
        `${m} must route through withPage or the nav queue`,
      ).toBe(true);
    }
    // The nav runner is where the recovery guard actually lives for those four.
    const runNav = liveBrowser.slice(liveBrowser.indexOf('private async runNav('));
    expect(runNav.slice(0, 1600), 'runNav must be recovery-guarded').toContain('this.withPage(');

    for (const m of ['key', 'selectAll']) {
      const body = liveBrowser.slice(liveBrowser.indexOf(`async ${m}(`));
      // `selectAll` now routes through `key('a', {ctrl:true})`, so either the
      // direct guard or the guarded primitive it delegates to is acceptable —
      // what must never happen is an unguarded raw CDP call.
      expect(
        /this\.withCdp\(/.test(body.slice(0, 700)) || /this\.key\(/.test(body.slice(0, 700)),
        `${m} must be recovery-guarded`,
      ).toBe(true);
    }
    for (const m of ['click', 'scroll', 'type']) {
      const body = liveBrowser.slice(liveBrowser.indexOf(`async ${m}(`));
      expect(body.slice(0, 900), `${m} must route through withCdp`).toContain('this.withCdp(');
    }
  });

  it('only retries on a DEAD-TARGET error, never on an ordinary failure', () => {
    // Retrying a 404 or an empty selector would rebuild a perfectly good browser
    // because a page happened to fail.
    expect(liveBrowser).toMatch(/function isDeadTargetError/);
    const w = liveBrowser.slice(
      liveBrowser.indexOf('private async withPage('),
      liveBrowser.indexOf('private async withCdp('),
    );
    // The discrimination itself: an ordinary failure must NOT trigger recovery.
    expect(w).toContain('if (!isDeadTargetError(e))');
    expect(w).not.toMatch(/if \(!isDeadTargetError\(e\)\) return;\s*\/\/ a normal failure/);
  });

  it('an ordinary input failure is REPORTED, never silently swallowed', () => {
    // MEASURED 2026-08-03: withPage/withCdp used to `return` on any non-dead-target
    // error under a comment claiming "the caller logs it". No caller logged it.
    // Every input command funnels through these two, so a command that failed for
    // any ordinary reason failed in total silence — the user saw a click that did
    // nothing, with no evidence it had even been attempted. That is precisely the
    // invisible-state failure the mandate forbids.
    for (const guard of ['private async withPage(', 'private async withCdp(']) {
      const body = liveBrowser.slice(
        liveBrowser.indexOf(guard),
        liveBrowser.indexOf(guard) + 900,
      );
      expect(body, `${guard} must report an ordinary failure`)
        .toContain('this.inputFailed(e)');
      // The retry path must report too, not swallow with a bare catch.
      expect(body, `${guard} must not swallow the retry`)
        .not.toMatch(/catch \{ \/\* one retry is enough \*\/ \}/);
    }
    // And the reporter must actually emit something the client can render.
    const reporter = liveBrowser.slice(liveBrowser.indexOf('private inputFailed('));
    expect(reporter.slice(0, 400)).toContain("message: 'input_failed'");
  });

  it('auth interception that cannot be installed says so', () => {
    // A 401 with no interception means the site is simply unreachable and the
    // native credentials window can never be shown. It used to fail into an empty
    // `catch {}`, so the only symptom was a page that would not load.
    // Bounded by the NEXT declaration rather than a character count: a fixed
    // window is exactly the kind of brittleness that makes better-commented code
    // fail a test for no reason.
    const start = liveBrowser.indexOf('private async installAuthHandler(');
    const body = liveBrowser.slice(start, liveBrowser.indexOf('async answerAuth(', start));
    expect(body).toContain("message: 'auth_interception_unavailable'");
  });

  it('does NOT recover on mouse-move (it fires ~14x/second)', () => {
    // A hover-triggered recovery would turn one dead page into a storm of
    // context rebuilds.
    const move = liveBrowser.slice(liveBrowser.indexOf('async move('), liveBrowser.indexOf('async scroll('));
    expect(move).not.toContain('this.withCdp(');
  });

  it('exposes resync as a command, and it rebuilds the STREAM first', () => {
    // The old restart button re-ran against the same dead handle. Reconnect has
    // to be able to fix a stopped screencast on a live page WITHOUT dropping the
    // socket, because dropping it is what lost the tab list.
    expect(liveBrowser).toMatch(/async resync\(\)/);
    expect(streamServer).toContain("case 'resync':");
    expect(streamServer).toContain('session.resync()');
    const r = liveBrowser.slice(liveBrowser.indexOf('async resync()'));
    expect(r.slice(0, 800)).toContain('this.bindCdp(page)');
  });

  it('tells the client what is happening', () => {
    // The reported symptom was an unexplained error with no way out. Both halves
    // of a recovery are now events the UI can narrate.
    expect(liveBrowser).toContain("this.emit('recovering'");
    expect(liveBrowser).toContain("this.emit('recovered'");
    expect(browserView).toContain("case 'recovering':");
    expect(browserView).toContain("case 'recovered':");
  });

  it('re-arms the picker after a recovery (the script lives in the PAGE)', () => {
    // A recovered page is a NEW page with no injected script, so select mode
    // would be silently off — the crosshair would look broken.
    const rec = browserView.slice(browserView.indexOf("case 'recovered':"));
    expect(rec.slice(0, 700)).toContain('applySelectMode(');
    const focus = liveBrowser.slice(liveBrowser.indexOf('private async focus('));
    expect(focus.slice(0, 900)).toContain('this.injectPicker()');
  });

  it('the client notices frames stopping, not only the server', () => {
    // The two see different failures: the server can tell its page stopped
    // answering, the client can tell that PIXELS stopped arriving (which also
    // covers a screencast silently stopped by a new renderer process).
    expect(browserView).toContain('stallTimer');
    expect(browserView).toContain('lastFrameAt');
    expect(browserView).toMatch(/send\(\{ t: 'resync' \}\)/);
  });

  // ── A frame gap is not a fault ────────────────────────────────────────────
  // Measured against a running server: Page.startScreencast is delta-based, so
  // a static page emits ONE frame on load, a reload of it emits one more, and a
  // click that changes no pixels emits zero. A watchdog that treated silence as
  // a broken stream would therefore put a "reconnecting" banner and a pointless
  // resync on every ordinary page every 20 seconds.

  it('probes silently before it blames the browser', () => {
    const strip = browserView.slice(browserView.indexOf('Frame-stall watchdog'));
    const body = strip.slice(0, 2500);
    // Stage one is a `ping`, not a `resync`...
    expect(body).toMatch(/send\(\{ t: 'ping' \}\)/);
    // ...and it must not narrate anything: the user sees no status for an idle
    // page. The only setStatus in the watchdog belongs to stage two.
    expect((body.match(/setStatus\(/g) || []).length).toBe(1);
    const ping = body.indexOf("t: 'ping'");
    const status = body.indexOf('setStatus(');
    expect(status).toBeLessThan(ping);   // stage two is written above stage one
  });

  it('only escalates to a visible recovery when the probe goes unanswered', () => {
    const strip = browserView.slice(browserView.indexOf('Frame-stall watchdog'), browserView.indexOf('---- wiring'));
    expect(strip).toContain('pingSentAt');
    // A second gate on how long we wait for the answer, so a resync needs BOTH
    // a frame gap and an unanswered ping.
    expect(strip).toMatch(/pingSentAt < \d+/);
    expect(strip).toMatch(/send\(\{ t: 'resync' \}\)/);
  });

  it('server answers `alive` for a merely-idle page instead of recovering', () => {
    expect(liveBrowser).toMatch(/async ping\(\)/);
    expect(streamServer).toContain("case 'ping':");
    expect(streamServer).toContain('session.ping()');
    const p = liveBrowser.slice(liveBrowser.indexOf('async ping()'));
    const body = p.slice(0, 1800);
    // It asks the page, re-arms the screencast, and forces one frame so the
    // client's canvas is provably current.
    expect(body).toContain('isPageAlive(page)');
    expect(body).toContain('this.startScreencast()');
    expect(body).toContain("this.emit('alive'");
    // ...and a page that cannot answer is the real bug, so it recovers.
    expect(body).toContain("this.recover('ping')");
  });

  it('the client clears the outstanding probe on every proof of life', () => {
    // A stale pingSentAt would make the NEXT quiet period jump straight to
    // stage two and show a recovery that was never needed.
    for (const c of ['alive', 'recovering', 'recovered']) {
      expect(browserView).toContain(`case '${c}':`);
    }
    const frame = browserView.slice(browserView.indexOf("case 'frame':\n          // Every frame is proof of life"));
    expect(frame.slice(0, 500)).toContain('pingSentAt = 0');
    const alive = browserView.slice(browserView.indexOf("case 'alive':"));
    expect(alive.slice(0, 300)).toContain('pingSentAt = 0');
    // `alive` must stay silent: no status, no toast.
    expect(alive.slice(0, alive.indexOf('break;'))).not.toContain('setStatus(');
    expect(alive.slice(0, alive.indexOf('break;'))).not.toContain('toast(');
  });

  it('the forced frame is not acknowledged as a screencast frame', () => {
    // Page.screencastFrameAck with an id Chromium never issued is a protocol
    // error, and the frame from ping is a plain screenshot.
    const p = liveBrowser.slice(liveBrowser.indexOf('async ping()'));
    expect(p.slice(0, 1800)).toMatch(/sessionId: 0/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Bug 2: multiple tabs.
// ══════════════════════════════════════════════════════════════════════════

describe('LiveBrowser multi-tab support', () => {
  it('the session owns a LIST of tabs', () => {
    expect(liveBrowser).toMatch(/interface LiveTab/);
    expect(liveBrowser).toMatch(/private tabs: LiveTab\[\]/);
    expect(liveBrowser).toMatch(/export interface TabInfo/);
    expect(liveBrowser).toMatch(/tabList\(\): TabInfo\[\]/);
  });

  it('exposes newTab / selectTab / closeTab, all routed from the socket', () => {
    for (const m of ['newTab', 'selectTab', 'closeTab']) {
      expect(liveBrowser, `LiveBrowser must expose ${m}`).toMatch(new RegExp(`async ${m}\\(`));
    }
    expect(streamServer).toContain("case 'tabNew':");
    expect(streamServer).toContain("case 'tabSelect':");
    expect(streamServer).toContain("case 'tabClose':");
    expect(streamServer).toContain('session.newTab(');
    expect(streamServer).toContain('session.selectTab(');
    expect(streamServer).toContain('session.closeTab(');
  });

  it('"Open here" opens a NEW tab instead of hijacking the active one', () => {
    // THE bug: "Open here" is almost always an extension popup, and the
    // extension is being opened FOR the page in the current tab. Navigating that
    // tab to the popup threw away the very page the cookies were for.
    const handler = browserView.slice(browserView.indexOf('onNavigate: function (url)'));
    expect(handler.slice(0, 1600)).toMatch(/send\(\{ t: 'tabNew', url: url \}\)/);
  });

  it('adopts pages the PAGE opens (target=_blank, window.open, OAuth)', () => {
    // These existed in the context but nothing streamed them, so a login the
    // user had just started was invisible.
    expect(liveBrowser).toMatch(/this\.context\.on\('page'/);
    expect(liveBrowser).toMatch(/private async adopt\(/);
  });

  it('adopts pages our tabs opened, and extension pages, but not a stranger\'s', () => {
    // The real-Chrome context is SHARED between sessions, so adopting every new
    // page in it would show one user another user's tabs.
    //
    // BUT the original rule — "adopt only if the opener is one of our pages" —
    // was too strict, and that strictness WAS the reported cookie-extension bug.
    // MEASURED (tools/probe-cdp2.js): a page created by an extension via
    // `chrome.tabs.create` has `opener() === null`, so every extension popup was
    // silently dropped: the tab existed in Chrome, nothing streamed it, and the
    // user saw nothing happen when they clicked their extension.
    //
    // So there are now three admissible claims, and this test pins all three
    // rather than the one it used to.
    expect(liveBrowser).toMatch(/private owned = new Set<Page>/);
    const onPage = liveBrowser.slice(liveBrowser.indexOf("this.context.on('page'"));
    // Wide enough to span the explanation as well as the code: the reasoning for
    // why an orphan is claimable is the part most likely to be deleted by someone
    // "tidying up", and deleting it is how this bug comes back.
    const head = onPage.slice(0, 2600);
    // 1. still the primary rule: a page one of our own pages opened
    expect(head).toContain('p.opener()');
    expect(head).toContain('this.owned.has(opener)');
    // 2. an extension page, which is the case that was broken
    expect(head).toMatch(/chrome-extension/);
    // 3. a page opened while WE asked for one (time-boxed, so it cannot be a
    //    standing invitation to adopt anything at all)
    expect(head).toContain('expectOrphanUntil');
    // and the refusal must still exist for everything else
    expect(head).toMatch(/if \(!claimable\) return;/);
  });

  it('caps the tab count (a redirect loop can call window.open in a loop)', () => {
    expect(liveBrowser).toContain('MAX_SAVED_TABS');
    expect(liveBrowser).toContain("'too_many_tabs'");
    // And the client must present it as a refusal, not a browser fault.
    expect(browserView).toContain("=== 'too_many_tabs'");
  });

  it('closing the last tab leaves a blank one, never zero', () => {
    // Chrome closes the window at zero tabs; this window cannot, so a blank tab
    // is the honest equivalent. Zero tabs would mean a canvas with no source.
    //
    // The window widened from 1200 to 3000 chars because closeTab now ASKS the
    // page's beforeunload handler first ("Leave site? Changes you made may not be
    // saved") before reaching the reaping code. That prompt is a requirement, not
    // padding — the old close threw the user's unsaved work away in silence.
    const close = liveBrowser.slice(liveBrowser.indexOf('async closeTab('));
    expect(close.slice(0, 3000)).toContain("this.openTab('about:blank'");
    // And the ask itself, since it is now on this path:
    expect(close.slice(0, 3000)).toContain('runBeforeUnload: true');
  });

  it('switching tabs brings the page to the front (a hidden tab is throttled)', () => {
    // A screencast of a background tab is a still image of whatever it last
    // painted, and the page reports itself hidden to its own scripts.
    const focus = liveBrowser.slice(liveBrowser.indexOf('private async focus('));
    expect(focus.slice(0, 900)).toContain('bringToFront()');
    expect(focus.slice(0, 900)).toContain('this.bindCdp(page)');
  });

  it('a background tab\'s file dialog is not answered as if it were ours', () => {
    // Only one chooser can be outstanding, and answering the wrong page's dialog
    // would hand a user's file to a tab they were not looking at.
    const fc = liveBrowser.slice(liveBrowser.indexOf("page.on('filechooser'"));
    expect(fc.slice(0, 300)).toContain('if (page !== this.page) return;');
  });

  it('closes EVERY tab on teardown, not just the active one', () => {
    // In real-Chrome mode the context is never closed, so a leaked background
    // page would never be collected by anything.
    const close = liveBrowser.slice(liveBrowser.indexOf('async close(): Promise<void>'));
    expect(close).toContain('for (const tab of this.tabs)');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Session restore ("show me the tabs I had, from this session or an earlier one")
// ══════════════════════════════════════════════════════════════════════════

describe('tab session restore', () => {
  it('loads the saved list at start and persists it as it changes', () => {
    expect(liveBrowser).toContain('loadTabs(');
    expect(liveBrowser).toContain('saveTabs(');
    expect(liveBrowser).toMatch(/private async persistTabs\(\)/);
  });

  it('restores lazily: only the active tab loads a page immediately', () => {
    // Twelve restored tabs must not mean twelve page loads nobody asked for.
    expect(liveBrowser).toMatch(/pending: true/);
    expect(liveBrowser).toMatch(/private async materialize\(tab: LiveTab\)/);
  });

  it('a failed OR HUNG restore still yields a working browser', () => {
    // The saved page may 404, time out, start requiring a login — or, measured
    // live on 2026-08-03, open a prompt() that makes `goto` never resolve at all.
    // That last one deadlocked start(), so `ready` never fired and the window was
    // dead-but-connected on EVERY open, curable only by deleting the tab file by
    // hand. None of it may stop the window from opening, so the restore is raced
    // against a deadline rather than merely try/caught.
    const start = liveBrowser.slice(
      liveBrowser.indexOf('async start(): Promise<void>'),
      liveBrowser.indexOf('private emit(type: string'),
    );
    expect(start).toContain('Promise.race');
    expect(start).toContain('RESTORE_BUDGET_MS');
    // The tab is kept as `pending`, NOT marked dead: the user asked for that page
    // and clicking it must retry. "We never lose a tab."
    expect(start).toContain('restoreTarget.pending = true');
    expect(start).not.toContain('restoreTarget.dead = true');
    // And a blank tab is only opened when the slow restore left no live page,
    // instead of unconditionally adding one on every slow open.
    expect(start).toContain("this.openTab('about:blank'");
    expect(start).toMatch(/if \(!this\.page \|\| this\.page\.isClosed\(\)\)/);
  });

  it('a restore dialog cannot deadlock the open', () => {
    // `page.goto` does not resolve while a modal dialog is open. A saved tab that
    // alerts on load therefore held start() open forever. During restore only,
    // dialogs are dismissed; the real handler takes over afterwards.
    const mat = liveBrowser.slice(
      liveBrowser.indexOf('private async materialize(tab: LiveTab)'),
      liveBrowser.indexOf('private async persistTabs()'),
    );
    expect(mat).toContain("page.on('dialog', dismissDuringRestore)");
    expect(mat).toContain('d.dismiss()');
    // It must be removed again, or the user's own dialogs would be silently eaten.
    expect(mat).toContain("page.off('dialog', dismissDuringRestore)");
    expect(mat).toMatch(/finally\s*\{/);
  });

  it('a tab whose CDP target vanished never rejects out of the open', () => {
    // MEASURED: an unguarded `await this.bindCdp(page)` here and in openTab()
    // rejected with "no object with guid page@…", which reached index.ts as an
    // unhandledRejection and took the WHOLE SERVER down — every user's session
    // gone, cured only by the manual restart the mandate abolishes.
    const mat = liveBrowser.slice(
      liveBrowser.indexOf('private async materialize(tab: LiveTab)'),
      liveBrowser.indexOf('private async persistTabs()'),
    );
    expect(mat).toMatch(/try\s*\{\s*await this\.bindCdp\(page\);\s*\}\s*catch/);
    const open = liveBrowser.slice(
      liveBrowser.indexOf('private async openTab('),
      liveBrowser.indexOf('/** Persist the strip'),
    );
    expect(open).toContain('tab_stream_pending');
    expect(open).toMatch(/try\s*\{\s*await this\.bindCdp\(page\);\s*\}\s*catch/);
  });

  it('writes the list on the way out, including on an idle timeout', () => {
    // Otherwise "show me my tabs next time" only works when the user happens to
    // close the window by hand.
    const close = liveBrowser.slice(liveBrowser.indexOf('async close(): Promise<void>'));
    expect(close).toContain('await saveTabs(this.userId, list)');
    expect(close).toContain('clearInterval(this.healthTimer)');
  });

  it('"forget this session" forgets the tabs too', () => {
    // A sign-out that leaves a strip of logged-in-looking tabs behind is a lie,
    // and restoring those URLs next time would be a second surprise.
    const forget = liveBrowser.slice(liveBrowser.indexOf('async forgetSession()'));
    expect(forget.slice(0, 600)).toContain('clearTabs(this.userId)');
  });

  it('tells the user their tabs were restored', () => {
    // A window that silently opens four tabs looks like a bug; naming it a
    // restore makes it the feature it is.
    expect(liveBrowser).toContain('restoredTabs');
    expect(browserView).toContain('msg.restoredTabs');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Client contract: the strip, its i18n, and its CSS.
// ══════════════════════════════════════════════════════════════════════════

describe('tab strip UI contract', () => {
  it('renders the strip from the SERVER\'s list', () => {
    // The client cannot derive this list: it includes tabs restored from earlier
    // sessions and tabs the page opened for itself.
    expect(browserView).toContain("case 'tabs':");
    expect(browserView).toMatch(/function renderTabs\(/);
    expect(liveBrowser).toMatch(/private emitTabs\(\)/);
    expect(liveBrowser).toContain("this.emit('tabs'");
  });

  it('does not collide with the panel\'s existing Attributes|Candidates tablist', () => {
    // `.bvp-tabs` / `.bvp-tab` are already taken by that widget; styling one with
    // the other's rules would break both.
    expect(styles).toContain('.bvp-tabstrip');
    expect(styles).toContain('.bvp-tabitem');
    expect(browserView).toContain('bvp-tabstrip');
    expect(browserView).toContain('bvp-tabitem');
  });

  it('closing a tab does not also select it', () => {
    const kill = browserView.slice(browserView.indexOf('bvp-tabkill'));
    expect(kill.slice(0, 800)).toContain('ev.stopPropagation()');
  });

  it('the strip never steals height from the page image', () => {
    // The shell is a fixed-height flex column: anything that grows here shrinks
    // the canvas the user is actually working in.
    const strip = styles.slice(styles.indexOf('.bvp-tabstrip {'));
    expect(strip.slice(0, 300)).toContain('flex: 0 0 auto');
  });

  it('the strip is ALWAYS visible, because the + button lives in it', () => {
    // It used to hide itself while there was a single tab. That hid the + button
    // too, so there was no way to open the second tab that would have brought
    // the strip back — a browser you cannot open a tab in.
    expect(styles).not.toContain('.bvp-tabstrip.is-solo');
    expect(browserView).not.toContain("'is-solo'");
    expect(browserView).toContain('bvp-tabadd');
  });

  it('has a Restart button as well as Reconnect (they fix different things)', () => {
    // Reconnect rebuilds a dead stream/page while Chrome keeps running; Restart
    // relaunches Chrome, which is the ONLY way to load an extension that was
    // installed after launch. Only Reconnect survived the tab work, which left
    // no way to load a freshly installed extension from the browser window.
    expect(browserView).toContain('bvp-restart');
    expect(browserView).toContain("'/browser/restart'");
    expect(browserView).toContain('bvp-resync');
    // Relaunching kills the streamed page, so it must resync afterwards or the
    // canvas is left on a frame of a browser that no longer exists.
    // The window is bounded by the NEXT handler rather than by a character
    // count. It was 1400 characters, which broke the moment the handler learned
    // to render the server's healing steps — a test about resyncing failing
    // because unrelated code was added above it is measuring the wrong thing.
    const from = browserView.indexOf("q('bvp-restart').addEventListener");
    expect(from).toBeGreaterThan(-1);
    const h = browserView.slice(from, browserView.indexOf("q('bvp-tabadd')", from));
    expect(h).toMatch(/t: 'resync'|connect\(\)/);
    // A failure has to name its cause, or "Real Chrome is off" is a dead end.
    expect(h).toContain('catch');
    // And the WAIT has to be narrated. The user pressed a restart button, saw
    // nothing change, and was left "گیج و منگ" — so the panel goes up before the
    // request is sent, not after it returns.
    expect(h).toContain('showHeal(');
    expect(h.indexOf('showHeal(')).toBeLessThan(h.indexOf('/browser/restart'));
  });

  it('renders the tab strip like Chrome: favicon, spinner, audio, pin', () => {
    // Every one of these is a fact the server now reports per tab, and a fact
    // reported but not drawn is a fact the user does not have. The strip used to
    // show a bare name, so "which tab is loading?" and "which tab is making that
    // noise?" had no answer at all.
    expect(browserView).toContain('bvp-tabmark');       // favicon / spinner slot
    expect(browserView).toContain('bvp-tabfav');
    expect(browserView).toContain("BIC('loader'");      // the loading spinner
    expect(browserView).toContain('bvp-tabsound');      // the audio indicator
    // Both forms, chosen by mute state. The two are DIFFERENT facts — "the
    // advert is in this tab" and "I already silenced that one" — so a single
    // icon for both would make the mute button look like it did nothing.
    expect(browserView).toMatch(/'volume-x' : 'volume'/);
    // …and every name used here must actually be REGISTERED, or the strip draws
    // an empty box where the speaker should be. (icons.test.ts enforces this
    // across all modules; restated here because these three names are the ones
    // this change introduces.)
    const icons = read('public/js/icons.js');
    for (const name of ['loader', 'volume', 'volume-x', 'globe', 'pin']) {
      expect(icons, `icons.js must define '${name}'`)
        .toMatch(new RegExp(`(^|\\s)'?${name}'?:\\s*\\[`, 'm'));
    }
    expect(browserView).toContain('bvp-tabpin');

    // A favicon that 404s must fall back, not leave a broken-image glyph.
    expect(browserView).toMatch(/fav\.addEventListener\('error'/);

    // Chrome-like widths: tabs stretch to fill the strip and shrink as the count
    // rises, rather than scrolling out of reach.
    expect(browserView).toMatch(/--bvp-tabmax/);

    // Middle-click closes, anywhere on the chip — muscle memory, and the only
    // comfortable way to close several in a row (the X moves as the strip
    // reflows; the chip under the pointer does not).
    expect(browserView).toMatch(/ev\.button === 1/);

    // Drag to reorder, with a real destination command.
    expect(browserView).toMatch(/function beginTabDrag/);
    expect(browserView).toContain("t: 'tabMove'");
    expect(streamServer).toContain("case 'tabMove'");
  });

  it('gives each tab Chrome\'s own right-click menu', () => {
    // Close / Close others / Close to the right / Duplicate / Pin, each wired to
    // a command the server really implements — a menu of labels that do nothing
    // would be worse than no menu.
    expect(browserView).toMatch(/function openTabMenu/);
    for (const cmd of ['tabClose', 'tabCloseOthers', 'tabCloseRight', 'tabDuplicate', 'tabPin', 'tabReopen']) {
      expect(browserView, `menu must send ${cmd}`).toContain(`t: '${cmd}'`);
      expect(streamServer, `server must handle ${cmd}`).toContain(`case '${cmd}'`);
    }
    // "Close others" and "Close to the right" are DISABLED rather than hidden
    // when they would do nothing: an entry that vanishes teaches the user that
    // the menu is unpredictable, while a greyed one teaches them the rule.
    expect(browserView).toMatch(/disabled: !many/);
    expect(browserView).toMatch(/disabled: !rightOf/);
  });

  it('shows the page\'s own dialogs, and the 401, instead of locking the tab', () => {
    // alert/confirm/prompt/beforeunload are drawn by CHROME, not the page, so
    // they can never appear in a screencast — and an unanswered Playwright
    // dialog blocks the page forever. That combination is what "the tab silently
    // locks up" was.
    expect(browserView).toContain('bvp-dialog');
    expect(browserView).toMatch(/function showDialog/);
    expect(browserView).toContain("t: 'dialogAnswer'");
    expect(streamServer).toContain("case 'dialogAnswer'");
    // A prompt needs a field; an alert must NOT offer Cancel, because there is
    // nothing to decline.
    expect(browserView).toContain('bvp-dlg-input');
    expect(browserView).toMatch(/kind === 'alert'/);
    // beforeunload must ASK — and its buttons must say what they do, not "OK".
    expect(browserView).toContain('bvp.dlgLeaveOk');
    expect(browserView).toContain('bvp.dlgStay');
    // The page's text is untrusted: textContent, never innerHTML.
    expect(browserView).toMatch(/msgEl\.textContent =/);

    // The 401. It names WHO is asking, because a password prompt that does not
    // is a phishing surface rather than a convenience.
    expect(browserView).toContain('bvp-auth');
    expect(browserView).toContain("t: 'authAnswer'");
    expect(streamServer).toContain("case 'authAnswer'");
    expect(browserView).toContain('bvp.authWho');
    expect(browserView).toMatch(/type="password"/);
  });

  it('has a download shelf with a way to actually GET the file', () => {
    // The bytes land on the SERVER's disk. Without a shelf a download here is a
    // file the user never learns about and could never open, so the fetch link
    // is the feature — a shelf that only names files would be decoration.
    expect(browserView).toContain('bvp-shelf');
    expect(browserView).toMatch(/function renderShelf/);
    expect(browserView).toMatch(/\/browser\/downloads\//);
    // Same identity rule as an upload: header auth, so the key travels in
    // `x-api-key` and never in the URL — hence fetch + blob + a synthetic click.
    //
    // This used to pin the exact expression `'x-api-key': window.API.getKey()`,
    // and that brittleness hid a real regression: a later commit replaced the
    // whole transfer with a hidden iframe, which this file then reported as a
    // string mismatch rather than as "downloads are broken". The iframe could
    // never work — the app sets `frame-src 'none'` — and it failed silently.
    // The transfer is now pinned BEHAVIOURALLY in
    // tests/unit/remote-download-transfer.test.ts (measured against a real
    // Chromium); what stays here is the shape that must not come back.
    expect(browserView).toMatch(/headers\['x-api-key'\]/);
    expect(browserView).toMatch(/URL\.createObjectURL/);
    // The regression itself: a frame can never carry this download.
    expect(browserView).not.toMatch(/iframe\.src\s*=/);
    // Name, size and progress, and an honest indeterminate bar when the server
    // sent no Content-Length (a bar stuck at 0% reads as broken).
    expect(browserView).toMatch(/function humanBytes/);
    expect(browserView).toContain('bvp-dl-bar');
    expect(browserView).toContain('is-indet');
    // Three events for one file must update ONE row, not stack three.
    expect(browserView).toMatch(/function upsertDownload/);
    // Hide keeps the files; Clear deletes them. A cookie export is credentials,
    // so "clear" really removing the bytes is the right default — and "hide"
    // silently deleting them would be a surprise with no undo.
    expect(browserView).toContain("t: 'downloadClear'");
    expect(streamServer).toContain("case 'downloadClear'");
    expect(browserView).toMatch(/shelfHidden = true/);
  });

  it('greys out an arrow that would do nothing', () => {
    // There is no CDP "canGoBack", so the server derives it from the real
    // history. Before this the arrows were always enabled and Back on the first
    // page of a tab silently did nothing — which is the reported bug, exactly.
    expect(browserView).toMatch(/case 'navState':/);
    expect(browserView).toMatch(/function applyNavState/);
    expect(browserView).toMatch(/b\.disabled = !pickState\.canBack/);
    expect(browserView).toMatch(/f\.disabled = !pickState\.canFwd/);
    // Pressing it anyway must EXPLAIN, not no-op: "there is nothing behind this
    // page" is a different message from "this button is broken".
    expect(browserView).toMatch(/case 'navBlocked':/);
    expect(browserView).toContain('bvp.navBlockedBack');
    expect(browserView).toContain('bvp.navBlockedForward');
    // And with no socket the buttons say so rather than sending into the void.
    expect(browserView).toMatch(/function navCmd/);
  });

  it('every new bvp.* key exists in BOTH dictionaries', () => {
    // The same guard element-picker.test.ts applies, restated for the keys this
    // change adds — a missing fa key ships an English string into an RTL UI.
    const fa = i18n.slice(i18n.indexOf('\n    fa: {'), i18n.indexOf('\n    en: {'));
    const en = i18n.slice(i18n.indexOf('\n    en: {'));
    const keys = [
      'bvp.tabs', 'bvp.newTab', 'bvp.closeTab', 'bvp.blankTab',
      'bvp.tabPending', 'bvp.tabsFull', 'bvp.tabRestored',
      'bvp.reconnect', 'bvp.recovering', 'bvp.recovered', 'bvp.tabCrashed',
    ];
    for (const k of keys) {
      expect(fa, `fa is missing ${k}`).toContain(`'${k}':`);
      expect(en, `en is missing ${k}`).toContain(`'${k}':`);
    }
  });

  it('every command the strip sends has a server case', () => {
    // Same seam element-picker.test.ts pins; restated because these four are new
    // and a client-only command is a silently dead button.
    for (const c of ['tabNew', 'tabSelect', 'tabClose', 'resync']) {
      expect(browserView, `client must send ${c}`).toContain(`t: '${c}'`);
      expect(streamServer, `server must handle ${c}`).toContain(`case '${c}':`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// normalizeTarget — one allowlist for every way a URL can reach the browser.
// ══════════════════════════════════════════════════════════════════════════

describe('navigation target allowlist', () => {
  it('is a single shared helper, used by navigate AND openTab', () => {
    // Two copies of this rule would eventually disagree, and the disagreement
    // would be a scheme one path accepts and the other does not.
    expect(liveBrowser).toMatch(/function normalizeTarget\(url: string\): string/);
    const nav = liveBrowser.slice(liveBrowser.indexOf('async navigate(url: string)'));
    expect(nav.slice(0, 400)).toContain('normalizeTarget(url)');
    // Bounded by the NEXT declaration, not by a character count. A fixed 1600-char
    // window used to live here and it broke the moment openTab() grew the guard
    // that stops a lost CDP target killing the server — a test failing because
    // the code got better is a test measuring the wrong thing.
    const open = liveBrowser.slice(
      liveBrowser.indexOf('private async openTab('),
      liveBrowser.indexOf('/** Persist the strip'),
    );
    expect(open).toContain('normalizeTarget(url)');
  });

  it('refuses file:// and any other unknown scheme', () => {
    // Navigate commands arrive over a WebSocket; reading the server's filesystem
    // would turn the picker into an exfiltration tool.
    const fn = liveBrowser.slice(
      liveBrowser.indexOf('function normalizeTarget'),
      liveBrowser.indexOf('async function isPageAlive'),
    );
    expect(fn).toMatch(/\^\[a-z\]\[a-z0-9\+\.-\]\*:/i);   // bare-scheme rejection
    expect(fn).toContain('chrome-extension');
    expect(fn).not.toMatch(/file:\/\/'/);
  });
});
