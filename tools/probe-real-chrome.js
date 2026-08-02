/**
 * probe-real-chrome.js — end-to-end proof that the real Chrome path works.
 *
 * This is the check that matters for the whole feature, and it cannot be a unit
 * test: the question "does Chrome actually LOAD the extension" is only
 * answerable by starting Chrome and asking it.
 *
 * It:
 *   1. writes a tiny throwaway extension into the extensions dir,
 *   2. starts the real Chrome through RealChrome (persistent profile + Xvfb),
 *   3. proves the extension is loaded by opening its own chrome-extension:// page
 *      — the very trick the UI uses to show a cookie extension's popup inside
 *      the picker canvas,
 *   4. proves the DevTools port is reachable,
 *   5. imports a Cookie-Editor style export and reads the cookie back from a
 *      real page, which is the user's actual "skip the login" workflow,
 *   6. cleans up the throwaway extension.
 *
 *   REAL_CHROME_ENABLED=true DISPLAY=:99 node tools/probe-real-chrome.js
 */
'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

process.env.REAL_CHROME_ENABLED = process.env.REAL_CHROME_ENABLED || 'true';
process.env.REAL_CHROME_DEBUG_PORT = process.env.REAL_CHROME_DEBUG_PORT || '9333';
process.env.REAL_CHROME_USER_DATA_DIR =
  process.env.REAL_CHROME_USER_DATA_DIR || path.join(os.tmpdir(), 'probe-chrome-profile');
process.env.REAL_CHROME_EXTENSIONS_DIR =
  process.env.REAL_CHROME_EXTENSIONS_DIR || path.join(os.tmpdir(), 'probe-chrome-extensions');

const { RealChrome, unpackedExtensionId } = require('../dist/core/RealChrome');
const { listExtensions } = require('../dist/core/ChromeExtensions');
const { config } = require('../dist/config');

const EXT_NAME = 'probe-cookie-tool';

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function writeTestExtension(dir) {
  const extDir = path.join(dir, EXT_NAME);
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(path.join(extDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Probe Cookie Tool',
    version: '1.0.0',
    description: 'Throwaway extension used by probe-real-chrome.js.',
    // `cookies` + host permissions are exactly what a real cookie
    // export/import extension asks for, so this also proves the permission
    // prompt path does not block a side-loaded extension.
    permissions: ['cookies', 'storage'],
    host_permissions: ['<all_urls>'],
    action: { default_popup: 'popup.html' },
  }, null, 2));
  await fs.writeFile(path.join(extDir, 'popup.html'),
    '<!doctype html><meta charset="utf-8"><title>Probe</title>' +
    '<body><h1 id="hdr">probe-extension-popup</h1>' +
    '<pre id="out">…</pre><script src="popup.js"></script></body>');
  await fs.writeFile(path.join(extDir, 'popup.js'),
    // Calling chrome.cookies proves the page really has extension privileges,
    // which is the whole reason a popup-as-a-tab is useful.
    'chrome.cookies.getAll({}, (c) => {' +
    '  document.getElementById("out").textContent = "cookies:" + c.length;' +
    '});');
  return extDir;
}

async function main() {
  console.log('\n── real Chrome probe ──────────────────────────────────────────\n');

  const extDir = await writeTestExtension(config.REAL_CHROME_EXTENSIONS_DIR);
  const found = await listExtensions(config.REAL_CHROME_EXTENSIONS_DIR);
  check('extension discovered on disk', found.some((e) => e.id === EXT_NAME),
    found.map((e) => e.id).join(', ') || 'none');

  let ctx;
  try {
    ctx = await RealChrome.getContext();
  } catch (e) {
    check('Chrome launched', false, e.message);
    process.exit(1);
  }
  check('Chrome launched (persistent profile)', true, config.REAL_CHROME_USER_DATA_DIR);

  const loaded = RealChrome.loadedExtensions();
  const probe = loaded.find((e) => e.id === EXT_NAME);
  check('extension passed to --load-extension', !!probe,
    loaded.map((e) => `${e.name}@${e.version}`).join(', ') || 'none');

  // ── the popup-as-a-tab trick ──────────────────────────────────────────────
  const page = await RealChrome.newPage();
  if (probe) {
    const expectedId = unpackedExtensionId(extDir);
    check('extension id is derivable without asking Chrome',
      probe.url === `chrome-extension://${expectedId}/`, probe.url);

    try {
      await page.goto(probe.popupUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const hdr = await page.textContent('#hdr').catch(() => '');
      check('extension popup renders as a normal tab', hdr === 'probe-extension-popup',
        JSON.stringify(hdr));

      // If chrome.cookies answered, the page has real extension privileges.
      await page.waitForFunction(
        () => document.getElementById('out')?.textContent?.startsWith('cookies:'),
        { timeout: 10000 },
      ).catch(() => {});
      const out = await page.textContent('#out').catch(() => '');
      check('popup can call the chrome.cookies API', /^cookies:\d+$/.test(String(out).trim()),
        String(out).trim());
    } catch (e) {
      check('extension popup renders as a normal tab', false, e.message);
    }
  }

  // ── DevTools port ─────────────────────────────────────────────────────────
  const status = await RealChrome.status();
  check('DevTools port answers', !!status.browserVersion,
    `${status.debugUrl} → ${status.browserVersion || 'no response'}`);

  // ── cookie import ─────────────────────────────────────────────────────────
  const exportFile = JSON.stringify([
    {
      name: 'probe_session',
      value: 'imported-not-logged-in',
      domain: '.example.com',
      hostOnly: false,
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      // Cookie-Editor writes fractional seconds; the parser must floor it.
      expirationDate: Math.floor(Date.now() / 1000) + 86400 + 0.37,
      storeId: '0',
    },
    // A deliberately broken row: the import must survive it, not abort.
    { value: 'no-name-here', domain: '.example.com' },
  ]);

  try {
    const { result, applied, rejected } = await RealChrome.importCookies(exportFile);
    check('cookie export parsed', result.cookies.length === 1 && result.skipped === 1,
      `parsed=${result.cookies.length} skipped=${result.skipped} format=${result.format}`);
    check('cookies applied to the live browser', applied === 1,
      `applied=${applied} rejected=${rejected.length}`);

    await page.goto('http://example.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const seen = await page.evaluate(() => document.cookie);
    check('the page really sends the imported cookie',
      String(seen).includes('probe_session=imported-not-logged-in'),
      JSON.stringify(seen).slice(0, 120));
  } catch (e) {
    check('cookie import', false, e.message);
  }

  // ── the profile is persistent ─────────────────────────────────────────────
  const cookies = await ctx.cookies();
  check('cookie is in the persistent profile',
    cookies.some((c) => c.name === 'probe_session'), `${cookies.length} cookie(s) in profile`);

  await RealChrome.stop();
  await fs.rm(extDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? '\x1b[32mall checks passed\x1b[0m' : `\x1b[31m${failures} check(s) failed\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
