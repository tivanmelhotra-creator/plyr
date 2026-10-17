/**
 * Owner brief 2 / C + D against the REAL app on :3000 (tools/s35/start-server.sh).
 *  D. A workflow run with NO profile selected: POST /run (origin manual) with one
 *     goto step and no profileId. Report: job state, which --user-data-dir /
 *     --profile-directory the run's Chromium used (from /proc), and the folder on disk.
 *  C. Local Browser mode: POST /browser/real/open -> running? which user-data-dir?
 *     -> GET /browser/real/health -> POST /browser/real/close -> stopped? A second
 *     open reuses the same root (no new branch is created; GET /profiles/branches stays as before).
 */
import fs from 'node:fs';
const B = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); let d = null; try { d = await r.json(); } catch {} return { s: r.status, d }; };
const browsers = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0'); } catch { return null; } })
  .filter((a) => a && a.some((x) => x.startsWith('--user-data-dir=')) && !a.some((x) => x.startsWith('--type=')) && !a.some((x) => x.includes('playwright_chromiumdev_profile')))
  .map((a) => ({ udd: (a.find((x) => x.startsWith('--user-data-dir=')) || '').slice(16), pd: (a.find((x) => x.startsWith('--profile-directory=')) || '').slice(20) || '(none)', headless: a.includes('--headless') || a.some((x) => x.startsWith('--headless=')) }));
const out = {};
// ── D ──
const run = await j('POST', '/run', { userId: 'local', origin: 'manual', steps: [{ action: 'goto', params: { url: 'data:text/html,<title>noprofile</title>ok' } }, { action: 'wait', params: { ms: 4000 } }] });
out.D_enqueue = { status: run.s, jobId: run.d?.jobId, error: run.d?.error };
let seen = [];
for (let i = 0; i < 40; i++) { const b = browsers(); if (b.length) seen = b; await sleep(250); if (seen.length) break; }
let state = null;
for (let i = 0; i < 60; i++) { const r = await j('GET', `/job/local/${run.d?.jobId}`); state = r.d?.job?.state || r.d?.state || r.d?.status; if (['completed', 'failed'].includes(state)) break; await sleep(500); }
const job = await j('GET', `/job/local/${run.d?.jobId}`);
out.D_result = { state, failedReason: job.d?.job?.failedReason || job.d?.failedReason || null, chromiumSeen: seen };
out.D_branchesAfter = (await j('GET', '/profiles/branches')).d?.branches?.map((b) => b.id) ?? null;
// ── C ──
out.C_branchesBefore = (await j('GET', '/profiles/branches')).d?.branches?.map((b) => b.id) ?? null;
const o = await j('POST', '/browser/real/open', {});
out.C_open = { status: o.s, success: o.d?.success, error: o.d?.error };
for (let i = 0; i < 60 && !(await j('GET', '/browser/real/health')).d?.running; i++) await sleep(500);
out.C_health_after_open = (await j('GET', '/browser/real/health')).d;
out.C_chromium = browsers();
const c = await j('POST', '/browser/real/close', {});
out.C_close = { status: c.s, success: c.d?.success, running: c.d?.running };
await sleep(1500);
out.C_health_after_close = (await j('GET', '/browser/real/health')).d;
out.C_chromium_after_close = browsers();
out.C_branchesAfter = (await j('GET', '/profiles/branches')).d?.branches?.map((b) => b.id) ?? null;
console.log('RESULT ' + JSON.stringify(out, null, 1));
