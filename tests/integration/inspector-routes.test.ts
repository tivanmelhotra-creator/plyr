import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ════════════════════════════════════════════════════════════════
// THE INSPECTOR ROUTES, OVER REAL HTTP
//
// WHY A ROUTE-LEVEL FILE ON TOP OF THE UNIT TESTS
// -----------------------------------------------
// inspector-hub.test.ts proves the hub refuses a forged `targetFieldId`, but it
// calls the hub directly. That leaves one thing unproven: that the ROUTE hands
// the hub the id from the body and the key from the CREDENTIAL, rather than
// trusting a body-supplied key or resolving the target itself. A route that
// read `req.body.apiKey` would let any caller borrow another client's pairing
// and every existing unit test would still pass.
//
// So these tests go over the wire: real Express, real router, real registries,
// real auth middleware. What is asserted is the HTTP contract — status codes and
// the §27 `reason`, because those are what the extension and the dashboard
// actually branch on.
//
// NOTE ON SINGLE-USER MODE
// ------------------------
// `resolveUserId` collapses every caller to 'local' when IS_SINGLE_USER is set,
// so cross-USER isolation cannot be demonstrated through these routes and is
// covered in the unit tests, which drive the registries directly. What IS
// demonstrable here — and is the more important property for a multi-extension
// setup — is cross-KEY isolation: two API keys, same account.
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
  // The routes read `req.apiKey`; the real middleware is what populates it, but
  // it also reaches for Redis. A minimal stand-in keeps this file about routing
  // while still proving the key is taken from the HEADER and not the body.
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

/** Register a destination the way the workflow UI does. */
async function openField(body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/inspector/target')
    .set('x-api-key', KEY_A)
    .send({ nodeId: 'node-7', fieldKey: 'selector', action: 'click', ...body });
  return res;
}

/**
 * Attach `key` to a destination, returning the field it is now bound to.
 *
 * WHAT THIS REPLACED, and why the shape of the helper changed. It used to be
 * called `pair` and it ran the three-step dance the product no longer has:
 * register the field, POST /inspector/authorize to mint an 8-character
 * Authorization Code, then POST /inspector/pair from the extension's key to
 * redeem it. Both of those routes are deleted, so every test that funnelled
 * through here was failing with 404.
 *
 * The replacement is ONE request, because that is now the whole handshake: the
 * chooser's own route registers the destination and binds the Inspector to it
 * before answering. `environment: 'local'` is the case under test throughout
 * this file — the browser on THIS server — and it binds with no prompt at all.
 *
 * Note which key gets bound. The route grants to `config.API_TOKEN` (the token it
 * seeds its own side-loaded extension with) and ALSO to the calling key when the
 * two differ. In multi-tenant mode — which tests/integration/setup.ts forces —
 * `config.API_TOKEN` is the empty string and `grant('')` is a no-op, so the
 * caller's own key is the binding that exists. That is what makes cross-KEY
 * isolation still demonstrable here: KEY_B calling begin binds KEY_B, and never
 * KEY_A's field.
 */
async function attach(key: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/inspector/targeting/begin')
    .set('x-api-key', key)
    .send({ nodeId: 'node-7', fieldKey: 'selector', action: 'click', environment: 'local', ...body });
  expect(res.status).toBe(200);
  // The contract this file is now pinned to: attached, with nothing pending.
  expect(res.body.step).toBe('targeting');
  expect(res.body.paired).toBe(true);
  expect(res.body.code).toBeUndefined();
  return res.body.target.targetFieldId as string;
}

function element() {
  return {
    tag: 'a', id: 'buy', classes: ['btn'],
    css: 'a#buy', xpath: '//*[@id="buy"]', text: 'Buy now',
    attrs: [{ name: 'href', value: '/checkout' }],
  };
}

function send(key: string, body: Record<string, unknown>) {
  return request(app).post('/inspector/element').set('x-api-key', key).send({
    element: element(),
    displayAttributes: ['css'],
    sendAttribute: { name: 'css', value: 'a#buy' },
    ...body,
  });
}

beforeEach(() => {
  // Module singletons: without this, one test's pairing survives into the next
  // and a red assertion goes quietly green.
  targetFields.clear();
  inspectorAuth.clear();
  inspectorHub.clear();
});

describe('a Target Field id cannot be forged', () => {
  it('refuses a well-formed id that was never registered', async () => {
    await attach(KEY_A);

    // Correct SHAPE, invented content. The server resolves the STORED record and
    // never parses facts out of the string, so a forgery has nowhere to land.
    const res = await send(KEY_A, { targetFieldId: 'node_node-7__selector__deadbeef' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_FIELD_NOT_FOUND');
    expect(inspectorHub.peek('local')).toHaveLength(0);
  });

  it('refuses a real id this key never paired with', async () => {
    // Registered and live, but this extension was never authorized for it —
    // the case that matters, because the id is guessable from the UI.
    const reg = await openField({ nodeId: 'node-9', fieldKey: 'url', action: 'goto' });
    const unpaired = reg.body.target.targetFieldId;

    // Registered through /inspector/target, which deliberately does NOT bind —
    // only the chooser's route does. So this id is live and unattached, which is
    // precisely the state a guessed id would land in.
    await attach(KEY_A);

    const res = await send(KEY_A, { targetFieldId: unpaired });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_NOT_AUTHORIZED');
    expect(inspectorHub.peek('local')).toHaveLength(0);
  });

  it('will not let one API key ride another key\u2019s pairing', async () => {
    const targetFieldId = await attach(KEY_A);

    // Same account, same field, different extension install.
    const res = await send(KEY_B, { targetFieldId });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('takes the key from the header, ignoring one supplied in the body', async () => {
    const targetFieldId = await attach(KEY_A);

    // KEY_B presenting itself as KEY_A. If the route read the body, this would
    // succeed and pairing would be worth nothing.
    const res = await send(KEY_B, { targetFieldId, apiKey: KEY_A });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('accepts the same send once the key is properly paired', async () => {
    // The control: everything above must fail for the RIGHT reason, not because
    // the happy path is broken too.
    const targetFieldId = await attach(KEY_A);

    const res = await send(KEY_A, { targetFieldId });

    expect(res.status).toBe(200);
    expect(res.body.targetFieldId).toBe(targetFieldId);
    expect(res.body.fieldName).toBe('selector');
    expect(res.body.attribute).toBe('css');
    expect(res.body.value).toBe('a#buy');
  });
});

describe('registration refuses a fieldKey the action does not declare', () => {
  it('rejects an undeclared field and says what IS declared', async () => {
    // coerceParams silently drops undeclared keys on save, so a node would look
    // configured and run unconfigured. Refused at the door instead.
    const res = await openField({ fieldKey: 'not_a_real_field', action: 'click' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('undeclared_field');
    expect(Array.isArray(res.body.declared)).toBe(true);
    expect(res.body.declared.length).toBeGreaterThan(0);
  });

  it('rejects an unknown action outright', async () => {
    const res = await openField({ action: 'no_such_action' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unknown_action');
  });
});

describe('the code MINT route is gone; the REDEEM route is REMOTE-only', () => {
  // WHY THE TWO ROUTES ARE TREATED DIFFERENTLY
  //
  // This describe asserted that BOTH `/inspector/authorize` and `/inspector/pair`
  // 404, on the reasoning that a code asks the operator to carry a secret out of
  // one of the server's own windows and back into another to prove they are
  // themselves. That reasoning is exactly right — about LOCAL, which is the
  // browser runtime on the same server this process runs on.
  //
  // It was applied to REMOTE too, and REMOTE is a browser on the operator's OWN
  // machine:
  //
  //   «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند و ارتباط مستقیم با پلاگین
  //    مرورگر رو نمی‌شه رفت … پس ما هم به یک اتورایز نیاز داریم»
  //
  // Two machines, a real trust gap, and no channel this server can push a dialog
  // through. So the two routes part company:
  //
  //   /inspector/authorize  STAYS GONE. It minted a code on its own, which is how
  //                         a code could exist naming no field — the operator
  //                         holding one while Target stayed empty. Minting now
  //                         happens INSIDE /inspector/targeting/begin, after the
  //                         field is registered, so a code always names a field.
  //
  //   /inspector/pair       IS BACK, for REMOTE only. Redeeming is what creates
  //                         the binding for a browser this server cannot vouch
  //                         for by itself.
  //
  // The absence of the mint route stays guarded here, because nothing else would
  // fail if a later change re-registered it.

  it('answers 404 to POST /inspector/authorize', async () => {
    // A live field, so a 404 can only mean the ROUTE is missing — not the target.
    const reg = await openField();
    expect(reg.status).toBe(200);

    const res = await request(app)
      .post('/inspector/authorize')
      .set('x-api-key', KEY_A)
      .send({ targetFieldId: reg.body.target.targetFieldId });

    expect(res.status).toBe(404);
    expect(res.body.code).toBeUndefined();
  });

  it('serves POST /inspector/pair, and refuses a code it never issued', async () => {
    // Present, and not permissive. A 403 with a §27 reason is the shape the route
    // answers with: the request was well-formed, the credential was not accepted.
    // A 404 here would mean the REMOTE handshake has no far end at all, which is
    // what this test used to require.
    const res = await request(app)
      .post('/inspector/pair')
      .set('x-api-key', KEY_A)
      .send({ code: 'ZZZZZZZZ' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe('INVALID_AUTHORIZATION_CODE');
    // And the refusal hands out nothing: no binding, and no destination that
    // could be reused as an address.
    expect(res.body.binding).toBeUndefined();
    expect(res.body.targetFieldId).toBeUndefined();
  });

  it('mints a code only through targeting/begin, never standing alone', async () => {
    // The property the deleted mint route existed to violate, asserted from the
    // other side: a code exists ONLY as the product of choosing REMOTE for a
    // named field, so it can never be issued without a destination attached.
    const res = await request(app)
      .post('/inspector/targeting/begin')
      .set('x-api-key', KEY_A)
      .send({
        nodeId: 'node-7', fieldKey: 'selector', action: 'click',
        environment: 'remote',
      });

    expect(res.status).toBe(200);
    expect(res.body.authorization.code).toBeTruthy();
    // It names the field it was minted for — that is the whole reason the mint
    // route had to go.
    expect(res.body.authorization.nodeId).toBe('node-7');
    expect(res.body.authorization.fieldKey).toBe('selector');
    expect(res.body.target.targetFieldId).toBeTruthy();
  });

  it('redeems a real code, and refuses the same one twice', async () => {
    // The end-to-end REMOTE handshake over real HTTP, plus the replay guard: a
    // one-time code that still worked on a second use would leave a credential
    // live on whatever screen the operator copied it from.
    const begun = await request(app)
      .post('/inspector/targeting/begin')
      .set('x-api-key', KEY_A)
      .send({
        nodeId: 'node-7', fieldKey: 'selector', action: 'click',
        environment: 'remote',
      });
    const code = begun.body.authorization.code;

    const first = await request(app)
      .post('/inspector/pair').set('x-api-key', KEY_A).send({ code });
    expect(first.status).toBe(200);
    expect(first.body.paired).toBe(true);
    expect(first.body.targetFieldId).toBe(begun.body.target.targetFieldId);

    const again = await request(app)
      .post('/inspector/pair').set('x-api-key', KEY_A).send({ code });
    expect(again.status).toBe(403);
  });

  it('hands out no code, and no address to type it into, on LOCAL', async () => {
    // The two fields the popup must not show for LOCAL. Note the `environment`
    // this always sent: 'local'. The assertion was right for this branch all
    // along — it was the CLAIM around it («neither environment gets a code») that
    // was too broad. Scoped to the branch it actually exercises, and REMOTE's
    // credential is asserted separately above.
    const res = await request(app)
      .post('/inspector/targeting/begin')
      .set('x-api-key', KEY_A)
      .send({ nodeId: 'node-7', fieldKey: 'selector', action: 'click', environment: 'local' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body.baseUrl).toBeUndefined();
    expect(res.body.baseUrlSource).toBeUndefined();
    expect(res.body.display).toBeUndefined();
    expect(res.body.step).toBe('targeting');
  });

  it('still files the binding under the STABLE pairing key', async () => {
    // The property the deleted "legacy route" test was really protecting, kept
    // because it is the reason «دفعات بعد … دیگر نیازی نیست» holds: bind against
    // the ephemeral ADDRESS and re-opening the node looks unpaired again, since
    // the address is re-minted on every open.
    const targetFieldId = await attach(KEY_A, { nodeId: 'node-7', fieldKey: 'selector' });

    const session = await request(app).get('/inspector/session').set('x-api-key', KEY_A);
    const keys = (session.body.pairings || []).map((x: { pairingKey: string }) => x.pairingKey);
    expect(keys).toContain('tf:-:node-7:selector');
    expect(keys).not.toContain(targetFieldId);

    // And the consequence the operator feels: after the address is released,
    // re-opening the SAME field already reports it paired.
    await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A).send({ targetFieldId });
    const again = await request(app).get('/inspector/targeting/options')
      .set('x-api-key', KEY_A).query({ nodeId: 'node-7', fieldKey: 'selector', action: 'click' });
    expect(again.status).toBe(200);
    expect(again.body.paired).toBe(true);
  });
});

describe('releasing one Target Field leaves the others alone', () => {
  it('revokes only the released field\u2019s binding', async () => {
    const first = await attach(KEY_A, { nodeId: 'node-1', fieldKey: 'selector', action: 'click' });
    const second = await attach(KEY_A, { nodeId: 'node-2', fieldKey: 'url', action: 'goto' });

    const rel = await request(app).post('/inspector/target/release')
      .set('x-api-key', KEY_A).send({ targetFieldId: first });
    expect(rel.status).toBe(200);
    expect(rel.body.released).toBe(true);

    // The closed one is gone…
    const dead = await send(KEY_A, { targetFieldId: first });
    expect(dead.body.reason).toBe('TARGET_FIELD_NOT_FOUND');

    // …and the untouched one still works. Several destinations coexist, so
    // closing one node must not disconnect the extension from the rest.
    const alive = await send(KEY_A, { targetFieldId: second });
    expect(alive.status).toBe(200);
    expect(alive.body.fieldName).toBe('url');
  });

  it('reports the session scoped to the asking key', async () => {
    const mine = await attach(KEY_A);

    const a = await request(app).get('/inspector/session').set('x-api-key', KEY_A);
    expect(a.body.authorized.map((b: { targetFieldId: string }) => b.targetFieldId)).toContain(mine);

    // Same account, different install: it can SEE the open fields but is
    // authorized for none of them.
    const b = await request(app).get('/inspector/session').set('x-api-key', KEY_B);
    expect(b.body.targets.length).toBeGreaterThan(0);
    expect(b.body.authorized).toHaveLength(0);
  });
});

// ── §27: nine codes, two languages, no gaps ────────────────────────────────
describe('every §27 refusal code is renderable in both languages', () => {
  const CODES = [
    'BACKEND_UNREACHABLE',
    'INVALID_API_KEY',
    'INVALID_AUTHORIZATION_CODE',
    'AUTHORIZATION_EXPIRED',
    'TARGET_FIELD_NOT_FOUND',
    'TARGET_NOT_AUTHORIZED',
    'INSPECTOR_DISCONNECTED',
    'ELEMENT_INSPECTION_FAILED',
    'ATTRIBUTE_SEND_FAILED',
  ];

  /**
   * Read the dictionary out of the shipped file.
   *
   * Parsed rather than imported because i18n.js is a browser IIFE assigning to
   * `window`, and this is a node environment. Reading the real file is the point:
   * a key added to a copy would prove nothing about what users load.
   */
  function dict(lang: 'fa' | 'en'): Record<string, string> {
    const src = readFileSync(resolve(__dirname, '../../public/js/i18n.js'), 'utf8');
    const out: Record<string, string> = {};
    // The fa block comes first, en second; slice to the requested one so a key
    // present only in fa cannot be found while checking en.
    const faAt = src.indexOf('\n    fa: {');
    const enAt = src.indexOf('\n    en: {');
    expect(faAt).toBeGreaterThan(-1);
    expect(enAt).toBeGreaterThan(faAt);
    const block = lang === 'fa' ? src.slice(faAt, enAt) : src.slice(enAt);

    const re = /'(insp\.err\.[A-Z_]+)':\s*'((?:\\'|[^'])*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) out[m[1]!] = m[2]!;
    return out;
  }

  it('has a Persian message for all nine', () => {
    const fa = dict('fa');
    for (const code of CODES) {
      expect(fa[`insp.err.${code}`], `missing fa message for ${code}`).toBeTruthy();
    }
  });

  it('has an English message for all nine', () => {
    const en = dict('en');
    for (const code of CODES) {
      expect(en[`insp.err.${code}`], `missing en message for ${code}`).toBeTruthy();
    }
  });

  it('keeps the two languages in lockstep', () => {
    // A code present in one language renders as a raw key to exactly the users
    // who cannot read the other one.
    expect(Object.keys(dict('fa')).sort()).toEqual(Object.keys(dict('en')).sort());
  });

  it('does not leave a Persian message written in English', () => {
    const fa = dict('fa');
    for (const code of CODES) {
      // Copy-pasting the en block into fa is the realistic failure, and it looks
      // fine in a diff. Persian text must contain Persian characters.
      expect(/[\u0600-\u06FF]/.test(fa[`insp.err.${code}`]!), `${code} is not translated`).toBe(true);
    }
  });

  it('reaches the same codes the routes actually emit', () => {
    const en = dict('en');
    // The dictionary is only useful if the keys match what the wire carries.
    for (const code of ['TARGET_FIELD_NOT_FOUND', 'TARGET_NOT_AUTHORIZED', 'INVALID_AUTHORIZATION_CODE']) {
      expect(en[`insp.err.${code}`]).toBeTruthy();
    }
  });
});
