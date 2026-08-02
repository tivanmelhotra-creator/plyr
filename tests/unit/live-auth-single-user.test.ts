import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── authorizeLive() in single-user self-hosted mode ────────────────────────
//
// REGRESSION GUARD. `DEPLOYMENT_MODE=single` is the DEFAULT deployment of this
// product, and in that mode one shared `API_TOKEN` authenticates the whole
// instance (src/middleware/auth.ts § SINGLE-USER MODE, identity `local`).
// `authorizeLive()` — the gate in front of BOTH WebSocket channels — only knew
// the multi-tenant rules, so the shared token matched nothing and every
// upgrade was answered `403 Forbidden`:
//
//   * /browser/ws  → the simulated browser window (Live Browser View and the
//                    Element Picker behind the crosshair) never connected, so
//                    it never rendered a frame and never navigated anywhere;
//   * /live/ws     → live run events never reached the editor.
//
// The symptom carried no error text of its own, which is why it survived so
// long. These tests fail if the single-user branch is ever removed.

const cfg: Record<string, unknown> = {
  IS_SINGLE_USER: true,
  DEPLOYMENT_MODE: 'single',
  API_TOKEN: 'tok_single_shared',
  API_KEYS_ENABLED: true,
  API_KEYS: new Set<string>(),      // empty in single mode — this is expected
  LIVE_SHARE_SECRET: '',
};

vi.mock('../../src/config', () => ({
  get config() {
    return cfg;
  },
}));

// The manager is only consulted on the multi-tenant path; if the single-user
// branch is missing, these tests would fall through to it — so make that
// visible instead of silently returning `auth_unavailable`.
const validateAndGetOwner = vi.fn(async () => ({ valid: false }));
vi.mock('../../src/middleware/auth', () => ({
  getApiKeyManager: () => ({ validateAndGetOwner }),
}));

describe('authorizeLive — single-user mode (DEPLOYMENT_MODE=single)', () => {
  beforeEach(() => {
    cfg.IS_SINGLE_USER = true;
    cfg.DEPLOYMENT_MODE = 'single';
    cfg.API_TOKEN = 'tok_single_shared';
    cfg.API_KEYS_ENABLED = true;
    validateAndGetOwner.mockClear();
  });

  it('allows the shared API_TOKEN (this is what unblocks /browser/ws)', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive('tok_single_shared', 'local');
    expect(res.ok).toBe(true);
    // It must NOT have gone down the multi-tenant path.
    expect(validateAndGetOwner).not.toHaveBeenCalled();
  });

  it('accepts any userId for that token — the instance IS the user', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    // The UI sends '0' when /me reports no id, and 'local' otherwise; neither
    // may be rejected, or the browser window dies depending on which page
    // opened it.
    for (const uid of ['local', '0', 'env_root', 'whatever']) {
      const res = await authorizeLive('tok_single_shared', uid);
      expect(res.ok, `userId=${uid}`).toBe(true);
    }
  });

  it('denies a wrong token', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive('not_the_token', 'local');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid_api_key');
  });

  it('denies a missing token', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive(undefined, 'local');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_api_key');
  });

  it('still short-circuits when auth is globally disabled', async () => {
    cfg.API_KEYS_ENABLED = false;
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive(undefined, 'local');
    expect(res.ok).toBe(true);
  });
});
