/**
 * runtime-settings.test.ts — a setting an operator can change without a restart.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INCIDENT THIS PINS
 * ════════════════════════════════════════════════════════════════════════════
 * Selecting the Remote Browser on the server produced:
 *
 *     Could not start the remote browser: remote_browser_disabled
 *     — Remote Chrome is disabled. Set REAL_CHROME_ENABLED=true and restart
 *       the server.
 *
 * Two instructions, both addressed to someone who is not there: edit a file, and
 * restart a process they may not control. The operator's standing requirement:
 *
 *   «متغییر ها باید از داخل پروژه هم باید قابل تنظیم باشه و مجبور نباشیم کل
 *    پروژه رو ریستارت کنیم … اگر مثل الان متغییری باید تغییر کنه با زدن اون
 *    دکمه تغییر کنه»
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS ASSERTED HERE, AND WHY IT IS NOT A RESTATEMENT OF THE CODE
 * ════════════════════════════════════════════════════════════════════════════
 * Every describe below is a claim that could plausibly break in a way normal use
 * would not reveal:
 *
 *   1. PRECEDENCE. A runtime override outranks an explicit `.env` value. That
 *      deliberately INVERTS EnvProfile.ts's rule ("an explicit value always
 *      wins"), and inverting a rule is exactly the kind of decision that gets
 *      quietly undone by someone tidying up later.
 *   2. PARSING AGREEMENT. This module carries a COPY of config.ts's `cleanEnv`,
 *      forced by an import cycle. A drifted copy makes the getter report one
 *      value while a direct `process.env` read reports another — invisible in
 *      operation, catastrophic in diagnosis.
 *   3. IDEMPOTENT WRITES. `.env` is the file that decides whether the instance
 *      boots. Two assignments of one key, a truncated file, or a needless
 *      rewrite on every boot are all real damage (mission items 3 and 7).
 *   4. IMMEDIACY WITHOUT DEPENDENCE ON DISK. The feature must work on a
 *      read-only filesystem — the button worked, and it says so honestly.
 *   5. THE ALLOW-LIST AS A SECURITY BOUNDARY. An endpoint that can set arbitrary
 *      environment variables can set NODE_OPTIONS, and that is remote code
 *      execution, not configuration.
 *   6. EVERY FIXABLE CAUSE CARRIES A REACHABLE ENDPOINT. A button pointing at a
 *      route that does not exist is worse than the error message it replaced.
 *   7. ONLY THE OVERRIDE LAYER IS DYNAMIC. The `bootEnv` snapshot exists because
 *      a lazy read broke config-defaults.test.ts; this states why, so it is not
 *      "simplified" back.
 *   8. NO SURVIVING MESSAGE ASKS FOR A RESTART. Checked against the source, not
 *      against a mock, because the incident WAS a string.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

import {
  MANAGED_KEYS,
  REMEDIES,
  applySetting,
  clearOverridesForTests,
  envFilePath,
  hasOverride,
  remedyFor,
  resolveSetting,
  rewriteEnvBody,
  setOverride,
  settingValue,
  settingsSelfCheck,
  type Remedy,
} from '../../src/core/RuntimeSettings';

const KEY = 'REAL_CHROME_ENABLED';

/** A throwaway directory, so no test ever writes the repository's own .env. */
function tempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), 'runtime-settings-'));
}

const tempDirs: string[] = [];
function scratch(): string {
  const d = tempDir();
  tempDirs.push(d);
  return d;
}

beforeEach(() => {
  clearOverridesForTests();
});

afterEach(() => {
  clearOverridesForTests();
  vi.restoreAllMocks();
  // tmpfs in this sandbox is small; leaving directories behind across a full run
  // is how a suite starts failing with ENOSPC for reasons unrelated to itself.
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try { fsSync.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 1. Precedence: runtime > explicit > default
// ════════════════════════════════════════════════════════════════════════════

describe('1. precedence', () => {
  it('falls back to the built-in default when nothing is set anywhere', () => {
    const r = resolveSetting(KEY, {} as NodeJS.ProcessEnv);
    // The default is TRUE — which is why every operator who saw the disabled
    // message was in the one state that message could not explain.
    expect(r.value).toBe(true);
    expect(r.source).toBe('default');
  });

  it('honours an explicit value from the environment', () => {
    const r = resolveSetting(KEY, { [KEY]: 'false' } as NodeJS.ProcessEnv);
    expect(r.value).toBe(false);
    expect(r.source).toBe('explicit');
  });

  it('lets a runtime override outrank an explicit .env value', () => {
    // THE INVERSION, STATED. EnvProfile.ts's rule is that an explicit value
    // always wins. For the runtime layer that rule is wrong: an override is a
    // human pressing a button seconds ago, and a stale .env line is the least
    // explicit thing in the system. If this ever passes with 'explicit', the
    // button has silently stopped working on exactly the machines that need it.
    setOverride(KEY, true);
    const r = resolveSetting(KEY, { [KEY]: 'false' } as NodeJS.ProcessEnv);
    expect(r.value).toBe(true);
    expect(r.source).toBe('runtime');
  });

  it('lets a runtime override turn something OFF as well as on', () => {
    // Not symmetry for its own sake: an operator who enabled the browser to
    // debug something must be able to put it back without a restart either.
    setOverride(KEY, false);
    expect(settingValue(KEY, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveSetting(KEY, {} as NodeJS.ProcessEnv).source).toBe('runtime');
  });

  it('treats an empty assignment as absent, not as a choice', () => {
    // `REAL_CHROME_ENABLED=` is what a commented-out edit leaves behind. Reading
    // it as an explicit answer would honour a value nobody typed.
    const r = resolveSetting(KEY, { [KEY]: '' } as NodeJS.ProcessEnv);
    expect(r.source).toBe('default');
    expect(r.value).toBe(true);
  });

  it('reports whether an override is in force, so a UI need not guess', () => {
    expect(hasOverride(KEY)).toBe(false);
    setOverride(KEY, false);
    expect(hasOverride(KEY)).toBe(true);
    clearOverridesForTests();
    expect(hasOverride(KEY)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. The parsing copy must not drift from config.ts
// ════════════════════════════════════════════════════════════════════════════

describe('2. the environment is parsed exactly as config.ts parses it', () => {
  it('treats only the literal word false as off', () => {
    const table = new Map(settingsSelfCheck().map((c) => [String(c.raw), c.value]));
    expect(table.get('false')).toBe(false);
    expect(table.get('False')).toBe(false);
    expect(table.get('FALSE')).toBe(false);
    expect(table.get('true')).toBe(true);
    expect(table.get('TRUE')).toBe(true);
    // Junk is ON, because the default is on and junk is not a decision.
    expect(table.get('banana')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    const table = new Map(settingsSelfCheck().map((c) => [String(c.raw), c.value]));
    expect(table.get(' true ')).toBe(true);
    expect(table.get('  ')).toBe(true);
    expect(resolveSetting(KEY, { [KEY]: '  false  ' } as NodeJS.ProcessEnv).value).toBe(false);
  });

  it('strips a trailing comment, the way a hand-edited .env carries one', () => {
    const table = new Map(settingsSelfCheck().map((c) => [String(c.raw), c.value]));
    expect(table.get('false # was on')).toBe(false);
    expect(table.get('true#no')).toBe(true);
    expect(resolveSetting(KEY, { [KEY]: 'false # off for now' } as NodeJS.ProcessEnv).value)
      .toBe(false);
  });

  it('agrees with config.ts on the same raw string', async () => {
    // The real check on the duplicated `cleanEnv`: load config with a value that
    // exercises BOTH the comment stripping and the case folding, and require the
    // resolved boolean to match this module's own answer.
    const raw = 'False # deliberately off';
    const saved = process.env[KEY];
    process.env[KEY] = raw;
    try {
      vi.resetModules();
      const { config } = await import('../../src/config');
      const mine = resolveSetting(KEY, { [KEY]: raw } as NodeJS.ProcessEnv).value;
      expect(config.REAL_CHROME_ENABLED).toBe(mine);
      expect(mine).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
      vi.resetModules();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Writing .env: one key, one line, always
// ════════════════════════════════════════════════════════════════════════════

describe('3. writing .env — one key, one line, always', () => {
  it('appends the key to a file that does not mention it', () => {
    const next = rewriteEnvBody('PORT=3000\nREDIS_URL=redis://x\n', KEY, 'true');
    expect(next).toBe(`PORT=3000\nREDIS_URL=redis://x\n${KEY}=true\n`);
  });

  it('leaves every other line untouched, including comments', () => {
    const body = '# my notes\nPORT=3000\n\n# browser\nREAL_CHROME_ENABLED=false\nAPI_TOKEN=abc\n';
    const next = rewriteEnvBody(body, KEY, 'true')!;
    expect(next).toContain('# my notes');
    expect(next).toContain('# browser');
    expect(next).toContain('PORT=3000');
    expect(next).toContain('API_TOKEN=abc');
  });

  it('collapses duplicate assignments into exactly one', () => {
    // dotenv is last-wins, so a duplicate is not merely untidy: it is a file
    // whose meaning depends on line order, and the operator reading the first
    // occurrence is reading a value that is not in force.
    const body = `${KEY}=false\nPORT=3000\n${KEY}=false\n  ${KEY} = false\n`;
    const next = rewriteEnvBody(body, KEY, 'true')!;
    const assignments = next.split('\n').filter((l) => /^\s*REAL_CHROME_ENABLED\s*=/.test(l));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toBe(`${KEY}=true`);
  });

  it('returns null when the file already says exactly this', () => {
    // "Nothing to write" is a requirement (mission item 7), not an optimisation:
    // a needless write churns an mtime that deployment tooling watches.
    expect(rewriteEnvBody(`PORT=3000\n${KEY}=true\n`, KEY, 'true')).toBeNull();
  });

  it('still rewrites when the value is right but duplicated', () => {
    const next = rewriteEnvBody(`${KEY}=true\n${KEY}=true\n`, KEY, 'true');
    expect(next).not.toBeNull();
    expect(next!.split('\n').filter((l) => l.startsWith(KEY)).length).toBe(1);
  });

  it('preserves CRLF in a file that uses it', () => {
    // A Windows-authored .env rewritten with bare LF becomes a file whose diff
    // is every line, which buries the one line that actually changed.
    const next = rewriteEnvBody(`PORT=3000\r\n${KEY}=false\r\n`, KEY, 'true')!;
    expect(next).toBe(`PORT=3000\r\n${KEY}=true\r\n`);
  });

  it('does not grow a blank line on every write', () => {
    let body = 'PORT=3000\n\n\n';
    body = rewriteEnvBody(body, KEY, 'true')!;
    body = rewriteEnvBody(body, KEY, 'false')!;
    body = rewriteEnvBody(body, KEY, 'true')!;
    expect(body).toBe(`PORT=3000\n${KEY}=true\n`);
  });

  it('creates a valid single-line file from nothing', () => {
    expect(rewriteEnvBody('', KEY, 'true')).toBe(`${KEY}=true\n`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Applying a setting: immediate, and persisted
// ════════════════════════════════════════════════════════════════════════════

describe('4. applying a setting takes effect immediately AND persists', () => {
  it('is in force for the current process before it touches disk', async () => {
    const cwd = scratch();
    setOverride(KEY, false);
    expect(settingValue(KEY, {} as NodeJS.ProcessEnv)).toBe(false);

    const r = await applySetting(KEY, true, { cwd });
    expect(r.value).toBe(true);
    expect(r.source).toBe('runtime');
    // The point of the whole change: no reload, no restart, no re-import.
    expect(settingValue(KEY, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('makes config.REAL_CHROME_ENABLED agree, without re-importing config', async () => {
    const cwd = scratch();
    // Both halves are taken from the SAME module graph on purpose. An earlier
    // test in this file calls vi.resetModules(), after which a dynamic import of
    // config builds a fresh graph with its own RuntimeSettings instance — so
    // mixing the statically imported applySetting with a freshly imported config
    // would be writing to one module and reading from another, and the failure
    // would look like a product bug ("the getter ignored the override") when it
    // is purely an artefact of module resetting.
    const { config } = await import('../../src/config');
    const live = await import('../../src/core/RuntimeSettings');
    try {
      await live.applySetting(KEY, false, { cwd });
      // The claim: an object imported BEFORE the change reports the new value,
      // because the property is an accessor rather than a copied boolean.
      expect(config.REAL_CHROME_ENABLED).toBe(false);
      await live.applySetting(KEY, true, { cwd });
      expect(config.REAL_CHROME_ENABLED).toBe(true);
    } finally {
      live.clearOverridesForTests();
      delete process.env[KEY];
    }
  });

  it('updates process.env too, for code that reads the environment directly', async () => {
    const cwd = scratch();
    await applySetting(KEY, false, { cwd });
    // doctor.ts and any lazily imported module read process.env. Leaving it
    // stale would print the old value beside the new behaviour — the single most
    // confusing thing a diagnostic can do.
    expect(process.env[KEY]).toBe('false');
    await applySetting(KEY, true, { cwd });
    expect(process.env[KEY]).toBe('true');
    delete process.env[KEY];
  });

  it('writes the value into .env so the next boot agrees', async () => {
    const cwd = scratch();
    await fs.writeFile(path.join(cwd, '.env'), 'PORT=3000\n', 'utf8');
    const r = await applySetting(KEY, true, { cwd });
    expect(r.persisted).toBe(true);
    const body = await fs.readFile(envFilePath(cwd), 'utf8');
    expect(body).toContain('PORT=3000');
    expect(body).toContain(`${KEY}=true`);
  });

  it('writes one line even when called twice, and says nothing changed', async () => {
    const cwd = scratch();
    await applySetting(KEY, true, { cwd });
    const second = await applySetting(KEY, true, { cwd });
    expect(second.unchanged).toBe(true);
    const body = await fs.readFile(envFilePath(cwd), 'utf8');
    expect(body.split('\n').filter((l) => l.startsWith(KEY))).toHaveLength(1);
  });

  it('keeps the change in force when the filesystem refuses the write', async () => {
    // A read-only container, a root-owned .env and a full disk are all real. In
    // every one of them the right outcome is "the button worked, and here is why
    // it will not survive a restart" — never "the button failed".
    const cwd = scratch();
    vi.spyOn(fs, 'writeFile').mockRejectedValue(
      Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }),
    );
    const r = await applySetting(KEY, true, { cwd });
    expect(r.persisted).toBe(false);
    expect(r.persistError).toMatch(/EROFS/);
    expect(r.value).toBe(true);
    expect(settingValue(KEY, {} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('writes through a temporary file and renames, so a crash cannot truncate .env', async () => {
    const cwd = scratch();
    const rename = vi.spyOn(fs, 'rename');
    const write = vi.spyOn(fs, 'writeFile');
    await applySetting(KEY, true, { cwd });
    expect(write).toHaveBeenCalled();
    // The file opened for writing must NOT be .env itself.
    expect(String(write.mock.calls[0][0])).not.toBe(envFilePath(cwd));
    expect(rename).toHaveBeenCalled();
    expect(String(rename.mock.calls[0][1])).toBe(envFilePath(cwd));
  });

  it('can be told not to persist at all', async () => {
    const cwd = scratch();
    const r = await applySetting(KEY, false, { cwd, persist: false });
    expect(r.persisted).toBe(false);
    expect(settingValue(KEY, {} as NodeJS.ProcessEnv)).toBe(false);
    await expect(fs.readFile(envFilePath(cwd), 'utf8')).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. The allow-list is a security boundary
// ════════════════════════════════════════════════════════════════════════════

describe('5. only named settings can ever be changed', () => {
  it('refuses a variable that is not on the list', async () => {
    // WHY THIS MATTERS MORE THAN IT LOOKS. An endpoint reachable over HTTP that
    // can set an arbitrary environment variable can set NODE_OPTIONS or PATH,
    // and that is a code-execution primitive, not a configuration feature.
    expect(() => setOverride('NODE_OPTIONS', true)).toThrow(/not a managed setting/);
    expect(() => resolveSetting('PATH')).toThrow(/not a managed setting/);
    await expect(applySetting('REDIS_URL', true)).rejects.toThrow(/not a managed setting/);
  });

  it('keeps secrets off the list on purpose', () => {
    // API_TOKEN and ADMIN_SECRET are read once at boot and are deliberately NOT
    // settable here: an endpoint that can rewrite the credential guarding it is
    // a privilege-escalation primitive. Their "and restart" hints are correct.
    for (const secret of ['API_TOKEN', 'ADMIN_SECRET', 'JWT_SECRET', 'DATABASE_URL']) {
      expect(MANAGED_KEYS).not.toContain(secret);
    }
  });

  it('publishes the list, so a client need not guess what it may change', () => {
    expect(MANAGED_KEYS).toContain(KEY);
    expect(Object.isFrozen(MANAGED_KEYS)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Every fixable cause carries the endpoint that fixes it
// ════════════════════════════════════════════════════════════════════════════

describe('6. every fixable cause carries the endpoint that fixes it', () => {
  it('offers the enable endpoint for the cause from the incident', () => {
    const r = remedyFor('remote_browser_disabled')!;
    expect(r).toBeDefined();
    expect(r.endpoint).toBe('/browser/enable');
    expect(r.key).toBe('enableRemoteBrowser');
    expect(r.automatic).toBe(true);
  });

  it('uses the same remedy for SelfHeal spelling of the same cause', () => {
    // RemoteBrowserStart says `remote_browser_disabled`; SelfHeal says
    // `realChromeDisabled`. One dead end, two spellings — a UI keyed on only one
    // of them shows a button in some paths and prose in others.
    expect(remedyFor('realChromeDisabled')!.endpoint).toBe(
      remedyFor('remote_browser_disabled')!.endpoint,
    );
  });

  it('offers an install endpoint for a missing binary and missing libraries', () => {
    expect(remedyFor('browser_not_installed')!.endpoint).toBe('/browser/dependencies/install');
    expect(remedyFor('browser_libraries_missing')!.endpoint)
      .toBe('/browser/dependencies/install');
  });

  it('offers a display start and a profile recovery', () => {
    expect(remedyFor('display_unavailable')!.endpoint).toBe('/browser/desktop/start');
    expect(remedyFor('browser_profile_locked')!.endpoint).toBe('/browser/real/recover');
  });

  it('has no remedy for a cause this build cannot fix by itself', () => {
    // Absence is a designed answer: a button that cannot work is worse than the
    // error text it replaced, because it spends the operator's trust.
    expect(remedyFor('unknown')).toBeUndefined();
    expect(remedyFor('')).toBeUndefined();
  });

  it('gives every remedy a label, a POST endpoint and an honest eta', () => {
    for (const [cause, r] of Object.entries(REMEDIES) as Array<[string, Remedy]>) {
      expect(r.label, cause).toBeTruthy();
      expect(r.endpoint, cause).toMatch(/^\/browser\//);
      // The eta goes on the button as a promise; zero or absent would make the
      // UI promise instant and then hang for three minutes.
      expect(r.etaMs, cause).toBeGreaterThan(0);
      expect(r.key, cause).toBeTruthy();
    }
  });

  it('points every remedy at a route that actually exists', async () => {
    // The failure this prevents is specific: a button wired to a 404. Asserted
    // against the router source, because a typo here is invisible until pressed.
    const src = await fs.readFile(
      path.join(process.cwd(), 'src/Routes/browser.routes.ts'), 'utf8',
    );
    for (const r of Object.values(REMEDIES) as Remedy[]) {
      expect(src, `${r.endpoint} must be a registered POST route`)
        .toContain(`router.post('${r.endpoint}'`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Only the override layer is dynamic
// ════════════════════════════════════════════════════════════════════════════

describe('7. only the override layer is dynamic', () => {
  it('does not let a later mutation of process.env revoke a booted value', () => {
    // MEASURED, NOT THEORETICAL. config-defaults.test.ts sets the variable,
    // loads config, then RESTORES the environment before asserting. A lazy read
    // sees the restored (empty) environment and answers `true`, so honouring an
    // explicit `False` failed. The value in .env is a fact about this boot, not
    // a variable a later `delete process.env.X` should silently revoke.
    const saved = process.env[KEY];
    process.env[KEY] = 'false';
    try {
      delete process.env[KEY];
      // The snapshot taken at import is unaffected by both writes above.
      const r = resolveSetting(KEY);
      expect(['explicit', 'default']).toContain(r.source);
      expect(r.source).not.toBe('runtime');
    } finally {
      if (saved === undefined) delete process.env[KEY];
      else process.env[KEY] = saved;
    }
  });

  it('lets an explicit environment value be passed in for inspection', () => {
    // The `env` parameter is how doctor/settings ask "what WOULD this resolve to"
    // without mutating anything.
    expect(resolveSetting(KEY, { [KEY]: 'false' } as NodeJS.ProcessEnv).source).toBe('explicit');
    expect(resolveSetting(KEY, {} as NodeJS.ProcessEnv).source).toBe('default');
  });

  it('makes the override the only thing that can change an answer mid-process', () => {
    const before = resolveSetting(KEY);
    process.env[KEY] = before.value ? 'false' : 'true';
    try {
      expect(resolveSetting(KEY).value).toBe(before.value);
      setOverride(KEY, !before.value);
      expect(resolveSetting(KEY).value).toBe(!before.value);
    } finally {
      delete process.env[KEY];
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. No surviving message asks for a restart
// ════════════════════════════════════════════════════════════════════════════

describe('8. no message may still ask the operator to restart', () => {
  /** Source with comments removed: a comment explaining history is not a hint. */
  async function codeOf(rel: string): Promise<string> {
    const raw = await fs.readFile(path.join(process.cwd(), rel), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
  }

  const FILES = [
    'src/core/RealChrome.ts',
    'src/core/RemoteBrowserStart.ts',
    'src/core/BrowserRuntime.ts',
    'src/core/StartupValidation.ts',
    'src/core/SelfHeal.ts',
    'src/Routes/browser.routes.ts',
  ];

  it('never tells the operator to restart the server about this setting', async () => {
    for (const file of FILES) {
      const code = await codeOf(file);
      // Scoped to lines that mention the flag: the identical phrase is CORRECT
      // for API_TOKEN and ADMIN_SECRET, which are read once at boot and are
      // deliberately not runtime-settable. An over-broad ban here flagged
      // StartupValidation's secret hints, and those were right.
      const offenders = code
        .split('\n')
        .filter((l) => l.includes('REAL_CHROME_ENABLED') && /restart/i.test(l));
      expect(offenders, `${file} still asks for a restart`).toEqual([]);
    }
  });

  it('deletes the exact sentence from the incident report', async () => {
    for (const file of FILES) {
      const code = await codeOf(file);
      expect(code, file).not.toMatch(/Set REAL_CHROME_ENABLED=true and restart/i);
    }
  });

  it('names the endpoint that fixes it wherever the dead end is explained', async () => {
    // Prose alone is not enough: the message must contain the thing that acts.
    for (const file of [
      'src/core/RealChrome.ts',
      'src/core/BrowserRuntime.ts',
      'src/core/StartupValidation.ts',
      'src/core/SelfHeal.ts',
    ]) {
      const code = await codeOf(file);
      expect(code, `${file} should point at the enable endpoint`)
        .toMatch(/\/browser\/enable/);
    }
  });

  it('keeps the phrases the existing readiness tests depend on', async () => {
    // Guard rail on this delta itself: environment-readiness.test.ts asserts
    // RealChrome's explanation still says the default is TRUE, still mentions
    // .env, and still points at `npm run doctor`. Rewriting a message is allowed;
    // deleting the facts around it is not.
    const code = await fs.readFile(
      path.join(process.cwd(), 'src/core/RealChrome.ts'), 'utf8',
    );
    expect(code).toMatch(/default is TRUE/i);
    expect(code).toMatch(/\.env/);
    expect(code).toMatch(/npm run doctor/);
  });
});
