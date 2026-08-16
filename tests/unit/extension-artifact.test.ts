import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ════════════════════════════════════════════════════════════════════════════
// THE BUILD MUST PRODUCE AN INSTALLABLE CHROME EXTENSION
//
// THE GAP
// -------
// Reported: the operator wants LOCAL BROWSER with their own Chrome, but
// «هیچ Chrome Extension ساخته‌شده‌ای برای نصب ندارند» — the repository gave
// them source and no installable artifact.
//
// MEASURED before the fix:
//
//     package.json   "build": "tsc"
//     tsconfig.json  "include": ["src/**/*"]
//
// so `extension/` never entered any build output. The only consumer was
// seedInspectorExtension(), which writes into the git-ignored `profiles/`
// directory for the REMOTE browser.
//
// THE CONTRACT THIS FILE LOCKS DOWN
// ---------------------------------
//     GitHub repository -> npm ci -> npm run build
//       -> Chrome Extension artifact
//       -> Chrome -> Extensions -> Load unpacked -> Element Inspector installed
//
// So the assertions are deliberately about INSTALLABILITY, not about file
// counts: manifest present and valid MV3, every referenced runtime file
// resolvable, no secret riding along. Anything Chrome would reject at "Load
// unpacked" must fail here first, while the developer is still looking.
// ════════════════════════════════════════════════════════════════════════════

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/build-extension.js');
const ARTIFACT = path.join(ROOT, 'artifacts/element-inspector-extension');

/** Read a file from the ARTIFACT (never from source) — that is the point. */
const artifactFile = (rel: string): string =>
  fs.readFileSync(path.join(ARTIFACT, rel), 'utf8');

const inArtifact = (rel: string): boolean => fs.existsSync(path.join(ARTIFACT, rel));

beforeAll(() => {
  // Build from scratch so the test can never pass on a stale directory left
  // behind by an earlier run.
  fs.rmSync(ARTIFACT, { recursive: true, force: true });
  execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });
}, 60_000);

describe('the build emits a loadable unpacked extension', () => {
  it('creates artifacts/element-inspector-extension', () => {
    expect(fs.existsSync(ARTIFACT)).toBe(true);
    expect(fs.statSync(ARTIFACT).isDirectory()).toBe(true);
  });

  it('ships a valid MV3 manifest IN THE ARTIFACT', () => {
    // In the artifact specifically: a manifest that exists only in `extension/`
    // is exactly the state the user reported.
    expect(inArtifact('manifest.json')).toBe(true);

    const manifest = JSON.parse(artifactFile('manifest.json'));
    expect(manifest.manifest_version).toBe(3);
    expect(typeof manifest.name).toBe('string');
    expect(typeof manifest.version).toBe('string');
    // Chrome refuses to install a manifest whose version is not dotted digits.
    expect(manifest.version).toMatch(/^\d+(\.\d+)*$/);
  });

  it('ships every runtime file the user was promised', () => {
    // The explicit list from the request: manifest.json, background.js,
    // content scripts, popup/, lib/, icons/.
    for (const f of [
      'manifest.json',
      'background.js',
      'content/inspector.js',
      'content/presence.js',
      'content/recorder.js',
      'content/selector.js',
      'lib/ab-core.js',
      'lib/ab-handoff.js',
      'lib/ab-inspect.js',
      'popup/popup.html',
      'popup/popup.js',
      'popup/popup.css',
      'icons/icon16.png',
      'icons/icon48.png',
      'icons/icon128.png',
    ]) {
      expect(inArtifact(f), `missing from artifact: ${f}`).toBe(true);
      expect(fs.statSync(path.join(ARTIFACT, f)).size, `empty in artifact: ${f}`)
        .toBeGreaterThan(0);
    }
  });

  it('every path the manifest names resolves inside the artifact', () => {
    const manifest = JSON.parse(artifactFile('manifest.json'));
    const refs: string[] = [
      manifest.background?.service_worker,
      manifest.action?.default_popup,
      ...Object.values(manifest.icons || {}),
      ...(manifest.content_scripts || []).flatMap(
        (cs: { js?: string[]; css?: string[] }) => [...(cs.js || []), ...(cs.css || [])],
      ),
    ].filter((x): x is string => typeof x === 'string');

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(inArtifact(ref), `manifest references a missing file: ${ref}`).toBe(true);
    }
  });

  it('every asset the popup HTML pulls in resolves too', () => {
    // popup.html loads popup.css, ../lib/ab-core.js and popup.js — NONE of
    // which appear in the manifest. A manifest-only check would bless an
    // artifact whose popup is blank the moment the toolbar icon is clicked.
    const html = artifactFile('popup/popup.html');
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((r) => !/^(https?:|data:|#)/i.test(r));

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const abs = path.resolve(path.join(ARTIFACT, 'popup'), ref);
      expect(fs.existsSync(abs), `popup.html references a missing asset: ${ref}`).toBe(true);
    }
  });

  it('every importScripts() in the service worker resolves', () => {
    // A missing one kills the worker at registration, and Chrome reports only
    // a generic "Service worker registration failed".
    const js = artifactFile('background.js');
    const refs = [...js.matchAll(/importScripts\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      // bootstrap.config.js is generated per-install for the REMOTE browser and
      // is intentionally absent here; background.js wraps it in try/catch.
      if (ref === 'bootstrap.config.js') continue;
      expect(inArtifact(ref), `background.js imports a missing script: ${ref}`).toBe(true);
    }
  });
});

describe('the artifact is clean', () => {
  it('carries no design sources or docs meant only for the repository', () => {
    // ~1.5 MB of PNG mockups and a spec that Chrome never reads.
    expect(inArtifact('UI_UX')).toBe(false);
    expect(inArtifact('README.md')).toBe(false);
  });

  it('never contains bootstrap.config.js', () => {
    // Generated by seedInspectorExtension() for the remote browser, and it
    // embeds a real API token. CI uploads this artifact for download, so a copy
    // in here would publish somebody's credential.
    expect(inArtifact('bootstrap.config.js')).toBe(false);
  });

  it('ships its own install instructions', () => {
    expect(inArtifact('INSTALL.md')).toBe(true);
    const md = artifactFile('INSTALL.md');
    expect(md).toContain('chrome://extensions');
    expect(md).toContain('Developer mode');
    expect(md).toContain('Load unpacked');
    expect(md).toContain('artifacts/element-inspector-extension');
  });
});

describe('the build refuses to emit a broken artifact', () => {
  it('fails loudly when a referenced runtime file is missing', () => {
    // THE PROPERTY THAT MAKES CI TRUSTWORTHY. Without it, a copy step that
    // silently dropped a file would produce something that looks built and
    // fails in the user's browser. `lib/ab-core.js` is chosen deliberately: it
    // is NOT named in the manifest, so only the HTML and importScripts checks
    // can catch it.
    const victim = path.join(ROOT, 'extension/lib/ab-core.js');
    const backup = fs.readFileSync(victim);

    try {
      fs.unlinkSync(victim);
      let failed = false;
      let output = '';
      try {
        execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });
      } catch (e) {
        failed = true;
        output = String((e as { stderr?: Buffer }).stderr || '');
      }
      expect(failed, 'build should have exited non-zero').toBe(true);
      expect(output).toContain('incomplete');
      expect(output).toContain('ab-core.js');
    } finally {
      fs.writeFileSync(victim, backup);
      // Leave a good artifact behind for anything that runs after this.
      execFileSync('node', [SCRIPT], { cwd: ROOT, stdio: 'pipe' });
    }
  }, 60_000);
});

describe('npm run build is enough — no extra step for the user', () => {
  it('package.json wires the extension build into "build"', () => {
    // The reported requirement was explicit:
    //   npm ci -> npm run build -> Chrome Extension artifact
    // A separate script the user has to know about would not satisfy it.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('build:extension');
    expect(pkg.scripts['build:extension']).toContain('scripts/build-extension.js');
  });
});
