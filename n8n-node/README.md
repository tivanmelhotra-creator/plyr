# n8n-nodes-automationbackend

An [n8n](https://n8n.io) community node package for the self-hosted **Automation
Backend** (this repository). It lets you run browser-automation `steps`
workflows, schedule recurring runs, fetch results, cancel jobs, and **trigger**
n8n workflows from the backend's signed webhooks — all from inside n8n.

It pairs with the backend's n8n-friendly API (step 14): synchronous
`POST /run?wait=true`, the `Idempotency-Key` header, and HMAC-signed webhooks.
See [`../docs/openapi.yaml`](../docs/openapi.yaml) for the full API contract.

## Nodes

### Automation Backend (action node)

| Operation | Method / Endpoint | Notes |
|-----------|-------------------|-------|
| **Run Saved Workflow** ⭐ | `POST /workflows/:userId/:workflowId/run` | **Recommended "Model B"** — pick a previously saved & versioned workflow from a dropdown (loaded live from `GET /workflows/:userId`). Optionally inject **Trigger Data (JSON)** as the first node's input items, and override **Headless** / **Webhook URL** for this run only. Honours **Wait for Completion** (`?wait=true`) + **Idempotency Key** just like Run Inline. |
| **Run Inline Workflow** | `POST /run` | Submit a `steps` array directly. Toggle **Wait for Completion** for sync mode (`?wait=true`) and set an **Idempotency Key** to dedupe retries. |
| **Get Job Result** | `GET /job/:userId/:jobId` | Poll a job's status / result. |
| **Create Schedule** | `POST /schedule` | Recurring cron job. |
| **Cancel Job** | `DELETE /cancel/:userId/:jobId` | Optional `closeBrowser` / `closeTab`. |

> **Why Run Saved Workflow?** It is the cleanest way to wire n8n to the backend:
> design and version your automation once in the dashboard (graph editor, NDV,
> live runs), then call it from n8n by **name** — no need to paste a `steps`
> array into n8n or keep two copies in sync. The **Workflow Name or ID**
> dropdown is populated by `loadOptions` (calls `GET /workflows/:userId`); set
> **User ID** first so the list can load (use `local` in single-user mode).

### Automation Backend Trigger (trigger node)

Exposes an n8n webhook URL. Point a job's `webhookUrl` (the **Webhook URL**
field on the Run/Schedule operation, or the backend `WEBHOOK_SECRET`-signed
notification) at this node's **Production URL** to start a workflow when a job
finishes.

- **Events** — filter by `job.completed`, `job.failed`, `job.cancelled`,
  `job.blocked`, `job.quota_exhausted` (empty = accept all).
- **Verify Signature** — when on, the node verifies the `X-Signature`
  (HMAC-SHA256 of the raw body) header using the **Webhook Secret** from the
  credential, and rejects unsigned/invalid requests with `401`. This must match
  the backend's `WEBHOOK_SECRET`.

## Credentials — Automation Backend API

| Field | Required | Description |
|-------|----------|-------------|
| **Base URL** | ✅ | Root URL of the backend, e.g. `https://automation.example.com`. |
| **API Key** | ✅ | Sent as the `x-api-key` header on every request. |
| **Webhook Secret** | — | Same value as the backend `WEBHOOK_SECRET`; used by the Trigger node for HMAC verification. |

The **Test** button calls `GET /me` and expects `200`.

## Installation

### Option A — n8n GUI (Community Nodes)
1. In n8n: **Settings → Community Nodes → Install**.
2. Enter `n8n-nodes-automationbackend` and confirm.

### Option B — manual / self-hosted
```bash
# In your n8n custom-extensions directory (e.g. ~/.n8n/custom or N8N_CUSTOM_EXTENSIONS)
npm install n8n-nodes-automationbackend
# then restart n8n
```

### Option C — build from this repo (local dev)
```bash
cd n8n-node
npm install --legacy-peer-deps   # n8n-workflow is a peer dep, provided by n8n at runtime
npm run build                    # compiles to dist/ and copies icons
# link into n8n:
#   npm link  (here)  &&  npm link n8n-nodes-automationbackend  (in ~/.n8n/custom)
```

> `n8n-workflow` is intentionally a **peerDependency** — n8n provides it at
> runtime. A local type shim (`types/n8n-workflow.d.ts`) lets the package
> type-check/build standalone without installing n8n's native deps.

## Example workflows

Import either file in n8n (**Workflows → Import from File**):

- [`examples/run-saved-workflow.json`](examples/run-saved-workflow.json) ⭐ —
  the **Model B** pattern: a **Schedule Trigger** fires every 6 hours →
  **Automation Backend (Run Saved Workflow, Wait=true)** runs a stored workflow
  by id with injected **Trigger Data** and an hourly **Idempotency Key**; an
  **Automation Backend Trigger** receives the signed `job.*` / `step.error`
  webhooks. Replace `workflowId` with one of your saved workflow ids (pick it
  from the dropdown once your credential is set).
- [`examples/example-workflow.json`](examples/example-workflow.json) — the
  inline pattern: **Manual Trigger → Automation Backend (Run Inline Workflow,
  Wait=true)** runs a tiny `goto`+`extract` flow and returns the result inline,
  while an **Automation Backend Trigger** receives the signed webhook for the
  same job.

## Saved Workflows (G2)

The backend can **store** reusable, versioned workflows so any client (this n8n
node, the Chrome extension, the dashboard UI) shares the same definitions and
history. The **Run Saved Workflow** operation above runs one directly (with a
name dropdown), and the **Test** credential / dropdown use `GET /workflows`.
For the remaining CRUD operations, use an **HTTP Request** node (with the same
`x-api-key`):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/workflows/:userId` | Create a workflow (`{ name, steps, ... }`) → version 1 |
| `GET` | `/workflows/:userId` | List the user's workflows |
| `GET` | `/workflows/:userId/:workflowId` | Fetch one workflow |
| `PUT` | `/workflows/:userId/:workflowId` | Update (bumps version + snapshots history) |
| `DELETE` | `/workflows/:userId/:workflowId` | Delete workflow + history |
| `GET` | `/workflows/:userId/:workflowId/versions` | Version history (newest first) |
| `POST` | `/workflows/:userId/:workflowId/run` | Re-run a saved workflow (supports `?wait=true` + `Idempotency-Key`) |

See [`docs/openapi.yaml`](../docs/openapi.yaml) for the full contract.

## CORS note

The action node calls the backend **server-side from n8n**, so browser CORS does
not apply. Keep `CORS_ALLOWED_ORIGINS` configured only for browser clients
(the dashboard UI / extension).

## License

MIT
