/**
 * Owner brief 5.6 / 5.7 / 5.11 — the flag catalog and the ONE argv builder
 * (core/FlagCatalog): defaults, each flag, conflicts, merged --blink-settings,
 * ordering, dedupe, forbidden flags, typed values only, secrets never logged.
 */
import { describe, it, expect } from 'vitest';
import { FLAG_CATALOG, buildFlags, catalogView, isForbiddenSwitch } from '../../src/core/FlagCatalog';

const b = (flags: Record<string, unknown>) => buildFlags({ flags });

describe('catalog shape (5.6)', () => {
  it('has the 14 entries of the brief, unique ids, every one with label/description/flag/input', () => {
    expect(FLAG_CATALOG.map((d) => d.id)).toEqual(['window-size', 'start-maximized', 'window-position', 'load-images', 'autoplay-policy', 'mute-audio',
      'restore-last-session', 'device-scale', 'user-agent', 'lang', 'disable-gpu', 'disable-notifications', 'force-dark-mode', 'proxy-server']);
    for (const d of FLAG_CATALOG) {
      expect(d.label && d.description && d.flag && d.input, d.id).toBeTruthy();
    }
    expect(catalogView().find((x) => x.id === 'proxy-server')!.input).toMatchObject({ kind: 'text', hint: expect.stringContaining('host:port') });
  });
  it('none of the catalog flags is a forbidden switch', () => {
    for (const d of FLAG_CATALOG) expect(isForbiddenSwitch(d.flag), d.flag).toBe(false);
  });
});

describe('builder (5.11)', () => {
  it('default (nothing stored / Default ON) -> no args', () => {
    expect(buildFlags(undefined)).toMatchObject({ ok: true, args: [] });
    expect(buildFlags({ flags: {} })).toMatchObject({ ok: true, args: [] });
  });

  it('each flag becomes its argv', () => {
    const cases: Array<[string, unknown, string[]]> = [
      ['window-size', { w: 900, h: 600 }, ['--window-size=900,600']],
      ['start-maximized', true, ['--start-maximized']],
      ['window-position', { x: 10, y: -5 }, ['--window-position=10,-5']],
      ['load-images', false, ['--blink-settings=imagesEnabled=false']],
      ['load-images', true, []],
      ['autoplay-policy', 'no-user-gesture-required', ['--autoplay-policy=no-user-gesture-required']],
      ['mute-audio', true, ['--mute-audio']],
      ['restore-last-session', true, ['--restore-last-session']],
      ['device-scale', 1.25, ['--force-device-scale-factor=1.25']],
      ['user-agent', 'AuditUA/1.0', ['--user-agent=AuditUA/1.0']],
      ['lang', 'fa-IR', ['--lang=fa-IR']],
      ['disable-gpu', true, ['--disable-gpu']],
      ['disable-notifications', true, ['--disable-notifications']],
      ['force-dark-mode', true, ['--force-dark-mode']],
      ['proxy-server', 'socks5://10.0.0.2:1080', ['--proxy-server=socks5://10.0.0.2:1080']],
    ];
    for (const [id, v, args] of cases) {
      const r = b({ [id]: v });
      expect(r.errors, id).toEqual([]);
      expect(r.args, id).toEqual(args);
    }
  });

  it('a selected row without a value takes the catalog default', () => {
    expect(b({ 'window-size': undefined }).args).toEqual(['--window-size=1280,800']);
    expect(b({ lang: undefined }).args).toEqual(['--lang=en-US']);
    expect(b({ 'device-scale': undefined }).args).toEqual(['--force-device-scale-factor=1']);
  });

  it('conflicts: Window size + Start maximized -> refused', () => {
    const r = b({ 'window-size': { w: 900, h: 600 }, 'start-maximized': true });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/Window size|Start maximized/);
  });

  it('several --blink-settings contributions are merged into ONE switch (only load-images today)', () => {
    const r = b({ 'load-images': false, 'mute-audio': true });
    expect(r.args.filter((a) => a.startsWith('--blink-settings'))).toEqual(['--blink-settings=imagesEnabled=false']);
    expect(r.args.at(-1)).toBe('--blink-settings=imagesEnabled=false');
  });

  it('ordering is the catalog order, independent of input key order; no duplicates', () => {
    const a = b({ 'force-dark-mode': true, 'mute-audio': true, lang: 'de-DE' });
    const c = b({ lang: 'de-DE', 'mute-audio': true, 'force-dark-mode': true });
    expect(a.args).toEqual(['--mute-audio', '--lang=de-DE', '--force-dark-mode']);
    expect(c.args).toEqual(a.args);
    expect(new Set(a.args).size).toBe(a.args.length);
  });

  it('forbidden switches are refused even when sent directly (5.7)', () => {
    for (const id of ['user-data-dir', 'profile-directory', 'remote-debugging-port', 'headless', 'no-sandbox', 'disable-web-security',
      'ignore-certificate-errors', 'incognito', 'single-process', 'load-extension', 'disable-extensions', 'disable-extensions-except']) {
      const r = b({ [id]: true });
      expect(r.ok, id).toBe(false);
      expect(r.args, id).toEqual([]);
      expect(r.errors[0]!.message).toMatch(/controlled by the application/);
    }
  });

  it('typed values only: wrong types, ranges, steps, control characters, credentials in the proxy', () => {
    expect(b({ 'window-size': { w: 100, h: 600 } }).errors[0]!.message).toMatch(/Width: between 320 and 7680/);
    expect(b({ 'window-size': { w: 900.5, h: 600 } }).errors[0]!.message).toMatch(/whole number/);
    expect(b({ 'device-scale': 1.3 }).errors[0]!.message).toMatch(/steps of 0.25/);
    expect(b({ 'device-scale': 4 }).errors[0]!.message).toMatch(/Between 0.5 and 3/);
    expect(b({ 'autoplay-policy': 'always' }).errors[0]!.message).toMatch(/one of the options/);
    expect(b({ 'load-images': 'no' }).errors[0]!.message).toMatch(/On or Off/);
    expect(b({ 'mute-audio': 'yes' }).errors[0]!.message).toMatch(/no value/);
    expect(b({ 'user-agent': 'a\nb' }).errors[0]!.message).toMatch(/control characters/);
    expect(b({ 'user-agent': 'x'.repeat(301) }).errors[0]!.message).toMatch(/At most 300/);
    expect(b({ 'proxy-server': 'http://user:pw@proxy:8080' }).errors[0]!.message).toMatch(/User name and password/);
    expect(b({ 'proxy-server': 'not a proxy' }).errors[0]!.message).toMatch(/host:port/);
    expect(b({ 'proxy-server': 'ftp://p:21' }).ok).toBe(false);
    // A raw flag string is never accepted as an id.
    expect(b({ '--mute-audio': true }).args).toEqual([]);
  });

  it('a stored id no longer in the catalog is skipped and reported, never a crash (5.10)', () => {
    const r = b({ 'old-flag': true, 'mute-audio': true });
    expect(r.ok).toBe(true);
    expect(r.unsupported).toEqual(['old-flag']);
    expect(r.args).toEqual(['--mute-audio']);
  });

  it('the proxy value never reaches the log-safe argv', () => {
    const r = b({ 'proxy-server': 'secret-proxy.internal:3128', lang: 'fa-IR' });
    expect(r.args).toContain('--proxy-server=secret-proxy.internal:3128');
    expect(r.logSafe).toEqual(['--lang=fa-IR', '--proxy-server=(set)']);
    expect(r.logSafe.join(' ')).not.toContain('secret-proxy');
  });

  it('garbage input never throws', () => {
    for (const x of [null, 1, 'x', [], { flags: null }, { flags: 'x' }, { flags: { 'window-size': 'big' } }]) expect(() => buildFlags(x)).not.toThrow();
  });
});
