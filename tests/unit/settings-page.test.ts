/**
 * Settings page (public/js/settings-ui.js): the tab architecture, the mapping
 * of every server setting to exactly one tab, and the single-user cleanup
 * (no Admin / Quota / language leftovers anywhere in the client).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';
import { CATALOG } from '../../src/core/SettingsCatalog';

const PUBLIC = join(__dirname, '..', '..', 'public');
const read = (p: string) => readFileSync(join(PUBLIC, p), 'utf8');
const SRC = read('js/settings-ui.js');
const VIEWS = read('js/views.js');
const APP = read('js/app.js');
const API = read('js/api.js');
const HTML = read('index.html');
const I18N = read('js/i18n.js');
const CSS = read('css/styles.css');

function loadSettingsUI(): any {
  const sandbox: any = { window: {}, document: {}, location: { hash: '' }, history: {} };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.window.SettingsUI;
}

describe('tab architecture', () => {
  const UI = loadSettingsUI();
  const ids = UI.TABS.map((t: any) => t.id);

  it('has the settings categories in order (Administration removed: single-user)', () => {
    expect(ids).toEqual(['general', 'server', 'access', 'security', 'browser', 'runs', 'storage']);
    expect(ids).not.toContain('admin');
  });

  it('every tab label and every new string resolves in the dictionary', () => {
    const keys = new Set<string>();
    for (const m of SRC.matchAll(/t\('((?:set|settings|nav|common)\.[\w.]+)'\)/g)) keys.add(m[1]);
    for (const t of UI.TABS) keys.add(t.label);
    for (const id of ['access', 'security', 'browser', 'runs', 'storage']) keys.add(`set.sec.${id}`);
    const missing = [...keys].filter((k) => !I18N.includes(`'${k}':`));
    expect(missing).toEqual([]);
  });

  it('maps every server setting to exactly one tab, in the right place', () => {
    const where: Record<string, string> = {};
    for (const s of CATALOG) where[s.key] = UI.tabOf({ key: s.key, group: s.group });
    expect(where).toEqual({
      APP_ENV: 'server', PUBLIC_DOMAIN: 'server',
      AUTH_MODE: 'access', API_TOKEN: 'access',
      WEBHOOK_SECRET: 'security', LIVE_SHARE_TTL_SEC: 'security', CODE_NODE_ENABLED: 'security',
      REAL_CHROME_ENABLED: 'browser', DEFAULT_HEADLESS: 'browser',
      STEP_TIMEOUT_MS: 'runs', MAX_CONCURRENT: 'runs',
      DOWNLOAD_TTL_MINUTES: 'storage', EXECUTION_RETENTION_DAYS: 'storage',
    });
  });

  it('a setting added later can never vanish: unmapped groups fall back to a tab', () => {
    expect(ids).toContain(UI.tabOf({ key: 'SOMETHING_NEW', group: 'unknown' }));
  });

  it('is a real ARIA tablist with one panel per tab; panels are hidden, not destroyed', () => {
    expect(SRC).toContain('role="tablist"');
    expect(SRC).toContain('aria-orientation="vertical"');
    expect(SRC).toMatch(/role="tab"[\s\S]*aria-selected/);
    expect(SRC).toContain('role="tabpanel"');
    expect(SRC).toMatch(/p\.hidden = p\.id !== 'set-panel-' \+ id/);
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) expect(SRC).toContain(`'${k}'`);
  });

  it('keeps the tab in the URL without re-rendering the route (replaceState)', () => {
    expect(SRC).toContain('history.replaceState');
    expect(SRC).toMatch(/\[\?&\]tab=/);
  });

  it('keeps unsaved text across a repaint (a save in one tab must not wipe another)', () => {
    expect(SRC).toMatch(/var drafts = captureDrafts\(root\);[\s\S]*restoreDrafts\(root, drafts\)/);
  });

  it('the public address is a choice first (Automatic / Custom domain)', () => {
    expect(SRC).toContain("s.key === 'PUBLIC_DOMAIN' ? addressControl(s)");
    expect(SRC).toContain('data-mode="auto"');
    expect(SRC).toContain('data-mode="custom"');
  });

  it('General shows only real /health facts, never a guessed value', () => {
    expect(SRC).toContain("document.addEventListener('health:change', onHealth)");
    expect(SRC).toMatch(/var na = '—';/);
  });

  it('styles the layout and collapses to a horizontal strip on small screens', () => {
    for (const c of ['.set-layout', '.set-nav', '.set-nav-item.is-active', '.set-panel', '.set-section', '.set-row', '.set-choice']) {
      expect(CSS, c).toContain(c);
    }
    expect(CSS).toMatch(/@media \(max-width: 900px\) \{\s*\.set-layout \{ grid-template-columns: 1fr;/);
  });

  it('views.js delegates the route to SettingsUI (no second settings implementation)', () => {
    expect(VIEWS).toContain('if (window.SettingsUI) { window.SettingsUI.render(root); return; }');
    expect(VIEWS).not.toContain('server-settings');
  });
});

describe('single-user cleanup: no multi-user leftovers in the client', () => {
  it('no Admin view, admin token or admin API helpers', () => {
    for (const s of ['renderAdmin', 'getAdminToken', 'setAdminToken', 'adminStats', 'validateAdminToken', 'x-admin-token']) {
      expect(VIEWS + API, s).not.toContain(s);
    }
    expect(HTML).not.toContain('data-route="admin"');
    expect(I18N).not.toMatch(/'admin\.\w+':/);
    expect(I18N).not.toContain("'nav.admin'");
  });

  it('no Quota view (single mode is always unlimited)', () => {
    expect(VIEWS).not.toContain('renderQuota');
    expect(API).not.toContain('getQuota');
    expect(I18N).not.toMatch(/'quota\.\w+':/);
  });

  it('no no-op language switch (the app is English-only)', () => {
    expect(VIEWS).not.toContain("act: 'lang'");
    expect(I18N).not.toContain("'settings.language'");
  });

  it('old #/admin and #/quota bookmarks land on Settings', () => {
    expect(APP).toMatch(/quota: 'settings', admin: 'settings'/);
  });
});

describe('server: /admin is not exposed in single-user mode', () => {
  const INDEX = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');
  it('mounts the Admin API only for the multi-tenant product', () => {
    expect(INDEX).toContain("if (!config.IS_SINGLE_USER) app.use('/admin', routes.admin);");
    expect(INDEX).not.toMatch(/^app\.use\('\/admin', routes\.admin\);/m);
  });
});
