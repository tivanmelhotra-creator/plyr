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
  .fbtn {
    font: inherit; color: #e6e6ee; background: rgba(38,38,46,.92);
    border: 1px solid #4a4a55; border-radius: 6px;
    padding: 6px 11px; cursor: pointer; backdrop-filter: blur(3px);
  }
  .fbtn:hover { background: rgba(58,58,68,.96); }
  #panel {
    width: 19rem; max-height: 15rem; overflow-y: auto;
    background: rgba(30,30,37,.96); border: 1px solid #43434e;
    border-radius: 8px; padding: 9px 10px;
    box-shadow: 0 6px 22px rgba(0,0,0,.45);
  }
  #panel[hidden] { display: none; }
  #panel h4 { margin: 0 0 7px; font-size: 12px; font-weight: 600; color: #b9b9c6; }
  #dls { list-style: none; margin: 0; padding: 0; }
  #dls li {
    display: flex; align-items: center; gap: 7px;
    padding: 4px 0; border-top: 1px solid #38383f;
  }
  #dls li:first-child { border-top: 0; }
  #dls a { color: #8fb6ff; text-decoration: none; overflow-wrap: anywhere; }
  #dls a:hover { text-decoration: underline; }
  .sz { color: #8b8b98; flex: none; }
  .empty { color: #8b8b98; }
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
    <h4>Downloads</h4>
    <ul id="dls"><li class="empty">Nothing downloaded yet.</li></ul>
  </div>
  <div style="display:flex; gap:8px">
    <button class="fbtn" id="upbtn" type="button" title="Send a file to the remote browser">Upload</button>
    <button class="fbtn" id="dlbtn" type="button">Files</button>
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
    } else {
      // A failed or in-flight row must SAY so rather than offer a dead link.
      li.className = 'empty';
      li.textContent = r.name + ' — ' +
        (r.state === 'failed' ? (r.error || 'failed') : 'downloading…');
    }
    dls.appendChild(li);
  });
}

function refreshDownloads() {
  return fetch('/browser/real/downloads', {
    headers: authHeaders(),
    credentials: 'same-origin',
  })
    .then((r) => r.json())
    .then((j) => {
      if (j && j.owner) shelfOwner = String(j.owner);
      renderDownloads((j && j.downloads) || []);
    })
    .catch(() => { /* the browser may not be up yet; the button can be pressed again */ });
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

/**
 * Where an uploaded file actually lands, said out loud.
 *
 * WHY THIS IS SHOWN RATHER THAN A SILENT "Uploaded"
 * ------------------------------------------------
 * On the SIMULATED browser an upload could be handed straight to the page,
 * because Playwright drives that browser and intercepts its file dialog
 * (page.on('filechooser') -> setFiles) -- see core/RemoteUploads. This view is
 * not that: it is a VNC screen onto a real Chromium the operator drives with
 * their own mouse, and Playwright is not holding its dialogs open. There is
 * therefore no dialog to answer at upload time, and pretending otherwise is
 * what made the old button meaningless -- it said "Uploaded" and the file was
 * unreachable from every page on the screen.
 *
 * What DOES work, and needs no interception at all: Chromium's own file dialog
 * is drawn on the virtual screen, so it IS visible and clickable over VNC, and
 * it browses the SERVER's disk -- which is where the bytes now are. So the one
 * thing the operator needs is the name to type into that dialog.
 */
function showUploadResult(names) {
  const li = document.createElement('li');
  li.className = 'uphint';
  li.textContent = names.length === 1
    ? 'Ready on the remote browser as: ' + names[0]
    : 'Ready on the remote browser: ' + names.join(', ');
  const how = document.createElement('div');
  how.className = 'sub';
  how.textContent = 'In the remote page press its own Choose/Browse button and '
    + 'type this name into the dialog on screen.';
  li.appendChild(how);
  dls.insertBefore(li, dls.firstChild || null);
  panel.hidden = false;
}

upInput.addEventListener('change', () => {
  const list = Array.from(upInput.files || []);
  // Reset first: picking the same file twice in a row fires no 'change' at all
  // unless the value is cleared, which reads as the upload being ignored.
  upInput.value = '';
  if (!list.length) return;
  const btn = document.getElementById('upbtn');
  btn.textContent = 'Uploading…';
  const done = [];
  let failure = '';
  // Sequential on purpose: parallel uploads of several large files on a server
  // that is also running a browser is how both end up slow.
  list.reduce(
    (chain, file) => chain.then(() => uploadOne(file).then((d) => {
      done.push((d && d.name) || file.name);
    })),
    Promise.resolve(),
  )
    .then(() => {
      btn.textContent = 'Uploaded';
      showUploadResult(done);
    })
    .catch((e) => {
      btn.textContent = 'Upload failed';
      failure = (e && e.message) ? e.message : 'The upload failed.';
      // Say WHY, in the panel, where it stays readable. A button that flicks
      // back to "Upload" after 2.5 s has told the operator nothing.
      const li = document.createElement('li');
      li.className = 'rowerr';
      li.textContent = failure;
      dls.insertBefore(li, dls.firstChild || null);
      panel.hidden = false;
      // Files that DID arrive before the failure are still usable, and saying
      // so is the difference between "retry the rest" and "start over".
      if (done.length) showUploadResult(done);
    })
    // Whatever happened, the button must go back to being a button.
    .then(() => setTimeout(() => { btn.textContent = 'Upload'; }, 2500));
});

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
