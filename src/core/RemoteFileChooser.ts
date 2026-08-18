/**
 * RemoteFileChooser — the UPLOAD half of "the remote browser must feel local".
 *
 * WHAT THE OPERATOR ASKED FOR
 * ---------------------------
 *   «وقتی کاربر از داخل Remote Browser روی یک سایت، فایل را برای Upload انتخاب
 *    می‌کند: Windows کاربر → Backend/Server → Website. این انتقال باید در
 *    Backend مدیریت شود و کاربر نباید مجبور باشد ابتدا فایل را دستی روی سرور
 *    Upload کند و بعد از سرور آن را روی سایت بفرستد.»
 *
 * One gesture: press the page's own "Choose file", pick a file off the Windows
 * machine, and the WEBSITE has it. The hop through the server is real, but it is
 * not the operator's problem and must never appear as a step they perform.
 *
 * WHY THIS IS POSSIBLE HERE — AND WHY THE OLD HANDOFF SAID IT WAS NOT
 * -------------------------------------------------------------------
 * An earlier design note stated that on this view an upload could not be
 * automatic, reasoning that the operator drives a REAL Chromium with a real
 * mouse over VNC, so Playwright "is not holding its dialogs open" and there is
 * no dialog to answer. That reasoning is wrong, and only a measurement could
 * settle it. MEASURED (tools/probe-upload-vnc.js): headed Chromium on Xvfb, the
 * file input clicked by a genuine X11 click delivered with `xdotool` — no
 * Playwright click anywhere in the path:
 *
 *     FILECHOOSER_EVENT_FIRED    = true
 *     CHOOSER_ANSWERED_BY_SERVER = true
 *     PAGE_SEES_FILE             = GOT:probe-upload-src.txt:25
 *     NATIVE_GTK_DIALOG_OPEN     = no
 *
 * Interception is a property of the CDP CONNECTION, not of who moved the mouse.
 * Chromium routes "please show a file dialog" to its automation client whenever
 * one is attached, so the native GTK window never opens and the request waits
 * for `setFiles`. RealChrome always has such a client attached — it is the thing
 * that launched the browser — so every chooser on this view is interceptable.
 *
 * Two further measurements set the UX budget around it:
 *   * The intercepted dialog is patient. MEASURED (tools/probe-chooser-hold.js)
 *     an unanswered chooser was still answerable after 47.8 s with the renderer
 *     still responsive — so there is time to ask a human for a file.
 *   * The operator's own picker can still be opened 4900 ms after their last
 *     click (tools/probe-activation-window.js), which is what lets this view
 *     open a LOCAL file dialog in response to a REMOTE page's request.
 *
 * TOKENS, NEVER PATHS
 * -------------------
 * `accept()` takes upload tokens and resolves them inside the user's own upload
 * directory (see RemoteUploads). A route that accepted a path instead would be
 * an arbitrary-file-read with extra steps: nothing would stop a caller skipping
 * the upload and asking the browser to hand `/etc/shadow` to an attacker's page.
 *
 * FIRST-COME, NOT LAST-COME
 * -------------------------
 * The slot holds exactly ONE dialog and the FIRST one keeps it. Ported from the
 * simulator, where the alternative was measured and is worse than a silent
 * failure — two tabs each opening a chooser, then one `setFiles`:
 *
 *     sequence      : pending <- A | pending <- B
 *     A input files : 0
 *     B input files : 1        ← A asked, B received
 *
 * A file going somewhere the operator did not choose is not an acceptable
 * failure mode, so a later dialog is RELEASED immediately (with an empty
 * selection, which is what "Cancel" means to a page) rather than being allowed
 * to clobber the outstanding one.
 */

import type { BrowserContext, FileChooser, Page } from 'playwright';

import { resolveUpload } from './RemoteUploads';

/**
 * What the view needs to know about the dialog the page is waiting on.
 *
 * `id` exists so an answer can NAME the dialog it is answering. Without it a
 * slow operator could answer a chooser that had already been replaced by a
 * newer one — handing their file to a page they were not looking at.
 */
export interface PendingChooser {
  id: string;
  /** Whether the input takes more than one file. */
  multiple: boolean;
  /** The input's own `accept` attribute, so the LOCAL picker can filter alike. */
  accept: string;
  /** The input's `name`, purely so the view can say what is being asked for. */
  name: string;
  /** Epoch ms, so the view can tell a fresh request from a stale one. */
  at: number;
}

/** Answering with more than this many files at once is a bug or an attack. */
const MAX_FILES = 10;

/** Keep the consumed-token list bounded; it is a diagnostic, not a ledger. */
const MAX_CONSUMED = 200;

/**
 * How long an unanswered dialog is held before it is released.
 *
 * Generous on purpose: a human has to see the prompt, find a file and pick it,
 * and the dialog itself is measurably happy to wait (47.8 s tested, no upper
 * bound found). But NOT forever — a page that thinks a file dialog is open
 * behaves as if it is still waiting for input, and leaving that state behind
 * after the operator walked away turns one ignored prompt into a tab that never
 * finishes what it was doing.
 */
export const CHOOSER_TTL_MS = 3 * 60 * 1000;

export class FileChooserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileChooserError';
  }
}

/**
 * The one file dialog the real Chromium currently has open, if any.
 *
 * Deliberately NOT a singleton: `userId` scopes which upload directory a token
 * resolves in, and answering a chooser with another user's upload is the same
 * arbitrary read this module exists to prevent.
 */
export class RemoteFileChooser {
  private chooser: FileChooser | null = null;
  private page: Page | null = null;
  private id = '';
  private info: PendingChooser | null = null;
  private seq = 0;
  private seen = new WeakSet<Page>();
  private expiry: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tokens already handed to a dialog.
   *
   * Remembered, not deleted: Chrome reads the bytes when the PAGE asks for them,
   * which can be long after `setFiles` resolves — deleting at hand-over produced
   * an upload whose name the page could see and whose bytes it could never read.
   * The ordinary sweep (RemoteUploads.sweepUploads, 1 h) removes them later.
   */
  private consumed: string[] = [];

  constructor(private readonly userId: string) {}

  /** Uploads that have been handed to a page. For diagnostics and cleanup. */
  consumedTokens(): string[] {
    return [...this.consumed];
  }

  /**
   * Start intercepting file dialogs in a context.
   *
   * Per-PAGE and not per-context, because Playwright has no context-level
   * `filechooser` event at all. Existing pages are attached now and future ones
   * as they appear — a dialog in a tab the operator opened later must not be the
   * one that escapes to a native GTK window nobody can reach.
   */
  watch(ctx: BrowserContext): void {
    for (const p of ctx.pages()) this.watchPage(p);
    ctx.on('page', (p) => this.watchPage(p));
  }

  private watchPage(page: Page): void {
    // A context can emit 'page' for something already in pages(); attaching
    // twice would make the second listener see a slot the first just filled and
    // release the dialog as though it were a hijack attempt.
    if (this.seen.has(page)) return;
    this.seen.add(page);

    page.on('filechooser', (chooser) => { void this.hold(chooser, page); });

    // A tab closed while its dialog is outstanding would leave a pending row the
    // view keeps prompting for. There is nothing left to answer, so drop it.
    page.on('close', () => {
      if (this.page === page) this.forget();
    });
  }

  private async hold(chooser: FileChooser, page: Page): Promise<void> {
    if (this.chooser && this.page !== page) {
      // Someone else's prompt is on screen. Release this one rather than steal
      // the answer meant for that page — see the measurement in the header.
      await chooser.setFiles([]).catch(() => { /* the page moved on */ });
      return;
    }

    this.seq += 1;
    this.chooser = chooser;
    this.page = page;
    this.id = `fc${this.seq}`;

    // The `accept` filter belongs to the INPUT, and repeating it in the
    // operator's own picker is what stops a .png being offered to a cookie
    // importer that only takes .json.
    let accept = '';
    let name = '';
    try {
      const el = chooser.element();
      accept = (await el.getAttribute('accept')) || '';
      name = (await el.getAttribute('name')) || '';
    } catch {
      /* the element can already be gone; the dialog itself still stands */
    }

    // Re-checked, because awaiting the attributes above yields to the event
    // loop and a second dialog (or an answer) can land in that window.
    // Publishing `info` for a slot that has since moved on would advertise a
    // chooser that cannot be answered.
    if (this.chooser !== chooser) return;

    this.info = {
      id: this.id,
      multiple: (() => { try { return chooser.isMultiple(); } catch { return false; } })(),
      accept,
      name,
      at: Date.now(),
    };

    this.arm(chooser);
  }

  /** Release the dialog if nobody answers it. See CHOOSER_TTL_MS. */
  private arm(chooser: FileChooser): void {
    this.disarm();
    const timer = setTimeout(() => {
      if (this.chooser !== chooser) return;
      this.forget();
      void chooser.setFiles([]).catch(() => { /* the page moved on */ });
    }, CHOOSER_TTL_MS);
    // Never hold the process open for a dialog nobody is waiting for.
    if (typeof timer.unref === 'function') timer.unref();
    this.expiry = timer;
  }

  private disarm(): void {
    if (this.expiry) {
      clearTimeout(this.expiry);
      this.expiry = null;
    }
  }

  /** Clear the slot and its owner TOGETHER — see `accept()` for why. */
  private forget(): void {
    this.disarm();
    this.chooser = null;
    this.page = null;
    this.id = '';
    this.info = null;
  }

  /** The dialog the page is waiting on, or null. */
  pending(): PendingChooser | null {
    return this.info ? { ...this.info } : null;
  }

  /**
   * Hand uploaded files to the dialog the page is waiting on.
   *
   * `id` is checked, not ignored: answering "whatever is pending now" is how a
   * file picked for one page gets delivered to a different one that opened its
   * own dialog in the meantime.
   */
  async accept(id: string, tokens: string[]): Promise<{ count: number }> {
    const chooser = this.chooser;
    if (!chooser || !this.info) {
      throw new FileChooserError('The page is not asking for a file any more.');
    }
    if (String(id || '') !== this.id) {
      throw new FileChooserError('That file request is no longer the current one.');
    }

    // Released BEFORE the awaits below, and released together with its owner: a
    // stale owner makes the next dialog from a different tab look like a hijack
    // attempt and get refused, which is the original silent-import bug wearing
    // a new hat.
    const multiple = this.info.multiple;
    this.forget();

    const paths: string[] = [];
    for (const token of (Array.isArray(tokens) ? tokens : []).slice(0, MAX_FILES)) {
      // Async because a token names a DIRECTORY holding one file that kept the
      // operator's own name, so the real path has to be read off the disk.
      try {
        paths.push(await resolveUpload(this.userId, String(token)));
      } catch {
        /* not a token we minted, or already swept: dropped, never passed through */
      }
    }

    if (!paths.length) {
      // Release the page rather than leave it waiting on a dialog that can no
      // longer be answered.
      await chooser.setFiles([]).catch(() => {});
      throw new FileChooserError('None of those uploads are still available.');
    }

    const use = multiple ? paths : [paths[0]];
    await chooser.setFiles(use);
    this.consumed.push(...(Array.isArray(tokens) ? tokens : []).map(String));
    if (this.consumed.length > MAX_CONSUMED) {
      this.consumed.splice(0, this.consumed.length - MAX_CONSUMED);
    }
    return { count: use.length };
  }

  /**
   * Dismiss the dialog. `setFiles([])` is what "Cancel" means to a page.
   *
   * An empty `id` cancels whatever is pending, which is what a teardown needs: a
   * dialog left open blocks its page, and a blocked page cannot be closed
   * cleanly either.
   */
  async cancel(id = ''): Promise<boolean> {
    const chooser = this.chooser;
    if (!chooser) return false;
    if (id && String(id) !== this.id) return false;
    this.forget();
    await chooser.setFiles([]).catch(() => { /* the page moved on */ });
    return true;
  }
}
