/**
 * THE ALERT PAGES A PREVIOUS RELEASE LEFT IN THE PROFILE ARE SWEPT AT LAUNCH.
 *
 * WHY THIS FILE EXISTS — THE WORD "BEFORE" IN THE REPORT
 * ------------------------------------------------------
 * The operator's complaint was not that using the picker made pages. It was:
 *
 *   «در اجرای فعلی Local Browser، حتی قبل از استفاده از Picker، چندین
 *    about:blank ساخته می‌شود؛ مثلاً ۵ یا بیشتر about:blank به‌علاوه یک
 *    consent-host. این رفتار قابل قبول نیست.»
 *
 * BEFORE using the picker. That single word rules out the picker flow as the
 * whole story, and it is what makes deleting `alertTab()` an incomplete fix.
 *
 * WHAT WAS MEASURED, on a profile that had run the old build, at launch, with
 * no picker having run in that process at all:
 *
 *   stage    total  about:blank  consent-host
 *   launch       3            1             2
 *
 * TWO pages the current code cannot account for, because the current code did
 * not create them — a PREVIOUS process did, and Chrome restored them. The
 * claim-and-reuse logic was per-PROCESS while the profile is per-DISK, so every
 * run that ended with an Alert page open added one to the profile's session, and
 * the next launch handed them all back.
 *
 * Session restore is ON deliberately (`enableSessionRestore` writes
 * `restore_on_startup = 5` and `--restore-last-session` is a launch flag), and
 * it is not being turned off: it is how the operator's real tabs survive a
 * crash, and they have already reported losing them once («تب‌هام از دست رفت»).
 * Deleting `Default/Sessions/*` would discard every other tab too — the exact
 * data loss restore exists to prevent. So the sweep is TARGETED: it closes only
 * pages whose URL is the Alert page this server used to open, and nothing else.
 *
 * The operator asked for this explicitly:
 *
 *   «Also clear any existing persisted Chrome session data that contains old
 *    consent-host pages, otherwise old state will keep confusing testing.»
 *
 * WHY THE FAKES RECORD BOTH `closes` AND `gotos`
 * ----------------------------------------------
 * The interesting branch does NOT close a page: when every restored page is
 * stale, closing them all would leave a window with no tab, contradicting
 * «Local Browser باید یک page/tab اولیه قابل reuse داشته باشد». One is blanked
 * instead. A fake that only counted closes could not tell "blanked and kept"
 * from "never handled", so it records navigations separately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sweepRestoredAlertPages } from '../../src/core/RealChrome';

/** The port varies between the run that leaked and the run that cleans up. */
const HOST = 'http://127.0.0.1:3000/inspector/consent-host';

type FakePage = {
  url: () => string;
  close: () => Promise<void>;
  goto: (u: string) => Promise<unknown>;
  closes: number;
  gotos: string[];
};

function page(url: string, opts: { failClose?: boolean; failGoto?: boolean } = {}): FakePage {
  const p: FakePage = {
    closes: 0,
    gotos: [],
    url: () => p.gotos.length ? p.gotos[p.gotos.length - 1]! : url,
    close: async () => {
      p.closes++;
      if (opts.failClose) throw new Error('target closed');
    },
    goto: async (u: string) => {
      if (opts.failGoto) throw new Error('navigation failed');
      p.gotos.push(u);
      return null;
    },
  };
  return p;
}

function context(pages: FakePage[]) {
  return { pages: () => pages } as unknown as Parameters<typeof sweepRestoredAlertPages>[0];
}

let logs: string[] = [];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('a profile carrying leaked Alert pages is cleaned at launch', () => {
  it('closes the consent-host pages the previous build left behind', async () => {
    const real = page('https://example.com/work');
    const leaked1 = page(HOST);
    const leaked2 = page(HOST);

    const handled = await sweepRestoredAlertPages(context([real, leaked1, leaked2]));

    expect(handled).toBe(2);
    expect(leaked1.closes).toBe(1);
    expect(leaked2.closes).toBe(1);
  });

  it('leaves every page that is NOT an Alert page completely alone', async () => {
    // The whole reason the sweep is targeted rather than a session wipe.
    const google = page('https://www.google.com/');
    const docs = page('https://example.com/docs');
    const blank = page('about:blank');
    const leaked = page(HOST);

    await sweepRestoredAlertPages(context([google, docs, blank, leaked]));

    for (const survivor of [google, docs, blank]) {
      expect(survivor.closes).toBe(0);
      expect(survivor.gotos).toEqual([]);
    }
    expect(leaked.closes).toBe(1);
  });

  it('does nothing at all, and says nothing, on a clean profile', async () => {
    const a = page('about:blank');
    const b = page('https://example.com/');

    const handled = await sweepRestoredAlertPages(context([a, b]));

    expect(handled).toBe(0);
    expect(a.closes + b.closes).toBe(0);
    // Silence matters: a launch line printed every time would train the
    // operator to ignore the one launch where it mattered.
    expect(logs.join('\n')).not.toContain('swept');
  });

  it('still recognises the page when the port has changed since it leaked', async () => {
    // Matching is on the PATH, because `config.PORT` can differ between the run
    // that leaked the page and the run that cleans it up.
    const moved = page('http://127.0.0.1:8899/inspector/consent-host');
    const real = page('https://example.com/');

    const handled = await sweepRestoredAlertPages(context([moved, real]));

    expect(handled).toBe(1);
    expect(moved.closes).toBe(1);
  });

  it('handles the «۵ یا بیشتر» case the operator actually reported', async () => {
    const blanks = [page('about:blank'), page('about:blank'), page('about:blank'),
      page('about:blank'), page('about:blank')];
    const host = page(HOST);

    const handled = await sweepRestoredAlertPages(context([...blanks, host]));

    // Only the Alert page is this function's business. The blanks are Chrome's
    // own restored tabs and are not ours to close.
    expect(handled).toBe(1);
    expect(host.closes).toBe(1);
    expect(blanks.every((b) => b.closes === 0)).toBe(true);
  });
});

describe('the window is never left without a reusable tab', () => {
  it('BLANKS the first page instead of closing it when every page is stale', async () => {
    const one = page(HOST);
    const two = page(HOST);
    const three = page(HOST);

    const handled = await sweepRestoredAlertPages(context([one, two, three]));

    expect(handled).toBe(3);
    // The distinction the fake exists to capture: kept, not closed.
    expect(one.closes).toBe(0);
    expect(one.gotos).toEqual(['about:blank']);
    expect(two.closes).toBe(1);
    expect(three.closes).toBe(1);
  });

  it('keeps a single stale page as the reusable tab rather than emptying the window', async () => {
    const only = page(HOST);

    const handled = await sweepRestoredAlertPages(context([only]));

    expect(handled).toBe(1);
    expect(only.closes).toBe(0);
    expect(only.url()).toBe('about:blank');
  });

  it('closes ALL stale pages once any non-stale page will survive', async () => {
    // The keep-one exception is about not emptying the window. With a survivor
    // present there is nothing to preserve, so no page is spared.
    const survivor = page('https://example.com/');
    const one = page(HOST);
    const two = page(HOST);

    await sweepRestoredAlertPages(context([survivor, one, two]));

    expect(one.closes).toBe(1);
    expect(two.closes).toBe(1);
    expect(one.gotos).toEqual([]);
    expect(survivor.closes).toBe(0);
  });

  it('treats about:blank as a survivor, so no stale page is kept', async () => {
    const blank = page('about:blank');
    const leaked = page(HOST);

    await sweepRestoredAlertPages(context([blank, leaked]));

    // about:blank IS the reusable tab the spec asks for, so the Alert page has
    // no reason to be spared.
    expect(leaked.closes).toBe(1);
    expect(leaked.gotos).toEqual([]);
  });
});

describe('the sweep cannot itself break the launch', () => {
  it('survives a page that refuses to close', async () => {
    // A page can die between `pages()` and `close()`. "Already gone" is the
    // desired state, so the rejection must not propagate into launch().
    const bad = page(HOST, { failClose: true });
    const real = page('https://example.com/');

    await expect(sweepRestoredAlertPages(context([bad, real]))).resolves.toBe(1);
  });

  it('survives a page that refuses to navigate', async () => {
    const bad = page(HOST, { failGoto: true });

    await expect(sweepRestoredAlertPages(context([bad]))).resolves.toBe(1);
  });

  it('is safe on a context with no pages at all', async () => {
    await expect(sweepRestoredAlertPages(context([]))).resolves.toBe(0);
  });

  it('never creates a page, in any state', async () => {
    // The point of the whole change is that no code path adds pages. A sweeper
    // that opened a replacement tab would reintroduce the defect it cleans up.
    const ctx = { pages: () => [page(HOST)], newPage: vi.fn() };
    await sweepRestoredAlertPages(ctx as unknown as Parameters<typeof sweepRestoredAlertPages>[0]);
    expect(ctx.newPage).not.toHaveBeenCalled();
  });
});
