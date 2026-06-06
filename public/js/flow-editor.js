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
  var CAT = window.ACTION_CATALOG || { ACTIONS: [] };
  var ACTIONS = CAT.ACTIONS;
  // Note: unlike the shared helper (which falls back to ACTIONS[0]), the editor
  // needs a strict lookup that returns null for unknown/synthetic node types
  // (e.g. '__start__'). Callers already guard on a null result.
  function actionById(id) {
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === id) return ACTIONS[i];
    return null;
  }

  // ---- Editor state ---------------------------------------------------------
  var state = null; // { nodes:{}, edges:[], nextId, selected, view:{x,y,scale} }
  var dom = null;    // { root, canvas, svg, world, palette, inspector }
  var drag = null;   // active node-drag or connection-drag context
  var listeners = []; // [{ target, type, fn }] for clean unmount

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
    return { nodes: { start: start }, edges: [], nextId: 0, selected: null,
      view: { x: 0, y: 0, scale: 1 } };
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
        x: x, y: 160 + (i % 2) * 40 };
      state.edges.push({ from: prevId, to: id });
      prevId = id;
      x += 230;
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
    var card = document.createElement('div');
    card.className = 'flow-node' + (node.action === '__start__' ? ' is-start' : '') +
      (state.selected === node.id ? ' selected' : '');
    card.setAttribute('data-node', node.id);
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';
    card.style.width = nodeW() + 'px';

    var act = actionById(node.action);
    var icon = node.action === '__start__' ? '🚩' : (act ? act.icon : '⚙️');

    var header = document.createElement('div');
    header.className = 'flow-node-head';
    header.innerHTML = '<span class="fn-icon">' + icon + '</span>' +
      '<span class="fn-title">' + esc(nodeTitle(node)) + '</span>';
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

    // node drag (move) — start on header
    header.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      selectNode(node.id);
      var wp = worldPoint(ev.clientX, ev.clientY);
      drag = { type: 'move', nodeId: node.id, dx: wp.x - node.x, dy: wp.y - node.y };
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
  }

  // ---- Node operations ------------------------------------------------------
  function selectNode(id) {
    state.selected = id;
    renderNodes();
    renderInspector();
  }

  function removeNode(id) {
    if (id === 'start') return;
    delete state.nodes[id];
    state.edges = state.edges.filter(function (e) {
      return e.from !== id && e.to !== id;
    });
    if (state.selected === id) state.selected = null;
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

  // ---- Palette --------------------------------------------------------------
  function renderPalette() {
    var p = dom.palette;
    p.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'palette-title';
    title.textContent = t('fe.palette');
    p.appendChild(title);
    ACTIONS.forEach(function (a) {
      var item = document.createElement('button');
      item.className = 'palette-item';
      item.setAttribute('data-action', a.id);
      item.innerHTML = '<span class="pi-icon">' + a.icon + '</span>' +
        '<span class="pi-label">' + esc(a.id) + '</span>';
      item.addEventListener('click', function () {
        // place new node near viewport center, cascading so nodes never stack
        var rect = dom.canvas.getBoundingClientRect();
        var center = worldPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        var n = Object.keys(state.nodes).length; // includes start
        var offset = (n - 1) % 6;
        addNode(a.id, center.x - nodeW() / 2 + offset * 26, center.y - 22 + offset * 30);
      });
      p.appendChild(item);
    });
  }

  // ---- Canvas-level interactions (pan, drop connection) ---------------------
  function attachCanvasHandlers() {
    // pan with background drag
    on(dom.canvas, 'mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target !== dom.canvas && ev.target !== dom.svg && ev.target !== dom.world) return;
      drag = { type: 'pan', startX: ev.clientX, startY: ev.clientY,
        ox: state.view.x, oy: state.view.y };
      state.selected = null;
      renderInspector();
      renderNodes();
    });

    on(window, 'mousemove', function (ev) {
      if (!drag) return;
      if (drag.type === 'pan') {
        state.view.x = drag.ox + (ev.clientX - drag.startX);
        state.view.y = drag.oy + (ev.clientY - drag.startY);
        applyViewTransform();
      } else if (drag.type === 'move') {
        var wp = worldPoint(ev.clientX, ev.clientY);
        var node = state.nodes[drag.nodeId];
        if (node) { node.x = Math.round(wp.x - drag.dx); node.y = Math.round(wp.y - drag.dy); }
        renderEdges();
        renderNodes();
      } else if (drag.type === 'connect') {
        drag.preview = worldPoint(ev.clientX, ev.clientY);
        renderEdges();
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
