import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * WHY THIS FILE EXISTS
 *
 * CI failed with:
 *
 *   TypeError: webidl.util.markAsUncloneable is not a function
 *     at new CacheStorage node_modules/undici/lib/web/cache/cachestorage.js
 *     at node_modules/jsdom/lib/api.js
 *
 * and it failed ONLY in CI. The suite passed locally, so the local pass was
 * worthless as evidence.
 *
 * The cause was not the test and not the code under test. jsdom@30 declares
 * `engines: { node: "^22.22.2 || ..." }` and pulls undici@8 (`>=22.19.0`).
 * `webidl.util.markAsUncloneable` wraps a Node 22+ builtin, so on Node 20 it is
 * `undefined` and merely IMPORTING jsdom throws before a single test runs.
 * The dev sandbox happened to be Node 22.23; CI pins Node 20. The dependency
 * was fine on the machine that installed it and broken everywhere else.
 *
 * The lesson is not "pin jsdom". It is that an engines range narrower than the
 * range the project actually supports is a silent, environment-dependent
 * failure, and the only place to catch it cheaply is the lockfile. So this test
 * reads the RESOLVED tree — not the declared `^` ranges, which say nothing
 * about what npm actually picked — and fails on any dependency that demands a
 * newer Node than this project claims to run on.
 *
 * It is deliberately not jsdom-specific: the next such dependency is caught
 * without anyone remembering this incident.
 */

type LockPkg = { version?: string; engines?: { node?: string }; dev?: boolean };

const root = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

/** Lowest major this project promises to run on, read from `engines`. */
function declaredMinMajor(): number {
  const range = String(pkg.engines?.node ?? '');
  const found = range.match(/(\d+)/);
  expect(found, 'package.json must declare engines.node').not.toBeNull();
  return Number(found![1]);
}

/**
 * The lowest major a semver range will accept. Handles the shapes npm actually
 * publishes: ">=22.19.0", "^22.22.2 || ^24.15.0 || >=26.0.0", "20 || >=22".
 * A range with several alternatives is satisfied by its LOWEST branch, so the
 * minimum over branches is the right reduction.
 */
function rangeMinMajor(range: string): number | null {
  const branches = range.split('||').map((s) => s.trim()).filter(Boolean);
  const majors: number[] = [];
  for (const branch of branches) {
    const m = branch.match(/(\d+)/);
    if (m) majors.push(Number(m[1]));
  }
  return majors.length ? Math.min(...majors) : null;
}

describe('the installed dependency tree runs on the Node this project targets', () => {
  it('declares engines.node, so the target is discoverable and not folklore', () => {
    expect(pkg.engines?.node, 'engines.node is missing').toBeTruthy();
    expect(declaredMinMajor()).toBeGreaterThanOrEqual(18);
  });

  it('agrees with the Node version CI actually installs', () => {
    // If these drift, CI is testing a runtime nobody declared — which is
    // exactly how the jsdom@30 breakage reached main-bound code unseen.
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const pinned = ci.match(/node-version:\s*'?(\d+)/);
    expect(pinned, 'CI must pin a node-version').not.toBeNull();
    expect(Number(pinned![1])).toBe(declaredMinMajor());
  });

  it('has no resolved package demanding a newer Node than we support', () => {
    const min = declaredMinMajor();
    const packages: Record<string, LockPkg> = lock.packages ?? {};
    const tooNew: string[] = [];

    for (const [path, meta] of Object.entries(packages)) {
      const range = meta?.engines?.node;
      if (!range) continue;
      const needs = rangeMinMajor(String(range));
      if (needs !== null && needs > min) {
        tooNew.push(`${path || '<root>'}@${meta.version} needs node ${range}`);
      }
    }

    // Reported in full: a bare count sends the next reader back to the lockfile.
    expect(
      tooNew,
      `these resolved packages require a newer Node than engines.node (>=${min}):\n  ` +
        tooNew.join('\n  '),
    ).toEqual([]);
  });

  it('can import jsdom on this runtime at all', async () => {
    // The original failure happened at import time, before any test body ran,
    // which is why every assertion about the DOM looked green on Node 22 and
    // the whole FILE collapsed on Node 20. Assert the import itself.
    await expect(import('jsdom')).resolves.toBeDefined();
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<p id="x">ok</p>');
    expect(dom.window.document.getElementById('x')?.textContent).toBe('ok');
  });
});
