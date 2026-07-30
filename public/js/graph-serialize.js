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
  // Params the Condition Builder NDV owns. They are encoded into the step's
  // `condition` object, so they must never ALSO appear in `step.params`.
  // `maxDepth` / `evaluateMode` are UI-only recursion/evaluation guards.
  var CONDITION_ONLY_PARAMS = ['groups', 'selector', 'operator', 'value',
    'expected', 'source', 'attribute', 'maxDepth', 'evaluateMode'];

  // The Condition Builder design (ndv-condition-final) adds a "Left source" +
  // "Attribute name" pair to each row. They travel to the backend as
  // SimpleCondition.source / .attribute (ConditionEngine reads them when
  // resolving the left-hand value). `source: 'text'` is the engine default, so
  // it is omitted to keep serialised workflows stable/diff-friendly.
  function buildSimpleCondition(row) {
    var cond = { operator: (row && row.operator) || 'exists' };
    if (row && row.selector !== undefined && row.selector !== '') cond.selector = row.selector;
    if (row && row.value !== undefined && row.value !== '') cond.value = row.value;
    if (row && row.expected !== undefined && row.expected !== '') cond.expected = row.expected;
    if (row && row.source !== undefined && row.source !== '' && row.source !== 'text') {
      cond.source = row.source;
    }
    if (row && row.attribute !== undefined && row.attribute !== '') cond.attribute = row.attribute;
    return cond;
  }

  // Final ui-ux Condition Builder (ndv-condition-final.md): the editor stores
  // AND/OR groups on node.params.groups as a JSON string:
  //   [ [ {selector,operator,expected,value}, ... ],   <- group 1 (AND inside)
  //     [ ... ] ]                                      <- group 2 (OR between)
  // Serialized to the backend ConditionEngine composite form:
  //   1 group / 1 row  -> SimpleCondition
  //   1 group / n rows -> { all: [...] }
  //   n groups         -> { any: [ {all:[...]}, ... ] }
  function parseGroups(raw) {
    if (!raw) return null;
    var g = raw;
    if (typeof raw === 'string') {
      try { g = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!Array.isArray(g)) return null;
    var groups = [];
    g.forEach(function (rows) {
      if (!Array.isArray(rows)) return;
      var clean = rows.filter(function (r) { return r && typeof r === 'object' && r.operator; });
      if (clean.length) groups.push(clean);
    });
    return groups.length ? groups : null;
  }

  function buildCondition(params) {
    params = params || {};
    var groups = parseGroups(params.groups);
    if (groups) {
      var groupConds = groups.map(function (rows) {
        var conds = rows.map(buildSimpleCondition);
        return conds.length === 1 ? conds[0] : { all: conds };
      });
      return groupConds.length === 1 ? groupConds[0] : { any: groupConds };
    }
    // Legacy single-condition form (params.operator/selector/value/expected).
    return buildSimpleCondition(params);
  }

  // Reverse of buildCondition: reconstruct editor `groups` from a stored
  // composite condition. Returns null when the condition is a plain simple
  // condition (legacy editor fields are used instead).
  function conditionToGroups(cond) {
    if (!cond || typeof cond !== 'object') return null;
    function simpleRow(c) {
      var row = { operator: c.operator || 'exists' };
      if (c.selector !== undefined) row.selector = String(c.selector);
      if (c.value !== undefined) row.value = String(c.value);
      if (c.expected !== undefined) row.expected = String(c.expected);
      if (c.source !== undefined) row.source = String(c.source);
      if (c.attribute !== undefined) row.attribute = String(c.attribute);
      return row;
    }
    function groupRows(c) {
      // one group: either {all:[simple...]} or a single simple condition
      if (c && Array.isArray(c.all)) {
        var rows = [];
        for (var i = 0; i < c.all.length; i++) {
          var s = c.all[i];
          if (!s || typeof s !== 'object' || !('operator' in s)) return null; // nested beyond builder depth
          rows.push(simpleRow(s));
        }
        return rows;
      }
      if (c && 'operator' in c) return [simpleRow(c)];
      return null;
    }
    if (Array.isArray(cond.any)) {
      var groups = [];
      for (var i = 0; i < cond.any.length; i++) {
        var rows = groupRows(cond.any[i]);
        if (!rows) return null;
        groups.push(rows);
      }
      return groups.length ? groups : null;
    }
    if (Array.isArray(cond.all)) {
      var r = groupRows(cond);
      return r ? [r] : null;
    }
    return null; // plain simple condition -> legacy fields
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
      // A node flagged `disabled` (context-menu item J / group toolbar item I)
      // is SKIPPED exactly the way n8n skips a deactivated node: it emits no
      // step and the chain continues through its MAIN `next` port, so switching
      // one node off does not tear the rest of the flow apart. Consequence to
      // keep in mind: disabling a BRANCHING node (if/switch/loop/try) also
      // drops everything that hangs off its branch ports, because those
      // children are only reachable through the node being skipped.
      if (node.disabled === true) {
        nextId = portTarget(graph, node.id, 'next');
        continue;
      }
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
        // Only `maxIterations` is a real `while` param. Everything the Condition
        // Builder NDV writes (docs/uiux/ndv-condition-final) is condition-only
        // and is already encoded inside `loopStep.condition`, so strip it from
        // params — otherwise the same data would be serialised twice and the
        // backend would receive params it does not understand.
        CONDITION_ONLY_PARAMS.forEach(function (k) { delete loopStep.params[k]; });
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
  // Rebuilds a laid-out graph from nested steps[]. The main chain runs
  // left-to-right; each branch drops into its own lane on the next column, so
  // the canvas reads as a pipeline (see docs/uiux). The Start node's y matches
  // ORIGIN_Y in stepsToGraph so the trunk is one straight row.
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

    // ---- layout metrics -----------------------------------------------------
    // The reference design (docs/uiux) reads a workflow as a LEFT-TO-RIGHT
    // pipeline: sequential steps march along +X, and a branching node stacks
    // its ports downward on the next column. The previous build advanced +Y per
    // step at a fixed X, which produced the tall vertical stack visible in the
    // screenshots. COL_W/ROW_H below are multiples of the editor's 20px grid so
    // generated nodes land exactly on grid intersections.
    var COL_W = 260;   // horizontal step pitch (NODE_W 190 + 70 gutter for the edge)
    var ROW_H = 140;   // vertical pitch between sibling branch lanes
    var ORIGIN_X = 280;
    var ORIGIN_Y = 200;

    // Recursively lay out a linear group; returns the FIRST node id (or null).
    // x,y are the top-left anchor: the group flows right from x, and any nested
    // branches drop into lanes below y on the following column.
    function layoutGroup(group, x, y) {
      var firstId = null;
      var prevId = null;
      var prevPort = 'next';
      var curX = x;
      // Bottom-most Y consumed by this group including its nested branches, so
      // a caller can place the next sibling lane clear of it.
      var maxY = y;
      (group || []).forEach(function (s) {
        if (!s || !s.action) return;
        var id = mkId();
        var node = { id: id, action: s.action, params: {}, x: curX, y: y };
        // copy scalar params back as strings (editor stores strings)
        if (s.params && typeof s.params === 'object') {
          Object.keys(s.params).forEach(function (k) {
            node.params[k] = String(s.params[k]);
          });
        }
        // reconstruct editor-only fields from condition for if/while
        if ((s.action === 'if' || s.action === 'while') && s.condition && typeof s.condition === 'object') {
          var c = s.condition;
          var grp = conditionToGroups(c);
          if (grp) {
            // composite AND/OR condition -> Condition Builder groups
            node.params.groups = JSON.stringify(grp);
          } else {
            // Plain SimpleCondition -> legacy flat editor fields. `source` /
            // `attribute` come from the Condition Builder's "Left source" pair
            // and must round-trip too, otherwise re-opening a saved workflow
            // silently resets them to the `text` default.
            if (c.operator !== undefined) node.params.operator = String(c.operator);
            if (c.selector !== undefined) node.params.selector = String(c.selector);
            if (c.value !== undefined) node.params.value = String(c.value);
            if (c.expected !== undefined) node.params.expected = String(c.expected);
            if (c.source !== undefined) node.params.source = String(c.source);
            if (c.attribute !== undefined) node.params.attribute = String(c.attribute);
          }
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

        // Nested branches occupy the NEXT column, stacked into lanes that start
        // one row below the parent so the parent's own row stays readable.
        var branchX = curX + COL_W;
        var branchY = y + ROW_H;
        // How far right the widest branch reaches — the step that follows this
        // branching node must clear it, otherwise the two would overlap.
        var branchRight = curX;
        function lane(sub, port) {
          var r = layoutPort(sub, id, port, branchX, branchY);
          branchY = r.nextY;
          if (r.right > branchRight) branchRight = r.right;
        }
        if (s.action === 'if') {
          lane(s.then, 'then');
          lane(s.else, 'else');
        } else if (s.action === 'switch' && s.cases && typeof s.cases === 'object') {
          Object.keys(s.cases).forEach(function (cv) {
            lane(s.cases[cv], cv === 'default' ? 'default' : ('case:' + cv));
          });
        } else if (s.action === 'loop' || s.action === 'foreach' || s.action === 'while') {
          lane(s.steps, 'body');
        } else if (s.action === 'try') {
          lane(s.steps, 'try');
          lane(s.catch, 'catch');
          lane(s.finally, 'finally');
        }
        if (branchY - ROW_H > maxY) maxY = branchY - ROW_H;
        // Advance at least one column; skip past any branch subtree.
        curX = Math.max(curX + COL_W, branchRight + COL_W);

        prevId = id;
        // loop/foreach/while continue from 'done'; others from 'next'
        prevPort = (s.action === 'loop' || s.action === 'foreach' || s.action === 'while') ? 'done' : 'next';
      });
      // `curX` sits one column past the last node, so the last node's own left
      // edge is one column back.
      return { firstId: firstId, right: curX - COL_W, bottom: maxY };
    }

    // Lays out a port's sub-group and links the parent->first via `port`.
    // Returns { nextY, right }: the first free lane below this sub-group, and
    // how far right it extends.
    function layoutPort(group, parentId, port, x, y) {
      if (!group || !group.length) return { nextY: y, right: x - COL_W };
      var r = layoutGroup(group, x, y);
      if (r.firstId) graph.edges.push({ from: parentId, to: r.firstId, port: port });
      // Clear the sub-group's own nested lanes before starting the next one.
      return { nextY: Math.max(y, r.bottom) + ROW_H, right: r.right };
    }

    var topFirst = layoutGroup(steps, ORIGIN_X, ORIGIN_Y).firstId;
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
      // A DISABLED node never reaches the backend (walkChain skips it), so its
      // missing parameters cannot fail a run and must NOT be reported as
      // errors — that would make a valid flow un-runnable for a node that is
      // switched off. It still gets a WARNING, because a silently skipped node
      // is exactly the kind of thing a user forgets they switched off.
      if (node.disabled === true) {
        warnings.push({ code: 'disabled', nodeId: id, message: 'val.disabledNode' });
        continue;
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

  // -------- OUTLINE tree (docs/uiux/shell-editor-click-ndv.md § 2) -----------
  // The locked design shows the workflow as a NUMBERED NESTED TREE in a left
  // panel: `1 Trigger` → `1.1 Webhook`, `4 Condition` → `4.1.1 True` →
  // `4.1.1.1 Extract Data`. The spec is explicit that the outline is a
  // "navigational mirror, not a separate model" (§ 4), so it is DERIVED from
  // the same graph the canvas draws — never stored, never edited here.
  //
  // Shape of each row:
  //   { nodeId, action, port, num, depth, kind }
  //     nodeId — canvas node to select when the row is clicked ('' for a port
  //              row, which is a label on its owner node, not a node itself)
  //     port   — for kind 'port', the owner node's port id ('then'/'else'/…)
  //     num    — dotted section number as a STRING ('4.1.1.1')
  //     depth  — 0-based indentation level (== num segments - 1)
  //     kind   — 'node' | 'port'
  //
  // Being DOM-free keeps it unit-testable (the flow-editor is not), and keeps
  // one implementation of the numbering rule for both the panel and any future
  // consumer (e.g. an exported document outline).
  var OUTLINE_MAX_ROWS = 2000;   // hard stop: a cyclic graph must not hang the UI

  function outlineTree(graph) {
    var rows = [];
    if (!graph || !graph.nodes || !Array.isArray(graph.edges)) return rows;

    // A node reached from two different ports would otherwise be emitted twice
    // (and an actual cycle would never terminate). First visit wins, which
    // matches how graphToSteps() serialises the same graph.
    var seen = {};

    function walk(fromId, port, prefix) {
      var id = portTarget(graph, fromId, port);
      var index = 0;
      var guard = 0;
      while (id && guard < OUTLINE_MAX_ROWS) {
        guard += 1;
        if (seen[id]) break;
        var node = graph.nodes[id];
        if (!node) break;
        seen[id] = true;
        index += 1;
        var num = prefix ? prefix + '.' + index : String(index);
        rows.push({
          nodeId: id,
          action: node.action,
          port: '',
          num: num,
          depth: num.split('.').length - 1,
          kind: 'node',
          // The outline is a mirror of the canvas, so a node switched off on the
          // canvas has to read as switched off here too (views.js dims the row).
          disabled: node.disabled === true,
          label: typeof node.label === 'string' ? node.label : '',
        });
        if (rows.length >= OUTLINE_MAX_ROWS) return;

        // Branch ports become their own labelled rows, so `True` / `False`
        // read as sections that own their children (exactly as pictured).
        var ports = CAT.branchesOf ? CAT.branchesOf(node.action) : [{ id: 'next' }];
        var branchPorts = [];
        for (var i = 0; i < ports.length; i++) {
          if (ports[i] && ports[i].id !== 'next') branchPorts.push(ports[i]);
        }
        // `switch` fans out through dynamic `case:<value>` ports, which are not
        // declared in the catalog — read them off the edges instead.
        if (node.action === 'switch') {
          var es = edgesFrom(graph, id);
          for (var e = 0; e < es.length; e++) {
            var p = es[e].port || 'next';
            if (p.indexOf('case:') === 0) branchPorts.push({ id: p, label: 'port.case' });
          }
        }
        var sub = 0;
        for (var b = 0; b < branchPorts.length; b++) {
          var bp = branchPorts[b];
          if (!portTarget(graph, id, bp.id)) continue;   // empty port: no row
          sub += 1;
          var bnum = num + '.' + sub;
          rows.push({
            nodeId: id,
            action: node.action,
            port: bp.id,
            num: bnum,
            depth: bnum.split('.').length - 1,
            kind: 'port',
          });
          if (rows.length >= OUTLINE_MAX_ROWS) return;
          walk(id, bp.id, bnum);
          if (rows.length >= OUTLINE_MAX_ROWS) return;
        }

        // Continue the chain: branching nodes carry on via 'next' (if/switch/
        // try) or 'done' (loop/foreach/while) — same rule as buildNode().
        var contPort = DONE_PORT[node.action] ? 'done' : 'next';
        id = portTarget(graph, id, contPort);
      }
    }

    walk('start', 'next', '');
    return rows;
  }

  window.GraphSerialize = {
    graphToSteps: graphToSteps,
    stepsToGraph: stepsToGraph,
    validateGraph: validateGraph,
    outlineTree: outlineTree,
    // exported for tests / reuse
    coerceParams: coerceParams,
    buildCondition: buildCondition,
    conditionToGroups: conditionToGroups,
    CONDITION_ONLY_PARAMS: CONDITION_ONLY_PARAMS,
    OUTLINE_MAX_ROWS: OUTLINE_MAX_ROWS,
  };
})();
