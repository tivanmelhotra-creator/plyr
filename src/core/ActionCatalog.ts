'use strict';

/**
 * ActionCatalog — the SERVER's read-only view of which params each action
 * actually declares.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Target Field is `node_<nodeId>__<fieldKey>__<suffix>`, and the requirement
 * is explicit that `fieldKey` must come from a DECLARED field of the node's
 * action and must never be a free string chosen by the client:
 *
 *   «fieldKey باید از declared field واقعی Node/Action بیاید و رشته آزاد
 *    client نباشد»
 *
 * Without a server-side check that rule is unenforceable, and the failure it
 * prevents is the nastiest one available here. `GraphSerialize.coerceParams()`
 * and `FlowEditor.applyInspectorFields()` both copy ONLY keys present in the
 * action's `fields` array. So a pick sent to an undeclared key is accepted,
 * shown as filled in the editor, and then SILENTLY DROPPED on save/run — a node
 * that looks configured and runs unconfigured. Refusing at registration time is
 * the difference between an error the user can read and a workflow that quietly
 * does the wrong thing at 3am.
 *
 * WHY IT READS public/js/actions.js INSTEAD OF DECLARING THE LIST AGAIN
 * --------------------------------------------------------------------
 * `public/js/actions.js` is already the single source of truth for the 50
 * actions and their fields; it is what the editor renders and what
 * `coerceParams` filters against. Re-typing those field names in TypeScript
 * would create a second list that drifts from the first, and the drift would be
 * invisible: a field added to the editor would start being refused by this
 * module for no reason a reader could see.
 *
 * The file is a CSP-safe IIFE that assigns `window.ACTION_CATALOG`, with no
 * imports and no DOM access at load time. So it can be evaluated here with a
 * fake `window` and its own catalogue read back — the same technique the test
 * suite already uses for `public/js` code, for the same reason (measure the
 * shipped behaviour, not a copy of it).
 *
 * FAILURE POLICY: FAIL CLOSED, BUT NEVER CRASH
 * -------------------------------------------
 * If the file cannot be read or evaluated, this module ends up with an EMPTY
 * catalogue and `isDeclaredField()` answers `false` for everything. That
 * refuses every registration with a readable reason instead of accepting
 * everything — an authorization helper that fails open is worse than one that
 * is loudly unavailable. It must not throw at import time either: this is
 * pulled in by a route module, and a boot crash over a UI asset would take the
 * whole server down.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One declared param of an action, reduced to what this module needs. */
interface CatalogField {
  k?: unknown;
}

interface CatalogAction {
  id?: unknown;
  fields?: unknown;
}

interface CatalogWindow {
  ACTION_CATALOG?: {
    ACTIONS?: unknown;
  };
}

/** actionId -> the set of declared param keys. Built once, then read-only. */
type FieldMap = Map<string, Set<string>>;

let cache: FieldMap | null = null;
let loadError = '';

function catalogPath(): string {
  // Resolved from this file so it works from `src/` under vitest/tsx and from
  // `dist/` after a build, both of which sit one level under the repo root.
  return path.join(__dirname, '..', '..', 'public', 'js', 'actions.js');
}

/**
 * Evaluate the shipped catalogue and index it.
 *
 * `new Function` rather than `require`: the file is a browser IIFE, not a
 * CommonJS module, so there is no `module.exports` to read. It is a first-party
 * asset from this repository, not user input.
 */
function build(): FieldMap {
  const map: FieldMap = new Map();
  let source = '';
  try {
    source = fs.readFileSync(catalogPath(), 'utf8');
  } catch (e) {
    loadError = `actions.js could not be read: ${(e as Error).message}`;
    return map;
  }

  const win: CatalogWindow = {};
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', source)(win);
  } catch (e) {
    loadError = `actions.js could not be evaluated: ${(e as Error).message}`;
    return map;
  }

  const actions = win.ACTION_CATALOG?.ACTIONS;
  if (!Array.isArray(actions)) {
    loadError = 'actions.js did not expose window.ACTION_CATALOG.ACTIONS';
    return map;
  }

  for (const raw of actions as CatalogAction[]) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!id) continue;
    const keys = new Set<string>();
    if (Array.isArray(raw.fields)) {
      for (const f of raw.fields as CatalogField[]) {
        if (typeof f?.k === 'string' && f.k) keys.add(f.k);
      }
    }
    map.set(id, keys);
  }

  return map;
}

function catalog(): FieldMap {
  if (!cache) cache = build();
  return cache;
}

/** Drop the cache so a test can observe a rebuild. */
export function resetActionCatalog(): void {
  cache = null;
  loadError = '';
}

/** Why the catalogue is empty, for a diagnostic route or a log line. */
export function actionCatalogError(): string {
  catalog();
  return loadError;
}

/** How many actions were indexed. 0 means the catalogue failed to load. */
export function actionCatalogSize(): number {
  return catalog().size;
}

/** Does this action exist in the shipped catalogue? */
export function isKnownAction(actionId: string): boolean {
  return catalog().has(String(actionId || ''));
}

/**
 * Is `fieldKey` a param this action actually declares?
 *
 * The ONLY question the Target Field registry needs answered, and the whole
 * reason this module exists. Unknown action -> false: an action this server
 * cannot describe is one whose fields it cannot vouch for, and guessing here
 * would reintroduce exactly the silent-drop failure described above.
 */
export function isDeclaredField(actionId: string, fieldKey: string): boolean {
  const keys = catalog().get(String(actionId || ''));
  if (!keys) return false;
  return keys.has(String(fieldKey || ''));
}

/** Every declared param key for an action, for an error message that helps. */
export function declaredFields(actionId: string): string[] {
  const keys = catalog().get(String(actionId || ''));
  return keys ? [...keys] : [];
}
