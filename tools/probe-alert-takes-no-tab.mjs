/**
 * THE ALERT TAKES NO TAB — MEASURED IN A REAL CHROME.
 *
 *   «Alert نباید Tab جدید بسازد»
 *   «Picker نباید برای Alert صفحه جدید بسازد»
 *   «Retry نباید برای Alert صفحه جدید بسازد»
 *
 * ── WHAT THIS PROBE USED TO ASSERT ─────────────────────────────────────────
 * It was `probe-one-alert-tab.mjs`, and it measured the opposite conclusion
 * from the same setup: that the blank-only window produced EXACTLY ONE
 * consent-host tab, reused across five presses. It passed. The design it
 * certified has since been withdrawn —
 *
 *   «دیگر Priority 2 / fallback برای ساختن consent-host به عنوان Alert Tab
 *    نمی‌خواهیم … این concept باید از معماری حذف شود»
 *
 * — because "one tab per run" was still one tab too many: every page the
 * fallback created was written into the profile's session and restored on the
 * NEXT launch, so the count grew per launch rather than per press. That is the
 * reported «۵ یا بیشتر about:blank به‌علاوه یک consent-host».
 *
 * The SCENARIO is kept, because it is the hardest one: a window stripped back
 * to about:blank, where no content script can run and the old code therefore
 * felt entitled to build a page. Only the expected number changed, from one to
 * zero.
 *
 * What it asserts:
 *   · with only about:blank open, the Picker route creates NO tab, ever
 *   · no consent-host tab appears at any point, on any press
 *   · the blank page is not navigated — it stays about:blank
 *   · with a normal http page open, the count still does not move
 *   · Retry (mayOpenTab:false) likewise creates nothing
 *
 * Run: node tools/probe-alert-takes-no-tab.mjs
 */
const BASE = 'http://127.0.0.1:3000';
const CDP = 'http://127.0.0.1:9222';
const H = { 'Content-Type': 'application/json', 'X-API-Key': 'admin123' };

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: H, body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function tabs() {
  const r = await fetch(`${CDP}/json/list`);
  const all = await r.json().catch(() => []);
  return all.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
}
async function closeTab(id) {
  await fetch(`${CDP}/json/close/${id}`).catch(() => {});
}
async function openTab(url) {
  await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
}

const fail = [];
function check(cond, label, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) fail.push(label);
}
const isHttp = (u) => /^https?:\/\//i.test(u);

(async () => {
  console.log('\n=== 1. strip the browser back to about:blank only ===');
  // The state the withdrawn fallback fired in: nothing injectable, so the old
  // code built a page. Now it must build nothing, which is what makes this the
  // decisive scenario rather than a corner case.
  let now = await tabs();
  for (const t of now.filter((x) => isHttp(x.url))) await closeTab(t.id);
  await new Promise((r) => setTimeout(r, 1500));

  // Guarantee at least one page survives, so the browser is not left empty.
  now = await tabs();
  if (now.length === 0) { await openTab('about:blank'); now = await tabs(); }
  console.log(`  tabs: ${now.length}`);
  now.forEach((t, i) => console.log(`    [${i}] ${t.url.slice(0, 60)}`));
  check(now.filter((t) => isHttp(t.url)).length === 0,
    'no injectable page remains — the hardest case for "creates no tab"');

  console.log('\n=== 2. drive the Picker route 5x with nowhere to draw ===');
  const baseline = (await tabs()).length;
  const counts = [];
  for (let i = 1; i <= 5; i += 1) {
    const r = await post('/browser/real/open', {});
    await new Promise((res) => setTimeout(res, 1500));
    const t = await tabs();
    const hosts = t.filter((x) => /consent-host/.test(x.url));
    counts.push({ i, total: t.length, hosts: hosts.length, status: r.status });
    console.log(`  picker #${i}: http=${r.status} tabs=${t.length} consent-host=${hosts.length}`);
    check(hosts.length === 0, `picker #${i}: ZERO consent-host tabs`,
      `${hosts.length} found`);
    check(t.length === baseline, `picker #${i}: created no tab`,
      `${baseline} -> ${t.length}`);
  }

  // The blank page must be left blank. A probe that only counted tabs would
  // miss the route hijacking the page in place, which is the same defect
  // wearing a different number.
  const stillBlank = (await tabs()).filter((t) => t.url === 'about:blank').length;
  check(stillBlank >= 1, 'the about:blank page was NOT navigated to a consent host',
    `${stillBlank} blank page(s) remain`);

  const grew = counts.filter((c) => c.total > baseline);
  check(grew.length === 0, 'five presses created NOTHING at all',
    `totals: ${counts.map((c) => c.total).join(', ')}`);

  console.log('\n=== 3. with a normal page open, still nothing is created ===');
  await openTab('https://example.com/');
  const base = (await tabs()).length;
  for (let i = 1; i <= 3; i += 1) {
    await post('/browser/real/open', {});
    await new Promise((res) => setTimeout(res, 1500));
    const t = await tabs();
    console.log(`  picker #${i}: tabs=${t.length}`);
    check(t.length === base, `overlay picker #${i}: created no tab`, `${base} -> ${t.length}`);
  }

  console.log('\n=== 4. RETRY (mayOpenTab:false) creates nothing either ===');
  // Retry reuses the live browser and must not open a tab in the operator's
  // main browser NOR a page in the server's. Driven through the same route with
  // an explicit no-tab intent, which is what the client sends.
  const beforeRetry = (await tabs()).length;
  for (let i = 1; i <= 3; i += 1) {
    await post('/browser/real/open', { noTab: true });
    await new Promise((res) => setTimeout(res, 1500));
    const t = await tabs();
    const hosts = t.filter((x) => /consent-host/.test(x.url));
    console.log(`  retry #${i}: tabs=${t.length} consent-host=${hosts.length}`);
    check(t.length === beforeRetry, `retry #${i}: created no tab`,
      `${beforeRetry} -> ${t.length}`);
    check(hosts.length === 0, `retry #${i}: ZERO consent-host tabs`);
  }

  console.log('\n================ RESULT ================');
  if (fail.length === 0) console.log('ALL CHECKS PASSED - the Alert never took a tab, on any path.');
  else {
    console.log(`${fail.length} CHECK(S) FAILED:`);
    fail.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail.length === 0 ? 0 : 1);
})();
