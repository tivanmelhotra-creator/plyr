# PROJECT.md — Plyr / Automation Backend

> **Canonical technical reference.** This document is derived from the source
> code, not from historical planning notes. Where it describes behaviour, that
> behaviour is implemented in the files cited. If this file and any other
> document disagree, **this file wins** — and the other document should be
> corrected or deleted.
>
> Names: the product and npm package are **Plyr** (`plyr`); the repository was
> formerly called `automation-backend` / `automation-backend-v37`; the editor UI
> shows the brand **Aria Automate** (a locked design decision, see `docs/uiux/`).
> Version `37.1.0` · license MIT

---

## 1. Overview

Plyr is a **self-hosted browser-automation backend**. A client submits a
declarative workflow — an array of `steps` — over HTTP. The server enqueues it,
runs it on a real browser driven by Playwright, streams live progress back, and
can deliver signed webhooks when the run finishes.

What the product actually does:

- **Declarative workflows.** No user-supplied code is executed. Each step names
  an action (`click`, `type`, `extract`, `httpRequest`, `if`, `loop`, …) with
  parameters.
- **Two browser targets.** The same workflow can run against a browser **on the
  server** (Remote Browser) or against **the user's own local Chrome** (Local
  Browser), reached through a reverse WebSocket tunnel.
- **Live observability.** Step-by-step events stream over WebSocket (with an SSE
  fallback), plus an interactive view of the browser itself.
- **Visual editor.** A bundled dashboard (`public/`) provides a node-graph
  workflow editor, an execution list and a node-detail view (NDV).
- **Element Inspector.** An MV3 Chrome extension lets a human point at a real
  element in a real page and hand a stable selector back to the workflow.
- **Queue-backed execution.** Jobs run through BullMQ on Redis, so runs survive
  restarts and can be scheduled with cron, cancelled, retried and rate-limited.

Two deployment shapes are supported from one codebase, selected by
`DEPLOYMENT_MODE` (`src/config.ts`):

| Mode | Meaning |
| --- | --- |
| `single` (default) | Self-hosted, single-user, full access. Quota / plan / level gating is disabled; a single `API_TOKEN` is used (auto-generated if unset). |
| `multi` | Multi-tenant. Per-user plans, quotas, levels, expiry and admin endpoints are enforced. |

---

## 2. Architecture

```
                 ┌──────────────────────────────────────────────┐
   HTTP clients  │  Express 4 app  (src/index.ts)               │
   Dashboard     │  ├─ Helmet CSP, CORS allow-list, rate limit  │
   Extension     │  ├─ src/Routes/*  (~100 routes)              │
   Schedulers ──▶│  ├─ auth / admin-auth / block-check mw       │
                 │  └─ Zod request validation (src/schemas.ts)  │
                 └───────────────┬──────────────────────────────┘
                                 │ enqueue
                     ┌───────────▼──────────────┐
                     │ BullMQ 'automation-jobs' │  Redis (ioredis)
                     │ + repeatable cron jobs   │
                     └───────────┬──────────────┘
                                 │ consume (MAX_CONCURRENT)
                     ┌───────────▼─────────────┐
                     │ Worker (src/index.ts)   │
                     │   └─ runPipeline()      │  src/pipeline.ts
                     └───────────┬─────────────┘
                                 │ acquireContext()
                     ┌───────────▼─────────────────────────────┐
                     │ BrowserAdapter — one Playwright         │
                     │ BrowserContext regardless of target     │
                     ├─────────────────────┬───────────────────┤
                     │ REMOTE: Chrome on   │ LOCAL: user's own │
                     │ the server (Xvfb +  │ Chrome via a      │
                     │ noVNC at /desktop)  │ reverse WS tunnel │
                     └─────────────────────┴───────────────────┘
                                 │ step events
                     ┌───────────▼─────────────┐
                     │ LiveBus → /live/ws      │  + SSE fallback
                     │ Redis Pub/Sub + replay  │  + signed share links
                     └─────────────────────────┘
```

**Single HTTP port, multiplexed WebSockets.** Everything shares one port. A
single `server.on('upgrade')` listener in `src/index.ts` dispatches by pathname,
and every sub-server implements `matches()` and returns *without destroying*
sockets it does not own:

| Path | Served by |
| --- | --- |
| `/live/ws` | `LiveServer` — job/step event stream |
| `/browser/ws` | `BrowserStreamServer` — interactive browser view |
| `/inspector/ws` | `InspectorSocket` — Element Inspector push channel |
| agent tunnel path | `LocalBridge` — Local Browser agents |
| `/desktop/…` | `DesktopProxy` → websockify/noVNC |

This is deliberate: a listener that destroyed unrecognised upgrades would
silently break the live view the moment an agent connected.

---

## 3. Directory Structure

```
src/
  index.ts              Entry point: Express app, queue, worker, WS upgrade mux
  config.ts             All env parsing + per-environment profiles
  pipeline.ts           The step executor (action catalog 1..43)
  types.ts              Shared workflow/step/job types
  schemas.ts            Zod request schemas
  validation.ts         Workflow-level validation
  rate-limit.ts         express-rate-limit wiring
  cli/doctor.ts         Environment self-check CLI
  Routes/               index, health, user, browser, mode, admin
  services/             job.service, workflow.service, webhook.service
  middleware/           auth, admin-auth, block-check
  utils/                helpers, redis-keys, signature
  core/                 52 focused modules (browser, live, inspector, consent…)
public/                 Bundled dashboard (vanilla JS, no build step)
extension/              MV3 Element Inspector extension source
modules/                External, hot-loadable step modules
  detect-red-circles/     manifest.json + run.js (the only jimp consumer)
scripts/                build-extension.js, postinstall.js, dev helpers
tools/                  Probes + verifiers (shellverify/, uiverify/)
tests/
  unit/                 96 suites — pure, no Redis needed
  integration/          14 suites — self-skip when Redis is absent
docs/                   API.md, COOLIFY.md, END_TO_END_GUIDE.md, openapi.yaml,
                        MEASURED-DECISIONS.md, uiux/ (normative UI specs)
```

Build output goes to `dist/` (`rootDir: src`), the packed extension to
`artifacts/`. Neither is committed.

---

## 4. Backend

- **Runtime:** Node.js 22, TypeScript 5.5, `module: commonjs`, `target: ES2021`,
  `strict: true`. Build is plain `tsc` → `dist/`.
- **HTTP:** Express 4 with **Helmet** (strict CSP) and an **explicit CORS
  allow-list** (`CORS_ALLOWED_ORIGINS`; `*` is allowed but disables credentials).
- **Rate limiting:** `express-rate-limit`, separate user and admin budgets
  (`RATE_LIMIT_PER_MINUTE`, `ADMIN_RATE_LIMIT_PER_MINUTE`). Enabled by profile —
  on in production, off in dev/test.
- **Auth:** API key in `x-api-key`; admin endpoints additionally require
  `x-admin-token`. Ownership is bound to the `:userId` path param by middleware,
  so a key can only ever touch its own records.
- **Validation:** Zod schemas at the edge (`src/schemas.ts`) plus workflow-level
  checks (`src/validation.ts`).
- **Fault containment:** `ProcessGuard` classifies faults with `classifyFault()`
  against a **closed list** of survivable operational faults. Anything not on
  that list is treated as fatal. The server must not die because one page threw.
- **Startup:** `StartupValidation` refuses to reduce the server to "browser
  only" — it serves the dashboard, the workflow API, the external HTTP API and
  the queue, and `SelfHeal`/`DesktopProvision` may install missing pieces at
  runtime without root.

---

## 5. Workflow / Node System

**Item-based data model** (`src/core/WorkflowItems.ts`). Data flowing between
nodes is an array of items shaped `{ json, binary? }`. A workflow starts with
exactly one empty item, so the first node runs exactly once. This model is
directly inspired by n8n's data model — the *concept* is prior art the engine
mirrors; there is no n8n dependency, package or integration in this repository.

**Action catalog** (`src/pipeline.ts`, `src/core/ActionCatalog.ts`) — actions 1
through 43, including control flow (`if`, `while`, `loop`, `foreach`, `switch`,
`try/catch/finally`), interaction (`click`, `type`, `mouse-move`, `drag-drop`,
`scroll`, `select`, `upload`, `download`, `clipboard`), page/tab control
(`navigate`, `switch-frame`, `switch-tab`, `close-tab`, `handle-dialog`), data
(`extract`, `set_variable`, variable transform, export data, `cookie`), plus
`httpRequest`, notification, and **43 = EXTERNAL MODULE**, the fallback that
hands an unknown action name to the `ModuleLoader`.

**Safe expression engine** (`public/js/expression.js`). A hand-written
tokenizer → parser → interpreter. It does **not** use `eval` or `Function`, and
it blocks any path to `constructor` / `__proto__` / prototype walking. This is a
deliberate security posture, and `tests/unit/expression.test.ts` pins it —
including the classic "reach `Function` via `.constructor` twice" escape.

**Code node** (`src/core/CodeNode.ts`, action `code`, category Data) — runs
the operator's own JavaScript. It is **not a security sandbox**: `require`,
`fetch`, the filesystem and the network are reachable on purpose, because in
`single` mode the author owns the server. Available names: `$input`
(`all/first/last/item`), `$json`, `$item`, `$index`, `$items`, `$vars`
(writes are copied back into run variables), `$node`, `$now`, `$execution`,
`console` (shown in the step log and the NDV OUTPUT), `require`, `fetch`, and
`page` / `context` when *Use browser* is on. Modes: run once for all items,
or once per item. The return value is normalised into items (object → 1 item,
array of objects → n items, `null`/`[]` → 0 items; no pass-through).
Without *Use browser* the code runs in a `worker_thread` that is terminated on
timeout (`CODE_NODE_TIMEOUT_MS`, default 30 s, per-node override) under a heap
cap (`CODE_NODE_MAX_MEMORY_MB`). With *Use browser* it runs in the server
process (Playwright objects cannot cross threads) and the timeout is a
`Promise.race`: an **async** runaway is abandoned, but a **synchronous**
infinite loop blocks the event loop and cannot be stopped. `CODE_NODE_ENABLED`
(default on in `single`, always off in `multi`), `CODE_NODE_ALLOW_MODULES`
(optional `require` allow-list). The `code` param is read raw: `{{ }}` inside
JavaScript is not substituted. This is the one deliberate exception to the
no-dynamic-code rule, which still applies in full to `public/js/expression.js`.

**Error policy** (`src/core/ErrorPolicy.ts`) — per node: *Continue On Fail*,
*Retry On Fail* (with backoff), or *Stop And Error*.

**Triggers** (`src/core/TriggerEngine.ts`) — Manual, Webhook, Schedule (cron)
and Telegram entry points. A trigger emits the items the first real node
consumes.

**Step reporting** (`src/core/StepReporter.ts`) — two channels: per-step
outbound webhooks (same HMAC scheme as job webhooks, with an optional event
allow-list) and a per-job signed share token for a read-only live view.

**External modules** (`src/core/ModuleLoader.ts`) — loads
`modules/<name>/{manifest.json,run.js}`. Module names are sanitised and the
resolved real path is checked against the modules directory, so a crafted name
cannot traverse out. `modules/detect-red-circles/` is the in-repo example and
the only consumer of the `jimp` dependency.

**Where a node's output files go** (`src/core/WorkflowOutputs.ts`) — a run of a
*saved* workflow files what its nodes produce (screenshot, download,
export-data) in that workflow's own workspace (`core/WorkflowStorage`, the
"Workflow Files" drawer), never in an anonymous per-job directory:

```
<WORKFLOW_STORAGE_ROOT>/<owner>/<workflowId>/downloads/<NN>-<action>/<file>
```

- One folder per node. `<NN>` is the node's position in the workflow
  *definition* (depth-first), so the same node keeps the same folder across
  runs and across loop iterations. The folder is created on first use and
  reused afterwards; files are never overwritten (`a (2).png`).
- The workflow is chosen by the **route**, which verifies the caller owns it and
  stamps `job.data.__workspace = { owner, workflowId }` (`POST /run`,
  `/run-node`, `/schedule` accept an optional `workflowId`; `POST
  /workflows/:u/:id/run` always sets it). The worker re-validates the stamp
  (`workspaceOf`). A foreign, missing or malformed id yields **no** workspace;
  nothing about the target workspace is ever taken from a page or an expression.
- The output item carries `{ path, folder, name, size, mimeType, url, storage:
  'workflow' }`. `url` is the existing `/browser/workflow-files/:id/download`
  route, so the same ownership and path checks apply — there is no second door.
- A run with no saved workflow (unsaved canvas, ad-hoc API call) has no
  workspace; screenshots then fall back to `core/JobArtifacts`
  (`/job/:u/:jobId/artifact/:file`, `storage: 'job'`), swept by the GC.
- The UI loads these images with the API key and shows them as `data:` URLs.
  Do **not** switch back to `blob:` — the CSP is `img-src 'self' data:`.

**Conditional nodes — If, Router, join and cycle rules** (`public/js/graph-serialize.js`,
`src/pipeline.ts`, `docs/uiux/20-HANDOFF-conditional-nodes.md`)

- `if` and `router` are separate nodes on purpose. `if` is "first match wins, then
  leave the group" with a neutral `next`; `router` has an explicit `default`
  output and **always continues after itself** (a join).
- Serializer (`analyze(graph)` -> `{steps, errors, warnings}`): a branching node
  closes at its join -- the explicit `next`/`done` target, otherwise the first
  node every non-empty branch reaches. A shared node is emitted once, after the
  branching step, never copied into each branch. Multi-path `if` never infers a
  join (its `next` is the continuation).
- Non-convertible graphs are rejected, not silently trimmed: `cycle` (use
  Loop/ForEach/While), `fanout` (two edges on one port), `dangling` (edge to a
  missing node). The editor marks the node/edge (`has-issue` / `is-invalid`) and
  Run / Run node refuse with a toast. `duplicated` is a warning.
- Runtime: `router` -> `{action:'router', paths:[{id,name?,condition,steps?}],
  fallback?}`; conditions use the shared `ConditionEngine`, and the UI reuses the
  Condition Builder NDV (`ndv-nodes.js`).

**Launch Browser options** (`public/js/browser-options.js`, `src/core/BrowserOptions.ts`,
`docs/uiux/21-HANDOFF-browser-options.md`)

- One catalog of 31 per-run options (headless, viewport, userAgent, locale, timezone, geolocation,
  permissions, colour scheme, proxy, headers, HTTP auth, JS on/off, HTTPS errors, slowMo, chrome
  flags...). The editor panel, the server Zod whitelist and the tests all read the same file.
- Stored as `params.browserOptions` on the Launch node; validated in `validateSteps`.
- Applied by tier: persistent browser = launch + context; shared free browser = context only;
  local / Real Chrome = none (logged as ignored). A reused persistent browser is relaunched when
  the option set changes.
- Real-Chromium proof per option: `tests/browser/browser-options.test.ts`.

**Live run tab** (`public/js/live-tab.js`, `public/live-view.html`, `public/js/live-view.js`,
`src/core/JobScreencast.ts`, `src/Routes/live-frames.routes.ts`, `docs/uiux/22-HANDOFF-live-run-tab.md`)

- A **Test Run** with a **visible** browser (the run switch, or the Launch node's own `headless:false`,
  which wins) opens a new tab. `LiveTab.launch()` calls `window.open` synchronously in the click,
  before any `await`, then navigates the blank tab to the signed link. A blocked popup becomes a
  visible link, never a silent no-op. Headless runs, saved runs and node tests open nothing.
- The address is `/live/view/:user/:job?share=<token>`. The token comes from
  `POST /live/share/:user/:job` (API key in the **header**), is bound to one job and expires
  (`LIVE_SHARE_TTL_SEC`). No API key is ever placed in a URL.
- The page is **view-only by construction**: `/live/sse` (run events, replayed by LiveBus on every
  connect, de-duplicated by `seq`) and `/live/frames` (CDP screencast, one session per watched job,
  max 5 viewers) are server -> client only. noVNC is deliberately not used: its `viewOnly` flag is
  enforced by the client, so a share credential for it would grant control.
  The screencast is served by the process that owns the job's page (in-process hub).
- Step timeline on the left, browser picture and the clicked step's output on the right; a pinned
  step stays on screen while newer ones arrive ("Follow latest" unpins).
- Tests: `tests/unit/live-tab.test.ts`, `job-screencast.test.ts`, `live-view-page.test.ts`,
  `tests/browser/job-screencast.test.ts` (real Chromium).

**Workflow file (export / import) and the NDV** (`public/js/workflow-exchange.js`,
`src/core/WorkflowExchange.ts`, `docs/uiux/23-HANDOFF-export-import-ndv.md`)

- The file is `{format:"plyr-workflow", version:1, workflow:{name,description,headless,steps}}`
  (+ `exportedAt`, `redacted`). ONE module (`workflow-exchange.js`) is loaded by the editor and
  evaluated by the server (same technique as `actions.js` / `browser-options.js`), then wrapped in a
  strict Zod envelope. Unknown `format` / newer `version` are refused, never guessed. No n8n importer.
- **Export** blanks every `password`-type node field and every secret launch option (proxy / HTTP-auth
  passwords) and lists them in `redacted`; it carries no `webhookUrl` and no `active` flag. The editor
  Export menu exports the CANVAS (disabled nodes kept); the Workspace row exports the saved workflow.
  `GET /workflows/:u/:id/export?format=native` is the same file for API/CLI (default unchanged).
- **Import**: `POST /workflows/:u/import/preview` (stores nothing) returns the summary the dialog shows
  (node count/kinds, Code nodes disabled, secrets to re-enter, launch options, legacy flag);
  `POST /workflows/:u/import` saves. **Every Code node is forced `disabled:true` server-side at any
  depth**, the workflow is saved **inactive**, and `webhookUrl` is dropped. An older plyr export
  (bare `{name,steps}`) is wrapped and handled the same way.
- `disabled` is now a real step flag: `validateSteps` keeps a literal `true`, the pipeline skips such a
  step, and the graph has two serialisers: `graphToSteps` (run: skips disabled nodes) and
  `graphToDocumentSteps` (save/export: keeps them flagged). Before this, autosave deleted disabled nodes.
- NDV: a token dropped on a Fixed field flips it to Expression; an unexecuted node's OUTPUT offers Run
  (guarded runner), an executed-but-empty one says so; in RTL the column order stays INPUT | Parameters
  | OUTPUT (measured in Chromium: `tests/browser/ndv-rtl-order.test.ts`).
- Tests: `tests/unit/workflow-exchange.test.ts`, `ndv-exchange-ui.test.ts`, `graph-serialize.test.ts`,
  `pipeline-code-node.test.ts`, `tests/integration/workflow-import-export.test.ts`.


---

## 6. Browser Automation

Both targets are normalised to a single Playwright `BrowserContext` by
`BrowserAdapter.acquireContext()`, so `pipeline.ts` never branches on target.

**Remote Browser** — a real Chrome running on the server under **Xvfb**, exposed
to the operator through **websockify + noVNC**, proxied by `DesktopProxy` at
`/desktop`. Managed by `RealChrome`, `Desktop`, `DesktopSession`,
`DesktopProvision`, `RemoteBrowserStart`. Because it is a real desktop Chrome it
supports extensions, a download shelf, real file dialogs and a real context
menu.

**Local Browser** — the user's own Chrome. `tools/local-browser-agent.js` runs
on the user's machine and dials **out** to the server, establishing a reverse
WebSocket tunnel handled by `LocalBridge`. Nothing needs to be exposed on the
user's network. If the agent drops, the Playwright attachment built on top of it
is dropped too — otherwise the next node would receive a handle to a browser
that no longer exists.

Stealth: `playwright-extra` + `puppeteer-extra-plugin-stealth`. Playwright is
pinned to exactly `1.56.1` — the browser build and the CDP behaviour measured in
`docs/MEASURED-DECISIONS.md` are tied to that pin.

Supporting core modules include `BrowserTabs`, `BrowserInput`, `BrowserProfile`,
`ChromeFlags`, `ChromeView`, `ChromeExtensions`, `CookieImport`,
`RemoteDownloads`, `RemoteUploads`, `RemoteFileChooser`, `DownloadHeaders`,
`SessionHandoff`, `SelfHeal`, `GlobalBrowser`.

---

## 7. Inspector / Extension

The **Element Inspector** solves selector authoring: instead of guessing a
selector, a human points at the element.

- Source in `extension/` (MV3): `background.js`, `content/`, `popup/`,
  `lib/ab-core.js`.
- Packed by `scripts/build-extension.js` into `artifacts/`, and downloadable
  from the server via `GET /extension/download`.
- Server side: `InspectorHub`, `InspectorSocket` (`/inspector/ws` push
  channel), `InspectorExtension`, `InspectorAuthorization`,
  `TargetFieldRegistry`.
- HTTP surface: `/inspector/pair`, `/inspector/target`, `/inspector/element`,
  `/inspector/inbox`, `/inspector/ack`, `/inspector/session`,
  `/inspector/targeting/*`, `/inspector/consent*`.

Flow: the extension pairs with the server, the server names a target field, the
human picks an element in the live page, and the resulting selector is pushed
back into the workflow editor.

---

## 8. Consent

`src/core/RemoteTargetConsent.ts` (singleton `remoteTargetConsent`) implements
**Remote Target Consent**, which replaced the older typed authorization code for
remote browsers.

The rule: **the server decides the target, a human attaches to it.** An in-page
Allow/Deny prompt is shown in the remote browser and the operator answers it
there. Consent routes live in `src/Routes/mode.routes.ts`
(`GET /inspector/consent`, `GET /inspector/consent/status`,
`POST /inspector/consent/decide`).

`inspectorAuth.grant()` is the **single trust-creation point**. Nothing else
mints inspector trust, and `resolveUserId()` derives identity from the presented
credential only — never from a client-supplied body field.

---

## 9. Queues / Redis / BullMQ

- **Client:** `ioredis`. Keys are centralised in `src/utils/redis-keys.ts`.
- **Queue:** a single BullMQ queue named **`automation-jobs`**
  (`src/index.ts:145`).
- **Worker:** one `Worker('automation-jobs', …)` with
  `concurrency: config.MAX_CONCURRENT`.
- **Scheduling:** BullMQ **repeatable (cron)** jobs back `POST /schedule`,
  `GET /schedules/:userId` and `DELETE /schedule/:userId/:key(*)`.
- **Delay:** `moveToDelayed` is used for deferred/retried work.
- **Ordering:** a **Lua script** enforces job-ordering guarantees;
  `POST /reload-lua` reloads it.
- **Idempotency:** an `Idempotency-Key` header on `POST /run` maps
  `(userId, key) → jobId` for `IDEMPOTENCY_TTL_SECONDS` (default 24h). A retry
  with the same key returns the original job instead of enqueuing a second one.
- **Synchronous mode:** `POST /run?wait=true` blocks up to `RUN_WAIT_MAX_MS`
  (polling every `RUN_WAIT_POLL_MS`) and returns the full result inline; on
  timeout it returns **HTTP 202 with a `pollUrl`**.
- **Live fan-out:** `LiveBus` publishes over **Redis Pub/Sub** with a replay
  buffer, so a client that connects slightly late still sees prior events.

Redis is **required** at runtime. Integration tests self-skip when it is absent.

### Durable storage: SQLite

Redis keeps the queue, Pub/Sub, idempotency keys and cron. What must survive a
Redis flush lives in **SQLite** (`STORAGE_DRIVER=sqlite`, the default):
saved workflows, their version history, and the **execution history**.

- **Driver:** `better-sqlite3`. `node:sqlite` is experimental on Node 22 and
  absent on Node 20 (still allowed by `engines`); better-sqlite3 is synchronous,
  ships prebuilt binaries and exposes the online backup API.
- **File:** `SQLITE_PATH` (default `./data/plyr.db`, Docker `/app/data/plyr.db`
  on the `./data` volume), WAL mode. `data/` and `backups/` are git-ignored.
- **Schema:** append-only numbered migrations in `src/core/SqliteStore.ts`,
  tracked by `PRAGMA user_version`. A file from a newer build is refused.
- **Layers:** `services/workflow.repository.ts` (`WorkflowRepository` with
  Redis and SQLite implementations; no business rules), `WorkflowService`
  (version bumps, history cap, state switches — unchanged),
  `services/execution.repository.ts` (one row per finished job: workflow,
  trigger, status, timings, error, per-step summary with at most 3 sample
  items), `services/storage.ts` (driver choice + import).
- **One-time import:** at boot, if the DB holds no workflow and the import
  marker is absent, every `wf:meta:*` / `wf:ver:*` record is copied from Redis
  (SCAN, never KEYS). Redis is **not** modified, so `STORAGE_DRIVER=redis`
  still works afterwards.
- **History API:** `GET /executions/:userId[?workflowId=&limit=&before=]`,
  `GET /executions/:userId/:jobId`. Per-node test runs are not recorded.
  Retention: `EXECUTION_RETENTION_DAYS` (30) and `EXECUTION_MAX_ROWS` (10000).
- **Backup:** `./plyr backup [dir]` (online backup → one self-contained file,
  safe while running), `./plyr restore <file>` (refuses while the server is up,
  validates integrity + schema, keeps the old file as `.pre-restore-<time>`).
- **doctor:** DB directory writable + schema/row counts; warns when Redis runs
  without `appendonly yes`.
- **One process per DB file.** PM2 `instances > 1` is not supported
  (`ecosystem.config.js` is pinned to one fork-mode instance).

---

## 10. API / Routes

Roughly **100 routes**, mounted from `src/Routes/index.ts`. Full reference:
[`docs/API.md`](docs/API.md) and the OpenAPI spec
[`docs/openapi.yaml`](docs/openapi.yaml).

| Group | File | Representative routes |
| --- | --- | --- |
| Health | `health.routes.ts` | `GET /health`, `GET /health/browser` |
| Execution | `user.routes.ts` | `POST /run`, `POST /run-node`, `GET /job/:userId/:jobId`, `GET /jobs/:userId`, `DELETE /cancel/:userId/:jobId` |
| Workflows | `user.routes.ts` | `GET/POST/PUT/DELETE /workflows/:userId[/:workflowId]`, `/run`, `/export`, `/versions`, `PATCH /state` |
| Scheduling | `user.routes.ts` | `POST /schedule`, `GET /schedules/:userId`, `DELETE /schedule/:userId/:key(*)` |
| Identity | `user.routes.ts` | `GET /me`, `GET /quota/:userId`, `GET /api-keys`, `POST /api-keys/generate` |
| Browser | `browser.routes.ts` | `/browser/start\|stop\|restart\|status\|settings`, `/browser/tabs`, `/browser/desktop/*`, `/browser/real/*`, `/browser/extensions*`, `/browser/cookies/export`, `/browser/downloads/:token` |
| Mode & Inspector | `mode.routes.ts` | `GET/POST /browser-mode`, `/browser-mode/handoff/*`, `/inspector/*` incl. consent |
| Admin | `admin.routes.ts` | `/stats`, `/users/*`, `/user/:userId/*`, `/reset-quota/:userId`, `/set-user-level`, `/cleanup`, `/reload-lua`, `/system/restart`, `/restart-global-browser` |

Non-router surfaces: `/live/ws`, `/live/sse/:userId/:jobId`, `/browser/ws`,
`/inspector/ws`, `/desktop/vnc.html`, `GET /extension/download`, and the static
dashboard from `public/`.

**Outgoing webhooks** are a documented contract, not an inbound path. When
`WEBHOOK_SECRET` is set, every body is signed:

```
X-Signature:           sha256=<hex HMAC-SHA256 of the raw JSON body>
X-Webhook-Timestamp:   <unix seconds>
X-Webhook-Attempt:     <retry attempt number>
```

The HMAC is computed over the **exact serialized bytes** transmitted
(`src/utils/signature.ts`), so receivers must verify against the raw body.
Outgoing webhook URLs pass an **SSRF guard**.

---

## 11. Configuration

All configuration is environment-driven and parsed in one place,
`src/config.ts`, which applies **per-environment profiles** (a setting can
default differently in production, development and test). `.env.example` is the
annotated reference — copy it to `.env`. Highlights:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `REDIS_URL` / host+port | Redis connection |
| `API_TOKEN` | Single-user API key (auto-generated in `single` mode if unset) |
| `ADMIN_TOKEN` | Required for admin endpoints |
| `DEPLOYMENT_MODE` | `single` (default) or `multi` |
| `MAX_CONCURRENT` | Worker concurrency |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list; `*` disables credentials |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_PER_MINUTE`, `ADMIN_RATE_LIMIT_PER_MINUTE` | Rate limits |
| `RUN_WAIT_MAX_MS`, `RUN_WAIT_POLL_MS` | Synchronous `/run?wait=true` behaviour |
| `IDEMPOTENCY_TTL_SECONDS` | `Idempotency-Key` retention (default 86400) |
| `WEBHOOK_SECRET`, `WEBHOOK_RETRY_BACKOFF_MS` | Outgoing webhook signing/retry |
| `WORKFLOW_MAX_VERSIONS` | Versions retained per saved workflow (0 = all) |
| `BROWSER_MODE_DEFAULT` | `remote` or `local` |
| `LOCAL_BROWSER_ENABLED` | Enables the Local Browser agent tunnel |
| `LIVE_SHARE_TTL_SEC` | Live share-link lifetime in seconds. Default **7200** (2 h; was 24 h). 0 = never expires (doctor warns) |
| `REAL_CHROME_DEBUG_BIND` | DevTools listen address. Default `127.0.0.1`; doctor/boot warn on anything else |
| `ALLOW_DEFAULT_API_TOKEN` | Dev-compose-only opt-out of the `admin123` refusal (see §11.1) |
| `MAX_TOTAL_EXECUTION_OPS` | Hard ceiling on operations per run |
| `GOD_MODE_IPS` | Local privileged IPs |

`npm run doctor` (`src/cli/doctor.ts`) checks the resolved environment.

---

### 11.1 Security minimums

One module, `src/core/SecurityChecks.ts` (pure functions + injectable probes), feeds
**both** the boot log (`validateStartup()` → `issues[]`) and `npm run doctor`
(section "SECURITY MINIMUMS"). Nothing writes; the workflow scan opens SQLite
read-only and never creates the file.

| Check | Rule | Severity |
|---|---|---|
| `default_token_in_production` | `API_TOKEN` is the public `admin123` under `APP_ENV=server` or `production` | **fatal** (server refuses to start). `warn` only with `ALLOW_DEFAULT_API_TOKEN=true`; ignored on development/test |
| `debug_bind_exposed` | `REAL_CHROME_DEBUG_BIND` is not loopback (`0.0.0.0`, LAN IP). Default stays `127.0.0.1` | warn |
| `redis_port_exposed` | a `docker-compose*.yml` publishes `6379` outside loopback, **or** (server/production) Redis answers on one of this host's non-loopback IPv4 addresses | warn |
| `public_domain_not_https` | `PUBLIC_DOMAIN` is `http://` on a non-local host | warn |
| `https_unreachable` | *doctor only*: no valid TLS handshake on the domain (no Caddy/proxy, bad or <14-day certificate) | warn |
| `webhook_without_hmac` | server/production or public domain **and** an *active* workflow has a `trigger_webhook` with an empty `secret`, or workflows send to a `webhookUrl` while `WEBHOOK_SECRET` is empty | warn |
| `live_share_ttl` | `LIVE_SHARE_TTL_SEC` is `0` or > 24 h | warn |

Decisions worth knowing:

* **admin123 is refused, not just warned**, because under `server`/`production`
  the box is meant to be reachable and the token is public. The only compose file
  that sets it is `docker-compose.dev.yml` (loopback-only, disposable), and it
  opts out explicitly with `ALLOW_DEFAULT_API_TOKEN: "true"` so the exception is
  visible where it is needed. `./plyr` now writes a random `API_TOKEN` into a
  freshly created `.env`; `.env.example` keeps `admin123` only for local dev.
* **Network probes only run on server/production**, and the TLS handshake only in
  `doctor` (an outbound connection has no place in boot). Unit tests never touch
  the network: the NIC list and TLS probe are injected; the Redis probe is tested
  against a real loopback listener.
* **Webhook scan scope.** There is no inbound webhook route yet
  (`docs/PLAN-node-logic-v2.md`), so the warning is about the *configuration* that
  will be public the moment the route lands, plus outgoing signing. It scans
  SQLite only; with `STORAGE_DRIVER=redis` it reports "not scanned".
* **`LIVE_SHARE_TTL_SEC` 24 h → 2 h.** A run is capped at 90 min and a fresh link
  is minted per Test Run, so 2 h covers the longest run; a leaked link dies the
  same afternoon. Per-request `ttlSec` is unchanged (hard cap 30 days).

## 12. Development

The canonical lifecycle is the Plyr Runtime Manager:

```bash
./plyr install
./plyr start --dev
./plyr status
./plyr doctor --deep
```

| Script | Does |
| --- | --- |
| `./plyr install` | Verifies/installs Node, npm, Redis, desktop dependencies, Chromium and builds the app |
| `./plyr start --dev` | Starts the development server through the canonical manager |
| `./plyr start --build` | Starts the built application through the canonical manager |
| `./plyr stop` / `./plyr restart` | Stops/restarts only the manager-owned active runtime |
| `npm run dev` | Compatibility alias for `./plyr start --dev` |
| `npm run build` | `build:server` (tsc) + `build:extension` |
| `npm run check` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run doctor` | Runtime Manager deep self-check |
| `npm start` | Compatibility alias for `./plyr start --build` |
| `npm run clean` | Remove `dist/` and `artifacts/` |

**One-shot setup:** `bash dev.sh` is a compatibility wrapper for
`./plyr install-and-start-dev`; the canonical Codespaces path is documented in
[`CODESPACES.md`](CODESPACES.md).

**Installer:** `./install.sh` remains the bootstrap/wizard for server (node),
server (docker), client (Chrome extension) and Coolify targets. Its Native path
delegates dependency installation and lifecycle readiness to `./plyr` rather
than maintaining a second installer.

**Testing:** Vitest with `environment: node`, `pool: 'forks'` and
`singleFork: true` — suites run serially so integration tests cannot collide on
Redis keys. `tests/integration/setup.ts` pins a deterministic env before any
`src/config.ts` import. Unit tests (96 suites) need nothing external;
integration tests (14 suites) need Redis and skip themselves without it.

Extra verifiers: `tools/shellverify/*.py` (installer/startup wiring) and
`tools/uiverify/verify.js` (dashboard/extension assets).

### Standing project rules (R1–R5)

These predate this document, are cited from live source comments, and still
apply to every change. They are recorded here because the session notes that
originally held them have been removed.

| # | Rule |
| --- | --- |
| **R1** | Cross-check every node's options against [AutomaApp/automa](https://github.com/automaapp/automa) before designing or declaring a node "finished". Its node logic is the accepted reference — specifically `conditionBuilder` (`valueTypes` / `compareTypes` / `inputTypes`) and its Conditions block. Cited from `public/js/ndv-model.js` and `public/js/ndv-ui.js`. |
| **R2** | Nodes are the essence of the tool. A node is not "done" until it exposes the **complete** set of options its runtime can honour. |
| **R3** | Never ship a control that changes nothing. If a knob has no backend behind it, either implement the backend or delete the knob. (Precedent: `EVALUATE_MODES` / `maxDepth` were deleted rather than faked.) |
| **R4** | Commit after every change; rebase on `origin/main`; squash to one commit; open/update the PR and hand over the PR link. |
| **R5** | CSP-safe vanilla JS on the client; fa/en i18n key parity; `npx tsc --noEmit` + `node --check` + `npx vitest run` green before delivery. **LF** line endings under `public/**` (and `src/core/LiveBrowser.ts`); much of `src/**/*.ts`, root `package.json` and `.env.example` are **CRLF** — edit those in binary-safe mode so a one-line change does not rewrite the whole file. |

---

## 13. Deployment

| Method | Files |
| --- | --- |
| **Runtime Manager** | `./plyr` — canonical install/start/stop/restart/status/doctor lifecycle |
| **Docker** | `Dockerfile` + `docker-compose.yml` (app + Redis) |
| **Coolify** | `docker-compose.coolify.yml` — see [`docs/COOLIFY.md`](docs/COOLIFY.md) |
| **Caddy** | `Caddyfile.example` for automatic HTTPS in front of the app |
| **Codespaces** | `./plyr install && ./plyr start --dev` (or compatibility `bash dev.sh`) |
| **Windows** | `Control_Center.cmd` |

The `Dockerfile` is multi-stage: it builds with dev dependencies, then copies
`node_modules`, `dist/`, `package.json`, `public/` and `extension/` into the
runtime image. Redis must be reachable. For the Remote Browser the image also
needs Xvfb, websockify and noVNC — `DesktopProvision` can install missing pieces
at runtime without root.

CI: `.github/workflows/ci.yml` (typecheck, tests, extension artifact checks).

---

## 14. Technical Constraints

1. **Redis is mandatory.** No Redis, no queue, no scheduling, no live fan-out.
   Saved workflows and execution history live in SQLite (`SQLITE_PATH`) by
   default; run one Plyr process per database file.
2. **Playwright is pinned to `1.56.1`** (exact, no caret). The measured CDP
   behaviour in `docs/MEASURED-DECISIONS.md` assumes that build.
3. **CommonJS.** `module: commonjs` — do not introduce ESM-only dependencies
   into `src/` without a build change.
4. **One HTTP port.** Every WebSocket path is multiplexed by the single
   `upgrade` listener; any new sub-server must implement `matches()` and must
   **not** destroy sockets it does not own.
5. **No dynamic code execution.** The expression engine forbids `eval` and
   `Function` and blocks prototype access. Never "fix" it by reintroducing them.
   The Code node (`src/core/CodeNode.ts`) is the single, explicit exception:
   it runs operator-written JavaScript by design and is off in `multi` mode.
6. **HMAC over exact bytes.** The webhook body must be serialised once and both
   signed and sent; re-serialising breaks receiver verification.
7. **Ownership via path param.** `:userId` is authorised by middleware against
   the presented key. Never trust a user id from a request body.
8. **Module loading is sandboxed by path.** `ModuleLoader` resolves only inside
   `modules/`; keep the traversal guard intact.
9. **Fault classification is a closed list.** Only faults explicitly classified
   survivable are survived — an unknown fault is fatal by design.
10. **Serial tests.** `singleFork: true` is required; parallel runs collide on
    Redis keys.
11. **Mixed line endings.** Many source files use CRLF (see R5). Preserve a
    file's existing endings when editing to avoid whole-file diffs.

---

## 15. Known Limitations

- **Local Browser depends on the user's machine.** If the agent process dies or
  the network drops, in-flight runs for that user fail; the Playwright
  attachment is intentionally torn down with the tunnel.
- **Remote Browser needs a desktop stack.** Without Xvfb / websockify / noVNC
  the `/desktop` view is unavailable; `DesktopProvision` attempts a runtime
  install, which will not succeed in every container.
- **Integration tests silently skip without Redis.** A green run on a machine
  with no Redis has *not* exercised queue, scheduling or live behaviour.
- **`single` mode is genuinely single-user.** Quotas, plans and levels are
  inert; do not expose a `single`-mode instance as a multi-tenant service.
- **No lint tooling.** There is no `lint` script and no ESLint config; style is
  maintained by review, and `tsc --noEmit` is the only static gate.
- **Synchronous `/run?wait=true` is bounded.** Runs longer than
  `RUN_WAIT_MAX_MS` return `202 + pollUrl`; clients must handle both shapes.
- **Scheduling granularity is cron-level**, inherited from BullMQ repeatables.
- **The dashboard has no build step.** `public/js/*` is hand-authored vanilla JS
  loaded directly; there is no bundler, so no tree-shaking and no type checking
  there.
- **Windows support is limited** to `Control_Center.cmd` plus the documented
  Docker path; the shell installers assume a POSIX environment.

---

## Related documentation

| Document | Scope |
| --- | --- |
| [`README.md`](README.md) | Getting started, install paths, quick tour |
| [`docs/API.md`](docs/API.md) | HTTP API reference |
| [`docs/openapi.yaml`](docs/openapi.yaml) | Machine-readable OpenAPI 3.0.3 spec |
| [`docs/END_TO_END_GUIDE.md`](docs/END_TO_END_GUIDE.md) | Full walkthrough, entry point to result |
| [`docs/COOLIFY.md`](docs/COOLIFY.md) | Coolify deployment |
| [`docs/MEASURED-DECISIONS.md`](docs/MEASURED-DECISIONS.md) | Measured CDP evidence behind browser design choices |
| [`docs/uiux/`](docs/uiux/README.md) | Normative UI/UX specs (cited from source and tests) |
| [`extension/README.md`](extension/README.md) | Element Inspector extension |
| [`CODESPACES.md`](CODESPACES.md) | GitHub Codespaces quick start |
