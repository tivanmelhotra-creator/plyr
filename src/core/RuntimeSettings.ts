/**
 * RuntimeSettings — change a setting NOW, without restarting anything.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE REPORT THIS EXISTS TO DELETE
 * ══════════════════════════════════════════════════════════════════════════
 *
 *     Could not start the remote browser: remote_browser_disabled
 *     — Remote Chrome is disabled. Set REAL_CHROME_ENABLED=true and restart
 *       the server.
 *
 * and, in the operator's own words:
 *
 *   «قبلا به وضوح گفته بودم که متغییر ها باید از داخل پروژه هم باید قابل تنظیم
 *    باشه و مجبور نباشیم کل پروژه رو ریستارت کنیم … اگر مثل الان متغییری باید
 *    تغییر کنه با زدن اون دکمه تغییر کنه»
 *
 * Read that error as a user. It names a file they may not have (`.env` is not
 * created by the installer if one exists), a variable they did not set (the
 * DEFAULT IS ALREADY TRUE — see config.ts), and an action they may not be able
 * to perform: on a hosted box the person clicking the button often has no shell,
 * and "restart the server" is precisely the thing they came to this panel to
 * avoid. SelfHeal.ts already carries this project's rule —
 *
 *     "A message asking a user to do a thing the server can do itself is a bug
 *      report the server is filing against its own user."
 *
 * — and a configuration flag is exactly such a thing. The server can flip it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS, AND WHAT IT IS DELIBERATELY NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * IT IS a tiny, ALLOW-LISTED override store for the handful of settings whose
 * wrong value turns a feature into a dead end. Two effects per change, both
 * required:
 *
 *   1. IN MEMORY, immediately — so the very next call sees the new value. This
 *      is what makes "no restart" true rather than aspirational.
 *   2. IN `.env`, idempotently — so it is still true tomorrow. Without this the
 *      button would work until the next deploy and then silently stop working,
 *      which is worse than not having the button.
 *
 * IT IS NOT a general `process.env` editor. Only keys listed in `MANAGED` can
 * be written, and each declares its own parser and its own remedy text. An
 * endpoint that could set ANY variable at runtime is a remote-code-execution
 * primitive: `NODE_OPTIONS`, `PATH` and `REDIS_URL` are all one POST away from
 * turning a convenience into a takeover. The allow-list is the security model.
 *
 * IT IS NOT a place where a value changes BEHIND the operator's back. Nothing
 * here runs by itself; every write has a caller that a human triggered.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A RUNTIME OVERRIDE OUTRANKS `process.env`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * EnvProfile.ts establishes the opposite rule for PROFILES — "an explicit value
 * ALWAYS wins" — and that is right, because a profile is a GUESS about the
 * situation. This is not a guess. A runtime override is the most explicit signal
 * that exists: a human pressed a button, in this instance, seconds ago, having
 * been shown what it would change. A `false` in a `.env` inherited from an older
 * release is the LEAST explicit thing in the system — nobody in the reported
 * incident could say who wrote it. So: runtime > env > default, and the value is
 * written back to `.env` in the same breath so the two never disagree.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY IT WRITES `.env` WITH THIS EXACT ALGORITHM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Copied deliberately from `scripts/ask-domain.sh`, which solved the same
 * problem in shell: drop EVERY existing assignment of the key, then append ONE
 * canonical line. dotenv resolves duplicates by last-wins, so an appender that
 * does not delete leaves a file whose meaning depends on line order — the
 * failure mode being that the operator reads their new value near the bottom,
 * the loader honours it, and a second copy left further down makes the next edit
 * behave differently. One key, one line, always. That is also mission item 7's
 * "no duplicate .env keys", applied to the writer rather than only to the
 * startup scripts.
 *
 * No caching: `resolveSetting()` consults the override map on every call,
 * because a getter in config.ts is only useful if it can actually change.
 */

// Loaded here as well as in config.ts, and deliberately so. `dotenv/config` is
// idempotent (it will not overwrite a variable that is already set), and this
// module snapshots the environment in its module body — so whichever of the two
// modules is imported FIRST, the `.env` file has already been applied by the
// time the snapshot is taken. Without this line, a test or tool that reaches
// RuntimeSettings before config would snapshot an environment with no `.env` in
// it and silently resolve every setting to its default.
import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';

/** Where a resolved value came from. Ordered by precedence, strongest first. */
export type SettingSource = 'runtime' | 'explicit' | 'default';

/**
 * A one-click fix the UI can render as a button.
 *
 * This is the machine-readable half of a hint. The human half ("Remote Chrome
 * is switched off") tells the operator what is wrong; this tells the CLIENT what
 * to POST to make it stop being wrong, so the answer to a dead end is a button
 * rather than a sentence containing a variable name.
 *
 * `label` is short and imperative because it goes ON the button. It is English
 * here and translated client-side by `key`, following the same rule as
 * SelfHeal's HealStep: a sentence invented on the server arrives in a Persian UI
 * as English, and this UI is required to be both.
 */
export interface Remedy {
  /** Stable identifier the client translates. Never shown raw if a key exists. */
  key:
  | 'enableRemoteBrowser'
  | 'installBrowser'
  | 'installBrowserLibraries'
  | 'startDisplay'
  | 'recoverProfile';
  /** Fallback label, used only if the client has no translation for `key`. */
  label: string;
  /** The endpoint that performs the fix. Always a POST; always idempotent. */
  endpoint: string;
  /** How long it usually takes, so the button can promise something honest. */
  etaMs: number;
  /**
   * True when applying this fix needs no further action from the user — the
   * server changes the state and the feature works. False would mean "this
   * starts something you then have to watch", and nothing here is that.
   */
  automatic: true;
}

/** One setting this module is allowed to change. */
interface Managed<T> {
  /** Environment variable name, used verbatim in `.env`. */
  key: string;
  /** Read the raw string form of the environment. */
  parse: (raw: string | undefined) => T;
  /** Render a value back into the string form `.env` stores. */
  render: (value: T) => string;
  /** The value when nothing is set anywhere. */
  fallback: T;
}

/**
 * Strip a trailing comment and surrounding whitespace, exactly as config.ts's
 * `cleanEnv` does.
 *
 * Duplicated rather than imported because config.ts imports THIS module, and a
 * cycle between the two would make the getter it installs undefined at the
 * moment the module body runs. Eight lines of duplication is the cheaper of the
 * two problems, and `settingsSelfCheck()` below states the agreement as data a
 * test can execute against config's own resolution.
 */
function cleanRaw(val: string | undefined): string | undefined {
  if (val === undefined) return undefined;
  return val.split('#')[0].trim();
}

/** `false` only when it says so; anything else (including junk) is on. */
const parseBool = (raw: string | undefined): boolean =>
  (cleanRaw(raw)?.toLowerCase() ?? 'true') !== 'false';

const MANAGED: Record<string, Managed<boolean>> = {
  /**
   * The one from the incident report.
   *
   * Its default is TRUE, so every operator who has ever seen the disabled
   * message was in the one state the message could not explain. Making it
   * settable from the panel means that state is now recoverable by the person
   * looking at it.
   */
  REAL_CHROME_ENABLED: {
    key: 'REAL_CHROME_ENABLED',
    parse: parseBool,
    render: (v) => (v ? 'true' : 'false'),
    fallback: true,
  },
};

/** Every key this module will accept. Anything else is refused. */
export const MANAGED_KEYS: readonly string[] = Object.freeze(Object.keys(MANAGED));

/** In-memory overrides. Empty until something explicitly writes one. */
const overrides = new Map<string, boolean>();

/**
 * The environment AS IT WAS WHEN THIS MODULE LOADED.
 *
 * ── WHY A SNAPSHOT, IN A MODULE WHOSE WHOLE POINT IS TO BE DYNAMIC ─────────
 * Exactly ONE layer is dynamic here: the override, set by a human pressing a
 * button. The `explicit` layer must NOT be, because "read process.env on every
 * access" changes the meaning of configuration in a way nobody asked for:
 *
 *   • Every other value in config.ts is resolved once at import. A single value
 *     that instead tracks live mutations of process.env makes the config object
 *     internally inconsistent — PORT reflects boot, this one reflects now.
 *   • MEASURED, as a test failure rather than a theory: config-defaults.test.ts
 *     loads config under `{REAL_CHROME_ENABLED:'False'}` and then RESTORES the
 *     surrounding environment before asserting. A lazy read sees the restored
 *     (empty) environment and answers `true`, so the assertion that an explicit
 *     `False` is honoured failed. The test is right and the lazy read was wrong:
 *     the value an operator wrote in `.env` is a fact about this boot, not a
 *     variable that a later `delete process.env.X` should silently revoke.
 *   • Anything that legitimately wants to change the value has `applySetting`
 *     or `setOverride`, both of which record an override that outranks this
 *     snapshot. Nothing needs to reach the environment to be heard.
 *
 * `applySetting` still writes `process.env` for the benefit of code that reads
 * the environment directly (doctor.ts, lazily imported modules); the override it
 * records is what makes THIS module agree.
 */
const bootEnv: Record<string, string | undefined> = {};
for (const key of Object.keys(MANAGED)) bootEnv[key] = process.env[key];

/** Was this key set at runtime during this process? */
export function hasOverride(key: string): boolean {
  return overrides.has(key);
}

/**
 * Record an override in memory only — no `.env`, no I/O.
 *
 * This is what `config.REAL_CHROME_ENABLED = x` does, and the split matters.
 * ASSIGNING to config is an in-process statement about this run: it is what a
 * test does to set up a scenario, and what a code path does when it has decided
 * something for the lifetime of the process. PERSISTING is a separate, louder
 * act with a filesystem side effect, and it belongs to `applySetting`, which has
 * a human behind it.
 *
 * Keeping the plain assignment working is not a courtesy to the tests: several
 * of them (self-heal, live-browser-download-names) write the flag directly, and
 * a getter with no setter turns those writes into a throw — MEASURED:
 * "TypeError: Cannot set property REAL_CHROME_ENABLED of #<Object> which has
 * only a getter", 17 tests. A config value that cannot be assigned is also a
 * behaviour change nobody asked for.
 */
export function setOverride(key: string, value: boolean): void {
  if (!MANAGED[key]) throw new Error(`RuntimeSettings: ${key} is not a managed setting`);
  overrides.set(key, value);
}

/**
 * The value in force right now, with its provenance.
 *
 * Called on every read (config.ts installs a getter that delegates here), so it
 * does no I/O and allocates nothing beyond the returned record.
 */
export function resolveSetting(
  key: string,
  env: NodeJS.ProcessEnv = bootEnv as NodeJS.ProcessEnv,
): { value: boolean; source: SettingSource } {
  const spec = MANAGED[key];
  if (!spec) throw new Error(`RuntimeSettings: ${key} is not a managed setting`);

  if (overrides.has(key)) return { value: overrides.get(key)!, source: 'runtime' };

  const raw = cleanRaw(env[key]);
  // '' counts as ABSENT, matching EnvProfile's rule. `FOO=` in a .env is how a
  // key gets left behind by a commented-out edit, and treating it as an explicit
  // choice would honour a value nobody typed.
  if (raw !== undefined && raw !== '') return { value: spec.parse(raw), source: 'explicit' };

  return { value: spec.fallback, source: 'default' };
}

/** Just the value. */
export function settingValue(
  key: string,
  env: NodeJS.ProcessEnv = bootEnv as NodeJS.ProcessEnv,
): boolean {
  return resolveSetting(key, env).value;
}

/**
 * Where `.env` lives.
 *
 * `process.cwd()`, matching `dotenv/config`'s own default and `ask-domain.sh`,
 * which writes `./.env` relative to the directory the startup script ran from.
 * Two writers disagreeing about the path would produce the exact duplicate
 * configuration mission item 2 is about.
 */
export function envFilePath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.env');
}

/** The line ending already used by a file, so an edit does not mix them. */
function dominantEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Rewrite one key in a `.env` body, idempotently.
 *
 * Exported and PURE so the rule can be tested without a filesystem: given a body
 * it returns the new body, or `null` when the file already says exactly this and
 * nothing needs writing. "Nothing needs writing" is a real requirement, not an
 * optimisation — mission item 7 asks for startup paths that do not rewrite files
 * they already agree with, and a needless write churns the mtime that deployment
 * tooling watches.
 */
export function rewriteEnvBody(body: string, key: string, value: string): string | null {
  const eol = dominantEol(body);
  const assign = new RegExp(`^[\\s]*${key}[\\s]*=`);
  const lines = body.split(/\r?\n/);

  const kept: string[] = [];
  let matches = 0;
  let alreadyExact = false;
  for (const line of lines) {
    if (assign.test(line)) {
      matches += 1;
      if (line === `${key}=${value}`) alreadyExact = true;
      continue;
    }
    kept.push(line);
  }

  // Exactly one assignment, already the right text: leave the file alone.
  if (matches === 1 && alreadyExact) return null;

  // Drop trailing blank lines so appending does not grow a gap on every write.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(`${key}=${value}`);
  return kept.join(eol) + eol;
}

/**
 * Apply a setting: memory first, then disk.
 *
 * ORDER IS DELIBERATE. The in-memory override is what makes the feature work
 * immediately, and it must not be contingent on a writable filesystem — a
 * read-only container, a root-owned `.env` and a full disk are all real, and in
 * every one of them the right outcome is "the button worked, and here is why it
 * will not survive a restart" rather than "the button failed".
 *
 * `process.env` is updated too, so anything that re-reads the environment
 * directly (doctor.ts, a lazily imported module) agrees with the override
 * instead of reporting the stale value beside the new behaviour.
 */
export async function applySetting(
  key: string,
  value: boolean,
  opts: { cwd?: string; persist?: boolean } = {},
): Promise<{
  key: string;
  value: boolean;
  source: SettingSource;
  persisted: boolean;
  /** Present when persistence failed. The change is still in force. */
  persistError?: string;
  /** True when `.env` already said this, so nothing was written. */
  unchanged: boolean;
}> {
  const spec = MANAGED[key];
  if (!spec) throw new Error(`RuntimeSettings: ${key} is not a managed setting`);

  overrides.set(key, value);
  const rendered = spec.render(value);
  process.env[key] = rendered;

  if (opts.persist === false) {
    return { key, value, source: 'runtime', persisted: false, unchanged: true };
  }

  const file = envFilePath(opts.cwd);
  try {
    let body = '';
    try {
      body = await fs.readFile(file, 'utf8');
    } catch {
      body = ''; // no .env yet: creating one with a single line is correct
    }
    const next = rewriteEnvBody(body, key, rendered);
    if (next === null) {
      return { key, value, source: 'runtime', persisted: true, unchanged: true };
    }
    // Write through a temporary file and rename, so a crash mid-write cannot
    // leave the operator with a truncated .env — the file that decides whether
    // their instance can boot at all.
    const tmp = `${file}.runtime.tmp`;
    await fs.writeFile(tmp, next, 'utf8');
    await fs.rename(tmp, file);
    return { key, value, source: 'runtime', persisted: true, unchanged: false };
  } catch (e) {
    return {
      key,
      value,
      source: 'runtime',
      persisted: false,
      persistError: (e as Error)?.message || String(e),
      unchanged: false,
    };
  }
}

/**
 * Forget every runtime override.
 *
 * For tests only. Exported rather than reached through module internals because
 * a test that poked at the Map directly would pass while the real precedence
 * rule was broken.
 */
export function clearOverridesForTests(): void {
  overrides.clear();
}

/**
 * The remedies this build knows how to apply, by cause.
 *
 * Keyed on the error identifiers already emitted by RemoteBrowserStart.describe
 * and SelfHeal, so attaching a button to a failure is a lookup rather than a
 * second classification that could drift from the first.
 */
export const REMEDIES: Record<string, Remedy> = {
  remote_browser_disabled: {
    key: 'enableRemoteBrowser',
    label: 'Turn on the Remote Browser',
    endpoint: '/browser/enable',
    etaMs: 8_000,
    automatic: true,
  },
  realChromeDisabled: {
    key: 'enableRemoteBrowser',
    label: 'Turn on the Remote Browser',
    endpoint: '/browser/enable',
    etaMs: 8_000,
    automatic: true,
  },
  browser_not_installed: {
    key: 'installBrowser',
    label: 'Get the browser',
    endpoint: '/browser/dependencies/install',
    etaMs: 180_000,
    automatic: true,
  },
  browser_libraries_missing: {
    key: 'installBrowserLibraries',
    label: 'Get the missing system libraries',
    endpoint: '/browser/dependencies/install',
    etaMs: 180_000,
    automatic: true,
  },
  display_unavailable: {
    key: 'startDisplay',
    label: 'Start the screen',
    endpoint: '/browser/desktop/start',
    etaMs: 6_000,
    automatic: true,
  },
  browser_profile_locked: {
    key: 'recoverProfile',
    label: 'Clear the stale lock',
    endpoint: '/browser/real/recover',
    etaMs: 5_000,
    automatic: true,
  },
};

/** The remedy for a cause, if this build can fix it by itself. */
export function remedyFor(cause: string): Remedy | undefined {
  return REMEDIES[cause];
}

/**
 * A self-check that this module and config.ts still parse the environment the
 * same way.
 *
 * `cleanRaw` above is a copy of config.ts's `cleanEnv`, forced by the import
 * cycle. A copy that drifts would mean the getter reports one value and a direct
 * read reports another — the single nastiest failure this design can have, and
 * invisible in normal operation. So the agreement is stated as data a test can
 * execute.
 */
export function settingsSelfCheck(): Array<{ raw: string | undefined; value: boolean }> {
  const cases: Array<string | undefined> = [
    undefined, '', 'true', 'TRUE', 'false', 'False', 'FALSE',
    'banana', ' true ', 'false # was on', 'true#no', '  ',
  ];
  return cases.map((raw) => ({ raw, value: parseBool(raw) }));
}
