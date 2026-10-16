
Confirmed, proceed. Answers to your open items:

## G — Play when another profile in the same branch is open
Follow section G in Task(Pull_76)_2.md exactly: run the technical check first (G.1 — plain chrome launch without Playwright, check whether exit code 21 / SingletonLock is a real Chromium limit or an artifact of the test setup, repeat in the Docker image). Do not stop to ask me after that:
- If a second profile CAN open manually without breaking the first Playwright session: implement the inset alert + 3-second hold-to-confirm "I understand" flow (G.2), mark the second browser manual-only, and define how Stop/viewer/close-all behave for it.
- If Chromium genuinely blocks it even without Playwright: implement the OK-only informational alert (G.3), no hold, nothing launched.

## F — reference image
`reference-3-screens.jpg` is the final reference image. One correction to your own reading of it: I checked the image directly — all four rows in Screen B show an OPEN padlock, none show a closed one. The open/closed padlock is a real per-profile lock state (section 6, "locked to one workflow"), not something fixed per row in this reference — it will differ based on actual data once implemented. The image does confirm there is NO restore/history icon anywhere (section 4.5) — follow that.

## Launch Settings — audit before Stage 2/3 UI work
Before building the new Launch Settings UI in Stage 2/3: list what Launch Settings currently does in the codebase that has a real effect on the launched browser (width/height, custom flags Chromium actually receives, etc.) versus what is just decorative UI structure with no functional difference. Report that breakdown when Stage 1 wraps up.

## B, 1.1, 2.3
Proceed with these as defined in Task_Pull_76.md and Task(Pull_76)_2.md. Make sure 1.1 removes all remaining Local Browser UI section strings/CSS/dead code while keeping backend RealChrome / /browser/real/* intact per point C.

## Point A — viewer tab regression & fallback
Confirm explicitly that current HEAD matches main's original self-closing mechanism (window.close() after two consecutive zero-session checks on /browser/sessions ~2s apart). Also restore the fallback from section 2.2: when the browser refuses window.close() (e.g. a user-typed tab), do NOT leave an empty background-colored page — navigate the tab to the app's main page.

## Docker
Not needed from you right now. I will run ./plyr dev-docker --ref pr-76 --dev myself once this PR is ready. Do not attempt to install Docker in the sandbox.

Continue and finish B, 1.1, 2.3, and G now, and include the Launch Settings functional/decorative breakdown and point A confirmation in your next report.