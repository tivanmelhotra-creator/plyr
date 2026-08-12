/* ============================================================
   inspector.js — the Element Inspector, in the page.

   WHAT THE USER SEES
   ------------------
   Ctrl + Shift + C (or the popup's Inspect button) arms the picker. Moving
   the mouse outlines whatever is under it and labels it. Clicking FREEZES
   that element and opens a panel listing everything extractable from it,
   each row with a checkbox. Tick what you want, press "Confirm & Add to
   Node", and the values land in the node you opened in the project. This is
   deliberately the DevTools gesture (hover → highlight → click → inspect),
   because that is the one gesture every user of this feature already knows.

   WHY THE PANEL IS DRAWN IN THE PAGE AND NOT IN THE POPUP
   ------------------------------------------------------
   An extension popup closes the moment focus leaves it. The picker's very
   first action is moving the mouse onto the page — which would dismiss a
   popup-hosted panel before a single element could be picked. So the panel
   must live in the page.

   WHY A CLOSED SHADOW ROOT
   ------------------------
   Injecting plain nodes into a page means the page's CSS restyles them (a
   site with `div { display: none }` or an aggressive reset would break the
   panel), and the page's scripts can read them. `mode: 'closed'` gives a
   style boundary the page cannot reach into, and a DOM handle the page
   cannot obtain — so what the user is about to send to their own automation
   project is not readable by the site they are inspecting.

   WHY EVERY VALUE IS SET WITH textContent
   ---------------------------------------
   The strings rendered here are attribute values from an arbitrary page. One
   `innerHTML` with a value like `<img onerror=...>` and the page gets script
   execution inside our UI. There is no innerHTML in this file, and it should
   stay that way.

   All extraction lives in lib/ab-inspect.js and all selector generation in
   content/selector.js — this file is presentation, gesture and transport.
   ============================================================ */
(function () {
  'use strict';

  // Content scripts can be injected twice (manifest match + an explicit
  // scripting.executeScript). Re-running would stack a second set of capture
  // listeners on every event, so each pick would fire twice.
  if (window.__abInspectorLoaded) return;
  window.__abInspectorLoaded = true;

  var HL_ID = 'ab-inspector-highlight';
  var PANEL_ID = 'ab-inspector-panel';

  var state = {
    active: false,     // picker armed, following the mouse
    hovered: null,     // element currently under the cursor
    frozen: null,      // element the user clicked; the panel describes this one
    described: null,   // ab-inspect.describeElement result for `frozen`
    rows: [],          // attributeRows result, in panel order
    selected: {},      // key -> true for ticked rows
    host: null,        // panel shadow host
    shadow: null,      // panel shadow root
    ui: null,          // cached panel element refs
    hlHost: null,      // highlight shadow host
    hlShadow: null,
    box: null,         // the outline rectangle
    tip: null          // the floating label
  };

  function inspect() {
    return window.ABInspect || null;
  }

  function selectors() {
    return window.ABSelector || null;
  }

  /* ----------------------------------------------------------
     Is this node part of OUR UI?

     Without this, hovering the panel would re-target the pick to the panel's
     own rows — the act of choosing would destroy the choice. Walking
     parentNode (not parentElement) and hopping `host` crosses shadow
     boundaries, which a plain parentElement walk cannot do.
     ---------------------------------------------------------- */
  function isOurs(node) {
    var n = node;
    while (n) {
      if (n.id === HL_ID || n.id === PANEL_ID) return true;
      n = n.parentNode || n.host || null;
    }
    return false;
  }

  /* ----------------------------------------------------------
     HIGHLIGHT OVERLAY

     A second shadow host, separate from the panel, because it must be
     pointer-events:none at all times (an overlay that eats clicks makes
     picking impossible) while the panel must be clickable.
     ---------------------------------------------------------- */
  function ensureOverlay() {
    if (state.box) return;

    var host = document.createElement('div');
    host.id = HL_ID;
    host.setAttribute('style', 'all:initial;position:static;');
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    if (!shadow) return;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '.box{position:fixed;pointer-events:none;z-index:2147483646;',
      'border:2px solid #2563eb;background:rgba(37,99,235,.12);',
      'border-radius:2px;display:none;box-sizing:border-box}',
      '.tip{position:fixed;pointer-events:none;z-index:2147483646;display:none;',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'background:#1d4ed8;color:#fff;padding:2px 6px;border-radius:3px;',
      'white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;',
      'box-shadow:0 1px 4px rgba(0,0,0,.35)}'
    ].join('');

    var box = document.createElement('div');
    box.className = 'box';
    var tip = document.createElement('div');
    tip.className = 'tip';

    shadow.appendChild(style);
    shadow.appendChild(box);
    shadow.appendChild(tip);
    (document.documentElement || document.body).appendChild(host);

    state.hlHost = host;
    state.hlShadow = shadow;
    state.box = box;
    state.tip = tip;
  }

  // "a#buy.btn 120×36" — the tag identity plus the measured size, which is how
  // a user confirms they grabbed the button and not the wrapper around it.
  function describeShort(el) {
    var api = inspect();
    var label = '';
    if (api) {
      try {
        label = api.shortLabel({
          tag: api.tagNameOf(el),
          id: el.getAttribute ? (el.getAttribute('id') || '') : '',
          classes: (el.getAttribute && el.getAttribute('class') || '')
            .trim().split(/\s+/).filter(Boolean)
        });
      } catch (e) { label = ''; }
    }
    if (!label) label = (el.tagName || 'node').toLowerCase();
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (r) label += '  ' + Math.round(r.width) + '\u00d7' + Math.round(r.height);
    return label;
  }

  function moveOverlay(el) {
    ensureOverlay();
    if (!state.box || !el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) { hideOverlay(); return; }

    state.box.style.display = 'block';
    state.box.style.left = r.left + 'px';
    state.box.style.top = r.top + 'px';
    state.box.style.width = r.width + 'px';
    state.box.style.height = r.height + 'px';

    state.tip.style.display = 'block';
    state.tip.textContent = describeShort(el);
    // Above the element normally; flipped inside when the element is at the very
    // top of the viewport, where an above-label would be clipped off-screen.
    var above = r.top - 24;
    state.tip.style.top = (above < 2 ? Math.min(r.top + 2, window.innerHeight - 22) : above) + 'px';
    state.tip.style.left = Math.max(2, r.left) + 'px';
  }

  function hideOverlay() {
    if (state.box) state.box.style.display = 'none';
    if (state.tip) state.tip.style.display = 'none';
  }

  /* ----------------------------------------------------------
     GESTURE HANDLERS — all bound in the CAPTURE phase.

     Sites stop propagation on their own handlers all the time (menus,
     carousels, custom buttons). Bubble-phase listeners would simply never
     fire on exactly the interactive elements people most want to pick.
     ---------------------------------------------------------- */
  function onMove(e) {
    if (!state.active) return;
    // Once an element is frozen the panel describes THAT element; letting the
    // outline follow the mouse would point at one element while the panel
    // listed another.
    if (state.frozen) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    state.hovered = el;
    moveOverlay(el);
  }

  function onClick(e) {
    if (!state.active) return;
    if (isOurs(e.target)) return;         // clicks inside our panel are UI, not picks
    // A pick must not also activate the page: clicking a link while picking
    // would navigate away and take the pick with it.
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    freezeOn(e.target);
  }

  function onKey(e) {
    // Ctrl+Shift+C toggles, exactly as it does in DevTools. Bound permanently
    // (see the bottom of this file) so the shortcut works without first
    // opening the popup.
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      e.stopPropagation();
      if (state.active) stop(); else start();
      return;
    }
    if (!state.active) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }

    // Tree walking. The element under the cursor is often not the one wanted —
    // the text span inside the button, or the row wrapping the cell. Arrow keys
    // move the selection up to the parent or down to the first child instead of
    // making the user hunt for a pixel where the right element is on top.
    var base = state.frozen || state.hovered;
    if (!base) return;

    if (e.key === 'ArrowUp' && base.parentElement && !isOurs(base.parentElement)) {
      e.preventDefault();
      e.stopPropagation();
      retarget(base.parentElement);
    } else if (e.key === 'ArrowDown' && base.firstElementChild) {
      e.preventDefault();
      e.stopPropagation();
      retarget(base.firstElementChild);
    }
  }

  function retarget(el) {
    if (state.frozen) {
      freezeOn(el);                 // panel already open: re-describe in place
    } else {
      state.hovered = el;
      moveOverlay(el);
    }
  }

  // The outline is positioned in viewport coordinates, so a scroll or resize
  // leaves it pointing at empty space unless it is re-measured.
  function onScrollOrResize() {
    if (!state.active) return;
    var el = state.frozen || state.hovered;
    if (el && el.isConnected) moveOverlay(el);
    else hideOverlay();
  }

  /* ----------------------------------------------------------
     FREEZE: the clicked element becomes the subject of the panel.
     ---------------------------------------------------------- */
  function freezeOn(el) {
    var api = inspect();
    if (!api) return;

    state.frozen = el;
    state.described = api.describeElement(el, selectors(), {
      url: location.href,
      title: document.title || ''
    });
    if (!state.described) return;

    state.rows = api.attributeRows(state.described);
    state.selected = {};
    api.defaultSelection(state.described).forEach(function (k) {
      state.selected[k] = true;
    });

    moveOverlay(el);
    renderPanel();
  }

  /* ----------------------------------------------------------
     THE PANEL

     Built once, re-rendered per pick. All styling is scoped inside the shadow
     root; nothing here can leak out and restyle the page either.
     ---------------------------------------------------------- */
  function ensurePanel() {
    if (state.shadow) return;

    var host = document.createElement('div');
    host.id = PANEL_ID;
    host.setAttribute('style', 'all:initial;position:static;');
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    if (!shadow) return;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '*{box-sizing:border-box;margin:0;padding:0}',
      '.wrap{position:fixed;right:16px;bottom:16px;width:380px;max-height:70vh;',
      'z-index:2147483647;display:flex;flex-direction:column;',
      'font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
      'background:#0f172a;color:#e8eefc;border:1px solid #1f2a44;border-radius:10px;',
      'box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden;direction:ltr;text-align:left}',
      '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#111c33;',
      'border-bottom:1px solid #1f2a44}',
      '.hd .t{flex:1;min-width:0;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;',
      'color:#93c5fd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hd button{background:#1f2a44;color:#cbd5e1;border:0;border-radius:5px;',
      'padding:4px 8px;font-size:11px;cursor:pointer}',
      '.hd button:hover{background:#2b3a5c;color:#fff}',
      '.meta{padding:6px 12px;font-size:11px;color:#7d8ba8;background:#0d1526;',
      'border-bottom:1px solid #1f2a44;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rows{flex:1;overflow:auto;padding:4px 0}',
      '.row{display:flex;gap:8px;align-items:flex-start;padding:5px 12px}',
      '.row:hover{background:#14203a}',
      '.row input{margin-top:3px;accent-color:#2563eb;cursor:pointer;flex:0 0 auto}',
      '.row label{display:flex;gap:8px;flex:1;min-width:0;cursor:pointer}',
      '.k{flex:0 0 116px;color:#a9b6d0;font-size:11px;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.k.tagd{color:#c4b5fd}',
      '.v{flex:1;min-width:0;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;',
      'color:#e2e8f5;word-break:break-all}',
      '.v.empty{color:#5b6884;font-style:italic}',
      '.hint{padding:6px 12px;font-size:10px;color:#68758f;border-top:1px solid #1f2a44}',
      '.ft{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#111c33;',
      'border-top:1px solid #1f2a44}',
      '.st{flex:1;min-width:0;font-size:11px;color:#8b98b4;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.st.ok{color:#4ade80}',
      '.st.err{color:#f87171}',
      '.ft .go{background:#2563eb;color:#fff;border:0;border-radius:6px;padding:7px 12px;',
      'font-size:12px;font-weight:600;cursor:pointer}',
      '.ft .go:hover{background:#1d4ed8}',
      '.ft .go[disabled]{opacity:.6;cursor:default}',
      '.ft .cx{background:transparent;color:#94a3b8;border:1px solid #2b3a5c;',
      'border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}',
      '.ft .cx:hover{color:#e2e8f5;border-color:#43557f}'
    ].join('');

    var wrap = document.createElement('div');
    wrap.className = 'wrap';

    var hd = document.createElement('div');
    hd.className = 'hd';
    var title = document.createElement('div');
    title.className = 't';
    var again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Pick again';
    again.addEventListener('click', function () {
      // Back to hovering without disarming: the common case after a mis-click is
      // wanting another element, not wanting to leave the picker.
      state.frozen = null;
      state.described = null;
      hidePanel();
      hideOverlay();
    });
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '\u2715';
    close.title = 'Close inspector';
    close.addEventListener('click', function () { stop(); });
    hd.appendChild(title);
    hd.appendChild(again);
    hd.appendChild(close);

    var meta = document.createElement('div');
    meta.className = 'meta';

    var rows = document.createElement('div');
    rows.className = 'rows';

    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '\u2191 / \u2193 select the parent or first child \u00b7 Esc closes';

    var ft = document.createElement('div');
    ft.className = 'ft';
    var st = document.createElement('div');
    st.className = 'st';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cx';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { stop(); });
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.textContent = 'Confirm & Add to Node';
    go.addEventListener('click', function () { submit(go); });
    ft.appendChild(st);
    ft.appendChild(cancel);
    ft.appendChild(go);

    wrap.appendChild(hd);
    wrap.appendChild(meta);
    wrap.appendChild(rows);
    wrap.appendChild(hint);
    wrap.appendChild(ft);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    (document.documentElement || document.body).appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.ui = { wrap: wrap, title: title, meta: meta, rows: rows, st: st, go: go };
  }

  function renderPanel() {
    ensurePanel();
    if (!state.ui || !state.described) return;
    var api = inspect();
    var ui = state.ui;

    ui.wrap.style.display = 'flex';
    ui.title.textContent = api ? api.shortLabel(state.described) : (state.described.tag || '');
    ui.meta.textContent = state.described.url || '';
    setStatus('', '');

    while (ui.rows.firstChild) ui.rows.removeChild(ui.rows.firstChild);

    state.rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'row';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.selected[r.key];
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected[r.key] = true;
        else delete state.selected[r.key];
      });

      var label = document.createElement('label');
      var k = document.createElement('span');
      // data-* rows are tinted so a user scanning a long list can see at a
      // glance which values are the site's own data hooks.
      k.className = r.group === 'data' ? 'k tagd' : 'k';
      k.textContent = r.label || r.key;
      var v = document.createElement('span');
      if (r.value) {
        v.className = 'v';
        v.textContent = r.value;
      } else {
        v.className = 'v empty';
        v.textContent = '(empty)';
      }
      label.appendChild(k);
      label.appendChild(v);
      // Clicking the text toggles the box — a 12px checkbox is a poor target.
      label.addEventListener('click', function (e) {
        e.preventDefault();
        cb.checked = !cb.checked;
        if (cb.checked) state.selected[r.key] = true;
        else delete state.selected[r.key];
      });

      row.appendChild(cb);
      row.appendChild(label);
      ui.rows.appendChild(row);
    });

    ui.rows.scrollTop = 0;
  }

  function hidePanel() {
    if (state.ui) state.ui.wrap.style.display = 'none';
  }

  function setStatus(msg, kind) {
    if (!state.ui) return;
    state.ui.st.className = 'st' + (kind ? ' ' + kind : '');
    state.ui.st.textContent = msg || '';
  }

  /* ----------------------------------------------------------
     SUBMIT

     The content script cannot talk to the project directly — a page-context
     fetch is subject to the page's CSP and to CORS. The background service
     worker has host permissions and does the request; we hand it the payload
     and surface whatever it reports back.
     ---------------------------------------------------------- */
  function submit(button) {
    if (!state.described) return;

    // Preserve PANEL ORDER rather than object key order: the backend maps the
    // first non-identity pick to the node's attribute field, so "which one is
    // first" is meaningful and must match what the user saw.
    var ordered = state.rows
      .filter(function (r) { return !!state.selected[r.key]; })
      .map(function (r) { return r.key; });

    if (!ordered.length) {
      setStatus('Tick at least one attribute first.', 'err');
      return;
    }
    if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
      setStatus('Extension context unavailable — reload the page.', 'err');
      return;
    }

    button.disabled = true;
    setStatus('Sending\u2026', '');

    try {
      chrome.runtime.sendMessage({
        type: 'ab-inspector-submit',
        element: state.described,
        selected: ordered
      }, function (res) {
        button.disabled = false;
        var err = chrome.runtime.lastError;
        if (err) { setStatus(err.message || 'Send failed.', 'err'); return; }
        if (!res || !res.ok) {
          // The backend refuses with an actionable reason ("no active node",
          // "stale session"). Showing it verbatim is the difference between the
          // user knowing to open a node and the user thinking it is broken.
          setStatus((res && (res.error || res.reason)) || 'Send failed.', 'err');
          return;
        }
        var where = res.node || res.where || '';
        setStatus('Added' + (where ? ' to ' + where : ''), 'ok');
        // Leave the confirmation visible briefly, then get out of the user's way.
        setTimeout(stop, 900);
      });
    } catch (e) {
      button.disabled = false;
      setStatus((e && e.message) || 'Send failed.', 'err');
    }
  }

  /* ----------------------------------------------------------
     LIFECYCLE
     ---------------------------------------------------------- */
  function start() {
    if (state.active) return;
    state.active = true;
    state.frozen = null;
    state.described = null;
    ensureOverlay();
    hidePanel();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseover', onMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
  }

  function stop() {
    state.active = false;
    state.hovered = null;
    state.frozen = null;
    state.described = null;
    state.rows = [];
    state.selected = {};
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseover', onMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    hideOverlay();
    hidePanel();
  }

  // Permanently bound, unlike the picker listeners: the shortcut has to work
  // before the picker exists, which is the whole point of a shortcut.
  document.addEventListener('keydown', onKey, true);

  if (window.chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
      if (!msg || !msg.type) return;
      if (msg.type === 'ab-inspector-start') { start(); reply({ ok: true, active: true }); }
      else if (msg.type === 'ab-inspector-stop') { stop(); reply({ ok: true, active: false }); }
      else if (msg.type === 'ab-inspector-state') { reply({ ok: true, active: state.active }); }
    });
  }

  window.ABInspector = {
    start: start,
    stop: stop,
    isActive: function () { return state.active; }
  };
})();

