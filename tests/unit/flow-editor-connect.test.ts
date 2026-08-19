import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ════════════════════════════════════════════════════════════════
// public/js/flow-editor.js — the per-field "Connect Inspector" row is GONE.
//
// WHAT THIS FILE USED TO BE
// -------------------------
// 1266 lines driving `buildConnectRow()`: a control attached to every pickable
// field in the NDV that called `InspectorClient.authorizeTarget()`, printed a
// one-time Authorization Code, printed the Base URL to type it into, and polled
// until the extension redeemed it. The tests asserted that code was minted from
// the server's `targetFieldId`, that the address appeared beside it, that a
// refusal re-enabled the button, and so on.
//
// Every one of those behaviours is now FORBIDDEN, so testing them in detail
// would be testing for the defect. The requirement is explicit:
//
//   LOCAL BROWSER = the browser runtime on the SAME server as the application.
//   The LOCAL UI must not contain `Base URL`, `API Key`, `Authorization Code`
//   or `Remote Approval`, and the user must enter none of them.
//
// That row was the third of three credential surfaces (the other two were the
// targeting dialog's authorize screen and the extension popup's connection
// form). It is deleted, along with `authorizeTarget()` on the client and
// `POST /inspector/authorize` on the server.
//
// WHAT THIS FILE IS NOW
// ---------------------
// A regression guard, not a UI test. There is no rendered control left to
// exercise, so the only useful assertion is that it has not grown back — and
// that the machinery it depended on is still absent. This is deliberately a
// source-text test: it fails on the FIRST reintroduction of the pattern,
// including in a form that a behavioural test would not reach because no
// caller has been wired up yet.
// ════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Strip comments so an explanatory note about the removed flow does not read as
 * a reintroduction of it. The files under test document what was removed and
 * why, at length, and that prose necessarily names the very identifiers these
 * assertions forbid.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // Drop `//` comments, but not the `//` inside an http:// literal.
      const i = line.search(/(^|[^:])\/\//);
      if (i === -1) return line;
      return line.slice(0, line.indexOf('//', i));
    })
    .join('\n');
}

describe('flow-editor: the per-field credential row stays removed', () => {
  const editor = code(read('public/js/flow-editor.js'));

  it('does not define buildConnectRow() or its helpers', () => {
    // `buildConnectRow` rendered the row; `myTargetIdFor` looked up which
    // targetFieldId to mint a code for. Both went with it.
    expect(editor).not.toMatch(/function\s+buildConnectRow/);
    expect(editor).not.toMatch(/function\s+myTargetIdFor/);
  });

  it('never calls authorizeTarget()', () => {
    // The single entry point into code minting from the editor.
    expect(editor).not.toMatch(/authorizeTarget\s*\(/);
  });

  it('renders no .ndv-connect* element', () => {
    // The row's own class names. If any reappears, a credential surface is
    // being rebuilt in the node detail view.
    for (const cls of [
      'ndv-connect-btn',
      'ndv-connect-out',
      'ndv-connect-msg',
      'ndv-connect-code',
      'ndv-connect-chip',
      'ndv-connect-label',
      'ndv-connect-copy',
      'ndv-connect-base',
    ]) {
      expect(editor).not.toContain(cls);
    }
  });

  it('has no i18n lookup for a code or a base URL', () => {
    // The keys the row displayed. They are deleted from i18n.js too, so a
    // lookup here would render an empty string rather than fail loudly —
    // exactly the kind of silent half-rebuild worth catching in source.
    for (const key of [
      'insp.codeReady',
      'insp.codeExpires',
      'insp.codeFailed',
      'insp.codeCopied',
      'insp.pairedNow',
      'insp.connect',
      'insp.connectHint',
      'tgt.baseUrl',
      'tgt.authCode',
    ]) {
      expect(editor).not.toContain(key);
    }
  });

  it('keeps writeClipboard(), which belongs to copy-step / copy-workflow', () => {
    // A guard against over-deletion in the other direction: the clipboard
    // helper was NOT part of the credential row and two unrelated features
    // still use it. Removing it would be a silent regression elsewhere.
    expect(editor).toMatch(/function\s+writeClipboard/);
  });
});

describe('the crosshair is the only targeting entry point', () => {
  it('browser-view.js still routes picking through TargetingFlow', () => {
    // What REPLACED the row, and it lives in browser-view.js rather than in the
    // editor: the crosshair calls requestPick(), which hands off to
    // TargetingFlow, which asks the server, which resolves the environment and
    // binds the field itself. The operator supplies a click and nothing else.
    const view = code(read('public/js/browser-view.js'));
    expect(view).toMatch(/function\s+requestPick/);
    expect(view).toMatch(/TargetingFlow/);
  });
});

describe('the removed machinery is absent from the client and the server', () => {
  it('inspector-client.js exposes no authorizeTarget', () => {
    const client = code(read('public/js/inspector-client.js'));
    expect(client).not.toMatch(/function\s+authorizeTarget/);
    expect(client).not.toMatch(/authorizeTarget\s*:/);
    expect(client).not.toContain('/inspector/authorize');
  });

  it('mode.routes.ts mounts neither /inspector/authorize nor /inspector/pair', () => {
    const routes = code(read('src/Routes/mode.routes.ts'));
    // Asserted on the ROUTER CALL, not the string: the file still explains in
    // prose what these endpoints were, and that documentation is worth keeping.
    expect(routes).not.toMatch(/router\.post\(\s*['"]\/inspector\/authorize['"]/);
    expect(routes).not.toMatch(/router\.post\(\s*['"]\/inspector\/pair['"]/);
  });

  it('i18n.js no longer carries the credential keys in either language', () => {
    const i18n = read('public/js/i18n.js');
    for (const key of ['tgt.authCode', 'tgt.baseUrl', 'insp.codeReady', 'insp.connect']) {
      expect(i18n).not.toContain(`'${key}'`);
    }
  });
});
