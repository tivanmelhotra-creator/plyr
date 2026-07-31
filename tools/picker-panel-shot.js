/* ============================================================
   tools/picker-panel-shot.js — DEV ONLY renderer for the Element
   Picker's floating panel.

   picker-probe.js measures geometry but never puts a PICK on the
   wire, so the panel it screenshots is empty: no attribute cards,
   no candidates, no "#N Element", no session chip. Those are
   exactly the parts added for Automa parity, and "it typechecks"
   is not evidence that they render.

   This stubs window.WebSocket so the page receives a real-shaped
   `ready` + `frame` + `pick` sequence, then shoots the panel in
   both languages and both session states.

   Usage:
       node tools/ui-preview-server.js 8788 &
       UI_LANG=en node tools/picker-panel-shot.js
       UI_LANG=fa node tools/picker-panel-shot.js
   ============================================================ */
'use strict';

const path = require('path');
const { chromium } = require('playwright');

const base = process.env.UI_BASE || 'http://localhost:8788/index.html';
const lang = process.env.UI_LANG || 'en';
const outDir = process.env.UI_OUT || path.join(__dirname, '..', '.ui-shots');
const size = (process.env.UI_SIZE || '1672x941').split('x').map(Number);

// The payload shape LiveBrowser's PICKER_SCRIPT actually emits. Values are taken
// from a real Gmail compose button (the element in the reference screenshot), so
// the layout is stressed by realistic lengths — including the 34-char `jslog`
// that used to be ellipsised into uselessness by the old two-column row.
const PICK = {
  t: 'pick',
  k: 'pick',
  css: 'div.T-I.T-I-KE.L3',
  xpath: '/html/body/div[7]/div[3]/div/div[1]/div[3]/div/div/div[1]/div/div/div[1]/div/div',
  tag: 'div',
  text: 'Compose',
  count: 1,
  index: 1,
  hasParent: true,
  hasChild: true,
  attrs: [
    { name: 'id', value: ':5u' },
    { name: 'role', value: 'button' },
    { name: 'tabindex', value: '0' },
    { name: 'class', value: 'T-I T-I-KE L3' },
    { name: 'jslog', value: '21578; u014N:cOuCgd,Kr2v' },
    { name: 'aria-label', value: 'Compose a new message' }
  ],
  candidates: [
    { sel: 'div[role="button"]', count: 14 },
    { sel: 'div[aria-label="Compose a new message"]', count: 1 },
    { sel: 'div.T-I-KE', count: 1 },
    { sel: 'div.L3', count: 2 }
  ]
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

  await page.addInitScript(([lg]) => {
    localStorage.setItem('ab_api_key', 'dev-preview-key');
    localStorage.setItem('ab_user_id', 'dev-preview');
    if (lg) localStorage.setItem('ab_lang', lg);
    localStorage.removeItem('abPickerUrl');

    // A WebSocket that never leaves the page. `sent` is the assertion surface:
    // the panel's buttons are only wired if the right frames come back out.
    window.__sent = [];
    const RealWS = window.WebSocket;
    function FakeWS() {
      window.__ws = this;
      this.readyState = 1;                       // OPEN
      this.OPEN = 1;
      setTimeout(() => { if (this.onopen) this.onopen({}); }, 0);
    }
    FakeWS.prototype.send = function (s) {
      window.__sent.push(s);
      try {
        const m = JSON.parse(s);
        // Answer a verify the way the page script does, so the count the panel
        // shows after clicking a candidate is a real round trip.
        if (m.t === 'verify' && this.onmessage) {
          const known = { 'div[role="button"]': 14, 'div.L3': 2 };
          const n = known[m.selector] !== undefined ? known[m.selector] : 1;
          this.onmessage({ data: JSON.stringify({ t: 'verified', count: n }) });
        }
        if (m.t === 'forgetSession' && this.onmessage) {
          this.onmessage({ data: JSON.stringify({ t: 'session', signedIn: false, cleared: true }) });
        }
      } catch (e) {}
    };
    FakeWS.prototype.close = function () { this.readyState = 3; };
    FakeWS.OPEN = 1;
    FakeWS.__real = RealWS;
    window.WebSocket = FakeWS;

    window.__push = function (obj) {
      if (window.__ws && window.__ws.onmessage) {
        window.__ws.onmessage({ data: JSON.stringify(obj) });
      }
    };
  }, [lang]);

  await page.goto(base + '#/editor', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const report = { lang, viewport: size.join('x'), errors: [] };

  async function openWith(signedIn) {
    await page.evaluate(() => {
      if (window.BrowserView && window.BrowserView.stop) window.BrowserView.stop();
      window.__picked = null;
      window.BrowserView.requestPick((v) => { window.__picked = v; },
        { value: '', url: 'https://mail.google.com/', mode: 'css' });
    });
    await page.waitForTimeout(250);
    // ready → the picker learns whether cookies were restored
    await page.evaluate((s) => window.__push({ t: 'ready', signedIn: s }), signedIn);
    // frame → a 1280x720 image, the real screencast size
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, 720);
      g.addColorStop(0, '#f6f8fc'); g.addColorStop(1, '#e3e8ef');
      x.fillStyle = g; x.fillRect(0, 0, 1280, 720);
      x.fillStyle = '#c3ccd8';
      for (let i = 0; i < 12; i++) x.fillRect(60, 90 + i * 48, 700, 26);
      const b64 = c.toDataURL('image/jpeg', 0.7).split(',')[1];
      window.__push({ t: 'frame', data: b64 });
    });
    await page.waitForTimeout(300);
    await page.evaluate((p) => window.__push(p), PICK);
    await page.waitForTimeout(250);
  }

  const shot = async (name) => {
    const f = path.join(outDir, name);
    await page.screenshot({ path: f });
    return f;
  };

  const measure = () => page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const panel = g('bvp-panel');
    const stage = g('bvp-stage');
    const ps = panel.getBoundingClientRect();
    const ss = stage.getBoundingClientRect();
    const grip = g('bvp-drag').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.bvp-attr')].map((c) => ({
      name: c.querySelector('.bvp-attr-name').textContent,
      // Does the value fit, or is it silently truncated?
      clipped: c.querySelector('.bvp-attr-value').scrollWidth -
               c.querySelector('.bvp-attr-value').clientWidth,
      hasCopy: !!c.querySelector('.bvp-attr-copy')
    }));
    return {
      panel: r(panel),
      elHead: g('bvp-elhead').textContent.trim(),
      count: g('bvp-count').textContent.trim(),
      session: g('bvp-session').textContent.trim(),
      anon: g('bvp-anon').textContent.trim().slice(0, 60),
      forgetDisabled: g('bvp-forget').disabled,
      tabs: [...document.querySelectorAll('.bvp-tab')].map((b) => ({
        label: b.textContent.trim(), on: b.classList.contains('is-on')
      })),
      cardCount: cards.length,
      cards,
      // The grip overhangs the panel top — prove it is not clipped by the stage.
      gripAboveStage: Math.round(ss.top - grip.top),
      gripCentered: Math.round((grip.left + grip.width / 2) - (ps.left + ps.width / 2)),
      // Does the panel still fit inside the stage now that it grew?
      overflowBottom: Math.round((ps.bottom) - (ss.bottom)),
      selDir: getComputedStyle(g('bvp-sel')).direction,
      kbd: document.querySelector('.bvp-kbd').textContent.replace(/\s+/g, ' ').trim()
    };
  });

  // ---- 1. anonymous session ------------------------------------------------
  await openWith(false);
  report.anonymous = await measure();
  report.shots = [await shot(`picker-panel-${lang}-anon.png`)];

  // ---- 2. restored session -------------------------------------------------
  await openWith(true);
  report.restored = await measure();
  report.shots.push(await shot(`picker-panel-${lang}-signedin.png`));

  // ---- 3. the Candidates tab actually switches -----------------------------
  await page.click('#bvp-tab-cands');
  await page.waitForTimeout(150);
  report.candidatesTab = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.bvp-cand')].map((b) => ({
      sel: b.querySelector('.bvp-cand-sel').textContent,
      n: b.querySelector('.bvp-cand-n').textContent,
      tone: b.querySelector('.bvp-cand-n').className.replace('bvp-cand-n ', ''),
      clipped: b.querySelector('.bvp-cand-sel').scrollWidth -
               b.querySelector('.bvp-cand-sel').clientWidth
    }));
    return {
      attrsHidden: document.getElementById('bvp-pane-attrs').classList.contains('is-off'),
      candsShown: !document.getElementById('bvp-pane-cands').classList.contains('is-off'),
      tabBadge: document.getElementById('bvp-cands-n').textContent,
      rows
    };
  });
  report.shots.push(await shot(`picker-panel-${lang}-candidates.png`));

  // ---- 4. clicking a candidate writes it into the field and re-verifies ----
  await page.click('.bvp-cand:nth-child(1)');
  await page.waitForTimeout(150);
  report.candidateClick = await page.evaluate(() => ({
    sel: document.getElementById('bvp-sel').value,
    count: document.getElementById('bvp-count').textContent.trim(),
    verifySent: window.__sent.filter((s) => s.indexOf('"verify"') >= 0).length
  }));

  // ---- 5. clicking an attribute box offers [name="value"] -----------------
  await page.click('#bvp-tab-attrs');
  await page.waitForTimeout(100);
  await page.click('.bvp-attr:nth-child(6) .bvp-attr-box');   // aria-label
  await page.waitForTimeout(150);
  report.attrClick = await page.evaluate(() => ({
    sel: document.getElementById('bvp-sel').value,
    count: document.getElementById('bvp-count').textContent.trim()
  }));

  // ---- 6. keyboard on the stage ------------------------------------------
  await page.evaluate(() => { window.__sent.length = 0; document.getElementById('bvp-stage').focus(); });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  report.keyboard = await page.evaluate(() => window.__sent.map((s) => JSON.parse(s)));

  // ---- 7. forget session -------------------------------------------------
  await page.click('#bvp-forget');
  await page.waitForTimeout(200);
  report.afterForget = await page.evaluate(() => ({
    session: document.getElementById('bvp-session').textContent.trim(),
    forgetDisabled: document.getElementById('bvp-forget').disabled,
    anon: document.getElementById('bvp-anon').textContent.trim().slice(0, 50)
  }));

  report.errors = errors;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
