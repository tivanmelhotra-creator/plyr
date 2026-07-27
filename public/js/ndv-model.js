/*
 * ndv-model.js — PURE (DOM-free) model layer for the Aria NDV node designs.
 *
 * Why a separate file?
 *   The locked designs in `docs/uiux/` (ndv-click-element-final.md /
 *   ndv-condition-final.md) are dense. Rather than growing flow-editor.js with
 *   more DOM code, the *logic* of each designed node — its parameter contract,
 *   defaults, normalisation and the human-readable summaries shown on collapsed
 *   rows — lives here as plain data + pure functions. That makes it:
 *     - unit-testable under node:vm with only a `window` shim (no jsdom),
 *     - reusable by the NDV renderer (ndv-nodes.js) AND by the node-card
 *       summary on the canvas,
 *     - the single place to extend when the next node gets designed.
 *
 * Layering (design base → per-node design):
 *   ndv-model.js  (this file) pure contracts + normalisation
 *   ndv-ui.js     reusable Aria chrome primitives (DOM)
 *   ndv-nodes.js  per-node centre-column designs (click, condition, …)
 *   flow-editor.js  shell/canvas + generic fallback for undesigned nodes
 *
 * Loaded BEFORE flow-editor.js in index.html. LF line endings.
 */
(function () {
  'use strict';

  // =========================================================================
  // 1. Condition model (ndv-condition-final.md § 5)
  // =========================================================================
  // Storage contract (backwards compatible with Step-32 `params.groups`):
  //   params.groups = JSON string of [[row, …], [row, …]]
  //     - rows inside one array are ANDed   -> ConditionEngine { all: [...] }
  //     - the arrays themselves are ORed    -> ConditionEngine { any: [...] }
  //   row = { source?, attribute?, selector?, operator, value?, expected?,
  //           collapsed? }
  // `source`/`attribute` are the design's "Left source" + "Attribute name"
  // controls; they are serialised to the backend SimpleCondition as
  // { source, attribute } (see graph-serialize.js + ConditionEngine).

  // Left-source options. `text` is the v1 default (backend reads innerText).
  var CONDITION_SOURCES = [
    { id: 'text', label: 'cbs.text', needsAttribute: false },
    { id: 'attribute', label: 'cbs.attribute', needsAttribute: true },
    { id: 'value', label: 'cbs.value', needsAttribute: false },
    { id: 'html', label: 'cbs.html', needsAttribute: false },
    { id: 'variable', label: 'cbs.variable', needsAttribute: false },
  ];

  // Operator registry. `dom` = evaluated purely against selector presence /
  // visibility (no expected value); `needsExpected` drives whether the design
  // shows the "Right value" field.
  var CONDITION_OPERATORS = [
    { id: 'exists', label: 'op.exists', dom: true, needsExpected: false },
    { id: 'not_exists', label: 'op.not_exists', dom: true, needsExpected: false },
    { id: 'visible', label: 'op.visible', dom: true, needsExpected: false },
    { id: 'hidden', label: 'op.hidden', dom: true, needsExpected: false },
    { id: 'equals', label: 'op.equals', dom: false, needsExpected: true },
    { id: 'not_equals', label: 'op.not_equals', dom: false, needsExpected: true },
    { id: 'contains', label: 'op.contains', dom: false, needsExpected: true },
    { id: 'not_contains', label: 'op.not_contains', dom: false, needsExpected: true },
    { id: 'starts_with', label: 'op.starts_with', dom: false, needsExpected: true },
    { id: 'ends_with', label: 'op.ends_with', dom: false, needsExpected: true },
    { id: 'matches_regex', label: 'op.matches_regex', dom: false, needsExpected: true },
    { id: 'greater_than', label: 'op.greater_than', dom: false, needsExpected: true },
    { id: 'less_than', label: 'op.less_than', dom: false, needsExpected: true },
    { id: 'greater_equal', label: 'op.greater_equal', dom: false, needsExpected: true },
    { id: 'less_equal', label: 'op.less_equal', dom: false, needsExpected: true },
    { id: 'is_empty', label: 'op.is_empty', dom: false, needsExpected: false },
    { id: 'not_empty', label: 'op.not_empty', dom: false, needsExpected: false },
    { id: 'is_true', label: 'op.is_true', dom: false, needsExpected: false },
    { id: 'is_false', label: 'op.is_false', dom: false, needsExpected: false },
  ];

  function operatorMeta(id) {
    for (var i = 0; i < CONDITION_OPERATORS.length; i++) {
      if (CONDITION_OPERATORS[i].id === id) return CONDITION_OPERATORS[i];
    }
    return CONDITION_OPERATORS[0];
  }
  function sourceMeta(id) {
    for (var i = 0; i < CONDITION_SOURCES.length; i++) {
      if (CONDITION_SOURCES[i].id === id) return CONDITION_SOURCES[i];
    }
    return CONDITION_SOURCES[0];
  }

  function blankRow() {
    return { source: 'text', attribute: '', selector: '', operator: 'exists',
      value: '', expected: '', collapsed: false };
  }

  function normalizeRow(raw) {
    var row = blankRow();
    if (!raw || typeof raw !== 'object') return row;
    var op = operatorMeta(raw.operator).id;
    row.operator = raw.operator && op === raw.operator ? raw.operator : op;
    row.source = sourceMeta(raw.source).id;
    row.attribute = raw.attribute != null ? String(raw.attribute) : '';
    row.selector = raw.selector != null ? String(raw.selector) : '';
    row.value = raw.value != null ? String(raw.value) : '';
    row.expected = raw.expected != null ? String(raw.expected) : '';
    row.collapsed = raw.collapsed === true;
    return row;
  }

  // Parse whatever is stored on the node into a clean [[row,…],…] structure.
  // Falls back to the legacy flat params (selector/operator/value/expected).
  function readGroups(params) {
    params = params || {};
    var raw = params.groups;
    var parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    var groups = [];
    if (Array.isArray(parsed)) {
      parsed.forEach(function (rows) {
        if (!Array.isArray(rows)) return;
        var clean = rows.map(normalizeRow);
        if (clean.length) groups.push(clean);
      });
    }
    if (!groups.length) {
      groups = [[normalizeRow({
        selector: params.selector,
        operator: params.operator || 'exists',
        value: params.value,
        expected: params.expected,
        source: params.source,
        attribute: params.attribute,
      })]];
    }
    return groups;
  }

  // Write groups back onto a node's params, mirroring row 1 into the legacy
  // flat fields so the canvas card summary and single-condition fallback keep
  // working with older saved workflows.
  function writeGroups(params, groups) {
    params = params || {};
    var clean = (groups || []).map(function (rows) { return (rows || []).map(normalizeRow); })
      .filter(function (rows) { return rows.length; });
    if (!clean.length) clean = [[blankRow()]];
    params.groups = JSON.stringify(clean);
    var r0 = clean[0][0];
    params.selector = r0.selector || '';
    params.operator = r0.operator || 'exists';
    params.value = r0.value || '';
    params.expected = r0.expected || '';
    params.source = r0.source || 'text';
    params.attribute = r0.attribute || '';
    return params;
  }

  // Chip pieces for a COLLAPSED row (design: `exists · .user-name`, and
  // `error-message | textContent | Contains | "Error"`). Returns tokens so the
  // renderer can style each piece; `text` values are already display-ready
  // except operator/source which are i18n keys the caller translates.
  function rowChips(row) {
    row = normalizeRow(row);
    var op = operatorMeta(row.operator);
    var chips = [];
    if (row.selector) chips.push({ kind: 'selector', text: row.selector });
    else if (row.value) chips.push({ kind: 'value', text: row.value });
    if (row.source === 'attribute' && row.attribute) {
      chips.push({ kind: 'attribute', text: row.attribute });
    } else if (row.source !== 'text') {
      chips.push({ kind: 'source', i18n: sourceMeta(row.source).label });
    }
    chips.push({ kind: 'operator', i18n: op.label });
    if (op.needsExpected) chips.push({ kind: 'expected', text: '"' + (row.expected || '') + '"' });
    return chips;
  }

  // A row is only *configured* once it names something to test. Every operator
  // needs a left-hand target, so a row with neither a selector nor a value is
  // still blank — readGroups() seeds exactly such a row so the builder always
  // renders one, and that placeholder must never leak into a summary.
  function rowIsBlank(row) {
    row = normalizeRow(row);
    return !row.selector && !row.value;
  }

  // A one-line, human readable summary (used on the canvas node card).
  // Returns '' when nothing is configured yet, so the card can fall back to its
  // "no parameters" hint instead of claiming a meaningless `Exists` condition.
  function conditionSummary(params, translate) {
    var tr = typeof translate === 'function' ? translate : function (k) { return k; };
    var parts = readGroups(params).map(function (rows) {
      return rows.filter(function (row) { return !rowIsBlank(row); }).map(function (row) {
        return rowChips(row).map(function (c) {
          return c.i18n ? tr(c.i18n) : c.text;
        }).join(' ');
      }).join(' AND ');
    }).filter(function (s) { return s !== ''; });
    return parts.join(' OR ');
  }

  // v1 runtime executes a single path (shell-editor-condition-ndv.md §2:
  // "multi-path UI is v2; v1 runtime = true/false only"). Kept as a constant so
  // the UI can label the disabled `+ Add path` control honestly.
  var CONDITION_MAX_PATHS_V1 = 1;

  var EVALUATE_MODES = [
    { id: 'first', label: 'cb.evalFirst' },
    { id: 'all', label: 'cb.evalAll' },
  ];

  // =========================================================================
  // 2. Click Element model (ndv-click-element-final.md § 5)
  // =========================================================================
  // The design exposes far more than the legacy { selector } form. Backend keys
  // stay FLAT (params.x) so src/pipeline.ts + coerceParams keep working; the
  // design's nested `modifiers` / `behavior` objects are flattened to
  // modAlt / modCtrl / modShift / human / force.
  var CLICK_DEFAULTS = {
    selectorType: 'css',
    selector: '',
    clickType: 'single',
    button: 'left',
    clickCount: 1,
    delayBeforeMs: 0,
    waitForSelector: true,
    timeout: 10000,
    scrollIntoView: true,
    multipleMatches: false,
    highlightElement: false,
    visibleOnly: true,
    stableForMs: 300,
    offsetX: 0,
    offsetY: 0,
    modAlt: false,
    modCtrl: false,
    modShift: false,
    human: true,
    force: false,
  };

  var CLICK_SELECTOR_TYPES = ['css', 'xpath', 'text'];
  var CLICK_TYPES = ['single', 'double', 'triple'];
  var CLICK_BUTTONS = ['left', 'middle', 'right'];

  function toBool(v, dflt) {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return dflt === true;
  }
  function toNum(v, dflt, min, max) {
    var n = typeof v === 'number' ? v : parseFloat(String(v));
    if (!isFinite(n)) n = dflt;
    if (typeof min === 'number' && n < min) n = min;
    if (typeof max === 'number' && n > max) n = max;
    return n;
  }
  function oneOf(v, list, dflt) {
    return list.indexOf(String(v)) !== -1 ? String(v) : dflt;
  }

  // Normalise a click node's params to the full, valid design contract. Used by
  // the NDV renderer (so toggles reflect real defaults instead of "unset") and
  // exercised by unit tests as the click parameter contract.
  function normalizeClickParams(raw) {
    raw = raw || {};
    var d = CLICK_DEFAULTS;
    var out = {
      selectorType: oneOf(raw.selectorType, CLICK_SELECTOR_TYPES, d.selectorType),
      selector: raw.selector != null ? String(raw.selector) : d.selector,
      clickType: oneOf(raw.clickType, CLICK_TYPES, d.clickType),
      button: oneOf(raw.button, CLICK_BUTTONS, d.button),
      clickCount: Math.round(toNum(raw.clickCount, d.clickCount, 1, 10)),
      delayBeforeMs: Math.round(toNum(raw.delayBeforeMs, d.delayBeforeMs, 0, 600000)),
      waitForSelector: toBool(raw.waitForSelector, d.waitForSelector),
      timeout: Math.round(toNum(raw.timeout, d.timeout, 0, 600000)),
      scrollIntoView: toBool(raw.scrollIntoView, d.scrollIntoView),
      multipleMatches: toBool(raw.multipleMatches, d.multipleMatches),
      highlightElement: toBool(raw.highlightElement, d.highlightElement),
      visibleOnly: toBool(raw.visibleOnly, d.visibleOnly),
      stableForMs: Math.round(toNum(raw.stableForMs, d.stableForMs, 0, 60000)),
      offsetX: Math.round(toNum(raw.offsetX, d.offsetX, -10000, 10000)),
      offsetY: Math.round(toNum(raw.offsetY, d.offsetY, -10000, 10000)),
      modAlt: toBool(raw.modAlt, d.modAlt),
      modCtrl: toBool(raw.modCtrl, d.modCtrl),
      modShift: toBool(raw.modShift, d.modShift),
      human: toBool(raw.human, d.human),
      force: toBool(raw.force, d.force),
    };
    // clickType is the friendly control; clickCount is the raw count. Keep them
    // consistent so the runtime never sees "double click, count 1".
    var typed = out.clickType === 'double' ? 2 : out.clickType === 'triple' ? 3 : 1;
    if (out.clickType !== 'single') out.clickCount = Math.max(out.clickCount, typed);
    else if (out.clickCount > 1) out.clickType = out.clickCount >= 3 ? 'triple' : 'double';
    return out;
  }

  // The canonical execution payload from the spec (§5). Used by tests + the
  // OUTPUT column's representative result shape.
  function clickPayloadPreview(params) {
    var p = normalizeClickParams(params);
    return {
      clicked: true,
      selector: p.selector || '#next-button',
      button: p.button,
      clickCount: p.clickCount,
    };
  }

  // =========================================================================
  // 3. Which nodes have a LOCKED design?
  // =========================================================================
  // Only nodes whose preview image exists under docs/uiux/ get a bespoke NDV;
  // everything else uses the generic parameter list. This list is the explicit
  // gate so undesigned nodes are never "half designed".
  var DESIGNED_NODES = {
    click: 'ndv-click-element-final',
    if: 'ndv-condition-final',
    while: 'ndv-condition-final',
  };
  function isDesigned(actionId) {
    return Object.prototype.hasOwnProperty.call(DESIGNED_NODES, actionId);
  }

  window.NdvModel = {
    // condition
    CONDITION_SOURCES: CONDITION_SOURCES,
    CONDITION_OPERATORS: CONDITION_OPERATORS,
    CONDITION_MAX_PATHS_V1: CONDITION_MAX_PATHS_V1,
    EVALUATE_MODES: EVALUATE_MODES,
    operatorMeta: operatorMeta,
    sourceMeta: sourceMeta,
    blankRow: blankRow,
    normalizeRow: normalizeRow,
    readGroups: readGroups,
    writeGroups: writeGroups,
    rowChips: rowChips,
    conditionSummary: conditionSummary,
    rowIsBlank: rowIsBlank,
    // click
    CLICK_DEFAULTS: CLICK_DEFAULTS,
    CLICK_SELECTOR_TYPES: CLICK_SELECTOR_TYPES,
    CLICK_TYPES: CLICK_TYPES,
    CLICK_BUTTONS: CLICK_BUTTONS,
    normalizeClickParams: normalizeClickParams,
    clickPayloadPreview: clickPayloadPreview,
    // registry
    DESIGNED_NODES: DESIGNED_NODES,
    isDesigned: isDesigned,
  };
})();
