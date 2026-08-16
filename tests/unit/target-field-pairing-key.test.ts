import { describe, it, expect, beforeEach } from 'vitest';
import {
  TargetFieldRegistry,
  pairingKeyFor,
} from '../../src/core/TargetFieldRegistry';

// ════════════════════════════════════════════════════════════════
// TWO IDENTITIES ON ONE DESTINATION
//
// THE BUG THIS FILE EXISTS TO KEEP FIXED
// --------------------------------------
// The requirement asks for two things that one id cannot deliver at once:
//
//   (a) re-opening the SAME field must not ask for another Authorization Code;
//   (b) a pick made against a destination the user has since closed must not
//       land.
//
// (a) wants an identity that does not change. (b) wants one that does. Serving
// both from `targetFieldId` is precisely why the previous build demanded a code
// on every single NDV open: `register()` mints a fresh random suffix each time,
// the binding was filed under it, so the "same" field was never the same field.
//
// So there are now two:
//
//   targetFieldId  ephemeral delivery ADDRESS   — re-minted, keeps (b) true
//   pairingKey     stable authorization IDENTITY — derived, keeps (a) true
//
// These tests hold that split in place. A future refactor that made the pairing
// key random, or the target id stable, would break one half of the requirement
// silently — and fail here loudly.
// ════════════════════════════════════════════════════════════════

const USER = 'user-a';

describe('pairingKeyFor — the stable authorization identity', () => {
  it('is identical for the same workflow/node/field, every time', () => {
    // The whole persistence story rests on this one property.
    expect(pairingKeyFor('n8', 'selector', 'wf1'))
      .toBe(pairingKeyFor('n8', 'selector', 'wf1'));
  });

  it('contains no randomness at all', () => {
    const keys = new Set(
      Array.from({ length: 25 }, () => pairingKeyFor('n8', 'selector', 'wf1')),
    );
    expect(keys.size).toBe(1);
  });

  // [REQ] The operator's own example: a DIFFERENT target needs new pairing.
  it('differs for a different field on the same node', () => {
    expect(pairingKeyFor('n8', 'product_selector', 'wf1'))
      .not.toBe(pairingKeyFor('n8', 'product_url', 'wf1'));
  });

  it('differs for the same field on a different node', () => {
    expect(pairingKeyFor('node_8f21', 'selector', 'wf1'))
      .not.toBe(pairingKeyFor('node_92aa', 'selector', 'wf1'));
  });

  it('differs across workflows, so one workflow’s pairing is not another’s', () => {
    expect(pairingKeyFor('n8', 'selector', 'wf1'))
      .not.toBe(pairingKeyFor('n8', 'selector', 'wf2'));
  });

  it('is stable for an unsaved workflow, and cannot be confused with a real one', () => {
    const anon = pairingKeyFor('n8', 'selector', undefined);
    expect(anon).toBe(pairingKeyFor('n8', 'selector', ''));
    // A workflow literally named "-" is impossible — validIdPart forbids a
    // leading dash — so the placeholder cannot collide with a real id.
    expect(anon).toContain(':-:');
  });
});

describe('the registry records BOTH identities', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  it('mints a fresh ADDRESS but keeps the IDENTITY constant across re-opens', () => {
    // This single case is the fix, stated in one place.
    const first = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
    }).target!;
    const second = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
    }).target!;

    expect(second.targetFieldId).not.toBe(first.targetFieldId); // (b) stale-proof
    expect(second.pairingKey).toBe(first.pairingKey);           // (a) persistent
  });

  it('derives the pairing key from the same facts a pre-flight caller has', () => {
    // The chooser asks "is this already paired?" BEFORE any target exists, so
    // it must be able to compute the key without registering one. If these two
    // ever disagreed, the answer would always be "no" and the code would come
    // back on every open.
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
    }).target!;
    expect(t.pairingKey).toBe(pairingKeyFor('n8', 'selector', 'wf1'));
  });

  it('gives two different fields two different pairing keys', () => {
    const a = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
    }).target!;
    const b = reg.register(USER, {
      nodeId: 'n9', fieldKey: 'name', action: 'extract', workflowId: 'wf1',
    }).target!;
    expect(a.pairingKey).not.toBe(b.pairingKey);
  });

  it('exposes the pairing key through resolve(), not just at registration', () => {
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click',
    }).target!;
    expect(reg.resolve(USER, t.targetFieldId)!.pairingKey).toBe(t.pairingKey);
  });
});

describe('the registry records the chosen environment', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  it('stores LOCAL when the user chose LOCAL', () => {
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', environment: 'local',
    }).target!;
    expect(t.environment).toBe('local');
    expect(reg.resolve(USER, t.targetFieldId)!.environment).toBe('local');
  });

  it('stores REMOTE when the user chose REMOTE', () => {
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', environment: 'remote',
    }).target!;
    expect(t.environment).toBe('remote');
  });

  it('defaults to REMOTE, so callers written before the chooser are unchanged', () => {
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click',
    }).target!;
    expect(t.environment).toBe('remote');
  });

  it('coerces a garbled environment rather than refusing the registration', () => {
    // A destination is still useful with a defaulted environment; refusing
    // would lose the user's pick over a cosmetic field.
    const r = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', environment: 'sideways',
    });
    expect(r.ok).toBe(true);
    expect(r.target!.environment).toBe('remote');
  });

  it('lets the same field be re-targeted in the other environment', () => {
    // Switching environment is a normal act, not an error: the pairing belongs
    // to the FIELD, so the key survives while the environment changes.
    const local = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
      environment: 'local',
    }).target!;
    const remote = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
      environment: 'remote',
    }).target!;

    expect(remote.environment).toBe('remote');
    expect(remote.pairingKey).toBe(local.pairingKey);
  });
});

describe('finding a destination without holding its id', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  it('finds the live target for a node+field', () => {
    // The Targeting flow works forwards from "node n1, field selector" while
    // delivery works backwards from an id; without this the front-end would
    // have to remember the id and a reload would lose it.
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click',
    }).target!;
    expect(reg.find(USER, 'n8', 'selector')!.targetFieldId).toBe(t.targetFieldId);
  });

  it('returns null for a node+field with nothing open', () => {
    expect(reg.find(USER, 'n8', 'selector')).toBeNull();
  });

  it('resolves by pairing key', () => {
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
    }).target!;
    expect(reg.resolveByPairingKey(USER, t.pairingKey)!.targetFieldId)
      .toBe(t.targetFieldId);
  });

  it('never believes a forged pairing key', () => {
    // Same rule as resolve(): keys are matched against stored records, never
    // parsed for facts, so spelling the format buys nothing.
    reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.resolveByPairingKey(USER, 'tf:-:n8:password')).toBeNull();
  });

  it('keeps one user’s destinations invisible to another', () => {
    const t = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click',
    }).target!;
    expect(reg.find('user-b', 'n8', 'selector')).toBeNull();
    expect(reg.resolveByPairingKey('user-b', t.pairingKey)).toBeNull();
  });
});
