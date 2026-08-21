/**
 * field-identity.test.ts — the six scenarios the rule is defined by.
 *
 * THE RULE UNDER TEST
 * -------------------
 *   «Field Identity Matching اساس کل سیستم است.»
 *
 *   Project Field ID === Extension Field ID          → MATCH
 *       LOCAL:  بدون Alert          REMOTE: بدون Authorization جدید
 *   Project Field ID !== Extension Field ID  |  null → MISMATCH
 *       LOCAL:  Alert               REMOTE: Authorization جدید
 *
 * The six cases are the cross product of the two environments with the three
 * possible states of the extension's id (equal / absent / different), and they
 * are enumerated explicitly rather than generated because each one is a distinct
 * user-visible outcome that was asked for by name.
 *
 * WHAT MAKES THESE TESTS MEANINGFUL RATHER THAN CEREMONIAL
 * -------------------------------------------------------
 * The decision is a PURE function, so each scenario is a real call with real
 * inputs and a real assertion on the returned verdict — not a regex over source
 * text. The previous round of this work failed precisely because its tests
 * inspected source strings, so a rule can be "present in the file" and still not
 * hold. Here, if the branch is wrong the assertion fails.
 *
 * The environment does NOT appear in syncDecision's inputs, and that is
 * deliberate and worth asserting: the comparison is the same in both
 * environments, and only the CONSEQUENCE differs (a prompt versus a code). Tests
 * 1–6 therefore assert the shared verdict, and the consequence table below
 * asserts the mapping from verdict to action for each environment.
 *
 * The HTTP-level counterpart is tests/integration/field-identity-routes.test.ts.
 * Both are needed: this file proves the decision is right, that one proves the
 * route actually consults it. A handler that computed the verdict and then went
 * on issuing codes unconditionally would leave THIS file entirely green.
 */

import { describe, it, expect } from 'vitest';
import {
  syncDecision,
  extensionFieldIdFromRequest,
  FIELD_IDENTITY_HEADER,
} from '../../src/core/FieldIdentity';

/**
 * The field the Project is targeting — the Source of Truth, in every case.
 *
 * Shaped like a real `pairingKey` (`tf:${workflowId}:${nodeId}:${fieldKey}`) and
 * NOT like a `targetFieldId`, because the pairing key is the stable identity the
 * comparison is defined over. A test written against `node_n7__url__f00d1234`
 * would be testing the address, which is re-minted every visit and can never
 * match twice.
 */
const PROJECT_FIELD = 'tf:wf-1:node-7:prompt';
/** A genuinely different field, as an extension left over from earlier work. */
const OTHER_FIELD = 'tf:wf-1:node-9:system';

/**
 * The consequence table, written once so the two environments cannot drift.
 *
 * LOCAL settles a mismatch with an in-page prompt and has NO authorization
 * surface whatsoever. REMOTE settles it with a one-time code and has no prompt.
 * A MATCH settles nothing in either, because there is nothing to settle.
 */
function consequences(environment: 'local' | 'remote', requiresSync: boolean) {
  return {
    // LOCAL raises the Alert, and only on a mismatch.
    alert: environment === 'local' && requiresSync,
    // REMOTE mints a code, and only on a mismatch.
    newAuthorization: environment === 'remote' && requiresSync,
    // «LOCAL هیچ Authorization‌ای ندارد.» — unconditionally, on both verdicts.
    authorizationSurface: environment === 'remote',
  };
}

describe('Field Identity Matching — the six required scenarios', () => {
  // ── LOCAL ────────────────────────────────────────────────────────────────

  it('1. LOCAL + MATCH → no Alert', () => {
    const d = syncDecision(PROJECT_FIELD, PROJECT_FIELD);
    expect(d.verdict).toBe('match');
    expect(d.requiresSync).toBe(false);

    const c = consequences('local', d.requiresSync);
    // The requirement, stated directly: an extension already pointed at this
    // field is asked nothing. Re-opening the same field IS a change but is NOT
    // a mismatch, and it is the mismatch that decides.
    expect(c.alert).toBe(false);
    // And LOCAL never has an authorization surface, match or not.
    expect(c.authorizationSurface).toBe(false);
    expect(c.newAuthorization).toBe(false);
  });

  it('2. LOCAL + Extension Field ID === null → Alert', () => {
    for (const empty of [null, undefined, '', '   ']) {
      const d = syncDecision(PROJECT_FIELD, empty);
      expect(d.verdict).toBe('mismatch');
      expect(d.requiresSync).toBe(true);
      expect(d.reason).toBe('absent');
      // Normalized to null, so "holds nothing" is one state and not four.
      expect(d.extensionFieldId).toBeNull();

      const c = consequences('local', d.requiresSync);
      expect(c.alert).toBe(true);
      // Still no code, even though a sync IS required: LOCAL settles by
      // approval, never by transcription.
      expect(c.authorizationSurface).toBe(false);
    }
  });

  it('3. LOCAL + MISMATCH → Alert', () => {
    const d = syncDecision(PROJECT_FIELD, OTHER_FIELD);
    expect(d.verdict).toBe('mismatch');
    expect(d.requiresSync).toBe(true);
    expect(d.reason).toBe('different');
    // The Project's id is what the extension must adopt — Project > Extension.
    expect(d.projectFieldId).toBe(PROJECT_FIELD);
    expect(d.extensionFieldId).toBe(OTHER_FIELD);

    const c = consequences('local', d.requiresSync);
    expect(c.alert).toBe(true);
    expect(c.authorizationSurface).toBe(false);
  });

  // ── REMOTE ───────────────────────────────────────────────────────────────

  it('4. REMOTE + MATCH → no new Authorization', () => {
    const d = syncDecision(PROJECT_FIELD, PROJECT_FIELD);
    expect(d.verdict).toBe('match');
    expect(d.requiresSync).toBe(false);

    const c = consequences('remote', d.requiresSync);
    // «این سیستم نباید با هر تغییر کوچک، Authorization جدید تولید کند.»
    expect(c.newAuthorization).toBe(false);
    // REMOTE always HAS the surface (the operator may still need the Base URL);
    // what a match removes is the need to mint a NEW code.
    expect(c.authorizationSurface).toBe(true);
    // And no prompt in REMOTE, ever.
    expect(c.alert).toBe(false);
  });

  it('5. REMOTE + Extension Field ID === null → new Authorization', () => {
    const d = syncDecision(PROJECT_FIELD, null);
    expect(d.verdict).toBe('mismatch');
    expect(d.requiresSync).toBe(true);
    expect(d.reason).toBe('absent');

    const c = consequences('remote', d.requiresSync);
    expect(c.newAuthorization).toBe(true);
    expect(c.alert).toBe(false);
  });

  it('6. REMOTE + MISMATCH → new Authorization', () => {
    const d = syncDecision(PROJECT_FIELD, OTHER_FIELD);
    expect(d.verdict).toBe('mismatch');
    expect(d.requiresSync).toBe(true);
    expect(d.reason).toBe('different');

    const c = consequences('remote', d.requiresSync);
    expect(c.newAuthorization).toBe(true);
    expect(c.alert).toBe(false);
  });
});

describe('why the criterion is MATCH/MISMATCH and not "did it change"', () => {
  it('treats re-opening the SAME field as a match, so nothing is re-issued', () => {
    // A second targeting run on one field: a change by any "did something
    // happen" measure, and the case the old unconditional code punished with a
    // fresh prompt/code every time.
    const first = syncDecision(PROJECT_FIELD, PROJECT_FIELD);
    const second = syncDecision(PROJECT_FIELD, PROJECT_FIELD);
    expect(first.requiresSync).toBe(false);
    expect(second.requiresSync).toBe(false);
  });

  it('treats an untouched-but-empty extension as a mismatch, so it is settled', () => {
    // Nothing "changed" here at all, yet a sync is required — the mirror image
    // of the case above, and the reason a change-based test gets both wrong.
    expect(syncDecision(PROJECT_FIELD, null).requiresSync).toBe(true);
  });

  it('is symmetric in equality but not in meaning: Project is the Source of Truth', () => {
    const d = syncDecision(PROJECT_FIELD, OTHER_FIELD);
    // The id the extension must move TO is always the project's.
    expect(d.projectFieldId).toBe(PROJECT_FIELD);
    // Never the reverse: there is no field on the decision that would tell the
    // project to adopt the extension's id.
    expect(Object.keys(d)).not.toContain('adoptExtensionFieldId');
  });
});

describe('normalization — so a mismatch is never reached by accident', () => {
  it('trims, so whitespace does not fake a mismatch', () => {
    expect(syncDecision(PROJECT_FIELD, `  ${PROJECT_FIELD}  `).verdict).toBe('match');
  });

  it('treats a stringified null/undefined as absent, not as a weird id', () => {
    // If any layer stringifies carelessly, `String(null)` produces 'null'. That
    // must land on the intended MISMATCH-because-absent, not on a
    // MISMATCH-because-the-strings-differ that only looks the same today.
    for (const junk of ['null', 'undefined', 'NULL']) {
      const d = syncDecision(PROJECT_FIELD, junk);
      expect(d.verdict).toBe('mismatch');
      expect(d.reason).toBe('absent');
      expect(d.extensionFieldId).toBeNull();
    }
  });

  it('compares case-SENSITIVELY, so two distinct fields never collide', () => {
    // These ids are opaque machine tokens. Case-folding them could declare two
    // genuinely different fields a MATCH — the one error this module exists to
    // prevent, because it binds a browser to the wrong field silently.
    expect(syncDecision('tf:a:b:Prompt', 'tf:a:b:prompt').verdict).toBe('mismatch');
  });

  it('refuses to call anything a match when the Project names no field', () => {
    const d = syncDecision('', 'anything');
    expect(d.requiresSync).toBe(true);
  });
});

describe('the header the extension declares its identity in', () => {
  it('reads the documented header', () => {
    const req = { header: (n: string) => (n === FIELD_IDENTITY_HEADER ? PROJECT_FIELD : undefined) };
    expect(extensionFieldIdFromRequest(req)).toBe(PROJECT_FIELD);
  });

  it('accepts the query string too, which is what shows up in a server log', () => {
    const req = { header: () => undefined, query: { extensionFieldId: PROJECT_FIELD } };
    expect(extensionFieldIdFromRequest(req)).toBe(PROJECT_FIELD);
  });

  it('returns null when nothing is declared — the Dashboard case', () => {
    // public/js/inspector-client.js runs in a DIFFERENT browser from the
    // extension and cannot read its chrome.storage.local, so it can never
    // supply this. Absent → null → MISMATCH by the ordinary rule, with no
    // special case for the dashboard.
    expect(extensionFieldIdFromRequest({ header: () => undefined })).toBeNull();
    expect(syncDecision(PROJECT_FIELD, extensionFieldIdFromRequest({})).requiresSync).toBe(true);
  });

  it('prefers the header over the query string when both are present', () => {
    const req = {
      header: (n: string) => (n === FIELD_IDENTITY_HEADER ? PROJECT_FIELD : undefined),
      query: { extensionFieldId: OTHER_FIELD },
    };
    expect(extensionFieldIdFromRequest(req)).toBe(PROJECT_FIELD);
  });
});
