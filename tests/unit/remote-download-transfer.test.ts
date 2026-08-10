/**
 * remote-download-transfer.test.ts — the paths by which a file is supposed to
 * leave the server and land on the remote user's own machine.
 *
 * THE REPORT
 * ----------
 * «از سایت به سرور اوکیه ولی از سرور به منی که ریموت بالا اومدم دانلود کار
 * نمیکنه» — site→server works, server→the-remote-user does not. Plus: the cookie
 * extension's IMPORT works but its EXPORT does not. Occasionally a download did
 * start and then died with Chrome's «Failed - Unknown server error».
 *
 * WHAT WAS ACTUALLY MEASURED
 * --------------------------
 * A real Chromium, driven by Playwright, against this real server, over a real
 * NON-localhost hostname (a sandbox HTTPS URL — the user's own condition, which
 * localhost cannot reproduce because the old code branched on hostname):
 *
 *   curl-ish HEAD userId=0 -> 200 len=200000
 *
 *   --- variant=iframe ---   (the committed shelf code)
 *     download fired: NONE
 *     console errors: [`Refused to frame '…/browser/downloads/dl_…' because it
 *       violates the following Content Security Policy directive:
 *       "frame-src 'none'".`]
 *
 *   --- variant=anchor ---
 *     download fired: {"name":"report.pdf","failure":null,"bytes":200000}
 *
 *   --- variant=blob ---     (the fix)
 *     js: {"headStatus":200,"headLen":"200000","getStatus":200,"blobSize":200000}
 *     download fired: {"name":"report.pdf","failure":null,"bytes":200000}
 *
 * So the shelf's "save to my machine" button was blocked by this app's OWN CSP
 * (src/index.ts sets `frameSrc: ["'none'"]`, confirmed live in the response
 * header) and, because a blocked frame is a console message and not an
 * exception, it failed in COMPLETE SILENCE. That is the reported bug.
 *
 * A CLAIM THIS FILE RETRACTS
 * --------------------------
 * An earlier pass asserted that Workspace export was broken too, 404ing on
 * `/workflows//wf_…/export` because `API.getUserId()` is empty. That was WRONG,
 * and it is recorded here so nobody re-derives it: measured, the old export
 * branch DOWNLOADED SUCCESSFULLY (`wfUserId="0"` came from `wf.userId`, which
 * every listed workflow carries), i.e.
 *
 *   variant=old  isRemote=true  wfUserId="0"  download fired: failure=null
 *
 * Export was still rewritten, but for reasons that hold on their own: it put a
 * whole-instance API key in a query string, and it revoked its blob URL with a
 * 0ms timer. Those are the properties pinned below — not a 404 that never was.
 *
 * TWO FURTHER BUGS FOUND WHILE MEASURING (both pre-existing on main)
 * -----------------------------------------------------------------
 * The shelf's "upload from your computer" button was mis-nested INSIDE the
 * shelf-clear `forEach` callback and sent a message name the server does not
 * handle. Measured, before the fix:
 *
 *   upload INSIDE forEach callback: true
 *   upload button sends: newTab
 *   server has case 'newTab': false      server has case 'tabNew': true
 *   downloads=0: upload listener attached 0 time(s) (after 1 Clear click)
 *   downloads=1: upload listener attached 1 time(s) (after 1 Clear click)
 *
 * i.e. on a fresh shelf the button was inert, and the only way to arm it was to
 * first delete the downloads you wanted — and even then the click was dropped.
 *
 * WHY THESE ARE BEHAVIOUR TESTS AND NOT STRING CHECKS
 * ---------------------------------------------------
 * The standing rule here: «تست‌ها باید رفتار را بسنجند نه وجود رشته در سورس» —
 * measure behaviour, not the presence of a string. A grep for
 * `URL.createObjectURL` would happily pass against code that builds a blob URL
 * and then hands it to an iframe, i.e. against the exact bug.
 *
 * public/js/*.js are DOM-bound IIFEs that cannot be imported, so each function
 * under test is lifted out by brace-balance and executed with `new Function`
 * against stubbed collaborators. That still runs the REAL shipped code: proven
 * by mutation testing — reintroducing the iframe makes 6 of these fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const browserView = read('public/js/browser-view.js');
const views = read('public/js/views.js');
const i18n = read('public/js/i18n.js');
const indexTs = read('src/index.ts');
const streamServer = read('src/core/BrowserStreamServer.ts');

/**
 * Lift one `function name(...) { … }` out of a source file by balancing braces.
 * Regex cannot do this: the bodies contain nested functions and `}` in strings.
 */
function grabFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in source`);
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(`no body for ${name}`);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

/** Balanced extent of the block that starts at `from`'s first `{`. */
function blockExtent(src: string, from: number): [number, number] {
  let i = src.indexOf('{', from);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return [src.indexOf('{', from), i];
    }
  }
  throw new Error('unbalanced block');
}

type Anchor = {
  href: string;
  download: string;
  rel: string;
  style: Record<string, string>;
  clicked: number;
  inDocumentAtClick: boolean;
  removed: boolean;
};

/** A document that records exactly what a save attempt did to the DOM. */
function fakeDocument() {
  const created: string[] = [];
  const anchors: Anchor[] = [];
  const attached = new Set<object>();

  const doc = {
    createElement(tag: string) {
      created.push(tag);
      if (tag !== 'a') {
        // Anything that is not an anchor is still recorded, so an iframe attempt
        // is visible in `created` rather than throwing.
        const el: Record<string, unknown> = { tagName: tag, style: {} };
        el.remove = () => {};
        return el;
      }
      const a: Anchor = {
        href: '', download: '', rel: '', style: {},
        clicked: 0, inDocumentAtClick: false, removed: false,
      };
      const el = {
        set href(v: string) { a.href = v; },
        get href() { return a.href; },
        set download(v: string) { a.download = v; },
        get download() { return a.download; },
        set rel(v: string) { a.rel = v; },
        get rel() { return a.rel; },
        style: a.style,
        tagName: 'a',
        click() { a.clicked++; a.inDocumentAtClick = attached.has(el as object); },
        remove() { a.removed = true; attached.delete(el as object); },
      };
      anchors.push(a);
      return el;
    },
    body: {
      appendChild(el: object) { attached.add(el); return el; },
      removeChild(el: object) { attached.delete(el); return el; },
    },
  };
  return { doc, created, anchors };
}

/** Minimal Headers shim: only `get`, which is all the code uses. */
function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(map)) lower[k.toLowerCase()] = map[k];
  return { get: (k: string) => (k.toLowerCase() in lower ? lower[k.toLowerCase()] : null) };
}

/** Build the sandbox the extracted shelf functions run inside. */
function shelfHarness(opts: {
  key?: string;
  userId?: string;
  responses: Array<{
    ok: boolean; status: number;
    headers?: Record<string, string>; body?: string; bytes?: number;
  }>;
}) {
  const { doc, created, anchors } = fakeDocument();
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const toasts: Array<{ msg: string; kind: string }> = [];
  const objectUrls: string[] = [];
  const revoked: string[] = [];
  const timers: Array<() => void> = [];
  let n = 0;

  const fetchStub = (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: (init && init.method) || 'GET', headers: (init && init.headers) || {} });
    const r = opts.responses[n++] || opts.responses[opts.responses.length - 1];
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      headers: headers(r.headers || {}),
      text: () => Promise.resolve(r.body || ''),
      blob: () => Promise.resolve({ __blob: true, size: r.bytes || 0 }),
    });
  };

  const sandbox = {
    document: doc,
    window: { API: { getKey: () => opts.key ?? '', getUserId: () => opts.userId ?? '' } },
    fetch: fetchStub,
    URL: {
      createObjectURL: (b: { size?: number }) => {
        const u = 'blob:local/' + objectUrls.length + '#' + (b && b.size);
        objectUrls.push(u);
        return u;
      },
      revokeObjectURL: (u: string) => { revoked.push(u); },
    },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    parseInt, JSON, String, Error, Promise,
    effectiveUserId: () => (opts.userId && opts.userId !== 'env_root' ? opts.userId : '0'),
    toast: (msg: string, kind: string) => { toasts.push({ msg, kind }); },
    t: (k: string) => 'i18n:' + k,
  };

  const src = [
    grabFunction(browserView, 'downloadUrlFor'),
    grabFunction(browserView, 'saveAs'),
    // `fetchDownload` reads the server's own Content-Disposition to decide the
    // filename, so the parser has to come along or the download loses its name.
    grabFunction(browserView, 'nameFromDisposition'),
    grabFunction(browserView, 'downloadFailureMessage'),
    grabFunction(browserView, 'fetchDownload'),
    'var BLOB_LIMIT_BYTES = 64 * 1024 * 1024;',
    'return { fetchDownload: fetchDownload, downloadUrlFor: downloadUrlFor,'
      + ' saveAs: saveAs, downloadFailureMessage: downloadFailureMessage,'
      + ' nameFromDisposition: nameFromDisposition };',
  ].join('\n');

  const keys = Object.keys(sandbox);
  const api = new Function(...keys, src)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));

  return { api, calls, toasts, anchors, created, objectUrls, revoked, timers };
}

/** Let the promise chain inside fetchDownload settle. */
const settle = () => new Promise((r) => setImmediate(r));

// ══════════════════════════════════════════════════════════════════════════
describe('§1 — the download shelf actually transfers the file', () => {
  it('does not use an iframe, because this app forbids frames outright', async () => {
    // Pinned from both ends. The CSP assertion is not decoration: if someone
    // relaxes frame-src later, this is the test that should make them read why
    // the iframe was removed before "simplifying" the fetch back into one.
    expect(indexTs).toMatch(/frameSrc:\s*\["'none'"\]/);

    const h = shelfHarness({
      key: 'k1',
      responses: [
        { ok: true, status: 200, headers: { 'content-length': '2048' } },
        { ok: true, status: 200, bytes: 2048 },
      ],
    });
    h.api.fetchDownload({ token: 'dl_' + 'a'.repeat(24), name: 'report.pdf' });
    await settle();

    // MEASURED: an iframe here produced ZERO downloads under frame-src 'none'.
    expect(h.created).not.toContain('iframe');
    expect(h.created).toContain('a');
  });

  it('saves the bytes it fetched, with the key in a header and never in the URL', async () => {
    const h = shelfHarness({
      key: 'secret-key',
      responses: [
        { ok: true, status: 200, headers: { 'content-length': '2048' } },
        { ok: true, status: 200, bytes: 2048 },
      ],
    });
    h.api.fetchDownload({ token: 'dl_' + 'b'.repeat(24), name: 'report.pdf' });
    await settle();

    // A HEAD preflight, then the real GET.
    expect(h.calls[0].method).toBe('HEAD');
    expect(h.calls[1].method).toBe('GET');

    // Header auth on every request, so a whole-instance credential never enters
    // download history, the address bar, or a reverse proxy's access log.
    for (const c of h.calls) {
      expect(c.headers['x-api-key']).toBe('secret-key');
      expect(c.url).not.toContain('secret-key');
    }

    // The file saved is the blob actually received.
    expect(h.objectUrls.length).toBe(1);
    const a = h.anchors[0];
    expect(a.clicked).toBe(1);
    expect(a.href).toBe(h.objectUrls[0]);
    expect(a.download).toBe('report.pdf');
    // Firefox ignores a detached anchor's click, so it must be in the document.
    expect(a.inDocumentAtClick).toBe(true);
    expect(a.removed).toBe(true);

    // Revoking in the same turn cancels the transfer that just began, so the
    // release is deferred — not skipped (a leak), not immediate (a cancel).
    expect(h.revoked).toEqual([]);
    h.timers.forEach((fn) => fn());
    expect(h.revoked).toEqual([h.objectUrls[0]]);
  });

  it('sends the userId the socket runs as, so the token resolves', async () => {
    // Downloads live in one directory per user (downloads/live/<userId>/<token>),
    // and the route trusts `?userId=`. Measured: the right id answered 200 with
    // len=200000 while a wrong one answered 404 — so this param is the
    // difference between a file and a mystery.
    const h = shelfHarness({
      key: 'k', userId: '',
      responses: [
        { ok: true, status: 200, headers: { 'content-length': '10' } },
        { ok: true, status: 200, bytes: 10 },
      ],
    });
    h.api.fetchDownload({ token: 'dl_' + 'c'.repeat(24), name: 'x.bin' });
    await settle();
    expect(h.calls[0].url).toContain('userId=0');
    expect(h.calls[0].url).not.toMatch(/userId=(&|$)/);
  });

  it('quotes the server\'s own words instead of Chrome\'s "Unknown server error"', async () => {
    // MEASURED: a failed download shows only the browser's generic text; the
    // body's real reason never reaches the user. The user quoted that generic
    // text in their report, so the reason is now read out and toasted.
    const h = shelfHarness({
      key: 'k',
      responses: [
        { ok: false, status: 404 },
        { ok: false, status: 404, body: JSON.stringify({ error: 'That download is no longer available.' }) },
      ],
    });
    h.api.fetchDownload({ token: 'dl_' + 'd'.repeat(24), name: 'gone.pdf' });
    await settle();

    expect(h.anchors.length).toBe(0);          // nothing pretends to save
    expect(h.toasts).toEqual([
      { msg: 'That download is no longer available.', kind: 'error' },
    ]);
  });

  it('names a cause even when the server sends no body', async () => {
    const h = shelfHarness({
      key: '',
      responses: [
        { ok: false, status: 401 },
        { ok: false, status: 401, body: '' },
      ],
    });
    h.api.fetchDownload({ token: 'dl_' + 'e'.repeat(24), name: 'x.pdf' });
    await settle();
    // A distinct, translatable cause — not a bare status code.
    expect(h.toasts[0].msg).toBe('i18n:bvp.dlNoAuth');
    expect(h.api.downloadFailureMessage(403, null)).toBe('i18n:bvp.dlForbidden');
    expect(h.api.downloadFailureMessage(404, null)).toBe('i18n:bvp.dlGone');
    // The catch-all still says WHICH status, so a bug report is actionable.
    expect(h.api.downloadFailureMessage(500, null)).toBe('i18n:bvp.dlServerError');
  });

  it('streams a file too large to hold in memory instead of dying on the blob', async () => {
    // 64MB+ in a blob is a tab crash on a modest remote box, so this one case
    // uses a real navigation — the only path where a token in the query buys
    // anything, because a navigation cannot carry a header.
    const h = shelfHarness({
      key: 'k9',
      responses: [{ ok: true, status: 200, headers: { 'content-length': String(200 * 1024 * 1024) } }],
    });
    h.api.fetchDownload({ token: 'dl_' + 'f'.repeat(24), name: 'big.zip' });
    await settle();

    expect(h.calls.length).toBe(1);            // no GET into memory
    expect(h.objectUrls).toEqual([]);          // no blob
    const a = h.anchors[0];
    expect(a.clicked).toBe(1);
    expect(a.href).toContain('token=k9');
    expect(a.download).toBe('big.zip');
    expect(h.created).not.toContain('iframe');
  });

  it('has every new message in both languages', () => {
    // A missing key renders as the key itself, turning a helpful error into
    // gibberish — worse than the generic text it replaced.
    for (const k of ['bvp.dlNoAuth', 'bvp.dlForbidden', 'bvp.dlGone', 'bvp.dlServerError']) {
      const hits = i18n.split(`'${k}':`).length - 1;
      expect(hits, `${k} must exist in BOTH the fa and en dictionaries`).toBe(2);
    }
    // The catch-all needs somewhere to put the number.
    expect(i18n).toMatch(/'bvp\.dlServerError':[^\n]*\{status\}/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§2 — the shelf\'s "upload from your computer" button is reachable', () => {
  /**
   * Execute the real shelf-clear handler and report whether binding the upload
   * button was a side effect of it — which is what the mis-nesting made it.
   */
  function wiringHarness(downloadCount: number) {
    const attachedTo: string[] = [];
    const els: Record<string, {
      id: string; _bound?: boolean;
      listeners: Record<string, Array<() => void>>;
      addEventListener(ev: string, fn: () => void): void;
    }> = {};
    const mk = (id: string) => (els[id] = {
      id, listeners: {},
      addEventListener(ev: string, fn: () => void) {
        (this.listeners[ev] = this.listeners[ev] || []).push(fn);
        attachedTo.push(id);
      },
    });
    ['bvp-shelf-clear', 'bvp-shelf-upload', 'bvp-shelf-hide'].forEach(mk);

    const sent: Array<Record<string, unknown>> = [];
    const opened: string[] = [];
    const sandbox = {
      q: (id: string) => els[id],
      pickState: {
        downloads: Array.from({ length: downloadCount }, (_, i) => ({ token: 'dl_' + i })),
        shelfHidden: false,
      },
      send: (m: Record<string, unknown>) => { sent.push(m); },
      renderShelf: () => {},
      newTab: (u: string) => { sent.push({ t: 'tabNew', url: u }); },
      effectiveUserId: () => '0',
      window: { open: (u: string) => { opened.push(u); } },
      encodeURIComponent,
    };

    // Run from the clear handler through the end of the upload binding, i.e. the
    // whole region the two used to be tangled in.
    const clearAt = browserView.indexOf("q('bvp-shelf-clear').addEventListener");
    const uploadAt = browserView.indexOf("q('bvp-shelf-upload')");
    const [, uploadEnd] = blockExtent(browserView, uploadAt);
    const region = browserView.slice(clearAt, uploadEnd + 1);

    const keys = Object.keys(sandbox);
    new Function(...keys, region)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));

    return { els, attachedTo, sent, opened };
  }

  it('is wired when the shelf is built, not as a side effect of pressing Clear', () => {
    // MEASURED before the fix: the binding sat inside the clear handler's
    // `pickState.downloads.forEach(...)`, so with an empty shelf it was attached
    // 0 times, and the only way to arm it was to first delete your downloads.
    for (const count of [0, 1]) {
      const h = wiringHarness(count);
      expect(
        h.attachedTo.filter((id) => id === 'bvp-shelf-upload').length,
        `upload must be bound exactly once with ${count} download(s), before any click`,
      ).toBe(1);
    }
  });

  it('still clears downloads without opening anything', () => {
    const h = wiringHarness(2);
    h.els['bvp-shelf-clear'].listeners.click.forEach((fn) => fn());
    // Clear deletes the bytes: one message per download, and nothing else.
    expect(h.sent.filter((m) => m.t === 'downloadClear').length).toBe(2);
    expect(h.opened).toEqual([]);
  });

  it('opens the picker in the USER\'s browser, not the server\'s', () => {
    // A `tabNew` would open the page in the SERVER's Chrome, whose file dialog
    // is drawn by the server's window manager and browses the server's disk —
    // the exact failure RemoteIO exists to remove. And the old name was not even
    // handled: measured `case 'newTab': false` / `case 'tabNew': true`.
    const h = wiringHarness(0);
    h.els['bvp-shelf-upload'].listeners.click.forEach((fn) => fn());

    expect(h.opened.length).toBe(1);
    expect(h.opened[0]).toContain('/remote-upload.html');
    // The id must match the session's, or the bytes land in a directory the
    // session never reads and Import fails as a bare ENOENT.
    expect(h.opened[0]).toContain('userId=0');
    // No socket traffic at all: this is a local tab.
    expect(h.sent).toEqual([]);
  });

  it('never sends a message name the server does not handle', () => {
    // Cheap, and it is the half of the bug a behavioural test cannot see: a
    // dropped `t` is silent by design.
    const names = Array.from(browserView.matchAll(/send\(\{\s*t:\s*'([a-zA-Z]+)'/g)).map((m) => m[1]);
    const unhandled = Array.from(new Set(names)).filter((n) => !streamServer.includes(`case '${n}':`));
    expect(unhandled, 'client sends commands with no server case').toEqual([]);
  });

  it('does not put the API key in the upload page\'s URL', () => {
    // remote-upload.html already falls back to localStorage.ab_api_key on this
    // same origin, so a key in the query only copied a credential into history.
    const h = wiringHarness(0);
    h.els['bvp-shelf-upload'].listeners.click.forEach((fn) => fn());
    expect(h.opened[0]).not.toContain('apiKey');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('§3 — Workspace export produces a real file', () => {
  /** Run the shipped exportWorkflowJson against stubs and report what it did. */
  function exportHarness(opts: {
    wf: Record<string, unknown>;
    key?: string;
    userId?: string;
    getWorkflow?: (uid: string, id: string) => Promise<unknown>;
  }) {
    const { doc, created, anchors } = fakeDocument();
    const toasts: Array<{ msg: string; kind: string }> = [];
    const blobs: Array<{ parts: string[]; type: string }> = [];
    const objectUrls: string[] = [];
    const revoked: string[] = [];
    const timers: Array<() => void> = [];
    const getWorkflowCalls: Array<[string, string]> = [];
    let navigated: string | null = null;

    const sandbox = {
      document: doc,
      Blob: function (parts: string[], o: { type: string }) {
        const b = { parts, type: (o && o.type) || '' };
        blobs.push(b);
        return b;
      },
      URL: {
        createObjectURL: () => {
          const u = 'blob:wf/' + objectUrls.length;
          objectUrls.push(u);
          return u;
        },
        revokeObjectURL: (u: string) => { revoked.push(u); },
      },
      setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
      JSON, String, Array, Promise,
      API: {
        getKey: () => opts.key ?? '',
        getUserId: () => opts.userId ?? '',
        getWorkflow: (uid: string, id: string) => {
          getWorkflowCalls.push([uid, id]);
          return opts.getWorkflow
            ? opts.getWorkflow(uid, id)
            : Promise.resolve({ workflow: { ...opts.wf, steps: [{ action: 'goto' }] } });
        },
      },
      // A location whose assignment is observable: exporting by navigation was
      // the old shape, and must not slip back in unnoticed.
      window: {
        get location() {
          return { get href() { return ''; }, set href(v: string) { navigated = v; } };
        },
      },
      effectiveUserId: () => (opts.userId && opts.userId !== 'env_root' ? opts.userId : '0'),
      U: () => ({ toast: (msg: string, kind: string) => { toasts.push({ msg, kind }); } }),
      t: (k: string) => 'i18n:' + k,
    };

    const src = grabFunction(views, 'exportWorkflowJson') + '\nreturn exportWorkflowJson;';
    const keys = Object.keys(sandbox);
    const fn = new Function(...keys, src)(...keys.map((k) => (sandbox as Record<string, unknown>)[k]));

    return {
      // `args.length` rather than `??`, so an explicit undefined really reaches
      // the function instead of being defaulted away by the harness.
      run: (...args: Array<Record<string, unknown> | undefined>) =>
        (args.length ? fn(args[0]) : fn(opts.wf)),
      created, anchors, toasts, blobs, objectUrls, revoked, timers, getWorkflowCalls,
      nav: () => navigated,
    };
  }

  const wf = {
    id: 'wf_abc123',
    name: 'Test WF',
    description: 'd',
    steps: [{ action: 'goto', params: { url: 'https://example.com' } }],
    headless: true,
    active: true,
  };

  it('builds the file in memory and keeps the API key out of it', async () => {
    // NOT because the old URL 404'd — measured, it did not (see this file's
    // header). Because it put a whole-instance credential in a query string to
    // fetch data the page was already holding.
    const h = exportHarness({ wf, key: 'secret-key', userId: '' });
    h.run();
    await settle();

    expect(h.nav()).toBeNull();
    expect(h.blobs.length).toBe(1);
    expect(h.getWorkflowCalls).toEqual([]);    // steps present: no round trip

    const a = h.anchors[0];
    expect(a.clicked).toBe(1);
    expect(a.inDocumentAtClick).toBe(true);
    expect(a.href).toBe(h.objectUrls[0]);
    // Sanitised, so a workflow named "a/b" cannot escape into a path.
    expect(a.download).toBe('Test_WF.json');

    expect(a.href).not.toContain('secret-key');
    expect(h.blobs[0].parts.join('')).not.toContain('secret-key');
    expect(h.toasts).toEqual([{ msg: 'i18n:ws.exported', kind: 'success' }]);
  });

  it('exports content the importer will accept', async () => {
    const h = exportHarness({ wf });
    h.run();
    await settle();

    const parsed = JSON.parse(h.blobs[0].parts.join(''));
    // The importer's one hard requirement (see importWorkflowJson).
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps).toEqual(wf.steps);
    expect(parsed.name).toBe('Test WF');
    expect(h.blobs[0].type).toBe('application/json');
  });

  it('fetches the full workflow rather than exporting an empty file', async () => {
    // A row without `steps` would otherwise export `{"steps":[]}` — a file that
    // imports as nothing. Silently plausible, which is the worst kind of wrong.
    const h = exportHarness({ wf: { id: 'wf_bare', name: 'Bare' }, userId: '' });
    h.run();
    await settle();

    expect(h.getWorkflowCalls).toEqual([['0', 'wf_bare']]);  // '0', never ''
    expect(JSON.parse(h.blobs[0].parts.join('')).steps).toEqual([{ action: 'goto' }]);
    expect(h.anchors[0].download).toBe('Bare.json');
  });

  it('reports a fetch failure instead of saving a file that imports as nothing', async () => {
    const h = exportHarness({
      wf: { id: 'wf_bare', name: 'Bare' },
      getWorkflow: () => Promise.reject(new Error('Endpoint not found')),
    });
    h.run();
    await settle();

    expect(h.blobs).toEqual([]);
    expect(h.anchors).toEqual([]);
    expect(h.toasts).toEqual([{ msg: 'Endpoint not found', kind: 'error' }]);
  });

  it('releases the blob URL late, not on a 0ms timer', async () => {
    // The old local path used `setTimeout(…, 0)`, which races the browser's own
    // read of the blob it was told to save.
    const h = exportHarness({ wf });
    h.run();
    await settle();
    expect(h.revoked).toEqual([]);
    h.timers.forEach((fn) => fn());
    expect(h.revoked).toEqual([h.objectUrls[0]]);
  });

  it('does nothing at all when handed nothing', () => {
    const h = exportHarness({ wf });
    h.run(undefined);
    expect(h.blobs).toEqual([]);
    expect(h.toasts).toEqual([]);
  });
});
