/**
 * remote-file-chooser.test.ts — picking a file on Windows reaches the website.
 *
 * THE REQUIREMENT, VERBATIM
 * -------------------------
 *   «وقتی کاربر از داخل Remote Browser روی یک سایت، فایل را برای Upload انتخاب
 *    می‌کند: Windows کاربر → Backend/Server → Website. این انتقال باید در Backend
 *    مدیریت شود و کاربر نباید مجبور باشد ابتدا فایل را دستی روی سرور Upload کند و
 *    بعد از سرور آن را روی سایت بفرستد.»
 *
 * WHY THIS CODE IS ALLOWED TO EXIST
 * ---------------------------------
 * An earlier design note said an upload on this view could not be automatic:
 * the operator drives a real Chromium with a real mouse over VNC, so Playwright
 * "is not holding its dialogs open" and there is no chooser to answer. MEASURED
 * (tools/probe-upload-vnc.js) with a genuine X11 click from `xdotool` and no
 * Playwright click anywhere in the path:
 *
 *     FILECHOOSER_EVENT_FIRED    = true
 *     CHOOSER_ANSWERED_BY_SERVER = true
 *     PAGE_SEES_FILE             = GOT:probe-upload-src.txt:25
 *     NATIVE_GTK_DIALOG_OPEN     = no
 *
 * Interception is a property of the CDP connection, not of who moved the mouse.
 *
 * HOW THESE TESTS WORK
 * --------------------
 * `RemoteFileChooser` is a real class, so it is imported and driven directly:
 * fake Playwright `Page`/`FileChooser`/`BrowserContext` objects that RECORD, and
 * REAL upload tokens written to a REAL temporary directory by `saveUpload`. The
 * token→path resolution is the security-critical half, so nothing about it is
 * mocked — the test proves a path is unusable and a token works by writing bytes
 * and reading back which file the page was actually handed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { RemoteFileChooser, FileChooserError } from '../../src/core/RemoteFileChooser';
import { saveUpload } from '../../src/core/RemoteUploads';
import { config } from '../../src/config';

const USER = 'local';

let dir = '';
let originalUploads = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chooser-test-'));
  // Real uploads on a real disk, in a directory this test owns.
  originalUploads = config.UPLOADS_DIR;
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = dir;
});

afterEach(async () => {
  (config as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A stand-in for Playwright's FileChooser that records what it was given. */
function fakeChooser(opts: { multiple?: boolean; accept?: string; name?: string } = {}) {
  const given: string[][] = [];
  return {
    given,
    isMultiple: () => !!opts.multiple,
    element: () => ({
      getAttribute: async (k: string) =>
        (k === 'accept' ? opts.accept : opts.name) ?? null,
    }),
    setFiles: async (files: string | string[]) => {
      given.push(Array.isArray(files) ? files : [files]);
    },
  };
}

/** A stand-in for a Playwright Page: an event emitter with a url. */
function fakePage(label = 'p') {
  const handlers = new Map<string, Array<(a: unknown) => void>>();
  return {
    label,
    on(type: string, fn: (a: unknown) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
      return this;
    },
    /** Test-side: the browser reporting a dialog, or the tab closing. */
    emit(type: string, arg?: unknown) {
      (handlers.get(type) || []).forEach((f) => f(arg));
    },
    isClosed: () => false,
    url: () => 'https://site.test/upload',
  };
}

function fakeContext(pages: Array<ReturnType<typeof fakePage>> = []) {
  const handlers = new Map<string, Array<(a: unknown) => void>>();
  return {
    pages: () => pages,
    on(type: string, fn: (a: unknown) => void) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
      return this;
    },
    /** Test-side: a new tab appears. */
    addPage(p: ReturnType<typeof fakePage>) {
      pages.push(p);
      (handlers.get('page') || []).forEach((f) => f(p));
    },
  };
}

/** Let the chooser's own async attribute reads settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function upload(name: string, body = 'hello'): Promise<string> {
  const stored = await saveUpload(USER, name, Buffer.from(body));
  return stored.token;
}

describe('a page asking for a file is reported, not left to a native dialog', () => {
  it('reports the dialog with the details the local picker needs', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);

    expect(fc.pending()).toBeNull();
    page.emit('filechooser', fakeChooser({ accept: '.json,application/json', name: 'cookies' }));
    await settle();

    const p = fc.pending();
    expect(p).not.toBeNull();
    // The accept filter belongs to the INPUT, and repeating it in the operator's
    // own picker is what stops a .png being offered to a cookie importer.
    expect(p!.accept).toBe('.json,application/json');
    expect(p!.name).toBe('cookies');
    expect(p!.multiple).toBe(false);
    expect(p!.id).toBeTruthy();
  });

  it('carries the multiple flag, so one input cannot be handed five files', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    page.emit('filechooser', fakeChooser({ multiple: true }));
    await settle();
    expect(fc.pending()!.multiple).toBe(true);
  });

  it('watches tabs opened AFTER it started, not only the ones already there', async () => {
    // A dialog in a tab the operator opened later must not be the one that
    // escapes to a native GTK window nobody can reach.
    const fc = new RemoteFileChooser(USER);
    const ctx = fakeContext([]);
    fc.watch(ctx as never);

    const later = fakePage('later');
    ctx.addPage(later);
    later.emit('filechooser', fakeChooser());
    await settle();

    expect(fc.pending()).not.toBeNull();
  });

  it('does not attach twice to a page reported twice', async () => {
    // A context can emit 'page' for something already in pages(). Two listeners
    // would make the second see a slot the first just filled and release the
    // dialog as though it were a hijack attempt.
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    const ctx = fakeContext([page]);
    fc.watch(ctx as never);
    ctx.addPage(page);            // reported again

    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    expect(fc.pending()).not.toBeNull();
    // Nothing was cancelled by a duplicate listener.
    expect(chooser.given).toEqual([]);
  });

  it('drops the request when the tab that asked is closed', async () => {
    // Otherwise the view keeps prompting for a file that has nowhere to go.
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    page.emit('filechooser', fakeChooser());
    await settle();
    expect(fc.pending()).not.toBeNull();

    page.emit('close');
    expect(fc.pending()).toBeNull();
  });
});

describe('answering the dialog with the operator own file', () => {
  it('hands the page the real path behind an upload token', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    const token = await upload('quarterly report.xlsx');
    const done = await fc.accept(fc.pending()!.id, [token]);

    expect(done.count).toBe(1);
    expect(chooser.given).toHaveLength(1);
    // The page must see the OPERATOR's filename, not the token: a page reads
    // file.name, shows it, and sometimes validates it.
    expect(path.basename(chooser.given[0][0])).toBe('quarterly report.xlsx');
    // And the bytes really are there.
    expect(await fs.readFile(chooser.given[0][0], 'utf8')).toBe('hello');
  });

  it('closes the request afterwards, so nothing can be answered twice', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    page.emit('filechooser', fakeChooser());
    await settle();

    const id = fc.pending()!.id;
    await fc.accept(id, [await upload('a.txt')]);
    expect(fc.pending()).toBeNull();
    await expect(fc.accept(id, [await upload('b.txt')])).rejects.toThrow(FileChooserError);
  });

  it('gives a single-file input exactly one file, however many were offered', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser({ multiple: false });
    page.emit('filechooser', chooser);
    await settle();

    const tokens = [await upload('a.txt'), await upload('b.txt'), await upload('c.txt')];
    const done = await fc.accept(fc.pending()!.id, tokens);

    expect(done.count).toBe(1);
    expect(chooser.given[0]).toHaveLength(1);
  });

  it('gives a multiple input all of them, in order', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser({ multiple: true });
    page.emit('filechooser', chooser);
    await settle();

    const tokens = [await upload('a.txt'), await upload('b.txt')];
    await fc.accept(fc.pending()!.id, tokens);

    expect(chooser.given[0].map((f) => path.basename(f))).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses an answer aimed at a request that is no longer current', async () => {
    // Answering "whatever is pending now" is how a file picked for one page gets
    // delivered to a different page that opened its own dialog meanwhile.
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    page.emit('filechooser', fakeChooser());
    await settle();

    await expect(fc.accept('fc999', [await upload('a.txt')]))
      .rejects.toThrow(/no longer the current one/i);
    // And the real request is untouched, so it can still be answered properly.
    expect(fc.pending()).not.toBeNull();
  });

  it('refuses when nothing is pending at all', async () => {
    const fc = new RemoteFileChooser(USER);
    await expect(fc.accept('fc1', ['up_0123456789abcdef01234567']))
      .rejects.toThrow(/not asking for a file/i);
  });
});

describe('tokens, never paths', () => {
  it('ignores a filesystem path and releases the page rather than reading it', async () => {
    // The central security property. A route that accepted a path would be an
    // arbitrary-file-read: nothing would stop a caller skipping the upload and
    // asking the browser to hand /etc/passwd to an attacker-chosen page.
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    // A path is not a token, so nothing resolves and the answer is refused
    // outright. The wording is the class's own, quoted here so a reword that
    // changed the MEANING would have to be looked at.
    await expect(fc.accept(fc.pending()!.id, ['/etc/passwd']))
      .rejects.toThrow(/none of those uploads are still available/i);
    // setFiles([]) — "Cancel" — so the page is released instead of left waiting.
    expect(chooser.given).toEqual([[]]);
  });

  it('ignores a traversal dressed up as a token', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    page.emit('filechooser', fakeChooser());
    await settle();

    await expect(fc.accept(fc.pending()!.id, ['up_../../../../etc/passwd']))
      .rejects.toThrow(/none of those uploads are still available/i);
  });

  it('drops an unusable token but still delivers the usable ones', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser({ multiple: true });
    page.emit('filechooser', chooser);
    await settle();

    const good = await upload('real.txt');
    await fc.accept(fc.pending()!.id, ['/etc/passwd', good, 'up_deadbeef']);

    expect(chooser.given[0].map((f) => path.basename(f))).toEqual(['real.txt']);
  });

  it('does not delete the upload at hand-over, because Chrome reads it later', async () => {
    // Chrome reads the bytes when the PAGE asks for them, which can be long after
    // setFiles resolves. Deleting on hand-over produced an upload whose name the
    // page could see and whose contents it could never read.
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    const token = await upload('later.txt', 'still here');
    await fc.accept(fc.pending()!.id, [token]);

    expect(await fs.readFile(chooser.given[0][0], 'utf8')).toBe('still here');
    expect(fc.consumedTokens()).toContain(token);
  });
});

describe('two tabs asking at once: first come, first served', () => {
  it('keeps the FIRST dialog and releases the second', async () => {
    // MEASURED (simulator + transient probe, since deleted) that letting the newer
    // dialog take the slot delivers the file to the WRONG page:
    //     A input files : 0
    //     B input files : 1        ← A asked, B received
    // A file going somewhere the operator did not choose is worse than a visible
    // failure, so the later dialog is cancelled instead.
    const fc = new RemoteFileChooser(USER);
    const a = fakePage('a');
    const b = fakePage('b');
    fc.watch(fakeContext([a, b]) as never);

    const first = fakeChooser({ name: 'first' });
    const second = fakeChooser({ name: 'second' });
    a.emit('filechooser', first);
    await settle();
    b.emit('filechooser', second);
    await settle();

    // The pending request is still the FIRST one.
    expect(fc.pending()!.name).toBe('first');
    // The second was released rather than left hanging.
    expect(second.given).toEqual([[]]);

    // And the file goes to the page that asked for it.
    await fc.accept(fc.pending()!.id, [await upload('mine.txt')]);
    expect(first.given).toHaveLength(1);
    expect(path.basename(first.given[0][0])).toBe('mine.txt');
  });

  it('lets the SAME page replace its own dialog', async () => {
    // A page that re-opens its own chooser (the operator clicked Browse twice) is
    // not a hijack, and refusing it would strand the dialog now on screen.
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);

    page.emit('filechooser', fakeChooser({ name: 'one' }));
    await settle();
    const firstId = fc.pending()!.id;
    page.emit('filechooser', fakeChooser({ name: 'two' }));
    await settle();

    expect(fc.pending()!.name).toBe('two');
    expect(fc.pending()!.id).not.toBe(firstId);
  });

  it('accepts the next tab dialog once the first has been answered', async () => {
    // The slot and its OWNER are released together. A stale owner would make the
    // next dialog from a different tab look like a hijack and get refused, which
    // is the original silent-import bug wearing a new hat.
    const fc = new RemoteFileChooser(USER);
    const a = fakePage('a');
    const b = fakePage('b');
    fc.watch(fakeContext([a, b]) as never);

    a.emit('filechooser', fakeChooser());
    await settle();
    await fc.accept(fc.pending()!.id, [await upload('a.txt')]);

    const second = fakeChooser({ name: 'b-dialog' });
    b.emit('filechooser', second);
    await settle();

    expect(fc.pending()!.name).toBe('b-dialog');
    expect(second.given).toEqual([]);      // admitted, not released
  });
});

describe('cancelling releases the page instead of freezing it', () => {
  it('answers with an empty selection, which is what Cancel means to a page', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    expect(await fc.cancel(fc.pending()!.id)).toBe(true);
    expect(chooser.given).toEqual([[]]);
    expect(fc.pending()).toBeNull();
  });

  it('cancels whatever is pending when given no id, for teardown', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    expect(await fc.cancel()).toBe(true);
    expect(chooser.given).toEqual([[]]);
  });

  it('ignores a cancel aimed at a request that is already gone', async () => {
    const fc = new RemoteFileChooser(USER);
    const page = fakePage();
    fc.watch(fakeContext([page]) as never);
    const chooser = fakeChooser();
    page.emit('filechooser', chooser);
    await settle();

    expect(await fc.cancel('fc999')).toBe(false);
    // The real one is untouched.
    expect(chooser.given).toEqual([]);
    expect(fc.pending()).not.toBeNull();
  });

  it('reports false when there is nothing to cancel', async () => {
    const fc = new RemoteFileChooser(USER);
    expect(await fc.cancel()).toBe(false);
  });
});

describe('a dialog nobody answers does not wait for ever', () => {
  it('releases the page after the timeout, so it stops waiting for input', async () => {
    // The dialog itself is patient — MEASURED (tools/probe-chooser-hold.js) still
    // answerable after 47.8 s with the renderer responsive — which is why the
    // timeout is minutes and not seconds. But it is not infinite: a page that
    // thinks a file dialog is open behaves as if it is still waiting for input,
    // and leaving that behind after the operator walks away turns one ignored
    // prompt into a tab that never finishes what it was doing.
    vi.useFakeTimers();
    try {
      const fc = new RemoteFileChooser(USER);
      const page = fakePage();
      fc.watch(fakeContext([page]) as never);
      const chooser = fakeChooser();
      page.emit('filechooser', chooser);
      await vi.advanceTimersByTimeAsync(0);
      expect(fc.pending()).not.toBeNull();

      // Well inside the window: still the operator's to answer.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fc.pending()).not.toBeNull();
      expect(chooser.given).toEqual([]);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      expect(fc.pending()).toBeNull();
      expect(chooser.given).toEqual([[]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release a dialog that was already answered', async () => {
    // The timer must be disarmed on answer, or it fires later and sends
    // setFiles([]) to a chooser that has already been given a file.
    vi.useFakeTimers();
    try {
      const fc = new RemoteFileChooser(USER);
      const page = fakePage();
      fc.watch(fakeContext([page]) as never);
      const chooser = fakeChooser();
      page.emit('filechooser', chooser);
      await vi.advanceTimersByTimeAsync(0);

      const stored = await saveUpload(USER, 'a.txt', Buffer.from('x'));
      await fc.accept(fc.pending()!.id, [stored.token]);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      // Exactly one setFiles, and it carried the file.
      expect(chooser.given).toHaveLength(1);
      expect(chooser.given[0]).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
