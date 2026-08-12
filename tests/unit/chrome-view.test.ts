/**
 * Behaviour tests for the bare Chromium view.
 *
 * WHAT THESE GUARD
 * ----------------
 * Two separate regressions the user actually hit:
 *
 * 1. Being shown a VNC client instead of a browser. MEASURED on noVNC's own
 *    client: `vnc.html` carries 64 distinct `noVNC_*` element ids (connect
 *    dialog, control bar, credentials dialog, settings/clipboard/fullscreen/
 *    power panels); `vnc_lite.html` is down to 4 but still paints a status bar
 *    and a Send-CtrlAltDel button. The user's words:
 *      «نمیخام به گزینه های مثل vnc یا novnc روبرو بشم»
 *
 * 2. The page hanging forever on "Starting Chromium…". Root cause MEASURED:
 *    a query string on an `import()` specifier is not inherited by that
 *    module's own relative imports, so rfb.js's 41 dependencies 401'd and the
 *    module graph never instantiated.
 *
 * WHY NO DOM LIBRARY
 * ------------------
 * This repo deliberately has no jsdom/happy-dom dependency (vitest runs with
 * `environment: 'node'`, and ab-core.test.ts states the convention explicitly:
 * "no jsdom dependency, no chrome/DOM access"). Adding one for a handful of
 * element lookups would be a poor trade, so the assertions below extract what
 * they need with narrow, purpose-built helpers over the emitted document.
 *
 * These test the ARTEFACT the browser receives, and the live end-to-end
 * behaviour is covered separately by rendering the page in real Chromium
 * (measured: canvas 1600x900, 30 distinct colours, overlay hidden, 0 noVNC
 * elements, 0 401 responses).
 */

import { describe, it, expect } from 'vitest';

import { chromeViewHtml } from '../../src/core/ChromeView';

/** Every `id="..."` in the document. */
function idsIn(html: string): string[] {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The opening tag of the element with this id, so attributes on it (notably
 * `hidden`) can be checked without a DOM.
 */
function openTagOf(html: string, id: string): string {
  const m = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`, 'i').exec(html);
  return m ? m[0] : '';
}

/** Does the element with this id start out hidden? */
function startsHidden(html: string, id: string): boolean {
  const tag = openTagOf(html, id);
  expect(tag, `no element with id="${id}"`).not.toBe('');
  return /\shidden(\s|=|>|\/)/.test(tag);
}

/** Just the <body>, so <style> and <script> text is out of the way. */
function bodyOf(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : '';
}

/** Visible text of the body: tags and inline script/style stripped. */
function visibleText(html: string): string {
  return bodyOf(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Every module specifier the page imports, static or dynamic. */
function importSpecifiers(html: string): string[] {
  return [...html.matchAll(/from\s+'([^']+)'|import\(\s*'([^']+)'/g)]
    .map((m) => m[1] || m[2]);
}

describe('the view shows a browser, not a VNC client', () => {
  it('has no noVNC UI elements at all', () => {
    // The number that made this rewrite necessary was 64. It must be 0.
    const novnc = idsIn(chromeViewHtml()).filter((id) => id.startsWith('noVNC_'));
    expect(novnc).toEqual([]);
  });

  it('offers no connect button for the operator to find and press', () => {
    // noVNC's connect dialog is what greeted the user before this change: they
    // asked for a browser and had to dismiss a protocol dialog first.
    const buttons = [...bodyOf(chromeViewHtml()).matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)]
      .map((m) => m[1].toLowerCase());
    expect(buttons.length).toBeGreaterThan(0); // the retry button exists...
    expect(buttons.some((t) => t.includes('connect'))).toBe(false); // ...but no Connect
  });

  it('offers no Send-CtrlAltDel, clipboard or power controls', () => {
    // These are what vnc_lite.html still shows, which is why dropping down to
    // it was not an acceptable substitute.
    const text = visibleText(chromeViewHtml());
    for (const word of ['ctrl', 'alt', 'del', 'clipboard', 'shutdown', 'reboot', 'fullscreen']) {
      expect(text, `unexpected VNC control: ${word}`).not.toContain(word);
    }
  });

  it('gives the remote screen a container that fills the tab', () => {
    const html = chromeViewHtml();
    expect(idsIn(html)).toContain('screen');
    // fixed + inset:0 is what makes Chromium fill the tab rather than sit in a
    // letterboxed panel with the page scrolling around it.
    const rule = /#screen\s*\{([^}]*)\}/.exec(html);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/position:\s*fixed/);
    expect(rule![1]).toMatch(/inset:\s*0/);
  });
});

describe('the status overlay', () => {
  it('starts visible so a slow connection is never a blank tab', () => {
    // `hidden` is what the connect handler removes; it must not start set, or
    // the operator stares at an empty dark page while it connects.
    expect(startsHidden(chromeViewHtml(), 'note')).toBe(false);
  });

  it('starts with a spinner and no retry button', () => {
    const html = chromeViewHtml();
    expect(startsHidden(html, 'spin')).toBe(false);
    // Offering "Try again" before anything has failed invites the operator to
    // interrupt a connection that is merely slow.
    expect(startsHidden(html, 'retry')).toBe(true);
  });

  it('says what it is doing, in words, while it connects', () => {
    // The user watched this exact text for ten minutes. It must be present (so
    // the tab is never blank) AND the connect handler must hide it (below).
    expect(visibleText(chromeViewHtml())).toContain('starting chromium');
  });

  it('hides the overlay when the connection succeeds', () => {
    // The stuck spinner WAS the bug report. If nothing hides the overlay on
    // 'connect', a working session still looks broken.
    const html = chromeViewHtml();
    const handler = /addEventListener\('connect',([\s\S]*?)\}\);/.exec(html);
    expect(handler).not.toBeNull();
    expect(handler![1]).toMatch(/note\.hidden\s*=\s*true/);
  });

  it('turns the spinner into a retry button when the connection fails', () => {
    // Otherwise a failure is indistinguishable from a slow connect, which is
    // precisely how the original bug presented.
    const html = chromeViewHtml();
    expect(html).toMatch(/addEventListener\('disconnect'/);
    expect(html).toMatch(/addEventListener\('securityfailure'/);
    // The button must START THE STACK, not merely reconnect. It used to call
    // connect(), which is why the operator's Retry span for ever: there was
    // nothing running to connect TO, and connecting harder does not fix that.
    // startThenConnect() POSTs /browser/real/open first (see ChromeView).
    expect(html).toMatch(/retry\.addEventListener\('click',[\s\S]{0,60}?startThenConnect\(\)/);
    expect(html).not.toMatch(/retry\.addEventListener\('click',\s*connect\)/);
  });

  it('starts the stack on load too, so arriving at the tab is enough', () => {
    // The failure page sends Retry HERE (public/js/browser-view.js). If this
    // page only connected, that link would just relocate the dead end.
    const html = chromeViewHtml();
    expect(html).toMatch(/async function startThenConnect/);
    expect(html).toMatch(/fetch\('\/browser\/real\/open'/);
    // The boot call, at the very bottom of the module body.
    expect(html).toMatch(/^\s*void startThenConnect\(\);\s*$/m);
  });
});

describe('asset loading cannot regress to per-URL credentials', () => {
  it('imports rfb.js with a bare specifier, carrying no query string', () => {
    // THE REGRESSION GUARD. `import RFB from './core/rfb.js?api_key=...'` looks
    // like it should work and does not: MEASURED that rfb.js's own 41 relative
    // imports do not inherit the query, so they 401 and the page hangs forever
    // on "Starting Chromium…". Auth belongs to the session cookie instead.
    const specifiers = importSpecifiers(chromeViewHtml());
    expect(specifiers).toContain('./core/rfb.js');
    for (const s of specifiers) {
      expect(s, `credential smuggled into an import: ${s}`).not.toContain('api_key');
      expect(s, `query string on an import specifier: ${s}`).not.toContain('?');
    }
  });

  it('loads nothing of ours besides rfb.js', () => {
    // Every extra request is another thing that can 401 or 404 before the
    // operator sees a browser, so the page is deliberately self-contained.
    const html = chromeViewHtml();
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(importSpecifiers(html)).toEqual(['./core/rfb.js']);
  });
});

describe('the VNC socket', () => {
  it("uses this app's own origin and port, not a second hostname", () => {
    // websockify's own port (6080) has no hostname behind a single published
    // port — a sandbox URL, a PaaS, a reverse proxy, a one-port SSH tunnel.
    const html = chromeViewHtml();
    expect(html).toContain('/desktop/websockify');
    expect(html).toContain('location.host');
    expect(html).not.toContain('6080');
    // No absolute origin of any kind: that is what made the old link dead.
    expect(html).not.toMatch(/ws:\/\/[a-z0-9]/i);
  });

  it('upgrades to wss when the page itself is https', () => {
    // A ws:// socket from an https page is blocked as mixed content, which
    // would strand the operator on the spinner with nothing on screen.
    expect(chromeViewHtml()).toContain("location.protocol === 'https:' ? 'wss' : 'ws'");
  });

  it('passes any VNC password up front so no credentials prompt appears', () => {
    // noVNC's credentials dialog is part of the UI the operator did not want;
    // supplying the password with the connection is what avoids it.
    const html = chromeViewHtml();
    expect(html).toMatch(/credentials:\s*\{\s*password:/);
    expect(html).toContain('vnc_password');
  });

  it('scales the desktop to the tab instead of showing scrollbars', () => {
    // A browser you have to pan around is not a usable browser.
    const html = chromeViewHtml();
    expect(html).toMatch(/scaleViewport\s*=\s*true/);
    expect(html).toMatch(/clipViewport\s*=\s*false/);
  });
});

describe('the page does not manufacture its own console errors', () => {
  it('declares an icon, so the browser does not request a 404 favicon', () => {
    // MEASURED: without a <link rel="icon">, the browser asks for /favicon.ico
    // unprompted. That is not a /desktop path, so it 404s and paints a red
    // error in the console of a page whose entire job is to reassure the
    // operator that the remote browser came up. With the icon declared, a full
    // page load reports FAILED_RESOURCES=[].
    const html = chromeViewHtml();
    const icon = /<link[^>]+rel=["']?icon["']?[^>]*>/i.exec(html);
    expect(icon, 'no <link rel="icon"> in the view').not.toBeNull();
    // It must be self-contained: pointing at a real file would be one more
    // request that has to authenticate, which is the class of bug this whole
    // view exists to eliminate.
    expect(icon![0]).toMatch(/href=["']?data:/i);
  });
});
