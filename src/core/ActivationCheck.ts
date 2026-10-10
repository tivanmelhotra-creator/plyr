/**
 * ActivationCheck — the blocking errors that must stop a workflow from being
 * ACTIVATED (frozen and handed to background runs: schedules, triggers, API).
 *
 * `validateSteps` sanitises a step tree and throws on the FIRST shape problem.
 * That is right for a run request, but activation needs more: a design that is
 * well-formed JSON can still be guaranteed to fail at run time (an action the
 * runtime does not implement, a Click node with no selector, ...). Activating
 * it would schedule a failure. So activation collects EVERY blocking problem,
 * with a node path the user can find, and refuses while any remain.
 *
 * Rules mirror what the runtime itself throws on (src/pipeline.ts) and the
 * editor's own validateGraph (public/js/graph-serialize.js). Only conditions
 * readable from the step tree are checked; a disabled node is skipped exactly
 * like the runtime skips it. Values containing `{{ expressions }}` count as
 * present: they are resolved at run time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isKnownAction, actionCatalogSize } from './ActionCatalog';
import { isTriggerAction } from './TriggerEngine';
import { OPEN_EXTENSION_ACTIONS } from './ExtensionStep';
import { isStopAndError } from './ErrorPolicy';

export interface ActivationIssue {
  /** Dotted position in the tree, 1-based (e.g. "3" or "4.then.1"). */
  path: string;
  action: string;
  message: string;
}

/** Actions the runtime dispatches by an alias the editor catalogue does not list. */
const RUNTIME_ALIASES = new Set([
  'navigate', 'goto-url', 'close', 'close_browser', 'close_tab', 'cookies', 'css', 'inject-css',
  'download-file', 'drag', 'dragAndDrop', 'export', 'export_data', 'fetch', 'http', 'api',
  'get-data', 'scrape', 'json-parse', 'parse_json', 'launch-browser', 'launch_browser', 'mark',
  'mark-elements', 'move-mouse', 'mouse', 'notify', 'remove', 'hide', 'set-variable', 'set_variable',
  'transform', 'switch_frame', 'switch_tab', 'handle_dialog', 'upload-file', 'break', 'continue',
  'return', 'fail', 'stop_and_error', 'stop-and-error', 'stopAndError', 'set', 'get', 'accept',
  'copy', 'paste', 'remove-element', 'open_extension',
]);

const has = (v: unknown): boolean =>
  v !== undefined && v !== null && (typeof v !== 'string' || v.trim() !== '');

/** Required params per action (any ONE key of an inner array satisfies it). */
const REQUIRED: Record<string, { keys: string[]; label: string }[]> = {
  goto: [{ keys: ['url'], label: 'a URL' }],
  navigate: [{ keys: ['url'], label: 'a URL' }],
  'goto-url': [{ keys: ['url'], label: 'a URL' }],
  click: [{ keys: ['selector'], label: 'a selector' }],
  dblclick: [{ keys: ['selector'], label: 'a selector' }],
  hover: [{ keys: ['selector'], label: 'a selector' }],
  focus: [{ keys: ['selector'], label: 'a selector' }],
  fill: [{ keys: ['selector'], label: 'a selector' }],
  type: [{ keys: ['selector'], label: 'a selector' }],
  press: [{ keys: ['text', 'key'], label: 'a key' }],
  select: [{ keys: ['selector'], label: 'a selector' }],
  check: [{ keys: ['selector'], label: 'a selector' }],
  uncheck: [{ keys: ['selector'], label: 'a selector' }],
  upload: [{ keys: ['selector'], label: 'a selector' }, { keys: ['path', 'files', 'filePath'], label: 'a file path' }],
  download: [{ keys: ['selector'], label: 'a selector' }],
  extract: [{ keys: ['selector'], label: 'a selector' }],
  'extract-data': [{ keys: ['selector'], label: 'a selector' }],
  attribute: [{ keys: ['selector'], label: 'a selector' }],
  'remove-element': [{ keys: ['selector'], label: 'a selector' }],
  'wait-element': [{ keys: ['selector'], label: 'a selector' }],
  'add-style': [{ keys: ['css', 'style'], label: 'CSS content' }],
  'drag-drop': [{ keys: ['source', 'selector'], label: 'a source selector' }],
  'http-request': [{ keys: ['url'], label: 'a URL' }],
  variable: [{ keys: ['name', 'target'], label: 'a variable name' }],
  switch: [{ keys: ['variable'], label: 'a variable' }],
  foreach: [{ keys: ['items'], label: 'an items variable' }],
};

/** Actions whose `url` param is handed to the browser / HTTP client as-is. */
const URL_ACTIONS = new Set(['goto', 'navigate', 'goto-url', 'http-request', 'fetch', 'http', 'api']);

/**
 * Why `raw` is not a URL the runtime can open, or null when it is (or when it
 * is an expression resolved at run time). Playwright's page.goto() refuses
 * anything without a scheme ("Cannot navigate to invalid URL"), so `arena.ai`
 * is filled in but still guaranteed to fail.
 */
export function urlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.includes('{{')) return null;
  // `localhost:3000` / `example.com:8080` parse as a "scheme" - they are hosts.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v) || /^[^/:]+:\d+(\/|$)/.test(v)) {
    return `has an incomplete URL "${v.slice(0, 80)}" - add https:// (for example https://${v.replace(/^\/+/, '').slice(0, 60)})`;
  }
  let u: URL;
  try { u = new URL(v); } catch { return `has an invalid URL "${v.slice(0, 80)}"`; }
  if (!['http:', 'https:', 'about:', 'file:', 'data:', 'chrome:', 'chrome-extension:'].includes(u.protocol)) {
    return `has a URL with an unsupported scheme "${u.protocol}"`;
  }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.hostname) {
    return `has a URL without a host "${v.slice(0, 80)}"`;
  }
  return null;
}

function paramsOf(step: any): Record<string, unknown> {
  if (step && typeof step.params === 'object' && step.params && !Array.isArray(step.params)) return step.params;
  return step && typeof step === 'object' ? step : {};
}

function actionExists(action: string): boolean {
  // A catalogue that failed to load must not make every workflow un-activatable.
  if (actionCatalogSize() === 0) return true;
  return isKnownAction(action) || RUNTIME_ALIASES.has(action) || isTriggerAction(action)
    || (OPEN_EXTENSION_ACTIONS as readonly string[]).includes(action);
}

export interface ActivationOptions {
  codeNodeEnabled?: boolean;
  /** Extra module ids installed under modules/ (runtime fallback). */
  moduleExists?: (action: string) => boolean;
}

export function activationIssues(steps: unknown, opts: ActivationOptions = {}): ActivationIssue[] {
  const issues: ActivationIssue[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return [{ path: '-', action: '-', message: 'The workflow has no nodes' }];
  }
  let runnable = 0;

  const walk = (list: unknown, prefix: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((step: any, i: number) => {
      const path = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      if (!step || typeof step !== 'object') {
        issues.push({ path, action: '-', message: 'is not a valid node' });
        return;
      }
      const action = typeof step.action === 'string' ? step.action.trim() : '';
      if (step.disabled === true) return; // skipped at run time, like the runtime does
      runnable++;
      if (!action) { issues.push({ path, action: '-', message: 'has no action' }); return; }
      if (!isStopAndError(step) && !actionExists(action) && !(opts.moduleExists && opts.moduleExists(action))) {
        issues.push({ path, action, message: `uses an unknown action "${action}"` });
      }
      const p = paramsOf(step);
      for (const req of REQUIRED[action] || []) {
        if (!req.keys.some((k) => has(p[k]))) issues.push({ path, action, message: `needs ${req.label}` });
      }
      if (URL_ACTIONS.has(action)) {
        const bad = urlProblem(p.url);
        if (bad) issues.push({ path, action, message: bad });
      }
      if (action === 'router') {
        let paths: unknown = p.paths ?? step.paths;
        if (typeof paths === 'string') { try { paths = JSON.parse(paths); } catch { paths = null; } }
        if (!Array.isArray(paths) || paths.length === 0) {
          issues.push({ path, action, message: 'needs at least one path' });
        }
      }
      if (action === 'code' && opts.codeNodeEnabled === false) {
        issues.push({ path, action, message: 'is a Code node, but Code nodes are disabled on this server' });
      }
      walk(step.then, `${path}.then`);
      walk(step.else, `${path}.else`);
      walk(step.steps, `${path}.body`);
      walk(step.catch, `${path}.catch`);
      walk(step.finally, `${path}.finally`);
      walk(step.fallback, `${path}.default`);
      if (step.cases && typeof step.cases === 'object') {
        for (const [k, v] of Object.entries(step.cases)) walk(v, `${path}.case(${k})`);
      }
      if (Array.isArray(step.paths)) {
        step.paths.forEach((pp: any, pi: number) => walk(pp && pp.steps, `${path}.path${pi + 1}`));
      }
    });
  };
  walk(steps, '');
  if (runnable === 0) issues.push({ path: '-', action: '-', message: 'Every node is disabled' });
  return issues;
}

/** One readable line per issue, for API `details` and the UI. */
export function formatActivationIssue(i: ActivationIssue): string {
  if (i.path === '-') return i.message;
  return `Node ${i.path} (${i.action}) ${i.message}`;
}

/**
 * Is `action` an installed external module (modules/<name>/run.js or
 * modules/<name>.js)? That is the runtime's last-resort dispatch, so such an
 * action is not "unknown". Existence check only: nothing is loaded here.
 */
export function installedModuleExists(action: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(action)) return false;
  const base = path.resolve(__dirname, '../../modules');
  return fs.existsSync(path.join(base, action, 'run.js')) || fs.existsSync(path.join(base, `${action}.js`));
}
