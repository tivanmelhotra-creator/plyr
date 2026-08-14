import { describe, it, expect, beforeEach } from 'vitest';
import {
  InspectorAuthorizationRegistry,
  AUTH_CODE_TTL_MS,
} from '../../src/core/InspectorAuthorization';

// ════════════════════════════════════════════════════════════════
// InspectorAuthorization — the one-time code, and the durable binding.
//
// The two rules under test are the ones the requirement states most firmly:
//
//   * a code is for PAIRING ONLY and is single use;
//   * after pairing, an ordinary send needs only the API key, and a binding to
//     one Target Field must never be disturbed by activity on another.
//
// Every case exercises the real registry. Nothing here reads the source.
// ════════════════════════════════════════════════════════════════

const USER = 'user-a';
const OTHER = 'user-b';
const KEY = 'ak_live_aaaaaaaaaaaaaaaa';
const KEY2 = 'ak_live_bbbbbbbbbbbbbbbb';
const T1 = 'node_n8__selector__aaaa1111';
const T2 = 'node_n9__name__bbbb2222';

describe('issuing an Authorization Code', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('issues a code scoped to one Target Field', () => {
    const offer = auth.issue(USER, T1);
    expect(offer).not.toBeNull();
    expect(offer!.targetFieldId).toBe(T1);
    expect(offer!.code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('refuses to issue without a user or a target', () => {
    expect(auth.issue('', T1)).toBeNull();
    expect(auth.issue(USER, '')).toBeNull();
  });

  it('does not leave two valid codes for the same target', () => {
    // A second press must invalidate the code still shown on a stale screen.
    const first = auth.issue(USER, T1)!;
    const second = auth.issue(USER, T1)!;
    expect(auth.pendingCount()).toBe(1);
    expect(auth.redeem(KEY, first.code).ok).toBe(false);
    expect(auth.redeem(KEY, second.code).ok).toBe(true);
  });

  it('keeps codes for two different targets alive together', () => {
    const a = auth.issue(USER, T1)!;
    const b = auth.issue(USER, T2)!;
    expect(auth.pendingCount()).toBe(2);
    expect(auth.redeem(KEY, a.code).ok).toBe(true);
    expect(auth.redeem(KEY, b.code).ok).toBe(true);
  });
});

describe('redeeming a code', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('creates a binding for the paired target', () => {
    const offer = auth.issue(USER, T1)!;
    const r = auth.redeem(KEY, offer.code);
    expect(r.ok).toBe(true);
    expect(auth.isAuthorized(KEY, USER, T1)).toBe(true);
  });

  it('is SINGLE USE — a second redemption is refused', () => {
    const offer = auth.issue(USER, T1)!;
    expect(auth.redeem(KEY, offer.code).ok).toBe(true);
    const again = auth.redeem(KEY2, offer.code);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toBe('INVALID_AUTHORIZATION_CODE');
  });

  it('does not authorize the second key when a code is reused', () => {
    const offer = auth.issue(USER, T1)!;
    auth.redeem(KEY, offer.code);
    auth.redeem(KEY2, offer.code);
    expect(auth.isAuthorized(KEY2, USER, T1)).toBe(false);
  });

  it('refuses an unknown code', () => {
    const r = auth.redeem(KEY, 'ZZZZZZZZ');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('INVALID_AUTHORIZATION_CODE');
  });

  it('reports EXPIRED separately from INVALID', () => {
    // §27 requires distinct messages: "ask for a new code" is not the same
    // instruction as "check what you typed".
    const offer = auth.issue(USER, T1, 1_000)!;
    const r = auth.redeem(KEY, offer.code, 1_000 + AUTH_CODE_TTL_MS + 1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('AUTHORIZATION_EXPIRED');
  });

  it('consumes an expired code so it cannot be retried', () => {
    const offer = auth.issue(USER, T1, 1_000)!;
    auth.redeem(KEY, offer.code, 1_000 + AUTH_CODE_TTL_MS + 1);
    const second = auth.redeem(KEY, offer.code, 1_000 + AUTH_CODE_TTL_MS + 2);
    expect(second.ok === false && second.reason).toBe('INVALID_AUTHORIZATION_CODE');
  });

  it('accepts a code the way a human types it (case and dashes)', () => {
    const offer = auth.issue(USER, T1)!;
    const typed = `${offer.code.slice(0, 4)}-${offer.code.slice(4)}`.toLowerCase();
    expect(auth.redeem(KEY, ` ${typed} `).ok).toBe(true);
  });

  it('refuses an empty code or an empty key', () => {
    const offer = auth.issue(USER, T1)!;
    expect(auth.redeem(KEY, '').ok).toBe(false);
    expect(auth.redeem('', offer.code).ok).toBe(false);
  });
});

describe('after pairing, ordinary sends need only the API key', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('authorizes repeatedly without another code', () => {
    // The requirement: the code is for pairing, NOT for each value sent.
    const offer = auth.issue(USER, T1)!;
    auth.redeem(KEY, offer.code);
    for (let i = 0; i < 5; i++) {
      expect(auth.isAuthorized(KEY, USER, T1)).toBe(true);
    }
    expect(auth.pendingCount()).toBe(0);
  });

  it('does not authorize a target this key never paired with', () => {
    const offer = auth.issue(USER, T1)!;
    auth.redeem(KEY, offer.code);
    expect(auth.isAuthorized(KEY, USER, T2)).toBe(false);
  });

  it('does not authorize a different API key', () => {
    const offer = auth.issue(USER, T1)!;
    auth.redeem(KEY, offer.code);
    expect(auth.isAuthorized(KEY2, USER, T1)).toBe(false);
  });

  it('does not authorize the same key under a different account', () => {
    const offer = auth.issue(USER, T1)!;
    auth.redeem(KEY, offer.code);
    expect(auth.isAuthorized(KEY, OTHER, T1)).toBe(false);
  });

  it('does not store the API key itself', () => {
    // The map only needs equality, so it holds a digest. A heap dump should not
    // hand over a working credential.
    const offer = auth.issue(USER, T1)!;
    auth.redeem(KEY, offer.code);
    expect(JSON.stringify([...auth.bindingsFor(KEY)])).not.toContain(KEY);
  });
});

describe('two bindings coexist and are revoked independently', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('holds bindings for two targets at once', () => {
    auth.redeem(KEY, auth.issue(USER, T1)!.code);
    auth.redeem(KEY, auth.issue(USER, T2)!.code);
    expect(auth.isAuthorized(KEY, USER, T1)).toBe(true);
    expect(auth.isAuthorized(KEY, USER, T2)).toBe(true);
    expect(auth.bindingsFor(KEY)).toHaveLength(2);
  });

  it('pairing a second target does NOT revoke the first', () => {
    // The single-slot regression this design exists to avoid.
    auth.redeem(KEY, auth.issue(USER, T1)!.code);
    auth.redeem(KEY, auth.issue(USER, T2)!.code);
    expect(auth.isAuthorized(KEY, USER, T1)).toBe(true);
  });

  it('revoking one target leaves the other authorized', () => {
    auth.redeem(KEY, auth.issue(USER, T1)!.code);
    auth.redeem(KEY, auth.issue(USER, T2)!.code);
    expect(auth.revoke(T1)).toBe(1);
    expect(auth.isAuthorized(KEY, USER, T1)).toBe(false);
    expect(auth.isAuthorized(KEY, USER, T2)).toBe(true);
  });

  it('revoking an unbound target is a no-op, not an error', () => {
    auth.redeem(KEY, auth.issue(USER, T1)!.code);
    expect(auth.revoke('node_nope__selector__ffff9999')).toBe(0);
    expect(auth.isAuthorized(KEY, USER, T1)).toBe(true);
  });

  it('revokes across every client bound to that target', () => {
    auth.redeem(KEY, auth.issue(USER, T1)!.code);
    auth.redeem(KEY2, auth.issue(USER, T1)!.code);
    expect(auth.revoke(T1)).toBe(2);
    expect(auth.isAuthorized(KEY, USER, T1)).toBe(false);
    expect(auth.isAuthorized(KEY2, USER, T1)).toBe(false);
  });
});
