/**
 * tools/probe-ui-controls.js — LIVE proof that the picker's TOOLBAR BUTTONS work
 * when a real mouse clicks them in a real browser.
 *
 * WHY THIS EXISTS (browser-parity audit §4.3b / §4.4b)
 * ────────────────────────────────────────────────────────────────────────────
 * The user reported Back / Forward / Reload and the `+` (new tab) button as not
 * working. An audit found the wiring correct, and yet every instrument in the
 * repo said "green":
 *
 *   • tools/probe-live-parity.js drives the WebSocket PROTOCOL. It proves the
 *     server obeys `back` / `forward` / `reload` / `tabNew`. It never touches a
 *     button.
 *   • the vitest suite reads SOURCE TEXT. It proves the listeners are written.
 *     It cannot run them.
 *
 * So a mis-wired listener, a CSS `pointer-events`, an overlay stealing the
 * click, or a `q()` that returned null would all leave both instruments happy
 * while the button did nothing under the user's mouse. This probe is the
 * missing layer: real clicks, on real DOM controls, in a real Chromium, asserted
 * on OBSERVABLE OUTCOMES — never on an element merely existing.
 *
 * Three independent witnesses are used, and none of them is "the client says so":
 *   1. the FIXTURE PAGE reports its own identity (`where`) and a fresh `nonce`
 *      on every execution, over HTTP, to a server the page cannot lie to;
 *   2. the SERVER's own frames (`navigated`, `navState`, `tabs`) are tapped
 *      passively off the page's WebSocket;
 *   3. the DOM state of the toolbar (`disabled`, `is-dim`, `is-busy`) is read
 *      and compared against 1 and 2 — a Back button that is enabled on the
 *      first page of a tab is a lie even if pressing it happens to be harmless.
 *
 * Usage:
 *   bash scripts/dev-server.sh              # the server must be up
 *   fuser -k 3111/tcp 2>/dev/null           # free the fixture port
 *   node tools/probe-ui-controls.js         # exit code == number of failures
 *
 * Env:
 *   UI_BASE   default http://127.0.0.1:3000
 *   API_KEY   default devtoken123
 *   UI_OUT    default .ui-shots            (screenshots land here)
 *   HEADFUL=1 run with a visible window (needs DISPLAY)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fixture = require('./fixture-server');

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const KEY = process.env.API_KEY || 'devtoken123';
const OUT = process.env.UI_OUT || path.join(__dirname, '..', '.ui-shots');

const results = [];
/** Stream every result as it is known: a hang must name the check it hung on. */
function record(pass, name, detail) {
  results.push({ pass, name, detail: detail || '' });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
}
function check(name, cond, detail) { record(!!cond, name, detail); }
function bad(name, detail) { record(false, name, detail); }
function group(label) { process.stdout.write('\n--- ' + label + ' ---\n'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` returns something truthy, or give up. Returns the value or null. */
async function until(fn, timeoutMs = 15000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

(async () => {
  const fx = await fixture.start(3111);
  console.log('fixture origin: ' + fx.base);
  const page4 = (p) => fx.base + p;

  const browser = await chromium.launch({ headless: !process.env.HEADFUL });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push('PAGEERROR ' + e.message));

  // ── The WebSocket tap ─────────────────────────────────────────────────────
  // Passive by default: every frame the SERVER sends is recorded, and nothing is
  // altered. `__bvDropNav` turns it into a nav-command black hole, which is the
  // only way to reproduce "the navigation was dropped and no navStart/navEnd
  // ever arrives" — the case that decides whether the spinner can spin forever.
  await page.addInitScript((k) => {
    localStorage.setItem('ab_api_key', k);
    localStorage.setItem('ab_user_id', '0');
    localStorage.removeItem('ab_flow_graph');
    localStorage.removeItem('abPickerUrl');

    window.__bvEvents = [];
    window.__bvSent = [];
    window.__bvDropped = [];
    window.__bvDropNav = false;
    const Real = window.WebSocket;
    class Tapped extends Real {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (ev) => {
          try {
            const m = JSON.parse(ev.data);
            // Frames are ~50KB of base64 each and arrive 15x/sec; keeping them
            // would OOM the tap and prove nothing.
            if (m && m.t && m.t !== 'frame') window.__bvEvents.push(m);
            if (window.__bvEvents.length > 400) window.__bvEvents.splice(0, 200);
          } catch (e) { /* not JSON: ignore */ }
        });
      }
      send(data) {
        try {
          const m = JSON.parse(data);
          window.__bvSent.push(m.t);
          if (window.__bvDropNav && (m.t === 'back' || m.t === 'forward' || m.t === 'reload')) {
            window.__bvDropped.push(m.t);
            return undefined;             // swallowed: the server never hears it
          }
        } catch (e) { /* binary or non-JSON: pass through */ }
        return super.send(data);
      }
    }
    window.WebSocket = Tapped;
  }, KEY);

  /** Server frames of a type, newest last. */
  const ev = (t) => page.evaluate((tt) => window.__bvEvents.filter((e) => e.t === tt), t);
  const lastEv = async (t) => { const a = await ev(t); return a[a.length - 1] || null; };
  const evCount = async (t) => (await ev(t)).length;
  const clearEv = () => page.evaluate(() => { window.__bvEvents.length = 0; });

  /** The toolbar as the DOM actually has it — not as the source says it should be. */
  const toolbar = () => page.evaluate(() => {
    const g = (id) => document.querySelector('#' + id);
    const st = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        disabled: !!el.disabled,
        dim: el.classList.contains('is-dim'),
        busy: el.classList.contains('is-busy'),
        pointerEvents: cs.pointerEvents,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        // What is actually on top at the button's centre? An overlay stealing
        // the click is invisible to every other kind of test.
        topmost: (() => {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit) return 'none';
          // The hit may be the inline <svg> inside the button, which is correct
          // and must not read as "something is covering it".
          const btn = hit.closest ? hit.closest('button') : null;
          return (btn && btn.id) || hit.id || hit.className || hit.tagName;
        })(),
      };
    };
    return {
      back: st(g('bvp-back')),
      fwd: st(g('bvp-fwd')),
      reload: st(g('bvp-reload')),
      tabadd: st(g('bvp-tabadd')),
      url: (g('bvp-url') || {}).value || '',
      status: (g('bvp-status') || {}).textContent || '',
      tabs: document.querySelectorAll('.bvp-tabitem').length,
    };
  });

  const shot = async (name) => {
    try {
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, 'ui-controls-' + name + '.png') });
    } catch (e) { /* a missing screenshot must never fail a measurement */ }
  };

  /**
   * Drive the URL bar exactly like a user: type, press Go, wait for the SERVER
   * to say it landed. Used to set up state — the checks are about the buttons.
   */
  async function goTo(p) {
    const before = await evCount('navigated');
    await page.fill('#bvp-url', page4(p));
    await page.click('#bvp-go');
    await until(async () => (await evCount('navigated')) > before, 30000);
    await until(async () => {
      const n = await lastEv('navigated');
      return n && String(n.url || '').includes(p);
    }, 20000);
    // navEnd lands in the server's `finally`, a moment after `navigated`.
    // Waiting for it means the next check starts from a settled toolbar rather
    // than from the tail of this navigation.
    await sleep(500);
  }

  try {
    // ── Open the picker the way a user does: editor → node → crosshair ──────
    group('opening the picker through the real UI');
    await page.goto(BASE + '/index.html#/editor', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      window.FlowEditor.loadSteps([{ action: 'click', params: { selector: '#login' } }]);
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const st = window.FlowEditor.getState();
      const id = Object.keys(st.nodes).find((k) => st.nodes[k].action === 'click');
      window.FlowEditor.openNdv(id);
    });
    await page.waitForTimeout(700);
    const crosshair = await page.$('.aria-iconbtn.is-picker');
    check('the NDV exposes the crosshair button', !!crosshair);
    if (!crosshair) throw new Error('no crosshair: cannot reach the picker through the UI');
    await crosshair.click();
    await page.waitForTimeout(500);
    check('clicking the crosshair opens the picker window',
      !!(await page.$('.bvp-backdrop')));

    // Every toolbar button must be REACHABLE by a mouse before any behaviour
    // question is meaningful. This is the failure mode no protocol probe can see.
    const t0 = await toolbar();
    for (const id of ['back', 'fwd', 'reload', 'tabadd']) {
      const s = t0[id];
      check(`#bvp-${id} is present, visible and accepts pointer events`,
        !!s && s.visible && s.pointerEvents !== 'none',
        s ? `visible=${s.visible} pointer-events=${s.pointerEvents}` : 'MISSING FROM THE DOM');
      check(`#bvp-${id} is the topmost element at its own centre (nothing steals the click)`,
        !!s && /bvp-(back|fwd|reload|tabadd)|icon-btn/.test(String(s.topmost)),
        s ? 'topmost=' + s.topmost : '');
    }

    group('navigation: the buttons change the PAGE, proved by the page itself');
    fx.reset();
    await clearEv();
    await goTo('/p1');
    let where = await until(() => (fx.report('where') === 'p1' ? 'p1' : ''), 20000);
    check('the URL bar + Go reach a page (probe setup works at all)', where === 'p1',
      'page reported where=' + (fx.report('where') || 'nothing'));

    await goTo('/p2');
    where = await until(() => (fx.report('where') === 'p2' ? 'p2' : ''), 20000);
    check('a second navigation lands (history now has two entries)', where === 'p2',
      'where=' + (fx.report('where') || 'nothing'));

    // Back must now be OFFERED. An arrow that is dim while history exists is
    // the reported symptom just as much as one that does nothing.
    let tb = await until(async () => { const s = await toolbar(); return s.back && !s.back.disabled ? s : null; }, 10000);
    check('Back becomes enabled once there is history behind the page',
      !!tb, tb ? '' : 'still disabled after two navigations');

    // ── the click that matters ──────────────────────────────────────────────
    fx.reset();
    await clearEv();
    await page.click('#bvp-back');
    where = await until(() => (fx.report('where') === 'p1' ? 'p1' : ''), 25000);
    check('clicking Back really goes back (the PAGE says it is p1 again)',
      where === 'p1', 'where=' + (fx.report('where') || 'nothing'));
    // WAIT for the frame, do not read the tap once.
    //
    // MEASURED: reading it immediately after the page's beacon arrived failed
    // intermittently with "no navigated frame". That was the PROBE racing, not
    // the product: the two witnesses travel by different routes — the beacon is
    // a fetch() from the page straight to the fixture, while `navigated` goes
    // page → server → our WebSocket → the tap. Either can land first. A probe
    // that reports a product failure because its own second witness had not
    // arrived yet is worse than no probe at all, because it teaches the reader
    // to distrust real failures too.
    const navBack = await until(async () => {
      const n = await lastEv('navigated');
      return n && String(n.url || '').includes('/p1') ? n : null;
    }, 15000);
    check('the server confirms the Back landed on the previous URL',
      !!navBack, navBack ? navBack.url : 'no navigated frame naming /p1 after the click');

    let st = await until(async () => { const s = await toolbar(); return s.fwd && !s.fwd.disabled ? s : null; }, 10000);
    check('Forward becomes enabled after going back', !!st,
      st ? '' : 'Forward stayed disabled, so the way back is a one-way trip');

    fx.reset();
    await clearEv();
    await page.click('#bvp-fwd');
    where = await until(() => (fx.report('where') === 'p2' ? 'p2' : ''), 25000);
    check('clicking Forward really goes forward (the PAGE says p2)',
      where === 'p2', 'where=' + (fx.report('where') || 'nothing'));

    group('reload: the only proof is the page running again');
    fx.reset();
    await clearEv();
    await goTo('/nonce');
    const n1 = await until(() => fx.report('nonce') || '', 20000);
    check('the nonce page reports a value at all', !!n1, 'nonce=' + n1);
    await page.click('#bvp-reload');
    const n2 = await until(() => {
      const v = fx.report('nonce') || '';
      return v && v !== n1 ? v : '';
    }, 30000);
    check('clicking Reload re-executes the page (a NEW nonce arrived)',
      !!n2 && n2 !== n1, `before=${n1} after=${n2 || 'unchanged'}`);

    group('the spinner must not be able to spin forever');
    // Normal path: the busy state clears on its own once the server answers.
    const cleared = await until(async () => { const s = await toolbar(); return s.reload && !s.reload.busy; }, 40000);
    check('after a real reload the busy state clears', !!cleared,
      cleared ? '' : 'is-busy still set 40s after the navigation finished');

    // The dropped-navigation case. The press sets `navBusy` optimistically, so
    // if the command never reaches the server NOTHING clears it unless the client
    // heals itself. Per the repo's no-restart mandate the UI must correct itself
    // rather than sit there lying about being busy.
    await page.evaluate(() => { window.__bvDropNav = true; });
    await page.click('#bvp-reload');
    const wentBusy = await until(async () => { const s = await toolbar(); return s.reload && s.reload.busy; }, 4000);
    check('a press shows the busy state immediately (the click is acknowledged)',
      !!wentBusy, wentBusy ? '' : 'no is-busy after pressing Reload');
    const dropped = await page.evaluate(() => window.__bvDropped.length);
    check('the probe really did swallow the nav command (this test is honest)',
      dropped > 0, 'dropped=' + dropped);
    // The 'press' lease is 6s (setNavBusy). 15s is a generous ceiling: long
    // enough that a loaded sandbox cannot fail it, short enough that a lease
    // which silently grew to half a minute would still be caught.
    const healed = await until(async () => { const s = await toolbar(); return s.reload && !s.reload.busy; }, 15000);
    check('a DROPPED navigation still un-sticks the spinner by itself',
      !!healed, healed ? '' : 'is-busy never cleared: the toolbar looks hung while being live');
    await page.evaluate(() => { window.__bvDropNav = false; });

    group('the + button opens exactly one tab, and it is a fresh one');
    await clearEv();
    const beforeTabs = (await toolbar()).tabs;
    await page.click('#bvp-tabadd');
    const grew = await until(async () => {
      const s = await toolbar();
      return s.tabs === beforeTabs + 1 ? s : null;
    }, 20000);
    check('clicking + adds exactly one tab to the strip', !!grew,
      grew ? `${beforeTabs} → ${grew.tabs}` : `stayed at ${(await toolbar()).tabs}`);
    const tabsEv = await lastEv('tabs');
    check('the server is the one reporting the new tab (not a client-side fake)',
      !!tabsEv && Array.isArray(tabsEv.tabs) && tabsEv.tabs.length === beforeTabs + 1,
      tabsEv ? tabsEv.tabs.length + ' tab(s) in the server frame' : 'no tabs frame');
    const active = tabsEv && tabsEv.tabs.find((x) => x.active);
    check('the new tab is the active one, like Ctrl+T in Chrome',
      !!active && (!active.url || active.url === 'about:blank'),
      active ? 'active url=' + JSON.stringify(active.url) : 'no active tab');

    // A fresh tab has NO history, so Back must be dim. This is the other half of
    // the original report: an arrow that is enabled when it cannot do anything
    // reads as broken the first time it is pressed.
    const fresh = await until(async () => {
      const s = await toolbar();
      return s.back && s.back.disabled ? s : null;
    }, 15000);
    check('Back is disabled on a brand-new tab (no history to go back to)',
      !!fresh, fresh ? '' : 'Back was still enabled on a fresh tab');
    const ns = await lastEv('navState');
    check('the disabled state matches the SERVER\'s canGoBack, not a guess',
      !!ns && ns.canGoBack === false, ns ? 'canGoBack=' + ns.canGoBack : 'no navState frame');

    await shot('toolbar');

    group('cleanup: leave the session as we found it');
    // A probe that leaves tabs behind poisons the next probe's measurements —
    // that lesson is already recorded in probe-live-parity.js (`soloTab`).
    const kill = await page.$('.bvp-tabitem.is-on .bvp-tabkill');
    if (kill) {
      await kill.click();
      await until(async () => (await toolbar()).tabs === beforeTabs, 15000);
    }
    check('the extra tab is closed again', (await toolbar()).tabs === beforeTabs,
      'tabs=' + (await toolbar()).tabs);

    check('no page errors while driving the toolbar', pageErrors.length === 0,
      pageErrors.length ? JSON.stringify(pageErrors.slice(0, 5)) : 'none');
  } catch (e) {
    bad('probe crashed', (e && e.message) || String(e));
    await shot('crash');
  }

  await browser.close().catch(() => {});
  await fx.close().catch(() => {});

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
  if (fails.length) {
    console.log('\nFAILED:');
    fails.forEach((f) => console.log('  • ' + f.name + (f.detail ? '  — ' + f.detail : '')));
  }
  process.exit(fails.length);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
