/*
 * flow-editor.js — node-based visual Flow editor (inspired by Automa).
 *
 * Pure vanilla JS, CSP-safe (script-src 'self'): no framework, no CDN, no inline
 * scripts. The canvas is plain SVG + absolutely-positioned HTML node cards.
 *
 * Concept (like Automa "connecting blocks"):
 *   - Every action is a NODE on a canvas.
 *   - Nodes are connected by EDGES (output port -> input port) that define
 *     execution order, starting from the single "start" node.
 *   - The linear list of nodes reachable from start is serialised to the SAME
 *     `steps: [{ action, params }]` JSON the backend already accepts.
 *
 * Exposes window.FlowEditor = { mount, unmount, toSteps, loadSteps, validate, ... }.
 *
 * Step 24: nodes can be BRANCHING (if/switch/loop/foreach/while/try) with
 * multiple labelled output ports. Edges carry a `port` id; serialisation to/
 * from the backend's nested steps[] (then/else/cases/steps/catch/finally) is
 * delegated to the DOM-free GraphSerialize module (public/js/graph-serialize.js).
 *
 * Loaded AFTER app.js is NOT guaranteed; this file is loaded before app.js in
 * index.html (order: i18n -> api -> flow-editor -> views -> app), so — like
 * views.js — it resolves AppUtil lazily via U().
 */
(function () {
  'use strict';

  var API = window.API;
  function U() { return window.AppUtil; }
  function t(k) { return U() ? U().t(k) : k; }
  function esc(s) { return U() ? U().esc(s) : String(s == null ? '' : s); }

  // ---- Icons (public/js/icons.js) -------------------------------------------
  // IC(name)      -> inline SVG for a chrome icon (chevron, trash, plus, …)
  // ICON(actionId)-> inline SVG for an ACTION_CATALOG action
  // Both degrade to an empty string when icons.js is absent, so the editor still
  // renders text-only rather than throwing.
  function IC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : '';
  }
  function ICON(actionId, size) {
    return window.Icons ? window.Icons.action(actionId, { size: size || 16 }) : '';
  }

  // Platform modifier key for the palette's search hint. The image shows the
  // Mac glyph; on Windows/Linux the same shortcut is Ctrl, so the hint has to
  // follow the actual platform rather than hardcode one of them.
  var MOD_KEY = (function () {
    try {
      var p = (navigator.platform || navigator.userAgent || '');
      return /Mac|iPhone|iPad|iPod/i.test(p) ? '\u2318' : 'Ctrl';
    } catch (e) { return 'Ctrl'; }
  })();

  // ---- Action catalog (mirrors views.js so a node == an action) -------------
  // Each action defines its editable params (fields). `branches` lists the
  // output ports of a node; default is a single 'next' port. Condition/loop
  // style actions can declare multiple branches for richer control later.
  // Shared catalog (public/js/actions.js → window.ACTION_CATALOG).
  var CAT = window.ACTION_CATALOG || { ACTIONS: [], CATEGORIES: [] };
  var ACTIONS = CAT.ACTIONS;
  var CATEGORIES = CAT.CATEGORIES || [];
  function categoryOf(actionId) {
    var act = actionById(actionId);
    var cid = act && act.cat ? act.cat : 'other';
    return CAT.categoryById ? CAT.categoryById(cid) : { id: cid, color: '#6b7280', label: 'cat.other' };
  }

  // Step 23: visual constants.
  var GRID = 20;            // grid size for snap-to-grid
  function snap(v) { return Math.round(v / GRID) * GRID; }
  // Note: unlike the shared helper (which falls back to ACTIONS[0]), the editor
  // needs a strict lookup that returns null for unknown/synthetic node types
  // (e.g. '__start__'). Callers already guard on a null result.
  function actionById(id) {
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i];
    return null;
  }

  // ---- Editor state ---------------------------------------------------------
  var state = null; // { nodes:{}, edges:[], nextId, selected, selSet, view:{x,y,scale} }
  var dom = null;    // { root, canvas, svg, world, palette, inspector, minimap, ... }
  var drag = null;   // active node-drag or connection-drag context
  var listeners = []; // [{ target, type, fn }] for clean unmount
  var clipboard = null; // Step 23: copied nodes (for paste)
  var nodeStatus = {};  // Step 23: { nodeId: 'idle'|'running'|'success'|'error' }
  var paletteQuery = ''; // Step 23: palette search text

  // ---- BLOCKS palette view state (item D) -----------------------------------
  // All four are pure VIEW preferences, deliberately module-level and never on
  // `state`, so they can never leak into saveLocal()/serialize()/steps[].
  var PAL_FAV_KEY = 'ab_palette_favs';
  var paletteFavs = {};      // { actionId: true } — starred blocks
  var paletteOpen = {};      // { groupId: true } — expanded category rows
  // The `Collapse` control at the palette footer. Hydrated from the sticky UI
  // prefs when the editor mounts (see hydrateViewPrefs) so the choice survives a
  // reload -- collapsing the palette on every visit only to have it spring back
  // open is the whole complaint. The DEFAULT stays expanded on purpose: the
  // locked images disagree with each other (state-empty-canvas shows the
  // 13-glyph rail, the NDV image shows the full category list), so this is a
  // user preference, not a design constant.
  var paletteCollapsed = false;

  // app.js is the LAST script tag, so `window.AppUtil` does not exist while this
  // IIFE evaluates. These read it at CALL time and no-op until it is there,
  // which keeps ONE owner of the `ab_ui_prefs` blob instead of a second parser
  // here that could disagree about its shape.
  function prefGet(key, fallback) {
    var A = window.AppUtil;
    return A && A.pref ? A.pref(key, fallback) : fallback;
  }
  function prefSet(key, value) {
    var A = window.AppUtil;
    if (A && A.setPref) A.setPref(key, value);
    return value;
  }

  /** Restore sticky panel state. Called once per editor mount, before render. */
  function hydrateViewPrefs() {
    paletteCollapsed = !!prefGet('fePaletteCollapsed', false);
  }

  function loadPaletteFavs() {
    try {
      var raw = localStorage.getItem(PAL_FAV_KEY);
      paletteFavs = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { paletteFavs = {}; }
  }
  function savePaletteFavs() {
    try { localStorage.setItem(PAL_FAV_KEY, JSON.stringify(paletteFavs)); }
    catch (e) { /* quota — favourites are a convenience, not data */ }
  }
  function favCount() { return Object.keys(paletteFavs).length; }
  var nodeResults = {};  // Step 25: { nodeId: { input:[...], output:[...] } } per-node items for the NDV INPUT/OUTPUT columns (populated by the live runner in Step 26)
  var nodeMeta = {};     // Step 26: { nodeId: { outputItemCount, inputItemCount, durationMs, status, error } } drives the on-node success/error badge + tooltip
  var nodePins = {};     // Step 26: { nodeId: true } pinned nodes (show a 📌 indicator on the card)

  // Canvas chrome state (items F + G of the uiux gap list).
  // `tool` mirrors the floating toolbar's active pointer mode:
  //   'select' — default; background drag = pan, Shift+drag = box-select
  //   'pan'    — background drag always pans (Shift still box-selects)
  // `locked` freezes node positions (cards stay clickable/openable).
  // `grid`/`minimapOpen` are pure view preferences. All four live outside
  // `state` on purpose: they are workspace chrome, not graph data, so they
  // must never reach serialize()/saveLocal() or the steps[] round-trip.
  var canvasTool = 'select';
  var canvasLocked = false;
  var gridVisible = true;
  var minimapOpen = true;

  // Status bar "Last saved: HH:MM:SS" (shell previews). null until a save
  // actually succeeds — the bar shows an em-dash rather than a fake time.
  var lastSavedAt = null;
  function clockLabel(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // Step 22: the saved-workflow currently open in the editor (if any).
  // { id, name, description, version, headless, webhookUrl } | null.
  // When null, the editor is editing an unsaved/local graph.
  var currentWorkflow = null;

  function uid(prefix) {
    state.nextId += 1;
    return (prefix || 'n') + state.nextId;
  }

  function newGraph() {
    var start = { id: 'start', action: '__start__', params: {}, x: 60, y: 200 };
    nodeStatus = {}; nodeMeta = {}; nodePins = {}; nodeResults = {};
    return { nodes: { start: start }, edges: [], nextId: 0, selected: null,
      selSet: {}, view: { x: 0, y: 0, scale: 1 } };
  }

  function on(target, type, fn) {
    target.addEventListener(type, fn);
    listeners.push({ target: target, type: type, fn: fn });
  }
  function offAll() {
    listeners.forEach(function (l) { l.target.removeEventListener(l.type, l.fn); });
    listeners = [];
  }

  // ---- Serialisation: graph <-> steps[] -------------------------------------
  // Walk the chain from `start` following each node's single outgoing edge.
  // Produces [{ action, params }] identical to the linear run-builder format.
  // The 'next' (main-chain) edge from a node. Used by chainNodeIds() for the
  // linear status walk; branch edges (then/else/body/...) are ignored here.
  function outgoing(nodeId) {
    for (var i = 0; i < state.edges.length; i++) {
      var e = state.edges[i];
      if (e.from === nodeId && (e.port || 'next') === 'next') return e;
    }
    // start node may use a non-'next' first edge in older graphs — fall back.
    for (var j = 0; j < state.edges.length; j++) {
      if (state.edges[j].from === nodeId) return state.edges[j];
    }
    return null;
  }

  function coerceParams(node) {
    var act = actionById(node.action);
    var params = {};
    if (!act) return params;
    act.fields.forEach(function (f) {
      var v = node.params[f.k];
      if (v === undefined || v === null || v === '') return;
      if (f.type === 'number') {
        var n = parseInt(v, 10);
        if (!isNaN(n)) params[f.k] = n;
      } else {
        params[f.k] = v;
      }
    });
    return params;
  }

  // Step 24: serialization is delegated to the DOM-free GraphSerialize module
  // (public/js/graph-serialize.js) so it can be unit-tested without a DOM.
  // This supports non-linear branching graphs (if/switch/loop/foreach/while/try)
  // and nests them into the backend's then/else/cases/steps/catch/finally shape.
  function GS() { return window.GraphSerialize; }

  function toSteps() {
    if (GS()) return GS().graphToSteps(state);
    // Fallback (serializer not loaded): linear walk.
    var steps = [];
    var seen = {};
    var edge = outgoing('start');
    var guard = 0;
    while (edge && guard < 1000) {
      guard += 1;
      var node = state.nodes[edge.to];
      if (!node || seen[node.id]) break;
      seen[node.id] = true;
      if (node.action !== '__start__') steps.push({ action: node.action, params: coerceParams(node) });
      edge = outgoing(node.id);
    }
    return steps;
  }

  // Validate the current graph (orphan nodes, missing required params, etc.).
  function validate() {
    if (GS()) return GS().validateGraph(state);
    return { ok: true, errors: [], warnings: [] };
  }

  // Rebuild a laid-out graph from a (possibly nested) steps[] array.
  function loadSteps(steps) {
    if (GS()) {
      var g = GS().stepsToGraph(steps || []);
      // preserve a fresh selection/view shape the editor expects
      state = g;
      state.selected = null;
      state.selSet = {};
      nodeStatus = {}; nodeMeta = {}; nodePins = {}; nodeResults = {};
      if (dom) renderAll();
      return;
    }
    // Fallback: linear layout.
    state = newGraph();
    var prevId = 'start';
    var x = 280;
    (steps || []).forEach(function (s, i) {
      var act = actionById(s.action);
      if (!act) return;
      var id = uid('n');
      var params = {};
      (s.params && typeof s.params === 'object') &&
        act.fields.forEach(function (f) {
          if (s.params[f.k] !== undefined) params[f.k] = String(s.params[f.k]);
        });
      state.nodes[id] = { id: id, action: s.action, params: params,
        x: snap(x), y: snap(160 + (i % 2) * 40) };
      state.edges.push({ from: prevId, to: id, port: 'next' });
      prevId = id;
      x += 240;
    });
    if (dom) renderAll();
  }

  // ---- Persistence (localStorage) -------------------------------------------
  var LS_KEY = 'ab_flow_graph';
  function serialize() {
    return JSON.stringify({
      nodes: state.nodes, edges: state.edges, nextId: state.nextId,
      view: state.view,
    });
  }
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, serialize());
      lastSavedAt = clockLabel(new Date());
      return true;
    } catch (e) { return false; }
  }
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !data.nodes || !data.nodes.start) return false;
      state.nodes = data.nodes;
      state.edges = Array.isArray(data.edges) ? data.edges : [];
      state.nextId = data.nextId || 0;
      state.view = data.view || { x: 0, y: 0, scale: 1 };
      state.selected = null;
      state.selSet = {};
      nodeStatus = {}; nodeMeta = {}; nodePins = {}; nodeResults = {};
      return true;
    } catch (e) { return false; }
  }

  // ---- Undo / redo (item A: the top bar's ↶ ↷ pair) -------------------------
  // The locked shell shows undo/redo left of `Export`. A COMMAND stack would
  // need every mutation path to describe its own inverse; the editor has many
  // (drag, connect, paste, NDV field edits, Auto Layout, …) and any that forgot
  // would corrupt the graph silently. So this is a SNAPSHOT stack of the same
  // JSON `serialize()` already writes to localStorage — one implementation, and
  // a path that cannot desynchronise from what is actually persisted.
  //
  // Snapshots deliberately exclude `selected`/`selSet`: undo restores the
  // GRAPH, not the cursor. They also exclude run results (nodeResults/nodeMeta/
  // nodePins), which belong to an execution and not to the document.
  var HISTORY_LIMIT = 60;        // ~60 snapshots of a few KB — bounded memory
  var undoStack = [];
  var redoStack = [];
  var historySuspended = false;  // true while APPLYING a snapshot (no re-record)
  var chromeListeners = [];      // shell subscribers (outline, undo/redo state)

  /** Subscribe to graph changes. Returns an unsubscribe function. */
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    chromeListeners.push(fn);
    return function () {
      var i = chromeListeners.indexOf(fn);
      if (i !== -1) chromeListeners.splice(i, 1);
    };
  }
  function emitChange() {
    for (var i = 0; i < chromeListeners.length; i++) {
      try { chromeListeners[i](); } catch (e) { /* a bad subscriber must not break the editor */ }
    }
  }

  /**
   * Record the CURRENT graph as an undo point. Call BEFORE mutating, so the
   * stack holds the state to go back TO. Consecutive identical snapshots are
   * collapsed, so a no-op mutation never costs an undo press.
   */
  function pushHistory() {
    if (historySuspended || !state) return;
    var snap = serialize();
    if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
    undoStack.push(snap);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];   // a new edit invalidates the redo branch
  }

  function applySnapshot(json) {
    var data;
    try { data = JSON.parse(json); } catch (e) { return false; }
    if (!data || !data.nodes || !data.nodes.start) return false;
    historySuspended = true;
    state.nodes = data.nodes;
    state.edges = Array.isArray(data.edges) ? data.edges : [];
    state.nextId = data.nextId || 0;
    state.view = data.view || { x: 0, y: 0, scale: 1 };
    // A node the snapshot does not contain must not stay selected, or the NDV
    // would render a node that no longer exists.
    if (state.selected && !state.nodes[state.selected]) state.selected = null;
    var keep = {};
    Object.keys(state.selSet || {}).forEach(function (id) {
      if (state.nodes[id]) keep[id] = true;
    });
    state.selSet = keep;
    if (ndvOpen && !state.nodes[ndvOpen]) closeNdv();
    historySuspended = false;
    return true;
  }

  function undo() {
    if (!undoStack.length) return false;
    var current = serialize();
    var prev = undoStack.pop();
    if (!applySnapshot(prev)) return false;
    redoStack.push(current);
    if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
    // renderAll() already notifies subscribers; emit directly when unmounted so
    // a headless undo still updates whatever is listening.
    if (dom) renderAll(); else emitChange();
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    var current = serialize();
    var next = redoStack.pop();
    if (!applySnapshot(next)) return false;
    undoStack.push(current);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    // renderAll() already notifies subscribers; emit directly when unmounted so
    // a headless undo still updates whatever is listening.
    if (dom) renderAll(); else emitChange();
    return true;
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }
  function clearHistory() { undoStack = []; redoStack = []; }

  // ---- Geometry helpers -----------------------------------------------------
  // Node card metrics come from the shell previews (docs/uiux/shell-editor-*.md):
  // cards measure ~190x64, radius 8, with ports centred on the left/right edges.
  var NODE_W = 190;
  var NODE_H_MIN = 64;      // spec: "node card height 48-58" for the body, 64 with padding
  var PORT_SLOT = 22;       // vertical pitch when a node exposes several ports
  var PORT_R = 7;           // half of the 14px port dot (used to centre it)
  // Half of the 18px circled `+` chip on a free output port. Kept next to
  // PORT_R because both are the JS half of a CSS size: change one, change both
  // (the chip's own width lives in `.flow-port-add`).
  var PORT_ADD_R = 9;
  function nodeW() { return NODE_W; }
  // Step 24: ports of a node. Branching actions expose multiple output ports
  // (then/else, body/done, try/catch/finally, switch cases). Returns a list of
  // { id, label } where the first is at the top.
  function portsOf(node) {
    if (node.action === '__start__') return [{ id: 'next', label: 'port.next' }];
    var base = (CAT.branchesOf ? CAT.branchesOf(node.action) : [{ id: 'next', label: 'port.next' }]);
    // if/switch/try also expose an implicit 'next' (main-chain continuation).
    var act = actionById(node.action);
    var needsNext = act && (node.action === 'if' || node.action === 'switch' || node.action === 'try');
    var ports = base.slice();
    // dynamic switch cases from a comma list (casesList param)
    if (node.action === 'switch' && node.params && node.params.casesList) {
      String(node.params.casesList).split(',').forEach(function (raw) {
        var v = raw.trim();
        if (v) ports.push({ id: 'case:' + v, label: v });
      });
    }
    if (needsNext) ports.push({ id: 'next', label: 'port.next' });
    return ports;
  }
  function nodeH(node) {
    var ports = portsOf(node);
    // A single-port card is exactly the spec height; extra branch ports grow it
    // just enough that each port keeps its PORT_SLOT pitch inside the card.
    if (ports.length <= 1) return NODE_H_MIN;
    return Math.max(NODE_H_MIN, 26 + ports.length * PORT_SLOT);
  }
  // Y position of a given output port slot (port id) on a node. Ports are
  // CENTRED on the card's right edge (previews) — a single port sits exactly at
  // the vertical middle; multiple ports spread symmetrically around it.
  function portY(node, portId) {
    var ports = portsOf(node);
    var idx = 0;
    for (var i = 0; i < ports.length; i++) { if (ports[i].id === portId) { idx = i; break; } }
    var h = nodeH(node);
    var mid = node.y + h / 2;
    var span = (ports.length - 1) * PORT_SLOT;
    return Math.round(mid - span / 2 + idx * PORT_SLOT);
  }
  function outPort(node, portId) {
    return { x: node.x + nodeW(), y: portY(node, portId || (portsOf(node)[0] || {}).id || 'next') };
  }
  // The input port is a single dot centred on the left edge.
  function inPort(node) {
    return { x: node.x, y: node.y + nodeH(node) / 2 };
  }
  function worldPoint(clientX, clientY) {
    var rect = dom.canvas.getBoundingClientRect();
    var v = state.view;
    return {
      x: (clientX - rect.left - v.x) / v.scale,
      y: (clientY - rect.top - v.y) / v.scale,
    };
  }

  // ---- Rendering ------------------------------------------------------------
  /**
   * Publish the canvas' START gutter (everything before the free canvas area:
   * the app edge, the BLOCKS rail, then the OUTLINE rail) as `--fe-dock-start`
   * on the document element.
   *
   * WHY a custom property and not plain CSS: `docs/uiux/state-empty-canvas.webp`
   * docks the ACTIVITY LOG *inside* the canvas, to the end of both rails — but
   * the drawer is a body-level `position: fixed` singleton (it is shared with
   * the Workspace view), so it cannot see how wide a nested rail happens to be,
   * and the rails have four different widths (240/64/0 palette x 236/26
   * outline). Measuring once per transform and publishing the result is the only
   * honest way to line the two up; the value is DERIVED every time, never
   * stored, and no layout depends on it outside `body.route-fullbleed`.
   */
  function publishDockGutter() {
    if (!dom || !dom.canvas) return;
    var rect = dom.canvas.getBoundingClientRect();
    var cs = getComputedStyle(dom.canvas);
    var olw = parseFloat(cs.getPropertyValue('--fe-ol-w')) || 0;
    // Logical (writing-direction aware) start edge, so RTL docks on the right.
    var rtl = (document.documentElement.getAttribute('dir') || '') === 'rtl';
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var start = rtl ? Math.max(0, vw - rect.right) : Math.max(0, rect.left);
    document.documentElement.style.setProperty('--fe-dock-start', (start + olw) + 'px');
  }

  function applyViewTransform() {
    var v = state.view;
    dom.world.style.transform =
      'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.scale + ')';
    dom.svg.style.transform = dom.world.style.transform;
    // Published for chrome that lives INSIDE the zoomed world but must not zoom
    // with it (item I's group toolbar). Kept here so zooming needs no re-render.
    dom.world.style.setProperty('--fe-inv-scale', String(1 / (v.scale || 1)));
    updateZoomLabel();
    renderMinimap();
  }

  function updateZoomLabel() {
    if (dom && dom.zoomLabel) {
      dom.zoomLabel.textContent = Math.round(state.view.scale * 100) + '%';
    }
  }

  // Compute the bounding box of all nodes in world coordinates.
  function nodesBBox() {
    var ids = Object.keys(state.nodes);
    if (!ids.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(function (id) {
      var n = state.nodes[id];
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + nodeW());
      maxY = Math.max(maxY, n.y + 64);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY,
      w: maxX - minX, h: maxY - minY };
  }

  // Fit all nodes into the visible canvas (with padding).
  /**
   * The OUTLINE panel, the run-info strip and the minimap are absolutely
   * positioned INSIDE `.fe-canvas`, so the visible canvas is smaller than its
   * own box. Fitting to the full box slid the first node underneath the OUTLINE
   * overlay: a seeded render showed the Start card as a "ghost" behind the panel.
   *
   * The insets are measured from live rects rather than hard-coded, so they stay
   * correct when a panel is collapsed, when its width changes in CSS, and under
   * RTL (where the OUTLINE hugs the opposite edge — the geometry decides, not a
   * `dir` branch).
   */
  function canvasInsets(rect) {
    var pad = 60;
    var ins = { top: pad, right: pad, bottom: pad, left: pad };
    if (!dom || !dom.canvas) return ins;
    var overlays = dom.canvas.querySelectorAll('.fe-outline, .fe-runinfo, .fe-minimap-wrap');
    Array.prototype.forEach.call(overlays, function (el) {
      if (el.hidden || !el.offsetWidth || !el.offsetHeight) return;
      var r = el.getBoundingClientRect();
      // An overlay is charged to ONE edge. Picking the nearest edge is wrong for
      // corner overlays: the minimap sits bottom-end and is 460x197, so "nearest"
      // could charge its 460px WIDTH to the end edge and shrink the fit to the
      // 0.4 floor. Charge it instead to the edge that costs the least canvas.
      var GAP = 24;
      var TOUCH = 48;               // how close counts as hugging an edge
      var cand = [];
      if (r.left - rect.left <= TOUCH) cand.push(['left', r.right - rect.left + GAP]);
      if (rect.right - r.right <= TOUCH) cand.push(['right', rect.right - r.left + GAP]);
      if (r.top - rect.top <= TOUCH) cand.push(['top', r.bottom - rect.top + GAP]);
      if (rect.bottom - r.bottom <= TOUCH) cand.push(['bottom', rect.bottom - r.top + GAP]);
      if (!cand.length) return;     // floating in the middle — not an edge dock
      var best = cand[0];
      cand.forEach(function (c) { if (c[1] < best[1]) best = c; });
      ins[best[0]] = Math.max(ins[best[0]], best[1]);
    });
    // The ACTIVITY LOG dock is a body-level `position: fixed` singleton, so the
    // query above cannot see it — yet on the full-bleed route it is drawn ON TOP
    // of the canvas' bottom band, and since G6 it is OPEN by default (46vh).
    // Without charging it, `fitToScreen` parks the tail of a long chain behind
    // the drawer: exactly the ghost-card class of bug that panel-aware fit was
    // introduced to kill. Measured from its live rect, so collapsing it (or the
    // site-wide translate variant, which sits below the fold) costs nothing.
    var dock = document.getElementById('run-panel');
    if (dock && dock.offsetHeight) {
      var dr = dock.getBoundingClientRect();
      var overlap = rect.bottom - dr.top;
      if (overlap > 0 && dr.right > rect.left && dr.left < rect.right) {
        ins.bottom = Math.max(ins.bottom, overlap + 16);
      }
    }
    // Never let the overlays eat the whole canvas (tiny viewports, 980px pass).
    if (ins.left + ins.right > rect.width * 0.7) { ins.left = pad; ins.right = pad; }
    if (ins.top + ins.bottom > rect.height * 0.7) { ins.top = pad; ins.bottom = pad; }
    return ins;
  }

  function fitToScreen() {
    var bb = nodesBBox();
    if (!bb || !dom) return;
    var rect = dom.canvas.getBoundingClientRect();
    var ins = canvasInsets(rect);
    var availW = Math.max(1, rect.width - ins.left - ins.right);
    var availH = Math.max(1, rect.height - ins.top - ins.bottom);
    var sx = availW / Math.max(1, bb.w);
    var sy = availH / Math.max(1, bb.h);
    var scale = Math.min(2, Math.max(0.4, Math.min(sx, sy)));
    state.view.scale = scale;
    state.view.x = ins.left - bb.minX * scale + (availW - bb.w * scale) / 2;
    state.view.y = ins.top - bb.minY * scale + (availH - bb.h * scale) / 2;
    applyViewTransform();
  }

  function zoomBy(factor) {
    if (!dom) return;
    var v = state.view;
    var rect = dom.canvas.getBoundingClientRect();
    var mx = rect.width / 2, my = rect.height / 2;
    var newScale = Math.min(2, Math.max(0.4, v.scale * factor));
    v.x = mx - (mx - v.x) * (newScale / v.scale);
    v.y = my - (my - v.y) * (newScale / v.scale);
    v.scale = newScale;
    applyViewTransform();
  }

  /**
   * Pan (never zoom) so that `nodeId`'s centre lands at the canvas centre.
   * Used by revealNode() so the OUTLINE panel can act as a navigator: clicking a
   * row must bring the node into view without changing the user's zoom level.
   */
  function centerOnNode(nodeId) {
    if (!dom || !state || !state.nodes[nodeId]) return false;
    var n = state.nodes[nodeId];
    var rect = dom.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;   // hidden canvas: nothing to do
    var s = state.view.scale || 1;
    var cx = n.x + nodeW() / 2;            // node centre in world coords
    var cy = n.y + nodeH(n) / 2;
    state.view.x = rect.width / 2 - cx * s;
    state.view.y = rect.height / 2 - cy * s;
    applyViewTransform();
    return true;
  }

  // ---- Minimap --------------------------------------------------------------
  //
  // WHY THIS IS NOT A PLAIN "fit the nodes" BOX.
  //
  // Framing only `nodesBBox()` looks right on a busy graph and absurd on a
  // small one. A fresh workflow holds a single 180x64 node, so the fit resolves
  // to a scale near 0.8: the map renders ONE ~148x52 slab of solid category
  // colour that fills the whole panel, and the viewport rectangle lands outside
  // the visible area. A minimap that cannot show where you are is worse than no
  // minimap, so two corrections are applied together:
  //
  //   1. the framed region is the UNION of the node bbox and the CURRENT
  //      viewport — "you are here" is therefore always inside the picture; and
  //   2. the scale is capped, so the map always reads as a miniature no matter
  //      how few nodes exist.
  //
  // The cap is deliberately loose (a 180px node still becomes ~25px wide, wide
  // enough to see its colour) and in practice only binds when both the graph
  // and the canvas viewport are tiny.
  var MM_MAX_SCALE = 0.14;

  function renderMinimap() {
    if (!dom || !dom.minimap) return;
    // Every caller of `renderMinimap` is exactly a "the canvas box may have
    // changed" moment (transform, palette collapse, focus mode), which is also
    // when the docked ACTIVITY LOG has to be re-measured. One hook, so the two
    // cannot drift apart.
    publishDockGutter();
    var mm = dom.minimap;
    var W = mm.clientWidth || 160, H = mm.clientHeight || 110;
    var bb = nodesBBox();
    // clear
    while (mm.firstChild) mm.removeChild(mm.firstChild);
    if (!bb) return;
    var pad = 12;
    // The visible canvas expressed in world coordinates.
    var rect = dom.canvas.getBoundingClientRect();
    var v = state.view;
    var vs = v.scale || 1;
    var vw = (rect.width || 1) / vs, vh = (rect.height || 1) / vs;
    var vx = (-v.x) / vs, vy = (-v.y) / vs;
    // frame = union(nodes, viewport)
    var fx = Math.min(bb.minX, vx), fy = Math.min(bb.minY, vy);
    var fw = Math.max(1, Math.max(bb.maxX, vx + vw) - fx);
    var fh = Math.max(1, Math.max(bb.maxY, vy + vh) - fy);
    var scale = Math.min((W - pad) / fw, (H - pad) / fh, MM_MAX_SCALE);
    var offX = (W - fw * scale) / 2;
    var offY = (H - fh * scale) / 2;
    function mapX(x) { return offX + (x - fx) * scale; }
    function mapY(y) { return offY + (y - fy) * scale; }

    Object.keys(state.nodes).forEach(function (id) {
      var n = state.nodes[id];
      var dot = document.createElement('div');
      dot.className = 'mm-node';
      var cat = n.action === '__start__' ? { color: '#34d399' } : categoryOf(n.action);
      dot.style.left = mapX(n.x) + 'px';
      dot.style.top = mapY(n.y) + 'px';
      dot.style.width = Math.max(4, nodeW() * scale) + 'px';
      dot.style.height = Math.max(3, 40 * scale) + 'px';
      dot.style.background = cat.color;
      mm.appendChild(dot);
    });

    // viewport rectangle — same world-space box the frame was built from, so it
    // can never be clipped away by the fit.
    var vp = document.createElement('div');
    vp.className = 'mm-viewport';
    vp.style.left = mapX(vx) + 'px';
    vp.style.top = mapY(vy) + 'px';
    vp.style.width = (vw * scale) + 'px';
    vp.style.height = (vh * scale) + 'px';
    mm.appendChild(vp);
  }

  // The previews describe connectors as smooth curves that "intentionally avoid
  // sharp angles": a symmetric cubic bezier whose control points are pulled
  // horizontally, so the wire leaves and enters both ports perfectly level.
  function curvePath(x1, y1, x2, y2) {
    var dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return 'M ' + x1 + ' ' + y1 +
      ' C ' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 +
      ' ' + x2 + ' ' + y2;
  }

  // Branch ports whose edges carry a mid-wire label pill in the previews
  // (`True` green, `False` red). Other ports stay unlabelled so the canvas
  // does not turn into a wall of chips.
  var EDGE_PILL_PORTS = {
    then: { i18n: 'pill.true', tone: 'true' },
    else: { i18n: 'pill.false', tone: 'false' },
    body: { i18n: 'pill.body', tone: 'true' },
    done: { i18n: 'pill.done', tone: 'neutral' },
    catch: { i18n: 'pill.catch', tone: 'false' },
  };

  // Midpoint of the cubic above (t = 0.5) — where the pill is anchored.
  function curveMidpoint(x1, y1, x2, y2) {
    var dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    var c1x = x1 + dx, c2x = x2 - dx;
    // B(0.5) = (P0 + 3*C1 + 3*C2 + P1) / 8
    return {
      x: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
      y: (y1 + 3 * y1 + 3 * y2 + y2) / 8,
    };
  }

  function renderEdges() {
    var svgns = 'http://www.w3.org/2000/svg';
    while (dom.svg.firstChild) dom.svg.removeChild(dom.svg.firstChild);
    clearEdgePills();
    state.edges.forEach(function (e, idx) {
      var from = state.nodes[e.from];
      var to = state.nodes[e.to];
      if (!from || !to) return;
      var port = e.port || 'next';
      var p1 = outPort(from, port);
      var p2 = inPort(to);
      var path = document.createElementNS(svgns, 'path');
      path.setAttribute('d', curvePath(p1.x, p1.y, p2.x, p2.y));
      // Step 24: colour-code branch edges (then=green, else/catch=red, etc.).
      path.setAttribute('class', 'flow-edge edge-' + port.replace(/[^a-z0-9]+/gi, '-'));
      path.setAttribute('data-edge', String(idx));
      // click an edge to delete it
      path.addEventListener('click', function (ev) {
        ev.stopPropagation();
        pushHistory();
        state.edges.splice(idx, 1);
        renderAll();
      });
      dom.svg.appendChild(path);

      // Mid-wire branch pill (`True` / `False`) — an HTML chip in the world
      // layer so it inherits the canvas transform and stays crisp at any zoom.
      var pill = EDGE_PILL_PORTS[port];
      if (pill) {
        var mid = curveMidpoint(p1.x, p1.y, p2.x, p2.y);
        var chip = document.createElement('span');
        chip.className = 'fe-edge-pill tone-' + pill.tone;
        chip.textContent = t(pill.i18n);
        chip.style.left = mid.x + 'px';
        chip.style.top = mid.y + 'px';
        dom.world.appendChild(chip);
      }
    });
    // pending connection preview
    if (drag && drag.type === 'connect' && drag.preview) {
      var pp = document.createElementNS(svgns, 'path');
      pp.setAttribute('d', curvePath(drag.startX, drag.startY, drag.preview.x, drag.preview.y));
      pp.setAttribute('class', 'flow-edge pending');
      dom.svg.appendChild(pp);
    }
  }

  function clearEdgePills() {
    if (!dom || !dom.world) return;
    var old = dom.world.querySelectorAll('.fe-edge-pill');
    Array.prototype.forEach.call(old, function (p) {
      if (p.parentNode === dom.world) dom.world.removeChild(p);
    });
  }

  function nodeTitle(node) {
    if (node.action === '__start__') return t('fe.startNode');
    // `Rename` (context menu item J) stores a user label on the node. It wins
    // over every derived name, and because it lives on the node it travels
    // through serialize()/saveLocal() and the undo stack like any other field.
    if (node.label) return String(node.label);
    // Designed nodes read with their human name on the card too, so the canvas
    // and the NDV header agree (previews show "Click Element" / "Condition").
    var key = NODE_DISPLAY_NAMES && NODE_DISPLAY_NAMES[node.action];
    if (key) return t(key);
    // action ids are not translated (same convention as the linear run builder)
    return node.action;
  }

  // Second line of a node card. The shell previews show a short, human summary
  // rather than a raw param dump — for if/while the Condition Builder model can
  // render its groups as one readable statement (NdvModel.conditionSummary).
  function nodeCardSummary(node, act) {
    if (node.action === 'if' || node.action === 'while') {
      if (window.NdvModel && window.NdvModel.conditionSummary) {
        var s = window.NdvModel.conditionSummary(node.params || {}, t);
        if (s) return s;
      }
    }
    var bits = [];
    if (act) act.fields.forEach(function (f) {
      if (f.internal) return;          // never surface raw JSON blobs on a card
      var v = node.params[f.k];
      if (v) bits.push(String(v));
    });
    return bits.length ? bits.join(' · ').slice(0, 60) : t('fe.noParams');
  }

  function renderNode(node) {
    var isStart = node.action === '__start__';
    var status = nodeStatus[node.id] || 'idle';
    var selected = state.selected === node.id || (state.selSet && state.selSet[node.id]);
    var card = document.createElement('div');
    card.className = 'flow-node' + (isStart ? ' is-start' : '') +
      (selected ? ' selected' : '') + ' status-' + status +
      (node.disabled === true ? ' is-off' : '');
    card.setAttribute('data-node', node.id);
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';
    card.style.width = nodeW() + 'px';

    var act = actionById(node.action);
    // Inline SVG (window.Icons) — emoji glyphs rendered as empty boxes wherever
    // the platform font stack lacks emoji coverage, and could not be tinted.
    var icon = ICON(isStart ? '__start__' : node.action);

    // Category accent bar (left) — colour-codes the node by category.
    var cat = isStart ? { color: '#34d399' } : categoryOf(node.action);
    // `Change Color` (context menu item J) overrides the CATEGORY accent for
    // this one node. Only values from NODE_COLORS are ever stored, so a graph
    // loaded from disk cannot inject an arbitrary CSS value here.
    card.style.setProperty('--cat-color',
      node.color && isNodeColor(node.color) ? node.color : cat.color);

    var header = document.createElement('div');
    header.className = 'flow-node-head';
    header.innerHTML = '<span class="fn-icon">' + icon + '</span>' +
      '<span class="fn-title">' + esc(nodeTitle(node)) + '</span>' +
      '<span class="fn-status" aria-hidden="true"></span>';
    card.appendChild(header);

    // Step 26: per-node run badge (✓ items + time / ✕ reason) + tooltip, and a
    // pin indicator. Driven by the last run's meta (nodeMeta) / pins (nodePins).
    if (!isStart) {
      var meta = nodeMeta[node.id];
      if (meta && (meta.status === 'success' || meta.status === 'error')) {
        var badge = document.createElement('div');
        var ok = meta.status === 'success';
        badge.className = 'fn-badge ' + (ok ? 'ok' : 'bad');
        var parts = [];
        if (ok) {
          parts.push(IC('check', 11));
          if (meta.outputItemCount != null) parts.push(meta.outputItemCount + ' ' + t('rp.items'));
          if (meta.durationMs != null) parts.push(meta.durationMs + 'ms');
        } else {
          parts.push(IC('x', 11));
          if (meta.error) parts.push(String(meta.error).slice(0, 24));
        }
        badge.innerHTML = parts.join(' ');
        var tip = ok
          ? (t('rp.done') + ' · ' + (meta.outputItemCount != null ? meta.outputItemCount + ' ' + t('rp.items') : '') +
             (meta.durationMs != null ? ' · ' + meta.durationMs + 'ms' : ''))
          : (t('rp.error') + (meta.error ? ' — ' + meta.error : ''));
        badge.title = tip;
        card.appendChild(badge);
      }
      if (nodePins[node.id]) {
        var pinmark = document.createElement('div');
        pinmark.className = 'fn-pin';
        pinmark.innerHTML = IC('pin', 11);
        pinmark.title = t('rp.pinned');
        card.appendChild(pinmark);
      }
      // `Disable` must be visible on the CANVAS, not only in a menu — a node
      // that is silently skipped at run time is a debugging trap.
      if (node.disabled === true) {
        var off = document.createElement('div');
        off.className = 'fn-off';
        off.innerHTML = IC('eye-off', 11) + '<span>' + esc(t('fe.offBadge')) + '</span>';
        off.title = t('fe.nodeDisabled');
        card.appendChild(off);
      }
      // `Add Comment` — the note is a first-class annotation, so it renders on
      // the card (truncated) with the full text as its tooltip.
      if (node.note) {
        var note = document.createElement('div');
        note.className = 'fn-note';
        note.innerHTML = IC('message-square', 11) +
          '<span>' + esc(String(node.note).slice(0, 60)) + '</span>';
        note.title = String(node.note);
        card.appendChild(note);
      }
    }

    // Second line: human summary (Condition Builder statement for if/while).
    if (node.action !== '__start__') {
      var sum = document.createElement('div');
      sum.className = 'flow-node-sub';
      sum.textContent = nodeCardSummary(node, act);
      sum.title = sum.textContent;
      card.appendChild(sum);

      // The previews put a `⋮` kebab in the card's top-right corner (not a bare
      // ×). It opens the same context menu as right-click; the destructive
      // delete stays inside that menu instead of one mis-click away.
      var kebab = document.createElement('button');
      kebab.className = 'flow-node-kebab';
      kebab.title = t('fe.nodeMenu');
      kebab.innerHTML = IC('more-vertical', 14);
      kebab.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var r = kebab.getBoundingClientRect();
        openNodeMenu(node.id, r.left, r.bottom + 4);
      });
      card.appendChild(kebab);

      // input port (left, vertically centred on the card edge)
      var pin = document.createElement('div');
      pin.className = 'flow-port in';
      pin.setAttribute('data-port', 'in');
      pin.style.top = (nodeH(node) / 2 - PORT_R) + 'px';
      card.appendChild(pin);
    }

    // Step 24: one output port per branch (start + linear nodes have a single
    // 'next'; if/switch/loop/foreach/while/try expose multiple labelled ports).
    card.style.minHeight = nodeH(node) + 'px';
    var ports = portsOf(node);
    var branching = ports.length > 1;
    if (branching) card.classList.add('is-branching');
    ports.forEach(function (p) {
      var po = document.createElement('div');
      po.className = 'flow-port out port-' + p.id.replace(/[^a-z0-9]+/gi, '-');
      po.setAttribute('data-port', p.id);
      // portY() returns an absolute world Y already centred on the card edge;
      // subtract the port radius so the DOT (not its box) lands on that line.
      po.style.top = (portY(node, p.id) - node.y - PORT_R) + 'px';
      card.appendChild(po);
      if (branching) {
        var lbl = document.createElement('span');
        lbl.className = 'flow-port-label port-' + p.id.replace(/[^a-z0-9]+/gi, '-');
        // case:<v> labels show the raw case value
        lbl.textContent = p.id.indexOf('case:') === 0 ? p.id.slice(5) : t(p.label);
        lbl.style.top = (portY(node, p.id) - node.y - 9) + 'px';
        card.appendChild(lbl);
      }
      // A FREE output port gets the circled `+` chip on a short connector stub —
      // visible in six of the eight locked images (e.g. right of "Click Element
      // #next-button" in shell-editor-click-ndv.webp). It is the fifth Add Node
      // entry point and the only one that pre-wires a SPECIFIC branch port, so
      // `else` / `catch` / `case:` can be extended without a drag.
      //
      // Only free ports get one: dropping a node on a port that is already
      // connected would silently replace that connection, which is not what
      // "add a node" means (same rule as openAddPaletteForSelection).
      var portTaken = state.edges.some(function (e) {
        return e.from === node.id && (e.port || 'next') === p.id;
      });
      if (!portTaken) {
        var add = document.createElement('button');
        add.type = 'button';
        add.className = 'flow-port-add port-' + p.id.replace(/[^a-z0-9]+/gi, '-');
        add.setAttribute('data-port', p.id);
        add.title = t('fe.addFromPort');
        add.setAttribute('aria-label', t('fe.addFromPort'));
        add.innerHTML = IC('plus', 11);
        add.style.top = (portY(node, p.id) - node.y - PORT_ADD_R) + 'px';
        // The card's own mousedown starts a node drag; the chip must not.
        add.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        add.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openAddPalette({
            world: slotAfter(node.id),
            from: { nodeId: node.id, port: p.id },
            at: { x: ev.clientX, y: ev.clientY },
          });
        });
        card.appendChild(add);
      }

      // connection drag — start on THIS output port (carries its port id)
      po.addEventListener('mousedown', function (ev) {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        var op = outPort(node, p.id);
        drag = { type: 'connect', from: node.id, fromPort: p.id,
          startX: op.x, startY: op.y, preview: { x: op.x, y: op.y } };
        renderEdges();
      });
    });

    // node drag (move) — start on header. Shift/Ctrl adds to multi-selection.
    header.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      var additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      if (additive && !isStart) {
        state.selSet[node.id] = !state.selSet[node.id];
        state.selected = node.id;
        renderNodes();
        renderInspector();
        return;
      }
      // If this node is part of an existing multi-selection, drag the whole set.
      if (!state.selSet[node.id]) { state.selSet = {}; }
      selectNode(node.id);
      // Canvas lock (toolbar item G) freezes geometry only — selecting a node,
      // opening its NDV and editing params all stay available.
      if (canvasLocked) return;
      var wp = worldPoint(ev.clientX, ev.clientY);
      // capture per-node offsets for group move
      var group = activeSelection();
      drag = { type: 'move', nodeId: node.id, sx: wp.x, sy: wp.y,
        // Undo point for the move, captured BEFORE the first pixel travels but
        // only COMMITTED once the pointer actually moves (see mousemove). A
        // mousedown that never becomes a drag must not cost an undo press.
        snapshot: serialize(), snapshotPushed: false,
        origins: group.map(function (nid) {
          var nn = state.nodes[nid];
          return { id: nid, x: nn.x, y: nn.y };
        }) };
    });

    card.addEventListener('click', function (ev) {
      ev.stopPropagation();
      selectNode(node.id);
    });

    // Aria spec: double-click a node card to open its NDV modal.
    card.addEventListener('dblclick', function (ev) {
      ev.stopPropagation();
      if (!isStart) openNdv(node.id);
    });

    // shell-add-node-palette.md §: right-click a node -> floating context menu.
    card.addEventListener('contextmenu', function (ev) {
      if (isStart) return;
      ev.preventDefault();
      ev.stopPropagation();
      selectNode(node.id);
      openNodeMenu(node.id, ev.clientX, ev.clientY);
    });

    dom.world.appendChild(card);
  }

  // ---- node context menu (kebab / right-click) — item J ---------------------
  //
  // The locked inventory (docs/uiux/shell-add-node-palette.md § "Floating
  // context menu") is NINE rows: Clone · Delete · Rename · Disable ·
  // Change Color (with colour dots) · Add Comment · Add to Favorites ·
  // Convert to Subflow · Advanced ▸.
  //
  // All nine are rendered, and every one of them is BACKED:
  //   Clone            -> copySelection()+pasteClipboard() (annotations included)
  //   Delete           -> removeNode()
  //   Rename           -> node.label, shown by nodeTitle() on card + OUTLINE
  //   Disable          -> node.disabled, SKIPPED by graph-serialize#walkChain
  //   Change Color     -> node.color, a swatch row of the 6 design tokens
  //   Add Comment      -> node.note, rendered on the card with a tooltip
  //   Add to Favorites -> the SAME `paletteFavs` store the palette star writes
  //   Convert Subflow  -> nothing implements subflows, so it renders DISABLED
  //                       with a tooltip that says so (menuItem-style honesty)
  //   Advanced ▸       -> submenu: Open settings · Pin/Unpin output · Copy JSON
  //
  // "Convert to Subflow" is the only inert row and it LOOKS inert. A row that
  // silently does nothing would be worse than no row at all.
  function closeNodeMenu() {
    var ex = document.querySelector('.fe-ctxmenu');
    while (ex) {
      if (ex.parentNode) ex.parentNode.removeChild(ex);
      ex = document.querySelector('.fe-ctxmenu');
    }
  }

  /** One clickable row of a context menu (or a disabled, explained row). */
  function ctxItem(it, onDone) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'fe-ctxitem' + (it.danger ? ' is-danger' : '') +
      (it.disabled ? ' is-disabled' : '') + (it.submenu ? ' has-sub' : '');
    b.setAttribute('role', 'menuitem');
    if (it.disabled) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      if (it.hint) b.title = it.hint;
    }
    b.innerHTML = '<span class="fe-ctxicon">' + IC(it.icon) + '</span>' +
      '<span class="fe-ctxlabel">' + esc(it.label) + '</span>' +
      (it.kbd ? '<span class="fe-ctxkbd">' + esc(it.kbd) + '</span>' : '') +
      (it.submenu ? '<span class="fe-ctxsub">' + IC('chevron-right', 12) + '</span>' : '');
    if (!it.disabled && !it.submenu) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeNodeMenu();
        it.fn();
      });
    }
    if (it.submenu) {
      var open = function (ev) {
        ev.stopPropagation();
        var r = b.getBoundingClientRect();
        // The submenu is a sibling menu, not a nested one: same close path, and
        // no chance of a menu that survives its parent.
        var sub = document.createElement('div');
        sub.className = 'fe-ctxmenu is-sub';
        sub.setAttribute('role', 'menu');
        it.submenu().forEach(function (si) { sub.appendChild(ctxItem(si, onDone)); });
        document.body.appendChild(sub);
        var sr = sub.getBoundingClientRect();
        sub.style.left = Math.max(8, Math.min(r.right + 2, window.innerWidth - sr.width - 8)) + 'px';
        sub.style.top = Math.max(8, Math.min(r.top, window.innerHeight - sr.height - 8)) + 'px';
      };
      b.addEventListener('click', open);
      b.addEventListener('mouseenter', function () {
        var ex = document.querySelector('.fe-ctxmenu.is-sub');
        if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
      });
    }
    return b;
  }

  /**
   * The `Change Color` row: six design-token swatches plus a reset chip.
   *
   * `target` is either ONE node id (per-node context menu) or an ARRAY of ids
   * (group toolbar ▸ More). One renderer for both keeps the swatch inventory,
   * the whitelist and the "on" marker from drifting between the two surfaces;
   * a group recolour is applied in a single undo step.
   */
  function ctxColorRow(target) {
    var many = Object.prototype.toString.call(target) === '[object Array]';
    var nodeId = many ? target[0] : target;
    var apply = function (c) {
      if (many) setSelectionColor(target, c); else setNodeColor(nodeId, c);
    };
    // The "on" marker only lights up when the whole target shares that colour.
    var current = many
      ? (target.every(function (id) {
        return state.nodes[id] && state.nodes[id].color === (state.nodes[target[0]] || {}).color;
      }) ? (state.nodes[target[0]] || {}).color : null)
      : (state.nodes[nodeId] || {}).color;
    var node = { color: current };
    var row = document.createElement('div');
    row.className = 'fe-ctxcolors';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', t('fe.changeColor'));
    var head = document.createElement('span');
    head.className = 'fe-ctxcolors-lbl';
    head.innerHTML = IC('palette', 14) + '<span>' + esc(t('fe.changeColor')) + '</span>';
    row.appendChild(head);
    var dots = document.createElement('span');
    dots.className = 'fe-ctxdots';
    NODE_COLORS.forEach(function (c) {
      var d = document.createElement('button');
      d.type = 'button';
      d.className = 'fe-ctxdot' + (node && node.color === c ? ' is-on' : '');
      d.style.background = c;
      d.title = c;
      d.setAttribute('aria-label', c);
      d.setAttribute('aria-pressed', node && node.color === c ? 'true' : 'false');
      d.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeNodeMenu();
        apply(c);
      });
      dots.appendChild(d);
    });
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'fe-ctxdot is-reset';
    reset.title = t('fe.resetColor');
    reset.setAttribute('aria-label', t('fe.resetColor'));
    reset.innerHTML = IC('rotate-ccw', 11);
    reset.addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeNodeMenu();
      apply(null);
    });
    dots.appendChild(reset);
    row.appendChild(dots);
    return row;
  }

  function openNodeMenu(nodeId, clientX, clientY) {
    closeNodeMenu();
    var node = state && state.nodes[nodeId];
    if (!node || node.action === '__start__') return;
    var fav = !!paletteFavs[node.action];

    var menu = document.createElement('div');
    menu.className = 'fe-ctxmenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('fe.nodeMenu'));

    var items = [
      { icon: 'copy', label: t('fe.cloneNode'), kbd: MOD_KEY + '+C', fn: function () {
        state.selSet = {}; state.selSet[nodeId] = true; state.selected = nodeId;
        copySelection(); pasteClipboard();
      } },
      { icon: 'pencil', label: t('fe.renameNode'), fn: function () {
        openInlinePrompt({
          title: t('fe.renameNode'), value: node.label || '',
          placeholder: nodeTitle(node), x: clientX, y: clientY,
          onOk: function (v) { renameNode(nodeId, v); },
        });
      } },
      { icon: node.disabled === true ? 'eye' : 'eye-off',
        label: t(node.disabled === true ? 'fe.enableNode' : 'fe.disableNode'),
        fn: function () { setNodeDisabled(nodeId); } },
      { swatches: true },
      { icon: 'message-square',
        label: t(node.note ? 'fe.editComment' : 'fe.addComment'),
        fn: function () {
          openInlinePrompt({
            title: t('fe.addComment'), value: node.note || '', multiline: true,
            x: clientX, y: clientY,
            onOk: function (v) { setNodeComment(nodeId, v); },
          });
        } },
      { icon: 'star', label: t(fav ? 'fe.unfavNode' : 'fe.favNode'), fn: function () {
        // Favourites are per ACTION (that is what the palette can star), so the
        // row says so in its tooltip rather than implying a per-node favourite.
        if (paletteFavs[node.action]) delete paletteFavs[node.action];
        else paletteFavs[node.action] = true;
        savePaletteFavs();
        if (dom && dom.palette) renderPaletteList();
        if (U() && U().toast) {
          U().toast(t(paletteFavs[node.action] ? 'fe.favAdded' : 'fe.favRemoved'), 'ok');
        }
      } },
      { icon: 'sitemap', label: t('fe.convertSubflow'),
        disabled: true, hint: t('fe.convertSubflowSoon') },
      { sep: true },
      { icon: 'sliders', label: t('fe.advanced'), submenu: function () {
        return [
          { icon: 'sliders', label: t('ndv.open'), fn: function () { openNdv(nodeId); } },
          { icon: 'pin', label: t(nodePins[nodeId] ? 'fe.unpinNode' : 'fe.pinNode'),
            fn: function () {
              if (nodePins[nodeId]) delete nodePins[nodeId]; else nodePins[nodeId] = true;
              renderNodes();
            } },
          { icon: 'braces', label: t('fe.copyNodeJson'),
            fn: function () { copyNodeJson(nodeId); } },
          // Item N: real per-node run. The row is enabled only when the node
          // actually produces a step on the main chain; otherwise it renders
          // disabled with the concrete reason, never a silent no-op.
          (function () {
            var why = runNodeBlockedReason(nodeId);
            return { icon: 'play', label: t('fe.runNode'),
              disabled: !!why, hint: why ? t(why) : t('fe.runNodeHint'),
              fn: function () { runNode(nodeId); } };
          })(),
        ];
      } },
      { sep: true },
      { icon: 'trash', label: t('fe.deleteNode'), kbd: 'Del', danger: true,
        fn: function () { removeNode(nodeId); } },
    ];

    items.forEach(function (it) {
      if (it.sep) {
        var sep = document.createElement('div');
        sep.className = 'fe-ctxsep';
        menu.appendChild(sep);
        return;
      }
      if (it.swatches) { menu.appendChild(ctxColorRow(nodeId)); return; }
      menu.appendChild(ctxItem(it));
    });

    // Position in viewport coords, flipped back inside if it would overflow.
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);
    var r = menu.getBoundingClientRect();
    var x = Math.min(clientX, window.innerWidth - r.width - 8);
    var y = Math.min(clientY, window.innerHeight - r.height - 8);
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';

    // Keyboard: the menu is reachable from the kebab button, so it has to be
    // operable without a mouse. Arrow keys move, Esc closes (handled globally).
    var rows = menu.querySelectorAll('.fe-ctxitem:not(.is-disabled)');
    if (rows.length) rows[0].focus();
    menu.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      var list = Array.prototype.slice.call(menu.querySelectorAll('.fe-ctxitem:not(.is-disabled)'));
      var i = list.indexOf(document.activeElement);
      var next = ev.key === 'ArrowDown' ? i + 1 : i - 1;
      if (next < 0) next = list.length - 1;
      if (next >= list.length) next = 0;
      if (list[next]) list[next].focus();
    });
  }

  function renderNodes() {
    // wipe existing node cards (keep svg + world container)
    var cards = dom.world.querySelectorAll('.flow-node');
    Array.prototype.forEach.call(cards, function (c) {
      if (c.parentNode === dom.world) dom.world.removeChild(c);
    });
    Object.keys(state.nodes).forEach(function (id) { renderNode(state.nodes[id]); });
    renderEmptyState();
    // Item I: the group boundary + toolbar are a function of the selection, so
    // they are rebuilt by the same pass that paints selection state on cards —
    // there is no second code path that could leave them stale.
    renderSelectionTools();
  }

  // Aria spec (state-empty-canvas.md): centered card with an orange icon
  // circle + "Add First Node" CTA when the canvas only holds the start node.
  function renderEmptyState() {
    if (!dom || !dom.canvas) return;
    var ex = dom.canvas.querySelector('.fe-empty-card');
    if (Object.keys(state.nodes).length > 1) {
      if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
      return;
    }
    if (ex) return;
    var card = document.createElement('div');
    card.className = 'fe-empty-card';
    card.innerHTML =
      '<div class="fe-empty-icon">' + IC('zap', 28) + '</div>' +
      '<div class="fe-empty-title">' + esc(t('fe.emptyTitle')) + '</div>' +
      '<div class="fe-empty-sub">' + esc(t('fe.emptySub')) + '</div>';
    var cta = document.createElement('button');
    cta.className = 'fe-empty-cta';
    cta.textContent = '+ ' + t('fe.addFirstNode');
    cta.addEventListener('click', function (ev) {
      ev.stopPropagation();
      // Item H: the CTA now opens the floating Add Node palette wired to Start,
      // instead of merely moving focus into the docked palette's search box and
      // leaving the user to figure out the rest.
      var r = cta.getBoundingClientRect();
      openAddPaletteForSelection({ x: r.left, y: r.bottom + 8 });
    });
    card.appendChild(cta);
    card.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    dom.canvas.appendChild(card);
  }

  // Step 24: append a small validation summary (errors/warnings) to a box.
  function appendValidation(box) {
    var res = validate();
    var wrap = document.createElement('div');
    wrap.className = 'fe-validation';
    var items = (res.errors || []).map(function (e) { return { kind: 'error', it: e }; })
      .concat((res.warnings || []).map(function (w) { return { kind: 'warn', it: w }; }));
    if (!items.length) {
      wrap.innerHTML = '<span class="v-ok">' + IC('check', 13) + ' ' + esc(t('val.ok')) + '</span>';
      box.appendChild(wrap);
      return;
    }
    items.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'v-item v-' + entry.kind;
      var name = entry.it.nodeId && state.nodes[entry.it.nodeId]
        ? (state.nodes[entry.it.nodeId].action + ': ') : '';
      row.innerHTML = '<span class="v-dot">' +
        IC(entry.kind === 'error' ? 'x-circle' : 'alert-circle', 13) + '</span>' +
        '<span>' + esc(name + t(entry.it.message)) + '</span>';
      wrap.appendChild(row);
    });
    box.appendChild(wrap);
  }

  // ---- Step 25: NDV (Node Detail View) — three-column INPUT | Parameters |
  // OUTPUT, rich field types, Fixed/Expression toggle, drag&drop-to-expression.
  function fieldTypeOf(f) {
    return (CAT && CAT.fieldType)
      ? CAT.fieldType(f)
      : { type: (f.type === 'text' ? 'string' : f.type === 'select' ? 'options' : (f.type || 'string')), input: 'text', expressionable: false };
  }

  // The items feeding a node's INPUT column = the OUTPUT of the node connected
  // to its (first) incoming edge. Falls back to {} so drag tokens still work.
  function inputItemsFor(nodeId) {
    var r = nodeResults[nodeId];
    if (r && Array.isArray(r.input)) return r.input;
    // derive from the predecessor's stored output, if any
    for (var i = 0; i < state.edges.length; i++) {
      if (state.edges[i].to === nodeId) {
        var from = nodeResults[state.edges[i].from];
        if (from && Array.isArray(from.output)) return from.output;
      }
    }
    return [];
  }
  function outputItemsFor(nodeId) {
    var r = nodeResults[nodeId];
    return (r && Array.isArray(r.output)) ? r.output : [];
  }

  // Flatten an item's JSON into dot-paths (for INPUT drag tokens). Depth-limited.
  function jsonPaths(obj, base, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 3 || obj == null || typeof obj !== 'object') return out;
    var keys = Object.keys(obj).slice(0, 40);
    keys.forEach(function (k) {
      var path = base ? base + '.' + k : k;
      var v = obj[k];
      out.push({ path: path, value: v });
      if (v && typeof v === 'object' && !Array.isArray(v)) jsonPaths(v, path, out, depth + 1);
    });
    return out;
  }

  function renderInputColumn(col, nodeId) {
    col.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'ndv-col-head';
    head.textContent = t('ndv.input');
    col.appendChild(head);
    var items = inputItemsFor(nodeId);
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'muted small ndv-empty';
      empty.textContent = t('ndv.noInput');
      col.appendChild(empty);
      return;
    }
    var sample = items[0] && items[0].json ? items[0].json : items[0];
    var paths = jsonPaths(sample, '$json', [], 0);
    var list = document.createElement('div');
    list.className = 'ndv-fields';
    paths.forEach(function (p) {
      var pill = document.createElement('div');
      pill.className = 'ndv-pill';
      pill.setAttribute('draggable', 'true');
      pill.dataset.expr = '{{ ' + p.path + ' }}';
      var preview = (p.value != null && typeof p.value !== 'object') ? String(p.value) : '';
      pill.innerHTML = '<span class="ndv-pill-key">' + esc(p.path) + '</span>' +
        (preview ? '<span class="ndv-pill-val">' + esc(preview.slice(0, 24)) + '</span>' : '');
      pill.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.setData('text/x-expr', pill.dataset.expr);
        ev.dataTransfer.setData('text/plain', pill.dataset.expr);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      list.appendChild(pill);
    });
    col.appendChild(list);
  }

  function renderOutputColumn(col, nodeId) {
    col.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'ndv-col-head';
    head.textContent = t('ndv.output');
    col.appendChild(head);
    var items = outputItemsFor(nodeId);
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'muted small ndv-empty';
      empty.textContent = t('ndv.noOutput');
      col.appendChild(empty);
      return;
    }
    var pre = document.createElement('pre');
    pre.className = 'ndv-json';
    try { pre.textContent = JSON.stringify(items, null, 2).slice(0, 4000); }
    catch (e) { pre.textContent = String(items); }
    col.appendChild(pre);
  }

  // Build one parameter control row (rich type + Fixed/Expression toggle).
  function buildFieldRow(node, f) {
    var ft = fieldTypeOf(f);
    var row = document.createElement('div');
    row.className = 'form-row ndv-row';

    var labelWrap = document.createElement('div');
    labelWrap.className = 'ndv-label-wrap';
    var label = document.createElement('label');
    label.textContent = t(f.label);
    labelWrap.appendChild(label);

    // expression-mode state lives on the node (params + an _expr flag map)
    node._expr = node._expr || {};
    var current = node.params[f.k];
    var isExprVal = window.ExpressionEngine
      ? window.ExpressionEngine.isExpression(current) : /\{\{[\s\S]*?\}\}/.test(String(current || ''));
    var exprMode = ft.expressionable && (node._expr[f.k] === true || isExprVal);

    var toggle = null;
    if (ft.expressionable) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ndv-expr-toggle' + (exprMode ? ' on' : '');
      toggle.textContent = exprMode ? t('expr.expression') : t('expr.fixed');
      toggle.title = t('expr.toggleHint');
      labelWrap.appendChild(toggle);
    }
    row.appendChild(labelWrap);

    function commit(v) {
      // One undo point per DISTINCT value: typing fires `input` per keystroke,
      // and pushHistory() collapses identical consecutive snapshots, so a burst
      // of keystrokes still leaves a usable (not per-character) undo stack.
      if (node.params[f.k] !== v) pushHistory();
      node.params[f.k] = v;
      renderNodes();
      renderFieldFeedback();
      emitChange();   // the OUTLINE row summary can depend on a param
    }

    var input;
    function buildControl() {
      if (input && input.parentNode) input.parentNode.removeChild(input);
      if (exprMode) {
        input = document.createElement('textarea');
        input.className = 'field ndv-field ndv-expr-input';
        input.rows = 2;
        input.placeholder = '{{ $json.field }}';
        input.value = node.params[f.k] != null ? String(node.params[f.k]) : '';
        // drag&drop a token from the INPUT column
        input.addEventListener('dragover', function (ev) { ev.preventDefault(); input.classList.add('drag-over'); });
        input.addEventListener('dragleave', function () { input.classList.remove('drag-over'); });
        input.addEventListener('drop', function (ev) {
          ev.preventDefault(); input.classList.remove('drag-over');
          var tok = ev.dataTransfer.getData('text/x-expr') || ev.dataTransfer.getData('text/plain');
          if (!tok) return;
          var pos = input.selectionStart != null ? input.selectionStart : input.value.length;
          input.value = input.value.slice(0, pos) + tok + input.value.slice(pos);
          commit(input.value);
        });
        input.addEventListener('input', function () { commit(input.value); });
      } else if (ft.input === 'select') {
        input = document.createElement('select');
        input.className = 'field ndv-field';
        (f.options || []).forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt; o.textContent = opt === '' ? '—' : opt;
          input.appendChild(o);
        });
        input.value = node.params[f.k] != null ? node.params[f.k] : (f.options ? f.options[0] : '');
        input.addEventListener('change', function () { commit(input.value); });
      } else if (ft.input === 'toggle') {
        input = document.createElement('label');
        input.className = 'ndv-toggle';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = node.params[f.k] === true || node.params[f.k] === 'true';
        var slide = document.createElement('span'); slide.className = 'ndv-toggle-slide';
        input.appendChild(cb); input.appendChild(slide);
        cb.addEventListener('change', function () { commit(cb.checked); });
      } else if (ft.input === 'textarea' || ft.input === 'json' || ft.input === 'code') {
        input = document.createElement('textarea');
        input.className = 'field ndv-field' + (ft.input === 'code' ? ' ndv-code' : ft.input === 'json' ? ' ndv-jsonin' : '');
        input.rows = ft.input === 'textarea' ? 2 : 4;
        input.placeholder = f.ph || '';
        input.value = node.params[f.k] != null ? String(node.params[f.k]) : '';
        input.addEventListener('input', function () { commit(input.value); });
      } else {
        input = document.createElement('input');
        input.className = 'field ndv-field';
        input.type = ft.input === 'number' ? 'number'
          : ft.input === 'password' ? 'password'
          : ft.input === 'datetime' ? 'datetime-local' : 'text';
        if (ft.input === 'number') {
          if (typeof f.min === 'number') input.min = String(f.min);
          if (typeof f.max === 'number') input.max = String(f.max);
        }
        input.placeholder = f.ph || '';
        input.value = node.params[f.k] != null ? String(node.params[f.k]) : '';
        input.addEventListener('input', function () {
          var v = input.value;
          if (ft.input === 'number' && v !== '') v = Number(v);
          commit(v);
        });
      }
      row.appendChild(input);
    }
    buildControl();

    if (toggle) {
      toggle.addEventListener('click', function () {
        exprMode = !exprMode;
        node._expr[f.k] = exprMode;
        toggle.textContent = exprMode ? t('expr.expression') : t('expr.fixed');
        toggle.classList.toggle('on', exprMode);
        buildControl();
        renderFieldFeedback();
      });
    }

    // help + inline expression preview/validation
    var feedback = document.createElement('div');
    feedback.className = 'ndv-feedback';
    if (f.help) {
      var help = document.createElement('div');
      help.className = 'ndv-help';
      help.textContent = t(f.help);
      feedback.appendChild(help);
    }
    var prev = document.createElement('div');
    prev.className = 'ndv-preview';
    prev.dataset.fk = f.k;
    feedback.appendChild(prev);
    row.appendChild(feedback);
    row._field = f;
    return row;
  }

  // Re-evaluate every expression field's preview against the node's INPUT
  // sample, marking errors inline (never throws — uses mapParams semantics).
  function renderFieldFeedback() {
    var root = ndvRoot();
    if (!root) return;
    var node = ndvOpen ? state.nodes[ndvOpen] : null;
    if (!node) return;
    var sample = inputItemsFor(node.id);
    var ctx = { json: (sample[0] && sample[0].json) ? sample[0].json : (sample[0] || {}), index: 0 };
    var previews = root.querySelectorAll('.ndv-preview');
    Array.prototype.forEach.call(previews, function (el) {
      var fk = el.dataset.fk;
      var raw = node.params[fk];
      el.className = 'ndv-preview';
      el.textContent = '';
      if (!window.ExpressionEngine || !window.ExpressionEngine.isExpression(raw)) return;
      try {
        var v = window.ExpressionEngine.evaluateTemplate(raw, ctx);
        el.classList.add('ok');
        el.textContent = '= ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 80);
      } catch (e) {
        el.classList.add('err');
        el.textContent = '! ' + (e && e.message ? e.message : t('expr.invalid'));
      }
    });
  }

  // Step 27: collapsible "Settings" block for a node's error-handling policy.
  // Stored on node.errorPolicy and serialized as top-level AutomationStep fields
  // (continueOnFail / retryOnFail / maxTries / waitBetweenTriesMs).
  function buildErrorSettings(node) {
    node.errorPolicy = node.errorPolicy || {};
    var ep = node.errorPolicy;
    var wrap = document.createElement('div');
    wrap.className = 'ndv-settings';

    var head = document.createElement('div');
    head.className = 'ndv-col-head ndv-settings-head';
    head.textContent = t('settings.errorHandling');
    wrap.appendChild(head);

    function toggleRow(key, labelKey, helpKey, onChange) {
      var row = document.createElement('div');
      row.className = 'form-row ndv-row';
      var lw = document.createElement('div');
      lw.className = 'ndv-label-wrap';
      var lab = document.createElement('label');
      lab.textContent = t(labelKey);
      lw.appendChild(lab);
      var tog = document.createElement('label');
      tog.className = 'ndv-toggle';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ep[key] === true;
      var slide = document.createElement('span');
      slide.className = 'ndv-toggle-slide';
      tog.appendChild(cb); tog.appendChild(slide);
      lw.appendChild(tog);
      row.appendChild(lw);
      if (helpKey) {
        var help = document.createElement('div');
        help.className = 'ndv-help';
        help.textContent = t(helpKey);
        row.appendChild(help);
      }
      cb.addEventListener('change', function () {
        ep[key] = cb.checked;
        if (onChange) onChange();
        renderNodes();
      });
      return row;
    }

    function numRow(key, labelKey, ph, min) {
      var row = document.createElement('div');
      row.className = 'form-row ndv-row';
      var lw = document.createElement('div');
      lw.className = 'ndv-label-wrap';
      var lab = document.createElement('label');
      lab.textContent = t(labelKey);
      lw.appendChild(lab);
      row.appendChild(lw);
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'field ndv-field';
      if (typeof min === 'number') inp.min = String(min);
      inp.placeholder = ph || '';
      inp.value = ep[key] != null ? String(ep[key]) : '';
      inp.addEventListener('input', function () {
        var v = inp.value === '' ? undefined : Number(inp.value);
        ep[key] = v;
      });
      row.appendChild(inp);
      return row;
    }

    wrap.appendChild(toggleRow('continueOnFail', 'settings.continueOnFail', 'help.continueOnFail'));

    var retrySub = document.createElement('div');
    retrySub.className = 'ndv-settings-sub';
    function syncRetrySub() { retrySub.style.display = ep.retryOnFail === true ? '' : 'none'; }
    wrap.appendChild(toggleRow('retryOnFail', 'settings.retryOnFail', 'help.retryOnFail', syncRetrySub));
    retrySub.appendChild(numRow('maxTries', 'settings.maxTries', '3', 1));
    retrySub.appendChild(numRow('waitBetweenTriesMs', 'settings.waitBetweenTries', '1000', 0));
    wrap.appendChild(retrySub);
    syncRetrySub();

    return wrap;
  }

  // ---- Aria NDV modal: the Node Detail View opens as a centered modal over
  // the canvas (spec: ndv-*-final.md) instead of the legacy side panel.
  var ndvOpen = null; // nodeId whose NDV modal is open, or null

  function ndvRoot() {
    var b = document.querySelector('.ndv-backdrop .ndv-body');
    return b || (dom && dom.inspector) || null;
  }

  function closeNdv() {
    ndvOpen = null;
    var b = document.querySelector('.ndv-backdrop');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function openNdv(id) {
    if (!state || !state.nodes[id] || state.nodes[id].action === '__start__') return;
    ndvOpen = id;
    renderInspector();
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && ndvOpen) closeNdv();
  });

  function statusBadgeLabel(s) {
    if (s === 'running') return t('ndv.statusRunning');
    if (s === 'success') return t('ndv.statusSuccess');
    if (s === 'error') return t('ndv.statusError');
    return t('ndv.statusIdle');
  }

  // ---- NDV header subtitle -------------------------------------------------
  // The designs show the node's *identity* under the title, not its category:
  //   Click Element  /  #next-button        (selector)
  //   Check Login Status  /  Condition      (node kind)
  function ndvSubtitle(node) {
    if (node.action === 'click') {
      return node.params && node.params.selector ? String(node.params.selector) : t('nk.click');
    }
    if (node.action === 'if') return t('nk.condition');
    if (node.action === 'while') return t('nk.loopCondition');
    var cat = categoryOf(node.action) || { label: 'cat.other' };
    return t(cat.label || 'cat.other');
  }

  // Display title: designed nodes get a human name instead of the raw action id.
  // Human node names for the canvas card + NDV header, so both agree with the
  // designed screens (docs/uiux). Anything absent falls back to the raw action id.
  /* Human name per catalog action.
   *
   * It covers ALL 50 actions on purpose. Every locked image labels its cards
   * with product language — "Type Text", "Wait Element", "Extract Data" — while
   * an unmapped action fell back to its raw id, so a seeded render showed
   * `fill` / `wait` / `extract` on the canvas, in the OUTLINE and in the blocks
   * palette. The fallback is kept for actions added later, and
   * `tests/unit/palette-labels.test.ts` fails the moment the catalog grows a
   * member this table does not name, in either dictionary. */
  var NODE_DISPLAY_NAMES = {
    // navigation
    goto: 'nk.openUrl',
    wait: 'nk.wait',
    launch: 'nk.launchBrowser',
    'wait-element': 'nk.waitElement',
    delay: 'nk.delay',
    'switch-frame': 'nk.switchFrame',
    'switch-tab': 'nk.switchTab',
    'close-tab': 'nk.closeTab',
    'close-browser': 'nk.closeBrowser',
    'handle-dialog': 'nk.handleDialog',
    // interaction
    click: 'nk.clickElement',
    dblclick: 'nk.doubleClick',
    hover: 'nk.hover',
    focus: 'nk.focusElement',
    'mouse-move': 'nk.moveMouse',
    'drag-drop': 'nk.dragDrop',
    scroll: 'nk.scrollPage',
    fill: 'nk.typeText',
    type: 'nk.typeKeystrokes',
    press: 'nk.pressKey',
    select: 'nk.selectOption',
    check: 'nk.checkBox',
    uncheck: 'nk.uncheckBox',
    upload: 'nk.uploadFile',
    'remove-element': 'nk.removeElement',
    'add-style': 'nk.injectCss',
    // data
    extract: 'nk.extractText',
    'extract-data': 'nk.extractData',
    'parse-json': 'nk.parseJson',
    'export-data': 'nk.exportData',
    screenshot: 'nk.screenshot',
    download: 'nk.downloadFile',
    attribute: 'nk.readAttribute',
    variable: 'nk.setVariable',
    // integration
    cookie: 'nk.cookies',
    clipboard: 'nk.clipboard',
    notification: 'nk.notification',
    log: 'nk.logMessage',
    'http-request': 'nk.httpRequest',
    // flow
    if: 'nk.condition',
    switch: 'nk.switchCase',
    loop: 'nk.loop',
    foreach: 'nk.forEach',
    while: 'nk.whileLoop',
    try: 'nk.tryCatch',
    stop_and_error: 'nk.stopAndError',
    // triggers
    trigger_manual: 'nk.manualTrigger',
    trigger_webhook: 'nk.webhookTrigger',
    trigger_schedule: 'nk.scheduleTrigger',
    trigger_telegram: 'nk.telegramTrigger',
  };
  /** Human name of an action id, falling back to the id itself. */
  function actionLabel(actionId) {
    var key = NODE_DISPLAY_NAMES[actionId];
    return key ? t(key) : String(actionId);
  }
  function ndvTitle(node) {
    var key = NODE_DISPLAY_NAMES[node.action];
    return key ? t(key) : nodeTitle(node);
  }

  // ---- NDV edge tone (category-derived modal border/glow) ------------------
  // Cross-cutting rule extracted from docs/uiux/shell-add-node-palette.md:
  // the modal's edge border + outer glow is NOT always orange — it is derived
  // from the node's category. HTTP/request-family nodes (integration, and the
  // browser/navigation family) read with a cool info blue; interaction and
  // flow-logic nodes (the two LOCKED designs: click, condition) read orange.
  // Any other category falls back to its own catalogue colour so the rule
  // scales to nodes that have no preview yet.
  var NDV_EDGE_BLUE = '#2BA6FF';   // token: "secondary accent (browser / info blue)"
  var NDV_EDGE_ORANGE = '#FF8A1F'; // token: "primary accent"
  var NDV_EDGE_BY_CATEGORY = {
    integration: NDV_EDGE_BLUE,   // http-request, webhooks, online services
    navigation: NDV_EDGE_BLUE,    // goto / wait — browser-family, same blue
    interaction: NDV_EDGE_ORANGE, // click, type, hover — the click NDV preview
    flow: NDV_EDGE_ORANGE,        // if / while — the condition NDV preview
  };
  function ndvEdgeTone(action) {
    var cat = categoryOf(action) || {};
    return NDV_EDGE_BY_CATEGORY[cat.id] || cat.color || NDV_EDGE_ORANGE;
  }

  // Which NDV centre tab is showing: instructions | advanced | error | test.
  var ndvTab = 'instructions';

  function renderInspector() {
    // legacy side panel stays empty (hidden by CSS); the NDV is a modal now
    if (dom && dom.inspector) dom.inspector.innerHTML = '';
    var node = ndvOpen && state ? state.nodes[ndvOpen] : null;
    if (!node || node.action === '__start__') { closeNdv(); return; }
    var act = actionById(node.action);
    var designed = window.NdvModel && window.NdvModel.isDesigned(node.action) &&
      window.NdvNodes && window.NdvUI;

    var back = document.querySelector('.ndv-backdrop');
    if (!back) {
      back = document.createElement('div');
      back.className = 'ndv-backdrop';
      back.addEventListener('mousedown', function (ev) {
        if (ev.target === back) closeNdv();
      });
      document.body.appendChild(back);
    }
    back.innerHTML = '';

    var modal = document.createElement('div');
    modal.className = 'ndv-modal' + (designed ? ' is-designed' : '');
    // Category-derived edge border/glow (blue for HTTP/browser-family, orange
    // for click/condition) — see ndvEdgeTone() and shell-add-node-palette.md.
    modal.style.setProperty('--ndv-edge', ndvEdgeTone(node.action));
    back.appendChild(modal);

    // ---- header: icon tile · title/subtitle · status badge · Run node · ×
    var head = document.createElement('div');
    head.className = 'ndv-head';
    var cat = categoryOf(node.action) || { color: '#6b7280' };
    var st = nodeStatus[node.id] || 'idle';
    head.innerHTML =
      '<span class="ndv-head-icon">' + ICON(node.action, 18) + '</span>' +
      '<span class="ndv-head-titles">' +
        '<div class="ndv-head-title">' + esc(ndvTitle(node)) + '</div>' +
        '<div class="ndv-head-sub">' + esc(ndvSubtitle(node)) + '</div>' +
      '</span>' +
      '<span class="ndv-status-badge ' + st + '"><span class="ndv-status-dot"></span>' +
        esc(statusBadgeLabel(st)) + '</span>';
    head.querySelector('.ndv-head-icon').style.setProperty('--cat-color', cat.color || '#FF8A1F');
    var runBtn = document.createElement('button');
    runBtn.className = 'ndv-run-btn';
    runBtn.innerHTML = '<span class="ndv-run-play">' + IC('play', 12) + '</span>' + esc(t('ndv.runNode'));
    // Item N. Until now this button said "Run node" and clicked #fe-run, i.e. it
    // ran the WHOLE flow — a fake success, because it looked like it had done
    // what it promised. It now runs the chain prefix ending at THIS node, or
    // renders disabled with the reason it cannot.
    var runWhy = runNodeBlockedReason(node.id);
    runBtn.title = runWhy ? t(runWhy) : t('fe.runNodeHint');
    if (runWhy) {
      runBtn.disabled = true;
      runBtn.setAttribute('aria-disabled', 'true');
    } else {
      runBtn.addEventListener('click', function () { runNode(node.id); });
    }
    head.appendChild(runBtn);
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ndv-close';
    closeBtn.title = t('ndv.close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeNdv);
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var body = document.createElement('div');
    body.className = 'ndv-body';
    modal.appendChild(body);

    var ndv = document.createElement('div');
    ndv.className = 'ndv';

    var cols = document.createElement('div');
    cols.className = 'ndv-cols';

    var inCol = document.createElement('div'); inCol.className = 'ndv-col ndv-col-input';
    var paramCol = document.createElement('div'); paramCol.className = 'ndv-col ndv-col-params';
    var outCol = document.createElement('div'); outCol.className = 'ndv-col ndv-col-output';

    // ---------- INPUT ----------
    if (designed) {
      window.NdvNodes.renderInput(inCol, ndvContext(node));
    } else {
      renderInputColumn(inCol, node.id);
    }

    // ---------- CENTRE ----------
    // Designed nodes get the spec's tab row (Instructions | Advanced | Error |
    // Test); undesigned nodes keep the plain "Parameters" heading.
    if (designed) {
      var tabRow = document.createElement('div');
      tabRow.className = 'ndv-tabs';
      [['instructions', 'ndv.tabInstructions'], ['advanced', 'ndv.tabAdvanced'],
       ['error', 'ndv.tabError'], ['test', 'ndv.tabTest']].forEach(function (pair) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ndv-tab' + (ndvTab === pair[0] ? ' on' : '');
        b.textContent = t(pair[1]);
        b.addEventListener('click', function () { ndvTab = pair[0]; renderInspector(); });
        tabRow.appendChild(b);
      });
      paramCol.appendChild(tabRow);

      var pane = document.createElement('div');
      pane.className = 'ndv-pane';
      paramCol.appendChild(pane);

      if (ndvTab === 'instructions') {
        window.NdvNodes.renderCenter(pane, ndvContext(node));
      } else if (ndvTab === 'advanced') {
        // fields the bespoke design does not surface (kept reachable, never lost)
        var shown = designedFieldKeys(node.action);
        var extra = (act ? act.fields : []).filter(function (f) {
          return !f.internal && shown.indexOf(f.k) === -1;
        });
        if (!extra.length) {
          pane.appendChild(emptyPane('ndv.advancedEmpty'));
        } else {
          extra.forEach(function (f) { pane.appendChild(buildFieldRow(node, f)); });
        }
      } else if (ndvTab === 'error') {
        pane.appendChild(buildErrorSettings(node));
      } else {
        pane.appendChild(buildTestPane(node));
      }
    } else {
      var pHead = document.createElement('div');
      pHead.className = 'ndv-col-head';
      pHead.textContent = t('ndv.parameters');
      paramCol.appendChild(pHead);

      // `internal: true` fields are owned by a bespoke NDV design; the generic
      // fallback editor must not expose them as raw inputs.
      var visible = (act ? act.fields : []).filter(function (f) { return !f.internal; });
      if (!visible.length) {
        paramCol.appendChild(emptyPane('fe.noParams'));
      } else {
        visible.forEach(function (f) {
          paramCol.appendChild(buildFieldRow(node, f));
        });
      }
      // Step 27: per-node error-handling settings (Continue/Retry On Fail).
      paramCol.appendChild(buildErrorSettings(node));
    }

    // ---------- OUTPUT ----------
    if (designed) {
      window.NdvNodes.renderOutput(outCol, ndvContext(node));
    } else {
      renderOutputColumn(outCol, node.id);
    }

    cols.appendChild(inCol);
    cols.appendChild(paramCol);
    cols.appendChild(outCol);
    ndv.appendChild(cols);
    body.appendChild(ndv);

    appendValidation(body);
    renderFieldFeedback();
  }

  function emptyPane(key) {
    var d = document.createElement('div');
    d.className = 'muted small ndv-empty';
    d.textContent = t(key);
    return d;
  }

  // Parameter keys already rendered by each bespoke design (so the "Advanced"
  // tab shows only what is NOT in the design and nothing is silently dropped).
  function designedFieldKeys(action) {
    if (action === 'click') {
      return ['selectorType', 'selector', 'clickType', 'button', 'clickCount',
        'delayBeforeMs', 'waitForSelector', 'timeout', 'scrollIntoView',
        'multipleMatches', 'highlightElement', 'visibleOnly', 'stableForMs',
        'offsetX', 'offsetY', 'modAlt', 'modCtrl', 'modShift', 'human', 'force'];
    }
    if (action === 'if' || action === 'while') {
      return ['groups', 'selector', 'operator', 'value', 'expected', 'source',
        'attribute', 'maxDepth', 'evaluateMode', 'maxIterations'];
    }
    return [];
  }

  // The "Test" tab: a read-only preview of what this node serialises to, which
  // is the fastest way to confirm a design maps to the backend contract.
  function buildTestPane(node) {
    var wrap = document.createElement('div');
    wrap.className = 'ndv-testpane';
    wrap.appendChild(emptyPane('ndv.testHint'));
    var pre = document.createElement('pre');
    pre.className = 'aria-json';
    try {
      var gs = GS();
      var step = null;
      if (gs && gs.coerceParams) {
        step = { action: node.action, params: gs.coerceParams(node.action, node.params) };
        if ((node.action === 'if' || node.action === 'while') && gs.buildCondition) {
          step.condition = gs.buildCondition(node.params || {});
          ['selector', 'operator', 'value', 'expected', 'source', 'attribute', 'groups']
            .forEach(function (k) { delete step.params[k]; });
        }
      } else {
        step = { action: node.action, params: node.params };
      }
      pre.textContent = JSON.stringify(step, null, 2);
    } catch (e) {
      pre.textContent = String(e && e.message ? e.message : e);
    }
    wrap.appendChild(pre);
    return wrap;
  }

  // Build the render context handed to the designed-node renderers.
  function ndvContext(node) {
    var input = inputItemsFor(node.id);
    return {
      node: node,
      inputItems: input,
      outputItems: outputItemsFor(node.id),
      meta: nodeMeta[node.id] || { status: nodeStatus[node.id] || 'idle' },
      exprContext: {
        json: (input[0] && input[0].json) ? input[0].json : (input[0] || {}),
        index: 0,
      },
      onParamsChange: function () { renderNodes(); renderFieldFeedback(); },
      onStructureChange: function () { renderInspector(); },
    };
  }

  function renderAll() {
    applyViewTransform();
    renderEdges();
    renderNodes();
    renderInspector();
    renderMinimap();
    // The shell (OUTLINE panel, undo/redo button state) mirrors the graph, so it
    // re-reads on every full render rather than being pushed to from each call
    // site — one subscription instead of N notifications to keep in sync.
    emitChange();
  }

  // ---- Step 23: visual node status (idle / running / success / error) -------
  // status: { nodeId|action#index : 'idle'|'running'|'success'|'error' }.
  // Real data is wired in Step 26; this is the UI substrate used by the live
  // runner to paint per-node halos. Accepts either a node id or, when steps[]
  // are run, the step index resolved to the matching node along the chain.
  function chainNodeIds() {
    var ids = [];
    var edge = outgoing('start');
    var guard = 0, seen = {};
    while (edge && guard < 1000) {
      guard += 1;
      var node = state.nodes[edge.to];
      if (!node || seen[node.id]) break;
      seen[node.id] = true;
      if (node.action !== '__start__') ids.push(node.id);
      edge = outgoing(node.id);
    }
    return ids;
  }

  /**
   * The main chain restricted to the nodes that actually PRODUCE a step, i.e.
   * every enabled node. This — not chainNodeIds() — is the id list a step index
   * addresses, because graphToSteps() skips `disabled` nodes (08-HANDOFF § 2).
   *
   * Bug this fixes (09-HANDOFF § 3.1): run-panel.js paints results with
   * `nodeIndex0 = stepIndex1 - 1`; resolving that through chainNodeIds() (which
   * KEEPS disabled nodes) shifted every halo / NDV result / pin after a disabled
   * node onto the wrong card.
   */
  function stepChainIds() {
    return chainNodeIds().filter(function (id) {
      var n = state && state.nodes ? state.nodes[id] : null;
      return !!n && n.disabled !== true;
    });
  }

  /**
   * Inverse of stepChainIds(): the 0-based index of `nodeId` **in the serialized
   * step list**, or -1 when the node has no step of its own (disabled, or not on
   * the main chain at all). Item N needs the STEP index, because the prefix it
   * sends is a literal slice of toSteps().
   *
   * Keep this adjacent to stepChainIds() so the two cannot drift apart.
   */
  function chainStepIndex(nodeId) {
    return stepChainIds().indexOf(nodeId);
  }

  /**
   * Why a node cannot be run on its own, as an i18n key — '' when it CAN.
   * Both entry points (the context-menu row and the NDV header button) render
   * from this single source so they can never disagree about the reason.
   */
  function runNodeBlockedReason(nodeId) {
    var n = state && state.nodes ? state.nodes[nodeId] : null;
    if (!n) return 'fe.runNodeBranch';
    if (n.disabled === true) return 'fe.runNodeDisabled';
    if (chainStepIndex(nodeId) < 0) return 'fe.runNodeBranch';
    return '';
  }

  /** views.js rule: env_root is the admin key, not an automation user. */
  function runUserId() {
    var uid = API && API.getUserId ? API.getUserId() : '';
    if (!uid || uid === 'env_root') return '0';
    return uid;
  }

  /**
   * Item N — execute the chain PREFIX ending at `nodeId` (09-HANDOFF § 2.1).
   *
   * A node can only be executed with REAL upstream data, so we send every
   * enabled step from the trigger up to and including this one and let the
   * server run them; the node under test is always the LAST step. Sending the
   * lone step would leave its input empty and the OUTPUT column would show a
   * lie, and calling API.runFlow() would file the partial run as a real
   * execution — hence the dedicated `__runNode`-tagged endpoint.
   */
  function runNode(nodeId) {
    if (runNodeBlockedReason(nodeId)) return false;   // guarded: row is disabled
    var idx = chainStepIndex(nodeId);
    var steps = toSteps().slice(0, idx + 1);
    if (!steps.length) return false;
    var uid = runUserId();
    if (!uid) { if (U() && U().toast) U().toast(t('fe.needUserId'), 'error'); return false; }
    setNodeStatus(nodeId, 'running');
    API.runNode(uid, { steps: steps, nodeIndex: idx, headless: true })
      .then(function (data) {
        if (U() && U().toast) U().toast(t('fe.runNodeQueued'), 'ok');
        var RP = window.RunPanel;
        if (RP && RP.startJob) {
          if (RP.open) RP.open();
          RP.startJob({
            userId: uid,
            jobId: data.jobId,
            apiKey: API.getKey ? API.getKey() : '',
          });
        }
      })
      .catch(function (err) {
        setNodeStatus(nodeId, 'error');
        if (U() && U().toast) {
          U().toast(err && err.message ? err.message : String(err), 'error');
        }
      });
    return true;
  }

  function setNodeStatus(ref, status) {
    if (!state) return;
    var id = ref;
    if (typeof ref === 'number') {
      var ids = stepChainIds();
      id = ids[ref];
    }
    if (!id || !state.nodes[id]) return;
    nodeStatus[id] = status || 'idle';
    if (dom) renderNodes();
  }

  function clearStatuses() {
    nodeStatus = {};
    nodeMeta = {};
    if (dom) renderNodes();
  }

  // ---- Node operations ------------------------------------------------------
  // The current effective selection (selSet if any, else the single `selected`),
  // never including the start node (it cannot be moved as a group / deleted).
  function activeSelection() {
    var ids = Object.keys(state.selSet).filter(function (id) {
      return state.selSet[id] && state.nodes[id] && id !== 'start';
    });
    if (ids.length) return ids;
    if (state.selected && state.selected !== 'start') return [state.selected];
    return [];
  }

  function selectNode(id) {
    state.selected = id;
    state.selSet = {};
    if (id && id !== 'start') state.selSet[id] = true;
    renderNodes();
    renderInspector();
  }

  function removeNode(id) {
    if (id === 'start') return;
    pushHistory();
    if (ndvOpen === id) closeNdv();
    delete state.nodes[id];
    delete nodeStatus[id];
    delete nodeMeta[id];
    delete nodePins[id];
    delete nodeResults[id];
    delete state.selSet[id];
    state.edges = state.edges.filter(function (e) {
      return e.from !== id && e.to !== id;
    });
    if (state.selected === id) state.selected = null;
    renderAll();
  }

  // Delete every node in the active selection (used by the Delete key).
  function removeSelection() {
    var ids = activeSelection();
    if (!ids.length) return;
    pushHistory();
    ids.forEach(function (id) {
      delete state.nodes[id];
      delete nodeStatus[id];
      delete nodeMeta[id];
      delete nodePins[id];
      delete nodeResults[id];
      state.edges = state.edges.filter(function (e) {
        return e.from !== id && e.to !== id;
      });
    });
    state.selSet = {};
    state.selected = null;
    renderAll();
  }

  // ---- Per-node annotations (context menu item J) ---------------------------
  //
  // Four user-owned fields live on the node itself — `label` (Rename), `note`
  // (Add Comment), `disabled` (Disable) and `color` (Change Color). They ride
  // inside `state.nodes`, which means they are already covered by serialize(),
  // saveLocal(), the undo snapshots and the clipboard, with no second store to
  // keep in sync.
  //
  // HONEST LIMIT, written down so nobody reports it as a bug later: the server
  // stores a workflow as `steps[]` (see src/validation.ts#validateSteps, which
  // whitelists step fields), and `label`/`note`/`color` are EDITOR metadata with
  // no place in that contract. They therefore survive a browser reload (the
  // graph is kept in localStorage) but NOT a server round-trip. `disabled` is
  // different: it changes what is serialised at all (graph-serialize.js skips
  // the node), so its effect does reach the backend.
  //
  // Only these swatches can ever be stored, so a graph loaded from disk cannot
  // inject an arbitrary value into the `--cat-color` custom property.
  var NODE_COLORS = ['#FF8A1F', '#2BA6FF', '#2ECC71', '#E45555', '#A78BFA', '#F5C542'];
  function isNodeColor(v) { return NODE_COLORS.indexOf(String(v)) !== -1; }

  function renameNode(id, value) {
    var n = state.nodes[id];
    if (!n || id === 'start') return;
    var next = String(value == null ? '' : value).trim().slice(0, 60);
    if (next === (n.label || '')) return;
    pushHistory();
    if (next) n.label = next; else delete n.label;   // empty = back to the derived name
    renderAll();
  }

  function setNodeComment(id, value) {
    var n = state.nodes[id];
    if (!n || id === 'start') return;
    var next = String(value == null ? '' : value).trim().slice(0, 500);
    if (next === (n.note || '')) return;
    pushHistory();
    if (next) n.note = next; else delete n.note;
    renderAll();
  }

  function setNodeColor(id, color) {
    var n = state.nodes[id];
    if (!n || id === 'start') return;
    pushHistory();
    if (color && isNodeColor(color)) n.color = color; else delete n.color;
    renderAll();
  }

  /** Toggle (or force, when `on` is a boolean) the disabled flag of one node. */
  function setNodeDisabled(id, on) {
    var n = state.nodes[id];
    if (!n || id === 'start') return;
    var next = typeof on === 'boolean' ? on : !(n.disabled === true);
    if (next === (n.disabled === true)) return;
    pushHistory();
    if (next) n.disabled = true; else delete n.disabled;
    renderAll();
  }

  /** Disable/enable a whole selection in ONE undo step (group toolbar, item I). */
  function setSelectionDisabled(ids, on) {
    var touched = (ids || []).filter(function (id) {
      var n = state.nodes[id];
      return n && id !== 'start' && (n.disabled === true) !== !!on;
    });
    if (!touched.length) return;
    pushHistory();
    touched.forEach(function (id) {
      if (on) state.nodes[id].disabled = true; else delete state.nodes[id].disabled;
    });
    renderAll();
  }

  /**
   * Apply one comment to a whole selection in ONE undo step (group toolbar).
   * An empty value clears the note on every node, which is how the toolbar's
   * "remove the comment from all of these" gesture is expressed.
   */
  function setSelectionComment(ids, value) {
    var next = String(value == null ? '' : value).trim().slice(0, 500);
    var touched = (ids || []).filter(function (id) {
      var n = state.nodes[id];
      return n && id !== 'start' && (n.note || '') !== next;
    });
    if (!touched.length) return;
    pushHistory();
    touched.forEach(function (id) {
      if (next) state.nodes[id].note = next; else delete state.nodes[id].note;
    });
    renderAll();
  }

  /** Recolour a whole selection in ONE undo step (`null` resets to category). */
  function setSelectionColor(ids, color) {
    var use = color && isNodeColor(color) ? color : null;
    var touched = (ids || []).filter(function (id) {
      var n = state.nodes[id];
      return n && id !== 'start' && (n.color || null) !== use;
    });
    if (!touched.length) return;
    pushHistory();
    touched.forEach(function (id) {
      if (use) state.nodes[id].color = use; else delete state.nodes[id].color;
    });
    renderAll();
  }

  /**
   * Pin / unpin a whole selection. Pins are VIEW state (they are not part of
   * the graph), so this deliberately takes no history step — undo would have
   * nothing to restore and would look broken.
   */
  function setSelectionPinned(ids, on) {
    (ids || []).forEach(function (id) {
      if (!state.nodes[id] || id === 'start') return;
      if (on) nodePins[id] = true; else delete nodePins[id];
    });
    if (dom) renderNodes();
  }

  /**
   * The serialized STEP of one node — the object the backend would actually
   * receive, produced by the single serializer rather than a hand-rolled dump
   * that could drift from it. Shared by "Copy node JSON" and its group twin.
   */
  function nodeStepJson(id) {
    var n = state.nodes[id];
    if (!n) return null;
    var gs = GS();
    if (!gs || !gs.graphToSteps) return { action: n.action, params: n.params || {} };
    // Serialise a one-node graph so `coerceParams` + the condition builder run
    // exactly as they do for a real save.
    var solo = { nodes: { start: { id: 'start', action: '__start__', params: {} } },
      edges: [{ from: 'start', to: id, port: 'next' }], nextId: 0 };
    solo.nodes[id] = JSON.parse(JSON.stringify(n));
    delete solo.nodes[id].disabled;        // a disabled node serialises to nothing
    var steps = gs.graphToSteps(solo);
    return steps[0] || {};
  }

  /** Copy `text` to the clipboard, with a fallback for non-secure contexts. */
  function writeClipboard(text) {
    var done = function (ok) {
      if (U() && U().toast) U().toast(t(ok ? 'fe.copiedJson' : 'fe.copyFailed'), ok ? 'ok' : 'err');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
          function () { done(false); });
        return true;
      }
    } catch (e) { /* fall through to the textarea path */ }
    // Fallback for non-secure contexts, where navigator.clipboard is absent.
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
      return !!ok;
    } catch (e2) { done(false); return false; }
  }

  /** Copy ONE node's serialized step to the clipboard as JSON (Advanced ▸). */
  function copyNodeJson(id) {
    var step = nodeStepJson(id);
    if (!step) return false;
    return writeClipboard(JSON.stringify(step, null, 2));
  }

  /**
   * Copy a whole selection as a JSON ARRAY of steps (group toolbar ▸ More).
   * Order follows the main chain where the nodes sit on it, so the copied text
   * reads in execution order rather than in click order.
   */
  function copySelectionJson(ids) {
    var list = (ids || []).filter(function (id) { return !!state.nodes[id]; });
    if (!list.length) return false;
    var order = chainNodeIds();
    list.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia === -1) ia = Infinity;
      if (ib === -1) ib = Infinity;
      return ia - ib;
    });
    var steps = list.map(nodeStepJson).filter(Boolean);
    return writeClipboard(JSON.stringify(steps, null, 2));
  }

  // ---- Inline prompt popover (Rename / Add Comment) -------------------------
  //
  // The browser's native `prompt` dialog was the cheap option and was rejected:
  // it is a browser chrome dialog that ignores the product's RTL direction, its
  // own dark theme and its i18n, and Playwright/automated review cannot see it.
  // This is a small
  // focus-trapped popover instead — Enter commits, Esc cancels, blur-to-cancel
  // is deliberately NOT used (a stray click must not silently discard typing).
  function closeInlinePrompt() {
    var ex = document.querySelector('.fe-prompt');
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
  }

  function openInlinePrompt(opts) {
    closeInlinePrompt();
    var o = opts || {};
    var box = document.createElement('div');
    box.className = 'fe-prompt';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'false');
    box.setAttribute('aria-label', o.title || '');
    var inputId = 'fe-prompt-' + Date.now();
    box.innerHTML =
      '<label class="fe-prompt-title" for="' + inputId + '">' + esc(o.title || '') + '</label>' +
      (o.multiline
        ? '<textarea class="fe-prompt-input" id="' + inputId + '" rows="3"></textarea>'
        : '<input type="text" class="fe-prompt-input" id="' + inputId + '" />') +
      '<div class="fe-prompt-row">' +
        '<button type="button" class="fe-prompt-ok">' + esc(t('fe.promptOk')) + '</button>' +
        '<button type="button" class="fe-prompt-cancel">' + esc(t('fe.promptCancel')) + '</button>' +
        '<span class="fe-prompt-hint">' + esc(t('fe.promptHint')) + '</span>' +
      '</div>';
    document.body.appendChild(box);

    var input = box.querySelector('.fe-prompt-input');
    input.value = o.value == null ? '' : String(o.value);
    if (o.placeholder) input.placeholder = o.placeholder;

    function commit() {
      var v = input.value;
      closeInlinePrompt();
      if (typeof o.onOk === 'function') o.onOk(v);
    }
    box.querySelector('.fe-prompt-ok').addEventListener('click', commit);
    box.querySelector('.fe-prompt-cancel').addEventListener('click', closeInlinePrompt);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); closeInlinePrompt(); return; }
      // In a textarea Enter inserts a newline; Ctrl/Cmd+Enter commits instead.
      if (ev.key !== 'Enter') return;
      if (o.multiline && !(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      commit();
    });
    box.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });

    // Position next to the trigger, flipped back inside the viewport.
    var r = box.getBoundingClientRect();
    var x = Math.min(o.x == null ? 120 : o.x, window.innerWidth - r.width - 8);
    var y = Math.min(o.y == null ? 120 : o.y, window.innerHeight - r.height - 8);
    box.style.left = Math.max(8, x) + 'px';
    box.style.top = Math.max(8, y) + 'px';
    input.focus();
    input.select();
    return box;
  }

  // ---- Copy / paste ---------------------------------------------------------
  function copySelection() {
    var ids = activeSelection();
    if (!ids.length) return;
    var idset = {};
    ids.forEach(function (id) { idset[id] = true; });
    clipboard = {
      nodes: ids.map(function (id) {
        var n = state.nodes[id];
        // A CLONE has to be a clone: the annotations (label/note/color/
        // disabled) and the error-handling settings are part of the node the
        // user is duplicating, so copying only action+params would quietly
        // produce a different node than the one on screen.
        var copy = { action: n.action, params: JSON.parse(JSON.stringify(n.params || {})),
          x: n.x, y: n.y };
        if (n.label) copy.label = n.label;
        if (n.note) copy.note = n.note;
        if (n.color) copy.color = n.color;
        if (n.disabled === true) copy.disabled = true;
        if (n.errorPolicy) copy.errorPolicy = JSON.parse(JSON.stringify(n.errorPolicy));
        return copy;
      }),
      // keep internal edges between copied nodes (relative by array index),
      // preserving the originating port so branch structure survives paste.
      edges: state.edges.filter(function (e) { return idset[e.from] && idset[e.to]; })
        .map(function (e) { return { from: ids.indexOf(e.from), to: ids.indexOf(e.to), port: e.port || 'next' }; }),
    };
  }

  function pasteClipboard() {
    if (!clipboard || !clipboard.nodes.length) return;
    pushHistory();
    var newIds = [];
    state.selSet = {};
    clipboard.nodes.forEach(function (c) {
      var id = uid('n');
      newIds.push(id);
      var nn = { id: id, action: c.action,
        params: JSON.parse(JSON.stringify(c.params || {})),
        x: snap(c.x + 40), y: snap(c.y + 40) };
      if (c.label) nn.label = c.label;
      if (c.note) nn.note = c.note;
      if (c.color && isNodeColor(c.color)) nn.color = c.color;
      if (c.disabled === true) nn.disabled = true;
      if (c.errorPolicy) nn.errorPolicy = JSON.parse(JSON.stringify(c.errorPolicy));
      state.nodes[id] = nn;
      state.selSet[id] = true;
    });
    clipboard.edges.forEach(function (e) {
      if (newIds[e.from] && newIds[e.to]) {
        state.edges.push({ from: newIds[e.from], to: newIds[e.to], port: e.port || 'next' });
      }
    });
    state.selected = newIds[newIds.length - 1] || null;
    renderAll();
  }

  function addNode(actionId, x, y) {
    var act = actionById(actionId);
    if (!act) return;
    pushHistory();
    var id = uid('n');
    state.nodes[id] = { id: id, action: actionId, params: {},
      x: typeof x === 'number' ? x : 320, y: typeof y === 'number' ? y : 220 };
    selectNode(id);
    renderAll();
  }

  // Step 24: a node can have at most ONE outgoing edge PER output port.
  // Reconnecting the same port replaces its previous target; branching nodes
  // therefore fan out (e.g. if -> then + else, try -> try/catch/finally).
  function connect(fromId, toId, port) {
    if (fromId === toId) return;
    if (toId === 'start') return; // nothing connects into start
    pushHistory();
    var p = port || 'next';
    state.edges = state.edges.filter(function (e) {
      return !(e.from === fromId && (e.port || 'next') === p);
    });
    state.edges.push({ from: fromId, to: toId, port: p });
    renderAll();
  }

  // ---- Palette (search + category grouping, Step 23) ------------------------
  function placeNewNode(actionId) {
    // place new node near viewport center, cascading so nodes never stack
    var rect = dom.canvas.getBoundingClientRect();
    var center = worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    var n = Object.keys(state.nodes).length; // includes start
    var offset = (n - 1) % 6;
    addNode(actionId, snap(center.x - nodeW() / 2 + offset * 26), snap(center.y - 22 + offset * 30));
  }

  /**
   * One catalog row. Used by BOTH the docked BLOCKS palette and the floating
   * Add Node palette (item H) — the second surface reuses this renderer instead
   * of owning a copy, so the star, the drag payload, the category dot and the
   * keyboard contract can never drift apart between them.
   *
   * @param {object} a     catalog action
   * @param {object} [opts]
   *        opts.onPick(actionId) — replaces the default "drop at viewport
   *        centre" behaviour (the Add Node palette inserts at a chosen point and
   *        wires the new node to a source port instead).
   */
  function paletteItem(a, opts) {
    var o = opts || {};
    var pick = typeof o.onPick === 'function'
      ? function () { o.onPick(a.id); }
      : function () { placeNewNode(a.id); };
    var cat = categoryOf(a.id);
    var item = document.createElement('div');
    item.className = 'palette-item';
    item.setAttribute('data-action', a.id);
    item.setAttribute('draggable', 'true');
    // A <div> was chosen so the row can HOST the star <button> (nested buttons
    // are invalid HTML), but that loses everything a <button> gave for free.
    // Handing the semantics back explicitly, because dropping a block on the
    // canvas must not require a mouse:
    //   role=button   -> assistive tech announces it as activatable
    //   tabindex=0    -> it is in the tab order at all
    //   Enter/Space   -> the keys a button would have handled itself
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.style.setProperty('--cat-color', cat.color);
    var starred = !!paletteFavs[a.id];
    // The row is a button-like surface plus its own star toggle, so the star
    // is a real nested <button> rather than a click-position heuristic.
    // The row shows the PRODUCT name ("Type Text"), like every locked image,
    // and keeps the raw action id in the tooltip so nothing is lost for anyone
    // who writes steps by hand. `data-action` still carries the id, so drag/drop
    // and the tests address the row by id, not by label.
    item.title = a.id;
    item.innerHTML = '<span class="pi-dot" aria-hidden="true"></span>' +
      '<span class="pi-icon">' + ICON(a.id) + '</span>' +
      '<span class="pi-label">' + esc(actionLabel(a.id)) + '</span>' +
      '<button type="button" class="pi-star' + (starred ? ' on' : '') + '"' +
        ' aria-pressed="' + (starred ? 'true' : 'false') +
        '" title="' + esc(t(starred ? 'pl.unfav' : 'pl.fav')) + '">' +
        IC('star', 12) + '</button>';
    item.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.pi-star')) return;
      pick();
    });
    item.addEventListener('keydown', function (ev) {
      // The star is a real <button>: it turns Enter/Space into its own `click`,
      // so those keys must not ALSO drop a node while the star holds focus.
      if (ev.target !== item) return;
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.preventDefault();            // Space would otherwise scroll the list
      pick();
    });
    var star = item.querySelector('.pi-star');
    if (star) star.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (paletteFavs[a.id]) delete paletteFavs[a.id]; else paletteFavs[a.id] = true;
      savePaletteFavs();
      // Both surfaces read the SAME store, so both have to repaint — starring a
      // block in the floating palette must show up in the docked one too.
      if (dom && dom.palette && dom.palette.querySelector('.palette-list')) renderPaletteList();
      if (document.querySelector('.fe-addnode')) renderAddList();
    });
    // HTML5 drag-and-drop onto the canvas
    item.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.setData('text/ab-action', a.id);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    return item;
  }

  // ---- Item H: the floating "Add Node" palette -------------------------------
  //
  // Reference: docs/uiux/shell-add-node-palette.webp + .md § "Right overlay:
  // Add Node palette" — a titled card with `Search nodes...`, a CATEGORY column
  // on the start edge and the matching node presets on the end edge. The spec
  // calls it "a quick insertion launcher rather than a full library page", so it
  // is transient (Esc / outside click closes it) and it never replaces the
  // docked BLOCKS palette.
  //
  // It is a second SURFACE over the same data, never a second catalog: rows come
  // from `paletteItem()`, groups from `PALETTE_GROUPS`, counts from the real
  // members, favourites from the same `paletteFavs` store.
  //
  // Four entry points, all of which knew where the node should go BEFORE the
  // palette opened — which is exactly why the docked palette could not serve
  // them (it always drops at the viewport centre):
  //   1. the empty-state card's `+ Add First Node`   -> after Start
  //   2. the canvas toolbar's `+`                     -> after the selection, or
  //                                                      at the viewport centre
  //   3. `Tab` on the canvas                          -> same as (2)
  //   4. dragging a connection into empty canvas      -> at the drop point,
  //                                                      wired to that port
  var addState = null;   // { cat, q, world:{x,y}, from:{nodeId,port}|null, active }
  var ADD_ALL = '__all__';
  var ADD_FAV = '__fav__';

  function closeAddPalette() {
    var ex = document.querySelector('.fe-addnode');
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
    addState = null;
    // The dashed "pending connection" hint on the source port goes with it.
    if (dom && dom.world) {
      var hint = dom.world.querySelectorAll('.fe-node-pending');
      Array.prototype.forEach.call(hint, function (h) { h.classList.remove('fe-node-pending'); });
    }
  }

  /** Catalog groups for the palette's category column, with REAL counts. */
  function addCategories() {
    var out = [{ id: ADD_FAV, icon: 'star', label: t('pl.favorites'),
      count: ACTIONS.filter(function (a) { return paletteFavs[a.id]; }).length, color: '#F5C542' }];
    PALETTE_GROUPS.forEach(function (g) {
      var members = ACTIONS.filter(function (a) { return (a.cat || 'other') === g.id; });
      if (!members.length) return;
      var cat = (CAT.categoryById && CAT.categoryById(g.id)) ||
        { color: '#6b7280', label: 'cat.other' };
      out.push({ id: g.id, icon: g.icon, label: paletteGroupLabel(g, cat),
        count: members.length, color: cat.color });
    });
    out.push({ id: ADD_ALL, icon: 'grid', label: t('an.all'),
      count: ACTIONS.length, color: '#97A2B3' });
    return out;
  }

  /** The actions the palette should currently list. */
  function addMatches() {
    var q = (addState && addState.q || '').trim().toLowerCase();
    return ACTIONS.filter(function (a) {
      if (q) {
        // A search spans the WHOLE catalog: hiding hits because another
        // category is selected is the classic "my search is broken" report.
        var hay = a.id.toLowerCase();
        var human = NODE_DISPLAY_NAMES && NODE_DISPLAY_NAMES[a.id]
          ? String(t(NODE_DISPLAY_NAMES[a.id])).toLowerCase() : '';
        return hay.indexOf(q) !== -1 || (human && human.indexOf(q) !== -1);
      }
      if (addState.cat === ADD_ALL) return true;
      if (addState.cat === ADD_FAV) return !!paletteFavs[a.id];
      return (a.cat || 'other') === addState.cat;
    });
  }

  /** Insert the picked action, wire it to the source port, and close. */
  function addPick(actionId) {
    if (!addState) return;
    var world = addState.world || { x: 320, y: 220 };
    var from = addState.from;
    closeAddPalette();
    var before = Object.keys(state.nodes);
    addNode(actionId, snap(world.x), snap(world.y));
    // addNode() picks the id itself, so find the one that appeared.
    var created = Object.keys(state.nodes).filter(function (id) {
      return before.indexOf(id) === -1;
    })[0];
    if (created && from && from.nodeId && state.nodes[from.nodeId]) {
      connect(from.nodeId, created, from.port || 'next');
    }
    if (created) centerOnNode(created);
  }

  function renderAddList() {
    var panel = document.querySelector('.fe-addnode');
    if (!panel || !addState) return;
    var list = panel.querySelector('.an-list');
    if (!list) return;
    list.innerHTML = '';
    var hits = addMatches();
    if (!hits.length) {
      list.innerHTML = '<div class="an-empty">' + esc(t('fe.noNodes')) + '</div>';
      return;
    }
    hits.forEach(function (a, i) {
      var row = paletteItem(a, { onPick: addPick });
      if (i === (addState.active || 0)) row.classList.add('is-active');
      row.setAttribute('data-add-index', String(i));
      list.appendChild(row);
    });
    // Category column counts change with the favourites, so repaint them too.
    var cats = panel.querySelectorAll('.an-cat');
    Array.prototype.forEach.call(cats, function (c) {
      c.classList.toggle('is-on', c.getAttribute('data-cat') === addState.cat);
    });
    var count = panel.querySelector('.an-count');
    if (count) count.textContent = String(hits.length);
  }

  /** Move the highlighted row and keep it in view (ArrowUp/ArrowDown). */
  function addMove(delta) {
    if (!addState) return;
    var n = addMatches().length;
    if (!n) return;
    var next = (addState.active || 0) + delta;
    if (next < 0) next = n - 1;
    if (next >= n) next = 0;
    addState.active = next;
    renderAddList();
    var el = document.querySelector('.fe-addnode .palette-item.is-active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /**
   * @param {object} [opts]
   *   opts.world  {x,y} world coords for the new node (default: viewport centre)
   *   opts.from   {nodeId, port} to wire the new node to
   *   opts.at     {x,y} viewport coords to anchor the panel at
   */
  function openAddPalette(opts) {
    closeAddPalette();
    closeNodeMenu();
    var o = opts || {};
    loadPaletteFavs();

    var world = o.world;
    if (!world && dom && dom.canvas) {
      var rect = dom.canvas.getBoundingClientRect();
      var c = worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      world = { x: c.x - nodeW() / 2, y: c.y - 22 };
    }
    addState = { cat: ADD_ALL, q: '', active: 0, world: world || { x: 320, y: 220 },
      from: o.from || null };

    var panel = document.createElement('div');
    panel.className = 'fe-addnode';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('an.title'));
    panel.innerHTML =
      '<div class="an-head">' +
        '<span class="an-title">' + IC('plus', 14) + '<span>' + esc(t('an.title')) + '</span></span>' +
        '<span class="an-count" aria-hidden="true"></span>' +
        '<button type="button" class="an-close" title="' + esc(t('fe.close')) + '"' +
          ' aria-label="' + esc(t('fe.close')) + '">' + IC('x', 14) + '</button>' +
      '</div>' +
      (addState.from
        ? '<div class="an-from">' + IC('corner-down-left', 12) +
          '<span>' + esc(t('an.fromNode')) + ': ' +
          esc(nodeTitle(state.nodes[addState.from.nodeId] || { action: '' })) + '</span></div>'
        : '') +
      '<div class="an-searchrow">' +
        '<span class="ps-ic" aria-hidden="true">' + IC('search', 13) + '</span>' +
        '<input type="text" class="an-search" />' +
      '</div>' +
      '<div class="an-body">' +
        '<div class="an-cats" role="tablist" aria-label="' + esc(t('an.categories')) + '"></div>' +
        '<div class="an-list" role="listbox" aria-label="' + esc(t('an.title')) + '"></div>' +
      '</div>' +
      '<div class="an-foot">' +
        '<span>' + IC('corner-down-left', 11) + esc(t('an.hintEnter')) + '</span>' +
        '<span>' + IC('keyboard', 11) + esc(t('an.hintKeys')) + '</span>' +
      '</div>';

    var search = panel.querySelector('.an-search');
    search.placeholder = t('an.search');
    search.setAttribute('aria-label', t('an.search'));
    search.addEventListener('input', function () {
      addState.q = search.value;
      addState.active = 0;
      renderAddList();
    });
    search.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); addMove(1); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); addMove(-1); return; }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        var hits = addMatches();
        var a = hits[addState.active || 0];
        if (a) addPick(a.id);
        return;
      }
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeAddPalette(); }
    });

    panel.querySelector('.an-close').addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeAddPalette();
    });

    var cats = panel.querySelector('.an-cats');
    addCategories().forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'an-cat' + (c.id === addState.cat ? ' is-on' : '');
      b.setAttribute('data-cat', c.id);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', c.id === addState.cat ? 'true' : 'false');
      b.style.setProperty('--cat-color', c.color);
      b.innerHTML = '<span class="an-cat-ic">' + IC(c.icon, 14) + '</span>' +
        '<span class="an-cat-label">' + esc(c.label) + '</span>' +
        '<span class="an-cat-count">' + c.count + '</span>';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        addState.cat = c.id;
        addState.active = 0;
        // Selecting a category while a query is active would show a list that
        // does not match the highlighted tab, so the query is cleared with it.
        addState.q = '';
        var s = panel.querySelector('.an-search');
        if (s) { s.value = ''; s.focus(); }
        Array.prototype.forEach.call(panel.querySelectorAll('.an-cat'), function (o2) {
          var on = o2.getAttribute('data-cat') === c.id;
          o2.classList.toggle('is-on', on);
          o2.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderAddList();
      });
      cats.appendChild(b);
    });

    panel.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    document.body.appendChild(panel);
    renderAddList();

    // Anchor near the trigger, flipped back inside the viewport.
    var r = panel.getBoundingClientRect();
    var ax = o.at && o.at.x != null ? o.at.x : (window.innerWidth - r.width) / 2;
    var ay = o.at && o.at.y != null ? o.at.y : (window.innerHeight - r.height) / 2;
    panel.style.left = Math.max(8, Math.min(ax, window.innerWidth - r.width - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(ay, window.innerHeight - r.height - 8)) + 'px';
    search.focus();

    // Mark the source node so it is obvious what the new node will attach to.
    if (addState.from && dom && dom.world) {
      var card = dom.world.querySelector('.flow-node[data-node="' + addState.from.nodeId + '"]');
      if (card) card.classList.add('fe-node-pending');
    }
    return panel;
  }

  /**
   * Where a node inserted "after" `nodeId` should land: one node-width plus a
   * gutter to the end side, on the grid, nudged down while the slot is taken so
   * two insertions never stack exactly on top of each other.
   */
  function slotAfter(nodeId) {
    var n = state.nodes[nodeId];
    if (!n) return { x: 320, y: 220 };
    var x = snap(n.x + nodeW() + 60);
    var y = snap(n.y);
    var guard = 0;
    while (guard < 40) {
      var taken = Object.keys(state.nodes).some(function (id) {
        var o = state.nodes[id];
        return Math.abs(o.x - x) < nodeW() && Math.abs(o.y - y) < 60;
      });
      if (!taken) break;
      y = snap(y + 90);
      guard += 1;
    }
    return { x: x, y: y };
  }

  /** Open the palette for "insert after the current selection / after Start". */
  function openAddPaletteForSelection(at) {
    var sel = activeSelection();
    var fromId = sel.length === 1 ? sel[0] : null;
    if (!fromId && Object.keys(state.nodes).length === 1) fromId = 'start';
    if (fromId) {
      // Only offer the wiring when that port is actually free — silently
      // replacing an existing connection is not what "add a node" means.
      var free = !state.edges.some(function (e) {
        return e.from === fromId && (e.port || 'next') === 'next';
      });
      return openAddPalette({
        world: slotAfter(fromId),
        from: free ? { nodeId: fromId, port: 'next' } : null,
        at: at,
      });
    }
    return openAddPalette({ at: at });
  }

  // ---- BLOCKS palette: presentational grouping (item D) ----------------------
  //
  // THE 6-vs-7 DECISION (written down so it is not re-litigated).
  //
  // `shell-editor-launcher-menu.webp` shows SEVEN collapsible rows with counts:
  //   General 14 · Browser 18 · Web Interaction 24 · Elements 20 ·
  //   Flow Control 16 · Online Services 22 · Data 14        (= 128 blocks)
  //
  // The real catalog (`public/js/actions.js`) has SIX categories and FIFTY
  // actions: navigation 10 · interaction 16 · data 8 · flow 7 · integration 5 ·
  // trigger 4. The image's rows and counts are therefore MOCK.
  //
  // Resolution: the mismatch is treated as PRESENTATIONAL. `ACTION_CATALOG`
  // stays the single source of truth — no invented categories, no renamed `cat`
  // ids, no padded action list (that would corrupt every node's colour, the
  // NDV, and `graphToSteps`). Instead this table maps catalog categories onto
  // the image's row vocabulary, and every count is COMPUTED from the real
  // members. So the palette matches the image's SHAPE (search + ⌘K, Favorites,
  // a `BLOCKS` header, collapsible rows with count badges, a footer group, a
  // Collapse control) while telling the truth about its contents.
  //
  //   image row          <- catalog category      real count
  //   -------------------------------------------------------
  //   Triggers           <- trigger                    4
  //   Browser            <- navigation                10
  //   Web Interaction    <- interaction               16
  //   Flow Control       <- flow                       7
  //   Online Services    <- integration                5
  //   Data               <- data                       8
  //
  // Six rows, not seven: the image's `General` and `Elements` rows have no
  // catalog members at all, and rendering an empty row with a fake count is
  // exactly the "fake-successful UI" the house rules forbid. `Triggers` takes
  // the leading slot because triggers are what a flow starts with.
  // `label` is the ROW NAME (the image's vocabulary); the catalog's own
  // `cat.<id>` label keeps driving everything else (node tone lookups, the NDV,
  // the Executions filters), so the two never diverge in meaning — only the
  // palette's presentation adopts the product wording. Omit `label` and the row
  // falls back to `cat.<id>`, which is what the leftovers sweep below relies on.
  var PALETTE_GROUPS = [
    { id: 'trigger',     icon: 'zap',            label: 'pg.triggers' },
    { id: 'navigation',  icon: 'globe',          label: 'pg.browser' },
    { id: 'interaction', icon: 'mouse-pointer',  label: 'pg.webInteraction' },
    { id: 'flow',        icon: 'git-branch',     label: 'pg.flowControl' },
    { id: 'integration', icon: 'layers',         label: 'pg.onlineServices' },
    { id: 'data',        icon: 'database',       label: 'pg.data' },
  ];

  /**
   * The palette row name for a group: the image's product wording when the group
   * declares one, else the catalog category label. ONE helper so the expanded
   * list, the collapsed rail and the Add Node palette can never drift apart —
   * three copies of `t(cat.label)` is how the rail ended up saying "Navigation"
   * while the list said "Browser".
   */
  function paletteGroupLabel(g, cat) {
    if (g && g.label) return t(g.label);
    return t((cat && cat.label) || 'cat.other');
  }

  // Footer group — the image lists `Templates`, `Variables`, `Connections`,
  // `Settings`, `Help & Docs`, plus `Collapse`.
  //
  // EVERY entry here must land somewhere that EXISTS. `app.js` accepts exactly
  //   home workspace dashboard jobs admin settings          (nav)
  //   workflows editor run live browser schedules quota     (deep)
  // and `currentRoute()` SILENTLY rewrites anything else to `#/workspace` — so a
  // plausible-looking `#/templates` would not 404, it would quietly dump the
  // user on the Workspace with no explanation. That is the "fake-successful UI"
  // the house rules forbid, so the invented hashes are gone:
  //
  //   Templates    -> `#/workspace?tab=templates`   (a real WS_TABS tab)
  //   Variables    -> no route at all; the workflow's variables live in the
  //                   ACTIVITY LOG, so this one calls `RunPanel.showTab()`
  //   Connections  -> `#/workspace?tab=connections` (a real WS_TABS tab)
  //   Settings     -> `#/settings`                  (a real nav route)
  //   Help & Docs  -> nothing ships a docs view yet, so it renders DISABLED
  //                   with a tooltip saying so, instead of pretending.
  var PALETTE_LINKS = [
    { key: 'pl.templates',   icon: 'grid',        route: '#/workspace?tab=templates' },
    { key: 'pl.variables',   icon: 'sliders',     act: 'variables' },
    { key: 'pl.connections', icon: 'link',        route: '#/workspace?tab=connections' },
    { key: 'pl.settings',    icon: 'settings',    route: '#/settings' },
    { key: 'pl.help',        icon: 'help-circle', disabled: 'pl.helpSoon' },
  ];

  function renderPalette() {
    var p = dom.palette;
    p.innerHTML = '';
    loadPaletteFavs();
    hydrateViewPrefs();
    // Every group starts expanded on the first mount so the palette is not an
    // opaque wall of closed rows.
    if (!Object.keys(paletteOpen).length) {
      PALETTE_GROUPS.forEach(function (g) { paletteOpen[g.id] = true; });
    }

    // ---- search row: input + the ⌘K hint the image shows -------------------
    var searchRow = document.createElement('div');
    searchRow.className = 'palette-searchrow';
    searchRow.innerHTML =
      '<span class="ps-ic" aria-hidden="true">' + IC('search', 13) + '</span>' +
      '<input type="text" class="palette-search" />' +
      '<span class="ps-kbd" aria-hidden="true"><kbd>' + esc(MOD_KEY) + '</kbd>' +
        '<kbd>' + esc(t('pl.shortcut')) + '</kbd></span>';
    var search = searchRow.querySelector('.palette-search');
    search.placeholder = t('pl.search');
    search.value = paletteQuery;
    search.setAttribute('aria-label', t('pl.search'));
    search.addEventListener('input', function () {
      paletteQuery = search.value;
      renderPaletteList();
      // keep focus + caret after re-render
      var el = dom.palette.querySelector('.palette-search');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
    p.appendChild(searchRow);

    var listWrap = document.createElement('div');
    listWrap.className = 'palette-list';
    p.appendChild(listWrap);

    // ---- footer: destinations, Collapse, and the real app version ----------
    var foot = document.createElement('div');
    foot.className = 'palette-foot';
    var linksHtml = PALETTE_LINKS.map(function (l) {
      var attrs = '';
      if (l.route) attrs = ' data-route="' + esc(l.route) + '"';
      else if (l.act) attrs = ' data-pl="' + esc(l.act) + '"';
      if (l.disabled) {
        // Disabled AND explained. A greyed control with a reason is honest; a
        // live-looking one that goes nowhere is not.
        attrs += ' disabled aria-disabled="true" title="' + esc(t(l.disabled)) + '"';
      }
      return '<button type="button" class="pl-link"' + attrs + '>' +
        '<span class="pl-link-ic">' + IC(l.icon, 13) + '</span>' +
        '<span>' + esc(t(l.key)) + '</span></button>';
    }).join('');
    foot.innerHTML = linksHtml +
      '<button type="button" class="pl-link pl-collapse" data-pl="collapse">' +
        '<span class="pl-link-ic">' + IC('panel-left', 13) + '</span>' +
        '<span>' + esc(t('pl.collapse')) + '</span></button>';
    p.appendChild(foot);
    foot.querySelectorAll('[data-route]').forEach(function (b) {
      b.addEventListener('click', function () {
        location.hash = b.getAttribute('data-route');
      });
    });
    var varBtn = foot.querySelector('[data-pl="variables"]');
    if (varBtn) {
      varBtn.addEventListener('click', function () {
        var RP = window.RunPanel;
        // If the drawer is not mounted there is nothing to show, and saying so
        // beats a click that appears to do nothing.
        if (RP && RP.showTab && RP.showTab('variables')) return;
        U().toast(t('pl.varsUnavailable'), 'info');
      });
    }
    var colBtn = foot.querySelector('[data-pl="collapse"]');
    if (colBtn) colBtn.addEventListener('click', function () { setPaletteCollapsed(true); });

    renderPaletteList();
    applyPaletteCollapsed();
  }

  /** One collapsible row: icon · label · count badge · chevron. */
  function paletteGroupHead(g, cat, count, open) {
    var gh = document.createElement('button');
    gh.type = 'button';
    gh.className = 'palette-group-head' + (open ? ' is-open' : '');
    gh.setAttribute('aria-expanded', open ? 'true' : 'false');
    gh.setAttribute('data-group', g.id);
    gh.style.setProperty('--cat-color', cat.color);
    gh.innerHTML =
      '<span class="pg-ic">' + IC(g.icon, 14) + '</span>' +
      '<span class="pg-label">' + esc(paletteGroupLabel(g, cat)) + '</span>' +
      '<span class="pg-count">' + count + '</span>' +
      '<span class="pg-caret">' + IC(open ? 'chevron-up' : 'chevron-down', 12) + '</span>';
    gh.addEventListener('click', function () {
      if (paletteOpen[g.id]) delete paletteOpen[g.id]; else paletteOpen[g.id] = true;
      renderPaletteList();
    });
    return gh;
  }

  function renderPaletteList() {
    var wrap = dom.palette.querySelector('.palette-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    var q = (paletteQuery || '').trim().toLowerCase();
    function matches(a) { return !q || a.id.toLowerCase().indexOf(q) !== -1; }

    // ---- Favorites row (count is REAL: the number of starred blocks) -------
    var favIds = Object.keys(paletteFavs);
    var favActions = ACTIONS.filter(function (a) {
      return paletteFavs[a.id] && matches(a);
    });
    var favOpen = !!paletteOpen.__fav;
    var favHead = document.createElement('button');
    favHead.type = 'button';
    favHead.className = 'palette-group-head pg-fav' + (favOpen ? ' is-open' : '');
    favHead.setAttribute('aria-expanded', favOpen ? 'true' : 'false');
    favHead.innerHTML =
      '<span class="pg-ic pg-star">' + IC('star', 14) + '</span>' +
      '<span class="pg-label">' + esc(t('pl.favorites')) + '</span>' +
      '<span class="pg-count">' + favIds.length + '</span>' +
      '<span class="pg-caret">' + IC(favOpen ? 'chevron-up' : 'chevron-down', 12) + '</span>';
    favHead.addEventListener('click', function () {
      if (paletteOpen.__fav) delete paletteOpen.__fav; else paletteOpen.__fav = true;
      renderPaletteList();
    });
    wrap.appendChild(favHead);
    if (favOpen) {
      var favBody = document.createElement('div');
      favBody.className = 'palette-group-body';
      if (!favActions.length) {
        favBody.innerHTML = '<div class="pg-empty">' + esc(t('pl.noFav')) + '</div>';
      } else {
        favActions.forEach(function (a) { favBody.appendChild(paletteItem(a)); });
      }
      wrap.appendChild(favBody);
    }

    // ---- BLOCKS header ----------------------------------------------------
    var hdr = document.createElement('div');
    hdr.className = 'palette-title';
    hdr.textContent = t('pl.blocks');
    wrap.appendChild(hdr);

    // ---- the six real category rows ---------------------------------------
    var shown = 0;
    PALETTE_GROUPS.forEach(function (g) {
      var members = ACTIONS.filter(function (a) { return (a.cat || 'other') === g.id; });
      if (!members.length) return;     // never render an empty row with a count
      var hits = members.filter(matches);
      // While searching, hide rows with no hits rather than showing "0".
      if (q && !hits.length) return;
      shown += hits.length;
      var cat = (CAT.categoryById && CAT.categoryById(g.id)) ||
        { color: '#6b7280', label: 'cat.other' };
      // A search implicitly expands the matching rows, otherwise results hide.
      var open = q ? true : !!paletteOpen[g.id];
      wrap.appendChild(paletteGroupHead(g, cat, members.length, open));
      if (!open) return;
      var body = document.createElement('div');
      body.className = 'palette-group-body';
      hits.forEach(function (a) { body.appendChild(paletteItem(a)); });
      wrap.appendChild(body);
    });

    // Any catalog category missing from PALETTE_GROUPS would silently vanish,
    // so sweep the leftovers into a final row instead of dropping them.
    var mapped = PALETTE_GROUPS.map(function (g) { return g.id; });
    var leftovers = {};
    ACTIONS.forEach(function (a) {
      var cid = a.cat || 'other';
      if (mapped.indexOf(cid) === -1) (leftovers[cid] = leftovers[cid] || []).push(a);
    });
    Object.keys(leftovers).forEach(function (cid) {
      var members = leftovers[cid];
      var hits = members.filter(matches);
      if (q && !hits.length) return;
      shown += hits.length;
      var cat = (CAT.categoryById && CAT.categoryById(cid)) ||
        { color: '#6b7280', label: 'cat.other' };
      var open = q ? true : !!paletteOpen[cid];
      wrap.appendChild(paletteGroupHead({ id: cid, icon: 'grid' }, cat, members.length, open));
      if (!open) return;
      var b2 = document.createElement('div');
      b2.className = 'palette-group-body';
      hits.forEach(function (a) { b2.appendChild(paletteItem(a)); });
      wrap.appendChild(b2);
    });

    if (q && !shown) {
      var none = document.createElement('div');
      none.className = 'muted small pg-empty';
      none.textContent = t('fe.noNodes');
      wrap.appendChild(none);
    }
  }

  // ---- palette collapse (the footer `Collapse` control) ---------------------
  //
  // Collapsed is NOT an empty gutter with one restore button. The reference
  // shell keeps a narrow ICON RAIL: every category glyph stays visible and
  // clickable, plus a `»` chip that brings the full panel back. Clicking a
  // glyph does the obvious thing — expand, and open that row.
  //
  // The rail is a SEPARATE element and the real palette is merely hidden by CSS,
  // so collapsing still never loses the search text or the open-group set.
  /**
   * G8 — the collapsed rail is a FULL icon column, not one restore chip.
   *
   * `docs/uiux/state-empty-canvas.webp` counts THIRTEEN glyphs on the collapsed
   * left edge, with the `»` expander LAST. Ours reaches the same thirteen out of
   * real surfaces only — no glyph stands for something that does not exist:
   *
   *   1  star          Favorites            (count = starred blocks, real)
   *   2  zap           Triggers             \
   *   3  globe         Browser               |
   *   4  mouse-pointer Web Interaction       |  the six catalog groups, each
   *   5  git-branch    Flow Control          |  with its REAL member count
   *   6  layers        Online Services       |
   *   7  database      Data                 /
   *   8  grid          Templates            \
   *   9  sliders       Variables             |  the same five footer links the
   *  10  link          Connections           |  expanded palette shows, same
   *  11  settings      Settings              |  handlers, same disabled state
   *  12  help-circle   Help & Docs (disabled)/
   *  13  chevron-right Expand
   *
   * A glyph name that is not in the registry renders the `dot` fallback SILENTLY,
   * so `tests/unit/node-toolbox.test.ts` pins every name used here.
   */
  function railBtn(opts) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pl-rail-btn' + (opts.cls ? ' ' + opts.cls : '');
    b.title = opts.name;
    b.setAttribute('aria-label', opts.name);
    if (opts.group) b.setAttribute('data-group', opts.group);
    if (opts.act) b.setAttribute('data-pl', opts.act);
    if (opts.color) b.style.setProperty('--cat-color', opts.color);
    if (opts.disabled) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
    }
    b.innerHTML = IC(opts.icon, 15);
    if (opts.onClick && !opts.disabled) b.addEventListener('click', opts.onClick);
    return b;
  }

  /** Expand the palette, open `groupId`'s row, and scroll it into view. */
  function railOpenGroup(groupId) {
    paletteOpen[groupId] = true;
    setPaletteCollapsed(false);
    renderPaletteList();
    var head = dom.palette.querySelector('.palette-group-head[data-group="' + groupId + '"]');
    if (head && head.scrollIntoView) head.scrollIntoView({ block: 'nearest' });
  }

  function paletteRail() {
    var rail = document.createElement('div');
    rail.className = 'pl-rail';

    // 1 — Favorites. Count is the real number of starred blocks; when nothing is
    // starred the expanded row already explains itself, so the glyph still opens
    // it rather than pretending there is content.
    var favCount = ACTIONS.filter(function (a) { return paletteFavs[a.id]; }).length;
    rail.appendChild(railBtn({
      icon: 'star', cls: 'pl-rail-fav', color: '#F5C542',
      name: t('pl.favorites') + ' · ' + favCount,
      onClick: function () {
        // `__fav` is the same open-state key the expanded Favorites head uses,
        // so the glyph opens the row the user expects instead of a second one.
        paletteOpen.__fav = true;
        setPaletteCollapsed(false);
        renderPaletteList();
        var fav = dom.palette.querySelector('.palette-group-head.pg-fav');
        if (fav && fav.scrollIntoView) fav.scrollIntoView({ block: 'nearest' });
      },
    }));

    PALETTE_GROUPS.forEach(function (g) {
      var members = ACTIONS.filter(function (a) { return (a.cat || 'other') === g.id; });
      if (!members.length) return;     // same rule as the expanded list
      var cat = (CAT.categoryById && CAT.categoryById(g.id)) ||
        { color: '#6b7280', label: 'cat.other' };
      // An icon-only control needs a name, and its count comes from the real
      // members — the rail must not become a second place that can lie.
      rail.appendChild(railBtn({
        icon: g.icon, group: g.id, color: cat.color,
        name: paletteGroupLabel(g, cat) + ' · ' + members.length,
        onClick: function () { railOpenGroup(g.id); },
      }));
    });

    // A hairline between "blocks you can insert" and "places you can go", so the
    // twelve glyphs do not read as one undifferentiated list.
    var sep = document.createElement('span');
    sep.className = 'pl-rail-sep';
    sep.setAttribute('aria-hidden', 'true');
    rail.appendChild(sep);

    // 8..12 — the SAME five footer destinations as the expanded palette, driven
    // by the SAME table, so a route (or a disabled reason) can never be true in
    // one surface and stale in the other.
    PALETTE_LINKS.forEach(function (l) {
      rail.appendChild(railBtn({
        icon: l.icon, act: l.act || null, cls: 'pl-rail-link',
        disabled: !!l.disabled,
        name: l.disabled ? t(l.key) + ' — ' + t(l.disabled) : t(l.key),
        onClick: function () {
          if (l.route) { location.hash = l.route; return; }
          if (l.act === 'variables') {
            var RP = window.RunPanel;
            if (RP && RP.showTab && RP.showTab('variables')) return;
            U().toast(t('pl.varsUnavailable'), 'info');
          }
        },
      }));
    });

    // 13 — the expander, LAST (the image puts `»` at the bottom of the rail).
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pl-restore';
    chip.title = t('pl.expand');
    chip.setAttribute('aria-label', t('pl.expand'));
    chip.innerHTML = IC('chevron-right', 14);
    chip.addEventListener('click', function () { setPaletteCollapsed(false); });
    rail.appendChild(chip);
    return rail;
  }

  function applyPaletteCollapsed() {
    if (!dom || !dom.palette) return;
    var shell = dom.palette.closest ? dom.palette.closest('.fe-layout') : null;
    if (shell) shell.classList.toggle('fe-pal-collapsed', paletteCollapsed);
    var rail = dom.palette.querySelector('.pl-rail');
    if (paletteCollapsed && !rail) {
      dom.palette.appendChild(paletteRail());
    } else if (!paletteCollapsed && rail) {
      rail.parentNode.removeChild(rail);
    }
  }
  function setPaletteCollapsed(on) {
    paletteCollapsed = !!on;
    prefSet('fePaletteCollapsed', paletteCollapsed);
    applyPaletteCollapsed();
    // the canvas box changed width, so the minimap viewport rect is now stale
    renderMinimap();
    publishDockGutter();
  }

  // ---- Canvas-level interactions (pan, box-select, drop, connection) --------
  function attachCanvasHandlers() {
    // background mousedown: Shift = box-select, otherwise pan
    on(dom.canvas, 'mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target !== dom.canvas && ev.target !== dom.svg && ev.target !== dom.world) return;
      // Shift always box-selects, even while the Pan tool is active, so the
      // pan mode never traps the user out of making a selection.
      if (ev.shiftKey) {
        var wp = worldPoint(ev.clientX, ev.clientY);
        drag = { type: 'box', x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y };
        state.selSet = {};
        state.selected = null;
        renderInspector();
        renderNodes();
        renderBoxSelect();
        return;
      }
      drag = { type: 'pan', startX: ev.clientX, startY: ev.clientY,
        ox: state.view.x, oy: state.view.y };
      state.selected = null;
      state.selSet = {};
      renderInspector();
      renderNodes();
    });

    // HTML5 drop: dropping a palette item onto the canvas places a node there.
    on(dom.canvas, 'dragover', function (ev) {
      if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], 'text/ab-action') !== -1) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
      }
    });
    on(dom.canvas, 'drop', function (ev) {
      var aid = ev.dataTransfer && ev.dataTransfer.getData('text/ab-action');
      if (!aid) return;
      ev.preventDefault();
      var wp = worldPoint(ev.clientX, ev.clientY);
      addNode(aid, snap(wp.x - nodeW() / 2), snap(wp.y - 22));
    });

    on(window, 'mousemove', function (ev) {
      if (!drag) return;
      if (drag.type === 'pan') {
        state.view.x = drag.ox + (ev.clientX - drag.startX);
        state.view.y = drag.oy + (ev.clientY - drag.startY);
        applyViewTransform();
      } else if (drag.type === 'move') {
        var wp = worldPoint(ev.clientX, ev.clientY);
        var ddx = wp.x - drag.sx;
        var ddy = wp.y - drag.sy;
        // Commit the pre-drag snapshot on the first real movement, so ONE undo
        // press restores the whole drag (not one press per mousemove event).
        if (!drag.snapshotPushed && (ddx || ddy)) {
          drag.snapshotPushed = true;
          if (!historySuspended) {
            undoStack.push(drag.snapshot);
            if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
            redoStack = [];
          }
        }
        var doSnap = !(ev.altKey); // hold Alt for free (un-snapped) movement
        drag.origins.forEach(function (o) {
          var node = state.nodes[o.id];
          if (!node) return;
          var nx = o.x + ddx;
          var ny = o.y + ddy;
          node.x = doSnap ? snap(nx) : Math.round(nx);
          node.y = doSnap ? snap(ny) : Math.round(ny);
        });
        renderEdges();
        renderNodes();
        renderMinimap();
      } else if (drag.type === 'connect') {
        drag.preview = worldPoint(ev.clientX, ev.clientY);
        renderEdges();
      } else if (drag.type === 'box') {
        var p = worldPoint(ev.clientX, ev.clientY);
        drag.x1 = p.x; drag.y1 = p.y;
        applyBoxSelection();
        renderBoxSelect();
        renderNodes();
      }
    });

    on(window, 'mouseup', function (ev) {
      if (!drag) return;
      if (drag.type === 'connect') {
        // did we drop on an input port / node?
        var el = document.elementFromPoint(ev.clientX, ev.clientY);
        var card = el && el.closest ? el.closest('.flow-node') : null;
        if (card) {
          var toId = card.getAttribute('data-node');
          if (toId) connect(drag.from, toId, drag.fromPort || 'next');
          drag = null;
          renderAll();
          return;
        }
        // Item H, entry point 4: a connection dropped on EMPTY canvas used to be
        // thrown away. It is now read as "I want a node here, attached to this
        // port" — the Add Node palette opens at the drop point and the pick is
        // wired to the port the drag started from.
        var openAt = { x: ev.clientX, y: ev.clientY };
        var dropWorld = worldPoint(ev.clientX, ev.clientY);
        var fromId = drag.from;
        var fromPort = drag.fromPort || 'next';
        drag = null;
        renderAll();
        // Only inside the canvas: releasing over the palette, the toolbar or the
        // minimap means "cancel", not "insert a node behind that widget".
        var onCanvas = !!(el && dom.canvas && dom.canvas.contains(el) &&
          !(el.closest && (el.closest('.fe-canvas-toolbar') || el.closest('.fe-view-pills') ||
            el.closest('.fe-minimap-wrap') || el.closest('.fe-addnode'))));
        if (fromId && state.nodes[fromId] && onCanvas) {
          openAddPalette({
            world: { x: snap(dropWorld.x), y: snap(dropWorld.y - 22) },
            from: { nodeId: fromId, port: fromPort },
            at: openAt,
          });
        }
        return;
      }
      if (drag.type === 'box') {
        drag = null;
        clearBoxSelect();
        renderInspector();
        renderNodes();
        return;
      }
      drag = null;
    });

    // zoom with wheel
    on(dom.canvas, 'wheel', function (ev) {
      ev.preventDefault();
      var v = state.view;
      var delta = ev.deltaY < 0 ? 1.1 : 0.9;
      var newScale = Math.min(2, Math.max(0.4, v.scale * delta));
      // keep mouse-anchored
      var rect = dom.canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left;
      var my = ev.clientY - rect.top;
      v.x = mx - (mx - v.x) * (newScale / v.scale);
      v.y = my - (my - v.y) * (newScale / v.scale);
      v.scale = newScale;
      applyViewTransform();
    });

    // keyboard: Delete removes selection, Ctrl/Cmd+C/V copy-paste.
    // Any click that is not inside the floating node menu dismisses it.
    on(window, 'mousedown', function (ev) {
      // A submenu is a SIBLING of its parent menu (see ctxItem), so "inside the
      // menu" cannot be tested against one element — ask whether the event
      // started inside ANY open menu, otherwise a click on a submenu row would
      // tear the menus down before its own `click` ever fired.
      if (document.querySelector('.fe-ctxmenu') &&
          !(ev.target && ev.target.closest && ev.target.closest('.fe-ctxmenu'))) {
        closeNodeMenu();
      }
      if (document.querySelector('.fe-addnode') &&
          !(ev.target && ev.target.closest &&
            (ev.target.closest('.fe-addnode') || ev.target.closest('.fe-empty-card')))) {
        closeAddPalette();
      }
    });

    on(window, 'keydown', function (ev) {
      if (!dom) return;
      if (ev.key === 'Escape') { closeNodeMenu(); closeInlinePrompt(); closeAddPalette(); }
      // Cmd/Ctrl+K focuses the blocks search — the shortcut the palette
      // advertises. Handled BEFORE the "ignore while typing" guard below, so it
      // still works from inside another field (which is the whole point of it).
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault();
        if (paletteCollapsed) setPaletteCollapsed(false);
        var box = dom.palette && dom.palette.querySelector('.palette-search');
        if (box) { box.focus(); box.select(); }
        return;
      }
      // ignore when typing in a field
      var tag = (ev.target && ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      var meta = ev.ctrlKey || ev.metaKey;
      // Item H: `Tab` opens the floating Add Node palette (the shortcut n8n
      // users already have in their fingers). Only when the editor's own canvas
      // is mounted and nothing is being typed into, so it does not steal the
      // browser's focus traversal from the surrounding shell chrome.
      if (!meta && !ev.shiftKey && !ev.altKey && ev.key === 'Tab' && dom && dom.canvas) {
        ev.preventDefault();
        if (document.querySelector('.fe-addnode')) closeAddPalette();
        else openAddPaletteForSelection();
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (activeSelection().length) { ev.preventDefault(); removeSelection(); }
      } else if (meta && (ev.key === 'c' || ev.key === 'C')) {
        copySelection();
      } else if (meta && (ev.key === 'v' || ev.key === 'V')) {
        ev.preventDefault(); pasteClipboard();
      } else if (meta && (ev.key === 'a' || ev.key === 'A')) {
        ev.preventDefault();
        state.selSet = {};
        Object.keys(state.nodes).forEach(function (id) {
          if (id !== 'start') state.selSet[id] = true;
        });
        renderNodes();
      } else if (!meta && (ev.key === 'v' || ev.key === 'V')) {
        // bare V / H are the tool shortcuts advertised in the toolbar tooltips.
        // Guarded on !meta so Ctrl/Cmd+V above still pastes.
        setTool('select');
      } else if (!meta && (ev.key === 'h' || ev.key === 'H')) {
        setTool('pan');
      }
    });
  }

  // ---- Box selection --------------------------------------------------------
  function boxRect() {
    return {
      minX: Math.min(drag.x0, drag.x1), minY: Math.min(drag.y0, drag.y1),
      maxX: Math.max(drag.x0, drag.x1), maxY: Math.max(drag.y0, drag.y1),
    };
  }
  function applyBoxSelection() {
    var r = boxRect();
    state.selSet = {};
    Object.keys(state.nodes).forEach(function (id) {
      if (id === 'start') return;
      var n = state.nodes[id];
      var cx = n.x + nodeW() / 2, cy = n.y + 22;
      if (cx >= r.minX && cx <= r.maxX && cy >= r.minY && cy <= r.maxY) {
        state.selSet[id] = true;
      }
    });
  }
  function renderBoxSelect() {
    clearBoxSelect();
    if (!drag || drag.type !== 'box') return;
    var r = boxRect();
    var box = document.createElement('div');
    box.className = 'fe-boxselect';
    box.style.left = r.minX + 'px';
    box.style.top = r.minY + 'px';
    box.style.width = (r.maxX - r.minX) + 'px';
    box.style.height = (r.maxY - r.minY) + 'px';
    dom.world.appendChild(box);
  }
  function clearBoxSelect() {
    var ex = dom.world.querySelector('.fe-boxselect');
    if (ex) ex.parentNode.removeChild(ex);
  }

  // ---- Group selection: boundary + action toolbar (item I) -------------------
  //
  // `shell-add-node-palette.md` §2 describes two things that belong together:
  //   * "The selected cluster is surrounded by a blue dashed group boundary."
  //   * a "bottom group toolbar" near that cluster carrying, in order:
  //     Disable · Delete · Clone · Group · Convert Subflow · Add Comment · More
  //
  // The reference screenshot has the NDV modal covering that area, so only the
  // written inventory is locked, not the pixels: the chrome therefore borrows
  // the already-reviewed `.fe-ctxmenu` / canvas-toolbar language instead of
  // inventing a new one.
  //
  // Both elements live INSIDE `dom.world`, so panning and zooming move them
  // with the nodes for free — no listener bookkeeping. The toolbar alone is
  // counter-scaled through `--fe-inv-scale` (published by `applyViewTransform`)
  // so its labels stay legible at 40% as well as at 200% zoom.
  //
  // It appears only for a MULTI selection (2+ nodes): for a single node the
  // kebab context menu already owns every one of these actions, and a second
  // floating widget over one card would just be in the way.
  function selectionBBox(ids) {
    var box = null;
    (ids || []).forEach(function (id) {
      var n = state.nodes[id];
      if (!n) return;
      var x2 = n.x + nodeW(), y2 = n.y + nodeH(n);
      if (!box) { box = { minX: n.x, minY: n.y, maxX: x2, maxY: y2 }; return; }
      box.minX = Math.min(box.minX, n.x);
      box.minY = Math.min(box.minY, n.y);
      box.maxX = Math.max(box.maxX, x2);
      box.maxY = Math.max(box.maxY, y2);
    });
    return box;
  }

  function clearSelectionTools() {
    if (!dom || !dom.world) return;
    ['.fe-selbox', '.fe-seltools'].forEach(function (sel) {
      var ex = dom.world.querySelector(sel);
      if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
    });
  }

  /** One toolbar button. `disabled` rows are visibly dead + carry a tooltip. */
  function selBtn(spec) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'fe-selbtn' + (spec.danger ? ' is-danger' : '') +
      (spec.disabled ? ' is-disabled' : '');
    b.innerHTML = IC(spec.icon, 14) + '<span>' + esc(spec.label) + '</span>';
    if (spec.disabled) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      b.title = spec.hint || spec.label;
    } else {
      b.title = spec.label;
      b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        spec.fn(b);
      });
    }
    return b;
  }

  /** The `More ▸` menu: the group twins of the per-node Advanced submenu. */
  function openSelectionMore(ids, clientX, clientY) {
    closeNodeMenu();
    var allPinned = ids.every(function (id) { return !!nodePins[id]; });
    var menu = document.createElement('div');
    menu.className = 'fe-ctxmenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('sel.more'));
    menu.appendChild(ctxColorRow(ids));
    [
      { icon: 'braces', label: t('sel.copyJson'),
        fn: function () { copySelectionJson(ids); } },
      { icon: 'pin', label: t(allPinned ? 'sel.unpinAll' : 'sel.pinAll'),
        fn: function () { setSelectionPinned(ids, !allPinned); } },
      { icon: 'layout', label: t('sel.alignRow'),
        fn: function () { alignSelection(ids); } },
    ].forEach(function (it) { menu.appendChild(ctxItem(it)); });
    document.body.appendChild(menu);
    var r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(clientX, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(clientY, window.innerHeight - r.height - 8)) + 'px';
    var rows = menu.querySelectorAll('.fe-ctxitem:not(.is-disabled)');
    if (rows.length) rows[0].focus();
  }

  /**
   * Align a selection on its top-most row, evenly spaced along the flow axis.
   * Purely positional, so it is a real, honest action with a single undo step.
   */
  function alignSelection(ids) {
    var list = (ids || []).filter(function (id) { return !!state.nodes[id]; });
    if (list.length < 2) return;
    list.sort(function (a, b) { return state.nodes[a].x - state.nodes[b].x; });
    var y = snap(Math.min.apply(null, list.map(function (id) { return state.nodes[id].y; })));
    var x0 = snap(state.nodes[list[0]].x);
    var gap = snap(nodeW() + 80);
    pushHistory();
    list.forEach(function (id, i) {
      state.nodes[id].x = x0 + i * gap;
      state.nodes[id].y = y;
    });
    renderAll();
  }

  function renderSelectionTools() {
    if (!dom || !dom.world) return;
    clearSelectionTools();
    // Never while a drag is live: a boundary that lags one frame behind the
    // cards it is supposed to wrap reads as a rendering bug.
    if (drag) return;
    var ids = activeSelection();
    if (ids.length < 2) return;
    var box = selectionBBox(ids);
    if (!box) return;

    var pad = 16;
    var frame = document.createElement('div');
    frame.className = 'fe-selbox';
    frame.style.left = (box.minX - pad) + 'px';
    frame.style.top = (box.minY - pad) + 'px';
    frame.style.width = (box.maxX - box.minX + pad * 2) + 'px';
    frame.style.height = (box.maxY - box.minY + pad * 2) + 'px';
    dom.world.appendChild(frame);

    var bar = document.createElement('div');
    bar.className = 'fe-seltools';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', t('sel.toolbar'));
    // Anchored to the bottom-centre of the boundary, per "a compact toolbar
    // appears near the selected group" — the CSS does the -50% / counter-scale.
    bar.style.left = ((box.minX + box.maxX) / 2) + 'px';
    bar.style.top = (box.maxY + pad + 10) + 'px';

    var count = document.createElement('span');
    count.className = 'fe-selcount';
    // Real count, straight off the selection — never a placeholder number.
    count.innerHTML = '<b>' + ids.length + '</b><span>' + esc(t('sel.selected')) + '</span>';
    bar.appendChild(count);

    var allOff = ids.every(function (id) { return state.nodes[id].disabled === true; });
    [
      { icon: allOff ? 'eye' : 'eye-off', label: t(allOff ? 'sel.enable' : 'sel.disable'),
        fn: function () { setSelectionDisabled(ids, !allOff); } },
      { icon: 'trash', label: t('sel.delete'), danger: true,
        fn: function () { removeSelection(); } },
      { icon: 'copy', label: t('sel.clone'),
        // The clipboard path already duplicates internal edges + annotations
        // and moves the selection onto the copies, so a group clone is exactly
        // a copy followed by a paste — not a second, drifting implementation.
        fn: function () { copySelection(); pasteClipboard(); } },
      // No frame/container concept exists in the graph model yet, so this is
      // rendered dead with a tooltip rather than pretending to work.
      { icon: 'frame', label: t('sel.group'), disabled: true, hint: t('sel.groupSoon') },
      { icon: 'sitemap', label: t('fe.convertSubflow'), disabled: true,
        hint: t('fe.convertSubflowSoon') },
      { icon: 'message-square', label: t('fe.addComment'), fn: function (btn) {
        var r = btn.getBoundingClientRect();
        openInlinePrompt({
          title: t('fe.addComment'), value: '', multiline: true,
          x: r.left, y: r.bottom + 6,
          onOk: function (v) { setSelectionComment(ids, v); },
        });
      } },
      { icon: 'more-vertical', label: t('sel.more'), fn: function (btn) {
        var r = btn.getBoundingClientRect();
        openSelectionMore(ids, r.left, r.bottom + 6);
      } },
    ].forEach(function (spec) { bar.appendChild(selBtn(spec)); });
    dom.world.appendChild(bar);
  }

  // ---- Canvas overlay: view-action pills + floating toolbar + minimap --------
  // Items F + G of the uiux gap list.
  //
  // CORRECTED 2026-07-29 against the refreshed `docs/uiux/state-empty-canvas.webp`
  // (1672x941) and re-checked against `shell-editor-launcher-menu.webp`. BOTH
  // images place the tool/zoom cluster at the TOP-END of the canvas, not the
  // bottom-start the older spec described, and the refreshed image shows the two
  // LABELLED view actions as their own pill row sitting ABOVE that cluster:
  //
  //   ( Auto Layout )( Focus Mode )        <- row 1, top-end
  //   [ ✋ ][ ⛶ ] │ [-] 100% [+]            <- row 2, directly beneath
  //
  // So there are now THREE clusters:
  //   * top-end    — `.fe-view-pills`, the two labelled pills.
  //   * top-end    — `.fe-canvas-toolbar`, pointer tools + zoom cluster.
  //   * bottom-end — the minimap, with a real titled header ("MINIMAP"), its own
  //     [+]/[-]/Fit buttons and a close [x] that collapses it to a restore chip.
  //
  // `data-view` handlers are bound once over the whole canvas overlay, so moving
  // a button between clusters cannot silently unbind it.
  function buildOverlay(canvas) {
    // ---- Row 1: labelled view actions (top-end) -----------------------------
    var pills = document.createElement('div');
    pills.className = 'fe-view-pills';
    pills.setAttribute('role', 'group');
    pills.setAttribute('aria-label', esc(t('fe.canvasTools')));
    pills.innerHTML =
      // Item H's canvas entry point. It leads the row because "add a node" is
      // the most common thing anyone does on a canvas, and it is the affordance
      // the empty-state card promises once the canvas is no longer empty.
      '<button class="fe-tb-btn fe-view-pill is-primary" data-view="addnode" title="' +
        esc(t('an.hintKeys')) + '">' +
        IC('plus') + '<span>' + esc(t('an.title')) + '</span></button>' +
      '<button class="fe-tb-btn fe-view-pill" data-view="autolayout" title="' +
        esc(t('fe.autoLayoutHint')) + '">' +
        IC('layout') + '<span>' + esc(t('fe.autoLayout')) + '</span></button>' +
      '<button class="fe-tb-btn fe-view-pill" data-view="focus" aria-pressed="false"' +
        ' title="' + esc(t('fe.focusModeHint')) + '">' +
        IC('target') + '<span>' + esc(t('fe.focusMode')) + '</span></button>';
    canvas.appendChild(pills);

    // ---- Row 2: G, floating canvas toolbar (top-end, below the pills) -------
    var ctrl = document.createElement('div');
    ctrl.className = 'fe-zoom-ctrl fe-canvas-toolbar';
    ctrl.setAttribute('role', 'toolbar');
    ctrl.setAttribute('aria-label', esc(t('fe.canvasTools')));
    ctrl.innerHTML =
      // pointer tools — radio-like group, so aria-pressed is the right state
      '<div class="fe-tb-group" role="group">' +
        '<button class="fe-zbtn fe-tool" data-tool="select" aria-pressed="true"' +
          ' title="' + esc(t('fe.toolSelect')) + '">' + IC('mouse-pointer-2') + '</button>' +
        '<button class="fe-zbtn fe-tool" data-tool="pan" aria-pressed="false"' +
          ' title="' + esc(t('fe.toolPan')) + '">' + IC('hand') + '</button>' +
        '<button class="fe-zbtn fe-tool" data-tool="lock" aria-pressed="false"' +
          ' title="' + esc(t('fe.toolLock')) + '">' + IC('lock') + '</button>' +
        '<button class="fe-zbtn fe-tool" data-tool="grid" aria-pressed="true"' +
          ' title="' + esc(t('fe.toolFrame')) + '">' + IC('frame') + '</button>' +
        // Fullscreen stays with the icon-only tools (it has no label in either
        // image); the labelled pills above own Auto Layout / Focus Mode.
        '<button class="fe-zbtn" data-view="fullscreen" title="' + esc(t('fe.fullscreen')) + '">' + IC('maximize') + '</button>' +
      '</div>' +
      '<span class="fe-tb-sep" aria-hidden="true"></span>' +
      // zoom cluster
      '<div class="fe-tb-group" role="group">' +
        '<button class="fe-zbtn" data-z="out" title="' + esc(t('fe.zoomOut')) + '">' + IC('minus') + '</button>' +
        '<button class="fe-zoom-label" data-z="reset" title="' + esc(t('fe.zoomReset')) + '">100%</button>' +
        '<button class="fe-zbtn" data-z="in" title="' + esc(t('fe.zoomIn')) + '">' + IC('plus') + '</button>' +
        '<button class="fe-zbtn" data-z="fit" title="' + esc(t('fe.fit')) + '">' + IC('maximize') + '</button>' +
      '</div>' +
      '';
    canvas.appendChild(ctrl);
    var zoomLabel = ctrl.querySelector('.fe-zoom-label');

    // zoom cluster + the icon-only view action share the .fe-zbtn class, so
    // bind by the attribute that is actually present rather than by class.
    ctrl.querySelectorAll('[data-z]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var z = b.getAttribute('data-z');
        if (z === 'in') zoomBy(1.2);
        else if (z === 'out') zoomBy(1 / 1.2);
        else if (z === 'reset') resetZoom();
        else fitToScreen();
      });
      b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    });

    ctrl.querySelectorAll('.fe-tool').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        setTool(b.getAttribute('data-tool'));
      });
      b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    });

    // View actions now live in TWO clusters (the labelled pills row and the
    // icon-only toolbar), so bind across both rather than inside `ctrl` only —
    // otherwise Auto Layout / Focus Mode would render but do nothing.
    [pills, ctrl].forEach(function (host) {
      host.querySelectorAll('[data-view]').forEach(function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var v = b.getAttribute('data-view');
          if (v === 'addnode') {
            var br = b.getBoundingClientRect();
            openAddPaletteForSelection({ x: br.left - 220, y: br.bottom + 8 });
          } else if (v === 'autolayout') autoLayout();
          else if (v === 'focus') toggleFocusMode();
          else toggleFullscreen();
        });
        b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      });
    });

    // ---- F: minimap with a real header (bottom-end corner) -----------------
    var wrap = document.createElement('div');
    wrap.className = 'fe-minimap-wrap';
    // Layout corrected 2026-07-30 against `state-empty-canvas.webp`: the head
    // carries ONLY the title and the close [x], while [+] / [-] / Fit form a
    // VERTICAL column on the map's end edge (the image stacks them there, with
    // `Fit` spelled out as a word rather than drawn as an icon). The click
    // handler below binds by `[data-mm]` across the whole wrapper, so moving a
    // button between the head and the column cannot silently unbind it.
    wrap.innerHTML =
      '<div class="fe-mm-head">' +
        '<span class="fe-mm-title">' + IC('map') + '<span>' + esc(t('fe.minimap')) + '</span></span>' +
        '<span class="fe-mm-actions">' +
          '<button class="fe-mm-btn fe-mm-close" data-mm="close" title="' + esc(t('fe.minimapHide')) + '">' + IC('x', 12) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="fe-mm-body">' +
        '<div class="fe-minimap"></div>' +
        '<span class="fe-mm-zoom" role="group" aria-label="' + esc(t('fe.canvasTools')) + '">' +
          '<button class="fe-mm-btn" data-mm="in" title="' + esc(t('fe.zoomIn')) + '"' +
            ' aria-label="' + esc(t('fe.zoomIn')) + '">' + IC('plus', 13) + '</button>' +
          '<button class="fe-mm-btn" data-mm="out" title="' + esc(t('fe.zoomOut')) + '"' +
            ' aria-label="' + esc(t('fe.zoomOut')) + '">' + IC('minus', 13) + '</button>' +
          '<button class="fe-mm-btn fe-mm-fit" data-mm="fit" title="' + esc(t('fe.fit')) + '">' +
            esc(t('fe.fitShort')) + '</button>' +
        '</span>' +
      '</div>';
    canvas.appendChild(wrap);

    // collapsed restore chip — hidden until the minimap is closed
    var chip = document.createElement('button');
    chip.className = 'fe-mm-restore';
    chip.setAttribute('hidden', 'hidden');
    chip.setAttribute('title', esc(t('fe.minimapShow')));
    chip.innerHTML = IC('map') + '<span>' + esc(t('fe.minimap')) + '</span>';
    canvas.appendChild(chip);

    wrap.querySelectorAll('[data-mm]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var a = b.getAttribute('data-mm');
        if (a === 'in') zoomBy(1.2);
        else if (a === 'out') zoomBy(1 / 1.2);
        else if (a === 'fit') fitToScreen();
        else setMinimapOpen(false);
      });
      b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    });
    chip.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setMinimapOpen(true);
    });
    chip.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });

    var mm = wrap.querySelector('.fe-minimap');
    mm.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    // click minimap to recentre the viewport on that world point
    mm.addEventListener('click', function (ev) {
      var bb = nodesBBox();
      if (!bb) return;
      var W = mm.clientWidth, H = mm.clientHeight, pad = 12;
      var scale = Math.min((W - pad) / Math.max(1, bb.w), (H - pad) / Math.max(1, bb.h));
      var offX = (W - bb.w * scale) / 2, offY = (H - bb.h * scale) / 2;
      var rect = mm.getBoundingClientRect();
      var wx = bb.minX + (ev.clientX - rect.left - offX) / scale;
      var wy = bb.minY + (ev.clientY - rect.top - offY) / scale;
      var crect = dom.canvas.getBoundingClientRect();
      state.view.x = crect.width / 2 - wx * state.view.scale;
      state.view.y = crect.height / 2 - wy * state.view.scale;
      applyViewTransform();
    });

    return { zoomLabel: zoomLabel, minimap: mm, zoomCtrl: ctrl,
      minimapWrap: wrap, minimapRestore: chip, toolbar: ctrl,
      viewPills: pills };
  }

  // ---- Canvas chrome behaviour (items F + G) --------------------------------
  // Pointer tool. 'lock'/'grid' are toggles that live in the same visual group
  // as the two real pointer modes (that is how the previews draw them), so the
  // handler splits them apart rather than treating all four as radios.
  function setTool(tool) {
    if (tool === 'lock') { canvasLocked = !canvasLocked; }
    else if (tool === 'grid') { gridVisible = !gridVisible; }
    else { canvasTool = (tool === 'pan') ? 'pan' : 'select'; }
    syncChrome();
  }

  // Reflect all four chrome flags onto the DOM. Cheap enough to call on every
  // toggle, and keeps aria-pressed honest for screen readers.
  function syncChrome() {
    if (!dom || !dom.toolbar) return;
    dom.toolbar.querySelectorAll('.fe-tool').forEach(function (b) {
      var tl = b.getAttribute('data-tool');
      var on = tl === 'lock' ? canvasLocked
        : tl === 'grid' ? gridVisible
        : canvasTool === tl;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-active', !!on);
      if (tl === 'lock') b.title = t(canvasLocked ? 'fe.toolLockOff' : 'fe.toolLock');
    });
    if (dom.canvas) {
      dom.canvas.classList.toggle('fe-tool-pan', canvasTool === 'pan');
      dom.canvas.classList.toggle('fe-locked', canvasLocked);
      dom.canvas.classList.toggle('fe-nogrid', !gridVisible);
    }
  }

  function setMinimapOpen(open) {
    minimapOpen = !!open;
    if (!dom) return;
    if (dom.minimapWrap) dom.minimapWrap.hidden = !minimapOpen;
    if (dom.minimapRestore) dom.minimapRestore.hidden = minimapOpen;
    if (minimapOpen) renderMinimap();
  }

  // Zoom back to exactly 100% about the canvas centre (the previews make the
  // "100%" pill itself the reset affordance).
  function resetZoom() {
    if (!dom) return;
    zoomBy(1 / state.view.scale);
  }

  // Auto Layout: hand the graph to the serializer's own left-to-right layout so
  // the canvas matches exactly what a saved-then-reloaded workflow looks like.
  // Round-tripping through steps[] is deliberate — one layout implementation,
  // not two that can drift. Nodes unreachable from `start` are not part of
  // steps[], so they are re-parked in a tidy row underneath instead of lost.
  function autoLayout() {
    if (!dom || !GS()) return;
    var before = Object.keys(state.nodes).length;
    var steps = toSteps();
    var laid = GS().stepsToGraph(steps || []);
    if (!laid || !laid.nodes || !laid.nodes.start) return;
    // Auto Layout rewrites every coordinate at once — the single most valuable
    // thing to be able to undo, so record before touching anything.
    pushHistory();

    // carry the pre-layout selection over by position in the main chain
    var keepSel = state.selected;
    var view = state.view;

    // orphans: nodes the serializer never saw (no path from start)
    var reachable = {};
    (function walk(id, guard) {
      if (!id || reachable[id] || guard > 5000) return;
      reachable[id] = true;
      state.edges.forEach(function (e) {
        if (e.from === id) walk(e.to, guard + 1);
      });
    })('start', 0);
    var orphans = Object.keys(state.nodes).filter(function (id) {
      return id !== 'start' && !reachable[id];
    }).map(function (id) { return state.nodes[id]; });

    state.nodes = laid.nodes;
    state.edges = laid.edges;
    state.nextId = laid.nextId || before + orphans.length;
    state.view = view;
    state.selected = state.nodes[keepSel] ? keepSel : null;
    state.selSet = {};

    if (orphans.length) {
      var bb = nodesBBox();
      var ox = 280;
      var oy = snap((bb ? bb.maxY : 200) + 120);
      orphans.forEach(function (n) {
        state.nodes[n.id] = n;
        n.x = snap(ox); n.y = oy;
        ox += 260;
      });
    }

    renderAll();
    fitToScreen();
    saveLocal();
  }

  // Focus Mode collapses the palette + inspector so the graph gets the full
  // width. The class goes on the shell (`.fe-layout`), which owns the grid
  // template; CSS does the rest so there is no layout maths here.
  function toggleFocusMode() {
    if (!dom) return;
    var shell = dom.canvas.closest ? dom.canvas.closest('.fe-layout') : null;
    if (!shell) return;
    var on = !shell.classList.contains('fe-focus');
    shell.classList.toggle('fe-focus', on);
    // The Focus pill moved out of `dom.toolbar` into the labelled pills row, so
    // look in both — scoping to the toolbar alone would silently stop updating
    // the pressed state.
    var btn = (dom.viewPills && dom.viewPills.querySelector('[data-view="focus"]')) ||
      (dom.toolbar && dom.toolbar.querySelector('[data-view="focus"]'));
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
    }
    // the canvas box changed size, so the minimap viewport rect is now stale
    renderMinimap();
  }

  // Fullscreen is best-effort: the Fullscreen API is unavailable in some
  // embedded/iframe contexts, so a rejection must not break the toolbar.
  function toggleFullscreen() {
    if (!dom) return;
    var el = (dom.canvas.closest && dom.canvas.closest('.fe-layout')) || dom.canvas;
    try {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
      } else if (el.requestFullscreen) {
        var p = el.requestFullscreen();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* not available — ignore */ }
  }

  // ---- Public mount / unmount ----------------------------------------------
  // root: the .fe-canvas element; refs: { palette, inspector }
  function mount(refs) {
    state = newGraph();
    loadLocal(); // restore previous graph if any

    dom = {
      canvas: refs.canvas,
      svg: refs.svg,
      world: refs.world,
      palette: refs.palette,
      inspector: refs.inspector,
    };

    // remove any stale overlay from a previous mount, then build a fresh one.
    // `.fe-minimap` is now nested inside `.fe-minimap-wrap`, so the wrapper and
    // the restore chip have to be swept too or they pile up on every re-mount.
    var stale = refs.canvas.querySelectorAll(
      '.fe-view-pills, .fe-zoom-ctrl, .fe-canvas-toolbar, .fe-minimap-wrap,' +
      ' .fe-minimap, .fe-mm-restore');
    Array.prototype.forEach.call(stale, function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    var ov = buildOverlay(refs.canvas);
    dom.zoomLabel = ov.zoomLabel;
    dom.minimap = ov.minimap;
    dom.minimapWrap = ov.minimapWrap;
    dom.minimapRestore = ov.minimapRestore;
    dom.toolbar = ov.toolbar;
    dom.viewPills = ov.viewPills;

    renderPalette();
    attachCanvasHandlers();
    syncChrome();
    setMinimapOpen(minimapOpen);
    renderAll();
  }

  function unmount() {
    closeNdv();
    closeNodeMenu();
    offAll();
    drag = null;
    dom = null;
    // The shell that subscribed is being torn down with the view; keeping its
    // callbacks would leak a closure over dead DOM on every navigation.
    chromeListeners = [];
    // keep `state` so re-entering the view keeps the graph in memory too
  }

  window.FlowEditor = {
    mount: mount,
    unmount: unmount,
    toSteps: toSteps,
    loadSteps: loadSteps,
    saveLocal: saveLocal,
    loadLocal: function () { var ok = loadLocal(); clearHistory(); if (dom) renderAll(); return ok; },
    reset: function () { state = newGraph(); clearHistory(); if (dom) renderAll(); },
    getState: function () { return state; },
    ACTIONS: ACTIONS,

    // ---- Item A: undo / redo + shell subscription -------------------------
    // History is a bounded stack of the SAME serialized JSON that saveLocal()
    // writes, so undo can never restore a shape the editor cannot load. It is
    // cleared whenever the DOCUMENT changes identity (open / new / reset /
    // loadLocal): undoing across two different workflows would silently paste
    // one workflow's nodes into another.
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    /** Subscribe to graph changes (OUTLINE panel, undo/redo enablement). */
    onChange: onChange,
    /**
     * The numbered nested OUTLINE rows for the current graph
     * (docs/uiux/shell-editor-click-ndv.md § 2). Derived, never stored.
     */
    outline: function () {
      return GS() && GS().outlineTree ? GS().outlineTree(state) : [];
    },
    /** Human title of a node id — the outline renders the same label as the card. */
    nodeLabel: function (nodeId) {
      var n = state && state.nodes ? state.nodes[nodeId] : null;
      return n ? nodeTitle(n) : '';
    },
    /** Selected node id, so the outline can mirror the canvas selection. */
    getSelected: function () { return state ? state.selected : null; },
    /**
     * Re-measure the canvas' start gutter into `--fe-dock-start`. The shell
     * calls this after collapsing the OUTLINE rail — that rail lives in
     * views.js, so the editor cannot observe the change itself, and without the
     * re-measure the docked ACTIVITY LOG would keep a 236px gap that is no
     * longer there.
     */
    syncDock: publishDockGutter,
    /** Select a node AND bring it into view — the outline is a navigator (§ 6). */
    revealNode: function (nodeId) {
      if (!state || !state.nodes[nodeId]) return false;
      selectNode(nodeId);
      if (dom) centerOnNode(nodeId);
      return true;
    },

    // ---- Step 23: viewport + visual node status ---------------------------
    fitToScreen: function () { fitToScreen(); },
    zoomIn: function () { zoomBy(1.2); },
    zoomOut: function () { zoomBy(1 / 1.2); },
    // Paint a node's halo: ref = nodeId | chain step index; status =
    // 'idle' | 'running' | 'success' | 'error'.
    setNodeStatus: setNodeStatus,
    clearStatuses: clearStatuses,

    // ---- Item N: per-node run ---------------------------------------------
    // `chainStepIndex(nodeId)` is the node's index in toSteps() (-1 when it has
    // no step); `runNode(nodeId)` executes the chain prefix ending there.
    chainStepIndex: chainStepIndex,
    stepChainIds: stepChainIds,
    runNodeBlockedReason: runNodeBlockedReason,
    runNode: runNode,

    // ---- Step 25: NDV per-node results (INPUT/OUTPUT columns) -------------
    // The live runner (Step 26) calls setNodeResults(nodeId, { input, output })
    // with arrays of WorkflowItem-shaped objects; the NDV re-renders if open.
    setNodeResults: function (nodeId, res) {
      if (!nodeId) return;
      nodeResults[nodeId] = res || {};
      if (dom && state && ndvOpen === nodeId) renderInspector();
    },
    clearResults: function () {
      nodeResults = {}; nodeMeta = {}; nodePins = {};
      if (dom) { renderNodes(); renderInspector(); }
    },

    // ---- Step 26: live run wiring by chain index --------------------------
    // The live runner addresses nodes by their 0-based position in the STEP
    // list, so these helpers resolve through stepChainIds() (enabled nodes
    // only) — never chainNodeIds(), which keeps disabled nodes and would shift
    // every index after one by one card (09-HANDOFF § 3.1).
    //
    // res = { output:[...items], meta:{ outputItemCount, inputItemCount,
    //         durationMs, status, error } }. Stores OUTPUT items for the NDV
    // and the meta that drives the on-node success/error badge.
    setNodeResultsByIndex: function (chainIndex0, res) {
      if (typeof chainIndex0 !== 'number') return;
      var ids = stepChainIds();
      var id = ids[chainIndex0];
      if (!id || !state.nodes[id]) return;
      res = res || {};
      // preserve any existing input (derived) while updating output/meta
      var prev = nodeResults[id] || {};
      nodeResults[id] = {
        input: Array.isArray(res.input) ? res.input : prev.input,
        output: Array.isArray(res.output) ? res.output : (prev.output || []),
      };
      if (res.meta) nodeMeta[id] = res.meta;
      if (dom) {
        renderNodes();
        if (state.selected === id) renderInspector();
      }
    },
    // Select the chain node at a 0-based index and open its NDV.
    selectByChainIndex: function (chainIndex0) {
      if (typeof chainIndex0 !== 'number') return;
      var ids = stepChainIds();
      var id = ids[chainIndex0];
      if (!id || !state.nodes[id]) return;
      selectNode(id);
    },
    // Pin / unpin a chain node (0-based) — shows a 📌 on the card.
    pinByIndex: function (chainIndex0, on) {
      var ids = stepChainIds();
      var id = ids[chainIndex0];
      if (!id) return;
      if (on === false) delete nodePins[id]; else nodePins[id] = true;
      if (dom) renderNodes();
    },
    isPinnedByIndex: function (chainIndex0) {
      var ids = stepChainIds();
      var id = ids[chainIndex0];
      return !!(id && nodePins[id]);
    },

    // ---- Step 24: graph validation ----------------------------------------
    // { ok, errors:[{code,nodeId?,message}], warnings:[...] } — message values
    // are i18n keys (val.*) the caller can translate.
    validate: validate,

    // ---- Step 22: saved-workflow context ----------------------------------
    // Open a saved workflow: rebuild the graph from its steps and remember its
    // identity so a subsequent Save does a PUT (version bump) rather than create.
    openWorkflow: function (meta, steps) {
      currentWorkflow = meta
        ? {
            id: meta.id,
            name: meta.name,
            description: meta.description || '',
            version: meta.version,
            headless: meta.headless,
            webhookUrl: meta.webhookUrl,
          }
        : null;
      loadSteps(steps || []);
      if (dom) renderAll();
    },
    // Begin editing a brand-new, unsaved workflow (clears the canvas + context).
    newWorkflow: function () {
      currentWorkflow = null;
      state = newGraph();
      if (dom) renderAll();
    },
    getCurrentWorkflow: function () { return currentWorkflow; },
    setCurrentWorkflow: function (meta) {
      currentWorkflow = meta || null;
      // Any successful save stamps the status bar's "Last saved" cell.
      lastSavedAt = meta ? clockLabel(new Date()) : null;
    },
    // `HH:MM:SS` of the last successful save, or null if nothing saved yet.
    getLastSavedAt: function () { return lastSavedAt; },
  };
})();
