/**
 * THE PAGE LIFECYCLE, MEASURED STAGE BY STAGE IN A REAL CHROME.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator asked for exactly this, and asked for it as a NUMBER rather than
 * an argument:
 *
 *   «تست‌ها را اجرا کن و تعداد واقعی page را قبل و بعد از هر عملیات گزارش کن
 *    برای حداقل: launch, Picker #1, Picker #2, Picker #3, Retry #1, Retry #2»
 *
 *   for each stage: total pages, page URLs, newly-created pages, closed pages,
 *   active page
 *
 * and then, after choosing the <dialog> design:
 *
 *   launch  → number of pages / URLs / restored pages
 *   Picker×3 → page count unchanged, no new alert page, only ONE dialog exists
 *   Retry×3  → page count unchanged, same target reused, previous dialog replaced
 *
 * They also said, twice, that grep is not evidence: «این موارد را واقعاً تست
 * کن، نه فقط با grep». So every number below is read out of a live browser.
 *
 * IDENTITY, NOT COUNTING
 * ----------------------
 * Pages are tracked by CDP TARGET ID, not by index or URL. That matters because
 * the defect being ruled out is "a page was created and another closed, leaving
 * the count the same" — which a total alone cannot see. Diffing id sets makes
 * created and closed pages separately visible.
 *
 * HOW THE DIALOG IS COUNTED THROUGH A CLOSED SHADOW ROOT
 * ------------------------------------------------------
 * `consent.js` attaches its shadow root with `mode:'closed'`, so `e.shadowRoot`
 * is null from outside and page-level script cannot enumerate its contents.
 * That is a deliberate security property and is not being weakened for a test.
 * Two readings are taken instead, and they answer different questions:
 *
 *   1. `mark()` mirrors the census onto the HOST element as `data-ab-dialogs` /
 *      `data-ab-open`. Cheap, and enough to catch STACKING.
 *   2. `DOM.getDocument({ pierce: true })` — a BROWSER-level CDP capability,
 *      not a page one — crosses the closed root and yields the dialog's actual
 *      text. Only the text can distinguish "replaced" from "never updated",
 *      and the requirement is specifically
 *      `Alert 1 → Picker ran again → Alert 1 removed/replaced → Alert 2`.
 *
 * Run: node tools/probe-page-lifecycle.mjs
 * Requires: server on :3000, REAL_CHROME_DEBUG_PORT=9222.
 */
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3000';
const CDP = 'http://127.0.0.1:9222';
const H = { 'Content-Type': 'application/json', 'X-API-Key': 'admin123' };

/**
 * THE INJECTABLE SURFACE, AND WHY IT IS THE DASHBOARD AND NOT consent-host.
 *
 * The first run of this probe reported `dialogs=0` at every stage and PASSED
 * anyway, because every dialog check was `<= 1` and zero satisfies that
 * vacuously. The cause was not the code under test: the window held only
 * `about:blank`, Chrome injects no content script there, so `consent.js` never
 * ran and there was nothing that COULD have drawn a dialog. The page-count half
 * of the verification was real; the singleton-dialog half was measuring nothing.
 *
 * The fix is to give the window a page the manifest actually matches. The
 * tempting choice — `/inspector/consent-host` — would have quietly destroyed
 * the other half of this probe, because `consent-host === 0` is itself one of
 * the things being asserted («No dedicated consent-host Alert Tab created»). A
 * probe that opens the very page it checks for cannot tell a leak from its own
 * fixture, and the honest response is to change the fixture rather than to
 * relax the check.
 *
 * So the surface is the DASHBOARD, `/`. It is http, so the content script runs;
 * it is not consent-host, so that check keeps its full meaning; and it is a
 * NORMAL operator page, which makes it simultaneously the subject of
 * «Google (or any page) must not be navigated/hijacked» — the Alert has to
 * appear over it without moving it.
 */
const SURFACE = `${BASE}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  try {
    const r = await fetch(BASE + path, {
      method: 'POST', headers: H, body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: { error: String(e.message || e) } };
  }
}

async function pages() {
  try {
    const r = await fetch(`${CDP}/json/list`);
    const all = await r.json().catch(() => []);
    return all.filter((t) => t.type === 'page').map((t) => ({
      id: t.id, url: t.url, ws: t.webSocketDebuggerUrl,
    }));
  } catch {
    return [];
  }
}

/**
 * Evaluate an expression in a page over raw CDP.
 *
 * Playwright is not used here on purpose: attaching Playwright to the live
 * browser would itself be a client that can create pages, and the thing being
 * measured is how many pages exist. A bare WebSocket cannot perturb the count.
 */
function evaluate(wsUrl, expression, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(wsUrl);
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => finish(null), timeout);
    ws.on('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    })));
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id === 1) { clearTimeout(timer); finish(msg.result?.result?.value ?? null); }
    });
    ws.on('error', () => { clearTimeout(timer); finish(null); });
  });
}

/** Several CDP calls on one socket, for the piercing DOM read below. */
function cdpCalls(wsUrl, calls, timeout = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const out = {};
    let seen = 0; let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(out); } };
    const timer = setTimeout(finish, timeout);
    ws.on('open', () => calls.forEach((c, i) => ws.send(JSON.stringify({
      id: i + 1, method: c.method, params: c.params || {},
    }))));
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg.id) return;
      out[msg.id] = msg;
      seen++;
      if (seen >= calls.length) { clearTimeout(timer); finish(); }
    });
    ws.on('error', () => { clearTimeout(timer); finish(); });
  });
}

/**
 * Raise a REAL consent prompt, the way the picker does.
 *
 * This exists because `POST /browser/real/open` alone proves only that no page
 * appears — it raises no question, so no dialog is ever drawn and every dialog
 * assertion passes on an empty browser. The prompt has to come from the same
 * route the dashboard's picker calls, `POST /inspector/targeting/begin`, so
 * what is measured is the real delivery path: server mints → extension polls
 * `GET /inspector/consent?environment=local` → `consent.js` renders.
 *
 * Two constraints learned by measurement, both load-bearing:
 *
 *  - `fieldKey` must be DECLARED by the action or the route answers 400
 *    `undeclared_field`. Hence real click-action fields below.
 *  - the same field asked twice REFRESHES its prompt instead of minting a
 *    second one (RemoteTargetConsent keys pending prompts on the pairing key).
 *    So each pick uses a DIFFERENT node, which is what makes the no-stacking
 *    check meaningful: several genuinely distinct questions end up pending on
 *    the server at once, and the browser must still show exactly one.
 */
async function raisePrompt(nodeId, fieldKey, label) {
  const res = await post('/inspector/targeting/begin', {
    environment: 'local', nodeId, fieldKey, action: 'click', workflowId: 'wf-probe', label,
  });
  const consent = res.body?.consent || null;
  return { consentId: consent?.consentId || null, status: res.status };
}

/** How many prompts the SERVER holds — the number the browser must NOT mirror. */
async function pendingOnServer() {
  try {
    const r = await fetch(`${BASE}/inspector/consent?environment=local`, { headers: H });
    const b = await r.json().catch(() => null);
    return b?.count ?? -1;
  } catch {
    return -1;
  }
}

/** Which page the operator is actually looking at, asked of the pages. */
async function activePage(list) {
  for (const p of list) {
    if (!p.ws) continue;
    const vis = await evaluate(p.ws, 'document.visibilityState');
    if (vis === 'visible') return p;
  }
  return null;
}

/**
 * The dialog census, read off the host element's mirrored attributes.
 * Summed across pages: more than one open dialog ANYWHERE is a stacking bug,
 * even if each individual page holds only one.
 */
async function dialogCensus(list) {
  let hosts = 0; let dialogs = 0; let open = 0;
  for (const p of list) {
    if (!p.ws || !/^https?:/i.test(p.url)) continue;
    const got = await evaluate(p.ws, `(() => {
      const h = document.getElementById('ab-consent-host');
      if (!h) return JSON.stringify({ host: 0, dialogs: 0, open: 0 });
      return JSON.stringify({
        host: 1,
        dialogs: Number(h.getAttribute('data-ab-dialogs') || 0),
        open: Number(h.getAttribute('data-ab-open') || 0),
      });
    })()`);
    if (!got) continue;
    try {
      const o = JSON.parse(got);
      hosts += o.host; dialogs += o.dialogs; open += o.open;
    } catch { /* unparseable is not a census */ }
  }
  return { hosts, dialogs, open };
}

/**
 * Read the dialog THROUGH the closed shadow root, and report its TEXT.
 *
 * `mark()`'s attributes say how many dialogs exist, which catches stacking but
 * not the subtler failure: one dialog still showing the SUPERSEDED question.
 * Only the rendered text separates "replaced" from "never updated".
 */
async function dialogDetail(list) {
  const found = [];
  for (const p of list) {
    if (!p.ws || !/^https?:/i.test(p.url)) continue;
    const res = await cdpCalls(p.ws, [
      { method: 'DOM.getDocument', params: { depth: -1, pierce: true } },
    ]);
    const root = res[1]?.result?.root;
    if (!root) continue;

    const dialogs = [];
    (function walk(n) {
      if (!n) return;
      if (n.localName === 'dialog') dialogs.push(n);
      (n.children || []).forEach(walk);
      (n.shadowRoots || []).forEach(walk);
      if (n.contentDocument) walk(n.contentDocument);
    })(root);

    for (const d of dialogs) {
      const attrs = {};
      for (let i = 0; d.attributes && i < d.attributes.length; i += 2) {
        attrs[d.attributes[i]] = d.attributes[i + 1];
      }
      let text = '';
      (function collect(n) {
        if (!n) return;
        if (n.nodeType === 3) text += ` ${n.nodeValue || ''}`;
        (n.children || []).forEach(collect);
        (n.shadowRoots || []).forEach(collect);
      })(d);
      found.push({ page: p.url, open: 'open' in attrs, text: text.replace(/\s+/g, ' ').trim() });
    }
  }
  return found;
}

const stages = [];
const fail = [];
function check(cond, label, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) fail.push(label);
}

/** Record one stage against the previous, and print the operator's table row. */
async function record(name, prev) {
  const list = await pages();
  const ids = new Set(list.map((p) => p.id));
  const prevIds = new Set((prev?.list || []).map((p) => p.id));

  const created = list.filter((p) => !prevIds.has(p.id));
  const closed = (prev?.list || []).filter((p) => !ids.has(p.id));
  const active = await activePage(list);
  const census = await dialogCensus(list);
  const detail = await dialogDetail(list);
  const pending = await pendingOnServer();

  const blanks = list.filter((p) => p.url === 'about:blank').length;
  const hostPages = list.filter((p) => /consent-host/.test(p.url)).length;

  const st = {
    name, list, created, closed, active, census, detail, pending,
    total: list.length, blanks, hostPages,
  };
  stages.push(st);

  console.log(`\n--- ${name} ---`);
  console.log(`  total=${st.total}  new=${created.length}  closed=${closed.length}  `
    + `about:blank=${blanks}  consent-host=${hostPages}`);
  console.log(`  dialogs: hosts=${census.hosts} mirrored=${census.dialogs} open=${census.open}`
    + `  pierced=${detail.length}  pendingOnServer=${pending}`);
  detail.forEach((d, i) => console.log(`    dialog[${i}] open=${d.open} "${d.text.slice(0, 100)}"`));
  console.log(`  active: ${active ? active.url.slice(0, 60) : '(none visible)'}`);
  list.forEach((p, i) => {
    const flags = [
      created.some((c) => c.id === p.id) ? 'NEW' : '',
      active && active.id === p.id ? 'ACTIVE' : '',
    ].filter(Boolean).join(',');
    console.log(`    [${i}] ${p.url.slice(0, 72)}${flags ? `   <${flags}>` : ''}`);
  });
  if (closed.length) closed.forEach((c) => console.log(`    CLOSED: ${c.url.slice(0, 60)}`));
  return st;
}

(async () => {
  console.log('=== 0. is the browser reachable? ===');
  const ver = await fetch(`${CDP}/json/version`).then((r) => r.json()).catch(() => null);
  if (!ver) {
    console.log('  CDP unreachable — start the server with REAL_CHROME_DEBUG_PORT=9222.');
    process.exit(2);
  }
  console.log(`  ${ver.Browser}  protocol ${ver['Protocol-Version']}`);

  // LAUNCH. The route is idempotent, so the first call is what brings Chrome up
  // on a cold start; the numbers recorded here are the post-launch state that
  // the report was actually about («حتی قبل از استفاده از Picker»).
  let boot = await post('/browser/real/open', {});
  for (let i = 0; i < 4 && boot.body?.error === 'remote_browser_starting'; i++) {
    console.log('  browser still starting, waiting…');
    await sleep(12000);
    boot = await post('/browser/real/open', {});
  }
  await sleep(2500);
  const atBoot = await record('launch', null);

  check(atBoot.blanks <= 1, 'launch: at most ONE about:blank', `${atBoot.blanks} found`);
  check(atBoot.hostPages === 0, 'launch: ZERO consent-host pages', `${atBoot.hostPages} found`);
  check(atBoot.total >= 1, 'launch: at least one reusable page exists');
  check(atBoot.detail.length === 0, 'launch: no dialog before any pick',
    `${atBoot.detail.length} found`);

  // ── GIVE THE WINDOW AN INJECTABLE SURFACE ──────────────────────────────
  //
  // The EXISTING blank page is navigated rather than a new one opened, because
  // the operator's rule is that the window keeps its one reusable tab. Driven
  // through the same route the picker uses for an explicit url, so this step is
  // itself a test of «the explicit-url path reuses the blank page».
  const beforeSurface = atBoot.total;
  await post('/browser/real/open', { url: SURFACE });
  await sleep(4000);
  let prev = await record('surface', atBoot);
  check(prev.total === beforeSurface, 'surface: the blank page was REUSED, not added to',
    `${beforeSurface} -> ${prev.total}`);
  check(prev.hostPages === 0, 'surface: still ZERO consent-host pages');
  check(prev.list.some((p) => p.url.startsWith(SURFACE)),
    'surface: an injectable http page is open, so consent.js can run');

  const atLaunch = prev.total;
  const surfaceIds = new Set(prev.list.map((p) => p.id));
  const seenFields = [];

  // Each pick uses a DIFFERENT node on purpose: same-field picks refresh one
  // prompt, which would make "only one dialog" true for the wrong reason.
  const picks = [
    ['p1', 'selector', 'Probe One / selector'],
    ['p2', 'waitForSelector', 'Probe Two / waitForSelector'],
    ['p3', 'timeout', 'Probe Three / timeout'],
  ];

  for (let i = 1; i <= 3; i++) {
    const [node, field, label] = picks[i - 1];
    const raised = await raisePrompt(node, field, label);
    check(!!raised.consentId, `picker#${i}: a REAL consent was raised`,
      raised.consentId || `status ${raised.status}`);
    await post('/browser/real/open', {});
    await sleep(6500);
    const st = await record(`picker#${i}`, prev);

    check(st.created.length === 0, `picker#${i}: created NO page`, `${st.created.length} created`);
    check(st.closed.length === 0, `picker#${i}: closed NO page`, `${st.closed.length} closed`);
    check(st.hostPages === 0, `picker#${i}: no consent-host page`);
    check(st.total === atLaunch, `picker#${i}: page count unchanged`, `${atLaunch} -> ${st.total}`);

    // NOT `<= 1`. Zero satisfies that vacuously, and zero is exactly what the
    // first version of this probe reported while proving nothing.
    check(st.detail.length === 1, `picker#${i}: EXACTLY one dialog, drawn and pierced`,
      `${st.detail.length} found`);
    check(st.census.dialogs === 1, `picker#${i}: the host's own census agrees`,
      `mirrored=${st.census.dialogs}`);
    check(st.detail[0]?.open === true, `picker#${i}: that dialog is OPEN (showModal ran)`);

    const shown = st.detail[0]?.text || '';
    check(shown.includes(field), `picker#${i}: it shows THIS pick's field`, `expected "${field}"`);
    check(shown.includes('Allow') && shown.includes('Not now'),
      `picker#${i}: the custom Allow / Not now buttons survived`);

    // REPLACEMENT, not accumulation: every earlier question must be unreadable.
    for (const old of seenFields) {
      check(!shown.includes(old), `picker#${i}: the previous question ("${old}") is GONE`);
    }
    seenFields.push(field);

    // The server holds several distinct prompts by now. That the browser shows
    // ONE is the point — a mirror would show as many as are pending.
    if (i >= 2) {
      check(st.pending >= 2, `picker#${i}: server holds ${st.pending} prompts, browser shows 1`);
    }
    prev = st;
  }

  for (let i = 1; i <= 3; i++) {
    // Retry is the same Alert implementation with mayOpenTab:false — it must
    // not open a tab in the operator's browser NOR a page in the server's, and
    // it must re-ask the LAST target rather than minting a new one.
    await post('/browser/real/open', { noTab: true });
    await sleep(3000);
    const st = await record(`retry#${i}`, prev);

    check(st.created.length === 0, `retry#${i}: created NO page`, `${st.created.length} created`);
    check(st.closed.length === 0, `retry#${i}: closed NO page`, `${st.closed.length} closed`);
    check(st.hostPages === 0, `retry#${i}: no consent-host page`);
    check(st.total === atLaunch, `retry#${i}: page count unchanged`, `${atLaunch} -> ${st.total}`);
    check(st.detail.length === 1, `retry#${i}: still EXACTLY one dialog`,
      `${st.detail.length} found`);

    // AC13: Retry repeats the LAST pick. The dialog must still name the third
    // pick's field, not drift to an earlier one.
    const shown = st.detail[0]?.text || '';
    const last = seenFields[seenFields.length - 1];
    check(shown.includes(last), `retry#${i}: same target reused ("${last}")`);
    for (const old of seenFields.slice(0, -1)) {
      check(!shown.includes(old), `retry#${i}: no earlier question reappeared ("${old}")`);
    }
    prev = st;
  }

  console.log('\n================ THE TABLE ================');
  console.log('stage        total  new  closed  blank  consent-host  dialogs  open');
  for (const s of stages) {
    console.log(
      `${s.name.padEnd(12)} ${String(s.total).padStart(5)} `
      + `${String(s.created.length).padStart(4)} ${String(s.closed.length).padStart(7)} `
      + `${String(s.blanks).padStart(6)} ${String(s.hostPages).padStart(13)} `
      + `${String(s.detail.length).padStart(8)} ${String(s.census.open).padStart(5)}`,
    );
  }

  // Cross-stage verdicts: the properties no single stage can establish.
  const afterSurface = stages.filter((s) => s.name !== 'launch');
  const totals = afterSurface.map((s) => s.total);
  check(new Set(totals).size === 1, 'the page count NEVER changed across every picker/retry stage',
    `totals: ${totals.join(', ')}`);
  check(stages.every((s) => s.hostPages === 0), 'no consent-host page existed at ANY stage');
  check(afterSurface.slice(1).every((s) => s.created.length === 0),
    'no operation after the surface opened created a page');
  check(stages.every((s) => s.detail.length <= 1), 'never more than one dialog, at any stage');
  check(afterSurface.slice(1).every((s) => s.detail.length === 1),
    'from the first pick onward there was ALWAYS exactly one dialog');

  // AC9: the operator's page was overlaid, never navigated away.
  const stillThere = stages[stages.length - 1].list
    .filter((p) => surfaceIds.has(p.id) && p.url.startsWith(SURFACE)).length;
  check(stillThere >= 1, 'the operator page was overlaid, NOT navigated or hijacked',
    `${stillThere} still on ${SURFACE}`);

  console.log('\n================ RESULT ================');
  if (fail.length === 0) {
    console.log('ALL CHECKS PASSED — one browser, one reusable page, no Alert page, one dialog.');
  } else {
    console.log(`${fail.length} CHECK(S) FAILED:`);
    fail.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail.length === 0 ? 0 : 1);
})();
