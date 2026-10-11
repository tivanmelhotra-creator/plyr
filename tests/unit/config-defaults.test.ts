/**
 * config-defaults.test.ts — the two defaults an operator gets with NO .env file.
 *
 * WHY THESE ARE PINNED
 * --------------------
 * Both were changed on explicit request, and both are the kind of value that a
 * later "tidy up the config" commit silently flips back:
 *
 *   REAL_CHROME_ENABLED  false → true   (opt-in → opt-OUT)
 *   API_TOKEN            admin123 → NO default at all (optional; the owner's
 *                        password is chosen on first run, see AuthStore)
 *
 * The first one matters because with Real Chrome off, Chrome loads NO extensions
 * at all — the cookie import/export extension that is the headline reason to run
 * this thing cannot even be installed, and the panel can only answer with a hint
 * to edit .env and restart. The second matters because the old behaviour minted a
 * fresh random token on every boot whenever .env was empty, which logged every
 * open panel out.
 *
 * There must NEVER again be a public default credential: `admin123` granted full
 * control of the instance (it drives a real browser and reads/writes the
 * download and upload directories). API_TOKEN is optional and empty by default.
 *
 * These tests read the REAL module with a real (temporarily emptied) environment
 * rather than mocking config, because the thing under test IS the resolution of
 * `process.env` into config. A mock would assert my own stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Load a pristine copy of src/config under a given environment. */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};
  // Clear everything that could steer the two values under test, so a stray
  // variable in the developer's own shell cannot make this pass or fail.
  const touched = [
    'REAL_CHROME_ENABLED', 'API_TOKEN', 'DEPLOYMENT_MODE',
    'REAL_CHROME_HEADLESS', 'API_KEYS',
  ];
  for (const k of touched) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return (await import('../../src/config')).config;
  } finally {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('config defaults with no .env', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  // ────────────────────────────────────────────────────────────────────────
  // REAL_CHROME_ENABLED
  // ────────────────────────────────────────────────────────────────────────

  it('enables Real Chrome by default, so extensions can be installed at all', async () => {
    const config = await loadConfig({});
    expect(config.REAL_CHROME_ENABLED).toBe(true);
  });

  it('still lets an operator turn Real Chrome off', async () => {
    // The whole point of opt-OUT is that opting out works. A lighter deployment
    // with no X server is a legitimate choice.
    const config = await loadConfig({ REAL_CHROME_ENABLED: 'false' });
    expect(config.REAL_CHROME_ENABLED).toBe(false);
  });

  it('treats an explicit true as true and a typo as the default', async () => {
    expect((await loadConfig({ REAL_CHROME_ENABLED: 'true' })).REAL_CHROME_ENABLED).toBe(true);
    expect((await loadConfig({ REAL_CHROME_ENABLED: 'TRUE' })).REAL_CHROME_ENABLED).toBe(true);
    // Only the exact string 'false' disables it. A typo must not silently take
    // away extensions — that is the failure mode this default exists to end.
    expect((await loadConfig({ REAL_CHROME_ENABLED: 'banana' })).REAL_CHROME_ENABLED).toBe(true);
    expect((await loadConfig({ REAL_CHROME_ENABLED: '' })).REAL_CHROME_ENABLED).toBe(true);
    // Case-insensitive off, since .env files are hand-edited.
    expect((await loadConfig({ REAL_CHROME_ENABLED: 'False' })).REAL_CHROME_ENABLED).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────
  // API_TOKEN
  // ────────────────────────────────────────────────────────────────────────

  it('has NO default token: no admin123, nothing generated, nothing to show', async () => {
    const config = await loadConfig({});
    expect(config.API_TOKEN).toBe('');
    expect(JSON.stringify(config)).not.toContain('admin123');
    expect((config as any).API_TOKEN_IS_DEFAULT).toBeUndefined();
  });

  it('is stable across restarts (nothing random is minted per boot)', async () => {
    const a = await loadConfig({});
    const b = await loadConfig({});
    expect(a.API_TOKEN).toBe(b.API_TOKEN);
  });

  it('uses an operator-supplied token as the optional scripts credential', async () => {
    const config = await loadConfig({ API_TOKEN: 'my-own-long-token' });
    expect(config.API_TOKEN).toBe('my-own-long-token');
  });

  it('an old DEPLOYMENT_MODE=multi is ignored: still one instance', async () => {
    const config = await loadConfig({ DEPLOYMENT_MODE: 'multi' });
    expect(config.DEPLOYMENT_MODE).toBe('single');
    expect(config.API_TOKEN).toBe('');
  });

  it('prints no default-token warning (there is no default to warn about)', async () => {
    await loadConfig({});
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).not.toContain('admin123');
    expect(said).not.toMatch(/PUBLIC/);
  });

  // ────────────────────────────────────────────────────────────────────────
  // The documentation must not contradict the code
  // ────────────────────────────────────────────────────────────────────────

  it('ships an .env.example that matches these defaults', async () => {
    // An example file that disagrees with the code is worse than none: it is the
    // first thing an operator copies to .env.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const example = readFileSync(join(__dirname, '..', '..', '.env.example'), 'utf8');
    expect(example).toMatch(/^REAL_CHROME_ENABLED=true$/m);
    // No credential is shipped in the example file: API_TOKEN is optional.
    expect(example).not.toMatch(/^API_TOKEN=\S/m);
    expect(example).not.toContain('admin123');
  });
});
