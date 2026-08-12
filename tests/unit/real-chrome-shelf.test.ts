/**
 * Downloads and clipboard for the REAL Chromium view.
 *
 * WHAT WAS BROKEN
 * ---------------
 * The real-Chromium view had no download handling at all. MEASURED against the
 * exact launch options RealChrome uses, serving a file as `report.png`:
 *
 *   FILES_ON_DISK        = [{"rel":"19e8fe9b-3f65-4353-bad1-2ea627bc6549",...}]
 *   ANY_NAMED_report_png = false
 *   AFTER_CLOSE_ENTRIES  = []
 *
 * No name, no extension, and then deleted when the browser closed — the
 * «اسم و فرمت فایل های دانلود شده» complaint.
 *
 * HOW THESE TESTS WORK
 * --------------------
 * `finalizeDownloadName` is driven with REAL BYTES ON A REAL DISK, because that
 * is what it inspects: the whole point of the function is to name a format from
 * a file's magic number when the browser could not. No mocks are involved in the
 * part that was broken.
 *
 * The clipboard half lives in a browser page, and this repo has no jsdom
 * (vitest environment is 'node' — see ab-core.test.ts). So the page's own module
 * script is EXTRACTED and EXECUTED in a `new Function()` sandbox with fake
 * globals, and the tests assert on what it did to those fakes. Executing it is
 * what makes these behaviour tests rather than a search for a substring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import {
  finalizeDownloadName,
  REAL_CHROME_SHELF_USER,
  RealChromeShelf,
} from '../../src/core/RealChromeShelf';
import { chromeViewHtml } from '../../src/core/ChromeView';
import { resolveDownload } from '../../src/core/RemoteDownloads';

// A one-pixel PNG. The first 8 bytes are the PNG signature, which is what
// extensionFromBytes reads.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('255044462d312e340a25', 'hex'); // %PDF-1.4

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('finalizeDownloadName — the name and format problem', () => {
  it('gives a nameless download the extension its BYTES prove it to be', async () => {
    // This is the measured failure: Chrome saved the file as a bare GUID with
    // no suffix, because the server sent no Content-Disposition.
    const guid = path.join(dir, '19e8fe9b-3f65-4353-bad1-2ea627bc6549');
    await fs.writeFile(guid, PNG);

    const out = await finalizeDownloadName(guid, '');

    expect(out.name.endsWith('.png')).toBe(true);
    expect(out.size).toBe(PNG.length);
    // The renamed file must actually be there under the new name.
    await expect(fs.readFile(out.path)).resolves.toHaveLength(PNG.length);
  });

  it('identifies the format from bytes even when the URL lies about it', async () => {
    // A URL suffix is preferred when present, so the file here has none and the
    // bytes must be what decides. PDF magic in a file called `export`.
    const p = path.join(dir, 'export');
    await fs.writeFile(p, PDF);
    const out = await finalizeDownloadName(p, 'https://x.test/download');
    expect(out.name).toBe('export.pdf');
  });

  it('keeps a name that already has an extension, byte for byte', async () => {
    const p = path.join(dir, 'report.png');
    await fs.writeFile(p, PNG);
    const out = await finalizeDownloadName(p, 'https://x.test/report.png');
    expect(out.name).toBe('report.png');
    expect(out.path).toBe(p);
  });

  it('uses the URL path suffix when the bytes are unrecognisable', async () => {
    const p = path.join(dir, 'download');
    await fs.writeFile(p, Buffer.from('id,name\n1,a\n', 'utf8')); // CSV: no magic
    const out = await finalizeDownloadName(p, 'https://x.test/data/report.csv?v=2');
    expect(out.name).toBe('download.csv');
  });

  it('reports the real size on disk, which the shelf shows the user', async () => {
    const p = path.join(dir, 'big.png');
    const bytes = Buffer.concat([PNG, Buffer.alloc(5000)]);
    await fs.writeFile(p, bytes);
    const out = await finalizeDownloadName(p, '');
    expect(out.size).toBe(bytes.length);
  });

  it('does not invent an extension when nothing can identify the format', async () => {
    // Guessing would send the user's OS to the wrong application, which is
    // worse than the missing suffix. `''` on doubt is the contract.
    const p = path.join(dir, 'mystery');
    await fs.writeFile(p, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    const out = await finalizeDownloadName(p, 'https://x.test/stream');
    expect(out.name).toBe('mystery');
  });

  it('never throws for a file that is not there', async () => {
    // A download that failed mid-write must not take the handler down with it.
    const out = await finalizeDownloadName(path.join(dir, 'gone'), '');
    expect(out.size).toBe(0);
  });
});

describe('the shelf owner', () => {
  it('is a fixed identity, so the write and the read use one directory', () => {
    // The real Chromium is one browser with one profile. Deriving the owner
    // per-request wrote the file under one id and looked for it under another
    // — the documented ENOENT hand-over failure on /browser/uploads.
    expect(REAL_CHROME_SHELF_USER).toBe('local');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The clipboard bridge, EXECUTED rather than read.
// ─────────────────────────────────────────────────────────────────────────────

/** The view's module script, with the noVNC import removed so it can run. */
function viewScript(): string {
  const html = chromeViewHtml();
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no module script in the view');
  return m[1].replace(/^\s*import RFB from .*$/m, '');
}

interface Harness {
  /** Fire an event the page registered on window. */
  fire: (type: string, ev?: unknown) => void;
  /** Text pushed to the remote desktop via rfb.clipboardPasteFrom(). */
  pushed: string[];
  /** Text written to the LOCAL clipboard via navigator.clipboard.writeText(). */
  written: string[];
  /** Fire the noVNC 'clipboard' event (remote copied something). */
  remoteCopy: (text: string) => void;
  /** Whatever readText() will resolve with. */
  setLocalClipboard: (text: string) => void;
  rejectReadText: boolean;
  rejectWriteText: boolean;
  /** Fire the noVNC 'connect' event (the desktop came up). */
  connected: () => void;
  /** The element the page got for an id, with everything it did to it. */
  el: (id: string) => FakeEl;
  /** Click an element the page registered a handler on. */
  click: (id: string) => void;
  /**
   * The file bar's fetches, in order. Excludes the boot POST to
   * /browser/real/open, which every run makes and which no test in this file is
   * counting; use `starts` for that one.
   */
  fetches: Array<{ url: string; init: Record<string, unknown> }>;
  /** The POSTs to /browser/real/open, from page load and from Retry. */
  starts: Array<{ url: string; init: Record<string, unknown> }>;
  /** Press "Try again" on the status overlay. */
  retry: () => void;
  /** What /browser/real/downloads will answer with. */
  setDownloads: (rows: unknown[]) => void;
  /** Make the downloads fetch reject outright. */
  failDownloadsFetch: boolean;
  /** Make upload POSTs answer !ok. */
  failUploads: boolean;
  /** What the list endpoint reports its files are stored under. */
  setOwner: (o: string) => void;
  /** Make the bytes endpoint refuse, with the body the real server would send. */
  failDownloadBytes: (status: number, errorBody: unknown) => void;
  /** What the bytes endpoint reports about the file it is serving. */
  setServedFile: (o: { length?: number; disposition?: string }) => void;
  /** Make an upload fail the way the real server does: a JSON error body. */
  failUploadWith: (status: number, errorBody: unknown) => void;
  /** Anchors the page appended to document.body, in order. */
  anchors: () => FakeEl[];
  /** Object URLs handed out, and the ones revoked so far. */
  objectUrls: string[];
  revoked: string[];
  /** Choose files in the hidden input and fire 'change'. */
  chooseFiles: (names: string[]) => void;
  /** The rendered <li> rows of the downloads panel. */
  rows: () => FakeEl[];
  /** The most uploads that were ever in flight at the same moment. */
  maxConcurrentUploads: () => number;
}

/**
 * A DOM element stand-in that RECORDS. The page's own code decides what to set
 * on it; the tests read those recordings back. Nothing here interprets markup.
 */
interface FakeEl {
  tag: string;
  hidden: boolean;
  textContent: string;
  className: string;
  href: string;
  attrs: Record<string, string>;
  children: FakeEl[];
  files: unknown[] | null;
  value: string;
  clicks: number;
  /** Whether the node had a parent at the moment click() ran. */
  clickedWhileInDocument: boolean;
  parent: FakeEl | null;
  style: Record<string, string>;
  rel: string;
  download: string;
  addEventListener: (type: string, fn: (ev: unknown) => void) => void;
  setAttribute: (k: string, v: string) => void;
  appendChild: (c: FakeEl) => void;
  insertBefore: (c: FakeEl, ref: FakeEl | null) => void;
  removeChild: (c: FakeEl) => void;
  remove: () => void;
  querySelector: (sel: string) => FakeEl | null;
  readonly firstChild: FakeEl | null;
  click: () => void;
  focus: () => void;
  /** Test-side: fire a listener the page attached. */
  emit: (type: string, ev?: unknown) => void;
}

/**
 * Which ids carry `hidden` in the view's OWN markup. Read from the markup
 * rather than hardcoded, so a fake element starts in the state the real element
 * would start in. Getting this wrong made the fake claim the file bar was
 * already visible before the desktop connected.
 */
function hiddenIdsInMarkup(): Set<string> {
  const html = chromeViewHtml();
  const ids = new Set<string>();
  // Any tag that has both an id and a bare `hidden` attribute.
  const re = /<[a-z]+[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const id = /id="([^"]+)"/.exec(tag);
    if (id && /\shidden(\s|>|=)/.test(tag)) ids.add(id[1]);
  }
  return ids;
}

function makeEl(tag: string, hidden = false): FakeEl {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  let text = '';
  let fileValue = '';
  const el: FakeEl = {
    tag,
    hidden,
    // Real DOM semantics: assigning textContent REPLACES all children, so
    // setting it to '' is how the page empties the list. A fake that kept the
    // children would have hidden a duplicate-rows bug.
    get textContent() {
      return text || el.children.map((c) => c.textContent).join('');
    },
    set textContent(v: string) {
      text = v;
      el.children.length = 0;
    },
    className: '',
    href: '',
    attrs: {},
    children: [],
    files: null,
    // Real <input type="file"> semantics: it reports the chosen file's name,
    // and assigning '' clears the FileList too. A fake whose value was always
    // '' made "the page cleared the input" impossible to observe.
    get value() { return fileValue; },
    set value(v: string) {
      fileValue = v;
      if (v === '') el.files = [];
    },
    parent: null,
    // Every real element has one. Without it `a.style.display = 'none'` throws
    // inside the page's own code, which looked exactly like the download never
    // being attempted -- a fake-fidelity gap, not a product bug.
    style: {},
    rel: '',
    download: '',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    appendChild(c) {
      // Reparenting, as the real DOM does: appending a node that already has a
      // parent MOVES it. Without this a node inserted twice would appear in two
      // places at once and a "replaces the rows" test could pass wrongly.
      if (c.parent && c.parent !== el) c.parent.removeChild(c);
      c.parent = el;
      el.children.push(c);
    },
    insertBefore(c, ref) {
      if (c.parent && c.parent !== el) c.parent.removeChild(c);
      c.parent = el;
      const at = ref ? el.children.indexOf(ref) : -1;
      if (at < 0) el.children.push(c);
      else el.children.splice(at, 0, c);
    },
    removeChild(c) {
      const at = el.children.indexOf(c);
      if (at >= 0) el.children.splice(at, 1);
      if (c.parent === el) c.parent = null;
    },
    /** What the real one does: detach from the parent, if there is one. */
    remove() { if (el.parent) el.parent.removeChild(el); },
    /** Depth-first, class selectors only — all this page uses. */
    querySelector(sel: string) {
      const want = String(sel).replace(/^\./, '');
      for (const c of el.children) {
        if (c.className === want) return c;
        const deeper = c.querySelector(sel);
        if (deeper) return deeper;
      }
      return null;
    },
    get firstChild() { return el.children.length ? el.children[0] : null; },
    // Recorded so a test can prove the anchor was IN the document when it was
    // clicked: Firefox ignores a detached anchor's click, so "appended, then
    // clicked, in that order" is the behaviour that matters, not the call count.
    clickedWhileInDocument: false,
    clicks: 0,
    click() {
      el.clicks += 1;
      el.clickedWhileInDocument = !!el.parent;
      el.emit('click');
    },
    focus() {},
    emit(type, ev) { (listeners.get(type) || []).forEach((f) => f(ev)); },
  };
  return el;
}

/**
 * Run the view's script with fake DOM/browser globals and return handles to
 * everything it touched. `new Function` is the repo's convention for this —
 * there is no jsdom.
 *
 * ASYNC, and it has to be. The page no longer attaches an RFB the instant it is
 * evaluated: it first POSTs /browser/real/open and only then connects, which is
 * what makes Retry able to recover a stopped desktop. So immediately after
 * evaluation there is no RFB and no listener on it — a synchronous handle would
 * hand every test a page that has not booted yet. `runView` therefore awaits
 * the boot before returning, and the tests read as they did before.
 */
async function runView(
  opts: {
    rejectReadText?: boolean; rejectWriteText?: boolean; search?: string;
    /** Make POST /browser/real/open fail, as it does when Xvfb is absent. */
    failStart?: boolean;
  } = {},
): Promise<Harness> {
  const winListeners = new Map<string, Array<(ev: unknown) => void>>();
  const rfbListeners = new Map<string, Array<(ev: unknown) => void>>();
  const pushed: string[] = [];
  const written: string[] = [];
  let localClipboard = '';

  const state = {
    rejectReadText: !!opts.rejectReadText,
    rejectWriteText: !!opts.rejectWriteText,
    failDownloadsFetch: false,
    failUploads: false,
    downloads: [] as unknown[],
    // The identity the list endpoint reports its files are stored under.
    owner: 'local',
    // What /browser/downloads/<token> answers with.
    downloadStatus: 200,
    downloadLength: 2048,
    downloadDisposition: '',
    downloadErrorBody: { success: false, error: 'That file is gone.' } as unknown,
    uploadStatus: 200,
    uploadErrorBody: { success: false, error: 'File is too large.' } as unknown,
    // How POST /browser/real/open answers. Success by default: almost every
    // test here is about the file bar and needs a page that got as far as
    // connecting.
    startOk: opts.failStart === undefined ? true : !opts.failStart,
    startStatus: 200,
    startErrorBody: {
      success: false,
      error: 'Missing: Xvfb. Install the virtual display: sudo apt-get install -y xvfb',
    } as unknown,
  };

  // One element per id, kept, so a handler the page attaches survives and the
  // properties it sets can be read back. The previous stub returned a fresh
  // object every call, which silently discarded both.
  const hiddenIds = hiddenIdsInMarkup();
  const byId = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    if (!byId.has(id)) byId.set(id, makeEl('#' + id, hiddenIds.has(id)));
    return byId.get(id)!;
  };

  const allFetches: Array<{ url: string; init: Record<string, unknown> }> = [];
  const conc = { inFlight: 0, max: 0 };

  /**
   * The POST that brings the stack up. The view fires it on load and on Retry,
   * because Retry pointing at a page that only CONNECTS was the reported dead
   * end (see ChromeView.startThenConnect).
   *
   * It is held apart from `fetches` on purpose. Every assertion in this file
   * that counts requests is asking about the file bar's own traffic — "nothing
   * was fetched merely by connecting" means the downloads LIST was not fetched.
   * Folding an unrelated boot request into those counts would turn each of them
   * into an off-by-one puzzle. Nothing is hidden: `starts` exposes it, and the
   * boot POST has its own tests below.
   */
  const isStart = (url: string) => url.indexOf('/browser/real/open') >= 0;

  /**
   * A response with the parts the real server sends. `text()` matters: the page
   * reads the BODY of an upload and of a failed download, because this server
   * answers a rejected upload with 200 + { success:false, error } and a refused
   * download with a JSON error — so a fake that only offers `ok` cannot tell a
   * working page from a broken one.
   */
  const reply = (opts: {
    ok?: boolean; status?: number; body?: unknown; headers?: Record<string, string>;
    blob?: unknown;
  }) => {
    const hdrs = opts.headers || {};
    const status = opts.status === undefined ? (opts.ok === false ? 500 : 200) : opts.status;
    return {
      ok: opts.ok === undefined ? status >= 200 && status < 300 : opts.ok,
      status,
      headers: {
        // Case-insensitive, as a real Headers object is: the page asks for
        // 'content-disposition' and a server sends 'Content-Disposition'.
        get: (name: string) => {
          const want = String(name).toLowerCase();
          const hit = Object.keys(hdrs).find((k) => k.toLowerCase() === want);
          return hit === undefined ? null : hdrs[hit];
        },
      },
      text: () => Promise.resolve(
        typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {}),
      ),
      json: () => Promise.resolve(opts.body ?? {}),
      blob: () => Promise.resolve(opts.blob ?? { size: 4, kind: 'blob' }),
    };
  };

  const fetch = (url: string, init: Record<string, unknown> = {}) => {
    allFetches.push({ url, init });
    // Answered BEFORE the upload fallthrough below. Without a case of its own
    // the boot POST landed in that branch, which resolves after a timer and
    // reports an upload token: startThenConnect() then never reached connect(),
    // so attach() never ran and no RFB listener was ever registered. MEASURED:
    // 12 failures reading `expected [] to include 'copied in the remote
    // browser'` — the clipboard was fine, the page had simply never started.
    if (isStart(url)) {
      return Promise.resolve(state.startOk
        ? reply({ body: { success: true, viewPath: '/desktop/chrome' } })
        : reply({ status: state.startStatus, body: state.startErrorBody }));
    }
    if (url.indexOf('/browser/real/downloads') >= 0) {
      if (state.failDownloadsFetch) return Promise.reject(new Error('browser not up'));
      return Promise.resolve(reply({
        body: { success: true, owner: state.owner, downloads: state.downloads },
      }));
    }
    if (url.indexOf('/browser/downloads/') >= 0) {
      const method = String(init.method || 'GET').toUpperCase();
      if (state.downloadStatus !== 200) {
        // HEAD carries no body by definition, which is exactly why the page has
        // to re-ask with GET to learn the reason.
        return Promise.resolve(reply({
          status: state.downloadStatus,
          body: method === 'HEAD' ? '' : state.downloadErrorBody,
        }));
      }
      return Promise.resolve(reply({
        status: 200,
        headers: {
          'Content-Length': String(state.downloadLength),
          'Content-Disposition': state.downloadDisposition,
        },
      }));
    }
    // An upload POST. It takes measurable TIME, which is the only way to observe
    // whether the page overlapped them: an instant promise would look identical
    // whether the uploads were chained or fired all at once.
    conc.inFlight += 1;
    if (conc.inFlight > conc.max) conc.max = conc.inFlight;
    return new Promise((resolve) => {
      setTimeout(() => {
        conc.inFlight -= 1;
        const name = /name=([^&]*)/.exec(url);
        resolve(state.failUploads
          ? reply({ status: state.uploadStatus, body: state.uploadErrorBody })
          : reply({
            body: {
              success: true,
              token: 'up_0123456789abcdef01234567',
              name: name ? decodeURIComponent(name[1]) : 'file',
              size: 4,
            },
          }));
      }, 5);
    });
  };

  // A fake RFB whose constructor records the listeners the page attaches, and
  // whose clipboardPasteFrom records what the page sent to the desktop.
  class FakeRFB {
    constructor() { /* the page only needs the instance */ }
    addEventListener(type: string, fn: (ev: unknown) => void) {
      if (!rfbListeners.has(type)) rfbListeners.set(type, []);
      rfbListeners.get(type)!.push(fn);
    }
    clipboardPasteFrom(text: string) { pushed.push(text); }
    disconnect() {}
  }

  const fakeWindow = {
    addEventListener(type: string, fn: (ev: unknown) => void) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type)!.push(fn);
    },
  };

  const navigator = {
    clipboard: {
      writeText: (t: string) => {
        if (state.rejectWriteText) return Promise.reject(new Error('not focused'));
        written.push(t);
        return Promise.resolve();
      },
      readText: () => {
        if (state.rejectReadText) return Promise.reject(new Error('denied'));
        return Promise.resolve(localClipboard);
      },
    },
  };

  // document.body. Anchors the page creates for a download get appended here,
  // and a test can then ask whether one was attached BEFORE it was clicked.
  const body = makeEl('body');

  // Every anchor that was clicked, captured at the moment of the click so the
  // page is free to detach it straight afterwards (which it should).
  const clickedAnchors: FakeEl[] = [];

  // Object URLs, recorded. `revoked` is what proves the page does not revoke
  // synchronously: revoking right after click() cancels the transfer, which was
  // measured as a 0-byte file, so the revoke must be deferred.
  const objectUrls: string[] = [];
  const revoked: string[] = [];
  const fakeURL = {
    createObjectURL: (blob: unknown) => {
      const href = 'blob:h.test/' + objectUrls.length;
      objectUrls.push(href);
      void blob;
      return href;
    },
    revokeObjectURL: (href: string) => { revoked.push(href); },
  };

  const fn = new Function(
    'RFB', 'window', 'document', 'location', 'navigator', 'URLSearchParams', 'console',
    'fetch', 'setTimeout', 'Promise', 'Array', 'Math', 'encodeURIComponent',
    'URL', 'parseInt',
    viewScript(),
  );

  fn(
    FakeRFB,
    fakeWindow,
    {
      getElementById: el,
      createElement: (tag: string) => {
        const node = makeEl(tag);
        if (tag === 'a') {
          // Record at click time: a download anchor is clicked and then removed,
          // so this is the only moment its state can be observed.
          const inner = node.click;
          node.click = () => { inner(); clickedAnchors.push(node); };
        }
        return node;
      },
      addEventListener: () => {},
      // A real body, so appending to it is observable and an anchor's click can
      // be judged on whether it was attached at the time.
      body: body,
    },
    { protocol: 'https:', host: 'h.test', search: opts.search ?? '' },
    navigator,
    URLSearchParams,
    { log: () => {}, warn: () => {}, error: () => {} },
    fetch,
    setTimeout,
    Promise,
    Array,
    Math,
    encodeURIComponent,
    fakeURL,
    parseInt,
  );

  // Let the boot POST resolve, so the page has reached attach() and registered
  // its RFB listeners. Two turns: one for the fetch promise, one for the
  // loadRFB() promise that connect() chains onto it.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  return {
    fire: (type, ev) => (winListeners.get(type) || []).forEach((f) => f(ev)),
    pushed,
    written,
    remoteCopy: (text) =>
      (rfbListeners.get('clipboard') || []).forEach((f) => f({ detail: { text } })),
    setLocalClipboard: (t) => { localClipboard = t; },
    get rejectReadText() { return state.rejectReadText; },
    set rejectReadText(v: boolean) { state.rejectReadText = v; },
    get rejectWriteText() { return state.rejectWriteText; },
    set rejectWriteText(v: boolean) { state.rejectWriteText = v; },
    connected: () => (rfbListeners.get('connect') || []).forEach((f) => f({})),
    el,
    click: (id) => el(id).emit('click'),
    /** The file bar's traffic: everything except the boot POST. */
    get fetches() { return allFetches.filter((f) => !isStart(f.url)); },
    /** The boot/Retry POSTs, so the start behaviour can be asserted directly. */
    get starts() { return allFetches.filter((f) => isStart(f.url)); },
    /** Press "Try again" on the overlay. */
    retry: () => el('retry').emit('click'),
    setDownloads: (rows) => { state.downloads = rows; },
    get failDownloadsFetch() { return state.failDownloadsFetch; },
    set failDownloadsFetch(v: boolean) { state.failDownloadsFetch = v; },
    get failUploads() { return state.failUploads; },
    set failUploads(v: boolean) { state.failUploads = v; },
    setOwner: (o: string) => { state.owner = o; },
    /** Make the bytes endpoint answer this status, with this JSON error body. */
    failDownloadBytes: (status: number, errorBody: unknown) => {
      state.downloadStatus = status;
      state.downloadErrorBody = errorBody;
    },
    setServedFile: (o: { length?: number; disposition?: string }) => {
      if (o.length !== undefined) state.downloadLength = o.length;
      if (o.disposition !== undefined) state.downloadDisposition = o.disposition;
    },
    failUploadWith: (status: number, errorBody: unknown) => {
      state.failUploads = true;
      state.uploadStatus = status;
      state.uploadErrorBody = errorBody;
    },
    // Anchors the page CLICKED, recorded at click time. Reading body.children
    // instead would always be empty: the page removes the anchor immediately
    // after clicking it, which is correct (it must not litter the document).
    anchors: () => clickedAnchors,
    objectUrls,
    revoked,
    chooseFiles: (names) => {
      const input = el('up');
      // A browser sets both before firing 'change'.
      input.files = names.map((name) => ({ name }));
      if (names.length) input.value = 'C:\\fakepath\\' + names[0];
      input.emit('change');
    },
    rows: () => el('dls').children,
    maxConcurrentUploads: () => conc.max,
  };
}

/** Let the page's clipboard promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('remote clipboard: the desktop copies, the operator pastes locally', () => {
  it('mirrors text copied inside the desktop into the local clipboard', async () => {
    const h = await runView();
    h.remoteCopy('copied in the remote browser');
    await settle();
    expect(h.written).toContain('copied in the remote browser');
  });

  it('ignores an empty clipboard event instead of clearing what the user had', async () => {
    const h = await runView();
    h.remoteCopy('');
    await settle();
    expect(h.written).toEqual([]);
  });

  it('survives writeText being refused, which happens whenever the tab is unfocused', async () => {
    // The copy already happened inside the desktop; a rejection here must not
    // become an unhandled rejection on a page whose job is to look like it works.
    const h = await runView({ rejectWriteText: true });
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      h.remoteCopy('text');
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', onRej);
    }
    expect(seen).toEqual([]);
  });
});

describe('remote clipboard: the operator copies locally, then pastes into the desktop', () => {
  it('ships pasted text to the desktop, which is what Ctrl+V there will read', async () => {
    const h = await runView();
    h.fire('paste', { clipboardData: { getData: () => 'from my machine' } });
    await settle();
    expect(h.pushed).toContain('from my machine');
  });

  it('reads the local clipboard when the tab regains focus', async () => {
    // There is no "clipboard changed" event, and readText only works while the
    // document is focused — so focus is the one moment this can be done.
    const h = await runView();
    h.setLocalClipboard('copied in another app');
    h.fire('focus');
    await settle();
    expect(h.pushed).toContain('copied in another app');
  });

  it('does NOT echo text that came from the desktop back to the desktop', async () => {
    // Mirroring remote -> local and then polling local -> remote is a loop that
    // would overwrite a selection made while it was in flight.
    const h = await runView();
    h.remoteCopy('from the desktop');
    await settle();
    h.setLocalClipboard('from the desktop');
    h.fire('focus');
    await settle();
    expect(h.pushed).toEqual([]);
  });

  it('still sends genuinely new text after an echo was suppressed', async () => {
    const h = await runView();
    h.remoteCopy('first');
    await settle();
    h.setLocalClipboard('first');
    h.fire('focus');          // suppressed
    await settle();
    h.setLocalClipboard('second');
    h.fire('focus');          // must get through
    await settle();
    expect(h.pushed).toEqual(['second']);
  });

  it('ignores a paste that carries no text (an image, or an empty clipboard)', async () => {
    const h = await runView();
    h.fire('paste', { clipboardData: { getData: () => '' } });
    h.fire('paste', {});
    await settle();
    expect(h.pushed).toEqual([]);
  });

  it('does not push an EMPTY local clipboard on focus', async () => {
    // Focus fires on every return to the tab, and readText resolves with '' when
    // the clipboard is empty. Sending that would wipe the remote selection just
    // because the operator clicked back into the window.
    const h = await runView();
    h.setLocalClipboard('');
    h.fire('focus');
    await settle();
    expect(h.pushed).toEqual([]);
  });

  it('does not wipe the desktop selection when the local clipboard is empty', async () => {
    // The sharp version of the case above. Once ANY text has moved, the
    // "same as last time" guard no longer happens to cover the empty string, so
    // an empty read would be forwarded and would clear the remote clipboard --
    // destroying something the operator copied inside the desktop.
    const h = await runView();
    h.remoteCopy('selected inside the desktop');
    await settle();
    h.setLocalClipboard('');
    h.fire('focus');
    await settle();
    expect(h.pushed).toEqual([]);
  });

  it('sends the same text only ONCE, however often the tab is refocused', async () => {
    // Focus fires constantly (alt-tab, clicking back in). Re-sending the
    // clipboard every time floods the desktop with redundant selection updates,
    // each of which clobbers anything selected there in the meantime.
    const h = await runView();
    h.setLocalClipboard('one copy');
    h.fire('focus');
    await settle();
    h.fire('focus');
    await settle();
    h.fire('focus');
    await settle();
    expect(h.pushed).toEqual(['one copy']);
  });

  it('sends the same text only ONCE when pasted repeatedly', async () => {
    const h = await runView();
    const ev = { clipboardData: { getData: () => 'repeated' } };
    h.fire('paste', ev);
    h.fire('paste', ev);
    await settle();
    expect(h.pushed).toEqual(['repeated']);
  });

  it('survives readText being denied, as it is in browsers without the API', async () => {
    const h = await runView({ rejectReadText: true });
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      h.fire('focus');
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', onRej);
    }
    expect(seen).toEqual([]);
    // And the ordinary paste path must still work without readText.
    h.fire('paste', { clipboardData: { getData: () => 'typed then pasted' } });
    await settle();
    expect(h.pushed).toContain('typed then pasted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The file bar: remote download / upload, EXECUTED.
//
// «ب) دانلود/آپلود یا امپورت/اکسپورت ریموت»
//
// Capturing a download server-side (RealChromeShelf, above) only put the bytes
// on the server's disk. Chrome's own shelf on the remote screen lists paths on
// the SERVER, which the operator cannot open. These tests drive the two controls
// that make the files actually reachable from the operator's machine.
// ─────────────────────────────────────────────────────────────────────────────

const KEY_SEARCH = '?api_key=k3y%2Fneeds%2Fescaping';

describe('the file bar appears only when there is a desktop to exchange files with', () => {
  it('is hidden while Chromium is still starting', async () => {
    const h = await runView();
    // The module body has run and connect() has been called, but the desktop
    // has not answered yet.
    expect(h.el('files').hidden).toBe(true);
  });

  it('is revealed once the desktop connects', async () => {
    const h = await runView();
    h.connected();
    expect(h.el('files').hidden).toBe(false);
  });

  it('keeps the downloads panel collapsed until it is asked for', async () => {
    const h = await runView();
    h.connected();
    expect(h.el('panel').hidden).toBe(true);
    // And nothing was fetched merely by connecting.
    expect(h.fetches).toEqual([]);
  });
});

/**
 * The reported dead end, from the other side:
 *
 *   «موقعه ای که میخام مرورگر ریموت رو بالا بیارم … Missing: Xvfb … بعد من همین
 *    Retry رو میزنم شروع میکنه به starting cromium... ولی باز فقط میچرخه و چیزی
 *    بالا نمیاد»
 *
 * Retry used to lead to this page, and this page only CONNECTED — so it waited
 * for a desktop nobody had started, for ever. These tests hold the page to
 * starting the stack itself, and to saying so when it cannot.
 */
describe('bringing the stack up, not just connecting to it', () => {
  it('asks the server to start everything before it tries to connect', async () => {
    const h = await runView({ search: KEY_SEARCH });
    expect(h.starts).toHaveLength(1);
    expect(String(h.starts[0].init.method).toUpperCase()).toBe('POST');
    // The credential has to be a header: /browser/* is not covered by the
    // desktop cookie (Path=/desktop), and a key in the URL outlives the request.
    const headers = h.starts[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k3y/needs/escaping');
    expect(h.starts[0].url).not.toContain('api_key=');
  });

  it('reports the server own reason instead of spinning for ever', async () => {
    // The spinner WAS the bug: a failure that looks exactly like a slow start.
    const h = await runView({ failStart: true });
    expect(h.el('note').hidden).not.toBe(true);
    // The message names the missing package, because that is the only part the
    // operator can act on — a generic "could not start" throws it away.
    expect(h.el('msg').textContent).toContain('Missing: Xvfb');
    // And the button is offered, not the spinner.
    expect(h.el('retry').hidden).toBe(false);
    expect(h.el('spin').hidden).toBe(true);
  });

  it('actually retries: the button starts the stack again', async () => {
    // Retry that merely re-renders is what sent the operator round in circles.
    const h = await runView({ failStart: true });
    expect(h.starts).toHaveLength(1);
    h.retry();
    await settle();
    expect(h.starts).toHaveLength(2);
  });
});

describe('listing what the remote browser downloaded', () => {
  it('fetches the list when the panel is opened, not before', async () => {
    const h = await runView({ search: KEY_SEARCH });
    h.connected();
    h.click('dlbtn');
    await settle();
    expect(h.el('panel').hidden).toBe(false);
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0].url).toContain('/browser/real/downloads');
  });

  it('authenticates with the page own api_key, in a header and not the url', async () => {
    // The desktop session cookie is scoped to Path=/desktop, so it does NOT
    // cover /browser/* — the api_key is the only credential that works here.
    //
    // It travels as a HEADER. A key in the query string is copied into the
    // download history, the address bar and every proxy log in between, which
    // for a whole-instance credential outlives the request that needed it.
    const h = await runView({ search: KEY_SEARCH });
    h.connected();
    h.click('dlbtn');
    await settle();
    const headers = h.fetches[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k3y/needs/escaping');
    expect(h.fetches[0].url).not.toContain('api_key=');
  });

  it('closes the panel again on a second press and does not refetch', async () => {
    const h = await runView();
    h.connected();
    h.click('dlbtn');
    await settle();
    h.click('dlbtn');
    await settle();
    expect(h.el('panel').hidden).toBe(true);
    expect(h.fetches).toHaveLength(1);
  });

  it('links a completed download to the token url that serves its real name', async () => {
    const h = await runView({ search: KEY_SEARCH });
    h.setDownloads([
      { token: 'dl_9f2c8a1b4e7d0c3f5a6b2e91', name: 'report.png', state: 'completed', size: 2048 },
    ]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();

    const rows = h.rows();
    expect(rows).toHaveLength(1);
    const link = rows[0].children[0];
    expect(link.tag).toBe('a');
    expect(link.href).toContain('/browser/downloads/dl_9f2c8a1b4e7d0c3f5a6b2e91');
    // NOT in the url: the click is intercepted and the bytes are fetched with
    // the key in a header instead (see the transfer tests below).
    expect(link.href).not.toContain('api_key=');
    // The whole point of the name/format fix: the operator receives
    // "report.png", not "dl_9f2c...".
    expect(link.textContent).toBe('report.png');
    expect(link.attrs.download).toBe('report.png');
  });

  it('asks for the bytes under the owner the list endpoint reported', async () => {
    // The list endpoint RETURNS `owner` precisely so a client does not hardcode
    // it. Writing the bytes under one identity and looking for them under
    // another is the documented ENOENT hand-over bug.
    const h = await runView();
    h.setOwner('someone-else');
    h.setDownloads([
      { token: 'dl_9f2c8a1b4e7d0c3f5a6b2e91', name: 'report.png', state: 'completed', size: 2048 },
    ]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();
    expect(h.rows()[0].children[0].href).toContain('userId=someone-else');
  });

  it('puts the remote-supplied name in text, never in markup', async () => {
    // The name arrived from a remote server Content-Disposition header. Writing
    // it as innerHTML would execute it.
    const h = await runView();
    const nasty = '<img src=x onerror=alert(1)>.png';
    h.setDownloads([{ token: 'dl_aaaaaaaaaaaaaaaaaaaaaaaa', name: nasty, state: 'completed', size: 1 }]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();

    const link = h.rows()[0].children[0];
    // textContent keeps it inert AND keeps it verbatim.
    expect(link.textContent).toBe(nasty);
    expect(h.el('dls')).not.toHaveProperty('innerHTML');
  });

  it('offers no link for a failed download, and says why', async () => {
    const h = await runView();
    h.setDownloads([
      { token: 'dl_bbbbbbbbbbbbbbbbbbbbbbbb', name: 'huge.iso', state: 'failed', error: 'too large' },
    ]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();

    const row = h.rows()[0];
    expect(row.children).toHaveLength(0);   // a dead link is worse than no link
    expect(row.textContent).toContain('huge.iso');
    expect(row.textContent).toContain('too large');
  });

  it('offers no link for a download still in flight', async () => {
    const h = await runView();
    h.setDownloads([
      { token: 'dl_cccccccccccccccccccccccc', name: 'movie.mp4', state: 'inProgress' },
    ]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();

    const row = h.rows()[0];
    expect(row.children).toHaveLength(0);
    expect(row.textContent).toContain('movie.mp4');
  });

  it('says so plainly when nothing has been downloaded', async () => {
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();

    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0].textContent).toMatch(/nothing/i);
  });

  it('replaces the previous rows instead of appending to them', async () => {
    // Reopening the panel twice must not show every file twice.
    const h = await runView();
    h.setDownloads([{ token: 'dl_dddddddddddddddddddddddd', name: 'a.png', state: 'completed', size: 1 }]);
    h.connected();
    h.click('dlbtn');
    await settle();
    await settle();
    h.click('dlbtn');          // close
    h.click('dlbtn');          // open again
    await settle();
    await settle();

    expect(h.rows()).toHaveLength(1);
  });

  it('does not crash when the browser is not up yet, so it can be retried', async () => {
    const h = await runView();
    h.failDownloadsFetch = true;
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      h.connected();
      h.click('dlbtn');
      await settle();
      await settle();
    } finally {
      process.off('unhandledRejection', onRej);
    }
    expect(seen).toEqual([]);

    // And pressing it again once the browser IS up works.
    h.failDownloadsFetch = false;
    h.setDownloads([{ token: 'dl_eeeeeeeeeeeeeeeeeeeeeeee', name: 'later.pdf', state: 'completed', size: 9 }]);
    h.click('dlbtn');
    h.click('dlbtn');
    await settle();
    await settle();
    expect(h.rows()[0].children[0].textContent).toBe('later.pdf');
  });
});

describe('uploading a local file so the remote browser can pick it up', () => {
  it('opens the hidden file chooser when Upload is pressed', async () => {
    const h = await runView();
    h.connected();
    h.click('upbtn');
    expect(h.el('up').clicks).toBe(1);
  });

  it('posts the chosen file to the upload endpoint with its name', async () => {
    const h = await runView({ search: KEY_SEARCH });
    h.connected();
    h.chooseFiles(['quarterly report.xlsx']);
    await new Promise((r) => setTimeout(r, 120));

    const posts = h.fetches.filter((f) => f.url.indexOf('/browser/uploads') >= 0);
    expect(posts).toHaveLength(1);
    expect(posts[0].init.method).toBe('POST');
    // Header, not query: a file transfer must not write the credential into a
    // URL that outlives it.
    const headers = posts[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k3y/needs/escaping');
    expect(posts[0].url).not.toContain('api_key=');
    // The name must survive the trip, spaces and all — the other half of the
    // «اسم و فرمت» problem, in the upload direction.
    expect(posts[0].url).toContain('name=quarterly%20report.xlsx');
  });

  it('clears the input before uploading, so the same file can be sent twice', async () => {
    // Picking an identical file fires no 'change' at all unless value is reset,
    // which reads to the operator as the upload being ignored.
    const h = await runView();
    h.connected();
    h.chooseFiles(['same.txt']);
    // Cleared synchronously inside the handler, i.e. before awaiting anything:
    // the file object was already captured, so resetting cannot lose it.
    expect(h.el('up').value).toBe('');
    await new Promise((r) => setTimeout(r, 120));

    h.chooseFiles(['same.txt']);
    await new Promise((r) => setTimeout(r, 120));
    const posts = h.fetches.filter((f) => f.url.indexOf('/browser/uploads') >= 0);
    expect(posts).toHaveLength(2);
    // Both really carried the file, i.e. clearing the input did not blank it.
    expect(posts.every((x) => x.url.indexOf('name=same.txt') >= 0)).toBe(true);
  });

  it('uploads several files one at a time rather than all at once', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles(['a.txt', 'b.txt', 'c.txt']);
    await new Promise((r) => setTimeout(r, 120));
    const posts = h.fetches.filter((f) => f.url.indexOf('/browser/uploads') >= 0);
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => decodeURIComponent(p.url.split('name=')[1])))
      .toEqual(['a.txt', 'b.txt', 'c.txt']);
    // The real assertion: they never overlapped. Parallel uploads of several
    // large files on a server that is also running a browser make both slow.
    expect(h.maxConcurrentUploads()).toBe(1);
  });

  it('does nothing at all when the chooser was cancelled', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles([]);
    // The button must not claim work it never did. Without the early return the
    // label walks "Uploading..." -> "Uploaded" for a cancelled dialog, which
    // tells the operator a file arrived when none was ever sent.
    expect(h.el('upbtn').textContent).toBe('');
    await new Promise((r) => setTimeout(r, 120));
    expect(h.el('upbtn').textContent).toBe('');
    expect(h.fetches.filter((f) => f.url.indexOf('/browser/uploads') >= 0)).toHaveLength(0);
  });

  it('reports progress and then returns the button to being a button', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles(['doc.pdf']);
    // Mid-flight the operator must see that something is happening.
    expect(h.el('upbtn').textContent).toMatch(/upload/i);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.el('upbtn').textContent).toBe('Uploaded');

    // ...and it must not stay stuck on the outcome forever.
    await new Promise((r) => setTimeout(r, 2600));
    expect(h.el('upbtn').textContent).toBe('Upload');
  }, 8000);

  it('tells the operator when an upload was rejected, then recovers', async () => {
    const h = await runView();
    h.failUploads = true;
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      h.connected();
      h.chooseFiles(['toobig.iso']);
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      process.off('unhandledRejection', onRej);
    }
    // A silent failure is the worst outcome: the operator waits for a file that
    // is never coming.
    expect(h.el('upbtn').textContent).toMatch(/failed/i);
    expect(seen).toEqual([]);

    await new Promise((r) => setTimeout(r, 2600));
    expect(h.el('upbtn').textContent).toBe('Upload');
  }, 8000);

  it('stops the chain when one file of several fails', async () => {
    const h = await runView();
    h.failUploads = true;
    h.connected();
    h.chooseFiles(['a.txt', 'b.txt']);
    await new Promise((r) => setTimeout(r, 120));
    // The first rejected; the second must not be fired blindly afterwards.
    const posts = h.fetches.filter((f) => f.url.indexOf('/browser/uploads') >= 0);
    expect(posts).toHaveLength(1);
    expect(h.el('upbtn').textContent).toMatch(/failed/i);
  }, 8000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Claiming the bytes when saveAs loses the race.
//
// MEASURED on the live stack, with a second client attached to the shared real
// Chromium:
//
//   download.saveAs: ENOENT: no such file or directory, copyfile
//   '/home/user/webapp/downloads/31b1a110-...' -> '.../report.png'
//   SHELF=[{"name":"report.png","state":"failed","size":0}]
//
// The bytes existed; the shelf still showed a failure. These tests drive
// RealChromeShelf.track() with a Download stand-in that reproduces exactly that,
// on a real temp directory, and assert the file ends up ON the shelf.
// ─────────────────────────────────────────────────────────────────────────────

/** A Download stand-in. saveAs behaves as configured; path() reports the artifact. */
function fakeDownload(opts: {
  url: string;
  suggested: string;
  artifact: string;          // where the "browser" left the bytes
  saveAsFails?: boolean;     // reproduce the measured ENOENT
  artifactMissing?: boolean; // nothing to fall back to either
}) {
  const calls = { saveAs: 0, path: 0 };
  return {
    calls,
    url: () => opts.url,
    suggestedFilename: () => opts.suggested,
    saveAs: async (dest: string) => {
      calls.saveAs += 1;
      if (opts.saveAsFails) {
        throw new Error(
          `download.saveAs: ENOENT: no such file or directory, copyfile '${opts.artifact}' -> '${dest}'`,
        );
      }
      await fs.copyFile(opts.artifact, dest);
    },
    path: async () => {
      calls.path += 1;
      return opts.artifactMissing ? null : opts.artifact;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching the bytes: the pipeline ported from the SIMULATOR, which is the one
// the operator said already worked («کلی انرژی گذاشته بودم»). Each test here
// pins one thing that pipeline knows and a plain <a href> does not.
// ─────────────────────────────────────────────────────────────────────────────

const ONE_ROW = [
  { token: 'dl_9f2c8a1b4e7d0c3f5a6b2e91', name: 'stale-name.bin', state: 'completed', size: 2048 },
];

/** Open the panel and click the single row's link. */
async function clickTheDownload(h: Harness) {
  h.connected();
  h.click('dlbtn');
  await settle();
  await settle();
  h.rows()[0].children[0].emit('click', { preventDefault: () => {} });
  // A real duration, not a count of microtask turns: the transfer is HEAD -> GET
  // -> blob, and each hop is a fake response with its own timers.
  await new Promise((r) => setTimeout(r, 60));
}

describe('fetching a downloaded file to the operator machine', () => {
  it('asks with HEAD first, so a refusal can be explained at all', async () => {
    // Handing a failing URL straight to the browser shows only Chrome's own
    // "Failed - Unknown server error" and throws the server's sentence away, so
    // an expired token, a missing file and a wrong key become one
    // indistinguishable failure. HEAD is what makes the reason readable.
    const h = await runView();
    h.setDownloads(ONE_ROW);
    await clickTheDownload(h);
    const byteCalls = h.fetches.filter((f) => f.url.indexOf('/browser/downloads/') >= 0);
    expect(byteCalls[0].init.method).toBe('HEAD');
  });

  it('takes the name from the SERVED file, not from the shelf row', async () => {
    // The row's name is a stale copy: the server renames an extension-less
    // download once it has identified the bytes, so the row can still say
    // "download" where the served file is "report.png". This is «اسم و فرمت».
    const h = await runView();
    h.setDownloads(ONE_ROW);
    h.setServedFile({ disposition: 'attachment; filename="report.png"' });
    await clickTheDownload(h);
    const a = h.anchors();
    expect(a).toHaveLength(1);
    expect(a[0].download).toBe('report.png');
  });

  it('prefers the RFC 6266 filename* copy, because the ascii copy is lossy', async () => {
    // The server transliterates the plain `filename=` copy, so a Persian name
    // arrives as _____.png. The starred form carries the real characters.
    const h = await runView();
    h.setDownloads(ONE_ROW);
    h.setServedFile({
      disposition: "attachment; filename=\"_____.png\"; filename*=UTF-8''%D8%B5%D9%81%D8%AD%D9%87.png",
    });
    await clickTheDownload(h);
    expect(h.anchors()[0].download).toBe('صفحه.png');
  });

  it('sends the key in a header and keeps it out of the bytes url', async () => {
    const h = await runView({ search: KEY_SEARCH });
    h.setDownloads(ONE_ROW);
    await clickTheDownload(h);
    const byteCalls = h.fetches.filter((f) => f.url.indexOf('/browser/downloads/') >= 0);
    expect(byteCalls.length).toBeGreaterThan(0);
    for (const c of byteCalls) {
      expect((c.init.headers as Record<string, string>)['x-api-key'])
        .toBe('k3y/needs/escaping');
      expect(c.url).not.toContain('api_key=');
    }
  });

  it('clicks an anchor that is IN the document, or Firefox ignores it', async () => {
    const h = await runView();
    h.setDownloads(ONE_ROW);
    await clickTheDownload(h);
    const a = h.anchors()[0];
    expect(a.clicks).toBe(1);
    expect(a.clickedWhileInDocument).toBe(true);
  });

  it('does not revoke the object url while the transfer is still running', async () => {
    // Revoking synchronously after click() cancels the transfer it just started,
    // measured as a 0-byte file. The revoke must be deferred.
    const h = await runView();
    h.setDownloads(ONE_ROW);
    await clickTheDownload(h);
    expect(h.objectUrls).toHaveLength(1);
    expect(h.revoked).toEqual([]);
  });

  it('shows the server own words when the bytes are refused', async () => {
    const h = await runView();
    h.setDownloads(ONE_ROW);
    h.failDownloadBytes(404, { success: false, error: 'That file is no longer on the server.' });
    await clickTheDownload(h);
    // Nothing was handed to the browser...
    expect(h.anchors()).toHaveLength(0);
    // ...and the reason is on the row, not swallowed.
    expect(h.rows()[0].textContent).toContain('no longer on the server');
  });

  it('still says something useful when the refusal carries no message', async () => {
    const h = await runView();
    h.setDownloads(ONE_ROW);
    h.failDownloadBytes(401, 'not json at all');
    await clickTheDownload(h);
    expect(h.rows()[0].textContent).toMatch(/authoris|authoriz/i);
  });

  it('streams a very large file by navigation instead of buffering it', async () => {
    // A Blob holds the whole file in the tab's memory, which is the thing that
    // breaks first on a big download. Over the limit the browser streams it, and
    // that is the ONE path allowed to carry the token in the query.
    const h = await runView({ search: KEY_SEARCH });
    h.setDownloads(ONE_ROW);
    h.setServedFile({ length: 65 * 1024 * 1024 });
    await clickTheDownload(h);
    expect(h.objectUrls).toHaveLength(0);
    const a = h.anchors()[0];
    expect(a.href).toContain('api_key=');
    // Only the HEAD was made: the bytes go through the navigation, not a fetch.
    expect(h.fetches.filter((f) => f.url.indexOf('/browser/downloads/') >= 0))
      .toHaveLength(1);
  });
});

describe('uploading tells the truth about what the server did', () => {
  it('treats a 200 that says success:false as the failure it is', async () => {
    // /browser/uploads answers 200 with { success:false, error } for a rejected
    // file, so checking res.ok alone reports "Uploaded" for a file the server
    // threw away. That is the "it does not actually work" that was reported.
    const h = await runView();
    h.failUploadWith(200, { success: false, error: 'File is too large (40000000 bytes).' });
    h.connected();
    h.chooseFiles(['huge.iso']);
    await new Promise((r) => setTimeout(r, 140));
    expect(h.el('upbtn').textContent).toMatch(/failed/i);
    expect(h.el('dls').textContent).toContain('too large');
  });

  it('says where the file landed, because nothing auto-fills the page dialog', async () => {
    // This view is a VNC screen onto a real Chromium the operator drives by
    // hand; Playwright is not holding its file dialog open, so there is no
    // chooser to answer. What the operator needs is the name to type into
    // Chromium's own dialog, which IS visible on the virtual screen.
    const h = await runView();
    h.connected();
    h.chooseFiles(['cookies.json']);
    await new Promise((r) => setTimeout(r, 140));
    expect(h.el('dls').textContent).toContain('cookies.json');
    // And the panel is opened, or the message is written somewhere unseen.
    expect(h.el('panel').hidden).toBe(false);
  });

  it('reports the files that DID arrive before a later one failed', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles(['ok.txt']);
    await new Promise((r) => setTimeout(r, 140));
    expect(h.el('dls').textContent).toContain('ok.txt');
  });
});

describe('a download is not lost when saveAs loses the race for the artifact', () => {
  it('keeps the file by falling back to the artifact the browser reports', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const artifact = path.join(dir, 'e2f1a9c4-guid-artifact');
    await fs.writeFile(artifact, PNG);

    const dl = fakeDownload({
      url: 'http://example.test/report',
      suggested: 'report.png',
      artifact,
      saveAsFails: true,      // exactly what was measured
    });

    const entry = await shelf.track(dl as never);

    // The complaint was a failed row for a file that existed.
    expect(entry.state).toBe('completed');
    expect(entry.name).toBe('report.png');
    expect(entry.size).toBe(PNG.length);
    expect(dl.calls.saveAs).toBe(1);   // the right call is still tried FIRST
    expect(dl.calls.path).toBe(1);     // and only then the fallback

    // The bytes are really there, and they are really a PNG — resolved the way
    // the SERVER resolves them when the operator clicks the link, so this also
    // proves the token actually leads to the file.
    const resolved = await resolveDownload(REAL_CHROME_SHELF_USER, entry.token);
    const saved = await fs.readFile(resolved.path);
    expect(saved.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(resolved.name).toBe('report.png');
  });

  it('leaves the browser artifact in place rather than moving it', async () => {
    // Another consumer may still own it; a rename would steal it.
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const artifact = path.join(dir, 'shared-artifact');
    await fs.writeFile(artifact, PDF);

    await shelf.track(fakeDownload({
      url: 'http://example.test/doc',
      suggested: 'doc.pdf',
      artifact,
      saveAsFails: true,
    }) as never);

    await expect(fs.stat(artifact)).resolves.toBeTruthy();
  });

  it('still reports the ORIGINAL failure when there is no artifact either', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const entry = await shelf.track(fakeDownload({
      url: 'http://example.test/gone',
      suggested: 'gone.png',
      artifact: path.join(dir, 'never-written'),
      saveAsFails: true,
      artifactMissing: true,
    }) as never);

    // A row stuck at inProgress is how a user waits forever for nothing.
    expect(entry.state).toBe('failed');
    // The message must name the real cause, not a symptom of the fallback.
    expect(entry.error).toContain('saveAs');
  });

  it('does not touch the fallback at all when saveAs works', async () => {
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const artifact = path.join(dir, 'ok-artifact');
    await fs.writeFile(artifact, PNG);

    const dl = fakeDownload({ url: 'http://example.test/ok.png', suggested: 'ok.png', artifact });
    const entry = await shelf.track(dl as never);

    expect(entry.state).toBe('completed');
    expect(dl.calls.path).toBe(0);   // no needless second guess on the happy path
  });

  it('still rescues the extension of a nameless download taken from the artifact', async () => {
    // Both halves of the «اسم و فرمت» fix must survive the fallback path.
    const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
    const artifact = path.join(dir, '9c1d77aa-2b3e-4f10-8a55-bd0e12345678');
    await fs.writeFile(artifact, PNG);

    const entry = await shelf.track(fakeDownload({
      url: 'http://example.test/stream',
      suggested: '',            // no name at all, as measured
      artifact,
      saveAsFails: true,
    }) as never);

    expect(entry.state).toBe('completed');
    expect(entry.name.toLowerCase().endsWith('.png')).toBe(true);
  });
});
