/* ============================================
   WorkflowFiles — the Workflow File Workspace drawer for the canvas views.

   WHAT THIS IS
   ------------
   Every saved Workflow owns an isolated, persistent file workspace on the
   server (src/core/WorkflowStorage.ts, HTTP face in
   src/Routes/workflow-files.routes.ts). This module is the RIGHT-SIDE DRAWER
   that browses and manages it from the main app: the picker modal and the Live
   Browser View (both wired through RemoteIO's file prompt).

   THERE IS NO PERMANENT TOOLBAR ANY MORE
   --------------------------------------
   The three standing buttons — «[+ Add File] [Sent] [Files]» — are gone. What
   is left on the surface is ONE small hamburger, and everything else lives
   inside the drawer it opens:

       [≡]  ->  Workflow Files drawer (overlay, right side, occupies nothing
                while shut)

   When a page inside the Browser View asks for a file the prompt offers two
   sources, and the second one opens THIS drawer by itself — the operator never
   presses the hamburger twice:

       Upload from Computer        -> RemoteIO's existing upload bridge
       Choose from Workflow Files  -> this drawer, then
                                      POST /browser/workflow-files/<id>/use

   The Local Browser view (/desktop/chrome, src/core/ChromeView.ts) has its own
   copy of this drawer, because that page is a standalone document served by
   the server and cannot load app scripts. The two speak the same API.

   A REAL FILE WORKSPACE, NOT A LIST
   ---------------------------------
   Per upload-ui/, the drawer is a TREE the operator works in: expand/collapse
   with a chevron, create folder, create file, upload (into the folder they
   right-clicked, not just the root), rename in place, delete with a
   confirmation, refresh, select one file — or several when the page's input is
   `multiple` — and a context menu on every row plus the empty space.

   THE BOUNDARY, FROM THE CLIENT'S SIDE
   ------------------------------------
   Nothing here ever names a filesystem path. Each request carries the
   canonical saved-workflow id (WorkflowService, `wf_...`) and a
   workflow-RELATIVE path the server itself returned in a listing; the server
   decides where that is on disk, refuses anything outside the workflow root,
   and hands the browser the file in-process. `/use` answers with the file's
   NAME and size, never its location. The API key travels in `x-api-key`, so
   it never lands in a URL.

   WHICH WORKFLOW
   --------------
   `currentWorkflowId()` is the id of the workflow open in the editor
   (FlowEditor.getCurrentWorkflow), or an explicit `workflowId` passed by the
   caller. It is validated against the same pattern the server uses; an id
   that does not fit is treated as "no saved workflow", never guessed.

   CSP-safe: no inline handlers, no eval, textContent for every name.
   ============================================ */
(function () {
  'use strict';

  function t(k, fallback) {
    var s = (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
    return (s === k && fallback) ? fallback : s;
  }
  function toast(msg, kind) {
    if (window.AppUtil && window.AppUtil.toast) window.AppUtil.toast(msg, kind || 'info');
  }
  function BIC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 14 }) : '';
  }

  /** The server's own rule (utils/redis-keys.ts WORKFLOW_ID_RE), repeated. */
  var WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  /**
   * The system folders every workspace is born with (core/WorkflowStorage
   * SYSTEM_FOLDERS). `uploads/` is where staged INPUT lives -- and where the
   * toolbar's Upload lands when the workspace root is on screen; `downloads/`
   * is what the browser brought back. The server marks them `system: true`.
   */
  var UPLOADS_FOLDER = 'uploads';

  /**
   * The saved-workflow id the drawer should browse.
   *
   * Preferred: an explicit id from the caller. Fallback: the workflow open in
   * the editor. Empty when the graph has never been saved — the drawer then
   * explains that instead of inventing a bucket.
   */
  function currentWorkflowId(explicit) {
    var id = explicit ? String(explicit) : '';
    if (!id && window.FlowEditor && typeof window.FlowEditor.getCurrentWorkflow === 'function') {
      try {
        var cur = window.FlowEditor.getCurrentWorkflow();
        if (cur && cur.id) id = String(cur.id);
      } catch (e) { /* no editor on this page */ }
    }
    return WORKFLOW_ID_RE.test(id) ? id : '';
  }

  function humanSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * The glyph for a file, by extension.
   *
   * upload-ui/ draws a picture frame for an image and a document for the rest;
   * that is the whole vocabulary, because a per-format icon set is a
   * maintenance burden that tells the operator nothing they cannot read from
   * the name itself.
   */
  var IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i;
  function fileIcon(name) {
    return IMAGE_EXT_RE.test(String(name || '')) ? 'image-frame' : 'file-text';
  }

  function apiHeaders(extra) {
    var key = (window.API && window.API.getKey) ? window.API.getKey() : '';
    var h = {};
    if (key) h['x-api-key'] = key;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  /** Read a JSON answer; turn a refusal into an Error carrying the server's words. */
  function readJson(r) {
    return r.text().then(function (txt) {
      var d = null;
      try { d = JSON.parse(txt); } catch (e) { /* not JSON: the status decides */ }
      if (r.status === 401 || r.status === 403) {
        throw new Error((d && d.error) || t('wfm.notAuthorised', 'Not authorised.'));
      }
      if (!r.ok || !d || !d.success) {
        throw new Error((d && d.error) || (t('wfm.refused', 'The server refused') + ' (HTTP ' + r.status + ').'));
      }
      return d;
    });
  }

  function call(path, init) {
    var o = init || {};
    return fetch(path, {
      method: o.method || 'GET',
      headers: apiHeaders(o.headers),
      body: o.body,
      credentials: 'same-origin'
    }).then(readJson);
  }

  /**
   * Does this file satisfy the page's `accept` attribute? Same rule RemoteIO
   * applies before an upload, so a workflow file the page would silently
   * reject is refused HERE with a message instead.
   */
  function accepts(accept, name) {
    if (window.RemoteIO && typeof window.RemoteIO.acceptsFile === 'function') {
      return window.RemoteIO.acceptsFile(accept, { name: name, type: '' });
    }
    return true;
  }

  /** The parent folder of a workflow-relative path ('' for a root entry). */
  function parentOf(rel) {
    var s = String(rel || '');
    var at = s.lastIndexOf('/');
    return at < 0 ? '' : s.slice(0, at);
  }

  // ── The drawer ─────────────────────────────────────────────────────────
  //
  // ONE drawer at a time; a second open() replaces it. `state` is everything
  // it knows, and is replaced wholesale on close so a request that lands late
  // can tell it belongs to a drawer that is gone (`state !== s`).

  var panel = null;
  var state = null;

  /* The tree, as the operator sees it.
   *
   *   folders: { <rel>: [entry, ...] }  what a folder's listing returned
   *   open:    { <rel>: true }          which folders are expanded
   *   loading: { <rel>: true }          which are being fetched right now
   *
   * '' is the root and is always open. Nothing is fetched twice for one
   * expand, and an expanded folder is re-fetched on refresh() only. */

  function base() {
    return '/browser/workflow-files/' + encodeURIComponent(state.workflowId);
  }

  function say(text, isErr) {
    if (!state) return;
    state.els.note.textContent = text || '';
    state.els.note.className = 'wfm-note' + (isErr ? ' err' : '');
  }

  function setBusy(isBusy, text) {
    if (!state) return;
    var els = state.els;
    if (isBusy) {
      els.root.classList.add('is-busy');
      els.note.className = 'wfm-note is-loading';
      els.note.textContent = '';
      var spin = document.createElement('span');
      spin.className = 'spinner';
      spin.style.width = '12px';
      spin.style.height = '12px';
      spin.style.marginInlineEnd = '6px';
      spin.style.verticalAlign = 'middle';
      spin.setAttribute('aria-hidden', 'true');
      els.note.appendChild(spin);
      var msg = document.createElement('span');
      msg.textContent = text || t('wfm.loading', 'Loading\u2026');
      els.note.appendChild(msg);
    } else {
      els.root.classList.remove('is-busy');
      if (text) say(text, false);
      syncSelection();
    }
  }

  function computeHighestBranch(paths) {
    if (!paths || !paths.length) return '';
    var branches = paths.map(function (p) {
      var norm = String(p || '').replace(/^\/+|\/+$/g, '');
      var idx = norm.indexOf('/');
      return idx === -1 ? '' : norm.slice(0, idx);
    });
    if (branches.some(function (b) { return b === ''; })) return '';
    var first = branches[0];
    return branches.every(function (b) { return b === first; }) ? first : '';
  }

  function close(reason) {
    if (!panel) return;
    var s = state;
    closeMenu();
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    state = null;
    if (s && s.onDocClick) {
      try { document.removeEventListener('click', s.onDocClick, true); } catch (e) { /* fine */ }
    }
    if (s && s.opts && typeof s.opts.onClose === 'function') {
      try { s.opts.onClose(reason || 'closed'); } catch (e) { /* caller's problem */ }
    }
  }

  /** window.prompt / confirm, guarded: the unit harness has no window dialogs. */
  function ask(text, initial) {
    try { return (typeof prompt === 'function') ? prompt(text, initial || '') : null; }
    catch (e) { return null; }
  }

  // ── Selection ──────────────────────────────────────────────────────────
  //
  // A LIST, not one entry, and it is the DRAWER'S OWN: any number of files can
  // be picked at any time, because Download and Delete act on the whole set.
  // The page's `multiple` does NOT shape the selection -- it used to (a second
  // pick REPLACED the first for a single-file input), which made the drawer
  // behave differently depending on which page was asking and left no way to
  // batch-delete while a single-file input waited. Where `multiple` binds is
  // SENDING: use() refuses to hand several files to a page that takes one.
  // Order is the order they were picked, which is the order they reach the page.

  function isPicked(rel) {
    if (!state) return false;
    for (var i = 0; i < state.selected.length; i++) {
      if (state.selected[i].path === rel) return true;
    }
    return false;
  }

  function pick(entry, on) {
    if (!state) return;
    var want = (on === undefined) ? !isPicked(entry.path) : !!on;
    var next = [];
    for (var i = 0; i < state.selected.length; i++) {
      if (state.selected[i].path !== entry.path) next.push(state.selected[i]);
    }
    if (want) next.push({ path: entry.path, name: entry.name, size: entry.size, type: entry.type });
    state.selected = next;
    syncSelection();
  }

  function clearSelection() {
    if (!state) return;
    state.selected = [];
    syncSelection();
  }

  /** Paint the selected rows and the footer, without rebuilding the tree. */
  function syncSelection() {
    if (!state) return;
    var els = state.els;
    var rows = els.list.querySelectorAll('li.wfm-file, li.wfm-dir');
    for (var i = 0; i < rows.length; i++) {
      var li = rows[i];
      var on = isPicked(li.getAttribute('data-path'));
      var isDir = li.getAttribute('data-type') === 'dir';
      var isSys = isDir && li.getAttribute('data-system') === 'true';
      li.className = isDir ? ('wfm-dir' + (isSys ? ' wfm-sys' : '') + (on ? ' sel' : '')) : ('wfm-file' + (on ? ' sel' : ''));
      li.setAttribute('aria-selected', on ? 'true' : 'false');
      var box = li.querySelector('.wfm-check');
      if (box) box.checked = on;
    }
    var n = state.selected.length;
    els.select.disabled = n === 0;
    els.select.textContent = n > 1
      ? t('wfm.selectN', 'Select') + ' (' + n + ')'
      : t('wfm.select', 'Select');
    els.count.textContent = n
      ? (n === 1 ? t('wfm.oneSelected', '1 selected')
                 : String(n) + ' ' + t('wfm.nSelected', 'selected'))
      : '';
    els.clear.hidden = n === 0;
    els.foot.classList.toggle('has-sel', n > 0);
    // The drawer may be built without the batch buttons (a caller that supplies
    // its own footer); guard every lookup so the tree keeps working regardless.
    if (els.compressSel) els.compressSel.hidden = n === 0;
    if (els.moveSel) els.moveSel.hidden = n === 0;
    if (els.copySel) els.copySel.hidden = n === 0;
    // Select is the hand-over to a page; a single-file page takes exactly one.
    // Said on the button before it is pressed, and again in the note if it is.
    els.select.title = (n > 1 && !state.multiple)
      ? t('wfm.oneOnly', 'The page takes ONE file; pick just one to send.')
      : t('wfm.selectTitle', 'Hand the selected file(s) to the page');
  }

  // ── Reading the tree ───────────────────────────────────────────────────

  /**
   * Fetch one folder's listing. Cached in `state.folders` so re-rendering the
   * tree (which happens on every expand) costs nothing.
   */
  function fetchFolder(rel, force) {
    if (!state) return Promise.resolve(null);
    var key = rel || '';
    if (!force && state.folders[key]) return Promise.resolve(state.folders[key]);
    if (state.loading[key]) return state.loading[key];
    var s = state;
    var p = call(base() + '?path=' + encodeURIComponent(key))
      .then(function (d) {
        if (state !== s) return null;
        delete s.loading[key];
        s.folders[key] = d.entries || [];
        return s.folders[key];
      })
      .catch(function (e) {
        if (state !== s) return null;
        delete s.loading[key];
        say((e && e.message) || t('wfm.loadFailed', 'Could not read the workflow files.'), true);
        // An empty array, not a missing key: the row then says "empty" rather
        // than spinning for a listing that is never coming.
        s.folders[key] = s.folders[key] || [];
        return s.folders[key];
      });
    state.loading[key] = p;
    return p;
  }

  /** Open a folder (fetching it if needed) and redraw. */
  function expand(rel) {
    if (!state) return Promise.resolve();
    state.open[rel || ''] = true;
    render();
    return fetchFolder(rel).then(function () { render(); });
  }

  function collapse(rel) {
    if (!state) return;
    delete state.open[rel || ''];
    render();
  }

  function toggleFolder(rel) {
    if (state && state.open[rel || '']) collapse(rel);
    else void expand(rel);
  }

  /**
   * Re-read every folder that is currently open, keeping the shape of the tree
   * and the selection. This is what Refresh does, and what every mutation does
   * afterwards, so a rename never collapses the branch it happened in.
   */
  function refresh() {
    if (!state) return Promise.resolve();
    var s = state;
    var keys = Object.keys(state.open);
    say('', false);
    return keys.reduce(function (chain, k) {
      return chain.then(function () { return fetchFolder(k, true); });
    }, Promise.resolve()).then(function () {
      if (state !== s) return;
      // A file that was deleted elsewhere must not stay selected: the /use
      // would fail with a 404 the operator cannot explain.
      var live = {};
      Object.keys(s.folders).forEach(function (k) {
        (s.folders[k] || []).forEach(function (e) { live[e.path] = e.type; });
      });
      s.selected = s.selected.filter(function (x) { return live[x.path] === 'file' || live[x.path] === 'dir'; });
      render();
    });
  }

  // ── Drawing the tree ───────────────────────────────────────────────────

  /**
   * One row.
   *
   * Structure mirrors upload-ui/: a checkbox that only appears on hover or
   * when picked, a chevron for folders, the type glyph, the name, and the
   * meta on the far end (item count for a folder, size for a file). Depth is
   * an inline padding rather than nested <ul>s, because a flat list is what
   * lets one querySelectorAll repaint the whole selection.
   */
  function row(entry, depth) {
    var isDir = entry.type === 'dir';
    var isSys = isDir && !!entry.system;
    var li = document.createElement('li');
    li.className = isDir ? ('wfm-dir' + (isSys ? ' wfm-sys' : '')) : 'wfm-file';
    li.setAttribute('role', isDir ? 'treeitem' : 'option');
    li.setAttribute('data-path', entry.path);
    li.setAttribute('data-type', entry.type);
    li.setAttribute('data-size', String(entry.size || 0));
    if (isSys) li.setAttribute('data-system', 'true');
    li.style.setProperty('--wfm-depth', String(depth));

    if (isDir) {
      li.setAttribute('aria-expanded', state.open[entry.path] ? 'true' : 'false');
      var chev = document.createElement('button');
      chev.type = 'button';
      chev.className = 'wfm-chev';
      chev.tabIndex = -1;
      chev.setAttribute('aria-label', t('wfm.expand', 'Expand or collapse'));
      chev.innerHTML = BIC(state.open[entry.path] ? 'chevron-down' : 'chevron-right', 13);
      chev.addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleFolder(entry.path);
      });
      li.appendChild(chev);

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'wfm-check';
      box.checked = isPicked(entry.path);
      box.setAttribute('aria-label', t('wfm.pickFolder', 'Select this folder'));
      box.addEventListener('click', function (ev) { ev.stopPropagation(); });
      box.addEventListener('change', function () { pick(entry, box.checked); });
      li.appendChild(box);
    } else {
      // The checkbox is the multi-select affordance from the reference UI. It
      // exists for a single-file input too, where it behaves as a radio.
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'wfm-check';
      box.checked = isPicked(entry.path);
      box.setAttribute('aria-label', t('wfm.pick', 'Select this file'));
      box.addEventListener('click', function (ev) { ev.stopPropagation(); });
      box.addEventListener('change', function () { pick(entry, box.checked); });
      li.appendChild(box);
    }

    var ico = document.createElement('span');
    ico.className = 'wfm-ico';
    ico.innerHTML = BIC(isDir ? 'folder' : fileIcon(entry.name), 15);
    li.appendChild(ico);

    var name = document.createElement('span');
    name.className = 'wfm-name';
    // textContent, never markup: the name came from a shared filesystem.
    name.textContent = entry.name;
    li.appendChild(name);

    if (isSys) {
      // Part of the workflow, not the operator's own: drawn apart so nobody
      // wonders why Rename is missing from its menu.
      var tag = document.createElement('span');
      tag.className = 'wfm-sys-tag';
      var isIn = entry.name === UPLOADS_FOLDER;
      tag.textContent = isIn ? t('wfm.sysInput', 'input') : t('wfm.sysOutput', 'output');
      tag.title = isIn
        ? t('wfm.sysInputHint', 'Files here are what a page\u2019s file input is answered with, and where Upload from Computer keeps its copy.')
        : t('wfm.sysOutputHint', 'Files the browser downloads while working for this workflow are filed here.');
      li.appendChild(tag);
    }

    var meta = document.createElement('span');
    meta.className = 'wfm-meta';
    if (isDir) {
      var kids = state.folders[entry.path];
      meta.textContent = kids
        ? (kids.length === 1 ? '1 ' + t('wfm.item', 'item')
                             : String(kids.length) + ' ' + t('wfm.items', 'items'))
        : '';
    } else {
      meta.textContent = humanSize(entry.size);
    }
    li.appendChild(meta);

    // Overflow: the same actions as the context menu, for a pointer that has
    // no right button (a touch screen) and for discoverability.
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'wfm-more';
    more.tabIndex = -1;
    more.setAttribute('aria-label', t('wfm.actions', 'Actions'));
    more.innerHTML = BIC('more-horizontal', 14);
    more.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var r = more.getBoundingClientRect ? more.getBoundingClientRect() : { left: 0, bottom: 0 };
      openMenu(entry, r.left, r.bottom);
    });
    li.appendChild(more);

    li.addEventListener('click', function () {
      if (isDir) { toggleFolder(entry.path); return; }
      // Only FILES can be selected: a folder cannot go into an input.
      pick(entry);
    });
    li.addEventListener('dblclick', function () {
      // A folder opens INTO (the breadcrumb takes it), a file is handed over.
      if (isDir) { void goTo(entry.path); return; }
      pick(entry, true);
      use();
    });
    li.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(entry, ev.clientX, ev.clientY);
    });
    return li;
  }

  /** A placeholder row: "empty", or "loading", inside an expanded folder. */
  function hintRow(text, depth) {
    var li = document.createElement('li');
    li.className = 'wfm-hint';
    li.style.setProperty('--wfm-depth', String(depth));
    li.textContent = text;
    return li;
  }

  /** Depth-first walk of the open folders, folders before files at each level. */
  function paint(rel, depth, into) {
    var entries = state.folders[rel || ''];
    if (!entries) {
      into.appendChild(hintRow(t('wfm.loading', 'Loading\u2026'), depth));
      return;
    }
    if (!entries.length) {
      into.appendChild(hintRow(
        depth === 0
          ? t('wfm.empty', 'This folder is empty. Upload a file or create a folder.')
          : t('wfm.emptyFolder', 'Empty'),
        depth,
      ));
      return;
    }
    var dirs = entries.filter(function (e) { return e.type === 'dir'; });
    var files = entries.filter(function (e) { return e.type !== 'dir'; });
    var here = rel || '';
    dirs.concat(files).forEach(function (e) {
      into.appendChild(row(e, depth));
      // Descend only into a child whose path really is BELOW this folder. A
      // listing that named a child with its parent's own path (a misbehaving
      // server, or a test fake) would otherwise recurse until the stack ran
      // out -- a tree that cannot be drawn is worse than one row too few.
      var below = !here || (e.path && e.path.indexOf(here + '/') === 0);
      if (e.type === 'dir' && below && e.path !== here && state.open[e.path]) paint(e.path, depth + 1, into);
    });
  }

  function render() {
    if (!state) return;
    var els = state.els;
    els.list.textContent = '';
    renderCrumbs();
    paint(state.root, 0, els.list);
    var entries = state.folders[state.root];
    var total = (entries || []).length;
    els.total.textContent = !entries ? '' : (total
      ? (total === 1 ? '1 ' + t('wfm.item', 'item')
                     : String(total) + ' ' + t('wfm.items', 'items'))
      : t('wfm.noItems', 'empty'));
    syncSelection();
  }

  // ── Navigation ─────────────────────────────────────────────────────────
  //
  // `state.root` is where the tree is ROOTED: '' is the workspace, otherwise
  // a folder the operator went into (double-click, or Open in the menu). The
  // breadcrumb above the list names it and is the way back. The chevron on a
  // row still expands in place, because a shallow folder is quicker that way
  // and a deep one needs the other.

  /** Root the tree at `rel` ('' = the workspace) and read it. */
  function goTo(rel) {
    if (!state) return Promise.resolve();
    var s = state;
    s.root = rel || '';
    s.open[s.root] = true;
    closeMenu();
    render();
    return fetchFolder(s.root).then(function () { if (state === s) render(); });
  }

  /** One level up -- the Back arrow. */
  function goBack() {
    if (!state || !state.root) return Promise.resolve();
    return goTo(parentOf(state.root));
  }

  /** One crumb: a button to `rel`; the last one is where we are. */
  function crumb(label, rel, current) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wfm-crumb' + (current ? ' on' : '');
    b.textContent = label;
    b.setAttribute('data-rel', rel);
    if (current) b.setAttribute('aria-current', 'location');
    else b.addEventListener('click', function (ev) { ev.stopPropagation(); void goTo(rel); });
    return b;
  }

  /** Draw the breadcrumb for state.root: Back, the workspace, every folder. */
  function renderCrumbs() {
    if (!state || !state.els.crumbs) return;
    var host = state.els.crumbs;
    host.textContent = '';
    var segs = state.root ? state.root.split('/') : [];
    if (segs.length) {
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'wfm-crumb wfm-back';
      back.title = t('wfm.back', 'Back');
      back.setAttribute('aria-label', t('wfm.back', 'Back'));
      back.innerHTML = BIC('arrow-left', 13);
      back.addEventListener('click', function (ev) { ev.stopPropagation(); void goBack(); });
      host.appendChild(back);
    }
    host.appendChild(crumb(t('wfm.rootCrumb', 'Workflow'), '', !segs.length));
    var acc = '';
    segs.forEach(function (seg, i) {
      acc = acc ? acc + '/' + seg : seg;
      var sep = document.createElement('span');
      sep.className = 'wfm-crumb-sep';
      sep.textContent = '/';
      host.appendChild(sep);
      host.appendChild(crumb(seg, acc, i === segs.length - 1));
    });
  }

  /**
   * Where the toolbar's Upload goes: the folder on screen, or -- at the
   * workspace root -- `uploads/`, because that is the folder the contract says
   * staged input lives in. A file dropped in the root would still hand over,
   * but would not be where a node looking for inputs expects it.
   */
  function uploadTarget() {
    return (state && state.root) || UPLOADS_FOLDER;
  }

  // ── Mutations ──────────────────────────────────────────────────────────
  //
  // Every one names a workflow-RELATIVE path the server itself returned, and
  // every one ends in refresh(), so what is on screen is what is on the disk
  // and not an optimistic guess that can drift.

  /** The folder a "new ..." or "upload here" acts in, given the clicked row. */
  function folderFor(entry) {
    if (!entry) return '';
    return entry.type === 'dir' ? entry.path : parentOf(entry.path);
  }

  function newFolder(inRel) {
    var name = ask(t('wfm.newFolderPrompt', 'New folder name:'), '');
    if (!name) return;
    var s = state;
    var into = inRel || '';
    call(base() + '/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: into, name: name })
    })
      .then(function () {
        if (state !== s) return;
        // The new folder is inside `into`, so `into` has to be open for it to
        // be visible at all — otherwise the operator sees nothing happen.
        s.open[into] = true;
        return refresh();
      })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.mkdirFailed', 'Could not create the folder.'), true); });
  }

  /**
   * Create an EMPTY file, through the endpoint made for it (POST /file).
   *
   * This used to be a one-byte upload, because the storage refuses a
   * zero-byte upload (an empty upload is almost always a failed transfer).
   * That was a workaround: the operator asked for an empty file and got a
   * newline.
   */
  function newFile(inRel) {
    var name = ask(t('wfm.newFilePrompt', 'New file name:'), 'untitled.txt');
    if (!name) return;
    var s = state;
    var into = inRel || '';
    call(base() + '/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: into, name: name })
    })
      .then(function () {
        if (state !== s) return;
        s.open[into] = true;
        return refresh();
      })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.newFileFailed', 'Could not create the file.'), true); });
  }

  /**
   * Rename IN PLACE, in the row itself.
   *
   * The reference UI edits the name where it stands rather than in a dialog,
   * which is also the only way to see the name next to its siblings while
   * choosing a new one. Enter commits, Escape and blur cancel.
   */
  function renameEntry(entry) {
    if (!state) return;
    if (entry.system) {
      say(t('wfm.systemLocked', 'This folder is part of the workflow and cannot be renamed or deleted.'), true);
      return;
    }
    var li = state.els.list.querySelector('li[data-path="' + cssEscape(entry.path) + '"]');
    var nameEl = li ? li.querySelector('.wfm-name') : null;
    if (!li || !nameEl) {
      // No row on screen (a stale menu): fall back to a prompt rather than
      // silently doing nothing.
      var typed = ask(t('wfm.renamePrompt', 'Rename to:'), entry.name);
      if (typed && typed !== entry.name) commitRename(entry, typed);
      return;
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'wfm-rename';
    input.value = entry.name;
    input.setAttribute('aria-label', t('wfm.renamePrompt', 'Rename to:'));
    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var next = String(input.value || '').trim();
      if (input.parentNode) input.parentNode.replaceChild(nameEl, input);
      if (commit && next && next !== entry.name) commitRename(entry, next);
    }
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
    li.replaceChild(input, nameEl);
    try { input.focus(); input.select(); } catch (e) { /* not focusable in the harness */ }
  }

  function commitRename(entry, name) {
    var s = state;
    call(base() + '/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path, name: name })
    })
      .then(function () {
        if (state !== s) return;
        // The path changed, so a selection or an expanded state keyed on the
        // OLD path is stale. Drop just that one rather than everything.
        s.selected = s.selected.filter(function (x) { return x.path !== entry.path; });
        if (s.open[entry.path]) {
          delete s.open[entry.path];
          var parent = parentOf(entry.path);
          s.open[parent] = true;
        }
        return refresh();
      })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.renameFailed', 'Could not rename.'), true); });
  }

  /**
   * Delete, behind an in-drawer confirmation.
   *
   * NOT window.confirm: this drawer floats over a remote browser stage, and a
   * native dialog there steals focus from the page that is waiting for a file.
   * The confirm is a strip in the drawer's own footer, so the name being
   * deleted and the button that deletes it are in the same place.
   */
  function deleteEntry(entry) {
    if (entry.system) {
      say(t('wfm.systemLocked', 'This folder is part of the workflow and cannot be renamed or deleted.'), true);
      return;
    }
    var isDir = entry.type === 'dir';
    confirmStrip(
      (isDir ? t('wfm.deleteFolderAsk', 'Delete this folder and everything inside it?')
             : t('wfm.deleteFileAsk', 'Delete this file?')) + ' ' + entry.name,
      function () {
        var s = state;
        call(base() + '?path=' + encodeURIComponent(entry.path) + (isDir ? '&recursive=1' : ''), { method: 'DELETE' })
          .then(function () {
            if (state !== s) return;
            s.selected = s.selected.filter(function (x) { return x.path !== entry.path; });
            delete s.open[entry.path];
            delete s.folders[entry.path];
            return refresh();
          })
          .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.deleteFailed', 'Could not delete.'), true); });
      },
    );
  }

  /** Delete every picked file, behind one confirmation naming the count. */
  function deleteSelected() {
    if (!state || !state.selected.length) return;
    var victims = state.selected.slice();
    confirmStrip(
      t('wfm.deleteManyAsk', 'Delete the selected files?') + ' (' + victims.length + ')',
      function () {
        var s = state;
        setBusy(true, t('wfm.delete', 'Delete') + '\u2026');
        victims.reduce(function (chain, v) {
          return chain.then(function () {
            return call(base() + '?path=' + encodeURIComponent(v.path), { method: 'DELETE' })
              .catch(function (e) { say((e && e.message) || t('wfm.deleteFailed', 'Could not delete.'), true); });
          });
        }, Promise.resolve()).then(function () {
          if (state !== s) return;
          s.selected = [];
          setBusy(false);
          return refresh();
        }).catch(function () {
          if (state === s) setBusy(false);
        });
      },
    );
  }

  // ── Organise: Move / Copy / Duplicate, and Archive: Compress / Extract ──
  //
  // Every one names workflow-RELATIVE paths the server itself returned, and
  // every one leaves the workspace's own tree as the single source of truth by
  // ending in refresh(). The DESTINATION is typed by the operator as a
  // workflow-relative folder path — the server normalises it and refuses
  // anything that is not a plain relative path inside the same workflow, so
  // nothing here ever names an absolute location, and a move/copy is a real
  // server-side filesystem operation, never a download + re-upload.
  //
  // A taken name is never overwritten: the server answers 409 (move/extract)
  // or numbers the copy, and the sentence it sends is shown verbatim.

  /** The operator's typed destination folder, reduced to a relative path. */
  function destInput(v) {
    return String(v == null ? '' : v).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  }

  /** POST /move for a set of paths into a typed folder. */
  function movePaths(paths) {
    if (!state || !paths.length) return Promise.resolve();
    var to = ask(t('wfm.movePrompt', 'Destination folder (relative to the workspace):'), state.root || '');
    if (to === null) return Promise.resolve();
    var s = state;
    setBusy(true, t('wfm.moving', 'Moving\u2026'));
    return call(base() + '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: paths, to: destInput(to) })
    })
      .then(function (d) {
        if (state !== s) return;
        // The paths changed, so any selection keyed on them is stale.
        s.selected = [];
        setBusy(false, t('wfm.moveDone', 'Moved:') + ' ' + ((d && d.count) || paths.length));
        return refresh();
      })
      .catch(function (e) {
        if (state === s) {
          setBusy(false);
          say((e && e.message) || t('wfm.moveFailed', 'Could not move.'), true);
        }
      });
  }

  /** POST /copy for a set of paths into a typed folder. */
  function copyPaths(paths, style) {
    if (!state || !paths.length) return Promise.resolve();
    var to = ask(t('wfm.copyPrompt', 'Destination folder to copy into (relative to the workspace):'), state.root || '');
    if (to === null) return Promise.resolve();
    var s = state;
    setBusy(true, t('wfm.copying', 'Copying\u2026'));
    return call(base() + '/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: paths, to: destInput(to), style: style || 'numbered' })
    })
      .then(function (d) {
        if (state !== s) return;
        s.selected = [];
        setBusy(false, t('wfm.copyDone', 'Copied:') + ' ' + ((d && d.count) || paths.length));
        return refresh();
      })
      .catch(function (e) {
        if (state === s) {
          setBusy(false);
          say((e && e.message) || t('wfm.copyFailed', 'Could not copy.'), true);
        }
      });
  }

  /** POST /duplicate for ONE entry — `config.json` -> `config copy.json`. */
  function duplicateEntry(entry) {
    if (!state) return Promise.resolve();
    var s = state;
    setBusy(true, t('wfm.copying', 'Copying\u2026'));
    return call(base() + '/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path })
    })
      .then(function (d) {
        if (state !== s) return;
        setBusy(false, t('wfm.duplicated', 'Duplicated:') + ' ' + ((d && d.entry && d.entry.name) || ''));
        return refresh();
      })
      .catch(function (e) {
        if (state === s) {
          setBusy(false);
          say((e && e.message) || t('wfm.duplicateFailed', 'Could not duplicate.'), true);
        }
      });
  }

  /** POST /compress: the selection -> ONE .zip created in the highest branch of the selection. */
  function compressPaths(paths) {
    if (!state || !paths.length) return Promise.resolve();
    var destDir = computeHighestBranch(paths);
    var defaultName = '';
    if (paths.length === 1) {
      var fileName = paths[0].split('/').pop();
      defaultName = fileName.replace(/\.[^.]+$/, '') + '.zip';
    } else {
      var leaf = destDir ? destDir.split('/').pop() : (state.root ? state.root.split('/').pop() : state.workflowId);
      defaultName = (leaf || 'archive') + '.zip';
    }
    var name = ask(t('wfm.compressPrompt', 'Archive name:'), defaultName);
    if (!name) return Promise.resolve();
    var s = state;
    setBusy(true, t('wfm.compressing', 'Building the archive\u2026'));
    return call(base() + '/compress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: paths, path: destDir, name: name, to: destDir })
    })
      .then(function (d) {
        if (state !== s) return;
        s.selected = [];
        setBusy(false, t('wfm.compressDone', 'Archive created:') + ' ' + ((d && d.entry && d.entry.name) || name));
        return refresh();
      })
      .catch(function (e) {
        if (state === s) {
          setBusy(false);
          say((e && e.message) || t('wfm.compressFailed', 'Could not compress.'), true);
        }
      });
  }

  /** POST /extract: unpack ONE .zip, beside itself or into a new folder. */
  function extractEntry(entry, mode) {
    if (!state) return Promise.resolve();
    var s = state;
    setBusy(true, t('wfm.extracting', 'Extracting\u2026'));
    return call(base() + '/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path, mode: mode })
    })
      .then(function (d) {
        if (state !== s) return;
        s.selected = [];
        setBusy(false, t('wfm.extractDone', 'Extracted:') + ' ' + ((d && d.folder) || ''));
        return refresh();
      })
      .catch(function (e) {
        if (state === s) {
          setBusy(false);
          say((e && e.message) || t('wfm.extractFailed', 'Could not extract.'), true);
        }
      });
  }

  /** Is this a `.zip`, the only archive format this pass supports? */
  function isZipName(name) {
    return /\.zip$/i.test(String(name || '').trim());
  }

  /** The paths of the current selection, in the order they were picked. */
  function selectedPaths() {
    if (!state) return [];
    return state.selected.map(function (c) { return c.path; });
  }

  /**
   * Details for ONE entry: name, kind, size, modified, and its workflow-relative
   * path. Shown in the drawer's own note line — never a native dialog, which
   * would steal focus from the page waiting behind the remote stage — and never
   * an absolute location, which this client is not given.
   */
  function showDetails(entry) {
    if (!state) return;
    var kind = entry.type === 'dir' ? t('wfm.folderKind', 'Folder') : t('wfm.fileKind', 'File');
    var parts = [entry.name, kind];
    if (entry.type !== 'dir') parts.push(humanSize(entry.size) || '0 B');
    if (entry.modifiedAt) {
      var when = new Date(entry.modifiedAt);
      if (!isNaN(when.getTime())) parts.push(when.toLocaleString());
    }
    parts.push(entry.path);
    say(parts.join('  ·  '), false);
  }

  // ── Download: the operator's own copy ──────────────────────────────────
  //
  // One file is served as itself; a folder, the workspace, or a picked SET
  // is ONE .zip the server streams (GET/POST .../download). The bytes are
  // fetched with the key in a HEADER and saved through a Blob + <a download>,
  // so the key never lands in a URL or the download history, and a refusal
  // is shown in the server's own words rather than Chrome's generic "Failed".

  function nameFromDisposition(h) {
    var v = String(h || '');
    var star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(v);
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch (e) { /* fall through */ } }
    var plain = /filename\s*=\s*"?([^";]+)"?/.exec(v);
    return plain ? plain[1].trim() : '';
  }

  function saveBlob(blob, name) {
    var href = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = href;
    a.download = name || 'download';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(href); } catch (e) { /* fine */ } }, 60000);
  }

  /** Fetch a download URL and hand the bytes to the operator's browser. */
  function saveFrom(path, init, fallbackName) {
    if (!state) return Promise.resolve();
    var s = state;
    var o = init || {};
    return fetch(path, {
      method: o.method || 'GET',
      headers: apiHeaders(o.headers || {}),
      body: o.body,
      credentials: 'same-origin'
    })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (txt) {
            var d = null;
            try { d = JSON.parse(txt); } catch (e) { /* not JSON */ }
            throw new Error((d && d.error) || (t('wfm.downloadFailed', 'The download failed.') + ' (HTTP ' + r.status + ')'));
          });
        }
        var want = nameFromDisposition(r.headers.get('content-disposition')) || fallbackName || 'download';
        return r.blob().then(function (blob) { saveBlob(blob, want); return want; });
      })
      .then(function (name) { if (state === s) say(t('wfm.downloaded', 'Downloaded:') + ' ' + name, false); })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.downloadFailed', 'The download failed.'), true); });
  }

  /** Download ONE entry: a file as itself, a folder as <name>.zip. */
  function downloadEntry(entry) {
    if (!state) return Promise.resolve();
    var isDir = entry.type === 'dir';
    say((isDir ? t('wfm.zipping', 'Zipping\u2026') : t('wfm.fetching', 'Fetching\u2026')) + ' ' + entry.name, false);
    return saveFrom(base() + '/download?path=' + encodeURIComponent(entry.path), { method: 'GET' },
      isDir ? entry.name + '.zip' : entry.name);
  }

  /** Download the whole workspace as <workflowId>.zip. */
  function downloadAll() {
    if (!state) return Promise.resolve();
    say(t('wfm.zipping', 'Zipping\u2026'), false);
    return saveFrom(base() + '/download', { method: 'GET' }, state.workflowId + '.zip');
  }

  /** Download every picked file: one as itself, several as one zip. */
  function downloadSelected() {
    if (!state || !state.selected.length) return Promise.resolve();
    var chosen = state.selected.slice();
    if (chosen.length === 1) return downloadEntry({ path: chosen[0].path, name: chosen[0].name, type: 'file' });
    var leaf = state.root ? state.root.split('/').pop() : state.workflowId;
    say(t('wfm.zipping', 'Zipping\u2026') + ' (' + chosen.length + ')', false);
    return saveFrom(base() + '/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: chosen.map(function (c) { return c.path; }), path: state.root })
    }, leaf + '.zip');
  }

  /**
   * Upload from the operator's computer INTO a named folder.
   *
   * `state.uploadInto` is set by whichever control started the picker, so
   * "Upload Here" on a folder lands in that folder and the toolbar's own
   * Upload lands in the root — the reference UI's `uploadTargetOverride`.
   */
  function uploadFiles(list) {
    if (!list.length || !state) return Promise.resolve();
    var s = state;
    var into = state.uploadInto || '';
    state.uploadInto = '';
    setBusy(true, t('wfm.uploading', 'Uploading\u2026'));
    return list.reduce(function (chain, file) {
      return chain.then(function () {
        return call(
          base() + '/upload?path=' + encodeURIComponent(into) + '&name=' + encodeURIComponent(file.name || 'file'),
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }
        );
      });
    }, Promise.resolve())
      .then(function () {
        if (state !== s) return;
        s.open[into] = true;
        setBusy(false, t('wfm.uploaded', 'Uploaded.'));
        return refresh();
      })
      .catch(function (e) {
        if (state !== s) return;
        setBusy(false);
        say((e && e.message) || t('wfm.uploadFailed', 'The upload failed.'), true);
        return refresh();
      });
  }

  /** Start the operator's own native picker, targeting `into`. */
  function askForUpload(into) {
    if (!state) return;
    state.uploadInto = into || '';
    try { state.els.input.click(); } catch (e) { /* nothing to do */ }
  }

  // ── The context menu ───────────────────────────────────────────────────
  //
  // ONE floating menu, positioned at the pointer, replaced rather than
  // stacked — the same rule the picker's Alert follows. It is a child of the
  // DRAWER, not of document.body, so it inherits the drawer's stacking
  // context and cannot outlive it.

  var menu = null;

  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }

  /** An escape for the one attribute selector this module builds. */
  function cssEscape(s) {
    return String(s == null ? '' : s).replace(/["\\]/g, '\\$&');
  }

  function menuItem(into, label, icon, fn, danger) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wfm-mi' + (danger ? ' danger' : '');
    var i = document.createElement('span');
    i.className = 'wfm-mi-ico';
    i.innerHTML = BIC(icon, 14);
    b.appendChild(i);
    var s = document.createElement('span');
    s.textContent = label;
    b.appendChild(s);
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeMenu();
      fn();
    });
    into.appendChild(b);
    return b;
  }

  function menuSep(into) {
    var d = document.createElement('div');
    d.className = 'wfm-mi-sep';
    into.appendChild(d);
  }

  /**
   * The menu for a row, or for the empty space when `entry` is null.
   *
   *   Folder: Open · New File · New Folder · Upload Here · Download (.zip)
   *           · Compress · Move · Copy · Rename · Delete
   *   System: Open · New File · New Folder · Upload Here · Download (.zip)
   *           · Compress                                (uploads/, downloads/)
   *   File:   Select · Download · Compress · Move · Copy · Duplicate · Extract (.zip)
   *           · Rename · Delete · Details
   *   Root:   New Folder · New File · Upload File · Select All
   *           · Download workspace · Compress · Refresh
   *
   * "Open" on a folder roots the tree THERE (the breadcrumb is the way back);
   * the chevron on the row expands it in place instead.
   *
   * "Open / Preview" is deliberately NOT offered for a file: this client has
   * no viewer, and a menu entry that does nothing is worse than one that is
   * absent. Extract is offered only for a `.zip` — the one format this pass
   * supports.
   */
  function openMenu(entry, x, y) {
    if (!state) return;
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'wfm-menu';
    menu.setAttribute('role', 'menu');

    if (!entry) {
      // The empty space acts on the folder on SCREEN, not always the root.
      menuItem(menu, t('wfm.newFolder', 'New Folder'), 'folder-plus', function () { newFolder(state.root); });
      menuItem(menu, t('wfm.newFile', 'New File'), 'file-plus', function () { newFile(state.root); });
      menuItem(menu, t('wfm.upload', 'Upload File'), 'upload', function () { askForUpload(uploadTarget()); });
      menuSep(menu);
      menuItem(menu, t('wfm.selectAll', 'Select All'), 'square-check', function () { selectAllVisible(); });
      menuItem(menu, state.root ? t('wfm.downloadFolder', 'Download this folder') : t('wfm.downloadAll', 'Download workspace (.zip)'),
        'download', function () {
          void (state.root ? downloadEntry({ path: state.root, name: state.root.split('/').pop(), type: 'dir' }) : downloadAll());
        });
      menuSep(menu);
      menuItem(menu, t('wfm.refresh', 'Refresh'), 'rotate-cw', function () { void refresh(); });
    } else if (entry.type === 'dir') {
      menuItem(menu, t('wfm.open', 'Open'), 'folder-open', function () { void goTo(entry.path); });
      menuSep(menu);
      menuItem(menu, t('wfm.newFile', 'New File'), 'file-plus', function () { newFile(entry.path); });
      menuItem(menu, t('wfm.newFolder', 'New Folder'), 'folder-plus', function () { newFolder(entry.path); });
      menuItem(menu, t('wfm.uploadHere', 'Upload Here'), 'upload', function () { askForUpload(entry.path); });
      menuSep(menu);
      menuItem(menu, t('wfm.downloadZip', 'Download (.zip)'), 'download', function () { void downloadEntry(entry); });
      if (!entry.system) {
        // uploads/ and downloads/ are part of the workflow: no Rename, no Delete.
        menuItem(menu, t('wfm.rename', 'Rename'), 'pencil', function () { renameEntry(entry); });
        menuItem(menu, t('wfm.delete', 'Delete'), 'trash', function () { deleteEntry(entry); }, true);
      }
      menuSep(menu);
      menuItem(menu, t('wfm.compress', 'Compress (.zip)'), 'layers', function () {
        var p = isPicked(entry.path) && selectedPaths().length > 1 ? selectedPaths() : [entry.path];
        void compressPaths(p);
      });
      if (!entry.system) {
        menuItem(menu, t('wfm.move', 'Move'), 'move', function () {
          var p = isPicked(entry.path) && selectedPaths().length > 1 ? selectedPaths() : [entry.path];
          void movePaths(p);
        });
        menuItem(menu, t('wfm.copy', 'Copy'), 'copy', function () {
          var p = isPicked(entry.path) && selectedPaths().length > 1 ? selectedPaths() : [entry.path];
          void copyPaths(p);
        });
      }
    } else {
      menuItem(menu, t('wfm.pick', 'Select'), 'check', function () { pick(entry, true); });
      menuItem(menu, t('wfm.download', 'Download'), 'download', function () { void downloadEntry(entry); });
      menuSep(menu);
      menuItem(menu, t('wfm.compress', 'Compress (.zip)'), 'layers', function () {
        var p = isPicked(entry.path) && selectedPaths().length > 1 ? selectedPaths() : [entry.path];
        void compressPaths(p);
      });
      menuItem(menu, t('wfm.move', 'Move'), 'move', function () {
        var p = isPicked(entry.path) && selectedPaths().length > 1 ? selectedPaths() : [entry.path];
        void movePaths(p);
      });
      menuItem(menu, t('wfm.copy', 'Copy'), 'copy', function () {
        var p = isPicked(entry.path) && selectedPaths().length > 1 ? selectedPaths() : [entry.path];
        void copyPaths(p);
      });
      menuItem(menu, t('wfm.duplicate', 'Duplicate'), 'copy', function () { void duplicateEntry(entry); });
      if (isZipName(entry.name)) {
        menuItem(menu, t('wfm.extractHere', 'Extract here'), 'extract', function () { void extractEntry(entry, 'here'); });
        menuItem(menu, t('wfm.extractFolder', 'Extract to new folder'), 'folder-open', function () { void extractEntry(entry, 'folder'); });
      }
      menuSep(menu);
      menuItem(menu, t('wfm.rename', 'Rename'), 'pencil', function () { renameEntry(entry); });
      menuItem(menu, t('wfm.delete', 'Delete'), 'trash', function () { deleteEntry(entry); }, true);
      menuItem(menu, t('wfm.details', 'Details'), 'info', function () { showDetails(entry); });
    }

    // Positioned relative to the DRAWER, so the menu travels with it and stays
    // inside it however the surface below is scrolled.
    var host = state.els.root;
    var box = host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0, width: 320, height: 480 };
    var left = Math.max(4, Math.min((x || 0) - box.left, Math.max(4, box.width - 200)));
    var top = Math.max(4, Math.min((y || 0) - box.top, Math.max(4, box.height - 40)));
    menu.style.insetInlineStart = left + 'px';
    menu.style.top = top + 'px';
    host.appendChild(menu);
  }

  // ── The confirmation strip ─────────────────────────────────────────────

  /**
   * Ask, in the drawer, with the name of the thing on screen. Replaces any
   * strip already up, so two Deletes in a row cannot leave two questions
   * queued against each other.
   */
  function confirmStrip(question, onYes) {
    if (!state) return;
    var host = state.els.confirm;
    host.textContent = '';
    host.hidden = false;
    var text = document.createElement('span');
    text.className = 'wfm-confirm-text';
    text.textContent = question;
    host.appendChild(text);
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-ghost btn-sm';
    no.textContent = t('wfm.cancel', 'Cancel');
    no.addEventListener('click', function () { host.hidden = true; host.textContent = ''; });
    host.appendChild(no);
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn-sm wfm-confirm-yes';
    yes.textContent = t('wfm.confirmDelete', 'Delete');
    yes.addEventListener('click', function () {
      host.hidden = true;
      host.textContent = '';
      onYes();
    });
    host.appendChild(yes);
  }

  // ── Handing the files over ─────────────────────────────────────────────

  /**
   * Hand the selected workflow file(s) to the page that is asking.
   *
   * No `chooserId`: the canvas views' dialog belongs to the user's
   * LiveBrowserSession, which the server finds by `userId` — the SAME identity
   * the socket was opened with. The server resolves each path inside the
   * workflow root and calls FileChooser.setFiles() itself; the hand-over is
   * then confirmed to the socket as 'fileChooserDone', exactly as for tokens.
   */
  function use() {
    if (!state || !state.selected.length) return;
    var s = state;
    var chosen = s.selected.slice();
    var hasFolder = chosen.some(function (c) { return c.type === 'dir'; });
    if (hasFolder) {
      say(t('wfm.noFolderInInput', 'Folders cannot be handed to a web page file input; please select files.'), true);
      return;
    }
    if (chosen.length > 1 && !s.multiple) {
      // The server refuses this too (409); saying it here keeps the selection
      // intact for Download / Delete and costs no request.
      say(t('wfm.oneOnly', 'The page takes ONE file; pick just one to send.'), true);
      return;
    }
    if (s.opts.accept) {
      var bad = chosen.filter(function (c) { return !accepts(s.opts.accept, c.name); });
      if (bad.length) {
        say(t('rio.wrongType', 'The page only accepts') + ' ' + s.opts.accept, true);
        return;
      }
    }
    var uid = typeof s.opts.userId === 'function' ? s.opts.userId() : (s.opts.userId || '');
    s.els.select.disabled = true;
    say(t('wfm.sending', 'Sending\u2026') + ' ' + chosen.map(function (c) { return c.name; }).join(', '), false);
    // ONE request, however many files. The session answers a waiting chooser
    // once and then forgets it, so several files have to travel together:
    // `path` is the first (the only field a single pick sends, unchanged),
    // `paths` the whole list, in the order they were picked.
    var body = { path: chosen[0].path };
    if (chosen.length > 1) body.paths = chosen.map(function (c) { return c.path; });
    if (uid) body.userId = uid;
    call(base() + '/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (d) {
        if (state !== s) return;
        if (typeof s.opts.onUsed === 'function') {
          try {
            // One file: the object, as it always was. Several: the list, so a
            // caller that only ever sees one is unaffected.
            s.opts.onUsed(chosen.length === 1
              ? { name: d.name || chosen[0].name, size: d.size || chosen[0].size }
              : chosen.map(function (c) { return { name: c.name, size: c.size }; }));
          } catch (e) { /* caller's problem */ }
        }
        close('used');
      })
      .catch(function (e) {
        if (state !== s) return;
        s.els.select.disabled = false;
        say((e && e.message) || t('wfm.useFailed', 'The file could not be sent.'), true);
      });
  }

  // ── Building the drawer ────────────────────────────────────────────────

  function iconBtn(cls, icon, label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wfm-tool ' + cls;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = BIC(icon, 16);
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }

  function build(host) {
    var root = document.createElement('div');
    // `is-opening` for one frame, then removed: the drawer slides in from the
    // side it is docked to rather than appearing, which is the only cue that
    // it came from the hamburger and will go back there.
    root.className = 'wfm-drawer is-opening';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', t('wfm.title', 'Workflow Files'));

    // ── head: identity, count, select-all, close
    var head = document.createElement('div');
    head.className = 'wfm-head';
    var badge = document.createElement('span');
    badge.className = 'wfm-badge';
    badge.innerHTML = BIC('folder', 15);
    head.appendChild(badge);
    var h = document.createElement('h4');
    h.textContent = t('wfm.title', 'Workflow Files');
    head.appendChild(h);
    var total = document.createElement('span');
    total.className = 'wfm-total';
    head.appendChild(total);
    var grow = document.createElement('span');
    grow.className = 'wfm-grow';
    head.appendChild(grow);
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'wfm-selectall';
    all.innerHTML = BIC('square-check', 14) +
      '<span>' + '</span>';
    all.querySelector('span').textContent = t('wfm.selectAll', 'Select All');
    all.addEventListener('click', function (ev) {
      ev.stopPropagation();
      selectAllVisible();
    });
    head.appendChild(all);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'wfm-tool wfm-close';
    x.title = t('wfm.close', 'Close');
    x.setAttribute('aria-label', t('wfm.close', 'Close'));
    x.innerHTML = BIC('x', 15);
    x.addEventListener('click', function () { close('closed'); });
    head.appendChild(x);
    root.appendChild(head);

    // ── toolbar: the five actions from upload-ui/, icon-only
    var bar = document.createElement('div');
    bar.className = 'wfm-toolbar';
    // The toolbar acts on the folder on screen (the breadcrumb), not always the root.
    bar.appendChild(iconBtn('wfm-mkdir', 'folder-plus', t('wfm.newFolder', 'New Folder'),
      function () { newFolder(state ? state.root : ''); }));
    bar.appendChild(iconBtn('wfm-mkfile', 'file-plus', t('wfm.newFile', 'New File'),
      function () { newFile(state ? state.root : ''); }));
    bar.appendChild(iconBtn('wfm-upload', 'upload', t('wfm.upload', 'Upload File'),
      function () { askForUpload(uploadTarget()); }));
    bar.appendChild(iconBtn('wfm-refresh', 'rotate-cw', t('wfm.refresh', 'Refresh'),
      function () { void refresh(); }));
    bar.appendChild(iconBtn('wfm-overflow', 'more-horizontal', t('wfm.actions', 'Actions'),
      function () {
        var r = bar.getBoundingClientRect ? bar.getBoundingClientRect() : { left: 0, bottom: 0 };
        openMenu(null, r.left, r.bottom);
      }));
    root.appendChild(bar);

    // ── breadcrumb: where the tree is rooted, and the way back
    var crumbs = document.createElement('div');
    crumbs.className = 'wfm-crumbs';
    crumbs.setAttribute('aria-label', t('wfm.location', 'Location'));
    root.appendChild(crumbs);

    // ── the tree
    var list = document.createElement('ul');
    list.className = 'wfm-list';
    list.setAttribute('role', 'tree');
    list.setAttribute('aria-multiselectable', 'true');
    // A right-click on the empty space is the root's own menu, and a plain
    // click there clears the selection — both from the reference UI.
    list.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      openMenu(null, ev.clientX, ev.clientY);
    });
    list.addEventListener('click', function (ev) {
      if (ev.target === list) clearSelection();
    });
    root.appendChild(list);

    var note = document.createElement('div');
    note.className = 'wfm-note';
    root.appendChild(note);

    var confirmHost = document.createElement('div');
    confirmHost.className = 'wfm-confirm';
    confirmHost.hidden = true;
    root.appendChild(confirmHost);

    // ── foot: what is picked, and the two things to do with it
    var foot = document.createElement('div');
    foot.className = 'wfm-foot';
    var count = document.createElement('span');
    count.className = 'wfm-count';
    foot.appendChild(count);
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'wfm-clear';
    clear.hidden = true;
    clear.textContent = t('wfm.clear', 'Clear');
    clear.addEventListener('click', function () { clearSelection(); });
    foot.appendChild(clear);
    var grow2 = document.createElement('span');
    grow2.className = 'wfm-grow';
    foot.appendChild(grow2);
    // Context-sensitive batch actions: hidden until something is picked (the
    // same `has-sel` rule Download/Delete use), so the footer never grows a
    // permanent wall of buttons. Move / Copy / Compress act on the whole set.
    var footCompress = document.createElement('button');
    footCompress.type = 'button';
    footCompress.className = 'btn btn-ghost btn-sm wfm-compresssel';
    footCompress.textContent = t('wfm.compress', 'Compress (.zip)');
    footCompress.title = t('wfm.compressSelTitle', 'Make one .zip from the selected items');
    footCompress.addEventListener('click', function () { void compressPaths(selectedPaths()); });
    foot.appendChild(footCompress);
    var footMove = document.createElement('button');
    footMove.type = 'button';
    footMove.className = 'btn btn-ghost btn-sm wfm-movesel';
    footMove.textContent = t('wfm.move', 'Move');
    footMove.addEventListener('click', function () { void movePaths(selectedPaths()); });
    foot.appendChild(footMove);
    var footCopy = document.createElement('button');
    footCopy.type = 'button';
    footCopy.className = 'btn btn-ghost btn-sm wfm-copysel';
    footCopy.textContent = t('wfm.copy', 'Copy');
    footCopy.addEventListener('click', function () { void copyPaths(selectedPaths()); });
    foot.appendChild(footCopy);
    var down = document.createElement('button');
    down.type = 'button';
    down.className = 'btn btn-ghost btn-sm wfm-downsel';
    down.textContent = t('wfm.download', 'Download');
    down.title = t('wfm.downloadSelTitle', 'Download the selected files (several become one .zip)');
    down.addEventListener('click', function () { void downloadSelected(); });
    foot.appendChild(down);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost btn-sm wfm-delsel';
    del.textContent = t('wfm.delete', 'Delete');
    del.addEventListener('click', function () { deleteSelected(); });
    foot.appendChild(del);
    var select = document.createElement('button');
    select.type = 'button';
    select.className = 'btn btn-primary btn-sm wfm-select';
    select.disabled = true;
    select.textContent = t('wfm.select', 'Select');
    select.addEventListener('click', use);
    foot.appendChild(select);
    root.appendChild(foot);

    // Hidden, not removed: the visible Upload buttons forward their click
    // here. That click is the operator's OWN gesture, so the native picker
    // opens regardless of how long ago the remote page asked for a file.
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.className = 'wfm-input';
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      uploadFiles(files);
    });
    root.appendChild(input);

    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        // Escape closes the MENU first when one is up, so it is not a way to
        // lose the whole drawer by aiming at a menu.
        if (menu) { closeMenu(); return; }
        close('closed');
      }
    });
    // A click anywhere else dismisses the menu, exactly as a native one does.
    root.addEventListener('click', function () { closeMenu(); });

    host.appendChild(root);
    return {
      root: root, list: list, note: note, select: select, input: input,
      total: total, count: count, clear: clear, foot: foot,
      confirm: confirmHost, selectAll: all, crumbs: crumbs,
      compressSel: footCompress, moveSel: footMove, copySel: footCopy
    };
  }

  /** Pick every FILE currently drawn (i.e. in an expanded folder). Always on offer. */
  function selectAllVisible() {
    if (!state) return;
    var next = [];
    var rows = state.els.list.querySelectorAll('li.wfm-file');
    for (var i = 0; i < rows.length; i++) {
      var rel = rows[i].getAttribute('data-path');
      var name = (rows[i].querySelector('.wfm-name') || {}).textContent || '';
      next.push({ path: rel, name: name, size: Number(rows[i].getAttribute('data-size') || 0) });
    }
    state.selected = next;
    syncSelection();
  }

  /**
   * Open the drawer.
   *
   * opts = {
   *   host:       element the drawer is appended to (defaults to document.body),
   *   workflowId: explicit saved-workflow id (defaults to the editor's),
   *   userId:     string or function() -> string; the identity the live socket
   *               runs as, so the server finds THIS session's waiting dialog,
   *   accept:     the page's accept list, checked before /use,
   *   multiple:   the page's own `multiple` — what makes multi-select possible,
   *   onUsed:     function({name,size} | [{name,size}]) after a hand-over,
   *   onClose:    function(reason) when the drawer goes away for any reason
   * }
   * Returns true when a drawer is on screen, false when there is no saved
   * workflow to browse (a toast says so).
   */
  function open(opts) {
    var o = opts || {};
    close('replaced');
    var workflowId = currentWorkflowId(o.workflowId);
    if (!workflowId) {
      toast(t('wfm.noWorkflow',
        'This browser was not opened from a saved workflow, so it has no workflow files. Save the workflow first.'), 'info');
      if (typeof o.onClose === 'function') { try { o.onClose('no-workflow'); } catch (e) { /* ignore */ } }
      return false;
    }
    var host = o.host || document.body;
    var els = build(host);
    panel = els.root;
    state = {
      workflowId: workflowId,
      folders: {},
      open: { '': true },
      loading: {},
      selected: [],
      multiple: !!o.multiple,
      uploadInto: '',
      /** Where the tree is rooted; '' is the workspace. See goTo(). */
      root: '',
      opts: o,
      els: els
    };
    // Multi-select is the drawer's own (Download / Delete any number); the
    // page's `multiple` only decides whether SEVERAL can be SENT (see use()).
    els.selectAll.hidden = false;
    els.foot.classList.toggle('is-multi', !!state.multiple);
    render();
    void expand('');
    // Let the class that starts the slide be painted before it is removed.
    try {
      setTimeout(function () { if (panel === els.root) els.root.classList.remove('is-opening'); }, 0);
    } catch (e) { els.root.classList.remove('is-opening'); }
    return true;
  }

  /**
   * Tell the server the caller's LIVE browser session works for this
   * workflow, so what it downloads is filed under downloads/ and what the
   * operator sends under uploads/ (POST /bind, target 'live'). RemoteIO
   * calls this when its socket says 'ready'. Idempotent and best-effort: the
   * server answers `bound: false` -- not an error -- when no session is open
   * yet, and the caller binds again on the next 'ready'.
   *
   * Returns a promise of `true` when bound, `false` otherwise; never rejects.
   */
  function bind(opts) {
    var o = opts || {};
    var workflowId = currentWorkflowId(o.workflowId);
    if (!workflowId) return Promise.resolve(false);
    var userId = (typeof o.userId === 'function') ? o.userId() : o.userId;
    var body = { target: 'live' };
    if (userId) body.userId = String(userId);
    return call('/browser/workflow-files/' + encodeURIComponent(workflowId) + '/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (d) { return !!(d && d.bound); })
      .catch(function () { return false; });
  }

  window.WorkflowFiles = {
    open: open,
    close: close,
    bind: bind,
    isOpen: function () { return !!panel; },
    currentWorkflowId: currentWorkflowId,
    // Exported for tests: the id rule must agree with the server's.
    WORKFLOW_ID_RE: WORKFLOW_ID_RE
  };
})();
