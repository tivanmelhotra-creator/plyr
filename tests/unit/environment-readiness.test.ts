/**
 * environment-readiness.test.ts — the 15 regression scenarios for configuration,
 * dependency and browser-runtime readiness.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A server was deployed and the Remote Browser died on the first click with:
 *
 *     Could not start the remote browser: Real Chrome is disabled.
 *     Set REAL_CHROME_ENABLED=true to use extensions.
 *
 * The instruction was explicitly NOT to fix that one variable. It was to make
 * the project reproducible, so that `git clone && npm ci && configure && build
 * && start` yields a working Remote Browser on a machine nobody has touched by
 * hand. Four independent root causes were measured:
 *
 *   1. CONFIGURATION DRIFT. REAL_CHROME_ENABLED defaults to TRUE. It was false
 *      only because a `.env` copied from an older release still carried the old
 *      opt-in default. `.gitignore` excludes `.env` and install.sh never
 *      overwrites one, so the drift is permanent and invisible.
 *   2. PROVISIONING. postinstall ran `playwright install chromium || echo ...`,
 *      turning failure into success. The binary landed; five OS libraries did
 *      not, and Chrome could not execute.
 *   3. SILENT DEGRADATION. NODE_ENV=production selected a HEADLESS profile, and
 *      headless Chrome loads ZERO extensions (measured: 0 service workers
 *      headless vs 1 headed). Every container shipped without the Element
 *      Inspector and said nothing.
 *   4. UNDOCUMENTED SURFACE. 13 variables were read by config.ts and appeared
 *      in no .env.example, so a deployer could not have known to set them.
 *
 * WHAT THESE TESTS GUARD
 * ----------------------
 * Each root cause is a class of regression that a later tidy-up commit
 * reintroduces silently, because in every case THE SERVER STILL STARTS. That is
 * the defining property: nothing here crashes loudly on its own, so nothing here
 * is caught without an explicit assertion.
 *
 * Several of these read repository FILES (package.json, Dockerfile,
 * .env.example) rather than runtime behaviour. That is deliberate. Causes 2 and
 * 4 are provisioning defects that cannot be observed from inside a process that
 * is already running on a correctly-provisioned machine — the only place the
 * truth exists is the manifest that a clean environment will be built from.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO = path.resolve(__dirname, '..', '..');
const readRepo = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

/**
 * Remove comments, preserving string literals.
 *
 * Every file-scanning assertion below needs this, and three of them were
 * written without it and FAILED on their first run — for the same reason, in
 * three different disguises:
 *
 *   • `app.listen` appeared in a comment ABOVE the validation call, so an
 *     ordering check read the comment and concluded the order was wrong.
 *   • The old `Set REAL_CHROME_ENABLED=true` message is QUOTED in the header of
 *     doctor.ts and BrowserRuntime.ts, as the bug those files exist to fix.
 *   • A `// REMOVED: a second router.post('/browser/start')` comment — left
 *     behind precisely to explain the deletion — was counted as a handler.
 *
 * In all three cases the code was correct and the naive test was wrong. Since
 * this repository documents heavily, and the mission required documenting the
 * reasoning, grep-style assertions over raw source are actively misleading here.
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .map((line) => {
      let out = '';
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          out += c;
          if (c === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
        if (c === '/' && line[i + 1] === '/') break;
        out += c;
      }
      return out;
    })
    .join('\n');
}

/** Read a repository file with its comments removed. */
const readCode = (p: string) => stripComments(readRepo(p));

/**
 * Every variable that can steer the modules under test.
 *
 * Cleared before each load so that a stray value in the developer's own shell,
 * in CI, or in tests/integration/setup.ts (which pins DEPLOYMENT_MODE, NODE_ENV
 * and API_KEYS for the whole run) cannot make an assertion pass or fail for a
 * reason unrelated to what it claims to test.
 */
const STEERING = [
  'APP_ENV', 'NODE_ENV', 'PORT',
  'REAL_CHROME_ENABLED', 'REAL_CHROME_HEADLESS', 'REAL_CHROME_DISPLAY',
  'REAL_CHROME_USER_DATA_DIR', 'REAL_CHROME_EXTENSIONS_DIR',
  'REAL_CHROME_DEBUG_PORT', 'REAL_CHROME_RESTORE_TABS',
  'CHROME_EXE', 'DISPLAY',
  'DESKTOP_ENABLED', 'DESKTOP_AUTO_PROVISION',
  'DEPLOYMENT_MODE', 'API_TOKEN', 'API_KEYS', 'API_KEYS_ENABLED',
  'ADMIN_SECRET', 'RATE_LIMIT_ENABLED', 'REQUIRE_BROWSER_RUNTIME',
  'BROWSER_MODE_DEFAULT', 'LOCAL_BROWSER_ENABLED',
];

/**
 * Load pristine copies of config + the readiness modules under a given
 * environment.
 *
 * `vi.resetModules()` is essential: src/config.ts resolves everything ONCE at
 * import time into an `as const` object, so without it the second scenario in
 * this file would silently assert against the first scenario's config.
 */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: (mods: {
    config: typeof import('../../src/config')['config'];
    runtime: typeof import('../../src/core/BrowserRuntime');
    startup: typeof import('../../src/core/StartupValidation');
    profile: typeof import('../../src/core/EnvProfile');
  }) => Promise<T> | T,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of STEERING) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    return await fn({
      config: (await import('../../src/config')).config,
      runtime: await import('../../src/core/BrowserRuntime'),
      startup: await import('../../src/core/StartupValidation'),
      profile: await import('../../src/core/EnvProfile'),
    });
  } finally {
    for (const k of STEERING) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  }
}

/** A real, disposable directory — the runtime report mkdir's what it checks. */
const scratchDirs: string[] = [];
function scratch(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `envready-${name}-`));
  scratchDirs.push(d);
  return d;
}

afterEach(() => {
  while (scratchDirs.length) {
    const d = scratchDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ===========================================================================
// 1. Missing required env
// ===========================================================================
describe('1. missing required env', () => {
  it('boots with NO environment at all — every gap has a default', async () => {
    // The headline promise of the task: a developer clones and runs, and the
    // application does not stop on a variable nobody told them about.
    await withEnv({}, async ({ startup }) => {
      const report = await startup.validateStartup();
      const fatal = report.issues.filter((i) => i.severity === 'fatal');
      expect(fatal, `unexpected fatal issues: ${JSON.stringify(fatal, null, 2)}`).toEqual([]);
      expect(report.ok).toBe(true);
    });
  });

  it('does NOT stop the boot for an absent value that has a default', async () => {
    // Stated verbatim in the task: "اگر مقداری باید default داشته باشد، نبود آن
    // نباید startup را متوقف کند." A validator that demands what it could have
    // defaulted is the same disease as the original bug, pointed the other way.
    await withEnv({}, async ({ config, startup }) => {
      expect(config.PORT).toBe(3000);
      expect(config.REAL_CHROME_ENABLED).toBe(true);
      const report = await startup.validateStartup();
      expect(report.issues.some((i) => i.id === 'port_invalid')).toBe(false);
    });
  });

  it('IS fatal for a value that cannot be defaulted — an unparseable PORT', async () => {
    // Not pedantry: parseInt('bananas') is NaN and app.listen(NaN) binds a
    // RANDOM free port. The server "starts" and is unreachable at the address
    // the operator was given. There is no safe default for a typo.
    await withEnv({ PORT: 'bananas' }, async ({ startup }) => {
      const report = await startup.validateStartup();
      const issue = report.issues.find((i) => i.id === 'port_invalid');
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe('fatal');
      expect(report.ok).toBe(false);
      expect(issue!.fix).toMatch(/PORT/);
    });
  });
});

// ===========================================================================
// 2. Default env behaviour
// ===========================================================================
describe('2. default env behaviour', () => {
  it('REAL_CHROME_ENABLED defaults to TRUE — the reported failure is not reachable by default', async () => {
    // THE REGRESSION THAT STARTED ALL OF THIS. If this ever flips back to an
    // opt-in default, a fresh deployment greets its operator with "Real Chrome
    // is disabled" and no indication that the default did it.
    await withEnv({}, ({ config }) => {
      expect(config.REAL_CHROME_ENABLED).toBe(true);
    });
  });

  it('an explicit value always beats a profile default', async () => {
    // The precedence rule that makes profiles safe to add. A profile that could
    // override what an operator typed would be a new class of silent surprise.
    await withEnv({ APP_ENV: 'production', REAL_CHROME_HEADLESS: 'false' }, ({ config }) => {
      expect(config.REAL_CHROME_HEADLESS).toBe(false);
    });
  });

  it('reports WHERE each value came from, so a surprise is diagnosable', async () => {
    await withEnv({ APP_ENV: 'server', REAL_CHROME_DISPLAY: ':77' }, ({ profile }) => {
      const explicit = profile.resolveVar('REAL_CHROME_DISPLAY', process.env, 'server');
      expect(explicit.source).toBe('explicit');
      const fromProfile = profile.resolveVar('REAL_CHROME_HEADLESS', process.env, 'server');
      expect(fromProfile.source).toBe('profile');
      expect(fromProfile.value).toBe('false');
    });
  });
});

// ===========================================================================
// 3. Production config
// ===========================================================================
describe('3. production config', () => {
  it('production still resolves deterministically with an empty environment', async () => {
    await withEnv({ APP_ENV: 'production' }, async ({ config, startup }) => {
      expect(config.APP_PROFILE).toBe('production');
      expect(config.APP_PROFILE_SOURCE).toBe('APP_ENV');
      const report = await startup.validateStartup();
      expect(report.issues.filter((i) => i.severity === 'fatal')).toEqual([]);
    });
  });

  it('warns — loudly and in writing — that the public default token is in use', async () => {
    // A weak default is defensible. A weak default that says nothing is not.
    await withEnv({ APP_ENV: 'production' }, async ({ startup }) => {
      const report = await startup.validateStartup();
      const issue = report.issues.find((i) => i.id === 'default_token_in_production');
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe('warn');
      expect(issue!.problem).toMatch(/admin123/);
    });
  });

  it('does NOT abort a running multi-tenant server merely for an empty API_KEYS', async () => {
    // This rule was written as `fatal` and that was a BUG, kept as a test
    // because the reasoning is the point. `config.API_KEYS` is only the .env
    // SEED — the real store is Redis (ApiKeyManager), and /admin/api-keys/generate
    // sits behind ADMIN_SECRET, not behind API-key auth. Aborting would have
    // killed healthy instances AND removed the endpoint that repairs the very
    // state being complained about.
    await withEnv(
      { APP_ENV: 'production', DEPLOYMENT_MODE: 'multi', API_KEYS_ENABLED: 'true', API_KEYS: '' },
      async ({ startup }) => {
        const report = await startup.validateStartup();
        const issue = report.issues.find((i) => i.id === 'no_api_keys');
        expect(issue).toBeDefined();
        expect(issue!.severity).toBe('warn');
        expect(report.ok).toBe(true);
        // The fix must be runnable, not advice.
        expect(issue!.fix).toMatch(/admin\/api-keys\/generate/);
      },
    );
  });
});

// ===========================================================================
// 4 + 5. Remote Browser enabled / Real Chrome enabled where required
// ===========================================================================
describe('4+5. Remote Browser and Real Chrome enablement', () => {
  it('the server profile runs HEADED, because extensions need it', async () => {
    // MEASURED, not assumed: headless Chrome loads 0 extension service workers,
    // headed loads 1. The Element Inspector IS an extension, so a headless
    // server profile would ship the product without its headline feature.
    await withEnv({ APP_ENV: 'server' }, ({ config }) => {
      expect(config.APP_PROFILE).toBe('server');
      expect(config.REAL_CHROME_ENABLED).toBe(true);
      expect(config.REAL_CHROME_HEADLESS).toBe(false);
    });
  });

  it('grades headless as DEGRADED rather than fine, and says what is lost', async () => {
    await withEnv(
      { APP_ENV: 'production', REAL_CHROME_HEADLESS: 'true' },
      async ({ runtime }) => {
        const report = await runtime.inspectBrowserRuntime();
        const ext = report.checks.find((c) => c.id === 'extensionSupport')!;
        expect(ext.state).toBe('degraded');
        expect(ext.detail).toMatch(/Element Inspector/);
        expect(ext.fix).toMatch(/REAL_CHROME_HEADLESS=false/);
      },
    );
  });

  it('when disabled, says so ONCE at boot instead of only at the first click', async () => {
    // The original defect was discovering this from a runtime error after
    // deployment. It must be visible at startup, before anyone clicks.
    await withEnv({ REAL_CHROME_ENABLED: 'false' }, async ({ startup }) => {
      const report = await startup.validateStartup();
      const issue = report.issues.find((i) => i.id === 'remote_browser_disabled');
      expect(issue).toBeDefined();
      expect(issue!.fix).toMatch(/default is true/);
      // Still only a warning: a deliberate opt-out is a valid configuration.
      expect(report.ok).toBe(true);
    });
  });

  it('server is selectable ONLY through APP_ENV, never accidentally through NODE_ENV', async () => {
    // NODE_ENV is owned by the wider tooling ecosystem; APP_ENV is ours. A
    // stray NODE_ENV=server from some unrelated tool must not silently change
    // how Chrome launches.
    await withEnv({ NODE_ENV: 'server' }, ({ config }) => {
      expect(config.APP_PROFILE).toBe('development');
    });
    await withEnv({ APP_ENV: 'server' }, ({ config }) => {
      expect(config.APP_PROFILE).toBe('server');
    });
  });
});

// ===========================================================================
// 6. Browser executable discovery
// ===========================================================================
describe('6. browser executable discovery', () => {
  it('an operator-pinned CHROME_EXE always wins over the bundled Chromium', async () => {
    // Someone who pinned a specific Chrome build (Widevine/DRM, corporate MSI)
    // must not be silently handed Playwright's Chromium instead.
    const dir = scratch('exe');
    const exe = path.join(dir, 'my-chrome');
    fs.writeFileSync(exe, '#!/bin/sh\necho "Chrome 999.0"\n');
    fs.chmodSync(exe, 0o755);
    await withEnv({ CHROME_EXE: exe }, async ({ runtime }) => {
      const resolved = await runtime.resolveExecutable();
      expect(resolved.source).toBe('CHROME_EXE');
      expect(resolved.path).toBe(exe);
    });
  });

  it('falls back to Playwright and reports the source honestly', async () => {
    await withEnv({}, async ({ runtime }) => {
      const resolved = await runtime.resolveExecutable();
      expect(['playwright', 'none']).toContain(resolved.source);
      if (resolved.source === 'playwright') expect(resolved.path).toBeTruthy();
    });
  });

  it('never throws when there is no browser — a missing one is a report, not a crash', async () => {
    await withEnv({ CHROME_EXE: '/nonexistent/definitely/not/chrome' }, async ({ runtime }) => {
      const report = await runtime.inspectBrowserRuntime();
      expect(report.ok).toBe(false);
      const exe = report.checks.find((c) => c.id === 'executable')!;
      expect(exe.state).toBe('failed');
      // Must name the variable actually at fault, not offer a generic install.
      expect(exe.fix).toMatch(/CHROME_EXE/);
    });
  });
});

// ===========================================================================
// 7. Missing browser runtime
// ===========================================================================
describe('7. missing browser runtime', () => {
  it('blocks only the Remote Browser, and lets the rest of the server run', async () => {
    // The API, queues and scheduler are useful without a browser. Refusing to
    // boot would convert a partial outage into a total one.
    await withEnv({ CHROME_EXE: '/nonexistent/chrome' }, async ({ startup }) => {
      const report = await startup.validateStartup();
      expect(report.ok).toBe(true);
      expect(report.blockedFeatures).toContain('Remote Browser');
      expect(report.issues.some((i) => i.severity === 'blocked')).toBe(true);
    });
  });

  it('REQUIRE_BROWSER_RUNTIME=true escalates the same fault to fatal', async () => {
    // For deployments whose only purpose IS the browser, booting a uselessly
    // healthy-looking server is worse than failing fast. Opt-in, not default.
    await withEnv(
      { CHROME_EXE: '/nonexistent/chrome', REQUIRE_BROWSER_RUNTIME: 'true' },
      async ({ startup }) => {
        const report = await startup.validateStartup();
        expect(report.ok).toBe(false);
        expect(report.issues.some((i) => i.severity === 'fatal')).toBe(true);
      },
    );
  });

  it('a cold X display is DEGRADED, not failed — the server starts one on demand', async () => {
    // Grading this as broken would report a dead Remote Browser on a machine
    // where pressing the button works perfectly, because Desktop.start() builds
    // the display before Chrome is ever touched.
    await withEnv(
      { APP_ENV: 'server', DESKTOP_AUTO_PROVISION: 'true', REAL_CHROME_DISPLAY: ':4242' },
      async ({ runtime }) => {
        const report = await runtime.inspectBrowserRuntime();
        const display = report.checks.find((c) => c.id === 'display')!;
        expect(display.state).toBe('degraded');
        expect(display.detail).toMatch(/on demand/);
      },
    );
  });

  it('but IS a failure when the server is forbidden to build one', async () => {
    await withEnv(
      { APP_ENV: 'server', DESKTOP_AUTO_PROVISION: 'false', REAL_CHROME_DISPLAY: ':4242' },
      async ({ runtime }) => {
        const report = await runtime.inspectBrowserRuntime();
        const display = report.checks.find((c) => c.id === 'display')!;
        expect(display.state).toBe('failed');
        expect(display.fix).toBeTruthy();
      },
    );
  });
});

// ===========================================================================
// 8. Missing runtime dependency
// ===========================================================================
describe('8. missing runtime dependency', () => {
  it('every module src/ imports is declared in package.json', async () => {
    // This is the test that would have caught the deployment class of failure
    // directly: code that works locally because a package happens to be present
    // on that machine, and explodes on a clean `npm ci`.
    //
    // Comment-stripping is not cosmetic — without it, the Persian/English prose
    // in this repo's doc comments produced six phantom "packages", including a
    // COMMENTED-OUT `import fetch from 'node-fetch'` in src/pipeline.ts that
    // looks exactly like a real missing dependency.
    const { builtinModules } = await import('module');
    const pkg = JSON.parse(readRepo('package.json'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
    const builtin = new Set(builtinModules);

    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    })(path.join(REPO, 'src'));
    expect(files.length).toBeGreaterThan(50); // the walk actually walked

    const undeclared = new Map<string, string[]>();
    const re = /(?:^|[\s;}])(?:import\s[^;]*?from\s*|import\s*|export\s[^;]*?from\s*)['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const spec = m[1] || m[2];
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (builtin.has(bare)) continue;
        if (!declared.has(bare)) {
          undeclared.set(bare, [...(undeclared.get(bare) || []), path.relative(REPO, file)]);
        }
      }
    }
    expect(
      Object.fromEntries(undeclared),
      'imported but not in package.json — a clean `npm ci` deployment will fail',
    ).toEqual({});
  });

  it('playwright is pinned EXACTLY and matches the Docker base image', async () => {
    // The Dockerfile uses mcr.microsoft.com/playwright:vX-jammy AND sets
    // SKIP_BROWSER_INSTALL=1, so the image's pre-baked browser revision is the
    // only one available. A caret range that drifts one minor gives a
    // playwright expecting a chromium build the image does not contain, and
    // which it will never download. Silent, and only in production.
    const pkg = JSON.parse(readRepo('package.json'));
    const version = pkg.dependencies.playwright;
    expect(version, 'playwright must be exact-pinned, not a range').toMatch(/^\d+\.\d+\.\d+$/);

    const dockerfile = readRepo('Dockerfile');
    const tags = [...dockerfile.matchAll(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/g)].map((m) => m[1]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, `Dockerfile image v${tag} vs package.json ${version}`).toBe(version);
    }
  });

  it('the shared-library probe reports a real answer for the real binary', async () => {
    // The exact failure the clean sandbox had: binary present, five libraries
    // missing, launch failing with "Host system is missing dependencies".
    await withEnv({}, async ({ runtime }) => {
      const { path: exe } = await runtime.resolveExecutable();
      if (!exe || !fs.existsSync(exe) || process.platform !== 'linux') return; // nothing to probe
      const missing = await runtime.missingSharedLibraries(exe);
      expect(Array.isArray(missing)).toBe(true);
      if (missing.length) {
        // Whatever it found, it must hand back a command that fixes it.
        expect(runtime.libraryFix(missing)).toMatch(/install:browser:deps/);
      }
    });
  });

  it('postinstall cannot mask a failed browser install', async () => {
    // It used to end in `|| echo "..."`, which turns a non-zero exit into a
    // successful `npm ci`. That single shell operator is how a broken image
    // reaches production reporting a clean install.
    const pkg = JSON.parse(readRepo('package.json'));
    expect(pkg.scripts.postinstall).not.toMatch(/\|\|\s*echo/);
    expect(pkg.scripts.postinstall).toMatch(/scripts\/postinstall\.js/);
    const script = readRepo('scripts/postinstall.js');
    expect(script).toMatch(/SKIP_BROWSER_INSTALL/); // honours prebaked images
    expect(script).toMatch(/ldd/);                  // checks OS libraries too
  });
});

// ===========================================================================
// 9. Invalid configuration
// ===========================================================================
describe('9. invalid configuration', () => {
  it('an unknown APP_ENV falls back to development rather than an undefined profile', async () => {
    // A typo must not produce a fourth, empty profile whose defaults are all
    // undefined — that is how you get a machine behaving unlike every other.
    await withEnv({ APP_ENV: 'prodcution' }, ({ config }) => {
      expect(config.APP_PROFILE).toBe('development');
    });
  });

  it('a CHROME_EXE pointing at a directory is reported as not executable', async () => {
    const dir = scratch('notafile');
    await withEnv({ CHROME_EXE: dir }, async ({ runtime }) => {
      const report = await runtime.inspectBrowserRuntime();
      expect(report.checks.find((c) => c.id === 'executable')!.state).toBe('failed');
    });
  });

  it('every failed or blocked finding carries a non-empty fix', async () => {
    // The whole complaint was an error with no remedy. An unactionable
    // diagnostic is the bug this project was asked to remove.
    await withEnv(
      { CHROME_EXE: '/nonexistent/chrome', PORT: 'nope' },
      async ({ startup }) => {
        const report = await startup.validateStartup();
        const actionable = report.issues.filter((i) => i.severity !== 'warn');
        expect(actionable.length).toBeGreaterThan(0);
        for (const issue of actionable) {
          expect(issue.fix.trim(), `issue ${issue.id} has no fix`).not.toBe('');
          expect(issue.feature.trim()).not.toBe('');
        }
      },
    );
  });
});

// ===========================================================================
// 10. Extension loading configuration
// ===========================================================================
describe('10. extension loading configuration', () => {
  it('the Docker image actually CONTAINS the extension it is meant to load', async () => {
    // It did not. `seedInspectorExtension()` resolves ./extension and never
    // throws, so every container silently ran without the Element Inspector and
    // reported nothing wrong. A one-line COPY was the entire defect.
    const dockerfile = readRepo('Dockerfile');
    expect(dockerfile).toMatch(/COPY\s+extension\s+\.\/extension/);
    expect(fs.existsSync(path.join(REPO, 'extension', 'manifest.json'))).toBe(true);
  });

  it('the image installs the display stack a headed browser requires', async () => {
    const dockerfile = readRepo('Dockerfile');
    for (const pkg of ['xvfb', 'x11vnc', 'websockify']) {
      expect(dockerfile, `Dockerfile must install ${pkg}`).toMatch(new RegExp(pkg));
    }
  });

  it('the extensions directory is checked for writability before Chrome needs it', async () => {
    // Otherwise the failure surfaces mid-launch as an EACCES that reads like a
    // browser crash rather than a permissions problem.
    const extDir = path.join(scratch('ext'), 'nested');
    await withEnv({ REAL_CHROME_EXTENSIONS_DIR: extDir }, async ({ runtime }) => {
      const report = await runtime.inspectBrowserRuntime();
      const check = report.checks.find((c) => c.id === 'extensionsDir')!;
      expect(check.state).toBe('ok');
      expect(check.detail).toMatch(/writable/);
    });
  });
});

// ===========================================================================
// 11. Startup readiness
// ===========================================================================
describe('11. startup readiness', () => {
  it('produces the operator-facing report shape the task specified', async () => {
    await withEnv({ APP_ENV: 'server', CHROME_EXE: '/nonexistent/chrome' }, async ({ startup }) => {
      const text = startup.formatStartupReport(await startup.validateStartup());
      expect(text).toMatch(/server/);          // which environment
      expect(text).toMatch(/Remote Browser/);  // which capability
      expect(text.length).toBeGreaterThan(50);
    });
  });

  it('validation is side-effect free and safe to run twice', async () => {
    // It runs at boot AND from `npm run doctor`. If it mutated anything, the
    // diagnostic tool would change the thing it was asked to diagnose.
    await withEnv({ APP_ENV: 'server' }, async ({ startup }) => {
      const first = await startup.validateStartup();
      const second = await startup.validateStartup();
      expect(second.issues.map((i) => i.id)).toEqual(first.issues.map((i) => i.id));
      expect(second.ok).toBe(first.ok);
    });
  });

  it('is wired into the boot path BEFORE the server accepts traffic', async () => {
    // Validating after listen() would report problems to a server already
    // serving requests it cannot fulfil.
    // Comments stripped first: a comment ABOVE the call explains why it must
    // run before app.listen, and mentions app.listen by name.
    const index = readCode('src/index.ts');
    const validateAt = index.indexOf('await enforceStartupValidation(');
    const listenAt = index.indexOf('app.listen(');
    expect(validateAt, 'enforceStartupValidation() is not awaited in index.ts').toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(listenAt);
  });

  it('exposes readiness over HTTP for a container health check', async () => {
    const routes = readRepo('src/Routes/health.routes.ts');
    expect(routes).toMatch(/\/browser/);
    expect(routes).toMatch(/profile/);
  });
});

// ===========================================================================
// 12. Local / Remote switching
// ===========================================================================
describe('12. local and remote switching', () => {
  it('all four profiles resolve a complete, deterministic configuration', async () => {
    // The explicit prohibition: "Environment A → Real Chrome enabled,
    // Environment B → Real Chrome silently disabled". Every profile must have a
    // defined answer for the values that decide whether the browser works.
    for (const id of ['development', 'server', 'production', 'test'] as const) {
      await withEnv({ APP_ENV: id }, ({ config }) => {
        expect(config.APP_PROFILE).toBe(id);
        expect(typeof config.REAL_CHROME_ENABLED).toBe('boolean');
        expect(typeof config.REAL_CHROME_HEADLESS).toBe('boolean');
        expect(typeof config.PORT).toBe('number');
      });
    }
  });

  it('keeps the Remote Browser enabled in EVERY profile', async () => {
    // Disabling it per-environment is precisely the silent divergence that
    // produced the original bug report.
    for (const id of ['development', 'server', 'production', 'test'] as const) {
      await withEnv({ APP_ENV: id }, ({ config }) => {
        expect(config.REAL_CHROME_ENABLED, `profile ${id} disabled Real Chrome`).toBe(true);
      });
    }
  });

  it('local browser mode remains available alongside the remote one', async () => {
    await withEnv({}, ({ config }) => {
      expect(['local', 'remote']).toContain(config.BROWSER_MODE_DEFAULT);
    });
  });
});

// ===========================================================================
// 13. Remote Browser startup
// ===========================================================================
describe('13. Remote Browser startup', () => {
  it('no source file still tells the user to "Set REAL_CHROME_ENABLED=true"', async () => {
    // That sentence WAS the bug report. It is wrong twice: the default is
    // already true, so the real cause is a stale .env, and it names a symptom
    // instead of the drift that produced it.
    //
    // Comments are stripped, because doctor.ts and BrowserRuntime.ts both QUOTE
    // the old message in their headers to record the defect they fix. Banning
    // the sentence from documentation as well as from output would make the
    // reasoning unwritable.
    const offenders: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith('.ts')
          && /Set REAL_CHROME_ENABLED=true to use extensions/.test(stripComments(fs.readFileSync(p, 'utf8')))) {
          offenders.push(path.relative(REPO, p));
        }
      }
    })(path.join(REPO, 'src'));
    expect(offenders, 'this message must not be shown to users any more').toEqual([]);
  });

  it('the disabled-browser message explains the stale .env, not just the flag', async () => {
    const source = readCode('src/core/RealChrome.ts');
    expect(source).toMatch(/default is TRUE/i);
    expect(source).toMatch(/\.env/);
    expect(source).toMatch(/npm run doctor/); // a way to see where the value came from
  });

  it('exactly ONE /browser/start handler is registered', async () => {
    // There were two. Express matches the first, so the second was dead — and
    // the dead one held the ONLY call to setSelfHealEnabled(true), meaning
    // /browser/stop could permanently disable self-healing with no way back.
    //
    // Comments stripped: a `// REMOVED: a second router.post('/browser/start')`
    // note was deliberately left where the dead handler stood, and a raw scan
    // counts the tombstone as a second registration.
    const routes = readCode('src/Routes/browser.routes.ts');
    const handlers = [...routes.matchAll(/router\.post\(\s*['"]\/browser\/start['"]/g)];
    expect(handlers.length, 'a duplicate handler is dead code Express never reaches').toBe(1);
    expect(routes).toMatch(/setSelfHealEnabled\(true\)/);
  });

  it('a deliberate stop is honoured instead of being undone by self-heal', async () => {
    // isSelfHealEnabled() had ZERO callers: /browser/stop wrote a flag nothing
    // read, so "Stop" did not stop.
    const selfHeal = readCode('src/core/SelfHeal.ts');
    expect(selfHeal).toMatch(/isSelfHealEnabled\(\)/);
    expect(selfHeal).toMatch(/selfHealDisabled/);
  });

  it('every variable config.ts reads is documented in .env.example', async () => {
    // 13 were not. A deployer cannot set what nobody wrote down, which is the
    // "configuration living only in a developer's head" the task forbids.
    const cfg = readRepo('src/config.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const used = new Set<string>([
      ...[...cfg.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
      ...[...cfg.matchAll(/profiled\(\s*'([A-Z][A-Z0-9_]*)'\s*\)/g)].map((m) => m[1]),
    ]);
    const documented = new Set(
      [...readRepo('.env.example').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    );
    expect(used.size).toBeGreaterThan(80); // the scan actually found the variables
    expect([...used].filter((v) => !documented.has(v)).sort()).toEqual([]);
  });
});

// ===========================================================================
// 14. Existing Handoff functionality
// ===========================================================================
describe('14. Handoff still works', () => {
  it('pairing codes are generated, normalised and compared as before', async () => {
    const handoff = await import('../../src/core/SessionHandoff');
    const code = handoff.generatePairingCode();
    expect(code.length).toBeGreaterThan(0);
    expect(handoff.normalizePairingCode(handoff.formatPairingCode(code))).toBe(code);
    expect(handoff.secretsMatch(code, code)).toBe(true);
    expect(handoff.secretsMatch(code, `${code}x`)).toBe(false);
  });

  it('snapshot freshness still expires on the documented TTL', async () => {
    const handoff = await import('../../src/core/SessionHandoff');
    const snap = handoff.buildSnapshot({ tabs: [], cookies: [], origin: 'remote' } as never);
    expect(handoff.snapshotIsFresh(snap)).toBe(true);
    expect(handoff.snapshotIsFresh(snap, Date.now() + handoff.SNAPSHOT_TTL_MS + 1000)).toBe(false);
    expect(handoff.snapshotIsFresh(null)).toBe(false);
  });

  it('the handoff registry is unaffected by the new profiles', async () => {
    for (const id of ['development', 'server', 'production'] as const) {
      await withEnv({ APP_ENV: id }, async () => {
        const handoff = await import('../../src/core/SessionHandoff');
        expect(handoff.sessionHandoff).toBeDefined();
        expect(handoff.PAIRING_TTL_MS).toBeGreaterThan(0);
      });
    }
  });
});

// ===========================================================================
// 15. Existing Element Inspector functionality
// ===========================================================================
describe('15. Element Inspector still works', () => {
  it('the extension is present and declares a manifest Chrome can load', async () => {
    const manifest = JSON.parse(readRepo('extension/manifest.json'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBeTruthy();
  });

  it('the inspector source directory resolves inside the deployed app', async () => {
    const inspector = await import('../../src/core/InspectorExtension');
    const dir = inspector.inspectorSourceDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.endsWith('extension')).toBe(true);
  });

  it('seeding reports a reason instead of throwing when it cannot run', async () => {
    // It never throws BY DESIGN — which is exactly why the missing Docker COPY
    // went unnoticed. The contract is that it must still say what happened, so
    // the caller can surface it.
    const inspector = await import('../../src/core/InspectorExtension');
    const result = await inspector.seedInspectorExtension(scratch('seed'));
    expect(result).toHaveProperty('seeded');
    expect(result).toHaveProperty('reason');
  });

  it('is available in every profile a human uses, because all run headed', async () => {
    for (const id of ['development', 'server'] as const) {
      await withEnv({ APP_ENV: id }, async ({ runtime }) => {
        const report = await runtime.inspectBrowserRuntime();
        const ext = report.checks.find((c) => c.id === 'extensionSupport')!;
        expect(ext.state, `profile ${id} cannot load extensions`).toBe('ok');
      });
    }
  });
});
