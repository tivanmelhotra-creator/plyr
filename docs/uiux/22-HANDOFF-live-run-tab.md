# 22 — Live run tab (Task 4b)

## What the user gets
Press **Test Workflow** with the *Live browser* switch on (or a Launch Browser node whose
`headless` option is off): a second tab opens at once and shows the run as it happens.

| Area | Content |
| --- | --- |
| Header | Title, job id, connection badge (Connecting / Connected / Reconnecting / Running / Run completed / Run failed) |
| Left | Step timeline. Clicking a step selects it. |
| Right, top | The browser picture (CDP screencast). The last picture stays after the run. |
| Right, bottom | The selected step's input/output counts, duration, output sample, error |
| Footer | "View only" notice |

The tab never accepts input. There is no input route on the server and no form control on the page.

## Why these choices
1. **`window.open` first.** Popup blockers only allow it inside the click. The run (queue) and the
   share token (second request) are asynchronous, so the tab opens blank and is navigated later.
   Logic lives in `public/js/live-tab.js` (pure, tested like `run-state.js`).
2. **Share token, not an API key.** The URL carries only `?share=` (HMAC, bound to one user+job,
   expiring). The API key travels in the `x-api-key` header of `POST /live/share/...`.
3. **Screencast, not VNC.** noVNC's view-only mode is a client flag; handing out a credential for
   it would give keyboard/mouse control. A CDP screencast has no input path, and it also works for
   headless pages (no X display).
4. **Reconnect and replay.** LiveBus replays its buffer on each SSE connect; `createFeed` drops
   events already applied (by `seq`, in a bounded Set), so a reconnect never doubles the log. A link
   rejected three times in a row without ever opening is reported as invalid/expired instead of
   retrying forever.
5. **Pinned step.** Selecting a step pins it. New steps do not steal the output pane; "Follow latest"
   releases it.

## Server
- `src/core/JobScreencast.ts` — one CDP session per watched (user, job); frames are acked even when
  throttled (Chromium stalls otherwise); detached when the last viewer leaves; follows the job's
  page if it changes; max 5 viewers per job.
- `src/Routes/live-frames.routes.ts` — `GET /live/frames/:userId/:jobId`, gated by `authorizeLive`
  (the same gate as `/live/sse`), slow clients drop frames instead of buffering.
- In-process: in a split web/worker deployment the process that owns the browser must serve it.

## Limits / not done
- Only the headed-run tab is opened automatically; a saved/scheduled run can still be opened by hand
  from a share link.
- Screencast is JPEG at ~8 fps, 1280x800 max. It is a monitoring view, not a remote desktop.

## Tests
`tests/unit/live-tab.test.ts` (34), `job-screencast.test.ts` (18), `live-view-page.test.ts` (12),
`tests/browser/job-screencast.test.ts` (real Chromium).
