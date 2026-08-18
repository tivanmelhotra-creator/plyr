import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════════════════
// LOCAL AND REMOTE ARE TWO FLOWS, AND THEY MUST NOT TRIGGER EACH OTHER
//
// WHY THIS FILE EXISTS
// --------------------
// REPORTED, from a real run in LOCAL mode:
//
//   LOCAL
//   -> Authorization Code
//   -> apparently connected
//   -> Target still empty
//   -> minutes later a Remote-like approval Alert appeared
//   -> accepted the Alert
//   -> only THEN did Target connect
//
// The approval prompt is a REMOTE mechanism. It exists because REMOTE issues no
// Authorization Code, so approving is what attaches the destination. In LOCAL the
// code already does that job, so a prompt there is not redundant decoration -- it
// is a second, competing way to bind a field, and it is why the field looked
// unbound until an unrelated event completed it.
//
// THE CONTRACT
//
//   LOCAL  = API Key + Authorization Code, and NO approval prompt.
//   REMOTE = no API key, no Authorization Code, and an approval prompt.
//
// Enforced on the SERVER, not only in the UI. A UI-only fix would leave the
// prompt being served to whoever polls next, and the extension in the operator's
// own Chrome polls the very same endpoint, with the very same account, as the one
// inside the server's browser. That is exactly how the reported leak happened.
// ════════════════════════════════════════════════════════════════════════════

const KEY_A = 'test_key_123'; // the dashboard's credential
const KEY_B = 'test_key_456'; // a second credential in the SAME account

const ACCOUNT_OF: Record<string, string> = {
  [KEY_A]: 'local',
  [KEY_B]: 'local',
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
      (req as { apiKey?: string }).apiKey = key;
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

/** Start targeting a field in a named environment. */
function begin(
  environment: 'local' | 'remote',
  body: Record<string, unknown> = {},
  key = KEY_A,
) {
  return request(app)
    .post('/inspector/targeting/begin')
    .set('x-api-key', key)
    .send({
      nodeId: 'node-7', fieldKey: 'selector', action: 'click', workflowId: 'wf1',
      environment, ...body,
    });
}

/** What an extension polls to discover approval prompts addressed to it. */
function asked(key = KEY_A, environment?: string) {
  const r = request(app).get('/inspector/consent').set('x-api-key', key);
  return environment ? r.query({ environment }) : r;
}

describe('LOCAL must never raise a Remote approval prompt', () => {
  // ── THE REPORTED DEFECT ──────────────────────────────────────────────────
  it('choosing LOCAL creates no consent request at all', async () => {
    const res = await begin('local');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.environment).toBe('local');

    // LOCAL authorizes with a code; it must not also be handed a prompt.
    expect(res.body.consent == null).toBe(true);
    expect(res.body.openRemoteBrowser).not.toBe(true);

    // And nothing may be pending server-side either. This is the assertion the
    // UI could not make for us: a prompt that EXISTS is a prompt that will be
    // delivered to whoever polls next.
    expect(remoteTargetConsent.pendingFor('local')).toHaveLength(0);
  });

  it('LOCAL is bound INTERNALLY — no code, no prompt, nothing to approve', async () => {
    // The corrected contract: LOCAL = the SERVER-LOCAL browser runtime. The
    // browser runs on the same server/infrastructure as Plyr, so the server
    // grants the binding itself and the flow is step 'targeting' end to end.
    // The old «LOCAL asks for an Authorization Code, and that is the whole
    // handshake» model (PR16) is explicitly rejected and must not come back.
    const res = await begin('local');

    expect(res.body.step).toBe('targeting');
    expect(res.body.code).toBeUndefined();
    expect(res.body.plan.needsAuthorization).toBe(false);
    expect(res.body.plan.serverMayGrant).toBe(true);
    expect(res.body.plan.opensRemoteBrowser).toBe(false);
  });

  // ── THE LEAK PATH ────────────────────────────────────────────────────────
  // One account may legitimately use BOTH environments: one node targeted
  // remotely, another locally. The remote prompt must stay addressed to the
  // remote browser and must not surface in the operator's own Chrome.
  it('a REMOTE prompt is not served to a LOCAL extension in the same account', async () => {
    const remote = await begin('remote', { nodeId: 'node-remote', fieldKey: 'selector' });
    expect(remote.body.consent).toBeTruthy();

    // The extension in the operator's OWN Chrome polls, declaring itself local.
    const local = await asked(KEY_B, 'local');

    expect(local.status).toBe(200);
    expect(local.body.success).toBe(true);
    expect(local.body.requests).toHaveLength(0);
    expect(local.body.count).toBe(0);
  });

  it('the same prompt IS served to a remote extension', async () => {
    const remote = await begin('remote', { nodeId: 'node-remote', fieldKey: 'selector' });
    const consentId = remote.body.consent.consentId;

    const seen = await asked(KEY_B, 'remote');

    expect(seen.status).toBe(200);
    expect(seen.body.requests.map((r: { consentId: string }) => r.consentId))
      .toContain(consentId);
  });

  // The prompt carries its environment, so a client can also refuse it locally.
  // Belt and braces: the server filters, and the client can verify.
  it('every prompt names the environment it belongs to', async () => {
    await begin('remote');
    const seen = await asked(KEY_A, 'remote');

    expect(seen.body.requests.length).toBeGreaterThan(0);
    for (const r of seen.body.requests) expect(r.environment).toBe('remote');
  });
});

describe('REMOTE keeps its approval prompt and needs no code', () => {
  it('choosing REMOTE issues no Authorization Code and raises a prompt', async () => {
    const res = await begin('remote');

    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('remote');
    expect(res.body.step).toBe('targeting');
    // No code, ever, on this branch.
    expect(res.body.code).toBeUndefined();
    expect(res.body.plan.needsAuthorization).toBe(false);
    // But there IS a prompt, and it names what it is asking about.
    expect(res.body.consent).toBeTruthy();
    expect(res.body.consent.nodeId).toBe('node-7');
    expect(res.body.consent.fieldKey).toBe('selector');
  });

  it('a second field reuses the browser and replaces the target, prompt and all', async () => {
    const first = await begin('remote', { nodeId: 'node-A', fieldKey: 'selector' });
    const second = await begin('remote', { nodeId: 'node-B', fieldKey: 'selector' });

    expect(first.body.consent.consentId).not.toBe(second.body.consent.consentId);
    // Both are answerable from the remote browser: the browser stays alive and
    // only the question changes.
    const seen = await asked(KEY_A, 'remote');
    const ids = seen.body.requests.map((r: { consentId: string }) => r.consentId);
    expect(ids).toContain(second.body.consent.consentId);
  });
});

describe('an extension that does not declare an environment', () => {
  // Backward compatibility: an older extension build sends no `environment`.
  // It must keep receiving remote prompts, because the remote browser runs
  // whatever build was side-loaded into it, and silently starving it would
  // break REMOTE entirely.
  it('still receives remote prompts when it declares nothing', async () => {
    const remote = await begin('remote');
    const seen = await asked(KEY_A);

    expect(seen.body.requests.map((r: { consentId: string }) => r.consentId))
      .toContain(remote.body.consent.consentId);
  });
});
