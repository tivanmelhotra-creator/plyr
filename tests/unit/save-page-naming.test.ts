/**
 * save-page-naming.test.ts — "Save page as…" must produce a file the user can
 * recognise and open, not `file` with no extension.
 *
 * THE REPORT (Ask #13, issue A)
 * -----------------------------
 * «خاستم با راست کلیک و ذخیره صفحه همون وب سایت بببنم فرمت های مثل html روهم
 * ساپورت میکنه دیدم که نام فایل همون فایل بود … و حتی پسوند هم نداشت …
 * من توقع دارم چیزی که دانلود میشه با همون اسم پسوند ریموتشم دانلود شه»
 *
 * i.e. saving a page produced a file literally called `file`, with no suffix,
 * and the expectation is that a download keeps the remote name AND format.
 *
 * THE MEASUREMENT
 * ---------------
 * Two independent causes, both reproduced before anything was changed.
 *
 * Cause A — the NAME. The old expression was
 *   `safeFileName(suggested || path.basename(url.pathname)) || 'download'`
 * and for a site's front page every term collapses:
 *
 *     path.basename(new URL('https://example.com/').pathname)  ===  ''
 *     safeFileName('')                                         ===  'file'
 *
 * `'file'` is TRUTHY, so `|| 'download'` never ran. The placeholder that
 * `safeFileName` invents for an empty string had become the user's filename.
 *
 * Cause B — the EXTENSION. `ensureUsableExtension` had three sources and none
 * could answer for a web page: the name has no suffix, the URL path has no
 * suffix (`/`), and HTML has no magic number so it is deliberately absent from
 * `MAGIC` ("a wrong extension is worse than a missing one"). Measured against
 * the real servers, the answer was in the response all along:
 *
 *     https://example.com/            -> 200  content-type: "text/html"
 *     https://news.ycombinator.com/   -> 200  content-type: "text/html; charset=utf-8"
 *
 * A server-side fetch HAS the response, so unlike a Playwright `Download` the
 * Content-Type is reachable here. That is the fourth source.
 *
 * A THIRD CAUSE, FOUND BY THIS FILE
 * ---------------------------------
 * The first draft of the fix named a front page `example.com` — and that was
 * still broken, for a reason only a behaviour test could catch. MEASURED:
 *
 *     extensionOf('example.com')          === '.com'
 *     extensionOf('news.ycombinator.com') === '.com'
 *
 * A TLD is indistinguishable from a file extension, so `ensureUsableExtension`
 * returned early believing the file was already named, and `.html` was never
 * appended. The user would have received a file with no usable format for the
 * second time, by a different route. Hence `example_com.html`. §2 pins it.
 *
 * WHAT THESE TESTS CHECK
 * ----------------------
 * Behaviour, never the presence of a string in the source: every case calls the
 * real exported function and asserts on the value it returns, or writes real
 * bytes into a real temporary directory and asserts on the filename that ends
 * up on disk.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import {
  nameFromUrl,
  extensionFromContentType,
  ensureUsableExtension,
} from '../../src/core/RemoteDownloads';
import { safeFileName, extensionOf } from '../../src/core/RemoteUploads';

const tmpDirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-page-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('§1 the bug, reproduced', () => {
  it('safeFileName still turns an empty name into the truthy placeholder "file"', () => {
    // Not a regression to fix — safeFileName is right to always return
    // SOMETHING. The bug was believing that something was a name.
    expect(safeFileName('')).toBe('file');
    expect(Boolean(safeFileName(''))).toBe(true);
  });

  it('a front page really does have an empty path basename', () => {
    expect(path.basename(new URL('https://example.com/').pathname)).toBe('');
    expect(path.basename(new URL('https://news.ycombinator.com/').pathname)).toBe('');
  });

  it('the OLD expression produced the reported name; the new one does not', () => {
    const url = new URL('https://example.com/');
    const old = safeFileName('' || path.basename(url.pathname)) || 'download';
    expect(old).toBe('file');                      // exactly what the user saw

    expect(nameFromUrl(url)).not.toBe('file');     // and what they get now
  });
});

describe('§2 a hostname is not a filename', () => {
  it('a TLD is indistinguishable from an extension — the trap this fell into', () => {
    // The measurement that forced the underscore. If this ever stops being
    // true the underscore can go, and this test says so out loud.
    expect(extensionOf('example.com')).toBe('.com');
    expect(extensionOf('news.ycombinator.com')).toBe('.com');
  });

  it('so a host-derived name carries no dots', () => {
    expect(nameFromUrl('https://example.com/')).toBe('example_com');
    expect(nameFromUrl('https://news.ycombinator.com/')).toBe('news_ycombinator_com');
    expect(extensionOf(nameFromUrl('https://example.com/'))).toBe('');
  });

  it('and can therefore still receive its real extension', async () => {
    // The end-to-end consequence, which is the only reason the rule exists.
    const dir = await scratch();
    const file = path.join(dir, nameFromUrl('https://example.com/'));
    await fs.writeFile(file, '<!doctype html><title>Example Domain</title>');

    const final = await ensureUsableExtension(file, 'https://example.com/', 'text/html');
    expect(final).toBe('example_com.html');
    await expect(fs.stat(path.join(dir, 'example_com.html'))).resolves.toBeTruthy();
  });

  it('drops a www. prefix, the way a browser names a save', () => {
    expect(nameFromUrl('https://www.example.com/')).toBe('example_com');
  });
});

describe('§3 nameFromUrl: a name the user recognises', () => {
  it('prefers the last real path segment over the host', () => {
    expect(nameFromUrl('https://en.wikipedia.org/wiki/Web_browser')).toBe('Web_browser');
    expect(nameFromUrl('https://cdn.example.com/a/b/photo.png')).toBe('photo.png');
  });

  it('a trailing slash is not a name — the segment before it is', () => {
    expect(nameFromUrl('https://example.com/docs/')).toBe('docs');
  });

  it('an explicit suggestion wins over everything', () => {
    // How "Save page as" passes the page title.
    expect(nameFromUrl('https://example.com/', 'Example Domain')).toBe('Example Domain');
    expect(nameFromUrl('https://en.wikipedia.org/wiki/Web_browser', 'Web browser - Wikipedia'))
      .toBe('Web browser - Wikipedia');
  });

  it('a dangerous suggestion is sanitised, not obeyed', () => {
    // The suggestion is a remote page's <title>: hostile input.
    const name = nameFromUrl('https://example.com/', '../../etc/passwd');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
  });

  it('an unusable suggestion falls through instead of becoming "file"', () => {
    expect(nameFromUrl('https://example.com/', '///')).toBe('example_com');
    expect(nameFromUrl('https://example.com/', '   ')).toBe('example_com');
  });

  it('honours a site that genuinely named its file "file"', () => {
    // The placeholder and a real name that happens to match must not be
    // confused in the other direction either.
    expect(nameFromUrl('https://example.com/file')).toBe('file');
  });

  it('only invents "download" when there is no URL to read at all', () => {
    expect(nameFromUrl('not a url')).toBe('download');
    expect(nameFromUrl('')).toBe('download');
  });

  it('accepts a URL object and a string identically', () => {
    expect(nameFromUrl(new URL('https://example.com/docs/')))
      .toBe(nameFromUrl('https://example.com/docs/'));
  });
});

describe('§4 extensionFromContentType: the format the server declared', () => {
  it('maps the type this bug is about', () => {
    expect(extensionFromContentType('text/html')).toBe('.html');
  });

  it('ignores parameters, which every real server sends', () => {
    // Measured: news.ycombinator.com answers `text/html; charset=utf-8`.
    expect(extensionFromContentType('text/html; charset=utf-8')).toBe('.html');
    expect(extensionFromContentType('TEXT/HTML;charset=UTF-8')).toBe('.html');
  });

  it('answers for the other common types', () => {
    expect(extensionFromContentType('application/pdf')).toBe('.pdf');
    expect(extensionFromContentType('application/json')).toBe('.json');
    expect(extensionFromContentType('image/svg+xml')).toBe('.svg');
    expect(extensionFromContentType('text/csv')).toBe('.csv');
  });

  it('says nothing when it does not know, rather than guessing', () => {
    // The same contract as MAGIC: a wrong suffix is worse than none.
    expect(extensionFromContentType('application/octet-stream')).toBe('');
    expect(extensionFromContentType('application/x-nonsense')).toBe('');
    expect(extensionFromContentType('')).toBe('');
  });
});

describe('§5 end to end: the bytes on disk get the right name', () => {
  it('a page save named from the page title keeps that title', async () => {
    const dir = await scratch();
    const file = path.join(dir, nameFromUrl('https://example.com/', 'Example Domain'));
    await fs.writeFile(file, '<!doctype html>');

    const final = await ensureUsableExtension(file, 'https://example.com/', 'text/html');
    expect(final).toBe('Example Domain.html');
  });

  it('the bytes still beat a lying Content-Type', async () => {
    // A misconfigured server serving a PNG as text/html is common. The magic
    // number is the truth, and it is consulted first.
    const dir = await scratch();
    const file = path.join(dir, 'thing');
    await fs.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));

    const final = await ensureUsableExtension(file, 'https://cdn.example.com/thing', 'text/html');
    expect(final).toBe('thing.png');
  });

  it('the URL suffix still wins over the header', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'report');
    await fs.writeFile(file, 'id,name\n1,a\n');

    const final = await ensureUsableExtension(file, 'https://x.test/report.csv', 'text/html');
    expect(final).toBe('report.csv');
  });

  it('a name that already has an extension is never touched', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'photo.png');
    await fs.writeFile(file, 'not really a png');

    const final = await ensureUsableExtension(file, 'https://x.test/photo.png', 'text/html');
    expect(final).toBe('photo.png');
  });

  it('an unknown Content-Type leaves the name alone rather than guessing', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'blob');
    await fs.writeFile(file, 'mystery bytes');

    const final = await ensureUsableExtension(
      file, 'https://x.test/blob', 'application/octet-stream',
    );
    expect(final).toBe('blob');
  });

  it('omitting the Content-Type keeps the previous behaviour exactly', async () => {
    // The parameter is optional, so every existing caller is unaffected.
    const dir = await scratch();
    const file = path.join(dir, 'page');
    await fs.writeFile(file, '<!doctype html>');

    const final = await ensureUsableExtension(file, 'https://example.com/');
    expect(final).toBe('page');
  });
});
