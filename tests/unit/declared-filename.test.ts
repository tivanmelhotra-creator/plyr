/**
 * declared-filename.test.ts — the file arrives with the name the WEBSITE gave it.
 *
 * THE REQUIREMENT, VERBATIM
 * -------------------------
 *   «هر فایلی که از طریق Remote Browser دانلود/اکسپورت می‌شود، باید با نام واقعی
 *    و Extension واقعی که خود Website اعلام کرده روی Windows کاربر ذخیره شود.»
 *
 * and the failure it reacts to:
 *
 *   «بعضی فایل‌ها بدون Extension دانلود می‌شدند … بعضی وقت‌ها نام فایل اشتباه بود
 *    … یک مدت همه فایل‌ها با نام file ذخیره می‌شدند»
 *
 * WHY THE OLD CODE COULD NOT SATISFY IT
 * -------------------------------------
 * It named every download from `download.suggestedFilename()`. MEASURED
 * (tools/probe-dl-final.js) over 40 cases — 8 Content-Disposition shapes × 5 ways
 * a site can start a download:
 *
 *     download.suggestedFilename()       25/40 correct  (63%)
 *     the response's Content-Disposition  40/40 correct (100%)
 *
 * `suggestedFilename()` returns the literal string `download` for every RFC 5987
 * (`filename*=UTF-8''…`) name and every raw-UTF-8 name — 15 of the 40, with
 * `فاکتور.xlsx` among them. That is the reported "every file was named file": not
 * a locale bug, and not fixable anywhere downstream, because by the time the
 * download event arrives the real name has already been discarded.
 *
 * So the fix is to remember what the site DECLARED (DownloadHeaderIndex) and to
 * prefer it (preferDeclaredName). These tests cover that preference and the
 * generic format mapping underneath it — no hardcoded list of formats, which is
 * the other half of the requirement:
 *
 *   «این قابلیت باید به صورت Generic برای همه فرمت‌ها کار کند، نه اینکه برای PDF
 *    یک منطق جدا و برای ZIP یک منطق جدا نوشته شود.»
 */

import { describe, it, expect } from 'vitest';

import { DownloadHeaderIndex } from '../../src/core/DownloadHeaders';
import { preferDeclaredName } from '../../src/core/RealChromeShelf';
import {
  extensionFromContentType,
  filenameFromContentDisposition,
} from '../../src/core/RemoteDownloads';
import { safeFileName } from '../../src/core/RemoteUploads';

describe('remembering what the website declared', () => {
  it('keeps the filename from a Content-Disposition, per response url', () => {
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/export', {
      'content-disposition': 'attachment; filename="report_final.pdf"',
      'content-type': 'application/pdf',
    });
    expect(idx.lookup('https://site.test/export')).toEqual({
      name: 'report_final.pdf',
      contentType: 'application/pdf',
    });
  });

  it('reads the header whatever case the server sent it in', () => {
    // Node lowercases incoming headers, but this index is also fed by probes and
    // by callers that pass headers through verbatim. A case-sensitive lookup
    // would silently remember nothing, which looks exactly like the bug it
    // exists to fix.
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/a', {
      'Content-Disposition': 'attachment; filename="invoice_2026.xlsx"',
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(idx.lookup('https://site.test/a')?.name).toBe('invoice_2026.xlsx');
  });

  it('prefers the RFC 5987 copy, the ONLY one that carries the real name', () => {
    // These are the 15/40 that suggestedFilename() reports as 'download'. The
    // plain filename= copy is deliberately lossy: the server transliterates it.
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/f', {
      'content-disposition':
        'attachment; filename="________.xlsx"; ' +
        "filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx",
      'content-type': 'application/octet-stream',
    });
    expect(idx.lookup('https://site.test/f')?.name).toBe('فاکتور.xlsx');
  });

  it('does not remember ordinary pages, only files', () => {
    // EVERY response passes through this index. Remembering a page's HTML would
    // make the next download from that url inherit a name from a document.
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/page', { 'content-type': 'text/html' });
    expect(idx.lookup('https://site.test/page')).toBeNull();
    expect(idx.size()).toBe(0);
  });

  it('remembers an attachment even when it declared no filename at all', () => {
    // 'attachment' with no name is still a download, and its Content-Type is the
    // only evidence of the FORMAT that will ever exist for a bytes-only response
    // whose format has no magic number (an .xlsx as octet-stream, a .csv).
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/blob', {
      'content-disposition': 'attachment',
      'content-type': 'application/pdf',
    });
    expect(idx.lookup('https://site.test/blob')).toEqual({
      name: '',
      contentType: 'application/pdf',
    });
  });

  it('forgets a declaration once it has been used', () => {
    // An /export endpoint legitimately returns a DIFFERENT file every call. If
    // the first response's name were kept, the second download would inherit it —
    // which is the reported "sometimes the filename was wrong", exactly.
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/export', {
      'content-disposition': 'attachment; filename="january.csv"',
    });
    idx.forget('https://site.test/export');
    expect(idx.lookup('https://site.test/export')).toBeNull();
  });

  it('keeps the LATEST declaration when one url is served twice', () => {
    const idx = new DownloadHeaderIndex();
    idx.record('https://site.test/export', {
      'content-disposition': 'attachment; filename="january.csv"',
    });
    idx.record('https://site.test/export', {
      'content-disposition': 'attachment; filename="february.csv"',
    });
    expect(idx.lookup('https://site.test/export')?.name).toBe('february.csv');
  });

  it('does not grow without bound on a page that downloads in a loop', () => {
    const idx = new DownloadHeaderIndex();
    for (let i = 0; i < 500; i += 1) {
      idx.record('https://site.test/f' + i, {
        'content-disposition': 'attachment; filename="f' + i + '.bin"',
      });
    }
    expect(idx.size()).toBeLessThanOrEqual(200);
    // And it evicted the OLDEST, so the download that just happened — the one
    // anybody could actually be waiting for — is the one still remembered.
    expect(idx.lookup('https://site.test/f499')?.name).toBe('f499.bin');
    expect(idx.lookup('https://site.test/f0')).toBeNull();
  });

  it('survives a response it cannot make sense of', () => {
    // A closed or redirected response can throw on headers(). A watcher that
    // threw here would stop remembering names for the rest of the session.
    const idx = new DownloadHeaderIndex();
    expect(() => idx.record('', {})).not.toThrow();
    expect(idx.lookup('')).toBeNull();
  });
});

describe('the website name beats the browser guess', () => {
  it('uses the declared name when there is one', () => {
    expect(preferDeclaredName('report_final.pdf', 'download')).toBe('report_final.pdf');
  });

  it('keeps the declared name even when Chrome guessed a different one', () => {
    // 100% vs 63%: when the two disagree, the header is the one that is right.
    expect(preferDeclaredName('invoice_2026.xlsx', 'invoice.xls')).toBe('invoice_2026.xlsx');
  });

  it('falls back to Chrome when the site declared nothing', () => {
    expect(preferDeclaredName('', 'photo.jpg')).toBe('photo.jpg');
  });

  it('borrows only the SUFFIX when the site named the file but gave no extension', () => {
    // MEASURED: Chrome derives a suffix from the response type, so 'export' with
    // an application/rtf body became 'export.rtf'. Keeping the site's stem and
    // borrowing the suffix beats discarding either half.
    expect(preferDeclaredName('export', 'export.rtf')).toBe('export.rtf');
  });

  it('refuses to staple a suffix from an unrelated name onto the site name', () => {
    // 'quarterly' + 'somethingelse.pdf' must NOT become 'quarterly.pdf': the
    // names disagree, so Chrome was not talking about this file. The extension is
    // then decided from the BYTES instead (ensureUsableExtension), which is
    // evidence rather than a guess about a guess.
    expect(preferDeclaredName('quarterly', 'somethingelse.pdf')).toBe('quarterly');
  });

  it('never invents a name when neither side has one', () => {
    // The caller substitutes 'download' only as a last resort. The requirement is
    // that a real declared name is never REPLACED by a default like 'file', so
    // this function must not manufacture one either.
    expect(preferDeclaredName('', '')).toBe('');
  });

  it('keeps a non-ASCII declared name intact', () => {
    expect(preferDeclaredName('فاکتور.xlsx', 'download')).toBe('فاکتور.xlsx');
  });

  it('ignores the surrounding whitespace a header can carry', () => {
    expect(preferDeclaredName('  report.pdf  ', 'download')).toBe('report.pdf');
  });
});

describe('extensions are mapped generically, not from a list of favourites', () => {
  /**
   * The requirement is «به صورت Generic برای همه فرمت‌ها … نه اینکه برای PDF یک
   * منطق جدا و برای ZIP یک منطق جدا». So the test is not "does it know these
   * twelve types" but "does it know types nobody wrote down in this repo", which
   * it can only do by consulting the IANA database rather than a curated table.
   */
  it('maps types no one hardcoded, straight out of the IANA database', () => {
    const cases: Array<[string, string]> = [
      ['application/pdf', '.pdf'],
      ['application/zip', '.zip'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
      ['application/vnd.oasis.opendocument.presentation', '.odp'],
      ['application/vnd.amazon.ebook', '.azw'],
      ['application/x-7z-compressed', '.7z'],
      ['text/calendar', '.ics'],
      ['application/vnd.ms-cab-compressed', '.cab'],
      ['font/woff2', '.woff2'],
      ['application/epub+zip', '.epub'],
      // .tif and not .tiff, which is what the IANA database itself answers. This
      // row is here deliberately: it proves the mapping is the DATABASE's and not
      // a table someone typed out, because a hand-written table would have said
      // .tiff. Either suffix opens the file; the point is the provenance.
      ['image/tiff', '.tif'],
    ];
    for (const [type, ext] of cases) {
      expect(extensionFromContentType(type), type).toBe(ext);
    }
  });

  it('ignores parameters and case, as a real Content-Type carries both', () => {
    expect(extensionFromContentType('APPLICATION/PDF; charset=binary')).toBe('.pdf');
    expect(extensionFromContentType('text/CSV;charset=utf-8')).toBe('.csv');
  });

  it('gives NO extension for an opaque type rather than a wrong one', () => {
    // application/octet-stream means "bytes, unspecified". Mapping it to .bin
    // would put a WRONG extension on a file whose real one is usually knowable
    // from its declared name or its magic number — a regression dressed up as a
    // feature, and precisely the "downloaded without an extension / with the
    // wrong one" complaint.
    for (const opaque of [
      'application/octet-stream',
      'binary/octet-stream',
      'application/force-download',
      'application/x-download',
      'application/unknown',
      '*/*',
    ]) {
      expect(extensionFromContentType(opaque), opaque).toBe('');
    }
  });

  it('prefers the extension a human expects where IANA differs', () => {
    // The database's first answer for image/jpeg is .jpeg and for audio/mpeg is
    // .mpga. Both are technically correct and neither is what anyone expects to
    // find in their Downloads folder.
    expect(extensionFromContentType('image/jpeg')).toBe('.jpg');
    expect(extensionFromContentType('audio/mpeg')).toBe('.mp3');
  });

  it('returns nothing for junk instead of throwing', () => {
    for (const junk of ['', '   ', 'not-a-type', ';;;']) {
      expect(extensionFromContentType(junk), JSON.stringify(junk)).toBe('');
    }
  });
});

describe('parsing the declaration itself', () => {
  it('handles the shapes real servers actually send', () => {
    const cases: Array<[string, string]> = [
      ['attachment; filename="report_final.pdf"', 'report_final.pdf'],
      ['attachment; filename=report_final.pdf', 'report_final.pdf'],
      ["attachment; filename*=UTF-8''report%20final.pdf", 'report final.pdf'],
      // Both forms present: the starred one wins, because the plain one is lossy.
      [
        'attachment; filename="______.xlsx"; ' +
        "filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx",
        'فاکتور.xlsx',
      ],
      // Order reversed — a parser that takes the first match it finds gets this
      // one wrong, and real servers send both orders.
      [
        "attachment; filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx; " +
        'filename="______.xlsx"',
        'فاکتور.xlsx',
      ],
      ['inline; filename="preview.png"', 'preview.png'],
    ];
    for (const [header, want] of cases) {
      expect(filenameFromContentDisposition(header), header).toBe(want);
    }
  });

  it('reports the declared name verbatim, and leaves sanitising to the sanitiser', () => {
    // This function PARSES; it does not sanitise, and it must not, because the
    // two jobs have opposite requirements. Parsing has to preserve the name
    // exactly — that is the whole reason this code exists — while the filesystem
    // needs it defanged. Doing both here would mean the name shown to the
    // operator is the defanged one, and «نام واقعی» would be lost again.
    //
    // The boundary is real and it is one layer down: every caller passes the
    // result through safeFileName before it reaches a disk or the UI (see
    // RealChromeShelf.track). Verified here so the split is a tested contract
    // rather than an assumption.
    const raw = filenameFromContentDisposition('attachment; filename="../../../etc/passwd"');
    expect(raw).toBe('../../../etc/passwd');

    const safe = safeFileName(raw);
    expect(safe).toBe('passwd');
    expect(safe).not.toContain('..');
    expect(safe.indexOf('/')).toBe(-1);
  });

  it('keeps a real non-ASCII name through the sanitiser too', () => {
    // The sanitiser must defang a name without transliterating it: stripping
    // non-ASCII "to be safe" is how «فاکتور.xlsx» became _____.xlsx.
    const raw = filenameFromContentDisposition(
      "attachment; filename*=UTF-8''%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx",
    );
    expect(safeFileName(raw)).toBe('فاکتور.xlsx');
  });

  it('returns nothing when there is no declaration to read', () => {
    for (const header of ['', 'attachment', 'inline', 'form-data; name="field"']) {
      expect(filenameFromContentDisposition(header), JSON.stringify(header)).toBe('');
    }
  });
});
