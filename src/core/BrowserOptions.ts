'use strict';

/**
 * BrowserOptions — the SERVER side of the per-run browser option catalog.
 *
 * The catalog itself lives in `public/js/browser-options.js` (one source of
 * truth: the editor's "Add option" panel renders it, this module enforces it).
 * Like `ActionCatalog`, the browser IIFE is evaluated here with a fake `window`
 * so there is no second list that could drift.
 *
 * What this module adds on top of the shared file:
 *   - a Zod whitelist (`browserOptionsSchema`): unknown keys are refused, never
 *     silently dropped (a node that looks configured and runs unconfigured is
 *     the failure this prevents);
 *   - `planFor()`: the Playwright launch/context keys for a run, per tier;
 *   - `findLaunchOptions()`: which options a workflow's Launch Browser node asks
 *     for, so the pipeline can apply them when it opens the browser.
 *
 * Fail-closed: if the catalog cannot be loaded the schema accepts NOTHING.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export type OptionKind = 'boolean' | 'int' | 'number' | 'string' | 'enum' | 'set' | 'headers' | 'lines';

export interface OptionDef {
  id: string;
  group: string;
  kind: OptionKind;
  scope: 'launch' | 'context';
  label: { fa: string; en: string };
  help: { fa: string; en: string };
  min?: number;
  max?: number;
  unit?: string;
  values?: string[];
  pattern?: string;
  secret?: boolean;
  sample: unknown;
  bad: unknown;
}

export interface Diagnostic {
  level: 'info' | 'warn';
  ids: string[];
  code: string;
  fa: string;
  en: string;
}

export type BrowserTier = 'vip' | 'free' | 'attached';

export interface BrowserPlan {
  launch: Record<string, any>;
  context: Record<string, any>;
  ignored: Array<{ id: string; reason: string }>;
  /** '' when the run asks for nothing; otherwise a stable fingerprint. */
  hash: string;
}

interface SharedApi {
  OPTIONS: OptionDef[];
  check(def: OptionDef | string, value: unknown): string | null;
  validate(o: unknown): { ok: boolean; options: Record<string, unknown>; errors: Array<{ id: string; code: string }> };
  diagnose(o: unknown, ctx?: { actions?: string[] }): Diagnostic[];
  buildPlan(o: unknown, opts?: { tier?: BrowserTier }): BrowserPlan;
  effectiveHeadless(o: unknown, runHeadless?: boolean): boolean;
}

let cache: SharedApi | null = null;
let loadError = '';

function catalogPath(): string {
  return path.join(__dirname, '..', '..', 'public', 'js', 'browser-options.js');
}

function load(): SharedApi | null {
  if (cache) return cache;
  try {
    const source = fs.readFileSync(catalogPath(), 'utf8');
    const win: { BROWSER_OPTIONS?: SharedApi } = {};
    // eslint-disable-next-line no-new-func
    new Function('window', source).call(win, win);
    if (!win.BROWSER_OPTIONS || !Array.isArray(win.BROWSER_OPTIONS.OPTIONS)) {
      loadError = 'browser-options.js did not expose window.BROWSER_OPTIONS';
      return null;
    }
    cache = win.BROWSER_OPTIONS;
    return cache;
  } catch (e) {
    loadError = `browser-options.js could not be loaded: ${(e as Error).message}`;
    return null;
  }
}

export function browserOptionsLoadError(): string {
  load();
  return loadError;
}

export function browserOptionDefs(): OptionDef[] {
  return load()?.OPTIONS ?? [];
}

function baseType(d: OptionDef): z.ZodTypeAny {
  switch (d.kind) {
    case 'boolean': return z.boolean();
    case 'int': return z.number().int();
    case 'number': return z.number();
    case 'string': return z.string();
    case 'enum': return z.string();
    case 'set': return z.array(z.string());
    case 'lines': return z.array(z.string());
    case 'headers': return z.record(z.string());
    default: return z.never();
  }
}

let schemaCache: z.ZodTypeAny | null = null;

/**
 * Zod whitelist: exactly the catalog's option ids, each with its own type, and
 * the shared range/format rules applied through one `superRefine` so the
 * browser UI and the server cannot disagree about what is valid.
 */
export function browserOptionsSchema(): z.ZodTypeAny {
  if (schemaCache) return schemaCache;
  const api = load();
  if (!api) return (schemaCache = z.never());
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const d of api.OPTIONS) {
    shape[d.id] = baseType(d)
      .superRefine((v, ctx) => {
        const code = api.check(d, v);
        if (code) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${d.id}: ${code}`, params: { code } });
      })
      .optional();
  }
  schemaCache = z.object(shape).strict();
  return schemaCache;
}

export interface ParsedOptions {
  ok: boolean;
  options: Record<string, unknown>;
  errors: string[];
}

export function parseBrowserOptions(input: unknown): ParsedOptions {
  if (input === undefined || input === null || input === '') return { ok: true, options: {}, errors: [] };
  let value: unknown = input;
  // The editor stores it as an object; a JSON string (hand-written workflow) is accepted too.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { ok: false, options: {}, errors: ['browserOptions: not valid JSON'] }; }
  }
  const res = browserOptionsSchema().safeParse(value);
  if (res.success) {
    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(res.data as Record<string, unknown>)) if (v !== undefined) options[k] = v;
    return { ok: true, options, errors: [] };
  }
  const errors = res.error.issues.map((i) => {
    if (i.code === 'unrecognized_keys') return `unknown option: ${(i as any).keys.join(', ')}`;
    const where = i.path.length ? `${i.path.join('.')}: ` : '';
    return i.message.startsWith(where) ? i.message : `${where}${i.message}`;
  });
  return { ok: false, options: {}, errors };
}

export function planFor(options: Record<string, unknown> | undefined, tier: BrowserTier): BrowserPlan {
  const api = load();
  if (!api || !options) return { launch: {}, context: {}, ignored: [], hash: '' };
  return api.buildPlan(options, { tier });
}

export function diagnoseBrowserOptions(options: Record<string, unknown>, actions: string[] = []): Diagnostic[] {
  return load()?.diagnose(options, { actions }) ?? [];
}

export function effectiveHeadless(options: Record<string, unknown> | undefined, runHeadless: boolean): boolean {
  const api = load();
  return api ? api.effectiveHeadless(options, runHeadless) : runHeadless;
}

const LAUNCH_ACTIONS = new Set(['launch', 'launch-browser', 'launch_browser']);
const CHILD_KEYS = ['then', 'else', 'steps', 'catch', 'finally', 'fallback'] as const;

/** Depth-first walk of a step tree (every branch kind the runtime has). */
function walk(steps: any[] | undefined, visit: (s: any) => boolean | void): boolean {
  if (!Array.isArray(steps)) return false;
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    if (visit(s) === true) return true;
    for (const k of CHILD_KEYS) if (walk(s[k], visit)) return true;
    if (s.cases && typeof s.cases === 'object') {
      for (const arr of Object.values(s.cases)) if (walk(arr as any[], visit)) return true;
    }
    if (Array.isArray(s.paths)) for (const p of s.paths) if (walk(p?.steps, visit)) return true;
  }
  return false;
}

export function allActions(steps: any[] | undefined): string[] {
  const seen = new Set<string>();
  walk(steps, (s) => { if (typeof s.action === 'string') seen.add(s.action); });
  return [...seen];
}

/**
 * The options of the FIRST Launch Browser node that carries any. The pipeline
 * opens its browser before the step loop, so this is what the initial context is
 * built from; a later Launch node (after Close Browser) reads its own.
 */
export function findLaunchOptions(steps: any[] | undefined): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  walk(steps, (s) => {
    if (!LAUNCH_ACTIONS.has(String(s.action))) return;
    const raw = s.params?.browserOptions;
    if (raw === undefined || raw === null || raw === '') return;
    const parsed = parseBrowserOptions(raw);
    if (parsed.ok && Object.keys(parsed.options).length) { found = parsed.options; return true; }
  });
  return found;
}

export function optionsOfStep(step: any): Record<string, unknown> | undefined {
  const raw = step?.params?.browserOptions;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = parseBrowserOptions(raw);
  return parsed.ok && Object.keys(parsed.options).length ? parsed.options : undefined;
}

/** Human summary used in logs: ids only — secrets never reach the log. */
export function describeOptions(options: Record<string, unknown>): string {
  const defs = new Map(browserOptionDefs().map((d) => [d.id, d] as const));
  return Object.entries(options)
    .map(([k, v]) => (defs.get(k)?.secret ? `${k}=***` : `${k}=${JSON.stringify(v)}`))
    .join(', ');
}
