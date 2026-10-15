Task: Rebuild the Browser Profiles feature to match the owner-approved 3-screen reference design, add the profile lock and the launch-flag system, make the backend clean and consistent with the UI, and fix every known bug listed below. Treat every item in this prompt as a requirement. Where this prompt says "verify", do not assume: check the code and a real Chromium, and report evidence.

====================================================================
0. READ FIRST, AND VERIFY BEFORE YOU CHANGE ANYTHING
====================================================================
- Repo: tivanmelhotra-creator/plyr. Work branch: feat/profile-infrastructure (PR #76).
- Run git log, git status, and read the newest files in handoffs/ and the PR #76 body. Report the real HEAD and anything in this prompt that does not match the code. If a statement here is wrong, say so and use the code as the truth.
- The owner attaches a reference image (3 screens: A Branch List, B Profile List, C Launch Settings). The text in section 4 is authoritative where the image and the text differ.
- Ground rules from the owner (do not break them):
  1. Do NOT merge or close PR #76.
  2. Push ONLY to feat/profile-infrastructure, after each finished stage (the owner tests with: ./plyr dev-docker --ref pr-76 --dev). Never push local/session-archive or any other branch.
  3. Small reviewable commits. The sandbox resets often: commit and run ProjectBackup after every step and give the owner the backup link in your message. Never put backup links in tracked files.
  4. Tests run on Linux/Docker only. Windows is out of scope; list Windows items as a manual checklist at the end, marked NOT RUN.
  5. No second launcher, no CI changes, browser tests stay out of CI.
  6. Speak to the owner in Persian; code, comments, commit messages and file names in English.
- Do NOT touch: Task View, Authorization Code, PUBLIC_DOMAIN, node/extension pairing, node logic (phase 2), and internal identifiers (RealChrome, realchrome, /browser/real/*). Do not rename them.
- Use the project's existing translation mechanism for every UI string (add English; add Persian if the project has a fa locale).

====================================================================
1. OWNER DECISIONS (these override older text anywhere in the repo or handoffs)
====================================================================
1.1 One section only. "Local Browser" is removed completely (UI, strings, CSS, translation keys, dead code). Everything lives under "Browser Profiles". "Turn on", "Turn off" and the "Chromium Session Closed" dialog are removed from the UI (keep backend route POST /profiles/turn-off and its tests). Opening an already-running profile shows it in a new tab; opening a stopped one launches it.
1.2 The model is fixed: Branch = one Chromium user-data root; Profile = a folder inside it selected only with --profile-directory. Aria identities stay separate: profile id prf_<hex>, branch id branch-NNN (never reused), folder profile-NNN, display name. The UI shows ONLY display names, never branch-NNN or profile-NNN.
1.3 There is no "legacy" or "old vs new" concept for the user. Nothing is hidden. The backend must be clean (see 2.1).
1.4 "Add an existing folder (outside Aria)" is removed completely: UI, route, prompt(), tests, strings. The owner does not need it.
1.5 A new branch has NO automatic "Default" profile. It contains only the profiles the user creates. Verify with a real Chromium whether Chromium creates a stray "Default" folder inside a fresh root even when --profile-directory is passed. If it does, it must never appear as a profile and must be handled and reported.
1.6 Concurrency: automated runs (Playwright) can use only ONE profile per branch at a time; different branches run in parallel. Manual opening of several profiles in one branch is wanted. VERIFY with real Chromium on Linux whether a second profile can be opened by hand in the same branch without breaking the first profile's Playwright session. If yes: allow it, with the warning in 4.2. If not possible: do not ship a broken behavior; keep Play but show a plain explanatory dialog with an OK button only, and tell the owner in the report.
1.7 Names: display names only, max 24 characters. Details in 3.1.
1.8 Launch settings are per profile, chosen from a catalog (no free-text flags). Details in section 5.
1.9 Profile lock: a profile can be locked to ONE workflow; no other workflow may use it. Details in section 6.
1.10 Navigation is a 3-level drill-down (A -> B -> C) with Back/Next history, no inline expansion, no long scrolling lists of everything.

====================================================================
2. BUGS AND CLEANUPS TO FIX (find the root cause with evidence; do not patch symptoms)
====================================================================
2.1 branch-001 is not shown and numbering is off. In the owner's test the list showed branch-002 as "Default" and a new branch got branch-003, while branch-001 exists but is hidden. Suspected cause: the old Local Browser root (realchrome) is adopted as a "legacy" branch and filtered out of the UI. Verify. Required end state (invariant): the registry, the list the UI shows, and the folders on disk under BRANCH_BASE_DIR describe exactly the same set of branches. On startup, an unlisted root is handled like this: if it holds no user data, remove it; if it holds data, list it as a normal branch (display name derived from its content or "Branch N") and never destroy data silently. If you remove the legacy adoption machinery, say exactly what you removed. Never reuse a branch id.
2.2 The viewer tab stays black after the last browser is closed (the owner closes the browsers from inside the tab assigned to them and the tab does not close). Reproduce in real Chromium in Docker. Find the real cause: was the tab opened by script (window.open) or by a plain link (not script-closable)? Is /browser/sessions still reporting a live session? Is the self-close logic even running? Is the VNC canvas simply showing black after disconnect? Fix so that when the LAST browser of the viewer's session set closes, the tab closes itself. Keep the safety rule from S27: self-close depends only on /browser/sessions reporting zero live sessions for this viewer, confirmed by at least two consecutive checks about 2 seconds apart; one failed probe, or a probe on another route, never closes the tab. If the browser refuses window.close(), do not leave a black page and do not bring back a dialog: navigate the tab to the app's main page. Report which case applies.
2.3 New profile creation has failed in every test so far (owner screenshots, "this system has problems"). Test end to end in real Chromium: create a profile in a NEW branch, create one in an EXISTING branch, first open, close, reopen, rename, delete, restart the server and check everything persists. A failed creation or launch must leave the profile in place with a plain error line and a retry (Play again).
2.4 "Turn on" without a selection used to fail: obsolete, but confirm no code path or test still depends on it.
2.5 Duplicate Default folders: the owner saw chrome-profile.Default Profile and prf_...Default Profile. From a clean container, verify no duplicate or stray profile folder appears after create/open/close/reopen. Report what Chromium creates.
2.6 Local Browser's "show the browser in a new tab" capability must survive, now only through Browser Profiles (link icon). Verify with the browser that used to be realchrome.
2.7 Task View card titles: the wmctrl parser prepends the container hostname to titles, so two cards get the same id. Do NOT fix (Task View is separate). Record it as a known bug in the report and in the handoff.
2.8 Test reporting: report skipped and failed separately. "9 skipped" is not "9 failed". Every test is marked RUN, NOT RUN or FAILED, with the command and the real output.
2.9 Optional one-liner: the pipeline-browser-options test should read the context by profile id. Do it if trivial.
2.10 After pushing, update the PR #76 body (remove stale statements, e.g. anything still describing the Local Browser row or Add-existing-folder) and write the handoff file. No backup links in tracked files.
2.11 The owner keeps finding bugs he does not remember in advance. If you find any other defect while working, list it in the report under "Found additionally" with evidence; fix it if it is inside this scope, otherwise leave it.

====================================================================
3. DATA RULES
====================================================================
3.1 Names
- Trim; collapse runs of spaces; reject empty. Maximum 24 characters (maxlength on the input AND enforced on the server). Show a counter like "21/24" in muted text only from 20 characters on. Unicode and Persian are allowed. No file-system character limits are needed because folders use ids.
- Branch display names are unique across the user, case-insensitive. Profile display names are unique inside their branch, case-insensitive. Error shown as a plain line under the input, e.g. "A profile named X already exists in this branch".
- Existing data that already violates this (duplicates, longer than 24) must still load; enforce the rules only on create and rename, and never rename existing data silently.
- Renaming never breaks references (ids are stable). Renaming a running profile is allowed.
- Long names never wrap: one line, ellipsis, full name in a tooltip, and in the rename input. The icons at the right never move or shrink because of a long name. The same truncation applies to the header title of Screens B and C.
3.2 Concepts that must stay distinct (document them in code and PR): per-branch run lease, scheduled reservation, operator hold, grant, and the NEW workflow lock (section 6). The workflow lock is persistent and explicit; do not overload the others.
3.3 The server is the authority for every rule (names, locks, flags, conflicts). The UI mirrors the rules for convenience only. Every API rejects invalid input with a clear machine-readable reason. Two browser tabs editing the same data: the server wins; the UI refreshes on conflict.

====================================================================
4. UI SPECIFICATION (match the reference image)
====================================================================
Dark theme. Colors: bg #0f1117-#171a23, borders #242836, text #e4e6eb, muted #8b8f9c, accent orange #f3862a (tab underline only), emerald green #22c55e-#2ecc71 (outline only). No other accent colors: no red/amber chips, no badges, no status dots. Plain error text may be a muted red line only. All icons: same outline style, same thin stroke, same size; play-triangle and stop-square are the only solid shapes. Reuse the same icon for the same action everywhere. Check at 100% zoom and at 360 px wide.

4.1 Shared top: tabs "Workflow Files" | "Browser Profiles" (globe icon before the text of the second), X close at the far right, orange underline on the active tab. The tabs are separate; navigating inside Browser Profiles never touches the outer tabs. The Workflow Files tab keeps its own content unchanged.
4.2 Header rows and navigation
- Screen A (Branch List): title "Branches"; NO arrow buttons at all; "+" at the far right (tooltip "New branch").
- Screen B (Profile List): Back "<" and Next ">" then the branch name; "+" at the far right (tooltip "New profile").
- Screen C (Launch Settings): ONLY Back "<", then the profile name; no Next, no "+".
- Next is enabled only after the user pressed Back, and only until they navigate somewhere else (browser-history behavior). Back/Next are the only navigation besides row clicks.
- The drawer opens at Screen A.
4.3 THE CORE ICON RULE (Screens A and B): an icon that is not useful in the current state does NOT EXIST in that row. Never render it dimmed, greyed, disabled or as a placeholder gap. Always-useful icons sit at the right edge and never move; state icons sit to their left; the group is right-aligned. Toggle icons share one slot and only change shape.
- Desktop: row icons appear on hover and on keyboard focus-within; on touch (hover:none) they are always visible. EXCEPTION: the closed padlock is a state and is always visible, even without hover.
- Every icon has a tooltip and an aria-label. Visible keyboard focus. Reduced motion respected.
- Width <= 400 px: the row's icon group collapses into one trailing "⋮" opening a plain bordered menu (icon + text rows).
4.4 Screen A rows (one per branch)
- Name at left (truncated), then icons. A thin 1.5-2px emerald outline around the WHOLE row exactly when at least one browser is open in that branch; otherwise a plain neutral border. Outline appears and disappears live when browsers open or close.
- Icons, left to right: [close all browsers in this branch (browser-window-with-x): ONLY when the branch has an open browser] [pencil: rename] [trash: delete branch] [">" chevron: enter]. Clicking the row also enters.
- "+" opens a small popover with a "Branch name" input and check/cancel icons; it creates an EMPTY branch.
- Empty state: centered muted "+" icon and "No branches yet".
- Delete branch: opens an inset panel under the row (flat, no card). Dependency scan first: blocked while any active, scheduled or running workflow references any profile in it, or any profile in it is locked (section 6). Blocked state lists the workflow names with a "Reassign to…" dropdown per item and the line "Resolve all dependencies to continue." Unblocked state shows the stats line, the red line "This permanently deletes all profile data in this branch.", and a 56px hold-to-delete ring (pointer, Enter, Space) that fills over 3 seconds; 2.5 seconds does nothing; releasing resets. At the end of the hold re-run the dependency scan on the server; if anything changed, cancel and show the blocking panel. Inactive workflows that referenced the branch become "profile missing". No recycle bin. Closing browsers is NOT part of delete; if any browser is open the branch is blocked with the reason.
4.5 Screen B rows (one per profile of the entered branch)
- Same outline rule: emerald outline around the row exactly when THAT profile's browser is open.
- Pencil and gear are the last two icons; the padlock is third from the right; at identical x-positions on all rows. Left of the padlock, the state icons:
  - Browser OPEN: [external-link icon: show this browser in a new tab (focus the existing viewer tab if one is already open; never create a duplicate session)] [stop-square: close browser] [padlock] [pencil] [gear]
  - Browser CLOSED: [play-triangle: open] [padlock] [pencil] [gear]
  - Padlock: open padlock = not locked; closed padlock = locked to one workflow. Same size and position; clearly different at a glance.
  - NO restore/history icon exists anywhere (see 5.8).
- Last icon after the gear: a trash icon (delete profile). NOTE: this icon is an owner-pending addition not shown in the reference image; implement it, keep it easy to remove. Delete profile follows the same blocking rules as 4.4 (blocked while the profile is locked, running, or referenced by an active/scheduled workflow; names listed; hold 3 seconds; server rescan at the end).
- Play: the icon becomes a small spinner while the browser starts; a double click must not launch twice (use the existing starting map). If the launch fails, show a plain one-line reason under the row and keep Play. If another browser is already open in this branch and 1.6 allows manual opening, clicking Play first shows a small inset prompt: title "Another browser is open in this branch", text "<Name> is already open here. Automated runs can use only one browser per branch, so open this one for manual use only.", buttons Cancel and Open anyway. Otherwise follow 1.6.
- Stop: closes the browser. If a workflow run or another viewer depends on it (BrowserSessions.canClose), do not close; show the reason with the workflow name. Never let a non-owner close a shared browser.
- Browser dies outside Aria (crash or closed externally): the row returns to the closed state within about 5 seconds without a page reload (reuse the existing status channel or polling; no stale green outline).
- Inline rename (pencil): the name becomes a bordered input with check/cancel icons; Enter saves, Esc cancels; rules from 3.1.
- Empty state: centered muted "+" and "No profiles yet".
- "+" opens a popover: first row "New branch" (folder-plus icon) with a 1px divider below it; then one line per existing branch "Name — N profiles" (folder icon); the selected line has a thin 2px orange left border; the current branch is preselected; below, a bordered "Profile name" input; bottom right check (create) and cancel icons. Choosing "New branch" creates a new branch (system picks a unique name like "Branch N", renameable later) with the new profile inside. Choosing an existing branch adds the profile to it.
4.6 Screen C (full page)
- Header: Back and the profile name. Below: muted "Launch settings". Details and behavior in section 5.
4.7 Loading, error and offline states for every screen: a muted loading line, an inline error line with a Retry icon; never a blank screen, never a native alert/confirm/prompt.
4.8 The branch outline on Screen A and the profile outline on Screen B are derived from real session state, not stored.

====================================================================
5. LAUNCH SETTINGS (Screen C) AND THE FLAG CATALOG
====================================================================
5.1 Layout (top to bottom): a radio-style row "Default" with muted "Standard launch settings"; a search field "Search flags"; the flag list; one check (save) icon at the bottom right (no undo).
5.2 The Default radio is a two-state switch. ON: the profile launches with standard settings and the flag list and search are hidden. OFF: the list is shown. Saving with Default ON clears every customization of that profile. A profile is therefore either Default or Custom.
5.3 Flag rows: friendly label at the left, technical flag name small and muted at the right on the same line. Clicking a row selects/deselects it: selected = thin emerald outline around the row (no checkbox, no word "SELECTED"). A selected row whose flag takes a value expands in place to show its input; clicks inside the input must not toggle the row. Flags without a value (for example Mute audio) do not expand. Keyboard: Enter/Space toggles, role checkbox with aria-checked. Each row has a tooltip with a one-line plain description.
5.4 Search filters by label, flag name and description. Selected rows are never hidden by an empty search result message.
5.5 Input types: no value = just the row; true/false = two radio options "On"/"Off" on one line; fixed choices = a dropdown whose options have plain descriptions; number = numeric input with min, max, step and a unit; several numbers = labeled inputs side by side; text = bordered input with a muted example and a length limit. The user must never have to know a flag's syntax or valid values.
5.6 Catalog. Build ONE data structure (a single source of truth) that holds, for every flag: id, friendly label, description, chromium flag name, input type, allowed values or range, default, conflictsWith, and how it becomes argv. The UI, the validation, and the launch argv builder all read from it. Adding a flag later must mean adding one entry. Initial entries (VERIFY every one against the pinned Chromium version and in headed and headless mode; drop any that does not work and tell the owner):
  - Window size: --window-size=W,H; two integers (W 320-7680, H 240-4320); default 1280x800. Conflicts with Start maximized. Check how it interacts with Playwright's viewport/RunPolicy for the persistent context (viewport null, headed vs hidden) and avoid contradicting existing launch options.
  - Start maximized: --start-maximized; no value; conflicts with Window size.
  - Window position: --window-position=X,Y; two integers.
  - Load images: On = no flag; Off = --blink-settings=imagesEnabled=false. If several settings use --blink-settings, merge them into ONE comma-separated flag.
  - Autoplay policy: --autoplay-policy=<v>; options "Allow without click" (no-user-gesture-required), "Require a click" (user-gesture-required), "Require a click on each page" (document-user-activation-required).
  - Mute audio: --mute-audio.
  - Restore last tabs: --restore-last-session; no value (see 5.8).
  - Device scale: --force-device-scale-factor=N; number 0.5-3, step 0.25.
  - User agent: --user-agent=<text>; one line, max 300 chars. Check conflicts with a workflow-level user agent option.
  - Language: --lang=<locale>; dropdown of common locales (en-US, fa-IR, de-DE, fr-FR, es-ES, tr-TR, ar-SA, ru-RU, zh-CN, ja-JP).
  - Disable GPU: --disable-gpu; no value.
  - Block notifications: --disable-notifications; no value.
  - Force dark mode: --force-dark-mode; no value.
  - Proxy server: --proxy-server=<value>; text (host:port or scheme://host:port), validated; credentials are not allowed in it; never write the value to logs (log only that a proxy is set).
5.7 Never offered, and rejected by the server even if sent directly: --user-data-dir, --profile-directory, --remote-debugging-*, --headless*, --no-sandbox (the system decides it from the environment), --disable-web-security, --ignore-certificate-errors, --incognito, --single-process, extension flags (--load-extension, --disable-extensions, --disable-extensions-except; the Element Inspector extension must keep working). The API accepts only catalog ids with typed values, never a raw flag string. Build argv as an array; never concatenate a shell string. Reject newlines and control characters in text values.
5.8 "Restore tabs": the old row icon is removed. It was incomplete (the checklist said tab snapshots were never done; only the persistent user-data-dir exists). The capability is now the flag "Restore last tabs". Verify what actually happens with Playwright's persistent context and report; if the flag does not work with the pinned Chromium or Playwright, remove it from the catalog and tell the owner.
5.9 Saving: the check icon exists only when there are unsaved changes and every value is valid. Invalid or empty required values block saving and show a plain muted message next to that field. Conflicts: selecting one flag of a conflicting pair deselects the other and shows a one-line muted note why. Back with unsaved changes shows a small inline "Discard changes?" prompt (Discard / Keep editing).
5.10 Settings are stored per profile id (not per name), survive rename and restart, and are deleted with the profile. They apply on the NEXT launch. If the browser is open, show the muted line "Applies the next time this browser opens". A flag in storage that is no longer in the catalog is skipped at launch with a logged warning and shown on Screen C as a muted "No longer supported" row; never crash.
5.11 ONE launch path builds the argv for manual opens and automated runs. Unit-test the builder: defaults, each flag, conflicts, merged --blink-settings, ordering, dedupe, forbidden flags.

====================================================================
6. PROFILE LOCK (the padlock)
====================================================================
6.1 Meaning: a closed padlock means this profile is locked to exactly ONE workflow; no other workflow can use it. An open padlock means unlocked. It is a toggle in the same slot on every profile row. Branches have no padlock. A workflow may own several locked profiles; a profile has at most one owner.
6.2 Locking: clicking an open padlock opens a small popover listing the user's workflows (single choice) with check/cancel icons. The server performs the lock atomically (two simultaneous lock requests: one wins, the other gets a clear error; test it). Locking is blocked while OTHER active or scheduled workflows reference that profile: list them by name with a "Reassign to…" dropdown, like branch deletion. Inactive workflows that reference it are allowed to exist but fail validation at activation time with "profile locked to <workflow>".
6.3 Unlocking: clicking a closed padlock unlocks. If the owner workflow is running, block with the workflow name ("stop it first"). If it is active or scheduled, ask for a plain confirmation naming it. After unlocking, the owner workflow's own reference stays valid; only the exclusivity ends.
6.4 Tooltips: closed = "Locked to <workflow name>" (the real name, kept current after renames because the lock stores the workflow id); open = "Lock to a workflow".
6.5 Enforcement is on the server for every path, not only in the UI: workflow profile pickers show a locked profile disabled with the reason "Locked to X" (selectable only by its owner); the API rejects other workflows; scheduling, activation, import and duplication all re-check.
6.6 Lifecycle rules (each one needs a test):
  - Workflow DELETED (by any path: UI, API, bulk delete, account deletion, import-overwrite, reset) -> its locks are released in the same transaction. If the workflow is running, the existing deletion rules apply first.
  - Workflow renamed -> lock follows the id.
  - Workflow disabled or deactivated -> lock stays.
  - Workflow duplicated, exported or imported -> the copy does NOT inherit locks; an imported workflow pointing at a profile locked to another workflow fails activation with a clear reason.
  - Owner workflow changes its own profile to another one -> the old lock stays until the user unlocks it (explicit action); the tooltip keeps telling the truth.
  - Profile deleted -> blocked while locked (names the owner); unlock first.
  - Branch deleted -> blocked while any of its profiles is locked.
  - Boot-time sweep: locks that point to a missing workflow or a missing profile are removed and logged; a missing folder marks the profile "profile missing"; never crash.
  - Server restart -> locks persist. All locks are per user.
  - Manual open of a locked profile: allowed unless the owner workflow is running or inside its reservation window; then block with the reason (reuse the existing reserved-profile rule). Verify the current behavior and report.
  - Log lock, unlock and automatic release events (workflow name, profile display name, reason; no sensitive data).
6.7 Fit with the existing infrastructure: map the new lock onto the existing lease/reservation/hold/grant code. Keep them distinct, state clearly in the report how they interact, and if you think the lock and the scheduled reservation should be merged, do not merge them silently: explain and ask the owner.

====================================================================
7. BROWSER LIFECYCLE RULES (keep, and verify they still hold)
====================================================================
- Closing a viewer tab never releases a reservation; it only detaches the viewer's dependency.
- Closing a browser is not the same as releasing a reservation, and vice versa.
- A shared browser cannot be closed by a non-owner; the Close Browser node only detaches.
- Idle close uses BROWSER_IDLE_CLOSE_MIN as before; Wait is not idle.
- After the last browser of a branch closes: its emerald outline and its "close all" icon disappear.
- "Close all browsers in this branch" closes only that branch's browsers, honoring the dependency rule per browser, and reports which ones stayed open and why.

====================================================================
8. TESTS (mark every one RUN, NOT RUN or FAILED, with the command and real output)
====================================================================
- Unit: name rules (trim, spaces, 24 chars, unique case-insensitive, Persian), argv builder, catalog validation (ranges, enums, conflicts, forbidden flags, newline injection), lock rules (every item in 6.6), dependency scan for branch and profile deletion, id never reused, registry == disk invariant.
- API: every route rejects invalid input with a clear reason; lock race; delete blockers; settings save and clear.
- UI (jsdom or browser): the rendered DOM contains none of: "Local Browser", "Turn on", "Turn off", "Chromium Session Closed", "Add an existing folder"; the absent-icon rule (no disabled or dimmed icons exist in the DOM); icon sets per state (open, closed, locked, branch with and without a browser); closed padlock visible without hover; long names truncate and icons keep their x-positions; Back/Next rules on A, B and C; Screen C selection, expansion, dirty-state save, discard prompt, conflict handling, search; 360 px kebab menu; keyboard operation; no native alert/confirm/prompt.
- Real Chromium on Linux/Docker: create profile in a new and in an existing branch; open, show, close, reopen; two branches in parallel; manual second profile in one branch (1.6); external close updates the UI within about 5 seconds; last browser closes and the viewer tab closes (2.2) in the cases: opened by script, opened by the user, one failed probe, two browsers with one closing; launch flags actually take effect (window size, images off, mute, language, user agent); no stray Default folder (2.5); restart persistence of branches, profiles, settings and locks.
- Fresh-start run: start from a clean Docker (no old data) with ./plyr dev-docker --ref pr-76 --dev and walk the whole flow.
- Manual Windows checklist at the end, marked NOT RUN.

====================================================================
9. WORK ORDER (commit and back up after each step; push after each stage)
====================================================================
Stage 1 - Audit and backend clean: section 0, 2.1, 2.2 root cause, 2.3, 2.5, 2.6, 1.4 and 1.1 removals, 1.6 feasibility test. Report findings before building on them.
Stage 2 - Data and API: names (3.1), lock (section 6) with lifecycle hooks, flag catalog and launch settings (section 5) with the single argv builder.
Stage 3 - UI: the 3 screens (section 4), all states, 360 px, accessibility.
Stage 4 - Tests (section 8), fresh-start run, PR body update, handoff file, final report.

====================================================================
10. REPORT (write it to the owner in Persian; code, comments, commits, file names in English)
====================================================================
1. Real HEAD and anything in this prompt that did not match the code.
2. For each bug in section 2: root cause with evidence, the fix, and the commit.
3. The answer to 1.6 (can a second profile run by hand in one branch?) and to 1.5 (does Chromium create a stray Default folder?).
4. How the viewer tab closes in each case (2.2).
5. The flag catalog as shipped: which flags were verified, which were dropped, and why.
6. How the workflow lock maps onto the lease/reservation/hold/grant code, and every lifecycle rule from 6.6 with the test that proves it.
7. Test results: RUN / NOT RUN / FAILED, skipped and failed counted separately.
8. Layout check at 100% and 360 px.
9. Known bugs recorded but not fixed (Task View titles) and anything found additionally.
10. Decisions needed from the owner (profile delete icon, lock vs reservation merge, anything unclear), the PR #76 body update status, and the backup link.