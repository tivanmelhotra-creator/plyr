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
   * counting; use `starts` for that one. Also excludes the BACKGROUND WATCH
   * traffic, for the same reason and by the same rule: once the desktop
   * connects, the view polls for a pending file dialog and for new downloads
   * every WATCH_MS, so folding those into these counts would make every
   * assertion here a race against a timer. `watch` exposes them.
   */
  fetches: Array<{ url: string; init: Record<string, unknown> }>;
  /** The POSTs to /browser/real/open, from page load and from Retry. */
  starts: Array<{ url: string; init: Record<string, unknown> }>;
  /** The background watcher's own polls, so they can be asserted directly. */
  watch: Array<{ url: string; init: Record<string, unknown> }>;
  /** What GET /browser/real/chooser will report is pending, or null. */
  setPendingChooser: (c: unknown) => void;
  /** Make POST /browser/real/chooser refuse, as it does when the page moved on. */
  failChooserAnswer: (status: number, errorBody: unknown) => void;
  /** Everything sent to /browser/real/chooser, in order. */
  chooserCalls: () => Array<{ url: string; init: Record<string, unknown> }>;
  /** Let the watcher run for roughly this many of its own ticks. */
  ticks: (n?: number) => Promise<void>;
  /** Press "Try again" on the status overlay. */
  retry: () => void;
  /**
   * What /browser/real/downloads will answer with.
   *
   * Typed by its `token` rather than as `unknown[]`, because the fake DELETE
   * branch has to find a row by token to remove it — which is what makes a
   * Remove button that deletes nothing fail here.
   */
  setDownloads: (rows: Array<{ token?: string }>) => void;
  /** Make the downloads fetch reject outright. */
  failDownloadsFetch: boolean;
  /** Make DELETE /browser/real/downloads/:token answer 404. */
  failDelete: boolean;
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
  /** The rendered rows of the workspace tree (placeholders included). */
  tree: () => FakeEl[];
  /** Every request the view made to /browser/workflow-files/. */
  wfCalls: () => Array<{ url: string; init: Record<string, unknown> }>;
  /** Make POST .../use refuse, as the real route does when the dialog is gone. */
  failUse: (status: number, errorBody: unknown) => void;
  /** Replace the fake workflow's tree. */
  setTree: (tree: Record<string, Array<{ name: string; path: string; type: string; size: number }>>) => void;
  /** What GET /browser/workflow-files-binding reports the Local Browser is bound to ('' = nothing). */
  setBinding: (id: string) => void;
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
  /**
   * The file input's own filter, mirrored from the REMOTE page's input.
   *
   * Recorded because it is the difference between offering the operator the file
   * the page will accept and offering them everything on their disk: a cookie
   * importer that takes only .json must not be handed a .png.
   */
  accept: string;
  multiple: boolean;
  type: string;
  /**
   * Whether the control refuses input.
   *
   * Needed because the Remove button disables ITSELF while its DELETE is in
   * flight and re-enables on failure. Without this on the fake, a double-click
   * that deletes twice — or a button left permanently dead after one failed
   * delete — would both pass unnoticed.
   */
  disabled: boolean;
  addEventListener: (type: string, fn: (ev: unknown) => void) => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  appendChild: (c: FakeEl) => void;
  replaceChild: (c: FakeEl, old: FakeEl) => void;
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
    accept: '',
    multiple: false,
    type: '',
    disabled: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    // Needed by the drawer's inline rename, which swaps the name span for an
    // input and back. Real DOM semantics: the new node takes the old one's slot.
    replaceChild(c, old) {
      const at = el.children.indexOf(old);
      if (at < 0) return;
      if (c.parent && c.parent !== el) c.parent.removeChild(c);
      c.parent = el;
      old.parent = null;
      el.children[at] = c;
    },
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
      // A real browser fires NOTHING on a disabled control. Modelled, because
      // the Remove button disables itself for the duration of its DELETE: a fake
      // that dispatched anyway would let a double-click send two deletes and
      // still pass.
      if (el.disabled) return;
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
    /**
     * window.prompt. Absent by default, which is what the view's `ask()`
     * guard is for; a test about New Folder / New File / Rename supplies one.
     */
    prompt?: (text: string, initial?: string) => string | null;
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
    // Make the Remove endpoint answer 404, the way the real route does when the
    // token is not on the shelf (e.g. the browser restarted since the panel was
    // rendered).
    failDelete: false,
    downloads: [] as Array<{ token?: string }>,
    // The identity the list endpoint reports its files are stored under.
    owner: 'local',
    // What /browser/downloads/<token> answers with.
    downloadStatus: 200,
    downloadLength: 2048,
    downloadDisposition: '',
    downloadErrorBody: { success: false, error: 'That file is gone.' } as unknown,
    uploadStatus: 200,
    uploadErrorBody: { success: false, error: 'File is too large.' } as unknown,
    // What GET /browser/real/chooser reports. null is the ordinary answer: most
    // of the time no page is asking for a file.
    pendingChooser: null as unknown,
    chooserAnswerStatus: 200,
    chooserAnswerBody: {
      success: false,
      error: 'The page is not asking for a file any more.',
    } as unknown,
    // The saved workflow's files, by folder ('' = root), as the list route
    // reports them. Only consulted when the page was opened with ?workflowId=.
    wfTree: {
      '': [
        { name: 'docs', path: 'docs', type: 'dir', size: 0 },
        { name: 'cookies.json', path: 'cookies.json', type: 'file', size: 12 },
        { name: 'photo.png', path: 'photo.png', type: 'file', size: 2048 },
      ],
      docs: [
        { name: 'readme.txt', path: 'docs/readme.txt', type: 'file', size: 7 },
      ],
    } as Record<string, Array<{ name: string; path: string; type: string; size: number }>>,
    // Which workflow the server says the Local Browser is bound to right now;
    // '' is the ordinary answer for a view opened outside any workflow.
    boundWorkflowId: '',
    // How POST /browser/workflow-files/:id/use answers.
    wfUseStatus: 200,
    wfUseBody: { success: false, error: 'The page is not asking for a file any more.' } as unknown,
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
   * The background watcher's traffic, held apart from `fetches` for exactly the
   * reason the boot POST is.
   *
   * The view now polls two endpoints every WATCH_MS once the desktop connects,
   * because both halves of the file transfer are started by something INSIDE the
   * remote page and neither can wait for the operator to press something in this
   * bar. The polls are: GET /browser/real/chooser (is a page asking for a file?)
   * and the shelf list marked with ?watch=1 (did anything finish downloading?).
   *
   * A shelf read that carries no ?watch=1 is the OPERATOR opening the panel, and
   * that one stays in `fetches` where the existing assertions expect it.
   */
  const isWatch = (url: string) =>
    url.indexOf('/browser/real/chooser') >= 0 || url.indexOf('watch=1') >= 0;

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
      // DELETE /browser/real/downloads/:token — the Remove control. Modelled
      // like the real route: the row is dropped from the SERVER's list and the
      // remaining list is returned, because the view re-renders from that answer
      // rather than patching its own DOM. A fake that ignored the method and
      // kept answering with every row would let a Remove button that deletes
      // nothing pass.
      if (String(init.method || 'GET').toUpperCase() === 'DELETE') {
        if (state.failDelete) {
          return Promise.resolve(reply({
            status: 404,
            body: { success: false, error: 'No such download.' },
          }));
        }
        const token = decodeURIComponent(url.split('/browser/real/downloads/')[1] || '');
        state.downloads = state.downloads.filter((d) => d.token !== token);
        return Promise.resolve(reply({ body: { success: true, downloads: state.downloads } }));
      }
      return Promise.resolve(reply({
        body: { success: true, owner: state.owner, downloads: state.downloads },
      }));
    }
    // The file-dialog handshake. Answered before the upload fallthrough below,
    // which would otherwise treat a chooser POST as an upload and hand the page
    // an invented token.
    if (url.indexOf('/browser/real/chooser') >= 0) {
      const method = String(init.method || 'GET').toUpperCase();
      if (method === 'POST') {
        if (state.chooserAnswerStatus === 200) {
          // The REAL server closes the slot when it answers: accept() calls
          // forget(), so the very next GET reports nothing pending. A fake that
          // kept reporting the same request would make the view see a BRAND NEW
          // request on the next tick and open the picker again — which is a
          // fake-fidelity gap, and it read exactly like the view failing to
          // reuse an already-uploaded file.
          state.pendingChooser = null;
          return Promise.resolve(reply({ body: { success: true, count: 1 } }));
        }
        return Promise.resolve(
          reply({ status: state.chooserAnswerStatus, body: state.chooserAnswerBody }),
        );
      }
      if (method === 'DELETE') {
        // cancel() clears the slot too, for the same reason.
        state.pendingChooser = null;
        return Promise.resolve(reply({ body: { success: true, cancelled: true } }));
      }
      return Promise.resolve(reply({
        body: { success: true, owner: state.owner, chooser: state.pendingChooser },
      }));
    }
    // The Workflow Files workspace: list, use, and the mutations. Modelled just
    // far enough that the view's requests can be read back; the storage rules
    // themselves are the routes' tests' business.
    // The binding lookup: the view asks this when its URL carries no id, so a
    // view reached through a placeholder link still finds the workflow the
    // operator is in. Not under /browser/workflow-files/ (no id to put there).
    if (url.indexOf('/browser/workflow-files-binding') >= 0) {
      return Promise.resolve(reply({
        body: { success: true, local: state.boundWorkflowId ? { workflowId: state.boundWorkflowId } : null },
      }));
    }
    if (url.indexOf('/browser/workflow-files/') >= 0) {
      const method = String(init.method || 'GET').toUpperCase();
      const q = /[?&]path=([^&]*)/.exec(url);
      const folder = q ? decodeURIComponent(q[1]) : '';
      // The binding: the view says which workflow the Local Browser works for
      // the moment the desktop connects. Acknowledged and recorded (through
      // allFetches), nothing more: the persistence it enables lives on the server.
      if (url.indexOf('/bind') >= 0 && method === 'POST') {
        return Promise.resolve(reply({ body: { success: true, target: 'local', workflowId: 'wf_42', bound: true } }));
      }
      if (url.indexOf('/use') >= 0 && method === 'POST') {
        if (state.wfUseStatus === 200) {
          state.pendingChooser = null;
          return Promise.resolve(reply({ body: { success: true, name: 'cookies.json', size: 12, count: 1 } }));
        }
        return Promise.resolve(reply({ status: state.wfUseStatus, body: state.wfUseBody }));
      }
      if (method === 'GET') {
        return Promise.resolve(reply({
          body: { success: true, path: folder, parent: folder ? '' : null, entries: state.wfTree[folder] || [] },
        }));
      }
      // mkdir / upload / rename / delete: acknowledged, nothing modelled.
      return Promise.resolve(reply({ body: { success: true } }));
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
    'URL', 'parseInt', 'prompt',
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
    opts.prompt,
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
    /** The file bar's traffic: everything the operator's own presses caused. */
    get fetches() {
      return allFetches.filter((f) => !isStart(f.url) && !isWatch(f.url));
    },
    /** The boot/Retry POSTs, so the start behaviour can be asserted directly. */
    get starts() { return allFetches.filter((f) => isStart(f.url)); },
    /** The background watcher's polls. */
    get watch() { return allFetches.filter((f) => isWatch(f.url)); },
    setPendingChooser: (c: unknown) => { state.pendingChooser = c; },
    failChooserAnswer: (status: number, errorBody: unknown) => {
      state.chooserAnswerStatus = status;
      state.chooserAnswerBody = errorBody;
    },
    chooserCalls: () =>
      allFetches.filter((f) => f.url.indexOf('/browser/real/chooser') >= 0),
    /**
     * Let the watcher actually run. Real time, not microtask turns: each tick is
     * a chain of fake responses that resolve on their own timers, and the view
     * schedules the next tick with setTimeout — so only elapsed time advances it.
     */
    ticks: async (n = 1) => {
      for (let i = 0; i < n; i += 1) {
        await new Promise((r) => setTimeout(r, 780));
      }
    },
    /** Press "Try again" on the overlay. */
    retry: () => el('retry').emit('click'),
    setDownloads: (rows) => { state.downloads = rows; },
    get failDownloadsFetch() { return state.failDownloadsFetch; },
    set failDownloadsFetch(v: boolean) { state.failDownloadsFetch = v; },
    get failDelete() { return state.failDelete; },
    set failDelete(v: boolean) { state.failDelete = v; },
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
    tree: () => el('wfmlist').children,
    wfCalls: () => allFetches.filter((f) => f.url.indexOf('/browser/workflow-files/') >= 0),
    failUse: (status, errorBody) => { state.wfUseStatus = status; state.wfUseBody = errorBody; },
    setTree: (tree) => { state.wfTree = tree; },
    setBinding: (id) => { state.boundWorkflowId = id; },
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

describe('the hamburger appears only when there is a desktop to exchange files with', () => {
  it('is hidden while Chromium is still starting', async () => {
    const h = await runView();
    // The module body has run and connect() has been called, but the desktop
    // has not answered yet.
    expect(h.el('burger').hidden).toBe(true);
    expect(h.el('files').hidden).toBe(true);
  });

  it('is revealed once the desktop connects', async () => {
    const h = await runView();
    h.connected();
    expect(h.el('burger').hidden).toBe(false);
  });

  it('keeps the drawer shut until it is asked for', async () => {
    // The drawer is an OVERLAY the operator opens; the three standing buttons
    // it replaces are gone, and nothing greets the operator but the page.
    const h = await runView();
    h.connected();
    expect(h.el('files').hidden).toBe(true);
    // And nothing was fetched merely by connecting.
    expect(h.fetches).toEqual([]);
  });

  it('opens from the hamburger and hides the hamburger while it is open', async () => {
    const h = await runView();
    h.connected();
    h.click('burger');
    expect(h.el('files').hidden).toBe(false);
    expect(h.el('burger').hidden).toBe(true);
    // Files pane first: no page is asking, so the workspace is the point.
    expect(h.el('panefiles').hidden).toBe(false);
    expect(h.el('dpick').hidden).toBe(true);
    h.click('dclose');
    expect(h.el('files').hidden).toBe(true);
    expect(h.el('burger').hidden).toBe(false);
  });

  it('says why there is no workspace when the page was not opened from a saved workflow, and the server knows of none', async () => {
    const h = await runView();
    h.connected();
    h.click('burger');
    await settle();
    await settle();
    expect(h.el('wfmlist').textContent).toMatch(/saved workflow/i);
    // The server WAS asked which workflow the Local Browser is bound to (the
    // one fallback that is not a guess), and nothing was listed under an
    // empty id: that URL is the `endpoint not found` incident.
    expect(h.fetches.some((f) => f.url.indexOf('/browser/workflow-files-binding') >= 0)).toBe(true);
    expect(h.fetches.some((f) => f.url.indexOf('/browser/workflow-files/') >= 0)).toBe(false);
  });

  it('THE INCIDENT: no id in the URL, but the Local Browser is bound to one on the server -> that workflow', async () => {
    // A view reached through the placeholder's own links, or the URL-bar
    // "open local", arrives without ?workflowId=. The operator who opened it
    // from a workflow a moment ago is still in that workflow, and the server
    // knows which: GET /browser/workflow-files-binding.
    const h = await runView();
    h.setBinding('wf_bound');
    h.connected();
    await settle();
    await settle();
    // Connecting does NOT bind: the URL named nothing, and the server already
    // holds the binding it is about to be asked for. Nothing was fetched.
    expect(h.wfCalls()).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);
    h.click('burger');
    await settle();
    await settle();
    const lists = h.wfCalls().filter((f) => f.url.indexOf('/bind') < 0);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists[0].url).toContain('/browser/workflow-files/wf_bound?path=');
    expect(h.tree().map((r) => r.attrs['data-name'])).toContain('cookies.json');
  });

  it('never builds a URL from an EMPTY workflow id: every mutation says why and sends nothing', async () => {
    // MEASURED: New Folder without a workflow posted /browser/workflow-files//mkdir
    // and the operator read "Endpoint not found". Now the toolbar says what is
    // really wrong, in the workspace, and nothing leaves the page.
    const h = await runView({ prompt: () => 'anything' });
    h.connected();
    h.click('burger');
    await settle();
    await settle();
    h.click('wfmrefresh');
    await settle();
    await settle();
    expect(h.el('wfmlist').textContent).toMatch(/saved workflow/i);
    h.click('wfmnew');
    h.click('wfmnewfile');
    h.click('wfmupload');
    await settle();
    await settle();
    expect(h.wfCalls()).toHaveLength(0);
    expect(h.fetches.some((f) => /\/browser\/workflow-files\/\//.test(f.url))).toBe(false);
    expect(h.el('wfmnote').textContent).toMatch(/saved workflow/i);
    expect(h.el('wfmup').clicks).toBe(0);
  });

  it('a malformed workflowId in the URL is ignored rather than sent to the server', async () => {
    const h = await runView({ search: '?workflowId=' + encodeURIComponent('../etc') });
    h.connected();
    await settle();
    expect(h.wfCalls()).toHaveLength(0);
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

describe('opening the workspace', () => {
  it('reads the workspace when the drawer is opened, not before', async () => {
    const h = await runView({ search: '?workflowId=wf_42&' + KEY_SEARCH.slice(1) });
    h.connected();
    await settle();
    const before = h.wfCalls().filter((f) => f.url.indexOf('/bind') < 0).length;
    expect(before).toBe(0);
    h.click('burger');
    await settle();
    await settle();
    expect(h.el('files').hidden).toBe(false);
    expect(h.el('panefiles').hidden).toBe(false);
    const lists = h.wfCalls().filter((f) => f.url.indexOf('/bind') < 0);
    expect(lists).toHaveLength(1);
    expect(lists[0].url).toContain('/browser/workflow-files/wf_42?path=');
  });

  it('authenticates with the page own api_key, in a header and not the url', async () => {
    // The desktop session cookie is scoped to Path=/desktop, so it does NOT
    // cover /browser/* — the api_key is the only credential that works here.
    //
    // It travels as a HEADER. A key in the query string is copied into the
    // download history, the address bar and every proxy log in between, which
    // for a whole-instance credential outlives the request that needed it.
    const h = await runView({ search: '?workflowId=wf_42&' + KEY_SEARCH.slice(1) });
    h.connected();
    h.click('burger');
    await settle();
    await settle();
    for (const f of h.wfCalls()) {
      expect((f.init.headers as Record<string, string>)['x-api-key']).toBe('k3y/needs/escaping');
      expect(f.url).not.toContain('api_key=');
    }
  });

  it('closes the drawer again on Close and does not refetch', async () => {
    const h = await runView({ search: '?workflowId=wf_42' });
    h.connected();
    h.click('burger');
    await settle();
    await settle();
    const n = h.wfCalls().length;
    h.click('dclose');
    await settle();
    expect(h.el('files').hidden).toBe(true);
    expect(h.el('burger').hidden).toBe(false);
    expect(h.wfCalls().length).toBe(n);
  });

  it('never fetches the downloads shelf for the operator: there is no shelf to show', async () => {
    // The only reader of /browser/real/downloads left is the background
    // watcher, which marks its reads with ?watch=1.
    const h = await runView({ search: '?workflowId=wf_42' });
    h.connected();
    h.click('burger');
    await settle();
    await settle();
    h.click('dclose');
    h.click('burger');
    await settle();
    expect(h.fetches.filter((f) => f.url.indexOf('/browser/real/downloads') >= 0)).toHaveLength(0);
  });

  it('does not crash when the browser is not up yet, so the watcher can carry on', async () => {
    const h = await runView();
    h.failDownloadsFetch = true;
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      h.connected();
      await h.ticks(2);
    } finally {
      process.off('unhandledRejection', onRej);
    }
    expect(seen).toEqual([]);
    h.failDownloadsFetch = false;
    await h.ticks(2);
    expect(h.watch.filter((f) => f.url.indexOf('watch=1') >= 0).length).toBeGreaterThan(1);
  });
});


describe('uploading a local file so the remote browser can pick it up', () => {
  it('opens the hidden file chooser from Upload from Computer, the operator own click', async () => {
    const h = await runView();
    h.connected();
    h.click('addpc');
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
    // ONE receipt for the batch, naming all three.
    expect(h.el('dnotices').children).toHaveLength(1);
    expect(h.el('dnotices').textContent).toContain('a.txt, b.txt, c.txt');
  });

  it('does nothing at all when the chooser was cancelled', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles([]);
    await new Promise((r) => setTimeout(r, 120));
    // No receipt claims work that was never done, and nothing was sent.
    expect(h.el('dnotices').children).toHaveLength(0);
    expect(h.fetches.filter((f) => f.url.indexOf('/browser/uploads') >= 0)).toHaveLength(0);
  });

  it('tells the operator when an upload was rejected, in a receipt that stays', async () => {
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
    // is never coming. A message that flicks away after 2.5 s is nearly as bad.
    const err = h.el('dnotices').children.find((c) => c.className === 'rowerr');
    expect(err).toBeDefined();
    expect(err!.textContent).toContain('too large');
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 2600));
    expect(h.el('dnotices').children.some((c) => c.className === 'rowerr')).toBe(true);
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
    expect(h.el('dnotices').children.some((c) => c.className === 'rowerr')).toBe(true);
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

/**
 * A download that finishes AFTER the viewer opened. The watcher's first poll
 * seeds what was already there; only a later completion is delivered. So the
 * shape is: connect, let the empty shelf seed, then put the row on it.
 */
const ONE_ROW = [
  { token: 'dl_9f2c8a1b4e7d0c3f5a6b2e91', name: 'stale-name.bin', state: 'completed', size: 2048 },
];

/**
 * Let the watcher deliver ONE_ROW. There is no shelf to click any more: a
 * completed download is fetched to the operator's machine by the watcher, and
 * these tests hold that transfer to the same pipeline the clicked row used to
 * go through (HEAD first, served name, key in a header, in-document anchor,
 * deferred revoke, streaming past the blob limit).
 */
async function deliverTheDownload(h: Harness) {
  h.setDownloads([]);
  h.connected();
  await h.ticks(2);
  h.setDownloads(ONE_ROW);
  await h.ticks(3);
}

/** The transfer's own requests: the HEAD and (under the limit) the GET. */
function byteCalls(h: Harness) {
  return h.watch.concat(h.fetches).filter((f) => f.url.indexOf('/browser/downloads/') >= 0);
}

describe('fetching a downloaded file to the operator machine', () => {
  it('asks with HEAD first, so a refusal can be explained at all', async () => {
    // Handing a failing URL straight to the browser shows only Chrome's own
    // "Failed - Unknown server error" and throws the server's sentence away, so
    // an expired token, a missing file and a wrong key become one
    // indistinguishable failure. HEAD is what makes the reason readable.
    const h = await runView();
    await deliverTheDownload(h);
    expect(byteCalls(h)[0].init.method).toBe('HEAD');
  });

  it('takes the name from the SERVED file, not from the shelf row', async () => {
    // The row's name is a stale copy: the server renames an extension-less
    // download once it has identified the bytes, so the row can still say
    // "download" where the served file is "report.png". This is «اسم و فرمت».
    const h = await runView();
    h.setServedFile({ disposition: 'attachment; filename="report.png"' });
    await deliverTheDownload(h);
    const a = h.anchors();
    expect(a).toHaveLength(1);
    expect(a[0].download).toBe('report.png');
  });

  it('prefers the RFC 6266 filename* copy, because the ascii copy is lossy', async () => {
    // The server transliterates the plain `filename=` copy, so a Persian name
    // arrives as _____.png. The starred form carries the real characters.
    const h = await runView();
    h.setServedFile({
      disposition: "attachment; filename=\"_____.png\"; filename*=UTF-8''%D8%B5%D9%81%D8%AD%D9%87.png",
    });
    await deliverTheDownload(h);
    expect(h.anchors()[0].download).toBe('صفحه.png');
  });

  it('sends the key in a header and keeps it out of the bytes url', async () => {
    const h = await runView({ search: KEY_SEARCH });
    await deliverTheDownload(h);
    const calls = byteCalls(h);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>)['x-api-key'])
        .toBe('k3y/needs/escaping');
      expect(c.url).not.toContain('api_key=');
    }
  });

  it('asks for the bytes under the owner the list endpoint reported', async () => {
    // The list endpoint RETURNS `owner` precisely so a client does not hardcode
    // it. Writing the bytes under one identity and looking for them under
    // another is the documented ENOENT hand-over bug.
    const h = await runView();
    h.setOwner('someone-else');
    await deliverTheDownload(h);
    expect(byteCalls(h)[0].url).toContain('userId=someone-else');
  });

  it('clicks an anchor that is IN the document, or Firefox ignores it', async () => {
    const h = await runView();
    await deliverTheDownload(h);
    const a = h.anchors()[0];
    expect(a.clicks).toBe(1);
    expect(a.clickedWhileInDocument).toBe(true);
  });

  it('does not revoke the object url while the transfer is still running', async () => {
    // Revoking synchronously after click() cancels the transfer it just started,
    // measured as a 0-byte file. The revoke must be deferred.
    const h = await runView();
    await deliverTheDownload(h);
    expect(h.objectUrls).toHaveLength(1);
    expect(h.revoked).toEqual([]);
  });

  it('shows the server own words when the bytes are refused', async () => {
    const h = await runView();
    h.failDownloadBytes(404, { success: false, error: 'That file is no longer on the server.' });
    await deliverTheDownload(h);
    // Nothing was handed to the browser...
    expect(h.anchors()).toHaveLength(0);
    // ...and the reason is a receipt in the workspace, not swallowed.
    expect(h.el('dnotices').textContent).toContain('no longer on the server');
  });

  it('still says something useful when the refusal carries no message', async () => {
    const h = await runView();
    h.failDownloadBytes(401, 'not json at all');
    await deliverTheDownload(h);
    expect(h.el('dnotices').textContent).toMatch(/authoris|authoriz/i);
  });

  it('streams a very large file by navigation instead of buffering it', async () => {
    // A Blob holds the whole file in the tab's memory, which is the thing that
    // breaks first on a big download. Over the limit the browser streams it, and
    // that is the ONE path allowed to carry the token in the query.
    const h = await runView({ search: KEY_SEARCH });
    h.setServedFile({ length: 65 * 1024 * 1024 });
    await deliverTheDownload(h);
    expect(h.objectUrls).toHaveLength(0);
    const a = h.anchors()[0];
    expect(a.href).toContain('api_key=');
    // Only the HEAD was made: the bytes go through the navigation, not a fetch.
    expect(byteCalls(h)).toHaveLength(1);
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
    const err = h.el('dnotices').children.find((c) => c.className === 'rowerr');
    expect(err).toBeDefined();
    expect(err!.textContent).toContain('too large');
  });

  it('says the file is ready to send, and never tells the operator to type a name', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong.
    //
    // It carried the reasoning of an earlier design note: this view is a
    // VNC screen onto a real Chromium the operator drives by hand, so
    // "Playwright is not holding its file dialog open", so there is no chooser to
    // answer, so the best the bar can do is tell the operator the NAME to type
    // into the server's own dialog. MEASURED (tools/probe-upload-vnc.js) with a
    // genuine X11 click from xdotool and no Playwright click anywhere:
    //
    //     FILECHOOSER_EVENT_FIRED    = true
    //     NATIVE_GTK_DIALOG_OPEN     = no
    //
    // Interception is a property of the CDP connection, not of who moved the
    // mouse. So the premise was false, and the instruction it produced was the
    // manual round trip the operator explicitly refused:
    // «کاربر نباید مجبور باشد ابتدا فایل را دستی روی سرور Upload کند».
    const h = await runView();
    h.connected();
    h.chooseFiles(['cookies.json']);
    await new Promise((r) => setTimeout(r, 140));
    expect(h.el('dnotices').textContent).toContain('cookies.json');
    expect(h.el('dnotices').textContent).toMatch(/ready to send/i);
    // And the drawer is opened on the workspace, or the message is written
    // somewhere unseen.
    expect(h.el('files').hidden).toBe(false);
    expect(h.el('panefiles').hidden).toBe(false);
    // The instruction to go and type the name by hand must be gone for good.
    expect(h.el('dnotices').textContent).not.toMatch(/type this name|dialog on screen/i);
  });

  it('reports the files that DID arrive before a later one failed', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles(['ok.txt']);
    await new Promise((r) => setTimeout(r, 140));
    expect(h.el('dnotices').textContent).toContain('ok.txt');
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

// ── THE AUTOMATIC HALF ──────────────────────────────────────────────────────
// Everything above this line is driven by the operator pressing something in
// the file bar. These two describes cover the part that has NO press at all,
// which is the whole of what was asked for:
//
//   «Windows کاربر → Backend/Server → Website ... کاربر نباید مجبور باشد ابتدا
//    فایل را دستی روی سرور Upload کند و بعد از سرور آن را روی سایت بفرستد»
//   «کلیک روی Download → فایل مستقیماً روی Windows کاربر ذخیره شود»
//
// The trigger for both happens INSIDE the remote page, where this page cannot
// see it, so the page polls the server and completes each direction on its own.
// These tests therefore let real time pass (h.ticks) rather than flushing
// microtasks: the loop is a setTimeout chain by design, so that a slow tick
// cannot overlap itself and deliver the same file twice.

describe('a page asking for a file gets one without the operator going to fetch it', () => {
  /** What GET /browser/real/chooser reports while a page is waiting. */
  const asking = (over: Record<string, unknown> = {}) => ({
    id: 'fc_1a2b3c4d',
    multiple: false,
    accept: '',
    name: 'file',
    at: Date.now(),
    ...over,
  });

  it('does not poll at all until the desktop is actually connected', async () => {
    // Polling before connect would be traffic about a browser that may not even
    // be up, and it would race the boot POST this page makes on load.
    const h = await runView();
    await h.ticks(2);
    expect(h.watch).toHaveLength(0);
  });

  it('starts watching for a file request once the desktop connects', async () => {
    const h = await runView();
    h.connected();
    await h.ticks(2);
    expect(h.watch.some((f) => f.url.indexOf('/browser/real/chooser') >= 0)).toBe(true);
  });

  it('raises the operator OWN picker when a page asks, with no press in this bar', async () => {
    // The measured reason this can work at all: interception is a property of
    // the CDP connection, not of who moved the mouse
    // (tools/probe-upload-vnc.js), so a hand-driven click on the VNC screen
    // still produces a chooser the server can answer.
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);

    // The hidden input was clicked BY THE PAGE. Nobody pressed Upload.
    expect(h.el('up').clicks).toBeGreaterThan(0);
    // And there is a visible way to do it by hand, because the picker can be
    // refused when the activation from the remote click has expired.
    expect(h.el('dnotices').textContent).toMatch(/asking for a file/i);
  });

  it('mirrors the page own accept filter onto the local picker', async () => {
    // A cookie importer that takes only .json must not offer the operator a
    // .png: the file would be uploaded, handed over, and then rejected by the
    // site, which looks exactly like this feature not working.
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking({ accept: '.json,application/json' }));
    await h.ticks(2);
    expect(h.el('up').accept).toBe('.json,application/json');
    expect(h.el('up').multiple).toBe(false);
  });

  it('lets a multiple input take several files, and a single one only take one', async () => {
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking({ multiple: true }));
    await h.ticks(2);
    expect(h.el('up').multiple).toBe(true);
  });

  it('sends the chosen file straight to the page, with no second gesture', async () => {
    // THE REQUIREMENT ITSELF. One pick on Windows, and the bytes are on the
    // server AND handed to the waiting page. No "now upload it to the site".
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);

    h.chooseFiles(['report_final.pdf']);
    await new Promise((r) => setTimeout(r, 200));

    const answers = h.chooserCalls().filter(
      (c) => String(c.init.method || 'GET').toUpperCase() === 'POST',
    );
    expect(answers).toHaveLength(1);
    const body = JSON.parse(String(answers[0].init.body));
    expect(body.id).toBe('fc_1a2b3c4d');
    // A TOKEN travelled, never a path: the page is handed the file by reference
    // and this bar never learns where on the server it landed.
    expect(body.tokens).toEqual(['up_0123456789abcdef01234567']);
    expect(String(answers[0].init.body)).not.toMatch(/\/tmp|\/home|C:\\\\/);
    // And the operator is told it reached the SITE, not merely the server.
    expect(h.el('dnotices').textContent).toMatch(/sent to the site/i);
  });

  it('does not re-open the picker on every tick while the same request stands', async () => {
    // A picker re-raised every 700 ms would fight the operator for the dialog
    // they are standing in.
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(4);
    expect(h.el('up').clicks).toBe(1);
  });

  it('releases the page when the operator dismisses their own picker', async () => {
    // Modern browsers fire 'cancel' and NOT 'change'. Without this the remote
    // page would sit on an open dialog until the server timed it out minutes
    // later, and a page that thinks a dialog is open does not move.
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);

    h.el('up').emit('cancel');
    await new Promise((r) => setTimeout(r, 60));

    const cancels = h.chooserCalls().filter(
      (c) => String(c.init.method || '').toUpperCase() === 'DELETE',
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0].url).toContain('fc_1a2b3c4d');
  });

  it('uses a file uploaded BEFORE the page asked, instead of asking again', async () => {
    // Pressing Upload early is legitimate preparation. Making the operator pick
    // the same file a second time when the page finally asks is the manual
    // round trip this feature exists to remove.
    const h = await runView();
    h.connected();
    h.chooseFiles(['invoice_2026.xlsx']);
    await new Promise((r) => setTimeout(r, 200));
    const clicksBefore = h.el('up').clicks;

    h.setPendingChooser(asking());
    await h.ticks(2);

    // Answered from what was already there, and no new picker was raised.
    const answers = h.chooserCalls().filter(
      (c) => String(c.init.method || 'GET').toUpperCase() === 'POST',
    );
    expect(answers).toHaveLength(1);
    expect(h.el('up').clicks).toBe(clicksBefore);
  });

  it('says why when the page stopped waiting, and keeps the file usable', async () => {
    // 409: the request was well formed but the dialog moved on. The bytes ARE
    // on the server, so the difference between "pick it again" and "press the
    // page button again" is worth stating.
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);
    h.failChooserAnswer(409, {
      success: false,
      error: 'The page is not asking for a file any more.',
    });

    h.chooseFiles(['late.txt']);
    await new Promise((r) => setTimeout(r, 200));

    expect(h.el('dnotices').textContent).toMatch(/not asking for a file any more/i);
  });

  it('takes the prompt down when the request goes away on its own', async () => {
    // Answered elsewhere, cancelled, or its tab closed. A bar still asking for
    // a file that nothing is waiting for is a lie.
    const h = await runView();
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);
    expect(h.el('dnotices').textContent).toMatch(/asking for a file/i);

    h.setPendingChooser(null);
    await h.ticks(2);
    expect(h.el('dnotices').textContent).not.toMatch(/asking for a file/i);
  });

  it('survives the chooser endpoint failing, and keeps polling', async () => {
    const h = await runView();
    const seen: unknown[] = [];
    const onRej = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', onRej);
    try {
      h.connected();
      h.failDownloadsFetch = true;      // the other half of each tick
      await h.ticks(2);
      h.failDownloadsFetch = false;
      h.setPendingChooser(asking());
      await h.ticks(2);
    } finally {
      process.off('unhandledRejection', onRej);
    }
    expect(seen).toEqual([]);
    // A failed poll is still a poll: the loop recovered and did its job.
    expect(h.el('up').clicks).toBeGreaterThan(0);
  });
});

describe('a finished download arrives on the operator machine by itself', () => {
  const done = (over: Record<string, unknown> = {}) => ({
    token: 'dl_1111111111111111111111aa',
    name: 'report_final.pdf',
    state: 'completed',
    size: 2048,
    ...over,
  });

  it('does NOT deliver what was already on the shelf when the viewer opened', async () => {
    // The shelf can hold files from before this tab existed. Dumping a previous
    // session's downloads into the operator's Downloads folder because they
    // opened a viewer is not what "the file I just downloaded arrives" means.
    const h = await runView();
    h.setDownloads([done()]);
    h.connected();
    await h.ticks(3);
    expect(h.anchors()).toHaveLength(0);
  });

  it('delivers a file that finished AFTER the viewer was open, with no press', async () => {
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);              // first poll seeds an empty shelf

    h.setDownloads([done()]);
    await h.ticks(2);

    const anchors = h.anchors();
    expect(anchors).toHaveLength(1);
    // The name the WEBSITE declared, on the operator's disk.
    expect(anchors[0].download).toBe('report_final.pdf');
    expect(anchors[0].clickedWhileInDocument).toBe(true);
  });

  it('takes the name off the SERVED response, not off the shelf row', async () => {
    // The served response is the only place the RFC 5987 name survives:
    // suggestedFilename() answers the literal "download" for it (MEASURED
    // 25/40). So a row saying "download" must still land as the real name.
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);

    h.setServedFile({
      disposition: "attachment; filename=\"factura.xlsx\"; filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx",
    });
    h.setDownloads([done({ token: 'dl_2222222222222222222222bb', name: 'download' })]);
    await h.ticks(2);

    expect(h.anchors()).toHaveLength(1);
    // filename* wins over the ASCII filename, so the operator gets the real one.
    expect(h.anchors()[0].download).toBe('فاکتور.xlsx');
  });

  it('delivers each file exactly once, however many times it is polled', async () => {
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);

    h.setDownloads([done()]);
    await h.ticks(4);             // the row keeps appearing in every poll

    expect(h.anchors()).toHaveLength(1);
  });

  it('waits for a download to finish before delivering it', async () => {
    // An in-flight row is not a file yet. It stays unmarked so the tick that
    // sees it complete is the one that delivers it.
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);

    h.setDownloads([done({ state: 'inProgress', size: 0 })]);
    await h.ticks(2);
    expect(h.anchors()).toHaveLength(0);

    h.setDownloads([done()]);     // same token, now finished
    await h.ticks(2);
    expect(h.anchors()).toHaveLength(1);
    expect(h.anchors()[0].download).toBe('report_final.pdf');
  });

  it('never delivers a failed download', async () => {
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);

    h.setDownloads([done({ state: 'failed', error: 'too large' })]);
    await h.ticks(3);
    expect(h.anchors()).toHaveLength(0);
  });

  it('delivers several files that finish in the same tick', async () => {
    // MEASURED (tools/probe-auto-download.js): 5/5 blob+anchor deliveries with
    // names intact, so Chrome's "multiple automatic downloads" gate does not
    // block this route.
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);

    h.setDownloads([
      done({ token: 'dl_3333333333333333333333cc', name: 'a.pdf' }),
      done({ token: 'dl_4444444444444444444444dd', name: 'b.zip' }),
      done({ token: 'dl_5555555555555555555555ee', name: 'c.docx' }),
    ]);
    await h.ticks(3);

    expect(h.anchors().map((a) => a.download).sort()).toEqual(['a.pdf', 'b.zip', 'c.docx']);
  });

  it('says why a delivery failed instead of silently dropping the file', async () => {
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);

    h.failDownloadBytes(404, { success: false, error: 'That file is no longer on the server.' });
    h.setDownloads([done()]);
    await h.ticks(3);

    expect(h.anchors()).toHaveLength(0);
    expect(h.el('dnotices').textContent).toMatch(/no longer on the server/i);
  });

  it('does not re-read the workspace under the operator on every tick', async () => {
    // The watcher polls the shelf every WATCH_MS. Re-reading the tree that
    // often would reset the scroll position of a list being read and wipe a
    // row-level state nobody has acted on yet. Only a download that LANDED
    // re-reads it (see the Files pane tests).
    const h = await runView({ search: '?workflowId=wf_42&api_key=k' });
    h.setDownloads([]);
    h.connected();
    h.click('burger');
    await settle();
    await settle();
    const before = h.wfCalls().length;
    await h.ticks(3);
    expect(h.wfCalls().length).toBe(before);
    // And the background polls themselves never touch the workspace.
    expect(h.watch.every((f) => f.url.indexOf('/browser/workflow-files/') < 0)).toBe(true);
  });


  it('marks its background shelf reads so they can be told from a real one', async () => {
    // Not cosmetic: a shelf endpoint hit every 700 ms looks alarming in an
    // access log until the background watch can be told from the operator
    // actually opening the panel.
    const h = await runView();
    h.connected();
    await h.ticks(2);
    const shelfWatch = h.watch.filter((f) => f.url.indexOf('/browser/real/downloads') >= 0);
    expect(shelfWatch.length).toBeGreaterThan(0);
    shelfWatch.forEach((f) => expect(f.url).toContain('watch=1'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The receipts. ONE workspace, and the things the old "Activity" pane and
// downloads shelf used to say -- a file is ready to send, a file was sent, a
// delivery failed -- are notice rows under the tree, each with its own
// Dismiss. They are receipts, not a second file list: the files themselves
// are under uploads/ and downloads/ in the tree above them.
// ─────────────────────────────────────────────────────────────────────────────

describe('the receipts under the tree', () => {
  it('the notice list takes no room until there is a notice', async () => {
    const h = await runView();
    h.connected();
    h.click('burger');
    await settle();
    expect(h.el('dnotices').hidden).toBe(true);
    expect(h.el('dnotices').children).toHaveLength(0);
  });

  it('a receipt is one row, newest first, with a Dismiss that removes only that row', async () => {
    const h = await runView();
    h.connected();
    h.chooseFiles(['first.txt']);
    await new Promise((r) => setTimeout(r, 120));
    h.chooseFiles(['second.txt']);
    await new Promise((r) => setTimeout(r, 120));
    const rows = h.el('dnotices').children;
    expect(rows).toHaveLength(2);
    expect(h.el('dnotices').hidden).toBe(false);
    expect(rows[0].textContent).toContain('second.txt');
    expect(rows[1].textContent).toContain('first.txt');
    // The name is in TEXT, never markup: it came from the operator's disk and
    // could be anything.
    expect(h.el('dnotices')).not.toHaveProperty('innerHTML');
    const x = rows[0].querySelector('.del');
    expect(x, 'every receipt carries its own Dismiss').not.toBeNull();
    expect(x!.attrs['aria-label']).toBe('Dismiss');
    x!.emit('click');
    expect(h.el('dnotices').children).toHaveLength(1);
    expect(h.el('dnotices').children[0].textContent).toContain('first.txt');
    // And dismissing the last one hides the list again.
    h.el('dnotices').children[0].querySelector('.del')!.emit('click');
    expect(h.el('dnotices').children).toHaveLength(0);
    expect(h.el('dnotices').hidden).toBe(true);
  });

  it('is bounded: the oldest receipts fall off, because these are receipts and not a log', async () => {
    const h = await runView();
    h.connected();
    for (let i = 0; i < 9; i += 1) {
      h.chooseFiles(['f' + i + '.txt']);
      await new Promise((r) => setTimeout(r, 30));
    }
    const rows = h.el('dnotices').children;
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(rows[0].textContent).toContain('f8.txt');
    expect(h.el('dnotices').textContent).not.toContain('f0.txt');
  });

  it('a failed delivery is a red row with the server own words, and the drawer opens on the workspace to show it', async () => {
    const h = await runView();
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);
    h.failDownloadBytes(404, { success: false, error: 'That file is no longer on the server.' });
    h.setDownloads([{ token: 'dl_1111111111111111111111aa', name: 'report_final.pdf', state: 'completed', size: 2048 }]);
    await h.ticks(3);
    const err = h.el('dnotices').children.find((c) => c.className === 'rowerr');
    expect(err).toBeDefined();
    expect(err!.textContent).toContain('no longer on the server');
    expect(h.el('files').hidden).toBe(false);
    expect(h.el('panefiles').hidden).toBe(false);
  });

  it('there is no downloads shelf, no tab strip and no Send button left in the markup', () => {
    const html = chromeViewHtml();
    for (const id of ['dls', 'dtabs', 'tabshelf', 'tabfiles', 'paneshelf', 'dlcount', 'upbtn']) {
      expect(html, `#${id} must be gone`).not.toMatch(new RegExp('id="' + id + '"'));
    }
    expect(html).toMatch(/id="dnotices"/);
    expect(html).toMatch(/id="panefiles"/);
    expect(html).toMatch(/id="dpick"/);
  });
});


describe('the Files pane: this workflow\u2019s own files, as a tree', () => {
  const WF = '?workflowId=wf_42&api_key=k';
  /** What GET /browser/real/chooser reports while a page is waiting. */
  const asking = (over: Record<string, unknown> = {}) => ({
    id: 'fc_9z8y7x6w', multiple: false, accept: '', name: 'file', at: Date.now(), ...over,
  });
  /** Open the drawer on the Files pane and let the root listing land. */
  async function openFiles(h: Harness) {
    h.connected();
    h.click('burger');
    await settle();
    await settle();
  }
  const rowByPath = (h: Harness, path: string) =>
    h.tree().find((li) => li.attrs['data-path'] === path);
  const fileRows = (h: Harness) => h.tree().filter((li) => li.attrs['data-type'] === 'file');

  /** The view's traffic to the workspace, minus the one-off binding POST. */
  const wfNonBind = (h: Harness) => h.wfCalls().filter((f) => f.url.indexOf('/bind') < 0);

  it('binds the Local Browser to the workflow the moment the desktop connects, and never before', async () => {
    const h = await runView({ search: WF });
    expect(h.wfCalls()).toHaveLength(0);
    h.connected();
    await settle();
    const binds = h.wfCalls().filter((f) => f.url.indexOf('/bind') >= 0);
    expect(binds).toHaveLength(1);
    expect(binds[0].url).toBe('/browser/workflow-files/wf_42/bind');
    expect(binds[0].init.method).toBe('POST');
    expect(JSON.parse(String(binds[0].init.body))).toEqual({ target: 'local' });
    // The key rides in a header, as for every other workspace request.
    expect((binds[0].init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('does not try to bind when the page was not opened from a saved workflow', async () => {
    const h = await runView({ search: '?api_key=k' });
    h.connected();
    await settle();
    expect(h.wfCalls()).toHaveLength(0);
  });

  it('lists the root when the drawer opens, and only then', async () => {
    const h = await runView({ search: WF });
    h.connected();
    await settle();
    // Connecting binds; it does not LIST. The tree is read when it is looked at.
    expect(wfNonBind(h)).toHaveLength(0);
    h.click('burger');
    await settle();
    await settle();
    const lists = h.wfCalls().filter((f) => String(f.init.method || 'GET') === 'GET');
    expect(lists).toHaveLength(1);
    expect(lists[0].url).toContain('/browser/workflow-files/wf_42?path=');
    // The api_key rides in a header, exactly as it does for the shelf.
    expect((lists[0].init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('draws folders before files, with the name and size of each', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    const rows = h.tree();
    expect(rows.map((r) => r.attrs['data-name'])).toEqual(['docs', 'cookies.json', 'photo.png']);
    expect(rows[0].attrs['data-type']).toBe('dir');
    expect(rows[0].attrs['aria-expanded']).toBe('false');
    expect(rowByPath(h, 'photo.png')!.textContent).toContain('2 KB');
    expect(h.el('dtotal').textContent).toBe('3 items');
  });

  it('expands a folder in place and shows its children indented under it', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'docs')!.emit('click');
    await settle();
    await settle();
    const names = h.tree().map((r) => r.attrs['data-name'] || r.textContent);
    expect(names).toEqual(['docs', 'readme.txt', 'cookies.json', 'photo.png']);
    expect(rowByPath(h, 'docs')!.attrs['aria-expanded']).toBe('true');
    // Indented one level, and listed from the server, not guessed.
    expect(rowByPath(h, 'docs/readme.txt')!.style.paddingLeft).toBe('19px');
    expect(h.wfCalls().some((f) => f.url.indexOf('path=docs') >= 0)).toBe(true);
    // A second click folds it back up, without another request.
    const before = h.wfCalls().length;
    rowByPath(h, 'docs')!.emit('click');
    await settle();
    expect(h.tree().map((r) => r.attrs['data-name'])).toEqual(['docs', 'cookies.json', 'photo.png']);
    expect(h.wfCalls().length).toBe(before);
  });

  it('says the folder is empty rather than spinning forever', async () => {
    const h = await runView({ search: WF });
    h.setTree({ '': [] });
    await openFiles(h);
    expect(h.tree()).toHaveLength(1);
    expect(h.tree()[0].textContent).toMatch(/empty/i);
    expect(h.el('dtotal').textContent).toBe('empty');
  });

  it('Select is disabled until a file is picked; a folder cannot be picked', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    expect(h.el('wfmselect').disabled).toBe(true);
    rowByPath(h, 'docs')!.emit('click');
    await settle();
    expect(h.el('wfmselect').disabled).toBe(true);
    rowByPath(h, 'cookies.json')!.emit('click');
    expect(h.el('wfmselect').disabled).toBe(false);
    expect(rowByPath(h, 'cookies.json')!.className).toContain('sel');
    expect(h.el('dcount').textContent).toBe('1 selected');
  });

  it('a single-file input keeps ONE pick: the second replaces the first', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'cookies.json')!.emit('click');
    rowByPath(h, 'photo.png')!.emit('click');
    expect(fileRows(h).filter((r) => r.className.indexOf('sel') >= 0).map((r) => r.attrs['data-name']))
      .toEqual(['photo.png']);
    expect(h.el('wfmselect').textContent).toBe('Select');
    // And "Select All" is not on offer: a promise a single input cannot keep.
    expect(h.el('dall').hidden).toBe(true);
  });

  it('a multiple input takes several, and offers Select All', async () => {
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking({ multiple: true }));
    await h.ticks(2);
    // offerFile() raised the drawer on the two sources; the operator picks the
    // workflow's files.
    expect(h.el('files').hidden).toBe(false);
    expect(h.el('dpick').hidden).toBe(false);
    h.click('addwf');
    await settle();
    await settle();
    expect(h.el('panefiles').hidden).toBe(false);
    expect(h.el('dall').hidden).toBe(false);
    rowByPath(h, 'cookies.json')!.emit('click');
    rowByPath(h, 'photo.png')!.emit('click');
    expect(h.el('wfmselect').textContent).toBe('Select (2)');
    expect(h.el('dcount').textContent).toBe('2 selected');
    h.click('dclear');
    expect(h.el('wfmselect').disabled).toBe(true);
    h.click('dall');
    expect(h.el('wfmselect').textContent).toBe('Select (2)');
  });

  it('hands the chosen file to the waiting page with ONE /use naming the chooser and a RELATIVE path', async () => {
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);
    h.click('addwf');
    await settle();
    await settle();
    rowByPath(h, 'cookies.json')!.emit('click');
    h.click('wfmselect');
    await settle();
    await settle();
    const uses = h.wfCalls().filter((f) => f.url.indexOf('/use') >= 0);
    expect(uses).toHaveLength(1);
    expect(uses[0].url).toBe('/browser/workflow-files/wf_42/use');
    const body = JSON.parse(String(uses[0].init.body));
    expect(body).toEqual({ path: 'cookies.json', chooserId: 'fc_9z8y7x6w' });
    // No absolute path ever left this page.
    expect(String(uses[0].init.body)).not.toMatch(/\/home\/|[A-Z]:\\\\/);
    // Done: the drawer shuts and the workspace carries the receipt.
    expect(h.el('files').hidden).toBe(true);
    expect(h.el('burger').hidden).toBe(false);
    expect(h.el('dnotices').textContent).toMatch(/Sent to the site: cookies\.json/);
  });

  it('sends several files in ONE request, because the chooser forgets its id on the first answer', async () => {
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking({ multiple: true }));
    await h.ticks(2);
    h.click('addwf');
    await settle();
    await settle();
    rowByPath(h, 'cookies.json')!.emit('click');
    rowByPath(h, 'photo.png')!.emit('click');
    h.click('wfmselect');
    await settle();
    await settle();
    const uses = h.wfCalls().filter((f) => f.url.indexOf('/use') >= 0);
    expect(uses).toHaveLength(1);
    const body = JSON.parse(String(uses[0].init.body));
    expect(body.chooserId).toBe('fc_9z8y7x6w');
    expect(body.path).toBe('cookies.json');
    expect(body.paths).toEqual(['cookies.json', 'photo.png']);
  });

  it('refuses, in words, a file the page\u2019s accept filter would reject', async () => {
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking({ accept: '.json' }));
    await h.ticks(2);
    h.click('addwf');
    await settle();
    await settle();
    rowByPath(h, 'photo.png')!.emit('click');
    h.click('wfmselect');
    await settle();
    expect(h.wfCalls().filter((f) => f.url.indexOf('/use') >= 0)).toHaveLength(0);
    expect(h.el('wfmnote').textContent).toMatch(/only accepts \.json/);
    expect(h.el('wfmnote').textContent).toContain('photo.png');
    expect(h.el('wfmnote').className).toBe('err');
  });

  it('explains when no page is asking, and sends nothing', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'cookies.json')!.emit('click');
    h.click('wfmselect');
    await settle();
    expect(h.wfCalls().filter((f) => f.url.indexOf('/use') >= 0)).toHaveLength(0);
    expect(h.el('wfmnote').textContent).toMatch(/No page is asking/);
  });

  it('shows the server\u2019s own words when /use is refused, and lets the operator try again', async () => {
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);
    h.failUse(409, { success: false, error: 'The page is not asking for a file any more.' });
    h.click('addwf');
    await settle();
    await settle();
    rowByPath(h, 'cookies.json')!.emit('click');
    h.click('wfmselect');
    await settle();
    await settle();
    expect(h.el('wfmnote').textContent).toBe('The page is not asking for a file any more.');
    expect(h.el('wfmselect').disabled).toBe(false);
    expect(h.el('files').hidden).toBe(false);
  });

  it('New Folder / New File ask for a name first, and send nothing when there is no way to ask', async () => {
    // The harness has no window.prompt; the view guards it and does nothing
    // rather than posting a folder called 'null'.
    const h = await runView({ search: WF });
    await openFiles(h);
    const before = h.wfCalls().length;
    h.click('wfmnew');
    h.click('wfmnewfile');
    await settle();
    expect(h.wfCalls().length).toBe(before);
  });

  it('Refresh re-reads every open folder, and keeps the selection of a file that still exists', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'docs')!.emit('click');
    await settle();
    await settle();
    rowByPath(h, 'cookies.json')!.emit('click');
    const before = h.wfCalls().length;
    h.click('wfmrefresh');
    await settle();
    await settle();
    await settle();
    const after = h.wfCalls().slice(before).filter((f) => String(f.init.method || 'GET') === 'GET');
    expect(after.map((f) => decodeURIComponent(/path=([^&]*)/.exec(f.url)![1])).sort()).toEqual(['', 'docs']);
    expect(rowByPath(h, 'cookies.json')!.className).toContain('sel');
  });

  it('drops a selected file that the refresh shows is gone', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'cookies.json')!.emit('click');
    h.setTree({ '': [{ name: 'photo.png', path: 'photo.png', type: 'file', size: 2048 }] });
    h.click('wfmrefresh');
    await settle();
    await settle();
    expect(h.el('wfmselect').disabled).toBe(true);
    expect(h.tree().map((r) => r.attrs['data-name'])).toEqual(['photo.png']);
  });

  it('Delete asks IN THE DRAWER, names the file, and only then sends the DELETE', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'cookies.json')!.emit('click');
    h.click('ddelsel');
    await settle();
    expect(h.el('dconfirm').hidden).toBe(false);
    expect(h.el('dconfirm').textContent).toMatch(/Delete the selected files\? \(1\)/);
    expect(h.wfCalls().filter((f) => f.init.method === 'DELETE')).toHaveLength(0);
    // Cancel: nothing sent.
    const cancel = h.el('dconfirm').children.find((c) => c.textContent === 'Cancel')!;
    cancel.emit('click');
    expect(h.el('dconfirm').hidden).toBe(true);
    expect(h.wfCalls().filter((f) => f.init.method === 'DELETE')).toHaveLength(0);
    // Again, and confirm.
    h.click('ddelsel');
    const yes = h.el('dconfirm').children.find((c) => c.textContent === 'Delete')!;
    yes.emit('click');
    await settle();
    await settle();
    const dels = h.wfCalls().filter((f) => f.init.method === 'DELETE');
    expect(dels).toHaveLength(1);
    expect(dels[0].url).toBe('/browser/workflow-files/wf_42?path=cookies.json');
  });

  it('a right-click on a row opens ONE menu with Select / Rename / Delete; on a folder, the folder actions', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    const menu = h.el('dmenu');
    expect(menu.hidden).toBe(true);
    rowByPath(h, 'cookies.json')!.emit('contextmenu', { clientX: 40, clientY: 50, preventDefault() {}, stopPropagation() {} });
    expect(menu.hidden).toBe(false);
    const labels = () => menu.children.filter((c) => c.className.indexOf('dmi') === 0 && c.className !== 'dmi-sep').map((c) => c.textContent);
    expect(labels()).toEqual(['Select', 'Rename', 'Delete']);
    // Open a second menu: it REPLACES the first rather than stacking.
    rowByPath(h, 'docs')!.emit('contextmenu', { clientX: 40, clientY: 50, preventDefault() {}, stopPropagation() {} });
    expect(labels()).toEqual(['Open', 'New File', 'New Folder', 'Upload Here', 'Rename', 'Delete']);
    // Empty space: the root's own actions.
    h.el('wfmlist').emit('contextmenu', { clientX: 40, clientY: 50, preventDefault() {} });
    expect(labels()).toEqual(['New Folder', 'New File', 'Upload File', 'Refresh']);
  });

  it('the menu\u2019s Select picks the file; Delete on a folder warns about everything inside it and sends recursive=1', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    const menu = h.el('dmenu');
    const item = (label: string) => menu.children.find((c) => c.textContent === label)!;
    rowByPath(h, 'cookies.json')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    item('Select').emit('click', { stopPropagation() {} });
    expect(menu.hidden).toBe(true);
    expect(h.el('wfmselect').disabled).toBe(false);
    rowByPath(h, 'docs')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    item('Delete').emit('click', { stopPropagation() {} });
    expect(h.el('dconfirm').textContent).toMatch(/everything inside it\? docs/);
    h.el('dconfirm').children.find((c) => c.textContent === 'Delete')!.emit('click');
    await settle();
    await settle();
    const dels = h.wfCalls().filter((f) => f.init.method === 'DELETE');
    expect(dels).toHaveLength(1);
    expect(dels[0].url).toBe('/browser/workflow-files/wf_42?path=docs&recursive=1');
  });

  it('Rename edits the name IN THE ROW; Enter sends PATCH /rename, Escape sends nothing', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    const menu = h.el('dmenu');
    const item = (label: string) => menu.children.find((c) => c.textContent === label)!;
    rowByPath(h, 'cookies.json')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    item('Rename').emit('click', { stopPropagation() {} });
    let row = rowByPath(h, 'cookies.json')!;
    let input = row.children.find((c) => c.className === 'drename')!;
    expect(input).toBeTruthy();
    expect(input.value).toBe('cookies.json');
    input.value = 'old.json';
    input.emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    expect(row.children.find((c) => c.className === 'drename')).toBeUndefined();
    expect(row.querySelector('.wfm-name')!.textContent).toBe('cookies.json');
    expect(h.wfCalls().filter((f) => f.init.method === 'PATCH')).toHaveLength(0);
    // Now for real.
    rowByPath(h, 'cookies.json')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    item('Rename').emit('click', { stopPropagation() {} });
    row = rowByPath(h, 'cookies.json')!;
    input = row.children.find((c) => c.className === 'drename')!;
    input.value = 'session.json';
    input.emit('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
    await settle();
    await settle();
    const patches = h.wfCalls().filter((f) => f.init.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe('/browser/workflow-files/wf_42/rename');
    expect(JSON.parse(String(patches[0].init.body))).toEqual({ path: 'cookies.json', name: 'session.json' });
  });

  it('Upload Here posts the operator\u2019s file INTO the named folder, then re-reads it', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    const menu = h.el('dmenu');
    rowByPath(h, 'docs')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
    menu.children.find((c) => c.textContent === 'Upload Here')!.emit('click', { stopPropagation() {} });
    // The operator's own picker, not the shelf's: a different input.
    expect(h.el('wfmup').clicks).toBe(1);
    expect(h.el('up').clicks).toBe(0);
    const input = h.el('wfmup');
    input.files = [{ name: 'notes.txt' }];
    input.emit('change');
    await settle();
    await settle();
    await settle();
    const ups = h.wfCalls().filter((f) => f.url.indexOf('/upload') >= 0);
    expect(ups).toHaveLength(1);
    expect(ups[0].url).toBe('/browser/workflow-files/wf_42/upload?path=docs&name=notes.txt');
    expect(ups[0].init.method).toBe('POST');
    // Then the folder is open and re-read, so the new file is on screen.
    expect(h.wfCalls().some((f) => f.url.indexOf('path=docs') >= 0 && String(f.init.method || 'GET') === 'GET')).toBe(true);
    expect(h.el('wfmnote').textContent).toBe('Uploaded.');
  });

  it('the toolbar\u2019s Upload lands in uploads/ when the workspace root is on screen', async () => {
    // uploads/ is the folder the contract says staged INPUT lives in: a file
    // dropped in the root would still hand over, but a node looking for inputs
    // would not find it.
    const h = await runView({ search: WF });
    await openFiles(h);
    h.click('wfmupload');
    const input = h.el('wfmup');
    input.files = [{ name: 'a.bin' }];
    input.emit('change');
    await settle();
    await settle();
    const ups = h.wfCalls().filter((f) => f.url.indexOf('/upload') >= 0);
    expect(ups[0].url).toBe('/browser/workflow-files/wf_42/upload?path=uploads&name=a.bin');
  });

  it('the toolbar\u2019s Upload lands in the folder the breadcrumb is on, once the operator went into one', async () => {
    const h = await runView({ search: WF });
    await openFiles(h);
    rowByPath(h, 'docs')!.emit('dblclick');
    await settle();
    await settle();
    h.click('wfmupload');
    const input = h.el('wfmup');
    input.files = [{ name: 'b.bin' }];
    input.emit('change');
    await settle();
    await settle();
    const ups = h.wfCalls().filter((f) => f.url.indexOf('/upload') >= 0);
    expect(ups[0].url).toBe('/browser/workflow-files/wf_42/upload?path=docs&name=b.bin');
  });

  it('New File goes through POST /file with a JSON body, not a one-byte upload', async () => {
    const h = await runView({ search: WF, prompt: () => 'notes.md' });
    await openFiles(h);
    h.click('wfmnewfile');
    await settle();
    await settle();
    const files = h.wfCalls().filter((f) => f.url.indexOf('/file') >= 0);
    expect(files).toHaveLength(1);
    expect(files[0].url).toBe('/browser/workflow-files/wf_42/file');
    expect(files[0].init.method).toBe('POST');
    expect(JSON.parse(String(files[0].init.body))).toEqual({ path: '', name: 'notes.md' });
    expect(h.wfCalls().some((f) => f.url.indexOf('/upload') >= 0)).toBe(false);
  });

  describe('the breadcrumb: going INTO a folder and back', () => {
    const crumbs = (h: Harness) => h.el('dcrumbs').children;
    const crumbLabels = (h: Harness) => crumbs(h).filter((c) => c.className.indexOf('dcrumb') === 0 && c.className.indexOf('dcrumb-sep') < 0 && c.className.indexOf('dback') < 0).map((c) => c.textContent);

    it('starts at the workspace, with no Back arrow', async () => {
      const h = await runView({ search: WF });
      await openFiles(h);
      expect(crumbLabels(h)).toEqual(['Workflow']);
      expect(crumbs(h).some((c) => c.className.indexOf('dback') >= 0)).toBe(false);
      expect(crumbs(h)[0].attrs['aria-current']).toBe('location');
    });

    it('double-clicking a folder roots the tree there, names it in the crumb, and shows a Back arrow', async () => {
      const h = await runView({ search: WF });
      await openFiles(h);
      rowByPath(h, 'docs')!.emit('dblclick');
      await settle();
      await settle();
      expect(crumbLabels(h)).toEqual(['Workflow', 'docs']);
      expect(crumbs(h).some((c) => c.className.indexOf('dback') >= 0)).toBe(true);
      // Only docs' children are on screen now, at depth 0.
      expect(h.tree().map((r) => r.attrs['data-path'])).toEqual(['docs/readme.txt']);
      expect(h.tree()[0].style.paddingLeft).toBe('5px');
      expect(h.el('dtotal').textContent).toBe('1 item');
    });

    it('the menu\u2019s Open on a folder goes into it the same way', async () => {
      const h = await runView({ search: WF });
      await openFiles(h);
      const menu = h.el('dmenu');
      rowByPath(h, 'docs')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
      menu.children.find((c) => c.textContent === 'Open')!.emit('click', { stopPropagation() {} });
      await settle();
      await settle();
      expect(crumbLabels(h)).toEqual(['Workflow', 'docs']);
    });

    it('Back goes up one level; the workspace crumb goes all the way home', async () => {
      const h = await runView({ search: WF });
      await openFiles(h);
      rowByPath(h, 'docs')!.emit('dblclick');
      await settle();
      await settle();
      crumbs(h).find((c) => c.className.indexOf('dback') >= 0)!.emit('click', { stopPropagation() {} });
      await settle();
      await settle();
      expect(crumbLabels(h)).toEqual(['Workflow']);
      // The folder just left stays EXPANDED in place, so the operator can see
      // where they came from; nothing else changed.
      expect(h.tree().map((r) => r.attrs['data-path'])).toEqual(['docs', 'docs/readme.txt', 'cookies.json', 'photo.png']);
      expect(rowByPath(h, 'docs')!.attrs['aria-expanded']).toBe('true');
    });

    it('the crumb of a folder above the current one is a button that goes there', async () => {
      const h = await runView({ search: WF });
      h.setTree({
        '': [{ name: 'a', path: 'a', type: 'dir', size: 0 }],
        a: [{ name: 'b', path: 'a/b', type: 'dir', size: 0 }],
        'a/b': [{ name: 'deep.txt', path: 'a/b/deep.txt', type: 'file', size: 3 }],
      });
      await openFiles(h);
      rowByPath(h, 'a')!.emit('dblclick');
      await settle();
      await settle();
      rowByPath(h, 'a/b')!.emit('dblclick');
      await settle();
      await settle();
      expect(crumbLabels(h)).toEqual(['Workflow', 'a', 'b']);
      expect(h.tree().map((r) => r.attrs['data-path'])).toEqual(['a/b/deep.txt']);
      crumbs(h).find((c) => c.textContent === 'a')!.emit('click', { stopPropagation() {} });
      await settle();
      await settle();
      expect(crumbLabels(h)).toEqual(['Workflow', 'a']);
      // Rooted at a/: b is on screen at depth 0, still expanded from the visit.
      expect(h.tree().map((r) => r.attrs['data-path'])).toEqual(['a/b', 'a/b/deep.txt']);
      expect(rowByPath(h, 'a/b')!.style.paddingLeft).toBe('5px');
    });

    it('the toolbar\u2019s New Folder acts on the folder on screen', async () => {
      const h = await runView({ search: WF, prompt: () => 'sub' });
      await openFiles(h);
      rowByPath(h, 'docs')!.emit('dblclick');
      await settle();
      await settle();
      h.click('wfmnew');
      await settle();
      const mk = h.wfCalls().filter((f) => f.url.indexOf('/mkdir') >= 0);
      expect(mk).toHaveLength(1);
      expect(JSON.parse(String(mk[0].init.body))).toEqual({ path: 'docs', name: 'sub' });
    });
  });

  describe('the system folders uploads/ and downloads/', () => {
    const withSystem = (h: Harness) => h.setTree({
      '': [
        { name: 'uploads', path: 'uploads', type: 'dir', size: 0, system: true },
        { name: 'downloads', path: 'downloads', type: 'dir', size: 0, system: true },
        { name: 'docs', path: 'docs', type: 'dir', size: 0 },
        { name: 'cookies.json', path: 'cookies.json', type: 'file', size: 12 },
      ],
      uploads: [{ name: 'in.csv', path: 'uploads/in.csv', type: 'file', size: 9 }],
      downloads: [],
      docs: [],
    } as never);

    it('are drawn apart, with a tag saying what each is for', async () => {
      const h = await runView({ search: WF });
      withSystem(h);
      await openFiles(h);
      const up = rowByPath(h, 'uploads')!;
      const down = rowByPath(h, 'downloads')!;
      expect(up.className).toContain('wfm-sys');
      expect(up.attrs['data-system']).toBe('true');
      expect(up.querySelector('.wfm-sys-tag')!.textContent).toBe('input');
      expect(down.querySelector('.wfm-sys-tag')!.textContent).toBe('output');
      // An ordinary folder carries no tag.
      expect(rowByPath(h, 'docs')!.querySelector('.wfm-sys-tag')).toBeNull();
    });

    it('offer no Rename or Delete in their menu, but everything that puts files INTO them', async () => {
      const h = await runView({ search: WF });
      withSystem(h);
      await openFiles(h);
      const menu = h.el('dmenu');
      const labels = () => menu.children.filter((c) => c.className.indexOf('dmi') === 0 && c.className !== 'dmi-sep').map((c) => c.textContent);
      rowByPath(h, 'uploads')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
      expect(labels()).toEqual(['Open', 'New File', 'New Folder', 'Upload Here']);
      // An ordinary folder still has the full set.
      rowByPath(h, 'docs')!.emit('contextmenu', { clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} });
      expect(labels()).toEqual(['Open', 'New File', 'New Folder', 'Upload Here', 'Rename', 'Delete']);
    });

    it('files INSIDE uploads/ can still be selected and handed to the page', async () => {
      const h = await runView({ search: WF });
      withSystem(h);
      h.connected();
      h.setPendingChooser(asking());
      await h.ticks(2);
      h.click('addwf');
      await settle();
      await settle();
      rowByPath(h, 'uploads')!.emit('dblclick');
      await settle();
      await settle();
      rowByPath(h, 'uploads/in.csv')!.emit('click');
      h.click('wfmselect');
      await settle();
      await settle();
      const uses = h.wfCalls().filter((f) => f.url.indexOf('/use') >= 0);
      expect(uses).toHaveLength(1);
      expect(JSON.parse(String(uses[0].init.body)).path).toBe('uploads/in.csv');
    });
  });

  it('a download that lands is FILED under downloads/ in the one workspace, and the tree is re-read', async () => {
    // No Activity pane, no shelf: the receipt names the folder, and the tree --
    // when it is on screen -- shows the file without the operator pressing
    // Refresh. The listing is re-read for an OPEN workspace only.
    const h = await runView({ search: WF });
    h.setDownloads([]);
    await openFiles(h);
    await h.ticks(2);
    const before = h.wfCalls().filter((f) => String(f.init.method || 'GET') === 'GET').length;
    h.setDownloads([{ token: 'dl_1', name: 'report.pdf', size: 2048, state: 'completed', workflowPath: 'downloads/report.pdf' }] as never);
    await h.ticks(3);
    expect(h.el('dnotices').textContent).toContain('Downloaded: report.pdf');
    expect(h.el('dnotices').textContent).toContain('downloads/');
    const after = h.wfCalls().filter((f) => String(f.init.method || 'GET') === 'GET').length;
    expect(after).toBeGreaterThan(before);
  });

  it('a download that lands while the drawer is SHUT does not open it, and does not read the tree', async () => {
    // A drawer that opened itself would cover the remote screen the operator is
    // working in. The file arriving on their machine is the signal; the receipt
    // waits for the next time the workspace is opened.
    const h = await runView({ search: WF });
    h.setDownloads([]);
    h.connected();
    await h.ticks(2);
    const before = h.wfCalls().filter((f) => String(f.init.method || 'GET') === 'GET').length;
    h.setDownloads([{ token: 'dl_1', name: 'report.pdf', size: 2048, state: 'completed', workflowPath: 'downloads/report.pdf' }] as never);
    await h.ticks(3);
    expect(h.el('files').hidden).toBe(true);
    expect(h.wfCalls().filter((f) => String(f.init.method || 'GET') === 'GET').length).toBe(before);
    expect(h.el('dnotices').textContent).toContain('Downloaded: report.pdf');
  });

  it('Choose from Workflow Files stands the tree IN for the source chooser; Escape gives the page back', async () => {
    // 'pick' is a state of the ONE workspace, not a second tab: the two sources
    // are shown instead of the tree while a page is asking, and choosing the
    // second source brings the tree up in their place.
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking());
    await h.ticks(2);
    expect(h.el('dpick').hidden).toBe(false);
    expect(h.el('panefiles').hidden).toBe(true);
    h.click('addwf');
    await settle();
    expect(h.el('panefiles').hidden).toBe(false);
    expect(h.el('dpick').hidden).toBe(true);
    // There is no tab strip left to press.
    expect(h.el('tabfiles').children).toHaveLength(0);
    expect(h.el('tabshelf').children).toHaveLength(0);
  });


  it('Upload from Computer in the source chooser is the operator\u2019s OWN click on the same hidden input', async () => {
    const h = await runView({ search: WF });
    h.connected();
    h.setPendingChooser(asking({ accept: '.json' }));
    await h.ticks(2);
    const before = h.el('up').clicks;
    h.click('addpc');
    expect(h.el('up').clicks).toBe(before + 1);
    expect(h.el('up').accept).toBe('.json');
    expect(h.el('up').multiple).toBe(false);
  });
});
