/**
 * chromeview-prompt-detection.test.ts -- the Local Browser page must tell a REAL
 * browser prompt() from a test stub.
 *
 * ChromeView.ts is ONE template literal, so a regex written there loses its
 * backslashes (\s -> s, \{ -> {) before the browser sees it. The old
 * isTestPrompt() was such a regex: in the emitted page it never matched a native
 * prompt, so it always answered "this is a test" and Move / Copy fell back to the
 * browser's own prompt() box instead of the in-drawer folder picker.
 *
 * This runs the function as EMITTED by chromeViewHtml(), not the TypeScript source.
 */
import { describe, it, expect } from 'vitest';

import { chromeViewHtml } from '../../src/core/ChromeView';

function emittedIsTestPrompt(): (prompt: unknown) => boolean {
  const html = chromeViewHtml();
  const m = /function isTestPrompt\(\) \{[\s\S]*?\n\}/.exec(html);
  if (!m) throw new Error('isTestPrompt is not in the emitted Local Browser page');
  // eslint-disable-next-line no-new-func
  return new Function('prompt', m[0] + '\nreturn isTestPrompt();') as (p: unknown) => boolean;
}

describe('Local Browser page: isTestPrompt as emitted', () => {
  it('is false for a native prompt, so the in-drawer picker is used', () => {
    // A bound function stringifies as "function () { [native code] }".
    const nativeLike = (() => null).bind(null);
    expect(emittedIsTestPrompt()(nativeLike)).toBe(false);
  });

  it('is true for a plain stub, so tests keep their typed-path fallback', () => {
    expect(emittedIsTestPrompt()(() => null)).toBe(true);
  });
});
