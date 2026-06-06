// =====================================================================
// actions.js — Shared ACTION catalog (Step 11)
// ---------------------------------------------------------------------
// Single source of truth for both the linear form builder (views.js) and
// the node-based visual editor (flow-editor.js). Previously the catalog
// was duplicated in both files; it now lives here as window.ACTION_CATALOG.
//
// Field format: { k, label, type, ph?, options? }
//   - k:        param key sent to the backend as params[k]
//   - label:    i18n key (e.g. 'p.url')
//   - type:     'text' | 'number' | 'select'
//   - ph:       placeholder (text/number only)
//   - options:  array of option values (select only)
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
      { k: 'url', label: 'p.url', type: 'text', ph: 'https://example.com' },
    ] },
    { id: 'wait', icon: '⏳', cat: 'navigation', fields: [
      { k: 'ms', label: 'p.ms', type: 'number', ph: '1000' },
      { k: 'selector', label: 'p.selector', type: 'text', ph: '(optional) #ready' },
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
      { k: 'selector', label: 'p.selector', type: 'text', ph: 'input[name=q]' },
      { k: 'text', label: 'p.text', type: 'text', ph: 'hello' },
    ] },
    { id: 'type', icon: '⌨️', cat: 'interaction', fields: [
      { k: 'selector', label: 'p.selector', type: 'text', ph: 'input[name=q]' },
      { k: 'text', label: 'p.text', type: 'text', ph: 'hello' },
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
      { k: 'selector', label: 'p.selector', type: 'text', ph: '.price' },
      { k: 'name', label: 'p.name', type: 'text', ph: 'price' },
    ] },
    { id: 'export-data', icon: '💾', cat: 'data', fields: [
      { k: 'format', label: 'p.format', type: 'select', options: ['json', 'csv'] },
      { k: 'from', label: 'p.from', type: 'text', ph: '(optional) variable name' },
      { k: 'filename', label: 'p.filename', type: 'text', ph: 'export' },
    ] },
    { id: 'screenshot', icon: '📸', cat: 'data', fields: [] },

    // ---- Variables (Automa-style transforms) -------------------------
    { id: 'variable', icon: '🔢', cat: 'data', fields: [
      { k: 'op', label: 'p.op', type: 'select', options: ['set', 'regex', 'replace', 'slice', 'split', 'join', 'sort'] },
      { k: 'name', label: 'p.name', type: 'text', ph: 'result' },
      { k: 'from', label: 'p.from', type: 'text', ph: '(optional) source variable' },
      { k: 'value', label: 'p.value', type: 'text', ph: 'literal value (if no "from")' },
      { k: 'pattern', label: 'p.pattern', type: 'text', ph: 'regex / replace pattern' },
      { k: 'flags', label: 'p.flags', type: 'text', ph: 'g i m' },
      { k: 'replacement', label: 'p.replacement', type: 'text', ph: 'replace op' },
      { k: 'separator', label: 'p.separator', type: 'text', ph: 'split / join' },
      { k: 'start', label: 'p.start', type: 'number', ph: 'slice start' },
      { k: 'end', label: 'p.end', type: 'number', ph: 'slice end' },
      { k: 'numeric', label: 'p.numeric', type: 'select', options: ['', 'true', 'false'] },
      { k: 'desc', label: 'p.desc', type: 'select', options: ['', 'true', 'false'] },
    ] },

    // ---- Cookies & clipboard -----------------------------------------
    { id: 'cookie', icon: '🍪', cat: 'integration', fields: [
      { k: 'op', label: 'p.op', type: 'select', options: ['getAll', 'get', 'set', 'clear'] },
      { k: 'name', label: 'p.name', type: 'text', ph: 'session_id' },
      { k: 'value', label: 'p.value', type: 'text', ph: 'set op only' },
      { k: 'domain', label: 'p.domain', type: 'text', ph: '(optional) .example.com' },
      { k: 'expires', label: 'p.expires', type: 'number', ph: '(optional) unix ts' },
    ] },
    { id: 'clipboard', icon: '📋', cat: 'integration', fields: [
      { k: 'action', label: 'p.op', type: 'select', options: ['get', 'set', 'copy', 'paste'] },
      { k: 'text', label: 'p.text', type: 'text', ph: 'set op' },
      { k: 'selector', label: 'p.selector', type: 'text', ph: 'copy/paste op' },
    ] },

    // ---- Notification & logging --------------------------------------
    { id: 'notification', icon: '🔔', cat: 'integration', fields: [
      { k: 'title', label: 'p.title', type: 'text', ph: 'Done' },
      { k: 'message', label: 'p.message', type: 'text', ph: 'workflow finished' },
      { k: 'level', label: 'p.level', type: 'select', options: ['info', 'success', 'warn', 'error'] },
    ] },
    { id: 'log', icon: '📝', cat: 'integration', fields: [
      { k: 'message', label: 'p.message', type: 'text', ph: 'checkpoint' },
    ] },

    // ---- Flow / branching (Step 24) ----------------------------------
    // These actions declare multiple OUTPUT PORTS via `branches`. Each
    // branch's nodes are serialised into a nested group on the backend
    // AutomationStep (then/else/steps/cases/catch/finally). A node WITHOUT
    // `branches` implicitly has a single 'next' port (the linear default).
    { id: 'if', icon: '🔀', cat: 'flow',
      branches: [{ id: 'then', label: 'port.then' }, { id: 'else', label: 'port.else' }],
      fields: [
        { k: 'selector', label: 'p.selector', type: 'text', ph: '(optional) .el' },
        { k: 'operator', label: 'p.operator', type: 'select', options: ['exists', 'not_exists', 'visible', 'hidden', 'equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] },
        { k: 'value', label: 'p.value', type: 'text', ph: '(optional) left/var value' },
        { k: 'expected', label: 'p.expected', type: 'text', ph: '(optional) compare to' },
      ] },
    { id: 'switch', icon: '🔢', cat: 'flow',
      branches: [{ id: 'default', label: 'port.default' }],
      dynamicBranches: 'cases',
      fields: [
        { k: 'variable', label: 'p.variable', type: 'text', ph: 'status' },
        { k: 'casesList', label: 'p.cases', type: 'text', ph: 'a, b, c (comma list)' },
      ] },
    { id: 'loop', icon: '🔁', cat: 'flow',
      branches: [{ id: 'body', label: 'port.body' }, { id: 'done', label: 'port.done' }],
      fields: [
        { k: 'count', label: 'p.count', type: 'number', ph: '3' },
      ] },
    { id: 'foreach', icon: '🔂', cat: 'flow',
      branches: [{ id: 'body', label: 'port.body' }, { id: 'done', label: 'port.done' }],
      fields: [
        { k: 'items', label: 'p.items', type: 'text', ph: 'variable holding array' },
        { k: 'itemVar', label: 'p.itemVar', type: 'text', ph: 'item' },
      ] },
    { id: 'while', icon: '♾️', cat: 'flow',
      branches: [{ id: 'body', label: 'port.body' }, { id: 'done', label: 'port.done' }],
      fields: [
        { k: 'selector', label: 'p.selector', type: 'text', ph: '(optional) .el' },
        { k: 'operator', label: 'p.operator', type: 'select', options: ['exists', 'not_exists', 'visible', 'hidden', 'equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'not_empty'] },
        { k: 'value', label: 'p.value', type: 'text', ph: '(optional) left/var value' },
        { k: 'expected', label: 'p.expected', type: 'text', ph: '(optional) compare to' },
        { k: 'maxIterations', label: 'p.maxIterations', type: 'number', ph: '100' },
      ] },
    { id: 'try', icon: '🛡️', cat: 'flow',
      branches: [{ id: 'try', label: 'port.try' }, { id: 'catch', label: 'port.catch' }, { id: 'finally', label: 'port.finally' }],
      fields: [] },
  ];

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
    ids: function () { return ACTIONS.map(function (a) { return a.id; }); },
  };
})();
