# 20 - Conditional nodes (If / Router) hand-off

## What changed
- New `router` node (cat `flow`, icon `git-branch`): ordered paths + an explicit
  **Default** output; always continues with the node after it.
- `If` unchanged for users (then/else or multi-path, first match wins).
- Serializer is join-aware (see PROJECT.md section 5): no node duplication for
  join / nested-If / loop-or-try-in-branch / switch.
- Bad graphs are rejected: `cycle`, `fanout`, `dangling` (errors, block run and
  mark the node/edge); `duplicated` (warning).

## Files
`public/js/graph-serialize.js`, `actions.js`, `ndv-model.js`, `ndv-nodes.js`,
`flow-editor.js`, `views.js`, `i18n.js` (fa/en parity), `css/styles.css`;
`src/pipeline.ts`, `validation.ts`, `types.ts`; tests in
`tests/unit/conditional-nodes.test.ts` (37).

## Rule R1 - Automa parity (gap report)
Automa has a single *Conditions* block (multiple condition paths + `fallback`),
which maps to our Router: paths with AND/OR groups, ordered, plus fallback. Not
copied, because the runtime cannot execute it (rule R3): Automa's per-path
"run all matches" mode and its JS-expression-only conditions (we keep the
no-eval expression engine, PROJECT.md section 14).

## Not done
- No "run every matching path" (fan-out) mode: the runtime has none.
- Cycles are never auto-converted into loops; the user must pick a loop node.
