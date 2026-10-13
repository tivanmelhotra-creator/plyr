/**
 * Phase 1 — launch settings (core/LaunchSettings), Chromium display name
 * (core/ChromiumProfileName), the shared build record (core/ProfileBuild),
 * the shared session view (core/SharedBrowsers) and the ONE shared viewer
 * (core/ProfileViewers with ?profiles=).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLaunchArgs, parseCustomFlags, REQUIRED_ARGS, LAUNCH_PRESETS, LAUNCH_OPTIONS, hasLaunchChoice, switchName,
} from '../../src/core/LaunchSettings';
import { applyChromiumProfileName, readChromiumProfileName, withLocalStateName } from '../../src/core/ChromiumProfileName';
import { buildCompatible, buildKey } from '../../src/core/ProfileBuild';
import { summarize, profileIdOfSession, closeContextBounded, LOCAL_BROWSER_SESSION } from '../../src/core/SharedBrowsers';
import { ProfileViewers, viewersOf } from '../../src/core/ProfileViewers';
import { launchInputOf } from '../../src/Routes/profile.routes';

describe('LaunchSettings — presets and options', () => {
  it('Standard reproduces exactly the arguments the profile launcher always used', () => {
    const r = buildLaunchArgs({});
    expect(r.ok).toBe(true);
    expect(r.presetId).toBe('standard');
    expect(r.args).toEqual(['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--start-maximized']);
  });

  it('each preset has a name, a description, real options, and adds its flags on top of the required ones', () => {
    const ids = new Set(LAUNCH_OPTIONS.map((o) => o.id));
    for (const p of LAUNCH_PRESETS) {
      expect(p.label && p.description).toBeTruthy();
      for (const o of p.options) expect(ids.has(o), `${p.id}:${o}`).toBe(true);
      const r = buildLaunchArgs({ preset: p.id });
      expect(r.ok).toBe(true);
      expect(r.args.slice(0, REQUIRED_ARGS.length)).toEqual([...REQUIRED_ARGS]);
    }
    const auto = buildLaunchArgs({ preset: 'automation' }).args;
    expect(auto).toContain('--disable-background-timer-throttling');
    expect(auto).toContain('--no-first-run');
    expect(buildLaunchArgs({ preset: 'diagnostics' }).args).toContain('--enable-logging=stderr');
    // Different presets = different fingerprints (a relaunch is decided on it).
    expect(buildLaunchArgs({ preset: 'automation' }).hash).not.toBe(buildLaunchArgs({}).hash);
  });

  it('a categorized option maps to its predefined switch; turning one off removes it', () => {
    expect(buildLaunchArgs({ options: { 'no-first-run': true } }).args).toContain('--no-first-run');
    expect(buildLaunchArgs({ options: { 'start-maximized': false } }).args).not.toContain('--start-maximized');
    const bad = buildLaunchArgs({ options: { 'made-up': true } });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]!.message).toMatch(/Unknown option/);
  });

  it('an unknown preset is an error, never silently Standard', () => {
    const r = buildLaunchArgs({ preset: 'turbo' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/Unknown preset/);
  });
});

describe('LaunchSettings — Custom Flags', () => {
  it('parses several flags, values with spaces in quotes, comments; never a shell string', () => {
    const p = parseCustomFlags('--lang=fa\n# comment\n--window-size=1280,800 --user-agent="Mozilla/5.0 (X11; Linux)"\n');
    expect(p.errors).toEqual([]);
    expect(p.flags).toEqual(['--lang=fa', '--window-size=1280,800', '--user-agent=Mozilla/5.0 (X11; Linux)']);
    // Shell metacharacters are just characters inside one argument.
    const r = buildLaunchArgs({ customFlags: '--lang="fa; rm -rf /"' });
    expect(r.custom).toEqual(['--lang=fa; rm -rf /']);
  });

  it('a valid custom flag ends up in the argv, after the required and option flags', () => {
    const r = buildLaunchArgs({ customFlags: '--lang=fa' });
    expect(r.ok).toBe(true);
    expect(r.args[r.args.length - 1]).toBe('--lang=fa');
  });

  it('app-controlled switches are refused with the reason (profile identity, debugging, visibility)', () => {
    for (const f of ['--user-data-dir=/tmp/x', '--profile-directory="Profile 2"', '--remote-debugging-port=9222', '--headless', '--headless=new', '--load-extension=/x', '--incognito']) {
      const r = buildLaunchArgs({ customFlags: f });
      expect(r.ok, f).toBe(false);
      expect(r.errors[0]!.message, f).toMatch(/controlled by the application/);
      expect(r.args.some((a) => a.startsWith(f.split('=')[0]!)), f).toBe(false);
    }
  });

  it('conflicts with required flags, enabled options and duplicates are reported, not "last wins"', () => {
    expect(buildLaunchArgs({ customFlags: '--no-sandbox' }).errors[0]!.message).toMatch(/always set/);
    expect(buildLaunchArgs({ customFlags: '--start-maximized' }).errors[0]!.message).toMatch(/conflicts with the option/);
    expect(buildLaunchArgs({ customFlags: '--lang=fa\n--lang=en' }).errors[0]!.message).toMatch(/twice/);
  });

  it('malformed input is reported: single dash, bare words, unterminated quote, control characters', () => {
    expect(parseCustomFlags('-v').errors[0]!.message).toMatch(/two dashes/);
    expect(parseCustomFlags('https://example.com').errors[0]!.message).toMatch(/not a switch/);
    expect(parseCustomFlags('--lang="fa').errors[0]!.message).toMatch(/Unterminated/);
    expect(buildLaunchArgs({ customFlags: ['--lang=fa\u0007'] }).ok).toBe(false);
    expect(buildLaunchArgs({ customFlags: '--bad_name' }).ok).toBe(false);
  });

  it('risky flags need an explicit confirmation', () => {
    const r = buildLaunchArgs({ customFlags: '--disable-web-security' });
    expect(r.ok).toBe(false);
    expect(r.needsConfirmation).toBe(true);
    expect(r.warnings[0]!.message).toMatch(/same-origin/);
    const ok = buildLaunchArgs({ customFlags: '--disable-web-security', acknowledgeRisk: true });
    expect(ok.ok).toBe(true);
    expect(ok.args).toContain('--disable-web-security');
  });

  it('hasLaunchChoice / launchInputOf: an empty body changes nothing; a body is sanitized', () => {
    expect(hasLaunchChoice(null)).toBe(false);
    expect(hasLaunchChoice({ options: {}, customFlags: '  ' })).toBe(false);
    expect(hasLaunchChoice({ preset: 'automation' })).toBe(true);
    expect(launchInputOf({})).toBeNull();
    expect(launchInputOf({ launch: { preset: 'automation', options: { 'no-first-run': true, x: 'yes' }, customFlags: '--lang=fa', acknowledgeRisk: 'true' } }))
      .toEqual({ preset: 'automation', options: { 'no-first-run': true }, customFlags: '--lang=fa', acknowledgeRisk: false });
    expect(switchName('--Lang=fa')).toBe('lang');
  });
});

describe('ChromiumProfileName — the profile name Chromium shows', () => {
  it('writes the name into Local State + Preferences, keeps every other key, is idempotent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpn-'));
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ browser: { x: 1 }, profile: { info_cache: { Default: { name: 'Your Chromium', avatar_icon: 'a' } } } }));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 } }));
    expect(await applyChromiumProfileName(dir, '22')).toEqual({ ok: true, changed: true });
    expect(await readChromiumProfileName(dir)).toBe('22');
    const ls = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
    expect(ls.browser).toEqual({ x: 1 });
    expect(ls.profile.info_cache.Default).toMatchObject({ name: '22', is_using_default_name: false, avatar_icon: 'a' });
    const pr = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    expect(pr).toMatchObject({ session: { restore_on_startup: 1 }, profile: { name: '22', using_default_name: false } });
    expect(await applyChromiumProfileName(dir, '22')).toEqual({ ok: true, changed: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh directory gets the files; an unreadable file is never overwritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpn-'));
    expect((await applyChromiumProfileName(dir, 'Shop')).ok).toBe(true);
    expect(await readChromiumProfileName(dir)).toBe('Shop');
    fs.writeFileSync(path.join(dir, 'Local State'), '{broken');
    const r = await applyChromiumProfileName(dir, 'Other');
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'Local State'), 'utf8')).toBe('{broken');
    expect(withLocalStateName(null, 'n').profile.info_cache.Default.name).toBe('n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ProfileBuild — one build record for both launchers', () => {
  it('a run without options may reuse the operator\'s browser (same visibility), not a hidden one', () => {
    const operator = buildKey({ headless: false, launchHash: 'abc' });
    expect(buildCompatible(operator, buildKey({ optionsHash: '', headless: false }))).toBe(true);
    expect(buildCompatible(operator, buildKey({ optionsHash: '', headless: true }))).toBe(false);
    expect(buildCompatible(operator, buildKey({ optionsHash: 'opt1', headless: false }))).toBe(false);
    expect(buildCompatible(undefined, buildKey({ headless: false }))).toBe(false);
    const run = buildKey({ optionsHash: 'opt1', headless: false });
    expect(buildCompatible(run, run)).toBe(true);
  });
});

describe('SharedBrowsers — one view of every live browser', () => {
  const rec = (leaseId: string, dependents: string[], visibility: 'visible' | 'hidden' = 'visible') =>
    ({ leaseId, userId: 'local', visibility, createdBy: '', startedAt: 1, lastActivity: 1, dependents, instance: 'i' });

  it('lists the Local Browser and profile browsers with registry names, no paths, counts only', () => {
    const list = summarize([
      rec('named:prf_a', ['operator:wf_1', 'job:9']),
      rec(LOCAL_BROWSER_SESSION, ['operator:local-browser']),
      rec('default', [], 'hidden'),
    ], (id) => ({ prf_a: '22', default: 'Default' } as Record<string, string>)[id]);
    expect(list.map((x) => [x.kind, x.name, x.runs, x.views])).toEqual([
      ['local-browser', 'Local Browser', 0, 0], ['profile', '22', 1, 1], ['profile', 'Default', 0, 0],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/\//);
    expect(profileIdOfSession('named:prf_a')).toBe('prf_a');
    expect(profileIdOfSession('realchrome')).toBeNull();
  });

  it('closeContextBounded never waits forever on a stuck page or context', async () => {
    vi.useFakeTimers();
    const never = () => new Promise<void>(() => { /* stuck on a dialog */ });
    const ctx: any = { pages: () => [{ close: never }, { close: () => Promise.resolve() }], close: never };
    const p = closeContextBounded(ctx, { closePages: true, pageMs: 100, contextMs: 200 });
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toEqual({ closed: false, timedOut: true });
    vi.useRealTimers();
  });
});

describe('ProfileViewers — the ONE shared viewer watches several profiles', () => {
  it('?profiles=a,b attaches the operator to each; closing the tab detaches all after the grace', () => {
    expect(viewersOf('?profiles=prf_a,prf_b,../x&workflowId=wf_abc123').map((v) => v.leaseId)).toEqual(['named:prf_a', 'named:prf_b']);
    vi.useFakeTimers();
    const detached: string[] = [];
    const v = new ProfileViewers(1000, (l, d) => detached.push(`${l}|${d}`));
    const gone = v.connected('?profiles=prf_a,default&workflowId=wf_abc123');
    expect(v.count('?profile=prf_a&workflowId=wf_abc123')).toBe(1);
    expect(v.count('?profile=default&workflowId=wf_abc123')).toBe(1);
    gone();
    vi.advanceTimersByTime(1000);
    expect(detached.sort()).toEqual(['default|operator:wf_abc123', 'named:prf_a|operator:wf_abc123']);
    vi.useRealTimers();
  });

  it('the viewer watches the shared session registry, not RealChrome, and never closes its own tab', () => {
    const cv = fs.readFileSync(path.join(__dirname, '../../src/core/ChromeView.ts'), 'utf8');
    const fn = cv.slice(cv.indexOf('function pollBrowserHealth'), cv.indexOf('function startWatching'));
    expect(fn).toContain("/browser/sessions?watch=1");
    expect(fn).not.toContain('/browser/real/health');
    const closed = cv.slice(cv.indexOf('function handleSessionClosed'), cv.indexOf('function pollBrowserHealth'));
    expect(closed).not.toMatch(/window\.close\(\)/);
  });
});
