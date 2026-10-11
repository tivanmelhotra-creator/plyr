import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── One install = one owner: access rules of requireApiKey ─────────────────
// There are no accounts, roles or per-user keys.
//   * production  -> a credential is required on EVERY request: a session
//                    issued after the owner's password, the internal service
//                    credential, or the optional operator API token;
//   * development -> a request from THIS machine (loopback socket, no
//                    forwarding header) needs NOTHING and no credential is
//                    validated; any other address is refused.
// The owner identity is always SINGLE_USER_ID ('local').

const cfg: Record<string, unknown> = {
  API_TOKEN: 'tok_secret_single_token',   // the OPTIONAL scripts token
  AUTH_OPEN: false,          // production
  ALLOW_OPEN_AUTH: false,
};

vi.mock('../../src/config', () => ({
  get config() {
    return cfg;
  },
}));

import { requireApiKey, SINGLE_USER_ID, isOpenAuthRequest } from '../../src/middleware/auth';
import { authStore } from '../../src/core/AuthStore';

function makeRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res as { statusCode: number; body: any };
}

function makeReq(opts: { authorization?: string; xApiKey?: string; remote?: string; headers?: Record<string, string> } = {}) {
  return {
    headers: { authorization: opts.authorization, 'x-api-key': opts.xApiKey, ...(opts.headers || {}) },
    query: {},
    ip: opts.remote || '127.0.0.1',
    socket: { remoteAddress: opts.remote || '127.0.0.1' },
  } as any;
}

beforeEach(async () => {
  authStore.resetForTests();
  await authStore.setInitialPassword('Correct-Horse-9');
  cfg.API_TOKEN = 'tok_secret_single_token';
  cfg.AUTH_OPEN = false;
  cfg.ALLOW_OPEN_AUTH = false;
});

describe('production — a credential is required', () => {
  it('accepts a session (Bearer) and resolves to the owner', async () => {
    const { token } = authStore.issueSession();
    const req = makeReq({ authorization: `Bearer ${token}` });
    const next = vi.fn();
    await requireApiKey(req, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKeyUserId).toBe('local');
  });

  it('accepts the internal service credential, but never the password itself', async () => {
    const ok = makeReq({ xApiKey: authStore.serviceToken() });
    const n1 = vi.fn();
    await requireApiKey(ok, makeRes() as any, n1);
    expect(n1).toHaveBeenCalledTimes(1);
    const res = makeRes();
    const n2 = vi.fn();
    await requireApiKey(makeReq({ xApiKey: 'Correct-Horse-9' }), res as any, n2);
    expect(n2).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('with no password set yet, says setup_required (503/409 never open)', async () => {
    authStore.resetForTests();
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq(), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('setup_required');
  });

  it('a session dies when the password changes', async () => {
    const { token } = authStore.issueSession();
    expect((await authStore.changePassword('Correct-Horse-9', 'Another-Pass-77')).ok).toBe(true);
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq({ xApiKey: token }), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('accepts the optional API token (Bearer) and resolves to the owner', async () => {
    const req = makeReq({ authorization: 'Bearer tok_secret_single_token' });
    const next = vi.fn();
    await requireApiKey(req, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKeyUserId).toBe(SINGLE_USER_ID);
    expect(req.apiKeyUserId).toBe('local');
  });

  it('accepts the token via x-api-key', async () => {
    const req = makeReq({ xApiKey: 'tok_secret_single_token' });
    const next = vi.fn();
    await requireApiKey(req, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing credential with 401 — even from this machine', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq(), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token with 403', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq({ authorization: 'Bearer tok_wrong' }), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('invalid_credential');
  });
});

describe('development — keyless only from this machine', () => {
  beforeEach(() => { cfg.AUTH_OPEN = true; });

  it('lets a loopback request in without a token', async () => {
    const req = makeReq({ remote: '127.0.0.1' });
    const next = vi.fn();
    await requireApiKey(req, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKeyUserId).toBe('local');
  });

  it('a loopback request carrying a forwarding header is NOT local', async () => {
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const res = makeRes();
      const next = vi.fn();
      await requireApiKey(makeReq({ remote: '127.0.0.1', headers: { [h]: '203.0.113.9' } }), res as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body.code).toBe('local_only');
    }
  });

  it('ALLOW_OPEN_AUTH (loopback-only dev compose) opens the container bridge peer too', () => {
    cfg.ALLOW_OPEN_AUTH = true;
    expect(isOpenAuthRequest(makeReq({ remote: '172.18.0.1' }))).toBe(true);
    expect(isOpenAuthRequest(makeReq({ remote: '172.18.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } }))).toBe(false);
  });

  it('is never open outside development', () => {
    cfg.AUTH_OPEN = false;
    expect(isOpenAuthRequest(makeReq({ remote: '127.0.0.1' }))).toBe(false);
  });

  it('still refuses another device on the network', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq({ remote: '192.168.1.50' }), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('validates nothing locally: a junk credential from loopback is still the owner', async () => {
    const req = makeReq({ authorization: 'Bearer nope' });
    const next = vi.fn();
    await requireApiKey(req, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKeyUserId).toBe('local');
  });

  it('works with no credential at all and does not need an API token to exist', async () => {
    cfg.API_TOKEN = '';
    const req = makeReq();
    const next = vi.fn();
    await requireApiKey(req, makeRes() as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
