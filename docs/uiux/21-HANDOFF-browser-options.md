# 21 - Launch Browser options (Task 4a)

## What it is
One catalog - `public/js/browser-options.js` (`window.BROWSER_OPTIONS`) - of 31
per-run browser options. Three consumers read the SAME file, so they cannot drift:

| consumer | file |
|---|---|
| "Add option" panel (searchable, grouped, live validation + warnings) | `public/js/browser-options-ui.js`, mounted in the Launch Browser NDV (`flow-editor.js`) |
| server whitelist (Zod, `.strict()`), plan builder, diagnostics | `src/core/BrowserOptions.ts` (evaluates the catalog like `ActionCatalog` does) |
| tests - iterate the catalog | `tests/unit/browser-options*.test.ts`, `tests/browser/*browser-options*.test.ts` |

Stored on the node as `params.browserOptions` (JSON text in the editor, an object
in `steps[]`). Only options the user ADDS are present; nothing added = old behaviour.

## Options (id : Playwright key)
headless, slowMo, chromeArgs (launch) - viewportWidth/Height -> `viewport`,
deviceScaleFactor, isMobile, hasTouch, userAgent, colorScheme, reducedMotion,
locale, timezoneId, geolocationLat/Lon/Accuracy -> `geolocation` (+ auto
`geolocation` permission), permissions, extraHTTPHeaders, httpUsername/Password ->
`httpCredentials`, javaScriptEnabled, ignoreHTTPSErrors, offline, bypassCSP
(context) - proxyServer/Username/Password/Bypass -> `proxy` (launch).

## Which browser each option can reach (`planFor(options, tier)`)
- `vip` (persistent browser): launch + context options both apply.
- `free` (shared GlobalBrowser): only context-scope options apply
  (`GlobalBrowser.getContext(overrides)`); launch-scope ones are LOGGED as
  ignored, never silently dropped.
- `attached` (local browser / Real Chrome extensions): the browser is not ours;
  every option is logged as ignored.

## Decisions
- **Relaunch on change.** A VIP browser is reused across jobs, so
  `vipOptionHash` (per user) is compared with the plan hash; a different hash
  relaunches. Without it a changed option would silently do nothing (R3).
  Removing all options also relaunches back to defaults.
- **Launch node wins over the run switch** for `headless`
  (`effectiveHeadless`). A Launch node reached while the browser is already open
  cannot change it: the run log says so and tells the user to add Close Browser.
- **Denied** (`ARG_DENY`, `HEADER_DENY`): chrome switches that would break the
  product's own wiring (remote debugging, user-data-dir, extensions, proxy, window
  size, headless, `--no-sandbox`...), `disable-web-security`, and hop-by-hop headers.
- **Secrets** (proxy/http passwords) are stored in the workflow like any param
  (the UI says so) and are masked (`***`) in run logs.
- Validation happens at the API boundary (`validateSteps`) so a typo is a 400
  with a readable message, not a silently ignored setting.

## Verified against real Chromium (tests/browser, run with `npm run test:browser`)
Every option has a test asserting an observable effect on a live page (local echo /
auth / CSP servers, a counting proxy with a 407 challenge, a self-signed HTTPS
server). Findings while writing them, now encoded in the tests: headless Chromium
reports `Notification.permission` as "denied" even when granted (use
`permissions.query`); Playwright's `slowMo` does not slow `evaluate`; `--hide-scrollbars`
and similar switches are not observable in headless, so `chromeArgs` is proven with
`--host-resolver-rules`. `headless:false` needs a display (Xvfb) and skips without one.

## Automa parity (R1)
Automa's "New Tab"/"Browser" options expose user agent, viewport, proxy and
timezone; those four are covered. Not copied: Automa's screenshot-on-failure and
"block images/CSS" toggles live in other nodes here (`TURBO_MODE` /
`FREE_RESOURCE_BLOCKING` are server-wide, not per-run) - listed under "not done".

## Not done
- Per-run resource blocking (images/fonts) - server-wide only today.
- Persisting a per-user "default options" preset.
- Options for the shared (free) browser launch, by design (not ours to relaunch).
