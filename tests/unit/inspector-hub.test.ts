import { describe, it, expect, beforeEach } from 'vitest';
import {
  InspectorHub,
  valueForKey,
  normalizeElement,
  summarizeSelection,
  type InspectorElement,
} from '../../src/core/InspectorHub';
import { TargetFieldRegistry } from '../../src/core/TargetFieldRegistry';
import { InspectorAuthorizationRegistry } from '../../src/core/InspectorAuthorization';
import { browserModes } from '../../src/core/BrowserMode';
import { SessionHandoffRegistry } from '../../src/core/SessionHandoff';

// ════════════════════════════════════════════════════════════════
// InspectorHub — the routing layer between a picked element and ONE FIELD.
//
// What these tests are actually defending:
//
//   1. The value lands in the field the REGISTRY names, and in no other. The
//      destination is resolved server-side from `targetFieldId`; the client's
//      idea of nodeId/fieldKey is never consulted. A value in the wrong param of
//      the right node fails silently at run time, which is far more expensive to
//      debug than a refusal at pick time.
//   2. Exactly ONE value is written. The radio decides what is sent; the
//      checkboxes only decide what is displayed. If `fields` ever gained a second
//      key, this layer would be deciding something it was not asked to decide.
//   3. Session is IRRELEVANT here. Neither a Session change nor a Local/Remote
//      switch may invalidate a Target Field — and the way that is guaranteed is
//      that this file cannot see either of them.
//   4. Attribute lookup stays generic. `valueForKey` falling back to the
//      element's own attribute list is what makes data-* work; a refactor to a
//      switch-only implementation would break the requirement invisibly.
//
// Both registries are injected, so every case below runs against isolated state
// rather than the process-wide singletons. That matters for the cross-user cases:
// in single-user deployments `resolveUserId()` returns a fixed 'local', so a
// route-level "other user" test would pass even with no scoping at all.
// ════════════════════════════════════════════════════════════════

function el(over: Partial<InspectorElement> = {}): InspectorElement {
  return {
    tag: 'a',
    id: 'buy',
    classes: ['btn', 'primary'],
    css: 'a#buy',
    xpath: '//*[@id="buy"]',
    text: 'Buy now',
    value: '',
    name: '',
    role: 'link',
    type: '',
    attrs: [
      { name: 'href', value: '/checkout' },
      { name: 'data-sku', value: 'SKU-1' },
      { name: 'data-anything-at-all', value: 'yes' },
    ],
    ...over,
  };
}

const API_KEY = 'ak_test_key_1';

/**
 * A hub with a live target and a redeemed pairing — the ordinary state in which
 * every send happens. Returns the pieces so a test can register a second target
 * or pair a second client without rebuilding the world.
 */
function paired(opts: { userId?: string; fieldKey?: string; action?: string } = {}) {
  const userId = opts.userId ?? 'u1';
  const registry = new TargetFieldRegistry();
  const auth = new InspectorAuthorizationRegistry();
  const hub = new InspectorHub(registry, auth);

  const reg = registry.register(userId, {
    nodeId: 'n1',
    fieldKey: opts.fieldKey ?? 'selector',
    action: opts.action ?? 'click',
  });
  if (!reg.ok || !reg.target) throw new Error(`fixture target rejected: ${reg.reason}`);

  const offer = auth.issue(userId, reg.target.targetFieldId);
  if (!offer) throw new Error('fixture offer not issued');
  const redeemed = auth.redeem(API_KEY, offer.code);
  if (!redeemed.ok) throw new Error('fixture pairing failed');

  return { hub, registry, auth, userId, target: reg.target };
}

// ════════════════════════════════════════════════════════════════
// The fixtures must stay real
// ════════════════════════════════════════════════════════════════

describe('the fixtures describe real declared fields', () => {
  it('click really declares selector, and extract really declares name', () => {
    // Every case below registers `click.selector` or `extract.name`. If the
    // action catalogue changed, the fixtures would start being rejected and the
    // failures would look like hub bugs. Assert the assumption once, here.
    const r = new TargetFieldRegistry();
    expect(r.register('u', { nodeId: 'n', fieldKey: 'selector', action: 'click' }).ok).toBe(true);
    expect(r.register('u', { nodeId: 'n', fieldKey: 'name', action: 'extract' }).ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// valueForKey — generic by construction
// ════════════════════════════════════════════════════════════════

describe('valueForKey: computed keys', () => {
  const e = el();
  it('serves the identity and content keys', () => {
    expect(valueForKey(e, 'tag')).toBe('a');
    expect(valueForKey(e, 'id')).toBe('buy');
    expect(valueForKey(e, 'class')).toBe('btn primary');
    expect(valueForKey(e, 'css')).toBe('a#buy');
    expect(valueForKey(e, 'xpath')).toBe('//*[@id="buy"]');
    expect(valueForKey(e, 'text')).toBe('Buy now');
    expect(valueForKey(e, 'role')).toBe('link');
  });
  it('accepts both the extension spellings and the spec §23 spellings', () => {
    expect(valueForKey(e, 'tagName')).toBe('a');
    expect(valueForKey(e, 'cssSelector')).toBe('a#buy');
    expect(valueForKey(e, 'innerText')).toBe('Buy now');
    expect(valueForKey(e, 'className')).toBe('btn primary');
  });
});

describe('valueForKey: the generic attribute path', () => {
  it('resolves any attribute by name, with no hardcoded list', () => {
    const e = el();
    expect(valueForKey(e, 'href')).toBe('/checkout');
    expect(valueForKey(e, 'data-sku')).toBe('SKU-1');
    // The whole point: an attribute this codebase has never heard of.
    expect(valueForKey(e, 'data-anything-at-all')).toBe('yes');
  });
  it('is case-insensitive about the key', () => {
    expect(valueForKey(el(), 'DATA-SKU')).toBe('SKU-1');
  });
  it('returns empty for an attribute the element does not have', () => {
    expect(valueForKey(el(), 'colspan')).toBe('');
  });
});

describe('normalizeElement', () => {
  it('requires only a tag', () => {
    const n = normalizeElement({ tag: 'div' });
    expect(n).toBeTruthy();
    expect(n!.tag).toBe('div');
  });
  it('rejects junk instead of inventing an element', () => {
    expect(normalizeElement(null)).toBeNull();
    expect(normalizeElement({})).toBeNull();
    expect(normalizeElement({ tag: '   ' })).toBeNull();
  });
  it('de-duplicates attribute names case-insensitively', () => {
    const n = normalizeElement({
      tag: 'div',
      attrs: [{ name: 'DATA-ID', value: 'a' }, { name: 'data-id', value: 'b' }],
    })!;
    expect(n.attrs).toHaveLength(1);
    expect(n.attrs![0]!.name).toBe('data-id');
  });
  it('collapses whitespace in text', () => {
    expect(normalizeElement({ tag: 'p', text: 'a  \n b' })!.text).toBe('a b');
  });
});

// ════════════════════════════════════════════════════════════════
// [REQ 4] The value lands in exactly the field the registry named
// ════════════════════════════════════════════════════════════════

describe('[REQ 4] the value lands in the resolved field, and only there', () => {
  it('writes the radio value into the target field key', () => {
    const { hub, userId, target } = paired({ fieldKey: 'selector', action: 'click' });
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      displayAttributes: ['id', 'class', 'css', 'xpath'],
      sendAttribute: { name: 'cssSelector' },
    });
    expect(r.ok).toBe(true);
    expect(r.delivery!.fields).toEqual({ selector: 'a#buy' });
  });

  it('writes into a DIFFERENT field when a different field was registered', () => {
    // The decisive case. Same element, same radio choice, same action — only the
    // registered destination differs. If the hub were inferring the field from
    // the ticked attributes (as the node-level design did), both would land in
    // `selector` and this test would fail.
    const { hub, userId, target } = paired({ fieldKey: 'name', action: 'extract' });
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'cssSelector' },
    });
    expect(r.ok).toBe(true);
    expect(r.delivery!.fields).toEqual({ name: 'a#buy' });
    expect(r.delivery!.fields.selector).toBeUndefined();
  });

  it('writes exactly one field — no companion keys', () => {
    // The old code also set `selectorType`, `xpath`, `attribute` and `value`.
    // The user pressed the picker next to ONE field; writing others would be
    // this layer deciding something it was not asked to decide.
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      displayAttributes: ['css', 'xpath', 'id', 'class', 'text', 'href'],
      sendAttribute: { name: 'css' },
    });
    expect(Object.keys(r.delivery!.fields)).toEqual(['selector']);
  });

  it('routes a generic data-* attribute into the field just the same', () => {
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'data-sku' },
    });
    expect(r.delivery!.fields).toEqual({ selector: 'SKU-1' });
    expect(r.delivery!.attribute).toBe('data-sku');
  });

  it('reports the destination it actually used', () => {
    // §24: the success response names the field, so the user can see it did not
    // go elsewhere.
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.delivery!.target.targetFieldId).toBe(target.targetFieldId);
    expect(r.delivery!.target.fieldKey).toBe('selector');
    expect(r.delivery!.target.nodeId).toBe('n1');
  });
});

// ════════════════════════════════════════════════════════════════
// Radio sends; checkboxes only display
// ════════════════════════════════════════════════════════════════

describe('the radio sends and the checkboxes only display', () => {
  it('ticking many attributes still sends exactly the radio one', () => {
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      displayAttributes: ['id', 'class', 'css', 'xpath', 'text', 'href', 'data-sku'],
      sendAttribute: { name: 'href' },
    });
    expect(r.delivery!.fields).toEqual({ selector: '/checkout' });
    expect(r.delivery!.displayAttributes).toHaveLength(7);
  });

  it('sends the radio value even when it was never ticked for display', () => {
    // The two states are independent, so an unticked radio is not a
    // contradiction to resolve — it is simply "send this, show those".
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      displayAttributes: ['text'],
      sendAttribute: { name: 'data-sku' },
    });
    expect(r.delivery!.fields).toEqual({ selector: 'SKU-1' });
  });

  it('sends with no checkboxes ticked at all', () => {
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      displayAttributes: [],
      sendAttribute: { name: 'css' },
    });
    expect(r.ok).toBe(true);
    expect(r.delivery!.fields).toEqual({ selector: 'a#buy' });
  });

  it('refuses when no radio was selected', () => {
    // §22.5. Without a radio there is no single value, and picking one for the
    // user would be a guess.
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      displayAttributes: ['css', 'xpath'],
      sendAttribute: { name: '' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ATTRIBUTE_SEND_FAILED');
  });

  it('refuses when the radio names a property the element does not have', () => {
    // §22.6. An empty value in a selector field is worse than a refusal: the
    // node looks configured and does nothing.
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'colspan' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ATTRIBUTE_SEND_FAILED');
  });

  it('derives the value from the element, ignoring the value the client claims', () => {
    // The radio NAME selects; it does not supply. A client that names one
    // property and attaches another's value gets the element's own truth.
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'cssSelector', value: 'body > .injected-by-client' },
    });
    expect(r.delivery!.fields).toEqual({ selector: 'a#buy' });
    expect(r.delivery!.value).toBe('a#buy');
  });
});

// ════════════════════════════════════════════════════════════════
// Refusals — §27 codes, never a silent redirect
// ════════════════════════════════════════════════════════════════

describe('refusals name a §27 cause instead of guessing a destination', () => {
  it('TARGET_FIELD_NOT_FOUND for an unknown id', () => {
    const { hub, userId } = paired();
    const r = hub.submit(userId, {
      targetFieldId: 'node_nope__selector__deadbeef',
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TARGET_FIELD_NOT_FOUND');
    expect(r.delivery).toBeUndefined();
  });

  it('TARGET_FIELD_NOT_FOUND for a well-formed FORGERY', () => {
    // The id is a lookup key, never a source of facts. Spelling the format
    // correctly buys nothing, because nothing here parses it.
    const { hub, userId, target } = paired();
    const forged = `node_${target.nodeId}__selector__ffffffff`;
    expect(forged).not.toBe(target.targetFieldId);
    const r = hub.submit(userId, {
      targetFieldId: forged,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.reason).toBe('TARGET_FIELD_NOT_FOUND');
  });

  it("another user's target is not found, not merely unauthorized", () => {
    // Whether someone else's field exists is not information this API leaks.
    const { hub, registry, target } = paired({ userId: 'owner' });
    const other = registry.register('intruder', {
      nodeId: 'n9', fieldKey: 'selector', action: 'click',
    });
    expect(other.ok).toBe(true);
    const r = hub.submit('intruder', {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.reason).toBe('TARGET_FIELD_NOT_FOUND');
  });

  it('TARGET_NOT_AUTHORIZED when the client never paired', () => {
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: 'ak_some_other_client',
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('TARGET_NOT_AUTHORIZED for a target this client paired for a different field', () => {
    // Pairing is per (client, target). Being authorized for one field must not
    // authorize the next one the user opens.
    const { hub, registry, auth, userId } = paired();
    const second = registry.register(userId, {
      nodeId: 'n2', fieldKey: 'selector', action: 'click',
    });
    expect(second.ok).toBe(true);
    expect(auth.isAuthorized(API_KEY, userId, second.target!.targetFieldId)).toBe(false);
    const r = hub.submit(userId, {
      targetFieldId: second.target!.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('ELEMENT_INSPECTION_FAILED for an unusable element', () => {
    const { hub, userId, target } = paired();
    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: {} as never,
      sendAttribute: { name: 'css' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ELEMENT_INSPECTION_FAILED');
  });

  it('checks existence BEFORE authorization', () => {
    // "Reopen the field" and "pair again" are different instructions. An
    // unregistered target must not be reported as an authorization problem.
    const { hub, userId } = paired();
    const r = hub.submit(userId, {
      targetFieldId: 'node_gone__selector__aaaaaaaa',
      apiKey: 'ak_not_paired_either',
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.reason).toBe('TARGET_FIELD_NOT_FOUND');
  });

  it('a refused submission queues nothing', () => {
    const { hub, userId, target } = paired();
    hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: 'wrong',
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(hub.peek(userId)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// [REQ 6] and [REQ 7] — Session and mode cannot invalidate a target
// ════════════════════════════════════════════════════════════════

describe('[REQ 6] a Session change does not invalidate a Target Field', () => {
  it('still delivers after the Handoff session id changes', () => {
    // Handoff owns its own `as_…` id. Rotating it is a Remote⇄Local transfer
    // concern and says nothing about which field the user is editing.
    const { hub, userId, target } = paired();
    const handoff = new SessionHandoffRegistry();
    const before = handoff.sessionId(userId);
    handoff.reset();
    const after = handoff.sessionId(userId);
    expect(after).not.toBe(before);

    const r = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.ok).toBe(true);
    expect(r.delivery!.fields).toEqual({ selector: 'a#buy' });
  });

  it('a submission carries no session id at all', () => {
    // The structural guarantee behind [REQ 6]: there is no field on the
    // submission for a session, so no code path can compare one.
    const { hub, userId, target } = paired();
    const submission = {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    };
    expect(Object.keys(submission)).not.toContain('sessionId');
    expect(hub.submit(userId, submission).ok).toBe(true);
  });
});

describe('[REQ 7] a Local/Remote switch does not invalidate a Target Field', () => {
  beforeEach(() => { browserModes.clear(); });

  it('keeps the same targetFieldId working across a mode switch', () => {
    const { hub, registry, userId, target } = paired();

    browserModes.set(userId, 'remote');
    const first = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
      mode: browserModes.modeOf(userId),
    });
    expect(first.ok).toBe(true);

    browserModes.set(userId, 'local');
    // The identity survives: same id, same resolved field.
    expect(registry.resolve(userId, target.targetFieldId)!.fieldKey).toBe('selector');
    const second = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
      mode: browserModes.modeOf(userId),
    });
    expect(second.ok).toBe(true);
    expect(second.delivery!.fields).toEqual({ selector: 'a#buy' });
  });

  it('records the mode a pick arrived in without letting it affect routing', () => {
    // Mode is context for the log, not an input to the destination.
    const { hub, userId, target } = paired();
    const local = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
      mode: 'local',
    });
    const remote = hub.submit(userId, {
      targetFieldId: target.targetFieldId,
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
      mode: 'remote',
    });
    expect(local.delivery!.mode).toBe('local');
    expect(remote.delivery!.mode).toBe('remote');
    expect(local.delivery!.target.targetFieldId)
      .toBe(remote.delivery!.target.targetFieldId);
  });
});

// ════════════════════════════════════════════════════════════════
// Several targets at once, and independent teardown
// ════════════════════════════════════════════════════════════════

describe('several Target Fields coexist and are torn down independently', () => {
  it('two paired targets each receive their own value', () => {
    const { hub, registry, auth, userId, target: first } = paired();
    const second = registry.register(userId, {
      nodeId: 'n2', fieldKey: 'name', action: 'extract',
    }).target!;
    const offer = auth.issue(userId, second.targetFieldId)!;
    expect(auth.redeem(API_KEY, offer.code).ok).toBe(true);

    const a = hub.submit(userId, {
      targetFieldId: first.targetFieldId,
      apiKey: API_KEY, element: el(), sendAttribute: { name: 'css' },
    });
    const b = hub.submit(userId, {
      targetFieldId: second.targetFieldId,
      apiKey: API_KEY, element: el(), sendAttribute: { name: 'data-sku' },
    });
    expect(a.delivery!.fields).toEqual({ selector: 'a#buy' });
    expect(b.delivery!.fields).toEqual({ name: 'SKU-1' });
  });

  it('unregistering one target leaves the other sending', () => {
    // The behaviour the old single-slot claim could not express: closing one
    // node must not disturb another node's live destination.
    const { hub, registry, auth, userId, target: first } = paired();
    const second = registry.register(userId, {
      nodeId: 'n2', fieldKey: 'name', action: 'extract',
    }).target!;
    const offer = auth.issue(userId, second.targetFieldId)!;
    auth.redeem(API_KEY, offer.code);

    expect(registry.unregister(userId, first.targetFieldId)).toBe(true);
    auth.revoke(first.targetFieldId);

    const dead = hub.submit(userId, {
      targetFieldId: first.targetFieldId,
      apiKey: API_KEY, element: el(), sendAttribute: { name: 'css' },
    });
    expect(dead.reason).toBe('TARGET_FIELD_NOT_FOUND');

    const alive = hub.submit(userId, {
      targetFieldId: second.targetFieldId,
      apiKey: API_KEY, element: el(), sendAttribute: { name: 'css' },
    });
    expect(alive.ok).toBe(true);
    expect(alive.delivery!.fields).toEqual({ name: 'a#buy' });
  });
});

// ════════════════════════════════════════════════════════════════
// Inbox
// ════════════════════════════════════════════════════════════════

describe('InspectorHub: inbox', () => {
  let ctx: ReturnType<typeof paired>;
  const send = (attr = 'css') => ctx.hub.submit(ctx.userId, {
    targetFieldId: ctx.target.targetFieldId,
    apiKey: API_KEY,
    element: el(),
    sendAttribute: { name: attr },
  });
  beforeEach(() => { ctx = paired(); });

  it('peek does not consume, drain does', () => {
    // A client that asks and then fails to apply must not have destroyed the
    // only copy of the pick.
    send();
    expect(ctx.hub.peek(ctx.userId)).toHaveLength(1);
    expect(ctx.hub.peek(ctx.userId)).toHaveLength(1);
    expect(ctx.hub.drain(ctx.userId)).toHaveLength(1);
    expect(ctx.hub.peek(ctx.userId)).toHaveLength(0);
  });

  it('ack removes exactly one delivery', () => {
    const a = send('css');
    send('text');
    expect(ctx.hub.ack(ctx.userId, a.delivery!.id)).toBe(true);
    expect(ctx.hub.ack(ctx.userId, a.delivery!.id)).toBe(false);
    expect(ctx.hub.peek(ctx.userId)).toHaveLength(1);
  });

  it('notifies subscribers with the field that was written', () => {
    const seen: string[] = [];
    ctx.hub.subscribe((userId, d) => { seen.push(`${userId}:${d.fields.selector}`); });
    send();
    expect(seen).toEqual(['u1:a#buy']);
  });

  it('a throwing subscriber does not break delivery', () => {
    ctx.hub.subscribe(() => { throw new Error('bad listener'); });
    expect(send().ok).toBe(true);
    expect(ctx.hub.peek(ctx.userId)).toHaveLength(1);
  });

  it('keeps one user out of another user\'s inbox', () => {
    send();
    expect(ctx.hub.peek('someone-else')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// [REQ 8] Handoff is a separate subsystem
// ════════════════════════════════════════════════════════════════

describe('[REQ 8] the Inspector and Handoff do not share state', () => {
  it('clearing the Inspector hub leaves Handoff pairing and snapshots working', () => {
    // Remote Browser / Handoff must survive anything the Inspector does. They
    // are independent subsystems, and this is the check that keeps them so.
    const { hub, userId } = paired();
    const handoff = new SessionHandoffRegistry();
    const offer = handoff.issuePairing(userId);
    const session = handoff.sessionId(userId);

    hub.clear();

    const redeemed = handoff.redeemPairing(offer.code);
    expect(redeemed.ok).toBe(true);
    expect(handoff.sessionId(userId)).toBe(session);
  });

  it('clearing the Inspector hub does not revoke a Target Field or its pairing', () => {
    // `clear()` empties queues only. If it also reset the registries, a support
    // action or a test helper would silently un-pair every open field.
    const { hub, registry, auth, userId, target } = paired();
    hub.clear();
    expect(registry.resolve(userId, target.targetFieldId)).not.toBeNull();
    expect(auth.isAuthorized(API_KEY, userId, target.targetFieldId)).toBe(true);
  });

  it('a Handoff session id is not usable as a Target Field id', () => {
    // The two namespaces are separate on purpose: `as_…` addresses a browser
    // transfer, `node_…__…__…` addresses a field.
    const { hub, userId } = paired();
    const handoff = new SessionHandoffRegistry();
    const r = hub.submit(userId, {
      targetFieldId: handoff.sessionId(userId),
      apiKey: API_KEY,
      element: el(),
      sendAttribute: { name: 'css' },
    });
    expect(r.reason).toBe('TARGET_FIELD_NOT_FOUND');
  });
});

// ════════════════════════════════════════════════════════════════
// Summary line
// ════════════════════════════════════════════════════════════════

describe('summarizeSelection', () => {
  it('names the element, the attribute sent, and the destination', () => {
    const { target } = paired();
    expect(summarizeSelection(el(), target, 'cssSelector'))
      .toBe('a#buy — cssSelector → click → selector');
  });

  it('prefers the field label when the editor supplied one', () => {
    const registry = new TargetFieldRegistry();
    const t = registry.register('u1', {
      nodeId: 'n1', fieldKey: 'selector', action: 'click', label: 'Product Selector',
    }).target!;
    expect(summarizeSelection(el(), t, 'cssSelector'))
      .toBe('a#buy — cssSelector → Product Selector');
  });
});
