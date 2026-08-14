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

  /* ── The file bar ──────────────────────────────────────────────────────
     Downloads land on the SERVER's disk and uploads have to get onto it, so
     both need a control that is NOT inside the remote screen. It is docked
     bottom-right and collapses to a single small button, because the point of
     this page is to be a browser, not a browser with a panel bolted on. */
  #files {
    position: fixed; right: 12px; bottom: 12px; z-index: 5;
    font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #e6e6ee; display: flex; flex-direction: column;
    align-items: flex-end; gap: 8px;
    /* The screen owns the pointer; only the bar's own controls take events. */
    pointer-events: none;
  }
  #files > * { pointer-events: auto; }
  #files[hidden] { display: none; }
  /* THE TWO-BUTTON PROBLEM
     ----------------------
     The operator's report: «قسمت آپلود و فایل ها هم اصلا خوب نیست ui/ux خوبی
     نداره باید بهتر بشه و کنترل بیشتری داشته باشیم».

     Two bare buttons labelled "Upload" and "Files" sat side by side with equal
     weight, and neither said what it would do. "Files" sounds like a file
     manager but only lists downloads; "Upload" opens a local picker whose
     result is not a transfer but a file PARKED ready for the page to ask for
     it — the single most surprising thing about this page, and nothing on
     screen said it. There was also no count, so "did my download arrive?" could
     only be answered by opening the panel.

     Now: ONE primary control that carries a live count, with Upload demoted to
     an icon-and-word secondary, and the explanation moved into the panel where
     there is room to write it. */
  .fbtn {
    font: inherit; color: #e6e6ee; background: rgba(38,38,46,.92);
    border: 1px solid #4a4a55; border-radius: 6px;
    padding: 6px 11px; cursor: pointer; backdrop-filter: blur(3px);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .fbtn:hover { background: rgba(58,58,68,.96); }
  .fbtn:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 1px; }
  /* The count rides on the Files button so the answer to "did it arrive?" is
     visible without opening anything. Hidden at zero rather than showing a 0,
     which reads as a broken badge. */
  #dlcount {
    background: #3d6ae0; color: #fff; border-radius: 9px;
    padding: 0 6px; font-size: 11px; font-weight: 600;
  }
  #dlcount[hidden] { display: none; }
  #panel {
    width: 22rem; max-height: 17rem; overflow-y: auto;
    background: rgba(30,30,37,.96); border: 1px solid #43434e;
    border-radius: 8px; padding: 9px 10px;
    box-shadow: 0 6px 22px rgba(0,0,0,.45);
  }
  #panel[hidden] { display: none; }
  #panel h4 { margin: 0 0 7px; font-size: 12px; font-weight: 600; color: #b9b9c6; }
  /* What the Upload button actually does, said once, where it can be read.
     Docked at the top of the panel because it explains the control above it. */
  .fhelp {
    margin: 0 0 8px; padding: 6px 8px; border-radius: 5px;
    background: rgba(61,106,224,.12); border-left: 2px solid #3d6ae0;
    color: #b9b9c6;
  }
  #dls { list-style: none; margin: 0; padding: 0; }
  #dls li {
    display: flex; align-items: center; gap: 7px;
    padding: 4px 0; border-top: 1px solid #38383f;
  }
  #dls li:first-child { border-top: 0; }
  #dls a { color: #8fb6ff; text-decoration: none; overflow-wrap: anywhere; flex: 1 1 auto; }
  #dls a:hover { text-decoration: underline; }
  .sz { color: #8b8b98; flex: none; }
  .empty { color: #8b8b98; }
  /* Remove: the «کنترل بیشتر» the operator asked for. Deliberately quiet until
     hovered — it deletes the file from the server, so it must not sit at the
     same visual weight as the link that merely fetches it. It is LAST in the
     row, after the size, so a mis-aimed click lands on nothing. */
  .del {
    font: inherit; color: #8b8b98; background: none; border: 0;
    padding: 0 2px; cursor: pointer; flex: none; line-height: 1;
  }
  .del:hover { color: #ff9d9d; }
  .del:focus-visible { outline: 1px solid #ff9d9d; outline-offset: 1px; }
  /* A failure has to be readable ON the row it belongs to: this page has no
     toast, and the operator's report was that a click did nothing at all. */
  .rowerr { color: #ff9d9d; flex-basis: 100%; padding: 2px 0 0; }
  #dls li { flex-wrap: wrap; }
  .uphint { color: #9fe0b0; display: block; }
  .uphint .sub { color: #8b8b98; padding-top: 2px; }
  #up { display: none; }
</style>
</head>
<body>
<div id="screen"></div>
<div id="files" hidden>
  <div id="panel" hidden>
    <h4>Files on the server</h4>
    <!-- The one thing about this page that surprises everybody: a file you send
         is not delivered anywhere, it WAITS for the page to ask for it. Said
         here, in the panel, because there is no room for it on a button — and
         not saying it anywhere is why the two buttons read as guesswork. -->
    <p class="fhelp">Downloads from the remote browser land here. A file you send waits here too, and is handed over automatically the moment a page asks for one &mdash; you never type its name.</p>
    <ul id="dls"><li class="empty">Nothing downloaded yet.</li></ul>
  </div>
  <div style="display:flex; gap:8px">
    <button class="fbtn" id="upbtn" type="button" title="Choose a file on your machine, ready for the page to ask for it">&#8593; Send a file</button>
    <!-- The count rides on this button so "did my download arrive?" is answered
         without opening anything. #dlcount is a CHILD span, so writing the
         button's own textContent would destroy it — nothing does, and
         popup-style label writing is confined to #upbtn. -->
    <button class="fbtn" id="dlbtn" type="button" title="Show the files on the server">Files <span id="dlcount" hidden></span></button>
  </div>
  <input id="up" type="file" multiple>
</div>
<div id="note">
  <div class="spin" id="spin"></div>
  <div id="msg">Starting Chromium&hellip;</div>
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
// Declared up here with the other elements, not next to the file-bar code that
// uses it, because connect() runs during the module body and would otherwise
// read it inside its temporal dead zone.
const filesEl = document.getElementById('files');

/*
 * The Send button's resting label, in ONE place.
 *
 * This button rewrites its own textContent to report progress ('Uploading…',
 * 'Uploaded', 'Upload failed') and then has to put itself back. That reset
 * string and the label in the markup above are the same label, so hardcoding it
 * in both places means renaming the button in the HTML silently renames it again
 * the first time it is used — the button would read 'Send a file' until the
 * first upload and 'Upload' forever after.
 */
const UP_IDLE = '\u2191 Send a file';

const qs = new URLSearchParams(location.search);

/** Show a status message. 'busy' decides spinner vs. retry button. */
function show(text, busy) {
  msg.textContent = text;
  spin.hidden  = !busy;
  retry.hidden = busy;
  note.hidden  = false;
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
async function startThenConnect() {
  show('Starting Chromium\\u2026', true);
  try {
    const r = await fetch('/browser/real/open', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: '{}',
      credentials: 'same-origin',
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.success) {
      // Show the SERVER's own reason. It is the one that names the missing
      // package, and a generic "could not start" would throw that away.
      const why = (j && j.error) || ('HTTP ' + r.status);
      show('Could not start the remote browser: ' + why, false);
      return;
    }
  } catch (e) {
    show('Could not reach the server to start the remote browser: '
      + ((e && e.message) || 'network error'), false);
    return;
  }
  connect();
}

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
    // Only once there is a desktop to exchange files WITH. Showing the bar over
    // the "Starting Chromium..." spinner would offer an upload with nowhere to
    // go, and a download list that cannot be populated.
    filesEl.hidden = false;
    // And only now start watching for files moving in either direction: before
    // the desktop is up there is no page that can ask for a file and nothing
    // that can have downloaded one.
    startWatching();
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
//   Files   lists what the remote browser downloaded, each row linking to
//           /browser/downloads/<token>, which serves the bytes with the name
//           the file was actually given (see RemoteDownloads).
//   Upload  puts a local file on the server so the remote browser's file
//           chooser can pick it up.
//
// These call /browser/*, which the desktop session cookie does NOT cover: that
// cookie is deliberately scoped to Path=/desktop. The page URL's own api_key is
// the credential here, exactly as it is for the page itself.
const panel   = document.getElementById('panel');
const dls     = document.getElementById('dls');
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

function renderDownloads(rows) {
  dls.textContent = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing downloaded yet.';
    dls.appendChild(li);
    return;
  }
  rows.forEach((r) => {
    const li = document.createElement('li');
    if (r.state === 'completed') {
      const a = document.createElement('a');
      // href='' plus preventDefault, not a real link: the transfer goes through
      // fetchDownload so the key travels in a header and a failure can be read
      // out loud. The href is kept only so this looks and focuses like a link.
      a.href = downloadHref(r.token, false);
      a.setAttribute('download', r.name);
      // textContent, never innerHTML: the name came from a remote server's
      // Content-Disposition and putting it into markup would be an injection.
      a.textContent = r.name;
      a.addEventListener('click', (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        const note = li.querySelector('.rowerr');
        if (note) note.remove();
        void fetchDownload(r, (message) => {
          // The reason belongs on the ROW that failed. A toast this page does
          // not have, and a silent failure is what the operator reported.
          const err = document.createElement('div');
          err.className = 'rowerr';
          err.textContent = message;
          li.appendChild(err);
        });
      });
      li.appendChild(a);
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = humanSize(r.size);
      li.appendChild(sz);
      // Remove, LAST in the row and appended after the size on purpose: the
      // anchor has to stay the row's first child (it is what a click on the name
      // must hit), and a destructive control sitting next to a fetch link wants
      // distance from it.
      li.appendChild(deleteButton(r, li));
    } else {
      // A failed or in-flight row must SAY so rather than offer a dead link.
      li.className = 'empty';
      li.textContent = r.name + ' — ' +
        (r.state === 'failed' ? (r.error || 'failed') : 'downloading…');
      // A failed row is still a row the operator wants gone — arguably more so.
      // An in-flight one is not: deleting bytes mid-write would leave the shelf
      // describing a file that is still being written.
      if (r.state === 'failed') li.appendChild(deleteButton(r, li));
    }
    dls.appendChild(li);
  });
}

/**
 * The per-row Remove control — the «کنترل بیشتر» the operator asked for.
 *
 * This DELETES THE FILE from the server (DELETE /browser/real/downloads/:token
 * removes the bytes and the row together), so it is not a hide button and must
 * never behave like one. Two consequences, both deliberate:
 *
 *   - The row is not removed optimistically. If the delete fails the file is
 *     still there, and a row that vanished anyway would leave the operator
 *     believing they had cleaned up something they had not.
 *   - The whole list is re-rendered from the server's answer rather than patched
 *     locally, so what is on screen is what is on disk.
 */
function deleteButton(row, li) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  // A cross, not the word "Delete": the row is already crowded with a name that
  // can be long, and the title carries the meaning for anyone hovering or using
  // a screen reader.
  del.textContent = '\u00d7';
  del.title = 'Delete this file from the server';
  del.setAttribute('aria-label', 'Delete ' + row.name + ' from the server');
  del.addEventListener('click', () => {
    const stale = li.querySelector('.rowerr');
    if (stale) stale.remove();
    del.disabled = true;
    fetch('/browser/real/downloads/' + encodeURIComponent(row.token), {
      method: 'DELETE',
      headers: authHeaders(),
      credentials: 'same-origin',
    })
      .then((res) => res.json().catch(() => ({})).then((body) => ({ res: res, body: body })))
      .then((out) => {
        if (!out.res.ok || !out.body || out.body.success !== true) {
          throw new Error((out.body && out.body.error) || 'The file could not be deleted.');
        }
        // Server-truth, not a local splice.
        renderDownloads(out.body.downloads || []);
        setDownloadCount((out.body.downloads || []).length);
      })
      .catch((e) => {
        del.disabled = false;
        const err = document.createElement('div');
        err.className = 'rowerr';
        err.textContent = (e && e.message) ? e.message : 'The file could not be deleted.';
        li.appendChild(err);
      });
  });
  return del;
}

/**
 * The badge on the Files button.
 *
 * Hidden at zero rather than showing '0': a badge reading zero looks like a
 * broken counter, and the point of the badge is to answer "did my download
 * arrive?" without opening the panel.
 */
function setDownloadCount(n) {
  const badge = document.getElementById('dlcount');
  if (!badge) return;
  badge.textContent = n > 0 ? String(n) : '';
  badge.hidden = !(n > 0);
}

/**
 * Read the shelf. Returns the rows, so the watcher can act on them.
 *
 * 'quiet' skips the re-render. The watcher runs every WATCH_MS and rebuilding
 * the list that often would reset the scroll position of a panel the operator
 * may be reading, and discard a per-row error message they have not read yet.
 * The panel is re-rendered when it is OPENED, which is when it is looked at.
 */
function refreshDownloads(quiet) {
  // The marker is for the READER of a log, not for the server, which ignores
  // unknown query parameters. A shelf endpoint that is hit every WATCH_MS looks
  // alarming in an access log until you can tell the background watch from the
  // operator actually opening the panel; this distinguishes them at a glance.
  return fetch('/browser/real/downloads' + (quiet ? '?watch=1' : ''), {
    headers: authHeaders(),
    credentials: 'same-origin',
  })
    .then((r) => r.json())
    .then((j) => {
      if (j && j.owner) shelfOwner = String(j.owner);
      const rows = (j && j.downloads) || [];
      if (!quiet) renderDownloads(rows);
      // The badge updates on the QUIET pass too, and that is the whole point of
      // it: the watcher already polls the shelf, so the count can appear while
      // the panel is shut. Only the list is skipped when quiet, because
      // re-rendering that would scroll a panel the operator is reading.
      setDownloadCount(rows.length);
      return rows;
    })
    .catch(() => {
      // The browser may not be up yet. The button can be pressed again, and the
      // watcher's next tick asks again by itself.
      return null;
    });
}

document.getElementById('dlbtn').addEventListener('click', () => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) void refreshDownloads();
});

document.getElementById('upbtn').addEventListener('click', () => upInput.click());

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

/** Put a line in the panel, and make sure the panel is where it can be read. */
function noteInPanel(className, text, sub) {
  const li = document.createElement('li');
  li.className = className;
  li.textContent = text;
  if (sub) {
    const extra = document.createElement('div');
    extra.className = 'sub';
    extra.textContent = sub;
    li.appendChild(extra);
  }
  dls.insertBefore(li, dls.firstChild || null);
  panel.hidden = false;
  return li;
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
  const btn = document.getElementById('upbtn');
  btn.textContent = 'Uploading…';
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
      if (answering && tokens.length) return answerPending(answering, tokens, done, btn);
      btn.textContent = 'Uploaded';
      readyTokens = readyTokens.concat(tokens);
      readyNames  = readyNames.concat(done);
      showUploadResult(done);
      return null;
    })
    .catch((e) => {
      btn.textContent = 'Upload failed';
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
    })
    // Whatever happened, the button must go back to being a button.
    .then(() => setTimeout(() => { btn.textContent = UP_IDLE; }, 2500));
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
    return answerPending(pendingId, tokens, names, document.getElementById('upbtn'));
  }

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

  // The attempt itself. It works while the click on the remote screen still
  // counts as activation; when it does not, the button above is right there.
  openLocalPicker();
  return null;
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
function answerPending(id, tokens, names, btn) {
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
      if (btn) btn.textContent = 'Sent';
      clearPending();
      noteInPanel('uphint', names.length === 1
        ? 'Sent to the site: ' + names[0]
        : 'Sent to the site: ' + names.join(', '));
      return null;
    })
    .catch((e) => {
      if (btn) btn.textContent = 'Upload failed';
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
  return refreshDownloads(true).then((rows) => {
    if (!rows) return null;
    rows.forEach((r) => {
      if (!r || !r.token) return;
      // In-flight and failed rows are not files yet. They stay unmarked so the
      // tick that sees them complete is the one that delivers them.
      if (r.state !== 'completed') return;
      if (delivered[r.token]) return;
      delivered[r.token] = true;
      // Seeding, not delivering: see the 'seeded' flag above.
      if (!seeded) return;
      void fetchDownload(r, (message) => { noteInPanel('rowerr', message); });
    });
    seeded = true;
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
