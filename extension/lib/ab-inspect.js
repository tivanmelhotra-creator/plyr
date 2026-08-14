/* ============================================================
   ab-inspect.js — the Element Inspector's extraction core.

   WHAT THIS IS
   ------------
   Given one DOM element, produce the full structured description the
   Inspector panel shows and the backend consumes: tag, id, classes, CSS
   path, XPath, text, value, name, role, type, and EVERY attribute the
   element actually carries.

   WHY IT IS A SEPARATE, PURE FILE
   -------------------------------
   It touches no chrome.* API and creates no UI, so the content script, the
   panel and the unit tests all run the SAME code. The alternative — the
   overlay computing its own view of an element and the panel computing
   another — is how a picker ends up showing a selector that differs from
   the one it sends.

   THE ONE RULE THAT SHAPES EVERYTHING: NO HARDCODED ATTRIBUTE LIST
   ---------------------------------------------------------------
   `collectAttributes` walks `el.attributes` and returns whatever is there.
   It does not consult a whitelist. That is what makes data-* work in full
   generality — data-id, data-product, data-category, data-anything — and it
   is also why href/src/colspan/placeholder/aria-* need no special cases.

   A whitelist would have to be edited every time a site used an attribute
   we had not thought of, and the user would have no way to reach it. The
   only per-tag knowledge here is COSMETIC: which attributes to show FIRST
   (`suggestedKeys`), because a person picking an <a> wants href near the
   top. Ordering a list is a very different thing from limiting it.

   Dual-export like ab-core.js: window.ABInspect in the browser,
   module.exports under Node/vitest.
   ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ABInspect = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // Long values (a data: URI in src, a minified inline style) are useless in a
  // node field and expensive to ship. Truncate for DISPLAY and transport; the
  // node re-reads the live attribute at run time anyway.
  var VALUE_CAP = 2048;

  function cap(v, n) {
    var s = (v == null) ? '' : String(v);
    var limit = n || VALUE_CAP;
    return s.length > limit ? s.slice(0, limit) : s;
  }

  // Collapse whitespace for one-line display. HTML treats a newline and a run
  // of spaces as one separator, so a button labelled "Add\n  to cart" is really
  // "Add to cart" — showing the raw text would be showing markup, not content.
  function tidyText(v) {
    return cap(String(v == null ? '' : v).replace(/\s+/g, ' ').trim());
  }

  /* ----------------------------------------------------------
     ATTRIBUTES — everything the element has, in document order.
     ---------------------------------------------------------- */
  function collectAttributes(el) {
    var out = [];
    if (!el || !el.attributes) return out;
    var list = el.attributes;
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !a.name) continue;
      var name = String(a.name).toLowerCase();
      // HTML attribute names are case-insensitive, so DATA-ID and data-id are
      // one attribute. Two checkboxes for it would let the user tick
      // contradictory things.
      if (seen[name]) continue;
      seen[name] = true;
      out.push({ name: name, value: cap(a.value) });
      // A pathological (or hostile) element must not turn one pick into an
      // unbounded payload.
      if (out.length >= 80) break;
    }
    return out;
  }

  /* ----------------------------------------------------------
     PER-TAG SUGGESTIONS — ordering only, never a limit.
     Mirrors the groups the requirements call out (link/media,
     form/input, table/list) so the attributes a user came for
     are the ones they see first.
     ---------------------------------------------------------- */
  var TAG_HINTS = {
    a: ['href', 'target', 'rel', 'download', 'title'],
    img: ['src', 'alt', 'width', 'height', 'srcset', 'loading', 'title'],
    audio: ['src', 'autoplay', 'controls', 'loop', 'muted', 'preload'],
    video: ['src', 'poster', 'autoplay', 'controls', 'loop', 'muted', 'width', 'height', 'preload'],
    source: ['src', 'srcset', 'type', 'media'],
    form: ['action', 'method', 'enctype', 'target', 'novalidate'],
    input: ['type', 'name', 'value', 'placeholder', 'required', 'disabled', 'readonly',
      'maxlength', 'minlength', 'min', 'max', 'step', 'pattern', 'checked', 'autocomplete'],
    textarea: ['name', 'placeholder', 'required', 'disabled', 'readonly', 'maxlength', 'rows', 'cols'],
    button: ['type', 'name', 'value', 'disabled', 'form'],
    select: ['name', 'required', 'disabled', 'multiple', 'size'],
    option: ['value', 'selected', 'disabled', 'label'],
    label: ['for'],
    td: ['colspan', 'rowspan', 'headers'],
    th: ['colspan', 'rowspan', 'scope', 'abbr'],
    table: ['border', 'summary'],
    ol: ['reversed', 'start', 'type'],
    ul: ['type'],
    li: ['value'],
    iframe: ['src', 'name', 'width', 'height', 'sandbox', 'allow'],
    form_generic: []
  };

  // The global attributes any element can carry (the requirements list these
  // explicitly). Offered as suggestions when the element does not actually have
  // them yet — useful because a user often wants `id` or `title` mentioned even
  // on an element where it is empty.
  var GLOBAL_HINTS = ['id', 'class', 'style', 'title', 'dir', 'lang', 'hidden',
    'tabindex', 'contenteditable', 'autofocus', 'draggable', 'spellcheck', 'role'];

  /**
   * The suggested ORDER of attribute keys for this element: the tag's own
   * interesting attributes first, then everything else it really has (which is
   * where every data-* lands), then the global ones it lacks.
   */
  function suggestedKeys(el) {
    var tag = tagNameOf(el);
    var have = collectAttributes(el).map(function (a) { return a.name; });
    var haveSet = {};
    have.forEach(function (n) { haveSet[n] = true; });

    var ordered = [];
    var pushed = {};
    function push(k) {
      if (!k || pushed[k]) return;
      pushed[k] = true;
      ordered.push(k);
    }

    // 1. tag-specific, but only the ones present.
    (TAG_HINTS[tag] || []).forEach(function (k) { if (haveSet[k]) push(k); });
    // 2. everything else the element actually has — data-* included, in
    //    document order, with nothing filtered out.
    have.forEach(push);
    // 3. globals it does not have, offered last so they never crowd out real data.
    GLOBAL_HINTS.forEach(function (k) { if (!haveSet[k]) push(k); });

    return ordered;
  }

  function tagNameOf(el) {
    if (!el) return '';
    var n = el.tagName || el.nodeName || '';
    return String(n).toLowerCase();
  }

  function classListOf(el) {
    if (!el || !el.getAttribute) return [];
    var raw = el.getAttribute('class') || '';
    return String(raw).trim().split(/\s+/).filter(Boolean).slice(0, 40);
  }

  /**
   * The element's own visible text.
   *
   * innerText is preferred over textContent because innerText is what the user
   * can SEE: it respects display:none and collapses whitespace the way the
   * rendered page does. A text-based selector built from textContent can match
   * a string that is invisible on screen, which the user would read as a bug.
   */
  function textOf(el) {
    if (!el) return '';
    var t = (typeof el.innerText === 'string' && el.innerText)
      ? el.innerText
      : (el.textContent || '');
    return tidyText(t);
  }

  /**
   * The element's current VALUE, for form controls.
   *
   * Read from the live property, not the attribute: `value` as an attribute is
   * the DEFAULT, while the property is what the user has actually typed. When a
   * person inspects a filled-in field they mean what is in it now.
   */
  function valueOf(el) {
    if (!el) return '';
    if (typeof el.value === 'string') return cap(el.value);
    return '';
  }

  /**
   * The accessibility role: explicit `role` if set, otherwise the implicit role
   * of the tag. Included because role is often the most stable way to address a
   * control on a site whose classes are generated hashes.
   */
  function roleOf(el) {
    if (!el) return '';
    if (el.getAttribute) {
      var explicit = el.getAttribute('role');
      if (explicit) return cap(explicit, 80);
    }
    var tag = tagNameOf(el);
    var implicit = {
      a: 'link', button: 'button', input: 'textbox', select: 'combobox',
      textarea: 'textbox', img: 'img', form: 'form', table: 'table',
      ul: 'list', ol: 'list', li: 'listitem', nav: 'navigation',
      header: 'banner', footer: 'contentinfo', main: 'main', h1: 'heading',
      h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading'
    };
    // An <input type=checkbox> is not a textbox; the type refines the role.
    if (tag === 'input' && el.getAttribute) {
      var t = String(el.getAttribute('type') || '').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    }
    return implicit[tag] || '';
  }

  function attrOr(el, name, capTo) {
    if (!el || !el.getAttribute) return '';
    var v = el.getAttribute(name);
    return v == null ? '' : cap(v, capTo);
  }

  /**
   * Describe one element completely.
   *
   * `selectors` is injected rather than imported so this file stays free of any
   * dependency on selector.js's load order — the content script passes
   * window.ABSelector, the tests pass their own. Missing selectors degrade to
   * empty strings instead of throwing, because a description with no CSS path
   * is still worth showing.
   */
  function describeElement(el, selectors, meta) {
    if (!el) return null;
    var sel = selectors || {};
    var css = '';
    var xpath = '';
    try { css = sel.cssPath ? String(sel.cssPath(el) || '') : ''; } catch (e) { css = ''; }
    try { xpath = sel.xPath ? String(sel.xPath(el) || '') : ''; } catch (e) { xpath = ''; }

    var info = meta || {};
    return {
      tag: tagNameOf(el),
      id: attrOr(el, 'id', 200),
      classes: classListOf(el),
      css: cap(css),
      xpath: cap(xpath),
      text: textOf(el),
      value: valueOf(el),
      name: attrOr(el, 'name', 200),
      role: roleOf(el),
      type: attrOr(el, 'type', 80),
      attrs: collectAttributes(el),
      url: cap(info.url || ''),
      title: cap(info.title || '')
    };
  }

  /* ----------------------------------------------------------
     THE ROW LIST the panel renders.

     §14: «Missing attributes must simply not appear in the dynamically
     discovered list… The Attributes panel should look like a real browser DOM
     inspector, not a checklist of all possible HTML attributes.»

     THE DISTINCTION THAT MATTERS IS *PRESENCE*, NOT TRUTHINESS.

     A row is dropped when the thing it describes DOES NOT EXIST. It is kept when
     the thing exists but is empty, because `<ol reversed>`, `<input required>`
     and `<div hidden>` are real attributes with the empty string as their value —
     that is how HTML spells a boolean attribute. Real DevTools shows them as
     `reversed=""`; hiding them would lose information the element genuinely
     carries, and would break the requirement that every discovered attribute be
     reachable. So the discovered-attribute loop below emits a row for everything
     in `byName`, empty value or not.

     The DERIVED rows are the ones that need the §14 guard, because they are
     synthesised here rather than read off the element:

       id / class / text  — a <div> with no id has no id. An `id —` line is
                            exactly the placeholder the spec forbids, and it is
                            worse than mere noise: it offers a radio the user can
                            select and then be refused for, since the server
                            rejects a send whose value is empty.

       tag / css / xpath  — always emitted, and that is not a §14 exception,
                            because these are never MISSING. Every element has a
                            tag name, and describeElement computes a CSS path and
                            an XPath for every element, since a path can always be
                            built from the document root. They are also the only
                            rows that say how a node FINDS the element, so a panel
                            that could omit them would leave nothing selectable
                            to send.

     The original ORDER is kept (tag, id, class, css, xpath, text) so a user who
     knows the panel still finds the rows where they were; absent ones simply
     close up.
     ---------------------------------------------------------- */
  function attributeRows(described) {
    if (!described) return [];
    var rows = [];

    /** Emit unconditionally — for things that exist even when empty. */
    function push(key, label, value, group) {
      rows.push({
        key: key,
        label: label,
        value: (value == null) ? '' : String(value),
        group: group,
        // Retained on the row shape so a renderer can style a boolean attribute
        // (`reversed=""`) differently from one carrying text.
        empty: !value
      });
    }

    /** §14: a DERIVED property with no value describes nothing, so no row. */
    function row(key, label, value, group) {
      if (!value) return;
      push(key, label, value, group);
    }

    push('tag', 'Tag Name', described.tag, 'identity');
    row('id', 'ID', described.id, 'identity');
    row('class', 'Class', (described.classes || []).join(' '), 'identity');
    push('css', 'CSS Selector', described.css, 'identity');
    push('xpath', 'XPath', described.xpath, 'identity');
    row('text', 'Text', described.text, 'content');
    if (described.value) row('value', 'Value', described.value, 'content');
    if (described.name) row('name', 'Name', described.name, 'content');
    if (described.role) row('role', 'Role', described.role, 'content');
    if (described.type) row('type', 'Type', described.type, 'content');

    // Every attribute the element carries. A key is skipped here only when it
    // ALREADY GOT A ROW above — the data would be identical, and a second
    // checkbox for it is a duplicate the user could tick twice.
    //
    // Derived from the rows actually emitted rather than a fixed list, so the
    // §14 guard and this skip-list cannot disagree. The case that makes the
    // difference is `<div id="">`: the derived `id` row is dropped (it describes
    // nothing), and because it was dropped, the attribute is still reachable
    // here as the present-but-empty attribute it really is.
    var already = {};
    rows.forEach(function (r) { already[r.key] = true; });
    var order = suggestedKeys({
      // suggestedKeys wants an element; feed it a shim backed by the attrs we
      // already collected, so this function needs no live DOM node and stays
      // usable on data that arrived over the wire.
      tagName: described.tag,
      attributes: (described.attrs || []).map(function (a) {
        return { name: a.name, value: a.value };
      }),
      getAttribute: function (k) {
        var hit = (described.attrs || []).filter(function (a) { return a.name === k; })[0];
        return hit ? hit.value : null;
      }
    });

    var byName = {};
    (described.attrs || []).forEach(function (a) { byName[a.name] = a.value; });

    order.forEach(function (key) {
      if (already[key]) return;
      // §14 IS ENFORCED HERE, and this single line is the whole of it: an
      // attribute the element does not carry gets no row, no matter how strongly
      // GLOBAL_HINTS suggests it for this tag. That is what keeps the panel from
      // becoming "a checklist of all possible HTML attributes".
      if (!(key in byName)) return;
      // `push`, not `row`: everything reaching this point EXISTS on the element.
      // A boolean attribute (`<ol reversed>`, `<input required>`) has the empty
      // string as its value, and dropping it would hide an attribute the element
      // genuinely carries — the opposite of what §14 asks for.
      push(key, key, byName[key], key.indexOf('data-') === 0 ? 'data' : 'attribute');
    });

    return rows;
  }

  /**
   * The default tick set for a fresh pick.
   *
   * CSS only. Not "everything": a pick that pre-selects ten attributes makes the
   * user UNtick nine, and the one thing every node needs is a selector. For a
   * link or an image the obvious payload is added too, because a user who
   * inspected an <a> almost always wants its href.
   */
  function defaultSelection(described) {
    if (!described) return [];
    var picks = ['css'];
    var tag = described.tag;
    var has = {};
    (described.attrs || []).forEach(function (a) { has[a.name] = true; });
    if (tag === 'a' && has.href) picks.push('href');
    else if ((tag === 'img' || tag === 'video' || tag === 'audio') && has.src) picks.push('src');
    else if (described.value) picks.push('value');
    return picks;
  }

  /** A one-line label for the panel header: "a#buy.btn". */
  function shortLabel(described) {
    if (!described) return '';
    var s = described.tag || 'element';
    if (described.id) s += '#' + described.id;
    else if (described.classes && described.classes.length) s += '.' + described.classes[0];
    return s;
  }

  return {
    VALUE_CAP: VALUE_CAP,
    collectAttributes: collectAttributes,
    suggestedKeys: suggestedKeys,
    describeElement: describeElement,
    attributeRows: attributeRows,
    defaultSelection: defaultSelection,
    shortLabel: shortLabel,
    tagNameOf: tagNameOf,
    textOf: textOf,
    roleOf: roleOf,
    TAG_HINTS: TAG_HINTS,
    GLOBAL_HINTS: GLOBAL_HINTS
  };
});
