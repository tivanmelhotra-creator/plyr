import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════
// FIELD IDENTITY MATCHING, OVER REAL HTTP
//
// WHAT THIS PROVES THAT field-identity.test.ts CANNOT
// ---------------------------------------------------
// The unit suite proves `syncDecision()` returns the right verdict. It says
// NOTHING about whether the route consults it. A handler that computed the
// decision and then went on issuing codes unconditionally — which is exactly
// what the code did before this change — would leave every unit test green while
// reproducing the reported behaviour in full.
//
// That is the same blind spot that let the popup ship broken: something was
// verified, just not the thing the operator experiences. So these tests go over
// the wire and assert on the HTTP response.
//
// THE RULE
// --------
//   «Field Identity Matching اساس کل سیستم است.»
//
//   Project Field ID === Extension Field ID          → MATCH
//       LOCAL:  no Alert            REMOTE: no new Authorization
//   Project Field ID !== Extension Field ID  |  null → MISMATCH
//       LOCAL:  Alert               REMOTE: new Authorization
//
// HOW THE EXTENSION'S HALF ARRIVES
// --------------------------------
// Only the extension knows which field IT holds — the value lives in that
// browser's chrome.storage.local. It is declared on the request as
// `x-extension-field-id`, following `x-browser-environment`, the one other piece
// of extension state the backend already reads.
//
// Until that wire existed the value was stored, read by the popup, and never
// transmitted, so the server had no second operand and could only act
// unconditionally. The prompts and codes that would not stop coming were not a
// policy decision; they were a missing operand.
//
// WHICH VALUE TRAVELS MATTERS AS MUCH AS THAT ONE DOES
// ----------------------------------------------------
// It is the `pairingKey` (`tf:${workflowId}:${nodeId}:${fieldKey}`), NOT
// `targetFieldId`. The latter carries a random suffix and is re-minted on every
// registration, so comparing it would return MISMATCH forever and the feature
// would look implemented while changing nothing. The MATCH cases below therefore
// ask the server for the pairing key it actually minted, rather than guessing.
//
// A request that declares nothing (the Dashboard, which runs in a DIFFERENT
// browser and cannot read the extension's storage) lands on null → MISMATCH,
// which is the safe default and needs no special case.
// ════════════════════════════════════════════════════════════════

const KEY_A = 'test_key_123'; // seeded by tests/integration/setup.ts

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
      (req as { apiKeyUserId?: string }).apiKeyUserId = 'local';
    }
    next();
  });
  app.use(createModeRoutes());
});

/** Module singletons: one scenario's pairing or prompt must not survive. */
function reset() {
  targetFields.clear();
  inspectorAuth.clear();
  inspectorHub.clear();
  // NOTE the name: `resetForTests()`, not `clear()`. Getting this wrong made all
  // eleven of these fail at once with a TypeError, which is at least loud.
  remoteTargetConsent.resetForTests();
}

beforeEach(reset);

const NODE = 'node-7';
const FIELD = 'selector';
const WF = 'wf1';

/**
 * Begin targeting, optionally declaring what the extension currently holds.
 *
 * `held === undefined` means the header is omitted entirely — the Dashboard
 * case, and the state of a freshly installed extension.
 */
function begin(
  environment: 'local' | 'remote',
  held?: string | undefined,
  body: Record<string, unknown> = {},
) {
  const req = request(app)
    .post('/inspector/targeting/begin')
    .set('x-api-key', KEY_A);
  if (held !== undefined) req.set('x-extension-field-id', held);
  return req.send({
    nodeId: NODE, fieldKey: FIELD, action: 'click', workflowId: WF, environment, ...body,
  });
}

/**
 * Ask the server for the STABLE id it minted for this field, so the MATCH cases
 * compare against the real thing rather than a value this test invented.
 *
 * Reads `pairingKey`, NOT `targetFieldId`: the latter carries a random suffix and
 * is re-minted on every registration, so handing it back as "what the extension
 * holds" would assert a MATCH against a value that can never match again — and
 * the test would fail for a reason that has nothing to do with the rule.
 *
 * Everything the probe created is cleared, so the real scenario starts clean.
 */
async function resolveProjectFieldId(environment: 'local' | 'remote' = 'remote'): Promise<string> {
  const res = await begin(environment);
  const id = res.body?.target?.pairingKey;
  expect(typeof id).toBe('string');
  expect(id.length).toBeGreaterThan(0);
  reset();
  return id as string;
}

describe('LOCAL — the Alert is raised only on MISMATCH', () => {
  it('1. LOCAL + MATCH → no Alert, and no authorization surface either', async () => {
    const held = await resolveProjectFieldId('local');
    const res = await begin('local', held);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.identity.verdict).toBe('match');

    // THE REQUIREMENT: no prompt. Before the fix this was an object on every
    // single call, so an extension already pointed at this exact field was
    // asked to confirm moving to the field it was already on.
    expect(res.body.consent).toBeNull();

    // «LOCAL هیچ Authorization‌ای ندارد.» — no code, on either verdict.
    expect(res.body.authorization).toBeNull();

    // The browser still opens: launching is a SEPARATE concern from matching.
    // The operator still needs to SEE the field; they just need not re-approve
    // it. An already-running local browser is reused, not relaunched.
    expect(res.body.openServerBrowser).toBe(true);
  });

  it('2. LOCAL + Extension Field ID absent → Alert', async () => {
    const res = await begin('local'); // header omitted entirely

    expect(res.status).toBe(200);
    expect(res.body.identity.verdict).toBe('mismatch');
    expect(res.body.identity.reason).toBe('absent');
    expect(res.body.identity.extensionFieldId).toBeNull();

    // The prompt IS raised — the extension holds nothing, so a human must
    // confirm where this field should land.
    expect(res.body.consent).not.toBeNull();
    expect(res.body.consent.nodeId).toBe(NODE);
    expect(res.body.consent.fieldKey).toBe(FIELD);

    // Still no code. LOCAL settles by approval, never by transcription.
    expect(res.body.authorization).toBeNull();
  });

  it('3. LOCAL + MISMATCH → Alert', async () => {
    const res = await begin('local', 'tf:wf1:node-99:somewhere-else');

    expect(res.status).toBe(200);
    expect(res.body.identity.verdict).toBe('mismatch');
    expect(res.body.identity.reason).toBe('different');

    expect(res.body.consent).not.toBeNull();
    expect(res.body.authorization).toBeNull();
  });

  it('raises no prompt on a match even after a mismatch raised one', async () => {
    // The ordering that matters in practice: the operator targets a new field
    // (prompt), settles it, then re-opens the SAME field. The second visit must
    // be silent, and must not leave the first prompt lying around to be
    // approved later and re-settle a binding that is already correct.
    const held = await resolveProjectFieldId('local');

    const first = await begin('local'); // nothing held → prompt
    expect(first.body.consent).not.toBeNull();

    const second = await begin('local', held); // now matching → silence
    expect(second.body.identity.verdict).toBe('match');
    expect(second.body.consent).toBeNull();

    // And the stale prompt for this field is gone, not merely unmentioned.
    expect(remoteTargetConsent.pendingFor('local', Date.now(), 'local').length).toBe(0);
  });
});

describe('REMOTE — a new Authorization is minted only on MISMATCH', () => {
  it('4. REMOTE + MATCH → no new Authorization', async () => {
    const held = await resolveProjectFieldId('remote');
    const res = await begin('remote', held);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.identity.verdict).toBe('match');

    // THE REQUIREMENT:
    //   «این سیستم نباید با هر تغییر کوچک، Authorization جدید تولید کند.»
    // Before the fix this object was minted unconditionally.
    expect(res.body.authorization).toBeNull();

    // A match means the field is usable NOW, so the step must not send the
    // dashboard looking for a code that was deliberately never minted.
    expect(res.body.step).toBe('targeting');
    expect(res.body.paired).toBe(true);

    // No prompt in REMOTE, ever — and no launch: the browser is on the
    // operator's own machine.
    expect(res.body.consent).toBeNull();
    expect(res.body.openServerBrowser).toBe(false);
  });

  it('5. REMOTE + Extension Field ID absent → new Authorization', async () => {
    const res = await begin('remote'); // header omitted

    expect(res.status).toBe(200);
    expect(res.body.identity.verdict).toBe('mismatch');
    expect(res.body.identity.reason).toBe('absent');

    expect(res.body.authorization).not.toBeNull();
    expect(typeof res.body.authorization.code).toBe('string');
    expect(res.body.authorization.code.length).toBeGreaterThan(0);
    // The Base URL the far end must reach this server on travels with the code.
    expect(typeof res.body.authorization.baseUrl).toBe('string');

    expect(res.body.step).toBe('authorize');
    expect(res.body.paired).toBe(false);
    expect(res.body.consent).toBeNull();
  });

  it('6. REMOTE + MISMATCH → new Authorization', async () => {
    const res = await begin('remote', 'tf:wf1:node-99:somewhere-else');

    expect(res.status).toBe(200);
    expect(res.body.identity.verdict).toBe('mismatch');
    expect(res.body.identity.reason).toBe('different');

    expect(res.body.authorization).not.toBeNull();
    expect(res.body.authorization.code.length).toBeGreaterThan(0);
    expect(res.body.step).toBe('authorize');
  });

  it('does not answer 500 when a match means no code was minted', async () => {
    // A real hazard, caught by the typechecker while writing this: the old
    // null-guard treated a null `issued` as an issuing FAILURE. Left alone, it
    // would have turned every matching REMOTE field into an HTTP 500 —
    // "nothing needed doing" reported as an error.
    const held = await resolveProjectFieldId('remote');
    const res = await begin('remote', held);
    expect(res.status).toBe(200);
  });

  it('stops re-minting across repeat visits to the same field', async () => {
    // The complaint this whole change answers: every visit produced a new code.
    const held = await resolveProjectFieldId('remote');

    const first = await begin('remote'); // nothing held → code
    expect(first.body.authorization).not.toBeNull();

    // Two further visits, now that the extension holds the field. This is also
    // the assertion that would fail if the comparison used `targetFieldId`: the
    // re-minted address would differ every time and both of these would get a
    // fresh code.
    const second = await begin('remote', held);
    const third = await begin('remote', held);
    expect(second.body.authorization).toBeNull();
    expect(third.body.authorization).toBeNull();
  });
});

describe('the query string carries the identity as well as the header', () => {
  it('accepts ?extensionFieldId=, which is what shows up in a server log', async () => {
    const held = await resolveProjectFieldId('remote');
    const res = await request(app)
      .post(`/inspector/targeting/begin?extensionFieldId=${encodeURIComponent(held)}`)
      .set('x-api-key', KEY_A)
      .send({ nodeId: NODE, fieldKey: FIELD, action: 'click', workflowId: WF, environment: 'remote' });

    expect(res.status).toBe(200);
    expect(res.body.identity.verdict).toBe('match');
    expect(res.body.authorization).toBeNull();
  });
});

describe('LOCAL never exposes an authorization surface, on any verdict', () => {
  it('returns authorization null for match, absent and mismatch alike', async () => {
    const held = await resolveProjectFieldId('local');
    for (const declared of [held, undefined, 'tf:wf1:node-99:elsewhere']) {
      const res = await begin('local', declared);
      expect(res.status).toBe(200);
      // «LOCAL هیچ Authorization‌ای ندارد.» — no code, no generate, no refresh.
      expect(res.body.authorization).toBeNull();
    }
  });
});
