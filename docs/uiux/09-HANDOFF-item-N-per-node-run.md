# 09 — HANDOFF: item **N** (per-node Run) — full implementation spec + open items

> **THIS IS THE CURRENT STATUS DOCUMENT.** It supersedes
> `08-HANDOFF-addnode-contextmenu-groupbar.md` for *what to do next*; `08-…`
> stays valid for *what already shipped* (items H / J / I) and for its trap list.
>
> Written 2026-07-30, at the end of a session that was cut short by credit
> exhaustion. **No code was changed in that last stretch** — the session
> produced (a) PR #11 for the finished H/J/I work and (b) this document, which
> is the *complete design + code sketch* for item **N** plus four extra findings
> that must not be lost.
>
> Read § 0 (rules), then § 2 (item N, in order 2.2 → 2.8), then § 3 (extra
> findings — two of them are real bugs, one of them is a **fake-success UI**
> violation that item N fixes for free).

---

## 0. Standing rules (user instructions, not preferences)

Unchanged; repeated because they are load-bearing and this file may be read with
no chat history:

1. **Keep developing. Never ask the user questions** — search, decide, document.
2. **Image beats prose.** `docs/uiux/*.webp` (1672×941) is authoritative; the
   `*.md` inventories are the fallback when the pixels are covered.
3. **Never ship fake-successful UI.** No mock rows, no invented counts. If the
   backend cannot do it yet, the control renders **visibly disabled with a
   tooltip** that says why.
4. **Real counts only.**
5. **Do not add a new front-end JS file.** `tests/unit/icons.test.ts` pins the
   **18** files in `public/js/`. Dev-only tooling goes in `tools/`.
6. Every i18n key must exist in **both** the `fa` and the `en` dictionary of
   `public/js/i18n.js`.
7. Line endings: `public/**` = LF (0 CR); `src/*.ts` = **CRLF**. Patch CRLF
   files byte-exactly, e.g.
   ```python
   import io
   s = io.open(p, 'r', encoding='utf-8', newline='').read()   # keeps \r\n
   io.open(p, 'w', encoding='utf-8', newline='').write(s.replace(old, new))
   ```
   Current CR counts (regression check): `src/Routes/user.routes.ts` **1190**,
   `src/types.ts` **304**, `src/pipeline.ts` 2927, `src/Routes/health.routes.ts`
   59. **`src/schemas.ts` is CR=0** — it is an LF file even though it lives in
   `src/`; do not "fix" it.
8. Git: commit after every change → `git fetch origin main` → rebase → **squash
   to one commit** (`git reset --soft HEAD~N && git commit -F file`) →
   `git push -f origin genspark_ai_developer` → create/update the PR → **hand
   the user the PR link**. Never put backticks in a `-m` message (bash executes
   them and silently blanks words — this already happened once); always use
   `-F /tmp/commitmsg.txt`.

---

## 1. Where the repo stands right now

| | |
|---|---|
| Branch | `genspark_ai_developer` |
| Commit | `3c99eab` *feat(editor): Add Node palette, full node context menu, group toolbar (H/J/I)* — one squashed commit on top of `origin/main` `0bef530` |
| PR | **https://github.com/jalil-ahmadi2/plyr/pull/11** (open, contains H/J/I) |
| Working tree | clean |
| `npx tsc --noEmit` | ✅ clean |
| `npx vitest run` | ✅ **36 files / 711 tests** |
| `node --check public/js/*.js` | ✅ clean, file count **18** |
| Line endings | ✅ `public/**` 0 CR, `src/*.ts` CRLF intact |

Items **A–M** of the original gap list are done. **N is the only one left**,
plus the visual follow-ups in § 5.

---

## 2. Item **N** — per-node Run

### 2.1 The decision record (semantics)

> A node can only be executed **with real upstream data**. Faking its input, or
> "running" it while actually running the whole flow, are both fake-success.

**Chosen semantics (n8n's "Execute step"):** running node *X* enqueues the
**chain prefix** — every enabled node from the trigger up to **and including**
*X* — through the normal pipeline, and streams the result back. The prefix is a
literal `slice()` of the real serialization (`FlowEditor.toSteps()`), so nothing
is synthesised.

Consequences that were deliberately accepted, and how the UI stays honest:

| Case | Behaviour |
|---|---|
| *X* is on the main chain and enabled | Runs. |
| *X* is **disabled** | It emits no step at all (see `08-…` § 2), so the row renders **disabled** with `fe.runNodeDisabled`. |
| *X* is **inside a branch** (`then` / `else` / loop body / `catch`) | Not addressable as a chain prefix, so the row renders **disabled** with `fe.runNodeBranch`. This is the honest first slice; a later pass can lift it. |
| No `userId` yet | Toast `fe.needUserId`, exactly like `#fe-run` in `views.js`. |

Rejected alternatives (do not redo this analysis):
* *Send only the single step.* Its inputs would be empty → the OUTPUT column
  would show a lie for any node that depends on upstream data.
* *No endpoint at all — just call `API.runFlow()` with the prefix.* Works, but
  the server then cannot tell a real run from a node test, so the partial run
  would land in the Workspace **Executions** list and in the run stats. The
  dedicated endpoint exists to tag the job (§ 2.4).

### 2.2 Backend — `POST /run-node`

File `src/Routes/user.routes.ts` — **CRLF, 1190 CR bytes**. Insert the new
handler **directly after the `POST /run` handler**, which ends at line ~236
(`});` after its `catch`), i.e. before the
`// POST /schedule` banner at line ~240. The two blocks it must copy verbatim
are already in that file twice (in `/run` at 97-236 and in
`/workflows/:userId/:workflowId/run` at 880-1030): the **quota check** and the
**queue-limit check**. Copy them; do **not** refactor those two existing
endpoints into a shared helper in the same commit (they are covered by
`tests/integration/workflows.test.ts` and a refactor would mix concerns).

```ts
  // ══════════════════════════════════════════════════════════════════
  // POST /run-node — item N: execute ONE node with REAL upstream data.
  //
  // The client sends the chain PREFIX: every enabled step from the trigger up
  // to and including the node under test, which is therefore always the LAST
  // element of `steps`. Running the prefix (instead of the lone step) is what
  // makes the NDV OUTPUT column truthful — a node's input is produced by
  // actually executing its ancestors, never synthesised.
  //
  // Deliberate omissions:
  //   * no `webhookUrl` — a node test must not fire the user's webhook;
  //   * no `workflowId` — the job is NOT stamped `__workflowId`, so a partial
  //     test run never pollutes the Workspace Executions tab or the run stats
  //     (see GET /jobs and GET /workspace/:userId/stats).
  // Quota and queue limits are identical to POST /run: a node test costs the
  // same browser minutes, so it must not be a quota bypass.
  // ══════════════════════════════════════════════════════════════════
  router.post('/run-node', async (req: AuthenticatedRequest, res) => {
    try {
      const body = parseBody(runNodeBodySchema, req.body, res);
      if (!body) return;

      const userId = sanitizeUserId(body.userId);
      const headless = validateHeadless(body.headless, config.DEFAULT_HEADLESS);
      const plan = await UserManager.getUserPlan(connection, userId);
      const steps = validateSteps(body.steps, plan);
      const triggerData = (body.triggerData && typeof body.triggerData === 'object')
        ? body.triggerData
        : undefined;

      // The node under test is the last step. A client that also sends
      // nodeIndex must agree, otherwise its OUTPUT column would be painted
      // from another node's items — fail loudly instead.
      const nodeIndex = steps.length - 1;
      if (body.nodeIndex !== undefined && body.nodeIndex !== nodeIndex) {
        return res.status(400).json({
          success: false,
          error: `nodeIndex must address the LAST step of the prefix (${nodeIndex})`
        });
      }

      // ---- quota check: copy of POST /run ----
      // ---- queue-limit check: copy of POST /run ----

      const job = await queue.add(
        'run',
        { userId, steps, headless, triggerData, __runNode: true, __nodeIndex: nodeIndex },
        { priority: plan.priority }
      );
      const activeKey = getUserActiveJobsKey(userId);
      await connection.sadd(activeKey, job.id!);
      await connection.expire(activeKey, 90 * 60);

      // ?wait=true keeps the same contract as POST /run (inline result, or 202
      // + pollUrl when the run outlives config.RUN_WAIT_MAX_MS).
      const wait = req.query.wait === 'true' || req.query.wait === '1';
      if (wait) {
        const result = await waitForJobResult(
          queue, userId, job.id!, config.RUN_WAIT_MAX_MS, config.RUN_WAIT_POLL_MS
        );
        if (result) {
          return res.json({ ...(result as object), jobId: job.id, nodeIndex, partial: true, waited: true });
        }
        return res.status(202).json({
          success: true, jobId: job.id, nodeIndex, partial: true, waited: true, completed: false,
          pollUrl: `/job/${userId}/${job.id}`
        });
      }

      return res.json({
        success: true,
        jobId: job.id,
        nodeIndex,
        partial: true,
        stepCount: steps.length,
        message: 'Node run queued successfully',
        priority: plan.priority
      });
    } catch (e: unknown) {
      const error = e as Error;
      res.status(400).json({ success: false, error: error.message });
    }
  });
```

No new import is needed: `parseBody`, `validateSteps`, `validateHeadless`,
`sanitizeUserId`, `UserManager`, `getUserActiveJobsKey`, `waitForJobResult` and
`config` are all already imported at the top of the file (lines 1-26). Add
`runNodeBodySchema` to the existing `from '../schemas'` import list (line ~15).

### 2.3 `src/schemas.ts` (LF file, CR=0)

Append after `workflowStateSchema`, and add the `export type` next to the other
three:

```ts
// [Item N] POST /run-node — the chain PREFIX up to and including the node under
// test. `steps` is asserted here as a non-empty array (deep-validated by
// validateSteps in the route); the node under test is always the LAST element,
// and the optional `nodeIndex` is a client/server agreement check, not a
// selector. No webhookUrl (a node test must not fire webhooks) and no
// workflowId (a partial run must not be attributed to a saved workflow).
export const runNodeBodySchema = z.object({
  userId: z.union([z.string(), z.number()], {
    required_error: 'userId is required',
    invalid_type_error: 'userId must be a string or number',
  }),
  steps: stepsEnvelope,
  nodeIndex: z.number().int().min(0).optional(),
  headless: headlessLoose,
  triggerData: triggerDataLoose,
});

export type RunNodeBody = z.infer<typeof runNodeBodySchema>;
```

### 2.4 `GET /jobs/:userId` — keep the Executions tab honest

Same file, lines 627-646. Two one-line additions to the mapped row so a partial
node test is never mistaken for a real execution:

```ts
        partial: !!j.data.__runNode,
        nodeIndex: typeof j.data.__nodeIndex === 'number' ? j.data.__nodeIndex : null,
```
and widen the existing `trigger` expression (line ~640):
```ts
        trigger: j.data.__runNode ? 'node'
          : (j.data.__scheduled ? 'schedule' : (j.data.__workflowId ? 'workflow' : 'manual')),
```
`GET /workspace/:userId/stats` (line 1077) groups by `__workflowId`, which a
run-node job never carries, so it needs **no change** — verify that with a test
rather than trusting this sentence.

### 2.5 `public/js/api.js` (LF)

Add next to `runFlow` (line 133) and export it in the `window.API` literal
(line ~233, alphabetically after `runFlow`):

```js
  /**
   * Item N — run ONE node: `steps` is the chain prefix up to and including it
   * (the node under test is the LAST step). The server tags the job
   * `__runNode`, so it never shows up as a workflow execution.
   * body = { steps, nodeIndex?, headless?, triggerData? }
   */
  function runNode(userId, body) {
    var payload = { userId: userId };
    var b = body || {};
    for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) payload[k] = b[k]; }
    return post('/run-node', payload);
  }
```

### 2.6 `public/js/flow-editor.js` (LF, currently 4069 lines)

**(a) step-index helper** — insert right after `chainNodeIds()` (line 1953):

```js
  /**
   * 0-based index of `nodeId` **in the serialized step list**, or -1 when the
   * node has no step of its own. This is NOT the same as its position in
   * chainNodeIds(): a `disabled` node emits no step (08-HANDOFF § 2), so every
   * disabled node before it shifts the step index by one. Item N needs the STEP
   * index, because the prefix it sends is a slice of toSteps().
   */
  function chainStepIndex(nodeId) {
    var ids = chainNodeIds();
    var k = -1;
    for (var i = 0; i < ids.length; i++) {
      var n = state.nodes[ids[i]] || {};
      if (n.disabled === true) continue;
      k += 1;
      if (ids[i] === nodeId) return k;
    }
    return -1;                 // not on the main chain, or disabled
  }
```

**(b) the run itself** — put it next to the other run helpers; it may talk to
`window.RunPanel` directly, exactly as the ACTIVITY-LOG hook at line ~2902
already does:

```js
  /** views.js rule: env_root is the admin key, not an automation user. */
  function runUserId() {
    var uid = API && API.getUserId ? API.getUserId() : '';
    if (!uid || uid === 'env_root') return '0';
    return uid;
  }

  /** Item N — execute the chain prefix ending at `nodeId` (see 09-HANDOFF § 2.1). */
  function runNode(nodeId) {
    var idx = chainStepIndex(nodeId);
    if (idx < 0) return false;                 // guarded: the row is disabled
    var steps = toSteps().slice(0, idx + 1);
    if (!steps.length) return false;
    var uid = runUserId();
    if (!uid) { if (U() && U().toast) U().toast(t('fe.needUserId'), 'error'); return false; }
    setNodeStatus(nodeId, 'running');
    API.runNode(uid, { steps: steps, nodeIndex: idx, headless: true })
      .then(function (data) {
        if (U() && U().toast) U().toast(t('fe.runNodeQueued'), 'ok');
        var RP = window.RunPanel;
        if (RP && RP.startJob) {
          if (RP.open) RP.open();
          RP.startJob({ userId: uid, jobId: data.jobId,
            apiKey: API.getKey ? API.getKey() : '' });
        }
      })
      .catch(function (err) {
        setNodeStatus(nodeId, 'error');
        if (U() && U().toast) U().toast(err && err.message ? err.message : String(err), 'error');
      });
    return true;
  }
```

**(c) un-disable the context-menu row** — line 1154-1155, inside the
`fe.advanced` submenu. Replace the hard-coded `disabled: true` with the honest
per-node reason:

```js
          (function () {
            var idx = chainStepIndex(nodeId);
            var why = node.disabled === true ? t('fe.runNodeDisabled')
              : (idx < 0 ? t('fe.runNodeBranch') : '');
            return { icon: 'play', label: t('fe.runNode'),
              disabled: !!why, hint: why || t('fe.runNodeHint'),
              fn: function () { runNode(nodeId); } };
          })(),
```

**(d) fix the NDV header button** — line 1753-1760. It currently does
`closeNdv(); document.getElementById('fe-run').click();`, i.e. it says
**“Run node”** and runs the **whole flow**. That is a fake-success violation and
item N is its fix:

```js
    var nIdx = chainStepIndex(node.id);
    var nWhy = node.disabled === true ? t('fe.runNodeDisabled')
      : (nIdx < 0 ? t('fe.runNodeBranch') : '');
    runBtn.title = nWhy || t('fe.runNodeHint');
    if (nWhy) { runBtn.disabled = true; runBtn.setAttribute('aria-disabled', 'true'); }
    else runBtn.addEventListener('click', function () { runNode(node.id); });
```
`.ndv-run-btn:disabled` needs the same dead-control styling the other disabled
controls use (`color: var(--text-faint); cursor: not-allowed;`) — append it to
the NDV block in `public/css/styles.css` (4631 lines, 0 CR). **Only tokens that
really exist** may be used; `--text-mute`, `--accent`, `--surface-2` and
`--text-disabled` are **not defined** (that trap was cleaned up in `08-…`, and
`tests/unit/node-toolbox.test.ts` now guards it).

**(e) expose it** on the `window.FlowEditor` literal next to `setNodeStatus`
(line ~3968) so `views.js` and a future toolbar can reuse it:
`runNode: runNode,` and `chainStepIndex: chainStepIndex,`.

### 2.7 i18n — `public/js/i18n.js`, **both** dictionaries

Add next to the existing `fe.runNode` / `fe.runNodeSoon` block (fa line ~426,
en line ~1251):

| key | fa | en |
|---|---|---|
| `fe.runNodeHint` | «این نود با داده واقعی نودهای قبلی اجرا می‌شود.» | `Runs the chain up to and including this node, with real upstream data.` |
| `fe.runNodeQueued` | «اجرای نود در صف قرار گرفت.» | `Node run queued.` |
| `fe.runNodeDisabled` | «نود غیرفعال است و هیچ مرحله‌ای تولید نمی‌کند.» | `A disabled node produces no step, so it cannot be run.` |
| `fe.runNodeBranch` | «اجرای تک‌نود فعلاً فقط برای نودهای زنجیرهٔ اصلی ممکن است.» | `Single-node run currently works only for main-chain nodes.` |

**Delete `fe.runNodeSoon`** from both dictionaries once the row is live, and
update the two assertions that pin it:
* `tests/unit/node-toolbox.test.ts` **line 183** — the key list (`'fe.runNode',
  'fe.runNodeSoon',` → drop the second, add the four new keys);
* `tests/unit/node-toolbox.test.ts` **lines 201-204** — the "one unbacked row"
  test asserts `label: t('fe.runNode'), disabled: true, hint: t('fe.runNodeSoon')`.
  Replace that expectation with: `Convert Subflow` is still the only
  unconditionally-disabled row, and `Run node` is disabled **conditionally**
  (`disabled: !!why`) with a non-empty tooltip in every branch.

### 2.8 Tests to write (keep them cheap — no browser needed)

1. **`tests/unit/schemas.test.ts`** — mirror the `runBodySchema` block for
   `runNodeBodySchema`: accepts a valid body, accepts `nodeIndex: 0`, rejects
   empty/non-array `steps`, rejects a negative or fractional `nodeIndex`,
   **rejects `webhookUrl`? no** — the schema is non-strict like its siblings, so
   assert instead that the parsed object simply has no `webhookUrl` field.
2. **`tests/integration/workflows.test.ts`** (or a new
   `tests/integration/run-node.test.ts` — integration files are not capped by
   the 18-file rule) — it already mounts the real router with an in-memory Redis
   stub and a fake queue (`makeConnection()` / `makeQueue()`, lines 43-83), so
   the endpoint can be asserted directly:
   * 200 + `partial: true` + `nodeIndex === steps.length - 1`;
   * the queued job data carries `__runNode: true` and **no** `__workflowId`;
   * a mismatched `nodeIndex` → 400;
   * `?wait=true` returns the job file inline (`jobFiles` map, line 26) and 202
     with a `pollUrl` on timeout;
   * `GET /jobs/:userId` reports `trigger: 'node'`, `partial: true`, and the row
     is **excluded** when `?workflowId=` is given.
3. **`tests/unit/node-toolbox.test.ts`** — extend the item-J describe with
   static guards: `chainStepIndex` skips disabled nodes; `runNode` sends
   `toSteps().slice(0, idx + 1)`; both entry points (ctx row + `.ndv-run-btn`)
   call `runNode(`; neither one references `getElementById('fe-run')` any more
   (that is the fake-success regression guard); every disabled branch still sets
   a tooltip.

---

## 3. Extra findings from this session (do not lose these)

### 3.1 🐛 Chain index vs step index diverge once a node is disabled

`public/js/run-panel.js` `paintNodes()` (lines 63-84) maps a **step** index to a
node with `nodeIndex0 = idx1 - 1` and then
`FlowEditor.setNodeResultsByIndex(nodeIndex0, …)`, which resolves it through
`chainNodeIds()[i]` (`flow-editor.js` lines 1968-1978, 3992, 4011, 4019).
`chainNodeIds()` **includes disabled nodes**, but `graphToSteps()` **skips**
them (that semantic landed with item J/I — see `08-…` § 2). So on any flow with
a disabled node, every status halo / NDV result / pin after it is painted on the
**wrong node**.

**Fix** (cheap, do it with item N since § 2.6(a) already adds the helper):
give `flow-editor.js` a single `stepChainIds()` = `chainNodeIds()` filtered to
enabled nodes, and use it in the four index→id resolvers
(`setNodeStatus(number)`, `setNodeResultsByIndex`, `selectByChainIndex`,
`pinByIndex`). `chainStepIndex()` is its inverse; keep them adjacent so they
cannot drift. Guard with a unit test that builds a 3-node chain, disables the
middle one, and asserts index `1` resolves to the **third** node.

### 3.2 🐛 The NDV “Run node” button runs the whole flow

Already described in § 2.6(d). Until item N lands this is the single worst
fake-success in the editor, because the button is enabled and *looks* like it
worked. If item N has to be postponed again, the interim honest move is to
render `.ndv-run-btn` **disabled** with `fe.runNodeSoon` — one edit, and it
stops lying.

### 3.3 ⚠ `validateSteps` strips annotation fields

`src/validation.ts` whitelists the `AutomationStep` fields (`src/types.ts`
lines 62-90), so `label` / `note` / `color` — the item-J annotations — do **not**
survive a server round-trip. `/run-node` sends steps through the same
validator, which is *correct* (a run must not carry UI metadata), but it means
the OUTPUT column must be keyed by `nodeIndex`, never by a label. If node
annotations should ever persist server-side, that is a separate schema change to
`AutomationStep` + `validateSteps` + `WorkflowService`, and it needs its own
decision record.

### 3.4 ✅ Partial runs must stay out of the Workspace numbers

`GET /workspace/:userId/stats` (line 1077) and the Executions tab both key off
`__workflowId`. Not stamping it on a run-node job is what keeps the "real
counts only" rule true. Anyone tempted to add `workflowId` to
`runNodeBodySchema` for attribution must stamp it under a **different** key
(`__runNodeWorkflowId`) and leave `__workflowId` unset.

---

## 4. Verification recipe (no Redis needed)

```bash
cd /home/user/webapp
npx tsc --noEmit                       # must print nothing
npx vitest run                         # baseline: 36 files / 711 tests
for f in public/js/*.js; do node --check "$f" || echo "FAIL $f"; done
ls public/js/*.js | wc -l              # must stay 18
grep -c $'\r' src/Routes/user.routes.ts   # must stay 1190
for f in public/css/styles.css public/js/*.js; do
  n=$(tr -dc '\r' < "$f" | wc -c); [ "$n" = 0 ] || echo "CR in $f: $n"; done
```

Visual pass (Redis is absent, so `npm start` fails — use the preview server):

```bash
node tools/ui-preview-server.js 8788 &
node tools/ui-shot.js '#/editor' /tmp/x.png 1672x941 '<click-selectors>'
# ad-hoc Playwright scripts must run with:
NODE_PATH=/home/user/webapp/node_modules node /tmp/whatever.js
```
RTL trap: the default language is **fa**, so "top-end" is top-**left** and the
minimap is bottom-**left**; box-select needs `shiftKey: true` dispatched at
`.fe-canvas`, not a corner drag (it lands on chrome).

---

## 5. Still open after item N (unchanged priority order)

1. **§ 5.0 follow-ups** inherited from `07-…`: 980 px render pass; RTL dock
   pass; `#fe-result` inside the full-bleed shell; ACTIVITY LOG open state.
2. **§ 5.1 visual deltas**: palette / outline collapse **defaults** with
   persistence; the 13-glyph icon rail; **minimap proportions** — with few nodes
   the `.mm-viewport` rect fills nearly the whole widget with `--primary-soft`
   and reads as an orange block; clamp or soften it.
3. **Circled `+` on free output ports** — visible in
   `shell-add-node-palette.webp`, right of a node on the connector stub. It is a
   fifth Add Node entry point and it is cheap now that
   `openAddPalette({ from: { nodeId, port } })` exists: render the chip on free
   ports, open the palette pre-wired.
4. **Group** and **Convert Subflow** (group toolbar + context menu) are honestly
   disabled; they need a real container concept in the graph model first.
5. Branch-node per-node run (§ 2.1) — lift the main-chain-only restriction.

---

## 6. Anchor table (line numbers as of commit `3c99eab`)

| File | Anchor | Why |
|---|---|---|
| `src/Routes/user.routes.ts` (CRLF 1190) | 40 `waitForJobResult`, 97 `POST /run`, ~236 end of `/run` = **insertion point**, 600 `GET /jobs`, 640 `trigger:`, 880 workflow run, 1077 workspace stats | item N § 2.2 / 2.4 |
| `src/schemas.ts` (LF) | 18 `stepsEnvelope`, 23 `headlessLoose`, 30 `triggerDataLoose`, 86 `workflowStateSchema`, 101 `export type` block | § 2.3 |
| `src/validation.ts` | `validateSteps` whitelist | § 3.3 |
| `public/js/api.js` | 133 `runFlow`, 233 export literal | § 2.5 |
| `public/js/flow-editor.js` (4069) | 1154 ctx `Run node` row, 1753 `.ndv-run-btn`, 1953 `chainNodeIds`, 1968 `setNodeStatus`, 2169 `nodeStepJson`, 3968 export literal, 3992 `setNodeResultsByIndex`, 4011 `selectByChainIndex`, 4019 `pinByIndex` | § 2.6 / § 3.1 |
| `public/js/run-panel.js` | 63-84 `paintNodes`, 502 `pin()` | § 3.1 |
| `public/js/i18n.js` | fa ~426, en ~1251 (`fe.runNode*`) | § 2.7 |
| `public/js/views.js` | 49 `effectiveUserId`, 1172 `#fe-run` handler (the pattern `runNode` copies) | § 2.6 |
| `tests/unit/node-toolbox.test.ts` | 183 key list, 201-204 unbacked-row test | § 2.7 / § 2.8 |
| `tests/integration/workflows.test.ts` | 26 `jobFiles`, 43 `makeConnection`, 64 `makeQueue`, 90 mount | § 2.8 |

Reference material: `docs/uiux/shell-add-node-palette.{webp,md}` (locked
inventory: the 9-row context menu, the 7-button group toolbar, the 8 palette
categories, the circled `+`), `docs/uiux/state-empty-canvas.webp` (four ACTIVITY
LOG tabs), `08-…` § 5 (eleven traps), `07-…` § 4 (shell anchors) and § 5.6 (the
do-not-"fix" list), `HANDOFF_2026-07-27_ICONS_LAYOUT.md` (A–N table).
