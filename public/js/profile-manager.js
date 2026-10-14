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

  // ── THE ONE SHARED VIEWER ────────────────────────────────────────────────
  // Every browser (Local Browser and every profile) is a window on ONE remote
  // desktop, so ONE tab shows them all. It is a NAMED window: window.open()
  // with the same name returns the existing tab instead of opening a new one,
  // so opening 1, 2 or 3 profiles, pressing Open again, or Show browser all
  // land in the same tab. Shared with workflow-files.js (Local Browser).
  var VIEWER_NAME = 'aria-browser-viewer';

  /** Claim the viewer tab inside the click (popup blockers). Returns it or null. */
  function claimViewer() {
    try { return window.open('', VIEWER_NAME); } catch (e) { return null; }
  }

  /** Point the viewer at `href` (relative). Navigates only when needed. */
  function showInViewer(tab, href) {
    var t = tab || claimViewer();
    if (!t) { try { window.open(href, VIEWER_NAME); } catch (e) { /* blocked */ } return; }
    try {
      var cur = '';
      try { cur = t.location.pathname + t.location.search; } catch (e) { cur = ''; }
      if (cur !== href) t.location = href;
      if (t.focus) t.focus();
    } catch (e) { /* cross-origin / closed */ }
  }

  /** Did claimViewer() just create an empty tab (vs. return the running viewer)? */
  function isBlankTab(tab) {
    try { return !!tab && (!tab.location || tab.location.href === 'about:blank'); } catch (e) { return false; }
  }
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
    open: function (id, workflowId, launch) {
      var attempt = 0;
      function once() {
        attempt++;
        return call('/profiles/' + encodeURIComponent(id) + '/open', 'POST', { workflowId: workflowId || undefined, launch: launch || undefined })
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
    close: function (id, workflowId) { return call('/profiles/' + encodeURIComponent(id) + '/close', 'POST', { workflowId: workflowId || undefined }); },
    launchOptions: function () { return call('/profiles/launch-options'); },
    validateLaunch: function (launch) { return call('/profiles/launch-settings/validate', 'POST', { launch: launch || {} }); },
    restore: function (id, workflowId) { return call('/profiles/' + encodeURIComponent(id) + '/restore', 'POST', { workflowId: workflowId || undefined }); },
    branches: function () { return call('/profiles/branches'); },
    createIn: function (name, branchId, workflowId) { return call('/profiles', 'POST', { name: name, branchId: branchId || 'new', workflowId: workflowId || undefined }); },
    renameBranch: function (id, label) { return call('/profiles/branches/' + encodeURIComponent(id), 'PATCH', { label: label }); },
    deletionScan: function (id) { return call('/profiles/branches/' + encodeURIComponent(id) + '/deletion-scan'); },
    deleteBranch: function (id) { return call('/profiles/branches/' + encodeURIComponent(id), 'DELETE'); },
    inspectExternal: function (root) { return call('/profiles/branches/external/inspect', 'POST', { root: root }); },
    addExternal: function (root, confirm, label) { return call('/profiles/branches/external', 'POST', { root: root, confirm: confirm, label: label || undefined }); }
  };

  /** How long the Delete branch button must be held (owner's rule: 3 s). */
  var DELETE_HOLD_MS = 3000;

  /**
   * Press-and-hold button: `onDone` runs only after `ms` of continuous
   * pointer OR Enter/Space hold. Releasing earlier cancels and resets the
   * progress. Returns { el, reset }.
   */
  function holdButton(label, ms, onDone) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm btn-danger pm-hold';
    var bar = document.createElement('span');
    bar.className = 'pm-hold-bar';
    bar.setAttribute('aria-hidden', 'true');
    var txt = document.createElement('span');
    txt.className = 'pm-hold-text';
    txt.textContent = label;
    b.appendChild(bar);
    b.appendChild(txt);
    b.setAttribute('aria-describedby', '');
    var started = 0, raf = 0, timer = 0, done = false;
    function frame() {
      if (!started) return;
      var p = Math.min(1, (Date.now() - started) / ms);
      bar.style.width = (p * 100).toFixed(1) + '%';
      b.setAttribute('data-progress', String(Math.round(p * 100)));
      raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(frame);
    }
    function start() {
      if (started || done || b.disabled) return;
      started = Date.now();
      frame();
      timer = setTimeout(function () { finish(); }, ms);
    }
    function reset() {
      started = 0;
      if (timer) clearTimeout(timer);
      timer = 0;
      bar.style.width = '0%';
      b.setAttribute('data-progress', '0');
    }
    function cancelHold() { if (!done) reset(); }
    function finish() {
      if (!started) return;
      done = true;
      bar.style.width = '100%';
      started = 0; timer = 0;
      Promise.resolve(onDone()).then(function () { done = false; reset(); }, function () { done = false; reset(); });
    }
    b.addEventListener('pointerdown', function (e) { if (e.button === undefined || e.button === 0) start(); });
    b.addEventListener('mousedown', function (e) { if (!window.PointerEvent && (e.button === 0)) start(); });
    ['pointerup', 'pointerleave', 'pointercancel', 'mouseup', 'mouseleave', 'blur'].forEach(function (ev) { b.addEventListener(ev, cancelHold); });
    b.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); if (!e.repeat) start(); }
    });
    b.addEventListener('keyup', function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') cancelHold(); });
    // A click alone never deletes.
    b.addEventListener('click', function (e) { e.preventDefault(); });
    return { el: b, reset: reset, _start: start, _cancel: cancelHold };
  }

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
    if (p.lastSession && p.lastSession.tabs) {
      parts.push(t('pm.savedTabs', 'Saved tabs') + ': ' + p.lastSession.tabs);
    }
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
   * The Launch settings panel (collapsed by default): Preset, categorized
   * options, Custom Flags, and a live check against the server's validator
   * (POST /profiles/launch-settings/validate) showing the final arguments,
   * errors (app-controlled / conflicting / malformed) and warnings (risky,
   * need a tick). value() returns null while nothing was changed, so the
   * default Open keeps the browser exactly as it always started.
   */
  function mountLaunchSettings(parent, opts) {
    var oo = opts || {};
    var cat = null;
    var touched = false;
    var state = { preset: 'standard', options: {}, customFlags: '', acknowledgeRisk: false };
    var det = document.createElement('details');
    det.className = 'pm-launch';
    var sum = document.createElement('summary');
    sum.className = 'pm-launch-sum';
    sum.textContent = t('pm.launchSettings', 'Launch settings');
    det.appendChild(sum);
    var body = document.createElement('div');
    body.className = 'pm-launch-body';
    det.appendChild(body);
    parent.appendChild(det);

    var presetRow = document.createElement('label');
    presetRow.className = 'pm-launch-row';
    var presetLbl = document.createElement('span');
    presetLbl.textContent = t('pm.preset', 'Preset');
    presetRow.appendChild(presetLbl);
    var presetSel = document.createElement('select');
    presetSel.className = 'pm-launch-preset';
    presetRow.appendChild(presetSel);
    body.appendChild(presetRow);
    var presetDesc = document.createElement('p');
    presetDesc.className = 'pm-launch-desc';
    body.appendChild(presetDesc);

    var optsBox = document.createElement('div');
    optsBox.className = 'pm-launch-options';
    body.appendChild(optsBox);

    var customLbl = document.createElement('label');
    customLbl.className = 'pm-launch-row pm-launch-custom';
    var customT = document.createElement('span');
    customT.textContent = t('pm.customFlags', 'Custom Flags');
    customLbl.appendChild(customT);
    var custom = document.createElement('textarea');
    custom.className = 'pm-launch-flags';
    custom.rows = 3;
    custom.spellcheck = false;
    custom.placeholder = '--lang=fa\n--window-size=1280,800';
    custom.setAttribute('aria-label', t('pm.customFlags', 'Custom Flags'));
    customLbl.appendChild(custom);
    body.appendChild(customLbl);
    var customHint = document.createElement('small');
    customHint.className = 'pm-launch-hint';
    customHint.textContent = t('pm.customFlagsHint', 'One flag per line, as --name or --name=value. Quotes only group a value with spaces. Flags the application controls (data directory, debugging, headless, extensions) are refused.');
    body.appendChild(customHint);

    var ackLbl = document.createElement('label');
    ackLbl.className = 'pm-launch-ack';
    ackLbl.hidden = true;
    var ack = document.createElement('input');
    ack.type = 'checkbox';
    ack.className = 'pm-launch-ack-box';
    ackLbl.appendChild(ack);
    var ackT = document.createElement('span');
    ackT.textContent = t('pm.ackRisk', 'I understand the risks of the flags marked with a warning.');
    ackLbl.appendChild(ackT);
    body.appendChild(ackLbl);

    var result = document.createElement('div');
    result.className = 'pm-launch-result';
    result.setAttribute('aria-live', 'polite');
    body.appendChild(result);

    function paintOptions() {
      optsBox.innerHTML = '';
      if (!cat) return;
      var preset = null;
      for (var i = 0; i < cat.presets.length; i++) if (cat.presets[i].id === state.preset) preset = cat.presets[i];
      presetDesc.textContent = preset ? preset.description : '';
      var on = {};
      (preset ? preset.options : []).forEach(function (id) { on[id] = true; });
      Object.keys(state.options).forEach(function (id) { on[id] = state.options[id]; });
      cat.categories.forEach(function (c) {
        var group = cat.options.filter(function (x) { return x.category === c.id; });
        if (!group.length) return;
        var fs = document.createElement('fieldset');
        fs.className = 'pm-launch-group';
        var lg = document.createElement('legend');
        lg.textContent = c.label;
        fs.appendChild(lg);
        group.forEach(function (op) {
          var l = document.createElement('label');
          l.className = 'pm-launch-opt';
          l.title = op.description + ' (' + op.arg + ')';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!on[op.id];
          cb.setAttribute('data-option', op.id);
          cb.addEventListener('change', function () {
            touched = true;
            state.options[op.id] = cb.checked;
            check();
          });
          l.appendChild(cb);
          var sp = document.createElement('span');
          sp.textContent = op.label;
          l.appendChild(sp);
          var code = document.createElement('code');
          code.textContent = op.arg;
          l.appendChild(code);
          fs.appendChild(l);
        });
        optsBox.appendChild(fs);
      });
    }

    function showResult(r) {
      result.innerHTML = '';
      if (!r) return;
      var argsP = document.createElement('p');
      argsP.className = 'pm-launch-args';
      var b = document.createElement('b');
      b.textContent = t('pm.launchArgs', 'Chromium will start with') + ': ';
      argsP.appendChild(b);
      var c = document.createElement('code');
      c.textContent = (r.args || []).join(' ');
      argsP.appendChild(c);
      result.appendChild(argsP);
      (r.errors || []).forEach(function (e) {
        var p = document.createElement('p');
        p.className = 'pm-launch-err';
        p.setAttribute('role', 'alert');
        p.textContent = '\u2716 ' + (e.flag ? e.flag + ' \u2014 ' : '') + e.message;
        result.appendChild(p);
      });
      (r.warnings || []).forEach(function (w) {
        var p = document.createElement('p');
        p.className = 'pm-launch-warn';
        p.textContent = '\u26a0 ' + (w.flag ? w.flag + ' \u2014 ' : '') + w.message;
        result.appendChild(p);
      });
      ackLbl.hidden = !(r.warnings && r.warnings.length);
    }

    var timer = 0;
    var seq = 0;
    function check() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var my = ++seq;
        api.validateLaunch(current()).then(function (d) { if (my === seq) showResult(d.launch); }).catch(function () { /* shown on Open */ });
      }, 250);
    }

    function current() {
      return { preset: state.preset, options: state.options, customFlags: custom.value, acknowledgeRisk: !!ack.checked };
    }

    presetSel.addEventListener('change', function () {
      touched = true;
      state.preset = presetSel.value;
      state.options = {};
      paintOptions();
      check();
    });
    custom.addEventListener('input', function () { touched = true; check(); });
    ack.addEventListener('change', function () { touched = true; check(); });
    det.addEventListener('toggle', function () { if (det.open && cat) check(); });

    api.launchOptions().then(function (d) {
      cat = d;
      presetSel.innerHTML = '';
      d.presets.forEach(function (p) {
        var op = document.createElement('option');
        op.value = p.id;
        op.textContent = p.label;
        if (p.id === d.defaultPreset) op.selected = true;
        presetSel.appendChild(op);
      });
      state.preset = d.defaultPreset;
      paintOptions();
    }).catch(function () {
      if (oo.onSay) oo.onSay(t('pm.launchLoadFailed', 'Launch settings could not be loaded; the standard settings are used.'), true);
    });

    return {
      el: det,
      /** null = unchanged (Standard, an open browser is reused as it is). */
      value: function () { return touched ? current() : null; },
      showResult: function (r) { det.open = true; showResult(r); },
      set: function (v) {
        touched = true;
        state.preset = (v && v.preset) || state.preset;
        state.options = (v && v.options) || {};
        custom.value = (v && v.customFlags) || '';
        ack.checked = !!(v && v.acknowledgeRisk);
        if (cat) { presetSel.value = state.preset; paintOptions(); }
      }
    };
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
    var st = { profiles: [], branches: [], unknownSchedules: [], selected: {}, busy: '', destroyed: false, timer: 0, holdTimer: 0, loaded: false };

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
    // Where the new profile goes: an existing branch Aria created, or a new
    // branch (the system creates branch-NNN; no path is typed).
    var branchSel = document.createElement('select');
    branchSel.className = 'pm-branch-select';
    branchSel.setAttribute('aria-label', t('pm.branchChoose', 'Branch'));
    form.appendChild(branchSel);
    var branchHint = document.createElement('small');
    branchHint.className = 'pm-branch-hint';
    branchHint.textContent = t('pm.branchHint', 'A branch is one browser data folder. Only one profile of a branch can run at a time; profiles in different branches can run together.');
    form.appendChild(branchHint);
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
    var restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn btn-sm btn-ghost pm-restore';
    restoreBtn.textContent = t('pm.restoreTabs', 'Restore tabs');
    restoreBtn.title = t('pm.restoreHint', 'Reopen the tabs that were open when this browser was last closed.');
    actions.appendChild(restoreBtn);
    root.appendChild(actions);

    // Launch settings (preset, options, Custom Flags) for the next Open /
    // the open after New profile. One choice for every selected profile.
    var launchUi = (o.launchSettings === false) ? null : mountLaunchSettings(root, { onSay: say });

    host.appendChild(root);

    var formMode = null; // { kind: 'create' } | { kind: 'rename', id }

    function paintBranchSelect() {
      branchSel.innerHTML = '';
      var nw = document.createElement('option');
      nw.value = 'new';
      nw.textContent = t('pm.newBranch', 'New branch');
      branchSel.appendChild(nw);
      var ext = document.createElement('option');
      ext.value = 'external';
      ext.textContent = t('pm.addExternal', 'Add an existing folder (outside Aria)\u2026');
      branchSel.appendChild(ext);
      (st.branches || []).forEach(function (b) {
        if (b.builtIn) return; // built-in roots (Default, Local Browser) do not take new profiles
        if (b.external) return; // a folder from outside Aria: its profiles are what Chromium already has
        var op = document.createElement('option');
        op.value = b.id;
        op.textContent = (b.label && b.label !== b.id ? b.label + ' (' + b.id + ')' : b.id) + ' \u2014 ' + (b.profiles || []).length + ' ' + t('pm.profilesCount', 'profile(s)');
        branchSel.appendChild(op);
      });
    }

    function showForm(mode, initial) {
      formMode = mode;
      form.hidden = false;
      branchSel.hidden = branchHint.hidden = mode.kind !== 'create';
      if (mode.kind === 'create') paintBranchSelect();
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
      var lastBranch = null;
      st.profiles.forEach(function (p) {
        if (p.branchId && p.branchId !== lastBranch) {
          lastBranch = p.branchId;
          var bh = document.createElement('li');
          bh.className = 'pm-branch-head';
          bh.setAttribute('role', 'presentation');
          bh.setAttribute('data-branch', p.branchId);
          var bl = document.createElement('span');
          bl.className = 'pm-branch-label';
          bl.textContent = t('pm.branch', 'Branch') + ': ' + (p.branchLabel && p.branchLabel !== p.branchId ? p.branchLabel + ' (' + p.branchId + ')' : p.branchId);
          bh.appendChild(bl);
          var binfo = (st.branches || []).filter(function (b) { return b.id === p.branchId; })[0];
          if (binfo && !binfo.builtIn) {
            var bdel = document.createElement('button');
            bdel.type = 'button';
            bdel.className = 'btn btn-sm btn-ghost pm-branch-del';
            bdel.textContent = t('pm.deleteBranch', 'Delete branch');
            bdel.addEventListener('click', function () { void startDeleteBranch(binfo); });
            bh.appendChild(bdel);
          }
          list.appendChild(bh);
        }
        var li = document.createElement('li');
        li.className = 'pm-row is-' + p.status + (p.available ? '' : ' is-blocked') + (p.branchBusyWith ? ' is-branch-busy' : '');
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
        // The profile's own color: the same one Chromium shows in its window.
        if (p.color && /^#[0-9a-f]{6}$/i.test(p.color)) dot.style.setProperty('--pm-profile-color', p.color);
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
        var det = p.branchBusyWith
          ? t('pm.branchBusy', 'Waits: another profile of this branch is running') + ' (\u201c' + p.branchBusyWith.name + '\u201d).'
          : detailOf(p);
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
        // Deleting is per BRANCH (owner's model): see the branch header.
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
      var anyRestorable = ids.some(function (id) { var p = byId(id); return p && p.hold && p.hold.mine && p.browser && p.browser.open && p.lastSession && p.lastSession.tabs; });
      restoreBtn.disabled = busy || !anyRestorable;
      releaseBtn.disabled = busy || !anyMine;
      newBtn.disabled = busy;
    }

    function byId(id) {
      for (var i = 0; i < st.profiles.length; i++) if (st.profiles[i].id === id) return st.profiles[i];
      return null;
    }

    function refresh() {
      var branchesP = api.branches().then(function (b) { st.branches = b.branches || []; }, function () { /* list still works */ });
      return Promise.all([api.list(o.workflowId), branchesP]).then(function (all) {
        var d = all[0];
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
    function viewHref(r) {
      return r.viewPath + (r.viewPath.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' +
        encodeURIComponent((window.API && window.API.getKey) ? (window.API.getKey() || '') : '') +
        (o.workflowId ? '&workflowId=' + encodeURIComponent(o.workflowId) : '');
    }

    /**
     * Open the browsers of `ids` with the chosen launch settings. ONE viewer
     * tab for all of them (claimed HERE, in the click); each successful open
     * points it at that profile (the view raises its window). A refused or
     * failed profile is reported; the viewer is left alone if nothing opened
     * and it was a fresh blank tab, closed again.
     */
    function openProfiles(ids, launchOverride) {
      if (!ids.length || st.busy) return Promise.resolve([]);
      st.busy = 'open';
      paintActions();
      var launch = launchOverride !== undefined ? launchOverride : (launchUi ? launchUi.value() : null);
      var tab = claimViewer();
      var fresh = isBlankTab(tab);
      if (fresh) { try { tab.document.title = t('pm.opening', 'Opening\u2026'); } catch (e) { /* fine */ } }
      var results = [];
      var lastHref = '';
      return ids.reduce(function (chain, id) {
        return chain.then(function () {
          return api.open(id, o.workflowId, launch).then(function (r) {
            lastHref = viewHref(r);
            // The shared viewer follows the latest opened profile (its window
            // is raised server-side); the others stay on the same desktop.
            if (o.openView) o.openView(lastHref, tab); else showInViewer(tab, lastHref);
            if (r.settingsApplied === false) say((byId(id) ? byId(id).name + ': ' : '') + t('pm.settingsNotApplied', 'The browser was already open and in use, so it kept its current launch settings.'), false);
            results.push({ id: id, ok: true });
          }, function (e) {
            var p = byId(id);
            var b = e.body || {};
            var msg = e.message || t('pm.openFailed', 'Could not open the browser.');
            if (b.code === 'needs_confirmation') msg = t('pm.confirmFlags', 'Confirm the risky launch flags in Launch settings first.') + ' ' + msg;
            if (b.code === 'branch_busy' && b.viewPath) {
              // Bring the running profile of the branch to the front instead.
              var showHref = viewHref({ viewPath: b.viewPath });
              if (o.openView) o.openView(showHref, tab); else showInViewer(tab, showHref);
              results.push({ id: id, ok: false, shownInstead: b.runningProfile ? b.runningProfile.id : null, code: b.code });
              say((p ? p.name + ': ' : '') + msg, true);
              return;
            }
            say((p ? p.name + ': ' : '') + msg, true);
            if (launchUi && b.launch) launchUi.showResult(b.launch);
            results.push({ id: id, ok: false, error: e.message, code: b.code });
          });
        });
      }, Promise.resolve()).then(function () {
        st.busy = '';
        if (!results.some(function (r) { return r.ok; }) && fresh) { try { tab.close(); } catch (x) { /* fine */ } }
        if (results.some(function (r) { return r.ok; })) startHoldRefresh();
        return refresh().then(function () { return results; });
      });
    }

    function createProfile(name) {
      st.busy = 'create';
      paintActions();
      // Claim the shared viewer NOW (inside the submit gesture): the open that
      // follows a successful create would be blocked as a popup otherwise.
      var tab = claimViewer();
      var fresh = isBlankTab(tab);
      var launch = launchUi ? launchUi.value() : null;
      var branchId = branchSel.value || 'new';
      return api.createIn(name, branchId, o.workflowId).then(function (d) {
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
          return api.open(p.id, o.workflowId, launch).then(function (r) {
            var href = viewHref(r);
            if (o.openView) o.openView(href, tab); else showInViewer(tab, href);
            st.busy = '';
            startHoldRefresh();
            say(t('pm.createdOpened', 'Profile created and its browser opened.'), false);
            return refresh();
          }, function (e) {
            // Only a blank tab this click created is closed; a viewer already
            // showing other browsers is never taken away.
            if (fresh) { try { tab.close(); } catch (x) { /* fine */ } }
            st.busy = '';
            // The profile is KEPT; Open can be pressed again.
            say(t('pm.createdNotOpened', 'Profile created, but its browser did not open') + ': ' + (e.message || '') + ' ' + t('pm.tryOpenAgain', 'Press Open browser to try again.'), true);
            return refresh();
          });
        });
      }, function (e) {
        if (fresh) { try { tab.close(); } catch (x) { /* fine */ } }
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

    /** Section 8: dependency scan -> blocking alert, or a warning with a 3-second hold. */
    var dlg = document.createElement('div');
    dlg.className = 'pm-dialog';
    dlg.hidden = true;
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-modal', 'true');
    root.appendChild(dlg);

    function closeDialog() { dlg.hidden = true; dlg.innerHTML = ''; }

    function line(parent, text, cls) {
      var el = document.createElement('p');
      if (cls) el.className = cls;
      el.textContent = text;
      parent.appendChild(el);
      return el;
    }

    function showBlocked(scan) {
      dlg.innerHTML = '';
      dlg.hidden = false;
      line(dlg, t('pm.delBlockedTitle', 'This branch cannot be deleted yet') + ': ' + scan.label, 'pm-dialog-title');
      (scan.runningProfiles || []).forEach(function (r) {
        line(dlg, '\u25b6 \u201c' + r.name + '\u201d ' + t('pm.delRunning', 'is running. Stop it first.'), 'pm-dialog-row is-running');
      });
      (scan.blockingWorkflows || []).forEach(function (w) {
        var row = line(dlg, '\u26a0 ' + t('pm.delUsedBy', 'Workflow') + ' \u201c' + w.name + '\u201d (' + t('pm.wfState.' + w.state, w.state) + ') ' +
          t('pm.delUses', 'uses profile') + ' \u201c' + w.profileName + '\u201d.' +
          (w.state === 'running' ? ' ' + t('pm.delStopFirst', 'It is running: stop it first; a new profile applies to its next run only.') : ''), 'pm-dialog-row');
        var re = document.createElement('button');
        re.type = 'button';
        re.className = 'btn btn-sm btn-ghost pm-reassign';
        re.textContent = t('pm.reassign', 'Reassign profile');
        re.addEventListener('click', function () {
          closeDialog();
          if (o.onReassign) o.onReassign(w.workflowId, w.profileId);
          else say(t('pm.reassignHow', 'Open the workflow\u2019s Settings and choose a profile from another branch.') + ' (' + w.name + ')', false);
        });
        row.appendChild(re);
      });
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'btn btn-sm btn-subtle';
      c.textContent = t('wfm.close', 'Close');
      c.addEventListener('click', closeDialog);
      dlg.appendChild(c);
    }

    function showConfirm(scan, branch) {
      dlg.innerHTML = '';
      dlg.hidden = false;
      line(dlg, t('pm.delTitle', 'Delete branch') + ' \u201c' + scan.label + '\u201d?', 'pm-dialog-title');
      line(dlg, (scan.profiles || []).length + ' ' + t('pm.delProfiles', 'profile(s) will be deleted') + ': ' +
        (scan.profiles || []).map(function (p) { return p.name; }).join(', '), 'pm-dialog-row');
      if ((scan.inactiveWorkflows || []).length) {
        line(dlg, t('pm.delInactive', 'Inactive workflows that will lose their profile (state: profile missing)') + ': ' +
          scan.inactiveWorkflows.map(function (w) { return w.name; }).join(', '), 'pm-dialog-row');
      }
      if (branch.external) line(dlg, t('pm.delExternal', 'This folder was added from outside Aria: it is only removed from Aria, its data on disk is kept.'), 'pm-dialog-warn');
      else line(dlg, t('pm.delPermanent', 'All data in this branch (cookies, logins, browser data) is deleted permanently. There is no recycle bin.'), 'pm-dialog-warn');
      line(dlg, t('pm.delHoldHint', 'Press and hold the button (or hold Enter / Space) for 3 seconds.'), 'pm-dialog-hint');
      var hb = holdButton(t('pm.delHold', 'Hold to delete'), DELETE_HOLD_MS, function () {
        // At the end of the hold the server scans AGAIN: anything that started
        // during the hold cancels the deletion and shows the blocking alert.
        return api.deleteBranch(branch.id).then(function (r) {
          closeDialog();
          say(t('pm.branchDeleted', 'Branch deleted.') + (r.profileMissing && r.profileMissing.length ? ' ' + t('pm.delMissingNow', 'Workflows now missing a profile') + ': ' + r.profileMissing.length : ''), false);
          return refresh();
        }, function (e) {
          var b = e.body || {};
          if (b.scan) showBlocked(b.scan); else say(e.message || t('pm.deleteFailed', 'Could not delete the branch.'), true);
        });
      });
      dlg.appendChild(hb.el);
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'btn btn-sm btn-subtle';
      c.textContent = t('wfm.cancel', 'Cancel');
      c.addEventListener('click', closeDialog);
      dlg.appendChild(c);
      try { hb.el.focus(); } catch (x) { /* jsdom */ }
      st.holdButton = hb;
    }

    function startDeleteBranch(branch) {
      return api.deletionScan(branch.id).then(function (d) {
        var scan = d.scan;
        if (!scan.deletable) showBlocked(scan); else showConfirm(scan, branch);
      }, function (e) { say(e.message || t('pm.deleteFailed', 'Could not delete the branch.'), true); });
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
    // "Add an existing folder (outside Aria)": never silent (section 4).
    // Step 1 reads the folder (nothing changes) and shows every warning;
    // step 2 is a SEPARATE confirmation that repeats the exact folder.
    branchSel.addEventListener('change', function () {
      if (branchSel.value !== 'external') return;
      branchSel.value = 'new';
      void startAddExternal();
    });
    function startAddExternal() {
      var root = (window.prompt ? window.prompt(t('pm.extPrompt', 'Full path of an existing Chromium data folder (the folder that contains "Local State"):'), '') : '') || '';
      root = String(root).trim();
      if (!root) return Promise.resolve(null);
      return api.inspectExternal(root).then(function (r) {
        var ins = r.inspection || {};
        dlg.innerHTML = '';
        dlg.hidden = false;
        dlg.setAttribute('data-kind', 'external');
        line(dlg, t('pm.extTitle', 'Add a folder from outside Aria?'), 'pm-dialog-title');
        line(dlg, ins.root || root, 'pm-dialog-row pm-ext-root');
        if ((ins.profiles || []).length) {
          line(dlg, t('pm.extProfiles', 'Chromium profiles found') + ': ' + ins.profiles.map(function (p) { return (p.chromiumName || p.folder) + ' (' + p.folder + ')'; }).join(', '), 'pm-dialog-row');
        }
        (ins.errors || []).forEach(function (m) { line(dlg, m, 'pm-dialog-warn pm-ext-error'); });
        (ins.warnings || []).forEach(function (m) { line(dlg, m, 'pm-dialog-warn pm-ext-warning'); });
        if (!(ins.errors || []).length) {
          var confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'btn btn-sm btn-danger pm-ext-confirm';
          confirmBtn.textContent = t('pm.extConfirm', 'I understand \u2014 add this folder');
          confirmBtn.addEventListener('click', function () {
            confirmBtn.disabled = true;
            api.addExternal(ins.root, ins.root).then(function (d) {
              closeDialog();
              say(t('pm.extAdded', 'Folder added as a branch') + ': ' + (d.branch ? d.branch.id : ''), false);
              return refresh();
            }, function (e) { confirmBtn.disabled = false; say(e.message, true); });
          });
          dlg.appendChild(confirmBtn);
        }
        var c = document.createElement('button');
        c.type = 'button';
        c.className = 'btn btn-sm btn-subtle';
        c.textContent = t('wfm.close', 'Close');
        c.addEventListener('click', closeDialog);
        dlg.appendChild(c);
        return ins;
      }, function (e) { say(e.message, true); return null; });
    }

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
    restoreBtn.addEventListener('click', function () {
      void each(function (id) {
        return api.restore(id, o.workflowId).then(function (r) { say(t('pm.restored', 'Tabs restored') + ': ' + (r.restored || 0), false); });
      }, selectedIds().filter(function (id) { var p = byId(id); return p && p.lastSession && p.lastSession.tabs; }));
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
      startDeleteBranch: startDeleteBranch,
      destroy: function () {
        st.destroyed = true;
        if (st.timer) clearInterval(st.timer);
        if (st.holdTimer) clearInterval(st.holdTimer);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  window.ProfileManager = {
    api: api, mount: mount, detailOf: detailOf, overlapText: overlapText, holdButton: holdButton, DELETE_HOLD_MS: DELETE_HOLD_MS,
    mountLaunchSettings: mountLaunchSettings, viewer: { name: VIEWER_NAME, claim: claimViewer, show: showInViewer, isBlank: isBlankTab }
  };
})();
