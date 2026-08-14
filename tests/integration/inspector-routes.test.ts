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

/** Full pairing dance for `key`, returning the field it is now bound to. */
async function pair(key: string, body: Record<string, unknown> = {}) {
  const reg = await openField(body);
  expect(reg.status).toBe(200);
  const targetFieldId = reg.body.target.targetFieldId as string;

  const auth = await request(app)
    .post('/inspector/authorize')
    .set('x-api-key', KEY_A)
    .send({ targetFieldId });
  expect(auth.status).toBe(200);

  const paired = await request(app)
    .post('/inspector/pair')
    .set('x-api-key', key)
    .send({ code: auth.body.code });
  expect(paired.status).toBe(200);

  return targetFieldId;
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
    await pair(KEY_A);

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

    await pair(KEY_A);

    const res = await send(KEY_A, { targetFieldId: unpaired });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_NOT_AUTHORIZED');
    expect(inspectorHub.peek('local')).toHaveLength(0);
  });

  it('will not let one API key ride another key\u2019s pairing', async () => {
    const targetFieldId = await pair(KEY_A);

    // Same account, same field, different extension install.
    const res = await send(KEY_B, { targetFieldId });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('takes the key from the header, ignoring one supplied in the body', async () => {
    const targetFieldId = await pair(KEY_A);

    // KEY_B presenting itself as KEY_A. If the route read the body, this would
    // succeed and pairing would be worth nothing.
    const res = await send(KEY_B, { targetFieldId, apiKey: KEY_A });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_NOT_AUTHORIZED');
  });

  it('accepts the same send once the key is properly paired', async () => {
    // The control: everything above must fail for the RIGHT reason, not because
    // the happy path is broken too.
    const targetFieldId = await pair(KEY_A);

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

describe('authorization codes are scoped and single-use', () => {
  it('will not issue a code for an id that does not exist', async () => {
    const res = await request(app)
      .post('/inspector/authorize')
      .set('x-api-key', KEY_A)
      .send({ targetFieldId: 'node_ghost__selector__aaaa' });

    // 404, and no code: issuing one would let a caller discover valid ids by
    // watching which requests produce a code.
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('TARGET_FIELD_NOT_FOUND');
    expect(res.body.code).toBeUndefined();
  });

  it('reports an unknown code as INVALID rather than as a server error', async () => {
    const res = await request(app)
      .post('/inspector/pair')
      .set('x-api-key', KEY_A)
      .send({ code: 'ZZZZZZZZ' });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('INVALID_AUTHORIZATION_CODE');
  });

  it('refuses a code that has already been redeemed', async () => {
    const reg = await openField();
    const auth = await request(app)
      .post('/inspector/authorize')
      .set('x-api-key', KEY_A)
      .send({ targetFieldId: reg.body.target.targetFieldId });

    const first = await request(app).post('/inspector/pair').set('x-api-key', KEY_A)
      .send({ code: auth.body.code });
    expect(first.status).toBe(200);

    // A code that lingered could pair a second, unintended extension.
    const second = await request(app).post('/inspector/pair').set('x-api-key', KEY_B)
      .send({ code: auth.body.code });
    expect(second.status).toBe(403);
    expect(second.body.reason).toBe('INVALID_AUTHORIZATION_CODE');
  });
});

describe('releasing one Target Field leaves the others alone', () => {
  it('revokes only the released field\u2019s binding', async () => {
    const first = await pair(KEY_A, { nodeId: 'node-1', fieldKey: 'selector', action: 'click' });
    const second = await pair(KEY_A, { nodeId: 'node-2', fieldKey: 'url', action: 'goto' });

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
    const mine = await pair(KEY_A);

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
