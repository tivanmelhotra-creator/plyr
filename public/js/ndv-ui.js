/*
 * ndv-ui.js — reusable Aria NDV chrome primitives (the DESIGN BASE).
 *
 * These are the shared building blocks every designed node reuses, taken from
 * the "Shared design tokens" + "Pixel-level UI language" blocks that repeat in
 * every docs/uiux/*.md spec. Building them once here is what lets each new node
 * be designed *precisely* instead of approximately:
 *
 *   segmented(...)    Schema | Table | JSON segmented tab control (32px)
 *   runSelector(...)  "Run 2 of 2" dropdown
 *   searchField(...)  "Search input data…" field with a magnifier
 *   section(...)      centre-column section card (title + body grid)
 *   fieldCell(...)    label + control + helper, on the 4/8/12/16 spacing grid
 *   toggleRow(...)    label · info dot · switch (orange when on)
 *   numberCell(...)   compact numeric field
 *   selectCell(...)   dark dropdown with chevron
 *   iconBtn(...)      square icon button (fx / target picker / collapse …)
 *   checkbox(...)     `Alt` / `Ctrl / Cmd` / `Shift` style checkbox
 *   dataTree(...)     INPUT column tree (expandable groups + typed values)
 *   dragChips(...)    bottom draggable value chips
 *   outputEmpty(...)  OUTPUT illustration + headline + subtext
 *   statusStrip(...)  Status · Time · Size footer strip
 *
 * Pure DOM, CSP-safe, no framework. Loaded BEFORE flow-editor.js.
 * LF line endings.
 */
(function () {
  'use strict';

  function U() { return window.AppUtil; }
  function t(k) { return U() ? U().t(k) : k; }
  function esc(s) { return U() ? U().esc(s) : String(s == null ? '' : s); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- segmented tabs (Schema | Table | JSON) -------------------------------
  // items: [{ id, label }]; onPick(id) — returns { root, setActive }.
  function segmented(items, activeId, onPick) {
    var root = el('div', 'aria-seg');
    var btns = {};
    (items || []).forEach(function (it) {
      var b = el('button', 'aria-seg-btn' + (it.id === activeId ? ' on' : ''), it.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        Object.keys(btns).forEach(function (k) { btns[k].classList.remove('on'); });
        b.classList.add('on');
        if (onPick) onPick(it.id);
      });
      btns[it.id] = b;
      root.appendChild(b);
    });
    return {
      root: root,
      setActive: function (id) {
        Object.keys(btns).forEach(function (k) { btns[k].classList.toggle('on', k === id); });
      },
    };
  }

  // ---- "Run 2 of 2" selector ------------------------------------------------
  function runSelector(count, activeIndex, onPick) {
    var wrap = el('label', 'aria-runsel');
    wrap.appendChild(el('span', 'aria-runsel-label', t('ndv.run')));
    var sel = el('select', 'aria-runsel-select');
    var n = Math.max(1, count || 1);
    for (var i = n; i >= 1; i--) {
      var o = el('option', null, i + ' ' + t('ndv.of') + ' ' + n);
      o.value = String(i);
      sel.appendChild(o);
    }
    sel.value = String(activeIndex || n);
    if (onPick) sel.addEventListener('change', function () { onPick(parseInt(sel.value, 10)); });
    wrap.appendChild(sel);
    return wrap;
  }

  // ---- search field ---------------------------------------------------------
  function searchField(placeholder, onInput) {
    var wrap = el('div', 'aria-search');
    var searchIcon = el('span', 'aria-search-icon');
    searchIcon.innerHTML = window.Icons ? window.Icons.svg('search', { size: 14 }) : '';
    wrap.appendChild(searchIcon);
    var inp = el('input', 'aria-search-input');
    inp.type = 'text';
    inp.placeholder = placeholder || '';
    if (onInput) inp.addEventListener('input', function () { onInput(inp.value); });
    wrap.appendChild(inp);
    return { root: wrap, input: inp };
  }

  // ---- centre-column section card ------------------------------------------
  // cols: 1 | 2 | 3 — the internal grid the spec uses for compact field rows.
  function section(titleText, cols) {
    var root = el('section', 'aria-sec');
    if (titleText) root.appendChild(el('div', 'aria-sec-title', titleText));
    var body = el('div', 'aria-sec-body cols-' + (cols || 1));
    root.appendChild(body);
    return { root: root, body: body };
  }

  // ---- generic field cell (label above control, helper below) ---------------
  // opts (all optional):
  //   inline: true  — label LEFT / control RIGHT on one row, the way the locked
  //                   preview lays out numerics that sit among toggle rows
  //                   (`Timeout (ms)`, `Stable for (ms)`, `Offset X (px)`).
  //   info: string  — the small ⓘ dot the preview puts after those labels.
  function fieldCell(labelText, control, helperText, span, opts) {
    var o = opts || {};
    var cell = el('div', 'aria-cell' + (span ? ' span-' + span : '') + (o.inline ? ' is-inline' : ''));
    if (labelText) {
      var lab = el('div', 'aria-cell-label');
      lab.appendChild(el('span', null, labelText));
      if (o.info) withInfo(lab, o.info);
      cell.appendChild(lab);
    }
    if (control) cell.appendChild(control);
    if (helperText) cell.appendChild(el('div', 'aria-cell-help', helperText));
    return cell;
  }

  // Attach a small ⓘ info dot with a tooltip to a label row.
  function withInfo(labelEl, tip) {
    if (!tip) return labelEl;
    var dot = el('span', 'aria-info');
    dot.innerHTML = window.Icons ? window.Icons.svg('help-circle', { size: 13 }) : '?';
    dot.title = tip;
    labelEl.appendChild(dot);
    return labelEl;
  }

  // ---- dark dropdown -------------------------------------------------------
  // options: [{ value, label }] | [string]
  function selectCell(options, value, onChange) {
    var sel = el('select', 'aria-select');
    (options || []).forEach(function (o) {
      var val = typeof o === 'string' ? o : o.value;
      var lab = typeof o === 'string' ? o : o.label;
      var opt = el('option', null, lab);
      opt.value = String(val);
      sel.appendChild(opt);
    });
    if (value != null) sel.value = String(value);
    if (onChange) sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  // ---- text input ----------------------------------------------------------
  function textCell(value, placeholder, onInput) {
    var inp = el('input', 'aria-input');
    inp.type = 'text';
    inp.placeholder = placeholder || '';
    inp.value = value != null ? String(value) : '';
    if (onInput) inp.addEventListener('input', function () { onInput(inp.value); });
    return inp;
  }

  // ---- compact numeric input ----------------------------------------------
  function numberCell(value, opts, onInput) {
    opts = opts || {};
    var inp = el('input', 'aria-input aria-input-num');
    inp.type = 'number';
    if (typeof opts.min === 'number') inp.min = String(opts.min);
    if (typeof opts.max === 'number') inp.max = String(opts.max);
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    inp.value = value != null && value !== '' ? String(value) : '';
    if (onInput) {
      inp.addEventListener('input', function () {
        var v = inp.value === '' ? '' : Number(inp.value);
        onInput(v);
      });
    }
    return inp;
  }

  // ---- toggle switch (orange track when on) --------------------------------
  function toggle(checked, onChange) {
    var lab = el('label', 'aria-toggle');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = checked === true;
    var slide = el('span', 'aria-toggle-slide');
    lab.appendChild(cb);
    lab.appendChild(slide);
    if (onChange) cb.addEventListener('change', function () { onChange(cb.checked); });
    return { root: lab, input: cb };
  }

  // A full "label · info · switch [· inline field]" row.
  function toggleRow(labelText, checked, onChange, opts) {
    opts = opts || {};
    var row = el('div', 'aria-toggle-row');
    var lab = el('div', 'aria-toggle-label');
    lab.appendChild(el('span', null, labelText));
    withInfo(lab, opts.info);
    row.appendChild(lab);
    if (opts.trailing) row.appendChild(opts.trailing);
    var tg = toggle(checked, onChange);
    row.appendChild(tg.root);
    if (opts.help) row.appendChild(el('div', 'aria-cell-help aria-toggle-help', opts.help));
    return { root: row, input: tg.input };
  }

  // ---- checkbox (Alt / Ctrl / Shift) --------------------------------------
  function checkbox(labelText, checked, onChange) {
    var lab = el('label', 'aria-check');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = checked === true;
    if (onChange) cb.addEventListener('change', function () { onChange(cb.checked); });
    lab.appendChild(cb);
    lab.appendChild(el('span', 'aria-check-box'));
    lab.appendChild(el('span', 'aria-check-label', labelText));
    return lab;
  }

  // ---- square icon button (fx / picker / clone / delete / collapse) --------
  // `glyph` may be either literal text or a name from the inline SVG registry
  // (public/js/icons.js). Registry names win, so callers pass semantic names
  // ('trash', 'copy', 'chevron-down') instead of emoji that render as boxes.
  function iconBtn(glyph, title, cls, onClick) {
    var useSvg = !!(window.Icons && window.Icons.has(glyph));
    var b = el('button', 'aria-iconbtn' + (cls ? ' ' + cls : ''), useSvg ? '' : glyph);
    if (useSvg) b.innerHTML = window.Icons.svg(glyph, { size: 14 });
    b.type = 'button';
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(ev); });
    return b;
  }

  // ---- INPUT data tree ----------------------------------------------------
  // nodes: recursive [{ key, value?, type?, children? }]
  // Rendered as label-left / value-right rows with caret disclosure, matching
  // the design's `response / data / meta` groups.
  function valueClass(v) {
    if (typeof v === 'number') return 'num';
    if (typeof v === 'boolean') return 'bool';
    if (v === null || v === undefined) return 'null';
    var s = String(v);
    if (/^(success|ok|true|200|201)$/i.test(s)) return 'good';
    return 'str';
  }

  function treeFrom(obj, depth) {
    depth = depth || 0;
    if (obj == null || typeof obj !== 'object' || depth > 4) return [];
    return Object.keys(obj).slice(0, 60).map(function (k) {
      var v = obj[k];
      var isObj = v && typeof v === 'object';
      return {
        key: k,
        value: isObj ? null : v,
        children: isObj ? treeFrom(v, depth + 1) : null,
        count: isObj ? (Array.isArray(v) ? v.length : Object.keys(v).length) : 0,
      };
    });
  }

  // path prefix lets rows carry a draggable `{{ $json.a.b }}` expression.
  function dataTree(nodes, pathPrefix, filter) {
    var root = el('div', 'aria-tree');
    var q = (filter || '').trim().toLowerCase();

    function matches(n) {
      if (!q) return true;
      if (String(n.key).toLowerCase().indexOf(q) !== -1) return true;
      if (n.value != null && String(n.value).toLowerCase().indexOf(q) !== -1) return true;
      return (n.children || []).some(matches);
    }

    function build(list, parentPath, depth, into) {
      (list || []).forEach(function (n) {
        if (!matches(n)) return;
        var path = parentPath ? parentPath + '.' + n.key : n.key;
        var isGroup = Array.isArray(n.children) && n.children.length > 0;
        var row = el('div', 'aria-tree-row' + (isGroup ? ' is-group' : ''));
        row.style.setProperty('--depth', String(depth));
        if (isGroup) {
          var caret = el('span', 'aria-tree-caret');
    caret.innerHTML = window.Icons ? window.Icons.svg('chevron-down', { size: 13 }) : '';
    row.appendChild(caret);
        } else {
          row.appendChild(el('span', 'aria-tree-caret is-leaf', ''));
        }
        row.appendChild(el('span', 'aria-tree-key', n.key));
        if (!isGroup) {
          var val = n.value;
          var text = val === null || val === undefined ? '—' : String(val);
          if (text.length > 26) text = text.slice(0, 24) + '…';
          var vEl = el('span', 'aria-tree-val v-' + valueClass(val), text);
          vEl.title = val === null || val === undefined ? '' : String(val);
          row.appendChild(vEl);
          row.setAttribute('draggable', 'true');
          var expr = '{{ ' + path + ' }}';
          row.addEventListener('dragstart', function (ev) {
            ev.dataTransfer.setData('text/x-expr', expr);
            ev.dataTransfer.setData('text/plain', expr);
            ev.dataTransfer.effectAllowed = 'copy';
          });
          row.title = expr;
        }
        into.appendChild(row);
        if (isGroup) {
          var kids = el('div', 'aria-tree-kids');
          build(n.children, path, depth + 1, kids);
          into.appendChild(kids);
          row.addEventListener('click', function () {
            var open = kids.style.display !== 'none';
            kids.style.display = open ? 'none' : '';
            row.querySelector('.aria-tree-caret').innerHTML =
        window.Icons ? window.Icons.svg(open ? 'chevron-right' : 'chevron-down', { size: 13 }) : '';
          });
        }
      });
    }

    build(nodes, pathPrefix || '', 0, root);
    if (!root.children.length) root.appendChild(el('div', 'aria-tree-none', t('ndv.noMatch')));
    return root;
  }

  // ---- bottom draggable chips --------------------------------------------
  // chips: [{ path, tone }] — tone cycles the design's colour coding.
  var CHIP_TONES = ['violet', 'blue', 'green', 'orange'];
  function dragChips(chips, hintText, onMore) {
    var wrap = el('div', 'aria-chips-wrap');
    if (hintText) wrap.appendChild(el('div', 'aria-chips-hint', hintText));
    var row = el('div', 'aria-chips');
    (chips || []).forEach(function (c, i) {
      var chip = el('div', 'aria-chip tone-' + (c.tone || CHIP_TONES[i % CHIP_TONES.length]), c.path);
      chip.setAttribute('draggable', 'true');
      var expr = '{{ ' + c.path + ' }}';
      chip.title = expr;
      chip.addEventListener('dragstart', function (ev) {
        ev.dataTransfer.setData('text/x-expr', expr);
        ev.dataTransfer.setData('text/plain', expr);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      row.appendChild(chip);
    });
    var more = el('button', 'aria-chip aria-chip-more', '+');
    more.type = 'button';
    more.title = t('ndv.moreFields');
    if (onMore) more.addEventListener('click', onMore);
    row.appendChild(more);
    wrap.appendChild(row);
    return wrap;
  }

  // ---- OUTPUT empty state -------------------------------------------------
  // Inline SVG placeholder illustration (CSP-safe: no external asset).
  function outputIllustration() {
    var box = el('div', 'aria-out-illu');
    box.innerHTML =
      '<svg viewBox="0 0 120 80" role="img" aria-hidden="true">' +
      '<rect x="10" y="10" width="100" height="60" rx="8" class="illu-card"/>' +
      '<rect x="22" y="24" width="26" height="5" rx="2.5" class="illu-bar"/>' +
      '<rect x="52" y="24" width="16" height="5" rx="2.5" class="illu-bar dim"/>' +
      '<rect x="22" y="38" width="52" height="4" rx="2" class="illu-bar dim"/>' +
      '<rect x="22" y="48" width="38" height="4" rx="2" class="illu-bar dim"/>' +
      '<circle cx="88" cy="52" r="13" class="illu-play-bg"/>' +
      '<path d="M84 46 L96 52 L84 58 Z" class="illu-play"/>' +
      '</svg>';
    return box;
  }

  function outputEmpty(headline, subtext, codePreview) {
    var wrap = el('div', 'aria-out-empty');
    wrap.appendChild(outputIllustration());
    wrap.appendChild(el('div', 'aria-out-title', headline));
    wrap.appendChild(el('div', 'aria-out-sub', subtext));
    if (codePreview) {
      var pre = el('pre', 'aria-out-code');
      pre.textContent = codePreview;
      wrap.appendChild(pre);
    }
    return wrap;
  }

  // ---- Status · Time · Size strip ----------------------------------------
  function statusStrip(status, time, size) {
    var strip = el('div', 'aria-status-strip');
    function cell(labelKey, value, tone) {
      var c = el('div', 'aria-status-cell');
      c.appendChild(el('span', 'aria-status-label', t(labelKey)));
      c.appendChild(el('span', 'aria-status-val' + (tone ? ' tone-' + tone : ''), value));
      return c;
    }
    strip.appendChild(cell('ndv.status', status.text, status.tone));
    strip.appendChild(cell('ndv.time', time || '—'));
    strip.appendChild(cell('ndv.size', size || '—'));
    return strip;
  }

  window.NdvUI = {
    el: el,
    t: t,
    esc: esc,
    segmented: segmented,
    runSelector: runSelector,
    searchField: searchField,
    section: section,
    fieldCell: fieldCell,
    withInfo: withInfo,
    selectCell: selectCell,
    textCell: textCell,
    numberCell: numberCell,
    toggle: toggle,
    toggleRow: toggleRow,
    checkbox: checkbox,
    iconBtn: iconBtn,
    treeFrom: treeFrom,
    dataTree: dataTree,
    dragChips: dragChips,
    outputEmpty: outputEmpty,
    outputIllustration: outputIllustration,
    statusStrip: statusStrip,
  };
})();
