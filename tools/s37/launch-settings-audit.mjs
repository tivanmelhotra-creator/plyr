/**
 * Owner brief 3 "Launch Settings audit", against the REAL app on :3000 with REAL Chromium.
 * For each case: POST /profiles/:id/open { launch } (exactly what the panel sends), then read
 *   - the argv Chromium really received (/proc/<pid>/cmdline of the browser process),
 *   - the window geometry (xdotool / wmctrl on the app's display),
 *   - chrome://version "Command Line" through CDP of the running context is not reachable from here,
 *     so the argv from /proc is the ground truth (it is what chrome://version prints).
 * Also: does a RUN (pipeline) on the same profile use the profile's launch settings? (/run with profileId)
 * And: is anything stored per profile? (registry entry before/after)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const B = 'http://127.0.0.1:3000';
const DATA = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch {} return { s: r.status, d }; };
const procs = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => { try { return { pid: Number(p), a: fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').filter(Boolean), env: fs.readFileSync(`/proc/${p}/environ`, 'utf8') }; } catch { return null; } })
  .filter((x) => x && x.a.some((y) => y.startsWith('--user-data-dir=' + DATA)) && !x.a.some((y) => y.startsWith('--type=')));
const display = (p) => (/(?:^|\0)DISPLAY=([^\0]*)/.exec(p.env) || [])[1];
function geometry(p) {
  try {
    const env = { ...process.env, DISPLAY: display(p) };
    const rows = execFileSync('wmctrl', ['-l', '-p', '-G'], { env }).toString().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/));
    const mine = rows.filter((c) => Number(c[2]) === p.pid).map((c) => ({ x: +c[3], y: +c[4], w: +c[5], h: +c[6], title: c.slice(8).join(' ') }));
    const screen = execFileSync('xdpyinfo', [], { env }).toString().match(/dimensions:\s+(\d+x\d+)/)?.[1];
    return { screen, windows: mine };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}
const waitProc = async () => { for (let i = 0; i < 100; i++) { const p = procs(); if (p.length) return p[0]; await sleep(200); } return null; };
const waitGone = async () => { for (let i = 0; i < 100 && procs().length; i++) await sleep(200); };
const out = { cases: [] };
const prf = (await j('POST', '/profiles', { name: 'Audit', branchId: 'new' })).d.profile;
const regBefore = fs.readFileSync(path.join(DATA, 'profiles/local/branches.json'), 'utf8');
const CASES = [
  ['none (panel untouched: launch not sent)', undefined],
  ['preset standard', { preset: 'standard' }],
  ['standard, Start maximized OFF', { preset: 'standard', options: { 'start-maximized': false } }],
  ['preset automation', { preset: 'automation' }],
  ['preset diagnostics', { preset: 'diagnostics' }],
  ['custom --window-size=900,600 (maximized off)', { preset: 'standard', options: { 'start-maximized': false }, customFlags: '--window-size=900,600' }],
  ['custom --lang=fa --mute-audio', { preset: 'standard', customFlags: '--lang=fa\n--mute-audio' }],
  ['custom --user-agent (risky, no ack)', { preset: 'standard', customFlags: '--user-agent=AuditUA/1.0' }],
  ['custom --user-agent (risky, ack)', { preset: 'standard', customFlags: '--user-agent=AuditUA/1.0', acknowledgeRisk: true }],
  ['forbidden --user-data-dir=/tmp/x', { preset: 'standard', customFlags: '--user-data-dir=/tmp/x' }],
  ['forbidden --headless', { preset: 'standard', customFlags: '--headless' }],
];
for (const [name, launch] of CASES) {
  const r = await j('POST', `/profiles/${prf.id}/open`, { workflowId: 'wf_audit', launch });
  const c = { name, sent: launch ?? null, status: r.s, code: r.d?.code, error: r.d?.error?.slice(0, 160), serverArgs: r.d?.launch?.args, settingsApplied: r.d?.settingsApplied };
  if (r.s === 200) {
    const p = await waitProc();
    await sleep(2500);
    c.argv = p ? p.a.slice(1).filter((x) => !x.startsWith('--user-data-dir=') && x !== 'about:blank' && !x.startsWith('--remote-debugging')) : null;
    c.geometry = p ? geometry(p) : null;
    if (launch?.customFlags?.includes('user-agent')) {
      // what the page actually sees
      const ua = await j('GET', '/browser/sessions');
      c.note = 'see uaSeen';
    }
    await j('POST', `/profiles/${prf.id}/close`, { workflowId: 'wf_audit' });
    await waitGone();
  }
  out.cases.push(c);
  console.log(JSON.stringify(c));
}
// Reuse: open once with standard, then ask for automation while the browser is open and used by nobody else.
await j('POST', `/profiles/${prf.id}/open`, { workflowId: 'wf_audit' }); const p1 = await waitProc();
const re = await j('POST', `/profiles/${prf.id}/open`, { workflowId: 'wf_audit', launch: { preset: 'automation' } }); await sleep(1500); const p2 = await waitProc();
out.reopenWithOtherSettings = { status: re.s, relaunched: re.d?.relaunched, settingsApplied: re.d?.settingsApplied, pidBefore: p1?.pid, pidAfter: p2?.pid, argvAfterHasAutomationFlags: !!p2?.a.includes('--disable-renderer-backgrounding') };
console.log('REOPEN ' + JSON.stringify(out.reopenWithOtherSettings));
await j('POST', `/profiles/${prf.id}/close`, { workflowId: 'wf_audit' }); await waitGone();
await j('POST', `/profiles/${prf.id}/release`, { workflowId: 'wf_audit' });
// Is anything stored per profile?
const regAfter = fs.readFileSync(path.join(DATA, 'profiles/local/branches.json'), 'utf8');
out.storedPerProfile = { registryMentionsLaunch: /launch|preset|customFlags/i.test(regAfter), registryChangedOtherThanTimestamps: regBefore.replace(/"\w+At": "[^"]+"/g, '') !== regAfter.replace(/"\w+At": "[^"]+"/g, '').replace(/,\s*"lastOpenError": null/g, '') };
console.log('STORED ' + JSON.stringify(out.storedPerProfile));
// A RUN on this profile: which argv?
const run = await j('POST', '/run', { userId: 'local', origin: 'manual', profileId: prf.id, steps: [{ action: 'goto', params: { url: 'data:text/html,<title>audit</title>ok' } }, { action: 'wait', params: { ms: 3000 } }] });
const rp = await waitProc();
out.run = { status: run.s, jobId: run.d?.jobId, argv: rp ? rp.a.slice(1).filter((x) => !x.startsWith('--user-data-dir=') && x !== 'about:blank' && !x.startsWith('--remote-debugging')) : null, headless: rp ? rp.a.some((x) => x.startsWith('--headless')) : null };
console.log('RUN ' + JSON.stringify(out.run));
for (let i = 0; i < 40; i++) { const s = (await j('GET', `/job/local/${run.d?.jobId}`)).d; const st = s?.job?.state || s?.state; if (['completed', 'failed'].includes(st)) { out.run.state = st; break; } await sleep(500); }
console.log('RUNSTATE ' + out.run.state);
fs.writeFileSync(path.join(DATA, 'launch-audit.json'), JSON.stringify(out, null, 1));
