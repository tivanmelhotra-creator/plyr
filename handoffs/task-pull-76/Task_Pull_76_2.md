Owner feedback on your Stage 1 report. Answer every point (A to I) in your next report, with evidence.

A. 2.2 viewer tab: this is a REGRESSION. Restore the original mechanism first.
The owner reports that on main the viewer tab closes itself when no browser is left, with the same Open action. So the bug was introduced on feat/profile-infrastructure (PR #76). Your earlier diagnosis (window.opener is empty, so close() was never tried) must be checked against this: if main works with the same Open action, something in this branch changed (how the tab is opened, or what decides "no browser left").
The rule: when no browser is open, a viewer tab has no purpose and must go away. Never leave a black page and never show a dialog.
Do this, in order:
  1. Find the code that closes the viewer on main (search for window.close, /browser/real/health and /browser/sessions in the viewer and its server routes) and the same code on this branch. Show the diff (git diff main...feat/profile-infrastructure for those files).
  2. Run the SAME scenario on main and on this branch in real Chromium: open a browser with the Open action, close all browsers from inside the tab, watch the tab. Record the result for each ref.
  3. Find the exact commit that broke it (git bisect or the log of those files). Report the commit and the cause with evidence. Say whether each hypothesis is true or false: (a) the branch opens the viewer with noopener or a plain link instead of window.open; (b) /browser/sessions never reaches zero, for example because the viewer itself counts as a live session or entries are not removed after a browser closes.
  4. Fix it by restoring the main behavior wherever possible, adapted only as far as multiple profiles require. Keep the S27 safety rule: closing depends only on /browser/sessions reporting zero live sessions for this viewer, confirmed by two consecutive checks about 2 seconds apart; one failed probe, or a probe on another route, never closes the tab.
  5. Add extra layers (the main tab closing the viewer tabs it opened, a BroadcastChannel signal, a redirect to the app's main page when close() is refused) ONLY if, after the regression is fixed, a real scenario still needs them.
  Tests in real Chromium, on both refs: tab opened by the Open or link action; two browsers with one closing (the tab stays); the last browser closing (the tab closes within about 5 seconds). Add a regression test that fails on the old code. Tell me which mechanism closed the tab in each test.

B. 2.6 and the Play/link semantics (a verification plus one explicit rule)
  - Play on a closed profile launches the browser AND opens a viewer tab once.
  - On a running profile, the icon is the external-link icon (it takes Play's place). It NEVER launches or relaunches anything. It only opens a viewer tab for the already-running browser, because the owner may have closed the first tab. If a viewer tab for that browser is already open, focus it instead of creating another. If it cannot be found (for example after a reload), open a new tab. It never creates a second browser or session.
  - Verify this still works after removing the Local Browser section, including for the browser that used to be realchrome.
  - Tests: click the link twice -> still one browser process and no duplicate tab; close the viewer tab, click the link -> a new viewer tab shows the same browser.

C. 1.1 scope clarification
Only the Local Browser SECTION/ROW in the Workflow Files panel (UI, strings, CSS, translation keys) is removed. The Local Browser MODE of the app (RealChrome, realchrome, /browser/real/*, launching, showing and closing that browser) has nothing to do with this and must not change. You removed the built-in branch for it from the registry: prove with tests that the mode still launches, shows and closes exactly as before, and tell me which user-data-dir it uses now.

D. A workflow with no profile selected
With the Default auto-profile and the built-in branch gone, what does a workflow that selected no profile launch with? The owner's requirement: no selection = the default browser opens. Run it in real Chromium and report. If it fails, it is a bug to fix in this stage.

E. Baseline check
You say 5 commits on 491de46. Confirm whether 491de46 equals origin/feat/profile-infrastructure, and that the earlier work (Local Browser section removal, Turn on/off removal, "Chromium Session Closed" dialog removal) is present in this code. Show: git log origin/feat/profile-infrastructure -1.

F. Rebuilt brief
The rebuilt instruction file is 191 bytes shorter than the original (31,329 vs 31,520). List every section heading (0 to 10) and confirm none is missing, especially sections 4, 5 and 6. Tell me if the reference image is the final one (padlock open/closed icons, no restore icon).

G. Play with another browser already open in the same branch (REPLACES the "OK-only dialog" in 1.6 and the Play prompt paragraph in 4.5 of the main brief; do NOT hide or remove Play, and do NOT add a muted line under the header)
The owner's decision: Play stays visible on every closed profile row. When the user clicks Play while another browser is already open in that branch, show a warning and let the user decide.
  1. Technical precondition. Your test showed Chromium rejecting a second profile in the same user-data-dir with exit code 21 (ProcessSingleton). Before building the flow, find out whether this is a real Chromium limit or an artifact of how the test launched it. Test all of these with the first profile running under Playwright:
     - a plain launch, not Playwright: chrome --user-data-dir=<same root> --profile-directory=<second profile> (does it forward to the running process and open a window for the second profile, and does the first Playwright session survive?);
     - whether exit code 21 is caused by a hostname or PID namespace lock mismatch (SingletonLock) in the sandbox or in Docker rather than by Chromium's normal forwarding;
     - repeat the working case in the Docker image the owner uses.
     Report the exact commands and results.
  2. If a second browser can run by hand (for example by forwarding to the running process): implement this flow.
     - Clicking Play shows an inset alert inside the panel (no native alert/confirm/prompt). Title: "Another browser is open in this branch". Body, in plain language: (a) automated runs can control only ONE browser per branch; (b) a second browser here is for manual use only, workflows cannot use it; (c) running a workflow on this branch while both are open can fail or close one of them (state only the consequence you verified); (d) the suggestion: "Better: keep this profile in a different branch, so both can run at the same time."
     - Buttons: "Cancel" and a hold-to-confirm button "I understand". While the pointer, Enter or Space is held, the button fills from left to right like a game loading bar and reaches full in exactly 3 seconds, then it confirms and launches. Releasing before it is full resets it to empty and does nothing. It must work with pointer, touch and keyboard, and respect reduced motion.
     - The confirmation applies to that single launch of that single profile only. The next Play on any profile in that branch asks again. It changes nothing for other profiles.
     - The second browser is marked manual-only: automation can never claim or use it. Define and report what happens when a workflow needs this branch while it is open (use the existing lease and reservation rules; do not invent a new concept). Define and report how Stop, the viewer, and the branch's "close all" behave for a browser started this way.
  3. If a second browser is truly impossible even by hand: keep Play visible, and show the same inset alert as information only: title "Another browser is open in this branch", a short explanation that a second profile cannot be opened in the same branch, and the suggestion "Close the open browser, or put this profile in another branch." Only an "OK" button, no hold-to-confirm, and nothing is launched.
  4. Tests: both flows in real Chromium; release at 2.9 seconds does nothing; release at 3 seconds launches; keyboard operation; no native dialogs in the DOM.

H. Tests
Say how many tests were removed and how many were added (the pass count moved only from 4629 to 4630 although seven translation keys and several tests were removed). Keep reporting skipped and failed separately.

I. Push
Push is NOT approved yet. Finish the rest of Stage 1 first (2.3 end-to-end profile creation, points A to D above, 1.1 cleanup of the UI section), then do the Docker "from zero" run (./plyr dev-docker --ref pr-76 --dev), and then ask me again before pushing. Commit and back up after every step as before.