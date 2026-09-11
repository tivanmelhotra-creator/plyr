/**
 * ChromeView — the page that shows the REAL Chromium and nothing else.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator asked, twice and unambiguously, for the real browser in a new
 * tab and for none of the VNC furniture around it:
 *
 *   «نمیخام به گزینه های مثل vnc یا novnc روبرو بشم میخام مستقیم برام کرومیوم
 *    رو بالا بیاره توی یک تب جدید»
 *
 * We were sending them to noVNC's own `vnc.html`. MEASURED on the installed
 * client (`curl /desktop/vnc.html | grep -o 'id="noVNC_[^"]*"' | sort -u`):
 * 64 distinct `noVNC_*` element ids — a connect dialog with its own Connect
 * button, a control bar, a credentials dialog, and settings / clipboard /
 * fullscreen / power panels. So the user was handed a VNC client to operate
 * before they could see a browser. `vnc_lite.html` is not the answer either: it
 * is down to 4 ids, but still paints a status bar and a Send-CtrlAltDel button.
 *
 * The RFB protocol implementation, though, is not the problem — it is correct
 * and it is already installed. So this page uses noVNC's `core/rfb.js` as a
 * TRANSPORT LIBRARY and supplies its own (empty) chrome: a full-viewport screen
 * element and a status overlay that removes itself the moment pixels arrive.
 *
 * MEASURED on the served page: 0 `noVNC_*` elements, and in a real browser the
 * canvas comes up 1600x900 with 30 distinct colours sampled (i.e. actual
 * Chromium pixels, not a blank surface) and the overlay hides itself.
 *
 * WHAT THE OPERATOR SEES
 * ----------------------
 * A spinner for as long as the connection takes, then Chromium filling the tab,
 * with mouse and keyboard live. On failure they get a sentence and a "Try
 * again" button — never a protocol console.
 *
 * AUTH
 * ----
 * This page does NOT thread `?api_key=` through the assets it loads. It cannot:
 * MEASURED that a query string on an `import()` specifier is not inherited by
 * that module's own relative imports (see DesktopSession.ts for the numbers),
 * and rfb.js pulls in 42 files. Instead the server sets a signed, HttpOnly
 * session cookie when it serves this page, and the browser attaches it to every
 * subresource and to the WebSocket handshake automatically. That is why there
 * is no credential juggling in the script below.
 *
 * IMPLEMENTATION NOTE
 * -------------------
 * The body is one template literal, so a stray backtick anywhere in it — even
 * inside a comment — terminates the string and breaks the build. Comments in
 * here therefore quote code with 'single quotes'.
 */

/**
 * The bare Chromium viewer page.
 *
 * Deliberately self-contained (no separate CSS/JS asset of ours to serve or
 * cache-bust) because the ONLY thing this page must do is come up fast and
 * connect; every extra request is another thing that can 401 or 404.
 */
export function chromeViewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>Chromium</title>
<!-- An inline empty icon. Without it the browser requests /favicon.ico on its
     own, which is not a desktop path, so it 404s and puts a red error in the
     console of a page whose whole purpose is to look like it is working.
     MEASURED: with this line, a full load reports FAILED_RESOURCES=[]. -->
<link rel="icon" href="data:,">
<style>
  html, body {
    margin: 0; padding: 0; height: 100%; width: 100%;
    overflow: hidden; background: #1b1b1f;
    /* The remote screen owns the pointer; a stray text selection while
       dragging inside a page would fight with the mouse events we forward. */
    -webkit-user-select: none; user-select: none;
  }
  /* The screen is the whole page. noVNC's Display appends its canvas here and
     sizes it itself, so this element must not impose a layout of its own. */
  #screen { position: fixed; inset: 0; width: 100%; height: 100%; }
  #note {
    position: fixed; inset: 0; display: flex;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: #1b1b1f; color: #d8d8de;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    text-align: center; padding: 24px;
  }
  #note[hidden] { display: none; }
  .spin {
    width: 26px; height: 26px; border-radius: 50%;
    border: 2px solid #3a3a42; border-top-color: #6da2ff;
    animation: spin .8s linear infinite;
  }
  .spin[hidden] { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #msg { max-width: 30rem; }
  #retry {
    font: inherit; color: #eaeaf0; background: #33333c;
    border: 1px solid #4a4a55; border-radius: 6px;
    padding: 7px 16px; cursor: pointer;
  }
  #retry:hover { background: #3d3d47; }
  #retry[hidden] { display: none; }
  /* ── The one-click fix ─────────────────────────────────────────────────
     Visually the PRIMARY action whenever it appears, because when it appears
     it is the only thing that will help: "Try again" against a browser that
     is switched off by configuration just reproduces the same failure, which
     is what the reporter experienced. Blue rather than grey so the eye goes
     to the button that changes something. */
  #fixbtn {
    font: inherit; color: #fff; background: #3d6ae0;
    border: 1px solid #4d7af0; border-radius: 6px;
    padding: 7px 16px; cursor: pointer; margin-right: 8px;
  }
  #fixbtn:hover { background: #4d7af0; }
  #fixbtn:disabled { opacity: .6; cursor: default; }
  #fixbtn[hidden] { display: none; }

  /* ── THE THREE BUTTONS ARE GONE ────────────────────────────────────────
     What used to be welded to the bottom-right corner of this page was:

         [ + Add File ]  [ ↑ Send a file ]  [ Files (3) ]

     Three standing controls, on screen whether or not anyone wanted a file,
     and each of them a guess: "Files" sounded like a file manager but only
     listed downloads; "Send a file" did not send anything anywhere, it PARKED
     a file for a page to ask for later; "Add File" opened a menu that did
     both. The operator's report was the obvious consequence — «قسمت آپلود و
     فایل ها هم اصلا خوب نیست ui/ux خوبی نداره».

     What is here now is ONE hamburger. Everything else lives inside the
     drawer it opens, which is an OVERLAY: while it is shut it occupies
     nothing at all, and this page is a browser again rather than a browser
     with a panel bolted on. */
  #burger {
    position: fixed; top: 12px; right: 12px; z-index: 7;
    font: inherit; color: #e6e6ee; background: rgba(24,26,33,.92);
    border: 1px solid #4a4a55; border-radius: 8px;
    width: 34px; height: 34px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    backdrop-filter: blur(3px);
    box-shadow: 0 4px 16px rgba(0,0,0,.4);
  }
  #burger:hover { color: #f0862f; border-color: rgba(240,134,47,.5); }
  #burger:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 1px; }
  /* Out of the way while the drawer is up: the drawer has its own Close, and
     two dismissals in the same corner is one too many. */
  #burger[hidden] { display: none; }

  /* ── The drawer ────────────────────────────────────────────────────────
     Docked to the right edge, full height, an overlay. This is the same
     Workflow Files workspace the canvas views get from
     public/js/workflow-files.js — reimplemented here because this page is a
     standalone document served by the server and cannot load app scripts.
     The two speak the same HTTP API and look the same on purpose.

     Reference for the layout and the interaction: upload-ui/. */
  #files {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 6;
    width: min(23rem, 100%);
    font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e6e6ee; display: flex; flex-direction: column;
    background: rgba(23,25,32,.98);
    border-left: 1px solid #43434e;
    box-shadow: -8px 0 30px rgba(0,0,0,.5);
    backdrop-filter: blur(6px);
    overflow: hidden;
  }
  #files[hidden] { display: none; }

  /* head: what this is, how much is in it, and the way out */
  .dhead {
    display: flex; align-items: center; gap: 7px;
    padding: 9px 10px; border-bottom: 1px solid #38383f; flex: none;
  }
  .dbadge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 6px; flex: none;
    color: #f0862f; background: rgba(232,115,26,.12);
    border: 1px solid rgba(232,115,26,.28);
  }
  .dhead h4 { margin: 0; font-size: 12.5px; font-weight: 600; color: #fff; flex: none; }
  /* "16 items" — the answer to "is there anything in here?" without scrolling. */
  #dtotal {
    flex: none; font-size: 10.5px; color: #9aa0ad;
    background: #1d2029; border: 1px solid #333846;
    border-radius: 999px; padding: 1px 7px;
  }
  .dgrow { flex: 1 1 auto; min-width: 0; }
  /* Offered ONLY when the page's input is 'multiple'; "Select All" against a
     single-file input is a promise this cannot keep. */
  #dall {
    font: inherit; font-size: 11px; display: inline-flex; align-items: center;
    gap: 4px; flex: none; color: #9aa0ad; background: none;
    border: 1px solid transparent; border-radius: 5px;
    padding: 2px 5px; cursor: pointer;
  }
  #dall:hover { color: #fff; border-color: #4a4a55; }
  #dall[hidden] { display: none; }
  #dall svg { color: #f0862f; }

  /* toolbar: the five actions from the reference UI, icon-only */
  .dbar {
    display: flex; align-items: center; justify-content: space-around;
    gap: 4px; margin: 9px 10px 4px; padding: 4px; flex: none;
    background: #16181f; border: 1px solid #2b303b; border-radius: 8px;
  }
  .dtool {
    font: inherit; display: inline-flex; align-items: center;
    justify-content: center; width: 30px; height: 30px;
    color: #9aa0ad; background: transparent;
    border: 1px solid transparent; border-radius: 6px; cursor: pointer;
  }
  .dtool:hover { color: #f0862f; background: #1e222c; border-color: rgba(240,134,47,.35); }
  .dtool:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 1px; }
  /* Close belongs to the head, not the toolbar, so it keeps its own weight. */
  #dclose { width: 24px; height: 24px; flex: none; }
  #dclose:hover { color: #fff; background: none; border-color: #4a4a55; }

  /* breadcrumb: where in the workspace the tree is rooted right now. The
     first crumb is the workspace itself; every other one is a folder the
     operator opened. Pressing any crumb goes back there. */
  .dcrumbs {
    display: flex; align-items: center; flex-wrap: wrap; gap: 2px; flex: none;
    padding: 2px 10px 0; font-size: 11px; color: #9aa0ad; direction: ltr;
  }
  .dcrumb {
    font: inherit; font-size: 11px; color: #9aa0ad; background: none; border: 0;
    padding: 2px 4px; border-radius: 4px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 3px;
  }
  .dcrumb:hover { color: #fff; background: #1e222c; }
  .dcrumb.on { color: #fff; cursor: default; }
  .dcrumb-sep { color: #4a4f5c; }
  .dback { color: #f0862f; padding: 2px 3px; }
  .dback svg { width: 13px; height: 13px; }
  /* System folders: part of the workflow, drawn apart from the operator's own. */
  #wfmlist li.wfm-sys .wfm-ico { color: #7aa2ff; }
  .wfm-sys-tag {
    flex: none; font-size: 9.5px; letter-spacing: .03em; text-transform: uppercase;
    color: #7aa2ff; border: 1px solid rgba(122,162,255,.4); border-radius: 3px;
    padding: 0 4px; line-height: 1.4;
  }

  /* the tree */
  #wfmlist {
    list-style: none; margin: 0; padding: 2px 7px 8px;
    overflow-y: auto; flex: 1 1 auto; min-height: 5rem;
  }
  #wfmlist li {
    display: flex; align-items: center; gap: 6px;
    /* Depth is an INDENT, not a nested list: a flat list is what lets one
       querySelectorAll repaint the whole selection after every pick. */
    padding: 4px 5px; border-radius: 5px;
    border: 1px solid transparent;
  }
  #wfmlist li.wfm-dir, #wfmlist li.wfm-file { cursor: pointer; }
  #wfmlist li.wfm-dir:hover, #wfmlist li.wfm-file:hover { background: #1c1f27; }
  #wfmlist li.sel {
    background: linear-gradient(90deg, rgba(232,115,26,.16) 0%, #1c1f27 100%);
    border-color: rgba(232,115,26,.45);
  }
  #wfmlist li.wfm-hint, #wfmlist li.empty { color: #8b8b98; cursor: default; }
  .dchev {
    font: inherit; display: inline-flex; align-items: center;
    justify-content: center; width: 16px; height: 16px; flex: none;
    padding: 0; color: #6d7382; background: none; border: 0; cursor: pointer;
  }
  .dchev:hover { color: #fff; }
  /* The checkbox appears on hover or when the row is picked — invisible the
     rest of the time, so a tree of files does not read as a form. */
  .dcheck {
    flex: none; width: 13px; height: 13px; margin: 0;
    accent-color: #e8731a; opacity: 0; cursor: pointer;
  }
  #wfmlist li:hover .dcheck, #wfmlist li.sel .dcheck, .dcheck:focus-visible { opacity: 1; }
  .wfm-ico { flex: none; display: inline-flex; color: #f0862f; }
  /* A file name is machine-readable and always LTR. */
  .wfm-name {
    flex: 1 1 auto; min-width: 0; direction: ltr;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wfm-meta { color: #6d7382; flex: none; font-size: 10.5px; }
  /* Inline rename: the row's own name turns into a field, so the new name is
     chosen next to the siblings it has to be unique among. */
  .drename {
    flex: 1 1 auto; min-width: 0; font: inherit; direction: ltr;
    color: #fff; background: #101319; border: 1px solid #e8731a;
    border-radius: 4px; padding: 1px 4px;
  }
  /* Overflow actions, for a pointer with no right button. */
  .dmore {
    font: inherit; display: inline-flex; align-items: center;
    justify-content: center; width: 20px; height: 20px; flex: none;
    padding: 0; color: #6d7382; background: none; border: 0;
    border-radius: 4px; cursor: pointer; opacity: 0;
  }
  #wfmlist li:hover .dmore, #wfmlist li.sel .dmore { opacity: 1; }
  .dmore:hover { color: #fff; background: #22262f; }

  /* the context menu */
  #dmenu {
    position: fixed; z-index: 8; min-width: 11rem;
    display: flex; flex-direction: column; padding: 4px;
    background: rgba(26,28,36,.98); border: 1px solid #3a4050;
    border-radius: 8px; box-shadow: 0 8px 26px rgba(0,0,0,.5);
  }
  #dmenu[hidden] { display: none; }
  .dmi {
    font: inherit; font-size: 11.5px; display: flex; align-items: center;
    gap: 7px; text-align: left; color: #e6e6ee; background: none;
    border: 0; border-radius: 5px; padding: 5px 7px; cursor: pointer;
  }
  .dmi:hover { background: #262a35; }
  .dmi-ico { display: inline-flex; flex: none; color: #f0862f; }
  .dmi.danger { color: #ff9d9d; }
  .dmi.danger .dmi-ico { color: #ff9d9d; }
  .dmi.danger:hover { background: rgba(255,157,157,.12); }
  .dmi-sep { height: 1px; margin: 3px 2px; background: #333846; }

  /* notes, and the in-drawer confirmation */
  #wfmnote { color: #8b8b98; padding: 0 10px; min-height: 1.2em; flex: none; }
  #wfmnote.err { color: #ff9d9d; }
  /* NOT window.confirm: a native dialog on this page steals focus from the
     remote screen, and the page waiting for a file is BEHIND that screen. The
     question and the button that answers it are in the drawer, together. */
  #dconfirm {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    margin: 5px 10px; padding: 7px 8px; flex: none;
    background: rgba(255,157,157,.1); border: 1px solid rgba(255,157,157,.4);
    border-radius: 6px;
  }
  #dconfirm[hidden] { display: none; }
  .dconfirm-text { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; }
  #dconfirm .fbtn { margin-left: auto; padding: 3px 9px; }
  .dyes { background: #b3423f; border-color: #c85450; color: #fff; }
  .dyes:hover { background: #c85450; }

  /* foot: what is picked, and the two things to do with it */
  .dfoot {
    display: flex; align-items: center; gap: 6px;
    padding: 9px 10px; border-top: 1px solid #38383f; flex: none;
  }
  #dcount { flex: none; color: #9aa0ad; }
  #dclear {
    font: inherit; font-size: 11px; flex: none; color: #9aa0ad;
    background: none; border: 0; padding: 0; cursor: pointer;
    text-decoration: underline; text-underline-offset: 2px;
  }
  #dclear:hover { color: #fff; }
  #dclear[hidden] { display: none; }
  .fbtn {
    font: inherit; color: #e6e6ee; background: rgba(38,38,46,.92);
    border: 1px solid #4a4a55; border-radius: 6px;
    padding: 5px 10px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .fbtn:hover { background: rgba(58,58,68,.96); }
  .fbtn:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 1px; }
  .fbtn:disabled { opacity: .5; cursor: default; }
  /* The one accent colour on this page: the spec asks for a dark UI with a
     restrained orange accent, and the one accent is what tells the control
     that DELIVERS the file apart from everything that merely browses. */
  .fbtn.accent { background: #e8731a; border-color: #f0862f; color: #fff; }
  .fbtn.accent:hover { background: #f0862f; }
  /* Batch delete only makes sense once something is picked, and it must never
     sit at the same weight as Select — it destroys, Select delivers. */
  #ddelsel[hidden] { display: none; }
  #ddelsel:hover { color: #ff9d9d; border-color: #ff9d9d; }

  /* ── The panes ─────────────────────────────────────────────────────────
     The drawer is ONE surface and what it shows changes: the workflow's own
     files, the downloads shelf, or the two sources a waiting page can be
     answered from. They are pages of the drawer, never extra floating
     panels stacked on top of each other. */
  .dpane { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .dpane[hidden] { display: none; }
  /* ── Notices, inside the workspace ─────────────────────────────────────
     ONE workspace, no tabs. What the old "Activity" pane used to say -- a
     file is ready to send, a file was sent, a delivery failed -- is said
     HERE, above the note line, as short rows that the operator can dismiss.
     They are receipts, not a second file list: the files themselves are in
     uploads/ and downloads/ in the tree above. */
  #dnotices { list-style: none; margin: 0; padding: 0 10px; flex: none; max-height: 9rem; overflow-y: auto; }
  #dnotices[hidden] { display: none; }
  #dnotices li {
    display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
    padding: 5px 0; border-top: 1px solid #38383f;
  }
  #dnotices li:first-child { border-top: 0; }
  .empty { color: #8b8b98; }
  /* A failure has to be readable ON the row it belongs to: this page has no
     toast, and the operator's report was that a click did nothing at all. */
  .rowerr { color: #ff9d9d; }
  #dnotices .ntext { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  /* Dismiss a notice. Quiet until hovered; last in the row. */
  .del {
    font: inherit; color: #8b8b98; background: none; border: 0;
    padding: 0 2px; cursor: pointer; flex: none; line-height: 1; margin-left: auto;
  }
  .del:hover { color: #fff; }
  .uphint { color: #9fe0b0; }
  .uphint .sub { color: #8b8b98; padding-top: 2px; flex-basis: 100%; }

  /* ── The source chooser ────────────────────────────────────────────────
     THE ACTIVATION PROBLEM, AND WHY THIS IS A BUTTON AND NOT A TIMER.
     'upInput.click()' opens the operator's native picker only within a few
     seconds of a real gesture (MEASURED: works at 4900 ms, gone at 5500 ms).
     The page's request arrives by POLLING, so by the time offerFile() runs
     the remote click may already be too old. The fix is not a faster poll; it
     is a control the operator presses HERE, whose own click is the activation.

     So when a page asks for a file the drawer shows this: two sources, one
     press each. 'Upload from Computer' calls the picker inside that same
     click handler; 'Choose from Workflow Files' needs no picker at all and
     simply shows the tree — which is why choosing it does NOT ask the
     operator to press anything else first. */
  #dpick { padding: 10px; gap: 8px; }
  #dpick h5 { margin: 0 0 2px; font-size: 12px; font-weight: 600; color: #fff; }
  #dpick .fbtn { width: 100%; justify-content: flex-start; }
  #dpick .sub { color: #8b8b98; font-size: 11px; padding: 0 2px 4px; }
  #dpick .why { color: #9fe0b0; padding: 0 2px 6px; }
  #up, #wfmup { display: none; }
</style>
</head>
<body>
<div id="screen"></div>
<!-- THE ONE PERMANENT CONTROL. Everything else is in the drawer it opens. -->
<button id="burger" type="button" title="Workflow Files" aria-label="Workflow Files" hidden>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>
</button>
<div id="files" hidden>
  <div class="dhead">
    <span class="dbadge">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
    </span>
    <h4>Workflow Files</h4>
    <span id="dtotal"></span>
    <span class="dgrow"></span>
    <!-- Only when the page's input is 'multiple'; see wfmSyncSelection(). -->
    <button id="dall" type="button" hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span>Select All</span>
    </button>
    <button class="dtool" id="dclose" type="button" title="Close" aria-label="Close">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="m5 5 14 14"/><path d="m19 5-14 14"/></svg>
    </button>
  </div>

  <!-- ── THE workspace: the workflow's own files ────────────────────────
       ONE workspace, not tabs. uploads/ and downloads/ are folders IN it,
       and what used to be an "Activity" pane is a few notice rows below the
       tree. A real workspace, not a list: a tree with a chevron, an icon-only
       toolbar, a context menu on every row and on the empty space, inline
       rename, and a confirmation that does not steal the remote screen's
       focus. It talks to /browser/workflow-files/<workflowId>; every request
       names a workflow-RELATIVE path and this page never sees an absolute
       one. -->
  <div class="dpane" id="panefiles">
    <div class="dbar">
      <button class="dtool" id="wfmnew" type="button" title="New Folder" aria-label="New Folder">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v6"/><path d="M9 13.5h6"/></svg>
      </button>
      <button class="dtool" id="wfmnewfile" type="button" title="New File" aria-label="New File">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11.5v6"/><path d="M9 14.5h6"/></svg>
      </button>
      <button class="dtool" id="wfmupload" type="button" title="Upload File" aria-label="Upload File">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/><path d="M4 20.5h16"/></svg>
      </button>
      <button class="dtool" id="wfmrefresh" type="button" title="Refresh" aria-label="Refresh">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10h-5.5"/></svg>
      </button>
      <button class="dtool" id="wfmmore" type="button" title="Actions" aria-label="Actions">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>
      </button>
    </div>
    <div class="dcrumbs" id="dcrumbs"></div>
    <ul id="wfmlist"><li class="empty">Loading&hellip;</li></ul>
    <!-- Receipts: ready to send / sent to the site / a delivery failed. -->
    <ul id="dnotices" hidden></ul>
    <div id="wfmnote"></div>
    <div id="dconfirm" hidden></div>
    <div class="dfoot">
      <span id="dcount"></span>
      <button id="dclear" type="button" hidden>Clear</button>
      <span class="dgrow"></span>
      <button class="fbtn" id="ddelsel" type="button" hidden title="Delete the selected files">Delete</button>
      <button class="fbtn accent" id="wfmselect" type="button" disabled title="Hand the selected file to the page">Select</button>
    </div>
    <input id="wfmup" type="file" multiple>
  </div>

  <!-- ── The source chooser, shown INSTEAD of the tree while a page is asking ─
       Both buttons are the operator's OWN click, which is what makes the
       native picker openable no matter how old the remote click is by now
       — and the second source never needed a picker at all. -->
  <div class="dpane" id="dpick" hidden>
    <h5>The page is asking for a file</h5>
    <span class="sub" id="dpickaccept"></span>
    <button class="fbtn accent" id="addpc" type="button">Upload from Computer</button>
    <button class="fbtn" id="addwf" type="button">Choose from Workflow Files</button>
    <span class="sub" id="addsub"></span>
  </div>

  <input id="up" type="file" multiple>
</div>
<!-- One floating menu, positioned at the pointer, REPLACED rather than
     stacked. Always present and toggled with 'hidden', never built on demand:
     a menu constructed at the moment of the right-click is a menu that can
     fail to appear. -->
<div id="dmenu" role="menu" hidden></div>
<div id="note">
  <div class="spin" id="spin"></div>
  <div id="msg">Starting Chromium&hellip;</div>
  <!-- The button the reported error should have been.
       «اگر مثل الان متغییری باید تغییر کنه با زدن اون دکمه تغییر کنه»
       It is hidden until a failure arrives carrying a 'fixable' remedy, and
       its label and endpoint come from that remedy, so the server decides what
       can be fixed and this page never has to guess. -->
  <button id="fixbtn" type="button" hidden></button>
  <button id="retry" type="button" hidden>Try again</button>
</div>
<script type="module">
// A bare relative specifier is correct here: the desktop session cookie the
// server set alongside this page authenticates rfb.js AND all 41 modules it
// pulls in. (An earlier attempt appended the api_key to it. MEASURED: the query
// is not inherited by the module's own relative imports, so every dependency
// 401'd, the graph never instantiated, and the page spun forever with no error
// on screen. Do not reintroduce that.)
//
// WHY THIS IS A DYNAMIC import() AND MUST STAY ONE.
// rfb.js is served by PROXYING to websockify, so when the desktop is down the
// specifier itself fails (MEASURED: HTTP 503). A static top-level 'import'
// makes that fatal to the WHOLE module: the body never executes, so the very
// handlers that would have reported the failure are inside the thing that did
// not load. The operator was then left on the initial 'Starting Chromium...'
// markup with a spinning spinner and no button, forever:
//
//   MEASURED before this change
//     t=2s   msg="Starting Chromium..."  spinner=true  retryBtn=false
//     t=8s   msg="Starting Chromium..."  spinner=true  retryBtn=false
//     t=20s  msg="Starting Chromium..."  spinner=true  retryBtn=false
//
//   «باز فقط میچرخه و چیزی بالا نمیاد»
//
// Loading it dynamically keeps the failure INSIDE a catch, where it can be
// turned into a message and a working button. See tools/probe-remote-browser-retry.js.
//
// The binding is NOT called 'RFB'. The unit harnesses (chrome-view.test.ts,
// real-chrome-shelf.test.ts) run this script body with 'new Function(...)' and
// pass a fake RFB as a PARAMETER of that name; a 'let RFB' here is a
// redeclaration of the same binding and throws before a line executes
// ("SyntaxError: Identifier 'RFB' has already been declared" -- MEASURED, 48
// tests). Using a private name keeps the injected one visible, which is also
// what lets those harnesses reach 'attach()' without a real network import.
let rfbCtor = null;
async function loadRFB() {
  if (rfbCtor) return rfbCtor;
  // Injected by the test harness (and absent in the browser, where the import
  // below is the only source). typeof avoids a ReferenceError under a bundler
  // that would otherwise treat the bare name as a global read.
  if (typeof RFB !== 'undefined' && RFB) { rfbCtor = RFB; return rfbCtor; }
  const mod = await import('./core/rfb.js');
  rfbCtor = mod.default || mod;
  return rfbCtor;
}

const screenEl = document.getElementById('screen');
const note  = document.getElementById('note');
const msg   = document.getElementById('msg');
const spin  = document.getElementById('spin');
const retry = document.getElementById('retry');
const fixbtn = document.getElementById('fixbtn');
// Declared up here with the other elements, not next to the drawer code that
// uses them, because connect() runs during the module body and would otherwise
// read them inside their temporal dead zone.
//
// 'drawer' is the whole Workflow Files drawer; 'burger' is the ONE permanent
// control that opens it. Neither is on screen until the desktop connects.
const drawer = document.getElementById('files');
const burger = document.getElementById('burger');

const qs = new URLSearchParams(location.search);

/**
 * Show a status message. 'busy' decides spinner vs. retry button.
 *
 * 'fixable' is the third state this page used to lack. Without it, a failure the
 * SERVER can repair looked exactly like one it cannot: the same grey "Try
 * again", which for 'remote_browser_disabled' simply re-ran a start that was
 * always going to be refused. Passing the remedy through means the page offers
 * the action that changes the situation, and the label comes from the server so
 * this file never has to know what causes exist.
 */
function show(text, busy, fixable) {
  msg.textContent = text;
  spin.hidden  = !busy;
  retry.hidden = busy;
  note.hidden  = false;
  showFix(busy ? null : (fixable || null));
}

/**
 * Offer, or withdraw, the one-click fix.
 *
 * Held in a module-level variable rather than on the element, because the click
 * handler is registered ONCE (a handler added per failure would fire N times
 * after N failures — and each firing is a POST that installs software).
 */
let pendingFix = null;

function showFix(fixable) {
  pendingFix = fixable && fixable.endpoint ? fixable : null;
  if (!pendingFix) { fixbtn.hidden = true; return; }
  // The label is the server's, and only its own strings are ever used: this is
  // textContent, so a hostile value cannot become markup.
  fixbtn.textContent = pendingFix.label || 'Fix this';
  fixbtn.disabled = false;
  fixbtn.hidden = false;
}

// Same origin, same port: the app proxies the VNC stream at /desktop/websockify
// so no second hostname is ever needed (see DesktopProxy). wss when the page
// itself is https, or the browser blocks the socket as mixed content.
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl  = scheme + '://' + location.host + '/desktop/websockify';

let rfb = null;

/**
 * Ask the server to bring the whole stack up, then connect.
 *
 * THIS IS WHAT 'RETRY' HAS TO DO. The failure page used to point Retry at this
 * very view, which starts nothing -- so the operator went from a page saying
 * "did not start" to a page waiting for something nobody had started. The only
 * endpoint that starts the display, the window manager, x11vnc, noVNC and a
 * headed Chromium is POST /browser/real/open, and it is idempotent, so calling
 * it when everything is already up costs one round trip and changes nothing.
 *
 * AUTHENTICATION. /browser/* is NOT covered by the desktop session cookie --
 * that cookie is deliberately scoped to Path=/desktop so it cannot ride along
 * on ordinary API calls. MEASURED when this first shipped without a credential:
 * the endpoint answered 401 and the page reported
 * 'Could not start the remote browser: Authentication required' -- an honest
 * message about the wrong problem. So it sends the same x-api-key HEADER as
 * every other fetch on this page (see authHeaders), never a query key: a
 * whole-instance credential in a URL is copied into history and proxy logs.
 *
 * Defined above authHeaders/apiKey but only ever CALLED from the bottom of the
 * module, after both are initialised.
 */
/**
 * Explain a failed start in terms the operator can act on.
 *
 * WHY THIS FUNCTION EXISTS. The reported message was, in full:
 *
 *     Could not start the remote browser: HTTP 502
 *
 * That string came from the old fallback below, and it is a dead end: a bare
 * status with no cause and no next step. Worse, it is MISLEADING, because this
 * server never sends 502 for this route -- sendError() only ever produces
 * 400/409/500/503 with a JSON {success,error} body. A 502 carrying a non-JSON
 * body therefore did not come from the application at all: it was synthesised
 * by a reverse proxy in front of it that stopped waiting (measured cold start:
 * 50.3s, against gateway read timeouts of 30-60s).
 *
 * So gateway statuses are now NAMED as gateway statuses, and everything else
 * prefers the server's own error + hint, which do name the missing package.
 */
function explainStartFailure(status, body) {
  if (body && body.error) {
    return body.hint ? body.error + ' \\u2014 ' + body.hint : body.error;
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'the gateway in front of this app returned ' + status
      + ' before the server answered. The browser is most likely still starting'
      + ' (a first-ever start also provisions the desktop and can take a minute).'
      + ' Nothing was cancelled -- press "Try again" in a few seconds.';
  }
  if (status === 401 || status === 403) {
    return 'authentication was rejected (HTTP ' + status + '). Reopen this view from the app.';
  }
  return 'HTTP ' + status;
}

/**
 * Ask the server to start the stack, retrying while it says "still starting".
 *
 * The server now answers inside a time budget instead of holding the request
 * open until a proxy invents a 502, so a slow cold start comes back as a
 * CONTROLLED 503 remote_browser_starting rather than an unparseable error page.
 * That is a "keep waiting" signal, not a failure, so it is retried
 * automatically with a backoff and only reported when it is really a failure.
 * Every attempt is idempotent, so retrying never starts a second browser.
 */
async function startThenConnect(attempt) {
  attempt = attempt || 1;
  const MAX_ATTEMPTS = 6;

  show(attempt === 1
    ? 'Starting Chromium\\u2026'
    : 'Still starting Chromium\\u2026 (attempt ' + attempt + ' of ' + MAX_ATTEMPTS + ')', true);

  let r, j;
  try {
    r = await fetch('/browser/real/open', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: '{}',
      credentials: 'same-origin',
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    show('Could not reach the server to start the remote browser: '
      + ((e && e.message) || 'network error'), false);
    return;
  }

  if (r.ok && j && j.success) { connect(); return; }

  // RETRYABLE means the work is still in flight on the server, so waiting is
  // the correct response. A gateway 502/504 is treated the same way: it says
  // the proxy stopped waiting, never that the start failed.
  const stillStarting = (j && (j.retryable || j.error === 'remote_browser_starting'))
    || r.status === 502 || r.status === 504;

  if (stillStarting && attempt < MAX_ATTEMPTS) {
    // Capped backoff: 2s, 4s, 6s, 8s, 10s -- enough to outlast the measured
    // ~50s cold start across the attempt budget without hammering the box.
    const waitMs = Math.min(attempt * 2000, 10000);
    setTimeout(function () { void startThenConnect(attempt + 1); }, waitMs);
    return;
  }

  // The third argument is what turns this dead end into a recoverable one. The
  // reported message was:
  //
  //   "Could not start the remote browser: remote_browser_disabled — Remote
  //    Chrome is disabled. Set REAL_CHROME_ENABLED=true and restart the server."
  //
  // and the only control on screen was "Try again", which could not possibly
  // help: the start was refused by configuration, so retrying re-refused it.
  show('Could not start the remote browser: ' + explainStartFailure(r.status, j),
    false, j && j.fixable);
}

/**
 * Apply the server's remedy, then carry on with what the user actually wanted.
 *
 * The continuation is the point. Someone who presses "Turn on the Remote
 * Browser" did not want a setting changed for its own sake — they wanted the
 * browser. Stopping at "enabled" would leave them to find Try again themselves,
 * which is a smaller version of the same defect.
 */
fixbtn.addEventListener('click', async () => {
  if (!pendingFix) return;
  const fix = pendingFix;
  // Disabled for the duration: these endpoints install software or launch a
  // browser, and a double-click must not start two of either.
  fixbtn.disabled = true;
  show(fix.label ? fix.label + '\\u2026' : 'Fixing\\u2026', true);

  let r, j;
  try {
    r = await fetch(fix.endpoint, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: '{}',
      credentials: 'same-origin',
    });
    j = await r.json().catch(() => null);
  } catch (e) {
    show('Could not reach the server to apply the fix: '
      + ((e && e.message) || 'network error'), false, fix);
    return;
  }

  // A fix that reports failure may still name a DIFFERENT remedy — enabling the
  // browser can succeed and then reveal that there is no Chromium binary. Using
  // the new remedy rather than re-offering the old one is what lets the operator
  // walk out of a chain of causes one button at a time.
  if (!(r.ok && j && j.success)) {
    show('That did not work: ' + explainStartFailure(r.status, j), false,
      (j && j.fixable) || null);
    return;
  }

  // It worked. Continue to the browser the user was asking for.
  void startThenConnect();
});

function connect() {
  show('Starting Chromium\\u2026', true);

  if (rfb) { try { rfb.disconnect(); } catch (e) { /* already gone */ } rfb = null; }

  // Failure to LOAD rfb.js is the down-desktop case (the specifier is proxied
  // to websockify). Report it and offer the button, instead of leaving the
  // initial spinner up for ever.
  loadRFB().then(() => { attach(); }).catch(() => {
    show('The remote desktop is not running, so there is nothing to show yet.'
      + ' Press "Try again" to start it.', false);
  });
}

function attach() {
  rfb = new rfbCtor(screenEl, wsUrl, {
    // Only used when the server was started with DESKTOP_VNC_PASSWORD. Passing
    // it up front is what keeps noVNC's credentials PROMPT from ever appearing,
    // which is half of the UI the operator did not want.
    credentials: { password: qs.get('vnc_password') || '' },
  });

  // Fit the desktop to this tab instead of showing scrollbars: the operator is
  // looking at a browser, and a browser that needs to be panned is not usable.
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.clipViewport  = false;
  rfb.focusOnClick  = true;

  rfb.addEventListener('connect', () => {
    note.hidden = true;
    // Only once there is a desktop to exchange files WITH. Showing the
    // hamburger over the "Starting Chromium..." spinner would offer a drawer
    // with nowhere to send anything, and a download list that cannot be
    // populated. The drawer itself stays shut: it is an overlay the operator
    // asks for, never one that greets them.
    burger.hidden = false;
    // And only now start watching for files moving in either direction: before
    // the desktop is up there is no page that can ask for a file and nothing
    // that can have downloaded one.
    startWatching();
    // Now that transfers CAN happen, say which workflow they belong to, so a
    // download is filed under downloads/ and a sent file under uploads/.
    void bindWorkflow();
  });

  rfb.addEventListener('disconnect', (ev) => {
    // 'clean' means the server closed it deliberately (desktop stopped);
    // anything else is a failure we should let the operator retry.
    show(
      ev.detail && ev.detail.clean
        ? 'Chromium disconnected.'
        : 'Could not reach Chromium. Is the remote desktop running?',
      false,
    );
  });

  rfb.addEventListener('securityfailure', () => {
    show('Chromium refused the connection (VNC authentication failed).', false);
  });

  // ── REMOTE CLIPBOARD, both directions ───────────────────────────────────
  // «الف) کپی/پیست ریموت» -- the simulator had this and the real view must too.
  //
  // No server code is involved: x11vnc already exchanges the X CLIPBOARD and
  // PRIMARY selections with its client in both directions (the -nosel /
  // -noclipboard / -nosetclipboard flags exist to switch that OFF and we pass
  // none of them), so the only missing link was this page and the operator's
  // OWN clipboard.
  //
  // remote -> local: the desktop copied something, so mirror it locally.
  rfb.addEventListener('clipboard', (ev) => {
    const text = ev.detail && ev.detail.text;
    if (typeof text !== 'string' || text === '') return;
    lastRemote = text;
    // Best-effort by design. writeText rejects when the document is not focused
    // and in browsers that gate it behind a permission; the copy still happened
    // INSIDE the remote desktop either way, so a rejection here must not become
    // an unhandled rejection in a page whose job is to look like it works.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  });
}

// The last text seen in either direction. Without it, mirroring the remote
// clipboard locally and then polling the local one would send the same string
// straight back to the desktop -- a copy loop that overwrites a selection the
// user makes while it is in flight.
let lastRemote = '';

/** Push text to the remote desktop's clipboard, if it is new. */
function pushClipboard(text) {
  if (typeof text !== 'string' || text === '' || text === lastRemote) return;
  if (!rfb) return;
  lastRemote = text;
  try { rfb.clipboardPasteFrom(text); } catch (e) { /* not connected yet */ }
}

// local -> remote, on paste. Ctrl+V inside the remote desktop is delivered to
// the remote application as a KEYSTROKE, and that application reads the REMOTE
// clipboard -- which knows nothing about what the operator copied on their own
// machine. So the text has to be shipped over before the keystroke lands. The
// paste event carries it directly, which needs no permission at all.
window.addEventListener('paste', (ev) => {
  const text = ev.clipboardData && ev.clipboardData.getData('text/plain');
  if (text) pushClipboard(text);
});

// local -> remote, without a paste: the operator copies in another app, comes
// back, and presses Ctrl+V inside the desktop. There is no event for "the
// clipboard changed", so the only way to have the text ready in time is to read
// it when this tab regains focus -- which is also the one moment readText() is
// permitted, since it requires the document to be focused.
function syncFromLocal() {
  if (!navigator.clipboard || !navigator.clipboard.readText) return;
  navigator.clipboard.readText().then(pushClipboard).catch(() => {
    // Denied or unsupported (Firefox has no readText for pages). The paste
    // listener above still covers the ordinary Ctrl+V case, so this is a
    // best-effort upgrade and never an error worth showing.
  });
}
window.addEventListener('focus', syncFromLocal);

// ── REMOTE DOWNLOAD / UPLOAD (import / export) ─────────────────────────────
// «ب) دانلود/آپلود یا امپورت/اکسپورت ریموت»
//
// Chrome's own shelf is visible on the remote screen, but every path on it is a
// path on the SERVER's disk, so clicking it opens a file manager the operator
// cannot reach. These two controls are the reachable halves:
//
//   Downloads  (the shelf pane of the drawer) lists what the remote browser
//              downloaded, each row linking to /browser/downloads/<token>,
//              which serves the bytes with the name the file was actually
//              given (see RemoteDownloads).
//   Send a file puts a local file on the server so the remote browser's file
//              chooser can pick it up.
//
// These call /browser/*, which the desktop session cookie does NOT cover: that
// cookie is deliberately scoped to Path=/desktop. The page URL's own api_key is
// the credential here, exactly as it is for the page itself.
//
// There is no downloads panel and no Activity pane: downloads are FILED under
// downloads/ in the one workspace, and the receipts ("ready to send", "sent to
// the site", "delivery failed") are notice rows inside that same workspace
// (#dnotices, see noteInPanel() below).
const dnotices = document.getElementById('dnotices');
const upInput = document.getElementById('up');
const apiKey  = qs.get('api_key') || '';

// Anything larger than this is streamed by the browser itself instead of being
// held in memory as a Blob. 64 MB is the simulator's measured line: below it a
// Blob is instant and keeps the key out of the URL, above it the tab's memory
// is the thing that breaks first.
const BLOB_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Add the api_key to one of our own paths.
 *
 * ONLY for requests a plain navigation has to make (see downloadHref). Every
 * fetch on this page authenticates with an x-api-key HEADER instead, because a
 * key in a URL is copied into the download history, the address bar and any
 * proxy log in between -- a whole-instance credential leaked into three places
 * that outlive the transfer.
 */
function api(path) {
  return path + (path.indexOf('?') >= 0 ? '&' : '?') +
    'api_key=' + encodeURIComponent(apiKey);
}

/** The auth header every fetch on this page uses instead of a query key. */
function authHeaders() {
  return apiKey ? { 'x-api-key': apiKey } : {};
}

function humanSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Which identity the shelf's files are stored under. The list endpoint RETURNS
// this ('owner') precisely so a client does not hardcode it; hardcoding is the
// documented ENOENT hand-over bug, where the bytes are written under one id and
// looked for under another. Empty until the first list, which is fine: the only
// way to have a row to fetch is to have listed first.
let shelfOwner = '';

/** The bytes URL. withToken is for navigations only, which cannot send headers. */
function downloadHref(token, withToken) {
  let path = '/browser/downloads/' + encodeURIComponent(token);
  if (shelfOwner) path += '?userId=' + encodeURIComponent(shelfOwner);
  return withToken ? api(path) : path;
}

/**
 * The filename the SERVER says this file has, per RFC 6266.
 *
 * filename*=UTF-8''... is preferred over the plain filename="..." because
 * the ASCII copy is deliberately lossy: the server transliterates anything
 * non-ASCII, so a Persian name arrives as _____.png. The starred form carries
 * the real characters.
 *
 * This is read from the RESPONSE and not taken from the shelf row, because the
 * row's name is a stale copy: the server renames extension-less downloads once
 * it has identified the bytes (finalizeDownloadName), so the row can still say
 * "download" where the served file is "report.png".
 */
function nameFromDisposition(cd) {
  const s = String(cd || '');
  // Doubled backslashes on purpose: this whole page is a TEMPLATE LITERAL in
  // ChromeView.ts, so a single backslash is consumed by TypeScript and never
  // reaches the browser. MEASURED before this fix, the shipped regex was
  // /filename*s*=s*UTF-8''([^;]+)/ -- which cannot match anything, so the
  // Persian name silently lost to the lossy ascii copy.
  const star = /filename\\*\\s*=\\s*UTF-8''([^;]+)/i.exec(s);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (decoded) return decoded;
    } catch (e) { /* a malformed encoding must not lose the plain copy below */ }
  }
  const plain = /filename\\s*=\\s*"([^"]*)"/i.exec(s)
    || /filename\\s*=\\s*([^;]+)/i.exec(s);
  return plain ? plain[1].trim() : '';
}

/**
 * Hand a URL to the browser as a download.
 *
 * The anchor must be IN the document before it is clicked: a detached anchor's
 * click is ignored outright by Firefox, which is how "nothing happens when I
 * click a file" happened.
 *
 * Revocation is DEFERRED, never synchronous. Calling revokeObjectURL right
 * after click() cancels the transfer that click just started -- measured as a
 * 0-byte file. 60 s is long enough for the browser to have taken the bytes.
 */
function saveAs(href, name, revoke) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name || 'download';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) {
    setTimeout(() => { try { URL.revokeObjectURL(href); } catch (e) {} }, 60000);
  }
}

/** Say what actually went wrong, in the server's own words when it gave any. */
function downloadFailureMessage(status, body) {
  if (body && body.error) return String(body.error);
  if (status === 401) return 'Not authorised to fetch this file.';
  if (status === 403) return 'This key may not fetch this file.';
  if (status === 404) return 'That file is no longer on the server.';
  return 'The server refused the download (HTTP ' + (status || '?') + ').';
}

/**
 * Fetch a shelf file and give it to the operator's own browser.
 *
 * A HEAD PREFLIGHT comes first, and that is the whole point of this function
 * rather than an <a href>. When a download URL answers non-2xx, Chrome shows
 * only its own generic "Failed - Unknown server error" and throws the server's
 * message away, so an expired token, a missing file and a wrong key are all one
 * indistinguishable failure. Asking with HEAD lets the real sentence be shown.
 *
 * The preflight also decides HOW to transfer: a small file becomes a Blob
 * fetched with the key in a header, and only a file over BLOB_LIMIT_BYTES is
 * navigated to with the token in the query.
 */
function fetchDownload(row, onError) {
  const headers = authHeaders();
  const fail = (res) => res.text().then((txt) => {
    let body = null;
    try { body = JSON.parse(txt); } catch (e) { /* not JSON: status decides */ }
    throw new Error(downloadFailureMessage(res.status, body));
  });

  return fetch(downloadHref(row.token, false), { method: 'HEAD', headers: headers })
    .then((res) => {
      // A HEAD that fails is re-asked as a GET purely to read the error body:
      // HEAD has no body by definition, so the server's sentence is only
      // available from the GET.
      if (!res.ok) {
        return fetch(downloadHref(row.token, false), { headers: headers }).then(fail);
      }
      const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      let want = nameFromDisposition(res.headers.get('content-disposition')) || row.name;
      if (len > BLOB_LIMIT_BYTES) {
        // Too big to hold in memory: the browser streams it to disk itself.
        // This is the ONLY path allowed to put the key in a URL.
        saveAs(downloadHref(row.token, true), want, false);
        return null;
      }
      return fetch(downloadHref(row.token, false), { headers: headers })
        .then((r) => {
          if (!r.ok) return fail(r);
          want = nameFromDisposition(r.headers.get('content-disposition')) || want;
          return r.blob();
        })
        .then((blob) => {
          if (!blob) return null;
          saveAs(URL.createObjectURL(blob), want, true);
          return null;
        });
    })
    .catch((e) => {
      if (onError) onError(e && e.message ? e.message : 'The download failed.');
    });
}

/**
 * Read the shelf -- for the WATCHER only. Returns the rows so pollDownloads()
 * can deliver what is new. Nothing is drawn from this: the file the browser
 * downloaded is filed under downloads/ in the workspace (WorkflowBinding), and
 * the tree is what shows it. The ?watch=1 marker is for the reader of an
 * access log, so the background poll can be told from an operator action.
 */
function refreshDownloads() {
  return fetch('/browser/real/downloads?watch=1', {
    headers: authHeaders(),
    credentials: 'same-origin',
  })
    .then((r) => r.json())
    .then((j) => {
      if (j && j.owner) shelfOwner = String(j.owner);
      return (j && j.downloads) || [];
    })
    .catch(() => {
      // The browser may not be up yet; the watcher's next tick asks again.
      return null;
    });
}

// ── THE DRAWER: ONE WORKSPACE ───────────────────────────────────────────────
//
// One surface, and it is the workflow's file workspace. The only other thing
// it ever shows is the source chooser, which stands IN for the tree while a
// page is asking for a file:
//
//   'files'  the workspace: uploads/, downloads/, the operator's own folders
//   'pick'   the two sources, offered only while a page is waiting
//
// No tabs, no Activity pane, no downloads shelf: a download is a file in
// downloads/, a sent file is a file in uploads/, and the receipts are notice
// rows under the tree. The hamburger opens the drawer; the drawer's own Close
// shuts it; the hamburger hides itself while it is open.
let drawerPane = 'files';

/** Show the workspace, or the source chooser in its place. */
function showPane(which) {
  drawerPane = which;
  const panes = { files: 'panefiles', pick: 'dpick' };
  Object.keys(panes).forEach((k) => {
    const el = document.getElementById(panes[k]);
    if (el) el.hidden = k !== which;
  });
}

function drawerOpen() { return !!drawer && !drawer.hidden; }

/**
 * Raise the drawer.
 *
 * Opening the workspace loads the tree; a workspace that is ALREADY on screen
 * is not re-read underneath the operator (a notice just written would be
 * scrolled away from). 'quiet' shows without loading at all.
 */
function openDrawer(which, quiet) {
  if (!drawer) return;
  const wasOpen = drawerOpen();
  const before = drawerPane;
  drawer.hidden = false;
  if (burger) burger.hidden = true;
  const next = which || drawerPane;
  showPane(next);
  if (quiet) return;
  if (wasOpen && before === next) return;
  if (next === 'files') void wfmEnsureLoaded();
}

function closeDrawer() {
  if (!drawer) return;
  drawer.hidden = true;
  if (burger) burger.hidden = false;
  wfmCloseMenu();
}

if (burger) {
  burger.addEventListener('click', () => {
    // A page that is mid-request has a question outstanding, so the drawer
    // opens on the two sources rather than on a tree the operator would then
    // have to find the point of.
    openDrawer(pendingId ? 'pick' : 'files');
  });
}
const dcloseBtn = document.getElementById('dclose');
if (dcloseBtn) dcloseBtn.addEventListener('click', () => closeDrawer());

// Escape shuts the menu first, then the drawer: aiming at a menu must not
// cost the whole drawer.
document.addEventListener('keydown', (ev) => {
  if (!ev || ev.key !== 'Escape') return;
  const dm = document.getElementById('dmenu');
  if (dm && !dm.hidden) { wfmCloseMenu(); return; }
  if (drawerOpen()) closeDrawer();
});

/**
 * Send one file to the server and return where the remote browser will find it.
 *
 * The response is READ, not merely checked for res.ok. /browser/uploads answers
 * 200 with { success:false, error } for a rejected file (too large, empty), so
 * a bare res.ok check reports "Uploaded" for a file the server threw away --
 * which is exactly the "it does not actually work" the operator reported. The
 * server's own sentence is what gets shown.
 *
 * The key travels as a HEADER here too, so a file transfer never writes the
 * credential into a URL.
 */
function uploadOne(file) {
  const query = '?name=' + encodeURIComponent(file.name || 'file');
  const headers = authHeaders();
  headers['Content-Type'] = 'application/octet-stream';
  return fetch('/browser/uploads' + query, {
    method: 'POST',
    headers: headers,
    body: file,
    credentials: 'same-origin',
  }).then((r) => r.text().then((txt) => {
    let d = null;
    try { d = JSON.parse(txt); } catch (e) { /* not JSON: the status decides */ }
    if (r.status === 401 || r.status === 403) {
      throw new Error('Not authorised to upload (the page key was rejected).');
    }
    if (!r.ok || !d || !d.success) {
      throw new Error((d && d.error) || 'The server rejected the upload.');
    }
    return d;
  }));
}

/**
 * A receipt, inside the workspace: "ready to send", "sent to the site", "the
 * delivery failed". It goes under the tree, newest first, with a dismiss
 * control, and the drawer is raised on the workspace so it can be read. A
 * message written where nobody is looking is the original complaint about
 * this page in a new form. Bounded: the oldest rows fall off past a handful,
 * because these are receipts and not a log.
 */
const NOTICE_LIMIT = 6;
function noteInPanel(className, text, sub, opts) {
  const li = document.createElement('li');
  li.className = className;
  // The text is a child of its own, not the row's own text node, so the
  // Dismiss control and the sub-line sit beside it in the row's flex layout.
  const main = document.createElement('span');
  main.className = 'ntext';
  main.textContent = text;
  li.appendChild(main);
  if (sub) {
    const extra = document.createElement('div');
    extra.className = 'sub';
    extra.textContent = sub;
    li.appendChild(extra);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'del';
  x.textContent = '\u00d7';
  x.title = 'Dismiss';
  x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', () => { li.remove(); syncNotices(); });
  li.appendChild(x);
  if (dnotices) {
    dnotices.insertBefore(li, dnotices.firstChild || null);
    while (dnotices.children.length > NOTICE_LIMIT) {
      dnotices.removeChild(dnotices.children[dnotices.children.length - 1]);
    }
    syncNotices();
  }
  // QUIET: the workspace is not re-read under the row just written; the tree
  // is refreshed by the operations themselves and by Refresh. A receipt that
  // asks for nothing (a download that simply landed) does not raise the
  // drawer at all -- it would cover the remote screen the operator is working
  // in; the file itself arriving on their machine is the signal, and the row
  // waits here for the next time the workspace is opened.
  if (!(opts && opts.raise === false)) openDrawer(drawerPane === 'pick' ? 'pick' : 'files', true);
  return li;
}

/** The notice list takes no room at all when it is empty. */
function syncNotices() {
  if (dnotices) dnotices.hidden = dnotices.children.length === 0;
}

/**
 * What happened to an upload that no page had asked for yet.
 *
 * THE OLD TEXT WAS THE BUG, NOT THE WORDING
 * -----------------------------------------
 * This used to read "press its own Choose/Browse button and type this name into
 * the dialog on screen", on the theory that a real Chromium driven by a real
 * mouse has no interceptable dialog, so the operator had to bridge the gap by
 * hand. MEASURED (tools/probe-upload-vnc.js) that theory is false: a genuine
 * X11 click IS intercepted, because interception is a property of the CDP
 * connection and not of who moved the mouse. So there is no name to type and no
 * server filesystem to browse; the file is simply sent when the page asks. Which
 * is the whole requirement:
 *
 *   «کاربر نباید مجبور باشد ابتدا فایل را دستی روی سرور Upload کند و بعد از
 *    سرور آن را روی سایت بفرستد»
 */
function showUploadResult(names) {
  noteInPanel(
    'uphint',
    names.length === 1 ? 'Ready to send: ' + names[0] : 'Ready to send: ' + names.join(', '),
    'Press the page own Choose/Browse button and this goes straight to the site.',
  );
}

/**
 * Uploads that are on the server but have not been given to a page yet.
 *
 * This is what makes the Upload button worth pressing BEFORE the page asks. When
 * a chooser then appears it is answered from here without another prompt, so the
 * operator picks a file once and never twice.
 */
let readyTokens = [];
let readyNames  = [];

upInput.addEventListener('change', () => {
  const list = Array.from(upInput.files || []);
  // Reset first: picking the same file twice in a row fires no 'change' at all
  // unless the value is cleared, which reads as the upload being ignored.
  upInput.value = '';
  // Captured NOW, before any await. If the page's request expires mid-upload the
  // file must not be delivered to whatever asked next.
  const answering = pendingId;
  if (!list.length) {
    // The operator opened their own picker and chose nothing. The remote page is
    // still waiting on a dialog, and a page that thinks a dialog is open behaves
    // as if it is still waiting for input -- so release it.
    if (answering) void cancelPending(answering);
    return;
  }
  const done = [];
  const tokens = [];
  let failure = '';
  // Sequential on purpose: parallel uploads of several large files on a server
  // that is also running a browser is how both end up slow.
  list.reduce(
    (chain, file) => chain.then(() => uploadOne(file).then((d) => {
      done.push((d && d.name) || file.name);
      if (d && d.token) tokens.push(d.token);
    })),
    Promise.resolve(),
  )
    .then(() => {
      // The bytes are on the server. If a page is waiting for them, that is the
      // whole point -- hand them over now rather than telling the operator to go
      // and do it themselves.
      if (answering && tokens.length) return answerPending(answering, tokens, done);
      readyTokens = readyTokens.concat(tokens);
      readyNames  = readyNames.concat(done);
      showUploadResult(done);
      return null;
    })
    .catch((e) => {
      failure = (e && e.message) ? e.message : 'The upload failed.';
      // Say WHY, in the panel, where it stays readable. A button that flicks
      // back to "Upload" after 2.5 s has told the operator nothing.
      noteInPanel('rowerr', failure);
      // A page still waiting on a dialog we cannot answer must be released, or
      // the operator is left looking at a page that never moves.
      if (answering) void cancelPending(answering);
      // Files that DID arrive before the failure are still usable, and saying
      // so is the difference between "retry the rest" and "start over".
      if (done.length) {
        readyTokens = readyTokens.concat(tokens);
        readyNames  = readyNames.concat(done);
        showUploadResult(done);
      }
    });
});

// A picker the operator dismissed. Modern browsers fire this and NOT 'change',
// so without it a cancelled pick would leave the remote page waiting on a dialog
// until the server's own timeout released it minutes later.
upInput.addEventListener('cancel', () => {
  const answering = pendingId;
  if (answering) void cancelPending(answering);
});

// ── AUTOMATIC TRANSFER, BOTH DIRECTIONS ────────────────────────────────────
// The two requirements this implements, in the operator's own words:
//
//   «Windows کاربر → Backend/Server → Website ... کاربر نباید مجبور باشد ابتدا
//    فایل را دستی روی سرور Upload کند»
//   «کلیک روی Download → فایل مستقیماً روی Windows کاربر ذخیره شود»
//
// Neither can be driven by the operator pressing something in this bar, because
// the thing that starts them happens INSIDE the remote page. So the page watches
// the server instead, and both directions complete on their own.
//
// WHY POLLING, AND WHY AT THIS RATE
// ---------------------------------
// Opening the operator's own file picker requires transient user activation, and
// the activation in play is the click they just made on the remote screen -- this
// canvas -- to press the page's Choose button. That activation has to survive the
// round trip to the server and back. MEASURED
// (tools/probe-activation-window.js): the picker still opens 4900 ms after the
// gesture and fails at 6000 ms. So the interval is set an order of magnitude
// inside the budget, leaving room for a slow request rather than sitting on the
// edge of it. A WebSocket would need no interval at all, but this page's only
// socket is the RFB stream and adding a second one is a new authentication
// surface for a saving of a few hundred milliseconds.
const WATCH_MS = 700;

/** The request the remote page is currently waiting on, and its details. */
let pendingId = '';
let pendingAccept = '';
let pendingMultiple = false;
/** The prompt shown for it, so it can be removed once it is answered. */
let pendingRow = null;

/**
 * Downloads already given to the operator's browser.
 *
 * Keyed by token, so a file is delivered exactly once no matter how many times
 * it appears in a poll. Without it every tick would re-save the same file.
 */
const delivered = {};
/**
 * Whether the first list has been seen.
 *
 * The first poll SEEDS this map instead of delivering: the shelf can already
 * hold files from before this tab was opened, and dumping a previous session's
 * downloads into the operator's Downloads folder because they opened a viewer is
 * not what "the file I just downloaded arrives on my machine" means.
 */
let seeded = false;

let watching = false;

/** Start the watch loop. Called once, when the desktop connects. */
function startWatching() {
  if (watching) return;
  watching = true;
  void tick();
}

/**
 * setTimeout and not setInterval, deliberately: a tick that is slower than the
 * interval would otherwise overlap itself, and two overlapping ticks can see the
 * same new download and deliver it twice.
 */
function tick() {
  return watchOnce()
    .catch(() => { /* a failed poll is a poll; the next one still runs */ })
    .then(() => { setTimeout(() => { void tick(); }, WATCH_MS); });
}

function watchOnce() {
  return Promise.resolve()
    .then(() => pollChooser())
    .then(() => pollDownloads());
}

/** Is a page asking for a file? If so, get the operator's file to it. */
function pollChooser() {
  return fetch('/browser/real/chooser', {
    headers: authHeaders(),
    credentials: 'same-origin',
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const c = j && j.chooser;
      if (!c || !c.id) {
        // The request is gone: answered, cancelled, or its page closed. Take the
        // prompt down so the bar does not ask for a file nothing is waiting for.
        if (pendingId) clearPending();
        return null;
      }
      // Already handling this one. Re-opening the picker on every tick would
      // fight the operator for the dialog they are standing in.
      if (c.id === pendingId) return null;
      pendingId = String(c.id);
      pendingAccept = String(c.accept || '');
      pendingMultiple = !!c.multiple;
      return offerFile();
    })
    .catch(() => { /* the browser may be down; the next tick finds out */ });
}

/**
 * Get a file to the page that is asking, with as few gestures as possible.
 *
 * Nothing here is a dead end. If the picker cannot be raised -- the activation
 * expired, or the operator's browser refuses -- the prompt in the panel is a
 * real button that opens it, so the request is always answerable by hand.
 */
function offerFile() {
  // Already uploaded something and it has not been used yet: the operator has
  // ALREADY chosen. Asking again would be the manual second step this feature
  // exists to remove.
  if (readyTokens.length) {
    const tokens = pendingMultiple ? readyTokens : readyTokens.slice(0, 1);
    const names  = pendingMultiple ? readyNames  : readyNames.slice(0, 1);
    readyTokens = pendingMultiple ? [] : readyTokens.slice(1);
    readyNames  = pendingMultiple ? [] : readyNames.slice(1);
    return answerPending(pendingId, tokens, names);
  }

  // A line on the shelf, with a button that is a real way to do it by hand:
  // the picker can be refused when the activation from the remote click has
  // expired, and then this button's OWN click is the activation.
  pendingRow = noteInPanel(
    'uphint',
    'The page is asking for a file.',
    'Choose it on your own computer and it goes straight to the site.',
  );
  const pick = document.createElement('button');
  pick.className = 'fbtn';
  pick.type = 'button';
  pick.textContent = 'Choose file';
  pick.addEventListener('click', () => openLocalPicker());
  pendingRow.appendChild(pick);

  // And the drawer opens ON THE TWO SOURCES. Both buttons there are the
  // operator's own gesture, which is what makes the native picker reliably
  // openable no matter how old the remote click is by now -- and the second
  // source, this workflow's files, never needed a picker at all.
  showSourceChooser('The page is asking for a file.');

  // The attempt itself. It works while the click on the remote screen still
  // counts as activation; when it does not, the buttons above are right there.
  openLocalPicker();
  return null;
}

// ── THE SOURCE CHOOSER: TWO SOURCES ──────────────────────────────────────────
//
//   The page is asking for a file
//   ├── Upload from Computer       -> the existing upload bridge (upInput,
//   │                                 uploadOne, /browser/uploads, tokens)
//   └── Choose from Workflow Files -> the workspace pane below, and
//                                     POST /browser/workflow-files/<id>/use
//
// WHY THE OPERATOR'S CLICK MATTERS (the diagnosed regression). offerFile()
// calls upInput.click() when the poll finds a request, and Chrome only honours
// that inside the transient-activation window of the operator's last gesture
// (MEASURED: 4900 ms works, 5500 ms does not). Both buttons here run inside
// the operator's own click, so 'Upload from Computer' opens the picker every
// time. Nothing here simulates a gesture or clicks Upload on the operator's
// behalf; the fix is that the gesture is theirs.
//
// WHICH WORKFLOW. The page is opened with ?workflowId=<id> by browser-view.js
// (the id of the workflow the picker was pressed in, i.e. the canonical
// WorkflowService id). Without one the second source is offered but explains
// that a saved workflow is needed, rather than inventing a bucket.
//
// THE 'endpoint not found' INCIDENT, from this side. MEASURED: a view opened
// WITHOUT ?workflowId= (the URL-bar "open local", the placeholder's own
// links) still let New Folder / New File / Upload be pressed, built
// '/browser/workflow-files//mkdir' from the empty id, and read the app-wide
// 404 back as "Endpoint not found". Two things follow:
//
//   1. workflowId is RESOLVED, not merely read: the URL first; failing that,
//      the workflow this Local Browser is currently bound to on the server
//      (GET /browser/workflow-files-binding), because the operator who opened
//      this view from the workflow a moment ago is still in that workflow.
//   2. No request is ever built from an empty id (wfmRequire below). Without a
//      workflow the workspace says so, in words, and the mutations say the
//      same thing instead of sending anything.
const pickAccept = document.getElementById('dpickaccept');
const addSub     = document.getElementById('addsub');
const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
let workflowId = WORKFLOW_ID_RE.test(qs.get('workflowId') || '') ? qs.get('workflowId') : '';
const NO_WORKFLOW_TEXT = 'This browser was not opened from a saved workflow, so it has no workflow files. Save the workflow, then open the browser from it.';

/**
 * Find the workflow when the URL did not name one: the server knows which
 * workflow the Local Browser is bound to right now. Resolves to the id, or ''.
 * Runs once per page, before the first listing and before the first bind.
 */
let workflowResolved = null;
function resolveWorkflowId() {
  if (workflowResolved) return workflowResolved;
  if (workflowId) { workflowResolved = Promise.resolve(workflowId); return workflowResolved; }
  workflowResolved = fetch('/browser/workflow-files-binding', { headers: authHeaders(), credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const id = j && j.local && j.local.workflowId ? String(j.local.workflowId) : '';
      if (WORKFLOW_ID_RE.test(id)) workflowId = id;
      return workflowId;
    })
    .catch(() => workflowId);
  return workflowResolved;
}

/**
 * The gate every workspace request goes through. TRUE when there is a
 * workflow; otherwise it says why in the workspace and returns false, so the
 * caller sends nothing. This is what makes an empty-id URL impossible.
 */
function wfmRequire() {
  if (workflowId) return true;
  wfmSay(NO_WORKFLOW_TEXT, true);
  return false;
}

/** Raise the drawer on the two sources, with the request's filter named. */
function showSourceChooser(why) {
  if (pickAccept) {
    pickAccept.textContent = pendingAccept ? 'The page accepts: ' + pendingAccept : '';
  }
  if (addSub) addSub.textContent = why || '';
  openDrawer('pick');
}
/** The question is gone: back to the workspace if the chooser was up. */
function hideSourceChooser() {
  if (drawerPane === 'pick') showPane('files');
}

const addPc = document.getElementById('addpc');
if (addPc) {
  addPc.addEventListener('click', () => {
    // Same input, same upload path, same tokens as "Send a file". If a page is
    // asking, the input mirrors its accept/multiple; otherwise it parks the
    // file exactly as Send does.
    if (pendingId) openLocalPicker();
    else {
      upInput.accept = '';
      upInput.multiple = true;
      try { upInput.click(); } catch (e) { /* the shelf's Send still works */ }
    }
  });
}

const addWf = document.getElementById('addwf');
if (addWf) {
  addWf.addEventListener('click', () => {
    // Choosing the second source IS the request to browse: the tree comes up
    // by itself, filtered by the page's own accept/multiple, and the operator
    // presses nothing else first.
    openDrawer('files');
  });
}

// ── THE WORKSPACE PANE ───────────────────────────────────────────────────────
//
// The same Workflow Files workspace the canvas views get from
// public/js/workflow-files.js, reimplemented for this standalone page (which
// cannot load app scripts). A real tree, not a list: expand/collapse, an
// icon-only toolbar, a context menu on every row and on the empty space,
// inline rename, delete behind an in-drawer confirmation, and multi-select
// whenever the page's input is 'multiple'.
//
// Every request names workflowId + a workflow-RELATIVE path; the server decides
// where that is on disk and this page never sees an absolute path. Persistent:
// files here outlive the temporary upload TTL and the browser session.
const wfmList    = document.getElementById('wfmlist');
const wfmNote    = document.getElementById('wfmnote');
const wfmSelect  = document.getElementById('wfmselect');
const wfmUp      = document.getElementById('wfmup');
const wfmTotal   = document.getElementById('dtotal');
const wfmAll     = document.getElementById('dall');
const wfmCount   = document.getElementById('dcount');
const wfmClear   = document.getElementById('dclear');
const wfmDelSel  = document.getElementById('ddelsel');
const wfmConfirm = document.getElementById('dconfirm');
const wfmMenu    = document.getElementById('dmenu');
const wfmCrumbs  = document.getElementById('dcrumbs');

/**
 * The tree, as the server has described it so far.
 *
 *   wfmFolders  rel-path -> entries[]   every folder listed so far (cached)
 *   wfmOpen     rel-path -> true        folders currently expanded
 *   wfmSelected [{ path, name, size }]  in the order they were picked
 *
 * Selection is a LIST, not one entry: an 'input type=file multiple' may take
 * several, and this drawer is the only place the operator can say which. For
 * a single-file input picking a second REPLACES the first.
 */
const wfmFolders = {};
const wfmOpen = { '': true };
let wfmSelected = [];
let wfmLoadedOnce = false;
/** Which folder the next upload lands in ("Upload Here" vs the toolbar). */
let wfmUploadInto = '';
/**
 * Where the tree is ROOTED right now: '' is the workspace itself, otherwise a
 * folder the operator opened (double-click, or Open in the menu). The
 * breadcrumb above the list names it and is the way back. Expanding in place
 * (the chevron) and going INTO a folder are both offered because a deep
 * folder needs the second and a shallow one is quicker with the first.
 */
let wfmRoot = '';
/** The name of the system folder that fresh uploads default to. */
const WFM_UPLOADS = 'uploads';
/** Whether the Local Browser has been bound to this workflow (POST /bind). */
let wfmBound = false;

function wfmBase() {
  return '/browser/workflow-files/' + encodeURIComponent(workflowId);
}

function wfmSay(text, isErr) {
  if (!wfmNote) return;
  wfmNote.textContent = text || '';
  wfmNote.className = isErr ? 'err' : '';
}

/** Read a JSON answer, and turn a refusal into an Error with the server's words. */
function wfmJson(r) {
  return r.text().then((txt) => {
    let d = null;
    try { d = JSON.parse(txt); } catch (e) { /* not JSON: the status decides */ }
    if (r.status === 401 || r.status === 403) {
      throw new Error((d && d.error) || 'Not authorised.');
    }
    if (!r.ok || !d || !d.success) {
      throw new Error((d && d.error) || ('The server refused (HTTP ' + r.status + ').'));
    }
    return d;
  });
}

function wfmFetch(path, init) {
  const o = init || {};
  const headers = Object.assign({}, authHeaders(), o.headers || {});
  return fetch(path, Object.assign({}, o, { headers: headers, credentials: 'same-origin' }))
    .then(wfmJson);
}

/** '' for a root entry, otherwise the folder the path is in. */
function wfmParentOf(rel) {
  const i = String(rel || '').lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** Does the page's accept filter admit this NAME? (Extensions only.) */
function wfmAccepts(accept, name) {
  const spec = String(accept || '').trim();
  if (!spec) return true;
  const lower = String(name || '').toLowerCase();
  const parts = spec.split(',');
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i].trim().toLowerCase();
    if (!p) continue;
    if (p.charAt(0) === '.') {
      if (lower.slice(-p.length) === p) return true;
    } else if (p.indexOf('/') >= 0) {
      // A MIME pattern cannot be checked against a bare name here; the page
      // itself decides. Do not refuse what might be fine.
      return true;
    }
  }
  return false;
}

// ── Selection ────────────────────────────────────────────────────────────────

function wfmIsPicked(rel) {
  for (let i = 0; i < wfmSelected.length; i += 1) {
    if (wfmSelected[i].path === rel) return true;
  }
  return false;
}

function wfmPick(entry, on) {
  const want = (on === undefined) ? !wfmIsPicked(entry.path) : !!on;
  let next = wfmSelected.filter((x) => x.path !== entry.path);
  if (want) {
    // A single-file input can hold exactly one, so picking a second REPLACES
    // the first rather than silently keeping a choice the page cannot take.
    if (!pendingMultiple) next = [];
    next.push({ path: entry.path, name: entry.name, size: entry.size });
  }
  wfmSelected = next;
  wfmSyncSelection();
}

function wfmClearSelection() {
  wfmSelected = [];
  wfmSyncSelection();
}

/** Every visible file -- offered only when the page's input is 'multiple'. */
function wfmSelectAllVisible() {
  if (!pendingMultiple) return;
  const next = [];
  wfmEachRow((li) => {
    if (li.getAttribute('data-type') !== 'file') return;
    next.push({
      path: li.getAttribute('data-path'),
      name: li.getAttribute('data-name'),
      size: Number(li.getAttribute('data-size') || 0),
    });
  });
  wfmSelected = next;
  wfmSyncSelection();
}

/** Walk the rows on screen. (No querySelectorAll: the unit harness lacks it.) */
function wfmEachRow(fn) {
  if (!wfmList) return;
  const kids = wfmList.children || [];
  for (let i = 0; i < kids.length; i += 1) {
    const li = kids[i];
    if (li && li.getAttribute && li.getAttribute('data-path') !== null) fn(li);
  }
}

/** Paint the selected rows and the footer, without rebuilding the tree. */
function wfmSyncSelection() {
  wfmEachRow((li) => {
    if (li.getAttribute('data-type') !== 'file') return;
    const on = wfmIsPicked(li.getAttribute('data-path'));
    li.className = 'wfm-file' + (on ? ' sel' : '');
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    const box = li.querySelector('.dcheck');
    if (box) box.checked = on;
  });
  const n = wfmSelected.length;
  if (wfmSelect) {
    wfmSelect.disabled = n === 0;
    wfmSelect.textContent = n > 1 ? 'Select (' + n + ')' : 'Select';
  }
  if (wfmCount) wfmCount.textContent = n ? (n === 1 ? '1 selected' : n + ' selected') : '';
  if (wfmClear) wfmClear.hidden = n === 0;
  if (wfmDelSel) wfmDelSel.hidden = n === 0;
  // "Select All" is a promise only a 'multiple' input can keep.
  if (wfmAll) wfmAll.hidden = !pendingMultiple;
}

// ── Reading the tree ─────────────────────────────────────────────────────────

/** Fetch one folder's listing (cached, so re-rendering on expand is free). */
function wfmFetchFolder(rel, force) {
  const key = rel || '';
  if (!workflowId) return Promise.resolve([]);
  if (!force && wfmFolders[key]) return Promise.resolve(wfmFolders[key]);
  return wfmFetch(wfmBase() + '?path=' + encodeURIComponent(key))
    .then((d) => {
      wfmFolders[key] = d.entries || [];
      return wfmFolders[key];
    })
    .catch((e) => {
      wfmSay((e && e.message) || 'Could not read the workflow files.', true);
      // An empty array, not a missing key: the row then says "empty" rather
      // than spinning for a listing that is never coming.
      wfmFolders[key] = wfmFolders[key] || [];
      return wfmFolders[key];
    });
}

function wfmExpand(rel) {
  wfmOpen[rel || ''] = true;
  wfmRender();
  return wfmFetchFolder(rel).then(() => wfmRender());
}

function wfmCollapse(rel) {
  delete wfmOpen[rel || ''];
  wfmRender();
}

function wfmToggleFolder(rel) {
  if (wfmOpen[rel || '']) wfmCollapse(rel);
  else void wfmExpand(rel);
}

/**
 * Re-read every folder that is currently open, keeping the shape of the tree
 * and the selection. This is what Refresh does, and what every mutation does
 * afterwards, so a rename never collapses the branch it happened in.
 */
function wfmRefresh() {
  if (!workflowId) return wfmEnsureLoaded();
  wfmSay('', false);
  const keys = Object.keys(wfmOpen);
  return keys.reduce(
    (chain, k) => chain.then(() => wfmFetchFolder(k, true)),
    Promise.resolve(),
  ).then(() => {
    // A file that was deleted elsewhere must not stay selected: the /use
    // would fail with a 404 the operator cannot explain.
    const live = {};
    Object.keys(wfmFolders).forEach((k) => {
      (wfmFolders[k] || []).forEach((e) => { live[e.path] = e.type; });
    });
    wfmSelected = wfmSelected.filter((x) => live[x.path] === 'file');
    wfmRender();
  });
}

/**
 * Tell the server this browser is working FOR this workflow, so what it
 * downloads is filed under downloads/ and what the operator sends under
 * uploads/. Fired once the desktop is up (the 'connect' event), because that
 * is the first moment a transfer can happen. Best-effort and idempotent: a
 * refusal here must not stop the page, and a re-bind is what the server
 * expects when the operator moves between workflows.
 */
function bindWorkflow() {
  // Only a workflow NAMED IN THE URL is bound here: that is the operator
  // saying "this browser works for this workflow". Without one the server
  // already holds whatever binding it has, and the workspace reads it back
  // (resolveWorkflowId) when it is opened -- binding the server to its own
  // answer would be a round trip that changes nothing, and connecting must
  // not fetch anything on its own.
  if (!workflowId) return Promise.resolve(false);
  return bindResolved();
}
function bindResolved() {
  return wfmFetch(wfmBase() + '/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'local' }),
  })
    .then((d) => { wfmBound = !!(d && d.bound); return wfmBound; })
    .catch(() => { wfmBound = false; return false; });
}

// ── Navigation ───────────────────────────────────────────────────────────────

/** Root the tree at a folder (or at the workspace with ''), and read it. */
function wfmGoTo(rel) {
  wfmRoot = rel || '';
  wfmOpen[wfmRoot] = true;
  wfmCloseMenu();
  wfmRender();
  return wfmFetchFolder(wfmRoot).then(() => wfmRender());
}

/** One level up, which is what the Back arrow in the breadcrumb does. */
function wfmBack() {
  if (!wfmRoot) return Promise.resolve();
  return wfmGoTo(wfmParentOf(wfmRoot));
}

/** One crumb: a button that goes to 'rel'; the last one is the current folder. */
function wfmCrumb(label, rel, current) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dcrumb' + (current ? ' on' : '');
  b.textContent = label;
  b.setAttribute('data-rel', rel);
  if (current) b.setAttribute('aria-current', 'location');
  else b.addEventListener('click', (ev) => {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    void wfmGoTo(rel);
  });
  return b;
}

/** Draw the breadcrumb for wfmRoot: Back arrow, workspace, then every folder. */
function wfmRenderCrumbs() {
  if (!wfmCrumbs) return;
  wfmCrumbs.textContent = '';
  const segs = wfmRoot ? wfmRoot.split('/') : [];
  if (segs.length) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'dcrumb dback';
    back.setAttribute('aria-label', 'Back');
    back.title = 'Back';
    back.innerHTML = wfmGlyph('arrow-left');
    back.addEventListener('click', (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      void wfmBack();
    });
    wfmCrumbs.appendChild(back);
  }
  wfmCrumbs.appendChild(wfmCrumb('Workflow', '', !segs.length));
  let acc = '';
  segs.forEach((s, i) => {
    acc = acc ? acc + '/' + s : s;
    const sep = document.createElement('span');
    sep.className = 'dcrumb-sep';
    sep.textContent = '/';
    wfmCrumbs.appendChild(sep);
    wfmCrumbs.appendChild(wfmCrumb(s, acc, i === segs.length - 1));
  });
}

/** Load the tree when the pane is shown. Without a workflow, say why not. */
function wfmEnsureLoaded() {
  return resolveWorkflowId().then((id) => {
    if (!id) {
      wfmList.textContent = '';
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = NO_WORKFLOW_TEXT;
      wfmList.appendChild(li);
      if (wfmTotal) wfmTotal.textContent = '';
      if (wfmCrumbs) wfmCrumbs.textContent = '';
      wfmSay('', false);
      return null;
    }
    wfmLoadedOnce = true;
    return wfmRefresh();
  });
}

// ── Drawing the tree ─────────────────────────────────────────────────────────

/** An inline SVG glyph for a row; this page cannot load icons.js. */
function wfmGlyph(kind) {
  const open = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const shut = '</svg>';
  const d = {
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v6"/><path d="M9 13.5h6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    'file-plus': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11.5v6"/><path d="M9 14.5h6"/>',
    upload: '<path d="M12 19V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/><path d="M4 20.5h16"/>',
    'rotate-cw': '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10h-5.5"/>',
    'arrow-left': '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.6H19a2 2 0 0 1 2 2V11H6.5a2 2 0 0 0-1.9 1.4L3 18z"/><path d="M3 18a2 2 0 0 0 2 2h13a2 2 0 0 0 1.9-1.4L22 11"/>',
    pencil: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m13.5 6.5 3 3"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    'more-horizontal': '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  };
  return open + (d[kind] || d.file) + shut;
}

/**
 * One row.
 *
 * Structure mirrors upload-ui/: a checkbox that only appears on hover or when
 * picked, a chevron for folders, the type glyph, the name, and the meta on the
 * far end (item count for a folder, size for a file). Depth is an inline
 * padding rather than nested lists, because a flat list is what lets one pass
 * over the children repaint the whole selection.
 */
function wfmRow(entry, depth) {
  const isDir = entry.type === 'dir';
  const isSys = isDir && !!entry.system;
  const li = document.createElement('li');
  li.className = isDir ? ('wfm-dir' + (isSys ? ' wfm-sys' : '')) : 'wfm-file';
  li.setAttribute('role', isDir ? 'treeitem' : 'option');
  li.setAttribute('data-path', entry.path);
  li.setAttribute('data-name', entry.name);
  li.setAttribute('data-size', String(entry.size || 0));
  li.setAttribute('data-type', isDir ? 'dir' : 'file');
  if (isSys) li.setAttribute('data-system', 'true');
  li.style.paddingLeft = (5 + depth * 14) + 'px';

  if (isDir) {
    li.setAttribute('aria-expanded', wfmOpen[entry.path] ? 'true' : 'false');
    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'dchev';
    chev.tabIndex = -1;
    chev.setAttribute('aria-label', 'Expand or collapse');
    chev.innerHTML = wfmGlyph(wfmOpen[entry.path] ? 'chevron-down' : 'chevron-right');
    chev.addEventListener('click', (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      wfmToggleFolder(entry.path);
    });
    li.appendChild(chev);
  } else {
    // The checkbox is the multi-select affordance from the reference UI. It
    // exists for a single-file input too, where it behaves as a radio.
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'dcheck';
    box.checked = wfmIsPicked(entry.path);
    box.setAttribute('aria-label', 'Select this file');
    box.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); });
    box.addEventListener('change', () => wfmPick(entry, box.checked));
    li.appendChild(box);
  }

  const ico = document.createElement('span');
  ico.className = 'wfm-ico';
  ico.innerHTML = wfmGlyph(isDir ? 'folder' : 'file');
  li.appendChild(ico);

  const name = document.createElement('span');
  name.className = 'wfm-name';
  // textContent, never markup: the name came from a filesystem the operator
  // shares with uploads they did not necessarily inspect.
  name.textContent = entry.name;
  li.appendChild(name);

  if (isSys) {
    // Part of the workflow, not the operator's own: uploads/ is what a
    // page's file input is answered from, downloads/ is what the browser
    // brought back. Drawn apart so nobody wonders why Rename is missing.
    const tag = document.createElement('span');
    tag.className = 'wfm-sys-tag';
    tag.textContent = entry.name === WFM_UPLOADS ? 'input' : 'output';
    tag.title = entry.name === WFM_UPLOADS
      ? 'Files here are what a page\u2019s file input is answered with, and where Upload from Computer keeps its copy.'
      : 'Files the browser downloads while working for this workflow are filed here.';
    li.appendChild(tag);
  }

  const meta = document.createElement('span');
  meta.className = 'wfm-meta';
  if (isDir) {
    const kids = wfmFolders[entry.path];
    meta.textContent = kids ? (kids.length === 1 ? '1 item' : kids.length + ' items') : '';
  } else {
    meta.textContent = humanSize(entry.size);
  }
  li.appendChild(meta);

  // Overflow: the same actions as the context menu, for a pointer that has no
  // right button (a touch screen) and for discoverability.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'dmore';
  more.tabIndex = -1;
  more.setAttribute('aria-label', 'Actions for ' + entry.name);
  more.innerHTML = wfmGlyph('more-horizontal');
  more.addEventListener('click', (ev) => {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const r = more.getBoundingClientRect ? more.getBoundingClientRect() : { left: 0, bottom: 0 };
    wfmOpenMenu(entry, r.left, r.bottom);
  });
  li.appendChild(more);

  li.addEventListener('click', () => {
    if (isDir) { wfmToggleFolder(entry.path); return; }
    // Only FILES can be selected: a folder cannot go into an input.
    wfmPick(entry);
  });
  li.addEventListener('dblclick', () => {
    // A folder opens INTO (the breadcrumb takes it), a file is handed over.
    if (isDir) { void wfmGoTo(entry.path); return; }
    wfmPick(entry, true);
    wfmUse();
  });
  li.addEventListener('contextmenu', (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (ev && ev.stopPropagation) ev.stopPropagation();
    wfmOpenMenu(entry, ev ? ev.clientX : 0, ev ? ev.clientY : 0);
  });
  return li;
}

/** A placeholder row: "empty", or "loading", inside an expanded folder. */
function wfmHintRow(text, depth) {
  const li = document.createElement('li');
  li.className = 'wfm-hint';
  li.style.paddingLeft = (5 + depth * 14) + 'px';
  li.textContent = text;
  return li;
}

/** Depth-first walk of the open folders, folders before files at each level. */
function wfmPaint(rel, depth, into) {
  const entries = wfmFolders[rel || ''];
  if (!entries) {
    into.appendChild(wfmHintRow('Loading\u2026', depth));
    return;
  }
  if (!entries.length) {
    into.appendChild(wfmHintRow(
      depth === 0 ? 'This folder is empty. Upload a file or create a folder.' : 'Empty',
      depth,
    ));
    return;
  }
  const dirs = entries.filter((e) => e.type === 'dir');
  const files = entries.filter((e) => e.type !== 'dir');
  const here = rel || '';
  dirs.concat(files).forEach((e) => {
    into.appendChild(wfmRow(e, depth));
    // Descend only into a child whose path really is BELOW this folder: a
    // listing naming a child with its parent's own path would otherwise
    // recurse until the stack ran out.
    const below = !here || (e.path && e.path.indexOf(here + '/') === 0);
    if (e.type === 'dir' && below && e.path !== here && wfmOpen[e.path]) wfmPaint(e.path, depth + 1, into);
  });
}

function wfmRender() {
  if (!wfmList) return;
  wfmList.textContent = '';
  wfmRenderCrumbs();
  wfmPaint(wfmRoot, 0, wfmList);
  const entries = wfmFolders[wfmRoot];
  const total = (entries || []).length;
  if (wfmTotal) {
    wfmTotal.textContent = !entries ? '' : (total ? (total === 1 ? '1 item' : total + ' items') : 'empty');
  }
  wfmSyncSelection();
}

// ── Mutations ────────────────────────────────────────────────────────────────
//
// Every one names a workflow-RELATIVE path the server itself returned, and
// every one ends in wfmRefresh(), so what is on screen is what is on the disk
// and not an optimistic guess that can drift.

/** window.prompt, guarded: the unit harness has no window dialogs. */
function ask(text, initial) {
  try { return (typeof prompt === 'function') ? prompt(text, initial || '') : null; }
  catch (e) { return null; }
}

function wfmNewFolder(inRel) {
  if (!wfmRequire()) return;
  const name = ask('New folder name:', '');
  if (!name) return;
  const into = inRel || '';
  wfmFetch(wfmBase() + '/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: into, name: name }),
  })
    .then(() => {
      // The new folder is inside 'into', so 'into' has to be open for it to be
      // visible at all -- otherwise the operator sees nothing happen.
      wfmOpen[into] = true;
      return wfmRefresh();
    })
    .catch((e) => wfmSay((e && e.message) || 'Could not create the folder.', true));
}

/**
 * Create an EMPTY file, through the endpoint made for it.
 *
 * This used to be a one-byte upload, because the storage refuses a zero-byte
 * upload (an empty upload is almost always a failed transfer). That was a
 * workaround: the operator asked for an empty file and got a newline. POST
 * /file makes a genuinely empty one.
 */
function wfmNewFile(inRel) {
  if (!wfmRequire()) return;
  const name = ask('New file name:', 'untitled.txt');
  if (!name) return;
  const into = inRel || '';
  wfmFetch(wfmBase() + '/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: into, name: name }),
  })
    .then(() => { wfmOpen[into] = true; return wfmRefresh(); })
    .catch((e) => wfmSay((e && e.message) || 'Could not create the file.', true));
}

/**
 * Rename IN PLACE, in the row itself.
 *
 * The reference UI edits the name where it stands rather than in a dialog,
 * which is also the only way to see the name next to its siblings while
 * choosing a new one. Enter commits, Escape cancels, blur commits.
 */
function wfmRename(entry) {
  if (entry.system) {
    wfmSay('The ' + entry.name + ' folder is part of the workflow and cannot be renamed.', true);
    return;
  }
  let li = null;
  wfmEachRow((row) => { if (!li && row.getAttribute('data-path') === entry.path) li = row; });
  const nameEl = li ? li.querySelector('.wfm-name') : null;
  if (!li || !nameEl || !li.replaceChild) {
    // No row on screen (a stale menu): fall back to a prompt rather than
    // silently doing nothing.
    const typed = ask('Rename to:', entry.name);
    if (typed && typed !== entry.name) wfmCommitRename(entry, typed);
    return;
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'drename';
  input.value = entry.name;
  input.setAttribute('aria-label', 'Rename to:');
  let done = false;
  function finish(commit) {
    if (done) return;
    done = true;
    const next = String(input.value || '').trim();
    // The row is known; no need to ask the input who its parent is.
    if (input.parent === li || input.parentNode === li) li.replaceChild(nameEl, input);
    if (commit && next && next !== entry.name) wfmCommitRename(entry, next);
  }
  input.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); });
  input.addEventListener('dblclick', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); });
  input.addEventListener('keydown', (ev) => {
    if (!ev) return;
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  li.replaceChild(input, nameEl);
  try { input.focus(); input.select(); } catch (e) { /* not focusable in the harness */ }
}

function wfmCommitRename(entry, name) {
  if (!wfmRequire()) return;
  wfmFetch(wfmBase() + '/rename', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: entry.path, name: name }),
  })
    .then(() => {
      // The path changed, so a selection or an expanded state keyed on the OLD
      // path is stale. Drop just that one rather than everything.
      wfmSelected = wfmSelected.filter((x) => x.path !== entry.path);
      if (wfmOpen[entry.path]) {
        delete wfmOpen[entry.path];
        wfmOpen[wfmParentOf(entry.path)] = true;
      }
      return wfmRefresh();
    })
    .catch((e) => wfmSay((e && e.message) || 'Could not rename.', true));
}

/**
 * Ask, in the drawer, with the name of the thing on screen.
 *
 * NOT window.confirm: a native dialog on this page steals focus from the
 * remote screen, and the page waiting for a file is BEHIND that screen. The
 * strip replaces any strip already up, so two Deletes in a row cannot leave
 * two questions queued against each other.
 */
function wfmConfirmStrip(question, onYes) {
  if (!wfmConfirm) { onYes(); return; }
  wfmConfirm.textContent = '';
  wfmConfirm.hidden = false;
  const text = document.createElement('span');
  text.className = 'dconfirm-text';
  text.textContent = question;
  wfmConfirm.appendChild(text);
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'fbtn';
  no.textContent = 'Cancel';
  no.addEventListener('click', () => { wfmConfirm.hidden = true; wfmConfirm.textContent = ''; });
  wfmConfirm.appendChild(no);
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'fbtn dyes';
  yes.textContent = 'Delete';
  yes.addEventListener('click', () => {
    wfmConfirm.hidden = true;
    wfmConfirm.textContent = '';
    onYes();
  });
  wfmConfirm.appendChild(yes);
}

function wfmDelete(entry) {
  if (!wfmRequire()) return;
  const isDir = entry.type === 'dir';
  if (entry.system) {
    wfmSay('The ' + entry.name + ' folder is part of the workflow and cannot be deleted.', true);
    return;
  }
  // Recursive deletion is EXPLICIT: the folder is named and the words
  // 'everything inside it' are on screen before anything is sent.
  wfmConfirmStrip(
    (isDir ? 'Delete this folder and everything inside it? ' : 'Delete this file? ') + entry.name,
    () => {
      wfmFetch(wfmBase() + '?path=' + encodeURIComponent(entry.path) + (isDir ? '&recursive=1' : ''), {
        method: 'DELETE',
      })
        .then(() => {
          wfmSelected = wfmSelected.filter((x) => x.path !== entry.path);
          delete wfmOpen[entry.path];
          delete wfmFolders[entry.path];
          return wfmRefresh();
        })
        .catch((e) => wfmSay((e && e.message) || 'Could not delete.', true));
    },
  );
}

/** Delete every picked file, behind one confirmation naming the count. */
function wfmDeleteSelected() {
  if (!wfmSelected.length || !wfmRequire()) return;
  const victims = wfmSelected.slice();
  wfmConfirmStrip('Delete the selected files? (' + victims.length + ')', () => {
    victims.reduce(
      (chain, v) => chain.then(() => wfmFetch(wfmBase() + '?path=' + encodeURIComponent(v.path), { method: 'DELETE' })
        .catch((e) => wfmSay((e && e.message) || 'Could not delete.', true))),
      Promise.resolve(),
    ).then(() => { wfmSelected = []; return wfmRefresh(); });
  });
}

/** Upload from the operator's computer INTO a named workflow folder. */
function wfmUploadFiles(list) {
  if (!list.length) return Promise.resolve();
  if (!wfmRequire()) return Promise.resolve();
  const into = wfmUploadInto || '';
  wfmUploadInto = '';
  wfmSay('Uploading ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '\u2026', false);
  return list.reduce(
    (chain, file) => chain.then(() => wfmFetch(
      wfmBase() + '/upload?path=' + encodeURIComponent(into)
        + '&name=' + encodeURIComponent(file.name || 'file'),
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
    )),
    Promise.resolve(),
  )
    // AFTER the refresh: wfmRefresh() clears the note line first, so a receipt
    // written before it was wiped before anyone could read it.
    .then(() => { wfmOpen[into] = true; return wfmRefresh().then(() => wfmSay('Uploaded.', false)); })
    .catch((e) => {
      const msg = (e && e.message) || 'The upload failed.';
      return wfmRefresh().then(() => wfmSay(msg, true));
    });
}

/**
 * Where the toolbar's Upload goes: the folder on screen, or -- at the
 * workspace root -- uploads/, because that is the folder the contract says
 * staged input lives in. A file dropped in the root would still work for a
 * hand-over, but would not be where a node looking for inputs expects it.
 */
function wfmUploadTarget() {
  return wfmRoot || WFM_UPLOADS;
}

/** Start the operator's own native picker, targeting 'into'. */
function wfmAskForUpload(into) {
  if (!wfmRequire()) return;
  wfmUploadInto = into || '';
  // The operator's own click: the picker opens here without any dependency on
  // a remote gesture.
  try { wfmUp.click(); } catch (e) { /* nothing to do */ }
}

// ── The context menu ─────────────────────────────────────────────────────────
//
// ONE floating menu (#dmenu), positioned at the pointer, REPLACED rather than
// stacked. Always present in the markup and toggled with 'hidden'.

function wfmCloseMenu() {
  if (!wfmMenu) return;
  wfmMenu.hidden = true;
  wfmMenu.textContent = '';
}

function wfmMenuItem(label, icon, fn, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dmi' + (danger ? ' danger' : '');
  const i = document.createElement('span');
  i.className = 'dmi-ico';
  i.innerHTML = wfmGlyph(icon);
  b.appendChild(i);
  const s = document.createElement('span');
  s.textContent = label;
  b.appendChild(s);
  b.addEventListener('click', (ev) => {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    wfmCloseMenu();
    fn();
  });
  wfmMenu.appendChild(b);
}

function wfmMenuSep() {
  const d = document.createElement('div');
  d.className = 'dmi-sep';
  wfmMenu.appendChild(d);
}

/**
 * The menu for a row, or for the empty space when 'entry' is null.
 *
 *   Folder: Open - New File - New Folder - Upload Here - Rename - Delete
 *   System: Open - New File - New Folder - Upload Here      (uploads/, downloads/)
 *   File:   Select - Rename - Delete
 *   Root:   New Folder - New File - Upload File - Refresh   (into the CURRENT folder)
 *
 * "Open" on a folder roots the tree THERE (the breadcrumb is the way back);
 * the chevron on the row expands it in place instead.
 *
 * "Open / Preview" is deliberately NOT offered for a file: this page has no
 * viewer and no download route for a workflow file, and a menu entry that
 * does nothing is worse than one that is absent.
 */
function wfmOpenMenu(entry, x, y) {
  if (!wfmMenu) return;
  wfmCloseMenu();
  if (!entry) {
    wfmMenuItem('New Folder', 'folder-plus', () => wfmNewFolder(wfmRoot));
    wfmMenuItem('New File', 'file-plus', () => wfmNewFile(wfmRoot));
    wfmMenuItem('Upload File', 'upload', () => wfmAskForUpload(wfmUploadTarget()));
    wfmMenuSep();
    wfmMenuItem('Refresh', 'rotate-cw', () => { void wfmRefresh(); });
  } else if (entry.type === 'dir') {
    wfmMenuItem('Open', 'folder-open', () => { void wfmGoTo(entry.path); });
    wfmMenuSep();
    wfmMenuItem('New File', 'file-plus', () => wfmNewFile(entry.path));
    wfmMenuItem('New Folder', 'folder-plus', () => wfmNewFolder(entry.path));
    wfmMenuItem('Upload Here', 'upload', () => wfmAskForUpload(entry.path));
    if (!entry.system) {
      wfmMenuSep();
      wfmMenuItem('Rename', 'pencil', () => wfmRename(entry));
      wfmMenuItem('Delete', 'trash', () => wfmDelete(entry), true);
    }
  } else {
    wfmMenuItem('Select', 'check', () => wfmPick(entry, true));
    wfmMenuSep();
    wfmMenuItem('Rename', 'pencil', () => wfmRename(entry));
    wfmMenuItem('Delete', 'trash', () => wfmDelete(entry), true);
  }
  // Kept inside the viewport: a menu that opens off the bottom edge is a menu
  // the operator cannot press.
  const vw = (window.innerWidth || 1200);
  const vh = (window.innerHeight || 800);
  const left = Math.max(4, Math.min(x || 0, vw - 190));
  const top = Math.max(4, Math.min(y || 0, vh - 220));
  wfmMenu.style.left = left + 'px';
  wfmMenu.style.top = top + 'px';
  wfmMenu.hidden = false;
}

// ── Handing the file(s) over ─────────────────────────────────────────────────

/**
 * Hand the selected workflow file(s) to the page that is asking.
 *
 * The body names the CHOOSER and a workflow-relative PATH. The server resolves
 * that inside the workflow root and gives the real Chromium the file through
 * the same FileChooser.setFiles() the upload path uses (RemoteFileChooser).
 *
 * ONE request, however many files: the Local Browser's chooser answers a dialog
 * BY ID and forgets it on the first answer, so a second request for the same
 * id would be refused. Several files therefore travel as 'paths' alongside the
 * first 'path', and the server hands the list over in one setFiles().
 */
function wfmUse() {
  if (!wfmSelected.length || !wfmRequire()) return;
  if (!pendingId) {
    wfmSay('No page is asking for a file right now. Press the page\u2019s own Choose/Browse button first, then Select.', true);
    return;
  }
  const chosen = wfmSelected.slice();
  if (pendingAccept) {
    const bad = chosen.filter((c) => !wfmAccepts(pendingAccept, c.name));
    if (bad.length) {
      wfmSay('The page only accepts ' + pendingAccept + ' \u2014 not ' + bad.map((b) => b.name).join(', '), true);
      return;
    }
  }
  const id = pendingId;
  wfmSelect.disabled = true;
  wfmSay('Sending ' + chosen.map((c) => c.name).join(', ') + '\u2026', false);
  const body = chosen.length === 1
    ? { path: chosen[0].path, chooserId: id }
    : { path: chosen[0].path, paths: chosen.map((c) => c.path), chooserId: id };
  wfmFetch(wfmBase() + '/use', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(() => {
      clearPending();
      wfmSelected = [];
      wfmSyncSelection();
      // Receipt first, then shut: noteInPanel() raises the drawer on the shelf,
      // and the operator -- who was IN the drawer and pressed Select -- wants
      // the page back, not a pane telling them what they just did. The line
      // waits on the shelf for the next time Downloads is opened.
      noteInPanel('uphint', 'Sent to the site: ' + chosen.map((c) => c.name).join(', '));
      closeDrawer();
    })
    .catch((e) => {
      wfmSelect.disabled = false;
      wfmSay((e && e.message) || 'The file could not be sent.', true);
    });
}

// ── Wiring ───────────────────────────────────────────────────────────────────

if (wfmList) {
  // The toolbar acts on the folder on screen (the breadcrumb), not always the root.
  document.getElementById('wfmnew').addEventListener('click', () => wfmNewFolder(wfmRoot));
  document.getElementById('wfmnewfile').addEventListener('click', () => wfmNewFile(wfmRoot));
  document.getElementById('wfmupload').addEventListener('click', () => wfmAskForUpload(wfmUploadTarget()));
  document.getElementById('wfmrefresh').addEventListener('click', () => { void wfmRefresh(); });
  document.getElementById('wfmmore').addEventListener('click', (ev) => {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const b = document.getElementById('wfmmore');
    const r = b.getBoundingClientRect ? b.getBoundingClientRect() : { left: 0, bottom: 0 };
    wfmOpenMenu(null, r.left, r.bottom);
  });
  wfmUp.addEventListener('change', () => {
    const list = Array.from(wfmUp.files || []);
    wfmUp.value = '';
    void wfmUploadFiles(list);
  });
  wfmSelect.addEventListener('click', () => wfmUse());
  if (wfmAll) wfmAll.addEventListener('click', () => wfmSelectAllVisible());
  if (wfmClear) wfmClear.addEventListener('click', () => wfmClearSelection());
  if (wfmDelSel) wfmDelSel.addEventListener('click', () => wfmDeleteSelected());
  // A right-click on the empty space is the root's own menu, and a plain click
  // there clears the selection -- both from the reference UI.
  wfmList.addEventListener('contextmenu', (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    wfmOpenMenu(null, ev ? ev.clientX : 0, ev ? ev.clientY : 0);
  });
  wfmList.addEventListener('click', (ev) => {
    if (ev && ev.target === wfmList) wfmClearSelection();
  });
  // Any click outside the menu closes it.
  document.addEventListener('click', (ev) => {
    if (!wfmMenu || wfmMenu.hidden) return;
    let n = ev && ev.target;
    while (n) { if (n === wfmMenu) return; n = n.parentNode; }
    wfmCloseMenu();
  });
}

/** Raise the operator's OWN file dialog, filtered like the page's input. */
function openLocalPicker() {
  // Mirror the input's own accept/multiple, so the operator is not offered files
  // the page will reject -- and so a single-file input cannot be handed five.
  upInput.accept = pendingAccept;
  upInput.multiple = pendingMultiple;
  try { upInput.click(); } catch (e) { /* the button in the panel still works */ }
}

/** Hand uploaded tokens to the waiting page. */
function answerPending(id, tokens, names) {
  return fetch('/browser/real/chooser', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ id: id, tokens: tokens }),
    credentials: 'same-origin',
  })
    .then((r) => r.text().then((txt) => {
      let d = null;
      try { d = JSON.parse(txt); } catch (e) { /* not JSON: the status decides */ }
      if (!r.ok || !d || !d.success) {
        throw new Error((d && d.error) || 'The page stopped waiting for the file.');
      }
      return d;
    }))
    .then(() => {
      clearPending();
      noteInPanel('uphint', names.length === 1
        ? 'Sent to the site: ' + names[0]
        : 'Sent to the site: ' + names.join(', '));
      return null;
    })
    .catch((e) => {
      // The file IS on the server; only the hand-over failed. Saying which is
      // the difference between "pick it again" and "press the page button again".
      noteInPanel('rowerr', (e && e.message) ? e.message : 'The file could not be sent.');
      readyTokens = readyTokens.concat(tokens);
      readyNames  = readyNames.concat(names);
      clearPending();
      return null;
    });
}

/** Tell the server nobody is going to answer, so the page is released. */
function cancelPending(id) {
  clearPending();
  return fetch('/browser/real/chooser?id=' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'same-origin',
  }).catch(() => { /* the server times it out anyway */ });
}

function clearPending() {
  pendingId = '';
  pendingAccept = '';
  pendingMultiple = false;
  if (pendingRow) {
    pendingRow.remove();
    pendingRow = null;
  }
  // The source chooser that offerFile() raised for THIS request goes back to
  // the workspace with it; the drawer itself stays where the operator left it.
  hideSourceChooser();
  // And the tree's own "multiple"/"Select All" affordances follow the request.
  wfmSyncSelection();
}

/**
 * Deliver anything newly downloaded straight to the operator's machine.
 *
 * «کلیک روی Download → فایل مستقیماً روی Windows کاربر ذخیره شود ... نباید کاربر
 *  مجبور باشد ابتدا فایل را روی Server دانلود کند و بعد آن را جداگانه از Server
 *  دریافت کند» -- so a completed download is fetched and saved without anyone
 *  pressing a row. It goes through fetchDownload, which is what reads the name
 *  off the SERVED response (Content-Disposition, filename* preferred) rather
 *  than off the shelf row, so the name and extension are the website's own.
 *
 * MEASURED (tools/probe-auto-download.js) that this scales past one file:
 * BLOB_ANCHOR_DOWNLOADS_DELIVERED = 5/5 with names intact, so Chrome's
 * "multiple automatic downloads" gate does not block the blob+anchor route.
 */
function pollDownloads() {
  return refreshDownloads().then((rows) => {
    if (!rows) return null;
    let landed = false;
    rows.forEach((r) => {
      if (!r || !r.token) return;
      // In-flight and failed rows are not files yet. They stay unmarked so the
      // tick that sees them complete is the one that delivers them.
      if (r.state !== 'completed') return;
      if (delivered[r.token]) return;
      delivered[r.token] = true;
      // Seeding, not delivering: see the 'seeded' flag above.
      if (!seeded) return;
      landed = true;
      void fetchDownload(r, (message) => { noteInPanel('rowerr', message); });
      // The workflow's own copy is under downloads/ (WorkflowBinding). Say so
      // where the operator reads receipts, naming the folder in the tree.
      if (r.workflowPath) {
        noteInPanel('uphint', 'Downloaded: ' + r.name, 'Filed in Workflow Files under ' + wfmParentOf(r.workflowPath) + '/', { raise: false });
      }
    });
    seeded = true;
    // A download that was just filed under downloads/ must show up in the
    // tree without the operator pressing Refresh -- but only re-read an OPEN
    // workspace, never one the operator has not asked for.
    if (landed && drawerOpen() && drawerPane === 'files' && wfmLoadedOnce) void wfmRefresh();
    return null;
  });
}

// 'Try again' must START, not merely reconnect -- see startThenConnect().
retry.addEventListener('click', () => { void startThenConnect(); });

// And so must the first load. This page is reached by a tab that was opened for
// the operator (the crosshair) or by the operator following the "Retry" link on
// the failure page; in both cases arriving here means "I want the browser up",
// and the endpoint is idempotent, so an already-running stack is unaffected.
void startThenConnect();
</script>
</body>
</html>`;
}
