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

   WHERE THE PANEL OPENS, AND WHY THAT NEEDED FIXING
   -------------------------------------------------
   The panel used to be pinned with a hard-coded `right:16px; bottom:16px` in
   CSS. Nothing ever compared its real size against the viewport, so on a short
   window — or on a page whose zoom/transform changes the effective viewport —
   the footer carrying Cancel and Confirm fell below the bottom edge and the
   picker became a dead end: the user could see the rows and could not act on
   them. `onScrollOrResize()` re-measured the OUTLINE only, never the panel.

   It is now positioned in left/top, MEASURED after it is on screen, and clamped
   into the viewport by clampPanel() — on open, on every resize, and after every
   drag. The size is unchanged: this was never a "too small / too large" problem.

   WHY THE HEADER IS THE ONLY DRAG HANDLE
   --------------------------------------
   The panel covers part of the page it describes, so it has to be movable. But a
   draggable BODY would mean every attempt to tick a checkbox or drag-select a
   value started a window move instead. So the drag is bound to the header strip
   only, `user-select: none` is applied to that strip alone, and the pointer is
   captured so a fast drag that outruns the cursor does not drop the panel.
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
    // §16/§23 — TWO INDEPENDENT STATES, deliberately not one.
    //
    // `display` is the set of ticked CHECKBOXES: which attributes the user wants
    // to look at. `sendKey` is the single selected RADIO: the one attribute whose
    // value is actually sent to the Target Field.
    //
    // Collapsing these into one collection is the obvious simplification and it
    // is wrong: the user needs to compare several candidates on screen before
    // committing to one, and "what I am reading" is not "what I am sending".
    // Keeping them apart is also what makes the outbound value unambiguous —
    // with a single set, sending would have to pick a winner by position, which
    // is a rule nobody can see.
    display: {},       // key -> true for ticked rows (VIEW ONLY)
    sendKey: '',       // the ONE key whose value is sent (§21)
    host: null,        // panel shadow host
    shadow: null,      // panel shadow root
    ui: null,          // cached panel element refs
    hlHost: null,      // highlight shadow host
    hlShadow: null,
    box: null,         // the outline rectangle
    tip: null,         // the floating label
    // Panel position in VIEWPORT coordinates, or null while the panel has never
    // been placed. Held here rather than read back off the style on every drag
    // frame: reading a computed style forces layout on a page we do not own, and
    // the numbers we set are the numbers we mean.
    pos: null,         // { left, top }
    drag: null         // { dx, dy, id } while the header is being dragged
  };

  // The panel's margin from the viewport edge. Large enough that a page's own
  // scrollbar cannot sit over the Confirm button, small enough that the panel
  // still reads as parked in the corner.
  var EDGE = 12;

  // The panel's width, from `--w` in the supplied picker.html design document.
  //
  // §16 forbids resizing the picker to "fix" visibility — «resize یا افزایش
  // ابعاد انجام نده» — but names its own exception: «مگر اینکه extension/UI_UX
  // صراحتاً ابعاد دیگری برای Picker تعریف کرده باشد». The design document does
  // define another dimension, explicitly and in a token, so this is that
  // exception and not a workaround: the position bugs were fixed by clamping and
  // dragging, which is what §16 is protecting, and the width follows the design.
  //
  // Declared once, in JS, because it is needed in two places that must never
  // disagree — the stylesheet below and panelSize()'s fallback. A literal in
  // each is a clamp that silently uses the wrong width the moment one changes.
  var PANEL_W = 330;

  // The height to assume before the panel has been laid out. Only ever a
  // fallback: the real height depends on how many rows the picked element
  // produced, so it is measured everywhere it matters.
  var PANEL_H_GUESS = 420;

  /* ----------------------------------------------------------
     TYPOGRAPHY

     The design pairs Hanken Grotesk for prose with JetBrains Mono for every
     label, identity and button, and the picker leans almost entirely on the
     mono. Both are vendored in the extension (see popup/fonts/), so nothing
     here touches the network.

     Two things make loading them from a content script different from loading
     them in the popup:

       · `@font-face` inside a shadow root is ignored. Font faces resolve
         against the DOCUMENT, so the rule has to be registered on the page
         even though every other style here is scoped to the shadow root. The
         FontFace API does exactly that and adds nothing visible to the page.
       · The woff2 lives inside the extension, and a page's own CSS cannot
         name a chrome-extension:// URL. chrome.runtime.getURL() produces one
         that this script may load.

     If any of that is unavailable — an ancient Chromium, a page that has
     somehow removed document.fonts, a blob: context — the stacks below simply
     fall through to the platform's own UI and monospace faces. That is why the
     fallbacks are named rather than left to `sans-serif`/`monospace`: the panel
     must degrade to the right SHAPE of typeface, not to Times.
     ---------------------------------------------------------- */
  var SANS = '"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var MONO = '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

  // Registered once per page, however many times the panel is opened and closed.
  var fontsRequested = false;

  function loadFonts() {
    if (fontsRequested) return;
    fontsRequested = true;
    try {
      if (!document.fonts || typeof window.FontFace !== 'function') return;
      if (!(window.chrome && chrome.runtime && chrome.runtime.getURL)) return;
      [
        ['Hanken Grotesk', 'popup/fonts/hanken-grotesk-latin.woff2'],
        ['JetBrains Mono', 'popup/fonts/jetbrains-mono-latin.woff2']
      ].forEach(function (f) {
        var face = new window.FontFace(f[0], 'url(' + chrome.runtime.getURL(f[1]) + ')', {
          // The vendored files are variable fonts, so one face covers the whole
          // 400–700 range the design uses. Declaring the range is what stops the
          // browser synthesising a fake bold over the top of the real one.
          weight: '400 700',
          style: 'normal',
          display: 'swap'
        });
        // Added to the set BEFORE the load resolves so the shadow CSS can already
        // name the family; `swap` means the fallback shows until the bytes land.
        document.fonts.add(face);
        var p = face.load();
        // A rejected load is not an error worth surfacing: the stacks fall back
        // on their own, and an unhandled rejection in a content script would
        // appear in the console of a page that has nothing to do with it.
        if (p && p.catch) p.catch(function () {});
      });
    } catch (e) { /* fall back to the platform faces */ }
  }

  // Fallbacks for the rare case where the viewport cannot be measured. Guessing
  // small is deliberate: a too-small guess parks the panel further inside the
  // viewport, which is visible but harmless. A too-large guess parks it outside,
  // which is the exact bug being fixed.
  var FALLBACK_W = 1024;
  var FALLBACK_H = 700;

  function viewportW() {
    var w = window.innerWidth;
    if (!w && document.documentElement) w = document.documentElement.clientWidth;
    return w || FALLBACK_W;
  }

  function viewportH() {
    var h = window.innerHeight;
    if (!h && document.documentElement) h = document.documentElement.clientHeight;
    return h || FALLBACK_H;
  }

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

    // The element label is set in the mono face too, and the overlay appears
    // before the panel does — so the request has to start here as well, not only
    // in ensurePanel(). loadFonts() is idempotent, so calling it from both costs
    // nothing.
    loadFonts();

    var host = document.createElement('div');
    host.id = HL_ID;
    host.setAttribute('style', 'all:initial;position:static;');
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    if (!shadow) return;

    var style = document.createElement('style');
    style.textContent = [
      // The design document's `.target`: a 2px --orange border over a #ff660012
      // wash, with a 1px #ff660033 halo so the edge still reads against both a
      // white and a dark page. The fill stays that faint deliberately — it sits
      // ON TOP of the content the user is reading in order to decide whether this
      // is the right element, and anything heavier obscures the very thing being
      // judged.
      //
      // Same accent as the panel and the popup, because the outline and the panel
      // are one act of pointing and cannot be two different colours.
      ':host{all:initial}',
      '.box{position:fixed;pointer-events:none;z-index:2147483646;',
      'border:2px solid #ff6600;background:#ff660012;box-shadow:0 0 0 1px #ff660033;',
      'display:none;box-sizing:border-box}',
      // The design's `.tag`: the label is a panel-coloured chip OUTLINED in
      // orange, not a solid orange block. It carries a tag name and dimensions in
      // mono, which stay readable on charcoal and would fight the border on a
      // saturated fill.
      '.tip{position:fixed;pointer-events:none;z-index:2147483646;display:none;',
      'font:11px/14px ' + MONO + ';',
      'background:#1a1a1a;color:#fff;border:1px solid #ff6600;padding:5px 8px;',
      'white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;',
      'box-shadow:0 2px 8px rgba(0,0,0,.45)}'
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

    // ESC cancels. `stop()` clears the pick and tears the UI down without
    // sending anything, which is what cancelling has to mean: no target and no
    // data may be mutated by walking away.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }

    // ENTER confirms — but only once an element is frozen and a value is armed.
    // Guarded on `sendKey` rather than just on `frozen`, because on a frozen
    // element with nothing armed the keypress would only produce the "choose one
    // attribute" refusal, and a keyboard that silently errors is worse than one
    // that does nothing. It also stays out of the way while the user is typing
    // in the page: the picker swallows clicks, so a frozen panel is the only
    // state where Enter could not have been meant for the page.
    if (e.key === 'Enter' && state.frozen && state.sendKey && state.ui) {
      e.preventDefault();
      e.stopPropagation();
      submit(state.ui.go);
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
  //
  // The PANEL is re-clamped here too, which it previously never was — that
  // omission is half the positioning bug. Shrinking the window used to push the
  // footer, and with it Cancel and Confirm, off the bottom of the screen with no
  // way to bring it back.
  function onScrollOrResize() {
    if (!state.active) return;
    if (state.frozen && state.ui) placePanel();
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
    state.display = {};
    var defaults = api.defaultSelection(state.described);
    defaults.forEach(function (k) { state.display[k] = true; });

    // Pre-arm the radio on the first default that actually HAS a value, so the
    // common case is one click on "Confirm". A row with no value would be
    // refused on send, so pre-selecting one would arm a guaranteed failure.
    state.sendKey = '';
    for (var i = 0; i < state.rows.length; i++) {
      var r = state.rows[i];
      if (defaults.indexOf(r.key) !== -1 && r.value) { state.sendKey = r.key; break; }
    }

    moveOverlay(el);
    renderPanel();
    publishPick();
  }

  /* ----------------------------------------------------------
     PUBLISHING THE PICK TO THE POPUP

     The popup's SELECTED ELEMENT and ATTRIBUTES sections describe the same pick
     this panel is showing. It cannot be handed over by a message, because at the
     moment of the pick the popup is CLOSED — the first thing the picker does is
     move the mouse onto the page, which dismisses it. So the pick is left in
     storage and the popup reads it on open.

     Written on freeze and after every change to either selection state, so the
     popup opens showing the ticks and the armed radio the user left in the page
     rather than a reset panel. The two are then two views of one pick, which is
     the only version of this that cannot show the user contradictory answers to
     "what am I about to send?".
     ---------------------------------------------------------- */
  function publishPick() {
    if (!(window.chrome && chrome.storage && chrome.storage.local)) return;
    try {
      if (!state.described) { chrome.storage.local.set({ ab_lastPick: null }); return; }
      chrome.storage.local.set({
        ab_lastPick: {
          element: state.described,
          rows: state.rows,
          // PANEL ORDER, not object key order, so what the popup restores is in
          // the order the user read it in.
          display: state.rows
            .filter(function (r) { return !!state.display[r.key]; })
            .map(function (r) { return r.key; }),
          sendKey: state.sendKey,
          at: Date.now()
        }
      });
    } catch (e) { /* storage is a convenience here; the panel still works */ }
  }

  /* ----------------------------------------------------------
     WHERE THE PANEL SITS

     Three functions, kept apart because they answer three different questions:
     how big is the panel (measure), where is it allowed to be (clamp), and where
     shall we put it (place).
     ---------------------------------------------------------- */

  // The panel's real on-screen size. Measured, never assumed: the height depends
  // on how many rows the picked element produced, and the width is in CSS the
  // page cannot reach but a browser zoom still scales. Falls back to the design
  // size where measurement is unavailable, so clamping degrades rather than
  // throwing.
  function panelSize() {
    var w = PANEL_W;
    var h = PANEL_H_GUESS;
    var wrap = state.ui && state.ui.wrap;
    if (wrap && wrap.getBoundingClientRect) {
      var r = wrap.getBoundingClientRect();
      if (r && r.width) w = r.width;
      if (r && r.height) h = r.height;
    }
    return { w: w, h: h };
  }

  /**
   * Force a position to be one where the WHOLE panel is on screen.
   *
   * The `max(EDGE, …)` after the `min` is what keeps the top-left corner
   * reachable when the panel is taller than the viewport: clamping only against
   * the bottom edge would push the header — the drag handle, and the only way out
   * of that state — off the top of the screen. Losing the bottom of a scrollable
   * list is recoverable; losing the header is not.
   */
  function clampPos(left, top) {
    var size = panelSize();
    var maxLeft = viewportW() - size.w - EDGE;
    var maxTop = viewportH() - size.h - EDGE;
    return {
      left: Math.round(Math.max(EDGE, Math.min(left, Math.max(EDGE, maxLeft)))),
      top: Math.round(Math.max(EDGE, Math.min(top, Math.max(EDGE, maxTop))))
    };
  }

  /**
   * Write a position to the panel, clamping it first.
   *
   * Every route to a new position — first open, resize, end of a drag — goes
   * through here, so there is exactly one place that can put the panel somewhere
   * unreachable, and it is the place that refuses to.
   */
  function setPos(left, top) {
    var wrap = state.ui && state.ui.wrap;
    if (!wrap) return;
    var p = clampPos(left, top);
    state.pos = p;
    wrap.style.left = p.left + 'px';
    wrap.style.top = p.top + 'px';
  }

  /**
   * Place the panel for a fresh pick, or re-clamp where the user left it.
   *
   * The default is the bottom-right corner — the old hard-coded intent, but now
   * DERIVED from the measured viewport instead of asserted in CSS, which is the
   * whole positioning fix. Once the user has dragged it somewhere, that choice
   * is kept and merely re-clamped: moving the panel back to the corner on the
   * next pick would undo a deliberate action, and the reason people drag it is
   * that the corner is covering what they are trying to inspect.
   */
  function placePanel() {
    if (!state.ui) return;
    if (state.pos) { setPos(state.pos.left, state.pos.top); return; }
    var size = panelSize();
    setPos(viewportW() - size.w - EDGE, viewportH() - size.h - EDGE);
  }

  /* ----------------------------------------------------------
     DRAGGING, BY THE HEADER ONLY

     Pointer events rather than mouse events: one code path covers mouse, touch
     and pen, and `setPointerCapture` keeps the events coming to the header even
     when a fast drag outruns the cursor or crosses an iframe — which a
     mousemove-on-document approach loses.
     ---------------------------------------------------------- */
  function onDragStart(e) {
    // Left button / primary contact only. A right-click on the header should open
    // the context menu, not silently begin a move that ends on the next click.
    if (e.button != null && e.button !== 0) return;
    var wrap = state.ui && state.ui.wrap;
    if (!wrap) return;

    // Anchor from the CURRENT position so the panel does not jump under the
    // cursor on the first frame.
    if (!state.pos) placePanel();
    if (!state.pos) return;

    state.drag = {
      dx: e.clientX - state.pos.left,
      dy: e.clientY - state.pos.top,
      id: e.pointerId
    };

    // The page must not also react to this gesture — a header press that started
    // a text selection or a page-level drag would fight the move.
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();

    var hd = state.ui.hd;
    if (hd && hd.setPointerCapture && e.pointerId != null) {
      try { hd.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    }
    if (hd && hd.classList) hd.classList.add('dragging');
  }

  function onDragMove(e) {
    if (!state.drag) return;
    if (e.pointerId != null && state.drag.id != null && e.pointerId !== state.drag.id) return;
    if (e.preventDefault) e.preventDefault();
    setPos(e.clientX - state.drag.dx, e.clientY - state.drag.dy);
  }

  function onDragEnd(e) {
    if (!state.drag) return;
    var hd = state.ui && state.ui.hd;
    if (hd && hd.releasePointerCapture && state.drag.id != null) {
      try { hd.releasePointerCapture(state.drag.id); } catch (err) { /* not fatal */ }
    }
    if (hd && hd.classList) hd.classList.remove('dragging');
    state.drag = null;
    if (e && e.preventDefault) e.preventDefault();
  }

  /* ----------------------------------------------------------
     THE PANEL

     Built once, re-rendered per pick. All styling is scoped inside the shadow
     root; nothing here can leak out and restyle the page either.
     ---------------------------------------------------------- */
  function ensurePanel() {
    if (state.shadow) return;

    // Requested here rather than at script load: this runs in EVERY frame of
    // every page the user visits, and a page where the inspector is never opened
    // should not have two fonts fetched into it.
    loadFonts();

    var host = document.createElement('div');
    host.id = PANEL_ID;
    host.setAttribute('style', 'all:initial;position:static;');
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    if (!shadow) return;

    // ── THE PICKER'S APPEARANCE ────────────────────────────────────────────
    //
    // Every value below comes from the supplied picker.html design document, not
    // from an approximation of it:
    //
    //   --bg #090909 · --panel #1a1a1a · --panel2 #131313 · --border #2a2a2a
    //   --muted #a0a0a0 · --orange #ff6600 · --green #00c853 · --w 330 · --r 4
    //
    // The blue palette this replaces matched nothing else in the product; these
    // are the same tokens the popup now uses, so the two surfaces of one feature
    // read as one feature.
    //
    // WHAT IS DELIBERATELY *NOT* PORTED: the design document's `.page`,
    // `.fake-page`, `.fake-card`, `.ghost` and `.target` rules, and its `.help`
    // and `.toast`. Those draw a pretend web page and a pretend highlighted
    // element so the picker can be previewed in isolation in a browser tab. Here
    // the page is the user's real page and the highlight is a real overlay drawn
    // by ensureOverlay(); reproducing the scaffolding would paint a fake site on
    // top of the real one.
    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '*{box-sizing:border-box;margin:0;padding:0}',
      // position:fixed with LEFT/TOP, not right/bottom. The old right/bottom
      // pinning is precisely what made the panel unpositionable: there was no
      // coordinate to clamp and nothing for a drag to write. These values are
      // placeholders — placePanel() overwrites both from the measured viewport
      // before the panel is ever visible.
      '.wrap{position:fixed;left:' + EDGE + 'px;top:' + EDGE + 'px;',
      // The design's --w, and its `max-width:calc(100vw - 20px)` so the panel
      // still fits a viewport narrower than itself instead of overflowing it.
      'width:' + PANEL_W + 'px;max-width:calc(100vw - ' + (EDGE * 2) + 'px);max-height:70vh;',
      'z-index:2147483647;display:flex;flex-direction:column;',
      'font:13px/1.5 ' + SANS + ';',
      'background:rgba(10,10,10,.98);color:#fff;border:1px solid #2a2a2a;border-radius:4px;',
      'box-shadow:0 12px 28px rgba(0,0,0,.45);overflow:hidden;direction:ltr;text-align:left}',
      // ── The drag handle. `cursor:grab` and `user-select:none` are scoped to
      // THIS strip alone. The design puts `user-select:none` on the whole picker,
      // which it can afford because its mockup body holds nothing worth
      // selecting; this one lists real attribute values, and people select those
      // to copy them. Restricting it to the header keeps the design's behaviour
      // where it matters — a drag never selects the title — without disabling a
      // useful gesture everywhere else.
      // `touch-action:none` stops a touch drag scrolling the page instead of
      // moving the panel.
      '.hd{display:flex;align-items:center;gap:8px;padding:9px 10px;background:#1a1a1a;',
      'border-bottom:1px solid #2a2a2a;cursor:grab;user-select:none;',
      '-webkit-user-select:none;touch-action:none}',
      '.hd.dragging{cursor:grabbing}',
      // The boxed crosshair mark, identical to the popup's header mark, so the
      // two surfaces are recognisably the same tool.
      '.hd .mk{flex:0 0 18px;width:18px;height:18px;display:flex;align-items:center;',
      'justify-content:center;border:1px solid #55301d;border-radius:3px;color:#ff6600;',
      'font:10px/1 ' + MONO + '}',
      '.hd .t{flex:1;min-width:0;font:700 10px/12px ' + MONO + ';letter-spacing:.1em;',
      'text-transform:uppercase;color:#ff6600;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap}',
      '.hd button{background:#151515;color:#fff;border:1px solid #2a2a2a;border-radius:4px;',
      'padding:0 9px;height:24px;font:700 10px/12px ' + MONO + ';letter-spacing:.05em;',
      'text-transform:uppercase;cursor:pointer}',
      '.hd button:hover{background:#1f1f1f;border-color:#444}',
      '.hd button.x{padding:0;width:24px;display:flex;align-items:center;',
      'justify-content:center;background:transparent;border-color:transparent;color:#a0a0a0;',
      'font-size:13px}',
      '.hd button.x:hover{color:#fff;background:#ffffff14;border-color:transparent}',
      '.meta{padding:7px 10px;font:11px/14px ' + MONO + ';color:#a0a0a0;background:#131313;',
      'border-bottom:1px solid #2a2a2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rows{flex:1;overflow:auto;padding:4px 0}',
      '.row{display:flex;gap:7px;align-items:flex-start;padding:6px 10px}',
      '.row:hover{background:#ffffff08}',
      '.row input{margin-top:2px;width:14px;height:14px;accent-color:#777;cursor:pointer;',
      'flex:0 0 auto}',
      // The radio carries the accent and the checkbox does not, because only one
      // of the two decides what leaves this panel. Styling them alike would
      // invite the reading that ticking more boxes sends more values.
      '.row input.send{accent-color:#ff6600}',
      '.row input.send[disabled]{cursor:default;opacity:.35}',
      '.row label{display:flex;gap:7px;flex:1;min-width:0;cursor:pointer}',
      // The design's `.metric`/`.selection` proportions: a mono key column, then
      // the value in white. 100px rather than its 78px because these keys are
      // real attribute names (`data-product-id`) and not the mockup's `CSS`.
      '.k{flex:0 0 100px;font:10px/16px ' + MONO + ';color:#a0a0a0;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      // data-* keys are the site's own hooks — usually the ones being hunted —
      // so they take a tint of the accent rather than a fourth hue.
      '.k.tagd{color:#d98b52}',
      // nowrap + ellipsis, as the design's `.v` specifies. The earlier
      // `word-break:break-all` let long values wrap, which broke them mid-word
      // ("…chec / kout?sku=A1") and made each row a different height, so the key
      // column stopped lining up. A URL or a selector is read left-to-right from
      // its start, so one clipped line beats two mangled ones — and the full text
      // is still recoverable from the row's tooltip and from SELECTED ELEMENT.
      '.v{flex:1;min-width:0;font:11px/16px ' + MONO + ';color:#fff;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.v.empty{color:#666;font-style:italic;font-family:' + SANS + '}',
      '.hint{padding:7px 10px;font:10px/12px ' + MONO + ';color:#666;',
      'border-top:1px solid #2a2a2a}',
      // The design's footer: buttons to the right on #111 above a hairline.
      '.ft{display:flex;align-items:center;gap:6px;padding:9px 10px;background:#111;',
      'border-top:1px solid #2a2a2a}',
      '.st{flex:1;min-width:0;font:11px/14px ' + MONO + ';color:#a0a0a0;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap}',
      '.st.ok{color:#00c853}',
      '.st.err{color:#ff6b63}',
      // The design's `.btn`: 30px, 4px radius, uppercase mono. The primary is
      // orange with DARK text (#1a0a00), which is what stops it vibrating
      // against the near-black panel.
      '.ft button{height:30px;padding:0 11px;border-radius:4px;',
      'font:700 10px/12px ' + MONO + ';letter-spacing:.05em;text-transform:uppercase;',
      'cursor:pointer;border:1px solid transparent}',
      '.ft .go{background:#ff6600;border-color:#ff6600;color:#1a0a00}',
      '.ft .go:hover{filter:brightness(1.06)}',
      '.ft .go[disabled]{opacity:.55;cursor:default;filter:none}',
      '.ft .cx{background:#151515;color:#fff;border-color:#2a2a2a}',
      '.ft .cx:hover{border-color:#444;background:#1a1a1a}'
    ].join('');

    var wrap = document.createElement('div');
    wrap.className = 'wrap';

    var hd = document.createElement('div');
    hd.className = 'hd';
    hd.title = 'Drag to move';

    // ── The drag handle, and ONLY the header. See the note at the top of the
    // file for why the body must stay un-draggable. The move listeners live on
    // the header too rather than on document, because setPointerCapture routes
    // every subsequent event of this gesture back here — including the ones that
    // land over an iframe, which a document-level listener never receives, and
    // which is how a drag "sticks" halfway across the screen.
    hd.addEventListener('pointerdown', onDragStart);
    hd.addEventListener('pointermove', onDragMove);
    hd.addEventListener('pointerup', onDragEnd);
    // A cancelled pointer (the OS taking over, a touch becoming a gesture) must
    // end the drag too, or the panel would follow the cursor with no button held.
    hd.addEventListener('pointercancel', onDragEnd);
    // Belt and braces for the no-pointer-events case: without this, a browser
    // that fired only mouse events would leave the header selecting its own text
    // on every press.
    hd.addEventListener('dragstart', function (e) { if (e.preventDefault) e.preventDefault(); });

    // The boxed crosshair, the same mark the popup's title bar carries — the two
    // surfaces of one feature should be recognisable as one tool. A text glyph
    // rather than an SVG because this panel inherits nothing from the page and a
    // single ◎ needs no viewBox.
    var mark = document.createElement('div');
    mark.className = 'mk';
    mark.textContent = '\u25ce';

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
      // Withdraw the abandoned pick as well, for the same reason Cancel does: the
      // user has just said this element was the wrong one, and leaving it in
      // storage would keep it on offer in the popup.
      publishPick();
    });
    var close = document.createElement('button');
    close.type = 'button';
    // Borderless and muted, as the design's `.close` is: this dismisses the tool
    // and must not compete with Confirm for attention.
    close.className = 'x';
    close.textContent = '\u00d7';
    close.title = 'Close inspector';
    close.addEventListener('click', function () { stop(); });

    // The header's buttons must not also be drag handles. Without this, a press
    // that moves a pixel or two — which most presses do — would begin a window
    // move and the click would never arrive, making "Pick again" and ✕ feel
    // broken exactly when the user is trying to escape a bad pick.
    [again, close].forEach(function (b) {
      b.addEventListener('pointerdown', function (e) {
        if (e.stopPropagation) e.stopPropagation();
      });
    });

    hd.appendChild(mark);
    hd.appendChild(title);
    hd.appendChild(again);
    hd.appendChild(close);

    var meta = document.createElement('div');
    meta.className = 'meta';

    var rows = document.createElement('div');
    rows.className = 'rows';

    var hint = document.createElement('div');
    hint.className = 'hint';
    // Spells out the distinction the two controls encode, because a checkbox
    // next to a radio is otherwise ambiguous on first sight.
    hint.textContent = '\u2611 show \u00b7 \u25c9 send (one only) \u00b7 \u2191/\u2193 parent or child \u00b7 Esc closes';

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
    // `hd` is cached because the drag needs it for pointer capture and for the
    // `.dragging` class — looking it up per pointermove would query the DOM on
    // every frame of a gesture.
    state.ui = { wrap: wrap, hd: hd, title: title, meta: meta, rows: rows, st: st, go: go };
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
    // Placed BEFORE the rows are built so the panel is never painted at the
    // placeholder coordinates, and again AFTER (at the end of this function) once
    // the rows have given it its real height — which is what the clamp needs to
    // know to keep the footer on screen.
    placePanel();

    while (ui.rows.firstChild) ui.rows.removeChild(ui.rows.firstChild);

    state.rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'row';

      // ---- The checkbox: DISPLAY only. Ticking it sends nothing. -----------
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.display[r.key];
      cb.title = 'Show this attribute';
      cb.addEventListener('change', function () {
        if (cb.checked) state.display[r.key] = true;
        else delete state.display[r.key];
        // Deliberately does NOT touch state.sendKey: un-ticking the row you are
        // sending would silently disarm the send, and the button would refuse
        // for a reason the user could not see.
        publishPick();
      });

      // ---- The radio: the ONE value that will be sent. ---------------------
      var rd = document.createElement('input');
      rd.type = 'radio';
      // A shared name is what makes the browser enforce "exactly one" for us,
      // rather than us having to un-check siblings by hand.
      rd.name = 'ab-send';
      rd.className = 'send';
      rd.checked = state.sendKey === r.key;
      // A row with no value cannot be sent, so it cannot be armed either. §14
      // keeps genuinely absent attributes out of the list entirely; what reaches
      // here empty is a boolean attribute like `reversed`, which is worth SEEING
      // but has no value to deliver.
      rd.disabled = !r.value;
      rd.title = r.value ? 'Send this attribute' : 'This attribute has no value to send';
      rd.addEventListener('change', function () {
        if (rd.checked) {
          state.sendKey = r.key;
          // Choosing to send something implies wanting to see it, but the
          // reverse is not true — which is exactly why the two states differ.
          state.display[r.key] = true;
          cb.checked = true;
          publishPick();
        }
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
        // The row clips to one line, so a long href or selector loses its tail on
        // screen. The tooltip carries the whole value, which matters because the
        // tail is often the part being hunted (…?sku=A1). textContent/title only,
        // never innerHTML: these strings come from an arbitrary page.
        v.title = r.value;
        k.title = r.label || r.key;
      } else {
        v.className = 'v empty';
        v.textContent = '(empty)';
      }
      label.appendChild(k);
      label.appendChild(v);
      // Clicking the text toggles DISPLAY — a 12px checkbox is a poor target.
      // It does not arm the radio: making the whole row select the outbound
      // value would make it far too easy to change what is sent while merely
      // trying to read the list.
      label.addEventListener('click', function (e) {
        e.preventDefault();
        cb.checked = !cb.checked;
        if (cb.checked) state.display[r.key] = true;
        else delete state.display[r.key];
        publishPick();
      });

      row.appendChild(cb);
      row.appendChild(rd);
      row.appendChild(label);
      ui.rows.appendChild(row);
    });

    ui.rows.scrollTop = 0;

    // Re-clamp now that the rows exist and the panel has its real height. A
    // 3-row pick and a 30-row pick are very different heights, and the second is
    // the one whose footer used to end up below the fold.
    placePanel();
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

    // Preserve PANEL ORDER rather than object key order, so what travels matches
    // what the user saw.
    var ordered = state.rows
      .filter(function (r) { return !!state.display[r.key]; })
      .map(function (r) { return r.key; });

    // §21: exactly ONE value goes out, and it is the radio's. Refused here
    // rather than sent, because the answer would be the same and the round trip
    // buys nothing.
    var sendRow = null;
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].key === state.sendKey) { sendRow = state.rows[i]; break; }
    }
    if (!sendRow) {
      setStatus('Choose the ONE attribute to send (the round button).', 'err');
      return;
    }
    if (!sendRow.value) {
      setStatus('That attribute has no value to send — choose another.', 'err');
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
        // The ticked boxes: what the user is looking at. Carried so the project
        // can show the same view, but none of these becomes a value.
        displayAttributes: ordered,
        // The radio: the single value that lands in the Target Field. The server
        // re-derives it from the element, so this is advisory.
        sendAttribute: { name: sendRow.key, value: sendRow.value }
      }, function (res) {
        button.disabled = false;
        var err = chrome.runtime.lastError;
        if (err) { setStatus(err.message || 'Send failed.', 'err'); return; }
        if (!res || !res.ok) {
          // The backend refuses with an actionable §27 reason ("this Inspector
          // is not authorized for that Field"). Showing it verbatim is the
          // difference between the user knowing to enter an Authorization Code
          // and the user thinking it is broken.
          setStatus((res && (res.error || res.reason)) || 'Send failed.', 'err');
          return;
        }
        // §24: name the FIELD and the value, not just "done" — that is what
        // proves the value did not quietly go somewhere else.
        var where = res.node || res.where || '';
        if (res.field) where = where ? where + ' → ' + res.field : res.field;
        setStatus('Added' + (where ? ' to ' + where : '') +
          (res.attribute ? ' (' + res.attribute + ')' : ''), 'ok');
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
    state.display = {};
    // Cleared too, or the next pick would arrive with a radio armed on an
    // attribute the newly picked element may not even have.
    state.sendKey = '';
    // An in-flight drag is abandoned, but `state.pos` is deliberately KEPT: the
    // user moved the panel because the default spot covered what they were
    // inspecting, and that is still true on the next pick.
    onDragEnd();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseover', onMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    hideOverlay();
    hidePanel();
    // The published pick goes with the panel.
    //
    // `stop()` is what Cancel and Escape call, and «Cancel → no target/data
    // mutation» has to include the pick the popup would read: one left in storage
    // reappears in SELECTED ELEMENT as though it were still current, and the user
    // would be looking at — and one click from sending — a value they had
    // explicitly walked away from.
    //
    // This costs nothing, because closing the panel is NOT how the user reaches
    // the popup. The panel lives in the page, so opening the popup does not
    // dismiss it; both can be on screen at once, which is the whole reason the
    // pick is published on freeze rather than on close.
    //
    // `state.described` is already null by now, so this writes the empty pick.
    publishPick();
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

