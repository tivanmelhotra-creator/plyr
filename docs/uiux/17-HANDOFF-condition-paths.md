# Handoff 17 — Condition node with multiple prioritised paths (Mission 7)

**Status:** ✅ Implemented
**Mission (owner request):** *«نود شرطی یه بخش path داره که نمیشه جدید اضافه کرد … هر کدوم از path ها با اولویت بالا از بالا به پایین به ترتیب چک میشه، درست باشه اون مسیر رو میره وگرنه بعدی چک میشه. اگر هیچ کدوم کار نکرد و مسیری فعال نشه، از مسیر خنثا یعنی next میره.»*

---

## 1. What the owner asked for

The condition node showed a **“path” section that could not accept a new path** —
both `+ Add path` controls were hard-disabled (`cb.addPathV2`, “v1 runtime executes
a single path”). The requested behaviour:

* the node holds **N ordered paths**;
* paths are evaluated **top → bottom** by priority;
* the **first path whose condition is true wins** and execution follows that path
  exclusively (later paths are not evaluated, the neutral chain does not also run);
* if **no** path matches, execution leaves through the **neutral `next`** port.

---

## 2. Data shapes

### 2.1 Editor (client, inside `node.params`)

```jsonc
// params.paths — a JSON string, present ONLY when there are 2+ paths
[
  { "id": "p1", "name": "VIP",    "groups": [ /* AND/OR rows */ ] },
  { "id": "p2", "name": "Member", "groups": [ /* … */ ] }
]
```

* `id` must match `/^[A-Za-z0-9_-]{1,24}$/` — the regex deliberately rejects `:`
  so the canvas port id `path:<id>` can never be broken. Hostile / duplicate ids
  are re-keyed to `p1`, `p2`, … on read.
* **A single-path node writes no `paths` key at all** (`delete params.paths`) and
  mirrors path[0] into the legacy `groups` + flat fields, so every previously
  saved workflow stays byte-identical.
* Cap: **20** paths (`CONDITION_MAX_PATHS`) — the same cap Automa uses.

### 2.2 Wire format (what the backend receives)

```jsonc
// 2+ paths → ordered list, no then/else
{
  "action": "if",
  "condition": { /* path 1's condition, for legacy readers */ },
  "paths": [
    { "id": "p1", "name": "VIP",    "condition": { … }, "steps": [ … ] },
    { "id": "p2", "name": "Member", "condition": { … }, "steps": [ … ] }
  ]
}

// exactly 1 path → the classic shape, unchanged
{ "action": "if", "condition": { … }, "then": [ … ], "else": [ … ] }
```

The steps that follow the node on the neutral `next` port are the group’s
continuation — they are **not** duplicated into any path.

---

## 3. Files touched

| File | What changed |
|------|--------------|
| `public/js/ndv-model.js` | Paths registry: `CONDITION_MAX_PATHS`, `normalizePath`, `readPaths`, `writePaths`, `isMultiPath`, `pathLabel`, `pathsSummary`; `groupsSummary` split out of `conditionSummary`. All pure / DOM-free. |
| `public/js/actions.js` | The `if` action declares `{ k:'paths', type:'string', internal:true }`. **Required** — `coerceParams` copies only declared keys, so an undeclared `paths` would be silently dropped on save. |
| `public/js/graph-serialize.js` | `parsePaths()`, `pathPortId()`, `simpleRowFromCondition()`; multi-path `buildNode`, import in `stepsToGraph`, path rows in `outlineTree`, path-aware `empty-if` warning; `'paths'` added to `CONDITION_ONLY_PARAMS`. |
| `public/js/flow-editor.js` | `portsOf()` emits one `path:<id>` port per path + neutral `next`; priority-prefixed labels, `clipPortLabel()` (14 chars), `pathPortText()`, `tone-path` edge pills, `pathsSummary` in the node card. |
| `public/js/ndv-nodes.js` | The real path list — add / rename / reorder (↑↓) / delete / select, priority pills, non-deletable neutral trailing row, per-path result cards (`pathResultCard`, `neutralResultCard`). Active path index lives in a module-level `ACTIVE_PATH` map, **never** on `node` (which gets serialised). |
| `public/js/i18n.js` | 14 new `cb.*` keys + `port.path` in **fa and en**; `cb.addPathV2` retired; `val.emptyIf` reworded (it used to say “then/else”). |
| `public/css/styles.css` | `.cb-pathlist` / `.cb-pathitem` / `.cb-path-*` styles, path & neutral result cards, `.fe-edge-pill.tone-path`, and `.cb-results.is-paths { grid-template-columns: 1fr }` (the old `flex-direction` was a no-op on a grid). |
| `src/types.ts` | `ConditionPath { id?, name?, condition?, steps? }` and `AutomationStep.paths?: ConditionPath[]`. |
| `src/validation.ts` | `StepInput.paths`; `paths` added to the legacy rest-spread strip; `mapStep` maps ids (≤24 ch), names (≤120 ch) and recurses into `paths[].steps`. |
| `src/pipeline.ts` | Exported `pickConditionPath()` + the exclusive routing branch in `executeStepGroup`. |
| `tests/unit/condition-paths.test.ts` | **New** — 29 tests across model / serializer / validation / runtime. |

---

## 4. Runtime rule (`src/pipeline.ts`)

```ts
export async function pickConditionPath(paths, evaluate): Promise<number> {
  if (!Array.isArray(paths)) return -1;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (!p || !p.condition) continue;      // condition-less path is skipped
    if (await evaluate(p.condition)) return i;   // first match wins, short-circuits
  }
  return -1;                                // → neutral next
}
```

The branch sits **before** the legacy `if (step.action === 'if' && step.condition)`
so multi-path nodes never fall into the then/else path, and it uses the existing
labelled loop:

* a match → run `p.steps`, then `break stepLoop` — **exclusive** routing, the
  neutral continuation must not also execute;
* no match → `continue stepLoop` — the neutral `next` chain runs normally;
* control signals (`return` / `break` / `continue`) raised inside a path still
  propagate outward unchanged.

An observability event is emitted per routing decision:
`onEvent('step.path', { index, action:'if', path, name, priority })`.

---

## 5. Traps that were deliberately handled

1. **Silent data loss** — `GraphSerialize.coerceParams()` copies only keys declared
   in an action’s `fields`. `paths` had to be declared (internal) or it vanished
   on every save.
2. **Double serialisation** — `paths` is in `CONDITION_ONLY_PARAMS`, so the blob
   never leaks into `step.params` alongside the structured `paths` array.
3. **Port-id injection** — `PATH_ID_RE` rejects `:`; a path named `evil:port`
   cannot collide with another node’s port (covered by a test).
4. **View state in saved data** — the selected path index is UI-only state in
   `ACTIVE_PATH`, keyed by node id.
5. **Backwards compatibility** — one path ⇒ no `paths` key, classic `then`/`else`
   wire shape, `parsePaths()` returns `null`.
6. **Long path names on the canvas** — `clipPortLabel()` truncates at 14 chars.

---

## 6. Verification

```bash
cd /home/user/webapp
npx tsc --noEmit                                  # clean
node --check public/js/ndv-model.js               # and every touched client file
npx vitest run tests/unit/condition-paths.test.ts # 29/29
npx vitest run                                    # 43 files / 949 tests

node tools/ui-preview-server.js 8788 &
UI_LANG=fa node tools/ui-shot.js '/editor' .ui-shots/fa.png 1440x900   # errors: none
```

Line endings confirmed unchanged: LF under `public/**`, CRLF preserved in
`src/pipeline.ts`, `src/types.ts`, `src/validation.ts`.

---

## 7. Not in scope / next

* **Mission 5 part 2** — Automa value-type parity for the condition builder
  (grouped value types) is still open; see `19-HANDOFF-condition-value-types.md`.
* Path-level *drag* reordering on the canvas (today reordering is done with the
  ↑ / ↓ buttons in the NDV list).
* A “duplicate path” shortcut — cheap to add on top of `writePaths`.
