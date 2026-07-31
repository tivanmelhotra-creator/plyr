/*
 * ndv-nodes.js — per-node NDV designs for the nodes that have a LOCKED preview
 * image in docs/uiux/.
 *
 * Scope rule (deliberate, see docs/uiux/00-PROCESS-node-design.md):
 *   Only design the nodes that actually have a final preview. Today that is
 *     · ndv-click-element-final  -> action `click`
 *     · ndv-condition-final      -> actions `if` / `while`
 *   Everything else keeps the generic parameter list. Getting these two exactly
 *   right (and factoring their shared chrome into ndv-ui.js) is worth more than
 *   approximating every node.
 *
 * This module owns the three NDV columns for designed nodes:
 *   renderInput(col, ctx)   INPUT — tabs · run selector · search · tree · chips
 *   renderCenter(col, ctx)  the bespoke centre column (returns false if the
 *                           action has no design, so the caller can fall back)
 *   renderOutput(col, ctx)  OUTPUT — tabs · search · empty state · status strip
 *
 * ctx = {
 *   node,            // editor node { id, action, params, … }
 *   inputItems,      // array of WorkflowItem-shaped objects
 *   outputItems,
 *   meta,            // { status, durationMs, outputItemCount, error }
 *   onParamsChange,  // () => void  — repaint canvas card + validation
 *   onStructureChange// () => void  — repaint the whole centre column
 * }
 *
 * Pure DOM, CSP-safe. Loaded BEFORE flow-editor.js. LF line endings.
 */
(function () {
  'use strict';

  function UI() { return window.NdvUI; }
  function M() { return window.NdvModel; }
  function U() { return window.AppUtil; }
  function t(k) { return U() ? U().t(k) : k; }

  // =========================================================================
  // Shared: expression-aware value field (Fixed <-> {{ Expression }} via `fx`)
  // =========================================================================
  // The design shows a small `fx` button beside expressionable values. Pressing
  // it flips the control to an expression textarea that accepts drops from the
  // INPUT column and shows a live preview underneath.
  function exprField(opts) {
    var ui = UI();
    var wrap = ui.el('div', 'aria-exprfield');
    var host = ui.el('div', 'aria-exprfield-host');
    var isExpr = window.ExpressionEngine
      ? window.ExpressionEngine.isExpression(opts.value)
      : /\{\{[\s\S]*?\}\}/.test(String(opts.value == null ? '' : opts.value));
    var preview = ui.el('div', 'aria-exprfield-preview');

    function renderPreview(raw) {
      preview.className = 'aria-exprfield-preview';
      preview.textContent = '';
      if (!window.ExpressionEngine || !window.ExpressionEngine.isExpression(raw)) return;
      try {
        var v = window.ExpressionEngine.evaluateTemplate(raw, opts.exprContext || { json: {}, index: 0 });
        preview.classList.add('ok');
        preview.textContent = '= ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 90);
      } catch (e) {
        preview.classList.add('err');
        preview.textContent = '! ' + (e && e.message ? e.message : t('expr.invalid'));
      }
    }

    function acceptDrop(input) {
      input.addEventListener('dragover', function (ev) {
        ev.preventDefault(); input.classList.add('drag-over');
      });
      input.addEventListener('dragleave', function () { input.classList.remove('drag-over'); });
      input.addEventListener('drop', function (ev) {
        ev.preventDefault(); input.classList.remove('drag-over');
        var tok = ev.dataTransfer.getData('text/x-expr') || ev.dataTransfer.getData('text/plain');
        if (!tok) return;
        var pos = input.selectionStart != null ? input.selectionStart : input.value.length;
        input.value = input.value.slice(0, pos) + tok + input.value.slice(pos);
        opts.onChange(input.value);
        renderPreview(input.value);
      });
    }

    function build() {
      host.innerHTML = '';
      var input;
      if (isExpr) {
        input = ui.el('textarea', 'aria-input aria-input-expr');
        input.rows = 2;
        input.placeholder = '{{ $json.field }}';
      } else {
        input = ui.el('input', 'aria-input');
        input.type = 'text';
        input.placeholder = opts.placeholder || '';
      }
      input.value = opts.value != null ? String(opts.value) : '';
      input.addEventListener('input', function () {
        opts.value = input.value;
        opts.onChange(input.value);
        renderPreview(input.value);
      });
      acceptDrop(input);
      host.appendChild(input);
      renderPreview(input.value);
    }

    var row = ui.el('div', 'aria-exprfield-row');
    row.appendChild(host);
    (opts.buttons || []).forEach(function (b) { row.appendChild(b); });
    var fx = ui.iconBtn('fx', t('expr.toggleHint'), 'is-fx' + (isExpr ? ' on' : ''), function () {
      isExpr = !isExpr;
      fx.classList.toggle('on', isExpr);
      build();
    });
    row.appendChild(fx);
    wrap.appendChild(row);
    wrap.appendChild(preview);
    build();
    return wrap;
  }

  // A target-picker button: hands the selector field over to the live Element
  // Picker when the browser view is available, otherwise explains why not.
  //
  // `getOpts` is read at CLICK time, not at build time, so the picker always
  // opens seeded with what the field holds right now (and in the selector
  // dialect the node is set to) instead of a stale snapshot.
  function pickerBtn(onPicked, getOpts) {
    return UI().iconBtn('target', t('ndv.pickElement'), 'is-picker', function () {
      if (window.BrowserView && typeof window.BrowserView.requestPick === 'function') {
        var opts = {};
        try { opts = (typeof getOpts === 'function' ? getOpts() : null) || {}; } catch (e) {}
        window.BrowserView.requestPick(onPicked, opts);
        return;
      }
      if (U() && U().toast) U().toast(t('ndv.pickHint'), 'info');
    });
  }

  // =========================================================================
  // INPUT column (identical design in both previews)
  // =========================================================================
  function renderInput(col, ctx) {
    var ui = UI();
    col.innerHTML = '';
    col.appendChild(ui.el('div', 'ndv-col-head', t('ndv.input')));

    var view = 'schema';
    var query = '';

    var tabs = ui.segmented([
      { id: 'schema', label: t('ndv.tabSchema') },
      { id: 'table', label: t('ndv.tabTable') },
      { id: 'json', label: t('ndv.tabJson') },
    ], view, function (id) { view = id; paint(); });
    col.appendChild(tabs.root);

    var items = ctx.inputItems || [];
    col.appendChild(ui.runSelector(Math.max(1, items.length), items.length, null));

    var search = ui.searchField(t('ndv.searchInput'), function (v) { query = v; paint(); });
    col.appendChild(search.root);

    var body = ui.el('div', 'aria-col-body');
    col.appendChild(body);

    var sample = items.length
      ? (items[0] && items[0].json ? items[0].json : items[0])
      : null;

    function paint() {
      body.innerHTML = '';
      if (!sample) {
        body.appendChild(ui.el('div', 'ndv-empty muted small', t('ndv.noInput')));
        return;
      }
      if (view === 'json') {
        var pre = ui.el('pre', 'aria-json');
        try { pre.textContent = JSON.stringify(items, null, 2).slice(0, 6000); }
        catch (e) { pre.textContent = String(items); }
        body.appendChild(pre);
        return;
      }
      if (view === 'table') {
        body.appendChild(flatTable(items, query));
        return;
      }
      body.appendChild(ui.dataTree(ui.treeFrom(sample), '$json', query));
    }
    paint();

    // bottom drag chips: the first few scalar leaf paths of the sample
    if (sample) {
      var leaves = [];
      (function walk(obj, base, depth) {
        if (!obj || typeof obj !== 'object' || depth > 3 || leaves.length >= 4) return;
        Object.keys(obj).forEach(function (k) {
          if (leaves.length >= 4) return;
          var v = obj[k];
          var p = base ? base + '.' + k : k;
          if (v && typeof v === 'object') walk(v, p, depth + 1);
          else leaves.push({ path: p });
        });
      })(sample, '$json', 0);
      col.appendChild(ui.dragChips(leaves, t('ndv.dragHint'), null));
    }
  }

  // A compact key/value table for the INPUT "Table" tab.
  function flatTable(items, query) {
    var ui = UI();
    var q = (query || '').trim().toLowerCase();
    var table = ui.el('div', 'aria-kvtable');
    var sample = items.length ? (items[0].json || items[0]) : {};
    (function walk(obj, base, depth) {
      if (!obj || typeof obj !== 'object' || depth > 3) return;
      Object.keys(obj).forEach(function (k) {
        var v = obj[k];
        var p = base ? base + '.' + k : k;
        if (v && typeof v === 'object') { walk(v, p, depth + 1); return; }
        if (q && p.toLowerCase().indexOf(q) === -1 &&
            String(v).toLowerCase().indexOf(q) === -1) return;
        var row = ui.el('div', 'aria-kvrow');
        row.appendChild(ui.el('span', 'aria-kvkey', p));
        row.appendChild(ui.el('span', 'aria-kvval', v == null ? '—' : String(v).slice(0, 40)));
        table.appendChild(row);
      });
    })(sample, '', 0);
    if (!table.children.length) table.appendChild(ui.el('div', 'aria-tree-none', t('ndv.noMatch')));
    return table;
  }

  // =========================================================================
  // OUTPUT column (identical design in both previews)
  // =========================================================================
  function renderOutput(col, ctx) {
    var ui = UI();
    col.innerHTML = '';
    col.appendChild(ui.el('div', 'ndv-col-head', t('ndv.output')));

    var view = 'schema';
    var query = '';
    var tabs = ui.segmented([
      { id: 'schema', label: t('ndv.tabSchema') },
      { id: 'table', label: t('ndv.tabTable') },
      { id: 'json', label: t('ndv.tabJson') },
    ], view, function (id) { view = id; paint(); });
    col.appendChild(tabs.root);

    var items = ctx.outputItems || [];
    col.appendChild(ui.runSelector(Math.max(1, items.length), items.length, null));
    var search = ui.searchField(t('ndv.searchOutput'), function (v) { query = v; paint(); });
    col.appendChild(search.root);

    var body = ui.el('div', 'aria-col-body');
    col.appendChild(body);

    var meta = ctx.meta || {};

    function paint() {
      body.innerHTML = '';
      if (!items.length) {
        // Representative result shape for the designed node (spec §5).
        var codePreview = null;
        if (ctx.node && ctx.node.action === 'click') {
          try {
            codePreview = JSON.stringify(M().clickPayloadPreview(ctx.node.params), null, 1)
              .replace(/\n\s*/g, ' ');
          } catch (e) { codePreview = null; }
        } else if (ctx.node && (ctx.node.action === 'if' || ctx.node.action === 'while')) {
          codePreview = '{ "result": true, "matchedGroup": "A", "evaluatedConditions": [] }';
        }
        body.appendChild(ui.outputEmpty(t('ndv.outEmptyTitle'), t('ndv.outEmptySub'), codePreview));
        return;
      }
      if (view === 'json' || view === 'table') {
        var pre = ui.el('pre', 'aria-json');
        try { pre.textContent = JSON.stringify(items, null, 2).slice(0, 6000); }
        catch (e) { pre.textContent = String(items); }
        body.appendChild(pre);
        return;
      }
      var sample = items[0] && items[0].json ? items[0].json : items[0];
      body.appendChild(ui.dataTree(ui.treeFrom(sample), '$json', query));
    }
    paint();

    var statusText = meta.status === 'success' ? t('ndv.statusSuccess')
      : meta.status === 'error' ? t('ndv.statusError')
      : meta.status === 'running' ? t('ndv.statusRunning')
      : t('ndv.statusIdle');
    var tone = meta.status === 'success' ? 'good' : meta.status === 'error' ? 'bad' : '';
    var size = '—';
    if (items.length) {
      try { size = Math.round(JSON.stringify(items).length / 1024 * 10) / 10 + ' KB'; }
      catch (e) { size = '—'; }
    }
    col.appendChild(ui.statusStrip(
      { text: statusText, tone: tone },
      meta.durationMs != null ? meta.durationMs + ' ms' : '—',
      size
    ));
  }

  // =========================================================================
  // DESIGN 1 — Click Element  (docs/uiux/ndv-click-element-final)
  // =========================================================================
  function renderClick(col, ctx) {
    var ui = UI();
    var node = ctx.node;
    var p = M().normalizeClickParams(node.params);
    // Persist the normalised contract so the runtime and the canvas summary
    // always see explicit values instead of "unset".
    Object.keys(p).forEach(function (k) { node.params[k] = p[k]; });

    function set(k, v) {
      node.params[k] = v;
      if (ctx.onParamsChange) ctx.onParamsChange();
    }
    var exprCtx = ctx.exprContext || { json: {}, index: 0 };

    // ---- 1. Selector -----------------------------------------------------
    var s1 = ui.section(t('click.secSelector'), 1);
    s1.body.appendChild(ui.fieldCell(
      t('click.selectorType'),
      ui.selectCell([
        { value: 'css', label: t('click.selTypeCss') },
        { value: 'xpath', label: t('click.selTypeXpath') },
        { value: 'text', label: t('click.selTypeText') },
      ], p.selectorType, function (v) { set('selectorType', v); })
    ));
    var selLabel = p.selectorType === 'xpath' ? t('click.selTypeXpath')
      : p.selectorType === 'text' ? t('click.selTypeText') : t('click.selTypeCss');
    var selField = exprField({
      value: p.selector,
      placeholder: '#next-button',
      exprContext: exprCtx,
      onChange: function (v) { set('selector', v); },
      buttons: [pickerBtn(function (sel) {
        set('selector', sel);
        if (ctx.onStructureChange) ctx.onStructureChange();
      }, function () {
        // `text` has no picker dialect (there is nothing to compute), so the
        // panel falls back to CSS and the user can still switch to XPath.
        return {
          value: p.selector,
          mode: p.selectorType === 'xpath' ? 'xpath' : 'css',
          url: ctx.pageUrl || '',
        };
      })],
    });
    var selCell = ui.fieldCell(selLabel, selField, t('click.selectorHelp'));
    selCell.querySelector('.aria-cell-label').appendChild(ui.el('span', 'aria-microtag', p.selectorType.toUpperCase()));
    s1.body.appendChild(selCell);
    col.appendChild(s1.root);

    // ---- 2. Click options ------------------------------------------------
    // 4-up in one row, as in the preview — see the `.cols-4` note in styles.css.
    var s2 = ui.section(t('click.secClickOptions'), 4);
    s2.body.appendChild(ui.fieldCell(t('click.clickType'),
      ui.selectCell([
        { value: 'single', label: t('click.typeSingle') },
        { value: 'double', label: t('click.typeDouble') },
        { value: 'triple', label: t('click.typeTriple') },
      ], p.clickType, function (v) {
        set('clickType', v);
        set('clickCount', v === 'double' ? 2 : v === 'triple' ? 3 : 1);
        if (ctx.onStructureChange) ctx.onStructureChange();
      })));
    s2.body.appendChild(ui.fieldCell(t('p.mouseButton'),
      ui.selectCell([
        { value: 'left', label: t('click.btnLeft') },
        { value: 'middle', label: t('click.btnMiddle') },
        { value: 'right', label: t('click.btnRight') },
      ], p.button, function (v) { set('button', v); })));
    s2.body.appendChild(ui.fieldCell(t('click.clickCount'),
      ui.numberCell(p.clickCount, { min: 1, max: 10 }, function (v) { set('clickCount', v); })));
    s2.body.appendChild(ui.fieldCell(t('click.delayBefore'),
      ui.numberCell(p.delayBeforeMs, { min: 0, placeholder: '0' }, function (v) { set('delayBeforeMs', v); })));
    col.appendChild(s2.root);

    // ---- 3. Selector options (toggles + inline numerics) -----------------
    var s3 = ui.section(t('click.secSelectorOptions'), 2);
    s3.body.appendChild(ui.toggleRow(t('click.waitForSelector'), p.waitForSelector,
      function (v) { set('waitForSelector', v); }, { info: t('click.waitForSelectorHelp') }).root);
    s3.body.appendChild(ui.toggleRow(t('click.multipleMatches'), p.multipleMatches,
      function (v) { set('multipleMatches', v); }, { info: t('click.multipleMatchesHelp') }).root);
    s3.body.appendChild(ui.fieldCell(t('p.timeout'),
      ui.numberCell(p.timeout, { min: 0, placeholder: '10000' }, function (v) { set('timeout', v); }),
      null, null, { inline: true, info: t('help.timeoutMs') }));
    s3.body.appendChild(ui.toggleRow(t('click.highlightElement'), p.highlightElement,
      function (v) { set('highlightElement', v); }, { info: t('click.highlightElementHelp') }).root);
    s3.body.appendChild(ui.toggleRow(t('p.scrollIntoView'), p.scrollIntoView,
      function (v) { set('scrollIntoView', v); }).root);
    s3.body.appendChild(ui.toggleRow(t('click.visibleOnly'), p.visibleOnly,
      function (v) { set('visibleOnly', v); }).root);
    s3.body.appendChild(ui.fieldCell(t('click.stableFor'),
      ui.numberCell(p.stableForMs, { min: 0, placeholder: '300' }, function (v) { set('stableForMs', v); }),
      t('click.stableForHelp'), null, { inline: true }));
    col.appendChild(s3.root);

    // ---- 4. Position offsets --------------------------------------------
    var s4 = ui.section(t('click.secOffsets'), 2);
    s4.body.appendChild(ui.fieldCell(t('click.offsetX'),
      ui.numberCell(p.offsetX, { placeholder: '0' }, function (v) { set('offsetX', v); }),
      null, null, { inline: true }));
    s4.body.appendChild(ui.fieldCell(t('click.offsetY'),
      ui.numberCell(p.offsetY, { placeholder: '0' }, function (v) { set('offsetY', v); }),
      null, null, { inline: true }));
    var offHelp = ui.el('div', 'aria-cell-help span-2', t('click.offsetHelp'));
    s4.body.appendChild(offHelp);
    col.appendChild(s4.root);

    // ---- 5. Optional modifiers ------------------------------------------
    var s5 = ui.section(t('click.secModifiers'), 1);
    var checks = ui.el('div', 'aria-checkrow');
    checks.appendChild(ui.checkbox(t('click.modAlt'), p.modAlt, function (v) { set('modAlt', v); }));
    checks.appendChild(ui.checkbox(t('click.modCtrl'), p.modCtrl, function (v) { set('modCtrl', v); }));
    checks.appendChild(ui.checkbox(t('click.modShift'), p.modShift, function (v) { set('modShift', v); }));
    s5.body.appendChild(checks);
    col.appendChild(s5.root);

    // ---- 6. Behavior -----------------------------------------------------
    var s6 = ui.section(t('click.secBehavior'), 2);
    s6.body.appendChild(ui.toggleRow(t('click.humanLike'), p.human,
      function (v) { set('human', v); },
      { info: t('help.humanClick'), help: t('help.humanClick') }).root);
    s6.body.appendChild(ui.toggleRow(t('click.forceClick'), p.force,
      function (v) { set('force', v); },
      { info: t('help.forceClick'), help: t('help.forceClick') }).root);
    col.appendChild(s6.root);

    // ---- 7. `Continue on fail` -------------------------------------------
    // The preview puts this OUTSIDE the Behavior card, as a bare row closing
    // the column — and that is also the honest place for it, because it is NOT
    // a click param: the runtime reads it as a top-level AutomationStep field
    // (node.errorPolicy -> graph-serialize.js). It is surfaced here for
    // discoverability while still writing to the single source of truth, which
    // the Error tab also edits.
    node.errorPolicy = node.errorPolicy || {};
    var foot7 = ui.el('div', 'aria-footrow');
    foot7.appendChild(ui.toggleRow(t('settings.continueOnFail'),
      node.errorPolicy.continueOnFail === true,
      function (v) {
        node.errorPolicy.continueOnFail = v === true;
        if (ctx.onParamsChange) ctx.onParamsChange();
      },
      { info: t('help.continueOnFail') }).root);
    col.appendChild(foot7);
    return true;
  }

  // =========================================================================
  // DESIGN 2 — Condition Builder  (docs/uiux/ndv-condition-final)
  // =========================================================================
  var GROUP_LETTERS = 'ABCDEFGH';

  function renderCondition(col, ctx) {
    var ui = UI();
    var m = M();
    var node = ctx.node;
    var groups = m.readGroups(node.params);
    var exprCtx = ctx.exprContext || { json: {}, index: 0 };

    function commit() {
      m.writeGroups(node.params, groups);
      if (ctx.onParamsChange) ctx.onParamsChange();
    }
    function restructure() {
      commit();
      if (ctx.onStructureChange) ctx.onStructureChange();
    }

    // ---- builder header: title · Path 1 pill · + Add path ---------------
    var head = ui.el('div', 'cb-head');
    head.appendChild(ui.el('div', 'cb-head-title', t('cb.builder')));
    var addPath = ui.el('button', 'cb-addpath', '+ ' + t('cb.addPath'));
    addPath.type = 'button';
    addPath.disabled = true; // v1 runtime = single path (true/false) — spec §2
    addPath.title = t('cb.addPathV2');
    head.appendChild(addPath);
    col.appendChild(head);

    var pathRow = ui.el('div', 'cb-pathrow');
    var pathPill = ui.el('span', 'cb-path-pill on', t('cb.path') + ' 1');
    pathRow.appendChild(pathPill);
    var pathPlus = ui.el('button', 'cb-path-plus', '+');
    pathPlus.type = 'button';
    pathPlus.disabled = true;
    pathPlus.title = t('cb.addPathV2');
    pathRow.appendChild(pathPlus);
    col.appendChild(pathRow);

    var builder = ui.el('div', 'cb-builder');
    col.appendChild(builder);

    var rowNumber = 0;
    groups.forEach(function (rows, gi) {
      if (gi > 0) {
        var sep = ui.el('div', 'cb-or-sep');
        sep.appendChild(ui.el('span', 'cb-or-pill', t('cb.or')));
        builder.appendChild(sep);
      }
      var group = ui.el('div', 'cb-group');

      // CONTRACT (ndv-condition-final.webp, 1:1 crop of both group heads): the
      // group header holds ONLY the letter badge and the "all conditions must be
      // met (AND)" label — there is NO group-level delete button on the right.
      // Removing a group stays possible because deleting a group's last row
      // splices the group out (see onDelete below), so the trash icon here was
      // redundant as well as off-design. Do not re-add it.
      var gh = ui.el('div', 'cb-group-head');
      gh.appendChild(ui.el('span', 'cb-group-badge', GROUP_LETTERS[gi] || String(gi + 1)));
      gh.appendChild(ui.el('span', 'cb-group-label', t('cb.allMustMatch')));
      group.appendChild(gh);

      // `+ AND` placement, straight off the locked crop: it closes the body of
      // the LAST EXPANDED row (group A in ndv-condition-final.webp puts it
      // under row 1's controls, above the collapsed row 2), and only falls back
      // to the group's own bottom when every row in the group is collapsed
      // (group B in the same crop).
      function makeAddAnd() {
        var b = ui.el('button', 'cb-add-and', '+ ' + t('cb.and'));
        b.type = 'button';
        b.addEventListener('click', function () {
          rows.push(m.blankRow()); restructure();
        });
        return b;
      }
      var lastExpanded = -1;
      rows.forEach(function (row, ri) { if (!row.collapsed) lastExpanded = ri; });

      rows.forEach(function (row, ri) {
        rowNumber += 1;
        group.appendChild(conditionRow({
          row: row, index: rowNumber, exprCtx: exprCtx,
          pageUrl: ctx.pageUrl || '',
          footer: ri === lastExpanded ? makeAddAnd() : null,
          onChange: commit,
          onToggleCollapse: function () { row.collapsed = !row.collapsed; restructure(); },
          onClone: function () {
            rows.splice(ri + 1, 0, m.normalizeRow(row)); restructure();
          },
          onDelete: function () {
            rows.splice(ri, 1);
            if (!rows.length) groups.splice(gi, 1);
            if (!groups.length) groups.push([m.blankRow()]);
            restructure();
          },
        }));
      });

      if (lastExpanded < 0) group.appendChild(makeAddAnd());
      builder.appendChild(group);
    });

    var addGroup = ui.el('button', 'cb-add-group', '+ ' + t('cb.orNewGroup'));
    addGroup.type = 'button';
    addGroup.addEventListener('click', function () {
      groups.push([M().blankRow()]); restructure();
    });
    builder.appendChild(addGroup);

    // ---- true / false result cards -------------------------------------
    var isIf = node.action === 'if';
    var res = ui.el('div', 'cb-results');
    res.appendChild(resultCard(true, isIf));
    res.appendChild(resultCard(false, isIf));
    col.appendChild(res);

    // ---- REMOVED: "Max depth" · "Evaluate mode" -------------------------
    // ndv-condition-final.webp draws both of these under the true/false cards,
    // and they were built to match it. A stack-wide audit then showed that
    // NEITHER key is read anywhere in the backend — not in ConditionEngine, not
    // in the pipeline, not in the request schemas. They were two dropdowns that
    // could not change the outcome of a run:
    //   · "Max depth 3/5/8" guarded recursion depth, but this builder emits at
    //     most `any` of `all` — two levels — so every value behaved the same.
    //   · "Evaluate mode: first match / evaluate all" described short-circuit
    //     behaviour, which is already what `any`/`all` do; it was never a
    //     decision the user needed to make.
    // A control that cannot affect the result is worse than a missing one: it
    // spends the user's attention and then teaches them that the panel's
    // settings are not to be trusted. So they are deleted here, in the action
    // catalog and in the model, instead of being given a fake implementation to
    // justify the pixels. This is the one place where the mock is deliberately
    // NOT followed, and it is recorded in the handoff's audit section.
    //
    // `while` keeps its own extra parameter (max iterations) below the builder —
    // that one IS read by the runtime, which is exactly the difference.
    if (node.action === 'while') {
      var wf = ui.section(t('cb.loopGuard'), 1);
      wf.body.appendChild(ui.fieldCell(t('p.maxIterations'),
        ui.numberCell(node.params.maxIterations != null ? node.params.maxIterations : 100,
          { min: 1, placeholder: '100' },
          function (v) { node.params.maxIterations = v; commit(); })));
      col.appendChild(wf.root);
    }

    commit();
    return true;
  }

  function resultCard(isTrue, isIf) {
    var ui = UI();
    var card = ui.el('div', 'cb-result-card ' + (isTrue ? 'true' : 'false'));
    var icon = ui.el('span', 'cb-result-icon');
    icon.innerHTML = window.Icons ? window.Icons.svg(isTrue ? 'check' : 'x', { size: 14 }) : '';
    card.appendChild(icon);
    var texts = ui.el('div', 'cb-result-texts');
    texts.appendChild(ui.el('div', 'cb-result-title',
      isTrue ? t('cb.truePath') : t('cb.falsePath')));
    texts.appendChild(ui.el('div', 'cb-result-sub',
      isTrue ? t('cb.truePathSub') : t('cb.falsePathSub')));
    var portLabel = isIf
      ? (isTrue ? t('port.then') : t('port.else'))
      : (isTrue ? t('port.body') : t('port.done'));
    texts.appendChild(ui.el('span', 'cb-result-pill', t('cb.outputPort') + ' ' + portLabel));
    card.appendChild(texts);
    return card;
  }

  // One condition row: a clickable header (number badge + chip summary + icon
  // buttons) and, when expanded, the two-line control grid from the design.
  function conditionRow(o) {
    var ui = UI();
    var m = M();
    var row = o.row;
    var opMeta = m.operatorMeta(row.operator);
    var srcMeta = m.sourceMeta(row.source);

    var wrap = ui.el('div', 'cb-row' + (row.collapsed ? ' is-collapsed' : ' is-expanded'));

    // -- header ----------------------------------------------------------
    var head = ui.el('div', 'cb-row-head');
    head.appendChild(ui.el('span', 'cb-row-num', String(o.index)));
    // The crop draws the summary as PLAIN, evenly spaced text tokens — no
    // coloured pills. `docs/uiux/*.webp` outranks the prose (standing rule 0.2).
    var toks = ui.el('div', 'cb-row-toks');
    m.rowChips(row).forEach(function (c) {
      toks.appendChild(ui.el('span', 'cb-tok tone-' + c.kind, c.i18n ? t(c.i18n) : c.text));
    });
    head.appendChild(toks);
    var acts = ui.el('div', 'cb-row-acts');
    acts.appendChild(ui.iconBtn('copy', t('cb.cloneRow'), '', o.onClone));
    acts.appendChild(ui.iconBtn('trash', t('cb.removeRow'), 'is-danger', o.onDelete));
    acts.appendChild(ui.iconBtn(row.collapsed ? 'chevron-down' : 'chevron-up',
      row.collapsed ? t('cb.expandRow') : t('cb.collapseRow'), 'is-collapse', o.onToggleCollapse));
    head.appendChild(acts);
    head.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.aria-iconbtn')) return;
      o.onToggleCollapse();
    });
    wrap.appendChild(head);

    if (row.collapsed) return wrap;

    // -- PROGRESSIVE DISCLOSURE -------------------------------------------
    //
    // The row used to render all five controls at once (Left source · Attribute
    // name · CSS Selector · Operator · Right value), which made a beginner face
    // five decisions to express "is this button on the page?" — and, worse, two
    // of those five were read by the runtime only on OTHER code paths, so the
    // panel showed settings that the run would silently ignore.
    //
    // Now the row asks ONE question first — "what do you want to check?" — and
    // then shows exactly the fields the chosen path consumes. The three choices
    // are not invented UI categories: they are the runtime's own three branches
    // (NdvModel.CONDITION_KINDS documents the mapping to ConditionEngine).
    //
    //   element  → CSS Selector · Operator                        (2 fields)
    //   content  → CSS Selector · Read · [Attribute] · Op · [Value] (3–5)
    //   variable → Variable · Operator · [Value]                  (2–3)
    //
    // `kind` is derived from the stored row, never persisted, so params.groups
    // and every already-saved workflow are untouched.
    var kind = m.checkKindOf(row);
    var body = ui.el('div', 'cb-row-body');

    var kindCell = ui.fieldCell(t('cb.checkKind'),
      ui.selectCell(m.CONDITION_KINDS.map(function (k) {
        return { value: k.id, label: t(k.label) };
      }), kind, function (v) {
        if (v === kind) return;
        var next = m.applyCheckKind(row, v);
        Object.keys(next).forEach(function (k) { row[k] = next[k]; });
        o.onChange();
        rebuild();
      }), t(m.CONDITION_KINDS.filter(function (k) { return k.id === kind; })[0].hint),
      null, { info: t('cb.checkKindHelp') });
    kindCell.className += ' cb-kind-cell';
    body.appendChild(kindCell);

    // -- line 1: the LEFT-hand value ---------------------------------------
    var l1 = ui.el('div', 'cb-row-line cb-line-1');
    if (kind === 'variable') {
      // The engine reads the variable NAMED BY `value` and never touches the
      // DOM here, so there is deliberately no selector field on this path.
      l1.appendChild(ui.fieldCell(t('cb.variableName'), exprField({
        value: row.value,
        placeholder: 'status',
        exprContext: o.exprCtx,
        onChange: function (v) { row.value = v; o.onChange(); },
      }), null, null, { info: t('cb.variableNameHelp') }));
    } else {
      var selHost = exprField({
        value: row.selector,
        placeholder: '#login-status',
        exprContext: o.exprCtx,
        onChange: function (v) { row.selector = v; o.onChange(); },
        buttons: [pickerBtn(function (sel) {
          row.selector = sel; o.onChange(); rebuild();
        }, function () {
          // No `selectorType` param on this path ON PURPOSE: ConditionEngine
          // calls page.locator(selector) directly, and Playwright already
          // sniffs a leading `//` as XPath — so one field accepts both and an
          // extra dropdown would be a control the backend never reads.
          var v = String(row.selector || '');
          return {
            value: v,
            mode: /^\s*(\/\/|\.\.|\()/.test(v) ? 'xpath' : 'css',
            url: o.pageUrl || '',
          };
        })],
      });
      l1.appendChild(ui.fieldCell(t('cb.cssSelector'), selHost, null, null,
        { info: t('cb.cssSelectorHelp') }));
      if (kind === 'content') {
        // "Left source" renamed to what it actually asks: WHICH PART of the
        // matched element to read. `variable` is not offered here — it is the
        // separate kind above, instead of a value smuggled into this dropdown.
        l1.appendChild(ui.fieldCell(t('cb.readWhat'),
          ui.selectCell(m.contentSources().map(function (s) {
            return { value: s.id, label: t(s.label) };
          }), row.source, function (v) {
            row.source = v; o.onChange();
            if (m.sourceMeta(v).needsAttribute !== srcMeta.needsAttribute) rebuild();
          }), null, null, { info: t('cb.readWhatHelp') }));
        if (srcMeta.needsAttribute) {
          l1.appendChild(ui.fieldCell(t('cb.attributeName'),
            ui.comboCell(row.attribute, m.CONDITION_ATTRIBUTES, 'textContent',
              function (v) { row.attribute = v; o.onChange(); }),
            null, null, { info: t('cb.attributeNameHelp') }));
        }
      }
    }
    body.appendChild(l1);

    // -- line 2: Operator · Right value ----------------------------------
    // Only the operators the chosen path can actually evaluate are listed:
    // offering `visible` on a content row produced a self-contradicting row.
    var l2 = ui.el('div', 'cb-row-line cb-line-2');
    l2.appendChild(ui.fieldCell(t('cb.operator'),
      ui.selectCell(m.operatorsForKind(kind).map(function (op) {
        return { value: op.id, label: t(op.label) };
      }), row.operator, function (v) {
        var was = opMeta;
        row.operator = v; o.onChange();
        var now = m.operatorMeta(v);
        if (now.needsExpected !== was.needsExpected || !!now.list !== !!was.list) rebuild();
      }), null, null, { info: t('cb.operatorHelp') }));
    if (opMeta.needsExpected) {
      // `in_list` / `not_in_list` compare against a LIST, so the field's own
      // label, placeholder and helper say so — the serialiser splits it on
      // commas/newlines into the array the engine requires.
      l2.appendChild(ui.fieldCell(opMeta.list ? t('cb.valueList') : t('cb.rightValue'),
        exprField({
          value: row.expected,
          placeholder: opMeta.list ? 'paid, shipped, delivered' : 'logged-out',
          exprContext: o.exprCtx,
          onChange: function (v) { row.expected = v; o.onChange(); },
        }), opMeta.list ? t('cb.valueListHelp') : null, null,
        { info: opMeta.list ? t('cb.valueListHelp') : t('cb.rightValueHelp') }));
    }
    body.appendChild(l2);
    // the group's `+ AND`, when this is its last expanded row (see makeAddAnd)
    if (o.footer) body.appendChild(o.footer);
    wrap.appendChild(body);

    function rebuild() {
      var fresh = conditionRow(o);
      if (wrap.parentNode) wrap.parentNode.replaceChild(fresh, wrap);
    }
    return wrap;
  }

  // =========================================================================
  // Dispatcher
  // =========================================================================
  function renderCenter(col, ctx) {
    var action = ctx.node && ctx.node.action;
    if (!M().isDesigned(action)) return false;
    if (action === 'click') return renderClick(col, ctx);
    if (action === 'if' || action === 'while') return renderCondition(col, ctx);
    return false;
  }

  window.NdvNodes = {
    renderInput: renderInput,
    renderOutput: renderOutput,
    renderCenter: renderCenter,
    // exported for reuse / future designs
    exprField: exprField,
    pickerBtn: pickerBtn,
    conditionRow: conditionRow,
  };
})();
