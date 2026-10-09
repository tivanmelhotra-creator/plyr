'use strict';

/**
 * WorkflowExchange — the SERVER side of the native workflow file
 * `{format:"plyr-workflow", version, workflow}`.
 *
 * The rules (envelope shape, which values are secrets, "Code nodes arrive
 * disabled", the pre-save summary) live in `public/js/workflow-exchange.js`,
 * the very file the editor loads. It is evaluated here with a fake `window`
 * that also carries the node catalog and the browser-option catalog, so the UI
 * preview and the server's decision cannot drift (same technique as
 * ActionCatalog / BrowserOptions).
 *
 * What the SERVER adds is the part that must not be trusted to the client:
 *   - a strict Zod parse of the envelope (unknown versions refused, never
 *     guessed at);
 *   - disabling every Code node itself — a hand-made request that skips the
 *     UI still cannot import a runnable Code node;
 *   - the `steps` deep validation stays with validateSteps() in the route.
 *
 * Fail-closed: if the shared module cannot be loaded nothing is importable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const EXCHANGE_FORMAT = 'plyr-workflow';
export const EXCHANGE_VERSION = 1;

export interface ExchangeSummary {
  name: string;
  description: string;
  nodeCount: number;
  actions: Array<{ action: string; count: number }>;
  codeNodes: number;
  disabledNodes: number;
  launchOptionNodes: number;
  redacted: string[];
  legacy: boolean;
  exportedAt: string;
}

interface SharedExchange {
  FORMAT: string;
  VERSION: number;
  buildEnvelope(wf: unknown, opts?: { now?: Date }): Record<string, any>;
  fromLegacy(body: unknown): Record<string, any> | null;
  disableCodeNodes(steps: unknown): { steps: unknown[]; count: number };
  summarize(envelope: unknown): ExchangeSummary;
}

let cache: SharedExchange | null = null;
let loadError = '';

function jsDir(): string {
  return path.join(__dirname, '..', '..', 'public', 'js');
}

function load(): SharedExchange | null {
  if (cache) return cache;
  try {
    const win: Record<string, any> = {};
    for (const f of ['actions.js', 'browser-options.js', 'workflow-exchange.js']) {
      const source = fs.readFileSync(path.join(jsDir(), f), 'utf8');
      // eslint-disable-next-line no-new-func
      new Function('window', source).call(win, win);
    }
    if (!win.WorkflowExchange || typeof win.WorkflowExchange.summarize !== 'function') {
      loadError = 'workflow-exchange.js did not expose window.WorkflowExchange';
      return null;
    }
    cache = win.WorkflowExchange as SharedExchange;
    return cache;
  } catch (e) {
    loadError = `workflow-exchange.js could not be loaded: ${(e as Error).message}`;
    return null;
  }
}

export function exchangeLoadError(): string {
  load();
  return loadError;
}

/** The shared builder, for the server-side native export. */
export function buildNativeEnvelope(wf: { name: string; description?: string | null; steps: unknown[]; headless?: unknown }): Record<string, any> {
  const api = load();
  if (!api) throw new Error(loadError || 'workflow exchange unavailable');
  return api.buildEnvelope(wf);
}

/**
 * Second, authoritative pass of the "imported Code nodes arrive disabled" rule,
 * run on the steps AFTER validateSteps() — i.e. on exactly what will be stored.
 * parseExchange() already disabled them on the raw file, but validateSteps()
 * normalises (trims `action`), so any normalisation it gains later can never
 * again turn a step the first pass did not recognise into a live Code node.
 */
export function enforceImportedCodeDisabled<T>(steps: T[]): { steps: T[]; count: number } {
  const api = load();
  if (!api) throw new Error(loadError || 'workflow exchange unavailable');
  const r = api.disableCodeNodes(steps);
  return { steps: r.steps as T[], count: r.count };
}

const envelopeSchema = z.object({
  format: z.literal(EXCHANGE_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string().max(64).optional(),
  redacted: z.array(z.string().max(200)).max(500).optional(),
  workflow: z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional().nullable(),
    headless: z.union([z.boolean(), z.string(), z.number()]).optional(),
    steps: z.array(z.record(z.unknown())).min(1).max(500),
  }),
});

export type ExchangeErrorCode = 'unavailable' | 'json' | 'format' | 'version' | 'shape';

export type ParsedExchange =
  | { ok: true; workflow: { name: string; description: string | null; headless?: unknown; steps: unknown[] }; summary: ExchangeSummary; codeDisabled: number; legacy: boolean }
  | { ok: false; code: ExchangeErrorCode; message: string };

function fail(code: ExchangeErrorCode, message: string): ParsedExchange {
  return { ok: false, code, message };
}

/**
 * Parse an uploaded file body. Accepts the native envelope, or an OLD plyr
 * export (a bare `{name, steps}`), which is wrapped and treated identically.
 * Every Code node in the result is already disabled and counted.
 */
export function parseExchange(body: unknown): ParsedExchange {
  const api = load();
  if (!api) return fail('unavailable', loadError || 'workflow exchange unavailable');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('shape', 'The file is not a workflow object');

  let candidate: any = body;
  let legacy = false;
  if ((body as any).format === undefined) {
    const wrapped = api.fromLegacy(body);
    if (!wrapped) return fail('format', 'Not a plyr workflow file');
    candidate = wrapped;
    legacy = true;
  } else if ((body as any).format !== EXCHANGE_FORMAT) {
    return fail('format', 'Not a plyr workflow file');
  }

  const ver = (candidate as any).version;
  if (typeof ver === 'number' && Number.isInteger(ver) && ver > EXCHANGE_VERSION) {
    return fail('version', `File version ${ver} is newer than this plyr supports (${EXCHANGE_VERSION})`);
  }

  const parsed = envelopeSchema.safeParse({ ...candidate, legacy: undefined });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail('shape', `${first.path.join('.') || 'file'}: ${first.message}`);
  }

  const wf = parsed.data.workflow;
  const disabled = api.disableCodeNodes(wf.steps);
  const workflow = {
    name: wf.name,
    description: wf.description ?? null,
    headless: wf.headless,
    steps: disabled.steps,
  };
  const summary = api.summarize({
    workflow,
    redacted: parsed.data.redacted,
    legacy,
    exportedAt: parsed.data.exportedAt,
  });
  return { ok: true, workflow, summary, codeDisabled: disabled.count, legacy };
}
