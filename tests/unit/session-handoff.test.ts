/**
 * Tests for the Remote <-> Local session handoff.
 *
 * WHAT IS ACTUALLY BEING PROTECTED HERE
 * -------------------------------------
 * The user's requirement was not "a handoff exists" — it was that Remote and
 * Local must NOT be two independent sessions, and that a switch must feel like
 * the same browser moved machines. That translates into a small number of
 * invariants that are easy to break with an innocent-looking refactor, so each
 * one gets a test that names it:
 *
 *   1. The automation session ID survives a mode switch. If this ever changes,
 *      "one session" is a claim in a comment rather than a fact.
 *   2. Tab order and the active tab are preserved exactly.
 *   3. A pairing code is single-use and short-lived, and comparing it cannot
 *      crash on a length mismatch.
 *   4. The server's code normalisation and the extension's agree. These are two
 *      implementations in two languages of one rule; if they drift, users get
 *      "invalid code" while looking at a valid code.
 *   5. Pulling a snapshot PEEKS. A drain-by-default loses the only record of
 *      where the user's tabs were if the restore dies halfway.
 *
 * The registry's clock is injectable, so the expiry tests assert real
 * time-dependent behaviour without sleeping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PAIRING_TTL_MS,
  SNAPSHOT_TTL_MS,
  SessionHandoffRegistry,
  buildSnapshot,
  describeLimits,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  secretsMatch,
  snapshotIsFresh,
  MAX_SAVED_TABS,
} from '../../src/core/SessionHandoff';

// The extension's copy of the same rules, loaded as a plain CommonJS module.
// Requiring the real file (rather than restating its logic) is the entire point:
// a divergence between the two sides fails here instead of in the user's hands.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ABCore = require('../../extension/lib/ab-core.js');

describe('SessionHandoff — one automation session across both modes', () => {
  let reg: SessionHandoffRegistry;

  beforeEach(() => {
    reg = new SessionHandoffRegistry();
  });

  it('issues a stable session id and never reissues it', () => {
    const first = reg.sessionId('user-a');
    expect(first).toMatch(/^as_[0-9a-f]{24}$/);
    // Called again after any number of switches: still the same session.
    expect(reg.sessionId('user-a')).toBe(first);
    reg.issuePairing('user-a');
    reg.putSnapshot('user-a', buildSnapshot({
      sessionId: first, fromMode: 'remote', tabs: [{ url: 'https://example.com' }],
    }));
    expect(reg.sessionId('user-a')).toBe(first);
  });

  it('keeps different users on different sessions', () => {
    expect(reg.sessionId('user-a')).not.toBe(reg.sessionId('user-b'));
  });

  it('quotes the same session id in the pairing as the registry holds', () => {
    const sid = reg.sessionId('user-a');
    expect(reg.issuePairing('user-a').sessionId).toBe(sid);
  });
});

describe('SessionHandoff — pairing codes', () => {
  let reg: SessionHandoffRegistry;

  beforeEach(() => {
    reg = new SessionHandoffRegistry();
  });

  it('draws codes from an alphabet with no ambiguous characters', () => {
    // 0/O and 1/I/L are the characters users misread off a screen. 200 samples
    // is enough that a stray character in the alphabet shows up reliably.
    for (let i = 0; i < 200; i += 1) {
      expect(generatePairingCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('redeems a code for a token bound to the right user and session', () => {
    const offer = reg.issuePairing('user-a');
    const result = reg.redeemPairing(offer.code);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe('user-a');
    expect(result.sessionId).toBe(offer.sessionId);
    expect(result.token).toMatch(/^st_[0-9a-f]{48}$/);
  });

  it('refuses a second redemption of the same code', () => {
    const offer = reg.issuePairing('user-a');
    expect(reg.redeemPairing(offer.code).ok).toBe(true);
    const again = reg.redeemPairing(offer.code);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    // Not 'unknown': the distinction tells the user someone else consumed it.
    expect(again.reason).toBe('already_used');
  });

  it('refuses an expired code', () => {
    const t0 = 1_000_000;
    const offer = reg.issuePairing('user-a', t0);
    const late = reg.redeemPairing(offer.code, t0 + PAIRING_TTL_MS + 1);
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.reason).toBe('expired');
  });

  it('accepts a code on the last millisecond of its life', () => {
    const t0 = 1_000_000;
    const offer = reg.issuePairing('user-a', t0);
    expect(reg.redeemPairing(offer.code, t0 + PAIRING_TTL_MS).ok).toBe(true);
  });

  it('reports an unrecognised or empty code as unknown', () => {
    for (const bad of ['ZZZZZZZZ', '', null, undefined, 12345]) {
      const r = reg.redeemPairing(bad as unknown);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('unknown');
    }
  });

  it('drops a previous unredeemed code when a new one is issued', () => {
    // Two live codes for one session means the screen shows one while the
    // extension accepts another.
    const first = reg.issuePairing('user-a');
    const second = reg.issuePairing('user-a');
    expect(second.code).not.toBe(first.code);
    expect(reg.redeemPairing(first.code).ok).toBe(false);
    expect(reg.redeemPairing(second.code).ok).toBe(true);
  });

  it('resolves a redeemed token and revokes it on demand', () => {
    const offer = reg.issuePairing('user-a');
    const r = reg.redeemPairing(offer.code);
    if (!r.ok) throw new Error('expected redemption to succeed');

    expect(reg.resolveToken(r.token)).toEqual({ userId: 'user-a', sessionId: offer.sessionId });
    expect(reg.resolveToken('st_deadbeef')).toBeNull();
    expect(reg.resolveToken('')).toBeNull();

    expect(reg.revokeToken(r.token)).toBe(true);
    expect(reg.resolveToken(r.token)).toBeNull();
  });
});

describe('SessionHandoff — secretsMatch', () => {
  it('matches identical secrets and rejects different ones', () => {
    expect(secretsMatch('abcdefgh', 'abcdefgh')).toBe(true);
    expect(secretsMatch('abcdefgh', 'abcdefgi')).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual THROWS on unequal lengths. An attacker controls the
    // length, so an unguarded call is a remote crash, not just a bug.
    expect(() => secretsMatch('short', 'muchlongersecret')).not.toThrow();
    expect(secretsMatch('short', 'muchlongersecret')).toBe(false);
  });

  it('treats empty and nullish input as no match', () => {
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(undefined as unknown as string, '')).toBe(false);
  });
});

describe('SessionHandoff — code normalisation agrees with the extension', () => {
  const cases = [
    ' abcd-efgh ', 'abcd efgh', 'ABCD-EFGH', 'abcdefgh',
    'ab cd-ef gh', '', 'zzz', 'abcd-efgh-ijkl',
  ];

  it('produces identical output on both sides', () => {
    // One rule, two implementations. This is the only thing standing between a
    // refactor on one side and "invalid code" while staring at a valid code.
    for (const input of cases) {
      expect(ABCore.normalizePairingCode(input)).toBe(normalizePairingCode(input));
    }
  });

  it('upper-cases and strips separators', () => {
    expect(normalizePairingCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(ABCore.normalizePairingCode(' abcd-efgh ')).toBe('ABCDEFGH');
  });

  it('accepts a normalised code as well-formed on the extension side', () => {
    expect(ABCore.looksLikePairingCode('abcd-efgh')).toBe(true);
    expect(ABCore.looksLikePairingCode('ABCDEFGH')).toBe(true);
    expect(ABCore.looksLikePairingCode('ABCDEFG')).toBe(false);
    expect(ABCore.looksLikePairingCode('')).toBe(false);
  });

  it('formats a code for reading without changing its meaning', () => {
    const pretty = formatPairingCode('ABCDEFGH');
    expect(pretty).toContain('-');
    // Round-trips: what we show can be typed straight back in.
    expect(normalizePairingCode(pretty)).toBe('ABCDEFGH');
  });
});

describe('SessionHandoff — snapshots preserve what the user was looking at', () => {
  it('keeps tab order exactly as given', () => {
    const urls = ['https://a.example', 'https://b.example', 'https://c.example'];
    const snap = buildSnapshot({
      sessionId: 'as_x', fromMode: 'remote', tabs: urls.map((url) => ({ url })),
    });
    expect(snap.tabs.map((t) => t.url)).toEqual(urls);
  });

  it('carries exactly one active tab', () => {
    const snap = buildSnapshot({
      sessionId: 'as_x',
      fromMode: 'remote',
      tabs: [
        { url: 'https://a.example' },
        { url: 'https://b.example', active: true },
        { url: 'https://c.example' },
      ],
    });
    expect(snap.tabs.filter((t) => t.active).length).toBe(1);
    expect(snap.tabs.findIndex((t) => t.active)).toBe(1);
  });

  it('drops tabs whose scheme must never be reopened', () => {
    // A snapshot is replayed into the user's OWN browser. file:// would read
    // their disk and javascript: would execute in whatever context it lands in.
    const snap = buildSnapshot({
      sessionId: 'as_x',
      fromMode: 'remote',
      tabs: [
        { url: 'https://ok.example' },
        { url: 'file:///etc/passwd' },
        { url: 'javascript:alert(1)' },
        { url: 'data:text/html,<h1>x' },
        { url: '' },
      ],
    });
    expect(snap.tabs.map((t) => t.url)).toEqual(['https://ok.example']);
  });

  it('reports capped tabs instead of silently losing them', () => {
    const many = Array.from({ length: MAX_SAVED_TABS + 4 }, (_, i) => ({
      url: `https://n${i}.example`,
    }));
    const snap = buildSnapshot({ sessionId: 'as_x', fromMode: 'remote', tabs: many });
    expect(snap.tabs.length).toBe(MAX_SAVED_TABS);
    expect(snap.limits.notes).toContain('tabs_capped');
    expect(snap.limits.tabsDropped).toBe(4);
  });

  it('flags missing storage so the UI can warn about signing in again', () => {
    const bare = buildSnapshot({
      sessionId: 'as_x', fromMode: 'remote', tabs: [{ url: 'https://a.example' }],
    });
    expect(bare.limits.notes).toContain('storage_unavailable');
    expect(bare.storage).toBeUndefined();

    const withCookies = buildSnapshot({
      sessionId: 'as_x',
      fromMode: 'remote',
      tabs: [{ url: 'https://a.example' }],
      storage: { cookies: [{ name: 's', value: '1', domain: 'a.example', path: '/' }] } as never,
    });
    expect(withCookies.limits.notes).not.toContain('storage_unavailable');
    expect(withCookies.storage).toBeDefined();
  });

  it('flags an empty tab list rather than pretending it succeeded', () => {
    const snap = buildSnapshot({ sessionId: 'as_x', fromMode: 'local', tabs: [] });
    expect(snap.limits.notes).toContain('no_tabs');
  });

  it('records which side the snapshot came from, both directions', () => {
    expect(buildSnapshot({ sessionId: 'as_x', fromMode: 'remote', tabs: [] }).fromMode)
      .toBe('remote');
    // The reverse switch is a first-class case, not an afterthought.
    expect(buildSnapshot({ sessionId: 'as_x', fromMode: 'local', tabs: [] }).fromMode)
      .toBe('local');
  });

  it('treats a snapshot as stale past its TTL', () => {
    const t0 = 5_000_000;
    const snap = buildSnapshot({ sessionId: 'as_x', fromMode: 'remote', tabs: [], now: t0 });
    expect(snapshotIsFresh(snap, t0)).toBe(true);
    expect(snapshotIsFresh(snap, t0 + SNAPSHOT_TTL_MS)).toBe(true);
    expect(snapshotIsFresh(snap, t0 + SNAPSHOT_TTL_MS + 1)).toBe(false);
    expect(snapshotIsFresh(null)).toBe(false);
  });

  it('counts dropped tabs from the raw input, not the kept list', () => {
    expect(describeLimits(5, [{ url: 'https://a.example' }], true).tabsDropped).toBe(4);
    expect(describeLimits(1, [{ url: 'https://a.example' }], true).notes).toEqual([]);
  });
});

describe('SessionHandoff — snapshot storage in the registry', () => {
  let reg: SessionHandoffRegistry;

  beforeEach(() => {
    reg = new SessionHandoffRegistry();
  });

  const snapFor = (reg2: SessionHandoffRegistry, userId: string, now?: number) => buildSnapshot({
    sessionId: reg2.sessionId(userId),
    fromMode: 'remote',
    tabs: [{ url: 'https://a.example', active: true }],
    now,
  });

  it('peeks without consuming, so a failed restore can retry', () => {
    reg.putSnapshot('user-a', snapFor(reg, 'user-a'));
    expect(reg.peekSnapshot('user-a')).not.toBeNull();
    // The whole reason /pull peeks by default: Chrome can recycle the service
    // worker mid-restore, and the second attempt must still find the tabs.
    expect(reg.peekSnapshot('user-a')).not.toBeNull();
  });

  it('drains only when explicitly asked', () => {
    reg.putSnapshot('user-a', snapFor(reg, 'user-a'));
    expect(reg.takeSnapshot('user-a')).not.toBeNull();
    expect(reg.peekSnapshot('user-a')).toBeNull();
  });

  it('never hands one user another user snapshot', () => {
    reg.putSnapshot('user-a', snapFor(reg, 'user-a'));
    expect(reg.peekSnapshot('user-b')).toBeNull();
  });

  it('hides a snapshot that has aged out', () => {
    const t0 = 9_000_000;
    reg.putSnapshot('user-a', snapFor(reg, 'user-a', t0));
    expect(reg.peekSnapshot('user-a', t0 + SNAPSHOT_TTL_MS)).not.toBeNull();
    expect(reg.peekSnapshot('user-a', t0 + SNAPSHOT_TTL_MS + 1)).toBeNull();
  });

  it('clears a snapshot when a switch completes or is cancelled', () => {
    reg.putSnapshot('user-a', snapFor(reg, 'user-a'));
    reg.clearSnapshot('user-a');
    expect(reg.peekSnapshot('user-a')).toBeNull();
  });

  it('sweeps expired pairings and snapshots but keeps the session id', () => {
    const t0 = 1_000_000;
    const sid = reg.sessionId('user-a');
    const offer = reg.issuePairing('user-a', t0);
    reg.putSnapshot('user-a', snapFor(reg, 'user-a', t0));

    reg.sweep(t0 + SNAPSHOT_TTL_MS + PAIRING_TTL_MS + 1);

    expect(reg.redeemPairing(offer.code).ok).toBe(false);
    expect(reg.peekSnapshot('user-a')).toBeNull();
    // Sweeping garbage must not silently end the automation session.
    expect(reg.sessionId('user-a')).toBe(sid);
  });
});

describe('SessionHandoff — the extension restore plan', () => {
  it('opens every tab unfocused and points at the one to focus', () => {
    // Chrome focuses a newly created tab by default, so a plan that marked tabs
    // active would leave the LAST one in front instead of the user's tab.
    const snap = buildSnapshot({
      sessionId: 'as_x',
      fromMode: 'remote',
      tabs: [
        { url: 'https://a.example' },
        { url: 'https://b.example', active: true },
        { url: 'https://c.example' },
      ],
    });
    const plan = ABCore.planTabRestore(snap);

    expect(plan.count).toBe(3);
    expect(plan.tabs.map((t: { url: string }) => t.url))
      .toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
    expect(plan.tabs.every((t: { active: boolean }) => t.active === false)).toBe(true);
    expect(plan.focusIndex).toBe(1);
  });

  it('indexes the focus against the KEPT tabs, not the original list', () => {
    // An unsafe URL before the active tab shifts every later index down. Using
    // the original index here would focus the wrong page.
    const plan = ABCore.planTabRestore({
      tabs: [
        { url: 'file:///secret' },
        { url: 'https://a.example' },
        { url: 'https://b.example', active: true },
      ],
    });
    expect(plan.count).toBe(2);
    expect(plan.focusIndex).toBe(1);
    expect(plan.tabs[plan.focusIndex].url).toBe('https://b.example');
  });

  it('falls back to the first tab when nothing was marked active', () => {
    const plan = ABCore.planTabRestore({ tabs: [{ url: 'https://a.example' }] });
    expect(plan.focusIndex).toBe(0);
  });

  it('returns an empty, harmless plan for junk input', () => {
    for (const bad of [null, undefined, {}, { tabs: null }, { tabs: [] }]) {
      const plan = ABCore.planTabRestore(bad);
      expect(plan.count).toBe(0);
      expect(plan.tabs).toEqual([]);
      expect(plan.focusIndex).toBe(-1);
    }
  });

  it('turns limit keys into a sentence, and silence into silence', () => {
    expect(ABCore.describeHandoffLimits({ notes: [], tabsDropped: 0 })).toBe('');
    expect(ABCore.describeHandoffLimits(null)).toBe('');

    const msg = ABCore.describeHandoffLimits({
      notes: ['tabs_capped', 'storage_unavailable'], tabsDropped: 3,
    });
    expect(msg).toContain('3');
    expect(msg).toContain('sign in again');
  });

  it('builds the handoff URLs the routes actually serve', () => {
    // Trailing slash included on purpose: a double slash would 404.
    for (const base of ['http://localhost:3000', 'http://localhost:3000/']) {
      expect(ABCore.buildPairUrl(base)).toBe('http://localhost:3000/browser-mode/handoff/pair');
      expect(ABCore.buildPullUrl(base)).toBe('http://localhost:3000/browser-mode/handoff/pull');
      expect(ABCore.buildCompleteUrl(base))
        .toBe('http://localhost:3000/browser-mode/handoff/complete');
    }
  });
});
