/**
 * The in-worker poll must deliver EVERY export on the live path, not just the
 * first one.
 *
 * REPORTED (PR #52 manual test, commit 10a9983): the first extension export
 * reached `<workflow>/downloads/`; the next ones did not.
 *
 * REPRODUCED here against a fake `chrome.downloads`, driving
 * `nextExtensionDownloadReports` exactly like ExtensionDownloadBridge.attach()
 * does (poll, time out, poll again). Before the fix every quiet poll left its
 * waiter in `rec.waiters`; the next `onChanged` woke the stale waiters first,
 * the oldest drained the queue into an already-resolved promise, and the report
 * was lost. Only export #1 (no quiet poll before it) arrived. The sweep is
 * disabled in this fake so the live path is measured on its own.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  installExtensionDownloadObserver,
  nextExtensionDownloadReports,
} from '../../src/core/ExtensionDownloads';

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
let items: any[];
let listeners: Array<(d: any) => void>;

function fakeChrome(sweepFinds: boolean): void {
  items = [];
  listeners = [];
  delete g.__plyrExtDl;
  g.chrome = {
    runtime: { id: 'ext_fixture' },
    downloads: {
      download(o: any, cb?: (id: number) => void) {
        const id = items.length + 1;
        items.push({ id, url: o.url, filename: `/dl/guid-${id}`, state: 'in_progress', byExtensionId: 'ext_fixture', mime: 'application/json' });
        setTimeout(() => {
          items[id - 1].state = 'complete';
          for (const l of listeners) l({ id, state: { current: 'complete' } });
        }, 10);
        if (cb) cb(id);
      },
      onChanged: { addListener: (f: (d: any) => void) => listeners.push(f) },
      search(q: any, cb: (r: any[]) => void) {
        setTimeout(() => cb(q.id != null
          ? items.filter((i) => i.id === q.id)
          : sweepFinds ? items.filter((i) => i.state !== 'in_progress') : []), 1);
      },
    },
  };
}

/** The bridge's loop, with a short poll. Returns received ids with arrival times. */
function pollLoop(waitMs: number): { got: Map<number, number>; stop: () => void } {
  const got = new Map<number, number>();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const batch = (await nextExtensionDownloadReports({ waitMs, since: 0 })) as any[];
      for (const r of batch) if (!got.has(r.id)) got.set(r.id, Date.now());
    }
  })();
  return { got, stop: () => { stopped = true; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('extension export poll: every export on the live path', () => {
  beforeEach(() => fakeChrome(false));
  afterEach(() => { delete g.chrome; delete g.__plyrExtDl; });

  it('3 consecutive exports separated by quiet polls all arrive, promptly', async () => {
    expect(installExtensionDownloadObserver(true).ok).toBe(true);
    const loop = pollLoop(150);
    const fired = new Map<number, number>();
    for (let i = 1; i <= 3; i++) {
      await sleep(400);                                 // > 2 quiet polls before each export
      fired.set(i, Date.now());
      g.chrome.downloads.download({ url: 'data:application/json,{}', filename: 'same.json' });
    }
    await sleep(300);
    loop.stop();
    expect([...loop.got.keys()].sort()).toEqual([1, 2, 3]);
    for (const [id, at] of loop.got) expect(at - fired.get(id)!).toBeLessThan(120);
    // No waiter outlives its poll.
    expect(g.__plyrExtDl.waiters.length).toBeLessThanOrEqual(1);
  });
});
