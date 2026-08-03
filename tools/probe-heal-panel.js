/**
 * tools/probe-heal-panel.js — LIVE proof for §1: the picker got STUCK on
 * "Getting the browser ready / Starting Chrome / about 6 seconds".
 *
 * What the user reported (docs/HANDOFF-SIX-REGRESSIONS.md §1)
 * ──────────────────────────────────────────────────────────
 *   «باید حداقل نیاز به زمان داره اطلاع بده یا خلاصه اگر نیازه ترمیم بشه ترمیم
 *   بشه خلاصه کاربر نباید گیر کنه»
 *   — at minimum tell me how long it needs; if it needs healing, heal it; the
 *   bottom line is THE USER MUST NEVER GET STUCK.
 *
 * Why a click-level probe and not a protocol one
 * ─────────────────────────────────────────────
 * The panel is pure client state. `showHeal()` is opened optimistically before
 * the request is even sent, and only an explicit later event took it down, so
 * the bug only exists when that later event never comes. No protocol probe can
 * see it and no source-reading test can run it — the same blind spot that let
 * four toolbar bugs live behind provably-correct wiring (§4.3b). So this drives
 * a real mouse in a real Chromium and BLACKHOLES the restart POST, which is the
 * faithful reproduction of "the socket dropped mid-flight / the server died
 * while relaunching / the modal was closed and reopened mid-relaunch".
 *
 * Blackholing is done with Playwright's own request interception rather than by
 * patching fetch: it drops the request at the network layer, exactly as a dead
 * link does, so nothing in the page can tell the difference. That matters —
 * a fake that the code could detect would prove nothing.
 *
 * Usage:
 *   bash scripts/dev-server.sh
 *   fuser -k 3111/tcp 2>/dev/null
 *   node tools/probe-heal-panel.js          # exit code == number of failures
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
function record(pass, name, detail) {
  results.push({ pass, name, detail: detail || '' });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
}
function check(name, cond, detail) { record(!!cond, name, detail); }
function group(label) { process.stdout.write('\n--- ' + label + ' ---\n'); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const browser = await chromium.launch({
    headless: !process.env.HEADFUL,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  /** Errors this probe caused on purpose, reported separately and asserted on. */
  const selfInflicted = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Do not blame the app for the instrument's own wound. This probe reproduces
    // the bug by HOLDING the restart POST open and then aborting it during
    // teardown, and an aborted fetch is reported by the browser as
    // `net::ERR_FAILED`. Counting that as an app error would make the probe fail
    // for doing exactly what it was written to do — and, worse, would train the
    // next reader to ignore this check. Anything else still counts.
    if (/Failed to load resource: net::ERR_FAILED/.test(text)) {
      selfInflicted.push(text);
      return;
    }
    pageErrors.push('console: ' + text);
  });

  await page.addInitScript((k) => {
    localStorage.setItem('ab_api_key', k);
    localStorage.setItem('ab_user_id', '0');
    localStorage.removeItem('ab_flow_graph');
    localStorage.removeItem('abPickerUrl');
    // Record the toasts. "The panel came down" is only half the requirement —
    // the user must also be TOLD what to do next, and a toast is where this app
    // says that. Wrapping the DOM rather than the function keeps it honest.
    window.__toasts = [];
    const obs = new MutationObserver((muts) => {
      for (const mu of muts) {
        for (const n of mu.addedNodes) {
          if (n && n.nodeType === 1 && String(n.className || '').includes('toast')) {
            window.__toasts.push(String(n.textContent || ''));
          }
        }
      }
    });
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }, KEY);

  /**
   * Swallow the restart POST at the network layer.
   *
   * `route.abort()` would surface as a fetch rejection, i.e. the `.catch` path,
   * which the old code DID handle. The dangerous case — and the reported one —
   * is a request that never settles at all, so the promise neither resolves nor
   * rejects and no handler ever runs. That is what a dropped socket looks like,
   * and it is reproduced by simply never answering the route.
   */
  let blackhole = false;
  const held = [];
  await page.route('**/browser/restart', async (route) => {
    if (!blackhole) return route.continue();
    held.push(route);            // held forever: never continue, never abort
  });

  /** The heal panel exactly as the DOM has it. */
  const healState = () => page.evaluate(() => {
    const box = document.querySelector('#bvp-heal');
    if (!box) return null;
    const cs = getComputedStyle(box);
    const steps = Array.from(document.querySelectorAll('.bvp-heal-step')).map((li) => ({
      cls: li.className,
      text: String(li.textContent || '').trim(),
    }));
    const closeBtn = document.querySelector('#bvp-heal-close');
    return {
      off: box.classList.contains('is-off'),
      visible: cs.display !== 'none' && cs.visibility !== 'hidden',
      steps,
      text: String(box.textContent || '').trim(),
      hasClose: !!closeBtn,
      closeVisible: !!closeBtn && getComputedStyle(closeBtn).display !== 'none',
    };
  });

  const toasts = () => page.evaluate(() => (window.__toasts || []).slice());
  const shot = async (name) => {
    try {
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, 'heal-' + name + '.png') });
    } catch (e) { /* a screenshot must never fail a measurement */ }
  };

  try {
    // ── Open the picker the way a user does ─────────────────────────────────
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
    await page.waitForTimeout(600);
    check('clicking the crosshair opens the picker window', !!(await page.$('.bvp-backdrop')));

    const h0 = await healState();
    check('the heal panel starts hidden', !!h0 && h0.off, h0 ? 'off=' + h0.off : 'MISSING');

    // ── The reported control: the power button ──────────────────────────────
    group('the button the user pressed is reachable and says what it does');
    const restartBtn = await page.$('#bvp-restart');
    check('#bvp-restart exists and is clickable', !!restartBtn && await restartBtn.isEnabled());
    const label = await page.evaluate(() => {
      const b = document.querySelector('#bvp-restart');
      return b ? { title: b.title || '', aria: b.getAttribute('aria-label') || '' } : null;
    });
    // The user pressed "off" and got "Starting Chrome". A control whose glyph
    // reads as power-off MUST say restart in words, or the surprise is the UI's
    // fault, not the user's.
    check('the power button names itself as a RESTART, not an off switch',
      !!label && /restart|راه‌اندازی دوباره|راه اندازی دوباره/i.test(label.title + ' ' + label.aria),
      label ? JSON.stringify(label) : 'no label');

    // ── THE BUG: a restart whose answer never comes ────────────────────────
    group('a restart that never answers must NOT strand the user');
    blackhole = true;
    await page.evaluate(() => { window.__toasts.length = 0; });
    const pressedAt = Date.now();
    await page.click('#bvp-restart');
    await page.waitForTimeout(700);

    const opened = await healState();
    check('the panel appears immediately (the press is acknowledged)',
      !!opened && !opened.off,
      opened ? 'steps=' + opened.steps.length + ' text=' + opened.text.slice(0, 60) : 'MISSING');
    await shot('01-opened');

    // The user must be able to get out from under it even while it is running.
    // Before the fix there was no close affordance at all: role="status" over
    // the canvas with no way to dismiss it.
    check('the panel offers a way out while it is still running',
      !!opened && opened.hasClose && opened.closeVisible,
      opened ? 'hasClose=' + opened.hasClose : '');

    // The heart of it: with nothing ever coming back, does it clear ITSELF?
    const cleared = await until(async () => {
      const h = await healState();
      return h && h.off ? h : null;
    // The lease is 20s in the 'press' phase (see setHealLease: reconciled with
    // SelfHeal's own ~12.5s worst case, not invented). 40s of headroom proves it
    // fires without making the probe hostage to one slow box.
    }, 40000, 250);
    const clearedAfter = Date.now() - pressedAt;
    check('the panel takes itself down when no answer ever arrives',
      !!cleared, cleared ? `cleared after ${clearedAfter}ms` : 'STILL SHOWING after 40s');
    await shot('02-after-lease');

    // …and says something actionable. A panel that silently vanishes teaches
    // the user that the button does nothing, which is the other half of the bug.
    const said = await toasts();
    check('the user is told what happened and what to do next',
      said.some((s) => /reconnect|دوباره|اتصال|پاسخ/i.test(s)),
      said.length ? JSON.stringify(said).slice(0, 200) : 'NO TOAST AT ALL');

    // A stuck panel must not have poisoned the rest of the window.
    const canStillType = await page.evaluate(() => {
      const u = document.querySelector('#bvp-url');
      if (!u) return false;
      const cs = getComputedStyle(u);
      return !u.disabled && cs.pointerEvents !== 'none';
    });
    check('the window is still usable afterwards (not left disabled)', canStillType);

    // The restart button must be usable again, or the user is stuck in the
    // other direction: a control that took itself away on the first failure.
    const btnBack = await until(async () => page.evaluate(() => {
      const b = document.querySelector('#bvp-restart');
      return b && !b.disabled;
    }), 20000, 250);
    check('the restart button is pressable again after a lost attempt', !!btnBack);

    // ── The dismiss control has to actually dismiss ─────────────────────────
    group('the user can dismiss the panel by hand');
    await page.evaluate(() => { window.__toasts.length = 0; });
    await page.click('#bvp-restart');
    await page.waitForTimeout(600);
    let h = await healState();
    check('the panel is up again for the dismiss test', !!h && !h.off);
    if (h && h.hasClose) {
      await page.click('#bvp-heal-close');
      await page.waitForTimeout(400);
      h = await healState();
      check('clicking the close control hides the panel at once', !!h && h.off,
        h ? 'off=' + h.off : '');
      // Dismissing is a VIEW action: it must not close the picker or kill the
      // socket. Turning a convenience into data loss would be a worse bug than
      // the one being fixed.
      check('dismissing the panel does not close the picker',
        !!(await page.$('.bvp-backdrop')));
      const sockAlive = await page.evaluate(() => {
        const s = document.querySelector('#bvp-status');
        return s ? String(s.textContent || '') : '';
      });
      check('dismissing the panel leaves the session alone',
        !/error|خطا/i.test(sockAlive), 'status=' + sockAlive);
    } else {
      check('clicking the close control hides the panel at once', false, 'no close control');
      check('dismissing the panel does not close the picker', false, 'no close control');
      check('dismissing the panel leaves the session alone', false, 'no close control');
    }

    // ── A REAL restart still reports the truth ──────────────────────────────
    group('a real restart still works, with an HONEST duration');
    blackhole = false;
    for (const r of held.splice(0)) { try { await r.abort(); } catch (e) {} }
    await page.evaluate(() => { window.__toasts.length = 0; });
    const realStart = Date.now();
    await page.click('#bvp-restart');
    // MEASURED 2026-08-03: a real relaunch on this box takes ~0.5–1.3s, while
    // the panel used to hard-code "about 6 seconds". A wrong ETA is worse than
    // none: at t=20s a panel claiming 6s has taught the user the app is broken.
    const done = await until(async () => {
      const hh = await healState();
      return hh && hh.off ? hh : null;
    }, 60000, 250);
    const realMs = Date.now() - realStart;
    check('a real restart finishes and the panel comes down by itself', !!done,
      `took ${realMs}ms`);
    const okToasts = await toasts();
    check('a successful restart says so', okToasts.some((s) => /restart|راه‌اندازی|کروم|Chrome/i.test(s)),
      JSON.stringify(okToasts).slice(0, 200));
    await shot('03-real-restart');

    // The ETA shown must not be a number the code invented. Either the server's
    // own measured figure or nothing at all.
    const etaHardcoded = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'js', 'browser-view.js'), 'utf8',
    ).includes('etaMs: 6000');
    check('the client no longer hard-codes a 6-second ETA', !etaHardcoded,
      etaHardcoded ? "found `etaMs: 6000` in browser-view.js" : 'gone');

    // ── The glyph, not just the tooltip ─────────────────────────────────────
    // The user said they pressed the OFF button. The tooltip always said
    // "Restart Chrome", so the misleading part was the DRAWING: `icons.js`
    // aliases both `close` and `close-browser` to `power`, so in this product a
    // power symbol already means "shut it down". Asserted on the rendered SVG
    // because that is what the user actually looked at.
    group('the restart button no longer draws itself as an off switch');
    const glyph = await page.evaluate(() => {
      const b = document.querySelector('#bvp-restart');
      if (!b) return null;
      const svg = b.querySelector('svg');
      const paths = [...b.querySelectorAll('path')].map((p) => p.getAttribute('d') || '');
      return { has: !!svg, paths: paths.join(' ') };
    });
    // The power glyph is the vertical stroke plus the broken ring:
    // 'M12 3v9' + 'M18.4 6.6a9 9 0 1 1-12.8 0'. Neither may be there.
    const looksLikePower = !!glyph && /M12 3v9/.test(glyph.paths)
      && /18\.4 6\.6/.test(glyph.paths);
    check('the restart button is not drawn with the power/off symbol',
      !!glyph && glyph.has && !looksLikePower,
      glyph ? 'paths=' + glyph.paths.slice(0, 80) : 'NO BUTTON');

    // ── Resume: the second window must learn the truth ──────────────────────
    // The reported sequence was: panel stuck -> closed the window -> reopened it
    // -> "could not connect, apparently stuck the same way". It was not stuck; it
    // had no way to know a heal was running. The server now publishes the live
    // heal on /browser/status, and a freshly opened window adopts it.
    group('a reopened window resumes the truth instead of guessing');
    const idle = await page.evaluate(async () => {
      const r = await window.API.get('/browser/status');
      return { hasField: Object.prototype.hasOwnProperty.call(r, 'heal'), heal: r.heal };
    });
    check('/browser/status carries a heal field', idle.hasField);
    // Nothing running -> null. A window that puts up a spinner "just in case"
    // would be the same lie in a new place.
    check('an idle server reports NO heal (it must not invent one)',
      idle.heal === null || idle.heal === undefined,
      'heal=' + JSON.stringify(idle.heal));

    // Now race a real restart and read the state mid-flight.
    const mid = await page.evaluate(async () => {
      const seen = [];
      const p = window.API.post('/browser/restart', {}).catch(() => null);
      for (let i = 0; i < 10; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        const s = await window.API.get('/browser/status').catch(() => null);
        if (s && s.heal && s.heal.step) {
          seen.push({ key: s.heal.step.key, elapsedMs: s.heal.elapsedMs });
          break;
        }
      }
      await p;
      return seen;
    });
    check('a heal in flight is visible to a window that did not start it',
      mid.length > 0 && !!mid[0].key,
      mid.length ? JSON.stringify(mid[0]) : 'never observed a live heal');
    check('the live heal reports a real elapsed time, not a guess',
      mid.length > 0 && typeof mid[0].elapsedMs === 'number' && mid[0].elapsedMs >= 0,
      mid.length ? 'elapsedMs=' + mid[0].elapsedMs : '');

    group('no page errors while driving the heal panel');
    check('no page errors', pageErrors.length === 0,
      pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : 'none');
    // Positive control: if this is 0 the blackhole never actually bit, which
    // would mean the "panel takes itself down" pass above proved nothing.
    check('the probe really did strand a request (its reproduction worked)',
      selfInflicted.length > 0, 'aborted-fetch errors=' + selfInflicted.length);
  } catch (e) {
    record(false, 'probe reached the end without throwing', String(e && e.message ? e.message : e));
    await shot('99-crash');
  } finally {
    blackhole = false;
    for (const r of held.splice(0)) { try { await r.abort(); } catch (e) {} }
    await browser.close().catch(() => {});
    await fx.close();
  }

  const failed = results.filter((x) => !x.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('\nfailures:\n');
    failed.forEach((f) => process.stdout.write('  ✗ ' + f.name + (f.detail ? '  — ' + f.detail : '') + '\n'));
  }
  process.exit(failed.length);
})();
