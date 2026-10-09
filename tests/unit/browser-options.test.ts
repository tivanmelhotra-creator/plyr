/**
 * Task 4a — the per-run browser option catalog.
 *
 * One source of truth (public/js/browser-options.js), read by the editor panel,
 * the server whitelist and these tests. The "every option" blocks iterate the
 * catalog, so an option added without a sample / bad value / Playwright mapping
 * fails here instead of shipping as a control that changes nothing (rule R3).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  browserOptionDefs, browserOptionsSchema, parseBrowserOptions, planFor, diagnoseBrowserOptions,
  effectiveHeadless, findLaunchOptions, optionsOfStep, allActions, describeOptions,
  browserOptionsLoadError,
} from '../../src/core/BrowserOptions';
import { validateSteps } from '../../src/validation';
import { config } from '../../src/config';

const PUBLIC_JS = join(__dirname, '..', '..', 'public', 'js');
function load(files: string[]): any {
  const sandbox: any = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(readFileSync(join(PUBLIC_JS, f), 'utf8'), sandbox, { filename: f });
  return sandbox.window;
}
const win = load(['browser-options.js']);
const BO = win.BROWSER_OPTIONS;
const defs = browserOptionDefs();

describe('catalog shape', () => {
  it('loads on the server from the very same file', () => {
    expect(browserOptionsLoadError()).toBe('');
    expect(defs.map((d) => d.id)).toEqual(BO.OPTIONS.map((d: any) => d.id));
  });

  it('has 20-40 options with unique ids and a known group', () => {
    expect(defs.length).toBeGreaterThanOrEqual(20);
    expect(defs.length).toBeLessThanOrEqual(40);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    const groups = BO.GROUPS.map((g: any) => g.id);
    for (const d of defs) expect(groups, d.id).toContain(d.group);
  });

  it('covers the options named in the brief', () => {
    const ids = defs.map((d) => d.id);
    for (const want of ['headless', 'viewportWidth', 'viewportHeight', 'userAgent', 'locale', 'timezoneId',
      'geolocationLat', 'geolocationLon', 'permissions', 'colorScheme', 'proxyServer', 'ignoreHTTPSErrors',
      'extraHTTPHeaders', 'javaScriptEnabled', 'slowMo', 'chromeArgs']) expect(ids).toContain(want);
  });

  it('every option has fa+en label and help, a sample and a bad value', () => {
    for (const d of defs) {
      for (const k of ['label', 'help'] as const) {
        expect(d[k].fa?.length, `${d.id}.${k}.fa`).toBeGreaterThan(2);
        expect(d[k].en?.length, `${d.id}.${k}.en`).toBeGreaterThan(2);
      }
      expect(d.sample, `${d.id}.sample`).not.toBeUndefined();
      expect(d.bad, `${d.id}.bad`).not.toBeUndefined();
    }
  });
});

describe('one test per option: accepts its sample, refuses its bad value', () => {
  for (const d of defs) {
    it(`${d.id}`, () => {
      expect(BO.check(d, d.sample), 'sample').toBeNull();
      expect(BO.check(d, d.bad), 'bad').not.toBeNull();
      // the Zod whitelist (server) agrees with the shared checker (browser)
      expect(parseBrowserOptions({ [d.id]: d.sample }).ok, 'zod sample').toBe(true);
      expect(parseBrowserOptions({ [d.id]: d.bad }).ok, 'zod bad').toBe(false);
      // and the wrong JSON type is refused too
      expect(parseBrowserOptions({ [d.id]: { nope: 1 } }).ok || d.kind === 'headers').toBe(d.kind === 'headers');
    });
  }
});

describe('every option maps to a Playwright key (R3: no control that changes nothing)', () => {
  // options that need a partner to take effect
  const PARTNER: Record<string, Record<string, unknown>> = {
    geolocationLon: { geolocationLat: 10 }, geolocationLat: { geolocationLon: 20 },
    geolocationAccuracy: { geolocationLat: 10, geolocationLon: 20 },
    proxyUsername: { proxyServer: 'http://127.0.0.1:8080' }, proxyPassword: { proxyServer: 'http://127.0.0.1:8080', proxyUsername: 'u' },
    proxyBypass: { proxyServer: 'http://127.0.0.1:8080' },
    httpUsername: { httpPassword: 'p' }, httpPassword: { httpUsername: 'u' },
  };
  for (const d of defs) {
    it(`${d.id} ends up in the plan`, () => {
      const opts = { ...(PARTNER[d.id] || {}), [d.id]: d.sample };
      const plan = planFor(opts, 'vip');
      const flat = JSON.stringify({ l: plan.launch, c: plan.context });
      expect(plan.hash, 'non-empty hash').not.toBe('');
      expect(plan.ignored.filter((i) => i.id === d.id), 'not ignored').toEqual([]);
      // the sample value's content is really carried into the plan
      const probe = d.kind === 'set' || d.kind === 'lines' ? (d.sample as string[])[0]
        : d.kind === 'headers' ? Object.keys(d.sample as object)[0] : String(d.sample);
      if (d.id === 'headless') expect(plan.launch.headless).toBe(false);
      else if (d.id === 'slowMo') expect(plan.launch.slowMo).toBe(120);
      else expect(flat, d.id).toContain(probe);
    });
  }

  it('a default-valued slowMo (0) is not sent', () => {
    expect(planFor({ slowMo: 0 }, 'vip').launch.slowMo).toBeUndefined();
  });
});

describe('Zod whitelist', () => {
  it('refuses unknown option names instead of dropping them', () => {
    const r = parseBrowserOptions({ viewportWidth: 800, hackTheGibson: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/hackTheGibson/);
  });

  it('accepts an empty / absent value and a JSON string', () => {
    expect(parseBrowserOptions(undefined)).toMatchObject({ ok: true, options: {} });
    expect(parseBrowserOptions('')).toMatchObject({ ok: true, options: {} });
    expect(parseBrowserOptions('{"locale":"fa-IR"}')).toMatchObject({ ok: true, options: { locale: 'fa-IR' } });
    expect(parseBrowserOptions('{oops').ok).toBe(false);
  });

  it('refuses dangerous chrome switches and reserved headers', () => {
    for (const a of ['--remote-debugging-port=1', '--user-data-dir=/x', '--load-extension=/x', '--proxy-server=x',
      '--disable-web-security', '--no-sandbox', '--js-flags=--expose-gc']) {
      expect(parseBrowserOptions({ chromeArgs: [a] }).ok, a).toBe(false);
    }
    expect(parseBrowserOptions({ chromeArgs: ['--mute-audio', '--mute-audio'] }).ok).toBe(false);
    expect(parseBrowserOptions({ chromeArgs: ['mute-audio'] }).ok).toBe(false);
    expect(parseBrowserOptions({ extraHTTPHeaders: { Host: 'x' } }).ok).toBe(false);
    expect(parseBrowserOptions({ extraHTTPHeaders: { 'X-A': 'a\nb' } }).ok).toBe(false);
  });

  it('range edges', () => {
    expect(parseBrowserOptions({ viewportWidth: 199 }).ok).toBe(false);
    expect(parseBrowserOptions({ viewportWidth: 200 }).ok).toBe(true);
    expect(parseBrowserOptions({ viewportWidth: 800.5 }).ok).toBe(false);
    expect(parseBrowserOptions({ geolocationLat: 90.01 }).ok).toBe(false);
    expect(parseBrowserOptions({ slowMo: 10001 }).ok).toBe(false);
    expect(parseBrowserOptions({ timezoneId: 'Nope/Nowhere' }).ok).toBe(false);
    expect(parseBrowserOptions({ proxyServer: 'ftp://h:1' }).ok).toBe(false);
  });

  it('the schema object is strict', () => {
    expect(browserOptionsSchema().safeParse({ headless: true }).success).toBe(true);
    expect(browserOptionsSchema().safeParse({ headless: 'true' }).success).toBe(false);
  });
});

describe('browser tiers', () => {
  const opts = { headless: false, slowMo: 50, proxyServer: 'http://p:1', viewportWidth: 900, locale: 'fa-IR' };

  it('vip: launch AND context options both apply', () => {
    const p = planFor(opts, 'vip');
    expect(p.launch).toMatchObject({ headless: false, slowMo: 50, proxy: { server: 'http://p:1' } });
    expect(p.context).toMatchObject({ locale: 'fa-IR', viewport: { width: 900, height: 720 } });
    expect(p.ignored).toEqual([]);
  });

  it('free (shared browser): launch options are reported, never silently dropped', () => {
    const p = planFor(opts, 'free');
    expect(p.launch).toEqual({});
    expect(p.context).toMatchObject({ locale: 'fa-IR' });
    expect(p.ignored.map((i) => i.id).sort()).toEqual(['headless', 'proxyServer', 'slowMo']);
    expect(p.ignored.every((i) => i.reason === 'shared-browser')).toBe(true);
  });

  it('attached (local / Real Chrome): nothing applies and everything is reported', () => {
    const p = planFor(opts, 'attached');
    expect(p.launch).toEqual({});
    expect(p.context).toEqual({});
    expect(p.ignored).toHaveLength(Object.keys(opts).length);
  });

  it('unpaired options are reported as ignored', () => {
    expect(planFor({ geolocationLat: 1 }, 'vip').ignored).toEqual([{ id: 'geolocationLat', reason: 'geo-incomplete' }]);
    expect(planFor({ httpUsername: 'u' }, 'vip').ignored).toEqual([{ id: 'httpUsername', reason: 'http-incomplete' }]);
    expect(planFor({ proxyBypass: 'a.test' }, 'vip').ignored).toEqual([{ id: 'proxyBypass', reason: 'needs-proxy' }]);
  });

  it('geolocation grants its own permission, without duplicating it', () => {
    expect(planFor({ geolocationLat: 1, geolocationLon: 2 }, 'vip').context.permissions).toEqual(['geolocation']);
    expect(planFor({ geolocationLat: 1, geolocationLon: 2, permissions: ['geolocation', 'notifications'] }, 'vip')
      .context.permissions).toEqual(['geolocation', 'notifications']);
  });

  it('the hash is stable and changes with the options', () => {
    const a = planFor({ locale: 'fa-IR', viewportWidth: 900 }, 'vip').hash;
    const b = planFor({ viewportWidth: 900, locale: 'fa-IR' }, 'vip').hash;
    expect(a).toBe(b);
    expect(planFor({ locale: 'en-US' }, 'vip').hash).not.toBe(a);
    expect(planFor({}, 'vip').hash).toBe('');
  });
});

describe('incompatibility warnings', () => {
  const codes = (o: any, actions: string[] = []) => diagnoseBrowserOptions(o, actions).map((d) => d.code);

  it('proxy credentials without a server', () => {
    expect(codes({ proxyUsername: 'u' })).toContain('needs-proxy');
    expect(codes({ proxyServer: 'http://p:1', proxyPassword: 'x' })).toContain('proxy-pass-no-user');
    expect(codes({ proxyServer: 'http://p:1', proxyUsername: 'u' })).toEqual([]);
  });
  it('half a pair', () => {
    expect(codes({ httpUsername: 'u' })).toContain('http-auth-pair');
    expect(codes({ geolocationLat: 1 })).toContain('geo-pair');
    expect(codes({ geolocationAccuracy: 5 })).toContain('geo-accuracy');
  });
  it('offline + proxy, JS off, headless + extension, ua/lang duplicated in headers', () => {
    expect(codes({ offline: true, proxyServer: 'http://p:1' })).toContain('offline-proxy');
    expect(codes({ javaScriptEnabled: false })).toContain('js-off');
    expect(codes({ headless: true }, ['open-extension'])).toContain('headless-ext');
    expect(codes({ headless: true }, ['click'])).not.toContain('headless-ext');
    expect(codes({ userAgent: 'x', extraHTTPHeaders: { 'User-Agent': 'y' } })).toContain('ua-header');
    expect(codes({ locale: 'fa-IR', extraHTTPHeaders: { 'accept-language': 'en' } })).toContain('lang-header');
  });
  it('mobile without touch, slowMo while headless', () => {
    expect(codes({ isMobile: true })).toContain('mobile-touch');
    expect(codes({ isMobile: true, hasTouch: true })).not.toContain('mobile-touch');
    expect(codes({ slowMo: 100, headless: true })).toContain('slowmo-headless');
  });
  it('every diagnostic is bilingual', () => {
    const all = diagnoseBrowserOptions({
      proxyUsername: 'u', httpUsername: 'u', geolocationLat: 1, offline: true, proxyServer: 'http://p:1',
      javaScriptEnabled: false, headless: true, slowMo: 5, isMobile: true, bypassCSP: true, ignoreHTTPSErrors: true,
      permissions: ['camera'], userAgent: 'x', locale: 'fa-IR', viewportWidth: 300,
      extraHTTPHeaders: { 'user-agent': 'a', 'accept-language': 'b' },
    }, ['open-extension']);
    expect(all.length).toBeGreaterThan(10);
    for (const d of all) { expect(d.fa.length, d.code).toBeGreaterThan(5); expect(d.en.length, d.code).toBeGreaterThan(5); }
  });
});

describe('headless precedence', () => {
  it('the Launch node option beats the run switch; absent -> the run switch', () => {
    expect(effectiveHeadless({ headless: false }, true)).toBe(false);
    expect(effectiveHeadless({ headless: true }, false)).toBe(true);
    expect(effectiveHeadless({}, false)).toBe(false);
    expect(effectiveHeadless(undefined, true)).toBe(true);
  });
});

describe('workflow integration', () => {
  const launch = (browserOptions: unknown) => ({ action: 'launch', params: { browserOptions } });

  it('validateSteps refuses bad options with a readable message', () => {
    expect(() => validateSteps([launch({ viewportWidth: 5 })] as never, config.FULL_ACCESS_PLAN))
      .toThrow(/invalid browser options.*viewportWidth/);
    expect(() => validateSteps([launch({ nope: 1 })] as never, config.FULL_ACCESS_PLAN)).toThrow(/unknown option/);
  });

  it('validateSteps keeps valid options as an object (JSON text accepted)', () => {
    const out = validateSteps([launch('{"locale":"fa-IR"}')] as never, config.FULL_ACCESS_PLAN);
    expect(out[0].params.browserOptions).toEqual({ locale: 'fa-IR' });
  });

  it('a Launch node without options is untouched', () => {
    const out = validateSteps([{ action: 'launch', params: { url: 'https://x.test' } }] as never, config.FULL_ACCESS_PLAN);
    expect(out[0].params).toEqual({ url: 'https://x.test' });
  });

  it('findLaunchOptions walks nested branches; allActions lists everything', () => {
    const steps = [
      { action: 'if', then: [{ action: 'click', params: {} }], else: [launch({ locale: 'fa-IR' })] },
    ];
    expect(findLaunchOptions(steps as any)).toEqual({ locale: 'fa-IR' });
    expect(allActions(steps as any).sort()).toEqual(['click', 'if', 'launch']);
    expect(optionsOfStep(launch({ slowMo: 5 }))).toEqual({ slowMo: 5 });
    expect(optionsOfStep(launch({}))).toBeUndefined();
    expect(findLaunchOptions([{ action: 'goto', params: {} }] as any)).toBeUndefined();
  });

  it('secrets never reach the log summary', () => {
    const s = describeOptions({ proxyServer: 'http://p:1', proxyPassword: 'hunter2', httpPassword: 'hunter3' });
    expect(s).not.toMatch(/hunter/);
    expect(s).toContain('proxyPassword=***');
  });
});

describe('serializer round trip (UI <-> backend)', () => {
  const w = load(['icons.js', 'actions.js', 'graph-serialize.js']);
  const GS = w.GraphSerialize;
  it('browserOptions survives graph -> steps -> graph', () => {
    const text = JSON.stringify({ locale: 'fa-IR', viewportWidth: 900 });
    const graph = {
      nodes: { start: { id: 'start', action: '__start__', params: {} },
        n1: { id: 'n1', action: 'launch', params: { browserOptions: text } } },
      edges: [{ from: 'start', to: 'n1', port: 'next' }],
    };
    const steps = GS.graphToSteps(graph);
    expect(steps[0].params.browserOptions).toBe(text);
    const back = GS.stepsToGraph([{ action: 'launch', params: { browserOptions: { locale: 'fa-IR' } } }]);
    const n = Object.values(back.nodes as Record<string, any>).find((x) => x.action === 'launch');
    expect(JSON.parse(n.params.browserOptions)).toEqual({ locale: 'fa-IR' });
  });
});

describe('pipeline: the plan reaches the launch call', () => {
  it('the vip launch uses launch+context keys and relaunches when options change', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'pipeline.ts'), 'utf8');
    expect(src).toMatch(/vipOptionHash/);
    expect(src).toMatch(/\.\.\.optPlan\.context/);
    expect(src).toMatch(/GlobalBrowser\.getContext\(freePlan\.context\)/);
    void vi;
  });
});
