/**
 * BrowserProfile.ts — how an INTERACTIVE server browser should be set up.
 *
 * Two different jobs use Chromium in this project and they want opposite
 * things:
 *
 *   • a workflow RUN wants a throwaway, anonymous context — no leftover state,
 *     a fresh fingerprint every time. `GlobalBrowser.getContext()` does that
 *     and stays as it is.
 *   • the Element Picker / Live Browser is a HUMAN sitting in front of a real
 *     page. It wants the opposite: the same identity every time, cookies that
 *     survive, and as few bot challenges as possible — otherwise you log in,
 *     the 5-minute idle timer fires, the context is destroyed, and the next
 *     open is a login wall again. That was HANDOFF 15 § 6.1 `AUTH-GAP`.
 *
 * This module is the second profile. Three concerns, deliberately separated:
 *
 *   1. PERSISTENCE  — Playwright `storageState` (cookies + localStorage) saved
 *      per user under PROFILES_DIR, so a login done inside the picker modal is
 *      still there tomorrow. This is option (b) of § 6.1 made real.
 *   2. FINGERPRINT  — a UA derived from the REAL browser build instead of a
 *      hardcoded list, plus a matching locale/timezone/platform set, because an
 *      inconsistent fingerprint is more suspicious than an honest one.
 *   3. CONSENT      — cookie/GDPR walls auto-dismissed, since on an interactive
 *      picker they are pure obstruction: they cover the element you are trying
 *      to pick.
 *
 * Anti-detection itself is NOT reimplemented here: the project already runs
 * `playwright-extra` + `puppeteer-extra-plugin-stealth` in GlobalBrowser, which
 * is the maintained package for this. What this file adds is the part stealth
 * cannot do — identity that persists, and a fingerprint that agrees with itself.
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { config } from '../config';

// ───────────────────────────────────────────────────────────────────────────
// 1. Launch flags
// ───────────────────────────────────────────────────────────────────────────

/**
 * The flag that matters most for not being flagged as a robot, and which was
 * missing from GlobalBrowser's arg list: without it Chromium advertises
 * `navigator.webdriver === true` and adds automation client hints. The stealth
 * plugin patches the JS getter afterwards, but the flag prevents the signal
 * from ever being emitted (including in HTTP client-hint headers, which JS
 * patching cannot reach).
 *
 * `--disable-extensions` is deliberately NOT included for interactive use: a
 * real Chrome profile has extensions, and the flag is itself detectable.
 */
export const ANTI_AUTOMATION_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-default-browser-check',
  '--disable-features=IsolateOrigins,site-per-process',
];

/**
 * Default Playwright switches that must be REMOVED, not merely countered.
 *
 * MEASURED (2026-08-11), reading Chrome's own `/proc/<pid>/cmdline` rather than
 * our source:
 *
 *   launched with args ['--exclude-switches=enable-automation']
 *     → cmdline CONTAINS --enable-automation      (the flag survived)
 *   launched with ignoreDefaultArgs ['--enable-automation']
 *     → cmdline does NOT contain --enable-automation
 *     → and --no-sandbox is still present, so nothing else was lost
 *
 * `--exclude-switches` is a ChromeDriver/webdriver *capability*, not a Chrome
 * command-line switch. Passing it as an argument does nothing at all: Chrome
 * does not recognise it, does not warn, and keeps --enable-automation. That is
 * why the yellow "Chrome is being controlled by automated test software" bar
 * kept appearing even though the code plainly intended to suppress it — the
 * intent was there, the effect never was.
 *
 * The bar is not merely ugly. It is the loudest possible automation signal, it
 * steals vertical space in the remote view, and --enable-automation also
 * disables the password manager and some extension UI, which is exactly what a
 * user reaching for the REAL Chrome wants working.
 *
 * `--disable-extensions` is removed for the opposite reason: Playwright adds it
 * by default, and keeping it would make --load-extension a silent no-op.
 */
export const IGNORED_DEFAULT_ARGS: readonly string[] = [
  '--disable-extensions',
  '--enable-automation',
];

/**
 * Give Chromium's process a UTF-8 locale, so a download keeps its own name.
 *
 * MEASURED (2026-08-10), and the cause of a reported bug: a user downloaded a
 * PNG through the live browser and received a file called `download`, with no
 * extension at all. The bytes were fine — only the name was destroyed.
 *
 * Chromium derives a download's filename with `base::FilePath`, which is a
 * BYTE string on POSIX, and converts the server's UTF-16 name into it using
 * the C library's locale encoding. When the process has no `LANG`/`LC_ALL`,
 * glibc reports the "C" locale, i.e. ANSI_X3.4-1968 (plain ASCII). Every
 * non-ASCII character then fails to convert, Chromium discards the whole name
 * as unusable, and falls back to its hardcoded default — the literal string
 * `download`, with no extension, because the extension went out with the name.
 *
 * The container this runs in ships exactly that: `locale -a` lists only
 * `C`, `C.utf8` and `POSIX`, and nothing exports `LANG`.
 *
 *   no LANG          →  "download"     ← the bug, reproduced
 *   LANG=C.UTF-8     →  "صفحه.png"     ← the name survives intact
 *   LANG=en_US.UTF-8 →  "download"     ← still broken: not generated in this image
 *
 * That last line is why the value is `C.UTF-8` and not a friendlier-looking
 * `en_US.UTF-8`. A locale that is not generated does not fall back to UTF-8;
 * glibc silently drops to "C" and the bug comes straight back. `C.UTF-8` is
 * built into glibc itself, so it is available everywhere without `locale-gen`.
 *
 * This is NOT the same setting as Playwright's `locale: 'en-US'` context
 * option, which only drives `Accept-Language` and JS `Intl`. That option was
 * already set while the bug was happening; it cannot reach the filesystem
 * encoding, because that is decided by the OS process environment.
 *
 * An operator who has deliberately exported a UTF-8 locale keeps it: theirs may
 * carry collation or currency rules that matter to them, and any UTF-8 locale
 * already fixes the encoding. Only a missing or non-UTF-8 locale is replaced.
 */
export function withUtf8Locale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  // LC_ALL outranks LANG, so if it is set and is not UTF-8 it would override
  // whatever LANG we choose — it has to be judged, and fixed, on its own.
  const isUtf8 = (v: string | undefined): boolean => /utf-?8/i.test(String(v || ''));
  if (out.LC_ALL && !isUtf8(out.LC_ALL)) delete out.LC_ALL;
  if (!isUtf8(out.LC_ALL) && !isUtf8(out.LANG)) out.LANG = 'C.UTF-8';
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Fingerprint
// ───────────────────────────────────────────────────────────────────────────

/**
 * Turn the browser's real version string into a plausible desktop UA.
 *
 * Why not a hardcoded list: GlobalBrowser rotates seven UAs pinned to Chrome
 * 119–121. Those are years stale, so the UA disagrees with every other signal
 * the page can read (JS features, client hints, TLS) — which is a stronger bot
 * tell than a plain honest UA. Deriving from `browser.version()` keeps the
 * major version truthful and only removes the word "Headless", which is the one
 * token that has no business being there.
 */
export function realisticUserAgent(browser: Browser | null, platform = 'Windows'): string {
  let version = '';
  try { version = browser ? browser.version() : ''; } catch { version = ''; }
  // browser.version() looks like "HeadlessChrome/141.0.7390.54" or "141.0.7390.54"
  const m = /(\d+\.\d+\.\d+\.\d+)/.exec(version || '');
  const full = m ? m[1] : '';
  if (!full) return '';                    // let Playwright use its own default
  const os = platform === 'macOS'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'Linux'
      ? 'X11; Linux x86_64'
      : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) `
    + `Chrome/${full} Safari/537.36`;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Persisted session state
// ───────────────────────────────────────────────────────────────────────────

/** Per-user storage-state file. Under PROFILES_DIR, which is already gitignored. */
export function sessionStatePath(userId: string): string {
  // A userId reaches us from a URL query, so it must never be able to walk out
  // of the directory. Anything outside [A-Za-z0-9_-] is folded away.
  const safe = String(userId || 'anon').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'anon';
  return path.join(config.PROFILES_DIR, 'sessions', `${safe}.json`);
}

/** True when this user has a saved browser session on disk. */
export async function hasSavedSession(userId: string): Promise<boolean> {
  try {
    const st = await fs.stat(sessionStatePath(userId));
    return st.isFile() && st.size > 2;
  } catch { return false; }
}

/**
 * Read the saved storageState, or `undefined` when there is none / it is
 * corrupt. Never throws: a bad file must degrade to "anonymous", not to a
 * picker that refuses to open.
 */
export async function loadStorageState(
  userId: string,
): Promise<BrowserContextOptions['storageState'] | undefined> {
  try {
    const raw = await fs.readFile(sessionStatePath(userId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!Array.isArray(parsed.cookies) && !Array.isArray(parsed.origins)) return undefined;
    return parsed as BrowserContextOptions['storageState'];
  } catch { return undefined; }
}

/**
 * Persist cookies + localStorage for this user. Called when an interactive
 * session ends, which is what makes a login done inside the picker outlive the
 * idle timeout.
 */
export async function saveStorageState(context: BrowserContext, userId: string): Promise<boolean> {
  try {
    const file = sessionStatePath(userId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const state = await context.storageState();
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // silently drops the user's session on the next open.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fs.rename(tmp, file);
    return true;
  } catch { return false; }
}

/** Forget this user's browser session ("sign out everywhere" for the picker). */
export async function clearStorageState(userId: string): Promise<boolean> {
  try { await fs.unlink(sessionStatePath(userId)); return true; }
  catch { return false; }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Context options
// ───────────────────────────────────────────────────────────────────────────

/**
 * Options for an interactive (picker / live browser) context.
 *
 * Everything here is chosen so the signals AGREE. A Windows UA with a
 * `Europe/London` timezone, `en-US` locale and a Linux platform is a mismatch a
 * CMP will notice; the point is not to look exotic but to look consistent.
 */
export async function interactiveContextOptions(
  userId: string,
  browser: Browser | null,
  opts: { viewport?: { width: number; height: number }; timezoneId?: string; locale?: string } = {},
): Promise<BrowserContextOptions> {
  const ua = realisticUserAgent(browser);
  const storageState = await loadStorageState(userId);
  return {
    // A stable viewport, not a random one: the picker maps canvas coordinates
    // onto page coordinates, so the size must be predictable.
    viewport: opts.viewport || { width: 1280, height: 720 },
    ...(ua ? { userAgent: ua } : {}),
    locale: opts.locale || 'en-US',
    timezoneId: opts.timezoneId || 'UTC',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    // The picker injects through `page.evaluate` (CDP), which is not subject to
    // the page's CSP, so there is no reason to weaken the site's own policy.
    bypassCSP: false,
    ...(storageState ? { storageState } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Cookie / consent walls
// ───────────────────────────────────────────────────────────────────────────

/**
 * Auto-dismiss consent dialogs.
 *
 * Why this is a NAMED-CMP allowlist and not "click anything that says Agree":
 * this script runs on a page the user is about to pick elements from. A greedy
 * text match would happily click "I agree" on a checkout form, or a "Continue"
 * that navigates away — destroying the page the user was working on. So it only
 * touches the accept control of consent platforms it can positively identify,
 * plus a narrow fallback that requires a cookie/consent-named ancestor.
 *
 * It also stops after a short window. A consent wall appears within the first
 * seconds; anything clicking minutes later is a liability, not a feature.
 */
export const CONSENT_SCRIPT = `(() => {
  if (window.__abConsentActive) return;
  window.__abConsentActive = true;

  // Accept buttons of the major consent platforms, by their own stable hooks.
  var SELECTORS = [
    '#onetrust-accept-btn-handler',                       // OneTrust
    '.onetrust-close-btn-handler',
    '#truste-consent-button',                             // TrustArc
    '.qc-cmp2-summary-buttons > button[mode="primary"]',  // Quantcast
    'button[mode="primary"].qc-cmp2-hide-desktop',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', // Cookiebot
    '#CybotCookiebotDialogBodyButtonAccept',
    '[data-testid="uc-accept-all-button"]',               // Usercentrics
    '#usercentrics-root >>> button',
    '#didomi-notice-agree-button',                        // Didomi
    '.didomi-continue-without-agreeing',
    '.osano-cm-accept-all',                               // Osano
    '.cky-btn-accept',                                    // CookieYes
    '#termly-code-snippet-support button.t-acceptAllButton', // Termly
    '.cmplz-accept',                                      // Complianz
    '._brlbs-btn-accept-all',                             // Borlabs
    '.fc-cta-consent',                                    // Google Funding Choices
    '#L2AGLb',                                            // Google's own "Accept all"
    'button#accept-choices',
    '[aria-label="Accept all"]',
    '[aria-label="Accept cookies"]'
  ];

  // Fallback: an accept-ish button that is INSIDE a container which names
  // itself cookie/consent/gdpr. Both halves must hold.
  var WORDS = /^(accept|accept all|accept cookies|allow all|agree|i agree|ok|got it|understood|allow|قبول|می.?پذیرم|پذیرفتن|تایید|موافقم)$/i;
  var CONTAINER = /(cookie|consent|gdpr|cmp|privacy)/i;

  function visible(el){
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }
  function named(el){
    for (var n = el, hops = 0; n && hops < 6; n = n.parentElement, hops++){
      var id = (n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '');
      if (CONTAINER.test(id)) return true;
    }
    return false;
  }
  var clicked = 0;
  function sweep(){
    if (clicked >= 3) return;              // a page has one consent wall, not ten
    for (var i = 0; i < SELECTORS.length; i++){
      var el = null;
      try { el = document.querySelector(SELECTORS[i]); } catch (e) { el = null; }
      if (el && visible(el)){ try { el.click(); clicked++; return; } catch (e) {} }
    }
    var btns = document.querySelectorAll('button, [role="button"], a.btn');
    for (var j = 0; j < btns.length && j < 400; j++){
      var b = btns[j];
      var txt = (b.textContent || '').trim();
      if (txt.length > 24) continue;
      if (!WORDS.test(txt)) continue;
      if (!named(b)) continue;
      if (!visible(b)) continue;
      try { b.click(); clicked++; return; } catch (e) {}
    }
  }
  // Consent walls are injected asynchronously, so poll briefly rather than
  // running once on DOMContentLoaded.
  var t0 = Date.now();
  var iv = setInterval(function(){
    if (Date.now() - t0 > 8000 || clicked >= 3){ clearInterval(iv); return; }
    try { sweep(); } catch (e) {}
  }, 400);
  try { sweep(); } catch (e) {}
})();`;

/**
 * Install the consent dismisser on every document of this page (main frame and
 * future navigations). `addInitScript` runs before the page's own scripts, so
 * the poller is already ticking when the CMP injects its wall.
 */
export async function installConsentAutoDismiss(page: Page): Promise<void> {
  try { await page.addInitScript(CONSENT_SCRIPT); } catch { /* non-fatal */ }
}
