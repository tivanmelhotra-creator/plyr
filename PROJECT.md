# PROJECT.md — Plyr / Automation Backend

> **Canonical technical reference.** This document is derived from the source
> code, not from historical planning notes. Where it describes behaviour, that
> behaviour is implemented in the files cited. If this file and any other
> document disagree, **this file wins** — and the other document should be
> corrected or deleted.
>
> Package: `automation-backend-v37` · version `37.1.0` · license MIT

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
| `LIVE_SHARE_TTL_SEC` | Live share-link lifetime (0 = never expires) |
| `MAX_TOTAL_EXECUTION_OPS` | Hard ceiling on operations per run |
| `GOD_MODE_IPS` | Local privileged IPs |

`npm run doctor` (`src/cli/doctor.ts`) checks the resolved environment.

---

## 12. Development

```bash
npm install                    # postinstall runs scripts/postinstall.js
cp .env.example .env
npm run install:browser:deps   # Playwright Chromium + OS deps
npm run dev                    # tsx watch src/index.ts
```

| Script | Does |
| --- | --- |
| `npm run dev` | Watch-mode server via `tsx` |
| `npm run build` | `build:server` (tsc) + `build:extension` |
| `npm run check` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run doctor` | Environment self-check |
| `npm start` | `node dist/index.js` (runs `prestart` build) |
| `npm run clean` | Remove `dist/` and `artifacts/` |

**One-shot setup:** `bash dev.sh` installs dependencies, creates `.env`, starts
Redis, builds and runs the server — this is also the GitHub Codespaces path
(forward port 3000 and set its visibility to Public). See
[`CODESPACES.md`](CODESPACES.md).

**Installer:** `./install.sh` offers server (node), server (docker), client
(Chrome extension) and Coolify targets, interactively or via flags
(`--server-node`, `--server-docker`, `--client`, `--coolify`).

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
| **PM2** | `ecosystem.config.js` (runs `./dist/index.js`) |
| **Docker** | `Dockerfile` + `docker-compose.yml` (app + Redis) |
| **Coolify** | `docker-compose.coolify.yml` — see [`docs/COOLIFY.md`](docs/COOLIFY.md) |
| **Caddy** | `Caddyfile.example` for automatic HTTPS in front of the app |
| **Codespaces** | `bash dev.sh`, then make port 3000 public |
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
2. **Playwright is pinned to `1.56.1`** (exact, no caret). The measured CDP
   behaviour in `docs/MEASURED-DECISIONS.md` assumes that build.
3. **CommonJS.** `module: commonjs` — do not introduce ESM-only dependencies
   into `src/` without a build change.
4. **One HTTP port.** Every WebSocket path is multiplexed by the single
   `upgrade` listener; any new sub-server must implement `matches()` and must
   **not** destroy sockets it does not own.
5. **No dynamic code execution.** The expression engine forbids `eval` and
   `Function` and blocks prototype access. Never "fix" it by reintroducing them.
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
