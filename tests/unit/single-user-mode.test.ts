import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── One install = one owner: access rules of requireApiKey ─────────────────
// There are no accounts, roles or per-user keys. One instance access token
// protects the backend:
//   * production  -> the token is required on EVERY request;
//   * development -> a request from THIS machine (loopback socket) needs no
//                    token; any other address still needs it.
// The owner identity is always SINGLE_USER_ID ('local').

const cfg: Record<string, unknown> = {
  API_TOKEN: 'tok_secret_single_token',
  AUTH_OPEN: false,          // production
  ALLOW_OPEN_AUTH: false,
};

vi.mock('../../src/config', () => ({
  get config() {
    return cfg;
  },
}));

import { requireApiKey, SINGLE_USER_ID } from '../../src/middleware/auth';

function makeRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  return res as { statusCode: number; body: any };
}

function makeReq(opts: { authorization?: string; xApiKey?: string; remote?: string } = {}) {
  return {
    headers: { authorization: opts.authorization, 'x-api-key': opts.xApiKey },
    query: {},
    ip: opts.remote || '127.0.0.1',
    socket: { remoteAddress: opts.remote || '127.0.0.1' },
  } as any;
}

beforeEach(() => {
  cfg.API_TOKEN = 'tok_secret_single_token';
  cfg.AUTH_OPEN = false;
  cfg.ALLOW_OPEN_AUTH = false;
});

describe('production — the access token is required', () => {
  it('accepts the token (Bearer) and resolves to the owner', async () => {
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

  it('rejects a missing token with 401 — even from this machine', async () => {
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
    expect(res.body.error).toBe('Invalid API token');
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

  it('still requires the token from another device on the network', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq({ remote: '192.168.1.50' }), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('a wrong token is still refused, even from loopback', async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireApiKey(makeReq({ authorization: 'Bearer nope' }), res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
