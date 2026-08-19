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
//   REMOTE  → 200, step 'targeting', no `code`, openRemoteBrowser, consent raised
//   LOCAL   → 200, step 'targeting', NO code and NO consent, EVER — because LOCAL
//             is the browser runtime on the same server as this process, so the
//             server binds the field itself and there is nothing to hand over
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

  it('promises NEITHER environment will ask for a code, even on a fresh field', async () => {
    // This test used to assert the opposite for LOCAL, and that inverted
    // expectation is the whole defect in miniature: the chooser advertised
    // «این محیط از شما Authorization Code می‌خواهد» before the user had picked
    // anything, so the credential form was promised at the earliest possible
    // moment. There is no longer a code in EITHER environment, so the promise
    // is now false for both — and it is asserted on an unpaired field on
    // purpose, since that was the one case that used to differ.
    const res = await options();
    const local = res.body.options.find((o: { id: string }) => o.id === 'local');
    const remote = res.body.options.find((o: { id: string }) => o.id === 'remote');
    expect(res.body.paired).toBe(false);
    expect(local.needsAuthorization).toBe(false);
    expect(remote.needsAuthorization).toBe(false);
  });

  it('marks the approval Alert as the ONE difference between the two', async () => {
    // The environments are not interchangeable, and the chooser has to say so
    // — but the difference is now a single flag rather than a whole extra
    // screen. REMOTE binds a long-lived browser that may already be pointed at
    // another field, so a human confirms WHICH field it should follow. LOCAL is
    // resolved per run on this same machine, so there is nothing to
    // disambiguate: «LOCAL → بدون Alert → اتصال خودکار».
    const res = await options();
    const local = res.body.options.find((o: { id: string }) => o.id === 'local');
    const remote = res.body.options.find((o: { id: string }) => o.id === 'remote');
    expect(local.needsRemoteApproval).toBe(false);
    expect(remote.needsRemoteApproval).toBe(true);
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
  // [REQ] "Target This Field → LOCAL BROWSER → Detect local browser runtime →
  //        … → Connected to Target → Ready to Send", with no step in between
  //        that asks the operator for anything at all.
  it('goes straight to targeting: no code, no approval, no server window', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.status).toBe(200);
    // Was step 'authorize' carrying an 8-character code.
    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    expect(res.body.display).toBeUndefined();
    expect(res.body.openRemoteBrowser).toBe(false);
    // No approval alert for LOCAL — automatic connection instead.
    expect(res.body.consent).toBeNull();
    // Stated positively so the dashboard renders the automatic progression.
    expect(res.body.runtime).toBe('server-local');
    expect(res.body.paired).toBe(true);
  });

  it('never returns a Base URL for the operator to copy', async () => {
    // The LOCAL UI must contain no `Base URL`. The route used to send one
    // beside the code, and that is what the dialog rendered.
    const res = await begin({ environment: 'local' });
    expect(res.body.baseUrl).toBeUndefined();
    expect(res.body.baseUrlSource).toBeUndefined();
  });

  it('records LOCAL on the destination', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.body.target.environment).toBe('local');
  });

  // THE decisive test for this environment.
  //
  // "Connected to Target / Ready to Send" has to be TRUE, not merely displayed.
  // Removing the Authorization Code removed the thing that used to create the
  // very first binding, so if nothing replaced it the dialog would report
  // success and then every pick would be refused with TARGET_NOT_AUTHORIZED —
  // a worse failure than the credential form, because it stays invisible until
  // the user actually tries to work.
  it('leaves the FIRST-TIME browser genuinely able to send', async () => {
    const res = await begin({ environment: 'local' });
    const id = res.body.target.targetFieldId;

    expect(inspectorAuth.isAuthorized(KEY_A, 'local', id)).toBe(true);
    expect((await send(KEY_A, id)).status).toBe(200);
  });

  it('binds ONLY the fields that were actually targeted', async () => {
    // «The Extension must NEVER be able to choose an arbitrary Target Field.»
    // Granting internally must not turn into granting broadly.
    const first = await begin({ environment: 'local', nodeId: 'node-7' });
    const second = await begin({
      environment: 'local', nodeId: 'node-9', fieldKey: 'url', action: 'goto',
    });

    expect((await send(KEY_A, first.body.target.targetFieldId)).status).toBe(200);
    expect((await send(KEY_A, second.body.target.targetFieldId)).status).toBe(200);
    // A never-targeted id remains refused.
    expect((await send(KEY_A, 'node_zzzz__nope__0000')).status).toBe(409);
  });
});

describe('POST /inspector/targeting/begin — LOCAL BROWSER, returning', () => {
  /** Target the field once, the way the crosshair does. No redemption step. */
  async function bindLocal(body: Record<string, unknown> = {}) {
    const res = await begin({ environment: 'local', ...body });
    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    return res.body.target.targetFieldId as string;
  }

  // [REQ] The next time round, for the same extension and the same Target
  //       Field, nothing further is needed — now trivially true, because
  //       nothing was needed the first time either.
  it('asks for nothing on the second visit either', async () => {
    await bindLocal();

    const again = await begin({ environment: 'local' });
    expect(again.status).toBe(200);
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
    expect(again.body.paired).toBe(true);
  });

  it('re-points the existing pairing at the NEW address', async () => {
    // `register()` mints a fresh id on every NDV open, so the durable pairing
    // must be moved to it or the user is told "connected" over a dead channel.
    const firstId = await bindLocal();
    const again = await begin({ environment: 'local' });

    expect(again.body.target.targetFieldId).not.toBe(firstId);
    expect(again.body.rebound).toBeGreaterThan(0);
    expect((await send(KEY_A, again.body.target.targetFieldId)).status).toBe(200);
  });

  it('survives the node being CLOSED in between', async () => {
    // `target/release` fires on every NDV close, including the sendBeacon on
    // page unload. It must drop the address without dropping the pairing.
    const firstId = await bindLocal();
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A).send({ targetFieldId: firstId });

    const again = await begin({ environment: 'local' });
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
    // And still genuinely usable, not merely reported as connected.
    expect((await send(KEY_A, again.body.target.targetFieldId)).status).toBe(200);
  });

  it('asks for nothing for a DIFFERENT field either', async () => {
    await bindLocal();
    const other = await begin({
      environment: 'local', nodeId: 'node-9', fieldKey: 'url', action: 'goto',
    });
    expect(other.body.step).toBe('targeting');
    expect(other.body.code).toBeUndefined();
    expect(other.body.consent).toBeNull();
  });

  it('asks for nothing in a different workflow either', async () => {
    await bindLocal({ workflowId: 'wf1' });
    const elsewhere = await begin({ environment: 'local', workflowId: 'wf2' });
    expect(elsewhere.body.step).toBe('targeting');
    expect(elsewhere.body.code).toBeUndefined();
  });

  it('shows the chooser that LOCAL needs no authorization and no approval', async () => {
    await bindLocal();
    const res = await options();
    expect(res.body.paired).toBe(true);
    const local = res.body.options.find((o: { id: string }) => o.id === 'local');
    expect(local.needsAuthorization).toBe(false);
    expect(local.needsRemoteApproval).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Status and unpair
// ════════════════════════════════════════════════════════════════

describe('GET /inspector/targeting/status', () => {
  it('reports LOCAL already paired the instant targeting begins', async () => {
    // OLD BEHAVIOUR: this reported `paired:false` / `step:'authorize'`, because
    // the pairing did not exist yet — it would only come into being once the
    // operator carried an 8-character code from the dashboard into the
    // extension. This route was how the dashboard polled for that to happen.
    //
    // There is nothing left to wait FOR. The server binds the destination
    // during `begin`, so the very first poll already reports the finished
    // state. That is what makes the LOCAL screen a progress indicator rather
    // than a form: it is describing work that is already done.
    const res = await begin({ environment: 'local' });
    const status = await request(app).get('/inspector/targeting/status')
      .set('x-api-key', KEY_A)
      .query({ targetFieldId: res.body.target.targetFieldId });

    expect(status.status).toBe(200);
    expect(status.body.paired).toBe(true);
    expect(status.body.step).toBe('targeting');
    expect(status.body.environment).toBe('local');
  });

  it('never regresses to "authorize", however many times it is polled', async () => {
    // The dashboard polls this while the LOCAL progress screen animates. If any
    // poll answered 'authorize' the screen would snap back to a credential
    // form mid-progression, which is precisely the symptom being fixed. Polled
    // repeatedly because a one-shot check cannot catch a state that decays.
    const res = await begin({ environment: 'local' });
    const id = res.body.target.targetFieldId;

    for (let i = 0; i < 3; i += 1) {
      const status = await request(app).get('/inspector/targeting/status')
        .set('x-api-key', KEY_A).query({ targetFieldId: id });
      expect(status.body.step).toBe('targeting');
      expect(status.body.paired).toBe(true);
    }
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
  it('really drops the durable pairing, not just the reported count', async () => {
    // OLD BEHAVIOUR: this asserted that unpairing "makes the code come back",
    // i.e. that the next `begin` returned `step:'authorize'`. That is no longer
    // a meaningful observation — no `begin` in any environment returns
    // 'authorize' any more — so the assertion could only ever fail.
    //
    // What unpair is FOR survives the change intact, and is asserted instead:
    // it forgets the RELATIONSHIP between this user and this field. Read back
    // out of the registry rather than trusted from the response, because a route
    // that reported `unpaired:1` without touching the store would satisfy any
    // response-level assertion.
    //
    // Note what is deliberately NOT asserted here: that the in-flight ADDRESS
    // binding also dies. `unpair` and `revoke` are separate on purpose and were
    // before this change — «Drops the ADDRESS only. The PAIRING is untouched» —
    // so conflating them in a test would invent a contract the code never had.
    const res = await begin({ environment: 'local' });
    const pairingKey = res.body.target.pairingKey;
    expect(inspectorAuth.isPairedForUser('local', pairingKey)).toBe(true);

    const gone = await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A)
      .send({ nodeId: 'node-7', fieldKey: 'selector', workflowId: 'wf1' });
    expect(gone.body.unpaired).toBe(1);

    expect(inspectorAuth.isPairedForUser('local', pairingKey)).toBe(false);
  });

  it('re-targeting after an unpair attaches again with no ceremony', async () => {
    // Unpair must be recoverable WITHOUT reintroducing setup. Under the old
    // contract this was the moment the credential form reappeared; now the same
    // crosshair click is the whole recovery, and it must land on a working
    // binding rather than merely a hopeful screen.
    const first = await begin({ environment: 'local' });
    await request(app).post('/inspector/targeting/unpair')
      .set('x-api-key', KEY_A)
      .send({ nodeId: 'node-7', fieldKey: 'selector', workflowId: 'wf1' });

    const again = await begin({ environment: 'local' });
    expect(again.body.step).toBe('targeting');
    expect(again.body.code).toBeUndefined();
    expect(again.body.consent).toBeNull();
    expect(again.body.target.pairingKey).toBe(first.body.target.pairingKey);
    expect((await send(KEY_A, again.body.target.targetFieldId)).status).toBe(200);
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
  it('attaches product_selector with no setup, and product_url the same way', async () => {
    // The operator's scenario, re-read under the final contract. Every step the
    // user PERFORMS is unchanged; what changed is that the two steps which were
    // pure ceremony — read a code, retype a code — are simply gone:
    //
    //   Target This Field → LOCAL BROWSER → …resolve internally… → Ready to Send
    //
    // 1. First target chosen with LOCAL BROWSER. Attached immediately.
    const first = await begin({
      environment: 'local', nodeId: 'node-8f21', fieldKey: 'selector', action: 'click',
    });
    expect(first.body.step).toBe('targeting');
    expect(first.body.code).toBeUndefined();
    expect(first.body.runtime).toBe('server-local');
    // No step 2 any more: nothing is typed anywhere. Asserted by SENDING, since
    // "Connected to Target / Ready to Send" has to be true and not merely shown.
    expect((await send(KEY_A, first.body.target.targetFieldId)).status).toBe(200);

    // The node is closed, as it would be in real use.
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A)
      .send({ targetFieldId: first.body.target.targetFieldId });

    // 2. Next time, the SAME Target Field: still nothing to do, and the durable
    //    pairing identity is the same one — a re-open, not a re-setup.
    const secondVisit = await begin({
      environment: 'local', nodeId: 'node-8f21', fieldKey: 'selector', action: 'click',
    });
    expect(secondVisit.body.step).toBe('targeting');
    expect(secondVisit.body.code).toBeUndefined();
    expect(secondVisit.body.target.pairingKey).toBe(first.body.target.pairingKey);
    expect((await send(KEY_A, secondVisit.body.target.targetFieldId)).status).toBe(200);

    // 3. A NEW field is a genuinely different destination — it gets its own
    //    pairing identity, so the two can be detached independently — but it
    //    costs the user no setup either. This is the assertion that used to
    //    demand a fresh 8-character code.
    const newTarget = await begin({
      environment: 'local', nodeId: 'node-92aa', fieldKey: 'url', action: 'goto',
    });
    expect(newTarget.body.step).toBe('targeting');
    expect(newTarget.body.code).toBeUndefined();
    expect(newTarget.body.target.pairingKey).not.toBe(first.body.target.pairingKey);
    expect((await send(KEY_A, newTarget.body.target.targetFieldId)).status).toBe(200);

    // 4. And the destinations stay distinct: attaching the second field must not
    //    have quietly re-pointed the first. Otherwise «switch current target»
    //    would silently become «overwrite the previous target».
    expect(newTarget.body.target.targetFieldId)
      .not.toBe(secondVisit.body.target.targetFieldId);
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
