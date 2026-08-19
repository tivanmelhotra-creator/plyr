import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════════════════
// REMOTE TARGETING, FROM THE BROWSER'S POINT OF VIEW
//
// WHY THIS FILE EXISTS
// --------------------
// `targeting-routes.test.ts` already proves that choosing REMOTE issues no code
// and that a submit CARRYING the target id lands. Both were true, and REMOTE was
// still broken, because a proof that "a submit with the right id works" says
// nothing about whether anyone ever learns the id.
//
// REPORTED:
//
//   «اگر کد اتورایز رو وارد نکنم … ظاهرا نمیدونه به کدوم فیلد باید ارسال بشه»
//   Connection failed: network
//
// The extension inside the server's browser addresses its submit with
// `ab_targetFieldId` out of `chrome.storage.local`, written ONLY by redeeming a
// code — which REMOTE deliberately never issues. So the value stayed empty.
//
// These tests therefore assert on the thing that was missing rather than on the
// half that already worked: that the server ASKS the remote browser which field
// it should aim at, that the question names the node and field so a human can
// verify it, that two open nodes produce two distinct questions instead of a
// silent guess, and that answering is what creates the authority.
//
// The scenario is written in the operator's own words at the bottom, end to end.
// ════════════════════════════════════════════════════════════════════════════

const KEY_A = 'test_key_123'; // seeded by tests/integration/setup.ts
const KEY_B = 'test_key_456'; // a SECOND credential inside the SAME account
const KEY_OTHER = 'test_key_other'; // a credential in a DIFFERENT account

/**
 * Which account each key authenticates into.
 *
 * KEY_A and KEY_B deliberately share an account, because that is the real
 * deployment: the DASHBOARD mints with one credential and the EXTENSION answers
 * with its own. If those two were treated as strangers the handshake could never
 * complete in production, so "a different key may answer" is a REQUIREMENT here,
 * not a leak — see sessionOwners() in mode.routes.ts.
 *
 * KEY_OTHER is what makes the negative tests meaningful. An earlier draft of this
 * file asserted cross-account refusal using KEY_B and passed the wrong thing for
 * the wrong reason: every key mapped to 'local', so it was really asserting that
 * an account cannot see its own prompts.
 */
const ACCOUNT_OF: Record<string, string> = {
  [KEY_A]: 'local',
  [KEY_B]: 'local',
  [KEY_OTHER]: 'other-account',
};

let app: Express;
let targetFields: typeof import('../../src/core/TargetFieldRegistry')['targetFields'];
let inspectorAuth: typeof import('../../src/core/InspectorAuthorization')['inspectorAuth'];
let inspectorHub: typeof import('../../src/core/InspectorHub')['inspectorHub'];
let remoteTargetConsent: typeof import('../../src/core/RemoteTargetConsent')['remoteTargetConsent'];

beforeAll(async () => {
  const { createModeRoutes } = await import('../../src/Routes/mode.routes');
  ({ targetFields } = await import('../../src/core/TargetFieldRegistry'));
  ({ inspectorAuth } = await import('../../src/core/InspectorAuthorization'));
  ({ inspectorHub } = await import('../../src/core/InspectorHub'));
  ({ remoteTargetConsent } = await import('../../src/core/RemoteTargetConsent'));

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const key = String(req.header('x-api-key') || '');
    if (key) {
      (req as { apiKey?: string; apiKeyUserId?: string }).apiKey = key;
      (req as { apiKeyUserId?: string }).apiKeyUserId = ACCOUNT_OF[key] || 'local';
    }
    next();
  });
  app.use(createModeRoutes());
});

beforeEach(() => {
  targetFields.clear();
  inspectorAuth.clear();
  inspectorHub.clear();
  remoteTargetConsent.resetForTests();
});

/** The dashboard chose REMOTE for one field. */
function begin(body: Record<string, unknown> = {}, key = KEY_A) {
  return request(app)
    .post('/inspector/targeting/begin')
    .set('x-api-key', key)
    .send({
      nodeId: 'node-7', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
      environment: 'remote', ...body,
    });
}

/** What the extension inside the remote browser polls for. */
function asked(key = KEY_A) {
  return request(app).get('/inspector/consent').set('x-api-key', key);
}

/** The human pressed Allow (or Deny) on the prompt. */
function decide(consentId: string, approve = true, key = KEY_A) {
  return request(app)
    .post('/inspector/consent/decide')
    .set('x-api-key', key)
    .send({ consentId, approve });
}

/** What the dashboard polls while it waits. */
function status(consentId: string, key = KEY_A) {
  return request(app)
    .get('/inspector/consent/status')
    .set('x-api-key', key)
    .query({ consentId });
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
// 1. Choosing REMOTE now asks the browser something
// ════════════════════════════════════════════════════════════════

describe('1. choosing REMOTE raises a prompt in the server browser', () => {
  it('still issues no Authorization Code — the old promise is kept', async () => {
    // [REQ] «برای REMOTE BROWSER نیازی به Authorization Code نیست.»
    // The fix must not smuggle a code back in under another name.
    const res = await begin();
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('returns a consent handle instead, so the dashboard can wait for an answer', async () => {
    const res = await begin();
    expect(res.body.consent).toBeTruthy();
    expect(res.body.consent.consentId).toMatch(/^cns_[0-9a-f]{24}$/);
    expect(res.body.consent.state).toBe('pending');
  });

  it('names the node and the field in the prompt, so a human can verify it', async () => {
    // A prompt that says only "allow this connection?" cannot be verified — the
    // operator would be agreeing to something unstated. This is the difference
    // between consent and a dialog to be dismissed.
    await begin({ nodeId: 'node-42', fieldKey: 'selector', label: 'Click → Selector' });
    const res = await asked();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.requests[0].nodeId).toBe('node-42');
    expect(res.body.requests[0].fieldKey).toBe('selector');
    expect(res.body.requests[0].label).toBe('Click → Selector');
    expect(res.body.requests[0].action).toBe('click');
  });

  it('never puts the target address in the prompt list', async () => {
    // The extension answers with a consentId. If the pending list carried the
    // targetFieldId, an extension could skip the prompt and submit straight to
    // it — «The Extension must NEVER be able to choose an arbitrary Target
    // Field» would then hold only by convention.
    await begin();
    const res = await asked();
    expect(res.body.requests[0].targetFieldId).toBeUndefined();
  });

  it('does not deliver anything until the prompt is answered', async () => {
    const res = await begin();
    expect(inspectorHub.peek('local')).toHaveLength(0);
    expect(res.body.consent.state).toBe('pending');
  });
});

// ════════════════════════════════════════════════════════════════
// 2. Answering it is what attaches the destination
// ════════════════════════════════════════════════════════════════

describe('2. Allow attaches the field; Deny attaches nothing', () => {
  it('hands back the two values the extension must store', async () => {
    // THE FIX, in one assertion. `targetFieldId` is what goes on the next
    // submit — the value that was never being written and the direct cause of
    // the reported failure. `pairingKey` is what stops it being asked again.
    const started = await begin();
    const res = await decide(started.body.consent.consentId);
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);
    expect(res.body.targetFieldId).toBe(started.body.target.targetFieldId);
    expect(res.body.pairingKey).toBe(started.body.target.pairingKey);
  });

  it('reports the field it attached, by name', async () => {
    const started = await begin({ nodeId: 'node-9', label: 'Type → Value' });
    const res = await decide(started.body.consent.consentId);
    expect(res.body.target.nodeId).toBe('node-9');
    expect(res.body.target.fieldKey).toBe('selector');
    expect(res.body.target.environment).toBe('remote');
  });

  it('makes a real pick land, with no code ever typed', async () => {
    // The end the operator cares about: the whole point is a delivered value.
    const started = await begin();
    await decide(started.body.consent.consentId);
    const sent = await send(KEY_A, started.body.target.targetFieldId);
    expect(sent.status).toBe(200);
    expect(sent.body.fieldName).toBe('selector');
    expect(sent.body.value).toBe('a#buy');
  });

  it('grants to the browser that ANSWERED, not to some other key', async () => {
    // Whoever pressed Allow is the client that will submit. Binding anything
    // else would authorize a different client than the human consented for.
    const started = await begin();
    await decide(started.body.consent.consentId, true, KEY_A);
    const bound = inspectorAuth.bindingsFor(KEY_A);
    expect(bound.some((b) => b.targetFieldId === started.body.target.targetFieldId)).toBe(true);
  });

  it('Deny attaches nothing at all', async () => {
    const started = await begin();
    const res = await decide(started.body.consent.consentId, false);
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(false);
    expect(res.body.targetFieldId).toBeUndefined();
  });

  it('takes the prompt off screen once answered', async () => {
    const started = await begin();
    await decide(started.body.consent.consentId);
    const res = await asked();
    expect(res.body.count).toBe(0);
  });

  it('refuses a second answer rather than re-applying the first', async () => {
    // A stale screen must not be able to re-answer. 409, not a silent repeat.
    const started = await begin();
    await decide(started.body.consent.consentId);
    const again = await decide(started.body.consent.consentId);
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('already_decided');
  });

  it('refuses an unknown handle instead of inventing a target', async () => {
    const res = await decide('cns_deadbeefdeadbeefdeadbeef');
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('consent_not_found');
  });
});

// ════════════════════════════════════════════════════════════════
// 3. TWO NODES — the ambiguity that was the heart of the report
// ════════════════════════════════════════════════════════════════

describe('3. two fields open at once are disambiguated by the human', () => {
  // [REQ] «تو فرض کن من قراره دوتا نود که یعنی دو تا فیلد با نودهای متفاوت باید
  //        المان/اتربیوت براش پر کنم … و الان نمیدونه کدوم فیلد باید ارسال بشه»

  it('asks TWO separate questions, one per field', async () => {
    await begin({ nodeId: 'node-A', fieldKey: 'selector' });
    await begin({ nodeId: 'node-B', fieldKey: 'selector' });
    const res = await asked();
    expect(res.body.count).toBe(2);
    expect(res.body.requests.map((r: { nodeId: string }) => r.nodeId)).toEqual(['node-A', 'node-B']);
  });

  it('asks them oldest first, so the answer order is not arbitrary', async () => {
    await begin({ nodeId: 'node-A' });
    await begin({ nodeId: 'node-B' });
    const res = await asked();
    expect(res.body.requests[0].nodeId).toBe('node-A');
  });

  it('answering one does NOT answer the other', async () => {
    // The failure this prevents: approving the prompt in front of you silently
    // attaching a different node's field, and the pick landing there.
    const a = await begin({ nodeId: 'node-A' });
    const b = await begin({ nodeId: 'node-B' });
    await decide(a.body.consent.consentId);

    const still = await asked();
    expect(still.body.count).toBe(1);
    expect(still.body.requests[0].consentId).toBe(b.body.consent.consentId);
  });

  it('delivers to the field that was approved, not the most recent one', async () => {
    // THE mis-delivery the design refuses to risk. node-B was chosen LAST, so a
    // "current target" shortcut would send node-A's pick to node-B.
    const a = await begin({ nodeId: 'node-A' });
    await begin({ nodeId: 'node-B' });
    await decide(a.body.consent.consentId);

    const sent = await send(KEY_A, a.body.target.targetFieldId);
    expect(sent.status).toBe(200);
    expect(sent.body.nodeName).toBe('node-A');
  });

  it('lets both be approved, so two fields can be filled without re-pairing', async () => {
    const a = await begin({ nodeId: 'node-A' });
    const b = await begin({ nodeId: 'node-B' });
    await decide(a.body.consent.consentId);
    await decide(b.body.consent.consentId);

    expect((await send(KEY_A, a.body.target.targetFieldId)).body.nodeName).toBe('node-A');
    expect((await send(KEY_A, b.body.target.targetFieldId)).body.nodeName).toBe('node-B');
  });
});

// ════════════════════════════════════════════════════════════════
// 4. THE REPEAT CASE — the browser must not be relaunched, or double-prompted
// ════════════════════════════════════════════════════════════════

describe('4. asking again about the SAME field refreshes one prompt', () => {
  // [REQ] «اگر حتی مرورگر بالا موند و فیلد عوض شد و همون ریموت باز انتخاب شد …
  //        مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد در حالت تکراری»

  it('does not stack a second prompt for one field', async () => {
    // Two prompts for one field is a bug, not a reminder: the operator answers
    // one and the other is left on screen asking the same thing.
    await begin({ nodeId: 'node-7' });
    await begin({ nodeId: 'node-7' });
    const res = await asked();
    expect(res.body.count).toBe(1);
  });

  it('says so, so the dashboard can word it as "still waiting"', async () => {
    const first = await begin({ nodeId: 'node-7' });
    const second = await begin({ nodeId: 'node-7' });
    expect(first.body.consent.reused).toBe(false);
    expect(second.body.consent.reused).toBe(true);
  });

  it('keeps the same handle, so a poller does not lose track of it', async () => {
    const first = await begin({ nodeId: 'node-7' });
    const second = await begin({ nodeId: 'node-7' });
    expect(second.body.consent.consentId).toBe(first.body.consent.consentId);
  });

  it('re-points the refreshed prompt at the CURRENT address', async () => {
    // Re-opening the node re-mints targetFieldId. A refreshed prompt still
    // holding the old one would approve a destination that no longer exists.
    const first = await begin({ nodeId: 'node-7' });
    targetFields.clear();
    const second = await begin({ nodeId: 'node-7' });
    expect(second.body.target.targetFieldId).not.toBe(first.body.target.targetFieldId);

    const res = await decide(second.body.consent.consentId);
    expect(res.body.targetFieldId).toBe(second.body.target.targetFieldId);
  });

  it('a DIFFERENT field is a different question, not a refresh', async () => {
    // `waitForSelector`, not an invented key: the registry refuses a fieldKey the
    // action does not declare, so a made-up name would make `begin` fail and this
    // test would "pass" on the absence of a prompt rather than on two of them.
    const a = await begin({ nodeId: 'node-7', fieldKey: 'selector' });
    const b = await begin({ nodeId: 'node-7', fieldKey: 'waitForSelector' });
    expect(a.body.consent).toBeTruthy();
    expect(b.body.consent).toBeTruthy();
    expect(b.body.consent.consentId).not.toBe(a.body.consent.consentId);
    expect(b.body.consent.reused).toBe(false);
    expect((await asked()).body.count).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════
// 5. The dashboard's side of the wait
// ════════════════════════════════════════════════════════════════

describe('5. the dashboard can see how the prompt is going', () => {
  it('reports pending while nobody has answered', async () => {
    const started = await begin();
    const res = await status(started.body.consent.consentId);
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.state).toBe('pending');
  });

  it('withholds the address until it is actually approved', async () => {
    // A dashboard that read the target out of a PENDING status could arm its
    // crosshair before anyone agreed — the exact "it said connected but nothing
    // happened" shape reported earlier in this project.
    const started = await begin();
    expect((await status(started.body.consent.consentId)).body.targetFieldId).toBe('');
    await decide(started.body.consent.consentId);
    expect((await status(started.body.consent.consentId)).body.targetFieldId)
      .toBe(started.body.target.targetFieldId);
  });

  it('reports approved, and denied, distinctly', async () => {
    const a = await begin({ nodeId: 'node-A' });
    const b = await begin({ nodeId: 'node-B' });
    await decide(a.body.consent.consentId, true);
    await decide(b.body.consent.consentId, false);
    expect((await status(a.body.consent.consentId)).body.state).toBe('approved');
    expect((await status(b.body.consent.consentId)).body.state).toBe('denied');
  });

  it('answers a poll about something gone with a state, not an error', async () => {
    // A polling client should not have to treat "finished" as a failure.
    const res = await status('cns_000000000000000000000000');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.state).toBe('expired');
  });

  it('names the field in the status, so a toast can too', async () => {
    const started = await begin({ nodeId: 'node-33' });
    const res = await status(started.body.consent.consentId);
    expect(res.body.nodeId).toBe('node-33');
    expect(res.body.fieldKey).toBe('selector');
  });
});

// ════════════════════════════════════════════════════════════════
// 6. A prompt is not a public object
// ════════════════════════════════════════════════════════════════

describe('6. only the browser it was addressed to may answer', () => {
  it('refuses an answer from a key in another account', async () => {
    // An unguessable id is not an authorization model. KEY_OTHER is a perfectly
    // valid credential — it simply belongs to somebody else.
    const started = await begin({}, KEY_A);
    const res = await request(app)
      .post('/inspector/consent/decide')
      .set('x-api-key', KEY_OTHER)
      .send({ consentId: started.body.consent.consentId, approve: true });
    expect([403, 404]).toContain(res.status);
  });

  it('does not list one account’s prompts to another', async () => {
    await begin({}, KEY_A);
    expect((await asked(KEY_OTHER)).body.count).toBe(0);
  });

  it('does not report another account’s prompt through status either', async () => {
    const started = await begin({}, KEY_A);
    const res = await status(started.body.consent.consentId, KEY_OTHER);
    expect(res.body.found).toBe(false);
    // And the refusal must not become an oracle: no address, no node name.
    expect(res.body.targetFieldId).toBeFalsy();
    expect(res.body.nodeId).toBeUndefined();
  });

  it('a refused answer leaves the prompt answerable by the right browser', async () => {
    // A stranger's Deny must not consume the question. Otherwise anyone holding
    // a valid key for any account could cancel someone else's targeting.
    const started = await begin({}, KEY_A);
    await request(app).post('/inspector/consent/decide')
      .set('x-api-key', KEY_OTHER)
      .send({ consentId: started.body.consent.consentId, approve: false });

    expect((await asked()).body.count).toBe(1);
    expect((await decide(started.body.consent.consentId)).body.approved).toBe(true);
  });

  it('DOES let a second credential in the SAME account answer', async () => {
    // The production shape: the dashboard mints with one key, the extension in
    // the server's browser answers with its own. Treating those as strangers
    // would make the handshake impossible to complete for real.
    const started = await begin({}, KEY_A);
    const res = await decide(started.body.consent.consentId, true, KEY_B);
    expect(res.status).toBe(200);
    expect(res.body.targetFieldId).toBe(started.body.target.targetFieldId);

    // And the grant went to the key that ANSWERED, so its submit is the one that lands.
    expect((await send(KEY_B, res.body.targetFieldId)).status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════
// 7. Unpairing takes the question away
// ════════════════════════════════════════════════════════════════

describe('7. a prompt about an unpaired field is withdrawn', () => {
  it('disappears when the field is unpaired', async () => {
    // Otherwise the operator detaches a field and is then asked to re-attach it
    // one press later — and approving would undo what they just did.
    const started = await begin({ nodeId: 'node-7', fieldKey: 'selector' });
    await decide(started.body.consent.consentId);

    await request(app).post('/inspector/targeting/unpair').set('x-api-key', KEY_A)
      .send({ nodeId: 'node-7', fieldKey: 'selector', workflowId: 'wf1' });

    const again = await begin({ nodeId: 'node-7', fieldKey: 'selector' });
    // A fresh question, not the answered one resurrected.
    expect(again.body.consent.reused).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// 8. LOCAL is untouched — the separation the mission insists on
// ════════════════════════════════════════════════════════════════

describe('8. LOCAL raises no prompt and needs no code either', () => {
  // [REQ] SUPERSEDED. This block read «LOCAL BROWSER → may need an Authorization
  // Code; REMOTE BROWSER → never needs one» and pinned that asymmetry. The final
  // contract removes the code from BOTH, because both browsers run on this
  // server, and keeps a different asymmetry instead — the approval Alert:
  //
  //     LOCAL  → internal automatic Base URL → no API Key → no Authorization
  //              → no Alert → automatic connection
  //     REMOTE → Base URL from the server's own configuration → no API Key
  //              → no Authorization Code → Remote Approval Alert
  //
  // The block is kept because "LOCAL raises no prompt" is still load-bearing:
  // it is the assertion that stops the REMOTE consent flow leaking into LOCAL.

  it('LOCAL asks nobody anything — no code, and no prompt for the server browser', async () => {
    const res = await begin({ environment: 'local' });
    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    expect(res.body.consent == null).toBe(true);
    // The prompt queue the REMOTE browser polls must stay empty, or the operator
    // would find an approval card in a flow that never asked for one.
    expect((await asked()).body.count).toBe(0);
  });

  it('LOCAL shows no Base URL to read, because nothing is retyped', async () => {
    // Inverted deliberately. This test used to REQUIRE `baseUrl` in the response
    // so the dialog could display it beside the code; the requirement forbids
    // that field outright: «LOCAL UI نباید Base URL داشته باشد».
    const res = await begin({ environment: 'local' });
    expect(res.body.baseUrl).toBeUndefined();
    expect(res.body.baseUrlSource).toBeUndefined();
    expect(res.body.display).toBeUndefined();
  });

  it('LOCAL mints no pending code server-side, so none can be waiting', async () => {
    // Stronger than the response check above: a code that was created and merely
    // omitted from the body would still be a code the user could be asked for
    // later. Nothing may be pending at all.
    await begin({ environment: 'local' });
    await begin({ environment: 'local' });
    expect(inspectorAuth.pendingCount()).toBe(0);
  });

  it('REMOTE never opens a code path, paired or not', async () => {
    await begin({ environment: 'remote' });
    await begin({ environment: 'remote' });
    expect(inspectorAuth.pendingCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// 9. THE OPERATOR'S SCENARIO, END TO END
// ════════════════════════════════════════════════════════════════

describe('9. the reported scenario, start to finish', () => {
  it('two nodes, one browser, no codes, both values delivered correctly', async () => {
    // «دو تا فیلد با نودهای متفاوت … با مرورگر روی سرور … بدون کد اتورایز»
    //
    // 1. First node: choose REMOTE. The browser is asked.
    const a = await begin({ nodeId: 'search-box', fieldKey: 'selector', label: 'Click → Selector' });
    expect(a.body.code).toBeUndefined();
    expect(a.body.consent.state).toBe('pending');

    // 2. The operator sees a prompt IN the server browser naming the field.
    let prompts = (await asked()).body.requests;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].nodeId).toBe('search-box');

    // 3. They press Allow. The extension now knows where to send.
    const allowedA = await decide(prompts[0].consentId);
    expect(allowedA.body.targetFieldId).toBe(a.body.target.targetFieldId);

    // 4. A pick lands in the first node. Asserted on the ADDRESS, because both
    //    nodes carry the same human label here — and a label is exactly what
    //    cannot tell two nodes apart, which is the bug being fixed.
    const sentA = await send(KEY_A, allowedA.body.targetFieldId);
    expect(sentA.status).toBe(200);
    expect(sentA.body.targetFieldId).toBe(a.body.target.targetFieldId);

    // 5. WITHOUT closing the browser, they open a SECOND node and choose REMOTE.
    //    «اگر کاربر مرورگر رو نبنده و برم نود بعدی رو باز کنه»
    const b = await begin({ nodeId: 'submit-btn', fieldKey: 'selector', label: 'Click → Selector' });

    // 6. Only ONE new question, about the new field. The first is not re-asked.
    prompts = (await asked()).body.requests;
    expect(prompts).toHaveLength(1);
    expect(prompts[0].nodeId).toBe('submit-btn');

    // 7. Allow, and the second value lands in the SECOND node — a different
    //    address than the first, which is the whole point.
    const allowedB = await decide(prompts[0].consentId);
    expect(allowedB.body.targetFieldId).toBe(b.body.target.targetFieldId);
    expect(allowedB.body.targetFieldId).not.toBe(allowedA.body.targetFieldId);

    const sentB = await send(KEY_A, allowedB.body.targetFieldId);
    expect(sentB.status).toBe(200);
    expect(sentB.body.targetFieldId).toBe(b.body.target.targetFieldId);

    // 8. And the first node's binding still works — approving the second did
    //    not steal the first. Two fields filled, zero codes typed.
    const againA = await send(KEY_A, allowedA.body.targetFieldId);
    expect(againA.status).toBe(200);
    expect(againA.body.targetFieldId).toBe(a.body.target.targetFieldId);
    expect(inspectorAuth.pendingCount()).toBe(0);
  });
});
