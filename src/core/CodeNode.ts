/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CodeNode — the `code` action: run the operator's own JavaScript.
 *
 * THIS IS NOT A SECURITY SANDBOX. Plyr is single-user and self-hosted; the
 * person writing the code is the person who owns the server. `require`,
 * `fetch`, the filesystem and the network are all reachable on purpose. The
 * limits below exist only so one bad snippet cannot take the server down:
 *
 *   - a wall-clock timeout,
 *   - a heap cap for the worker,
 *   - a cap on captured console lines.
 *
 * TWO EXECUTION PATHS, ONE RUNNER
 * -------------------------------
 *   useBrowser = false  -> a fresh worker_thread. On timeout it is terminated,
 *                          so even `while (true) {}` is killed.
 *   useBrowser = true   -> this process, because Playwright's `page` and
 *                          `context` cannot cross a thread boundary. The timeout
 *                          is a Promise.race: an ASYNC runaway is abandoned, but
 *                          a SYNCHRONOUS infinite loop blocks the event loop and
 *                          cannot be interrupted (documented in the node help).
 *
 * Both paths evaluate the very same runner source (RUNNER_SOURCE below), so
 * output normalisation, console capture and `require` filtering cannot drift
 * between them. It is a plain JS string because a worker started with
 * `eval: true` cannot load a .ts module under vitest/tsx, and the same text
 * must also work from `dist/` after `tsc`.
 *
 * The expression engine (public/js/expression.js) is unrelated and keeps its
 * no-eval guarantee; this module is the one place that deliberately runs code.
 */
import Module from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WorkflowItem } from './WorkflowItems';

export type CodeMode = 'runOnceForAllItems' | 'runOnceForEachItem';

export interface CodeLogLine {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

export interface CodeRunOptions {
  code: string;
  mode?: CodeMode | string;
  items: WorkflowItem[];
  /** Run variables (name -> value). Changes made through `$vars` are returned. */
  vars?: Record<string, unknown>;
  /** Earlier nodes' outputs, keyed like context.nodeOutputs. */
  nodeOutputs?: Record<string, WorkflowItem[]>;
  executionId?: string;
  timeoutMs?: number;
  /** Run in-process with access to Playwright `page` / `context`. */
  useBrowser?: boolean;
  page?: unknown;
  browserContext?: unknown;
  /** Empty = every module may be required. */
  allowModules?: string[];
  maxMemoryMb?: number;
  maxLogLines?: number;
  /** Directory `require()` resolves from (default: process.cwd()). */
  cwd?: string;
  onLog?: (line: CodeLogLine) => void;
}

export interface CodeRunResult {
  items: WorkflowItem[];
  logs: CodeLogLine[];
  /** Variables whose value changed (or were added) during the run. */
  changedVars: Record<string, unknown>;
  durationMs: number;
}

export class CodeNodeError extends Error {
  logs: CodeLogLine[];
  constructor(message: string, logs: CodeLogLine[]) {
    super(message);
    this.name = 'CodeNodeError';
    this.logs = logs;
  }
}

export const CODE_DEFAULT_TIMEOUT_MS = 30000;
export const CODE_MIN_TIMEOUT_MS = 100;
export const CODE_MAX_TIMEOUT_MS = 600000;
export const CODE_DEFAULT_MAX_LOG_LINES = 200;

/**
 * The shared runner. Evaluated with `new Function` (in-process) or inline in
 * the worker. It must stay self-contained: no imports, no TypeScript.
 *
 * Exposes { runUserCode(env), normalizeOutput(mode, raw), makeRequire(base, allow), sanitizeVars(obj) }.
 */
export const RUNNER_SOURCE = String.raw`
var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
var PARAMS = ['$input', '$json', '$item', '$index', '$items', '$vars', '$node', '$now',
  '$execution', 'console', 'require', 'fetch', 'page', 'context'];

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { var s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch (e) { return String(a); }
}

function makeConsole(onLog) {
  function level(name) {
    return function () {
      var text = Array.prototype.map.call(arguments, fmt).join(' ');
      if (text.length > 4000) text = text.slice(0, 4000) + '\u2026';
      onLog({ level: name, text: text });
    };
  }
  return { log: level('log'), info: level('info'), warn: level('warn'), error: level('error'), debug: level('debug') };
}

function rootModuleName(id) {
  var s = String(id || '');
  if (s.indexOf('node:') === 0) s = s.slice(5);
  if (s.charAt(0) === '.' || s.charAt(0) === '/') return s;
  var parts = s.split('/');
  return s.charAt(0) === '@' ? parts.slice(0, 2).join('/') : parts[0];
}

function makeRequire(base, allow) {
  if (!allow || !allow.length) return base;
  var set = {};
  allow.forEach(function (a) { set[rootModuleName(a)] = true; });
  var req = function (id) {
    var root = rootModuleName(id);
    if (!set[root]) {
      throw new Error('require("' + id + '") is not allowed: add "' + root + '" to CODE_NODE_ALLOW_MODULES');
    }
    return base(id);
  };
  req.resolve = base.resolve;
  return req;
}

// Make one returned value plain JSON. Throws on what cannot be data.
function toJsonValue(v, where, seen) {
  if (v === null) return null;
  var t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return isFinite(v) ? v : null;
  if (t === 'undefined') return undefined;
  if (t === 'function') throw new Error(where + ' is a function; return data, not code');
  if (t === 'symbol') throw new Error(where + ' is a Symbol and cannot be stored');
  if (t === 'bigint') throw new Error(where + ' is a BigInt; convert it with String() or Number()');
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) throw new Error(where + ' is a Buffer; convert it (e.g. buf.toString("base64"))');
  if (seen.indexOf(v) !== -1) throw new Error(where + ' contains a circular reference');
  seen.push(v);
  var out;
  if (Array.isArray(v)) {
    out = v.map(function (x, i) { var r = toJsonValue(x, where + '[' + i + ']', seen); return r === undefined ? null : r; });
  } else if (v instanceof Map) {
    out = {};
    v.forEach(function (val, key) { var r = toJsonValue(val, where + '.' + String(key), seen); if (r !== undefined) out[String(key)] = r; });
  } else if (v instanceof Set) {
    out = []; var i = 0;
    v.forEach(function (val) { var r = toJsonValue(val, where + '[' + (i++) + ']', seen); out.push(r === undefined ? null : r); });
  } else {
    out = {};
    Object.keys(v).forEach(function (k) {
      var r = toJsonValue(v[k], where + '.' + k, seen);
      if (r !== undefined) out[k] = r;
    });
  }
  seen.pop();
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Map) && !(v instanceof Set);
}

// One returned element -> one WorkflowItem. Accepts { json, binary? } items
// and bare objects (wrapped as json), like n8n. Anything else is an error.
function toItem(v, where) {
  if (!isPlainObject(v)) {
    var kind = v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v;
    throw new Error(where + ' must be an object (got ' + kind + '). Return { key: value } or [{ key: value }, ...]');
  }
  var hasJson = isPlainObject(v.json);
  var keys = Object.keys(v);
  var looksLikeItem = hasJson && keys.every(function (k) { return k === 'json' || k === 'binary' || k === 'pairedItem'; });
  if (looksLikeItem) {
    var item = { json: toJsonValue(v.json, where + '.json', []) };
    if (isPlainObject(v.binary)) item.binary = toJsonValue(v.binary, where + '.binary', []);
    return item;
  }
  return { json: toJsonValue(v, where, []) };
}

// mode 'runOnceForAllItems': raw = the single return value.
// mode 'runOnceForEachItem': raw = [{ index, value }, ...] (one per input item).
// null/undefined means "no items" (once) or "drop this item" (each).
function normalizeOutput(mode, raw) {
  var out = [];
  if (mode === 'runOnceForEachItem') {
    (raw || []).forEach(function (r) {
      var v = r.value; var where = 'Item ' + r.index;
      if (v === undefined || v === null) return;
      if (Array.isArray(v)) { v.forEach(function (x, j) { out.push(toItem(x, where + '[' + j + ']')); }); return; }
      out.push(toItem(v, where));
    });
    return out;
  }
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    raw.forEach(function (x, i) { out.push(toItem(x, 'Returned item ' + i)); });
    return out;
  }
  out.push(toItem(raw, 'The returned value'));
  return out;
}

// Variables are lenient: what cannot be JSON becomes its String().
function sanitizeVars(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    try { var r = toJsonValue(obj[k], k, []); out[k] = r === undefined ? null : r; }
    catch (e) { try { out[k] = String(obj[k]); } catch (e2) { out[k] = null; } }
  });
  return out;
}

async function runUserCode(env) {
  var fn;
  try {
    fn = new AsyncFunction(PARAMS.join(','), env.code);
  } catch (e) {
    throw new Error('Syntax error: ' + e.message);
  }
  var con = makeConsole(env.onLog);
  var items = env.items || [];
  var req = makeRequire(env.baseRequire, env.allowModules);
  var page = env.page, context = env.context;
  if (!env.useBrowser) {
    var off = function (name) {
      return new Proxy({}, { get: function () {
        throw new Error('"' + name + '" is only available when the node option "Use browser (page)" is on');
      } });
    };
    page = off('page'); context = off('context');
  }
  var input = {
    all: function () { return items; },
    first: function () { return items[0]; },
    last: function () { return items[items.length - 1]; },
    item: items[0],
  };
  var now = new Date();
  var exec = env.execution || {};
  var call = function (inp, item, index) {
    return fn(inp, item ? item.json : {}, item, index, items, env.vars, env.node || {}, now, exec,
      con, req, env.fetch, page, context);
  };
  var raw;
  if (env.mode === 'runOnceForEachItem') {
    raw = [];
    for (var i = 0; i < items.length; i++) {
      var inp = { all: input.all, first: input.first, last: input.last, item: items[i] };
      raw.push({ index: i, value: await call(inp, items[i], i) });
    }
  } else {
    raw = await call(input, items[0], 0);
  }
  return { items: normalizeOutput(env.mode, raw), vars: sanitizeVars(env.vars) };
}

return { runUserCode: runUserCode, normalizeOutput: normalizeOutput, makeRequire: makeRequire, sanitizeVars: sanitizeVars };
`;

interface RunnerLib {
  runUserCode(env: Record<string, unknown>): Promise<{ items: WorkflowItem[]; vars: Record<string, unknown> }>;
  normalizeOutput(mode: string, raw: unknown): WorkflowItem[];
  makeRequire(base: NodeRequire, allow: string[]): NodeRequire;
  sanitizeVars(obj: Record<string, unknown>): Record<string, unknown>;
}

let lib: RunnerLib | null = null;
function runner(): RunnerLib {
  // eslint-disable-next-line no-new-func
  if (!lib) lib = new Function(RUNNER_SOURCE)() as RunnerLib;
  return lib;
}

/** Shape a raw return value into items (exported for tests). */
export function normalizeCodeOutput(mode: CodeMode | string, raw: unknown): WorkflowItem[] {
  return runner().normalizeOutput(normalizeMode(mode), raw);
}

export function normalizeMode(mode: unknown): CodeMode {
  return mode === 'runOnceForEachItem' ? 'runOnceForEachItem' : 'runOnceForAllItems';
}

export function clampTimeout(raw: unknown, fallback: number = CODE_DEFAULT_TIMEOUT_MS): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  const v = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(CODE_MAX_TIMEOUT_MS, Math.max(CODE_MIN_TIMEOUT_MS, Math.round(v)));
}

/** `CODE_NODE_ALLOW_MODULES=lodash, node:fs` -> ['lodash', 'node:fs']. */
export function parseAllowModules(raw: string | undefined | null): string[] {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Map -> plain object, for `$vars`. */
export function varsToObject(vars: Map<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (vars) for (const [k, v] of vars) out[String(k)] = v;
  return runner().sanitizeVars(out);
}

function buildNodeRefs(nodeOutputs: Record<string, WorkflowItem[]> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, items] of Object.entries(nodeOutputs || {})) {
    const list = Array.isArray(items) ? items : [];
    out[k] = { json: list[0]?.json ?? {}, items: list };
  }
  return out;
}

/** Report a user-code error with the line inside the snippet, when known. */
function describeError(e: any): string {
  const msg = e && e.message ? String(e.message) : String(e);
  const stack = e && e.stack ? String(e.stack) : '';
  // new AsyncFunction(...) puts the body after a 2-line header.
  const m = /<anonymous>:(\d+):(\d+)/.exec(stack);
  if (m) {
    const line = parseInt(m[1], 10) - 2;
    if (line > 0) return `${msg} (line ${line})`;
  }
  return msg;
}

function diffVars(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const k of Object.keys(after || {})) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = after[k];
  }
  return changed;
}

function workerSource(): string {
  return `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const Module = require('module');
const path = require('path');
const lib = (function () { ${RUNNER_SOURCE} })();
const base = Module.createRequire(path.join(workerData.cwd, '__plyr_code_node__.js'));
(async () => {
  try {
    const res = await lib.runUserCode(Object.assign({}, workerData, {
      baseRequire: base,
      fetch: typeof fetch === 'function' ? fetch : undefined,
      onLog: (line) => parentPort.postMessage({ type: 'log', line }),
    }));
    parentPort.postMessage({ type: 'done', items: res.items, vars: res.vars });
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e && e.message ? String(e.message) : String(e),
      stack: e && e.stack ? String(e.stack) : '' });
  }
})();
`;
}

/**
 * Run a Code node. Resolves with the produced items; rejects with a
 * CodeNodeError (which carries the console lines captured so far).
 */
export async function runCodeNode(opts: CodeRunOptions): Promise<CodeRunResult> {
  const started = Date.now();
  const code = typeof opts.code === 'string' ? opts.code : '';
  const logs: CodeLogLine[] = [];
  const maxLines = opts.maxLogLines && opts.maxLogLines > 0 ? opts.maxLogLines : CODE_DEFAULT_MAX_LOG_LINES;
  const onLog = (line: CodeLogLine) => {
    if (logs.length < maxLines) {
      logs.push(line);
      opts.onLog?.(line);
    } else if (logs.length === maxLines) {
      const cut: CodeLogLine = { level: 'warn', text: `console output truncated after ${maxLines} lines` };
      logs.push(cut);
      opts.onLog?.(cut);
    }
  };
  if (!code.trim()) throw new CodeNodeError('The Code node has no code', logs);

  const mode = normalizeMode(opts.mode);
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const vars = opts.vars || {};
  const env = {
    code,
    mode,
    items: Array.isArray(opts.items) ? opts.items : [],
    vars: JSON.parse(JSON.stringify(vars)),
    node: buildNodeRefs(opts.nodeOutputs),
    execution: { id: opts.executionId || '' },
    useBrowser: !!opts.useBrowser,
    allowModules: opts.allowModules || [],
    cwd: opts.cwd || process.cwd(),
  };

  let res: { items: WorkflowItem[]; vars: Record<string, unknown> };
  if (opts.useBrowser) {
    res = await runInProcess(env, opts, timeoutMs, onLog, logs);
  } else {
    res = await runInWorker(env, opts, timeoutMs, onLog, logs);
  }
  return {
    items: res.items,
    logs,
    changedVars: diffVars(vars, res.vars),
    durationMs: Date.now() - started,
  };
}

async function runInProcess(
  env: Record<string, any>,
  opts: CodeRunOptions,
  timeoutMs: number,
  onLog: (l: CodeLogLine) => void,
  logs: CodeLogLine[],
): Promise<{ items: WorkflowItem[]; vars: Record<string, unknown> }> {
  const base = Module.createRequire(path.join(env.cwd, '__plyr_code_node__.js'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const guardedLog = (l: CodeLogLine) => { if (!finished) onLog(l); };
  try {
    return await Promise.race([
      runner().runUserCode({
        ...env,
        baseRequire: base,
        fetch: (globalThis as any).fetch,
        page: opts.page,
        context: opts.browserContext,
        onLog: guardedLog,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    throw new CodeNodeError(describeError(e), logs);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
  }
}

function runInWorker(
  env: Record<string, any>,
  opts: CodeRunOptions,
  timeoutMs: number,
  onLog: (l: CodeLogLine) => void,
  logs: CodeLogLine[],
): Promise<{ items: WorkflowItem[]; vars: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(workerSource(), {
        eval: true,
        workerData: env,
        resourceLimits: opts.maxMemoryMb && opts.maxMemoryMb > 0
          ? { maxOldGenerationSizeMb: opts.maxMemoryMb }
          : undefined,
        stdout: false,
        stderr: false,
      });
    } catch (e) {
      reject(new CodeNodeError(`could not start the code worker: ${(e as Error).message}`, logs));
      return;
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate().catch(() => { /* already gone */ });
    };
    const timer = setTimeout(() => {
      finish(() => reject(new CodeNodeError(`timed out after ${timeoutMs}ms (the worker was stopped)`, logs)));
    }, timeoutMs);
    worker.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'log' && !settled) onLog(msg.line);
      else if (msg.type === 'done') finish(() => resolve({ items: msg.items, vars: msg.vars }));
      else if (msg.type === 'error') finish(() => reject(new CodeNodeError(describeError(msg), logs)));
    });
    worker.on('error', (e: any) => {
      const oom = e && e.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish(() => reject(new CodeNodeError(
        oom ? `ran out of memory (limit ${opts.maxMemoryMb} MB, CODE_NODE_MAX_MEMORY_MB)` : describeError(e), logs)));
    });
    worker.on('exit', (code) => {
      finish(() => reject(new CodeNodeError(`the code worker exited unexpectedly (code ${code})`, logs)));
    });
  });
}
