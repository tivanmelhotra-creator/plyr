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
 * Exposes window.FlowEditor = { mount, unmount, toSteps, loadSteps }.
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
    nodeStatus = {};
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
  function outgoing(nodeId) {
    for (var i = 0; i < state.edges.length; i++) {
      if (state.edges[i].from === nodeId) return state.edges[i];
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

  function toSteps() {
    var steps = [];
    var seen = {};
    var edge = outgoing('start');
    var guard = 0;
    while (edge && guard < 1000) {
      guard += 1;
      var node = state.nodes[edge.to];
      if (!node || seen[node.id]) break; // missing or cycle -> stop
      seen[node.id] = true;
      if (node.action !== '__start__') {
        steps.push({ action: node.action, params: coerceParams(node) });
      }
      edge = outgoing(node.id);
    }
    return steps;
  }

  // Build a clean left-to-right chain graph from a steps[] array.
  function loadSteps(steps) {
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
      state.edges.push({ from: prevId, to: id });
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
    try { localStorage.setItem(LS_KEY, serialize()); return true; }
    catch (e) { return false; }
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
      nodeStatus = {};
      return true;
    } catch (e) { return false; }
  }

  // ---- Geometry helpers -----------------------------------------------------
  function nodeW() { return 190; }
  function nodeH(node) {
    var act = actionById(node.action);
    var rows = act ? act.fields.length : 0;
    return 44 + rows * 0; // header only; params live in inspector
  }
  function outPort(node) {
    return { x: node.x + nodeW(), y: node.y + 22 };
  }
  function inPort(node) {
    return { x: node.x, y: node.y + 22 };
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

  function curvePath(x1, y1, x2, y2) {
    var dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
    return 'M ' + x1 + ' ' + y1 +
      ' C ' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 +
      ' ' + x2 + ' ' + y2;
  }

  function renderEdges() {
    var svgns = 'http://www.w3.org/2000/svg';
    while (dom.svg.firstChild) dom.svg.removeChild(dom.svg.firstChild);
    state.edges.forEach(function (e, idx) {
      var from = state.nodes[e.from];
      var to = state.nodes[e.to];
      if (!from || !to) return;
      var p1 = outPort(from);
      var p2 = inPort(to);
      var path = document.createElementNS(svgns, 'path');
      path.setAttribute('d', curvePath(p1.x, p1.y, p2.x, p2.y));
      path.setAttribute('class', 'flow-edge');
      path.setAttribute('data-edge', String(idx));
      // click an edge to delete it
      path.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.edges.splice(idx, 1);
        renderAll();
      });
      dom.svg.appendChild(path);
    });
    // pending connection preview
    if (drag && drag.type === 'connect' && drag.preview) {
      var pp = document.createElementNS(svgns, 'path');
      pp.setAttribute('d', curvePath(drag.startX, drag.startY, drag.preview.x, drag.preview.y));
      pp.setAttribute('class', 'flow-edge pending');
      dom.svg.appendChild(pp);
    }
  }

  function nodeTitle(node) {
    if (node.action === '__start__') return t('fe.startNode');
    // action ids are not translated (same convention as the linear run builder)
    return node.action;
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
    var icon = isStart ? '🚩' : (act ? act.icon : '⚙️');

    // Category accent bar (left) — colour-codes the node by category.
    var cat = isStart ? { color: '#34d399' } : categoryOf(node.action);
    card.style.setProperty('--cat-color', cat.color);

    var header = document.createElement('div');
    header.className = 'flow-node-head';
    header.innerHTML = '<span class="fn-icon">' + icon + '</span>' +
      '<span class="fn-title">' + esc(nodeTitle(node)) + '</span>' +
      '<span class="fn-status" aria-hidden="true"></span>';
    card.appendChild(header);

    // brief summary of params under the title
    if (node.action !== '__start__') {
      var sum = document.createElement('div');
      sum.className = 'flow-node-sub';
      var bits = [];
      if (act) act.fields.forEach(function (f) {
        var v = node.params[f.k];
        if (v) bits.push(esc(String(v)));
      });
      sum.textContent = bits.length ? bits.join(' · ').slice(0, 60) : t('fe.noParams');
      card.appendChild(sum);

      var del = document.createElement('button');
      del.className = 'flow-node-del';
      del.title = t('fe.deleteNode');
      del.textContent = '×';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeNode(node.id);
      });
      card.appendChild(del);

      // input port (left)
      var pin = document.createElement('div');
      pin.className = 'flow-port in';
      pin.setAttribute('data-port', 'in');
      card.appendChild(pin);
    }

    // output port (right) — start + every action node has one
    var pout = document.createElement('div');
    pout.className = 'flow-port out';
    pout.setAttribute('data-port', 'out');
    card.appendChild(pout);

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
      var wp = worldPoint(ev.clientX, ev.clientY);
      // capture per-node offsets for group move
      var group = activeSelection();
      drag = { type: 'move', nodeId: node.id, sx: wp.x, sy: wp.y,
        origins: group.map(function (nid) {
          var nn = state.nodes[nid];
          return { id: nid, x: nn.x, y: nn.y };
        }) };
    });

    // connection drag — start on output port
    pout.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      var op = outPort(node);
      drag = { type: 'connect', from: node.id, startX: op.x, startY: op.y, preview: { x: op.x, y: op.y } };
      renderEdges();
    });

    card.addEventListener('click', function (ev) {
      ev.stopPropagation();
      selectNode(node.id);
    });

    dom.world.appendChild(card);
  }

  function renderNodes() {
    // wipe existing node cards (keep svg + world container)
    var cards = dom.world.querySelectorAll('.flow-node');
    Array.prototype.forEach.call(cards, function (c) {
      if (c.parentNode === dom.world) dom.world.removeChild(c);
    });
    Object.keys(state.nodes).forEach(function (id) { renderNode(state.nodes[id]); });
  }

  function renderInspector() {
    var box = dom.inspector;
    box.innerHTML = '';
    var node = state.selected ? state.nodes[state.selected] : null;
    if (!node || node.action === '__start__') {
      box.innerHTML = '<div class="muted small">' + esc(t('fe.selectHint')) + '</div>';
      return;
    }
    var act = actionById(node.action);
    var h = document.createElement('div');
    h.className = 'insp-title';
    h.textContent = nodeTitle(node);
    box.appendChild(h);

    if (!act || act.fields.length === 0) {
      var none = document.createElement('div');
      none.className = 'muted small';
      none.textContent = t('fe.noParams');
      box.appendChild(none);
      return;
    }

    act.fields.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'form-row';
      var label = document.createElement('label');
      label.textContent = t(f.label);
      row.appendChild(label);

      var input;
      if (f.type === 'select') {
        input = document.createElement('select');
        f.options.forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          input.appendChild(o);
        });
        input.value = node.params[f.k] || f.options[0];
      } else {
        input = document.createElement('input');
        input.type = f.type === 'number' ? 'number' : 'text';
        input.placeholder = f.ph || '';
        input.value = node.params[f.k] || '';
      }
      input.className = 'field';
      input.addEventListener('input', function () {
        node.params[f.k] = input.value;
        // live-update node summary only (cheap)
        renderNodes();
      });
      row.appendChild(input);
      box.appendChild(row);
    });
  }

  function renderAll() {
    applyViewTransform();
    renderEdges();
    renderNodes();
    renderInspector();
    renderMinimap();
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
    delete state.nodes[id];
    delete nodeStatus[id];
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
    ids.forEach(function (id) {
      delete state.nodes[id];
      delete nodeStatus[id];
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
      // keep internal edges between copied nodes (relative by array index)
      edges: state.edges.filter(function (e) { return idset[e.from] && idset[e.to]; })
        .map(function (e) { return { from: ids.indexOf(e.from), to: ids.indexOf(e.to) }; }),
    };
  }

  function pasteClipboard() {
    if (!clipboard || !clipboard.nodes.length) return;
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
        state.edges.push({ from: newIds[e.from], to: newIds[e.to] });
      }
    });
    state.selected = newIds[newIds.length - 1] || null;
    renderAll();
  }

  function addNode(actionId, x, y) {
    var act = actionById(actionId);
    if (!act) return;
    var id = uid('n');
    state.nodes[id] = { id: id, action: actionId, params: {},
      x: typeof x === 'number' ? x : 320, y: typeof y === 'number' ? y : 220 };
    selectNode(id);
    renderAll();
  }

  // a node can have at most ONE outgoing edge (linear flow). Replace if exists.
  function connect(fromId, toId) {
    if (fromId === toId) return;
    // prevent connecting into start
    if (toId === 'start') return;
    state.edges = state.edges.filter(function (e) { return e.from !== fromId; });
    state.edges.push({ from: fromId, to: toId });
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
    var item = document.createElement('button');
    item.className = 'palette-item';
    item.setAttribute('data-action', a.id);
    item.setAttribute('draggable', 'true');
    item.style.setProperty('--cat-color', cat.color);
    item.innerHTML = '<span class="pi-dot" aria-hidden="true"></span>' +
      '<span class="pi-icon">' + a.icon + '</span>' +
      '<span class="pi-label">' + esc(a.id) + '</span>';
    item.addEventListener('click', function () { placeNewNode(a.id); });
    // HTML5 drag-and-drop onto the canvas
    item.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.setData('text/ab-action', a.id);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    return item;
  }

  function renderPalette() {
    var p = dom.palette;
    p.innerHTML = '';

    var title = document.createElement('div');
    title.className = 'palette-title';
    title.textContent = t('fe.palette');
    p.appendChild(title);

    // search box
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'field palette-search';
    search.placeholder = t('fe.searchNode');
    search.value = paletteQuery;
    search.addEventListener('input', function () {
      paletteQuery = search.value;
      renderPaletteList();
      // keep focus + caret after re-render
      var el = dom.palette.querySelector('.palette-search');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
    p.appendChild(search);

    var listWrap = document.createElement('div');
    listWrap.className = 'palette-list';
    p.appendChild(listWrap);

    renderPaletteList();
  }

  function renderPaletteList() {
    var wrap = dom.palette.querySelector('.palette-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    var q = (paletteQuery || '').trim().toLowerCase();

    // group actions by category, in CATEGORIES order, then any leftovers.
    var order = CATEGORIES.map(function (c) { return c.id; });
    var groups = {};
    ACTIONS.forEach(function (a) {
      if (q && a.id.toLowerCase().indexOf(q) === -1) return;
      var cid = a.cat || 'other';
      (groups[cid] = groups[cid] || []).push(a);
    });
    var seenCats = order.filter(function (c) { return groups[c]; });
    Object.keys(groups).forEach(function (c) {
      if (seenCats.indexOf(c) === -1) seenCats.push(c);
    });

    if (!seenCats.length) {
      var none = document.createElement('div');
      none.className = 'muted small';
      none.textContent = t('fe.noNodes');
      wrap.appendChild(none);
      return;
    }

    seenCats.forEach(function (cid) {
      var cat = CAT.categoryById ? CAT.categoryById(cid) : { color: '#6b7280', label: 'cat.other' };
      var grp = document.createElement('div');
      grp.className = 'palette-group';
      var gh = document.createElement('div');
      gh.className = 'palette-group-head';
      gh.innerHTML = '<span class="pg-dot" style="background:' + cat.color + '"></span>' +
        '<span>' + esc(t(cat.label)) + '</span>';
      grp.appendChild(gh);
      groups[cid].forEach(function (a) { grp.appendChild(paletteItem(a)); });
      wrap.appendChild(grp);
    });
  }

  // ---- Canvas-level interactions (pan, box-select, drop, connection) --------
  function attachCanvasHandlers() {
    // background mousedown: Shift = box-select, otherwise pan
    on(dom.canvas, 'mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target !== dom.canvas && ev.target !== dom.svg && ev.target !== dom.world) return;
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
          if (toId) connect(drag.from, toId);
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
    on(window, 'keydown', function (ev) {
      if (!dom) return;
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

  // ---- Canvas overlay: zoom controls + minimap (Step 23) --------------------
  function buildOverlay(canvas) {
    // zoom controls (bottom-start corner)
    var ctrl = document.createElement('div');
    ctrl.className = 'fe-zoom-ctrl';
    ctrl.innerHTML =
      '<button class="fe-zbtn" data-z="in" title="' + esc(t('fe.zoomIn')) + '">＋</button>' +
      '<button class="fe-zbtn" data-z="out" title="' + esc(t('fe.zoomOut')) + '">－</button>' +
      '<button class="fe-zbtn" data-z="fit" title="' + esc(t('fe.fit')) + '">⤢</button>' +
      '<span class="fe-zoom-label">100%</span>';
    canvas.appendChild(ctrl);
    var zoomLabel = ctrl.querySelector('.fe-zoom-label');
    ctrl.querySelectorAll('.fe-zbtn').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var z = b.getAttribute('data-z');
        if (z === 'in') zoomBy(1.2);
        else if (z === 'out') zoomBy(1 / 1.2);
        else fitToScreen();
      });
      // prevent the canvas pan handler from firing
      b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    });

    // minimap (bottom-end corner)
    var mm = document.createElement('div');
    mm.className = 'fe-minimap';
    canvas.appendChild(mm);
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

    return { zoomLabel: zoomLabel, minimap: mm, zoomCtrl: ctrl };
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

    // remove any stale overlay from a previous mount, then build a fresh one
    var stale = refs.canvas.querySelectorAll('.fe-zoom-ctrl, .fe-minimap');
    Array.prototype.forEach.call(stale, function (el) { el.parentNode.removeChild(el); });
    var ov = buildOverlay(refs.canvas);
    dom.zoomLabel = ov.zoomLabel;
    dom.minimap = ov.minimap;

    renderPalette();
    attachCanvasHandlers();
    renderAll();
  }

  function unmount() {
    offAll();
    drag = null;
    dom = null;
    // keep `state` so re-entering the view keeps the graph in memory too
  }

  window.FlowEditor = {
    mount: mount,
    unmount: unmount,
    toSteps: toSteps,
    loadSteps: loadSteps,
    saveLocal: saveLocal,
    loadLocal: function () { var ok = loadLocal(); if (dom) renderAll(); return ok; },
    reset: function () { state = newGraph(); if (dom) renderAll(); },
    getState: function () { return state; },
    ACTIONS: ACTIONS,

    // ---- Step 23: viewport + visual node status ---------------------------
    fitToScreen: function () { fitToScreen(); },
    zoomIn: function () { zoomBy(1.2); },
    zoomOut: function () { zoomBy(1 / 1.2); },
    // Paint a node's halo: ref = nodeId | chain step index; status =
    // 'idle' | 'running' | 'success' | 'error'.
    setNodeStatus: setNodeStatus,
    clearStatuses: clearStatuses,

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
    },
  };
})();
