# 24 — Live Run tab redesign

Reference: the operator's "Live Run" mock (top bar · browser · Execution steps).

## Layout
| Area | Content |
| --- | --- |
| Header (one row) | Live Run · Workflow name · Browser profile · Restart · Stop |
| Left | Status strip (RUNNING · Step N of M · current step · elapsed), then the browser window (address bar + screencast) |
| Right | Two tabs: **Execution steps (N)** (rows expand into OUTPUT / DETAILS) and **Log** |
| Footer | Run id · "View only" |

## Decisions
1. **The log is a tab, not a panel under the browser.** It took ~25% of the height and is read only
   when a run goes wrong. The Log tab carries a badge with the number of NEW errors/warnings
   (red if any error) so that moment is not missed; opening the tab clears it.
2. **The browser keeps the page's proportions.** `.lr-window` is the largest box with the frame's
   real aspect ratio (`--lr-ar`, from the screencast's width/height; 16:10 until the first frame)
   that fits the free space (container query units). The old picture was a wide, short letterbox.
   The separate "Live Run" tab above the header was folded into the header row for the same reason.
3. **Scrolling where space is tight:** step list and log scroll inside the side card; OUTPUT / DETAILS
   scroll at `min(260px, 34vh)` (both axes for long JSON lines); clipped lines keep a tooltip.
   Under 1100px wide (or under 560px tall) the page stacks and scrolls normally.
4. **Plan before it runs:** `GET /live/plan` (share token) gives the top-level chain with one
   non-secret target per step (`core/LiveRunPlan`: URL origin+path, selector, ms — never values,
   bodies, headers, tokens, code). `step.start` now carries `top` (position in the top-level chain)
   or `depth`, so live steps land on their planned rows and nested steps sit under their parent.
5. **Stop / Restart are owner-only.** Shown only when `GET /me` answers 200. Stop = existing
   `DELETE /cancel`; Restart = `POST /live/restart` (owner credential; a share token is refused),
   which cancels an unfinished run, queues the same work as a manual run and returns a new live link.
   The key travels in the `x-api-key` header, never a URL.
6. **Address bar** shows the page URL from the screencast (`pageUrl`: origin + path, no query/hash).

## Files
`src/core/LiveRunPlan.ts`, `src/Routes/live-control.routes.ts`, `src/core/JobScreencast.ts` (frame url),
`src/pipeline.ts` (top/depth), `src/index.ts` (wiring), `public/live-view.html`, `public/js/live-view.js`,
`public/js/live-tab.js` (pure: names, phrases, mergePlan, logLines, formatting), `public/css/styles.css` (`.lr-*`).

## Tests
`tests/unit/live-run-plan.test.ts`, `tests/unit/live-tab.test.ts`, `tests/unit/live-view-page.test.ts`.
Full suite: 4423 passed. Visual check in Chromium at 1568x875 / 1920x960 / 820x1100: browser box ratio 1.600, no page scroll on desktop.
