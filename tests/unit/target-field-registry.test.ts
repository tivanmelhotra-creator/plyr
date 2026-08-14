import { describe, it, expect, beforeEach } from 'vitest';
import {
  TargetFieldRegistry,
  TARGETS_MAX,
  TARGET_TTL_MS,
} from '../../src/core/TargetFieldRegistry';
import { isDeclaredField } from '../../src/core/ActionCatalog';

// ════════════════════════════════════════════════════════════════
// TargetFieldRegistry — "where does this picked value land?"
//
// These tests measure BEHAVIOUR, not the presence of strings in the source:
// every case registers, resolves or unregisters for real and asserts on what
// came back. That matters most for the authorization rules, because the failure
// they prevent (a value written into someone else's field, or into a param that
// is silently dropped on save) is invisible at pick time.
//
// The eight cases the requirement names explicitly are marked [REQ n].
// ════════════════════════════════════════════════════════════════

const USER = 'user-a';
const OTHER = 'user-b';

// `click` really declares `selector`, and `extract` really declares `name`.
// Asserted here so a catalogue change that invalidates the fixtures fails LOUDLY
// in one obvious place instead of making every case below mysteriously refuse.
describe('the fixtures these tests rely on are real', () => {
  it('uses action/field pairs the shipped catalogue actually declares', () => {
    expect(isDeclaredField('click', 'selector')).toBe(true);
    expect(isDeclaredField('extract', 'name')).toBe(true);
    expect(isDeclaredField('click', 'definitely_not_a_field')).toBe(false);
  });
});

describe('registering a Target Field', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  // [REQ 1] A Target Field can be registered.
  it('registers a field and hands back a resolvable id', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(r.ok).toBe(true);
    expect(r.target).toBeDefined();

    const found = reg.resolve(USER, r.target!.targetFieldId);
    expect(found).not.toBeNull();
    expect(found!.nodeId).toBe('n8');
    expect(found!.fieldKey).toBe('selector');
  });

  it('mints an id in the node_<nodeId>__<fieldKey>__<suffix> shape', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(r.target!.targetFieldId).toMatch(/^node_n8__selector__[0-9a-f]{8}$/);
  });

  it('gives two registrations of the same field DIFFERENT suffixes', () => {
    // The suffix is what makes an old id stale. Two identical ids would mean a
    // destination the user closed could still be addressed by its old handle.
    const a = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const b = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(a.target!.targetFieldId).not.toBe(b.target!.targetFieldId);
  });

  it('keeps the label and workflow for a confirmation that names the destination', () => {
    const r = reg.register(USER, {
      nodeId: 'n8', fieldKey: 'selector', action: 'click',
      workflowId: 'wf-1', label: 'Click → Selector',
    });
    const t = reg.resolve(USER, r.target!.targetFieldId)!;
    expect(t.label).toBe('Click → Selector');
    expect(t.workflowId).toBe('wf-1');
  });
});

describe('fieldKey must be a DECLARED param of the node action', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  it('refuses a field the action does not declare', () => {
    // This is the silent-drop guard: coerceParams() copies only declared keys,
    // so an undeclared one would show as filled and vanish on save.
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'made_up_param', action: 'click' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('undeclared_field');
  });

  it('names what the action does declare, so the error is actionable', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'made_up_param', action: 'click' });
    expect(r.declared).toContain('selector');
  });

  it('refuses an action that is not in the catalogue at all', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'no-such-action' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_action');
  });

  it('refuses a field that is declared by a DIFFERENT action', () => {
    // `name` is real on `extract` but not on `click`. Accepting it because it
    // exists somewhere would defeat the whole check.
    expect(isDeclaredField('extract', 'name')).toBe(true);
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'name', action: 'click' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('undeclared_field');
  });

  it('does not register anything when it refuses', () => {
    reg.register(USER, { nodeId: 'n8', fieldKey: 'made_up_param', action: 'click' });
    expect(reg.list(USER)).toHaveLength(0);
  });
});

describe('ids that could confuse the format are refused', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  it('refuses a nodeId containing the __ separator', () => {
    // Otherwise node_a__b + field c is indistinguishable from node_a + field b__c.
    const r = reg.register(USER, { nodeId: 'a__b', fieldKey: 'selector', action: 'click' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_node_id');
  });

  it('refuses a fieldKey containing the __ separator', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'sel__ector', action: 'click' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_field_key');
  });

  it('refuses an empty nodeId', () => {
    expect(reg.register(USER, { nodeId: '', fieldKey: 'selector', action: 'click' }).reason)
      .toBe('invalid_node_id');
  });

  it('refuses junk characters in a nodeId', () => {
    for (const bad of ['n 8', 'n"8', 'n/8', '../x', 'n<8']) {
      const r = reg.register(USER, { nodeId: bad, fieldKey: 'selector', action: 'click' });
      expect(r.ok, `nodeId ${JSON.stringify(bad)} must be refused`).toBe(false);
    }
  });

  it('refuses an empty userId', () => {
    const r = reg.register('', { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(r.ok).toBe(false);
  });
});

describe('a Target Field belongs to exactly one user', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  // [REQ 2] A Target Field cannot be used by another user.
  //
  // Driven straight against the registry with two DIFFERENT userIds on purpose.
  // Going through the HTTP route would prove nothing here: in single-user
  // deployments `resolveUserId()` returns the same fixed id for every request,
  // so a route-level test would pass even if this scoping did not exist.
  it('does not resolve another user\'s target', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.resolve(OTHER, r.target!.targetFieldId)).toBeNull();
  });

  it('still resolves it for its owner', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.resolve(USER, r.target!.targetFieldId)).not.toBeNull();
  });

  it('does not let another user unregister it', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.unregister(OTHER, r.target!.targetFieldId)).toBe(false);
    expect(reg.resolve(USER, r.target!.targetFieldId)).not.toBeNull();
  });

  it('keeps two users\' identically-shaped targets apart', () => {
    const a = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const b = reg.register(OTHER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.resolve(OTHER, a.target!.targetFieldId)).toBeNull();
    expect(reg.resolve(USER, b.target!.targetFieldId)).toBeNull();
    expect(reg.list(USER)).toHaveLength(1);
    expect(reg.list(OTHER)).toHaveLength(1);
  });
});

describe('a stale Target Field is refused', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  // [REQ 3] An old Target Field is rejected.
  it('does not resolve an unregistered target', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    reg.unregister(USER, r.target!.targetFieldId);
    expect(reg.resolve(USER, r.target!.targetFieldId)).toBeNull();
  });

  it('does not resolve a superseded suffix after the field re-registers', () => {
    // The stale guard the uniqueSuffix exists for: same node, same field, new
    // registration. The OLD handle must stop working.
    const first = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const second = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.resolve(USER, first.target!.targetFieldId)).toBeNull();
    expect(reg.resolve(USER, second.target!.targetFieldId)).not.toBeNull();
  });

  it('leaves exactly one live target after a re-registration', () => {
    reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.list(USER)).toHaveLength(1);
  });

  it('refuses an id that was never registered, however well-formed', () => {
    // The forgery case. The format is guessable; the registry is the authority.
    expect(reg.resolve(USER, 'node_n8__selector__deadbeef')).toBeNull();
  });

  it('expires a target once its TTL has passed', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const id = r.target!.targetFieldId;
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + TARGET_TTL_MS + 1000;
      expect(reg.resolve(USER, id)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('several Target Fields coexist for one user', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  // [REQ 5] Two Target Fields can be registered at once for one user.
  it('keeps two different fields of the same node alive together', () => {
    const a = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const b = reg.register(USER, { nodeId: 'n8', fieldKey: 'timeout', action: 'click' });
    expect(a.ok && b.ok).toBe(true);
    expect(reg.resolve(USER, a.target!.targetFieldId)).not.toBeNull();
    expect(reg.resolve(USER, b.target!.targetFieldId)).not.toBeNull();
  });

  it('keeps fields of two different nodes alive together', () => {
    const a = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const b = reg.register(USER, { nodeId: 'n9', fieldKey: 'name', action: 'extract' });
    expect(reg.list(USER)).toHaveLength(2);
    expect(reg.resolve(USER, a.target!.targetFieldId)!.nodeId).toBe('n8');
    expect(reg.resolve(USER, b.target!.targetFieldId)!.nodeId).toBe('n9');
  });

  // [REQ 8-adjacent] Unregistering one target must not disturb another.
  it('unregistering one target leaves the other working', () => {
    const a = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const b = reg.register(USER, { nodeId: 'n9', fieldKey: 'name', action: 'extract' });
    expect(reg.unregister(USER, a.target!.targetFieldId)).toBe(true);
    expect(reg.resolve(USER, a.target!.targetFieldId)).toBeNull();
    expect(reg.resolve(USER, b.target!.targetFieldId)).not.toBeNull();
  });

  it('re-registering one field does not disturb a different field', () => {
    const keep = reg.register(USER, { nodeId: 'n9', fieldKey: 'name', action: 'extract' });
    reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    expect(reg.resolve(USER, keep.target!.targetFieldId)).not.toBeNull();
  });

  it('caps runaway growth by evicting the oldest, keeping the newest', () => {
    const ids: string[] = [];
    for (let i = 0; i < TARGETS_MAX + 5; i++) {
      const r = reg.register(USER, { nodeId: `n${i}`, fieldKey: 'selector', action: 'click' });
      ids.push(r.target!.targetFieldId);
    }
    expect(reg.list(USER).length).toBeLessThanOrEqual(TARGETS_MAX);
    // The one registered last is the one the user is looking at.
    expect(reg.resolve(USER, ids[ids.length - 1]!)).not.toBeNull();
    expect(reg.resolve(USER, ids[0]!)).toBeNull();
  });
});

describe('resolve returns stored facts, never client-supplied ones', () => {
  let reg: TargetFieldRegistry;
  beforeEach(() => { reg = new TargetFieldRegistry(); });

  it('reports the nodeId that was REGISTERED, not one spelled into the id', () => {
    // A caller that parsed the id would read `victim` here. The registry looks
    // the id up instead, so a forged string simply does not resolve.
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const forged = 'node_victim__selector__' + r.target!.targetFieldId.slice(-8);
    expect(reg.resolve(USER, forged)).toBeNull();
    expect(reg.resolve(USER, r.target!.targetFieldId)!.nodeId).toBe('n8');
  });

  it('hands out copies, so a caller cannot mutate the registry', () => {
    const r = reg.register(USER, { nodeId: 'n8', fieldKey: 'selector', action: 'click' });
    const first = reg.resolve(USER, r.target!.targetFieldId)!;
    first.fieldKey = 'hacked';
    expect(reg.resolve(USER, r.target!.targetFieldId)!.fieldKey).toBe('selector');
  });
});
