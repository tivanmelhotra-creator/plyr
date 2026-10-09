// @vitest-environment jsdom
/**
 * Task 4a — the "Add option" panel (public/js/browser-options-ui.js).
 * Pure helpers first, then the real DOM driven the way a user would.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JS = join(__dirname, '..', '..', 'public', 'js');
let UI: any; let BO: any;

beforeAll(() => {
  const w = window as any;
  new Function('window', readFileSync(join(JS, 'browser-options.js'), 'utf8')).call(w, w);
  new Function('window', readFileSync(join(JS, 'browser-options-ui.js'), 'utf8')).call(w, w);
  UI = w.BrowserOptionsUI; BO = w.BROWSER_OPTIONS;
});

const t = (k: string) => k;
function mount(value: unknown = '', actions: string[] = []) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById('host') as HTMLElement;
  const changes: string[] = [];
  const handle = UI.render(host, { value, t, lang: () => 'en', actions: () => actions, onChange: (x: string) => changes.push(x) });
  return { host, changes, handle };
}
const $ = (s: string) => document.querySelector(s) as HTMLElement;
function type(el: HTMLInputElement | HTMLTextAreaElement, v: string) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }

describe('pure helpers', () => {
  it('parse is forgiving, serialize drops empties', () => {
    expect(UI.parse('')).toEqual({}); expect(UI.parse('{oops')).toEqual({}); expect(UI.parse('[1]')).toEqual({});
    expect(UI.parse('{"a":1}')).toEqual({ a: 1 }); expect(UI.parse({ b: 2 })).toEqual({ b: 2 });
    expect(UI.serialize({})).toBe(''); expect(UI.serialize({ a: 1 })).toBe('{"a":1}');
  });
  it('search matches id, either language, help text; hides used options', () => {
    const ids = (q: string, used = {}) => UI.search(q, used).map((d: any) => d.id);
    expect(ids('proxy')).toEqual(expect.arrayContaining(['proxyServer', 'proxyUsername', 'proxyPassword', 'proxyBypass']));
    expect(ids('زبان')).toContain('locale');
    expect(ids('TIMEZONE')).toContain('timezoneId');
    expect(ids('پروکسی')).toContain('proxyServer');
    expect(ids('zzzznothing')).toEqual([]);
    expect(ids('proxy', { proxyServer: 'x' })).not.toContain('proxyServer');
    expect(ids('')).toHaveLength(BO.OPTIONS.length);
  });
  it('search folds Arabic yeh/kaf to Persian', () => {
    expect(UI.norm('كيك')).toBe(UI.norm('کیک'));
  });
  it('every default value passes the catalog check', () => {
    for (const d of BO.OPTIONS) expect(BO.check(d, UI.defaultFor(d)), d.id).toBeNull();
  });
  it('lines / headers text round trip', () => {
    expect(UI.textToLines(' --a \r\n\n--b')).toEqual(['--a', '--b']);
    expect(UI.linesToText(['--a', '--b'])).toBe('--a\n--b');
    expect(UI.textToHeaders(UI.headersToText({ A: 'b' }))).toEqual({ A: 'b' });
    expect(() => UI.textToHeaders('{nope')).toThrow();
  });
});

describe('panel', () => {
  it('starts empty with a hint, and adds nothing to the workflow', () => {
    const { changes } = mount('');
    expect($('[data-bo-row]')).toBeNull();
    expect($('.bo-empty')).not.toBeNull();
    expect(changes).toEqual([]);
  });

  it('search -> pick adds the option with a valid default and reports it', () => {
    const { changes } = mount('');
    $('#bo-add').click();
    const search = $('#bo-search') as HTMLInputElement;
    type(search, 'viewport');
    const picks = [...document.querySelectorAll('[data-bo-pick]')].map((e) => e.getAttribute('data-bo-pick'));
    // isMobile matches too: its help text mentions the mobile viewport
    expect(picks).toEqual(['viewportWidth', 'viewportHeight', 'isMobile']);
    ($('[data-bo-pick="viewportWidth"]') as HTMLElement).click();
    expect($('[data-bo-row="viewportWidth"]')).not.toBeNull();
    expect(JSON.parse(changes[changes.length - 1])).toEqual({ viewportWidth: 900 });
    // an added option no longer appears in the picker
    $('#bo-add').click();
    expect($('[data-bo-pick="viewportWidth"]')).toBeNull();
  });

  it('shows "no match" for an empty search', () => {
    mount(''); $('#bo-add').click(); type($('#bo-search') as HTMLInputElement, 'qqqqq');
    expect($('.bo-nomatch')).not.toBeNull();
  });

  it('editing a number commits valid values and flags invalid ones without committing', () => {
    const { changes } = mount('{"viewportWidth":900}');
    const inp = $('[data-bo-input="viewportWidth"]') as HTMLInputElement;
    type(inp, '1024');
    expect(JSON.parse(changes[changes.length - 1])).toEqual({ viewportWidth: 1024 });
    const n = changes.length;
    type(inp, '50');
    expect(changes.length).toBe(n);                       // not committed
    expect($('[data-bo-err="viewportWidth"]').textContent).toBe('bo.err.range');
    expect(inp.classList.contains('bo-invalid')).toBe(true);
    type(inp, '800');
    expect($('[data-bo-err="viewportWidth"]').hidden).toBe(true);
  });

  it('remove drops the option and re-serialises to empty', () => {
    const { changes } = mount('{"locale":"fa-IR"}');
    ($('[data-bo-remove="locale"]') as HTMLElement).click();
    expect($('[data-bo-row="locale"]')).toBeNull();
    expect(changes[changes.length - 1]).toBe('');
  });

  it('boolean, enum, set, lines, headers controls all commit', () => {
    const { changes } = mount('{"headless":false,"colorScheme":"dark","permissions":["notifications"],"chromeArgs":["--mute-audio"],"extraHTTPHeaders":{"A":"b"}}');
    const last = () => JSON.parse(changes[changes.length - 1]);
    const cb = $('[data-bo-input="headless"]') as HTMLInputElement; cb.checked = true; cb.dispatchEvent(new Event('change'));
    expect(last().headless).toBe(true);
    const sel = $('[data-bo-input="colorScheme"]') as HTMLSelectElement; sel.value = 'light'; sel.dispatchEvent(new Event('change'));
    expect(last().colorScheme).toBe('light');
    const perm = $('[data-bo-input="permissions"] input[value="camera"]') as HTMLInputElement; perm.checked = true; perm.dispatchEvent(new Event('change'));
    expect(last().permissions).toEqual(['camera', 'notifications'].sort((a, b) => BO.PERMISSIONS.indexOf(a) - BO.PERMISSIONS.indexOf(b)));
    type($('[data-bo-input="chromeArgs"]') as HTMLTextAreaElement, '--mute-audio\n--hide-scrollbars');
    expect(last().chromeArgs).toEqual(['--mute-audio', '--hide-scrollbars']);
    type($('[data-bo-input="chromeArgs"]') as HTMLTextAreaElement, '--remote-debugging-port=1');
    expect($('[data-bo-err="chromeArgs"]').textContent).toBe('bo.err.denied');
    expect(last().chromeArgs).toEqual(['--mute-audio', '--hide-scrollbars']);
    type($('[data-bo-input="extraHTTPHeaders"]') as HTMLTextAreaElement, '{"X-K":"v"}');
    expect(last().extraHTTPHeaders).toEqual({ 'X-K': 'v' });
    type($('[data-bo-input="extraHTTPHeaders"]') as HTMLTextAreaElement, '{bad');
    expect($('[data-bo-err="extraHTTPHeaders"]').textContent).toBe('bo.err.json');
  });

  it('secret options render as password inputs', () => {
    mount('{"proxyServer":"http://p:1","proxyPassword":"x"}');
    expect(($('[data-bo-input="proxyPassword"]') as HTMLInputElement).type).toBe('password');
  });

  it('launch-scope options carry the "needs a fresh launch" badge, context ones do not', () => {
    mount('{"proxyServer":"http://p:1","locale":"fa-IR"}');
    expect($('[data-bo-row="proxyServer"] .bo-badge')).not.toBeNull();
    expect($('[data-bo-row="locale"] .bo-badge')).toBeNull();
  });

  it('incompatibility warnings appear live and know the workflow actions', () => {
    const { host } = mount('{"headless":true,"proxyUsername":"u"}', ['open-extension']);
    const codes = [...host.querySelectorAll('[data-bo-diag]')].map((e) => e.getAttribute('data-bo-diag'));
    expect(codes).toEqual(expect.arrayContaining(['needs-proxy', 'headless-ext']));
    // fixing the cause removes the warning
    ($('[data-bo-remove="proxyUsername"]') as HTMLElement).click();
    const after = [...document.querySelectorAll('[data-bo-diag]')].map((e) => e.getAttribute('data-bo-diag'));
    expect(after).not.toContain('needs-proxy');
  });

  it('an option the catalog no longer knows is shown with a remove button, not hidden', () => {
    const { changes } = mount('{"ghost":1,"locale":"fa-IR"}');
    expect($('.bo-row-unknown')).not.toBeNull();
    ($('.bo-row-unknown button') as HTMLElement).click();
    expect(JSON.parse(changes[changes.length - 1])).toEqual({ locale: 'fa-IR' });
  });

  it('uses only CSP-safe DOM (no inline handlers / scripts)', () => {
    const { host } = mount('{"locale":"fa-IR","headless":false}');
    $('#bo-add').click();
    expect(host.innerHTML).not.toMatch(/\son[a-z]+=/i);
    expect(host.querySelector('script')).toBeNull();
  });
});

describe('i18n parity for the panel', () => {
  it('every bo.* key the code uses is defined in the (English-only) dictionary', () => {
    const src = readFileSync(join(JS, 'i18n.js'), 'utf8');
    const enStart = src.indexOf('    en: {');
    expect(enStart).toBeGreaterThan(-1);
    const en = src.slice(enStart);
    const keys = (s: string) => new Set([...s.matchAll(/'(bo\.[A-Za-z.]+)':/g)].map((m) => m[1]));
    const kf = keys(en);
    expect(kf.size).toBeGreaterThan(10);
    const used = new Set<string>();
    const ui = readFileSync(join(JS, 'browser-options-ui.js'), 'utf8');
    for (const m of ui.matchAll(/t\('(bo\.[A-Za-z.]+)'\)/g)) used.add(m[1]);
    for (const m of ui.matchAll(/'(bo\.err\.)' \+/g)) void m;
    for (const c of ['type', 'range', 'length', 'format', 'enum', 'duplicate', 'denied', 'unknown', 'json']) used.add('bo.err.' + c);
    used.add('bo.title');
    for (const k of used) expect(kf.has(k), k).toBe(true);
  });
});
