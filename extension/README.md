# Automation Backend Helper — Chrome Extension

A lightweight **Manifest V3** Chrome/Chromium extension that lets you:

- **Pick elements** on any real web page and instantly get a stable **CSS** + **XPath** selector (same selector logic used by the backend's Live Browser View), then **insert the selector directly** into a `click`/`extract` step.
- **Record actions** (click / type / Enter / navigation) on the page and turn them into backend **steps**.
- **Send** the recorded steps to your self-hosted `automation-backend` as an inline Flow (`POST /run`) using your **API Key** — directly from the popup.
- **Use the same backend as the dashboard panel** (Step 31, *Model A*): the popup logs in with the *same* API key, lists the **same saved workflows** (`GET /workflows/:userId`), and can **run a saved workflow** (`POST /workflows/:userId/:workflowId/run`) on demand.
- **Watch the run live** — the popup subscribes to the job's live stream (SSE) and paints a **tick ✓ / error ✗ / retry ↻** per node, mirroring the dashboard's live node states.
- **Open the panel** in a new tab (the same UI the extension is a thin client of — not a parallel copy).

It is the *"real browser"* companion (Solution B) to the in-app Live Browser View (Solution A). Use it when you want to capture selectors / flows, or trigger and monitor your saved workflows, while browsing in your own logged-in Chrome session.

---

## 1. Requirements

- Google Chrome, Chromium, Brave, or Edge (any Chromium-based browser with MV3 support).
- A running `automation-backend` instance reachable from your browser (e.g. `http://localhost:3000`).
- A valid **API Key** for that backend (a per-user key, or the root/admin env key).

---

## 2. Install (load unpacked)

The extension is **unbundled** plain JS — no build step is needed.

1. Open `chrome://extensions` in your browser.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked**.
4. Select the `extension/` folder from this repository.
5. The **Automation Backend Helper** icon appears in the toolbar. Pin it for convenience.

> If you change any file, return to `chrome://extensions` and click the **reload** ↻ button on the extension card.

---

## 3. Configure the backend

Click the extension icon to open the popup, then under **Backend**:

| Field      | Example                  | Notes |
|------------|--------------------------|-------|
| Base URL   | `http://localhost:3000`  | Scheme optional — `localhost:3000` becomes `http://localhost:3000`. Trailing slash is stripped. |
| API Key    | *(your key)*             | Sent as the `x-api-key` header. Never logged. |
| User ID    | `local`                  | The `userId` used in the Flow payload. In self-hosted single-user mode the backend binds the key to `local`; in multi-tenant mode it is your key's owner id. |

Click **Save**, then **Test connection** to verify connectivity. *Test* calls `GET /me` with your key, shows **online / offline**, resolves the **canonical userId** the key is bound to (auto-filled), and loads your saved **Workflows**. Click **Open panel** to open the dashboard UI in a new tab.

---

## 4. Usage

Open any normal **http/https** web page (the content script does not run on `chrome://`, the Web Store, or `file://` pages).

### Pick an element
1. Click **🎯 Pick element**.
2. Hover the page — the element under the cursor is highlighted.
3. Click the target element. Picking is **one-shot**: it stops automatically and shows the selected element's **CSS** and **XPath** in the popup.
4. From the picked box you can:
   - **Copy CSS** to the clipboard.
   - **Add click** → appends `{ action: "click", params: { selector } }` to the step list.
   - **Add extract** → prompts for a **field name** then appends `{ action: "extract", params: { selector, name } }` (so the extracted value lands in a named field).

### Run a saved workflow (same list as the dashboard)
1. After **Test connection**, the **Workflows** card lists your saved workflows (name · version · step count) — the *same* list shown in the dashboard panel.
2. Click **▶ Run** on any workflow. Tick **show browser** first if you want a headful run.
3. The popup queues the run (`POST /workflows/:userId/:workflowId/run`) and opens a **Live run** card that paints **✓ / ✗ / ↻** per node as the job streams events, ending with **Done ✓** or **Failed**.
4. Use **↻ Refresh** to reload the list after editing workflows in the panel.

### Record a flow
1. Click **⏺ Record**.
2. Interact with the page normally. The recorder captures:
   - **click** → `click` (with a CSS selector)
   - **input/change** on form fields → `fill` (selector + value)
   - **Enter** key → `press` (`Enter`)
   - **navigation** (URL change) → `goto` (target URL)
3. Click **⏹ Stop recording** when done. Steps accumulate in the **Steps** list.

### Send to backend
1. Review the steps (use **Clear** to start over).
2. Click **Send to backend**. The popup asks the background service worker to `POST /run` with body:
   ```json
   { "userId": "0", "steps": [ ... ], "headless": true }
   ```
3. On success the popup shows **Queued ✓ — Job ID: …**. Track it in the backend UI (Jobs).

> The picked/recorded step format matches the backend's canonical `ACTION_CATALOG` (`{ action, params }`), so steps map 1:1 to backend actions (`goto`, `click`, `fill`, `type`, `press`, `extract`, …).

---

## 5. CORS / networking notes

The extension performs all backend requests (`GET /me`, `GET /workflows/:userId`, `POST /run`, `POST /workflows/:userId/:workflowId/run`, and the live `GET /live/sse/...` stream) from its **background service worker**, which is extension-privileged and granted `host_permissions: ["http://*/*", "https://*/*"]`. This avoids the page-context cross-origin restrictions a content-script fetch would hit, so **the default flow works even when the backend's `CORS_ALLOWED_ORIGINS` is empty**. The live stream is read in the worker via `fetch` + `ReadableStream` (MV3 workers have no `EventSource`), with the API key passed as `?api_key=` since SSE cannot set headers.

However, if you customize the extension to fetch from a *page* context, or your backend sits behind a proxy that enforces `Origin` checks, configure CORS on the backend:

```env
# .env on the backend
# Allow any origin (simplest for self-hosted / local dev):
CORS_ALLOWED_ORIGINS=*

# Or allow specific origins (comma-separated). For an extension origin:
# CORS_ALLOWED_ORIGINS=chrome-extension://<your-extension-id>
```

With an **empty** `CORS_ALLOWED_ORIGINS`, the backend answers a preflight `OPTIONS` with `204` but **does not** emit an `Access-Control-Allow-Origin` header — a page-context fetch from a disallowed origin would then be blocked by the browser. The background-fetch path used by this extension is unaffected.

> Tip: For purely local single-user setups, `CORS_ALLOWED_ORIGINS=*` is the least-friction option. For shared deployments, allowlist the specific origins you trust.

---

## 6. Permissions explained

| Permission | Why |
|------------|-----|
| `storage` | Persist your settings + recorded steps in `chrome.storage.local`. |
| `activeTab` / `tabs` | Relay picker/recorder toggles to the active tab. |
| `scripting` | (Reserved) programmatic injection if needed. |
| `host_permissions: http/https` | Let the background worker call your backend and let content scripts run on web pages. |

No data is sent anywhere except to the **Base URL** you configure. Your API Key is stored locally and only transmitted to your backend via the `x-api-key` header.

---

## 7. Files

```
extension/
├── manifest.json          # MV3 manifest
├── background.js          # service worker: /me, /workflows list+run, /run, SSE live relay, open panel, content relay
├── lib/
│   └── ab-core.js         # pure shared helpers (window.ABCore): URL builders, list/me parse, live-event mapping, stepLabel — reused by popup + worker + unit tests
├── content/
│   ├── selector.js        # window.ABSelector → cssPath() / xPath() (matches backend picker)
│   └── recorder.js        # element picker overlay + action recorder
├── popup/
│   ├── popup.html         # popup UI (config / workflows / capture / steps / live run)
│   ├── popup.css          # dark theme
│   └── popup.js           # popup controller (CSP-safe, no inline JS); consumes ABCore
├── icons/                 # 16 / 48 / 128 px
└── README.md              # this file
```

---

## 8. Troubleshooting

- **"Open a normal web page (http/https)…"** — you're on a restricted page (`chrome://`, store, PDF viewer, `file://`). Switch to a normal site.
- **Connection failed (offline)** — check the Base URL, that the backend is running, and that the API Key is valid (`GET /me` should return `success: true`).
- **Send failed: http_401** — invalid/missing API Key.
- **Send failed: http_400** — payload rejected by the backend schema (e.g. an unsupported action). Check the Steps list.
- **No steps recorded** — make sure **Record** is active (button shows *Stop recording*) and you're interacting with the *active* tab.
- **Workflows list is empty** — confirm you ran **Test connection** first (it resolves the userId and loads the list), and that the user actually has saved workflows. Use **↻ Refresh**.
- **Live run shows no ticks** — the job may have finished before the popup subscribed, or the popup was closed (the SSE stream is driven by the popup session). Re-open the popup and re-run, or watch the job in the dashboard panel.
