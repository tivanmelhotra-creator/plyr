/* ============================================
   WorkflowFiles — the Workflow File Manager for the canvas views.

   WHAT THIS IS
   ------------
   Every saved Workflow owns an isolated, persistent file workspace on the
   server (src/core/WorkflowStorage.ts, HTTP face in
   src/Routes/workflow-files.routes.ts). This module is the compact panel
   that browses it from the main app: the picker modal and the Live Browser
   View (both wired through RemoteIO's file prompt), and it is what the second
   source of "Add File" opens:

       Add File
       ├── Upload from Computer        -> RemoteIO's existing upload bridge
       └── Choose from Workflow Files  -> THIS panel, then
                                          POST /browser/workflow-files/<id>/use

   The Local Browser view (/desktop/chrome, src/core/ChromeView.ts) has its own
   copy of this panel, because that page is a standalone document served by
   the server and cannot load app scripts. The two speak the same API.

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
   * The saved-workflow id the panel should browse.
   *
   * Preferred: an explicit id from the caller. Fallback: the workflow open in
   * the editor. Empty when the graph has never been saved — the panel then
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

  // ── The panel ──────────────────────────────────────────────────────────

  var panel = null;      // the one open panel; a second open() replaces it
  var state = null;      // { workflowId, cwd, parent, selected, opts, els }

  function base() {
    return '/browser/workflow-files/' + encodeURIComponent(state.workflowId);
  }

  function say(text, isErr) {
    if (!state) return;
    state.els.note.textContent = text || '';
    state.els.note.className = 'wfm-note' + (isErr ? ' err' : '');
  }

  function close(reason) {
    if (!panel) return;
    var s = state;
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    state = null;
    if (s && s.opts && typeof s.opts.onClose === 'function') {
      try { s.opts.onClose(reason || 'closed'); } catch (e) { /* caller's problem */ }
    }
  }

  function setSelected(entry, row) {
    if (!state) return;
    if (state.selectedRow) state.selectedRow.classList.remove('sel');
    state.selected = entry || null;
    state.selectedRow = row || null;
    if (row) row.classList.add('sel');
    state.els.select.disabled = !state.selected;
  }

  /** window.prompt / confirm, guarded: the unit harness has no window dialogs. */
  function ask(text, initial) {
    try { return (typeof prompt === 'function') ? prompt(text, initial || '') : null; }
    catch (e) { return null; }
  }
  function agree(text) {
    try { return (typeof confirm === 'function') ? confirm(text) : false; }
    catch (e) { return false; }
  }

  function load(rel) {
    if (!state) return Promise.resolve();
    say('', false);
    setSelected(null, null);
    var s = state;
    return call(base() + '?path=' + encodeURIComponent(rel || ''))
      .then(function (d) {
        if (state !== s) return;
        s.cwd = d.path || '';
        s.parent = (d.parent === null || d.parent === undefined) ? null : String(d.parent);
        render(d.entries || []);
      })
      .catch(function (e) {
        if (state !== s) return;
        say((e && e.message) || t('wfm.loadFailed', 'Could not read the workflow files.'), true);
      });
  }

  function render(entries) {
    var els = state.els;
    els.path.textContent = t('wfm.root', 'Workflow') +
      (state.cwd ? ' / ' + state.cwd.split('/').join(' / ') : '');
    els.back.disabled = state.parent === null;
    els.list.textContent = '';
    if (!entries.length) {
      var empty = document.createElement('li');
      empty.className = 'wfm-empty';
      empty.textContent = t('wfm.empty', 'This folder is empty. Upload a file or create a folder.');
      els.list.appendChild(empty);
      return;
    }
    entries.forEach(function (e) {
      var isDir = e.type === 'dir';
      var li = document.createElement('li');
      li.className = isDir ? 'wfm-dir' : 'wfm-file';
      li.setAttribute('role', 'option');

      var ico = document.createElement('span');
      ico.className = 'wfm-ico';
      ico.innerHTML = BIC(isDir ? 'folder' : 'file-text', 14) || (isDir ? '\uD83D\uDCC1' : '\uD83D\uDCC4');
      li.appendChild(ico);

      var name = document.createElement('span');
      name.className = 'wfm-name';
      // textContent, never markup: the name came from a shared filesystem.
      name.textContent = e.name;
      li.appendChild(name);

      if (!isDir) {
        var sz = document.createElement('span');
        sz.className = 'wfm-size';
        sz.textContent = humanSize(e.size);
        li.appendChild(sz);
      }

      var act = document.createElement('span');
      act.className = 'wfm-act';
      var ren = document.createElement('button');
      ren.type = 'button';
      ren.textContent = t('wfm.rename', 'Rename');
      ren.addEventListener('click', function (ev) { ev.stopPropagation(); renameEntry(e); });
      act.appendChild(ren);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = t('wfm.delete', 'Delete');
      del.addEventListener('click', function (ev) { ev.stopPropagation(); deleteEntry(e); });
      act.appendChild(del);
      li.appendChild(act);

      li.addEventListener('click', function () {
        if (isDir) { load(e.path); return; }
        // Only FILES can be selected: a folder cannot go into an input.
        setSelected({ path: e.path, name: e.name, size: e.size }, li);
      });
      li.addEventListener('dblclick', function () {
        if (!isDir) { setSelected({ path: e.path, name: e.name, size: e.size }, li); use(); }
      });
      els.list.appendChild(li);
    });
  }

  function newFolder() {
    var name = ask(t('wfm.newFolderPrompt', 'New folder name:'), '');
    if (!name) return;
    var s = state;
    call(base() + '/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: s.cwd, name: name })
    })
      .then(function () { if (state === s) return load(s.cwd); })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.mkdirFailed', 'Could not create the folder.'), true); });
  }

  function renameEntry(entry) {
    var name = ask(t('wfm.renamePrompt', 'Rename to:'), entry.name);
    if (!name || name === entry.name) return;
    var s = state;
    call(base() + '/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entry.path, name: name })
    })
      .then(function () { if (state === s) return load(s.cwd); })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.renameFailed', 'Could not rename.'), true); });
  }

  function deleteEntry(entry) {
    var isDir = entry.type === 'dir';
    // Recursive deletion is EXPLICIT: the folder is named and "everything
    // inside it" is on screen before anything is sent.
    var q = isDir
      ? t('wfm.deleteFolderAsk', 'Delete this folder and everything inside it?') + '\n' + entry.name
      : t('wfm.deleteFileAsk', 'Delete this file?') + '\n' + entry.name;
    if (!agree(q)) return;
    var s = state;
    call(base() + '?path=' + encodeURIComponent(entry.path) + (isDir ? '&recursive=1' : ''), { method: 'DELETE' })
      .then(function () { if (state === s) return load(s.cwd); })
      .catch(function (e) { if (state === s) say((e && e.message) || t('wfm.deleteFailed', 'Could not delete.'), true); });
  }

  /** Upload from the operator's computer INTO the current workflow folder. */
  function uploadFiles(list) {
    if (!list.length || !state) return Promise.resolve();
    var s = state;
    say(t('wfm.uploading', 'Uploading…'), false);
    return list.reduce(function (chain, file) {
      return chain.then(function () {
        return call(
          base() + '/upload?path=' + encodeURIComponent(s.cwd) + '&name=' + encodeURIComponent(file.name || 'file'),
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }
        );
      });
    }, Promise.resolve())
      .then(function () { if (state === s) { say(t('wfm.uploaded', 'Uploaded.'), false); return load(s.cwd); } })
      .catch(function (e) { if (state === s) { say((e && e.message) || t('wfm.uploadFailed', 'The upload failed.'), true); return load(s.cwd); } });
  }

  /**
   * Hand the selected workflow file to the page that is asking.
   *
   * No `chooserId`: the canvas views' dialog belongs to the user's
   * LiveBrowserSession, which the server finds by `userId` — the SAME identity
   * the socket was opened with. The server resolves the path inside the
   * workflow root and calls FileChooser.setFiles() itself; the hand-over is
   * then confirmed to the socket as 'fileChooserDone', exactly as for tokens.
   */
  function use() {
    if (!state || !state.selected) return;
    var s = state;
    var chosen = s.selected;
    if (s.opts.accept && !accepts(s.opts.accept, chosen.name)) {
      say(t('rio.wrongType', 'The page only accepts') + ' ' + s.opts.accept, true);
      return;
    }
    var uid = typeof s.opts.userId === 'function' ? s.opts.userId() : (s.opts.userId || '');
    s.els.select.disabled = true;
    say(t('wfm.sending', 'Sending…') + ' ' + chosen.name, false);
    call(base() + '/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(uid ? { path: chosen.path, userId: uid } : { path: chosen.path })
    })
      .then(function (d) {
        if (state !== s) return;
        if (typeof s.opts.onUsed === 'function') {
          try { s.opts.onUsed({ name: d.name || chosen.name, size: d.size || chosen.size }); } catch (e) { /* caller's problem */ }
        }
        close('used');
      })
      .catch(function (e) {
        if (state !== s) return;
        s.els.select.disabled = false;
        say((e && e.message) || t('wfm.useFailed', 'The file could not be sent.'), true);
      });
  }

  function build(host, workflowId) {
    var root = document.createElement('div');
    root.className = 'wfm-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', t('wfm.title', 'Workflow Files'));

    var head = document.createElement('div');
    head.className = 'wfm-head';
    var h = document.createElement('h4');
    h.textContent = t('wfm.title', 'Workflow Files');
    head.appendChild(h);
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'icon-btn wfm-close';
    x.setAttribute('aria-label', t('wfm.close', 'Close'));
    x.innerHTML = BIC('x', 14) || '\u00d7';
    x.addEventListener('click', function () { close('closed'); });
    head.appendChild(x);
    root.appendChild(head);

    var crumb = document.createElement('div');
    crumb.className = 'wfm-crumb';
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost btn-sm wfm-back';
    back.title = t('wfm.up', 'Go to the parent folder');
    back.textContent = '\u2190';
    back.addEventListener('click', function () { if (state && state.parent !== null) load(state.parent); });
    crumb.appendChild(back);
    var path = document.createElement('span');
    path.className = 'wfm-path';
    crumb.appendChild(path);
    root.appendChild(crumb);

    var list = document.createElement('ul');
    list.className = 'wfm-list';
    list.setAttribute('role', 'listbox');
    root.appendChild(list);

    var note = document.createElement('div');
    note.className = 'wfm-note';
    root.appendChild(note);

    var foot = document.createElement('div');
    foot.className = 'wfm-foot';
    var mk = document.createElement('button');
    mk.type = 'button';
    mk.className = 'btn btn-sm wfm-new';
    mk.textContent = t('wfm.newFolder', 'New Folder');
    mk.addEventListener('click', newFolder);
    foot.appendChild(mk);
    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'btn btn-sm wfm-upload';
    up.textContent = t('wfm.upload', 'Upload');
    foot.appendChild(up);
    var grow = document.createElement('span');
    grow.className = 'wfm-grow';
    foot.appendChild(grow);
    var select = document.createElement('button');
    select.type = 'button';
    select.className = 'btn btn-primary btn-sm wfm-select';
    select.disabled = true;
    select.textContent = t('wfm.select', 'Select');
    select.addEventListener('click', use);
    foot.appendChild(select);
    root.appendChild(foot);

    // Hidden, not removed: the visible Upload button forwards its click here.
    // That click is the operator's OWN gesture, so the native picker opens
    // regardless of how long ago the remote page asked for a file.
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.className = 'wfm-input';
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      uploadFiles(files);
    });
    up.addEventListener('click', function () { try { input.click(); } catch (e) { /* nothing to do */ } });
    root.appendChild(input);

    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close('closed'); }
    });

    host.appendChild(root);
    return { root: root, path: path, back: back, list: list, note: note, select: select, input: input };
  }

  /**
   * Open the panel.
   *
   * opts = {
   *   host:       element the panel is appended to (defaults to document.body),
   *   workflowId: explicit saved-workflow id (defaults to the editor's),
   *   userId:     string or function() -> string; the identity the live socket
   *               runs as, so the server finds THIS session's waiting dialog,
   *   accept:     the page's accept list, checked before /use,
   *   onUsed:     function({ name, size }) after a successful hand-over,
   *   onClose:    function(reason) when the panel goes away for any reason
   * }
   * Returns true when a panel is on screen, false when there is no saved
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
    var els = build(host, workflowId);
    panel = els.root;
    state = { workflowId: workflowId, cwd: '', parent: null, selected: null, selectedRow: null, opts: o, els: els };
    load('');
    return true;
  }

  window.WorkflowFiles = {
    open: open,
    close: close,
    isOpen: function () { return !!panel; },
    currentWorkflowId: currentWorkflowId,
    // Exported for tests: the id rule must agree with the server's.
    WORKFLOW_ID_RE: WORKFLOW_ID_RE
  };
})();
