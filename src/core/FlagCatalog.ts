/**
 * FlagCatalog — the launch-flag catalog (owner brief section 5), the SINGLE
 * source of truth. The UI (Screen C), the server validation and the ONE argv
 * builder used by manual opens AND automated runs all read this table.
 * Adding a flag = adding one entry here.
 *
 * The API accepts ONLY catalog ids with typed values (never a raw flag
 * string, 5.7). argv is built as an ARRAY (handed to execve by Playwright;
 * no shell ever sees it). Text values may not contain control characters or
 * newlines. Several entries that map onto --blink-settings are merged into
 * ONE comma-separated switch (5.6, Load images).
 *
 * Pure: no I/O.
 */

export type FlagInput =
  | { kind: 'none' }
  | { kind: 'bool' }                                                             // On / Off
  | { kind: 'choice'; options: ReadonlyArray<{ value: string; label: string; description: string }> }
  | { kind: 'number'; min: number; max: number; step: number; unit?: string }
  | { kind: 'numbers'; fields: ReadonlyArray<{ key: string; label: string; min: number; max: number; step: number; unit?: string }> }
  | { kind: 'text'; maxLength: number; example: string; pattern?: RegExp; patternHint?: string };

export type FlagValue = true | boolean | string | number | Record<string, number>;

export interface FlagDef {
  id: string;
  label: string;
  description: string;
  /** The Chromium switch, shown small and muted on the row (no leading dashes in data, shown with them). */
  flag: string;
  input: FlagInput;
  /** Value used when the row is selected without a value yet. */
  default?: FlagValue;
  conflictsWith?: readonly string[];
  /** Never log the value (only that it is set). */
  secretValue?: boolean;
  /** How the value becomes argv: switches, or contributions to a merged switch. */
  toArgs(v: FlagValue): { args?: string[]; blink?: string[] };
}

const LOCALES = ['en-US', 'fa-IR', 'de-DE', 'fr-FR', 'es-ES', 'tr-TR', 'ar-SA', 'ru-RU', 'zh-CN', 'ja-JP'] as const;
const LOCALE_LABEL: Record<string, string> = {
  'en-US': 'English (US)', 'fa-IR': 'Persian (Iran)', 'de-DE': 'German', 'fr-FR': 'French', 'es-ES': 'Spanish',
  'tr-TR': 'Turkish', 'ar-SA': 'Arabic (Saudi Arabia)', 'ru-RU': 'Russian', 'zh-CN': 'Chinese (Simplified)', 'ja-JP': 'Japanese',
};

export const FLAG_CATALOG: readonly FlagDef[] = [
  { id: 'window-size', label: 'Window size', description: 'Open the browser window at this size (pixels).', flag: 'window-size',
    input: { kind: 'numbers', fields: [{ key: 'w', label: 'Width', min: 320, max: 7680, step: 1, unit: 'px' }, { key: 'h', label: 'Height', min: 240, max: 4320, step: 1, unit: 'px' }] },
    default: { w: 1280, h: 800 }, conflictsWith: ['start-maximized'],
    toArgs: (v) => { const o = v as Record<string, number>; return { args: [`--window-size=${o.w},${o.h}`] }; } },
  { id: 'start-maximized', label: 'Start maximized', description: 'Open the window maximized on the desktop.', flag: 'start-maximized',
    input: { kind: 'none' }, conflictsWith: ['window-size'], toArgs: () => ({ args: ['--start-maximized'] }) },
  { id: 'window-position', label: 'Window position', description: 'Place the window at this position on the desktop (pixels from the top-left).', flag: 'window-position',
    input: { kind: 'numbers', fields: [{ key: 'x', label: 'X', min: -10000, max: 10000, step: 1, unit: 'px' }, { key: 'y', label: 'Y', min: -10000, max: 10000, step: 1, unit: 'px' }] },
    default: { x: 0, y: 0 }, toArgs: (v) => { const o = v as Record<string, number>; return { args: [`--window-position=${o.x},${o.y}`] }; } },
  { id: 'load-images', label: 'Load images', description: 'Off: pages load without pictures (faster, less data).', flag: 'blink-settings',
    input: { kind: 'bool' }, default: false, toArgs: (v) => (v === false ? { blink: ['imagesEnabled=false'] } : {}) },
  { id: 'autoplay-policy', label: 'Autoplay policy', description: 'When pages may start playing sound or video by themselves.', flag: 'autoplay-policy',
    input: { kind: 'choice', options: [
      { value: 'no-user-gesture-required', label: 'Allow without click', description: 'Media may play as soon as a page loads.' },
      { value: 'user-gesture-required', label: 'Require a click', description: 'Media plays only after a click on the site.' },
      { value: 'document-user-activation-required', label: 'Require a click on each page', description: 'Every page needs its own click first.' },
    ] }, default: 'user-gesture-required', toArgs: (v) => ({ args: [`--autoplay-policy=${String(v)}`] }) },
  { id: 'mute-audio', label: 'Mute audio', description: 'No sound from any tab.', flag: 'mute-audio', input: { kind: 'none' }, toArgs: () => ({ args: ['--mute-audio'] }) },
  { id: 'restore-last-session', label: 'Restore last tabs', description: 'Reopen the tabs that were open when this browser was last closed.', flag: 'restore-last-session',
    input: { kind: 'none' }, toArgs: () => ({ args: ['--restore-last-session'] }) },
  { id: 'device-scale', label: 'Device scale', description: 'Zoom the whole browser UI and pages (1 = normal).', flag: 'force-device-scale-factor',
    input: { kind: 'number', min: 0.5, max: 3, step: 0.25, unit: '×' }, default: 1, toArgs: (v) => ({ args: [`--force-device-scale-factor=${Number(v)}`] }) },
  { id: 'user-agent', label: 'User agent', description: 'The browser identifies itself with this text to every site.', flag: 'user-agent',
    input: { kind: 'text', maxLength: 300, example: 'Mozilla/5.0 (X11; Linux x86_64) …' }, toArgs: (v) => ({ args: [`--user-agent=${String(v)}`] }) },
  { id: 'lang', label: 'Language', description: 'The browser and pages ask for this language.', flag: 'lang',
    input: { kind: 'choice', options: LOCALES.map((l) => ({ value: l, label: LOCALE_LABEL[l]!, description: l })) }, default: 'en-US',
    toArgs: (v) => ({ args: [`--lang=${String(v)}`] }) },
  { id: 'disable-gpu', label: 'Disable GPU', description: 'Draw without the graphics card (helps on some remote desktops).', flag: 'disable-gpu',
    input: { kind: 'none' }, toArgs: () => ({ args: ['--disable-gpu'] }) },
  { id: 'disable-notifications', label: 'Block notifications', description: 'Sites cannot ask to show notifications.', flag: 'disable-notifications',
    input: { kind: 'none' }, toArgs: () => ({ args: ['--disable-notifications'] }) },
  { id: 'force-dark-mode', label: 'Force dark mode', description: 'Browser UI and supporting pages in dark colors.', flag: 'force-dark-mode',
    input: { kind: 'none' }, toArgs: () => ({ args: ['--force-dark-mode'] }) },
  { id: 'proxy-server', label: 'Proxy server', description: 'Send all traffic of this browser through this proxy (no user name or password).', flag: 'proxy-server',
    input: { kind: 'text', maxLength: 200, example: 'proxy.example.com:8080 or socks5://10.0.0.2:1080',
      pattern: /^(?:(?:https?|socks4|socks5):\/\/)?[A-Za-z0-9.-]+:\d{1,5}$/, patternHint: 'host:port or scheme://host:port (http, https, socks4, socks5)' },
    secretValue: true, toArgs: (v) => ({ args: [`--proxy-server=${String(v)}`] }) },
];

const BY_ID = new Map(FLAG_CATALOG.map((d) => [d.id, d] as const));
export function flagDef(id: string): FlagDef | undefined { return BY_ID.get(id); }

/** 5.7: never offered, and refused even if sent (by switch name, also as a catalog-looking id). */
export const FORBIDDEN_SWITCHES: readonly RegExp[] = [
  /^user-data-dir$/, /^profile-directory$/, /^remote-debugging/, /^headless/, /^no-sandbox$/, /^disable-web-security$/,
  /^ignore-certificate-errors$/, /^incognito$/, /^single-process$/, /^load-extension$/, /^disable-extensions$/, /^disable-extensions-except$/,
];
export const isForbiddenSwitch = (name: string): boolean => FORBIDDEN_SWITCHES.some((r) => r.test(name.replace(/^--/, '').split('=')[0]!.toLowerCase()));

/** What a profile stores: { flags: { <catalogId>: value } }. Default = no flags at all (5.2). */
export interface ProfileLaunchFlags { flags: Record<string, unknown> }

export interface FlagIssue { id: string; message: string }

export interface BuiltFlags {
  ok: boolean;
  /** Validated selection (only known ids, typed values). */
  selection: Record<string, FlagValue>;
  /** The argv contribution, ordered as the catalog, deduped, --blink-settings merged once. */
  args: string[];
  errors: FlagIssue[];
  /** Stored ids no longer in the catalog: skipped, reported, never a crash (5.10). */
  unsupported: string[];
  /** Safe for logs: values of secret flags replaced. */
  logSafe: string[];
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/;

function validateValue(d: FlagDef, raw: unknown): { ok: true; value: FlagValue } | { ok: false; message: string } {
  const i = d.input;
  switch (i.kind) {
    case 'none':
      return raw === true || raw === undefined || raw === null ? { ok: true, value: true } : { ok: false, message: 'This flag takes no value.' };
    case 'bool':
      if (raw === undefined && typeof d.default === 'boolean') return { ok: true, value: d.default };
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, message: 'Choose On or Off.' };
    case 'choice': {
      const v = raw === undefined ? d.default : raw;
      return typeof v === 'string' && i.options.some((o) => o.value === v) ? { ok: true, value: v } : { ok: false, message: 'Choose one of the options.' };
    }
    case 'number': {
      const v = raw === undefined ? d.default : raw;
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return { ok: false, message: 'Enter a number.' };
      if (n < i.min || n > i.max) return { ok: false, message: `Between ${i.min} and ${i.max}.` };
      const steps = (n - i.min) / i.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) return { ok: false, message: `In steps of ${i.step}.` };
      return { ok: true, value: n };
    }
    case 'numbers': {
      const v = (raw === undefined ? d.default : raw) as Record<string, unknown> | undefined;
      if (!v || typeof v !== 'object') return { ok: false, message: 'Enter every value.' };
      const out: Record<string, number> = {};
      for (const f of i.fields) {
        const x = v[f.key];
        const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
        if (!Number.isInteger(n)) return { ok: false, message: `${f.label}: enter a whole number.` };
        if (n < f.min || n > f.max) return { ok: false, message: `${f.label}: between ${f.min} and ${f.max}.` };
        out[f.key] = n;
      }
      return { ok: true, value: out };
    }
    case 'text': {
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: 'Enter a value.' };
      const v = raw.trim();
      if (CTRL.test(v)) return { ok: false, message: 'No line breaks or control characters.' };
      if (Array.from(v).length > i.maxLength) return { ok: false, message: `At most ${i.maxLength} characters.` };
      if (d.id === 'proxy-server' && /@/.test(v)) return { ok: false, message: 'User name and password are not allowed in the proxy address.' };
      if (i.pattern && !i.pattern.test(v)) return { ok: false, message: `Use ${i.patternHint || 'the shown format'}.` };
      return { ok: true, value: v };
    }
  }
}

/**
 * Validate a stored or submitted selection and build its argv (5.11). Pure.
 * Order: catalog order (stable, independent of the input's key order).
 * Conflicts: both selected -> error on the later one (the UI deselects the
 * other before saving, 5.9; the server refuses it).
 */
export function buildFlags(input: unknown): BuiltFlags {
  const errors: FlagIssue[] = [];
  const unsupported: string[] = [];
  const selection: Record<string, FlagValue> = {};
  const raw = (input && typeof input === 'object' && (input as ProfileLaunchFlags).flags && typeof (input as ProfileLaunchFlags).flags === 'object')
    ? (input as ProfileLaunchFlags).flags as Record<string, unknown> : {};
  for (const [id, v] of Object.entries(raw)) {
    if (isForbiddenSwitch(id)) { errors.push({ id: id.slice(0, 60), message: `--${id.slice(0, 60)} is controlled by the application and cannot be set.` }); continue; }
    const d = BY_ID.get(id);
    if (!d) { unsupported.push(id.slice(0, 60)); continue; }
    const r = validateValue(d, v);
    if (!r.ok) { errors.push({ id, message: r.message }); continue; }
    selection[id] = r.value;
  }
  for (const d of FLAG_CATALOG) {
    if (!(d.id in selection)) continue;
    for (const c of d.conflictsWith || []) {
      if (c in selection && FLAG_CATALOG.findIndex((x) => x.id === c) < FLAG_CATALOG.findIndex((x) => x.id === d.id)) {
        errors.push({ id: d.id, message: `Cannot be combined with "${BY_ID.get(c)!.label}".` });
      }
    }
  }
  const args: string[] = [];
  const blink: string[] = [];
  const logSafe: string[] = [];
  for (const d of FLAG_CATALOG) {
    if (!(d.id in selection)) continue;
    const out = d.toArgs(selection[d.id]!);
    for (const a of out.args || []) {
      if (!args.includes(a)) { args.push(a); logSafe.push(d.secretValue ? `--${d.flag}=(set)` : a); }
    }
    for (const b of out.blink || []) if (!blink.includes(b)) blink.push(b);
  }
  if (blink.length) { const a = `--blink-settings=${blink.join(',')}`; args.push(a); logSafe.push(a); }
  return { ok: errors.length === 0, selection, args, errors, unsupported, logSafe };
}

/** What GET /profiles/launch-options shows of the catalog (RegExps become a hint string). */
export function catalogView() {
  return FLAG_CATALOG.map((d) => ({
    id: d.id, label: d.label, description: d.description, flag: `--${d.flag}`, default: d.default ?? null,
    conflictsWith: d.conflictsWith || [],
    input: d.input.kind === 'text' ? { kind: 'text', maxLength: d.input.maxLength, example: d.input.example, hint: d.input.patternHint || null } : d.input,
  }));
}
