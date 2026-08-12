#!/usr/bin/env node
/**
 * probe-condition-value-types.js — the MEASUREMENT behind mission 5 part 2
 * (grouped condition value types: Automa's `Code`, `Element visible in screen`).
 *
 * Run:  node tools/probe-condition-value-types.js
 *       (needs the Playwright chromium download; ~4s, headless, no X server)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * MISSIONS.md's plan for part 2 proposed implementing "element visible in
 * screen" as `locator.boundingBox()` intersected with the viewport rect. This
 * probe was written to check that before building on it, and it turned out to be
 * WRONG — see finding 3. Two more traps (findings 1 and 4) are silent: they
 * produce a `false` condition rather than an error, which in a branching
 * workflow means "quietly took the else path", the single most expensive class
 * of bug in this product.
 *
 * Re-run it if you touch ConditionEngine's `code` or in-screen paths. Every
 * assertion the engine relies on is printed with a PASS/FAIL verdict, so this is
 * a regression check and not just a dump.
 *
 * THE SEVEN FINDINGS (all reproduced by this script)
 * --------------------------------------------------
 *  1. `page.evaluate('return true;')` throws `SyntaxError: Illegal return
 *     statement`. Automa seeds its Code editor with exactly `return true;`, so
 *     the snippet MUST be wrapped before it is handed to Playwright.
 *  2. Wrapping in a statement body `(async () => { <code> })()` fixes `return
 *     true;` but silently yields `undefined` for an expression-only snippet like
 *     `document.title === ""`. Wrapping as an expression `return (<code>)` is
 *     the mirror image: it throws on `return true;`. Neither wrapper alone is
 *     correct -> ConditionEngine picks per snippet (`looksLikeStatement`).
 *  3. **The plan's suggested implementation is wrong.** For an element scrolled
 *     out of sight inside an `overflow:hidden` container, boundingBox ∩ viewport
 *     says IN VIEW while IntersectionObserver says false. A single rect cannot
 *     see ancestor clipping. Hence `isInScreen()` uses IntersectionObserver.
 *  4. `locator.evaluate('<a function source string>')` returns `undefined`
 *     instead of calling the function — the string form is evaluated as an
 *     expression, so it just produces the function object. The in-screen check
 *     must be passed as a REAL function.
 *  5. `in_screen` is genuinely NOT a duplicate of `visible`: an element 4000px
 *     below the fold reports `isVisible() === true` but is not on screen.
 *     Scrolling to it flips in-screen to true and flips the formerly-visible
 *     element to false, which is what makes the operator worth having.
 *  6. An IntersectionObserver on a `display:none` element still fires (with
 *     isIntersecting false) — but relying on that is unsafe, so the promise
 *     carries a timeout that resolves false; without it a non-firing observer
 *     would hang the whole run.
 *  7. A runaway snippet (`while (true) {}`) wedges the page PERMANENTLY: a later
 *     `page.evaluate('1+1')` never returns. So the code path must be bounded by
 *     a race, and the timeout must be reported as a failed condition.
 *
 * Also verified: a strict `script-src 'self'` CSP on the page does NOT block
 * `page.evaluate(<string>)` (Playwright injects through the debugger, not a
 * <script> tag), so the Code value type still works on CSP-hardened sites.
 */
'use strict';

const { chromium } = require('playwright');

const VIEWPORT = { width: 800, height: 600 };
const results = [];

function check(name, actual, expected, note) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ ok, name, actual, expected, note });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(
    `[${tag}] ${name}\n        got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`
    + (note ? `\n        ${note}` : '')
  );
}

// The two candidate wrappers, exactly as ConditionEngine builds them.
const asStatements = (code) => `(async () => {\n${code}\n})()`;
const asExpression = (code) => `(async () => { return (\n${code}\n); })()`;

// The in-screen check, kept byte-identical in spirit to ConditionEngine.isInScreen.
const IN_SCREEN = (el, budgetMs) => new Promise((resolve) => {
  let settled = false;
  let io = null;
  const finish = (v) => {
    if (settled) return;
    settled = true;
    try { if (io) io.disconnect(); } catch (e) { /* already gone */ }
    resolve(v);
  };
  try {
    io = new IntersectionObserver((entries) => {
      finish(entries.length > 0 && entries[entries.length - 1].isIntersecting === true);
    });
    io.observe(el);
  } catch (e) { finish(false); }
  setTimeout(() => finish(false), budgetMs);
});

const FIXTURE = `
  <div id="inview" style="width:40px;height:40px">IN</div>
  <div id="below" style="position:absolute;top:4000px">BELOW THE FOLD</div>
  <div id="right" style="position:absolute;left:3000px;top:5px">OFF TO THE RIGHT</div>
  <div id="clipwrap" style="position:absolute;top:5px;left:5px;width:100px;height:60px;overflow:hidden">
    <div style="height:300px"></div>
    <div id="clipped" style="height:20px">SCROLLED OUT INSIDE A CLIPPING PARENT</div>
  </div>
  <div id="none" style="display:none">DISPLAY NONE</div>
  <div id="partial" style="position:absolute;top:590px;height:80px;width:40px">HALF ON SCREEN</div>
`;

async function evalSafe(page, source) {
  try { return { ok: true, value: await page.evaluate(source) }; }
  catch (e) { return { ok: false, error: String(e.message).split('\n')[0] }; }
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    // ===================================================================
    // 1 + 2. How a user's snippet must be handed to the page
    // ===================================================================
    console.log('\n=== 1/2. wrapping the user snippet ===');
    const cp = await browser.newPage({ viewport: VIEWPORT });
    await cp.setContent('<div id="n">7</div>');

    const bare = await evalSafe(cp, 'return true;');
    check('a bare `return true;` is rejected by page.evaluate',
      bare.ok === false && /Illegal return statement/.test(bare.error || ''), true,
      'this is why the snippet is wrapped at all (Automa seeds exactly this)');

    const stmtOnStatement = await evalSafe(cp, asStatements('return true;'));
    check('statement wrapper runs `return true;`', stmtOnStatement.value, true);

    const stmtOnExpression = await evalSafe(cp, asStatements('document.title === ""'));
    check('statement wrapper SILENTLY loses an expression-only snippet',
      stmtOnExpression.value === undefined, true,
      'undefined -> Boolean() -> false: a wrong branch with no error at all');

    const exprOnExpression = await evalSafe(cp, asExpression('document.title === ""'));
    check('expression wrapper runs an expression-only snippet', exprOnExpression.value, true);

    const exprOnStatement = await evalSafe(cp, asExpression('return true;'));
    check('expression wrapper throws on a statement snippet',
      exprOnStatement.ok === false, true,
      'so NEITHER wrapper is universal — the engine must choose per snippet');

    const multi = await evalSafe(cp, asStatements(
      'const el = document.querySelector("#n"); return Number(el.textContent) > 5;'));
    check('statement wrapper handles a multi-statement snippet', multi.value, true);

    const awaited = await evalSafe(cp, asStatements(
      'await new Promise(r => setTimeout(r, 5)); return 42;'));
    check('the wrapper is async, so `await` works inside a snippet', awaited.value, 42);

    const thrown = await evalSafe(cp, asStatements('throw new Error("boom");'));
    check('a throwing snippet rejects (engine turns this into false)',
      thrown.ok === false, true);

    // ===================================================================
    // 3. in-screen: boundingBox ∩ viewport vs IntersectionObserver
    // ===================================================================
    console.log('\n=== 3. THE PLAN\u2019S SUGGESTED IMPLEMENTATION IS WRONG ===');
    const vp = await browser.newPage({ viewport: VIEWPORT });
    await vp.setContent(FIXTURE);

    const clipped = vp.locator('#clipped').first();
    const box = await clipped.boundingBox();
    const boxSaysInView = !!box
      && box.x < VIEWPORT.width && box.y < VIEWPORT.height
      && box.x + box.width > 0 && box.y + box.height > 0;
    const ioSays = await clipped.evaluate(IN_SCREEN, 1000);

    check('boundingBox \u2229 viewport WRONGLY reports a clipped element as on screen',
      boxSaysInView, true,
      `box=${JSON.stringify(box)} — the rect lands inside the viewport…`);
    check('IntersectionObserver correctly reports it as OFF screen', ioSays, false,
      '…because only the observer accounts for the overflow:hidden ancestor');
    check('the two methods therefore DISAGREE (box test is unusable)',
      boxSaysInView !== ioSays, true);

    // ===================================================================
    // 4. the string form of locator.evaluate is a silent no-op
    // ===================================================================
    console.log('\n=== 4. locator.evaluate(<string>) silently returns undefined ===');
    const asString = await vp.locator('#inview').first()
      .evaluate('(el) => { return 123; }').catch((e) => 'THREW');
    check('passing the check as a SOURCE STRING yields undefined, not 123',
      asString === undefined, true,
      'the string is evaluated as an expression, producing the function object');
    const asFunction = await vp.locator('#inview').first().evaluate((el) => 123);
    check('passing a REAL function works', asFunction, 123);

    // ===================================================================
    // 5. in_screen is not a duplicate of visible
    // ===================================================================
    console.log('\n=== 5. in_screen vs visible: genuinely different questions ===');
    const table = {};
    for (const id of ['inview', 'below', 'right', 'clipped', 'none', 'partial']) {
      const loc = vp.locator('#' + id).first();
      table[id] = {
        isVisible: await loc.isVisible().catch(() => 'threw'),
        inScreen: await loc.evaluate(IN_SCREEN, 1000).catch(() => 'threw'),
      };
    }
    console.log(JSON.stringify(table, null, 2));
    check('an element below the fold is VISIBLE but NOT on screen',
      [table.below.isVisible, table.below.inScreen], [true, false],
      'this is the whole justification for the new operator');
    check('an element off to the right is likewise visible but not on screen',
      [table.right.isVisible, table.right.inScreen], [true, false]);
    check('a half-on-screen element counts as on screen',
      table.partial.inScreen, true);
    check('display:none is neither visible nor on screen',
      [table.none.isVisible, table.none.inScreen], [false, false]);

    await vp.evaluate(() => window.scrollTo(0, 3900));
    const belowAfter = await vp.locator('#below').first().evaluate(IN_SCREEN, 1000);
    const inviewAfter = await vp.locator('#inview').first().evaluate(IN_SCREEN, 1000);
    check('scrolling flips the answer for BOTH elements',
      [belowAfter, inviewAfter], [true, false],
      'a check that ignored scroll position could not do this');

    // ===================================================================
    // 6. the observer needs its timeout guard
    // ===================================================================
    console.log('\n=== 6. the in-screen promise must be time-bounded ===');
    const np = await browser.newPage({ viewport: VIEWPORT });
    await np.setContent('<div id="none" style="display:none">N</div>');
    const t0 = Date.now();
    const noneRes = await np.locator('#none').first().evaluate(IN_SCREEN, 1000);
    const noneMs = Date.now() - t0;
    check('a display:none element settles false', noneRes, false);
    check('…and settles FAST (the observer does fire; the timer is the backstop)',
      noneMs < 900, true, `took ${noneMs}ms`);

    // ===================================================================
    // 7. a runaway snippet wedges the page for good
    // ===================================================================
    console.log('\n=== 7. a runaway snippet wedges the page PERMANENTLY ===');
    const rp = await browser.newPage({ viewport: VIEWPORT });
    await rp.setContent('<div>x</div>');
    const runaway = rp.evaluate(asStatements('while (true) {}')).catch(() => 'rejected');
    const raced = await Promise.race([
      runaway,
      new Promise((r) => setTimeout(() => r('TIMEOUT_WON'), 1200)),
    ]);
    check('the snippet never returns, so only a race escapes it',
      raced, 'TIMEOUT_WON',
      'hence ConditionEngine races the evaluate against CONDITION_CODE_TIMEOUT_MS');
    const after = await Promise.race([
      rp.evaluate('1+1').then((v) => 'alive:' + v).catch(() => 'threw'),
      new Promise((r) => setTimeout(() => r('STILL_WEDGED'), 1500)),
    ]);
    check('the page stays wedged afterwards — the timeout cannot be a retry',
      after, 'STILL_WEDGED',
      'so a timed-out code condition must report false, not try again');

    // ===================================================================
    // bonus: a strict CSP does not block page.evaluate
    // ===================================================================
    console.log('\n=== bonus. a strict CSP does not break the Code value type ===');
    const csp = await browser.newPage({ viewport: VIEWPORT });
    await csp.route('**/csp', (route) => route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'; script-src 'self'",
      },
      body: '<html><body><div id="x">hi</div></body></html>',
    }));
    await csp.goto('http://csp.test/csp');
    const underCsp = await evalSafe(csp,
      asStatements('return document.querySelector("#x").textContent;'));
    check('page.evaluate still runs under script-src \'self\'', underCsp.value, 'hi',
      'Playwright injects through the debugger, not a <script> tag');

  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n================ ${results.length - failed.length}/${results.length} checks passed ================`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}`));
    process.exitCode = 1;
  } else {
    console.log('VERDICT=PASS — every assumption ConditionEngine makes is reproduced.');
  }
})().catch((e) => {
  console.error('probe crashed:', e);
  process.exitCode = 1;
});
