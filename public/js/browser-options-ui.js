// =====================================================================
// browser-options-ui.js — the "Add option" panel of the Launch Browser node.
// ---------------------------------------------------------------------
// Renders window.BROWSER_OPTIONS (browser-options.js) — it declares NO option
// of its own. The value lives on the node as `params.browserOptions` (JSON text);
// only options the user added are present, so "nothing added" = today's defaults.
//
// Pure helpers (parse / serialize / search / groupFor) are separate from the DOM
// code so tests/unit/browser-options-ui.test.ts can run them without a browser.
// Vanilla, CSP-safe (no inline handlers, no eval). LF line endings.
// =====================================================================
(function (root) {
  'use strict';

  function BO() { return root.BROWSER_OPTIONS; }

  // ---------- pure helpers ----------------------------------------------
  // The stored text -> an object of options. Anything unreadable is "no options"
  // (the server re-validates; the UI must never throw on a hand-edited file).
  function parse(text) {
    if (text === undefined || text === null || text === '') return {};
    if (typeof text === 'object') return Array.isArray(text) ? {} : text;
    try {
      var v = JSON.parse(String(text));
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) { return {}; }
  }
  // Empty -> '' so the param is dropped on save (coerceParams skips '').
  function serialize(obj) {
    return (obj && Object.keys(obj).length) ? JSON.stringify(obj) : '';
  }

  // Persian/Arabic letter variants + case folded, so "کروم" and "كروم" both match.
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\u064a/g, '\u06cc').replace(/\u0643/g, '\u06a9')
      .replace(/[\u064b-\u065f\u0640]/g, '').toLowerCase().trim();
  }

  // Options matching `query` (id, both labels, both help texts), in catalog order,
  // minus the ones already added.
  function search(query, used) {
    var q = norm(query);
    used = used || {};
    return BO().OPTIONS.filter(function (d) {
      if (Object.prototype.hasOwnProperty.call(used, d.id)) return false;
      if (!q) return true;
      var hay = norm([d.id, d.label.fa, d.label.en, d.help.fa, d.help.en].join(' '));
      return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
    });
  }

  function defaultFor(d) {
    switch (d.kind) {
      case 'boolean': return d.id === 'headless' ? false : (d.sample === false ? false : true);
      case 'int': case 'number': return d.sample;
      case 'string': return d.sample;
      case 'enum': return d.values[0];
      case 'set': return [d.values[0]];
      case 'lines': return d.sample.slice();
      case 'headers': return JSON.parse(JSON.stringify(d.sample));
      default: return '';
    }
  }

  // Text <-> value for the two multi-line kinds.
  function linesToText(a) { return Array.isArray(a) ? a.join('\n') : ''; }
  function textToLines(t) {
    return String(t || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function headersToText(h) { return h && typeof h === 'object' ? JSON.stringify(h, null, 2) : ''; }
  function textToHeaders(t) {
    var v = JSON.parse(String(t || ''));   // throws on bad JSON; the caller reports it
    return v;
  }

  // ---------- DOM -------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function render(host, opts) {
    opts = opts || {};
    var t = opts.t || function (k) { return k; };
    var lang = (opts.lang && opts.lang() === 'en') ? 'en' : 'fa';
    var api = BO();
    var obj = parse(opts.value);
    var open = false;
    var query = '';
    var errors = {};   // id -> message key / text for a draft the user is still typing

    function lab(d) { return d.label[lang]; }
    function commit(next) {
      obj = next;
      if (opts.onChange) opts.onChange(serialize(obj));
    }
    function errText(code) { return t('bo.err.' + code) || code; }

    function redraw() {
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(buildPanel());
    }

    function setValue(d, v) {
      var code = api.check(d, v);
      if (code) { errors[d.id] = errText(code); return false; }
      delete errors[d.id];
      var next = {}; Object.keys(obj).forEach(function (k) { next[k] = obj[k]; });
      next[d.id] = v;
      commit(next);
      return true;
    }

    function control(d) {
      var v = obj[d.id];
      var c, i;
      function fieldErr() {
        var e = host.querySelector('[data-bo-err="' + d.id + '"]');
        if (e) { e.textContent = errors[d.id] || ''; e.hidden = !errors[d.id]; }
        var inp = host.querySelector('[data-bo-input="' + d.id + '"]');
        if (inp) inp.classList.toggle('bo-invalid', !!errors[d.id]);
      }
      if (d.kind === 'boolean') {
        c = el('label', 'ndv-toggle');
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = v === true;
        cb.setAttribute('data-bo-input', d.id);
        var sl = el('span', 'ndv-toggle-slide');
        c.appendChild(cb); c.appendChild(sl);
        cb.addEventListener('change', function () { setValue(d, cb.checked); redrawDiag(); });
        return c;
      }
      if (d.kind === 'enum') {
        c = el('select', 'field ndv-field');
        c.setAttribute('data-bo-input', d.id);
        d.values.forEach(function (x) {
          var o = el('option', '', x); o.value = x; c.appendChild(o);
        });
        c.value = v;
        c.addEventListener('change', function () { setValue(d, c.value); redrawDiag(); });
        return c;
      }
      if (d.kind === 'set') {
        c = el('div', 'bo-set');
        c.setAttribute('data-bo-input', d.id);
        d.values.forEach(function (x) {
          var lb = el('label', 'bo-set-item');
          var k = el('input'); k.type = 'checkbox'; k.value = x;
          k.checked = Array.isArray(v) && v.indexOf(x) !== -1;
          lb.appendChild(k); lb.appendChild(el('span', '', x));
          k.addEventListener('change', function () {
            var cur = [];
            c.querySelectorAll('input[type=checkbox]').forEach(function (q) { if (q.checked) cur.push(q.value); });
            if (!cur.length) { errors[d.id] = errText('type'); fieldErr(); return; }
            setValue(d, cur); fieldErr(); redrawDiag();
          });
          c.appendChild(lb);
        });
        return c;
      }
      if (d.kind === 'lines' || d.kind === 'headers') {
        c = el('textarea', 'field ndv-field ndv-code');
        c.rows = 4; c.spellcheck = false; c.setAttribute('dir', 'ltr');
        c.setAttribute('data-bo-input', d.id);
        c.value = d.kind === 'lines' ? linesToText(v) : headersToText(v);
        c.addEventListener('input', function () {
          var parsed;
          try { parsed = d.kind === 'lines' ? textToLines(c.value) : textToHeaders(c.value); }
          catch (e) { errors[d.id] = errText('json'); fieldErr(); return; }
          setValue(d, parsed); fieldErr(); redrawDiag();
        });
        return c;
      }
      // int / number / string
      c = el('input', 'field ndv-field');
      c.setAttribute('data-bo-input', d.id);
      if (d.kind === 'string') {
        c.type = d.secret ? 'password' : 'text';
        if (d.secret) c.autocomplete = 'new-password';
        c.value = v == null ? '' : String(v);
        c.setAttribute('dir', 'ltr');
      } else {
        c.type = 'number';
        c.min = String(d.min); c.max = String(d.max);
        c.step = d.kind === 'int' ? '1' : 'any';
        c.value = v == null ? '' : String(v);
      }
      c.addEventListener('input', function () {
        var val = d.kind === 'string' ? c.value : (c.value === '' ? NaN : Number(c.value));
        if (setValue(d, val)) { fieldErr(); redrawDiag(); } else { fieldErr(); }
      });
      return c;
    }

    var diagHost = null;
    function redrawDiag() {
      if (!diagHost) return;
      while (diagHost.firstChild) diagHost.removeChild(diagHost.firstChild);
      var list = api.diagnose(obj, { actions: (opts.actions && opts.actions()) || [] });
      diagHost.hidden = list.length === 0;
      list.forEach(function (d) {
        var row = el('div', 'bo-diag bo-diag-' + d.level);
        row.setAttribute('data-bo-diag', d.code);
        row.appendChild(el('span', 'bo-diag-tag', t(d.level === 'warn' ? 'bo.warn' : 'bo.info')));
        row.appendChild(el('span', '', d[lang]));
        diagHost.appendChild(row);
      });
    }

    function row(d) {
      var r = el('div', 'bo-row');
      r.setAttribute('data-bo-row', d.id);
      var head = el('div', 'bo-row-head');
      head.appendChild(el('label', 'bo-row-label', lab(d) + (d.unit ? ' (' + d.unit + ')' : '')));
      if (d.scope === 'launch') {
        var b = el('span', 'bo-badge', t('bo.needsLaunch'));
        b.title = t('bo.needsLaunchHint');
        head.appendChild(b);
      }
      var rm = el('button', 'icon-btn bo-remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', t('bo.remove'));
      rm.title = t('bo.remove');
      rm.setAttribute('data-bo-remove', d.id);
      if (root.Icons && root.Icons.svg) rm.innerHTML = root.Icons.svg('x'); else rm.textContent = '-';
      rm.addEventListener('click', function () {
        var next = {}; Object.keys(obj).forEach(function (k) { if (k !== d.id) next[k] = obj[k]; });
        delete errors[d.id];
        commit(next); redraw();
      });
      head.appendChild(rm);
      r.appendChild(head);
      r.appendChild(control(d));
      r.appendChild(el('div', 'muted small bo-help', d.help[lang]));
      var e = el('div', 'bo-error small'); e.setAttribute('data-bo-err', d.id); e.hidden = true;
      r.appendChild(e);
      return r;
    }

    function picker() {
      var box = el('div', 'bo-picker');
      var inp = el('input', 'field bo-search');
      inp.type = 'search'; inp.id = 'bo-search';
      inp.placeholder = t('bo.search');
      inp.setAttribute('aria-label', t('bo.search'));
      inp.value = query;
      box.appendChild(inp);
      var list = el('div', 'bo-picker-list'); list.setAttribute('role', 'listbox');
      box.appendChild(list);
      function fill() {
        while (list.firstChild) list.removeChild(list.firstChild);
        var found = search(query, obj);
        if (!found.length) { list.appendChild(el('div', 'muted small bo-nomatch', t('bo.noMatch'))); return; }
        api.GROUPS.forEach(function (g) {
          var inGroup = found.filter(function (d) { return d.group === g.id; });
          if (!inGroup.length) return;
          list.appendChild(el('div', 'bo-group', g[lang]));
          inGroup.forEach(function (d) {
            var it = el('button', 'bo-pick');
            it.type = 'button'; it.setAttribute('role', 'option');
            it.setAttribute('data-bo-pick', d.id);
            it.appendChild(el('span', 'bo-pick-label', lab(d)));
            it.appendChild(el('span', 'muted small bo-pick-id', d.id));
            it.addEventListener('click', function () {
              var next = {}; Object.keys(obj).forEach(function (k) { next[k] = obj[k]; });
              next[d.id] = defaultFor(d);
              commit(next); open = false; query = ''; redraw();
            });
            list.appendChild(it);
          });
        });
      }
      inp.addEventListener('input', function () { query = inp.value; fill(); });
      fill();
      setTimeout(function () { try { inp.focus(); } catch (e) { /* detached */ } }, 0);
      return box;
    }

    function buildPanel() {
      var wrap = el('section', 'bo-panel');
      wrap.id = 'browser-options-panel';
      var head = el('div', 'bo-head');
      head.appendChild(el('h4', 'bo-title', t('bo.title')));
      head.appendChild(el('div', 'muted small', t('bo.subtitle')));
      wrap.appendChild(head);

      var ids = Object.keys(obj);
      if (!ids.length) wrap.appendChild(el('div', 'muted small bo-empty', t('bo.empty')));
      ids.forEach(function (id) { var d = api.def(id); if (d) wrap.appendChild(row(d)); });
      // keys the catalog no longer knows are shown, not hidden: the server will refuse them
      ids.forEach(function (id) {
        if (api.def(id)) return;
        var r = el('div', 'bo-row bo-row-unknown');
        r.appendChild(el('span', '', id + ': ' + t('bo.unknown')));
        var rm = el('button', 'btn btn-sm', t('bo.remove')); rm.type = 'button';
        rm.addEventListener('click', function () {
          var next = {}; Object.keys(obj).forEach(function (k) { if (k !== id) next[k] = obj[k]; });
          commit(next); redraw();
        });
        r.appendChild(rm); wrap.appendChild(r);
      });

      var add = el('button', 'btn btn-sm bo-add', t('bo.add'));
      add.type = 'button'; add.id = 'bo-add';
      add.setAttribute('aria-expanded', open ? 'true' : 'false');
      add.addEventListener('click', function () { open = !open; redraw(); });
      wrap.appendChild(add);
      if (open) wrap.appendChild(picker());

      diagHost = el('div', 'bo-diags'); diagHost.hidden = true;
      wrap.appendChild(diagHost);
      redrawDiag();
      return wrap;
    }

    redraw();
    return { refresh: redrawDiag, get: function () { return obj; } };
  }

  root.BrowserOptionsUI = {
    render: render, parse: parse, serialize: serialize, search: search,
    defaultFor: defaultFor, norm: norm,
    linesToText: linesToText, textToLines: textToLines,
    headersToText: headersToText, textToHeaders: textToHeaders
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BrowserOptionsUI;
})(typeof window !== 'undefined' ? window : this);
