/* ============================================
   ProfileManager — the ONE client for browser profiles.

   Every surface that shows or picks a profile uses this module and the one
   server API behind it (src/Routes/profile.routes.ts):

     - the Workflow Files drawer (mount(): list, multi-select, create, rename,
       delete, open / close / release, status of browser and access);
     - Workflow Settings (list(): the profile choice).

   Rules this client keeps (the server enforces them too):
     - creating a profile and opening its browser are two operations; after a
       successful CREATE the UI immediately tries to OPEN it, exactly as if the
       operator had selected it and pressed Open. If the open fails the
       profile stays, and Open can be pressed again;
     - a profile that is reserved / in use by another workflow is shown with
       the reason (workflow name, reservation window); its checkbox cannot be
       ticked, so a selection can never bypass a reservation;
     - the browser is shown through the existing remote view in a NEW tab,
       opened synchronously in the click (popup blockers), pointed at the
       profile once the server answers. One tab per open press; the server
       reuses a running browser, so a second press never starts a second one.

   CSP-safe: no inline handlers, textContent for every name.
   ============================================ */
(function () {
  'use strict';

  function t(k, fallback) {
    var s = (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
    return (s === k && fallback) ? fallback : s;
  }

  var POLL_MS = 6000;
  var HOLD_REFRESH_MS = 5 * 60 * 1000;
  var OPEN_ATTEMPTS = 8;
  var OPEN_BACKOFF_MS = 2500;

  function headers(json) {
    var key = (window.API && window.API.getKey) ? window.API.getKey() : '';
    var h = {};
    if (key) h['x-api-key'] = key;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** One request; a refusal becomes an Error carrying the server's own words + body. */
  function call(path, method, body) {
    return fetch(path, {
      method: method || 'GET',
      headers: headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      return r.text().then(function (txt) {
        var d = null;
        try { d = JSON.parse(txt); } catch (e) { /* not JSON */ }
        if (!r.ok || !d || !d.success) {
          var err = new Error((d && d.error) || ('HTTP ' + r.status));
          err.status = r.status;
          err.body = d;
          throw err;
        }
        return d;
      });
    });
  }

  function q(workflowId) {
    return workflowId ? '?workflowId=' + encodeURIComponent(workflowId) : '';
  }

  var api = {
    list: function (workflowId) { return call('/profiles' + q(workflowId)); },
    create: function (name, workflowId) { return call('/profiles', 'POST', { name: name, workflowId: workflowId || undefined }); },
    rename: function (id, name, workflowId) { return call('/profiles/' + encodeURIComponent(id), 'PATCH', { name: name, workflowId: workflowId || undefined }); },
    remove: function (id) { return call('/profiles/' + encodeURIComponent(id), 'DELETE'); },
    /**
     * Open, retrying while the server says the cold start is still going
     * (503 retryable): the start continues server-side and each retry joins
     * it, so this never starts a second browser.
     */
    open: function (id, workflowId) {
      var attempt = 0;
      function once() {
        attempt++;
        return call('/profiles/' + encodeURIComponent(id) + '/open', 'POST', { workflowId: workflowId || undefined })
          .catch(function (e) {
            var b = e && e.body;
            if (b && b.code === 'starting' && b.retryable && attempt < OPEN_ATTEMPTS) {
              return new Promise(function (r) { setTimeout(r, OPEN_BACKOFF_MS); }).then(once);
            }
            throw e;
          });
      }
      return once();
    },
    hold: function (id, workflowId) { return call('/profiles/' + encodeURIComponent(id) + '/hold', 'POST', { workflowId: workflowId || undefined }); },
    release: function (id, workflowId) { return call('/profiles/' + encodeURIComponent(id) + '/release', 'POST', { workflowId: workflowId || undefined }); },
    close: function (id, workflowId) { return call('/profiles/' + encodeURIComponent(id) + '/close', 'POST', { workflowId: workflowId || undefined }); }
  };

  var STATUS_LABEL = {
    free: ['pm.free', 'Free'],
    reserved: ['pm.reserved', 'Reserved'],
    in_use: ['pm.inUse', 'In use'],
    needs_review: ['pm.needsReview', 'Needs review']
  };

  function hhmm(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }

  /** The one-line detail under a profile name. */
  function detailOf(p) {
    if (!p.available && p.explanation) return p.explanation;
    if (p.problem) return t('pm.needsReview', 'Needs review') + ': ' + p.problem;
    if (p.lastOpenError && p.lastOpenError.message) return t('pm.openFailedBefore', 'Last open failed') + ': ' + p.lastOpenError.message;
    var parts = [];
    if (p.hold && p.hold.mine) parts.push(t('pm.heldByYou', 'Opened by you') + (p.hold.until ? ' \u2192 ' + hhmm(p.hold.until) : ''));
    if (p.browser && p.browser.open) parts.push(t('pm.browserOpen', 'Browser open') + (p.browser.visibility === 'hidden' ? ' (' + t('pm.hidden', 'hidden') + ')' : ''));
    if (p.nextReservation) {
      parts.push(t('pm.nextReservation', 'Reserved') + ' ' + hhmm(p.nextReservation.start) + '\u2013' + hhmm(p.nextReservation.end) +
        (p.nextReservation.ownerName ? ' (' + p.nextReservation.ownerName + ')' : ''));
    }
    return parts.join(' \u00b7 ');
  }

  /** One line for an overlap of two workflows' schedules on one profile. */
  function overlapText(ov) {
    var a = ov && ov.a, b = ov && ov.b;
    if (!a || !b) return (ov && ov.message) || '';
    return t('pm.overlap', 'Schedules overlap') + ': \u201c' + (a.ownerName || t('pm.anotherWorkflow', 'another workflow')) + '\u201d ' +
      hhmm(a.start) + '\u2013' + hhmm(a.end) + ' \u00b7 \u201c' + (b.ownerName || t('pm.anotherWorkflow', 'another workflow')) + '\u201d ' +
      hhmm(b.start) + '\u2013' + hhmm(b.end) + '. ' + t('pm.overlapWaits', 'The later run waits for the profile.');
  }

  /**
   * Mount the profile panel into `host`.
   *   opts.workflowId   the workflow the operator works for (hold owner)
   *   opts.onSay(text, isErr)
   *   opts.openView(viewPath, tab)  how to show the browser (default: navigate the pre-opened tab)
   * Returns { refresh, destroy, state }.
   */
  function mount(host, opts) {
    var o = opts || {};
    var st = { profiles: [], unknownSchedules: [], selected: {}, busy: '', destroyed: false, timer: 0, holdTimer: 0, loaded: false };

    function say(text, isErr) { if (o.onSay) o.onSay(text, isErr); }

    var root = document.createElement('section');
    root.className = 'pm-panel';
    root.setAttribute('aria-label', t('pm.title', 'Browser profiles'));

    var head = document.createElement('div');
    head.className = 'pm-head';
    var title = document.createElement('span');
    title.className = 'pm-title';
    title.textContent = t('pm.title', 'Browser profiles');
    head.appendChild(title);
    var grow = document.createElement('span');
    grow.className = 'wfm-grow';
    head.appendChild(grow);
    var newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'btn btn-sm btn-ghost pm-new';
    newBtn.textContent = t('pm.new', 'New profile');
    head.appendChild(newBtn);
    root.appendChild(head);

    var form = document.createElement('form');
    form.className = 'pm-form';
    form.hidden = true;
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 60;
    input.className = 'pm-input';
    input.setAttribute('aria-label', t('pm.namePrompt', 'Profile name'));
    input.placeholder = t('pm.namePrompt', 'Profile name');
    form.appendChild(input);
    var ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'btn btn-sm btn-primary pm-form-ok';
    form.appendChild(ok);
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm btn-subtle pm-form-cancel';
    cancel.textContent = t('wfm.cancel', 'Cancel');
    form.appendChild(cancel);
    root.appendChild(form);

    var list = document.createElement('ul');
    list.className = 'pm-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    root.appendChild(list);

    // Schedule-level warnings from the server: schedules whose profile cannot
    // be known (they reserve nothing yet). Overlaps are shown on their row.
    var notes = document.createElement('ul');
    notes.className = 'pm-notes';
    notes.hidden = true;
    root.appendChild(notes);

    var actions = document.createElement('div');
    actions.className = 'pm-actions';
    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-sm btn-primary pm-open';
    actions.appendChild(openBtn);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-sm btn-ghost pm-close';
    closeBtn.textContent = t('pm.closeBrowser', 'Close browser');
    actions.appendChild(closeBtn);
    var releaseBtn = document.createElement('button');
    releaseBtn.type = 'button';
    releaseBtn.className = 'btn btn-sm btn-ghost pm-release';
    releaseBtn.textContent = t('pm.release', 'Release');
    releaseBtn.title = t('pm.releaseHint', 'Give the profile back to other workflows. The browser stays open.');
    actions.appendChild(releaseBtn);
    root.appendChild(actions);

    host.appendChild(root);

    var formMode = null; // { kind: 'create' } | { kind: 'rename', id }

    function showForm(mode, initial) {
      formMode = mode;
      form.hidden = false;
      input.value = initial || '';
      ok.textContent = mode.kind === 'create' ? t('pm.create', 'Create') : t('pm.rename', 'Rename');
      try { input.focus(); input.select(); } catch (e) { /* jsdom */ }
    }
    function hideForm() { formMode = null; form.hidden = true; input.value = ''; }

    function selectedIds() {
      return st.profiles.filter(function (p) { return st.selected[p.id]; }).map(function (p) { return p.id; });
    }

    function paint() {
      list.innerHTML = '';
      if (!st.loaded) {
        var li0 = document.createElement('li');
        li0.className = 'pm-hint';
        li0.textContent = t('pm.loading', 'Loading profiles\u2026');
        list.appendChild(li0);
      }
      st.profiles.forEach(function (p) {
        var li = document.createElement('li');
        li.className = 'pm-row is-' + p.status + (p.available ? '' : ' is-blocked');
        li.setAttribute('role', 'option');
        li.setAttribute('data-id', p.id);
        li.setAttribute('aria-selected', st.selected[p.id] ? 'true' : 'false');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'pm-check';
        box.checked = !!st.selected[p.id];
        // A profile another workflow holds or reserves cannot be selected:
        // a selection never bypasses a reservation.
        box.disabled = !p.available && !(p.hold && p.hold.mine);
        box.setAttribute('aria-label', p.name);
        box.addEventListener('change', function () {
          if (box.checked) st.selected[p.id] = true; else delete st.selected[p.id];
          paintActions();
          li.setAttribute('aria-selected', box.checked ? 'true' : 'false');
        });
        li.appendChild(box);
        var dot = document.createElement('span');
        dot.className = 'pm-dot' + (p.browser && p.browser.open ? ' is-open' : '');
        dot.setAttribute('aria-hidden', 'true');
        li.appendChild(dot);
        var txt = document.createElement('span');
        txt.className = 'pm-text';
        var nm = document.createElement('span');
        nm.className = 'pm-name';
        nm.textContent = p.name;
        txt.appendChild(nm);
        var badge = document.createElement('span');
        badge.className = 'pm-badge is-' + p.status;
        var lbl = STATUS_LABEL[p.status] || STATUS_LABEL.needs_review;
        badge.textContent = t(lbl[0], lbl[1]);
        txt.appendChild(badge);
        var det = detailOf(p);
        if (det) {
          var d = document.createElement('span');
          d.className = 'pm-detail';
          d.textContent = det;
          txt.appendChild(d);
        }
        (p.overlaps || []).forEach(function (ov) {
          var w = document.createElement('span');
          w.className = 'pm-overlap';
          w.setAttribute('role', 'note');
          w.textContent = '\u26a0 ' + overlapText(ov);
          txt.appendChild(w);
        });
        li.appendChild(txt);
        var ren = document.createElement('button');
        ren.type = 'button';
        ren.className = 'btn btn-sm btn-ghost pm-ren';
        ren.textContent = t('pm.rename', 'Rename');
        ren.addEventListener('click', function () { showForm({ kind: 'rename', id: p.id }, p.name); });
        li.appendChild(ren);
        if (!p.builtIn) {
          var del = document.createElement('button');
          del.type = 'button';
          del.className = 'btn btn-sm btn-ghost pm-del';
          del.textContent = t('pm.delete', 'Delete');
          del.addEventListener('click', function () { void removeProfile(p); });
          li.appendChild(del);
        }
        list.appendChild(li);
      });
      paintActions();
    }

    function paintNotes() {
      notes.innerHTML = '';
      (st.unknownSchedules || []).forEach(function (u) {
        var li = document.createElement('li');
        li.className = 'pm-note is-unknown';
        li.setAttribute('role', 'note');
        li.textContent = '\u26a0 ' + t('pm.unknownSchedule', 'Schedule') + ' \u201c' + (u.name || u.key) + '\u201d (' + u.cron + '): ' +
          t('pm.unknownScheduleText', 'its browser profile is unknown until its next run is queued, so nothing is reserved for it yet. Re-create the schedule to reserve its profile.');
        notes.appendChild(li);
      });
      notes.hidden = !notes.children.length;
    }

    function paintActions() {
      var ids = selectedIds();
      var busy = !!st.busy;
      openBtn.disabled = busy || !ids.length;
      openBtn.textContent = st.busy === 'open' ? t('pm.opening', 'Opening\u2026')
        : ids.length > 1 ? t('pm.openN', 'Open browsers') + ' (' + ids.length + ')'
        : t('pm.open', 'Open browser');
      var anyOpen = ids.some(function (id) { var p = byId(id); return p && p.browser && p.browser.open; });
      var anyMine = ids.some(function (id) { var p = byId(id); return p && p.hold && p.hold.mine; });
      closeBtn.disabled = busy || !anyOpen;
      releaseBtn.disabled = busy || !anyMine;
      newBtn.disabled = busy;
    }

    function byId(id) {
      for (var i = 0; i < st.profiles.length; i++) if (st.profiles[i].id === id) return st.profiles[i];
      return null;
    }

    function refresh() {
      return api.list(o.workflowId).then(function (d) {
        if (st.destroyed) return;
        st.profiles = d.profiles || [];
        st.unknownSchedules = d.unknownSchedules || [];
        st.loaded = true;
        paintNotes();
        // A selection that became unavailable is dropped, never kept by stealth.
        Object.keys(st.selected).forEach(function (id) {
          var p = byId(id);
          if (!p || (!p.available && !(p.hold && p.hold.mine))) delete st.selected[id];
        });
        paint();
        return d;
      }).catch(function (e) {
        if (st.destroyed) return;
        st.loaded = true;
        paint();
        say(e.message || t('pm.loadFailed', 'Could not read the profiles.'), true);
      });
    }

    /**
     * Open the browsers of `ids`. The viewer tabs are opened HERE, in the
     * click, and navigated once the server answers; a refused one is closed
     * again and the reason is shown.
     */
    function openProfiles(ids) {
      if (!ids.length || st.busy) return Promise.resolve([]);
      st.busy = 'open';
      paintActions();
      var tabs = ids.map(function () { try { return window.open('', '_blank'); } catch (e) { return null; } });
      tabs.forEach(function (tab) {
        try { if (tab && tab.document) tab.document.title = t('pm.opening', 'Opening\u2026'); } catch (e) { /* cross-origin */ }
      });
      var results = [];
      return ids.reduce(function (chain, id, i) {
        return chain.then(function () {
          return api.open(id, o.workflowId).then(function (r) {
            var href = r.viewPath + (r.viewPath.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' +
              encodeURIComponent((window.API && window.API.getKey) ? (window.API.getKey() || '') : '') +
              (o.workflowId ? '&workflowId=' + encodeURIComponent(o.workflowId) : '');
            if (o.openView) o.openView(href, tabs[i]);
            else if (tabs[i]) tabs[i].location = href;
            else window.open(href, '_blank', 'noopener');
            results.push({ id: id, ok: true });
          }, function (e) {
            try { if (tabs[i]) tabs[i].close(); } catch (x) { /* fine */ }
            var p = byId(id);
            say((p ? p.name + ': ' : '') + (e.message || t('pm.openFailed', 'Could not open the browser.')), true);
            results.push({ id: id, ok: false, error: e.message, code: e.body && e.body.code });
          });
        });
      }, Promise.resolve()).then(function () {
        st.busy = '';
        if (results.some(function (r) { return r.ok; })) startHoldRefresh();
        return refresh().then(function () { return results; });
      });
    }

    function createProfile(name) {
      st.busy = 'create';
      paintActions();
      // Pre-open the viewer tab NOW (inside the submit gesture): the open that
      // follows a successful create would be blocked as a popup otherwise.
      var tab = null;
      try { tab = window.open('', '_blank'); } catch (e) { tab = null; }
      return api.create(name, o.workflowId).then(function (d) {
        st.busy = '';
        hideForm();
        var p = d.profile;
        st.selected = {};
        if (p) st.selected[p.id] = true;
        say(t('pm.created', 'Profile created.') + ' ' + t('pm.openingNew', 'Opening its browser\u2026'), false);
        return refresh().then(function () {
          if (!p) return null;
          // Create succeeded: now the same open as Select + Open.
          st.busy = 'open';
          paintActions();
          return api.open(p.id, o.workflowId).then(function (r) {
            var href = r.viewPath + '&api_key=' + encodeURIComponent((window.API && window.API.getKey) ? (window.API.getKey() || '') : '') +
              (o.workflowId ? '&workflowId=' + encodeURIComponent(o.workflowId) : '');
            if (o.openView) o.openView(href, tab);
            else if (tab) tab.location = href;
            st.busy = '';
            startHoldRefresh();
            say(t('pm.createdOpened', 'Profile created and its browser opened.'), false);
            return refresh();
          }, function (e) {
            try { if (tab) tab.close(); } catch (x) { /* fine */ }
            st.busy = '';
            // The profile is KEPT; Open can be pressed again.
            say(t('pm.createdNotOpened', 'Profile created, but its browser did not open') + ': ' + (e.message || '') + ' ' + t('pm.tryOpenAgain', 'Press Open browser to try again.'), true);
            return refresh();
          });
        });
      }, function (e) {
        try { if (tab) tab.close(); } catch (x) { /* fine */ }
        st.busy = '';
        paintActions();
        say(e.message || t('pm.createFailed', 'Could not create the profile.'), true);
      });
    }

    function renameProfile(id, name) {
      st.busy = 'rename';
      paintActions();
      return api.rename(id, name, o.workflowId).then(function () {
        st.busy = '';
        hideForm();
        say(t('pm.renamed', 'Profile renamed.'), false);
        return refresh();
      }, function (e) {
        st.busy = '';
        paintActions();
        say(e.message || t('pm.renameFailed', 'Could not rename the profile.'), true);
      });
    }

    function removeProfile(p) {
      var sure = true;
      try { sure = window.confirm(t('pm.deleteConfirm', 'Delete this profile and all its browser data (logins, cookies)?') + '\n' + p.name); } catch (e) { sure = true; }
      if (!sure) return Promise.resolve();
      st.busy = 'delete';
      paintActions();
      return api.remove(p.id).then(function () {
        st.busy = '';
        delete st.selected[p.id];
        say(t('pm.deleted', 'Profile deleted.'), false);
        return refresh();
      }, function (e) {
        st.busy = '';
        paintActions();
        say(e.message || t('pm.deleteFailed', 'Could not delete the profile.'), true);
      });
    }

    function each(fn, ids) {
      st.busy = 'act';
      paintActions();
      return ids.reduce(function (c, id) {
        return c.then(function () { return fn(id).catch(function (e) { var p = byId(id); say((p ? p.name + ': ' : '') + e.message, true); }); });
      }, Promise.resolve()).then(function () { st.busy = ''; return refresh(); });
    }

    function startHoldRefresh() {
      if (st.holdTimer) return;
      st.holdTimer = setInterval(function () {
        if (st.destroyed) return;
        st.profiles.filter(function (p) { return p.hold && p.hold.mine; }).forEach(function (p) {
          api.hold(p.id, o.workflowId).catch(function () { /* the list shows the truth */ });
        });
      }, HOLD_REFRESH_MS);
    }

    newBtn.addEventListener('click', function () { showForm({ kind: 'create' }, ''); });
    cancel.addEventListener('click', hideForm);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = String(input.value || '').trim();
      if (!name || !formMode) return;
      if (formMode.kind === 'create') void createProfile(name);
      else void renameProfile(formMode.id, name);
    });
    openBtn.addEventListener('click', function () { void openProfiles(selectedIds()); });
    closeBtn.addEventListener('click', function () {
      void each(function (id) { return api.close(id, o.workflowId); }, selectedIds().filter(function (id) { var p = byId(id); return p && p.browser && p.browser.open; }));
    });
    releaseBtn.addEventListener('click', function () {
      void each(function (id) { return api.release(id, o.workflowId); }, selectedIds().filter(function (id) { var p = byId(id); return p && p.hold && p.hold.mine; }));
    });

    paint();
    void refresh();
    st.timer = setInterval(function () { if (!st.destroyed && !st.busy) void refresh(); }, POLL_MS);

    return {
      state: st,
      el: root,
      refresh: refresh,
      openProfiles: openProfiles,
      createProfile: createProfile,
      destroy: function () {
        st.destroyed = true;
        if (st.timer) clearInterval(st.timer);
        if (st.holdTimer) clearInterval(st.holdTimer);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  window.ProfileManager = { api: api, mount: mount, detailOf: detailOf, overlapText: overlapText };
})();
