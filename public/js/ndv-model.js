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

  // ---- CHECK KIND: the one question a condition row really asks -------------
  //
  // AUDIT (src/core/ConditionEngine.ts evaluateSimple) — the runtime has exactly
  // THREE evaluation paths, and each one ignores different fields:
  //
  //   1. DOM path      (operator ∈ exists|not_exists|visible|hidden, L111)
  //      reads ONLY `selector`. `source` and `attribute` are never touched.
  //   2. variable path (source === 'variable', L140)
  //      reads the run variable NAMED BY `value`. `selector` is never touched.
  //   3. content path  (readFromElement, L211)
  //      reads `selector` through `source` (+ `attribute` when source is
  //      'attribute').
  //
  // The old NDV showed all five controls (Left source · Attribute name · CSS
  // Selector · Operator · Right value) for every row, which meant that in path
  // 1 the user configured a "Left source" the engine throws away, and in path 2
  // a "CSS Selector" the engine throws away. That is not just clutter, it is a
  // UI that LIES about what the run will do.
  //
  // `kind` fixes it and costs nothing: it is DERIVED from the row that is
  // already stored (never persisted, never serialised), so the params.groups
  // contract and every saved workflow stay byte-identical.
  var CONDITION_KINDS = [
    { id: 'element', label: 'cbk.element', hint: 'cbk.elementHint', group: 'element' },
    { id: 'content', label: 'cbk.content', hint: 'cbk.contentHint', group: 'element' },
    { id: 'variable', label: 'cbk.variable', hint: 'cbk.variableHint', group: 'value' },
    // Automa's "Code" value type. The snippet lives in `value` — the same field
    // the variable path uses — because both are "the left-hand value, not read
    // from a selector", and the engine's readFromCode() reads exactly that.
    { id: 'code', label: 'cbk.code', hint: 'cbk.codeHint', group: 'value' },
  ];

  // Automa's `conditionBuilder.valueTypes` renders its dropdown as two
  // <optgroup>s — *value* and *element* — and rule R1 makes that the reference.
  // With a fourth kind the flat list stopped being self-explanatory: `code` and
  // `variable` share "I already have the value", while `element` and `content`
  // share "go and read the page". The order IS the dropdown order, and
  // 'element' must stay first because checkKindOf() falls back to it.
  var CONDITION_KIND_GROUPS = [
    { id: 'element', label: 'cvg.element' },
    { id: 'value', label: 'cvg.value' },
  ];

  /**
   * The same kinds bucketed for an <optgroup> dropdown, in
   * CONDITION_KIND_GROUPS order with empty buckets dropped. Pure: no DOM, no
   * i18n — the caller translates `group` and each `option.label`.
   */
  function groupedCheckKinds() {
    var out = [];
    CONDITION_KIND_GROUPS.forEach(function (g) {
      var inGroup = CONDITION_KINDS.filter(function (k) {
        return (k.group || 'element') === g.id;
      });
      if (inGroup.length) out.push({ group: g.label, options: inGroup });
    });
    // Same orphan safety net as groupedOperatorsForKind: a kind added without a
    // known group must stay reachable rather than vanish from the dropdown.
    var known = {};
    out.forEach(function (b) { b.options.forEach(function (k) { known[k.id] = true; }); });
    var orphans = CONDITION_KINDS.filter(function (k) { return !known[k.id]; });
    if (orphans.length) out.push({ group: 'cvg.other', options: orphans });
    return out;
  }

  /** Which of the runtime's four paths this row will take. Pure derivation. */
  function checkKindOf(row) {
    if (!row) return 'element';
    if (operatorMeta(row.operator).dom) return 'element';
    if (row.source === 'variable') return 'variable';
    if (row.source === 'code') return 'code';
    return 'content';
  }

  // What a fresh `code` row is seeded with. This is Automa's own editor seed,
  // and it is not decoration: MEASURED (tools/probe-condition-value-types.js
  // finding 1) page.evaluate('return true;') throws "Illegal return statement",
  // so the engine wraps every snippet. Seeding the wrapped-statement form is
  // how the user learns that `return` is allowed here.
  var CONDITION_CODE_SEED = 'return true;';

  /**
   * Move a row to another kind, keeping every field that still has a meaning
   * and clearing only the ones the new path cannot use. Returns a NEW row.
   *
   * Clearing matters: leaving a stale `selector` on a variable row would show
   * the user a value that the engine ignores — the same lie in reverse.
   */
  function applyCheckKind(row, kind) {
    var next = normalizeRow(row);
    if (kind === 'element') {
      if (!operatorMeta(next.operator).dom) next.operator = 'exists';
      next.source = 'text';       // engine default; unused on this path
      next.attribute = '';
      next.expected = '';
      next.value = '';
    } else if (kind === 'variable') {
      if (operatorMeta(next.operator).dom) next.operator = 'equals';
      // Coming FROM code, `value` holds a JS snippet — a nonsense variable
      // name. Clearing it is the same honesty as clearing a stale selector.
      if (next.source === 'code') next.value = '';
      next.source = 'variable';
      next.attribute = '';
      next.selector = '';         // never read on this path
    } else if (kind === 'code') {
      if (operatorMeta(next.operator).dom) next.operator = 'is_truthy';
      // …and symmetrically: a variable NAME is not a snippet, so seed instead.
      if (next.source !== 'code') next.value = CONDITION_CODE_SEED;
      next.source = 'code';
      next.attribute = '';
      next.selector = '';         // the snippet is the left-hand value
    } else {
      if (operatorMeta(next.operator).dom) next.operator = 'equals';
      // 'text' is the engine default. Both non-DOM sources that live in `value`
      // (variable, code) must fall back to it, or a content row would keep a
      // source whose left-hand value never comes from the selector beside it.
      if (next.source === 'variable' || next.source === 'code') next.source = 'text';
      next.value = '';            // only the variable / code paths use `value`
    }
    return next;
  }

  // What to read out of the matched element — the design's "Left source", minus
  // `variable`, which is now the separate `variable` KIND rather than a value
  // hidden inside an unrelated dropdown.
  var CONDITION_SOURCES = [
    { id: 'text', label: 'cbs.text', needsAttribute: false },
    { id: 'attribute', label: 'cbs.attribute', needsAttribute: true },
    { id: 'value', label: 'cbs.value', needsAttribute: false },
    { id: 'html', label: 'cbs.html', needsAttribute: false },
    { id: 'variable', label: 'cbs.variable', needsAttribute: false },
    // Like `variable`, this is not a "part of the element" — it is its own KIND
    // (CONDITION_KINDS 'code'). It lives in this registry only so that
    // sourceMeta()/normalizeRow() recognise it instead of silently rewriting a
    // saved code row back to 'text'.
    { id: 'code', label: 'cbs.code', needsAttribute: false },
  ];

  // The sources that are really a separate KIND rather than "which part of the
  // matched element to read". Both take their left-hand value from `value` and
  // never touch the row's selector, which is exactly why they must not appear
  // in the content row's "Read" dropdown.
  var NON_ELEMENT_SOURCES = ['variable', 'code'];

  /** The sources offered for the `content` kind (i.e. everything DOM-backed). */
  function contentSources() {
    return CONDITION_SOURCES.filter(function (s) {
      return NON_ELEMENT_SOURCES.indexOf(s.id) < 0;
    });
  }

  // Suggestions for the design's `Attribute name` chevron menu. NOT a closed
  // set — the field stays free text because the runtime reads any attribute
  // (`getAttribute(name)`), so a <select> here would remove a real capability.
  var CONDITION_ATTRIBUTES = [
    'textContent', 'innerText', 'value', 'href', 'src', 'alt', 'title',
    'id', 'class', 'name', 'type', 'placeholder', 'checked', 'disabled',
    'aria-label', 'aria-expanded', 'aria-checked', 'data-state', 'data-testid',
  ];

  // Operator groups — Automa parity (utils/shared.js -> conditionBuilder
  // .compareTypes, which renders its dropdown as <optgroup>s: basic / number /
  // text / boolean). Project rule R1 (MISSIONS.md) makes Automa the reference
  // for node logic, and a 20-entry flat list is exactly the case an <optgroup>
  // exists for. Two groups are ours rather than Automa's:
  //   dom    — our four selector-only operators (Automa expresses these as
  //            *value types* instead: "Element exists", "Element visible", …)
  //   state  — is_empty / not_empty, and list — in_list / not_in_list, both of
  //            which the runtime already implements.
  // The order of this array IS the order of the dropdown, and 'exists' must
  // stay first because operatorMeta() falls back to CONDITION_OPERATORS[0].
  var CONDITION_OPERATOR_GROUPS = [
    { id: 'dom', label: 'opg.dom' },
    { id: 'basic', label: 'opg.basic' },
    { id: 'number', label: 'opg.number' },
    { id: 'text', label: 'opg.text' },
    { id: 'state', label: 'opg.state' },
    // NB: this order IS the dropdown order, and it deliberately mirrors the
    // order of CONDITION_OPERATORS below, so the grouped and flat views of the
    // registry can never disagree about which operator comes first.
    { id: 'boolean', label: 'opg.boolean' },
    { id: 'list', label: 'opg.list' },
  ];

  // Operator registry. `dom` = evaluated purely against selector presence /
  // visibility (no expected value); `needsExpected` drives whether the design
  // shows the "Right value" field; `group` places it in the dropdown.
  var CONDITION_OPERATORS = [
    { id: 'exists', label: 'op.exists', group: 'dom', dom: true, needsExpected: false },
    { id: 'not_exists', label: 'op.not_exists', group: 'dom', dom: true, needsExpected: false },
    { id: 'visible', label: 'op.visible', group: 'dom', dom: true, needsExpected: false },
    { id: 'hidden', label: 'op.hidden', group: 'dom', dom: true, needsExpected: false },
    // Automa's "Element visible in screen" / "hidden in screen" value types.
    // NOT duplicates of visible/hidden, and that is MEASURED rather than
    // assumed (tools/probe-condition-value-types.js finding 5): an element
    // 4000px below the fold reports isVisible() === true, because Playwright's
    // "visible" means "has a box and is not visibility:hidden" and says nothing
    // about where the page is scrolled to. These two answer the different, and
    // often more useful, question "can the user see it right now?".
    { id: 'in_screen', label: 'op.in_screen', group: 'dom', dom: true, needsExpected: false },
    { id: 'not_in_screen', label: 'op.not_in_screen', group: 'dom', dom: true, needsExpected: false },
    { id: 'equals', label: 'op.equals', group: 'basic', dom: false, needsExpected: true },
    // Automa `eqi` / `cni` / `nci`: case-INSENSITIVE twins. Not cosmetic — the
    // most common real comparison is against copy a site may render as
    // "Sign out", "SIGN OUT" or "Sign Out", and without these the user had to
    // hand-write a regex (matches_regex) just to ignore case.
    { id: 'equals_i', label: 'op.equals_i', group: 'basic', dom: false, needsExpected: true },
    { id: 'not_equals', label: 'op.not_equals', group: 'basic', dom: false, needsExpected: true },
    { id: 'greater_than', label: 'op.greater_than', group: 'number', dom: false, needsExpected: true },
    { id: 'greater_equal', label: 'op.greater_equal', group: 'number', dom: false, needsExpected: true },
    { id: 'less_than', label: 'op.less_than', group: 'number', dom: false, needsExpected: true },
    { id: 'less_equal', label: 'op.less_equal', group: 'number', dom: false, needsExpected: true },
    { id: 'contains', label: 'op.contains', group: 'text', dom: false, needsExpected: true },
    { id: 'contains_i', label: 'op.contains_i', group: 'text', dom: false, needsExpected: true },
    { id: 'not_contains', label: 'op.not_contains', group: 'text', dom: false, needsExpected: true },
    { id: 'not_contains_i', label: 'op.not_contains_i', group: 'text', dom: false, needsExpected: true },
    { id: 'starts_with', label: 'op.starts_with', group: 'text', dom: false, needsExpected: true },
    { id: 'ends_with', label: 'op.ends_with', group: 'text', dom: false, needsExpected: true },
    { id: 'matches_regex', label: 'op.matches_regex', group: 'text', dom: false, needsExpected: true },
    { id: 'is_empty', label: 'op.is_empty', group: 'state', dom: false, needsExpected: false },
    { id: 'not_empty', label: 'op.not_empty', group: 'state', dom: false, needsExpected: false },
    { id: 'is_true', label: 'op.is_true', group: 'boolean', dom: false, needsExpected: false },
    { id: 'is_false', label: 'op.is_false', group: 'boolean', dom: false, needsExpected: false },
    // Automa `itr` / `ifl`: JS truthiness, which is NOT what is_true/is_false
    // test. is_true only passes for the literal boolean true or the string
    // "true"; is_truthy passes for any non-empty, non-zero value — the check
    // you actually want for "did the page give me a value at all".
    { id: 'is_truthy', label: 'op.is_truthy', group: 'boolean', dom: false, needsExpected: false },
    { id: 'is_falsy', label: 'op.is_falsy', group: 'boolean', dom: false, needsExpected: false },
    // BACKEND HAD IT, UI DID NOT (ConditionEngine 'in_list' / 'not_in_list').
    // Real, frequently-needed capability: "status is one of paid, shipped,
    // delivered" previously forced the user to build three OR groups by hand.
    // `list: true` makes the Right value a comma/newline list; graph-serialize
    // turns it into the ARRAY the engine requires (it compares with
    // Array.includes and returns false for a plain string).
    { id: 'in_list', label: 'op.in_list', group: 'list', dom: false, needsExpected: true, list: true },
    { id: 'not_in_list', label: 'op.not_in_list', group: 'list', dom: false, needsExpected: true, list: true },
    // DELIBERATELY NOT SURFACED: the engine also accepts `random`
    // (Math.random() * 100 < expected, an A/B-split coin flip). It is left out
    // of the builder on purpose — a browser-automation workflow whose branch
    // depends on a coin flip cannot be reproduced, diffed or debugged, and the
    // "why did last night's run take the other path?" support cost is real.
    // The engine keeps it so hand-written / imported JSON still runs; the
    // builder simply refuses to help you shoot yourself in the foot.
    // Equally NOT surfaced: CompositeCondition.not — every operator here
    // already ships its negative twin (exists/not_exists, equals/not_equals,
    // in_list/not_in_list, …), so a NOT toggle would be a second way to say the
    // same thing, which is exactly the kind of duplicate control that makes a
    // builder feel arbitrary.
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
    // `codeContext` is CONDITIONALLY carried, never defaulted. The engine
    // accepts it only so an imported Automa workflow (which records Background /
    // Active tab) round-trips instead of losing the field; this product has one
    // context, so there is deliberately no control for it (rule R3 — a dropdown
    // whose second entry behaves like the first is a lying control).
    //
    // It must NOT join blankRow(): adding a key there would put it on EVERY
    // serialised row and change params.groups for every already-saved workflow,
    // which is exactly the byte-identity this model protects.
    if (raw.codeContext === 'page') row.codeContext = 'page';
    return row;
  }

  // Parse whatever is stored on the node into a clean [[row,…],…] structure.
  // Falls back to the legacy flat params (selector/operator/value/expected).
  //
  // Collapse default (locked crop, ndv-condition-final.webp): the FIRST row of
  // the FIRST group is expanded and every other row is a one-line summary. Only
  // applied when the stored data carries no explicit `collapsed` flag at all —
  // i.e. a legacy workflow or a graph deserialised from the backend. Once the
  // user expands/collapses anything, writeGroups persists the flags and this
  // never overrides them again.
  function readGroups(params) {
    params = params || {};
    var raw = params.groups;
    var parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    var groups = [];
    var sawFlag = false;
    if (Array.isArray(parsed)) {
      parsed.forEach(function (rows) {
        if (!Array.isArray(rows)) return;
        var clean = rows.map(function (r) {
          if (r && typeof r === 'object' && 'collapsed' in r) sawFlag = true;
          return normalizeRow(r);
        });
        if (clean.length) groups.push(clean);
      });
    }
    if (!sawFlag) {
      groups.forEach(function (rows, gi) {
        rows.forEach(function (row, ri) {
          row.collapsed = !(gi === 0 && ri === 0);
        });
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
    else if (row.source === 'code' && row.value) {
      // A snippet is multi-line and arbitrarily long, so it cannot be a chip the
      // way a selector or a variable name can. Collapse it to its first line and
      // elide the rest: the summary's job is to identify the row at a glance,
      // and a wall of pasted JavaScript in a one-line header does the opposite.
      chips.push({ kind: 'code', text: codeChipText(row.value) });
    } else if (row.value) chips.push({ kind: 'value', text: row.value });
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
    return groupsSummary(readGroups(params), translate);
  }

  // The same one-liner for an ALREADY PARSED groups array — a multi-path node
  // summarises each of its paths, and those groups never live in `params`.
  function groupsSummary(groups, translate) {
    var tr = typeof translate === 'function' ? translate : function (k) { return k; };
    var parts = (groups || []).map(function (rows) {
      return (rows || []).filter(function (row) { return !rowIsBlank(row); }).map(function (row) {
        return rowChips(row).map(function (c) {
          return c.i18n ? tr(c.i18n) : c.text;
        }).join(' ');
      }).join(' AND ');
    }).filter(function (s) { return s !== ''; });
    return parts.join(' OR ');
  }

  // =========================================================================
  // 2b. PRIORITISED PATHS  (mission 7)
  // =========================================================================
  // An `if` node holds an ORDERED list of paths. They are evaluated top → down;
  // the FIRST one whose condition is true is the route taken, and if none match
  // the run leaves through the neutral `next` port. One path keeps the classic
  // true/false shape, so every workflow saved before this feature is untouched.
  //
  //   path = { id: 'p1', name: '', groups: [[row, …], …] }
  //
  // `id` is what the canvas edge port is keyed on (`path:<id>`), so it must be
  // stable across renames and safe inside a port string (no ':').
  var CONDITION_MAX_PATHS = 20;      // Automa's own cap on condition paths
  var PATH_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
  // Kept so older callers/tests that asked "how many paths does v1 run?" still
  // resolve; the runtime is no longer limited to one.
  var CONDITION_MAX_PATHS_V1 = 1;

  function nextPathId(used) {
    var n = 1;
    while (used['p' + n]) n += 1;
    return 'p' + n;
  }

  // One path, defensively normalised: a usable id, a string name and at least
  // one (possibly blank) condition row so the builder always has something to
  // draw.
  function normalizePath(raw, used) {
    used = used || {};
    var src = (raw && typeof raw === 'object') ? raw : {};
    var id = typeof src.id === 'string' && PATH_ID_RE.test(src.id) && !used[src.id]
      ? src.id : nextPathId(used);
    used[id] = true;
    var groups = [];
    if (Array.isArray(src.groups)) {
      src.groups.forEach(function (rows) {
        if (!Array.isArray(rows)) return;
        var clean = rows.map(normalizeRow);
        if (clean.length) groups.push(clean);
      });
    }
    if (!groups.length) groups = [[blankRow()]];
    return {
      id: id,
      name: typeof src.name === 'string' ? src.name : '',
      groups: groups,
    };
  }

  // Read the ordered path list off a node's params. ALWAYS returns ≥ 1 path:
  // a node that never used the feature yields a single path carrying its
  // existing `groups`, which is what makes the migration free.
  function readPaths(params) {
    params = params || {};
    var raw = params.paths;
    var parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    var used = {};
    var out = [];
    if (Array.isArray(parsed)) {
      parsed.forEach(function (p) {
        if (out.length >= CONDITION_MAX_PATHS) return;
        out.push(normalizePath(p, used));
      });
    }
    if (!out.length) out = [{ id: 'p1', name: '', groups: readGroups(params) }];
    return out;
  }

  // Write the path list back. Path 1 is ALSO mirrored into the legacy
  // `groups` + flat fields, so a single-path node serialises byte-identically
  // to what it did before this feature existed, and `params.paths` is removed
  // entirely in that case (rule: never persist redundant state).
  function writePaths(params, paths) {
    params = params || {};
    var used = {};
    var clean = (paths || []).slice(0, CONDITION_MAX_PATHS)
      .map(function (p) { return normalizePath(p, used); });
    if (!clean.length) clean = [{ id: 'p1', name: '', groups: [[blankRow()]] }];
    writeGroups(params, clean[0].groups);
    if (clean.length > 1) {
      params.paths = JSON.stringify(clean.map(function (p) {
        return { id: p.id, name: p.name, groups: p.groups };
      }));
    } else if (params.paths !== undefined) {
      delete params.paths;
    }
    return params;
  }

  function isMultiPath(params) {
    return readPaths(params).length > 1;
  }

  // Display label for a path: the user's name, else "Path <n>".
  function pathLabel(path, index, translate) {
    var tr = typeof translate === 'function' ? translate : function (k) { return k; };
    var nm = path && typeof path.name === 'string' ? path.name.trim() : '';
    return nm || (tr('cb.path') + ' ' + (index + 1));
  }

  // Canvas-card summary for a MULTI-path node: "P1 … · P2 …". Blank paths are
  // skipped, so an unconfigured extra path cannot invent a meaningless clause.
  function pathsSummary(params, translate) {
    var tr = typeof translate === 'function' ? translate : function (k) { return k; };
    var paths = readPaths(params);
    if (paths.length <= 1) return conditionSummary(params, translate);
    var parts = [];
    paths.forEach(function (p, i) {
      var s = groupsSummary(p.groups, translate);
      if (s) parts.push(pathLabel(p, i, tr) + ': ' + s);
    });
    return parts.join(' · ');
  }

  /**
   * The operators offered for a given check kind.
   *
   * This is what makes the row honest: the `element` kind can ONLY be given the
   * operators the engine's DOM branch understands, and the other three kinds
   * can only be given comparison operators — previously every operator was
   * listed for every row, so picking `visible` while "Left source: Element
   * attribute" was set produced a row whose own controls contradicted each
   * other.
   *
   * Note this is deliberately keyed on `dom`, not on a hard-coded kind list, so
   * adding a value type (as `code` was) needs no change here.
   */
  function operatorsForKind(kind) {
    var wantDom = kind === 'element';
    return CONDITION_OPERATORS.filter(function (o) { return !!o.dom === wantDom; });
  }

  /**
   * The same list, bucketed for an <optgroup> dropdown (Automa parity, rule R1).
   * Returns [{ group: <i18n key>, options: [operator, …] }, …] in
   * CONDITION_OPERATOR_GROUPS order, with empty groups dropped — so an
   * `element` row still shows a single "Element" group rather than six empty
   * headings. Pure: no DOM, no i18n; the caller translates `group` and
   * `option.label`.
   */
  function groupedOperatorsForKind(kind) {
    var ops = operatorsForKind(kind);
    var out = [];
    CONDITION_OPERATOR_GROUPS.forEach(function (g) {
      var inGroup = ops.filter(function (o) { return (o.group || 'basic') === g.id; });
      if (inGroup.length) out.push({ group: g.label, options: inGroup });
    });
    // Safety net: an operator added without a known `group` must still be
    // reachable rather than silently vanishing from the dropdown.
    var known = {};
    out.forEach(function (b) { b.options.forEach(function (o) { known[o.id] = true; }); });
    var orphans = ops.filter(function (o) { return !known[o.id]; });
    if (orphans.length) out.push({ group: 'opg.other', options: orphans });
    return out;
  }

  // How much of a snippet a collapsed row's summary chip shows. Long enough to
  // tell two conditions apart, short enough that the header stays one line.
  var CODE_CHIP_MAX = 32;

  /**
   * One-line, length-capped preview of a code snippet for a summary chip.
   * Pure string work: no DOM, no escaping (the renderer already escapes text
   * chips, which is why this must NOT pre-escape or the user would see &lt;).
   */
  function codeChipText(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var nl = s.search(/[\r\n]/);
    var firstLine = nl >= 0 ? s.slice(0, nl).trim() : s;
    var clipped = firstLine.length > CODE_CHIP_MAX
      ? firstLine.slice(0, CODE_CHIP_MAX).trim() + '…'
      : firstLine;
    // A trailing ellipsis for the dropped LINES too, so a 10-line snippet whose
    // first line is short is not mistaken for the whole condition.
    return (nl >= 0 && clipped.slice(-1) !== '…') ? clipped + ' …' : clipped;
  }

  /**
   * Split a `list: true` Right value into the ARRAY the engine's in_list /
   * not_in_list cases require. Newline OR comma separated, trimmed, blanks
   * dropped, so "paid, shipped" and a pasted column both work.
   */
  function parseListValue(raw) {
    return String(raw == null ? '' : raw)
      .split(/[\n,]/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // REMOVED (frontend-only decoration): `EVALUATE_MODES` and the `maxDepth`
  // number backed the NDV footer's "Evaluate mode" / "Max depth" controls.
  // A stack-wide audit found NO backend reference to either key — not in
  // ConditionEngine, not in the pipeline, not in the schemas. They were knobs
  // that changed nothing:
  //   · `maxDepth` guarded "recursive evaluation depth", but this builder can
  //     only ever emit two levels (`any` of `all`), so any value ≥ 2 was
  //     identical and values < 2 still did nothing.
  //   · `evaluateMode: first|all` described short-circuiting, which is simply
  //     how the engine's `any`/`all` already behave — not a user decision.
  // They are gone from the model, the NDV, the action catalog and the
  // serialiser rather than being "implemented" to justify themselves.

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
  //
  // This MUST stay in step with what src/pipeline.ts actually pushes for a click
  // step, otherwise the OUTPUT preview promises a shape the run never produces.
  // Optional keys (modifiers / position) are only present when configured, which
  // mirrors the runtime's conditional spread.
  function clickPayloadPreview(params) {
    var p = normalizeClickParams(params);
    var out = {
      clicked: true,
      selector: p.selector || '#next-button',
      selectorType: p.selectorType,
      button: p.button,
      clickCount: p.clickCount,
      clickType: p.clickType,
      human: p.human,
    };
    var mods = clickModifierList(p);
    if (mods.length) out.modifiers = mods;
    if (p.offsetX !== 0 || p.offsetY !== 0) {
      // Runtime converts the design's center-relative offset into Playwright's
      // top-left `position`; without a live element the raw offset is shown.
      out.position = { x: p.offsetX, y: p.offsetY };
    }
    return out;
  }

  // Playwright modifier names, in the same order the runtime emits them.
  // Ctrl/Cmd -> ControlOrMeta so one workflow behaves the same on every OS.
  function clickModifierList(params) {
    var p = normalizeClickParams(params);
    var mods = [];
    if (p.modAlt) mods.push('Alt');
    if (p.modCtrl) mods.push('ControlOrMeta');
    if (p.modShift) mods.push('Shift');
    return mods;
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
    CONDITION_OPERATOR_GROUPS: CONDITION_OPERATOR_GROUPS,
    CONDITION_ATTRIBUTES: CONDITION_ATTRIBUTES,
    CONDITION_MAX_PATHS_V1: CONDITION_MAX_PATHS_V1,
    CONDITION_MAX_PATHS: CONDITION_MAX_PATHS,
    CONDITION_KINDS: CONDITION_KINDS,
    CONDITION_KIND_GROUPS: CONDITION_KIND_GROUPS,
    CONDITION_CODE_SEED: CONDITION_CODE_SEED,
    checkKindOf: checkKindOf,
    applyCheckKind: applyCheckKind,
    groupedCheckKinds: groupedCheckKinds,
    operatorsForKind: operatorsForKind,
    groupedOperatorsForKind: groupedOperatorsForKind,
    contentSources: contentSources,
    parseListValue: parseListValue,
    codeChipText: codeChipText,
    operatorMeta: operatorMeta,
    sourceMeta: sourceMeta,
    blankRow: blankRow,
    normalizeRow: normalizeRow,
    readGroups: readGroups,
    writeGroups: writeGroups,
    rowChips: rowChips,
    conditionSummary: conditionSummary,
    groupsSummary: groupsSummary,
    rowIsBlank: rowIsBlank,
    // prioritised paths (mission 7)
    normalizePath: normalizePath,
    readPaths: readPaths,
    writePaths: writePaths,
    isMultiPath: isMultiPath,
    pathLabel: pathLabel,
    pathsSummary: pathsSummary,
    // click
    CLICK_DEFAULTS: CLICK_DEFAULTS,
    CLICK_SELECTOR_TYPES: CLICK_SELECTOR_TYPES,
    CLICK_TYPES: CLICK_TYPES,
    CLICK_BUTTONS: CLICK_BUTTONS,
    normalizeClickParams: normalizeClickParams,
    clickPayloadPreview: clickPayloadPreview,
    clickModifierList: clickModifierList,
    // registry
    DESIGNED_NODES: DESIGNED_NODES,
    isDesigned: isDesigned,
  };
})();
