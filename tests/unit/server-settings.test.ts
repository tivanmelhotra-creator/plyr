/**
 * server-settings.test.ts — the Settings page store, catalog and launch rules.
 *
 * The operator's request: every value a launch needs should be a CHOICE asked
 * at startup, changeable later in the panel, with no .env editing — and in
 * development the panel should not ask for a login at all, while a server must
 * get a real token the project generates itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  rewriteKey, saveSetting, readSettingsFile, loadPersistedSettings, PERSISTABLE_KEYS,
  resetLiveSettingsForTests, liveRaw, settingsFilePath,
} from '../../src/core/PersistedSettings';
import {
  CATALOG, validateValue, specOf, generateSecret, catalogMatchesPersistable, type ValidateCtx,
} from '../../src/core/SettingsCatalog';
import { isLoopbackAddress } from '../../src/middleware/auth';

const dev: ValidateCtx = { profile: 'development', allowDefaultToken: false, openAllowed: true, singleUser: true };
const server: ValidateCtx = { profile: 'server', allowDefaultToken: false, openAllowed: false, singleUser: true };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-settings-')); resetLiveSettingsForTests(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); resetLiveSettingsForTests(); });

describe('catalog', () => {
  it('lists exactly the keys the boot overlay is allowed to apply', () => {
    expect(catalogMatchesPersistable()).toBe(true);
  });

  it('offers named options (Persian and English) for every choice', () => {
    for (const s of CATALOG) {
      expect(s.fa && s.en && s.hintFa && s.hintEn).toBeTruthy();
      if (s.type === 'choice' || s.type === 'bool') {
        expect(s.options!.length).toBeGreaterThan(1);
        for (const o of s.options!) expect(o.fa && o.en).toBeTruthy();
        expect(s.options!.some((o) => o.value === s.dflt)).toBe(true);
      }
    }
  });

  it('never exposes a variable that would be a takeover primitive', () => {
    for (const k of ['NODE_OPTIONS', 'PATH', 'REDIS_URL', 'ADMIN_SECRET', 'SQLITE_PATH', 'ALLOW_OPEN_AUTH', 'ALLOW_DEFAULT_API_TOKEN']) {
      expect(PERSISTABLE_KEYS).not.toContain(k);
    }
  });

  it('generates 48-hex-char secrets that pass its own token rule', () => {
    const a = generateSecret(); const b = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
    expect(validateValue(specOf('API_TOKEN')!, a, server)).toEqual({ value: a });
  });
});

describe('validation', () => {
  const v = (key: string, value: unknown, ctx = dev) => validateValue(specOf(key)!, value, ctx);

  it('accepts only listed options', () => {
    expect(v('STEP_TIMEOUT_MS', '60000')).toEqual({ value: '60000' });
    expect(v('STEP_TIMEOUT_MS', '123')).toHaveProperty('error');
    expect(v('CODE_NODE_ENABLED', false)).toEqual({ value: 'false' });
  });

  it('refuses "no login" unless the profile in force allows it', () => {
    expect(v('AUTH_MODE', 'open', dev)).toEqual({ value: 'open' });
    expect(v('AUTH_MODE', 'open', server)).toHaveProperty('errorFa');
    expect(v('AUTH_MODE', 'open', { ...dev, singleUser: false })).toHaveProperty('error');
  });

  it('refuses admin123 and short tokens on a server, allows admin123 in development', () => {
    expect(v('API_TOKEN', 'admin123', server)).toHaveProperty('error');
    expect(v('API_TOKEN', 'admin123', dev)).toEqual({ value: 'admin123' });
    expect(v('API_TOKEN', 'short', dev)).toHaveProperty('error');
    expect(v('API_TOKEN', 'has space in it 1234567', dev)).toHaveProperty('error');
    expect(v('API_TOKEN', null, server)).toHaveProperty('error');
  });

  it('normalises a bare domain to https and rejects paths', () => {
    expect(v('PUBLIC_DOMAIN', 'panel.example.com')).toEqual({ value: 'https://panel.example.com' });
    expect(v('PUBLIC_DOMAIN', 'http://10.0.0.5:3000/')).toEqual({ value: 'http://10.0.0.5:3000' });
    expect(v('PUBLIC_DOMAIN', 'https://x.com/path')).toHaveProperty('error');
    expect(v('PUBLIC_DOMAIN', '')).toEqual({ value: '' });
  });

  it('refuses line breaks and "#" (they would corrupt an env file)', () => {
    expect(v('WEBHOOK_SECRET', 'abcdefghijklmnop\nNODE_OPTIONS=x')).toHaveProperty('error');
    expect(v('WEBHOOK_SECRET', 'abcdefghijklmnop#x')).toHaveProperty('error');
  });
});

describe('settings file', () => {
  it('rewrites one key as one line, keeping the rest', () => {
    const body = '# c\nA=1\nB=2\nA=3\n';
    expect(rewriteKey(body, 'A', '9')).toBe('# c\nB=2\nA=9\n');
    expect(rewriteKey(body, 'A', null)).toBe('# c\nB=2\n');
    expect(rewriteKey('X=1\r\n', 'Y', '2')).toBe('X=1\r\nY=2\r\n');
  });

  it('saves to disk with 0600 and is in force in memory immediately', () => {
    const file = path.join(dir, 'settings.env');
    const r = saveSetting('STEP_TIMEOUT_MS', '60000', { file });
    expect(r.persisted).toBe(true);
    expect(readSettingsFile(file)).toEqual({ STEP_TIMEOUT_MS: '60000' });
    expect(liveRaw('STEP_TIMEOUT_MS')).toBe('60000');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('stays in force when the disk refuses the write', () => {
    // A path whose parent is a regular FILE: mkdir fails at once (ENOTDIR).
    // (Not /proc: Node's recursive mkdir there never returns.)
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const r = saveSetting('STEP_TIMEOUT_MS', '30000', { file: path.join(blocker, 'sub', 'settings.env') });
    expect(r.persisted).toBe(false);
    expect(liveRaw('STEP_TIMEOUT_MS')).toBe('30000');
  });

  it('refuses keys that are not in the catalog', () => {
    expect(() => saveSetting('NODE_OPTIONS', '--inspect')).toThrow();
  });

  it('applies only allowed keys at boot', () => {
    const file = path.join(dir, 'settings.env');
    fs.writeFileSync(file, 'API_TOKEN=fromfile_abcdefghijk\nNODE_OPTIONS=--inspect\n');
    const env: NodeJS.ProcessEnv = { SETTINGS_FILE: file, API_TOKEN: 'fromenv' };
    const applied = loadPersistedSettings(PERSISTABLE_KEYS, env);
    expect(applied).toEqual(['API_TOKEN']);
    expect(env.API_TOKEN).toBe('fromfile_abcdefghijk');
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('lives next to the SQLite database, so Docker volumes keep it', () => {
    expect(settingsFilePath({ SQLITE_PATH: '/app/data/plyr.db' } as NodeJS.ProcessEnv)).toBe('/app/data/settings.env');
  });
});

describe('open login is loopback-only', () => {
  it('recognises loopback peers, including IPv4-mapped IPv6', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.5']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['10.0.0.2', '::ffff:192.168.1.4', '', undefined]) expect(isLoopbackAddress(a as string)).toBe(false);
  });
});

describe('config getters follow a panel save without a restart', () => {
  async function loadConfig(env: Record<string, string>) {
    vi.resetModules();
    const keys = ['APP_ENV', 'NODE_ENV', 'AUTH_MODE', 'API_TOKEN', 'DEPLOYMENT_MODE', 'ALLOW_OPEN_AUTH', 'SETTINGS_FILE'];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
    try {
      const config = (await import('../../src/config')).config;
      const store = await import('../../src/core/PersistedSettings');
      return { config, store };
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }

  it('rotates the API token in place, and a reset returns to the .env value', async () => {
    const { config, store } = await loadConfig({ DEPLOYMENT_MODE: 'single', API_TOKEN: 'boot_token_abcdefghij', APP_ENV: 'development' });
    expect(config.API_TOKEN).toBe('boot_token_abcdefghij');
    store.saveSetting('API_TOKEN', 'rotated_token_abcdefgh', { file: path.join(dir, 's.env') });
    expect(config.API_TOKEN).toBe('rotated_token_abcdefgh');
    expect(config.API_TOKEN_IS_DEFAULT).toBe(false);
    store.saveSetting('API_TOKEN', null, { file: path.join(dir, 's.env') });
    expect(config.API_TOKEN).toBe('boot_token_abcdefghij');
  });

  it('honours AUTH_MODE=open only in development', async () => {
    let { config } = await loadConfig({ DEPLOYMENT_MODE: 'single', APP_ENV: 'development', AUTH_MODE: 'open' });
    expect(config.AUTH_OPEN).toBe(true);
    ({ config } = await loadConfig({ DEPLOYMENT_MODE: 'single', APP_ENV: 'server', AUTH_MODE: 'open', API_TOKEN: 'x'.repeat(20) }));
    expect(config.AUTH_MODE_REQUESTED).toBe('open');
    expect(config.AUTH_OPEN).toBe(false);
    ({ config } = await loadConfig({ DEPLOYMENT_MODE: 'single', APP_ENV: 'server', AUTH_MODE: 'open', ALLOW_OPEN_AUTH: 'true' }));
    expect(config.AUTH_OPEN).toBe(true);
    ({ config } = await loadConfig({ DEPLOYMENT_MODE: 'multi', APP_ENV: 'development', AUTH_MODE: 'open' }));
    expect(config.AUTH_OPEN).toBe(false);
  });

  it('changes Code node and step timeout live', async () => {
    const { config, store } = await loadConfig({ DEPLOYMENT_MODE: 'single', APP_ENV: 'development' });
    expect(config.CODE_NODE_ENABLED).toBe(true);
    store.saveSetting('CODE_NODE_ENABLED', 'false', { file: path.join(dir, 's.env') });
    expect(config.CODE_NODE_ENABLED).toBe(false);
    store.saveSetting('STEP_TIMEOUT_MS', '60000', { file: path.join(dir, 's.env') });
    expect(config.STEP_TIMEOUT_MS).toBe(60000);
  });
});
