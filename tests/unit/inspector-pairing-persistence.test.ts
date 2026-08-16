import { describe, it, expect, beforeEach } from 'vitest';
import {
  InspectorAuthorizationRegistry,
  PAIRING_TTL_MS,
  BINDING_TTL_MS,
} from '../../src/core/InspectorAuthorization';

// ════════════════════════════════════════════════════════════════
// THE DURABLE PAIRING — «دفعات بعد دیگر Authorization Code لازم نیست»
//
// WHY THIS IS A SEPARATE FILE FROM inspector-authorization.test.ts
// ---------------------------------------------------------------
// That file tests the CODE: single use, short TTL, one target at a time. This
// one tests what the code LEAVES BEHIND, and the two have deliberately
// different lifetimes and different keys:
//
//   BINDING  clientId → targetFieldId   "may write to this ADDRESS"  (hours)
//   PAIRING  clientId → pairingKey      "knows this FIELD"           (weeks)
//
// Merging them is exactly how the previous build lost the relationship every
// time a node was closed: `register()` mints a new address on each NDV open and
// `target/release` revoked the binding on every close, so trust evaporated
// twice per visit. Keeping the pairing on a key that does not change is the
// whole fix, and these cases are what stop it regressing.
// ════════════════════════════════════════════════════════════════

const USER = 'user-a';
const OTHER = 'user-b';
const KEY = 'ak_live_aaaaaaaaaaaaaaaa';
const KEY2 = 'ak_live_bbbbbbbbbbbbbbbb';

// Two addresses for ONE field — what re-opening the same node produces.
const ADDR_1 = 'node_8f21__product_selector__a73f';
const ADDR_2 = 'node_8f21__product_selector__c91d';
const PK = 'tf:wf1:8f21:product_selector';

// A genuinely different field, from the operator's own example.
const OTHER_ADDR = 'node_92aa__product_url__b14c';
const OTHER_PK = 'tf:wf1:92aa:product_url';

describe('redeeming a code creates a pairing that outlives the address', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('files the pairing under the STABLE key, not the address', () => {
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    expect(offer.pairingKey).toBe(PK);
    expect(auth.redeem(KEY, offer.code).ok).toBe(true);

    expect(auth.isPaired(KEY, USER, PK)).toBe(true);
  });

  // [REQ] The operator's scenario, start to finish.
  it('needs NO second code when the same field comes back with a new address', () => {
    // First visit: pair.
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    auth.redeem(KEY, offer.code);

    // The node is closed. The address dies with it — that is by design.
    auth.revoke(ADDR_1);
    expect(auth.isAuthorized(KEY, USER, ADDR_1)).toBe(false);

    // Second visit: a brand-new address for the very same field…
    expect(auth.isPaired(KEY, USER, PK)).toBe(true);   // …and the trust survived.

    // So the server re-points it instead of asking for anything.
    expect(auth.rebind(KEY, USER, ADDR_2, PK)).not.toBeNull();
    expect(auth.isAuthorized(KEY, USER, ADDR_2)).toBe(true);
  });

  // [REQ] «اگر کاربر Target Field جدیدی انتخاب کند، برای آن نیاز به
  //        Authorization/Pairing جدید است.»
  it('does NOT extend the pairing to a different field', () => {
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    auth.redeem(KEY, offer.code);

    expect(auth.isPaired(KEY, USER, OTHER_PK)).toBe(false);
    expect(auth.rebind(KEY, USER, OTHER_ADDR, OTHER_PK)).toBeNull();
  });

  it('does not extend one extension’s pairing to a different extension', () => {
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    auth.redeem(KEY, offer.code);
    expect(auth.isPaired(KEY2, USER, PK)).toBe(false);
  });

  it('does not extend a pairing across accounts', () => {
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    auth.redeem(KEY, offer.code);
    expect(auth.isPaired(KEY, OTHER, PK)).toBe(false);
  });

  it('falls back to the address as its own key when no pairing key is given', () => {
    // Every caller written before this change keeps working, just without the
    // persistence it never had.
    const offer = auth.issue(USER, ADDR_1)!;
    expect(offer.pairingKey).toBe(ADDR_1);
    auth.redeem(KEY, offer.code);
    expect(auth.isPaired(KEY, USER, ADDR_1)).toBe(true);
  });
});

describe('revoking an address does not unpair the field', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('keeps the pairing when the binding is revoked', () => {
    // `revoke` fires on every NDV close, including the sendBeacon on page
    // unload. If it took the pairing with it, the user would be asked for a
    // code every time they refreshed the tab.
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    auth.redeem(KEY, offer.code);

    auth.revoke(ADDR_1);
    expect(auth.isAuthorized(KEY, USER, ADDR_1)).toBe(false);
    expect(auth.isPaired(KEY, USER, PK)).toBe(true);
  });

  it('drops the pairing only when the user explicitly unpairs', () => {
    const offer = auth.issue(USER, ADDR_1, Date.now(), PK)!;
    auth.redeem(KEY, offer.code);

    expect(auth.unpair(PK)).toBe(1);
    expect(auth.isPaired(KEY, USER, PK)).toBe(false);
  });

  it('unpairing one field leaves another field paired', () => {
    auth.redeem(KEY, auth.issue(USER, ADDR_1, Date.now(), PK)!.code);
    auth.redeem(KEY, auth.issue(USER, OTHER_ADDR, Date.now(), OTHER_PK)!.code);

    auth.unpair(PK);
    expect(auth.isPaired(KEY, USER, PK)).toBe(false);
    expect(auth.isPaired(KEY, USER, OTHER_PK)).toBe(true);
  });
});

describe('grant() — the REMOTE branch, with no code', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  // [REQ] «برای REMOTE BROWSER نیازی به Authorization Code نیست.»
  it('authorizes immediately, with no code ever issued', () => {
    const binding = auth.grant(KEY, USER, ADDR_1, PK);
    expect(binding).not.toBeNull();
    expect(auth.isAuthorized(KEY, USER, ADDR_1)).toBe(true);
    // Nothing was put on screen for the user to type.
    expect(auth.pendingCount()).toBe(0);
  });

  it('records WHY it was granted, so a status view can tell the truth', () => {
    auth.grant(KEY, USER, ADDR_1, PK);
    const [pairing] = auth.pairingsFor(KEY);
    expect(pairing.via).toBe('server');

    // …and a code-redeemed one is distinguishable from it.
    const auth2 = new InspectorAuthorizationRegistry();
    auth2.redeem(KEY, auth2.issue(USER, ADDR_1, Date.now(), PK)!.code);
    expect(auth2.pairingsFor(KEY)[0].via).toBe('code');
  });

  it('is still scoped to one field and one account', () => {
    // "No code" is not "no boundaries". A server grant for one field must not
    // become a licence to write anywhere.
    auth.grant(KEY, USER, ADDR_1, PK);
    expect(auth.isAuthorized(KEY, USER, OTHER_ADDR)).toBe(false);
    expect(auth.isAuthorized(KEY, OTHER, ADDR_1)).toBe(false);
    expect(auth.isAuthorized(KEY2, USER, ADDR_1)).toBe(false);
  });

  it('refuses to grant on missing inputs rather than inventing them', () => {
    expect(auth.grant('', USER, ADDR_1, PK)).toBeNull();
    expect(auth.grant(KEY, '', ADDR_1, PK)).toBeNull();
    expect(auth.grant(KEY, USER, '', PK)).toBeNull();
  });
});

describe('the dashboard asks the pairing question with a different key', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('answers for the USER, not for one specific extension', () => {
    // The dashboard is deciding whether to put a code on screen and cannot know
    // which extension the user will type it into. If the answer required a
    // matching key, a two-key setup would be handed a code for a pairing that
    // already exists — the papercut this change removes.
    auth.redeem(KEY, auth.issue(USER, ADDR_1, Date.now(), PK)!.code);

    expect(auth.isPaired(KEY2, USER, PK)).toBe(false);      // that extension: no
    expect(auth.isPairedForUser(USER, PK)).toBe(true);      // the account: yes
  });

  it('still leaks nothing across accounts', () => {
    auth.redeem(KEY, auth.issue(USER, ADDR_1, Date.now(), PK)!.code);
    expect(auth.isPairedForUser(OTHER, PK)).toBe(false);
  });

  it('re-points every paired client at the new address in one call', () => {
    auth.redeem(KEY, auth.issue(USER, ADDR_1, Date.now(), PK)!.code);
    auth.redeem(KEY2, auth.issue(USER, ADDR_1, Date.now(), PK)!.code);

    expect(auth.rebindForUser(USER, ADDR_2, PK)).toBe(2);
    expect(auth.isAuthorized(KEY, USER, ADDR_2)).toBe(true);
    expect(auth.isAuthorized(KEY2, USER, ADDR_2)).toBe(true);
  });

  it('re-points nothing when there was no pairing to begin with', () => {
    // Trust cannot be created by asking for it to be refreshed.
    expect(auth.rebindForUser(USER, ADDR_2, PK)).toBe(0);
    expect(auth.isAuthorized(KEY, USER, ADDR_2)).toBe(false);
  });
});

describe('the two lifetimes are genuinely different', () => {
  let auth: InspectorAuthorizationRegistry;
  beforeEach(() => { auth = new InspectorAuthorizationRegistry(); });

  it('outlives the binding TTL by a wide margin', () => {
    expect(PAIRING_TTL_MS).toBeGreaterThan(BINDING_TTL_MS);
  });

  it('survives long after the binding has aged out', () => {
    const t0 = 1_000;
    auth.redeem(KEY, auth.issue(USER, ADDR_1, t0, PK)!.code, t0);

    const later = t0 + BINDING_TTL_MS + 1;
    expect(auth.isAuthorized(KEY, USER, ADDR_1, later)).toBe(false); // address: gone
    expect(auth.isPaired(KEY, USER, PK, later)).toBe(true);          // field: known
  });

  it('does eventually expire, so an abandoned pairing is not immortal', () => {
    const t0 = 1_000;
    auth.redeem(KEY, auth.issue(USER, ADDR_1, t0, PK)!.code, t0);
    expect(auth.isPaired(KEY, USER, PK, t0 + PAIRING_TTL_MS + 1)).toBe(false);
  });

  it('refreshes the clock on a field still in active use', () => {
    const t0 = 1_000;
    auth.redeem(KEY, auth.issue(USER, ADDR_1, t0, PK)!.code, t0);

    // Used again just before it would have expired…
    const nearly = t0 + PAIRING_TTL_MS - 1;
    auth.rebind(KEY, USER, ADDR_2, PK, nearly);

    // …so it is still alive past the ORIGINAL deadline.
    expect(auth.isPaired(KEY, USER, PK, t0 + PAIRING_TTL_MS + 10)).toBe(true);
  });

  it('is cleared by sweep() once expired', () => {
    const t0 = 1_000;
    auth.redeem(KEY, auth.issue(USER, ADDR_1, t0, PK)!.code, t0);
    auth.sweep(t0 + PAIRING_TTL_MS + 1);
    expect(auth.pairingsFor(KEY)).toHaveLength(0);
  });
});

describe('pairings never expose the API key', () => {
  it('stores no raw credential a heap dump could read', () => {
    const auth = new InspectorAuthorizationRegistry();
    auth.grant(KEY, USER, ADDR_1, PK);
    expect(JSON.stringify(auth.pairingsFor(KEY))).not.toContain(KEY);
  });
});
