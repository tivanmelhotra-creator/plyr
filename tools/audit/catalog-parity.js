#!/usr/bin/env node
/*
 * catalog-parity.js — compare what the editor DECLARES for each node
 * (public/js/actions.js `fields`) with what the runtime actually READS
 * (`finalParams.<key>` inside that action's handler in src/pipeline.ts).
 *
 *   backend-only : the runtime can honour it, but the UI never offers it
 *                  (hidden capability — limits what a user can build).
 *   ui-only      : the UI offers it, but the handler never reads it
 *                  (a control that changes nothing — rule R3).
 *
 * Heuristic, read-only diagnostic (docs/PLAN-node-logic-v2.md, Phase 0).
 * Handlers that read params through a helper (click/fill/wait/if...) show up
 * as ui-only false positives; check those by hand. Usage:
 *   node tools/audit/catalog-parity.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(root, 'src/pipeline.ts'), 'utf8').replace(/\r/g, '');
const win = {};
// First-party asset, same technique as src/core/ActionCatalog.ts.
// eslint-disable-next-line no-new-func
new Function('window', fs.readFileSync(path.join(root, 'public/js/actions.js'), 'utf8'))(win);
const actions = win.ACTION_CATALOG.ACTIONS;

const re = /if \((step\.action === '[^)]*)\)\s*\{/g;
const blocks = [];
let m;
while ((m = re.exec(src))) {
  blocks.push({ ids: [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), start: m.index });
}
blocks.forEach((b, i) => { b.body = src.slice(b.start, i + 1 < blocks.length ? blocks[i + 1].start : src.length); });

for (const a of actions) {
  const b = blocks.find((x) => x.ids.includes(a.id));
  if (!b) { console.log(a.id.padEnd(18), '(no direct handler block — dispatched elsewhere)'); continue; }
  const used = new Set([...b.body.matchAll(/finalParams\.(\w+)/g)].map((x) => x[1]));
  const decl = new Set(a.fields.map((f) => f.k));
  const hidden = [...used].filter((x) => !decl.has(x));
  const dead = [...decl].filter((x) => !used.has(x));
  if (hidden.length || dead.length) {
    console.log(a.id.padEnd(18), 'backend-only:', hidden.join(',') || '-', '| ui-only:', dead.join(',') || '-');
  }
}
