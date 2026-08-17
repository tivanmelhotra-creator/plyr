import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════
// THE SESSION'S TWO HALVES MUST BE ANSWERED IN THE SAME SCOPE
//
// THE BUG THESE EXIST FOR
// -----------------------
// Reported from a live test, three symptoms in one flow:
//
//   «با اینکه اتصال برقرار شد ظاهرا و از افلاین به انلاین تغییر وضعیت کرد پلاگین
//    ولی Connected to target چیزی رو نمایش نداد … ارسال نشد و حتی دکمه ارسال
//    رنگ ماتی داشت»
//
// One cause. GET /inspector/session answered two questions in two different
// scopes:
//
//   authorized — from the API KEY  (the binding was found → popup went ONLINE)
//   targets    — from the extension's own key→user mapping (EMPTY)
//
// The popup computes `live = authorized && target` and gates BOTH the
// "Connected to target" card and the Send button on it, so a mismatch shows up
// as "online, but connected to nothing, and Send is dead".
//
// The mismatch is real whenever the code's issuer and its redeemer resolve to
// different accounts — a separate extension key, API_TOKEN_USER_ID set on one
// side only, or an env admin key (`env_root`) on one side and a user key on the
// other. Redemption deliberately records the ISSUER's account on the binding, so
// the binding is the authoritative answer to "whose targets?".
//
// WHY OVER HTTP AND WITH A MULTI-TENANT SHIM
// ------------------------------------------
// The registries themselves were never wrong — driving them directly passes even
// with the bug present. What was wrong is which userId the ROUTE asked them
// about, so the test has to go through the route, with a key→user mapping that
// actually differs between the two callers. `resolveUserId` returns a fixed
// 'local' in single-user mode, which is precisely why the bug never showed up in
// the existing suites.
// ════════════════════════════════════════════════════════════════

const DASH_KEY = 'dash_key_aaa';
const EXT_KEY = 'ext_key_bbb';

/** Deliberately DIFFERENT accounts: the whole point of the reproduction. */
const USER_OF: Record<string, string> = {
  [DASH_KEY]: 'userA',
  [EXT_KEY]: 'userB',
};

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
      (req as { apiKey?: string }).apiKey = key;
      // The shim that makes the two sides distinct accounts.
      (req as { apiKeyUserId?: string }).apiKeyUserId = USER_OF[key] || 'local';
    }
    next();
  });
  app.use(createModeRoutes());
});

beforeEach(() => {
  targetFields.clear();
  inspectorAuth.clear();
  inspectorHub.clear();
});

/** The dashboard opens the chooser and picks LOCAL: a code comes back. */
function begin(key = DASH_KEY, body: Record<string, unknown> = {}) {
  return request(app)
    .post('/inspector/targeting/begin')
    .set('x-api-key', key)
    .send({
      nodeId: 'node-7', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
      environment: 'local', ...body,
    });
}

/** The extension types the code in. */
function pair(code: string, key = EXT_KEY) {
  return request(app).post('/inspector/pair').set('x-api-key', key).send({ code });
}

/** What the popup asks on open — the request whose answer was self-contradictory. */
function session(key = EXT_KEY) {
  return request(app).get('/inspector/session').set('x-api-key', key);
}

function element() {
  return {
    tag: 'a', id: 'buy', classes: ['btn'],
    css: 'a#buy', xpath: '//*[@id="buy"]', text: 'Buy now',
    attrs: [{ name: 'href', value: '/checkout' }],
  };
}

function send(targetFieldId: string, key = EXT_KEY) {
  return request(app).post('/inspector/element').set('x-api-key', key).send({
    targetFieldId,
    element: element(),
    displayAttributes: ['css'],
    sendAttribute: { name: 'css', value: 'a#buy' },
  });
}

/**
 * The popup's own arithmetic, copied from extension/popup/popup.js so the
 * assertion is about what the USER sees rather than about a JSON shape:
 *
 *   var paired = !!(res && res.targetFieldId);
 *   var live   = !!(res && res.authorized && res.target);
 *
 * `live` is what fills the "Connected to target" card and what un-dims Send.
 */
function popupView(body: Record<string, unknown>, chosenTargetFieldId: string) {
  const authorized = (body.authorized as { targetFieldId: string }[]) || [];
  const targets = (body.targets as { targetFieldId: string }[]) || [];
  const isAuthorized = authorized.some((b) => b.targetFieldId === chosenTargetFieldId);
  const target = targets.find((t) => t.targetFieldId === chosenTargetFieldId) || null;
  return {
    paired: !!chosenTargetFieldId,
    live: !!(isAuthorized && target),
    target,
  };
}

/** The full LOCAL pairing, dashboard → code → extension. */
async function pairedFlow() {
  const begun = await begin();
  expect(begun.status).toBe(200);
  expect(begun.body.step).toBe('authorize');

  const paired = await pair(begun.body.code);
  expect(paired.status).toBe(200);

  const targetFieldId: string = paired.body.binding.targetFieldId;
  expect(targetFieldId).toBeTruthy();
  return { targetFieldId, begun, paired };
}

describe('GET /inspector/session — one scope for both halves of the answer', () => {
  it('reports the paired field as LIVE when the code came from another account', async () => {
    const { targetFieldId } = await pairedFlow();

    const res = await session();
    expect(res.status).toBe(200);

    const view = popupView(res.body, targetFieldId);
    // Before the fix: paired true, live FALSE — "online" with an empty card.
    expect(view.paired).toBe(true);
    expect(view.live).toBe(true);
  });

  it('names the destination, so "Connected to target" is not blank', async () => {
    const { targetFieldId } = await pairedFlow();

    const view = popupView((await session()).body, targetFieldId);
    expect(view.target).not.toBeNull();
    // The three lines the card actually renders: node, field, id.
    expect(view.target?.nodeId).toBe('node-7');
    expect((view.target as { fieldKey?: string })?.fieldKey).toBe('selector');
    expect(view.target?.targetFieldId).toBe(targetFieldId);
  });

  it('lists the target the code was issued for, not an empty list', async () => {
    const { targetFieldId } = await pairedFlow();

    const res = await session();
    const ids = (res.body.targets as { targetFieldId: string }[]).map((t) => t.targetFieldId);
    expect(ids).toContain(targetFieldId);
  });

  it('carries the Browser Environment the dashboard chose, so the card can name it', async () => {
    const { targetFieldId } = await pairedFlow();

    const view = popupView((await session()).body, targetFieldId);
    // LOCAL was chosen at `begin`; the extension never asserts this.
    expect((view.target as { environment?: string })?.environment).toBe('local');
  });

  it('does not list the same target twice when both sides resolve to one account', async () => {
    // The ORDINARY case must be untouched: same key on both sides.
    const begun = await begin(DASH_KEY);
    const paired = await pair(begun.body.code, DASH_KEY);
    const targetFieldId: string = paired.body.binding.targetFieldId;

    const res = await session(DASH_KEY);
    const ids = (res.body.targets as { targetFieldId: string }[]).map((t) => t.targetFieldId);
    expect(ids.filter((id) => id === targetFieldId)).toHaveLength(1);
  });

  it('still shows an UNPAIRED extension nothing it may write to', async () => {
    // A key that redeemed no code must not inherit another account's targets
    // just because that account has a field open. The widening is driven by
    // BINDINGS, never by the mere existence of a target.
    await begin(DASH_KEY);

    const res = await session(EXT_KEY);
    expect(res.body.authorized).toHaveLength(0);
    expect(res.body.targets).toHaveLength(0);
  });

  it('does not leak a THIRD account\'s targets to a paired extension', async () => {
    const { targetFieldId } = await pairedFlow();

    // A different account, with its own open field, that this extension never
    // paired with. Widening the scope must not become "show everything".
    const stranger = 'stranger_key_ccc';
    USER_OF[stranger] = 'userC';
    try {
      await begin(stranger, { nodeId: 'node-99', fieldKey: 'selector' });

      const ids = ((await session()).body.targets as { targetFieldId: string }[])
        .map((t) => t.targetFieldId);
      expect(ids).toContain(targetFieldId);
      expect(ids.some((id) => id.indexOf('node-99') === 0)).toBe(false);
    } finally {
      delete USER_OF[stranger];
    }
  });
});

describe('POST /inspector/element — the pick reaches the account that is watching', () => {
  it('accepts the send instead of leaving the button dead', async () => {
    const { targetFieldId } = await pairedFlow();

    const res = await send(targetFieldId);
    // Before the fix this was 409 TARGET_FIELD_NOT_FOUND: the route looked the
    // target up under the EXTENSION's account, where it does not exist.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.attribute).toBe('css');
    expect(res.body.value).toBe('a#buy');
  });

  it('queues the delivery under the DASHBOARD\'s account, where the node is open', async () => {
    const { targetFieldId } = await pairedFlow();
    await send(targetFieldId);

    // The account polling /inspector/inbox is the one that opened the field.
    // Delivering to the extension's own account would 200 and vanish.
    expect(inspectorHub.peek('userA')).toHaveLength(1);
    expect(inspectorHub.peek('userB')).toHaveLength(0);
  });

  it('still refuses a target this extension was never authorized for', async () => {
    // The scope widening must not become an authorization bypass.
    const begun = await begin(DASH_KEY);
    const targetFieldId: string = begun.body.target.targetFieldId;

    const res = await send(targetFieldId, EXT_KEY);
    expect(res.status).toBe(409);
    expect(['TARGET_FIELD_NOT_FOUND', 'TARGET_NOT_AUTHORIZED']).toContain(res.body.reason);
  });

  it('still refuses an id that was never registered', async () => {
    await pairedFlow();
    const res = await send('node-7__selector__deadbeef');
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('TARGET_FIELD_NOT_FOUND');
  });
});

describe('GET /inspector/targeting/status — the dashboard can see the pairing land', () => {
  it('flips to paired so the code dialog can close itself', async () => {
    const { begun } = await pairedFlow();
    const targetFieldId: string = begun.body.target.targetFieldId;

    // The dialog polls with the DASHBOARD's key: this is what closes it and
    // raises the success alert the operator expected and did not get.
    const res = await request(app)
      .get('/inspector/targeting/status')
      .set('x-api-key', DASH_KEY)
      .query({ targetFieldId });

    expect(res.status).toBe(200);
    expect(res.body.paired).toBe(true);
    expect(res.body.step).toBe('targeting');
  });

  it('reports NOT paired while the code is still unredeemed', async () => {
    const begun = await begin(DASH_KEY);
    const targetFieldId: string = begun.body.target.targetFieldId;

    const res = await request(app)
      .get('/inspector/targeting/status')
      .set('x-api-key', DASH_KEY)
      .query({ targetFieldId });

    expect(res.body.paired).toBe(false);
    expect(res.body.step).toBe('authorize');
  });
});
