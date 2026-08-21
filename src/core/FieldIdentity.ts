'use strict';

/**
 * FieldIdentity — the ONE comparison the whole targeting system turns on.
 *
 * THE REQUIREMENT THIS FILE ENCODES
 * ---------------------------------
 *   «Field Identity Matching اساس کل سیستم است.»
 *
 *   `Project Field ID === Extension Field ID`
 *       → MATCH    → LOCAL: بدون Alert          REMOTE: بدون Authorization جدید
 *   `Project Field ID !== Extension Field ID`  یا  `Extension Field ID === null`
 *       → MISMATCH → LOCAL: Alert               REMOTE: Authorization جدید
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT THE SAME THING
 * ----------------------------------------------------
 * The route used to act on "a targeting run happened": every call to
 * /inspector/targeting/begin raised a LOCAL prompt or minted a REMOTE code,
 * unconditionally. A comment in that route even defended it —
 *
 *     "WHY A FRESH CODE PER FIELD IS CORRECT, NOT A NUISANCE"
 *
 * — which is the mistake this module exists to correct. That sentence described
 * a RESULT of the old implementation and then promoted it into a design rule.
 * The actual rule is:
 *
 *     «این سیستم نباید با هر تغییر کوچک، Authorization جدید تولید کند.»
 *
 * The deciding criterion is NOT "did the field change". It is only MATCH versus
 * MISMATCH. Those are genuinely different tests, and the difference is the whole
 * bug: re-opening the SAME field is a change (a new run) but a MATCH (the
 * extension is already pointed there), so it must be silent. Conversely an
 * extension holding nothing has not "changed" anything, yet it is a MISMATCH and
 * must be settled. Keying off change gets both of those backwards.
 *
 * PROJECT IS THE SOURCE OF TRUTH
 * ------------------------------
 *   «Project همیشه Source of Truth است. Project > Extension.»
 *
 * The Extension syncs itself TO the Project, never the reverse. That asymmetry
 * is why the two operands are NOT interchangeable and why this function does not
 * merely return a boolean: on MISMATCH the answer includes WHICH id the
 * extension must move to (`projectFieldId`), and there is no code path anywhere
 * that moves the project to the extension's id.
 *
 * WHICH ID IS COMPARED — THE OBVIOUS CHOICE IS THE WRONG ONE
 * ----------------------------------------------------------
 * Callers must pass the STABLE identity (`pairingKey`), never the address
 * (`targetFieldId`). The latter carries a `crypto.randomBytes(4)` suffix and is
 * re-minted on every registration — background.js documents it as "the ADDRESS …
 * re-minted whenever the node is re-opened". Comparing addresses could never
 * once return MATCH, so the whole feature would silently degrade into the exact
 * behaviour it was written to remove: a prompt or a code on every single visit,
 * forever, for reasons no log would explain.
 *
 * `pairingKey` is `tf:${workflowId}:${nodeId}:${fieldKey}` — derived from the
 * same three facts every time, which is the only reason "the same field" is a
 * question that can be answered at all across two visits.
 *
 * WHY ABSENT MEANS MISMATCH RATHER THAN "UNKNOWN"
 * -----------------------------------------------
 * An extension that has never been targeted has no field id, and the Dashboard
 * path cannot supply one at all — `public/js/inspector-client.js` runs in a
 * DIFFERENT browser from the extension and has no access to its
 * `chrome.storage.local`. So "absent" is not a rare edge case; it is the normal
 * state of one entire code path.
 *
 * Treating absent as MISMATCH is the safe direction. It costs a prompt (LOCAL)
 * or a code (REMOTE) that may turn out to have been unnecessary. Treating it as
 * MATCH would silently declare a browser bound to a field it knows nothing
 * about, and the operator would discover it only when the data landed in the
 * wrong place — or nowhere. One of those is an inconvenience; the other is
 * unnoticed data loss.
 *
 * This also keeps the rule UNIFORM. Both paths ask the same question of the same
 * function; only the source of the right-hand operand differs (the extension
 * declares it via header, or nobody does and it is null). No second rule for the
 * dashboard, and therefore no way for the two to drift apart.
 *
 * WHY THIS IS SEPARATE FROM CONNECTION / BROWSER UI
 * -------------------------------------------------
 *   «Connection/Browser UI را با Authorization قاطی نکن.»
 *
 * This module answers ONLY "must the binding be settled, and how". It says
 * nothing about which cards are visible, what the status line reads, or whether
 * a browser gets launched. Those are separate concerns and deriving them from
 * this decision is what produced the previous defect, where the chooser
 * disappeared exactly when it was needed.
 *
 * In particular, a MATCH is not an instruction to hide anything.
 *
 * WHY THIS IS PURE
 * ----------------
 * No storage, no clock, no registry, no I/O. Given the same two ids it returns
 * the same decision forever, which is what lets the six required scenarios be
 * tested as plain function calls rather than through a live server.
 */

/**
 * How the two ids compared.
 *
 * Two named states rather than a boolean, because `false` at a call site reads
 * as "not matching" while the thing the caller must actually branch on is
 * "needs settling" — and a bare boolean invites the reader to guess which
 * polarity is which.
 */
export type FieldIdentityVerdict = 'match' | 'mismatch';

/**
 * WHY a mismatch was reached. Purely explanatory — no branch may depend on the
 * distinction, because the required rule treats all three identically.
 *
 *   'match'        the ids are equal.
 *   'absent'       the extension declared nothing (null / '' / whitespace).
 *   'different'    both sides named a field, and they are not the same field.
 */
export type FieldIdentityReason = 'match' | 'absent' | 'different';

export interface FieldIdentityDecision {
  /** The verdict the required rule is written in terms of. */
  verdict: FieldIdentityVerdict;
  /** Convenience mirror of `verdict === 'match'`. */
  matched: boolean;
  /**
   * TRUE when the binding must be settled: LOCAL raises the confirmation
   * prompt, REMOTE mints an authorization code. Exactly `!matched` — named
   * separately so the two route branches read as one shared rule rather than as
   * two independent negations that could later drift apart.
   */
  requiresSync: boolean;
  /** Why, for logs and messages only. Never branch on this. */
  reason: FieldIdentityReason;
  /** The id the Project wants — the Source of Truth, normalized. */
  projectFieldId: string;
  /**
   * The id the Extension actually holds, normalized, or `null` when it holds
   * none. `null` and not `''`, so "declared nothing" is distinguishable from
   * "declared something" at a glance.
   */
  extensionFieldId: string | null;
}

/**
 * Normalize one side of the comparison.
 *
 * Trims, and collapses every flavour of "nothing" to `null`. Without this,
 * `undefined`, `null`, `''` and `'  '` would be four distinct values and a
 * header that arrived as the literal string `'null'` — which is what
 * `String(null)` produces if any layer stringifies carelessly — would compare
 * unequal to everything and merely LOOK like a mismatch for the wrong reason.
 */
function normalizeFieldId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  // A literal 'null'/'undefined' is always a stringification accident upstream,
  // never a real field id. Treated as absent so it produces MISMATCH by the
  // intended rule rather than by accidental string inequality.
  const lowered = text.toLowerCase();
  if (lowered === 'null' || lowered === 'undefined') return null;
  return text;
}

/**
 * Compare the Project's field id with the Extension's and decide whether the
 * binding must be settled.
 *
 * @param projectFieldId   what the Project is targeting — the Source of Truth.
 *                         Pass the STABLE `pairingKey`, not `targetFieldId`.
 * @param extensionFieldId what the Extension currently holds, or null/'' if none.
 *
 * Note the argument order matches the rule as written: Project first, because
 * Project > Extension. Swapping them cannot change the verdict (equality is
 * symmetric) but WOULD mislabel `reason` and, worse, put the wrong id in
 * `projectFieldId` — which is the value the extension is then told to adopt.
 */
export function syncDecision(
  projectFieldId: unknown,
  extensionFieldId: unknown,
): FieldIdentityDecision {
  const project = normalizeFieldId(projectFieldId);
  const extension = normalizeFieldId(extensionFieldId);

  // A project that names no field is not a comparison at all — there is nothing
  // to sync TO. Reported as a mismatch because it is certainly not a state in
  // which a binding may be treated as good, and callers must not proceed
  // silently. In practice the route validates the target before reaching here.
  if (!project) {
    return {
      verdict: 'mismatch',
      matched: false,
      requiresSync: true,
      reason: extension ? 'different' : 'absent',
      projectFieldId: '',
      extensionFieldId: extension,
    };
  }

  if (extension === null) {
    return {
      verdict: 'mismatch',
      matched: false,
      requiresSync: true,
      reason: 'absent',
      projectFieldId: project,
      extensionFieldId: null,
    };
  }

  // Exact, case-SENSITIVE comparison. These ids are opaque machine-minted
  // tokens, not human text; case-folding them would let two genuinely distinct
  // fields collide and be silently declared a MATCH — the one error class this
  // module exists to prevent.
  if (extension === project) {
    return {
      verdict: 'match',
      matched: true,
      requiresSync: false,
      reason: 'match',
      projectFieldId: project,
      extensionFieldId: extension,
    };
  }

  return {
    verdict: 'mismatch',
    matched: false,
    requiresSync: true,
    reason: 'different',
    projectFieldId: project,
    extensionFieldId: extension,
  };
}

/**
 * The header the extension declares its current field identity in.
 *
 * Follows `x-browser-environment` — the only other piece of extension-side state
 * the backend already reads — rather than inventing a second convention. A
 * header and not a body field so the Dashboard path, which cannot know this
 * value, simply omits it and lands on `null` = MISMATCH by the normal rule
 * instead of needing a special case.
 */
export const FIELD_IDENTITY_HEADER = 'x-extension-field-id';

/**
 * Read the extension's declared field identity off an incoming request.
 *
 * Accepts the query string as well as the header, for the same reason
 * `/inspector/consent/pending` does: the query string is visible in a server log
 * when diagnosing exactly this class of bug, while the header survives a proxy
 * that rewrites query strings. Either may be used and both mean the same thing.
 *
 * Returns `null` for "not declared", which the rule above turns into MISMATCH.
 */
export function extensionFieldIdFromRequest(req: {
  header?: (name: string) => string | undefined;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): string | null {
  const fromHeader = typeof req.header === 'function'
    ? req.header(FIELD_IDENTITY_HEADER)
    : (req.headers ? req.headers[FIELD_IDENTITY_HEADER] : undefined);

  const fromQuery = req.query ? req.query.extensionFieldId : undefined;
  // The body is accepted last and only as a courtesy to callers that cannot set
  // headers; the header is the documented channel.
  const fromBody = req.body ? req.body.extensionFieldId : undefined;

  return normalizeFieldId(
    fromHeader !== undefined && fromHeader !== null && String(fromHeader).trim()
      ? fromHeader
      : (fromQuery !== undefined && fromQuery !== null && String(fromQuery).trim()
        ? fromQuery
        : fromBody),
  );
}
