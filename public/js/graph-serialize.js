/*
 * graph-serialize.js — non-linear graph <-> nested steps[] serialization (Step 24).
 *
 * Pure, DOM-free, CSP-safe. No framework, no DOM access — so it can be unit
 * tested under node:vm with only a `window` shim (the Step 23 lesson). The
 * flow-editor delegates its toSteps()/loadSteps() to these functions.
 *
 * GRAPH MODEL
 *   graph = {
 *     nodes: { [id]: { id, action, params, x?, y?, caseLabels? } },
 *     edges: [ { from, to, port } ]    // port defaults to 'next'
 *   }
 *   - A non-branching action has a single implicit 'next' output port.
 *   - A branching action declares ports via ACTION_CATALOG.branchesOf(id):
 *       if      -> then | else        (+ implicit 'next' to continue after)
 *       switch  -> default | case:<v> (+ implicit 'next')
 *       loop    -> body | done
 *       foreach -> body | done
 *       while   -> body | done
 *       try     -> try | catch | finally (+ implicit 'next')
 *
 * BACKEND MAPPING (src/pipeline.ts + src/types.ts AutomationStep)
 *   if     -> { action:'if', condition, then:[...], else:[...] }
 *   switch -> { action:'switch', params:{variable}, cases:{ <v>:[...], default:[...] } }
 *   loop   -> { action:'loop', params:{count}, steps:[body...] }            then 'done' continues
 *   foreach-> { action:'foreach', params:{items,itemVar}, steps:[body...] } then 'done' continues
 *   while  -> { action:'while', condition, params:{maxIterations}, steps:[body...] } then 'done'
 *   try    -> { action:'try', steps:[try...], catch:[...], finally:[...] }  then 'next' continues
 *
 * Loaded BEFORE flow-editor.js in index.html. LF line endings.
 */
(function () {
  'use strict';

  var CAT = window.ACTION_CATALOG || {
    branchesOf: function () { return [{ id: 'next', label: 'port.next' }]; },
    isBranching: function () { return false; },
    actionById: function () { return null; },
  };

  // Actions whose ports are self-contained groups but the MAIN chain may
  // continue after them via an implicit 'next' port.
  var CONTINUE_AFTER = { if: true, switch: true, try: true };
  // Actions whose continuation lives on a dedicated 'done' port.
  var DONE_PORT = { loop: true, foreach: true, while: true };

  function strictAction(id) {
    var a = CAT.actionById ? CAT.actionById(id) : null;
    // actionById falls back to ACTIONS[0]; treat a fallback mismatch as unknown.
    if (a && a.id === id) return a;
    return null;
  }

  // -------- params coercion (numbers -> int, drop empty) ---------------------
  function coerceParams(action, rawParams) {
    var act = strictAction(action);
    var out = {};
    var params = rawParams || {};
    if (!act) {
      // unknown action: pass through non-empty values verbatim
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (v !== undefined && v !== null && v !== '') out[k] = v;
      });
      return out;
    }
    (act.fields || []).forEach(function (f) {
      var v = params[f.k];
      if (v === undefined || v === null || v === '') return;
      if (f.type === 'number') {
        var n = parseInt(v, 10);
        if (!isNaN(n)) out[f.k] = n;
      } else {
        out[f.k] = v;
      }
    });
    return out;
  }

  // -------- edge lookup helpers ----------------------------------------------
  function edgesFrom(graph, nodeId) {
    var res = [];
    for (var i = 0; i < graph.edges.length; i++) {
      if (graph.edges[i].from === nodeId) res.push(graph.edges[i]);
    }
    return res;
  }
  function portTarget(graph, nodeId, port) {
    var es = edgesFrom(graph, nodeId);
    for (var i = 0; i < es.length; i++) {
      var p = es[i].port || 'next';
      if (p === port) return es[i].to;
    }
    return null;
  }

  // -------- condition builder (matches ConditionEngine SimpleCondition) ------
  function buildCondition(params) {
    var cond = { operator: params.operator || 'exists' };
    if (params.selector !== undefined && params.selector !== '') cond.selector = params.selector;
    if (params.value !== undefined && params.value !== '') cond.value = params.value;
    if (params.expected !== undefined && params.expected !== '') cond.expected = params.expected;
    return cond;
  }

  // Step 27: copy a node's error-handling settings onto its serialized step as
  // top-level AutomationStep fields (continueOnFail / retryOnFail / maxTries /
  // waitBetweenTriesMs). Only emits fields that are explicitly set, so plain
  // nodes stay clean. The settings live on `node.errorPolicy` (set by the NDV
  // Settings tab); tolerant of missing/garbage values.
  function applyErrorPolicy(step, node) {
    var ep = node && node.errorPolicy;
    if (!ep || typeof ep !== 'object') return;
    if (ep.continueOnFail === true) step.continueOnFail = true;
    if (ep.retryOnFail === true) {
      step.retryOnFail = true;
      var mt = parseInt(ep.maxTries, 10);
      if (isFinite(mt) && mt > 1) step.maxTries = mt;
      var wt = parseInt(ep.waitBetweenTriesMs, 10);
      if (isFinite(wt) && wt >= 0) step.waitBetweenTriesMs = wt;
    }
  }

  // -------- graph -> steps[] (serialize) -------------------------------------
  // Walks a chain starting from the node reached via `startEdgePort` of
  // `fromId`. `seen` guards against cycles within a single chain walk.
  function walkChain(graph, fromId, startPort, seen) {
    var steps = [];
    var nextId = portTarget(graph, fromId, startPort);
    var guard = 0;
    while (nextId && guard < 5000) {
      guard += 1;
      if (seen[nextId]) break;        // cycle within this chain -> stop
      var node = graph.nodes[nextId];
      if (!node) break;
      seen[nextId] = true;
      var built = buildNode(graph, node, seen);
      if (built.step) {
        applyErrorPolicy(built.step, node);
        steps.push(built.step);
      }
      // Determine the continuation node id.
      nextId = built.continueId;
    }
    return steps;
  }

  // Builds the AutomationStep for one node and returns the id of the node the
  // MAIN chain should continue to (or null to stop).
  function buildNode(graph, node, seen) {
    var action = node.action;
    var params = coerceParams(action, node.params);

    if (action === 'if') {
      var step = { action: 'if', condition: buildCondition(node.params || {}) };
      var thenSteps = walkChain(graph, node.id, 'then', {});
      var elseSteps = walkChain(graph, node.id, 'else', {});
      if (thenSteps.length) step.then = thenSteps;
      if (elseSteps.length) step.else = elseSteps;
      return { step: step, continueId: portTarget(graph, node.id, 'next') };
    }

    if (action === 'switch') {
      var sStep = { action: 'switch', params: { variable: params.variable }, cases: {} };
      // default port
      var def = walkChain(graph, node.id, 'default', {});
      if (def.length) sStep.cases['default'] = def;
      // explicit case ports: edges with port 'case:<value>'
      var es = edgesFrom(graph, node.id);
      for (var i = 0; i < es.length; i++) {
        var p = es[i].port || 'next';
        if (p.indexOf('case:') === 0) {
          var caseVal = p.slice(5);
          sStep.cases[caseVal] = walkChain(graph, node.id, p, {});
        }
      }
      return { step: sStep, continueId: portTarget(graph, node.id, 'next') };
    }

    if (action === 'loop' || action === 'foreach' || action === 'while') {
      var loopStep = { action: action, params: params };
      if (action === 'while') {
        loopStep.condition = buildCondition(node.params || {});
        // maxIterations stays in params; selector/operator/value/expected are
        // condition-only, strip them from params so they don't double up.
        delete loopStep.params.selector;
        delete loopStep.params.operator;
        delete loopStep.params.value;
        delete loopStep.params.expected;
      }
      var body = walkChain(graph, node.id, 'body', {});
      if (body.length) loopStep.steps = body;
      else loopStep.steps = [];
      return { step: loopStep, continueId: portTarget(graph, node.id, 'done') };
    }

    if (action === 'try') {
      var tStep = { action: 'try' };
      var tryS = walkChain(graph, node.id, 'try', {});
      var catchS = walkChain(graph, node.id, 'catch', {});
      var finallyS = walkChain(graph, node.id, 'finally', {});
      tStep.steps = tryS;
      if (catchS.length) tStep.catch = catchS;
      if (finallyS.length) tStep.finally = finallyS;
      return { step: tStep, continueId: portTarget(graph, node.id, 'next') };
    }

    // Plain linear action.
    return {
      step: { action: action, params: params },
      continueId: portTarget(graph, node.id, 'next'),
    };
  }

  function graphToSteps(graph) {
    if (!graph || !graph.nodes || !graph.edges) return [];
    return walkChain(graph, 'start', 'next', {});
  }

  // -------- steps[] -> graph (deserialize) -----------------------------------
  // Rebuilds a laid-out graph from nested steps[]. Branch sub-chains are placed
  // below+right of their parent so the canvas reads top-to-bottom.
  function newBlankGraph() {
    return {
      nodes: { start: { id: 'start', action: '__start__', params: {}, x: 60, y: 200 } },
      edges: [],
      nextId: 0,
      selected: null,
      selSet: {},
      view: { x: 0, y: 0, scale: 1 },
    };
  }

  function stepsToGraph(steps) {
    var graph = newBlankGraph();
    var ctr = { n: 0 };
    function mkId() { ctr.n += 1; graph.nextId = ctr.n; return 'n' + ctr.n; }

    // Recursively lay out a linear group; returns the FIRST node id (or null).
    // x,y are the top-left anchor for this group; depth indents branches.
    function layoutGroup(group, x, y) {
      var firstId = null;
      var prevId = null;
      var prevPort = 'next';
      var curY = y;
      (group || []).forEach(function (s) {
        if (!s || !s.action) return;
        var id = mkId();
        var node = { id: id, action: s.action, params: {}, x: x, y: curY };
        // copy scalar params back as strings (editor stores strings)
        if (s.params && typeof s.params === 'object') {
          Object.keys(s.params).forEach(function (k) {
            node.params[k] = String(s.params[k]);
          });
        }
        // reconstruct editor-only fields from condition for if/while
        if ((s.action === 'if' || s.action === 'while') && s.condition && typeof s.condition === 'object') {
          var c = s.condition;
          if (c.operator !== undefined) node.params.operator = String(c.operator);
          if (c.selector !== undefined) node.params.selector = String(c.selector);
          if (c.value !== undefined) node.params.value = String(c.value);
          if (c.expected !== undefined) node.params.expected = String(c.expected);
        }
        // Step 27: reconstruct the node's error-handling settings from the step.
        if (s.continueOnFail === true || s.retryOnFail === true) {
          node.errorPolicy = {};
          if (s.continueOnFail === true) node.errorPolicy.continueOnFail = true;
          if (s.retryOnFail === true) {
            node.errorPolicy.retryOnFail = true;
            if (s.maxTries !== undefined) node.errorPolicy.maxTries = s.maxTries;
            if (s.waitBetweenTriesMs !== undefined) node.errorPolicy.waitBetweenTriesMs = s.waitBetweenTriesMs;
          }
        }
        graph.nodes[id] = node;
        if (prevId === null) {
          firstId = id;
        } else {
          graph.edges.push({ from: prevId, to: id, port: prevPort });
        }

        // lay out nested branches of this node (below, indented to the right)
        var branchX = x + 240;
        var branchY = curY + 70;
        if (s.action === 'if') {
          branchY = layoutPort(s.then, id, 'then', branchX, branchY);
          branchY = layoutPort(s.else, id, 'else', branchX, branchY);
        } else if (s.action === 'switch' && s.cases && typeof s.cases === 'object') {
          Object.keys(s.cases).forEach(function (cv) {
            var port = cv === 'default' ? 'default' : ('case:' + cv);
            branchY = layoutPort(s.cases[cv], id, port, branchX, branchY);
          });
        } else if (s.action === 'loop' || s.action === 'foreach' || s.action === 'while') {
          branchY = layoutPort(s.steps, id, 'body', branchX, branchY);
        } else if (s.action === 'try') {
          branchY = layoutPort(s.steps, id, 'try', branchX, branchY);
          branchY = layoutPort(s.catch, id, 'catch', branchX, branchY);
          branchY = layoutPort(s.finally, id, 'finally', branchX, branchY);
        }
        curY = Math.max(curY + 120, branchY);

        prevId = id;
        // loop/foreach/while continue from 'done'; others from 'next'
        prevPort = (s.action === 'loop' || s.action === 'foreach' || s.action === 'while') ? 'done' : 'next';
      });
      return firstId;
    }

    // Lays out a port's sub-group and links the parent->first via `port`.
    // Returns the next free Y.
    function layoutPort(group, parentId, port, x, y) {
      if (!group || !group.length) return y;
      var firstId = layoutGroup(group, x, y);
      if (firstId) graph.edges.push({ from: parentId, to: firstId, port: port });
      // advance Y by the group's vertical extent (rough estimate)
      return y + group.length * 120 + 40;
    }

    var topFirst = layoutGroup(steps, 280, 160);
    if (topFirst) graph.edges.push({ from: 'start', to: topFirst, port: 'next' });
    return graph;
  }

  // -------- graph validation -------------------------------------------------
  // Returns { ok, errors:[{code,nodeId?,message}], warnings:[...] }.
  function validateGraph(graph) {
    var errors = [];
    var warnings = [];
    if (!graph || !graph.nodes) {
      return { ok: false, errors: [{ code: 'no-graph', message: 'val.noGraph' }], warnings: warnings };
    }

    var startEdge = null;
    for (var i = 0; i < graph.edges.length; i++) {
      if (graph.edges[i].from === 'start') { startEdge = graph.edges[i]; break; }
    }
    if (!startEdge) {
      errors.push({ code: 'empty', message: 'val.empty' });
    }

    // Reachability from start.
    var reachable = {};
    (function mark(id) {
      if (!id || reachable[id]) return;
      reachable[id] = true;
      edgesFrom(graph, id).forEach(function (e) { mark(e.to); });
    })('start');

    var ids = Object.keys(graph.nodes);
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (id === 'start') continue;
      var node = graph.nodes[id];
      if (!reachable[id]) {
        warnings.push({ code: 'orphan', nodeId: id, message: 'val.orphan' });
      }
      // unknown action
      if (!strictAction(node.action)) {
        errors.push({ code: 'unknown-action', nodeId: id, message: 'val.unknownAction' });
      }
      // loop/foreach/while must have a non-empty body
      if (node.action === 'loop' || node.action === 'foreach' || node.action === 'while') {
        if (!portTarget(graph, id, 'body')) {
          warnings.push({ code: 'empty-loop', nodeId: id, message: 'val.emptyLoop' });
        }
        // foreach needs an items variable; while needs an operator
        if (node.action === 'foreach' && !(node.params && node.params.items)) {
          errors.push({ code: 'foreach-items', nodeId: id, message: 'val.foreachItems' });
        }
      }
      // if needs at least one branch
      if (node.action === 'if') {
        if (!portTarget(graph, id, 'then') && !portTarget(graph, id, 'else')) {
          warnings.push({ code: 'empty-if', nodeId: id, message: 'val.emptyIf' });
        }
      }
      // switch needs a variable
      if (node.action === 'switch' && !(node.params && node.params.variable)) {
        errors.push({ code: 'switch-var', nodeId: id, message: 'val.switchVar' });
      }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  window.GraphSerialize = {
    graphToSteps: graphToSteps,
    stepsToGraph: stepsToGraph,
    validateGraph: validateGraph,
    // exported for tests / reuse
    coerceParams: coerceParams,
    buildCondition: buildCondition,
  };
})();
