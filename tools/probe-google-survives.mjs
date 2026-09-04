/**
 * THE REPORTED DEFECT, REPRODUCED AND MEASURED AGAINST THE REAL SERVER.
 *
 *   Tab1 → Alert, Tab2 → Alert, Tab3 → Alert, then the operator opens
 *   Tab4 → Google. Running the Picker again made GOOGLE DISAPPEAR and
 *   become an Alert.
 *
 * The operator's tabs are opened over CDP, because that is what an operator
 * genuinely does — the server has no "open me a tab" endpoint, and inventing
 * one would test the server's own allocator instead of the real situation.
 *
 * Then the Picker route (`/browser/real/open`, the ONLY caller of the fixed
 * code) is driven six times, and after each call this asserts:
 *
 *   · every operator tab still holds its ORIGINAL url   (zero overwrite)
 *   · no tab vanished                                   (zero close)
 *   · no tab appeared                                    (zero new tabs)
 *
 * Tabs are matched by CDP target id AND url, so an overwrite cannot hide
 * behind a matching count — which is precisely how the old code failed.
 *
 * Run: node probe-google-survives.mjs
 */
const BASE = 'http://127.0.0.1:3000';
const CDP = 'http://127.0.0.1:9222';
const KEY = 'admin123';
const H = { 'Content-Type': 'application/json', 'X-API-Key': KEY };

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
async function openTab(url) {
  await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
}

const fail = [];
function check(cond, label, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) fail.push(label);
}

(async () => {
  console.log('\n=== 1. the operator builds their own tabs, incl. GOOGLE ===');
  // Real http(s) pages, so content/consent.js is genuinely injected in each —
  // which is what makes the overlay path (PRIORITY 1) reachable at all.
  for (const url of [
    'https://example.com/',
    'https://example.org/',
    'https://www.iana.org/help/example-domains',
    'https://www.google.com/',
  ]) {
    await openTab(url);
    console.log(`  opened ${url}`);
  }

  const before = await tabs();
  console.log(`\n  tabs now: ${before.length}`);
  before.forEach((t, i) => console.log(`    [${i}] ${t.url.slice(0, 72)}`));

  const googleBefore = before.filter((t) => /google\./i.test(t.url));
  check(googleBefore.length > 0, 'a Google tab exists to be protected',
    `${googleBefore.length} found`);
  if (googleBefore.length === 0) {
    console.log('\nCannot verify the defect without a Google tab. Stopping.');
    process.exit(1);
  }

  const idUrl = new Map(before.map((t) => [t.id, t.url]));

  console.log('\n=== 2. run the PICKER SIX TIMES (the defect trigger) ===');
  for (let i = 1; i <= 6; i += 1) {
    const r = await post('/browser/real/open', {});
    await new Promise((res) => setTimeout(res, 1500));
    const now = await tabs();

    const intact = [...idUrl.entries()].filter(([id, url]) => {
      const t = now.find((x) => x.id === id);
      return t && t.url === url;
    }).length;
    const google = now.filter((t) => /google\./i.test(t.url)).length;

    console.log(
      `\n  picker #${i}: http=${r.status} tabs=${now.length} `
      + `intact=${intact}/${idUrl.size} google=${google}`,
    );
    if (now.length !== before.length || intact !== idUrl.size) {
      now.forEach((t, j) => console.log(`      [${j}] ${t.url.slice(0, 72)}`));
    }

    check(google === googleBefore.length, `picker #${i}: GOOGLE SURVIVED`);
    check(intact === idUrl.size, `picker #${i}: every operator tab kept its url`,
      `${intact}/${idUrl.size}`);
    check(now.length === before.length, `picker #${i}: created no tab`,
      `${before.length} -> ${now.length}`);
  }

  console.log('\n=== 3. the Alert exists as a consent request (drawn as an overlay) ===');
  const c = await fetch(`${BASE}/inspector/consent?environment=local`, { headers: H });
  const cb = await c.json().catch(() => null);
  const reqs = (cb && cb.requests) || [];
  console.log(`  GET /inspector/consent -> ${c.status}, ${reqs.length} request(s)`);

  console.log('\n================ RESULT ================');
  if (fail.length === 0) {
    console.log('ALL CHECKS PASSED - zero new tabs, zero closes, Google untouched.');
  } else {
    console.log(`${fail.length} CHECK(S) FAILED:`);
    fail.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail.length === 0 ? 0 : 1);
})();
