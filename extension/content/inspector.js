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

   THE PICK IS KEPT UNTIL THE USER CLOSES — AND 👁 IS WHY THAT IS BEARABLE
   ----------------------------------------------------------------------
   Clicking freezes an element and the panel then STAYS: the picker does not
   close itself, because comparing two candidate elements, or reading a value
   before committing it, both need the panel to survive the click. The cost is
   that the picking gesture remains armed over a page the user now wants to read
   — every mousemove re-outlines, every click is swallowed and re-aimed — and the
   only way out used to be ✕, which discards the pick along with the ticks and
   the armed radio.

   The header's 👁 pauses the GESTURE and nothing else. Selection off: no hover
   outline follows the mouse, no click re-picks, the arrows do not walk the tree,
   and page clicks are handed back to the page. Everything the user has chosen —
   the frozen element, its rows, the checkboxes, the radio — is untouched, and
   the outline stays on the picked element so the panel's subject is still
   visible. ✕ closes; 👁 pauses. They are deliberately not the same action.

   EVERY DISPLAYED VALUE CAN BE COPIED
   -----------------------------------
   Each attribute row and each SELECTED ELEMENT entry carries its own copy
   button. Own, not shared: the button closes over ITS row's key and resolves the
   text through valueForKey() at click time, which is what makes "copying one row
   cannot yield another row's value" a structural property rather than a thing to
   be careful about. Values are read from `state.rows`, so what is copied is the
   real string and never the "(empty)" placeholder the cell may be showing. The
   confirmation is a ✓ on the pressed button for ~1s — deliberately not a toast,
   because §16 forbids growing the picker and the question being answered ("did
   THAT line copy?") is local to one line.

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
    /*
     * SELECTION MODE — the 👁 toggle in the header.
     *
     * `active` and `selecting` are TWO states, and the distinction is the whole
     * feature. `active` means "the picker is open"; `selecting` means "moving the
     * mouse and clicking picks a new element".
     *
     * Why they cannot be one flag: after freezing an element the user often needs
     * to interact with the PAGE again — scroll a list to read the value in
     * context, open a menu, compare the element against a neighbour. While
     * `selecting` is on, every mousemove re-outlines and every click is swallowed
     * and re-aimed, so the only way to stop re-picking used to be to CLOSE the
     * picker — which throws away the pick that was just made and, with it, the
     * ticked rows and the armed radio.
     *
     * So 👁 pauses the picking gesture and NOTHING else: the panel stays open,
     * the frozen element stays described, both selections survive, and the
     * outline stays on the element that was picked so the user can still see
     * what the panel is talking about. ✕ / Cancel / Esc remain the only ways to
     * close. Conflating the two would make "let me look at the page" and "throw
     * my pick away" the same button.
     */
    selecting: true,   // hover/click may re-target; toggled by the eye button
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
    drag: null,        // { dx, dy, id } while the header is being dragged
    // Per-row "✓ Copied" reset timers, keyed by row key. Held here so a second
    // copy on the SAME row restarts its own countdown instead of stacking two
    // timers that would each try to clear the label — and so a copy on one row
    // never cancels another row's feedback. See copyValue().
    copyTimers: {}
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

  // The copy control's resting glyph: the two-sheets mark every editor uses for
  // copy. A text glyph rather than an SVG for the same reason the header's
  // crosshair is one — this panel inherits nothing from the page and a single
  // mark needs no viewBox. Declared once because it is written in three places
  // (the button's initial label, and the two restores after a flash), and three
  // literals is three chances for the icon to change in only two of them.
  var COPY_GLYPH = '\u29c9';

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
    // 👁 off: the picking GESTURE is paused, so the mouse is the page's again.
    // Returning before anything is written is what makes the pause total — the
    // outline is left exactly where it was (on the frozen element, if there is
    // one), and `state.hovered` is not advanced, so a later Arrow keypress or a
    // re-enable cannot act on an element the user merely swept the cursor over
    // while selection was off.
    if (!state.selecting) return;
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
    /*
     * 👁 off: no new pick, and the click is NOT swallowed either.
     *
     * The swallowing below exists only to protect a pick in progress. With
     * selection paused there is no gesture to protect, and the reason a user
     * pauses it is to use the page again — expanding the row that holds the
     * element, opening the tab it lives in, scrolling a virtualised list. A
     * picker that still ate every click would leave the page inert with no
     * visible cause, which reads as the tool having hung.
     *
     * Returning before freezeOn() is what satisfies "click does NOT select
     * another element": the frozen element, its rows, the ticks and the armed
     * radio are all untouched by a click anywhere on the page.
     */
    if (!state.selecting) return;
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
    //
    // Paused with 👁 off, because this IS element selection — reached by keyboard
    // rather than by pointer. Leaving it live would mean "selection disabled"
    // stopped the mouse and not the arrows, i.e. the toggle would only half do
    // what it says, and an accidental ArrowUp would silently re-describe the
    // element the user had deliberately frozen.
    if (!state.selecting) return;
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
     SELECTION MODE — the 👁 toggle

     WHAT IT IS FOR
     --------------
     The picker keeps a pick until the user closes it, which is right: closing on
     the first click would make comparing two candidate elements impossible. But
     it also means the picking gesture stays armed over a page the user now wants
     to READ — and while it is armed, every mousemove re-outlines and every click
     is swallowed. The only escape was ✕, which discards the pick.

     So this pauses the gesture and nothing else. It is deliberately NOT a second
     route to closing, and it does not clear `frozen`, `described`, `rows`,
     `display` or `sendKey`: pausing selection must not lose a single thing the
     user has chosen, or nobody would dare press it.
     ---------------------------------------------------------- */

  /**
   * Turn element selection on or off.
   *
   * `on` is coerced rather than trusted so a click handler passing an event by
   * accident cannot leave the flag holding an object that is truthy forever.
   */
  function setSelecting(on) {
    var next = !!on;
    if (state.selecting === next) { renderEye(); return; }
    state.selecting = next;

    if (!next) {
      /*
       * Turning it OFF. `hovered` is dropped because it is a fact about a
       * gesture that is no longer running — keeping it would let a re-enable, or
       * an Arrow key, act on whatever the cursor happened to be over when the
       * user paused.
       *
       * The OUTLINE is a different question, and the requirement is explicit:
       * «currently selected element remains visible». So with a frozen element
       * the outline is re-measured and KEPT — the panel still describes that
       * element, and an outline is how the user knows which one. Without a
       * frozen element there is nothing being described, and an outline left
       * over a hover the picker no longer tracks would be a lie, so it goes.
       */
      state.hovered = null;
      if (state.frozen && state.frozen.isConnected !== false) moveOverlay(state.frozen);
      else hideOverlay();
    } else if (state.frozen && state.frozen.isConnected !== false) {
      // Back on with a pick still frozen: the outline stays on that element (the
      // panel still describes it), and the next click re-freezes as usual.
      moveOverlay(state.frozen);
    }

    renderEye();
  }

  function toggleSelecting() { setSelecting(!state.selecting); }

  /**
   * Paint the eye button for the state it now carries.
   *
   * The class is what the CSS keys off, and `aria-pressed` is what a screen
   * reader keys off — a toggle whose state is only a colour is invisible to
   * anyone not looking at the colour. The label is a glyph swap (👁 / 🚫-ish
   * slashed eye) so the state is legible even where the accent is not.
   */
  function renderEye() {
    if (!state.ui) return;
    // The notice is painted first and unconditionally, so it cannot survive on
    // screen in a build where the eye is missing.
    if (state.ui.paused) {
      state.ui.paused.style.display = state.selecting ? 'none' : 'block';
    }
    if (!state.ui.eye) return;
    var b = state.ui.eye;
    b.className = state.selecting ? 'ey on' : 'ey off';
    // U+1F441 vs the same eye with a combining slash is unreliable across
    // platforms, so the OFF state uses the "no entry"-free pair the panel can
    // guarantee: an open eye and a struck-through eye drawn as text.
    b.textContent = state.selecting ? '\u25c9' : '\u25cc';
    b.setAttribute('aria-pressed', state.selecting ? 'true' : 'false');
    b.title = state.selecting
      ? 'Element selection is ON — click an element to pick it. Click to pause.'
      : 'Element selection is PAUSED — the page is yours again. Click to resume.';
  }

  /* ----------------------------------------------------------
     COPY — one button per displayed value

     WHY EVERY ROW GETS ITS OWN
     --------------------------
     The values in this panel are the whole reason the panel exists, and their
     destination is very often somewhere outside this product: a colleague's
     message, a test file, a selector box in another tool. Selecting a clipped
     one-line cell with the mouse is unreliable (and the header's drag makes a
     stray selection worse), so each row carries its own copy action.

     WHY THE VALUE IS CAPTURED PER ROW, NOT LOOKED UP ON CLICK
     --------------------------------------------------------
     A shared handler that resolved "the current row" at click time is how a copy
     button ends up putting a NEIGHBOUR's value on the clipboard after a
     re-render. Each button closes over its own row's key and reads that row's
     value from `state.rows`, so a copy can only ever produce the value on the
     line the user pressed.
     ---------------------------------------------------------- */

  /**
   * The exact string a given row is offering.
   *
   * Read from `state.rows` — the same array the row and SELECTED ELEMENT render
   * from — rather than from the rendered cell's textContent. The cell may be
   * showing "(empty)" for a boolean attribute, and copying the literal word
   * "(empty)" would be putting our own placeholder on the user's clipboard.
   */
  function valueForKey(key) {
    if (!state.rows) return '';
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].key === key) return state.rows[i].value || '';
    }
    return '';
  }

  /**
   * Put `text` on the clipboard, resolving true/false.
   *
   * Two paths, and both are needed. `navigator.clipboard.writeText` is the
   * modern one but it is gated on a secure context and on the document being
   * focused — and this panel lives in an arbitrary page, so an http:// site or a
   * page that has just stolen focus would simply fail. The execCommand fallback
   * works there. It is written into a textarea positioned off-screen with
   * `readonly` cleared, because a readonly/hidden field is not selectable in
   * every engine.
   *
   * The temporary node is appended to the DOCUMENT, not to our shadow root: a
   * selection inside a closed shadow root is not what execCommand('copy') reads.
   * It is removed in a `finally`, so a throw cannot leave a stray textarea in
   * the user's page.
   */
  function writeClipboard(text) {
    var s = String(text == null ? '' : text);
    if (!s) return Promise.resolve(false);

    function legacy() {
      var ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = s;
        // Off-screen rather than display:none — a hidden field cannot be
        // selected, and a visible one would flash over the page.
        ta.setAttribute('style',
          'position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none;');
        ta.setAttribute('aria-hidden', 'true');
        (document.body || document.documentElement).appendChild(ta);
        if (ta.select) ta.select();
        if (ta.setSelectionRange) ta.setSelectionRange(0, s.length);
        var ok = false;
        if (document.execCommand) ok = !!document.execCommand('copy');
        return ok;
      } catch (e) {
        return false;
      } finally {
        if (ta && ta.parentNode) {
          try { ta.parentNode.removeChild(ta); } catch (e2) { /* nothing to do */ }
        }
      }
    }

    try {
      var nav = window.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        var p = nav.clipboard.writeText(s);
        if (p && p.then) {
          return p.then(function () { return true; }, function () { return legacy(); });
        }
        return Promise.resolve(true);
      }
    } catch (e) { /* fall through to the legacy path */ }

    return Promise.resolve(legacy());
  }

  /**
   * Copy one row's value and confirm it ON THAT ROW.
   *
   * The confirmation is deliberately local and small: a "✓" swapped into the
   * button that was pressed, reverting after a moment. §16 forbids growing the
   * picker, and a toast would either cover the very rows being read or push the
   * layout — while the question the user is asking ("did THAT one copy?") is
   * about a single line and is answered best beside it.
   *
   * The timer is keyed by row so two copies in a row on different lines each get
   * their own confirmation, and a repeat copy on the same line restarts its own
   * countdown rather than stacking a second timer that would clear the label
   * early.
   */
  function copyValue(key, button) {
    var text = valueForKey(key);
    if (!button) return;

    if (!text) {
      // A boolean attribute (`<ol reversed>`) has nothing to put on a clipboard.
      // Said plainly on the button rather than silently doing nothing, which
      // would read as the button being broken.
      flashCopy(key, button, '\u2014', 'no value to copy');
      return;
    }

    writeClipboard(text).then(function (ok) {
      if (ok) flashCopy(key, button, '\u2713', 'Copied');
      else flashCopy(key, button, '!', 'Copy failed — select the value and press Ctrl+C');
    });
  }

  /** The short-lived label on one copy button. */
  function flashCopy(key, button, glyph, title) {
    if (!button) return;
    button.textContent = glyph;
    button.title = title;
    if (button.classList) button.classList.add('done');

    // `key in`, not a truthiness test: a timer handle is allowed to be 0, and a
    // falsy-but-real handle would sail past `if (state.copyTimers[key])` and leave
    // a live timer behind to clear this label early.
    if (Object.prototype.hasOwnProperty.call(state.copyTimers, key)) {
      try {
        if (typeof clearTimeout === 'function') clearTimeout(state.copyTimers[key]);
      } catch (e) { /* not fatal */ }
      delete state.copyTimers[key];
    }
    if (typeof setTimeout !== 'function') return;
    state.copyTimers[key] = setTimeout(function () {
      delete state.copyTimers[key];
      // The button may have been thrown away by a re-render (a new pick, a bulk
      // tick) while the timer was pending. Restoring text on a detached node is
      // harmless, so there is nothing to guard beyond the node existing.
      button.textContent = COPY_GLYPH;
      button.title = 'Copy this value';
      if (button.classList) button.classList.remove('done');
    }, 1100);
  }

  /**
   * One copy button, for one row's value.
   *
   * `key` is captured in the closure, which is what guarantees the rule that
   * copying one row cannot produce another row's value. The click is stopped
   * from propagating because in the rows this button sits inside a `<label>`
   * whose own click toggles DISPLAY — without this, every copy would also tick
   * or untick the row, i.e. an action for reading a value would change what the
   * panel is showing.
   */
  function copyButton(key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp';
    b.textContent = COPY_GLYPH;
    b.title = 'Copy this value';
    // Named for the row, so the control is not just "button" to a screen reader
    // reading a column of identical glyphs.
    b.setAttribute('aria-label', 'Copy ' + key);
    b.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      copyValue(key, b);
    });
    // The panel's rows are not a drag handle, but the SELECTED ELEMENT section
    // and the rows both sit under a header that is — and a press that wanders a
    // pixel must not turn a copy into a window move.
    b.addEventListener('pointerdown', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
    });
    return b;
  }

  /**
   * Tick or clear the DISPLAY column in one action.
   *
   * The popup's §19 contract, applied here unchanged: this touches
   * `state.display` and NOTHING else. `state.sendKey` is deliberately not read
   * or written, because "show me everything" and "send this one value" are
   * different questions — see the block comment where the buttons are built.
   *
   * Rebuilt through renderRows() rather than by walking the live checkboxes, so
   * there is exactly one place that turns `state.display` into what is on screen.
   * Poking the inputs directly would leave two renderers to keep in agreement.
   */
  function setDisplayAll(on) {
    if (!state.rows || !state.rows.length) return;
    state.display = {};
    if (on) {
      state.rows.forEach(function (r) { state.display[r.key] = true; });
    } else if (state.sendKey) {
      /*
       * One exception to a literal "clear", and it exists to keep the panel
       * honest rather than to be clever: the row being SENT stays visible.
       *
       * Arming a radio already forces its checkbox on (see the radio handler),
       * because sending a value the user cannot see is indefensible. If Clear
       * were allowed to hide that row, the panel would claim it is sending an
       * attribute that appears nowhere in the list, and DESTINATION in the popup
       * would name a value with no corresponding row. Clearing everything else
       * is the useful part of the gesture and it still happens.
       */
      state.display[state.sendKey] = true;
    }
    renderRows();
    publishPick();
  }

  /**
   * The toolbar's own state: the count, and whether each bulk action can still
   * do anything.
   *
   * Disabling at the extremes matters more here than in the popup, because this
   * panel floats over the user's page — a button that swallows a click without
   * visible effect reads as the panel having frozen.
   */
  function renderTools() {
    if (!state.ui || !state.ui.tools) return;
    var total = state.rows ? state.rows.length : 0;
    var shown = state.rows
      ? state.rows.filter(function (r) { return !!state.display[r.key]; }).length
      : 0;
    state.ui.count.textContent = total ? shown + ' of ' + total + ' shown' : '';
    state.ui.allBtn.disabled = total === 0 || shown === total;
    // With a radio armed, the floor is 1 rather than 0: that row cannot be
    // hidden, so at 1-of-N there is genuinely nothing left for Clear to do.
    var floor = state.sendKey && state.display[state.sendKey] ? 1 : 0;
    state.ui.noneBtn.disabled = total === 0 || shown <= floor;
    // With nothing picked there is nothing to bulk-edit, and an enabled toolbar
    // over an empty list invites a click that cannot work.
    state.ui.tools.style.display = total ? 'flex' : 'none';
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
      /*
       * ── THE 👁 SELECTION TOGGLE ───────────────────────────────────────────
       *
       * Same 24px square and same 1px/4px chrome as ✕ beside it, because they are
       * peers in the header — but they are NOT the same kind of action, and the
       * styling has to say so. ✕ is borderless and muted: it dismisses the tool
       * and should not compete for attention. This one carries state, so it is a
       * real bordered control whose two states are distinguishable at a glance:
       *
       *   ON  — the accent, on the accent's own faint wash. This is the picker's
       *         normal condition and the colour the outline and the armed radio
       *         already use, so "orange means this is what is live" holds across
       *         the whole panel.
       *   OFF — muted foreground on the panel's own #151515, with a dashed border.
       *         Deliberately NOT dimmed to near-invisibility: selection being off
       *         is a state the user chose and will want to leave, so the control
       *         has to stay legible and obviously pressable. The dash is what
       *         makes the difference readable without colour, which matters
       *         because the whole distinction would otherwise be one hue.
       */
      '.hd button.ey{padding:0;width:24px;display:flex;align-items:center;',
      'justify-content:center;font-size:12px;line-height:1}',
      '.hd button.ey.on{color:#ff6600;border-color:#55301d;background:#ff66001a}',
      '.hd button.ey.on:hover{background:#ff660026;border-color:#ff6600}',
      '.hd button.ey.off{color:#a0a0a0;border-color:#3a3a3a;background:#151515;',
      'border-style:dashed}',
      '.hd button.ey.off:hover{color:#fff;border-color:#555;background:#1f1f1f}',
      // Keyboard focus must be visible on both states: this is a toggle, and a
      // toggle nobody can see the focus on cannot be operated without a mouse.
      '.hd button.ey:focus-visible{outline:2px solid #ff6600;outline-offset:1px}',
      /*
       * ── PAUSED BANNER ─────────────────────────────────────────────────────
       *
       * With selection off, the page stops responding to the picker — no outline
       * follows the mouse, no click re-picks. That is exactly what was asked for,
       * and it is also indistinguishable from the picker having died unless the
       * panel says which it is. One line, in the existing `.meta` idiom, on the
       * accent so it reads as a live mode rather than an error.
       *
       * `display` is toggled from renderEye()'s caller, so the row occupies no
       * space at all while selection is on — this must not become permanent
       * furniture in the panel's normal state.
       */
      '.pz{padding:6px 10px;font:10px/13px ' + MONO + ';letter-spacing:.04em;',
      'color:#ff6600;background:#1a0f07;border-bottom:1px solid #55301d;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /*
       * ── COPY BUTTONS ──────────────────────────────────────────────────────
       *
       * One per value, in the rows and in SELECTED ELEMENT. Sized down to 18px
       * from the header's 24px because these repeat once per line: at header size
       * a twenty-row list would read as a column of buttons with attribute values
       * squeezed beside them, inverting what the panel is for.
       *
       * Muted and borderless at rest, for the same reason ✕ is: the values are
       * the content, and twenty resting accents would flatten the one accent that
       * means something (the armed radio). The control earns its border and its
       * accent on hover/focus — the point at which it IS what the user is doing.
       *
       * `flex:0 0 auto` so the button never shrinks under a long value, and never
       * steals width from it either.
       */
      '.cp{flex:0 0 auto;width:18px;height:18px;display:flex;align-items:center;',
      'justify-content:center;padding:0;border:1px solid transparent;border-radius:3px;',
      'background:transparent;color:#6f6f6f;font:11px/1 ' + MONO + ';cursor:pointer}',
      '.cp:hover{color:#ff6600;border-color:#55301d;background:#ff660014}',
      '.cp:focus-visible{outline:2px solid #ff6600;outline-offset:1px;color:#ff6600}',
      // The "✓ Copied" moment. Green is the design's --green, already the panel's
      // success colour in the footer status line, so a confirmation means the same
      // thing wherever it appears. It reverts on its own after ~1s.
      '.cp.done{color:#00c853;border-color:#1d4a2c;background:#00c8531a}',
      '.meta{padding:7px 10px;font:11px/14px ' + MONO + ';color:#a0a0a0;background:#131313;',
      'border-bottom:1px solid #2a2a2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /*
       * ── SELECTED ELEMENT (§17), in the picker ────────────────────────────
       *
       * The picker used to end at the attribute rows, and every one of those rows
       * is deliberately CLIPPED to a single line (`.v` is nowrap + ellipsis, for
       * the alignment reasons written above that rule). At 330px that leaves
       * roughly thirty characters, so a ticked CSS Selector read
       * "div.bubble > div.desc:nth-of…" and an XPath read "/html[1]/body[1]/div[1]…"
       * — a half-line PREVIEW of the very string the user is about to commit to
       * their node. The whole value existed only in a `title` tooltip, which is
       * not somewhere a value can be read, compared against another candidate,
       * or copied.
       *
       * The popup already solves this: its SELECTED ELEMENT card renders every
       * TICKED row in full, wrapping (`.kv .v { overflow-wrap: anywhere }`). Two
       * surfaces of one feature answering "what did I just select?" differently
       * is the actual defect — so the picker gets the same section, driven by the
       * same checkbox state, and a tick now has somewhere to be READ instead of
       * only somewhere to be counted.
       *
       * It sits ABOVE the attribute rows: this is the readable statement of the
       * pick, and the rows below are the controls that edit that statement. Its
       * own scroll and a max-height keep a long value from pushing the rows — and
       * the toolbar that edits them — out of a 70vh panel. The section is a
       * readout; it must never crowd out the thing it reflects.
       */
      '.sel{flex:0 0 auto;max-height:34vh;overflow:auto;background:#0e0e0e;',
      'border-bottom:1px solid #2a2a2a}',
      '.sel .sh{display:flex;align-items:baseline;gap:6px;padding:6px 10px 4px;',
      'font:700 9px/12px ' + MONO + ';letter-spacing:.1em;text-transform:uppercase;',
      'color:#ff6600}',
      // Names WHY a value is here at all, which is the §16/§23 distinction the
      // whole panel rests on: this section is the checkbox column made readable,
      // never the radio's outbound value.
      '.sel .sh i{flex:1;min-width:0;font:400 9px/12px ' + SANS + ';letter-spacing:0;',
      'text-transform:none;color:#666;font-style:normal;text-align:right;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // `position:relative` plus the reserved right padding is how the copy
      // button gets a place in this section without changing its two-line
      // key-above-value shape. Laying the key and the button out as a flex row
      // instead would push the key's own wrapping around, and this section exists
      // precisely so nothing here has to be reflowed to fit.
      '.sitem{position:relative;padding:5px 30px 6px 10px;border-top:1px solid #1c1c1c}',
      '.sitem.first{border-top:0}',
      // Aligned to the KEY line rather than the value: the value can be many
      // lines tall here, and a button that drifted to the middle of a wrapped
      // XPath would stop reading as belonging to that entry's heading.
      '.sitem > .cp{position:absolute;top:4px;right:6px}',
      '.sk{display:block;font:10px/13px ' + MONO + ';color:#a0a0a0}',
      '.sk.tagd{color:#d98b52}',
      /*
       * THE ENTIRE POINT OF THIS SECTION: the value is shown WHOLE.
       *
       * `overflow-wrap:anywhere` (the popup's own `.kv .v` rule) rather than the
       * rows' nowrap+ellipsis. The rows clip because uniform row heights are what
       * make a long list scannable; here there is no list to keep aligned and no
       * reason left to hide the tail. `user-select:text` because the reason a user
       * wants the full string on screen is frequently to copy it, and the header's
       * `user-select:none` must not leak down here.
       */
      '.sv{display:block;margin-top:2px;font:11px/15px ' + MONO + ';color:#fff;',
      'overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}',
      '.sv.empty{color:#666;font-style:italic;font-family:' + SANS + '}',
      // The armed row is marked here as well as in the list, so the answer to
      // "which of these actually travels?" never requires looking away.
      '.sitem.out{background:#120e0b}',
      '.sitem.out .sk{color:#ff6600}',
      // Not an error state: it is the honest reading of "you have ticked nothing",
      // and it names the control that changes it.
      '.sempty{padding:7px 10px;font:10px/14px ' + SANS + ';color:#666}',
      /*
       * The DISPLAY toolbar. The popup has had "Select all / Clear" since §19;
       * this panel only ever offered one-at-a-time ticking, so an element with
       * twenty data-* attributes cost twenty clicks to show.
       *
       * It sits directly above the rows, on the same #131313 as `.meta`, so it
       * reads as a header FOR the list rather than another row IN it. Its buttons
       * are the design's `.btn.secondary` shrunk to 22px: they are a bulk edit of
       * the checkbox column, not a peer of Confirm/Cancel in the footer.
       */
      '.tools{display:flex;align-items:center;gap:6px;padding:5px 10px;background:#131313;',
      'border-bottom:1px solid #2a2a2a}',
      '.tools button{height:22px;padding:0 8px;border-radius:3px;background:#151515;',
      'border:1px solid #2a2a2a;color:#fff;font:600 9px/1 ' + MONO + ';letter-spacing:.08em;',
      'text-transform:uppercase;cursor:pointer}',
      '.tools button:hover{background:#1d1d1d;border-color:#3a3a3a}',
      // A disabled bulk action states "there is nothing left to do" — clearer
      // than a button that accepts the click and changes nothing.
      '.tools button[disabled]{opacity:.4;cursor:default}',
      '.tools button[disabled]:hover{background:#151515;border-color:#2a2a2a}',
      // The count is the feedback for a bulk edit: after one click on Select all,
      // this line is the only thing that confirms how many rows it touched.
      '.tools .n{flex:1;min-width:0;text-align:right;font:10px/12px ' + MONO + ';',
      'color:#a0a0a0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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
      // "Pick again" is a request to pick, so it un-pauses. Leaving selection off
      // here would tear the panel down and then refuse to pick anything, which is
      // a dead end with no visible cause — the user asked for the hovering state,
      // and the hovering state requires selection to be live.
      setSelecting(true);
      // Withdraw the abandoned pick as well, for the same reason Cancel does: the
      // user has just said this element was the wrong one, and leaving it in
      // storage would keep it on offer in the popup.
      publishPick();
    });

    /*
     * ── 👁 SELECTION TOGGLE ───────────────────────────────────────────────
     *
     * A THIRD kind of header action, and the reason it has to exist separately
     * from the two beside it:
     *
     *   "Pick again"  discards this pick and goes back to hovering.
     *   ✕             closes the picker and discards everything.
     *   👁            keeps the pick AND the panel, and only stops the gesture.
     *
     * Before this, a user who had picked the element they wanted had no way to
     * touch the page again: hovering re-outlined, clicking re-picked, and the only
     * exit was ✕, which threw away the pick along with the ticks and the armed
     * radio. Pausing selection is what makes a frozen pick something you can keep
     * while you go and read the page around it.
     *
     * Bound to `click` only — no keyboard shortcut is added, because every letter
     * combination is the page's and the picker already spends Ctrl+Shift+C, Esc,
     * Enter and the arrows.
     */
    var eye = document.createElement('button');
    eye.type = 'button';
    // The class, glyph, tooltip and aria-pressed are all set by renderEye() so
    // there is exactly one place that decides what each state looks like — two
    // would drift the moment a state was added.
    eye.className = 'ey on';
    eye.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      // Toggles selection and NOTHING else. It must never reach stop(): ✕ closes,
      // this pauses, and collapsing the two is the exact confusion this control
      // exists to remove.
      toggleSelecting();
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
    [again, eye, close].forEach(function (b) {
      b.addEventListener('pointerdown', function (e) {
        if (e.stopPropagation) e.stopPropagation();
      });
    });

    hd.appendChild(mark);
    hd.appendChild(title);
    hd.appendChild(again);
    // Between "Pick again" and ✕: it belongs with the picking controls, and it is
    // kept off the panel's edge so the muscle-memory reach for ✕ cannot land on a
    // control that silently pauses the tool instead of closing it.
    hd.appendChild(eye);
    hd.appendChild(close);

    var meta = document.createElement('div');
    meta.className = 'meta';

    /*
     * The paused notice. Hidden while selection is live (see renderPaused), so it
     * costs no height in the panel's normal state — it exists to explain a mode
     * the user has deliberately entered, not to decorate the default one.
     */
    var paused = document.createElement('div');
    paused.className = 'pz';
    paused.style.display = 'none';
    paused.textContent = 'Selection paused \u00b7 the page is yours \u00b7 \u25c9 to resume';

    /*
     * SELECTED ELEMENT — the ticked rows, rendered in FULL (§17).
     *
     * Built as a container plus a fixed header here, and refilled per change by
     * renderSelected(); the header is static so the section keeps its identity
     * even while it holds nothing, which is what lets it explain itself instead
     * of appearing out of nowhere on the first tick.
     */
    var sel = document.createElement('div');
    sel.className = 'sel';
    var selHead = document.createElement('div');
    selHead.className = 'sh';
    var selTitle = document.createElement('span');
    selTitle.textContent = 'Selected element';
    // Stated in the header rather than in a tooltip, because the one thing a
    // user must not have to guess is why a row is in this list.
    var selNote = document.createElement('i');
    selNote.textContent = 'checked rows, in full';
    selHead.appendChild(selTitle);
    selHead.appendChild(selNote);
    var selBody = document.createElement('div');
    selBody.className = 'sb';
    sel.appendChild(selHead);
    sel.appendChild(selBody);

    /*
     * Bulk DISPLAY controls, requested because ticking twenty data-* attributes
     * one at a time is twenty clicks for something the popup has always done in
     * one. The popup's §19 contract is copied exactly rather than reinvented:
     *
     *   these affect the CHECKBOX column ONLY and must never move the radio.
     *
     * Showing every attribute and choosing which single one to send are separate
     * decisions. A "Clear" that also disarmed the radio would leave Confirm
     * refusing for a reason nothing on screen explains — and worse, a "Select
     * all" that armed a radio would change what is about to be written to the
     * user's node when they only asked to look at the list.
     */
    var tools = document.createElement('div');
    tools.className = 'tools';
    var allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'all';
    allBtn.textContent = 'Select all';
    allBtn.title = 'Show every discovered attribute (does not change what is sent)';
    allBtn.addEventListener('click', function () { setDisplayAll(true); });
    var noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = 'none';
    noneBtn.textContent = 'Clear';
    noneBtn.title = 'Show none of them (does not change what is sent)';
    noneBtn.addEventListener('click', function () { setDisplayAll(false); });
    var count = document.createElement('span');
    count.className = 'n';
    tools.appendChild(allBtn);
    tools.appendChild(noneBtn);
    tools.appendChild(count);

    var rows = document.createElement('div');
    rows.className = 'rows';

    var hint = document.createElement('div');
    hint.className = 'hint';
    // Spells out the distinction the two controls encode, because a checkbox
    // next to a radio is otherwise ambiguous on first sight. The copy mark is
    // named here too: it is a 18px glyph repeated down the list, and a legend is
    // cheaper than twenty tooltips the user has to hover to discover.
    hint.textContent = '\u2611 show \u00b7 \u25c9 send (one only) \u00b7 '
      + COPY_GLYPH + ' copy \u00b7 \u2191/\u2193 parent or child \u00b7 Esc closes';

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
    // Directly under the header, beside the control that produced it: a mode
    // notice further down would be read as a comment on the rows rather than on
    // the picker.
    wrap.appendChild(paused);
    // Above the toolbar and the rows: the readable statement of the pick comes
    // first, and the controls that edit it follow. Reversing these would put the
    // full values below a scrolling list, i.e. off-screen exactly when the list
    // is long enough for the clipping to matter.
    wrap.appendChild(sel);
    wrap.appendChild(tools);
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
    state.ui = {
      wrap: wrap, hd: hd, title: title, meta: meta, rows: rows, st: st, go: go,
      tools: tools, allBtn: allBtn, noneBtn: noneBtn, count: count,
      // Only the BODY is cached: the header is static, so nothing ever needs to
      // find it again, and caching it would invite a future edit to rewrite it.
      sel: sel, selBody: selBody,
      // The eye and its notice ARE re-read on every toggle, so both are cached:
      // finding them by class on each press would be a second place that knows the
      // markup, and the toggle has to be able to repaint even with no pick loaded.
      eye: eye, paused: paused,
    };

    // The panel is built once and may be built while selection is already paused,
    // so the eye and its notice are painted from the CURRENT state here rather
    // than assumed to start on.
    renderEye();
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

    // Rebuilds the rows AND, through them, SELECTED ELEMENT — so a fresh pick
    // cannot leave the previous element's values on screen.
    renderRows();

    ui.rows.scrollTop = 0;
    // The readout scrolls independently, so it needs its own reset: a pick made
    // after scrolling down a long value would otherwise open part-way into the
    // new element's first attribute.
    ui.sel.scrollTop = 0;

    // Re-clamp now that the rows exist and the panel has its real height. A
    // 3-row pick and a 30-row pick are very different heights, and the second is
    // the one whose footer used to end up below the fold — and SELECTED ELEMENT
    // adds height of its own, which is precisely why it is capped and scrollable
    // rather than free to grow with the value it holds.
    placePanel();
  }

  /**
   * Build the attribute rows from `state.display` / `state.sendKey`.
   *
   * Split out of renderPanel() so the bulk DISPLAY buttons repaint through the
   * SAME code that first drew the list. The alternative — walking the live
   * checkboxes and flipping `.checked` — would create a second renderer to keep
   * in step with this one, and the two would eventually disagree about the
   * checkbox/radio coupling that the rows encode.
   *
   * Note it does NOT re-clamp or reset the scroll position: a bulk tick must not
   * jump the list back to the top or move a panel the user has placed. Row count
   * and therefore panel height are unchanged by a display toggle, so there is
   * nothing for the clamp to correct.
   */
  function renderRows() {
    if (!state.ui || !state.rows) return;
    var ui = state.ui;

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
        renderTools();
        // The readout is repainted here rather than by rebuilding the rows: a
        // full renderRows() would replace the very checkbox the pointer is on
        // mid-click. This is the ONE thing a tick is for, so it has to be
        // immediate — the point of the section is that ticking a box is how you
        // read a value in full.
        renderSelected();
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
          // Arming can both raise the count and change Clear's floor, since the
          // armed row can no longer be hidden.
          renderTools();
          // Arming moves the "→ sending" marker AND can pull a previously hidden
          // row into the readout (the line above just ticked it), so the section
          // has to be rebuilt, not merely re-marked.
          renderSelected();
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
        renderTools();
        // Same repaint as the checkbox's own handler: this IS the checkbox, just
        // reached through a larger hit target.
        renderSelected();
        publishPick();
      });

      row.appendChild(cb);
      row.appendChild(rd);
      row.appendChild(label);
      /*
       * The copy control, OUTSIDE the label and last in the row.
       *
       * Outside, because the label's click toggles DISPLAY: a copy button inside
       * it would tick or untick the row on every copy, so reading a value would
       * silently change what the panel is showing. (Its own handler stops
       * propagation as well — belt and braces, since the label is an ancestor in
       * the event path either way.)
       *
       * Last, because the two selection controls are the row's PURPOSE and the
       * value is its content; a copy button before them would put a
       * clipboard action in the position the eye reads as "what this row is for".
       */
      row.appendChild(copyButton(r.key));
      ui.rows.appendChild(row);
    });

    // The toolbar reads from the same state the rows were just built from, so it
    // cannot fall out of step with what is on screen.
    renderTools();
    // …and so does SELECTED ELEMENT. Called from HERE, once, rather than from
    // each of the four places that mutate `state.display`: every one of those
    // already repaints through renderRows(), so hanging the readout off the same
    // call is what guarantees it can never show a set the rows disagree with.
    renderSelected();
  }

  /**
   * SELECTED ELEMENT — every TICKED row, with its value shown IN FULL (§17).
   *
   * WHY THIS EXISTS AT ALL
   * ----------------------
   * The attribute rows above are clipped to one line on purpose: equal row
   * heights are what keep the key column aligned and a twenty-row list
   * scannable. But that means the panel's only rendering of a value was a
   * ~30-character preview — "div.bubble > div.desc:nth-of…" — of a string the
   * user is about to commit to a node field. The full text lived solely in a
   * `title` tooltip: fine as a reassurance, useless for reading a long XPath,
   * comparing two candidate selectors, or copying either.
   *
   * The popup has always had this section. The picker not having it is the
   * defect: the two surfaces of one feature gave different answers to "what did
   * I just select?", and the picker's answer was the truncated one — while the
   * picker is the surface the user is actually looking at when they tick a box.
   *
   * WHAT DRIVES IT — AND WHAT MUST NOT
   * ----------------------------------
   * `state.display` — the CHECKBOXES — and nothing else, exactly as the popup's
   * renderSelected() does. §16/§23 keep display and send independent, so this
   * section must not be filtered by, reordered around, or limited to
   * `state.sendKey`; the armed row is merely MARKED here (`.out`), because
   * "which one travels" is a fact worth seeing beside the values, not a filter
   * on them.
   *
   * Order is PANEL ORDER, from `state.rows`, so the readout reads in the same
   * sequence as the list it reflects — not in tick order, which would reshuffle
   * the section every time a box changed.
   */
  function renderSelected() {
    if (!state.ui || !state.ui.selBody) return;
    var ui = state.ui;
    var body = ui.selBody;

    while (body.firstChild) body.removeChild(body.firstChild);

    // No pick yet: the section is hidden entirely rather than shown empty. Before
    // the first freeze there is no element to describe, and an empty card above
    // the rows would just be furniture.
    if (!state.described || !state.rows || !state.rows.length) {
      ui.sel.style.display = 'none';
      return;
    }
    ui.sel.style.display = 'block';

    var shown = state.rows.filter(function (r) { return !!state.display[r.key]; });

    if (!shown.length) {
      // Kept VISIBLE and explained, unlike the no-pick case: here the emptiness
      // is a state the user produced (a Clear, or un-ticking the last row) and
      // can undo, so the section says which control brings values back instead
      // of silently vanishing and looking like a bug.
      var none = document.createElement('div');
      none.className = 'sempty';
      none.textContent = 'Nothing ticked. Check a row below to show it here in full.';
      body.appendChild(none);
      return;
    }

    shown.forEach(function (r, i) {
      var item = document.createElement('div');
      item.className = 'sitem'
        + (i === 0 ? ' first' : '')
        + (state.sendKey === r.key ? ' out' : '');

      var k = document.createElement('span');
      // Same data-* tint as the rows, so a key means the same thing in both
      // places.
      k.className = r.group === 'data' ? 'sk tagd' : 'sk';
      k.textContent = r.label || r.key;
      // The arrow is appended as TEXT rather than drawn by a CSS ::after so the
      // marker survives being read by a screen reader, and so the row cannot end
      // up claiming to be outbound in one renderer and not the other.
      if (state.sendKey === r.key) k.textContent += '  \u2192 sending';

      var v = document.createElement('span');
      if (r.value) {
        v.className = 'sv';
        // textContent, never innerHTML: this is an attribute value from an
        // arbitrary page, and one `<img onerror=…>` here would be script
        // execution inside our own UI. The whole file holds to this rule.
        v.textContent = r.value;
      } else {
        v.className = 'sv empty';
        v.textContent = '(empty)';
      }

      item.appendChild(k);
      item.appendChild(v);
      /*
       * Its own copy button, keyed by the SAME row key as the list's.
       *
       * Not shared with the row's button, and not a lookup of "the visible one":
       * this section and the rows are two renderings of one row, and each
       * rendering owns the control the user pressed so a "✓ Copied" appears where
       * the click landed. Both read the value from `state.rows` through
       * valueForKey(), so the two buttons cannot disagree about what they copy.
       *
       * This is also the button that matters most: this section is where the
       * value is shown UNCLIPPED, so it is where a user reading a long CSS
       * selector or XPath is standing when they decide to take it.
       */
      item.appendChild(copyButton(r.key));
      body.appendChild(item);
    });
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
    /*
     * Opening the picker ALWAYS starts with selection live, whatever it was when
     * the picker was last closed.
     *
     * Persisting the pause would mean the very next Ctrl+Shift+C opened a picker
     * that outlines nothing and picks nothing — the tool arriving broken, for a
     * reason set minutes earlier on another page. The pause is a state WITHIN one
     * picking session, so it belongs to that session.
     */
    state.selecting = true;
    renderEye();
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
    // Reset with everything else, so a paused session cannot hand its pause to
    // the next one. start() asserts the same thing; both do it because either can
    // be reached first (✕ then Ctrl+Shift+C, or the popup's Inspect button).
    state.selecting = true;
    // Pending "✓ Copied" reverts are dropped: their buttons are going away with
    // the panel, and a timer that outlives the UI it was going to repaint is a
    // leak with no observable purpose.
    Object.keys(state.copyTimers).forEach(function (k) {
      try {
        if (typeof clearTimeout === 'function') clearTimeout(state.copyTimers[k]);
      } catch (e) { /* not fatal */ }
    });
    state.copyTimers = {};
    renderEye();
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

