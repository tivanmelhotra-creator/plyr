'use strict';

/**
 * TargetFieldRegistry — WHERE a picked value lands.
 *
 * THE ONE QUESTION THIS ANSWERS
 * -----------------------------
 * The Element Inspector runs in a browser, on a page this server does not
 * control. When a value arrives, something must answer "which field of which
 * node does this belong in?" — and answer it without guessing.
 *
 * The previous design answered it with `sessionId + nodeId`, and that had two
 * defects:
 *
 *   1. GRANULARITY. The destination was a NODE, so every pick had to be mapped
 *      back to fields by inspecting which attributes were ticked. A node with
 *      two selector-shaped params could not be targeted precisely.
 *   2. THE WRONG IDENTITY. `sessionId` was a browser-tab id (`ui-…`) that the
 *      extension could not know, so the extension had to fetch the server's
 *      current claim and echo it back on every submit just to pass an equality
 *      check. That round trip carried no information: the value it sent was the
 *      value the server had handed it moments earlier.
 *
 * So the destination is now a first-class thing with its own identity:
 *
 *     node_<nodeId>__<fieldKey>__<uniqueSuffix>
 *     e.g. node_8f21__product_selector__a73f
 *
 * and Session is out of the picture entirely. `SessionHandoff` keeps its own
 * `as_…` id for Remote⇄Local transfer; nothing here reads it, which is what
 * makes "a mode switch must not invalidate a Target Field" true by construction
 * rather than by convention.
 *
 * SERVER-AUTHORITATIVE, AND WHY THAT IS THE WHOLE POINT
 * ----------------------------------------------------
 * The requirement is explicit: «Backend باید Target Field را server-side
 * resolve کند و نباید به nodeId یا fieldKey ارسالی client برای authorization
 * اعتماد کند».
 *
 * Two concrete consequences, both load-bearing:
 *
 *   - `uniqueSuffix` is minted HERE with `crypto.randomBytes`. If the client
 *     supplied it, it could re-register a suffix it had seen before and revive a
 *     destination the user had closed — which is precisely the stale-delivery
 *     the suffix exists to prevent.
 *   - `resolve()` returns the STORED record. The id is a lookup key, never a
 *     source of facts. A caller that parsed `nodeId` out of the string would
 *     accept `node_<victim>__password__<forged>` from anyone who can spell the
 *     format; this module never parses, so that attack has nowhere to land.
 *
 * `fieldKey` is checked against the action's DECLARED params (see
 * ActionCatalog). An undeclared key is not a harmless typo: `coerceParams()`
 * drops unknown keys on save, so the value would appear in the editor and then
 * vanish on run — a node that looks configured and runs unconfigured.
 *
 * SCOPED PER USER, ALWAYS
 * -----------------------
 * The outer map is keyed by `userId`, which comes only from the authenticated
 * API key. A target registered by one account is invisible to another: not
 * "refused with a message" but absent, because whether someone else's field
 * exists is not information this API should leak.
 *
 * IN MEMORY, deliberately — same reasoning as BrowserMode and InspectorHub. A
 * target describes a node open in a browser tab talking to THIS process.
 * Persisting it would let a value land in a field nobody is looking at.
 */

import crypto from 'node:crypto';
import { isDeclaredField, isKnownAction, declaredFields } from './ActionCatalog';

/** What the caller asks for when a field's picker button is pressed. */
export interface TargetFieldRequest {
  nodeId: string;
  fieldKey: string;
  /** The node's action id — how `fieldKey` is validated. */
  action: string;
  workflowId?: string;
  /** A human label for "value added to: Click → Selector". */
  label?: string;
}

/** A registered destination. `targetFieldId` is the only handle clients get. */
export interface TargetField {
  targetFieldId: string;
  nodeId: string;
  fieldKey: string;
  action: string;
  workflowId?: string;
  label?: string;
  registeredAt: number;
}

export type TargetFieldRejection =
  | 'invalid_node_id'
  | 'invalid_field_key'
  | 'unknown_action'
  | 'undeclared_field';

export interface TargetFieldRegistration {
  ok: boolean;
  target?: TargetField;
  reason?: TargetFieldRejection;
  /** For `undeclared_field`: what this action does declare. */
  declared?: string[];
}

/**
 * How long a target stays valid without being refreshed.
 *
 * Matches the old claim TTL: long enough to hunt for an element on a slow page,
 * short enough that a node abandoned yesterday cannot receive today's value.
 */
export const TARGET_TTL_MS = 30 * 60 * 1000;

/**
 * A ceiling on concurrent targets per user.
 *
 * Several MUST be able to coexist — that is an explicit requirement, and the
 * reason this is a map rather than the single slot the old design had. But
 * unbounded is a leak: a long editing session opens and closes many nodes, and
 * a user who never closes the tab would accumulate them forever. When full, the
 * OLDEST is evicted, because the one just registered is the one the user is
 * looking at.
 */
export const TARGETS_MAX = 50;

/** Ids must not contain the `__` separator, or the format becomes ambiguous. */
const SEPARATOR = '__';

function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Is this a usable id component?
 *
 * Rejects the separator (so `node_a__b__c` can never be mistaken for a
 * different pair) and anything outside a conservative id charset. A nodeId with
 * a space or a quote in it has no legitimate source — the editor mints `n1`,
 * `n2`, `start` — and allowing one would put attacker-chosen text into a string
 * other code splits on.
 */
function validIdPart(s: string): boolean {
  if (!s) return false;
  if (s.includes(SEPARATOR)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
}

export class TargetFieldRegistry {
  /** userId -> targetFieldId -> target. Two levels so several can coexist. */
  private targets = new Map<string, Map<string, TargetField>>();

  /**
   * Register a destination and mint its id.
   *
   * Every rejection names a cause rather than returning a generic false: the
   * caller is a UI that must tell the user what to fix, and "undeclared field"
   * versus "unknown action" point at genuinely different mistakes.
   */
  register(userId: string, req: TargetFieldRequest): TargetFieldRegistration {
    const owner = clean(userId, 200);
    const nodeId = clean(req?.nodeId, 200);
    const fieldKey = clean(req?.fieldKey, 120);
    const action = clean(req?.action, 80);

    if (!owner || !validIdPart(nodeId)) return { ok: false, reason: 'invalid_node_id' };
    if (!validIdPart(fieldKey)) return { ok: false, reason: 'invalid_field_key' };
    if (!isKnownAction(action)) return { ok: false, reason: 'unknown_action' };
    // The rule that stops a value being silently dropped on save. See the file
    // header and ActionCatalog for why this is not merely defensive.
    if (!isDeclaredField(action, fieldKey)) {
      return { ok: false, reason: 'undeclared_field', declared: declaredFields(action) };
    }

    const suffix = crypto.randomBytes(4).toString('hex');
    const target: TargetField = {
      targetFieldId: `node_${nodeId}${SEPARATOR}${fieldKey}${SEPARATOR}${suffix}`,
      nodeId,
      fieldKey,
      action,
      workflowId: clean(req.workflowId, 200) || undefined,
      label: clean(req.label, 200) || undefined,
      registeredAt: Date.now(),
    };

    let mine = this.targets.get(owner);
    if (!mine) { mine = new Map(); this.targets.set(owner, mine); }

    // Re-registering the SAME node+field replaces the previous entry rather than
    // piling up a new suffix per NDV open. Without this, opening one node ten
    // times would hold ten live destinations for one visible field, and nine of
    // them would be indistinguishable from the real one.
    for (const [id, t] of mine) {
      if (t.nodeId === nodeId && t.fieldKey === fieldKey) mine.delete(id);
    }

    this.sweepOwner(mine);
    while (mine.size >= TARGETS_MAX) {
      const oldest = mine.keys().next();
      if (oldest.done) break;
      mine.delete(oldest.value);
    }

    mine.set(target.targetFieldId, target);
    return { ok: true, target };
  }

  /**
   * The stored record for this id, or null.
   *
   * THE ONLY authorized way to turn an id into a destination. Returns a copy so
   * a caller cannot mutate the registry by holding the result, and null for a
   * target belonging to someone else — indistinguishable from "does not exist",
   * on purpose.
   */
  resolve(userId: string, targetFieldId: string): TargetField | null {
    const mine = this.targets.get(clean(userId, 200));
    if (!mine) return null;
    const t = mine.get(clean(targetFieldId, 400));
    if (!t) return null;
    if (Date.now() - t.registeredAt > TARGET_TTL_MS) {
      mine.delete(t.targetFieldId);
      return null;
    }
    return { ...t };
  }

  /**
   * Forget one target.
   *
   * Scoped to a single id BY DESIGN: closing one node must not disturb another
   * node's live destination, which the old single-slot claim could not express.
   */
  unregister(userId: string, targetFieldId: string): boolean {
    const mine = this.targets.get(clean(userId, 200));
    if (!mine) return false;
    const removed = mine.delete(clean(targetFieldId, 400));
    if (!mine.size) this.targets.delete(clean(userId, 200));
    return removed;
  }

  /** Everything live for this user, newest last. For a status view. */
  list(userId: string): TargetField[] {
    const mine = this.targets.get(clean(userId, 200));
    if (!mine) return [];
    this.sweepOwner(mine);
    return [...mine.values()].map((t) => ({ ...t }));
  }

  /** Drop expired entries for one user. */
  private sweepOwner(mine: Map<string, TargetField>): void {
    const now = Date.now();
    for (const [id, t] of mine) {
      if (now - t.registeredAt > TARGET_TTL_MS) mine.delete(id);
    }
  }

  /** Drop every expired entry, for a periodic timer. */
  sweep(): void {
    for (const [owner, mine] of this.targets) {
      this.sweepOwner(mine);
      if (!mine.size) this.targets.delete(owner);
    }
  }

  clear(): void {
    this.targets.clear();
  }
}

/**
 * The process-wide registry.
 *
 * A singleton for the same reason `browserModes` is one: it describes live
 * editor state in THIS process, and two registries would disagree about where a
 * value belongs.
 */
export const targetFields = new TargetFieldRegistry();
