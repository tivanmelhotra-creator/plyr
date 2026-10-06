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
  //
  // `maxDepth` and `evaluateMode` USED to be listed here. They were removed
  // once a stack-wide audit showed no backend reference to either key: they
  // were UI-only knobs that changed nothing about the run. They stay in this
  // strip list for one release so that a workflow saved by an older build does
  // not carry two orphan params into `step.params` when it is re-serialised.
  var CONDITION_ONLY_PARAMS = ['groups', 'paths', 'selector', 'operator', 'value',
    'expected', 'source', 'attribute', 'maxDepth', 'evaluateMode'];

  // Operators whose `expected` the engine compares with Array.includes and so
  // MUST arrive as a real array (ConditionEngine 'in_list' / 'not_in_list' both
  // return false outright for a non-array). The builder edits them as one
  // comma/newline separated text field, which is the only shape a single input
  // can hold, and the conversion happens here — at the single boundary where
  // editor rows become backend conditions.
  var LIST_OPERATORS = ['in_list', 'not_in_list'];
  function splitListValue(raw) {
    return String(raw == null ? '' : raw)
      .split(/[\n,]/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // The Condition Builder design (ndv-condition-final) adds a "Left source" +
  // "Attribute name" pair to each row. They travel to the backend as
  // SimpleCondition.source / .attribute (ConditionEngine reads them when
  // resolving the left-hand value). `source: 'text'` is the engine default, so
  // it is omitted to keep serialised workflows stable/diff-friendly.
  function buildSimpleCondition(row) {
    var cond = { operator: (row && row.operator) || 'exists' };
    if (row && row.selector !== undefined && row.selector !== '') cond.selector = row.selector;
    if (row && row.value !== undefined && row.value !== '') cond.value = row.value;
    if (row && row.expected !== undefined && row.expected !== '') {
      cond.expected = LIST_OPERATORS.indexOf(cond.operator) >= 0
        ? splitListValue(row.expected)
        : row.expected;
    }
    if (row && row.source !== undefined && row.source !== '' && row.source !== 'text') {
      cond.source = row.source;
    }
    if (row && row.attribute !== undefined && row.attribute !== '') cond.attribute = row.attribute;
    // `codeContext` only ever arrives from an imported Automa workflow — this
    // product has a single execution context and therefore no control for it
    // (rule R3). Passed through rather than defaulted, so a round-trip does not
    // silently drop it AND a row that never had it stays byte-identical.
    if (row && row.codeContext === 'page') cond.codeContext = 'page';
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

  // -------- prioritised paths (mission 7) ------------------------------------
  // An `if` node may carry an ORDERED list of paths on `params.paths` (JSON):
  //   [{ id, name, groups: [[row,…],…] }, …]
  // Evaluated top → down at runtime; first true path wins; if none match the
  // run leaves through the neutral `next` port. Returns null for the classic
  // single-path node so its serialised shape is byte-identical to before.
  //
  // This parser is deliberately standalone (it does NOT reach for NdvModel):
  // graph-serialize.js is the boundary the backend sees and is unit-tested on
  // its own, so it must be able to read a graph without the NDV layer loaded.
  var PATH_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
  function parsePaths(params, allowSingle) {
    params = params || {};
    var raw = params.paths;
    // A Router with no stored list yet is one path built from the flat fields.
    if (!raw) return allowSingle ? [{ id: 'p1', name: '', groups: parseGroups(params.groups) }] : null;
    var arr = raw;
    if (typeof raw === 'string') {
      try { arr = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!Array.isArray(arr)) return null;
    var used = {};
    var out = [];
    arr.forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var id = typeof p.id === 'string' && PATH_ID_RE.test(p.id) && !used[p.id] ? p.id : null;
      if (!id) { id = 'p' + (out.length + 1); if (used[id]) return; }
      used[id] = true;
      out.push({
        id: id,
        name: typeof p.name === 'string' ? p.name : '',
        groups: Array.isArray(p.groups) ? p.groups : null,
      });
    });
    // A single path IS the classic true/false node — do not switch shapes.
    // The Router has no true/false form, so one path is a perfectly valid
    // Router (`allowSingle`).
    return (out.length > 1 || (allowSingle && out.length > 0)) ? out : null;
  }

  // The canvas port id that carries a path's branch.
  function pathPortId(id) { return 'path:' + id; }

  // Reverse of buildCondition: reconstruct editor `groups` from a stored
  // composite condition. Returns null when the condition is a plain simple
  // condition (legacy editor fields are used instead).
  // One backend SimpleCondition -> one editor row. Hoisted to module scope
  // because the multi-path importer needs the same conversion for a path whose
  // condition is a bare simple condition (conditionToGroups returns null there,
  // and a path has no legacy flat fields to fall back to).
  function simpleRowFromCondition(c) {
    var row = { operator: (c && c.operator) || 'exists' };
    if (!c || typeof c !== 'object') return row;
    if (c.selector !== undefined) row.selector = String(c.selector);
    if (c.value !== undefined) row.value = String(c.value);
    // `in_list` / `not_in_list` arrive as a real ARRAY (see splitListValue).
    // Join them back with ", " so the row edits as the same comma list the
    // user typed — `String(['a','b'])` would give "a,b" without the space and
    // an object array would give "[object Object]".
    if (c.expected !== undefined) {
      row.expected = Array.isArray(c.expected)
        ? c.expected.map(function (v) { return String(v); }).join(', ')
        : String(c.expected);
    }
    if (c.source !== undefined) row.source = String(c.source);
    if (c.attribute !== undefined) row.attribute = String(c.attribute);
    // The reverse half of the pass-through in buildSimpleCondition. Only the one
    // value the engine's type allows is accepted, so a hand-edited or imported
    // workflow cannot smuggle an execution context that does not exist here.
    if (c.codeContext === 'page') row.codeContext = 'page';
    return row;
  }

  function conditionToGroups(cond) {
    if (!cond || typeof cond !== 'object') return null;
    var simpleRow = simpleRowFromCondition;
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
  //
  // The editor's graph is a DAG-ish canvas; the backend wants NESTED steps[].
  // The conversion rules (task 3 — see docs/uiux/20-HANDOFF-conditional-nodes.md):
  //
  //  1. JOIN.  When the branches of an `if` / `router` / `switch` converge on a
  //     node, that node is emitted ONCE, AFTER the branching step, in the
  //     parent chain — not copied into every branch. Two ways to say "join":
  //       a) wire the node's own `next` port to it (explicit), or
  //       b) wire every non-empty branch to the same node (inferred; the
  //          nearest node reachable from ALL branches is the join point).
  //     Branch walks STOP at the join (`stops`), so nested joins compose.
  //  2. CYCLES are rejected. A loop is a `loop`/`foreach`/`while` node, never a
  //     back-edge; an edge to a node that is already on the way down the
  //     current descent is reported as `cycle` (error), not silently cut.
  //  3. A node reachable from several branches that do NOT all converge (a
  //     "partial join") is emitted in each branch that reaches it — faithful
  //     for exclusive branches — and reported as the warning `duplicated`.
  //  4. Two edges leaving the SAME port (`fanout`) and edges to a missing node
  //     (`dangling`) are errors: the runtime can only follow one.
  //
  // `analyze()` is the single implementation; graphToSteps()/validateGraph()
  // are views of it, so the canvas, the run button and the tests can never
  // disagree about what a graph means.
  var LOOP_LIKE = { loop: true, foreach: true, while: true };

  // The port a node continues through once its own work (and branches) is done.
  function continuationPort(action) { return LOOP_LIKE[action] ? 'done' : 'next'; }

  // Ports of `node` that carry a nested group (everything except the
  // continuation port). Only branching actions have any.
  function branchPortsOf(graph, node) {
    var action = node.action;
    var out = [];
    if (action === 'if') {
      var ip = parsePaths(node.params || {});
      if (ip) ip.forEach(function (p) { out.push(pathPortId(p.id)); });
      else out.push('then', 'else');
    } else if (action === 'router') {
      var rp = parsePaths(node.params || {}, true) || [];
      rp.forEach(function (p) { out.push(pathPortId(p.id)); });
      out.push('default');
    } else if (action === 'switch') {
      out.push('default');
      edgesFrom(graph, node.id).forEach(function (e) {
        if ((e.port || '').indexOf('case:') === 0 && out.indexOf(e.port) < 0) out.push(e.port);
      });
    } else if (action === 'try') {
      out.push('try', 'catch', 'finally');
    } else if (LOOP_LIKE[action]) {
      out.push('body');
    }
    return out;
  }

  // Nodes reachable from `startId` (inclusive), in depth-first pre-order.
  function reachOrder(graph, startId) {
    var order = [];
    var seen = {};
    (function visit(id) {
      if (!id || seen[id] || !graph.nodes[id] || order.length > 5000) return;
      seen[id] = true;
      order.push(id);
      edgesFrom(graph, id).forEach(function (e) { visit(e.to); });
    })(startId);
    return { order: order, set: seen };
  }

  // The node the main chain continues with after `node` (and its branches).
  // `explicit` is true when the user wired the continuation port themselves.
  function joinTarget(graph, node) {
    var cont = portTarget(graph, node.id, continuationPort(node.action));
    if (cont) return cont;
    // `try` and loops never converge their branches; only the sequential
    // branchers (if / router / switch) infer a join.
    if (node.action !== 'if' && node.action !== 'router' && node.action !== 'switch') return null;
    var reaches = [];
    branchPortsOf(graph, node).forEach(function (port) {
      var to = portTarget(graph, node.id, port);
      if (to && graph.nodes[to]) reaches.push(reachOrder(graph, to));
    });
    if (reaches.length < 2) return null;
    for (var i = 0; i < reaches[0].order.length; i++) {
      var id = reaches[0].order[i];
      var inAll = true;
      for (var j = 1; j < reaches.length; j++) {
        if (!reaches[j].set[id]) { inAll = false; break; }
      }
      if (inAll) return id;
    }
    return null;
  }

  function withStop(stops, id) {
    var out = {};
    Object.keys(stops).forEach(function (k) { out[k] = true; });
    if (id) out[id] = true;
    return out;
  }

  // Walks a chain starting from the node reached via `startPort` of `fromId`.
  // `ctx.active` holds the ids on the current descent (cycle detection);
  // `stops` are join points owned by an ENCLOSING branching node.
  function walkChain(graph, fromId, startPort, ctx, stops) {
    var steps = [];
    var visited = [];
    var prevFrom = fromId;
    var prevPort = startPort;
    var nextId = portTarget(graph, fromId, startPort);
    var guard = 0;
    while (nextId && guard < 5000) {
      guard += 1;
      if (stops[nextId]) break;                 // reached the enclosing join
      var node = graph.nodes[nextId];
      if (!node) {
        ctx.errors.push({ code: 'dangling', nodeId: prevFrom, edge: { from: prevFrom, to: nextId, port: prevPort }, message: 'val.dangling' });
        break;
      }
      if (ctx.active[nextId]) {
        ctx.errors.push({ code: 'cycle', nodeId: nextId, edge: { from: prevFrom, to: nextId, port: prevPort }, message: 'val.cycle' });
        break;
      }
      ctx.active[nextId] = true;
      visited.push(nextId);
      if (ctx.emitted[nextId]) {
        if (!ctx.dupSeen[nextId]) {
          ctx.dupSeen[nextId] = true;
          ctx.warnings.push({ code: 'duplicated', nodeId: nextId, message: 'val.duplicated' });
        }
      }
      ctx.emitted[nextId] = true;
      prevFrom = node.id;
      // A node flagged `disabled` is SKIPPED exactly the way n8n skips a
      // deactivated node: it emits no step and the chain continues through its
      // MAIN `next` port, so switching one node off does not tear the rest of
      // the flow apart. Disabling a BRANCHING node also drops everything that
      // hangs off its branch ports (they are only reachable through it).
      if (node.disabled === true && !ctx.keepDisabled) {
        prevPort = 'next';
        nextId = portTarget(graph, node.id, 'next');
        continue;
      }
      var built = buildNode(graph, node, ctx, stops);
      if (built.step) {
        applyErrorPolicy(built.step, node);
        // DOCUMENT mode (save / export): the node stays in the workflow and is
        // flagged, so switching a node off is not the same as deleting it. The
        // runtime skips a `disabled` step; RUN mode never sees one (above).
        if (node.disabled === true) built.step.disabled = true;
        steps.push(built.step);
      }
      prevPort = continuationPort(node.action);
      nextId = built.continueId;
    }
    visited.forEach(function (id) { delete ctx.active[id]; });
    return steps;
  }

  // Builds the AutomationStep for one node and returns the id of the node the
  // MAIN chain should continue to (or null to stop).
  function buildNode(graph, node, ctx, stops) {
    var action = node.action;
    var params = coerceParams(action, node.params);

    if (action === 'if' || action === 'router' || action === 'switch') {
      // A multi-path `if` keeps its Mission-7 semantics: the runtime LEAVES the
      // group once a path matched, and `next` is the neutral "nothing matched"
      // port — so no join may be inferred or stopped at (the node after a join
      // would never run). Router / two-way if / switch continue after their
      // branch, which is exactly what a join means.
      var multiIf = action === 'if' && !!parsePaths(node.params || {});
      var join = multiIf ? portTarget(graph, node.id, 'next') : joinTarget(graph, node);
      var inner = multiIf ? stops : withStop(stops, join);

      if (action === 'if') {
        // Mission 7 — N prioritised paths. The runtime evaluates `paths` in
        // order and takes the FIRST true one; `then`/`else` are not emitted at
        // all in that shape, so there is no way for both routings to fire.
        var paths = parsePaths(node.params || {});
        if (paths) {
          var pStep = {
            action: 'if',
            condition: buildCondition({ groups: JSON.stringify(paths[0].groups || []) }),
            paths: paths.map(function (p) {
              var entry = {
                id: p.id,
                condition: buildCondition({ groups: JSON.stringify(p.groups || []) }),
              };
              if (p.name) entry.name = p.name;
              var psteps = walkChain(graph, node.id, pathPortId(p.id), ctx, inner);
              if (psteps.length) entry.steps = psteps;
              return entry;
            }),
          };
          return { step: pStep, continueId: join };
        }
        var step = { action: 'if', condition: buildCondition(node.params || {}) };
        var thenSteps = walkChain(graph, node.id, 'then', ctx, inner);
        var elseSteps = walkChain(graph, node.id, 'else', ctx, inner);
        if (thenSteps.length) step.then = thenSteps;
        if (elseSteps.length) step.else = elseSteps;
        return { step: step, continueId: join };
      }

      if (action === 'router') {
        // Router = N prioritised paths + a DEFAULT (fallback) port. First match
        // wins; when nothing matches the `default` branch runs; either way the
        // run then continues with whatever follows the router (the join).
        var rpaths = parsePaths(node.params || {}, true) || [];
        var rStep = {
          action: 'router',
          paths: rpaths.map(function (p) {
            var rentry = {
              id: p.id,
              condition: buildCondition({ groups: JSON.stringify(p.groups || []) }),
            };
            if (p.name) rentry.name = p.name;
            var rsteps = walkChain(graph, node.id, pathPortId(p.id), ctx, inner);
            if (rsteps.length) rentry.steps = rsteps;
            return rentry;
          }),
        };
        var fb = walkChain(graph, node.id, 'default', ctx, inner);
        if (fb.length) rStep.fallback = fb;
        return { step: rStep, continueId: join };
      }

      var sStep = { action: 'switch', params: { variable: params.variable }, cases: {} };
      // default port
      var def = walkChain(graph, node.id, 'default', ctx, inner);
      if (def.length) sStep.cases['default'] = def;
      // explicit case ports: edges with port 'case:<value>'
      var es = edgesFrom(graph, node.id);
      for (var i = 0; i < es.length; i++) {
        var p = es[i].port || 'next';
        if (p.indexOf('case:') === 0) {
          sStep.cases[p.slice(5)] = walkChain(graph, node.id, p, ctx, inner);
        }
      }
      return { step: sStep, continueId: join };
    }

    if (LOOP_LIKE[action]) {
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
      var body = walkChain(graph, node.id, 'body', ctx, stops);
      loopStep.steps = body.length ? body : [];
      return { step: loopStep, continueId: portTarget(graph, node.id, 'done') };
    }

    if (action === 'try') {
      var tStep = { action: 'try' };
      var tryS = walkChain(graph, node.id, 'try', ctx, stops);
      var catchS = walkChain(graph, node.id, 'catch', ctx, stops);
      var finallyS = walkChain(graph, node.id, 'finally', ctx, stops);
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

  // Structural problems that exist regardless of how the walk goes.
  function edgeIssues(graph, errors) {
    var count = {};
    graph.edges.forEach(function (e) {
      if (!e) return;
      var key = e.from + '\u0000' + (e.port || 'next');
      count[key] = (count[key] || 0) + 1;
      if (count[key] === 2) {
        errors.push({
          code: 'fanout', nodeId: e.from,
          edge: { from: e.from, to: e.to, port: e.port || 'next' },
          message: 'val.fanout',
        });
      }
    });
  }

  function analyze(graph, opts) {
    var ctx = { errors: [], warnings: [], active: {}, emitted: {}, dupSeen: {}, keepDisabled: !!(opts && opts.keepDisabled) };
    if (!graph || !graph.nodes || !Array.isArray(graph.edges)) {
      return { steps: [], errors: ctx.errors, warnings: ctx.warnings };
    }
    edgeIssues(graph, ctx.errors);
    var steps = walkChain(graph, 'start', 'next', ctx, {});
    return { steps: steps, errors: ctx.errors, warnings: ctx.warnings };
  }

  function graphToSteps(graph) {
    return analyze(graph).steps;
  }

  /**
   * The DOCUMENT form of the graph (what is saved and exported): same as
   * graphToSteps(), but a node switched off stays in the list, flagged
   * `disabled: true`. graphToSteps() (what RUNS) still leaves it out, so the
   * editor's step-index mapping is untouched.
   */
  function graphToDocumentSteps(graph) {
    return analyze(graph, { keepDisabled: true }).steps;
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
        if (s.disabled === true) node.disabled = true;
        // copy scalar params back as strings (editor stores strings)
        if (s.params && typeof s.params === 'object') {
          Object.keys(s.params).forEach(function (k) {
            // Object params (Launch Browser `browserOptions`) are kept as JSON text:
            // String({}) would be "[object Object]" and the options would be lost.
            var pv = s.params[k];
            node.params[k] = (pv !== null && typeof pv === 'object') ? JSON.stringify(pv) : String(pv);
          });
        }
        // Mission 7 — a multi-path `if` round-trips through `params.paths`.
        // Each path's backend condition is turned back into builder groups, so
        // re-opening an imported workflow shows the same ordered list.
        var importedPaths = null;
        if ((s.action === 'router' && Array.isArray(s.paths) && s.paths.length > 0) ||
            (s.action === 'if' && Array.isArray(s.paths) && s.paths.length > 1)) {
          importedPaths = s.paths.map(function (p, pi) {
            var pg = (p && p.condition) ? conditionToGroups(p.condition) : null;
            if (!pg && p && p.condition) pg = [[simpleRowFromCondition(p.condition)]];
            return {
              id: (p && typeof p.id === 'string' && PATH_ID_RE.test(p.id)) ? p.id : ('p' + (pi + 1)),
              name: (p && typeof p.name === 'string') ? p.name : '',
              groups: pg || [[{ operator: 'exists' }]],
            };
          });
          node.params.paths = JSON.stringify(importedPaths);
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
            // An `in_list` expected arrives as an array; join it the way the
            // builder's "Allowed values" field displays it, so importing a
            // workflow and re-saving it does not rewrite the user's own text.
            if (c.expected !== undefined) {
              node.params.expected = Array.isArray(c.expected)
                ? c.expected.map(function (v) { return String(v); }).join(', ')
                : String(c.expected);
            }
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
        if ((s.action === 'if' || s.action === 'router') && importedPaths) {
          importedPaths.forEach(function (p, pi) {
            lane(s.paths[pi] && s.paths[pi].steps, 'path:' + p.id);
          });
          if (s.action === 'router') lane(s.fallback, 'default');
        } else if (s.action === 'if') {
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

    // Structural verdict of the very walk graphToSteps() performs: cycles,
    // two edges on one port, edges to a missing node, partial joins. A graph
    // with an error here CANNOT be turned into steps[] faithfully, so the run
    // button refuses it (flow-editor) and the offending node/edge is marked.
    var an = analyze(graph);
    an.errors.forEach(function (e) { errors.push(e); });
    an.warnings.forEach(function (w) { warnings.push(w); });

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
      // if needs at least one branch — for a multi-path node, at least one of
      // its `path:<id>` ports must lead somewhere (the neutral `next` port is
      // not a branch: leaving every path empty means the node decides nothing).
      if (node.action === 'if') {
        var ifPaths = parsePaths(node.params || {});
        if (ifPaths) {
          var anyPath = false;
          for (var pi = 0; pi < ifPaths.length; pi++) {
            if (portTarget(graph, id, pathPortId(ifPaths[pi].id))) { anyPath = true; break; }
          }
          if (!anyPath) warnings.push({ code: 'empty-if', nodeId: id, message: 'val.emptyIf' });
        } else if (!portTarget(graph, id, 'then') && !portTarget(graph, id, 'else')) {
          warnings.push({ code: 'empty-if', nodeId: id, message: 'val.emptyIf' });
        }
      }
      // router: at least one path, and at least one branch wired
      if (node.action === 'router') {
        var rps = parsePaths(node.params || {}, true) || [];
        if (!rps.length) {
          errors.push({ code: 'router-paths', nodeId: id, message: 'val.routerPaths' });
        } else {
          var anyR = !!portTarget(graph, id, 'default');
          for (var ri = 0; ri < rps.length && !anyR; ri++) {
            if (portTarget(graph, id, pathPortId(rps[ri].id))) anyR = true;
          }
          if (!anyR) warnings.push({ code: 'empty-if', nodeId: id, message: 'val.emptyIf' });
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
        // A multi-path `if` replaces then/else with one `path:<id>` port per
        // path, in priority order, so the outline mirrors the canvas.
        if (node.action === 'if') {
          var np = parsePaths(node.params || {});
          if (np) {
            branchPorts = np.map(function (p) {
              return { id: pathPortId(p.id), label: 'port.path' };
            });
          }
        }
        if (node.action === 'router') {
          branchPorts = (parsePaths(node.params || {}, true) || []).map(function (p) {
            return { id: pathPortId(p.id), label: 'port.path' };
          });
          branchPorts.push({ id: 'default', label: 'port.default' });
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
        var contPort = LOOP_LIKE[node.action] ? 'done' : 'next';
        id = portTarget(graph, id, contPort);
      }
    }

    walk('start', 'next', '');
    return rows;
  }

  window.GraphSerialize = {
    graphToSteps: graphToSteps,
    graphToDocumentSteps: graphToDocumentSteps,
    stepsToGraph: stepsToGraph,
    validateGraph: validateGraph,
    outlineTree: outlineTree,
    // exported for tests / reuse
    coerceParams: coerceParams,
    buildCondition: buildCondition,
    conditionToGroups: conditionToGroups,
    parsePaths: parsePaths,
    pathPortId: pathPortId,
    analyze: analyze,
    branchPortsOf: branchPortsOf,
    CONDITION_ONLY_PARAMS: CONDITION_ONLY_PARAMS,
    OUTLINE_MAX_ROWS: OUTLINE_MAX_ROWS,
  };
})();
