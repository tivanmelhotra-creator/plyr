'use strict';

/**
 * InspectorHub — where a picked element becomes a filled-in node.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The Element Inspector is a Chrome extension. It runs in the user's browser,
 * in a page this server does not control, and it has no idea which node the
 * user was editing when they hit Ctrl+Shift+C. Something has to answer: "this
 * element data just arrived — WHERE does it go?"
 *
 * The wrong answer is "the most recently opened node" or "whatever the client
 * says". Both put a selector into the wrong step of someone's workflow, and a
 * workflow that silently clicks the wrong element is worse than one that
 * plainly failed. Debugging it means re-reading every node.
 *
 * So delivery is a two-step handshake around an explicit SESSION:
 *
 *   1. CLAIM  — the UI, when it opens a node, says "session S is editing node N".
 *   2. SUBMIT — the extension sends the element together with session S.
 *
 * If S is not the current session, the submission is REFUSED (`stale_session`)
 * rather than delivered somewhere plausible. A refusal the user can see and
 * retry is strictly better than a silent mis-delivery they cannot.
 *
 * GENERIC ATTRIBUTES, NOT A HARDCODED LIST
 * ----------------------------------------
 * The requirement is explicit that `data-*` must work in full generality —
 * `data-id`, `data-product`, `data-category` and anything else a site invented
 * this morning. So `valueForKey` handles the computed keys (css, xpath, text …)
 * by name and then falls through to a LOOKUP in the element's own attribute
 * list. That one default branch is what makes href, src, colspan, placeholder,
 * aria-*, data-* and every future attribute work without this file ever being
 * edited again. A hardcoded enum would need a release per attribute.
 */

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

/** The attribute keys the user ticked, in the order they ticked them. */
export type InspectorPick = string[];

export interface InspectorSubmission {
  sessionId: string;
  element: InspectorElement;
  selected: InspectorPick;
  mode?: string;
}

/** "Session S is editing node N." */
export interface ActiveNodeClaim {
  sessionId: string;
  nodeId: string;
  action?: string;
  workflowId?: string;
  /** A specific field, when the user pressed the picker next to one. */
  field?: string;
  label?: string;
}

export interface ActiveNodeSession extends ActiveNodeClaim {
  claimedAt: number;
}

/** What the UI receives and applies to the node. */
export interface InspectorDelivery {
  id: string;
  ts: number;
  mode: string;
  session: ActiveNodeSession;
  element: InspectorElement;
  selected: InspectorPick;
  /** Ready-to-apply node field values (keys match public/js/actions.js). */
  fields: Record<string, string>;
  /** One line for the toast / log. */
  summary: string;
}

export type InspectorRefusal =
  | 'no_active_node'
  | 'stale_session'
  | 'empty_selection'
  | 'invalid_element';

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
 * How long a claim stays valid. Long enough for a real session of hunting for
 * an element on a slow page; short enough that a node abandoned yesterday
 * cannot receive today's pick.
 */
export const CLAIM_TTL_MS = 30 * 60 * 1000;

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
 * The value for one ticked key.
 *
 * The switch covers the COMPUTED keys — things that are not attributes at all
 * (a CSS path, an XPath, innerText) or that need a canonical form. Everything
 * else falls to the default, which looks the key up in the element's own
 * attribute list.
 *
 * That default is the whole generic-attribute requirement in three lines:
 * `data-product`, `href`, `colspan`, `placeholder`, `autoplay`, `aria-label`
 * and anything a site invents next year all resolve without a list to maintain.
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

/**
 * Keys that describe the element's IDENTITY rather than a piece of data on it.
 * Ticking `css` means "use this to find the element"; ticking `data-sku` means
 * "read this off the element". They must not be confused, or a pick of `href`
 * would end up as the selector.
 */
const RESERVED_KEYS = new Set([
  'tag', 'tagname', 'id', 'class', 'classname', 'classes',
  'css', 'selector', 'cssselector', 'xpath', 'text', 'innertext', 'textcontent',
]);

/**
 * Turn the ticked keys into node field values.
 *
 * SELECTOR PRECEDENCE: css → xpath → #id → .firstClass. CSS first because it is
 * what every node's `selector` field expects and what the existing picker
 * produces; XPath next because it is the only thing that can address some
 * elements; the id/class fallbacks exist so a pick that ticked ONLY `id` still
 * produces a usable selector instead of an empty field the user must fix by hand.
 */
export function mapSelectionToFields(
  el: InspectorElement,
  selected: InspectorPick,
  action?: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const ticked = new Set(selected.map((s) => String(s || '').trim().toLowerCase()));

  // ── selector + selectorType ─────────────────────────────────────────────
  if (ticked.has('css') || ticked.has('selector') || ticked.has('cssselector')) {
    if (el.css) { fields.selector = el.css; fields.selectorType = 'css'; }
  }
  if (!fields.selector && ticked.has('xpath') && el.xpath) {
    fields.selector = el.xpath;
    fields.selectorType = 'xpath';
  }
  if (!fields.selector && ticked.has('id') && el.id) {
    fields.selector = `#${el.id}`;
    fields.selectorType = 'css';
  }
  if (!fields.selector
      && (ticked.has('class') || ticked.has('classes') || ticked.has('classname'))
      && el.classes && el.classes.length) {
    fields.selector = `.${el.classes[0]}`;
    fields.selectorType = 'css';
  }
  // A pick with no identity key at all still needs to be actionable: fall back
  // to the CSS path the extension computed, which is always present.
  if (!fields.selector && el.css) {
    fields.selector = el.css;
    fields.selectorType = 'css';
  }

  // XPath stays available separately even when CSS won the selector slot — some
  // nodes offer both, and discarding it would lose information the user ticked.
  if (ticked.has('xpath') && el.xpath) fields.xpath = el.xpath;

  // ── text ────────────────────────────────────────────────────────────────
  if ((ticked.has('text') || ticked.has('innertext') || ticked.has('textcontent')) && el.text) {
    fields.text = el.text;
  }

  // ── attribute + value ───────────────────────────────────────────────────
  // The first non-identity key ticked becomes the attribute to read. This is
  // what makes `data-*` land in a node: the NAME goes in `attribute` (so the
  // node reads it live at run time) and the value the user saw goes in `value`
  // (so they can see they picked the right thing).
  for (const key of selected) {
    const k = String(key || '').trim().toLowerCase();
    if (!k || RESERVED_KEYS.has(k)) continue;
    const v = valueForKey(el, k);
    if (k === 'value') { fields.value = v; continue; }
    if (k === 'name' && !fields.name) { fields.name = v; continue; }
    if (!fields.attribute) {
      fields.attribute = k;
      if (v && !fields.value) fields.value = v;
    }
    break;
  }

  // Extract nodes save into a variable, and an empty name means the run has
  // nowhere to put the result. Derive a safe identifier so the node is usable
  // the moment it is filled.
  const act = String(action || '').toLowerCase();
  if ((act === 'extract' || act === 'extract-data') && !fields.name) {
    const base = fields.attribute || el.id || el.name || el.tag || 'value';
    const safe = base.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    fields.name = safe || 'value';
  }

  return fields;
}

/** A short human line: "a#buy — href, data-sku". */
export function summarizeSelection(el: InspectorElement, selected: InspectorPick): string {
  let what = el.tag || 'element';
  if (el.id) what += `#${el.id}`;
  else if (el.classes && el.classes.length) what += `.${el.classes[0]}`;
  const keys = selected.map((s) => String(s || '').trim()).filter(Boolean);
  return keys.length ? `${what} — ${keys.join(', ')}` : what;
}

type InboxListener = (userId: string, delivery: InspectorDelivery) => void;

/**
 * The hub: who is editing what, and what has been picked for them.
 *
 * In memory for the same reason as BrowserMode: a claim describes a node open in
 * a browser tab talking to THIS process. Persisting it would outlive the tab and
 * let a pick land in a node nobody is looking at.
 */
export class InspectorHub {
  private active = new Map<string, ActiveNodeSession>();
  private inbox = new Map<string, InspectorDelivery[]>();
  private listeners = new Set<InboxListener>();
  private seq = 0;

  /** "Session S is now editing node N." Replaces any previous claim. */
  claim(userId: string, claim: ActiveNodeClaim): ActiveNodeSession | null {
    const sessionId = clean(claim?.sessionId, 200);
    const nodeId = clean(claim?.nodeId, 200);
    if (!sessionId || !nodeId) return null;

    const session: ActiveNodeSession = {
      sessionId,
      nodeId,
      action: clean(claim.action, 80),
      workflowId: clean(claim.workflowId, 200),
      field: clean(claim.field, 80),
      label: clean(claim.label, 200),
      claimedAt: Date.now(),
    };
    this.active.set(userId, session);
    return session;
  }

  /** The current claim, or null when there is none or it has expired. */
  activeNode(userId: string): ActiveNodeSession | null {
    const s = this.active.get(userId);
    if (!s) return null;
    if (Date.now() - s.claimedAt > CLAIM_TTL_MS) {
      this.active.delete(userId);
      return null;
    }
    return { ...s };
  }

  /**
   * Give up the claim. `sessionId` is checked so a stale tab closing cannot
   * release the claim a newer tab has since made.
   */
  release(userId: string, sessionId?: string): boolean {
    const s = this.active.get(userId);
    if (!s) return false;
    if (sessionId && clean(sessionId, 200) !== s.sessionId) return false;
    this.active.delete(userId);
    return true;
  }

  /**
   * The extension's submission.
   *
   * Every failure path REFUSES with a reason instead of guessing a destination.
   * That is the entire point of the session: a pick that cannot be placed
   * correctly must not be placed at all.
   */
  submit(userId: string, submission: InspectorSubmission): InspectorResult {
    const session = this.activeNode(userId);
    if (!session) return { ok: false, reason: 'no_active_node' };

    const sessionId = clean(submission?.sessionId, 200);
    if (!sessionId || sessionId !== session.sessionId) {
      return { ok: false, reason: 'stale_session' };
    }

    const element = normalizeElement(submission?.element);
    if (!element) return { ok: false, reason: 'invalid_element' };

    const selected = Array.isArray(submission?.selected)
      ? submission.selected.map((s) => clean(s, 120)).filter(Boolean).slice(0, 60)
      : [];
    if (!selected.length) return { ok: false, reason: 'empty_selection' };

    const delivery: InspectorDelivery = {
      id: `insp_${Date.now().toString(36)}_${(++this.seq).toString(36)}`,
      ts: Date.now(),
      mode: clean(submission.mode, 20) || 'remote',
      session,
      element,
      selected,
      fields: mapSelectionToFields(element, selected, session.action),
      summary: summarizeSelection(element, selected),
    };

    this.push(userId, delivery);
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

  clear(): void {
    this.active.clear();
    this.inbox.clear();
    this.listeners.clear();
  }
}

export const inspectorHub = new InspectorHub();
