import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════
// THE TARGETING ROUTES, OVER REAL HTTP
//
// WHAT THESE PROVE THAT THE UNIT TESTS CANNOT
// -------------------------------------------
// browser-environment.test.ts proves `planTargeting` decides correctly, and
// inspector-pairing-persistence.test.ts proves the registry can remember a
// pairing. Neither proves that the ROUTES actually consult them — a handler
// that ignored the plan and issued a code unconditionally would leave every one
// of those tests green while reproducing the exact bug being fixed.
//
// So these go over the wire and assert on the HTTP contract:
//
//   REMOTE  → 200, step 'targeting', no `code`, openRemoteBrowser, a consent
//   LOCAL   → 200, step 'targeting', no `code`, consent NULL, granted
//             internally — the FIRST time and every time.
//
// LOCAL is the SERVER-LOCAL browser runtime: the browser runs on the same
// server/infrastructure as this process, so there is no trust gap and no
// Authorization Code is ever minted. The legacy /inspector/authorize +
// /inspector/pair routes still exist for older clients, and these tests use
// them to set up durable pairings — but `begin` must never route LOCAL
// through them.
// ════════════════════════════════════════════════════════════════

const KEY_A = 'test_key_123'; // seeded by tests/integration/setup.ts
const KEY_B = 'test_key_456';

let app: Express;
let targetFields: typeof import('../../src/core/TargetFieldRegistry')['targetFields'];
let inspectorAuth: typeof import('../../src/core/InspectorAuthorization')['inspectorAuth'];
let inspectorHub: typeof import('../../src/core/InspectorHub')['inspectorHub'];

beforeAll(async () => {
  const { createModeRoutes } = await import('../../src/Routes/mode.routes');
  ({ targetFields } = await import('../../src/core/TargetFieldRegistry'));
  ({ inspectorAuth } = await import('../../src/core/InspectorAuthorization'));
  ({ inspectorHub } = await import('../../src/core/InspectorHub'));

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const key = String(req.header('x-api-key') || '');
    if (key) {
      (req as { apiKey?: string; apiKeyUserId?: string }).apiKey = key;
      (req as { apiKeyUserId?: string }).apiKeyUserId = 'local';
    }
    next();
  });
  app.use(createModeRoutes());
});

beforeEach(() => {
  // Module singletons: without this, one test's pairing survives into the next
  // and a red assertion goes quietly green.
  targetFields.clear();
  inspectorAuth.clear();
  inspectorHub.clear();
});

/** Step one of the flow: what are my choices for this field? */
function options(q: Record<string, string> = {}) {
  return request(app)
    .get('/inspector/targeting/options')
    .set('x-api-key', KEY_A)
    .query({ nodeId: 'node-7', fieldKey: 'selector', workflowId: 'wf1', ...q });
}

/** Step two: the user chose an environment. */
function begin(body: Record<string, unknown> = {}, key = KEY_A) {
  return request(app)
    .post('/inspector/targeting/begin')
    .set('x-api-key', key)
    .send({
      nodeId: 'node-7', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
      environment: 'remote', ...body,
    });
}

function element() {
  return {
    tag: 'a', id: 'buy', classes: ['btn'],
    css: 'a#buy', xpath: '//*[@id="buy"]', text: 'Buy now',
    attrs: [{ name: 'href', value: '/checkout' }],
  };
}

function send(key: string, targetFieldId: string) {
  return request(app).post('/inspector/element').set('x-api-key', key).send({
    targetFieldId,
    element: element(),
    displayAttributes: ['css'],
    sendAttribute: { name: 'css', value: 'a#buy' },
  });
}

/**
 * The LEGACY code flow — still live for old clients, and the only way to
 * create a durable pairing for an arbitrary key from a test. `begin` itself
 * must never route LOCAL through this; the tests below assert exactly that.
 */
async function legacyPair(key: string, targetFieldId: string) {
  const issued = await request(app).post('/inspector/authorize')
    .set('x-api-key', KEY_A).send({ targetFieldId });
  expect(issued.status).toBe(200);
  expect(issued.body.code).toMatch(/^[A-Z0-9]{8}$/);
  const done = await request(app).post('/inspector/pair')
    .set('x-api-key', key).send({ code: issued.body.code });
  expect(done.status).toBe(200);
}

// ════════════════════════════════════════════════════════════════
// Step one — the chooser
// ════════════════════════════════════════════════════════════════

describe('GET /inspector/targeting/options', () => {
  it('offers exactly LOCAL and REMOTE', async () => {
    const res = await options();
    expect(res.status).toBe(200);
    expect(res.body.options.map((o: { id: string }) => o.id)).toEqual(['local', 'remote']);
  });

  it('creates NOTHING — opening a chooser the user may cancel is a read', async () => {
    await options();
    expect(targetFields.list('local')).toHaveLength(0);
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('warns about NOTHING — no environment ever asks for a code', async () => {
    // The inversion this task pins: LOCAL used to carry needsAuthorization
    // true. The chooser must not advertise a credential step the contract
    // forbids.
    const res = await options();
    const local = res.body.options.find((o: { id: string }) => o.id === 'local');
    const remote = res.body.options.find((o: { id: string }) => o.id === 'remote');
    expect(local.needsAuthorization).toBe(false);
    expect(remote.needsAuthorization).toBe(false);
  });

  it('returns the stable pairing key, so it survives a re-open', async () => {
    const a = await options();
    const b = await options();
    expect(a.body.pairingKey).toBe(b.body.pairingKey);
    expect(a.body.paired).toBe(false);
  });

  it('reports a different pairing key for a different field', async () => {
    const a = await options({ fieldKey: 'selector' });
    const b = await options({ nodeId: 'node-9', fieldKey: 'selector' });
    expect(a.body.pairingKey).not.toBe(b.body.pairingKey);
  });

  it('refuses without a node and field rather than guessing one', async () => {
    const res = await request(app)
      .get('/inspector/targeting/options').set('x-api-key', KEY_A).query({});
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════
// Step two — REMOTE
// ════════════════════════════════════════════════════════════════

describe('POST /inspector/targeting/begin — REMOTE BROWSER', () => {
  // [REQ] «برای REMOTE BROWSER نیازی به Authorization Code نیست.»
  it('goes straight to targeting and issues NO code', async () => {
    const res = await begin({ environment: 'remote' });
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('tells the caller to open the server browser', async () => {
    const res = await begin({ environment: 'remote' });
    expect(res.body.openRemoteBrowser).toBe(true);
  });

  it('records REMOTE on the destination itself', async () => {
    const res = await begin({ environment: 'remote' });
    expect(res.body.target.environment).toBe('remote');
    expect(targetFields.resolve('local', res.body.target.targetFieldId)!.environment)
      .toBe('remote');
  });

  it('binds the caller so a pick actually lands, with no pairing step', async () => {
    const res = await begin({ environment: 'remote' });
    const sent = await send(KEY_A, res.body.target.targetFieldId);
    expect(sent.status).toBe(200);
    expect(sent.body.fieldName).toBe('selector');
  });

  it('reports the environment on the delivery, from the server’s record', async () => {
    const res = await begin({ environment: 'remote' });
    const sent = await send(KEY_A, res.body.target.targetFieldId);
    expect(sent.body.delivery.environment).toBe('remote');
  });

  it('is the fallback for a missing or garbled environment', async () => {
    const res = await begin({ environment: 'sideways' });
    expect(res.body.environment).toBe('remote');
    expect(res.body.step).toBe('targeting');
  });
});

// ════════════════════════════════════════════════════════════════
// Step two — LOCAL, the SERVER-LOCAL runtime
// ════════════════════════════════════════════════════════════════

describe('POST /inspector/targeting/begin — LOCAL BROWSER, first time', () => {
  // [REQ] «LOCAL UI نباید … Authorization Code … و کاربر نباید هیچ‌کدام را
  //        وارد کند.» — not even the first time, not even one.
  it('grants the binding INTERNALLY and issues NO code, ever', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    expect(res.body.consent).toBeNull();
    expect(res.body.openRemoteBrowser).toBe(false);
    expect(res.body.paired).toBe(true);
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('answers where the automatic connection resolved to — as information, not a form', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.body.internal).toBeDefined();
    expect(res.body.internal.requiresUserInput).toBe(false);
    expect(String(res.body.internal.baseUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('records LOCAL on the destination', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.body.target.environment).toBe('local');
  });

  it('lets the granted key send IMMEDIATELY — Ready to Send, no further step', async () => {
    // «Detect → ensure ready → resolve internal context → resolve target →
    // Connected to Target → Ready to Send» ends here: the pick goes through.
    const res = await begin({ environment: 'local' });
    const sent = await send(KEY_A, res.body.target.targetFieldId);
    expect(sent.status).toBe(200);
    expect(sent.body.delivery.environment).toBe('local');
  });

  it('still refuses a key that was never granted — automatic is not anonymous', async () => {
    // The grant is scoped to the server's own token and the caller's key. A
    // stranger's key naming the same field must still bounce, or the binding
    // would mean nothing.
    const res = await begin({ environment: 'local' });
    const sent = await send(KEY_B, res.body.target.targetFieldId);
    expect(sent.status).toBe(409);
    expect(sent.body.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('grants per FIELD: a different field is a different binding', async () => {
    // Isolation is preserved WITHOUT codes: targeting node-7 grants node-7's
    // field, and says nothing about node-9's.
    const first = await begin({ environment: 'local', nodeId: 'node-7' });
    const second = await begin({
      environment: 'local', nodeId: 'node-9', fieldKey: 'url', action: 'goto',
    });

    expect((await send(KEY_A, first.body.target.targetFieldId)).status).toBe(200);
    expect((await send(KEY_A, second.body.target.targetFieldId)).status).toBe(200);
    // The bindings are distinct — neither id works for the other field.
    expect(first.body.target.targetFieldId).not.toBe(second.body.target.targetFieldId);
  });
});

describe('POST /inspector/targeting/begin — LOCAL BROWSER, with a legacy pairing', () => {
  /**
   * Pair KEY_B through the LEGACY code route (as an old extension would), then
   * target the same field again: the pairing must be re-pointed at the fresh
   * address, not replaced by a new code.
   */
  async function beginThenLegacyPair(body: Record<string, unknown> = {}) {
    const res = await begin({ environment: 'local', ...body });
    await legacyPair(KEY_B, res.body.target.targetFieldId);
    return res.body.target.targetFieldId as string;
  }

  // [REQ] «دفعات بعد برای همان Extension و همان Target Field، دیگر
  //        Authorization Code لازم نیست.»
  it('asks for NOTHING the second time the same field is targeted', async () => {
    await beginThenLegacyPair();

    const again = await begin({ environment: 'local' });
    expect(again.status).toBe(200);
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
    expect(again.body.paired).toBe(true);
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('re-points the existing pairing at the NEW address', async () => {
    // The trust survived, but register() minted a fresh id — without a rebind
    // nothing could be delivered and the user would be told \"connected\" over
    // a dead channel.
    const firstId = await beginThenLegacyPair();
    const again = await begin({ environment: 'local' });

    expect(again.body.target.targetFieldId).not.toBe(firstId);
    expect((await send(KEY_B, again.body.target.targetFieldId)).status).toBe(200);
  });

  it('survives the node being CLOSED in between', async () => {
    const firstId = await beginThenLegacyPair();
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A).send({ targetFieldId: firstId });

    const again = await begin({ environment: 'local' });
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
    expect((await send(KEY_B, again.body.target.targetFieldId)).status).toBe(200);
  });

  it('shows the chooser that the field is already paired', async () => {
    await beginThenLegacyPair();
    const res = await options();
    expect(res.body.paired).toBe(true);
    const local = res.body.options.find((o: { id: string }) => o.id === 'local');
    expect(local.needsAuthorization).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Status and unpair
// ════════════════════════════════════════════════════════════════

describe('GET /inspector/targeting/status', () => {
  it('reports paired:true immediately for LOCAL — there is nothing to wait for', async () => {
    // The legacy \"still waiting for the code\" state cannot exist anymore:
    // begin granted the binding in the same request that registered the field.
    const res = await begin({ environment: 'local' });
    const status = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: res.body.target.targetFieldId });

    expect(status.status).toBe(200);
    expect(status.body.paired).toBe(true);
    expect(status.body.step).toBe('targeting');
    expect(status.body.environment).toBe('local');
  });

  it('flips to \"targeting\" once a legacy extension redeems a code', async () => {
    // The legacy route still works end to end: a code issued by the OLD
    // /inspector/authorize path and redeemed by an OLD client pairs the field.
    const res = await begin({ environment: 'local' });
    await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A)
      .send({ pairingKey: res.body.target.pairingKey });
    const waiting = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: res.body.target.targetFieldId });
    expect(waiting.body.paired).toBe(false);
    expect(waiting.body.step).toBe('authorize'); // legacy status vocabulary

    await legacyPair(KEY_B, res.body.target.targetFieldId);

    const status = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: res.body.target.targetFieldId });
    expect(status.body.paired).toBe(true);
    expect(status.body.step).toBe('targeting');
  });

  it('404s for a target that does not exist', async () => {
    const status = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: 'node_node-7__selector__deadbeef' });
    expect(status.status).toBe(404);
    expect(status.body.reason).toBe('TARGET_FIELD_NOT_FOUND');
  });
});

describe('POST /inspector/targeting/unpair', () => {
  it('drops the durable pairing — and LOCAL STILL issues no code afterwards', async () => {
    // Unpair used to be \"the ONLY thing that makes the code come back\". There
    // is no code to come back to: after unpairing, the next begin simply
    // grants fresh — automatically, as the contract demands.
    const res = await begin({ environment: 'local' });
    await legacyPair(KEY_B, res.body.target.targetFieldId);
    // The return visit re-mints the address (register() on every NDV open), so
    // it is THIS begin's id that is live from here on — the first one is stale.
    const revisit = await begin({ environment: 'local' });
    expect(revisit.body.step).toBe('targeting');

    const gone = await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A)
      .send({ nodeId: 'node-7', fieldKey: 'selector', workflowId: 'wf1' });
    // begin() now records the automatic grant under BOTH the server token's
    // and the caller's clientId, so more than one record goes — the exact
    // count is an implementation detail. What matters is that the pairing is
    // genuinely gone afterwards.
    expect(gone.body.unpaired).toBeGreaterThan(0);
    const waiting = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: revisit.body.target.targetFieldId });
    expect(waiting.body.paired).toBe(false);

    const next = await begin({ environment: 'local' });
    expect(next.body.step).toBe('targeting');
    expect(next.body.code).toBeUndefined();
    // And the freshly-granted caller can still send.
    expect((await send(KEY_A, next.body.target.targetFieldId)).status).toBe(200);
  });

  it('reports nothing removed for a pairing this user does not hold', async () => {
    const res = await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A).send({ pairingKey: 'tf:wf9:nope:nope' });
    expect(res.body.unpaired).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// The operator's scenario, end to end, on the corrected contract
// ════════════════════════════════════════════════════════════════

describe('the corrected scenario, start to finish', () => {
  it('targets product_selector, closes, re-opens, then targets product_url — with ZERO codes', async () => {
    // 1. First target chosen with LOCAL BROWSER: bound at once, no code.
    const first = await begin({
      environment: 'local', nodeId: 'node-8f21', fieldKey: 'selector', action: 'click',
    });
    expect(first.body.step).toBe('targeting');
    expect(first.body.code).toBeUndefined();
    expect(first.body.consent).toBeNull();
    expect((await send(KEY_A, first.body.target.targetFieldId)).status).toBe(200);

    // The node is closed, as it would be in real use.
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A)
      .send({ targetFieldId: first.body.target.targetFieldId });

    // 2. Next time, the SAME Target Field: still no code, still works.
    const secondVisit = await begin({
      environment: 'local', nodeId: 'node-8f21', fieldKey: 'selector', action: 'click',
    });
    expect(secondVisit.body.step).toBe('targeting');
    expect(secondVisit.body.code).toBeUndefined();
    expect((await send(KEY_A, secondVisit.body.target.targetFieldId)).status).toBe(200);

    // 3. A NEW target is a fresh automatic grant — no code for it either, and
    //    it does not disturb the first field's binding.
    const newTarget = await begin({
      environment: 'local', nodeId: 'node-92aa', fieldKey: 'url', action: 'goto',
    });
    expect(newTarget.body.step).toBe('targeting');
    expect(newTarget.body.code).toBeUndefined();
    expect((await send(KEY_A, newTarget.body.target.targetFieldId)).status).toBe(200);

    // 4. Through all of it, no pending code was ever minted.
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('keeps the two environments’ concerns apart on one field', async () => {
    // Browser Environment is not Session and not Target Field identity. The
    // same field targeted remotely then locally keeps ONE pairing identity
    // while the recorded environment changes.
    const remote = await begin({ environment: 'remote' });
    expect(remote.body.target.environment).toBe('remote');

    const local = await begin({ environment: 'local' });
    expect(local.body.target.environment).toBe('local');
    expect(local.body.target.pairingKey).toBe(remote.body.target.pairingKey);
  });
});
