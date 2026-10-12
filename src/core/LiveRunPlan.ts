/**
 * LiveRunPlan — what the live run tab may know about a run BEFORE it happens.
 *
 * The live page (public/live-view.html) is opened with a share token. Its event
 * stream only reports steps that have STARTED, so on its own it cannot draw the
 * "Execution steps (8)" list with the steps still to come. This module turns a
 * job's steps into that plan.
 *
 * WHAT IT DELIBERATELY LEAVES OUT
 * -------------------------------
 * A share link can be forwarded. The plan therefore carries, per step, only the
 * action id and ONE short, non-secret "target":
 *   - a URL reduced to origin + path (no query, no hash: tokens live there),
 *   - a CSS selector (clipped),
 *   - a wait time in ms,
 *   - an extension name.
 * Typed values, HTTP bodies/headers, cookies, bot tokens, code and messages are
 * never copied, because any of them can be a credential.
 *
 * Only the TOP-LEVEL chain is planned. Steps inside branches / loops run (or
 * not) depending on data, so they are not promised up front; the page inserts
 * them as they actually start (LiveTab.mergePlan).
 *
 * Pure: no I/O, unit-tested directly.
 */

export interface PlannedStep {
  action: string;
  /** Short, non-secret description of what the step acts on. May be ''. */
  target: string;
}

export interface LiveRunPlan {
  steps: PlannedStep[];
}

const MAX_PLANNED = 200;
const MAX_TARGET = 160;

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_TARGET ? t.slice(0, MAX_TARGET - 1) + '\u2026' : t;
}

/**
 * origin + path of an http(s) URL; '' for anything else. An expression
 * (`{{ $json.url }}`) is shown as written: it holds no value yet.
 */
export function safeUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  if (/^\{\{[\s\S]*\}\}$/.test(s)) return clip(s);
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const path = u.pathname === '/' ? '' : u.pathname;
    return clip(u.origin + path);
  } catch {
    return '';
  }
}

const URL_ACTIONS = new Set(['goto', 'launch', 'http-request']);
const SELECTOR_ACTIONS = new Set([
  'click', 'dblclick', 'hover', 'focus', 'fill', 'type', 'select', 'check', 'uncheck', 'upload',
  'extract', 'extract-data', 'attribute', 'download', 'wait-element', 'remove-element', 'switch-frame',
]);
const MS_ACTIONS = new Set(['wait', 'delay']);

function paramsOf(step: Record<string, unknown>): Record<string, unknown> {
  const p = step.params;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

export function targetOf(step: Record<string, unknown>): string {
  const action = String(step.action || '');
  const p = paramsOf(step);
  if (URL_ACTIONS.has(action)) return safeUrl(p.url);
  if (action === 'open-extension') return typeof p.extension === 'string' ? clip(p.extension) : '';
  if (MS_ACTIONS.has(action)) {
    const ms = Number(p.ms);
    if (p.ms !== undefined && p.ms !== '' && Number.isFinite(ms) && ms >= 0) return `${Math.round(ms)}ms`;
    if (typeof p.selector === 'string' && p.selector.trim()) return clip(p.selector);
    return '';
  }
  if (SELECTOR_ACTIONS.has(action)) return typeof p.selector === 'string' ? clip(p.selector) : '';
  return '';
}

/** The run's top-level, enabled steps as the live tab may show them. */
export function buildLivePlan(steps: unknown): LiveRunPlan {
  const out: PlannedStep[] = [];
  if (!Array.isArray(steps)) return { steps: out };
  for (const s of steps) {
    if (out.length >= MAX_PLANNED) break;
    if (!s || typeof s !== 'object') continue;
    const step = s as Record<string, unknown>;
    if (step.disabled === true) continue; // never runs, emits no event
    if (typeof step.action !== 'string' || !step.action) continue;
    out.push({ action: step.action, target: targetOf(step) });
  }
  return { steps: out };
}

/**
 * Job data for a re-run of the same work (the live tab's Restart button).
 * The bookkeeping a run picks up while it runs (cancel flag, profile wait
 * marker) is dropped, and a schedule's fire becomes a plain run: it is the
 * operator who restarts it, so it is a manual (visible) run.
 */
export function restartJobData(data: Record<string, unknown>, fromJobId: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data };
  for (const k of Object.keys(next)) {
    if (k === '__cancelledByUser' || k === '__waitingFor' || k === '__scheduled' || k.startsWith('__schedule')) {
      delete next[k];
    }
  }
  next.__origin = 'manual';
  next.__restartOf = String(fromJobId);
  return next;
}
