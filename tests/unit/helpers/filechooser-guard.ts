/**
 * filechooser-guard.ts — run the REAL file-dialog guard from
 * src/core/LiveBrowser.ts against fake pages.
 *
 * Not a test file (vitest collects only tests/**\/*.test.ts), just a shared
 * harness for the two suites that assert on this guard:
 *   * tests/unit/filechooser-not-lost.test.ts — the bug it fixes
 *   * tests/unit/browser-tabs.test.ts         — "don't answer another tab's dialog"
 *
 * WHY EXTRACT-AND-EXECUTE RATHER THAN RE-IMPLEMENT
 * -----------------------------------------------
 * The decision under test is a predicate inside a Playwright event handler, so
 * it cannot be imported. My first attempt re-implemented the predicate in the
 * test file and asserted against that copy — mutation testing exposed it as
 * near-worthless: with the original bug restored in LiveBrowser.ts only 1 of 6
 * tests failed, because five were testing the copy instead of the code.
 *
 * So the real listener body is read out of the source, `new Function`-compiled
 * and called with `this` bound to a fake session. If the shipped predicate
 * changes, every test built on this helper fails.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', '..', 'src', 'core', 'LiveBrowser.ts');

/** A stand-in for Playwright's FileChooser, recording how it was disposed of. */
export function fakeChooser(id: string) {
  const calls: string[] = [];
  return {
    id,
    calls,
    isMultiple: () => false,
    element: () => ({ getAttribute: async () => '' }),
    setFiles: async () => { calls.push('setFiles([])'); },
  };
}

export interface FakeSelf {
  tabs: Array<{ page: unknown }>;
  page: unknown;
  pendingChooser: unknown;
  pendingChooserPage: unknown;
  emit: (name: string) => void;
}

export type Guard = (
  self: FakeSelf,
  page: unknown,
  chooser: ReturnType<typeof fakeChooser>,
) => void;

/**
 * Pull the real `page.on('filechooser', …)` callback body out of the source and
 * make it callable with a fake `this`.
 *
 * Only the guard runs: the trailing `void (async () => {…})()` block reads
 * attributes off a live Playwright ElementHandle, which is not what is under
 * test. It is replaced by a recorded `emit`, leaving exactly the admit/refuse
 * decision — the thing that broke.
 */
export async function loadRealGuard(): Promise<Guard> {
  const src = await readFile(SRC, 'utf8');
  const start = src.indexOf("page.on('filechooser'");
  if (start < 0) throw new Error('filechooser listener not found');
  const bodyStart = src.indexOf('{', src.indexOf('=>', start));
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  if (bodyEnd < 0) throw new Error('unbalanced filechooser body');
  let body = src.slice(bodyStart + 1, bodyEnd);
  const tail = body.indexOf('void (async');
  if (tail >= 0) body = body.slice(0, tail) + "this.emit('filechooser');";
  // eslint-disable-next-line no-new-func
  const fn = new Function('page', 'chooser', body);
  return (self, page, chooser) => fn.call(self, page, chooser);
}

/**
 * A fake LiveBrowser: the tabs we own, the page activation has settled on, and
 * a recorder for what the real guard decides to do.
 *
 * `tabs` and `page` are deliberately allowed to disagree — that disagreement IS
 * the measured activation race.
 */
export function fakeSession(tabs: unknown[], activePage: unknown) {
  const emitted: string[] = [];
  const self: FakeSelf = {
    tabs: tabs.map((p) => ({ page: p })),
    page: activePage,
    pendingChooser: null,
    pendingChooserPage: null,
    emit: (name: string) => { emitted.push(name); },
  };
  return { self, emitted };
}
