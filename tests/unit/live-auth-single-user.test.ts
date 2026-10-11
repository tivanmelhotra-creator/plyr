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
  API_TOKEN: 'tok_single_shared',
  LIVE_SHARE_SECRET: '',
};

vi.mock('../../src/config', () => ({
  get config() {
    return cfg;
  },
}));

describe('authorizeLive — one instance token', () => {
  beforeEach(() => {
    cfg.API_TOKEN = 'tok_single_shared';
  });

  it('allows the shared API_TOKEN (this is what unblocks /browser/ws)', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    const res = await authorizeLive('tok_single_shared', 'local');
    expect(res.ok).toBe(true);
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

  it('a token that differs only in length is refused (no prefix match)', async () => {
    const { authorizeLive } = await import('../../src/core/LiveServer');
    expect((await authorizeLive('tok_single_shared_x', 'local')).ok).toBe(false);
    expect((await authorizeLive('tok_single', 'local')).ok).toBe(false);
  });
});
