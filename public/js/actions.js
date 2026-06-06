// =====================================================================
// actions.js — Shared ACTION catalog (Step 11)
// ---------------------------------------------------------------------
// Single source of truth for both the linear form builder (views.js) and
// the node-based visual editor (flow-editor.js). Previously the catalog
// was duplicated in both files; it now lives here as window.ACTION_CATALOG.
//
// Field format: { k, label, type, ph?, options?, expr?, help?, min?, max? }
//   - k:        param key sent to the backend as params[k]
//   - label:    i18n key (e.g. 'p.url')
//   - type:     rich field type — one of FIELD_TYPES below
//   - ph:       placeholder (text-like types)
//   - options:  array of option values (options/multiOptions)
//   - expr:     true when the field supports {{ }} expression mode (Step 25)
//   - help:     i18n key for an inline help/description hint (Step 25)
//   - min/max:  numeric bounds (number type, Step 25)
//
// Rich field types (Step 25 — n8n-style NDV):
//   string | password | multiline | number | boolean | options |
//   multiOptions | collection | fixedCollection | assignment | dateTime |
//   code | json | filter
// Legacy 'text'/'select' are aliased to 'string'/'options' by fieldType().
//
// Each action also carries a `cat` (category id) used by the visual editor
// (Step 23) for colour-coding + grouping/searching the palette. Categories
// are defined in CATEGORIES below.
//
// Each backend action ({ action, params }) must be implemented in
// src/pipeline.ts. Loaded BEFORE i18n/api/views/flow-editor in index.html.
// LF line endings (public/** convention).
// =====================================================================
(function () {
  'use strict';

  var ACTIONS = [
    // ---- Navigation & timing -----------------------------------------
    { id: 'goto', icon: '🌐', cat: 'navigation', fields: [
      { k: 'url', label: 'p.url', type: 'string', ph: 'https://example.com', expr: true, help: 'help.url' },
    ] },
    { id: 'wait', icon: '⏳', cat: 'navigation', fields: [
      { k: 'ms', label: 'p.ms', type: 'number', ph: '1000', min: 0, expr: true, help: 'help.ms' },
      { k: 'selector', label: 'p.selector', type: 'string', ph: '(optional) #ready', help: 'help.waitSelector' },
    ] },

    // ---- Mouse / interaction -----------------------------------------
    { id: 'click', icon: '🖱️', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'text', ph: 'button.submit' },
    ] },
    { id: 'hover', icon: '👆', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'text', ph: '.menu' },
    ] },
    { id: 'scroll', icon: '🧭', cat: 'interaction', fields: [
      { k: 'direction', label: 'p.direction', type: 'select', options: ['bottom', 'top'] },
    ] },

    // ---- Forms / keyboard --------------------------------------------
    { id: 'fill', icon: '✏️', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'string', ph: 'input[name=q]' },
      { k: 'text', label: 'p.text', type: 'string', ph: 'hello', expr: true, help: 'help.fillText' },
    ] },
    { id: 'type', icon: '⌨️', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'string', ph: 'input[name=q]' },
      { k: 'text', label: 'p.text', type: 'string', ph: 'hello', expr: true, help: 'help.fillText' },
    ] },
    { id: 'press', icon: '↩️', cat: 'interaction', fields: [
      { k: 'text', label: 'p.key', type: 'text', ph: 'Enter' },
    ] },
    { id: 'select', icon: '🔽', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'text', ph: 'select#country' },
      { k: 'value', label: 'p.value', type: 'text', ph: 'IR' },
    ] },
    { id: 'upload', icon: '📎', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'text', ph: 'input[type=file]' },
      { k: 'path', label: 'p.value', type: 'text', ph: 'uploads/file.pdf' },
    ] },

    // ---- Data extraction & export ------------------------------------
    { id: 'extract', icon: '📤', cat: 'data', fields: [
      { k: 'selector', label: 'p.selector', type: 'string', ph: '.price' },
      { k: 'name', label: 'p.name', type: 'string', ph: 'price', help: 'help.saveAs' },
    ] },
    { id: 'export-data', icon: '💾', cat: 'data', fields: [
      { k: 'format', label: 'p.format', type: 'options', options: ['json', 'csv'] },
      { k: 'from', label: 'p.from', type: 'string', ph: '(optional) variable name' },
      { k: 'filename', label: 'p.filename', type: 'string', ph: 'export', expr: true },
    ] },
    { id: 'screenshot', icon: '📸', cat: 'data', fields: [] },

    // ---- Variables (Automa-style transforms) -------------------------
    { id: 'variable', icon: '🔢', cat: 'data', fields: [
      { k: 'op', label: 'p.op', type: 'options', options: ['set', 'regex', 'replace', 'slice', 'split', 'join', 'sort'] },
      { k: 'name', label: 'p.name', type: 'string', ph: 'result' },
      { k: 'from', label: 'p.from', type: 'string', ph: '(optional) source variable' },
      { k: 'value', label: 'p.value', type: 'string', ph: 'literal value (if no "from")', expr: true, help: 'help.varValue' },
      { k: 'pattern', label: 'p.pattern', type: 'string', ph: 'regex / replace pattern' },
      { k: 'flags', label: 'p.flags', type: 'string', ph: 'g i m' },
      { k: 'replacement', label: 'p.replacement', type: 'string', ph: 'replace op' },
      { k: 'separator', label: 'p.separator', type: 'string', ph: 'split / join' },
      { k: 'start', label: 'p.start', type: 'number', ph: 'slice start' },
      { k: 'end', label: 'p.end', type: 'number', ph: 'slice end' },
      { k: 'numeric', label: 'p.numeric', type: 'boolean' },
      { k: 'desc', label: 'p.desc', type: 'boolean' },
    ] },

    // ---- Cookies & clipboard -----------------------------------------
    { id: 'cookie', icon: '🍪', cat: 'integration', fields: [
      { k: 'op', label: 'p.op', type: 'options', options: ['getAll', 'get', 'set', 'clear'] },
      { k: 'name', label: 'p.name', type: 'string', ph: 'session_id' },
      { k: 'value', label: 'p.value', type: 'string', ph: 'set op only', expr: true },
      { k: 'domain', label: 'p.domain', type: 'string', ph: '(optional) .example.com' },
      { k: 'expires', label: 'p.expires', type: 'number', ph: '(optional) unix ts' },
    ] },
    { id: 'clipboard', icon: '📋', cat: 'integration', fields: [
      { k: 'action', label: 'p.op', type: 'options', options: ['get', 'set', 'copy', 'paste'] },
      { k: 'text', label: 'p.text', type: 'string', ph: 'set op', expr: true },
      { k: 'selector', label: 'p.selector', type: 'string', ph: 'copy/paste op' },
    ] },

    // ---- Notification & logging --------------------------------------
    { id: 'notification', icon: '🔔', cat: 'integration', fields: [
      { k: 'title', label: 'p.title', type: 'string', ph: 'Done', expr: true },
      { k: 'message', label: 'p.message', type: 'multiline', ph: 'workflow finished', expr: true },
      { k: 'level', label: 'p.level', type: 'options', options: ['info', 'success', 'warn', 'error'] },
    ] },
    { id: 'log', icon: '📝', cat: 'integration', fields: [
      { k: 'message', label: 'p.message', type: 'multiline', ph: 'checkpoint', expr: true },
    ] },

    // ---- Flow / branching (Step 24) ----------------------------------
    // These actions declare multiple OUTPUT PORTS via `branches`. Each
    // branch's nodes are serialised into a nested group on the backend
    // AutomationStep (then/else/steps/cases/catch/finally). A node WITHOUT
    // `branches` implicitly has a single 'next' port (the linear default).
    { id: 'if', icon: '🔀', cat: 'flow',
      branches: [{ id: 'then', label: 'port.then' }, { id: 'else', label: 'port.else' }],
      fields: [
        { k: 'selector', label: 'p.selector', type: 'string', ph: '(optional) .el' },
        { k: 'operator', label: 'p.operator', type: 'options', options: ['exists', 'not_exists', 'visible', 'hidden', 'equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] },
        { k: 'value', label: 'p.value', type: 'string', ph: '(optional) left/var value', expr: true },
        { k: 'expected', label: 'p.expected', type: 'string', ph: '(optional) compare to', expr: true },
      ] },
    { id: 'switch', icon: '🔢', cat: 'flow',
      branches: [{ id: 'default', label: 'port.default' }],
      dynamicBranches: 'cases',
      fields: [
        { k: 'variable', label: 'p.variable', type: 'string', ph: 'status', expr: true },
        { k: 'casesList', label: 'p.cases', type: 'string', ph: 'a, b, c (comma list)' },
      ] },
    { id: 'loop', icon: '🔁', cat: 'flow',
      branches: [{ id: 'body', label: 'port.body' }, { id: 'done', label: 'port.done' }],
      fields: [
        { k: 'count', label: 'p.count', type: 'number', ph: '3', min: 0, expr: true },
      ] },
    { id: 'foreach', icon: '🔂', cat: 'flow',
      branches: [{ id: 'body', label: 'port.body' }, { id: 'done', label: 'port.done' }],
      fields: [
        { k: 'items', label: 'p.items', type: 'string', ph: 'variable holding array', expr: true },
        { k: 'itemVar', label: 'p.itemVar', type: 'string', ph: 'item' },
      ] },
    { id: 'while', icon: '♾️', cat: 'flow',
      branches: [{ id: 'body', label: 'port.body' }, { id: 'done', label: 'port.done' }],
      fields: [
        { k: 'selector', label: 'p.selector', type: 'string', ph: '(optional) .el' },
        { k: 'operator', label: 'p.operator', type: 'options', options: ['exists', 'not_exists', 'visible', 'hidden', 'equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] },
        { k: 'value', label: 'p.value', type: 'string', ph: '(optional) left/var value', expr: true },
        { k: 'expected', label: 'p.expected', type: 'string', ph: '(optional) compare to', expr: true },
        { k: 'maxIterations', label: 'p.maxIterations', type: 'number', ph: '100', min: 1 },
      ] },
    { id: 'try', icon: '🛡️', cat: 'flow',
      branches: [{ id: 'try', label: 'port.try' }, { id: 'catch', label: 'port.catch' }, { id: 'finally', label: 'port.finally' }],
      fields: [] },
    // Step 27: deliberate, conditional failure (n8n "Stop And Error").
    { id: 'stop_and_error', icon: '🛑', cat: 'flow', fields: [
      { k: 'message', label: 'p.message', type: 'string', ph: 'Why this stops', expr: true, help: 'help.stopError' },
    ] },
  ];

  // Rich field-type registry (Step 25). `input` tells the renderer which
  // control to build. `expr` marks types that can carry a {{ }} expression by
  // default (the per-field `expr` flag can still opt-in/out individually).
  var FIELD_TYPES = {
    string:          { input: 'text',     expr: true },
    password:        { input: 'password',  expr: false },
    multiline:       { input: 'textarea',  expr: true },
    number:          { input: 'number',    expr: true },
    boolean:         { input: 'toggle',    expr: false },
    options:         { input: 'select',    expr: false },
    multiOptions:    { input: 'multi',     expr: false },
    collection:      { input: 'collection', expr: false },
    fixedCollection: { input: 'collection', expr: false },
    assignment:      { input: 'assignment', expr: true },
    dateTime:        { input: 'datetime',  expr: true },
    code:            { input: 'code',       expr: false },
    json:            { input: 'json',       expr: true },
    filter:          { input: 'filter',     expr: false },
  };
  // Normalise a field's declared type (incl. legacy aliases) to a FIELD_TYPES
  // entry plus the effective `expressionable` flag for that specific field.
  function fieldType(field) {
    field = field || {};
    var t = field.type || 'string';
    if (t === 'text') t = 'string';
    if (t === 'select') t = 'options';
    var meta = FIELD_TYPES[t] || FIELD_TYPES.string;
    // A field is expressionable only when it explicitly opts in (`expr:true`)
    // AND its type supports expressions.
    var expressionable = field.expr === true && meta.expr === true;
    return { type: t, input: meta.input, expressionable: expressionable };
  }

  // Category metadata for the visual editor (Step 23): colour + i18n label.
  // `color` drives the node's left accent bar and palette group dot.
  var CATEGORIES = [
    { id: 'navigation',  color: '#4f8cff', label: 'cat.navigation' },
    { id: 'interaction', color: '#a855f7', label: 'cat.interaction' },
    { id: 'data',        color: '#3ecf8e', label: 'cat.data' },
    { id: 'flow',        color: '#f5a623', label: 'cat.flow' },
    { id: 'integration', color: '#06b6d4', label: 'cat.integration' },
    { id: 'trigger',     color: '#ef4444', label: 'cat.trigger' }
  ];
  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].id === id) return CATEGORIES[i];
    }
    return { id: 'other', color: '#6b7280', label: 'cat.other' };
  }

  function actionById(id) {
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].id === id) return ACTIONS[i];
    }
    return ACTIONS[0];
  }

  // Step 24: the output ports of an action. Branching actions declare them
  // via `branches`; every other action has a single implicit 'next' port.
  function branchesOf(id) {
    var act = null;
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].id === id) { act = ACTIONS[i]; break; }
    }
    if (act && Array.isArray(act.branches) && act.branches.length) {
      return act.branches.slice();
    }
    return [{ id: 'next', label: 'port.next' }];
  }
  // True when an action has more than the single linear 'next' port.
  function isBranching(id) {
    var b = branchesOf(id);
    return !(b.length === 1 && b[0].id === 'next');
  }

  // Expose globally (CSP-safe, no modules).
  window.ACTION_CATALOG = {
    ACTIONS: ACTIONS,
    CATEGORIES: CATEGORIES,
    actionById: actionById,
    categoryById: categoryById,
    branchesOf: branchesOf,
    isBranching: isBranching,
    FIELD_TYPES: FIELD_TYPES,
    fieldType: fieldType,
    ids: function () { return ACTIONS.map(function (a) { return a.id; }); },
  };
})();
