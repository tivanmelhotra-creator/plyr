import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════════════════
// LOCAL AND REMOTE ARE TWO FLOWS, AND THEY MUST NOT TRIGGER EACH OTHER
//
// WHY THIS FILE EXISTS
// --------------------
// REPORTED, from a real run:
//
//   chose one environment
//   -> Authorization Code
//   -> apparently connected
//   -> Target still empty
//   -> minutes later an approval Alert appeared
//   -> accepted the Alert
//   -> only THEN did Target connect
//
// Two competing ways to bind one field. Whichever of them the operator was not
// expecting is the one that made the field look unbound until an unrelated event
// completed it. So each environment gets exactly ONE binding mechanism, and the
// separation is enforced on the SERVER.
//
// ── WHICH MECHANISM BELONGS TO WHICH BROWSER ───────────────────────────────
//
// This file had the two the wrong way round, and the operator reported the
// consequence directly:
//
//   «وقتی روی پیکر می‌زنم و باکس بالا می‌آید که لوکال می‌خواهی یا ریموت، وقتی
//    لوکال می‌زنم باید مرورگر لوکال سرور بالا بیاید ولی برعکس است»
//
// Read from the PROJECT's point of view, LOCAL is the browser runtime on the SAME
// server as this process and REMOTE is a browser on the operator's own machine.
// That single fact decides everything else:
//
//   LOCAL   One machine, one trust domain. Nothing to prove and no address to
//           transcribe, so NO code and NO Base URL. But the server's browser is
//           one shared, long-lived window that outlives a targeting run, so a
//           human must say which field the next pick belongs to:
//           an in-page approval prompt, and it is the whole handshake.
//
//   REMOTE  Two machines, a real trust gap, and no channel this server can push
//           a dialog through. So NO prompt — an Authorization Code plus a Base
//           URL instead, carried by the operator:
//           «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند … پس ما هم به یک اتورایز
//            نیاز داریم … و هم به یک بیس یو ار ال»
//
// THE CONTRACT
//
//   LOCAL  = no code, no Base URL, and an approval prompt.
//   REMOTE = an Authorization Code + Base URL, and NO approval prompt.
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

/**
 * What an extension polls to discover approval prompts addressed to it.
 *
 * The declaration is sent BOTH ways when given, exactly as background.js does:
 * the query string is what a server log shows when diagnosing this class of bug,
 * and the header survives a proxy that rewrites query strings. The route accepts
 * either and treats them identically.
 *
 * Omitting it is a real case, not a shortcut — see the last describe block.
 */
function asked(key = KEY_A, environment?: string) {
  const r = request(app).get('/inspector/consent').set('x-api-key', key);
  return environment ? r.set('x-browser-environment', environment).query({ environment }) : r;
}

describe('LOCAL is the environment that DOES raise the approval prompt', () => {
  // ── THE REPORTED DEFECT ──────────────────────────────────────────────────
  it('choosing LOCAL opens the server\'s browser and asks which field it is for', async () => {
    // THE INVERSION, AT ITS SOURCE. This test asserted that LOCAL creates no
    // consent request at all and opens nothing — which is precisely why pressing
    // LOCAL launched nothing: «وقتی لوکال می‌زنم باید مرورگر لوکال سرور بالا
    // بیاد ولی برعکسه».
    const res = await begin('local');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.environment).toBe('local');

    // It opens (or reuses) the browser on THIS server. Named for what it opens;
    // `openRemoteBrowser` said the opposite of what it did.
    expect(res.body.openServerBrowser).toBe(true);
    expect(res.body.runtime).toBe('server-local');

    // And it raises the prompt there, naming the field so a human can verify it.
    // «اگر بالا باشه که الرت میده اگر بالا نباشه یکی بالا میاره و بعدش الرت میده»
    expect(res.body.consent).toBeTruthy();
    expect(res.body.consent.nodeId).toBe('node-7');
    expect(res.body.consent.fieldKey).toBe('selector');
    expect(remoteTargetConsent.pendingFor('local')).toHaveLength(1);
  });

  it('LOCAL asks for no credential — the approval is the whole handshake', async () => {
    // The property this test always guarded — LOCAL's handshake involves nothing
    // the operator must fetch from elsewhere — with the mechanism corrected. The
    // flag names changed WITH the meaning, and that is the point: while they read
    // `needsRemoteApproval` / `opensRemoteBrowser`, an assertion that LOCAL had
    // neither looked entirely reasonable.
    const res = await begin('local');

    expect(res.body.step).toBe('targeting');
    expect(res.body.plan.needsAuthorization).toBe(false);
    expect(res.body.plan.serverMayGrant).toBe(true);
    expect(res.body.plan.needsInPageApproval).toBe(true);
    expect(res.body.plan.opensServerBrowser).toBe(true);
    // Nothing for the operator to read, copy or retype anywhere in the response:
    // «Resolved automatically by the server that runs this browser. There is
    // nothing to enter.»
    expect(res.body.code).toBeUndefined();
    expect(res.body.baseUrl).toBeUndefined();
    expect(res.body.authorization).toBeNull();
  });

  // ── THE LEAK PATH ────────────────────────────────────────────────────────
  // One account may legitimately use BOTH environments: one node targeted on the
  // server's browser, another on the operator's own. The server-browser prompt
  // must stay addressed there and must not surface in the operator's own Chrome,
  // where approving it would bind a destination from the wrong machine.
  it('a LOCAL prompt is not served to a REMOTE extension in the same account', async () => {
    const local = await begin('local', { nodeId: 'node-local', fieldKey: 'selector' });
    expect(local.body.consent).toBeTruthy();

    // The extension in the operator's OWN Chrome polls, declaring itself remote.
    const seen = await asked(KEY_B, 'remote');

    expect(seen.status).toBe(200);
    expect(seen.body.success).toBe(true);
    expect(seen.body.requests).toHaveLength(0);
    expect(seen.body.count).toBe(0);
  });

  it('the same prompt IS served to the server\'s own browser', async () => {
    const local = await begin('local', { nodeId: 'node-local', fieldKey: 'selector' });
    const consentId = local.body.consent.consentId;

    const seen = await asked(KEY_B, 'local');

    expect(seen.status).toBe(200);
    expect(seen.body.requests.map((r: { consentId: string }) => r.consentId))
      .toContain(consentId);
  });

  // The prompt carries its environment, so a client can also refuse it locally.
  // Belt and braces: the server filters, and the client can verify.
  it('every prompt names the environment it belongs to', async () => {
    await begin('local');
    const seen = await asked(KEY_A, 'local');

    expect(seen.body.requests.length).toBeGreaterThan(0);
    for (const r of seen.body.requests) expect(r.environment).toBe('local');
  });

  it('a second field re-asks about the NEW field, not the old one', async () => {
    // The repeat case, and the reason the prompt exists at all. The browser is
    // already up and still holding node-A's address, so nothing but a human can
    // say that the next pick belongs to node-B:
    // «مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد … میگه که چه نودی، چه فیلدی»
    const first = await begin('local', { nodeId: 'node-A', fieldKey: 'selector' });
    const second = await begin('local', { nodeId: 'node-B', fieldKey: 'selector' });

    expect(first.body.consent.consentId).not.toBe(second.body.consent.consentId);
    const seen = await asked(KEY_A, 'local');
    const ids = seen.body.requests.map((r: { consentId: string }) => r.consentId);
    expect(ids).toContain(second.body.consent.consentId);
  });
});

describe('REMOTE keeps the Authorization Code and raises no prompt', () => {
  it('choosing REMOTE issues a code and a Base URL, and asks nobody anything', async () => {
    const res = await begin('remote');

    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('remote');
    // The second step, restored to the ONE environment that always needed it.
    expect(res.body.step).toBe('authorize');
    expect(res.body.plan.needsAuthorization).toBe(true);
    expect(res.body.authorization).toBeTruthy();
    expect(res.body.authorization.code).toBeTruthy();
    // «و هم به یک بیس یو ار ال» — resolved centrally by PublicBaseUrl.
    expect(typeof res.body.authorization.baseUrl).toBe('string');
    expect(res.body.authorization.baseUrl.length).toBeGreaterThan(0);

    // And NO prompt: this server cannot raise a dialog inside a browser on
    // somebody else's desktop, and the code already named exactly one field, so
    // a second question would re-ask something already answered.
    expect(res.body.consent == null).toBe(true);
    expect(res.body.openServerBrowser).toBe(false);
    expect(remoteTargetConsent.pendingFor('local')).toHaveLength(0);
  });

  it('opens nothing on this server, because the browser is not on it', async () => {
    const res = await begin('remote');
    expect(res.body.plan.opensServerBrowser).toBe(false);
    expect(res.body.plan.needsInPageApproval).toBe(false);
    // No grant either: this server will not vouch for a browser it has never
    // seen. The binding is created when the code is redeemed at /inspector/pair.
    expect(res.body.plan.serverMayGrant).toBe(false);
    expect(inspectorHub.peek('local')).toHaveLength(0);
  });

  it('a second field gets its own code, so the far browser can follow', async () => {
    // «هر بار فیلد جدید اتورایز جدید باعث شد ما همیشه با فیلد جدید ست بمونیم»
    // The code carries the destination, so reusing one could not express a move.
    const first = await begin('remote', { nodeId: 'node-A', fieldKey: 'selector' });
    const second = await begin('remote', { nodeId: 'node-B', fieldKey: 'selector' });

    expect(first.body.authorization.code).not.toBe(second.body.authorization.code);
    expect(second.body.authorization.fieldKey).toBe('selector');
    // Still no prompts, from either call.
    expect((await asked(KEY_A, 'local')).body.count).toBe(0);
  });
});

describe('an extension that does not declare an environment', () => {
  // Backward compatibility, RE-AIMED WITH THE CONTRACT. An older extension build
  // sends no `environment`. It must keep receiving the prompts that exist, and
  // the prompts now belong to the SERVER's browser — which is precisely the
  // browser this server side-loads, so it is the one most likely to be running
  // an older build. Starving it would break the environment the prompt exists
  // for.
  //
  // RemoteTargetConsent.pendingFor() is strict in the other direction: anything
  // that is not an explicit 'remote' is treated as the server's browser, so an
  // undeclared poller sees LOCAL prompts and never REMOTE-stamped ones. The
  // client-side gate in background.js is the second, independent barrier for the
  // operator's own browser.
  it('still receives the server browser\'s prompts when it declares nothing', async () => {
    const local = await begin('local');
    const seen = await asked(KEY_A);

    expect(seen.body.requests.map((r: { consentId: string }) => r.consentId))
      .toContain(local.body.consent.consentId);
  });

  it('and REMOTE has no prompts for it to be given by mistake', async () => {
    // The mirror: REMOTE raises none at all, so there is nothing an undeclared
    // poller could be handed from that path in the first place.
    await begin('remote');
    const seen = await asked(KEY_A);
    expect(seen.body.count).toBe(0);
  });
});
