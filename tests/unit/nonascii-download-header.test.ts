/**
 * nonascii-download-header.test.ts — a download whose name is not ASCII must
 * still reach the user.
 *
 * THE BUG, AS REPORTED
 * --------------------
 * "خارج از پلاگین وقتی چیزی رو دانلود میکنم روی سرور دانلود میشه ولی از سرور به
 *  مرورگر شخصیم … Invalid character in header content [\"Content-Disposition\"]"
 *
 * The file arrived on the server correctly; the server→browser transfer failed.
 *
 * ROOT CAUSE
 * ----------
 * HTTP header values are latin1. `res.setHeader` THROWS on any code unit above
 * 0xff, and the route interpolated the remote file's own name straight into
 * `attachment; filename="${file.name}"`. Express turns that throw into a 500,
 * so the download became an error response. MEASURED against the running
 * server, same session, two files:
 *
 *     GET /browser/downloads/dl_…  "report.pdf"                  -> 200
 *     GET /browser/downloads/dl_…  "seedream-5.0-pro_a_مهدی.png" -> 500
 *       {"success":false,
 *        "error":"Invalid character in header content [\"Content-Disposition\"]"}
 *
 * The same bug existed a second time in the cookie-export route, which built
 * the header out of the `?domain=` query parameter — found by auditing, not by
 * report. MEASURED: ?domain=مهدی.com -> 500, ?domain=x.com -> 200.
 *
 * PROVENANCE, HONESTLY
 * --------------------
 * `git log -L` puts the throwing line in commit 158b94e, so it predates this
 * work. The earlier CSP fix (#29) is what EXPOSED it: while `frame-src 'none'`
 * blocked the download the browser never issued the request, so this
 * server-side throw was never reached. The user's "you made it worse" is fair —
 * the symptom genuinely changed on that commit.
 *
 * THE FIX, AND WHY IT IS NOT "RENAME THEIR FILE"
 * ---------------------------------------------
 * RFC 6266 allows two parameters: an ASCII `filename="…"` fallback and
 * `filename*=UTF-8''<percent-encoded>`. Every browser in use today prefers
 * `filename*`, so the user still receives the real name. Percent-encoding is
 * what makes it safe: `encodeURIComponent` cannot emit a high byte, a quote, a
 * CR or an LF, so it can neither throw nor inject a header.
 *
 * HOW THESE TESTS MEASURE IT
 * --------------------------
 * They serve the header from a REAL `http.Server` and read it back with a real
 * request, so Node itself judges whether the header is legal — the same code
 * that produced the user's 500. Asserting on the returned string alone would
 * not have caught the original bug at all, because the string was fine; it was
 * `setHeader` that rejected it.
 *
 * ONE FALSE ALARM, RECORDED SO NOBODY RE-DEBUGS IT
 * -----------------------------------------------
 * An end-to-end probe saved the Persian file as literally "download". That was
 * not this bug: the sandbox had `LANG` unset (`LC_CTYPE="POSIX"`), and Chromium
 * discards a non-ASCII filename under a POSIX locale. With `LANG=C.utf8`:
 *
 *     "report.pdf"        -> "report.pdf"
 *     "seedream_مهدی.png" -> "seedream_مهدی.png"
 *     "مهدی.png"          -> "مهدی.png"
 *
 * A locale artifact of the test machine, not a defect. The user's Windows
 * browser is UTF-8.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { contentDispositionAttachment } from '../../src/core/RemoteDownloads';

/**
 * Serve one response whose Content-Disposition is built by the helper, then
 * fetch it. The `setHeader` call is deliberately inside the try: if it throws
 * the way it did for the user, that becomes a 500 here too, exactly as Express
 * reported it.
 */
async function serveWithName(filename: string): Promise<{
  status: number;
  header: string;
  threw: string | null;
}> {
  let threw: string | null = null;
  const server = createServer((_req, res) => {
    try {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDispositionAttachment(filename));
      res.statusCode = 200;
      res.end('body');
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
      res.statusCode = 500;
      res.end('error');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    await res.text();
    return {
      status: res.status,
      header: res.headers.get('content-disposition') || '',
      threw,
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Decode what a modern browser would actually use: the `filename*` parameter. */
function realNameFrom(header: string): string {
  const m = /filename\*=UTF-8''([^;]+)/.exec(header);
  return m ? decodeURIComponent(m[1]) : '';
}

const PERSIAN = 'seedream-5.0-pro_a_مهدی.png';

describe('a non-ASCII filename must not break the response', () => {
  it('serves a Persian filename with 200, not the reported 500', async () => {
    // The exact reported case. Before the fix this threw inside setHeader.
    const r = await serveWithName(PERSIAN);
    expect(r.threw).toBeNull();
    expect(r.status).toBe(200);
  });

  it('still delivers the REAL name, so the fix is not "rename their file"', async () => {
    const r = await serveWithName(PERSIAN);
    expect(realNameFrom(r.header)).toBe(PERSIAN);
  });

  it('leaves a plain ASCII name completely untouched', async () => {
    // The fix must not change the behaviour that already worked.
    const r = await serveWithName('report.pdf');
    expect(r.status).toBe(200);
    expect(r.header).toContain('filename="report.pdf"');
    expect(realNameFrom(r.header)).toBe('report.pdf');
  });

  it('accepts every shape of hostile or exotic name without throwing', async () => {
    // Download names come from a remote server's own Content-Disposition, so
    // they are untrusted input, not just "unusual text".
    const names = [
      'مهدی.png',                       // pure non-ASCII
      '文件名.txt',                      // CJK
      'emoji-🎉-party.zip',             // astral plane (surrogate pair)
      'quote".txt',                     // would terminate the quoted-string
      'back\\slash.txt',                // would escape the closing quote
      'crlf\r\ninjected: yes',          // response splitting
      'tab\there.txt',                  // control character
      '\u200f\u200ebidi.txt',           // invisible direction marks
      'ünïcödé-àccents.pdf',            // latin-1 range, still > 0x7e
      'x'.repeat(300) + '-مهدی.bin',    // long + non-ASCII
    ];
    for (const name of names) {
      const r = await serveWithName(name);
      expect(r.threw, `threw for ${JSON.stringify(name)}`).toBeNull();
      expect(r.status, `status for ${JSON.stringify(name)}`).toBe(200);
    }
  });

  it('never emits a CR or LF, so the header cannot be split', () => {
    // A newline here would let a filename append headers of its own.
    const header = contentDispositionAttachment('evil\r\nX-Injected: 1\r\n\r\nbody');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('keeps the ASCII fallback strictly ASCII and safely quoted', () => {
    // The fallback is what old clients read; it must be legal on its own.
    const header = contentDispositionAttachment(PERSIAN);
    const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(fallback.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-control-regex
    expect(fallback).toMatch(/^[\x20-\x7e]*$/);
    expect(fallback).not.toContain('"');
    expect(fallback).not.toContain('\\');
  });

  it('falls back to a usable name when there is nothing left to keep', () => {
    // An empty or invisible-only name must not produce filename="".
    for (const name of ['', '   ', '\u200f\u200e']) {
      const header = contentDispositionAttachment(name);
      const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
      expect(fallback.trim().length, `fallback for ${JSON.stringify(name)}`)
        .toBeGreaterThan(0);
    }
  });

  it('is an attachment, so the browser saves instead of rendering it', () => {
    // Rendering remote HTML on our own origin would be an XSS gift.
    expect(contentDispositionAttachment(PERSIAN)).toMatch(/^attachment;/);
    expect(contentDispositionAttachment('page.html')).toMatch(/^attachment;/);
  });
});

describe('the routes that build this header', () => {
  it('both download and cookie-export use the helper, not their own template', async () => {
    // Deliberately source-level and narrow: the helper's behaviour is measured
    // above, but a route that goes back to interpolating the name would
    // reintroduce the user's 500 while every test above still passed.
    const src = await readFile('src/Routes/browser.routes.ts', 'utf8');
    const uses = (src.match(/contentDispositionAttachment\(/g) || []).length;
    expect(uses).toBeGreaterThanOrEqual(2);
    // No raw interpolation of a name into the header anywhere in this file.
    expect(src).not.toMatch(/filename="\$\{/);
  });
});
