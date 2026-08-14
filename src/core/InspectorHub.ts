'use strict';

/**
 * InspectorHub — where a picked element becomes a filled-in FIELD.
 *
 * WHAT CHANGED, AND WHY IT HAD TO
 * -------------------------------
 * This file used to route by `sessionId + nodeId`. Two defects made that
 * untenable:
 *
 *   1. THE DESTINATION WAS A NODE, not a field. So `mapSelectionToFields` had to
 *      GUESS which param the user meant by inspecting which attributes were
 *      ticked — css became `selector`, the first non-identity key became
 *      `attribute`, and a node with two selector-shaped params could not be
 *      addressed at all. A guess that lands in the wrong param of the right node
 *      is exactly the silent mis-delivery this subsystem exists to prevent.
 *
 *   2. `sessionId` WAS THE WRONG IDENTITY. It was a browser-tab id (`ui-…`) the
 *      extension could not know, so the extension fetched the server's current
 *      claim and echoed it back purely to pass an equality check. That round trip
 *      carried no information — the value it sent was the value the server had
 *      handed it moments earlier — while making a Session change look like a
 *      reason to invalidate a destination. It is not one.
 *
 * So routing is now by `targetFieldId`, resolved SERVER-SIDE through
 * TargetFieldRegistry, and Session is out of this file entirely. SessionHandoff
 * keeps its own `as_…` id for Remote⇄Local transfer; nothing here reads it, which
 * is what makes "a mode switch must not invalidate a Target Field" true by
 * construction rather than by convention.
 *
 * EXACTLY ONE VALUE IS WRITTEN
 * ----------------------------
 * The requirement splits the two controls the UI shows per attribute:
 *
 *   CHECKBOX (`displayAttributes`) — what the user wants to SEE. Display only.
 *   RADIO    (`sendAttribute`)     — the single value that is SENT.
 *
 * `fields` therefore always has exactly one key: the resolved target's
 * `fieldKey`. It deliberately does NOT also set a companion like `selectorType`,
 * even though the old node-level code did: the button the user pressed was next
 * to one field, and writing a second one would be this layer deciding something
 * it was not asked to decide.
 *
 * THE VALUE IS RECOMPUTED, NOT TRUSTED
 * ------------------------------------
 * `sendAttribute` arrives as `{name, value}`, but the value written is the one
 * this server derives from the submitted element via `valueForKey`. A client that
 * says `{name: 'cssSelector', value: '<something else>'}` gets the CSS selector
 * of the element it actually sent, or a refusal — never its own substitute. The
 * name selects; it does not supply.
 *
 * GENERIC ATTRIBUTES, NOT A HARDCODED LIST
 * ----------------------------------------
 * `data-*` must work in full generality — `data-id`, `data-product` and anything
 * a site invented this morning. `valueForKey` handles the COMPUTED keys (css,
 * xpath, text …) by name and then falls through to a LOOKUP in the element's own
 * attribute list. That one default branch is what makes href, src, colspan,
 * placeholder, aria-* and every future attribute work without this file ever
 * being edited again. A hardcoded enum would need a release per attribute.
 */

import { targetFields, type TargetField, type TargetFieldRegistry } from './TargetFieldRegistry';
import { inspectorAuth, type InspectorAuthorizationRegistry } from './InspectorAuthorization';

/** One attribute exactly as the DOM had it. */
export interface InspectorAttr {
  name: string;
  value: string;
}

/**
 * An element as the extension saw it.
 *
 * Only `tag` is required. Every other field is genuinely absent for some real
 * element (a `<div>` has no value, a `<span>` has no id), and demanding them
 * would mean the extension inventing empty strings that then look like data.
 */
export interface InspectorElement {
  tag: string;
  id?: string;
  classes?: string[];
  css?: string;
  xpath?: string;
  text?: string;
  value?: string;
  name?: string;
  role?: string;
  type?: string;
  attrs?: InspectorAttr[];
  /** Where it was picked from, for the UI to show context. */
  url?: string;
  title?: string;
}

/** The single radio choice: which property to send. */
export interface SendAttribute {
  name: string;
  /** What the extension displayed. Advisory — the server recomputes. */
  value?: string;
}

export interface InspectorSubmission {
  /** The destination. A lookup key only; never a source of facts. */
  targetFieldId: string;
  /** Proves this client was paired with that destination. */
  apiKey?: string;
  element: InspectorElement;
  /** CHECKBOX state — what to show in SELECTED ELEMENT. Display only. */
  displayAttributes?: string[];
  /** RADIO state — the one property that is sent. */
  sendAttribute: SendAttribute;
  mode?: string;
}

/** What the UI receives and applies to exactly one field. */
export interface InspectorDelivery {
  id: string;
  ts: number;
  mode: string;
  /** The resolved destination, from the registry — not from the client. */
  target: TargetField;
  element: InspectorElement;
  /** Echoed for the UI's SELECTED ELEMENT panel. Never affects `fields`. */
  displayAttributes: string[];
  /** The property that was sent, and the value the server derived. */
  attribute: string;
  value: string;
  /** Exactly one entry: `{ [target.fieldKey]: value }`. */
  fields: Record<string, string>;
  /** One line for the toast / log. */
  summary: string;
}

/**
 * Refusal codes, taken verbatim from spec §27.
 *
 * They are the spec's strings rather than internal names so a message table and
 * an extension `switch` can key off the same value with no translation layer to
 * drift. `AUTHORIZATION_EXPIRED` / `INVALID_AUTHORIZATION_CODE` belong to the
 * pairing step and are produced by InspectorAuthorization, not here.
 */
export type InspectorRefusal =
  | 'TARGET_FIELD_NOT_FOUND'
  | 'TARGET_NOT_AUTHORIZED'
  | 'ELEMENT_INSPECTION_FAILED'
  | 'ATTRIBUTE_SEND_FAILED';

export interface InspectorResult {
  ok: boolean;
  reason?: InspectorRefusal;
  delivery?: InspectorDelivery;
}

/**
 * How many deliveries wait for a UI that is not listening. Small on purpose:
 * this is a hand-off buffer for a page that is reloading, not a history. An
 * unbounded inbox would grow forever for a user who closed the tab.
 */
export const INBOX_MAX = 20;

/**
 * Per-value cap. An `<img src="data:...">` or a minified inline `style` can be
 * megabytes; a node field cannot use that, and pushing it through a WebSocket
 * to every listener would be the expensive way to achieve nothing.
 */
export const VALUE_CAP = 2048;

/** Trim, cap, and force to a string. Never throws on odd input. */
function clean(value: unknown, cap = VALUE_CAP): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

/** Is there enough here to be an element at all? */
function isUsableElement(el: unknown): el is InspectorElement {
  if (!el || typeof el !== 'object') return false;
  const tag = (el as InspectorElement).tag;
  return typeof tag === 'string' && tag.trim().length > 0;
}

/**
 * Normalise whatever the extension sent into a trustworthy shape.
 *
 * Attribute names are lower-cased and de-duplicated because HTML attribute
 * names are case-insensitive: `DATA-ID` and `data-id` are one attribute, and
 * showing the user two checkboxes for it would let them tick contradictory
 * things. The 80-attribute cap stops a pathological element (or a hostile page)
 * from turning one pick into an unbounded payload.
 */
export function normalizeElement(raw: unknown): InspectorElement | null {
  if (!isUsableElement(raw)) return null;
  const src = raw as InspectorElement;

  const attrs: InspectorAttr[] = [];
  const seen = new Set<string>();
  if (Array.isArray(src.attrs)) {
    for (const a of src.attrs) {
      if (!a || typeof a !== 'object') continue;
      const name = clean((a as InspectorAttr).name, 120).toLowerCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      attrs.push({ name, value: clean((a as InspectorAttr).value) });
      if (attrs.length >= 80) break;
    }
  }

  const classes = Array.isArray(src.classes)
    ? src.classes.map((c) => clean(c, 120)).filter(Boolean).slice(0, 40)
    : [];

  return {
    tag: clean(src.tag, 40).toLowerCase(),
    id: clean(src.id, 200),
    classes,
    css: clean(src.css),
    xpath: clean(src.xpath),
    text: clean(src.text),
    value: clean(src.value),
    name: clean(src.name, 200),
    role: clean(src.role, 80),
    type: clean(src.type, 80),
    attrs,
    url: clean(src.url),
    title: clean(src.title),
  };
}

/**
 * The value for one property name.
 *
 * The switch covers the COMPUTED keys — things that are not attributes at all
 * (a CSS path, an XPath, innerText) or that need a canonical form. Everything
 * else falls to the default, which looks the name up in the element's own
 * attribute list.
 *
 * That default is the whole generic-attribute requirement in three lines:
 * `data-product`, `href`, `colspan`, `placeholder`, `autoplay`, `aria-label`
 * and anything a site invents next year all resolve without a list to maintain.
 *
 * Both the extension's key names and the spec §23 names are accepted (`tag` and
 * `tagName`, `css` and `cssSelector`) because the payload example in the spec and
 * the rows the extension builds use different spellings for the same thing, and
 * a client should not have to know which one this server happens to prefer.
 */
export function valueForKey(el: InspectorElement, key: string): string {
  const k = String(key || '').trim().toLowerCase();
  switch (k) {
    case 'tag':
    case 'tagname':
      return el.tag || '';
    case 'id':
      return el.id || '';
    case 'class':
    case 'classname':
    case 'classes':
      return (el.classes || []).join(' ');
    case 'css':
    case 'selector':
    case 'cssselector':
      return el.css || '';
    case 'xpath':
      return el.xpath || '';
    case 'text':
    case 'innertext':
    case 'textcontent':
      return el.text || '';
    case 'value':
      return el.value || '';
    case 'name':
      return el.name || '';
    case 'role':
      return el.role || '';
    case 'type':
      return el.type || '';
    default: {
      // ── The generic path ────────────────────────────────────────────────
      const hit = (el.attrs || []).find((a) => a.name === k);
      return hit ? hit.value : '';
    }
  }
}

/** A short human line: "a#buy → Selector = a#buy". */
export function summarizeSelection(
  el: InspectorElement,
  target: TargetField,
  attribute: string,
): string {
  let what = el.tag || 'element';
  if (el.id) what += `#${el.id}`;
  else if (el.classes && el.classes.length) what += `.${el.classes[0]}`;
  const where = target.label || `${target.action} → ${target.fieldKey}`;
  return `${what} — ${attribute} → ${where}`;
}

type InboxListener = (userId: string, delivery: InspectorDelivery) => void;

/**
 * The hub: what has been picked, and for which field.
 *
 * In memory for the same reason as BrowserMode: a delivery is meant for a node
 * open in a browser tab talking to THIS process. Persisting it would outlive the
 * tab and let a value land in a field nobody is looking at.
 *
 * The two registries are constructor-injected so a test can drive one hub with
 * its own isolated state instead of reaching for process-wide singletons — which
 * is what let the cross-user cases be written honestly, given that
 * `resolveUserId()` returns a fixed `'local'` in single-user mode.
 */
export class InspectorHub {
  private inbox = new Map<string, InspectorDelivery[]>();
  private listeners = new Set<InboxListener>();
  private seq = 0;

  constructor(
    private readonly registry: TargetFieldRegistry = targetFields,
    private readonly auth: InspectorAuthorizationRegistry = inspectorAuth,
  ) {}

  /**
   * The extension's submission.
   *
   * Every failure path REFUSES with a §27 code instead of guessing a
   * destination. «Never silently redirect the data to another Node Field» is the
   * spec's wording; a refusal the user can see and retry is strictly better than
   * a mis-delivery they cannot.
   *
   * ORDER MATTERS. Existence is checked before authorization so a target that has
   * expired reads as NOT_FOUND rather than NOT_AUTHORIZED — one tells the user to
   * reopen the field, the other to pair again, and they are not
   * interchangeable advice.
   */
  submit(userId: string, submission: InspectorSubmission): InspectorResult {
    const owner = clean(userId, 200);
    const targetFieldId = clean(submission?.targetFieldId, 400);

    // Resolved from the registry — never parsed out of the id. A forged
    // `node_<victim>__password__<suffix>` has nowhere to land.
    const target = this.registry.resolve(owner, targetFieldId);
    if (!target) return { ok: false, reason: 'TARGET_FIELD_NOT_FOUND' };

    if (!this.auth.isAuthorized(clean(submission?.apiKey, 400), owner, target.targetFieldId)) {
      return { ok: false, reason: 'TARGET_NOT_AUTHORIZED' };
    }

    const element = normalizeElement(submission?.element);
    if (!element) return { ok: false, reason: 'ELEMENT_INSPECTION_FAILED' };

    // §22.5 — "A Radio option is selected". No radio, nothing to send.
    const attribute = clean(submission?.sendAttribute?.name, 120);
    if (!attribute) return { ok: false, reason: 'ATTRIBUTE_SEND_FAILED' };

    // §22.6 — "The Radio-selected property has a valid value". Derived from the
    // element, so a client cannot name one property and supply another's value.
    const value = clean(valueForKey(element, attribute));
    if (!value) return { ok: false, reason: 'ATTRIBUTE_SEND_FAILED' };

    // Checkbox state. Kept for the UI panel and pointedly NOT consulted below:
    // display and send are independent, so a value can be sent without being
    // ticked for display and vice versa.
    const displayAttributes = Array.isArray(submission?.displayAttributes)
      ? submission.displayAttributes.map((s) => clean(s, 120)).filter(Boolean).slice(0, 60)
      : [];

    const delivery: InspectorDelivery = {
      id: `insp_${Date.now().toString(36)}_${(++this.seq).toString(36)}`,
      ts: Date.now(),
      mode: clean(submission.mode, 20) || 'remote',
      target,
      element,
      displayAttributes,
      attribute,
      value,
      // Exactly one field, and it is the one the registry named.
      fields: { [target.fieldKey]: value },
      summary: summarizeSelection(element, target, attribute),
    };

    this.push(owner, delivery);
    return { ok: true, delivery };
  }

  /** Queue a delivery and tell every listener. */
  push(userId: string, delivery: InspectorDelivery): void {
    const list = this.inbox.get(userId) || [];
    list.push(delivery);
    // Oldest first out: if the buffer overflows, the pick the user just made is
    // the one they are waiting for.
    while (list.length > INBOX_MAX) list.shift();
    this.inbox.set(userId, list);

    for (const fn of this.listeners) {
      try { fn(userId, delivery); } catch { /* one bad listener is not fatal */ }
    }
  }

  /** Look without consuming (a page load that may not have applied them yet). */
  peek(userId: string): InspectorDelivery[] {
    return [...(this.inbox.get(userId) || [])];
  }

  /** Take and clear — for a client that will definitely apply them. */
  drain(userId: string): InspectorDelivery[] {
    const list = this.inbox.get(userId) || [];
    this.inbox.delete(userId);
    return list;
  }

  /** Acknowledge one delivery by id. Returns true if it was still queued. */
  ack(userId: string, deliveryId: string): boolean {
    const list = this.inbox.get(userId);
    if (!list) return false;
    const id = clean(deliveryId, 120);
    const idx = list.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length) this.inbox.set(userId, list);
    else this.inbox.delete(userId);
    return true;
  }

  subscribe(fn: InboxListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Clear only THIS hub's queues.
   *
   * Deliberately does not touch the target or authorization registries: a test
   * (and a support script) must be able to empty the inbox without silently
   * revoking every pairing, and Handoff must keep working regardless.
   */
  clear(): void {
    this.inbox.clear();
    this.listeners.clear();
  }
}

export const inspectorHub = new InspectorHub();
