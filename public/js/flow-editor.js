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
  var paletteCollapsed = false;  // the `Collapse` control at the footer

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
  function applyViewTransform() {
    var v = state.view;
    dom.world.style.transform =
      'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.scale + ')';
    dom.svg.style.transform = dom.world.style.transform;
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
  function fitToScreen() {
    var bb = nodesBBox();
    if (!bb || !dom) return;
    var rect = dom.canvas.getBoundingClientRect();
    var pad = 60;
    var sx = (rect.width - pad * 2) / Math.max(1, bb.w);
    var sy = (rect.height - pad * 2) / Math.max(1, bb.h);
    var scale = Math.min(2, Math.max(0.4, Math.min(sx, sy)));
    state.view.scale = scale;
    state.view.x = pad - bb.minX * scale + (rect.width - pad * 2 - bb.w * scale) / 2;
    state.view.y = pad - bb.minY * scale + (rect.height - pad * 2 - bb.h * scale) / 2;
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
  function renderMinimap() {
    if (!dom || !dom.minimap) return;
    var mm = dom.minimap;
    var W = mm.clientWidth || 160, H = mm.clientHeight || 110;
    var bb = nodesBBox();
    // clear
    while (mm.firstChild) mm.removeChild(mm.firstChild);
    if (!bb) return;
    var pad = 12;
    var scale = Math.min((W - pad) / Math.max(1, bb.w), (H - pad) / Math.max(1, bb.h));
    var offX = (W - bb.w * scale) / 2;
    var offY = (H - bb.h * scale) / 2;
    function mapX(x) { return offX + (x - bb.minX) * scale; }
    function mapY(y) { return offY + (y - bb.minY) * scale; }

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

    // viewport rectangle (the visible canvas area mapped into world coords)
    var rect = dom.canvas.getBoundingClientRect();
    var v = state.view;
    var vx = (-v.x) / v.scale, vy = (-v.y) / v.scale;
    var vw = rect.width / v.scale, vh = rect.height / v.scale;
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
      (selected ? ' selected' : '') + ' status-' + status;
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
    card.style.setProperty('--cat-color', cat.color);

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

  // ---- node context menu (kebab / right-click) ------------------------------
  // Inventory taken from docs/uiux/shell-add-node-palette.md: Clone · Rename ·
  // Disable · Pin · Delete. Items whose backend/UI support does not exist yet
  // are simply not listed — an unimplemented menu row is worse than no row.
  function closeNodeMenu() {
    var ex = document.querySelector('.fe-ctxmenu');
    if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
  }

  function openNodeMenu(nodeId, clientX, clientY) {
    closeNodeMenu();
    var node = state && state.nodes[nodeId];
    if (!node || node.action === '__start__') return;

    var menu = document.createElement('div');
    menu.className = 'fe-ctxmenu';
    var items = [
      { icon: 'copy', label: t('fe.cloneNode'), fn: function () {
        state.selSet = {}; state.selSet[nodeId] = true; state.selected = nodeId;
        copySelection(); pasteClipboard();
      } },
      { icon: 'sliders', label: t('ndv.open'), fn: function () { openNdv(nodeId); } },
      { icon: 'pin',
        label: nodePins[nodeId] ? t('fe.unpinNode') : t('fe.pinNode'),
        fn: function () {
          if (nodePins[nodeId]) delete nodePins[nodeId]; else nodePins[nodeId] = true;
          renderNodes();
        } },
      { sep: true },
      { icon: 'trash', label: t('fe.deleteNode'), danger: true,
        fn: function () { removeNode(nodeId); } },
    ];

    items.forEach(function (it) {
      if (it.sep) {
        var sep = document.createElement('div');
        sep.className = 'fe-ctxsep';
        menu.appendChild(sep);
        return;
      }
      var b = document.createElement('button');
      b.className = 'fe-ctxitem' + (it.danger ? ' is-danger' : '');
      b.innerHTML = '<span class="fe-ctxicon">' + IC(it.icon) + '</span>' +
        '<span>' + esc(it.label) + '</span>';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeNodeMenu();
        it.fn();
      });
      menu.appendChild(b);
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
  }

  function renderNodes() {
    // wipe existing node cards (keep svg + world container)
    var cards = dom.world.querySelectorAll('.flow-node');
    Array.prototype.forEach.call(cards, function (c) {
      if (c.parentNode === dom.world) dom.world.removeChild(c);
    });
    Object.keys(state.nodes).forEach(function (id) { renderNode(state.nodes[id]); });
    renderEmptyState();
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
    cta.addEventListener('click', function () {
      var s = dom.palette && dom.palette.querySelector('.palette-search');
      if (s) s.focus();
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
  var NODE_DISPLAY_NAMES = {
    click: 'nk.clickElement',
    if: 'nk.condition',
    while: 'nk.whileLoop',
    launch: 'nk.launchBrowser',
    'wait-element': 'nk.waitElement',
    delay: 'nk.delay',
    'close-browser': 'nk.closeBrowser',
    'extract-data': 'nk.extractData',
    'parse-json': 'nk.parseJson',
    goto: 'nk.openUrl',
    'http-request': 'nk.httpRequest',
    trigger_webhook: 'nk.webhookTrigger',
    trigger_manual: 'nk.manualTrigger',
    trigger_schedule: 'nk.scheduleTrigger',
  };
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
    runBtn.addEventListener('click', function () {
      closeNdv();
      var r = document.getElementById('fe-run');
      if (r) r.click();
    });
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

  function setNodeStatus(ref, status) {
    if (!state) return;
    var id = ref;
    if (typeof ref === 'number') {
      var ids = chainNodeIds();
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

  // ---- Copy / paste ---------------------------------------------------------
  function copySelection() {
    var ids = activeSelection();
    if (!ids.length) return;
    var idset = {};
    ids.forEach(function (id) { idset[id] = true; });
    clipboard = {
      nodes: ids.map(function (id) {
        var n = state.nodes[id];
        return { action: n.action, params: JSON.parse(JSON.stringify(n.params || {})),
          x: n.x, y: n.y };
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
      state.nodes[id] = { id: id, action: c.action,
        params: JSON.parse(JSON.stringify(c.params || {})),
        x: snap(c.x + 40), y: snap(c.y + 40) };
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

  function paletteItem(a) {
    var cat = categoryOf(a.id);
    var item = document.createElement('div');
    item.className = 'palette-item';
    item.setAttribute('data-action', a.id);
    item.setAttribute('draggable', 'true');
    item.style.setProperty('--cat-color', cat.color);
    var starred = !!paletteFavs[a.id];
    // The row is a button-like surface plus its own star toggle, so the star
    // is a real nested <button> rather than a click-position heuristic.
    item.innerHTML = '<span class="pi-dot" aria-hidden="true"></span>' +
      '<span class="pi-icon">' + ICON(a.id) + '</span>' +
      '<span class="pi-label">' + esc(a.id) + '</span>' +
      '<button type="button" class="pi-star' + (starred ? ' on' : '') + '"' +
        ' aria-pressed="' + (starred ? 'true' : 'false') +
        '" title="' + esc(t(starred ? 'pl.unfav' : 'pl.fav')) + '">' +
        IC('star', 12) + '</button>';
    item.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.pi-star')) return;
      placeNewNode(a.id);
    });
    var star = item.querySelector('.pi-star');
    if (star) star.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (paletteFavs[a.id]) delete paletteFavs[a.id]; else paletteFavs[a.id] = true;
      savePaletteFavs();
      renderPaletteList();
    });
    // HTML5 drag-and-drop onto the canvas
    item.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.setData('text/ab-action', a.id);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    return item;
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
  var PALETTE_GROUPS = [
    { id: 'trigger',     icon: 'zap' },
    { id: 'navigation',  icon: 'globe' },
    { id: 'interaction', icon: 'mouse-pointer' },
    { id: 'flow',        icon: 'git-branch' },
    { id: 'integration', icon: 'layers' },
    { id: 'data',        icon: 'database' },
  ];

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
      '<span class="pg-label">' + esc(t(cat.label)) + '</span>' +
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
  function applyPaletteCollapsed() {
    if (!dom || !dom.palette) return;
    var shell = dom.palette.closest ? dom.palette.closest('.fe-layout') : null;
    if (shell) shell.classList.toggle('fe-pal-collapsed', paletteCollapsed);
    // A collapsed rail keeps ONE affordance: the restore button. Rebuilding the
    // whole palette would lose the search text and the open-group set.
    var chip = dom.palette.querySelector('.pl-restore');
    if (paletteCollapsed && !chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'pl-restore';
      chip.title = t('pl.expand');
      chip.setAttribute('aria-label', t('pl.expand'));
      chip.innerHTML = IC('panel-left', 14);
      chip.addEventListener('click', function () { setPaletteCollapsed(false); });
      dom.palette.appendChild(chip);
    } else if (!paletteCollapsed && chip) {
      chip.parentNode.removeChild(chip);
    }
  }
  function setPaletteCollapsed(on) {
    paletteCollapsed = !!on;
    applyPaletteCollapsed();
    // the canvas box changed width, so the minimap viewport rect is now stale
    renderMinimap();
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
        }
        drag = null;
        renderAll();
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
      var m = document.querySelector('.fe-ctxmenu');
      if (m && !m.contains(ev.target)) closeNodeMenu();
    });

    on(window, 'keydown', function (ev) {
      if (!dom) return;
      if (ev.key === 'Escape') closeNodeMenu();
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
          if (v === 'autolayout') autoLayout();
          else if (v === 'focus') toggleFocusMode();
          else toggleFullscreen();
        });
        b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      });
    });

    // ---- F: minimap with a real header (bottom-end corner) -----------------
    var wrap = document.createElement('div');
    wrap.className = 'fe-minimap-wrap';
    wrap.innerHTML =
      '<div class="fe-mm-head">' +
        '<span class="fe-mm-title">' + IC('map') + '<span>' + esc(t('fe.minimap')) + '</span></span>' +
        '<span class="fe-mm-actions">' +
          '<button class="fe-mm-btn" data-mm="out" title="' + esc(t('fe.zoomOut')) + '">' + IC('minus', 12) + '</button>' +
          '<button class="fe-mm-btn" data-mm="in" title="' + esc(t('fe.zoomIn')) + '">' + IC('plus', 12) + '</button>' +
          '<button class="fe-mm-btn" data-mm="fit" title="' + esc(t('fe.fit')) + '">' + IC('maximize', 12) + '</button>' +
          '<button class="fe-mm-btn fe-mm-close" data-mm="close" title="' + esc(t('fe.minimapHide')) + '">' + IC('x', 12) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="fe-minimap"></div>';
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
    // The live runner addresses nodes by their 0-based position in the main
    // chain (chainNodeIds()). These helpers translate that to the internal
    // nodeId so run-panel.js need not know about node identity.
    //
    // res = { output:[...items], meta:{ outputItemCount, inputItemCount,
    //         durationMs, status, error } }. Stores OUTPUT items for the NDV
    // and the meta that drives the on-node success/error badge.
    setNodeResultsByIndex: function (chainIndex0, res) {
      if (typeof chainIndex0 !== 'number') return;
      var ids = chainNodeIds();
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
      var ids = chainNodeIds();
      var id = ids[chainIndex0];
      if (!id || !state.nodes[id]) return;
      selectNode(id);
    },
    // Pin / unpin a chain node (0-based) — shows a 📌 on the card.
    pinByIndex: function (chainIndex0, on) {
      var ids = chainNodeIds();
      var id = ids[chainIndex0];
      if (!id) return;
      if (on === false) delete nodePins[id]; else nodePins[id] = true;
      if (dom) renderNodes();
    },
    isPinnedByIndex: function (chainIndex0) {
      var ids = chainNodeIds();
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
