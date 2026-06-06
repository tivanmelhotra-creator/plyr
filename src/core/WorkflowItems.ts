/* eslint-disable @typescript-eslint/no-explicit-any */
// ════════════════════════════════════════════════════════════════
// WorkflowItems (Step 21) — uniform, item-based data model.
// ----------------------------------------------------------------
// Inspired directly by n8n's data model: data flowing between nodes is
// always an ARRAY OF ITEMS, where every item is an object with a `json`
// payload (and, optionally, `binary` references). A node may receive n
// items and emit a different number of items (1 -> many, many -> 1, …).
//
// This module is the SINGLE SOURCE OF TRUTH for that contract. It is
// intentionally dependency-free and pure so it can be unit-tested in
// isolation and reused by the pipeline, the API layer and (later) the
// expression engine and the NDV UI.
//
// Backwards compatibility is a hard requirement: the existing engine is
// built around `context.variables` (a Map) and per-step `result` values.
// Nothing here replaces that — the item stream is an ADDITIONAL layer
// that runs alongside the variable system. Helpers below convert a
// step's arbitrary `result` into a normalized item array and back, so
// downstream features (NDV INPUT/OUTPUT, expressions `$json` / `$node`)
// have a predictable shape to read from.
// ════════════════════════════════════════════════════════════════

// A binary reference attached to an item. We keep only metadata + an
// optional path/id here (never the raw bytes) so the stream stays light
// and JSON-serializable for live events and persistence.
export interface WorkflowBinary {
  /** MIME type, e.g. "image/png". */
  mimeType?: string;
  /** Original/suggested file name. */
  fileName?: string;
  /** Filesystem path or storage id where the bytes live (not the bytes). */
  path?: string;
  /** Size in bytes, when known. */
  size?: number;
  /** Free-form extra metadata. */
  [k: string]: unknown;
}

// The fundamental unit that flows between steps/nodes.
// `json` is always a plain object; `binary` is an optional map of named
// binary references (matching n8n's `{ data: { fileName, mimeType, … } }`).
export interface WorkflowItem {
  json: Record<string, unknown>;
  binary?: Record<string, WorkflowBinary>;
}

// A single empty item — the canonical "no input yet" stream that a
// workflow starts with (mirrors n8n's behaviour where the first node
// receives one empty item so it always executes once).
export function emptyItem(): WorkflowItem {
  return { json: {} };
}

export function emptyStream(): WorkflowItem[] {
  return [emptyItem()];
}

// Type guard: is this value already a well-formed WorkflowItem?
export function isWorkflowItem(value: unknown): value is WorkflowItem {
  if (typeof value !== 'object' || value === null) return false;
  const j = (value as any).json;
  return typeof j === 'object' && j !== null && !Array.isArray(j);
}

// Wrap an arbitrary value into a single item's `json`. Objects become the
// json directly; primitives/arrays are wrapped under a `value` key so the
// json contract (always an object) holds.
export function toItem(value: unknown): WorkflowItem {
  if (isWorkflowItem(value)) {
    // Already an item — copy to avoid aliasing the caller's object.
    const v = value as WorkflowItem;
    return v.binary ? { json: { ...v.json }, binary: { ...v.binary } } : { json: { ...v.json } };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { json: { ...(value as Record<string, unknown>) } };
  }
  // Primitive, array, null or undefined → wrap under `value`.
  return { json: { value: value as unknown } };
}

// Normalize ANY step result into a uniform item array.
//   - undefined/null               → [] (no output items; stream is "passed through" by caller if desired)
//   - WorkflowItem                  → [item]
//   - WorkflowItem[]                → as-is (validated/copied)
//   - array of objects/primitives   → one item per element
//   - single object                 → [ { json: object } ]
//   - primitive                     → [ { json: { value } } ]
export function normalizeToItems(result: unknown): WorkflowItem[] {
  if (result === undefined || result === null) return [];

  if (Array.isArray(result)) {
    if (result.length === 0) return [];
    return result.map((el) => toItem(el));
  }

  return [toItem(result)];
}

// Convenience: when a step produces nothing meaningful, we want the item
// stream to "pass through" the previous stream rather than collapse to
// empty (this matches the intuition that e.g. a `click` step does not
// destroy the data flowing through). The caller decides whether to use
// the normalized output or fall back to the previous stream.
export function resolveOutputStream(
  result: unknown,
  previous: WorkflowItem[]
): WorkflowItem[] {
  const out = normalizeToItems(result);
  return out.length > 0 ? out : previous;
}

// Extract just the `json` payloads — handy for expressions / UI tables.
export function itemsToJson(items: WorkflowItem[]): Record<string, unknown>[] {
  return items.map((it) => it.json);
}

// A compact, JSON-safe summary of a stream for live events. We cap how
// much we ship over the wire so large scrapes never flood the live
// channel; the full data remains available via the job result file.
export interface ItemsSummary {
  itemCount: number;
  sample: Record<string, unknown>[];
  truncated: boolean;
}

const DEFAULT_SAMPLE = 5;
const MAX_SAMPLE_CHARS = 8 * 1024; // ~8KB cap per summary

export function summarizeItems(
  items: WorkflowItem[] | undefined,
  sampleSize: number = DEFAULT_SAMPLE
): ItemsSummary {
  const arr = Array.isArray(items) ? items : [];
  const sliced = arr.slice(0, Math.max(0, sampleSize)).map((it) => it.json);

  // Defensive size cap: drop sample down if it serializes too big.
  let sample = sliced;
  let truncated = arr.length > sliced.length;
  try {
    let json = JSON.stringify(sample);
    while (sample.length > 1 && json.length > MAX_SAMPLE_CHARS) {
      sample = sample.slice(0, sample.length - 1);
      truncated = true;
      json = JSON.stringify(sample);
    }
    if (sample.length === 1 && json.length > MAX_SAMPLE_CHARS) {
      sample = [{ note: '[item too large to preview]' }];
      truncated = true;
    }
  } catch {
    sample = [{ note: '[unserializable item]' }];
    truncated = true;
  }

  return { itemCount: arr.length, sample, truncated };
}
