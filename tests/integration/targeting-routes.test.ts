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
//   REMOTE  → 200, step 'targeting', no `code` in the body, openRemoteBrowser
//   LOCAL   → 200, step 'authorize', a `code` — but only the FIRST time
//
// The scenario the operator wrote out by hand is at the bottom, end to end.
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
    // No destination was minted and no code was put on screen. Otherwise every
    // stray click on the crosshair would leak a target and a pending code.
    expect(targetFields.list('local')).toHaveLength(0);
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('warns that LOCAL will ask for a code on a field that is not yet paired', async () => {
    const res = await options();
    const local = res.body.options.find((o: { id: string }) => o.id === 'local');
    const remote = res.body.options.find((o: { id: string }) => o.id === 'remote');
    expect(local.needsAuthorization).toBe(true);
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
    // The half that would be easy to miss: "no code needed" is worthless if the
    // submit is then refused as unauthorized.
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
// Step two — LOCAL
// ════════════════════════════════════════════════════════════════

describe('POST /inspector/targeting/begin — LOCAL BROWSER, first time', () => {
  // [REQ] «اگر این Target Field قبلاً pair نشده باشد، همان لحظه یک
  //        Authorization Code مخصوص همان Target Field صادر شود.»
  it('issues a code, and does NOT open the server browser', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('authorize');
    expect(res.body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(res.body.openRemoteBrowser).toBe(false);
  });

  it('records LOCAL on the destination', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.body.target.environment).toBe('local');
  });

  it('refuses the pick until the code has been redeemed', async () => {
    // The code has to mean something. If a submit worked before pairing, the
    // whole authorize step would be theatre.
    const res = await begin({ environment: 'local' });
    const sent = await send(KEY_B, res.body.target.targetFieldId);
    expect(sent.status).toBe(409);
    expect(sent.body.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('issues a code scoped to THAT field only', async () => {
    const first = await begin({ environment: 'local', nodeId: 'node-7' });
    const second = await begin({
      environment: 'local', nodeId: 'node-9', fieldKey: 'url', action: 'goto',
    });

    await request(app).post('/inspector/pair')
      .set('x-api-key', KEY_B).send({ code: first.body.code });

    // Paired with the first field…
    expect((await send(KEY_B, first.body.target.targetFieldId)).status).toBe(200);
    // …and pointedly not with the second.
    expect((await send(KEY_B, second.body.target.targetFieldId)).body.reason)
      .toBe('TARGET_NOT_AUTHORIZED');
  });
});

describe('POST /inspector/targeting/begin — LOCAL BROWSER, returning', () => {
  /** Pair KEY_B with the default field, the way the extension does. */
  async function pairLocal(body: Record<string, unknown> = {}) {
    const res = await begin({ environment: 'local', ...body });
    expect(res.body.step).toBe('authorize');
    const done = await request(app).post('/inspector/pair')
      .set('x-api-key', KEY_B).send({ code: res.body.code });
    expect(done.status).toBe(200);
    return res.body.target.targetFieldId as string;
  }

  // [REQ] «دفعات بعد برای همان Extension و همان Target Field، دیگر
  //        Authorization Code لازم نیست.»
  it('asks for NO code the second time the same field is targeted', async () => {
    await pairLocal();

    const again = await begin({ environment: 'local' });
    expect(again.status).toBe(200);
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
    expect(again.body.paired).toBe(true);
  });

  it('re-points the existing pairing at the NEW address', async () => {
    // The half that is easy to get wrong: the trust survived, but `register()`
    // minted a fresh id, so without a rebind nothing could be delivered and the
    // user would be told "no code needed" over a dead channel.
    const firstId = await pairLocal();
    const again = await begin({ environment: 'local' });

    expect(again.body.target.targetFieldId).not.toBe(firstId);
    expect(again.body.rebound).toBeGreaterThan(0);
    expect((await send(KEY_B, again.body.target.targetFieldId)).status).toBe(200);
  });

  it('survives the node being CLOSED in between', async () => {
    // `target/release` fires on every NDV close, including the sendBeacon on
    // page unload. It used to revoke the pairing, which is what made the code
    // come back every single time.
    const firstId = await pairLocal();
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A).send({ targetFieldId: firstId });

    const again = await begin({ environment: 'local' });
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
  });

  it('still asks for a code for a DIFFERENT field', async () => {
    await pairLocal();
    const other = await begin({
      environment: 'local', nodeId: 'node-9', fieldKey: 'url', action: 'goto',
    });
    expect(other.body.step).toBe('authorize');
    expect(other.body.code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('still asks for a code in a different workflow', async () => {
    await pairLocal({ workflowId: 'wf1' });
    const elsewhere = await begin({ environment: 'local', workflowId: 'wf2' });
    expect(elsewhere.body.step).toBe('authorize');
  });

  it('shows the chooser that the field is already paired', async () => {
    await pairLocal();
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
  it('reports "still waiting" while the code is untyped', async () => {
    const res = await begin({ environment: 'local' });
    const status = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: res.body.target.targetFieldId });

    expect(status.status).toBe(200);
    expect(status.body.paired).toBe(false);
    expect(status.body.step).toBe('authorize');
    expect(status.body.environment).toBe('local');
  });

  it('flips to "targeting" once the extension redeems the code', async () => {
    // The dashboard cannot watch the extension directly — different browsers,
    // which is the entire point of LOCAL — so the server is the only party that
    // sees both sides.
    const res = await begin({ environment: 'local' });
    await request(app).post('/inspector/pair')
      .set('x-api-key', KEY_B).send({ code: res.body.code });

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
  it('is the ONLY thing that makes the code come back', async () => {
    const res = await begin({ environment: 'local' });
    await request(app).post('/inspector/pair')
      .set('x-api-key', KEY_B).send({ code: res.body.code });
    expect((await begin({ environment: 'local' })).body.step).toBe('targeting');

    const gone = await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A)
      .send({ nodeId: 'node-7', fieldKey: 'selector', workflowId: 'wf1' });
    expect(gone.body.unpaired).toBe(1);

    expect((await begin({ environment: 'local' })).body.step).toBe('authorize');
  });

  it('reports nothing removed for a pairing this user does not hold', async () => {
    // Answering identically for "not yours" and "does not exist" is deliberate:
    // otherwise the route would confirm whether an arbitrary key is in use.
    const res = await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A).send({ pairingKey: 'tf:wf9:nope:nope' });
    expect(res.body.unpaired).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// The operator's own scenario, end to end
// ════════════════════════════════════════════════════════════════

describe('the scenario from the requirement, start to finish', () => {
  it('pairs product_selector once, then never again — but product_url still pairs', async () => {
    // 1. First target chosen with LOCAL BROWSER: a code is issued.
    const first = await begin({
      environment: 'local', nodeId: 'node-8f21', fieldKey: 'selector', action: 'click',
    });
    expect(first.body.step).toBe('authorize');

    // 2. The user types it into the extension.
    await request(app).post('/inspector/pair')
      .set('x-api-key', KEY_B).send({ code: first.body.code });

    // The node is closed, as it would be in real use.
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A)
      .send({ targetFieldId: first.body.target.targetFieldId });

    // 3. Next time, the SAME Target Field: no new code.
    const secondVisit = await begin({
      environment: 'local', nodeId: 'node-8f21', fieldKey: 'selector', action: 'click',
    });
    expect(secondVisit.body.step).toBe('targeting');
    expect(secondVisit.body.code).toBeUndefined();
    // …and it genuinely works, rather than merely claiming to.
    expect((await send(KEY_B, secondVisit.body.target.targetFieldId)).status).toBe(200);

    // 4. But a NEW target requires new Authorization/Pairing.
    const newTarget = await begin({
      environment: 'local', nodeId: 'node-92aa', fieldKey: 'url', action: 'goto',
    });
    expect(newTarget.body.step).toBe('authorize');
    expect(newTarget.body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect((await send(KEY_B, newTarget.body.target.targetFieldId)).body.reason)
      .toBe('TARGET_NOT_AUTHORIZED');
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
