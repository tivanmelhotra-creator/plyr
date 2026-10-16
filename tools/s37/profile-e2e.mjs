/**
 * Owner brief 2.3 end to end against the REAL app on :3000 (tools/s35/start-server.sh <tree> <data>),
 * with REAL Chromium, driven through the REAL panel script (/js/profile-manager.js served by the app)
 * in a second Chromium (the operator's browser).
 *
 * Phase 1 (node tools/s37/profile-e2e.mjs phase1 <data>):
 *   a. invalid name -> plain error, nothing created
 *   b. create "E2E One" in a NEW branch through the panel's New profile form -> it opens automatically
 *      (real Chromium, --user-data-dir=<branch root> --profile-directory=<folder>)
 *   c. close (panel Stop), reopen (Play) -> same root/folder, one process
 *   d. create "E2E Two" in the EXISTING branch -> branch busy -> the G.2 alert, NOT a second browser; close One, Play Two
 *   e. rename One -> "E2E Uno" (while closed); rename Two while RUNNING
 *   f. a launch that FAILS (branch root replaced by a file): the profile stays, plain error line, Play again works
 *      after the root is restored
 *   g. create "E2E Three" (new branch), delete it -> gone from list, registry and disk
 *   -> writes <data>/e2e-state.json
 * Phase 2 (after tools/s37/restart-server.sh, node tools/s37/profile-e2e.mjs phase2 <data>):
 *   everything from phase 1 is still there (names, branches, folders, deleted stays deleted), and opens again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const B = 'http://127.0.0.1:3000';
const [phase, DATA] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch {} return { s: r.status, d }; };
const browsers = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => { try { return { pid: Number(p), a: fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0') }; } catch { return null; } })
  .filter((x) => x && x.a.some((y) => y.startsWith('--user-data-dir=' + DATA)) && !x.a.some((y) => y.startsWith('--type=')))
  .map((x) => ({ pid: x.pid, udd: x.a.find((y) => y.startsWith('--user-data-dir=')).slice(16), pd: (x.a.find((y) => y.startsWith('--profile-directory=')) || '').slice(20) || '(none)' }));
const out = { phase, steps: [] };
const step = (name, ok, detail) => { out.steps.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`); };
const list = async () => (await j('GET', '/profiles?workflowId=wf_e2e')).d.profiles;
const folderOf = (id) => (registry().profiles.find((p) => p.id === id) || {}).folder || null;
const byName = async (n) => { const p = (await list()).find((x) => x.name === n); return p ? { ...p, folder: folderOf(p.id) } : p; };
const registry = () => JSON.parse(fs.readFileSync(path.join(DATA, 'profiles', 'local', 'branches.json'), 'utf8'));
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
// The viewer page itself is not under test here (VNC); a stand-in records which profile it was pointed at.
await ctx.route('**/desktop/chrome**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>viewer</title>' }));
const page = await ctx.newPage();
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.type()); void d.dismiss(); });
await page.goto(B + '/health');
await page.evaluate(() => { window.AppUtil = { t: (k) => k, toast: () => {} }; window.API = { getKey: () => '' }; document.body.innerHTML = '<div id="host"></div>'; });
for (const f of ['/js/i18n.js', '/js/icons.js', '/js/profile-manager.js']) await page.addScriptTag({ url: B + f });
const notes = [];
await page.exposeFunction('__say', (t, e) => notes.push({ t, e }));
await page.evaluate(() => { window.__pm = window.ProfileManager.mount(document.getElementById('host'), { workflowId: 'wf_e2e', launchSettings: false, onSay: (t, e) => window.__say(t, !!e) }); });
const idle = () => page.waitForFunction(() => !window.__pm.state.busy, null, { timeout: 60000 });
const refresh = async () => { await page.evaluate(() => window.__pm.refresh()); };
const lastNote = () => notes[notes.length - 1] || null;

async function createViaForm(name, branchValue) {
  await page.click('.pm-new');
  await page.fill('.pm-input', name);
  if (branchValue) await page.selectOption('.pm-branch-select', branchValue);
  await page.click('.pm-form-ok');
  await idle();
  await sleep(500);
}
const row = (id) => `.pm-row[data-id="${id}"]`;

if (phase === 'phase1') {
  // a. invalid name
  const bad = await j('POST', '/profiles', { name: '   ', branchId: 'new' });
  step('a invalid name -> plain error, nothing created', bad.s >= 400 && (await list()).length === 0 && registry().branches?.length !== undefined ? true : bad.s >= 400 && (await list()).length === 0, { status: bad.s, error: bad.d?.error });

  // b. create in a NEW branch through the form -> opens automatically
  await createViaForm('E2E One', 'new');
  const one = await byName('E2E One');
  const b1 = browsers();
  step('b create in NEW branch -> opened automatically (real Chromium, branch root + --profile-directory)', one && one.browser.open && b1.length === 1 && b1[0].pd === one.folder,
    { id: one?.id, branchId: one?.branchId, folder: one?.folder, chromium: b1, note: lastNote() });
  const root1 = b1[0]?.udd;
  out.one = { id: one?.id, branchId: one?.branchId, folder: one?.folder, root: root1 };

  // c. close (row Stop), reopen (Play)
  await refresh();
  await page.click(`${row(one.id)} .pm-stop`); await idle();
  const closed = await waitFor(() => browsers().length === 0);
  await refresh();
  const hasPlay = await page.locator(`${row(one.id)} .pm-play`).count();
  await page.click(`${row(one.id)} .pm-play`); await idle();
  const b2 = await waitFor(() => { const b = browsers(); return b.length ? b : null; });
  step('c close then reopen -> same root and folder, one process', closed && hasPlay === 1 && b2 && b2.length === 1 && b2[0].udd === root1 && b2[0].pd === one.folder, { afterClose: closed, reopened: b2 });

  // d. create in the EXISTING branch while One runs
  await createViaForm('E2E Two', one.branchId);
  const two = await byName('E2E Two');
  await sleep(800);
  const alertShown = await page.locator('.pm-manual-alert:not([hidden])').count();
  const b3 = browsers();
  step('d create in EXISTING branch while another runs -> kept, G.2 alert, no second browser', two && two.branchId === one.branchId && alertShown === 1 && b3.length === 1 && dialogs.length === 0,
    { id: two?.id, branchId: two?.branchId, folder: two?.folder, alertShown, chromium: b3, note: lastNote() });
  await page.click('.pm-manual-cancel');
  await refresh();
  await page.click(`${row(one.id)} .pm-stop`); await idle();
  await waitFor(() => browsers().length === 0);
  await refresh();
  await page.click(`${row(two.id)} .pm-play`); await idle();
  const b4 = await waitFor(() => { const b = browsers(); return b.length ? b : null; });
  step('d2 One closed, Play Two -> Two runs in the same branch root with its own folder', b4 && b4.length === 1 && b4[0].udd === root1 && b4[0].pd === two.folder, { chromium: b4 });
  out.two = { id: two?.id, folder: two?.folder };

  // e. rename One (closed) and Two (running)
  const r1 = await j('PATCH', `/profiles/${one.id}`, { name: 'E2E Uno' });
  const r2 = await j('PATCH', `/profiles/${two.id}`, { name: 'E2E Dos' });
  await refresh();
  const names = await page.$$eval('.pm-row .pm-name', (n) => n.map((x) => x.textContent));
  step('e rename closed + running profile -> ids stable, list shows new names, Two still running', r1.s === 200 && r2.s === 200 && names.includes('E2E Uno') && names.includes('E2E Dos') && browsers().length === 1,
    { r1: r1.s, r2: r2.s, names, chromium: browsers() });
  await j('POST', `/profiles/${two.id}/close`, { workflowId: 'wf_e2e' });
  await waitFor(() => browsers().length === 0);

  // f. a launch that fails: branch root replaced by a file
  await createViaForm('E2E Fail', 'new');
  const fl = await byName('E2E Fail');
  const flRoot = browsers()[0]?.udd || null;
  await j('POST', `/profiles/${fl.id}/close`, { workflowId: 'wf_e2e' });
  await waitFor(() => browsers().length === 0);
  const regRoot = registry().branches.find((b) => b.id === fl.branchId)?.root;
  fs.renameSync(regRoot, regRoot + '.moved'); fs.writeFileSync(regRoot, 'not a directory');
  await refresh();
  notes.length = 0;
  await page.click(`${row(fl.id)} .pm-play`); await idle();
  await refresh();
  const flAfter = await byName('E2E Fail');
  const rowText = await page.locator(row(fl.id)).innerText();
  const playBack = await page.locator(`${row(fl.id)} .pm-play`).count();
  step('f failed launch -> profile kept, plain error line on the row and in the note, Play still there', flAfter && !flAfter.browser.open && flAfter.lastOpenError && rowText.includes('Last open failed') && playBack === 1 && notes.some((n) => n.e),
    { lastOpenError: flAfter?.lastOpenError?.message, rowText: rowText.replace(/\s+/g, ' ').slice(0, 200), note: notes.find((n) => n.e) });
  fs.rmSync(regRoot); fs.renameSync(regRoot + '.moved', regRoot);
  await page.click(`${row(fl.id)} .pm-play`); await idle();
  const b5 = await waitFor(() => { const b = browsers(); return b.length ? b : null; });
  await refresh();
  const flOk = await byName('E2E Fail');
  step('f2 root restored, Play again -> opens, error line cleared', b5 && b5.length === 1 && flOk.browser.open && !flOk.lastOpenError, { chromium: b5, lastOpenError: flOk.lastOpenError });
  await j('POST', `/profiles/${fl.id}/close`, { workflowId: 'wf_e2e' });
  await waitFor(() => browsers().length === 0);
  out.fail = { id: fl.id, root: regRoot, flRootSeen: flRoot };

  // g. create + delete
  await createViaForm('E2E Three', 'new');
  const th = await byName('E2E Three');
  await j('POST', `/profiles/${th.id}/close`, { workflowId: 'wf_e2e' });
  await j('POST', `/profiles/${th.id}/release`, { workflowId: 'wf_e2e' });
  await waitFor(() => browsers().length === 0);
  const thRoot = registry().branches.find((b) => b.id === th.branchId)?.root;
  const del = await j('DELETE', `/profiles/${th.id}`);
  const gone = !(await list()).some((p) => p.id === th.id) && !registry().profiles.some((p) => p.id === th.id) && !fs.existsSync(path.join(thRoot, th.folder));
  step('g delete profile -> gone from list, registry and disk', del.s === 200 && gone, { status: del.s, error: del.d?.error, folderExists: fs.existsSync(path.join(thRoot, th.folder)) });
  out.deleted = { id: th.id, root: thRoot, folder: th.folder };
  for (const p of await list()) await j('POST', `/profiles/${p.id}/release`, { workflowId: 'wf_e2e' });
  out.listBeforeRestart = (await list()).map((p) => ({ id: p.id, name: p.name, branchId: p.branchId, folder: folderOf(p.id) }));
  out.branchesBeforeRestart = (await j('GET', '/profiles/branches')).d.branches.map((b) => ({ id: b.id, label: b.label, profiles: b.profiles }));
  fs.writeFileSync(path.join(DATA, 'e2e-state.json'), JSON.stringify(out, null, 1));
} else {
  const prev = JSON.parse(fs.readFileSync(path.join(DATA, 'e2e-state.json'), 'utf8'));
  const now = (await list()).map((p) => ({ id: p.id, name: p.name, branchId: p.branchId, folder: folderOf(p.id) }));
  const brs = (await j('GET', '/profiles/branches')).d.branches.map((b) => ({ id: b.id, label: b.label, profiles: b.profiles }));
  step('r1 after restart: the same profiles (ids, names, branches)', JSON.stringify(now) === JSON.stringify(prev.listBeforeRestart), { before: prev.listBeforeRestart, after: now });
  step('r2 after restart: the same branches', JSON.stringify(brs) === JSON.stringify(prev.branchesBeforeRestart), { before: prev.branchesBeforeRestart, after: brs });
  step('r3 the deleted profile stays deleted', !now.some((p) => p.id === prev.deleted.id) && !fs.existsSync(path.join(prev.deleted.root, prev.deleted.folder)), prev.deleted);
  await refresh();
  const uno = now.find((p) => p.name === 'E2E Uno');
  await page.click(`${row(uno.id)} .pm-play`); await idle();
  const b = await waitFor(() => { const x = browsers(); return x.length ? x : null; });
  const cookiesDir = fs.existsSync(path.join(prev.one.root, prev.one.folder, 'Preferences'));
  step('r4 after restart: Play opens "E2E Uno" on the same root + folder as before', b && b.length === 1 && b[0].udd === prev.one.root && b[0].pd === prev.one.folder && cookiesDir, { chromium: b, expected: prev.one });
  await j('POST', `/profiles/${uno.id}/close`, { workflowId: 'wf_e2e' });
  await waitFor(() => browsers().length === 0);
  await j('POST', `/profiles/${uno.id}/release`, { workflowId: 'wf_e2e' });
}
step('no native dialogs', dialogs.length === 0, { dialogs });
const failed = out.steps.filter((s) => !s.ok).length;
console.log(`SUMMARY ${phase}: ${out.steps.length - failed} passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
