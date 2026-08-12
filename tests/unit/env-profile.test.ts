/**
 * Environment profiles and the Chrome flag catalogue.
 *
 * THE REQUEST (verbatim):
 *   «متغیرها خیلی زیاد شدن … من می‌خوام نسبت به موقعیت متغیرها تنظیم بشن … اگر
 *    توی حالت دولوپ هستیم خب طبیعیه که مرورگر توی حالت آشکار باشه ولی وقتی توی
 *    حالت پروداکته … باید رو حالت پنهان باشه … کاربر گیج نمونه»
 *
 * The single most valuable test in this file is
 * `reproduces the previously hard-coded arg list` (section D). Everything else
 * checks new behaviour; that one checks that a REFACTOR OF A WORKING LAUNCH PATH
 * changed nothing. Chrome switches are the kind of thing where a silent
 * regression is invisible for weeks — the browser still starts, it just quietly
 * stops hiding automation, or stops loading extensions.
 */

import { describe, it, expect } from 'vitest';

import {
  detectProfile,
  resolveVar,
  profiledEnv,
  describeProfile,
  PROFILE_DEFAULTS,
  PROFILE_IDS,
  PROFILES,
} from '../../src/core/EnvProfile';
import {
  resolveFlags,
  flagCatalogue,
  FLAG_CATALOGUE,
  FLAG_GROUPS,
  PRESETS,
  DEFAULT_PRESET_ID,
} from '../../src/core/ChromeFlags';

// ===========================================================================
// A. Detecting the situation
// ===========================================================================
describe('which profile are we in', () => {
  it('uses APP_ENV when it is set', () => {
    const d = detectProfile({ APP_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(d.id).toBe('production');
    expect(d.source).toBe('APP_ENV');
  });

  it('prefers APP_ENV over NODE_ENV, because tooling writes NODE_ENV', () => {
    // vitest itself sets NODE_ENV=test. If NODE_ENV won, an operator could not
    // run a production-profile check from inside a test at all.
    const d = detectProfile({ APP_ENV: 'production', NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect(d.id).toBe('production');
    expect(d.source).toBe('APP_ENV');
  });

  it('falls back to NODE_ENV when APP_ENV is absent', () => {
    const d = detectProfile({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(d.id).toBe('production');
    expect(d.source).toBe('NODE_ENV');
  });

  it('accepts the short spellings a human would type', () => {
    expect(detectProfile({ APP_ENV: 'prod' } as NodeJS.ProcessEnv).id).toBe('production');
    expect(detectProfile({ APP_ENV: 'dev' } as NodeJS.ProcessEnv).id).toBe('development');
    expect(detectProfile({ APP_ENV: 'ci' } as NodeJS.ProcessEnv).id).toBe('test');
    expect(detectProfile({ APP_ENV: 'PRODUCTION' } as NodeJS.ProcessEnv).id).toBe('production');
  });

  it('strips a trailing comment, like cleanEnv does', () => {
    // `APP_ENV=production # the live box` must not silently become development.
    const d = detectProfile({ APP_ENV: 'production # the live box' } as NodeJS.ProcessEnv);
    expect(d.id).toBe('production');
  });

  it('does NOT throw on a typo — a bad APP_ENV must not stop the server booting', () => {
    // The operator would get a stack trace where they expected a website. The
    // safest wrong guess is the one that hides nothing.
    const d = detectProfile({ APP_ENV: 'prodction' } as NodeJS.ProcessEnv);
    expect(d.id).toBe('development');
    expect(d.source).toBe('default');
  });

  it('treats an empty value as absent', () => {
    const d = detectProfile({ APP_ENV: '', NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(d.id).toBe('production');
    expect(d.source).toBe('NODE_ENV');
  });

  it('defaults to development when nothing is set', () => {
    expect(detectProfile({} as NodeJS.ProcessEnv).id).toBe('development');
  });
});

// ===========================================================================
// B. THE RULE: an explicit value always wins
// ===========================================================================
describe('precedence — explicit beats profile beats default', () => {
  it('an explicit value wins over the profile', () => {
    // The whole system is untrustworthy if this fails. An operator who writes
    // REAL_CHROME_HEADLESS=true and gets a visible browser has been lied to by
    // their own config file.
    const r = resolveVar('REAL_CHROME_HEADLESS', {
      APP_ENV: 'development',
      REAL_CHROME_HEADLESS: 'true',
    } as NodeJS.ProcessEnv);
    expect(r.value).toBe('true');
    expect(r.source).toBe('explicit');
  });

  it('an explicit FALSE also wins — turning something off is a real choice', () => {
    // The tempting-but-wrong implementation treats any falsy-looking value as
    // "unset" and helpfully overrides it. That silently ignores the operator.
    const r = resolveVar('RATE_LIMIT_ENABLED', {
      APP_ENV: 'production',
      RATE_LIMIT_ENABLED: 'false',
    } as NodeJS.ProcessEnv);
    expect(r.value).toBe('false');
    expect(r.source).toBe('explicit');
  });

  it('the profile fills the gap when nothing was set', () => {
    const r = resolveVar('REAL_CHROME_HEADLESS', { APP_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(r.value).toBe('true');
    expect(r.source).toBe('profile');
    expect(r.profile).toBe('production');
  });

  it('an EMPTY variable counts as unset, not as a choice', () => {
    // `FOO=` in a .env file and a commented-out FOO are the same intent.
    const r = resolveVar('REAL_CHROME_HEADLESS', {
      APP_ENV: 'production',
      REAL_CHROME_HEADLESS: '',
    } as NodeJS.ProcessEnv);
    expect(r.source).toBe('profile');
    expect(r.value).toBe('true');
  });

  it('reports "default" for a variable no profile has an opinion about', () => {
    const r = resolveVar('SOME_UNMANAGED_THING', { APP_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(r.value).toBeUndefined();
    expect(r.source).toBe('default');
  });

  it('always explains itself — every resolution carries a reason', () => {
    // A default with no stated reason is a default nobody can safely change.
    for (const id of PROFILE_IDS) {
      for (const name of Object.keys(PROFILE_DEFAULTS[id])) {
        const r = resolveVar(name, { APP_ENV: id } as NodeJS.ProcessEnv);
        expect(r.why.length).toBeGreaterThan(20);
      }
    }
  });
});

// ===========================================================================
// C. The operator's own example, end to end
// ===========================================================================
describe("the operator's example: headless follows the situation", () => {
  it('development gives a VISIBLE browser', () => {
    expect(profiledEnv('REAL_CHROME_HEADLESS', { APP_ENV: 'development' } as NodeJS.ProcessEnv))
      .toBe('false');
  });

  it('production gives a HIDDEN browser', () => {
    expect(profiledEnv('REAL_CHROME_HEADLESS', { APP_ENV: 'production' } as NodeJS.ProcessEnv))
      .toBe('true');
  });

  it('test gives a hidden browser too, because CI has no screen', () => {
    expect(profiledEnv('REAL_CHROME_HEADLESS', { APP_ENV: 'test' } as NodeJS.ProcessEnv))
      .toBe('true');
  });

  it('development turns the desktop ON, production turns it OFF', () => {
    // A headed browser with no display cannot start; a VNC desktop nobody
    // connects to is idle attack surface. The pair must move together.
    const dev = { APP_ENV: 'development' } as NodeJS.ProcessEnv;
    const prod = { APP_ENV: 'production' } as NodeJS.ProcessEnv;
    expect(profiledEnv('DESKTOP_ENABLED', dev)).toBe('true');
    expect(profiledEnv('REAL_CHROME_HEADLESS', dev)).toBe('false');
    expect(profiledEnv('DESKTOP_ENABLED', prod)).toBe('false');
    expect(profiledEnv('REAL_CHROME_HEADLESS', prod)).toBe('true');
  });

  it('never leaves the DevTools port open in production or test', () => {
    // An open DevTools port is remote code execution and full cookie theft.
    expect(profiledEnv('REAL_CHROME_DEBUG_PORT', { APP_ENV: 'production' } as NodeJS.ProcessEnv))
      .toBe('0');
    expect(profiledEnv('REAL_CHROME_DEBUG_PORT', { APP_ENV: 'test' } as NodeJS.ProcessEnv))
      .toBe('0');
  });

  it('a headed profile is never combined with a disabled desktop', () => {
    // Guards the combination, not each variable: the failure mode is a browser
    // that cannot start, and it only appears when the two disagree.
    for (const id of PROFILE_IDS) {
      const env = { APP_ENV: id } as NodeJS.ProcessEnv;
      const headless = profiledEnv('REAL_CHROME_HEADLESS', env) === 'true';
      const desktop = profiledEnv('DESKTOP_ENABLED', env) === 'true';
      if (!headless) expect(desktop).toBe(true);
    }
  });
});

// ===========================================================================
// D. The report the UI renders — «کاربر گیج نمونه»
// ===========================================================================
describe('the profile report tells the operator who decided what', () => {
  it('marks an explicit override as overridden, and keeps the profile value visible', () => {
    // "You set this" and "development set this for you" must never look alike.
    const rep = describeProfile({
      APP_ENV: 'development',
      REAL_CHROME_HEADLESS: 'true',
    } as NodeJS.ProcessEnv);
    const row = rep.values.find((v) => v.name === 'REAL_CHROME_HEADLESS');
    expect(row?.source).toBe('explicit');
    expect(row?.value).toBe('true');
    expect(row?.overridden).toBe(true);
    // Still shows what development WOULD have chosen, so the operator can see
    // exactly what their override cost them.
    expect(row?.profileValue).toBe('false');
  });

  it('does not cry "overridden" when the explicit value agrees with the profile', () => {
    const rep = describeProfile({
      APP_ENV: 'development',
      REAL_CHROME_HEADLESS: 'false',
    } as NodeJS.ProcessEnv);
    const row = rep.values.find((v) => v.name === 'REAL_CHROME_HEADLESS');
    expect(row?.source).toBe('explicit');
    expect(row?.overridden).toBe(false);
  });

  it('lists the same rows in every profile, so switching does not shuffle the form', () => {
    const names = PROFILE_IDS.map((id) =>
      describeProfile({ APP_ENV: id } as NodeJS.ProcessEnv).values.map((v) => v.name).join(','),
    );
    expect(new Set(names).size).toBe(1);
  });

  it('says where the profile was detected from', () => {
    expect(describeProfile({ APP_ENV: 'test' } as NodeJS.ProcessEnv).detectedFrom).toBe('APP_ENV');
    expect(describeProfile({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).detectedFrom).toBe('NODE_ENV');
    expect(describeProfile({} as NodeJS.ProcessEnv).detectedFrom).toBe('default');
  });

  it('carries a Persian reason for every row, because the UI is bilingual', () => {
    const rep = describeProfile({ APP_ENV: 'development' } as NodeJS.ProcessEnv);
    for (const row of rep.values.filter((v) => v.source === 'profile')) {
      expect(row.whyFa.length).toBeGreaterThan(10);
      // Must actually be Persian, not an English string copied into the field.
      expect(row.whyFa).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('every profile has a bilingual label and summary for the picker', () => {
    expect(PROFILES).toHaveLength(PROFILE_IDS.length);
    for (const p of PROFILES) {
      expect(p.labelFa).toMatch(/[\u0600-\u06FF]/);
      expect(p.summaryFa).toMatch(/[\u0600-\u06FF]/);
      expect(p.summary.length).toBeGreaterThan(20);
    }
  });
});

// ===========================================================================
// E. THE REGRESSION GUARD — the refactor must not have changed the launch
// ===========================================================================
describe('the flag catalogue reproduces what was hard-coded before it', () => {
  /**
   * The exact array that `RealChrome.launch()` built before the catalogue
   * existed, minus the parts that are computed per-launch (window size,
   * extensions, debug port). Copied from git history, NOT from the new code —
   * comparing the new code against itself would prove nothing.
   *
   * Note `--no-default-browser-check` appeared TWICE in the original (once in
   * the base list, once via ANTI_AUTOMATION_ARGS). That duplicate is the
   * cosmetic defect the handoff flagged; the catalogue de-duplicates it.
   */
  const HARD_CODED_BEFORE = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--restore-last-session',
    // ...ANTI_AUTOMATION_ARGS
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--disable-features=IsolateOrigins,site-per-process',
  ];

  it('the default preset yields exactly the old set of switches', () => {
    const got = resolveFlags().args;
    expect(new Set(got)).toEqual(new Set(HARD_CODED_BEFORE));
  });

  it('and yields each one exactly once — the old duplicate is gone', () => {
    const got = resolveFlags().args;
    expect(got.length).toBe(new Set(got).size);
    // Proof the duplicate really was there to remove.
    expect(HARD_CODED_BEFORE.length).toBe(new Set(HARD_CODED_BEFORE).size + 1);
  });
});

// ===========================================================================
// F. Choosing flags
// ===========================================================================
describe('resolving a flag selection', () => {
  it('an unknown preset falls back to the recommended one rather than launching bare', () => {
    // A typo must not produce a Chrome with no container flags at all, which in
    // Docker means a browser that does not start.
    const r = resolveFlags({ preset: 'nonsense' });
    expect(r.presetId).toBe(DEFAULT_PRESET_ID);
    expect(r.args).toContain('--no-sandbox');
  });

  it('required flags survive even the emptiest custom selection', () => {
    const r = resolveFlags({ preset: 'custom', flags: [] });
    expect(r.args).toContain('--no-sandbox');
    expect(r.args).toContain('--disable-setuid-sandbox');
    expect(r.args).toContain('--disable-dev-shm-usage');
  });

  it('REPORTS an unknown flag id instead of silently dropping it', () => {
    // A flag the operator believes they set and the browser never received is
    // the exact failure mode that cost days on the tab-restore hunt.
    const r = resolveFlags({ preset: 'custom', flags: ['disable-gpu', 'made-up-flag'] });
    expect(r.unknown).toEqual(['made-up-flag']);
    expect(r.args).toContain('--disable-gpu');
  });

  it('reports an attempt to switch off something required, and keeps it on', () => {
    const r = resolveFlags({ overrides: { 'no-sandbox': false } });
    expect(r.forced).toEqual(['no-sandbox']);
    expect(r.args).toContain('--no-sandbox');
  });

  it('an override can add a flag the preset omitted', () => {
    expect(resolveFlags({ preset: 'standard' }).args).not.toContain('--disable-gpu');
    expect(resolveFlags({ preset: 'standard', overrides: { 'disable-gpu': true } }).args)
      .toContain('--disable-gpu');
  });

  it('an override can remove an optional flag the preset included', () => {
    const r = resolveFlags({ preset: 'standard', overrides: { 'restore-last-session': false } });
    expect(r.args).not.toContain('--restore-last-session');
  });

  it('never emits a computed flag as a bare switch', () => {
    // `--remote-debugging-port` without `=9222` is meaningless, and
    // `--window-size` without a size would make Chrome ignore it. Those carry
    // values from configuration, so RealChrome appends them itself.
    const all = resolveFlags({
      preset: 'custom',
      flags: FLAG_CATALOGUE.map((f) => f.id),
    });
    expect(all.args).not.toContain('--remote-debugging-port');
    expect(all.args).not.toContain('--window-size');
  });

  it('produces flags in a stable order, so two equal selections compare equal', () => {
    // The UI decides "restart required" by comparing selections. Order noise
    // there would nag the operator to restart for no reason.
    const a = resolveFlags({ preset: 'custom', flags: ['disable-gpu', 'disable-sync'] });
    const b = resolveFlags({ preset: 'custom', flags: ['disable-sync', 'disable-gpu'] });
    expect(a.ids).toEqual(b.ids);
    expect(a.args).toEqual(b.args);
  });
});

// ===========================================================================
// G. The catalogue is fit to render — the beginner-safety requirement
// ===========================================================================
describe('the catalogue is safe to put in front of a beginner', () => {
  it('every flag explains itself in both languages', () => {
    for (const f of FLAG_CATALOGUE) {
      expect(f.why.length).toBeGreaterThan(30);
      expect(f.whyFa).toMatch(/[\u0600-\u06FF]/);
      expect(f.labelFa).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('every flag belongs to a group that exists', () => {
    const groups = new Set(FLAG_GROUPS.map((g) => g.id));
    for (const f of FLAG_CATALOGUE) expect(groups.has(f.group)).toBe(true);
  });

  it('flag ids are unique', () => {
    const ids = FLAG_CATALOGUE.map((f) => f.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('every dangerous flag says what it costs, not just what it does', () => {
    // `--no-sandbox` sounds harmless. A beginner ticking it has disabled the
    // browser's most important security boundary.
    for (const f of FLAG_CATALOGUE.filter((x) => x.risk === 'dangerous')) {
      expect(f.why).toMatch(/security|steal|execution|weakens|privileg/i);
    }
  });

  it('there is exactly one recommended preset, and it is the default', () => {
    // Two recommendations is no recommendation.
    const rec = PRESETS.filter((p) => p.recommended);
    expect(rec).toHaveLength(1);
    expect(rec[0].id).toBe(DEFAULT_PRESET_ID);
  });

  it('every preset references only real flags', () => {
    const ids = new Set(FLAG_CATALOGUE.map((f) => f.id));
    for (const p of PRESETS) {
      for (const f of p.flags) expect(ids.has(f)).toBe(true);
    }
  });

  it('offers a custom preset, because the operator asked for one', () => {
    expect(PRESETS.some((p) => p.id === 'custom')).toBe(true);
  });

  it('no preset disables extensions — that would silently break the product', () => {
    // --disable-extensions makes --load-extension a no-op. The user reaching for
    // the REAL Chrome is usually reaching for their extensions.
    for (const p of PRESETS) expect(p.flags).not.toContain('disable-extensions');
  });

  it('the stealth preset keeps site isolation, because turning it off is detectable', () => {
    const stealth = PRESETS.find((p) => p.id === 'stealth');
    expect(stealth?.flags).not.toContain('disable-site-isolation');
    expect(stealth?.flags).toContain('disable-automation-controlled');
  });

  it('hands the UI everything it needs in one payload', () => {
    const cat = flagCatalogue();
    expect(cat.groups.length).toBeGreaterThan(0);
    expect(cat.flags.length).toBeGreaterThan(0);
    expect(cat.presets.length).toBeGreaterThan(0);
    expect(cat.defaultPreset).toBe(DEFAULT_PRESET_ID);
    expect(cat.required).toContain('no-sandbox');
  });
});
