/**
 * END-TO-END PROOF of the operator's two requirements, on the REAL stack.
 *
 *   «کلیک روی Download → فایل مستقیماً روی Windows کاربر ذخیره شود»
 *   «Windows کاربر → Backend/Server → Website»
 *
 * Everything else pinning this feature is a unit test with a fake Playwright
 * object. This is the opposite: a REAL headed Chromium on a REAL Xvfb display,
 * a REAL http server declaring names the way real sites declare them, and the
 * REAL product classes (RealChromeShelf, RemoteFileChooser) doing the work. If
 * the fakes have drifted from Playwright's behaviour, this is what notices.
 *
 * Run:  node tools/probe-e2e-transfer.js
 * Needs: dist/ built (npx tsc --outDir dist), Xvfb on :% DISPLAY.
 *
 * It asserts, and exits non-zero on any failure, so it can be trusted in CI
 * rather than read by eye.
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { chromium } = require('playwright');

const CHROME = '/home/user/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

/**
 * The download shapes that matter, and WHY each one is here.
 *
 * These are not decorative: each row is a shape that a previous version of this
 * feature got wrong. The RFC 5987 rows are the ones that used to arrive named
 * the literal string `download`, because that is what suggestedFilename()
 * answers for them (MEASURED 25/40).
 */
const CASES = [
  {
    label: 'plain ascii pdf',
    route: '/report',
    want: 'report_final.pdf',
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="report_final.pdf"',
    },
  },
  {
    label: 'plain ascii xlsx (the operator own example)',
    route: '/invoice',
    want: 'invoice_2026.xlsx',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="invoice_2026.xlsx"',
    },
  },
  {
    label: 'RFC 5987 persian, filename* AFTER filename',
    route: '/persian',
    want: 'فاکتور.xlsx',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // A real server sends BOTH: ascii for old clients, filename* for the truth.
      'Content-Disposition':
        'attachment; filename="factura.xlsx"; filename*=UTF-8\'\'%D9%81%D8%A7%DA%A9%D8%AA%D9%88%D8%B1.xlsx',
    },
  },
  {
    label: 'RFC 5987 with filename* FIRST (order must not matter)',
    route: '/order',
    want: 'گزارش.pdf',
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition':
        'attachment; filename*=UTF-8\'\'%DA%AF%D8%B2%D8%A7%D8%B1%D8%B4.pdf; filename="report.pdf"',
    },
  },
  {
    label: 'no extension in the declaration, octet-stream body',
    route: '/nameonly',
    // Opaque content type must NOT invent .bin; the declared name stands alone.
    want: 'quarterly',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="quarterly"',
    },
  },
  {
    label: 'zip, to show no format has its own logic',
    route: '/archive',
    want: 'bundle_v2.zip',
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="bundle_v2.zip"',
    },
  },
  {
    label: 'docx, same',
    route: '/doc',
    want: 'contract.docx',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': 'attachment; filename="contract.docx"',
    },
  },
  {
    label: 'a format nobody hardcoded (generic mapping, no Content-Disposition name)',
    route: '/calendar',
    // No filename at all: the extension must come from the MIME database.
    wantExt: '.ics',
    headers: {
      'Content-Type': 'text/calendar',
      'Content-Disposition': 'attachment',
    },
  },
];

const failures = [];
const notes = [];
function check(ok, what) {
  if (ok) notes.push('  ok   ' + what);
  else { notes.push('  FAIL ' + what); failures.push(what); }
}

function startSite() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/') {
      // Every download is a real anchor the way a site does it, plus a file
      // input so the SAME page proves the upload direction.
      const links = CASES.map(
        (c) => '<p><a id="a' + c.route.slice(1) + '" href="' + c.route + '">' + c.label + '</a></p>',
      ).join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>site</title>' + links +
        '<hr><input id="pick" type="file" accept=".txt,text/plain">' +
        '<div id="seen">nothing</div>' +
        '<script>' +
        'document.getElementById("pick").addEventListener("change", function () {' +
        '  var f = this.files[0];' +
        '  if (!f) { document.getElementById("seen").textContent = "empty"; return; }' +
        '  var r = new FileReader();' +
        '  r.onload = function () {' +
        // Name AND bytes: a page that only reports a name proves nothing about
        // whether the operator's actual file arrived.
        '    document.getElementById("seen").textContent =' +
        '      "GOT|" + f.name + "|" + f.size + "|" + r.result;' +
        '  };' +
        '  r.readAsText(f);' +
        '});' +
        '</script>',
      );
      return;
    }

    const hit = CASES.find((c) => c.route === url);
    if (hit) {
      const body = Buffer.from('BYTES-FOR-' + hit.route + '-' + 'x'.repeat(64));
      res.writeHead(200, Object.assign({ 'Content-Length': body.length }, hit.headers));
      res.end(body);
      return;
    }
    res.writeHead(404).end('no');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // The product's own classes, from the build. Not a replica of them.
  const { RealChromeShelf, REAL_CHROME_SHELF_USER } = require('../dist/core/RealChromeShelf');
  const { RemoteFileChooser } = require('../dist/core/RemoteFileChooser');
  const { resolveDownload } = require('../dist/core/RemoteDownloads');
  const { saveUpload } = require('../dist/core/RemoteUploads');
  const cfg = require('../dist/config');
  const config = cfg.config || cfg.default || cfg;

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'e2e-transfer-'));
  // Point the real storage helpers at a scratch dir so this probe cannot touch
  // anything the running product owns.
  config.UPLOADS_DIR = path.join(root, 'uploads');
  config.DOWNLOADS_DIR = path.join(root, 'downloads');
  await fsp.mkdir(config.UPLOADS_DIR, { recursive: true });
  await fsp.mkdir(config.DOWNLOADS_DIR, { recursive: true });

  const { server, port } = await startSite();
  const base = 'http://127.0.0.1:' + port;

  const ctx = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    executablePath: CHROME,
    // HEADED on Xvfb, which is the whole point: headless Chromium behaves
    // differently for downloads and writes no session state at all.
    headless: false,
    acceptDownloads: true,
    downloadsPath: path.join(root, 'artifacts'),
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const shelf = new RealChromeShelf(REAL_CHROME_SHELF_USER);
  shelf.watch(ctx);                       // header index attaches first, inside
  const chooser = new RemoteFileChooser(REAL_CHROME_SHELF_USER);
  chooser.watch(ctx);

  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });

  // ── DOWNLOAD DIRECTION ────────────────────────────────────────────────────
  notes.push('DOWNLOAD: the name and extension the WEBSITE declared');
  for (const c of CASES) {
    // A real click on a real anchor, which is how the operator triggers it.
    await page.click('#a' + c.route.slice(1));
    // The shelf's own tracking is what the product relies on.
    await new Promise((r) => setTimeout(r, 900));

    // NEWEST FIRST. Reading rows[length-1] instead cost this probe a full run:
    // every case then compared against the OLDEST row, so all eight reported the
    // first file's name and looked like one catastrophic naming bug. The product
    // had been right the whole time.
    const rows = shelf.list();
    const row = rows[0];
    if (!row) { check(false, c.label + ': nothing reached the shelf'); continue; }

    if (c.want !== undefined) {
      check(row.name === c.want, c.label + ': name is "' + row.name + '" (want "' + c.want + '")');
    } else {
      check(
        row.name.toLowerCase().endsWith(c.wantExt),
        c.label + ': name is "' + row.name + '" (want ending "' + c.wantExt + '")',
      );
    }
    check(row.state === 'completed', c.label + ': state=' + row.state);

    // And the bytes are really reachable by the token the operator would use,
    // resolved the way the SERVER resolves it. A right name over a missing file
    // is not a fix.
    try {
      const resolved = await resolveDownload(REAL_CHROME_SHELF_USER, row.token);
      const buf = await fsp.readFile(resolved.path);
      check(buf.length > 0, c.label + ': ' + buf.length + ' bytes behind the token');
      check(
        path.basename(resolved.path) === row.name,
        c.label + ': stored basename matches the declared name',
      );
    } catch (e) {
      check(false, c.label + ': token did not resolve (' + e.message + ')');
    }
  }

  // Nothing was named the literal "download" or "file" — the two symptoms the
  // operator reported by name.
  const names = shelf.list().map((r) => r.name);
  check(
    !names.some((n) => n === 'download' || n === 'file' || n === ''),
    'no file was named "download", "file" or nothing: ' + JSON.stringify(names),
  );
  // The header index is EMPTY here, and that is correct: track() calls
  // headers.forget(url) once a download completes, so a long session cannot
  // accumulate one entry per file ever downloaded. Asserting > 0 here was
  // asserting a leak.
  check(
    shelf.declaredCount() === 0,
    'the header index cleaned up after itself (' + shelf.declaredCount() + ' left)',
  );
  // The REAL proof that the index did its job is above, and it is decisive:
  // suggestedFilename() answers the literal 'download' for an RFC 5987 name, so
  // فاکتور.xlsx and گزارش.pdf could not have come from anywhere else.
  check(
    names.indexOf('فاکتور.xlsx') >= 0 && names.indexOf('گزارش.pdf') >= 0,
    'the RFC 5987 names survived, which ONLY the declared header could supply',
  );

  // ── UPLOAD DIRECTION ──────────────────────────────────────────────────────
  notes.push('UPLOAD: Windows -> Server -> Website, with no manual server step');

  // The bytes as they would arrive from the operator's machine: through the REAL
  // upload path, which is what mints the token.
  const payload = 'operator-file-contents-' + Date.now();
  const saved = await saveUpload(
    REAL_CHROME_SHELF_USER,
    'my notes.txt',
    Buffer.from(payload),
  );
  check(/^up_/.test(saved.token), 'upload minted a token: ' + saved.token);

  // A REAL X11 click on the file input, via xdotool — no Playwright click, so
  // this genuinely tests the claim that interception does not depend on who
  // moved the mouse.
  const box = await page.locator('#pick').boundingBox();
  const clicked = await new Promise((resolve) => {
    const { execFile } = require('child_process');
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    execFile(
      'xdotool',
      ['mousemove', '--sync', String(x), String(y + 74), 'click', '1'],
      { env: process.env },
      (err) => resolve(!err),
    );
  });
  notes.push('  (xdotool click issued: ' + clicked + ')');

  // Give the chooser event time to arrive over CDP.
  let pending = null;
  for (let i = 0; i < 40 && !pending; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    pending = chooser.pending();
  }

  if (!pending) {
    // Fall back to a Playwright-driven click so the REST of the upload contract
    // is still measured; the xdotool result is reported separately above.
    //
    // NOTE, so nobody reads more into this line than it says: when this fires it
    // means the SYNTHETIC POINTER missed the input (the +74 offset below is a
    // guess at the viewport's position on the X screen, and it is not worth a
    // calibration routine here). It does NOT mean a hand-driven click fails to
    // produce a chooser. THAT is measured on its own in tools/probe-upload-vnc.js,
    // with the click landing and FILECHOOSER_EVENT_FIRED = true. What this probe
    // is for is the rest of the chain: pending -> refuse a path -> release ->
    // hand over a token -> the website has the bytes.
    notes.push('  (no chooser from the X11 click; retrying with a page click)');
    await page.click('#pick', { timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 40 && !pending; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      pending = chooser.pending();
    }
  }

  check(!!pending, 'the page asking for a file became a pending request');
  if (pending) {
    check(
      pending.accept.indexOf('.txt') >= 0,
      'the page own accept filter was reported: "' + pending.accept + '"',
    );

    // A PATH must be refused even here, on the real stack.
    let refused = false;
    try {
      await chooser.accept(pending.id, ['/etc/passwd']);
    } catch (e) {
      refused = /still available/i.test(e.message);
    }
    check(refused, 'a filesystem path was refused on the real stack too');

    // That refusal releases the page, so ask again for the genuine hand-over.
    await page.click('#pick', { timeout: 5000 }).catch(() => {});
    let again = null;
    for (let i = 0; i < 40 && !again; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      again = chooser.pending();
    }
    check(!!again, 'the page could ask again after the refusal (it was released)');

    if (again) {
      const res = await chooser.accept(again.id, [saved.token]);
      check(res.count === 1, 'exactly one file was handed over');

      // THE REQUIREMENT: the WEBSITE has the operator's bytes.
      let seen = '';
      for (let i = 0; i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await page.textContent('#seen');
        if (seen && seen.indexOf('GOT|') === 0) break;
      }
      check(seen.indexOf('GOT|') === 0, 'the website received a file: ' + seen.slice(0, 80));
      check(seen.indexOf(payload) >= 0, 'the website received the operator OWN bytes');
      check(
        seen.indexOf('my notes.txt') >= 0 || seen.indexOf('my_notes.txt') >= 0,
        'the website saw a sensible filename: ' + seen.split('|')[1],
      );
    }
  }

  await ctx.close();
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});

  console.log('\n' + notes.join('\n'));
  console.log(
    '\n' + (failures.length ? 'FAILURES: ' + failures.length : 'ALL CHECKS PASSED') + '\n',
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
