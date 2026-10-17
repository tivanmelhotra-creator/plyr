/**
 * LaunchSettings — HOW a profile's Chromium is started (presets, categorized
 * options, Custom Flags), validated in ONE place and turned into an argv array.
 *
 * Three things are kept apart:
 *
 *   PROFILE        which data (user-data-dir, identity)        core/ProfileRegistry
 *   LAUNCH         how the process starts (this file)           a choice per open
 *   APP CONTROL    switches the application owns and that the user cannot set:
 *                  the data dir, the inner profile, the debugging transport,
 *                  visibility (headless), extension loading, the automation
 *                  banner. Asking for one of these is an ERROR with a reason,
 *                  never a silent "last flag wins".
 *
 * Custom Flags are parsed as DATA: one flag per line (or several `--x` tokens
 * on a line), quotes only group a value, and the result is an array handed to
 * Playwright as `args` (execve, no shell). Nothing here is ever concatenated
 * into a command string.
 *
 * Pure: no I/O. The launcher (core/ProfileBrowser) calls buildLaunchArgs().
 */
import { createHash } from 'crypto';

export type LaunchCategory = 'window' | 'startup' | 'background' | 'diagnostics';

export interface LaunchOptionDef {
  id: string;
  category: LaunchCategory;
  label: string;
  description: string;
  /** The exact Chromium switch this option adds. */
  arg: string;
}

export interface LaunchPresetDef {
  id: 'standard' | 'automation' | 'diagnostics';
  label: string;
  description: string;
  /** Option ids turned on by the preset (the user may change them). */
  options: readonly string[];
}

export const LAUNCH_CATEGORIES: ReadonlyArray<{ id: LaunchCategory; label: string }> = [
  { id: 'window', label: 'Window' },
  { id: 'startup', label: 'Startup' },
  { id: 'background', label: 'Background tabs' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

/**
 * Every option has a concrete reason to exist in this project. Not offered on
 * purpose: --disable-web-security, --ignore-certificate-errors, site-isolation
 * switches, GPU switches (Xvfb has no GPU; Playwright already handles it) —
 * they can still be typed as Custom Flags, with a warning.
 */
export const LAUNCH_OPTIONS: readonly LaunchOptionDef[] = [
  { id: 'start-maximized', category: 'window', arg: '--start-maximized', label: 'Start maximized',
    description: 'The window fills the remote desktop, so the viewer shows the page without a black margin.' },
  { id: 'no-first-run', category: 'startup', arg: '--no-first-run', label: 'Skip the first-run screens',
    description: 'A new profile opens straight on a page instead of a welcome screen that takes the first click.' },
  { id: 'no-default-browser-check', category: 'startup', arg: '--no-default-browser-check', label: 'No default-browser question',
    description: 'Removes the info bar that covers the top of the page.' },
  { id: 'disable-background-timer-throttling', category: 'background', arg: '--disable-background-timer-throttling',
    label: 'Full-speed timers in background tabs',
    description: 'Several profile windows share one desktop; without this, timers in a window that is not in front are slowed and waits stall. Costs CPU.' },
  { id: 'disable-backgrounding-occluded-windows', category: 'background', arg: '--disable-backgrounding-occluded-windows',
    label: 'Keep covered windows running',
    description: 'A profile window hidden behind another one keeps rendering, so automation in it behaves as in front.' },
  { id: 'disable-renderer-backgrounding', category: 'background', arg: '--disable-renderer-backgrounding',
    label: 'No renderer priority drop',
    description: 'Background renderers keep their priority; steadier timing for automation, more CPU.' },
  { id: 'enable-logging', category: 'diagnostics', arg: '--enable-logging=stderr', label: 'Chromium log to the server log',
    description: 'Chromium writes its own log to stderr (the server log). May contain page URLs: use only while debugging.' },
  { id: 'verbose-log', category: 'diagnostics', arg: '--v=1', label: 'Verbose log level',
    description: 'More detail in the Chromium log (needs the option above to be useful).' },
  { id: 'auto-devtools', category: 'diagnostics', arg: '--auto-open-devtools-for-tabs', label: 'Open DevTools for every tab',
    description: 'Inspect what a page does. Takes screen space and changes the page size.' },
];

/**
 * `standard` is exactly what the profile launcher always used
 * (start maximized), so picking the default changes nothing.
 */
export const LAUNCH_PRESETS: readonly LaunchPresetDef[] = [
  { id: 'standard', label: 'Standard', options: ['start-maximized'],
    description: 'The normal behaviour of this project: a maximized window on the remote desktop.' },
  { id: 'automation', label: 'Automation',
    options: ['start-maximized', 'no-first-run', 'no-default-browser-check',
      'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding'],
    description: 'Steady automation with several windows on one desktop: no first-run screens, background windows are not slowed down.' },
  { id: 'diagnostics', label: 'Diagnostics', options: ['start-maximized', 'enable-logging', 'verbose-log'],
    description: 'Chromium logs to the server log for troubleshooting. Not for normal use (the log can contain page URLs).' },
];

export const DEFAULT_LAUNCH_PRESET = 'standard';

/** Switches every profile browser needs; not offered, not removable. */
export const REQUIRED_ARGS: readonly string[] = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
];

/** Switches owned by the application. A custom flag with one of these names is refused. */
export const APP_CONTROLLED: Readonly<Record<string, string>> = {
  'user-data-dir': 'the profile\'s data directory is chosen by the profile, not by a flag',
  'profile-directory': 'the profile directory is pinned per profile by the application (core/ChromiumProfileLocation); another one would open different data',
  'remote-debugging-port': 'the debugging connection is managed by the application',
  'remote-debugging-pipe': 'the debugging connection is managed by the application',
  'remote-debugging-address': 'the debugging connection is managed by the application',
  'remote-allow-origins': 'the debugging connection is managed by the application',
  'headless': 'visible / hidden is decided by the run policy (manual = visible, scheduled = hidden)',
  'no-startup-window': 'the application needs the startup window it controls',
  'incognito': 'an incognito window keeps nothing, so the profile would not keep its data',
  'guest': 'a guest window keeps nothing, so the profile would not keep its data',
  'load-extension': 'extensions are loaded by the application (Local Browser / extension runs)',
  'disable-extensions-except': 'extensions are loaded by the application',
  'enable-automation': 'shows the automation banner and is removed on purpose',
  'user-data-migrated': 'internal to Chromium',
};

/** Allowed, but the user must confirm: each weakens a security boundary or changes behaviour app-wide. */
export const RISKY: Readonly<Record<string, string>> = {
  'disable-web-security': 'pages can read data of every other site (same-origin policy off)',
  'ignore-certificate-errors': 'HTTPS errors are ignored: a forged site looks valid',
  'allow-running-insecure-content': 'HTTP content runs inside HTTPS pages',
  'disable-site-isolation-trials': 'removes a defence against cross-site attacks',
  'disable-features': 'replaces Playwright\'s own --disable-features list (Chromium keeps only the last value of a switch)',
  'enable-features': 'replaces any earlier --enable-features list (Chromium keeps only the last value)',
  'user-agent': 'every request uses this user agent; sites may break or flag it',
  'proxy-server': 'all traffic of this browser goes through that proxy',
  'kiosk': 'no window frame or tab strip: closing the window from the viewer gets harder',
};

export const MAX_CUSTOM_FLAGS = 30;
const MAX_FLAG_LEN = 1024;
const FLAG_RE = /^--([a-z0-9][a-z0-9-]*)(?:=([\s\S]*))?$/i;

export interface LaunchSettingsInput {
  preset?: string;
  /** Option id -> on/off, on top of the preset. Unknown ids are errors. */
  options?: Record<string, boolean>;
  /** Text (one flag per line) or a ready list. */
  customFlags?: string | string[];
  /** The user confirmed the risky flags shown in `warnings`. */
  acknowledgeRisk?: boolean;
}

export interface LaunchIssue { flag?: string; option?: string; message: string }

export interface ResolvedLaunch {
  ok: boolean;
  presetId: string;
  /** Option ids on (sorted). */
  options: string[];
  /** Validated custom flags, in the order given. */
  custom: string[];
  /** Final argv for Playwright (required + options + custom). */
  args: string[];
  errors: LaunchIssue[];
  /** Risky flags; `ok` stays false until `acknowledgeRisk`. */
  warnings: LaunchIssue[];
  needsConfirmation: boolean;
  /** Stable fingerprint of what the process is started with. */
  hash: string;
}

/** Name of a switch (`--lang=fa` -> `lang`), lower-case. */
export function switchName(arg: string): string {
  const m = FLAG_RE.exec(arg);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * Split Custom Flags text into arguments. Pure.
 *   one argument per `--` token; whitespace inside quotes belongs to the value;
 *   `--lang="fa IR"` -> `--lang=fa IR` (quotes removed, never interpreted).
 * Returns the tokens and syntax errors (unterminated quote, junk tokens).
 */
export function parseCustomFlags(input: string | string[] | undefined | null): { flags: string[]; errors: LaunchIssue[] } {
  const errors: LaunchIssue[] = [];
  if (input == null || input === '') return { flags: [], errors };
  const lines = Array.isArray(input) ? input.map((x) => String(x ?? '')) : String(input).split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (Array.isArray(input)) { out.push(line); continue; } // a list is already one arg per entry
    let cur = ''; let quote = ''; let has = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (ch === quote) quote = '';
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === '\'') { quote = ch; has = true; continue; }
      if (/\s/.test(ch)) {
        if (has) { out.push(cur); cur = ''; has = false; }
        continue;
      }
      cur += ch; has = true;
    }
    if (quote) errors.push({ flag: line, message: 'Unterminated quote.' });
    else if (has) out.push(cur);
  }
  // A token that is not a switch belongs to the previous one when it was given
  // as `--x value`: Chromium only understands `--x=value`, so say so.
  const flags: string[] = [];
  for (const tok of out) {
    if (!tok.startsWith('--')) {
      errors.push({ flag: tok, message: tok.startsWith('-')
        ? 'Chromium switches start with two dashes (--name or --name=value).'
        : `"${tok}" is not a switch. Write values as --name=value (a page URL cannot be given here).` });
      continue;
    }
    flags.push(tok);
  }
  return { flags, errors };
}

function issueKey(i: LaunchIssue): string { return `${i.flag || ''}|${i.option || ''}|${i.message}`; }

/** Turn a launch selection into a validated argv. Pure. */
export function buildLaunchArgs(input: LaunchSettingsInput = {}): ResolvedLaunch {
  const errors: LaunchIssue[] = [];
  const warnings: LaunchIssue[] = [];
  const byId = new Map(LAUNCH_OPTIONS.map((o) => [o.id, o] as const));

  let presetId = DEFAULT_LAUNCH_PRESET;
  if (input.preset !== undefined && input.preset !== null && input.preset !== '') {
    const p = LAUNCH_PRESETS.find((x) => x.id === input.preset);
    if (p) presetId = p.id;
    else errors.push({ message: `Unknown preset "${String(input.preset).slice(0, 40)}".` });
  }
  const preset = LAUNCH_PRESETS.find((x) => x.id === presetId)!;
  const on = new Set<string>(preset.options);
  for (const [id, want] of Object.entries(input.options || {})) {
    if (!byId.has(id)) { errors.push({ option: id.slice(0, 60), message: `Unknown option "${id.slice(0, 60)}".` }); continue; }
    if (want === true) on.add(id); else if (want === false) on.delete(id);
  }

  const parsed = parseCustomFlags(input.customFlags);
  errors.push(...parsed.errors);
  if (parsed.flags.length > MAX_CUSTOM_FLAGS) errors.push({ message: `At most ${MAX_CUSTOM_FLAGS} custom flags.` });

  const optionArgs = LAUNCH_OPTIONS.filter((o) => on.has(o.id)).map((o) => o.arg);
  const taken = new Map<string, string>(); // switch name -> where it comes from
  for (const a of REQUIRED_ARGS) taken.set(switchName(a), 'required');
  for (const o of LAUNCH_OPTIONS) if (on.has(o.id)) taken.set(switchName(o.arg), `option "${o.label}"`);

  const custom: string[] = [];
  const seen = new Set<string>();
  for (const f of parsed.flags.slice(0, MAX_CUSTOM_FLAGS)) {
    if (f.length > MAX_FLAG_LEN) { errors.push({ flag: f.slice(0, 60) + '…', message: `Too long (max ${MAX_FLAG_LEN} characters).` }); continue; }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(f)) { errors.push({ flag: f.slice(0, 60), message: 'Contains control characters.' }); continue; }
    const m = FLAG_RE.exec(f);
    if (!m) { errors.push({ flag: f.slice(0, 80), message: 'Not a valid switch: use --name or --name=value (letters, digits and dashes in the name).' }); continue; }
    const name = m[1]!.toLowerCase();
    if (APP_CONTROLLED[name]) { errors.push({ flag: f.slice(0, 80), message: `--${name} is controlled by the application: ${APP_CONTROLLED[name]}.` }); continue; }
    if (seen.has(name)) { errors.push({ flag: f.slice(0, 80), message: `--${name} is given twice; Chromium would keep only one of them.` }); continue; }
    const from = taken.get(name);
    if (from) {
      if (from === 'required') { errors.push({ flag: f.slice(0, 80), message: `--${name} is always set by the application.` }); continue; }
      errors.push({ flag: f.slice(0, 80), message: `--${name} conflicts with the ${from}; turn that option off or remove this flag.` });
      continue;
    }
    seen.add(name);
    if (RISKY[name]) warnings.push({ flag: f.slice(0, 80), message: `--${name}: ${RISKY[name]}.` });
    custom.push(f);
  }

  const dedupe = (l: LaunchIssue[]) => { const s = new Set<string>(); return l.filter((i) => (s.has(issueKey(i)) ? false : (s.add(issueKey(i)), true))); };
  const errs = dedupe(errors);
  const warns = dedupe(warnings);
  const needsConfirmation = warns.length > 0 && input.acknowledgeRisk !== true;
  const args = [...REQUIRED_ARGS, ...optionArgs, ...custom];
  const options = [...on].sort();
  const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
  return { ok: errs.length === 0 && !needsConfirmation, presetId, options, custom, args, errors: errs, warnings: warns, needsConfirmation, hash };
}

/** Everything the Open Browser form needs. */
export function launchCatalogue() {
  return {
    categories: LAUNCH_CATEGORIES,
    options: LAUNCH_OPTIONS,
    presets: LAUNCH_PRESETS,
    defaultPreset: DEFAULT_LAUNCH_PRESET,
    required: REQUIRED_ARGS,
    appControlled: Object.keys(APP_CONTROLLED).map((k) => ({ flag: `--${k}`, reason: APP_CONTROLLED[k] })),
    risky: Object.keys(RISKY).map((k) => ({ flag: `--${k}`, reason: RISKY[k] })),
    maxCustomFlags: MAX_CUSTOM_FLAGS,
  };
}

/** True when the input carries any choice at all (else the launcher keeps its old default). */
export function hasLaunchChoice(input: LaunchSettingsInput | null | undefined): boolean {
  if (!input) return false;
  return !!(input.preset || (input.options && Object.keys(input.options).length) ||
    (Array.isArray(input.customFlags) ? input.customFlags.length : (input.customFlags || '').trim()));
}
