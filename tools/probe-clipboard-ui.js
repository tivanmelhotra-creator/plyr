/**
 * probe-clipboard-ui.js — the CLIENT half of §4, driven through the real UI.
 *
 * Why a second probe. tools/probe-clipboard.js proved the SERVER is fine: paste,
 * selection copy and the permission-dependent page clipboard all work on a fresh
 * session, after a resync, and after a real restart — 20/20. So §4b (the handoff's
 * leading hypothesis, that recover() drops the clipboard grant) is FALSE, and the
 * reported breakage has to live on the client, where two things the server cannot
 * see are decided:
 *
 *   * whether the local browser will give up its clipboard at all
 *     (`navigator.clipboard` does not exist on a plain http:// origin — and a
 *     self-hosted server on a LAN is exactly that);
 *   * whether the user is TOLD when it refuses.
 *
 * The second is the actual defect this probe is written to catch. `legacyCopy`
 * returns a bare `false` and `writeLocalClipboard` resolves `false`; whether the
 * user learns anything depends entirely on the caller looking at it. A silent
 * `false` is indistinguishable from "the button does nothing", which is precisely
 * how this got reported as «خراب شده» — broken.
 *
 * The pattern is the one probe-heal-panel.js established: reach into the page and
 * make the browser API FAIL on purpose, then assert the UI explains itself.
 *
 *   DISPLAY=:99 node tools/probe-clipboard-ui.js
 */
'use strict';

const { chromium } = require('playwright');
const fixture = require('./fixture-server');

const KEY = process.env.API_TOKEN || 'devtoken123';
const BASE = 'http://127.0.0.1:3000';

const results = [];
function record(pass, name, detail) {
  results.push({ pass, name, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}\n`);
}
function check(name, cond, detail) { record(!!cond, name, detail); }
function group(name) { process.stdout.write(`\n--- ${name} ---\n`); }

async function main() {
  const fx = await fixture.start(3111);
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  // Granted deliberately: this probe is about what happens when the API is
  // MISSING or REFUSES, which it simulates explicitly. Leaving permission out
  // would confound "not permitted" with "not implemented".
  const ctx = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((k) => {
      localStorage.setItem('ab_api_key', k);
      localStorage.setItem('ab_lang', 'en');
    }, KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Record every toast, so "did the UI say anything?" is answerable.
    await page.evaluate(() => {
      window.__toasts = [];
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.matches && n.matches('.toast')) {
              window.__toasts.push(String(n.textContent || ''));
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
    const toasts = () => page.evaluate(() => window.__toasts.slice());

    group('the clipboard bridge is actually wired into the picker');
    // RemoteIO is attached with the socket, so the picker has to be open.
    const opened = await page.evaluate(async (base) => {
      // Open the picker the way the app does, then report what exists.
      const btn = document.querySelector('[data-act="pick"], .ndv-pick, #ndv-pick');
      return { hasBtn: !!btn, base };
    }, fx.base);
    check('the app page loaded and exposes its DOM', !!opened);

    // Drive the picker through the public helper the NDV uses.
    const okOpen = await page.evaluate(() => {
      if (!window.BrowserView || !window.BrowserView.requestPick) return false;
      window.BrowserView.requestPick(function () {});
      return !!document.querySelector('.bvp-backdrop');
    });
    check('the picker window opens', okOpen);
    if (!okOpen) throw new Error('picker did not open; cannot test the bridge');

    await page.fill('#bvp-url', `${fx.base}/clip`);
    await page.click('#bvp-go');
    await page.waitForTimeout(3500);

    const wired = await page.evaluate(() => {
      const s = document.querySelector('#bvp-stage');
      return {
        stage: !!s,
        focusable: s ? s.getAttribute('tabindex') : null,
        clipBtn: !!document.querySelector('#bvp-clip'),
        hasRemoteIO: !!window.RemoteIO,
      };
    });
    check('the stage exists and can take focus (a paste event needs that)',
      wired.stage && wired.focusable === '0', JSON.stringify(wired));
    check('the toolbar exposes an explicit "pull remote clipboard" button',
      wired.clipBtn);
    check('RemoteIO is present', wired.hasRemoteIO);

    // ── Copy FROM the remote browser, through the real button ──────────────
    group('copy from the remote browser lands on the LOCAL clipboard');
    await page.evaluate(() => { window.__toasts.length = 0; });
    // Put something selectable in the remote page first.
    await page.click('#bvp-stage');
    await page.waitForTimeout(200);
    await page.click('#bvp-clip');
    await page.waitForTimeout(2500);
    const afterPull = await toasts();
    check('pressing the clipboard button produces a spoken outcome',
      afterPull.length > 0,
      afterPull.length ? JSON.stringify(afterPull).slice(0, 180) : 'SILENT — the user cannot tell what happened');

    // ══════════════════════════════════════════════════════════════════════
    // THE DEFECT: what happens when the LOCAL clipboard refuses?
    // ══════════════════════════════════════════════════════════════════════
    // This is the http:// case that a self-hosted LAN deployment always hits,
    // simulated honestly: remove navigator.clipboard AND make the execCommand
    // fallback fail, which is exactly the state of a non-secure origin in a
    // browser that has already dropped execCommand('copy').
    group('when the local clipboard refuses, the user is TOLD (not left guessing)');
    await page.evaluate(() => {
      window.__toasts.length = 0;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true, get() { return undefined; },
        });
      } catch (e) { /* already shadowed */ }
      document.execCommand = function () { return false; };
    });
    await page.click('#bvp-clip');
    await page.waitForTimeout(2500);
    const refused = await toasts();
    check('a refused local clipboard write is reported to the user',
      refused.length > 0,
      refused.length ? JSON.stringify(refused).slice(0, 200) : 'SILENT — this is the reported bug');
    // …and it must say something USEFUL, not merely "failed". A user on http://
    // needs to know that the origin is the reason, or they will keep pressing.
    check('the message explains WHY, so the user can act on it',
      refused.some((s) => /https|secure|localhost|امن|permission|settings|by hand|دستی/i.test(s)),
      JSON.stringify(refused).slice(0, 240));

    // …and the text must not be thrown away. It has already crossed from the
    // remote machine; a browser policy that forbids writing the clipboard is no
    // reason to deny the user data they are already holding.
    const fallback = await page.evaluate(() => {
      const b = document.querySelector('#rio-copy-fallback');
      const ta = b ? b.querySelector('textarea') : null;
      return b ? { shown: true, text: ta ? ta.value : '', readOnly: ta ? ta.readOnly : null } : { shown: false };
    });
    check('the text is still offered in a selectable box (degrades, not disappears)',
      fallback.shown && String(fallback.text || '').length > 0,
      JSON.stringify(fallback).slice(0, 160));
    check('the fallback box is read-only (it is a copy source, not an editor)',
      fallback.readOnly === true, 'readOnly=' + fallback.readOnly);
    check('the fallback can be dismissed', await page.evaluate(() => {
      const b = document.querySelector('#rio-copy-fallback');
      const btn = b ? b.querySelector('button') : null;
      if (!btn) return false;
      btn.click();
      return !document.querySelector('#rio-copy-fallback');
    }));

    // ── Paste INTO the remote browser ─────────────────────────────────────
    group('paste into the remote browser');
    // A real paste event is the only way to read the local clipboard without a
    // prompt, so it is dispatched as the browser would.
    await page.evaluate(() => { window.__toasts.length = 0; });
    const pasteMark = 'ui-paste-' + Date.now();
    fx.reset();
    // Click the FIELD, not the middle of the stage. `Input.insertText` puts text
    // where the remote cursor is, so a click at the canvas centre focuses the
    // page body and the text lands nowhere the fixture can report — which looks
    // exactly like "paste is broken" while proving nothing. The field is at the
    // top-left of the fixture page, so aim there in canvas coordinates.
    const box = await page.locator('#bvp-canvas').boundingBox();
    await page.mouse.click(box.x + 60, box.y + 22);
    await page.waitForTimeout(300);
    await page.evaluate((text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      document.querySelector('#bvp-stage')
        .dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        }));
    }, pasteMark);
    await page.waitForTimeout(2000);
    // The fixture page reports what actually landed in its field.
    let landed = '';
    for (let i = 0; i < 25; i += 1) {
      landed = String(fx.report('field') || '');
      if (landed.indexOf(pasteMark) >= 0) break;
      await page.waitForTimeout(200);
    }
    check('a local paste reaches the remote page',
      landed.indexOf(pasteMark) >= 0, 'remote field=' + JSON.stringify(landed));

    group('no page errors while driving the clipboard');
    check('no page errors', pageErrors.length === 0,
      pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : 'none');
  } catch (e) {
    record(false, 'probe reached the end without throwing',
      String(e && e.message ? e.message : e));
  } finally {
    await browser.close().catch(() => {});
    await fx.close();
  }

  const failed = results.filter((x) => !x.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('\nfailures:\n');
    failed.forEach((f) => process.stdout.write('  ✗ ' + f.name + (f.detail ? '  — ' + f.detail : '') + '\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => { process.stdout.write('FATAL ' + e.stack + '\n'); process.exitCode = 1; });
