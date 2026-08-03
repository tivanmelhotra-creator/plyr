/**
 * clipboard-reasons.test.ts — §4, "remote copy/paste is broken".
 *
 * The report:
 *   «قبلاً می‌تونستم ریموت کپی یا پیست کنم ولی اینم خراب شده»
 *
 * WHAT THE MEASUREMENT ACTUALLY FOUND
 * -----------------------------------
 * The handoff's leading hypothesis (§4b) was that `LiveBrowser.recover()` grants
 * clipboard permissions only inside its `isContextDead` branch, so a recovery that
 * reuses the context would come back unable to touch the clipboard — which would
 * have tied this item to the extension install of §1/§2 and explained "it used to
 * work".
 *
 * That hypothesis is FALSE, and this is recorded here because a wrong cause left
 * in the docs is worse than no cause. tools/probe-clipboard.js exercised paste,
 * selection-copy and the permission-dependent page clipboard in all three
 * lifecycle states — fresh, after a `resync` (recovery WITHOUT a rebuild, the
 * predicted failure), and after a real /browser/restart — and got 20/20. The
 * server side of remote copy/paste is not broken.
 *
 * The real defect was on the CLIENT, and it was diagnostic rather than functional:
 * `writeLocalClipboard` resolved a bare `false` for three different situations
 * with three different remedies (non-secure origin, refused permission, no API at
 * all), so the UI could only ever say "Could not write to your clipboard." MEASURED
 * by tools/probe-clipboard-ui.js: with the API removed and `execCommand` stubbed
 * to false, that single sentence was the entire response — nothing to act on, and
 * the text that had already crossed from the remote machine was discarded.
 *
 * Both probes are the primary evidence. These tests pin the wiring so it cannot
 * silently regress: which shape the resolver returns, that every branch names a
 * reason, and that both dictionaries carry every new string.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

const RIO = read('public', 'js', 'remote-io.js');
const I18N = read('public', 'js', 'i18n.js');
const LIVE = read('src', 'core', 'LiveBrowser.ts');

/** Strip comments, so no assertion can be satisfied by prose ABOUT the rule. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}
const RIO_CODE = code(RIO);

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  for (let depth = 0, i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

describe('§4 a clipboard failure names its cause', () => {
  describe('writeLocalClipboard reports WHY, not just whether', () => {
    it('resolves an object carrying a reason, never a bare boolean', () => {
      // The bare boolean IS the bug: one `false` for three different remedies.
      const body = fnBody(RIO_CODE, 'writeLocalClipboard');
      expect(body).toMatch(/ok:\s*(true|false)/);
      expect(body).toMatch(/reason:/);
      // No path may resolve a naked boolean any more.
      expect(body).not.toMatch(/Promise\.resolve\(\s*(true|false)\s*\)/);
    });

    it('distinguishes a non-secure origin from a refusal from a missing API', () => {
      const body = fnBody(RIO_CODE, 'writeLocalClipboard');
      expect(body).toContain("'insecure'");
      expect(body).toContain("'denied'");
      const legacy = fnBody(RIO_CODE, 'legacyCopy');
      expect(legacy).toContain("'noApi'");
    });

    it('reasons are stable KEYS, not sentences', () => {
      // A sentence invented here would arrive in the Persian UI in English.
      const body = fnBody(RIO_CODE, 'writeLocalClipboard') + fnBody(RIO_CODE, 'legacyCopy');
      for (const m of body.matchAll(/reason:\s*'([^']*)'/g)) {
        expect(m[1]).toMatch(/^[a-z]*[A-Za-z]*$/);
        expect(m[1].length).toBeLessThan(20);
      }
    });

    it('an empty text is its own reason, not a failure to explain', () => {
      const body = fnBody(RIO_CODE, 'writeLocalClipboard');
      expect(body).toContain("reason: 'empty'");
    });

    it('still tries execCommand — it is the ONLY path on a plain http:// origin', () => {
      // Deleting it would break the majority of this project's deployments, so
      // the fix must add diagnosis without removing the fallback.
      expect(fnBody(RIO_CODE, 'legacyCopy')).toContain('execCommand');
      expect(fnBody(RIO_CODE, 'writeLocalClipboard')).toContain('legacyCopy(');
    });

    it('a missing execCommand is detected rather than thrown', () => {
      // It is deprecated and being removed from Chrome; a TypeError would be
      // reported to the user as an unrelated crash.
      expect(fnBody(RIO_CODE, 'legacyCopy'))
        .toMatch(/typeof document\.execCommand !== 'function'/);
    });

    it('secure-context detection uses the browser rule, not a URL guess', () => {
      expect(RIO_CODE).toContain('isSecureContext');
    });
  });

  describe('the caller speaks each reason', () => {
    it('maps every reason to its own actionable message', () => {
      const i = RIO_CODE.indexOf("case 'clipboard':");
      expect(i).toBeGreaterThan(0);
      const handler = RIO_CODE.slice(i, i + 2200);
      expect(handler).toContain("'rio.copyInsecure'");
      expect(handler).toContain("'rio.copyDenied'");
      expect(handler).toContain("'rio.copyNoApi'");
    });

    it('reads the new shape, not the old boolean', () => {
      const i = RIO_CODE.indexOf("case 'clipboard':");
      const handler = RIO_CODE.slice(i, i + 2200);
      expect(handler).toMatch(/\.then\(function \(r\)/);
      expect(handler).toMatch(/r\.ok/);
      expect(handler).toMatch(/r\.reason/);
    });

    it('still says the happy thing on success', () => {
      const i = RIO_CODE.indexOf("case 'clipboard':");
      expect(RIO_CODE.slice(i, i + 2200)).toContain("'rio.copied'");
    });

    it('still distinguishes "nothing was selected" from a failure', () => {
      // An empty answer is not an error, and conflating them would send the user
      // hunting a broken clipboard when they simply had no selection.
      const i = RIO_CODE.indexOf("case 'clipboard':");
      expect(RIO_CODE.slice(i, i + 2200)).toContain("'rio.nothingToCopy'");
    });
  });

  describe('the text is never thrown away', () => {
    it('offers a manual-copy fallback when the clipboard is refused', () => {
      // The text has already crossed the machine boundary. A browser policy that
      // forbids writing the clipboard is not a reason to discard data the user is
      // already holding.
      expect(RIO_CODE).toContain('function showCopyFallback(');
      const i = RIO_CODE.indexOf("case 'clipboard':");
      expect(RIO_CODE.slice(i, i + 2200)).toContain('showCopyFallback(');
    });

    it('the fallback is a read-only copy source, not an editor', () => {
      const body = fnBody(RIO_CODE, 'showCopyFallback');
      expect(body).toMatch(/readOnly\s*=\s*true/);
    });

    it('the fallback pre-selects the text so only Ctrl+C is left', () => {
      expect(fnBody(RIO_CODE, 'showCopyFallback')).toMatch(/\.select\(\)/);
    });

    it('the fallback can be dismissed, and never stacks up', () => {
      const body = fnBody(RIO_CODE, 'showCopyFallback');
      expect(body).toMatch(/removeChild/);
      expect(body).toContain('rio-copy-fallback');
    });

    it('the fallback is built with DOM calls, not innerHTML of user text', () => {
      // The text comes from a remote page. Interpolating it into innerHTML would
      // turn a clipboard helper into an injection sink.
      const body = fnBody(RIO_CODE, 'showCopyFallback');
      expect(body).toMatch(/\.value\s*=\s*String\(text/);
      expect(body).not.toMatch(/innerHTML\s*=\s*[^;]*text/);
    });
  });

  describe('the server side, whose innocence was MEASURED', () => {
    it('still grants clipboard permissions when it builds a context', () => {
      // 20/20 live across fresh / resync / restart says this is working. The test
      // exists so a later edit cannot quietly remove the grant and reintroduce
      // the bug the handoff feared.
      expect(LIVE).toContain("grantPermissions(['clipboard-read', 'clipboard-write'])");
    });

    it('answers a copy even when there is nothing to copy', () => {
      // Silence is indistinguishable from a broken button, so the UI must always
      // get an event it can explain.
      const c = code(LIVE);
      const i = c.indexOf('async readClipboard(');
      expect(i).toBeGreaterThan(0);
      const body = c.slice(i, i + 2000);
      expect(body).toMatch(/emit\('clipboard'/);
    });

    it('prefers the selection and falls back to the page clipboard', () => {
      // Order matters: the selection is what a user means by Ctrl+C, the page
      // clipboard is where a "copy" button in the page just put its output.
      const c = code(LIVE);
      const i = c.indexOf('async readClipboard(');
      const body = c.slice(i, i + 2000);
      expect(body.indexOf('getSelection')).toBeLessThan(body.indexOf('clipboard.readText'));
    });

    it('a paste both inserts text AND writes the page clipboard', () => {
      // Two different meanings of paste: into a field, and into an extension that
      // reads navigator.clipboard.
      const c = code(LIVE);
      const i = c.indexOf('async paste(');
      const body = c.slice(i, i + 1200);
      expect(body).toContain('clipboard.writeText');
      expect(body).toContain('Input.insertText');
    });
  });

  describe('i18n parity', () => {
    const keys = [
      'rio.copyInsecure', 'rio.copyDenied', 'rio.copyNoApi',
      'rio.copyManualTitle', 'rio.copyManualClose',
    ];
    for (const k of keys) {
      it(`${k} is defined in both dictionaries`, () => {
        expect(I18N.split(`'${k}':`).length - 1).toBe(2);
      });
    }
    it('no new key carries a doubled unicode escape', () => {
      for (const k of keys) {
        const re = new RegExp(`'${k.replace('.', '\\.')}':\\s*'([^']*)'`, 'g');
        for (const m of I18N.matchAll(re)) expect(m[1]).not.toContain('\\\\u');
      }
    });
  });

  describe('the instruments are checked in', () => {
    it('the server-side clipboard probe exists and tests all three states', () => {
      const p = read('tools', 'probe-clipboard.js');
      expect(p).toContain('after resync');
      expect(p).toContain('after restart');
      // It must witness the PERMISSION, not merely compare text: an empty string
      // cannot distinguish "nothing selected" from "read refused".
      expect(p).toContain('pagePermission');
    });

    it('the client-side probe forces the refusal it claims to test', () => {
      const p = read('tools', 'probe-clipboard-ui.js');
      expect(p).toContain('execCommand');
      expect(p).toMatch(/defineProperty\(navigator, 'clipboard'/);
    });
  });
});
