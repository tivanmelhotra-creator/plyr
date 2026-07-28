/* ============================================
   Views — Run / Jobs / Job detail / Quota / Schedules / Admin.
   Step 8: build/run/monitor jobs + quota + schedules + admin.
   Exposes window.Views.{ render, stopAll }.
   ============================================ */
(function () {
  'use strict';

  var API = window.API;
  // AppUtil is defined by app.js, which loads AFTER this file. Resolve it
  // lazily at call time (never capture it at script-load time, or it'd be undefined).
  function U() { return window.AppUtil; }

  // active interval handles per view, cleared on navigation
  var timers = [];
  function track(id) { timers.push(id); return id; }
  function stopAll() {
    timers.forEach(function (id) { clearInterval(id); });
    timers = [];
    // tear down the visual editor's window-level listeners when leaving the view
    if (window.FlowEditor && typeof window.FlowEditor.unmount === 'function') {
      try { window.FlowEditor.unmount(); } catch (e) { /* noop */ }
    }
    // close any active live (WebSocket/SSE) connection when leaving the view
    if (window.LiveView && typeof window.LiveView.stop === 'function') {
      try { window.LiveView.stop(); } catch (e) { /* noop */ }
    }
    // close the interactive Live Browser View socket when leaving (Step 12)
    if (window.BrowserView && typeof window.BrowserView.stop === 'function') {
      try { window.BrowserView.stop(); } catch (e) { /* noop */ }
    }
    // Step 26: tear down the bottom run/log drawer when leaving the editor
    // (the panel is editor-scoped; persisted last-run survives in localStorage).
    if (window.RunPanel && typeof window.RunPanel.unmount === 'function') {
      try { window.RunPanel.unmount(); } catch (e) { /* noop */ }
    }
  }

  function t(k) { return U().t(k); }
  function esc(s) { return U().esc(s); }

  // Inline SVG icons (public/js/icons.js). IC() is for chrome glyphs, ICON() for
  // ACTION_CATALOG actions. Emoji were replaced project-wide because the target
  // font stack has no emoji coverage — they rendered as empty boxes (□).
  function IC(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : '';
  }

  function effectiveUserId() {
    var uid = API.getUserId();
    // env_root (admin key) is not a real automation user; default to "0".
    if (!uid || uid === 'env_root') return '0';
    return uid;
  }

  // ---------------------------------------------
  // Action catalog for the flow builder.
  // Each action lists the param fields it needs.
  // ---------------------------------------------
  // Shared catalog (public/js/actions.js → window.ACTION_CATALOG).
  // Falls back to a minimal inline list if the catalog failed to load.
  var CAT = window.ACTION_CATALOG || {
    ACTIONS: [{ id: 'goto', fields: [{ k: 'url', label: 'p.url', type: 'text', ph: 'https://example.com' }] }],
    actionById: function (id) { return this.ACTIONS[0]; },
  };
  var ACTIONS = CAT.ACTIONS;
  function actionById(id) { return CAT.actionById(id); }

  // =============================================
  // RUN / FLOW BUILDER
  // =============================================
  // in-memory steps for the builder: [{ action, params:{} }]
  var builderSteps = [];

  function renderRun(root) {
    if (builderSteps.length === 0) {
      builderSteps = [{ action: 'goto', params: { url: 'https://example.com' } }];
    }
    var uid = effectiveUserId();

    root.innerHTML =
      '<div class="card">' +
        '<h3 class="card-title">' + IC('play') + ' ' + t('run.title') + '</h3>' +
        '<div class="form-row">' +
          '<label class="field">' +
            '<span class="field-label">' + t('run.userId') + '</span>' +
            '<input id="run-userid" class="field-input" value="' + esc(uid) + '" />' +
            '<span class="field-hint">' + t('run.userIdHint') + '</span>' +
          '</label>' +
          '<label class="field">' +
            '<span class="field-label">' + t('run.webhook') + '</span>' +
            '<input id="run-webhook" class="field-input" placeholder="https://..." />' +
          '</label>' +
        '</div>' +
        '<label class="checkbox-field" style="margin-bottom:16px">' +
          '<input type="checkbox" id="run-headless" checked /> <span>' + t('run.headless') + '</span>' +
        '</label>' +

        '<div class="toolbar">' +
          '<strong>' + t('run.steps') + '</strong>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-ghost btn-sm" id="run-example">' + t('run.loadExample') + '</button>' +
          '<button class="btn btn-ghost btn-sm" id="run-clear">' + t('run.clearAll') + '</button>' +
          '<button class="btn btn-sm" id="run-add">+ ' + t('run.addStep') + '</button>' +
        '</div>' +
        '<div class="steps-list" id="steps-list"></div>' +

        '<div class="toolbar" style="margin-top:6px">' +
          '<button class="btn btn-primary" id="run-submit">' + t('run.submit') + '</button>' +
        '</div>' +
        '<div id="run-result"></div>' +
      '</div>';

    renderStepsList(root);

    root.querySelector('#run-add').addEventListener('click', function () {
      builderSteps.push({ action: 'goto', params: {} });
      renderStepsList(root);
    });
    root.querySelector('#run-clear').addEventListener('click', function () {
      builderSteps = [];
      renderStepsList(root);
    });
    root.querySelector('#run-example').addEventListener('click', function () {
      builderSteps = [
        { action: 'goto', params: { url: 'https://example.com' } },
        { action: 'wait', params: { ms: '1000' } },
        { action: 'extract', params: { selector: 'h1', name: 'title' } },
        { action: 'screenshot', params: {} },
      ];
      renderStepsList(root);
    });
    root.querySelector('#run-submit').addEventListener('click', function () { submitFlow(root); });
  }

  function renderStepsList(root) {
    var list = root.querySelector('#steps-list');
    if (!list) return;
    if (builderSteps.length === 0) {
      list.innerHTML = '<div class="placeholder">' + t('run.noSteps') + '</div>';
      return;
    }
    var html = '';
    builderSteps.forEach(function (step, idx) {
      var act = actionById(step.action);
      var opts = ACTIONS.map(function (a) {
        return '<option value="' + a.id + '"' + (a.id === step.action ? ' selected' : '') + '>' + a.id + '</option>';
      }).join('');

      // `internal: true` fields (e.g. the Condition Builder's `groups` JSON blob)
      // are edited by their bespoke NDV only — never as a raw text input here.
      var params = act.fields.filter(function (f) { return !f.internal; }).map(function (f) {
        var val = step.params[f.k] != null ? String(step.params[f.k]) : '';
        if (f.type === 'select') {
          var o = f.options.map(function (op) {
            return '<option value="' + op + '"' + (op === val ? ' selected' : '') + '>' + op + '</option>';
          }).join('');
          return '<label class="field"><span class="field-label">' + t(f.label) + '</span>' +
            '<select class="field-input" data-step="' + idx + '" data-key="' + f.k + '">' + o + '</select></label>';
        }
        return '<label class="field"><span class="field-label">' + t(f.label) + '</span>' +
          '<input class="field-input" type="' + (f.type === 'number' ? 'number' : 'text') + '" ' +
          'data-step="' + idx + '" data-key="' + f.k + '" value="' + esc(val) + '" ' +
          'placeholder="' + esc(f.ph || '') + '" /></label>';
      }).join('');

      html +=
        '<div class="step-item">' +
          '<div class="step-head">' +
            '<span class="step-index">' + (idx + 1) + '</span>' +
            '<select class="field-input" data-action="' + idx + '">' + opts + '</select>' +
            '<span class="spacer"></span>' +
            '<button class="icon-btn" data-up="' + idx + '" title="' + t('run.moveUp') + '">' + IC('arrow-up', 14) + '</button>' +
            '<button class="icon-btn" data-down="' + idx + '" title="' + t('run.moveDown') + '">' + IC('arrow-down', 14) + '</button>' +
            '<button class="icon-btn" data-del="' + idx + '" title="' + t('run.removeStep') + '">' + IC('trash', 14) + '</button>' +
          '</div>' +
          (params ? '<div class="step-params">' + params + '</div>' : '') +
        '</div>';
    });
    list.innerHTML = html;

    // action change
    list.querySelectorAll('select[data-action]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var i = parseInt(sel.getAttribute('data-action'), 10);
        builderSteps[i].action = sel.value;
        builderSteps[i].params = {};
        renderStepsList(root);
      });
    });
    // param inputs
    list.querySelectorAll('[data-step]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var i = parseInt(inp.getAttribute('data-step'), 10);
        builderSteps[i].params[inp.getAttribute('data-key')] = inp.value;
      });
      inp.addEventListener('change', function () {
        var i = parseInt(inp.getAttribute('data-step'), 10);
        builderSteps[i].params[inp.getAttribute('data-key')] = inp.value;
      });
    });
    // controls
    list.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        builderSteps.splice(parseInt(b.getAttribute('data-del'), 10), 1);
        renderStepsList(root);
      });
    });
    list.querySelectorAll('[data-up]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = parseInt(b.getAttribute('data-up'), 10);
        if (i > 0) { var s = builderSteps.splice(i, 1)[0]; builderSteps.splice(i - 1, 0, s); renderStepsList(root); }
      });
    });
    list.querySelectorAll('[data-down]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = parseInt(b.getAttribute('data-down'), 10);
        if (i < builderSteps.length - 1) { var s = builderSteps.splice(i, 1)[0]; builderSteps.splice(i + 1, 0, s); renderStepsList(root); }
      });
    });
  }

  // Convert builder steps -> API step format, coercing numbers.
  function buildPayloadSteps() {
    return builderSteps.map(function (s) {
      var params = {};
      var act = actionById(s.action);
      act.fields.forEach(function (f) {
        var v = s.params[f.k];
        if (v === undefined || v === '') return;
        if (f.type === 'number') {
          var n = parseInt(v, 10);
          if (!isNaN(n)) params[f.k] = n;
        } else {
          params[f.k] = v;
        }
      });
      return { action: s.action, params: params };
    });
  }

  function submitFlow(root) {
    var uid = (root.querySelector('#run-userid').value || '').trim();
    var webhook = (root.querySelector('#run-webhook').value || '').trim();
    var headless = root.querySelector('#run-headless').checked;
    var resultEl = root.querySelector('#run-result');

    if (!uid) { U().toast(t('run.needUserId'), 'error'); return; }
    if (builderSteps.length === 0) { U().toast(t('run.needStep'), 'error'); return; }

    var payload = { userId: uid, steps: buildPayloadSteps(), headless: headless };
    if (webhook) payload.webhookUrl = webhook;

    var btn = root.querySelector('#run-submit');
    btn.disabled = true;
    btn.textContent = t('run.submitting');
    resultEl.innerHTML = '';

    API.runFlow(payload)
      .then(function (data) {
        resultEl.innerHTML =
          '<div class="result-banner ok">' + IC('check-circle') + ' ' + t('run.queued') +
          ' &nbsp; ' + t('run.jobId') + ': <code>' + esc(data.jobId) + '</code> ' +
          '<button class="btn btn-ghost btn-sm" id="goto-job" data-job="' + esc(data.jobId) +
          '">' + t('run.viewJob') + '</button></div>';
        var g = resultEl.querySelector('#goto-job');
        if (g) g.addEventListener('click', function () {
          location.hash = '#/jobs?job=' + encodeURIComponent(data.jobId) + '&user=' + encodeURIComponent(uid);
        });
      })
      .catch(function (err) {
        resultEl.innerHTML = '<div class="result-banner err">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = t('run.submit');
      });
  }

  // =============================================
  // JOBS LIST + DETAIL
  // =============================================
  function stateBadge(state) {
    var key = 'state.' + (state || 'unknown');
    var cls = 'state-' + (state || 'unknown');
    return '<span class="state-badge ' + cls + '">' + t(key) + '</span>';
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(U().lang() === 'fa' ? 'fa-IR' : 'en-US'); }
    catch (e) { return iso; }
  }

  function parseHashQuery() {
    var h = location.hash || '';
    var q = h.indexOf('?') !== -1 ? h.substring(h.indexOf('?') + 1) : '';
    var out = {};
    q.split('&').forEach(function (pair) {
      if (!pair) return;
      var kv = pair.split('=');
      out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }

  function renderJobs(root) {
    var qp = parseHashQuery();
    if (qp.job) { renderJobDetail(root, qp.user || effectiveUserId(), qp.job); return; }

    var uid = effectiveUserId();
    root.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<h3 class="card-title" style="margin:0">' + IC('layers') + ' ' + t('jobs.title') + '</h3>' +
          '<span class="spacer"></span>' +
          '<input id="jobs-uid" class="field-input" style="max-width:160px" value="' + esc(uid) + '" />' +
          '<button class="btn btn-ghost btn-sm" id="jobs-refresh">' + t('jobs.refresh') + '</button>' +
        '</div>' +
        '<div id="jobs-body"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</div>';

    function load() {
      var u = (root.querySelector('#jobs-uid').value || '').trim() || uid;
      var body = root.querySelector('#jobs-body');
      API.listJobs(u, 50)
        .then(function (data) {
          var jobs = data.jobs || [];
          if (jobs.length === 0) {
            body.innerHTML = '<div class="placeholder">' + t('jobs.empty') + '</div>';
            return;
          }
          var rows = jobs.map(function (j) {
            return '<tr>' +
              '<td class="mono">' + esc(j.jobId) + '</td>' +
              '<td>' + stateBadge(j.state) + '</td>' +
              '<td>' + esc(fmtTime(j.timestamp)) + '</td>' +
              '<td><div class="row-actions">' +
                '<button class="btn btn-ghost btn-sm" data-view="' + esc(j.jobId) + '">' + t('jobs.view') + '</button>' +
                (['waiting', 'delayed', 'active'].indexOf(j.state) !== -1 ?
                  '<button class="btn btn-ghost btn-sm" data-cancel="' + esc(j.jobId) + '">' + t('jobs.cancel') + '</button>' : '') +
              '</div></td>' +
            '</tr>';
          }).join('');
          body.innerHTML =
            '<div class="table-wrap"><table class="data"><thead><tr>' +
            '<th>' + t('jobs.id') + '</th><th>' + t('jobs.state') + '</th><th>' + t('jobs.time') + '</th><th>' + t('jobs.actions') + '</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';

          body.querySelectorAll('[data-view]').forEach(function (b) {
            b.addEventListener('click', function () {
              location.hash = '#/jobs?job=' + encodeURIComponent(b.getAttribute('data-view')) + '&user=' + encodeURIComponent(u);
            });
          });
          body.querySelectorAll('[data-cancel]').forEach(function (b) {
            b.addEventListener('click', function () {
              API.cancelJob(u, b.getAttribute('data-cancel'))
                .then(function () { U().toast(t('jobs.cancelled'), 'success'); load(); })
                .catch(function (err) { U().toast(err.message, 'error'); });
            });
          });
        })
        .catch(function (err) {
          body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
        });
    }

    root.querySelector('#jobs-refresh').addEventListener('click', load);
    load();
    track(setInterval(load, 8000));
  }

  function renderJobDetail(root, userId, jobId) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<h3 class="card-title" style="margin:0">' + IC('file-text') + ' ' + t('jobs.detail') + '</h3>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-ghost btn-sm" id="job-back">' + IC('chevron-left', 14) + ' ' + t('jobs.back') + '</button>' +
        '</div>' +
        '<div id="job-body"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</div>';

    root.querySelector('#job-back').addEventListener('click', function () {
      location.hash = '#/jobs';
    });

    function load() {
      var body = root.querySelector('#job-body');
      API.getJob(userId, jobId)
        .then(function (data) {
          var state = data.state || (data.success === false ? 'failed' : 'completed');
          var live = state === 'active';
          var outputs = data.stepOutputs || data.outputs || [];

          var meta =
            '<dl class="kv">' +
              '<dt>' + t('run.jobId') + '</dt><dd class="mono">' + esc(jobId) + '</dd>' +
              '<dt>' + t('jobs.state') + '</dt><dd>' + stateBadge(state) + '</dd>' +
              (data.progress != null ? '<dt>' + t('jobs.progress') + '</dt><dd>' + esc(data.progress) + '%</dd>' : '') +
              (data.durationMs != null ? '<dt>' + t('jobs.duration') + '</dt><dd>' + (Math.round(data.durationMs / 100) / 10) + 's</dd>' : '') +
            '</dl>';

          var liveNote = live ? '<div class="result-banner ok">' + IC('clock') + ' ' + t('jobs.live') + '</div>' : '';

          var outHtml;
          if (!outputs || outputs.length === 0) {
            outHtml = '<div class="placeholder">' + t('jobs.noOutput') + '</div>';
          } else {
            outHtml = '<div class="json-block">' + esc(JSON.stringify(outputs, null, 2)) + '</div>';
          }

          var resultHtml = '';
          if (data.result || data.message || data.error) {
            var r = data.result || { message: data.message, error: data.error };
            resultHtml = '<h4 class="section-title">' + t('jobs.result') + '</h4>' +
              '<div class="json-block">' + esc(JSON.stringify(r, null, 2)) + '</div>';
          }

          body.innerHTML = liveNote + meta +
            '<h4 class="section-title">' + t('jobs.output') + '</h4>' + outHtml + resultHtml;

          if (!live) stopAll();
        })
        .catch(function (err) {
          body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
        });
    }

    load();
    track(setInterval(load, 3000));
  }

  // =============================================
  // QUOTA
  // =============================================
  function renderQuota(root) {
    var uid = effectiveUserId();
    root.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<h3 class="card-title" style="margin:0">' + IC('gauge') + ' ' + t('quota.title') + '</h3>' +
          '<span class="spacer"></span>' +
          '<input id="q-uid" class="field-input" style="max-width:160px" value="' + esc(uid) + '" />' +
          '<button class="btn btn-ghost btn-sm" id="q-refresh">' + t('common.refresh') + '</button>' +
        '</div>' +
        '<div id="q-body"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</div>';

    function load() {
      var u = (root.querySelector('#q-uid').value || '').trim() || uid;
      var body = root.querySelector('#q-body');
      API.getQuota(u)
        .then(function (data) {
          var p = data.plan || {};
          var usg = data.usage || {};
          var rem = usg.unlimited ? t('quota.unlimited') : (usg.remainingMinutes + ' ' + t('common.minutes'));
          var lim = usg.unlimited ? t('quota.unlimited') : (usg.limitMinutes + ' ' + t('common.minutes'));
          body.innerHTML =
            '<div class="grid grid-cards">' +
              '<div class="card"><h3 class="card-title">' + t('quota.plan') + '</h3><dl class="kv">' +
                '<dt>' + t('quota.level') + '</dt><dd>' + U().num(p.level) + '</dd>' +
                '<dt>' + t('quota.type') + '</dt><dd>' + esc(data.userType) + '</dd>' +
                '<dt>' + t('quota.subscription') + '</dt><dd>' + esc(p.subscription) + '</dd>' +
                '<dt>' + t('quota.priority') + '</dt><dd>' + U().num(p.priority) + '</dd>' +
                '<dt>' + t('quota.maxTabs') + '</dt><dd>' + U().num(p.maxTabs) + '</dd>' +
                '<dt>' + t('quota.maxSteps') + '</dt><dd>' + U().num(p.maxSteps) + '</dd>' +
                '<dt>' + t('quota.maxSchedules') + '</dt><dd>' + U().num(p.maxSchedules) + '</dd>' +
              '</dl></div>' +
              '<div class="card"><h3 class="card-title">' + t('quota.usage') + '</h3><dl class="kv">' +
                '<dt>' + t('quota.used') + '</dt><dd>' + U().num(usg.usedMinutes) + ' ' + t('common.minutes') + '</dd>' +
                '<dt>' + t('quota.remaining') + '</dt><dd>' + esc(rem) + '</dd>' +
                '<dt>' + t('quota.limit') + '</dt><dd>' + esc(lim) + '</dd>' +
              '</dl></div>' +
            '</div>';
        })
        .catch(function (err) {
          body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
        });
    }
    root.querySelector('#q-refresh').addEventListener('click', load);
    load();
  }

  // =============================================
  // SCHEDULES
  // =============================================
  function renderSchedules(root) {
    var uid = effectiveUserId();
    root.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<h3 class="card-title" style="margin:0">' + IC('calendar') + ' ' + t('sched.title') + '</h3>' +
          '<span class="spacer"></span>' +
          '<input id="s-uid" class="field-input" style="max-width:160px" value="' + esc(uid) + '" />' +
          '<button class="btn btn-ghost btn-sm" id="s-refresh">' + t('common.refresh') + '</button>' +
        '</div>' +
        '<div id="s-body"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</div>';

    function load() {
      var u = (root.querySelector('#s-uid').value || '').trim() || uid;
      var body = root.querySelector('#s-body');
      API.listSchedules(u)
        .then(function (data) {
          var list = data.schedules || [];
          var head = '<div class="muted" style="margin-bottom:12px">' + t('sched.count') + ': ' +
            U().num(data.count) + ' / ' + U().num(data.limit) + '</div>';
          if (list.length === 0) {
            body.innerHTML = head + '<div class="placeholder">' + t('sched.empty') + '</div>';
            return;
          }
          var rows = list.map(function (s) {
            return '<tr>' +
              '<td>' + esc(s.name) + '</td>' +
              '<td class="mono">' + esc(s.cron) + '</td>' +
              '<td>' + esc(fmtTime(s.nextRun)) + '</td>' +
              '<td>' + esc(s.timezone) + '</td>' +
              '<td><button class="btn btn-ghost btn-sm" data-del="' + esc(s.key) + '">' + t('common.delete') + '</button></td>' +
            '</tr>';
          }).join('');
          body.innerHTML = head +
            '<div class="table-wrap"><table class="data"><thead><tr>' +
            '<th>' + t('sched.name') + '</th><th>' + t('sched.cron') + '</th><th>' + t('sched.next') + '</th>' +
            '<th>' + t('sched.tz') + '</th><th>' + t('sched.actions') + '</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';

          body.querySelectorAll('[data-del]').forEach(function (b) {
            b.addEventListener('click', function () {
              if (!confirm(t('sched.confirmDelete'))) return;
              API.deleteSchedule(u, b.getAttribute('data-del'))
                .then(function () { U().toast(t('sched.deleted'), 'success'); load(); })
                .catch(function (err) { U().toast(err.message, 'error'); });
            });
          });
        })
        .catch(function (err) {
          body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
        });
    }
    root.querySelector('#s-refresh').addEventListener('click', load);
    load();
  }

  // =============================================
  // WORKFLOWS (Step 22 — multi-workflow library)
  // Card list backed by the real /workflows CRUD. Create / rename /
  // duplicate / delete / open-in-editor / version history + restore / run.
  // =============================================
  // When set, renderEditor() will open this workflow on next render.
  var pendingWorkflowToOpen = null;

  function renderWorkflows(root) {
    var uid = effectiveUserId();
    root.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<h3 class="card-title" style="margin:0">' + IC('book-open') + ' ' + t('wf.title') + '</h3>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-primary btn-sm" id="wf-new">＋ ' + t('wf.new') + '</button>' +
          '<button class="btn btn-ghost btn-sm" id="wf-templates">' + IC('sitemap', 14) + ' ' + t('wf.templates') + '</button>' +
          '<button class="btn btn-ghost btn-sm" id="wf-refresh">' + t('common.refresh') + '</button>' +
        '</div>' +
        '<p class="muted small">' + t('wf.subtitle') + '</p>' +
        '<div id="wf-templates-box" hidden></div>' +
        '<div id="wf-body"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</div>';

    function openInEditor(wf) {
      pendingWorkflowToOpen = wf;
      location.hash = '#/editor';
    }

    function load() {
      var body = root.querySelector('#wf-body');
      API.listWorkflows(uid)
        .then(function (data) {
          var list = (data && data.workflows) || [];
          var head = '<div class="muted" style="margin-bottom:12px">' +
            t('wf.count') + ': ' + U().num(list.length) + '</div>';
          if (list.length === 0) {
            body.innerHTML = head + '<div class="placeholder">' + t('wf.empty') + '</div>';
            return;
          }
          var cards = list.map(function (wf) {
            var steps = Array.isArray(wf.steps) ? wf.steps.length : 0;
            return '<div class="wf-card" data-id="' + esc(wf.id) + '">' +
              '<div class="wf-card-head">' +
                '<span class="wf-name">' + esc(wf.name) + '</span>' +
                '<span class="badge">v' + esc(String(wf.version)) + '</span>' +
              '</div>' +
              (wf.description ? '<div class="wf-desc muted small">' + esc(wf.description) + '</div>' : '') +
              '<div class="wf-meta muted small">' +
                '<span>' + steps + ' ' + t('wf.steps') + '</span> · ' +
                '<span>' + esc(t('wf.updated')) + ': ' + esc(fmtTime(wf.updatedAt)) + '</span>' +
              '</div>' +
              '<div class="wf-actions">' +
                '<button class="btn btn-primary btn-sm" data-open="' + esc(wf.id) + '">' + IC('pencil', 14) + ' ' + t('wf.open') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-run="' + esc(wf.id) + '">' + IC('play', 14) + ' ' + t('wf.run') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-rename="' + esc(wf.id) + '">' + t('wf.rename') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-dup="' + esc(wf.id) + '">' + t('wf.duplicate') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-versions="' + esc(wf.id) + '">' + IC('history', 14) + ' ' + t('wf.versions') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-del="' + esc(wf.id) + '">' + IC('trash', 14) + ' ' + t('common.delete') + '</button>' +
              '</div>' +
              '<div class="wf-versions" id="wf-ver-' + esc(wf.id) + '" hidden></div>' +
            '</div>';
          }).join('');
          body.innerHTML = head + '<div class="wf-grid">' + cards + '</div>';

          function find(id) {
            for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
            return null;
          }

          body.querySelectorAll('[data-open]').forEach(function (b) {
            b.addEventListener('click', function () {
              var wf = find(b.getAttribute('data-open'));
              if (wf) openInEditor(wf);
            });
          });
          body.querySelectorAll('[data-run]').forEach(function (b) {
            b.addEventListener('click', function () {
              var id = b.getAttribute('data-run');
              b.disabled = true;
              API.runWorkflow(uid, id, {})
                .then(function (d) {
                  U().toast(t('wf.queued') + ' ' + (d.jobId || ''), 'success');
                  location.hash = '#/jobs?job=' + encodeURIComponent(d.jobId) +
                    '&user=' + encodeURIComponent(uid);
                })
                .catch(function (err) { U().toast(err.message, 'error'); })
                .then(function () { b.disabled = false; });
            });
          });
          body.querySelectorAll('[data-rename]').forEach(function (b) {
            b.addEventListener('click', function () {
              var wf = find(b.getAttribute('data-rename'));
              if (!wf) return;
              var name = prompt(t('wf.renamePrompt'), wf.name);
              if (name == null) return;
              name = String(name).trim();
              if (!name) { U().toast(t('wf.nameRequired'), 'error'); return; }
              API.updateWorkflow(uid, wf.id, {
                name: name, description: wf.description || null,
                steps: wf.steps, headless: wf.headless, webhookUrl: wf.webhookUrl
              })
                .then(function () { U().toast(t('wf.renamed'), 'success'); load(); })
                .catch(function (err) { U().toast(err.message, 'error'); });
            });
          });
          body.querySelectorAll('[data-dup]').forEach(function (b) {
            b.addEventListener('click', function () {
              var wf = find(b.getAttribute('data-dup'));
              if (!wf) return;
              API.createWorkflow(uid, {
                name: wf.name + ' ' + t('wf.copySuffix'),
                description: wf.description || null,
                steps: wf.steps, headless: wf.headless, webhookUrl: wf.webhookUrl
              })
                .then(function () { U().toast(t('wf.duplicated'), 'success'); load(); })
                .catch(function (err) { U().toast(err.message, 'error'); });
            });
          });
          body.querySelectorAll('[data-del]').forEach(function (b) {
            b.addEventListener('click', function () {
              if (!confirm(t('wf.confirmDelete'))) return;
              API.deleteWorkflow(uid, b.getAttribute('data-del'))
                .then(function () { U().toast(t('wf.deleted'), 'success'); load(); })
                .catch(function (err) { U().toast(err.message, 'error'); });
            });
          });
          body.querySelectorAll('[data-versions]').forEach(function (b) {
            b.addEventListener('click', function () {
              var id = b.getAttribute('data-versions');
              var box = body.querySelector('#wf-ver-' + cssId(id));
              if (!box) return;
              if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
              box.hidden = false;
              box.innerHTML = '<div class="muted small"><span class="spinner"></span> ' + t('common.loading') + '</div>';
              API.listWorkflowVersions(uid, id)
                .then(function (data) {
                  var vers = (data && data.versions) || [];
                  if (!vers.length) { box.innerHTML = '<div class="muted small">' + t('wf.noVersions') + '</div>'; return; }
                  box.innerHTML = vers.map(function (v) {
                    var n = Array.isArray(v.steps) ? v.steps.length : 0;
                    return '<div class="wf-ver-row">' +
                      '<span class="badge">v' + esc(String(v.version)) + '</span> ' +
                      '<span class="muted small">' + esc(fmtTime(v.savedAt)) + ' · ' + n + ' ' + t('wf.steps') + '</span> ' +
                      '<button class="btn btn-ghost btn-sm" data-restore="' + esc(id) + '" data-v="' + esc(String(v.version)) + '">' + t('wf.restore') + '</button>' +
                    '</div>';
                  }).join('');
                  box.querySelectorAll('[data-restore]').forEach(function (rb) {
                    rb.addEventListener('click', function () {
                      var wid = rb.getAttribute('data-restore');
                      var vnum = parseInt(rb.getAttribute('data-v'), 10);
                      var snap = null;
                      for (var i = 0; i < vers.length; i++) if (vers[i].version === vnum) snap = vers[i];
                      if (!snap) return;
                      if (!confirm(t('wf.confirmRestore'))) return;
                      // Restore = save the snapshot as a NEW current version (PUT bumps version).
                      API.updateWorkflow(uid, wid, {
                        name: snap.name, description: snap.description || null,
                        steps: snap.steps, headless: snap.headless, webhookUrl: snap.webhookUrl
                      })
                        .then(function () { U().toast(t('wf.restored'), 'success'); load(); })
                        .catch(function (err) { U().toast(err.message, 'error'); });
                    });
                  });
                })
                .catch(function (err) { box.innerHTML = '<div class="muted small">' + IC('alert-circle', 13) + ' ' + esc(err.message) + '</div>'; });
            });
          });
        })
        .catch(function (err) {
          body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
        });
    }

    // Step 32: starter templates. A pure catalog (window.TEMPLATES) renders a
    // small picker; choosing one saves it as a NEW workflow via the same CRUD.
    function renderTemplates() {
      var box = root.querySelector('#wf-templates-box');
      if (!box) return;
      if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
      var T = window.TEMPLATES;
      if (!T) { U().toast('templates unavailable', 'error'); return; }
      box.hidden = false;
      var cards = T.list().map(function (tpl) {
        var n = Array.isArray(tpl.steps) ? tpl.steps.length : 0;
        return '<div class="wf-card" data-tpl="' + esc(tpl.id) + '">' +
          '<div class="wf-card-head">' +
            '<span class="wf-name">' + IC(tpl.icon || 'sitemap', 14) + ' ' + esc(t(tpl.name)) + '</span>' +
            '<span class="badge">' + n + ' ' + t('wf.steps') + '</span>' +
          '</div>' +
          '<div class="wf-desc muted small">' + esc(t(tpl.description)) + '</div>' +
          '<div class="wf-actions">' +
            '<button class="btn btn-primary btn-sm" data-usetpl="' + esc(tpl.id) + '">＋ ' + t('wf.useTemplate') + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
      box.innerHTML =
        '<div class="card" style="margin:8px 0">' +
          '<h4 style="margin:0 0 4px">' + t('wf.templatesTitle') + '</h4>' +
          '<p class="muted small">' + t('wf.templatesHint') + '</p>' +
          '<div class="wf-grid">' + cards + '</div>' +
        '</div>';
      box.querySelectorAll('[data-usetpl]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-usetpl');
          var tpl = T.byId(id);
          if (!tpl) return;
          var body = T.toWorkflowBody(id, t(tpl.name));
          if (!body) return;
          b.disabled = true;
          API.createWorkflow(uid, body)
            .then(function () {
              U().toast(t('wf.templateCreated'), 'success');
              box.hidden = true; box.innerHTML = '';
              load();
            })
            .catch(function (err) { U().toast(err.message, 'error'); })
            .then(function () { b.disabled = false; });
        });
      });
    }

    root.querySelector('#wf-templates').addEventListener('click', renderTemplates);
    root.querySelector('#wf-refresh').addEventListener('click', load);
    root.querySelector('#wf-new').addEventListener('click', function () {
      if (window.FlowEditor) window.FlowEditor.newWorkflow();
      pendingWorkflowToOpen = null;
      location.hash = '#/editor';
    });
    load();
  }

  // Safe id fragment for building element selectors (workflow ids are wf_<hex>,
  // but guard against anything unexpected so querySelector never throws).
  function cssId(id) {
    return String(id).replace(/[^A-Za-z0-9_-]/g, '');
  }

  // =============================================
  // ADMIN
  // =============================================
  function renderAdmin(root) {
    var token = API.getAdminToken();
    if (!token) { renderAdminLogin(root); return; }
    renderAdminPanel(root);
  }

  function renderAdminLogin(root) {
    root.innerHTML =
      '<div class="card" style="max-width:460px">' +
        '<h3 class="card-title">' + IC('shield') + ' ' + t('admin.title') + '</h3>' +
        '<p class="muted" style="margin-top:0">' + t('admin.hint') + '</p>' +
        '<label class="field"><span class="field-label">' + t('admin.tokenLabel') + '</span>' +
          '<input id="admin-token" type="password" class="field-input" /></label>' +
        '<div id="admin-err"></div>' +
        '<button class="btn btn-primary" id="admin-connect">' + t('admin.connect') + '</button>' +
      '</div>';

    root.querySelector('#admin-connect').addEventListener('click', function () {
      var tk = (root.querySelector('#admin-token').value || '').trim();
      if (!tk) return;
      var errEl = root.querySelector('#admin-err');
      errEl.innerHTML = '';
      API.validateAdminToken(tk)
        .then(function (ok) {
          if (!ok) { errEl.innerHTML = '<div class="result-banner err">' + t('admin.invalidToken') + '</div>'; return; }
          API.setAdminToken(tk);
          renderAdminPanel(root);
        })
        .catch(function () {
          errEl.innerHTML = '<div class="result-banner err">' + t('admin.invalidToken') + '</div>';
        });
    });
  }

  function renderAdminPanel(root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="toolbar">' +
          '<h3 class="card-title" style="margin:0">' + IC('shield') + ' ' + t('admin.stats') + '</h3>' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-ghost btn-sm" id="admin-refresh">' + t('common.refresh') + '</button>' +
          '<button class="btn btn-ghost btn-sm" id="admin-logout">' + t('admin.disconnect') + '</button>' +
        '</div>' +
        '<div id="admin-body"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</div>';

    root.querySelector('#admin-logout').addEventListener('click', function () {
      API.setAdminToken('');
      renderAdminLogin(root);
    });

    function load() {
      var body = root.querySelector('#admin-body');
      API.adminStats()
        .then(function (data) {
          var s = data.stats || data;
          var sys = (s.system) || {};
          var totals = data.totals || data.counters || {};
          // /admin/stats embeds counters at top-level; be defensive.
          var totalJobs = data.totalJobs != null ? data.totalJobs : (data.counters && data.counters.totalJobs);
          var queue = data.queue || data.queueCounts || {};

          body.innerHTML =
            '<div class="grid grid-cards">' +
              '<div class="card"><h3 class="card-title">' + t('admin.stats') + '</h3><dl class="kv">' +
                '<dt>' + t('dash.version') + '</dt><dd>v' + esc(sys.version || data.version) + '</dd>' +
                '<dt>' + t('dash.uptime') + '</dt><dd>' + esc(U().formatUptime(sys.uptime || data.uptime || 0)) + '</dd>' +
                '<dt>Node</dt><dd>' + esc(sys.nodeVersion || '—') + '</dd>' +
                '<dt>Lua</dt><dd>' + esc(sys.luaScripts || '—') + '</dd>' +
              '</dl></div>' +
              '<div class="card"><h3 class="card-title">Queue</h3><dl class="kv">' +
                '<dt>waiting</dt><dd>' + U().num(queue.waiting) + '</dd>' +
                '<dt>active</dt><dd>' + U().num(queue.active) + '</dd>' +
                '<dt>completed</dt><dd>' + U().num(queue.completed) + '</dd>' +
                '<dt>failed</dt><dd>' + U().num(queue.failed) + '</dd>' +
                '<dt>delayed</dt><dd>' + U().num(queue.delayed) + '</dd>' +
              '</dl></div>' +
              '<div class="card"><h3 class="card-title">Raw</h3>' +
                '<div class="json-block" style="max-height:260px">' + esc(JSON.stringify(data, null, 2)) + '</div>' +
              '</div>' +
            '</div>';
        })
        .catch(function (err) {
          if (err.status === 403) { API.setAdminToken(''); renderAdminLogin(root); return; }
          body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
        });
    }

    root.querySelector('#admin-refresh').addEventListener('click', load);
    load();
  }

  // =============================================
  // Public router entry
  // =============================================
  // ---------------------------------------------
  // Visual node-based Flow editor (step 10, inspired by Automa).
  // The heavy lifting lives in window.FlowEditor (flow-editor.js); this view
  // builds the layout (palette / canvas / inspector) + toolbar and wires the
  // editor's graph<->steps conversion to POST /run.
  // ---------------------------------------------
  function renderEditor(root) {
    var FE = window.FlowEditor;
    if (!FE) {
      root.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' flow-editor.js not loaded</div>';
      return;
    }

    // Aria Automate editor shell: top bar (brand · workflow title · badge ·
    // actions) above a joined palette+canvas panel (shell-*.md specs).
    root.innerHTML =
      '<div class="fe-shell">' +
        '<div class="fe-topbar">' +
          '<span class="fe-brand"><span class="fe-brand-mark">A</span>' + t('fe.brand') + '</span>' +
          '<span class="fe-crumb-sep">/</span>' +
          '<span class="fe-wf-title" id="fe-wf-label"></span>' +
          '<span id="fe-wf-badge"></span>' +
          '<div class="fe-topbar-actions">' +
            '<button class="btn btn-ghost btn-sm" id="fe-from-run" title="' + t('fe.fromRun') + '">' + IC('upload', 15) + '</button>' +
            '<button class="btn btn-ghost btn-sm" id="fe-load" title="' + t('fe.load') + '">' + IC('folder', 15) + '</button>' +
            '<button class="btn btn-ghost btn-sm" id="fe-json" title="' + t('fe.toJson') + '">{ }</button>' +
            '<button class="btn btn-ghost btn-sm" id="fe-clear" title="' + t('fe.clear') + '">' + IC('trash', 15) + '</button>' +
            '<button class="btn btn-ghost btn-sm" id="fe-save">' + t('fe.save') + '</button>' +
            '<button class="btn btn-ghost btn-sm" id="fe-save-server">' + IC('save', 14) + ' ' + t('fe.saveServer') + '</button>' +
            '<button class="btn btn-primary btn-sm" id="fe-run">' + IC('play', 14) + ' ' + t('fe.testWorkflow') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="fe-layout">' +
          '<aside class="fe-palette" id="fe-palette"></aside>' +
          '<div class="fe-canvas" id="fe-canvas">' +
            '<svg class="fe-svg" id="fe-svg"></svg>' +
            '<div class="fe-world" id="fe-world"></div>' +
          '</div>' +
          '<aside class="fe-inspector"><div id="fe-inspector"></div></aside>' +
        '</div>' +
        // Status bar (shell previews): version · auto-save · last saved ·
        // workflow id · environment. Read-only telemetry, no controls.
        '<div class="fe-statusbar" id="fe-statusbar"></div>' +
        '<div class="muted small fe-hint">' + t('fe.hint') + '</div>' +
        '<div id="fe-result"></div>' +
      '</div>';

    var resultEl = root.querySelector('#fe-result');
    var wfLabel = root.querySelector('#fe-wf-label');
    var wfBadge = root.querySelector('#fe-wf-badge');
    var statusBar = root.querySelector('#fe-statusbar');

    FE.mount({
      canvas: root.querySelector('#fe-canvas'),
      svg: root.querySelector('#fe-svg'),
      world: root.querySelector('#fe-world'),
      palette: root.querySelector('#fe-palette'),
      inspector: root.querySelector('#fe-inspector'),
    });

    // Step 22: if the Workflows view asked us to open a saved workflow, load it
    // now (rebuilds the graph from its steps and remembers its identity so a
    // later "Save to server" performs a version-bumping PUT instead of create).
    if (pendingWorkflowToOpen) {
      FE.openWorkflow(pendingWorkflowToOpen, pendingWorkflowToOpen.steps || []);
      pendingWorkflowToOpen = null;
    }

    // Step 26: mount the collapsible bottom run/log drawer and restore the
    // "last run" of whatever workflow is currently open (survives reloads).
    if (window.RunPanel) {
      window.RunPanel.mount();
      var cur0 = FE.getCurrentWorkflow && FE.getCurrentWorkflow();
      window.RunPanel.loadLastRun(cur0 && cur0.id ? cur0.id : null);
    }

    // Status bar cells, matching the shell previews' reading order:
    //   Version 1.3.7 · Auto-save enabled ● · Last saved: 10:24:32 ·
    //   Workflow ID: wf_login_001 · Environment: Production ●
    // Values are real (from the open workflow), never faked placeholders.
    function statusCell(label, value, dot) {
      return '<span class="fe-sb-cell">' +
        (dot ? '<span class="fe-sb-dot tone-' + dot + '"></span>' : '') +
        '<span class="fe-sb-label">' + esc(label) + '</span>' +
        (value ? '<span class="fe-sb-val">' + esc(value) + '</span>' : '') +
        '</span>';
    }
    function refreshStatusBar() {
      if (!statusBar) return;
      var cur = FE.getCurrentWorkflow && FE.getCurrentWorkflow();
      var saved = FE.getLastSavedAt && FE.getLastSavedAt();
      var cells = [
        statusCell(t('sb.version'), cur && cur.version ? 'v' + cur.version : t('sb.unsaved')),
        statusCell(t('sb.autoSave'), t(cur && cur.id ? 'sb.on' : 'sb.off'),
          cur && cur.id ? 'good' : 'idle'),
        statusCell(t('sb.lastSaved'), saved || '—'),
        statusCell(t('sb.workflowId'), cur && cur.id ? String(cur.id) : '—'),
        statusCell(t('sb.environment'), t('sb.envDev'), 'good'),
      ];
      statusBar.innerHTML = cells.join('<span class="fe-sb-sep"></span>');
    }

    function refreshWfLabel() {
      var cur = FE.getCurrentWorkflow && FE.getCurrentWorkflow();
      if (cur && cur.id) {
        wfLabel.textContent = cur.name;
        wfBadge.innerHTML = '<span class="fe-badge-saved">' + IC('check', 12) + ' v' + cur.version + '</span>';
      } else {
        wfLabel.textContent = t('fe.untitled');
        wfBadge.innerHTML = '<span class="fe-badge-draft">' + t('fe.draft') + '</span>';
      }
      refreshStatusBar();
    }
    refreshWfLabel();

    // Save (or create) the current graph as a server-side saved workflow.
    root.querySelector('#fe-save-server').addEventListener('click', function () {
      var uid = effectiveUserId();
      if (!uid) { U().toast(t('fe.needUserId'), 'error'); return; }
      var steps = FE.toSteps();
      if (!steps.length) { U().toast(t('fe.noSteps'), 'error'); return; }

      var cur = FE.getCurrentWorkflow && FE.getCurrentWorkflow();
      var btn = root.querySelector('#fe-save-server');
      btn.disabled = true;

      if (cur && cur.id) {
        // Existing workflow → PUT (bumps version + snapshots history).
        API.updateWorkflow(uid, cur.id, {
          name: cur.name, description: cur.description || null,
          steps: steps, headless: cur.headless, webhookUrl: cur.webhookUrl
        })
          .then(function (data) {
            FE.setCurrentWorkflow(data.workflow);
            U().toast(t('wf.saved') + ' (v' + data.workflow.version + ')', 'success');
            refreshWfLabel();
          })
          .catch(function (err) { U().toast(err.message, 'error'); })
          .then(function () { btn.disabled = false; });
      } else {
        // New workflow → ask for a name, then create (version 1).
        var name = prompt(t('wf.namePrompt'), t('wf.defaultName'));
        if (name == null) { btn.disabled = false; return; }
        name = String(name).trim();
        if (!name) { U().toast(t('wf.nameRequired'), 'error'); btn.disabled = false; return; }
        API.createWorkflow(uid, { name: name, steps: steps, headless: true })
          .then(function (data) {
            FE.setCurrentWorkflow(data.workflow);
            U().toast(t('wf.created'), 'success');
            refreshWfLabel();
          })
          .catch(function (err) { U().toast(err.message, 'error'); })
          .then(function () { btn.disabled = false; });
      }
    });

    root.querySelector('#fe-save').addEventListener('click', function () {
      var ok = FE.saveLocal();
      U().toast(ok ? t('fe.saved') : 'error', ok ? 'ok' : 'error');
    });
    root.querySelector('#fe-load').addEventListener('click', function () {
      FE.loadLocal();
      U().toast(t('fe.loaded'), 'ok');
    });
    root.querySelector('#fe-clear').addEventListener('click', function () {
      FE.reset();
      U().toast(t('fe.cleared'), 'ok');
    });
    root.querySelector('#fe-from-run').addEventListener('click', function () {
      // import the linear builder steps (if the run view was used this session)
      FE.loadSteps(buildPayloadSteps());
      U().toast(t('fe.loaded'), 'ok');
    });
    root.querySelector('#fe-json').addEventListener('click', function () {
      var steps = FE.toSteps();
      resultEl.innerHTML = '<pre class="json-block">' +
        esc(JSON.stringify({ steps: steps }, null, 2)) + '</pre>';
    });

    root.querySelector('#fe-run').addEventListener('click', function () {
      var uid = effectiveUserId();
      if (!uid) { U().toast(t('fe.needUserId'), 'error'); return; }
      var steps = FE.toSteps();
      if (!steps.length) { U().toast(t('fe.noSteps'), 'error'); return; }

      var btn = root.querySelector('#fe-run');
      btn.disabled = true;
      var label = btn.textContent;
      btn.textContent = t('fe.running');
      resultEl.innerHTML = '';

      API.runFlow({ userId: uid, steps: steps, headless: true })
        .then(function (data) {
          resultEl.innerHTML =
            '<div class="result-banner ok">' + IC('check-circle') + ' ' + t('fe.queued') +
            ' <code>' + esc(data.jobId) + '</code> ' +
            '<button class="btn btn-ghost btn-sm" id="fe-goto-job" data-job="' +
            esc(data.jobId) + '">' + t('run.viewJob') + '</button> ' +
            '<span class="muted small">(' + steps.length + ' ' + t('fe.steps') + ')</span></div>';
          var g = resultEl.querySelector('#fe-goto-job');
          if (g) g.addEventListener('click', function () {
            location.hash = '#/jobs?job=' + encodeURIComponent(data.jobId) +
              '&user=' + encodeURIComponent(uid);
          });
          // Step 26: stream this job's live events into the bottom run/log
          // drawer — per-node halos, badges and the step timeline update live.
          if (window.RunPanel) {
            var curR = FE.getCurrentWorkflow && FE.getCurrentWorkflow();
            window.RunPanel.loadLastRun(curR && curR.id ? curR.id : null);
            window.RunPanel.startJob({
              userId: uid,
              jobId: data.jobId,
              apiKey: API.getKey ? API.getKey() : '',
            });
          }
        })
        .catch(function (err) {
          resultEl.innerHTML = '<div class="result-banner err">' + IC('x-circle') + ' ' +
            esc(err && err.message ? err.message : String(err)) + '</div>';
        })
        .then(function () { btn.disabled = false; btn.textContent = label; });
    });
  }

  // =============================================
  // WORKSPACE — the workflow-management hub
  // (locked design: docs/uiux/workspace-overview.md + .webp)
  //
  // WHY THIS VIEW EXISTS
  // --------------------
  // `Live View`, `Live Browser`, `Schedules` and `Active Flow` used to be
  // sidebar entries, which forced the user to know *which* workflow a global
  // "Live Browser" page was talking about. They are capabilities of ONE
  // workflow, so they live on that workflow's row here (toggles, eye button,
  // schedules cell, per-row menu) and the sidebar shrinks to six real areas.
  // =============================================

  /** Replace `{token}` placeholders in a translated string. */
  function fill(str, map) {
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return map[k] == null ? m : String(map[k]);
    });
  }

  /** Coarse relative time — the table wants "2h ago", not a full timestamp. */
  function fmtRel(iso) {
    if (!iso) return t('ws.never');
    var ts = Date.parse(iso);
    if (isNaN(ts)) return '—';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return t('ws.justNow');
    if (s < 3600) return fill(t('ws.minsAgo'), { n: Math.floor(s / 60) });
    if (s < 86400) return fill(t('ws.hoursAgo'), { n: Math.floor(s / 3600) });
    return fill(t('ws.daysAgo'), { n: Math.floor(s / 86400) });
  }

  /**
   * The seven stat cards, in the order LOCKED BY THE IMAGE (the written report
   * lists Total Flows first; the approved artefact puts Active Schedules
   * first — the image wins). `key` indexes the /workspace/:userId/stats payload.
   */
  var WS_CARDS = [
    { key: 'activeSchedules', icon: 'calendar', tone: 'violet', title: 'ws.card.activeSchedules', sub: 'ws.sub.activeSchedules' },
    { key: 'totalFlows', icon: 'sitemap', tone: 'blue', title: 'ws.card.totalFlows', sub: 'ws.sub.totalFlows' },
    { key: 'activeFlows', icon: 'check-circle', tone: 'green', title: 'ws.card.activeFlows', sub: 'ws.sub.activeFlows' },
    { key: 'successRate', icon: 'target', tone: 'green', title: 'ws.card.successRate', sub: 'ws.sub.successRate', pct: true },
    { key: 'failures', icon: 'alert-triangle', tone: 'red', title: 'ws.card.failures', sub: 'ws.sub.failures' },
    { key: 'activeJobs', icon: 'briefcase', tone: 'amber', title: 'ws.card.activeJobs', sub: 'ws.sub.activeJobs' },
    { key: 'liveBrowsers', icon: 'globe', tone: 'blue', title: 'ws.card.liveBrowsers', sub: 'ws.sub.liveBrowsers' },
  ];

  var WS_TABS = [
    { id: 'workflows', label: 'ws.tab.workflows' },
    { id: 'templates', label: 'ws.tab.templates' },
    { id: 'executions', label: 'ws.tab.executions' },
    { id: 'schedules', label: 'ws.tab.schedules' },
    { id: 'connections', label: 'ws.tab.connections' },
  ];

  var WS_SORTS = [
    { id: 'updated', label: 'ws.sort.updated' },
    { id: 'name', label: 'ws.sort.name' },
    { id: 'rate', label: 'ws.sort.rate' },
    { id: 'lastRun', label: 'ws.sort.lastRun' },
  ];

  /** Per-workflow actions menu — exactly the entries the sidebar gave up. */
  var WS_ROW_MENU = [
    { id: 'editor', icon: 'pencil', label: 'ws.menu.openEditor' },
    { id: 'live', icon: 'eye', label: 'ws.menu.liveBrowser' },
    { id: 'schedules', icon: 'calendar', label: 'ws.menu.schedules' },
    { id: 'executions', icon: 'history', label: 'ws.menu.executions' },
    { id: 'connections', icon: 'git-branch', label: 'ws.menu.connections' },
    { id: 'settings', icon: 'settings', label: 'ws.menu.settings' },
    { id: 'duplicate', icon: 'copy', label: 'ws.menu.duplicate' },
    { id: 'export', icon: 'download', label: 'ws.menu.export' },
    { id: 'delete', icon: 'trash', label: 'ws.menu.delete', danger: true },
  ];

  // Survives re-render (language switch, refresh) but not a page reload.
  // `filters` is a separate sub-object so "clear filters" is one assignment and
  // the active-filter count is one comparison against WS_FILTER_DEFAULTS.
  var WS_FILTER_DEFAULTS = { status: 'all', live: 'all', scheduled: false, failing: false };
  var wsState = {
    tab: 'workflows', search: '', sort: 'updated', page: 1, perPage: 10, compact: false,
    filters: Object.assign({}, WS_FILTER_DEFAULTS),
    // Executions tab: which workflow's runs to show ('' = every run) and
    // whether the 8 s poll is running.
    execWorkflow: '', execAuto: true,
  };

  /** How many filters differ from their default — drives the button's badge. */
  function wsActiveFilterCount() {
    var n = 0;
    var f = wsState.filters;
    for (var k in WS_FILTER_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(WS_FILTER_DEFAULTS, k) && f[k] !== WS_FILTER_DEFAULTS[k]) n++;
    }
    return n;
  }

  /**
   * Does a workflow survive the filter panel?
   * Kept a pure function of (workflow, its stat row, filters) so the guard test
   * can reason about it and so search/sort/paging stay independent of it.
   */
  function wsPassesFilters(wf, st, f) {
    var active = wf.active !== false;
    if (f.status === 'active' && !active) return false;
    if (f.status === 'inactive' && active) return false;
    var lb = wf.liveBrowser === true;
    if (f.live === 'on' && !lb) return false;
    if (f.live === 'off' && lb) return false;
    if (f.scheduled && !(st && st.scheduleCount > 0)) return false;
    // "Failing" means it HAS a measured rate that is poor. A workflow that never
    // ran has no evidence of failure and must not be accused of one.
    if (f.failing && !(st && st.successRate != null && st.successRate < 80)) return false;
    return true;
  }

  /** Trigger label for an execution row (server sends 'manual'|'schedule'|'workflow'). */
  function wsTriggerLabel(trigger) {
    var known = { manual: 1, schedule: 1, workflow: 1 };
    return t('ws.exec.trigger.' + (known[trigger] ? trigger : 'manual'));
  }

  /** Compact duration: an in-flight run has no duration yet, so it says so. */
  function wsDuration(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    if (s < 60) return (Math.round(s * 10) / 10) + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + Math.round(s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  /** Success-rate fill tone: >=95% green, 80-95% amber, <80% red (spec § 3F). */
  function wsSuccessTone(pct) {
    if (pct == null) return 'muted';
    if (pct >= 95) return 'green';
    if (pct >= 80) return 'amber';
    return 'red';
  }

  /** Hand a workflow to the editor view (same channel the old card list used). */
  function openInEditorFromWorkspace(wf) {
    pendingWorkflowToOpen = wf;
    location.hash = '#/editor';
  }

  /** Import a workflow JSON file produced by the row menu's Export entry. */
  function importWorkflowJson(uid, done) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var body;
        try { body = JSON.parse(String(reader.result)); }
        catch (e) { U().toast(t('ws.importInvalid'), 'error'); return; }
        if (!body || !Array.isArray(body.steps)) { U().toast(t('ws.importInvalid'), 'error'); return; }
        API.createWorkflow(uid, {
          name: body.name || 'Imported workflow',
          description: body.description || null,
          steps: body.steps,
          headless: body.headless,
          webhookUrl: body.webhookUrl,
        })
          .then(function () { U().toast(t('ws.imported'), 'success'); if (done) done(); })
          .catch(function (err) { U().toast(err.message, 'error'); });
      };
      reader.readAsText(file);
    });
    input.click();
  }

  /** Download a workflow as JSON (row menu → Export). */
  function exportWorkflowJson(wf) {
    var payload = JSON.stringify({
      name: wf.name, description: wf.description || null, steps: wf.steps,
      headless: wf.headless, webhookUrl: wf.webhookUrl,
      active: wf.active !== false, liveBrowser: wf.liveBrowser === true,
    }, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(wf.name || 'workflow').replace(/[^A-Za-z0-9_-]+/g, '_') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 0);
    U().toast(t('ws.exported'), 'success');
  }

  function renderWorkspace(root) {
    var uid = effectiveUserId();
    var workflows = [];
    var statsByWf = {};

    root.innerHTML =
      '<section class="ws">' +
        '<header class="page-head">' +
          '<div>' +
            '<h1 class="page-h1">' + t('ws.title') + '</h1>' +
            '<p class="page-sub">' + t('ws.subtitle') + '</p>' +
          '</div>' +
          '<div class="split-btn" id="ws-create">' +
            '<button type="button" class="split-main" id="ws-new">' + IC('plus', 15) + ' ' + t('ws.new') + '</button>' +
            '<button type="button" class="split-caret" id="ws-new-caret" aria-haspopup="menu"' +
              ' aria-expanded="false" aria-label="' + esc(t('ws.newMenu')) + '">' + IC('chevron-down', 14) + '</button>' +
            '<div class="split-menu" id="ws-new-menu" role="menu" hidden>' +
              '<button type="button" role="menuitem" data-create="template">' + IC('sitemap', 14) + ' ' + t('ws.fromTemplate') + '</button>' +
              '<button type="button" role="menuitem" data-create="import">' + IC('upload', 14) + ' ' + t('ws.importJson') + '</button>' +
            '</div>' +
          '</div>' +
        '</header>' +
        '<div class="ws-cards" id="ws-cards"></div>' +
        '<div class="ws-strip">' +
          '<div class="ws-tabs" role="tablist" id="ws-tabs"></div>' +
          '<div class="ws-controls">' +
            '<label class="ws-search">' + IC('search', 14) +
              '<input type="search" id="ws-search" placeholder="' + esc(t('ws.search')) + '"' +
              ' value="' + esc(wsState.search) + '" />' +
            '</label>' +
            '<select class="ws-select" id="ws-sort" aria-label="' + esc(t('ws.sortBy')) + '"></select>' +
            '<div class="ws-filter-wrap">' +
              '<button type="button" class="ws-icon-btn" id="ws-filter" title="' + esc(t('ws.filter')) + '"' +
                ' aria-label="' + esc(t('ws.filter')) + '" aria-haspopup="dialog" aria-expanded="false">' +
                IC('filter', 15) + '<span class="ws-filter-badge" id="ws-filter-badge" hidden></span></button>' +
              '<div class="ws-filter-panel" id="ws-filter-panel" role="dialog"' +
                ' aria-label="' + esc(t('ws.filterTitle')) + '" hidden></div>' +
            '</div>' +
            '<button type="button" class="ws-icon-btn" id="ws-layout" title="' + esc(t('ws.layout')) + '"' +
              ' aria-label="' + esc(t('ws.layout')) + '" aria-pressed="false">' + IC('layout', 15) + '</button>' +
          '</div>' +
        '</div>' +
        '<div id="ws-panel"><div class="placeholder"><span class="spinner"></span> ' + t('common.loading') + '</div></div>' +
      '</section>';

    var elCards = root.querySelector('#ws-cards');
    var elPanel = root.querySelector('#ws-panel');

    // ---- stat cards (7, order locked by the image) ------------------------
    function paintCards(stats) {
      elCards.innerHTML = WS_CARDS.map(function (c) {
        var raw = stats ? stats[c.key] : null;
        var val = raw == null ? '—' : (c.pct ? raw + '%' : U().num(raw));
        return '<div class="ws-card tone-' + c.tone + '">' +
          '<div class="ws-card-head">' +
            '<span class="ws-card-icon">' + IC(c.icon, 16) + '</span>' +
            '<span class="ws-card-title">' + t(c.title) + '</span>' +
          '</div>' +
          '<div class="ws-card-value">' + esc(val) + '</div>' +
          '<div class="ws-card-foot"><span class="ws-dot"></span>' + t(c.sub) + '</div>' +
        '</div>';
      }).join('');
    }
    paintCards(null);

    // ---- tabs + sort select ----------------------------------------------
    function paintTabs() {
      root.querySelector('#ws-tabs').innerHTML = WS_TABS.map(function (tab) {
        var on = wsState.tab === tab.id;
        return '<button type="button" class="ws-tab' + (on ? ' active' : '') + '" role="tab"' +
          ' aria-selected="' + (on ? 'true' : 'false') + '" data-tab="' + tab.id + '">' +
          t(tab.label) + '</button>';
      }).join('');
      root.querySelectorAll('[data-tab]').forEach(function (b) {
        b.addEventListener('click', function () {
          wsState.tab = b.getAttribute('data-tab');
          wsState.page = 1;
          paintTabs();
          paintPanel();
        });
      });
    }
    root.querySelector('#ws-sort').innerHTML = WS_SORTS.map(function (s) {
      return '<option value="' + s.id + '"' + (wsState.sort === s.id ? ' selected' : '') + '>' +
        esc(t('ws.sortBy') + ': ' + t(s.label)) + '</option>';
    }).join('');
    paintTabs();

    // ---- data ------------------------------------------------------------
    function load() {
      return Promise.all([
        API.listWorkflows(uid),
        API.workspaceStats(uid).catch(function () { return null; }),
      ]).then(function (res) {
        workflows = (res[0] && res[0].workflows) || [];
        statsByWf = {};
        var stats = res[1] && res[1].stats ? res[1].stats : null;
        ((res[1] && res[1].perWorkflow) || []).forEach(function (p) { statsByWf[p.workflowId] = p; });
        // Fall back to what the workflow list alone can prove, so the cards are
        // never blank just because the aggregate endpoint is unavailable.
        paintCards(stats || {
          totalFlows: workflows.length,
          activeFlows: workflows.filter(function (w) { return w.active !== false; }).length,
        });
        paintPanel();
      }).catch(function (err) {
        elPanel.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
      });
    }

    function visibleWorkflows() {
      var q = wsState.search.trim().toLowerCase();
      var list = workflows.filter(function (w) {
        if (!wsPassesFilters(w, statsByWf[w.id], wsState.filters)) return false;
        if (!q) return true;
        return String(w.name || '').toLowerCase().indexOf(q) !== -1 ||
          String(w.description || '').toLowerCase().indexOf(q) !== -1;
      });
      var s = wsState.sort;
      return list.sort(function (a, b) {
        if (s === 'name') return String(a.name).localeCompare(String(b.name));
        if (s === 'rate') {
          var ra = (statsByWf[a.id] && statsByWf[a.id].successRate) || 0;
          var rb = (statsByWf[b.id] && statsByWf[b.id].successRate) || 0;
          return rb - ra;
        }
        if (s === 'lastRun') {
          var la = Date.parse((statsByWf[a.id] && statsByWf[a.id].lastRunAt) || 0) || 0;
          var lb = Date.parse((statsByWf[b.id] && statsByWf[b.id].lastRunAt) || 0) || 0;
          return lb - la;
        }
        return (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0);
      });
    }

    function findWf(id) {
      for (var i = 0; i < workflows.length; i++) if (workflows[i].id === id) return workflows[i];
      return null;
    }

    // ---- cells -----------------------------------------------------------
    function lastRunCell(st) {
      if (!st || !st.lastRunAt) return '<span class="ws-muted">' + t('ws.never') + '</span>';
      var map = {
        completed: { tone: 'green', label: 'ws.success' },
        failed: { tone: 'red', label: 'ws.failed' },
        active: { tone: 'amber', label: 'ws.running' },
        waiting: { tone: 'amber', label: 'ws.queued' },
        delayed: { tone: 'amber', label: 'ws.queued' },
      };
      var m = map[st.lastRunState] || { tone: 'muted', label: 'ws.unknownRun' };
      return '<span class="ws-run"><span class="ws-run-dot tone-' + m.tone + '"></span>' +
        esc(fmtRel(st.lastRunAt)) + '</span>' +
        '<span class="ws-run-outcome tone-' + m.tone + '">' + t(m.label) + '</span>';
    }

    function rateCell(st) {
      var pct = st ? st.successRate : null;
      var w = pct == null ? 0 : Math.max(0, Math.min(100, pct));
      return '<span class="ws-rate-num">' + (pct == null ? '—' : pct + '%') + '</span>' +
        '<span class="ws-rate-track"><span class="ws-rate-fill tone-' + wsSuccessTone(pct) + '"' +
        ' style="width:' + w + '%"></span></span>';
    }

    /**
     * Live Browser is a per-workflow capability, and a browser session can only
     * exist while the workflow is allowed to run — hence the three locked states
     * (docs/uiux/workspace-overview.md § 4):
     *   active   + on  -> eye enabled (a session exists / will exist)
     *   inactive + on  -> toggle rendered gray, eye disabled (intent remembered)
     *   active   + off -> eye disabled (user opted out of streaming)
     */
    function liveCell(wf) {
      var active = wf.active !== false;
      var on = wf.liveBrowser === true;
      var watchable = active && on;
      var tip = watchable ? t('ws.watchBrowser')
        : (!active ? t('ws.watchDisabledInactive') : t('ws.watchDisabledOff'));
      return '<div class="ws-live">' +
        '<button type="button" class="ws-switch' + (on ? ' on' : '') + (on && !active ? ' muted-on' : '') + '"' +
          ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '"' +
          ' data-lb="' + esc(wf.id) + '" aria-label="' + esc(t('ws.col.liveBrowser')) + '">' +
          '<span class="ws-switch-knob"></span>' +
        '</button>' +
        '<button type="button" class="ws-eye' + (watchable ? '' : ' disabled') + '"' +
          ' data-watch="' + esc(wf.id) + '"' + (watchable ? '' : ' aria-disabled="true"') +
          ' title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
          IC(watchable ? 'eye' : 'eye-off', 15) +
        '</button>' +
      '</div>';
    }

    function ownerCell(wf) {
      var team = wf.owner === 'team';
      return '<span class="ws-owner">' + IC(team ? 'users' : 'user', 13) + ' ' +
        t(team ? 'ws.owner.team' : 'ws.owner.personal') + '</span>';
    }

    function rowMenu(wf) {
      return '<div class="ws-row-menu" id="ws-menu-' + cssId(wf.id) + '" role="menu" hidden>' +
        WS_ROW_MENU.map(function (m) {
          var dis = m.id === 'live' && !(wf.active !== false && wf.liveBrowser === true);
          return '<button type="button" role="menuitem" class="' + (m.danger ? 'danger' : '') + '"' +
            ' data-act="' + m.id + '" data-id="' + esc(wf.id) + '"' +
            (dis ? ' aria-disabled="true" disabled' : '') + '>' +
            IC(m.icon, 14) + ' ' + t(m.label) + '</button>';
        }).join('') +
      '</div>';
    }

    function workflowRow(wf) {
      var st = statsByWf[wf.id];
      var active = wf.active !== false;
      var n = st ? st.scheduleCount : 0;
      return '<tr data-row="' + esc(wf.id) + '">' +
        '<td>' +
          '<div class="ws-wf">' +
            '<span class="ws-wf-icon">' + IC('sitemap', 15) + '</span>' +
            '<span class="ws-wf-text">' +
              '<span class="ws-wf-name">' + esc(wf.name) + '</span>' +
              '<span class="ws-wf-desc">' + esc(wf.description || t('ws.noDescription')) + '</span>' +
            '</span>' +
          '</div>' +
        '</td>' +
        '<td>' + ownerCell(wf) + '</td>' +
        '<td>' + lastRunCell(st) + '</td>' +
        '<td>' + rateCell(st) + '</td>' +
        '<td>' +
          '<div class="ws-status">' +
            '<button type="button" class="ws-switch' + (active ? ' on' : '') + '" role="switch"' +
              ' aria-checked="' + (active ? 'true' : 'false') + '" data-active="' + esc(wf.id) + '"' +
              ' aria-label="' + esc(t('ws.col.status')) + '"><span class="ws-switch-knob"></span></button>' +
            '<span class="ws-status-label' + (active ? ' on' : '') + '">' +
              t(active ? 'ws.active' : 'ws.inactive') + '</span>' +
          '</div>' +
        '</td>' +
        '<td>' + liveCell(wf) + '</td>' +
        '<td>' +
          '<button type="button" class="ws-sched" data-sched="' + esc(wf.id) + '">' +
            IC('calendar', 14) + ' ' +
            (n === 1 ? t('ws.scheduleOne') : fill(t('ws.schedulesCount'), { n: n })) +
          '</button>' +
        '</td>' +
        '<td class="ws-actions-cell">' +
          '<button type="button" class="ws-icon-btn ws-kebab" data-menu="' + esc(wf.id) + '"' +
            ' aria-haspopup="menu" aria-expanded="false" aria-label="' + esc(t('ws.col.actions')) + '">' +
            IC('more-vertical', 16) + '</button>' +
          rowMenu(wf) +
        '</td>' +
      '</tr>';
    }

    // ---- panels per tab ---------------------------------------------------
    function paintPanel() {
      // Leaving the Executions tab must stop its poll, or a background timer
      // keeps hitting /jobs for a panel nobody is looking at.
      if (wsState.tab !== 'executions') stopExecPoll();
      if (wsState.tab === 'workflows') { paintWorkflowsTab(); return; }
      if (wsState.tab === 'schedules') { paintSchedulesTab(); return; }
      if (wsState.tab === 'templates') { paintTemplatesTab(); return; }
      if (wsState.tab === 'executions') { paintExecutionsTab(); return; }
      paintConnectionsTab();
    }

    function pageChips(pages) {
      var out = [];
      var GAP = '<span class="ws-page-gap">…</span>';
      for (var i = 1; i <= pages; i++) {
        if (pages > 7 && i > 3 && i < pages && Math.abs(i - wsState.page) > 1) {
          if (out[out.length - 1] !== GAP) out.push(GAP);
          continue;
        }
        out.push('<button type="button" class="ws-page-btn' + (i === wsState.page ? ' active' : '') +
          '" data-goto="' + i + '">' + i + '</button>');
      }
      return out.join('');
    }

    function paintWorkflowsTab() {
      var list = visibleWorkflows();
      if (!workflows.length) {
        elPanel.innerHTML =
          '<div class="ws-empty">' +
            '<span class="ws-empty-icon">' + IC('sitemap', 22) + '</span>' +
            '<p>' + t('ws.empty') + '</p>' +
            '<p class="ws-empty-hint">' + t('ws.emptyHint') + '</p>' +
          '</div>';
        return;
      }
      if (!list.length) {
        elPanel.innerHTML = '<div class="ws-empty"><span class="ws-empty-icon">' +
          IC('search', 22) + '</span><p>' + t('ws.noResults') + '</p></div>';
        return;
      }

      var pages = Math.max(1, Math.ceil(list.length / wsState.perPage));
      if (wsState.page > pages) wsState.page = pages;
      var from = (wsState.page - 1) * wsState.perPage;
      var slice = list.slice(from, from + wsState.perPage);

      var cols = ['workflow', 'owner', 'lastRun', 'successRate', 'status', 'liveBrowser', 'schedules', 'actions'];
      elPanel.innerHTML =
        '<div class="ws-table-wrap' + (wsState.compact ? ' compact' : '') + '">' +
          '<table class="ws-table"><thead><tr>' +
            cols.map(function (c) { return '<th scope="col">' + t('ws.col.' + c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + slice.map(workflowRow).join('') + '</tbody></table>' +
        '</div>' +
        '<div class="ws-foot">' +
          '<span class="ws-foot-count">' + esc(fill(t('ws.showing'), {
            from: list.length ? from + 1 : 0,
            to: from + slice.length,
            total: list.length,
          })) + '</span>' +
          '<div class="ws-pager">' +
            '<button type="button" class="ws-page-btn" data-page="prev"' +
              (wsState.page === 1 ? ' disabled' : '') + ' aria-label="' + esc(t('ws.prevPage')) + '">' +
              IC('chevron-left', 14) + '</button>' +
            pageChips(pages) +
            '<button type="button" class="ws-page-btn" data-page="next"' +
              (wsState.page === pages ? ' disabled' : '') + ' aria-label="' + esc(t('ws.nextPage')) + '">' +
              IC('chevron-right', 14) + '</button>' +
            '<select class="ws-select ws-perpage" id="ws-perpage" aria-label="' + esc(t('ws.perPage')) + '">' +
              [10, 25, 50, 100].map(function (n) {
                return '<option value="' + n + '"' + (wsState.perPage === n ? ' selected' : '') + '>' +
                  n + ' / ' + esc(t('ws.perPage')) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
        '</div>';

      bindWorkflowRows();
    }

    function closeRowMenus() {
      elPanel.querySelectorAll('.ws-row-menu').forEach(function (m) { m.hidden = true; });
      elPanel.querySelectorAll('[data-menu]').forEach(function (b) {
        b.setAttribute('aria-expanded', 'false');
      });
    }

    /**
     * Flip `active` / `liveBrowser` through the toggle-only endpoint. PATCH is
     * used on purpose: PUT would bump `Workflow.version` and write a history
     * snapshot, and flipping a switch is not a new design of the automation.
     */
    function setState(id, patch, btn) {
      if (btn) btn.disabled = true;
      return API.setWorkflowState(uid, id, patch)
        .then(function (data) {
          var wf = findWf(id);
          if (wf && data && data.workflow) {
            wf.active = data.workflow.active;
            wf.liveBrowser = data.workflow.liveBrowser;
          }
          var msgKey = Object.prototype.hasOwnProperty.call(patch, 'active')
            ? (patch.active ? 'ws.activated' : 'ws.deactivated')
            : (patch.liveBrowser ? 'ws.lbOn' : 'ws.lbOff');
          U().toast(t(msgKey), 'success');
          paintWorkflowsTab();
        })
        .catch(function (err) {
          U().toast(err.message || t('ws.stateFailed'), 'error');
          if (btn) btn.disabled = false;
        });
    }

    function runRowAction(act, wf) {
      if (act === 'editor' || act === 'connections' || act === 'settings') {
        // All three open the editor: it is the only place that owns a
        // workflow's graph, its node connections and its per-flow settings.
        openInEditorFromWorkspace(wf);
        return;
      }
      if (act === 'live') { location.hash = '#/browser'; return; }
      if (act === 'schedules') { location.hash = '#/schedules'; return; }
      if (act === 'executions') { location.hash = '#/jobs'; return; }
      if (act === 'duplicate') {
        API.createWorkflow(uid, {
          name: wf.name + ' ' + t('wf.copySuffix'),
          description: wf.description || null,
          steps: wf.steps, headless: wf.headless, webhookUrl: wf.webhookUrl,
        })
          .then(function () { U().toast(t('wf.duplicated'), 'success'); load(); })
          .catch(function (err) { U().toast(err.message, 'error'); });
        return;
      }
      if (act === 'export') { exportWorkflowJson(wf); return; }
      if (act === 'delete') {
        if (!confirm(t('wf.confirmDelete'))) return;
        API.deleteWorkflow(uid, wf.id)
          .then(function () { U().toast(t('wf.deleted'), 'success'); load(); })
          .catch(function (err) { U().toast(err.message, 'error'); });
      }
    }

    function bindWorkflowRows() {
      elPanel.querySelectorAll('[data-active]').forEach(function (b) {
        b.addEventListener('click', function () {
          var wf = findWf(b.getAttribute('data-active'));
          if (wf) setState(wf.id, { active: !(wf.active !== false) }, b);
        });
      });
      elPanel.querySelectorAll('[data-lb]').forEach(function (b) {
        b.addEventListener('click', function () {
          var wf = findWf(b.getAttribute('data-lb'));
          if (wf) setState(wf.id, { liveBrowser: !(wf.liveBrowser === true) }, b);
        });
      });
      elPanel.querySelectorAll('[data-watch]').forEach(function (b) {
        b.addEventListener('click', function () {
          var wf = findWf(b.getAttribute('data-watch'));
          if (!wf) return;
          // The server enforces this too: an inactive workflow refuses to run,
          // so there is nothing to watch. The disabled eye is convenience only.
          if (wf.active === false || wf.liveBrowser !== true) {
            U().toast(t(wf.active === false ? 'ws.watchDisabledInactive' : 'ws.watchDisabledOff'), 'error');
            return;
          }
          location.hash = '#/browser';
        });
      });
      elPanel.querySelectorAll('[data-sched]').forEach(function (b) {
        b.addEventListener('click', function () {
          wsState.tab = 'schedules';
          paintTabs();
          paintPanel();
        });
      });
      elPanel.querySelectorAll('[data-menu]').forEach(function (b) {
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var id = b.getAttribute('data-menu');
          var menu = elPanel.querySelector('#ws-menu-' + cssId(id));
          var wasOpen = menu && !menu.hidden;
          closeRowMenus();
          if (menu && !wasOpen) {
            menu.hidden = false;
            b.setAttribute('aria-expanded', 'true');
          }
        });
      });
      elPanel.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var wf = findWf(b.getAttribute('data-id'));
          closeRowMenus();
          if (wf) runRowAction(b.getAttribute('data-act'), wf);
        });
      });
      elPanel.querySelectorAll('[data-goto]').forEach(function (b) {
        b.addEventListener('click', function () {
          wsState.page = parseInt(b.getAttribute('data-goto'), 10) || 1;
          paintWorkflowsTab();
        });
      });
      elPanel.querySelectorAll('[data-page]').forEach(function (b) {
        b.addEventListener('click', function () {
          wsState.page += b.getAttribute('data-page') === 'next' ? 1 : -1;
          if (wsState.page < 1) wsState.page = 1;
          paintWorkflowsTab();
        });
      });
      var pp = elPanel.querySelector('#ws-perpage');
      if (pp) {
        pp.addEventListener('change', function () {
          wsState.perPage = parseInt(pp.value, 10) || 10;
          wsState.page = 1;
          paintWorkflowsTab();
        });
      }
      if (window.Icons) window.Icons.hydrate(elPanel);
    }

    function paintSchedulesTab() {
      elPanel.innerHTML = '<div id="ws-sched-host"></div>';
      renderSchedules(elPanel.querySelector('#ws-sched-host'));
    }

    // ---- Executions tab ---------------------------------------------------
    // Real run history, scoped to this workspace. The rows come from
    // GET /jobs/:userId (now carrying workflowId / trigger / duration), so a run
    // can be attributed to the workflow that produced it instead of the tab
    // being a link to the global Jobs page.
    var execTimer = null;

    function stopExecPoll() {
      if (execTimer) { clearInterval(execTimer); execTimer = null; }
    }

    function execStateTone(state) {
      if (state === 'completed') return 'green';
      if (state === 'failed') return 'red';
      if (state === 'active' || state === 'waiting' || state === 'delayed') return 'amber';
      return 'muted';
    }

    function execRow(j) {
      var wf = j.workflowId ? findWf(j.workflowId) : null;
      var flowLabel = j.workflowId
        ? (wf ? wf.name : t('ws.exec.deletedFlow'))
        : t('ws.exec.adhoc');
      var live = ['waiting', 'delayed', 'active'].indexOf(j.state) !== -1;
      return '<tr>' +
        '<td><span class="ws-run"><span class="ws-run-dot tone-' + execStateTone(j.state) + '"></span>' +
          (live ? t('ws.exec.running') : stateBadge(j.state)) + '</span></td>' +
        '<td class="mono ws-exec-id">' + esc(j.jobId) + '</td>' +
        '<td>' +
          '<span class="ws-exec-flow' + (j.workflowId && !wf ? ' ws-muted' : '') + '">' + esc(flowLabel) + '</span>' +
          (j.workflowVersion != null
            ? '<span class="ws-exec-ver">' + esc(fill(t('ws.exec.version'), { n: j.workflowVersion })) + '</span>'
            : '') +
        '</td>' +
        '<td><span class="ws-exec-trigger">' + esc(wsTriggerLabel(j.trigger)) +
          (j.scheduleName ? ' · ' + esc(j.scheduleName) : '') + '</span></td>' +
        '<td class="mono">' + esc(wsDuration(j.durationMs)) + '</td>' +
        '<td>' + esc(j.startedAt ? fmtRel(j.startedAt) : fmtRel(j.timestamp)) + '</td>' +
        '<td class="ws-actions-cell"><div class="row-actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-exec-view="' + esc(j.jobId) + '">' +
            t('ws.exec.view') + '</button>' +
          (live
            ? '<button type="button" class="btn btn-ghost btn-sm" data-exec-cancel="' + esc(j.jobId) + '">' +
                t('ws.exec.cancel') + '</button>'
            : '') +
        '</div></td>' +
      '</tr>';
    }

    function paintExecutionsTab() {
      var cols = ['status', 'runId', 'workflow', 'trigger', 'duration', 'startedAt', 'actions'];
      elPanel.innerHTML =
        '<div class="ws-exec-bar">' +
          '<select class="ws-select" id="ws-exec-flow" aria-label="' + esc(t('ws.exec.workflow')) + '">' +
            '<option value="">' + esc(t('ws.exec.allFlows')) + '</option>' +
            workflows.map(function (w) {
              return '<option value="' + esc(w.id) + '"' +
                (wsState.execWorkflow === w.id ? ' selected' : '') + '>' + esc(w.name) + '</option>';
            }).join('') +
          '</select>' +
          '<label class="ws-exec-auto">' +
            '<input type="checkbox" id="ws-exec-auto"' + (wsState.execAuto ? ' checked' : '') + ' /> ' +
            esc(t('ws.exec.autoRefresh')) +
          '</label>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="ws-icon-btn" id="ws-exec-refresh" title="' + esc(t('jobs.refresh')) + '"' +
            ' aria-label="' + esc(t('jobs.refresh')) + '">' + IC('rotate-cw', 15) + '</button>' +
        '</div>' +
        '<div id="ws-exec-body"><div class="placeholder"><span class="spinner"></span> ' +
          t('common.loading') + '</div></div>';

      var body = elPanel.querySelector('#ws-exec-body');

      function paintRows(jobs) {
        if (!jobs.length) {
          body.innerHTML =
            '<div class="ws-empty">' +
              '<span class="ws-empty-icon">' + IC('history', 22) + '</span>' +
              '<p>' + t('ws.executionsEmpty') + '</p>' +
              '<a class="btn btn-ghost btn-sm" href="#/jobs">' + t('ws.goToJobs') + '</a>' +
            '</div>';
          if (window.Icons) window.Icons.hydrate(body);
          return;
        }
        body.innerHTML =
          '<div class="ws-table-wrap' + (wsState.compact ? ' compact' : '') + '">' +
            '<table class="ws-table"><thead><tr>' +
              cols.map(function (c) { return '<th scope="col">' + t('ws.exec.' + c) + '</th>'; }).join('') +
            '</tr></thead><tbody>' + jobs.map(execRow).join('') + '</tbody></table>' +
          '</div>';
        body.querySelectorAll('[data-exec-view]').forEach(function (b) {
          b.addEventListener('click', function () {
            location.hash = '#/jobs?job=' + encodeURIComponent(b.getAttribute('data-exec-view')) +
              '&user=' + encodeURIComponent(uid);
          });
        });
        body.querySelectorAll('[data-exec-cancel]').forEach(function (b) {
          b.addEventListener('click', function () {
            b.disabled = true;
            API.cancelJob(uid, b.getAttribute('data-exec-cancel'))
              .then(function () { U().toast(t('ws.exec.cancelled'), 'success'); loadExecutions(); })
              .catch(function (err) { U().toast(err.message, 'error'); b.disabled = false; });
          });
        });
        if (window.Icons) window.Icons.hydrate(body);
      }

      function loadExecutions() {
        return API.listJobs(uid, 50, wsState.execWorkflow || null)
          .then(function (data) {
            // A late response for a tab the user already left must not paint.
            if (wsState.tab !== 'executions') return;
            paintRows(data.jobs || []);
          })
          .catch(function (err) {
            if (wsState.tab !== 'executions') return;
            body.innerHTML = '<div class="placeholder">' + IC('alert-circle') + ' ' + esc(err.message) + '</div>';
            if (window.Icons) window.Icons.hydrate(body);
          });
      }

      function syncPoll() {
        stopExecPoll();
        // Registered through track() as well, so leaving the whole view tears
        // the timer down even if paintPanel() is never called again.
        if (wsState.execAuto) execTimer = track(setInterval(loadExecutions, 8000));
      }

      elPanel.querySelector('#ws-exec-flow').addEventListener('change', function (ev) {
        wsState.execWorkflow = ev.target.value || '';
        loadExecutions();
      });
      elPanel.querySelector('#ws-exec-auto').addEventListener('change', function (ev) {
        wsState.execAuto = !!ev.target.checked;
        syncPoll();
      });
      elPanel.querySelector('#ws-exec-refresh').addEventListener('click', loadExecutions);

      if (window.Icons) window.Icons.hydrate(elPanel);
      loadExecutions();
      syncPoll();
    }

    // ---- Connections tab --------------------------------------------------
    // A workflow's "connections" are the edges it has to the outside world: the
    // outgoing webhook it reports to, and the trigger that starts it. Both are
    // owned by the editor, so this tab READS them and links there — it does not
    // become a second, competing editor for the same data.
    function connChips(wf) {
      var chips = [];
      if (wf.webhookUrl) {
        chips.push('<span class="ws-conn-chip tone-blue">' + IC('webhook', 13) + ' ' +
          esc(t('ws.conn.webhookOut')) + '<span class="ws-conn-url mono">' +
          esc(String(wf.webhookUrl)) + '</span></span>');
      }
      var trig = null;
      var steps = Array.isArray(wf.steps) ? wf.steps : [];
      for (var i = 0; i < steps.length; i++) {
        var a = steps[i] && steps[i].action;
        if (a === 'trigger' || a === 'webhook-trigger' || a === 'schedule-trigger' || a === 'telegram-trigger') {
          trig = a; break;
        }
      }
      if (trig) {
        chips.push('<span class="ws-conn-chip tone-violet">' + IC('zap', 13) + ' ' +
          esc(t('ws.conn.trigger')) + '<span class="ws-conn-url mono">' + esc(trig) + '</span></span>');
      }
      chips.push('<span class="ws-conn-chip tone-muted">' +
        IC(wf.headless === false ? 'eye' : 'eye-off', 13) + ' ' +
        esc(t(wf.headless === false ? 'ws.conn.visible' : 'ws.conn.headless')) + '</span>');
      return chips;
    }

    function paintConnectionsTab() {
      if (!workflows.length) {
        elPanel.innerHTML =
          '<div class="ws-empty">' +
            '<span class="ws-empty-icon">' + IC('git-branch', 22) + '</span>' +
            '<p>' + t('ws.connectionsEmpty') + '</p>' +
          '</div>';
        if (window.Icons) window.Icons.hydrate(elPanel);
        return;
      }
      elPanel.innerHTML = '<div class="ws-conn-grid">' + workflows.map(function (wf) {
        var chips = connChips(wf);
        // The headless chip is always present, so "no real connection" means
        // fewer than two chips — do not count the informational one as one.
        var real = chips.length - 1;
        return '<div class="ws-conn-card">' +
          '<div class="ws-conn-head">' +
            '<span class="ws-wf-icon">' + IC('sitemap', 15) + '</span>' +
            '<span class="ws-conn-name">' + esc(wf.name) + '</span>' +
            '<span class="badge">' + esc(real === 1 ? t('ws.conn.countOne')
              : fill(t('ws.conn.count'), { n: real })) + '</span>' +
          '</div>' +
          (real ? '<div class="ws-conn-chips">' + chips.join('') + '</div>'
                : '<div class="ws-conn-chips">' + chips.join('') +
                  '<p class="ws-conn-hint">' + t('ws.conn.noneHint') + '</p></div>') +
          '<div class="ws-conn-foot">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-conn="' + esc(wf.id) + '">' +
              IC('pencil', 13) + ' ' + t('ws.conn.configure') + '</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
      elPanel.querySelectorAll('[data-conn]').forEach(function (b) {
        b.addEventListener('click', function () {
          var wf = findWf(b.getAttribute('data-conn'));
          if (wf) openInEditorFromWorkspace(wf);
        });
      });
      if (window.Icons) window.Icons.hydrate(elPanel);
    }

    function paintTemplatesTab() {
      var T = window.TEMPLATES;
      if (!T) {
        elPanel.innerHTML = '<div class="ws-empty"><p>' + t('ws.templatesUnavailable') + '</p></div>';
        return;
      }
      elPanel.innerHTML = '<div class="wf-grid">' + T.list().map(function (tpl) {
        var n = Array.isArray(tpl.steps) ? tpl.steps.length : 0;
        return '<div class="wf-card">' +
          '<div class="wf-card-head">' +
            '<span class="wf-name">' + IC(tpl.icon || 'sitemap', 14) + ' ' + esc(t(tpl.name)) + '</span>' +
            '<span class="badge">' + n + ' ' + t('wf.steps') + '</span>' +
          '</div>' +
          '<div class="wf-desc muted small">' + esc(t(tpl.description)) + '</div>' +
          '<div class="wf-actions">' +
            '<button type="button" class="btn btn-primary btn-sm" data-usetpl="' + esc(tpl.id) + '">' +
              IC('plus', 13) + ' ' + t('wf.useTemplate') + '</button>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
      elPanel.querySelectorAll('[data-usetpl]').forEach(function (b) {
        b.addEventListener('click', function () {
          var tpl = T.byId(b.getAttribute('data-usetpl'));
          if (!tpl) return;
          var body = T.toWorkflowBody(tpl.id, t(tpl.name));
          if (!body) return;
          b.disabled = true;
          API.createWorkflow(uid, body)
            .then(function () {
              U().toast(t('wf.templateCreated'), 'success');
              wsState.tab = 'workflows';
              paintTabs();
              load();
            })
            .catch(function (err) { U().toast(err.message, 'error'); })
            .then(function () { b.disabled = false; });
        });
      });
    }

    // ---- header / control wiring -----------------------------------------
    var searchInput = root.querySelector('#ws-search');
    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        wsState.search = searchInput.value || '';
        wsState.page = 1;
        if (wsState.tab === 'workflows') paintWorkflowsTab();
      }, 180);
    });
    root.querySelector('#ws-sort').addEventListener('change', function (ev) {
      wsState.sort = ev.target.value;
      if (wsState.tab === 'workflows') paintWorkflowsTab();
    });
    // ---- filter panel -----------------------------------------------------
    // The locked image shows a filter button next to search; this makes it real.
    // Filters live in `wsState.filters` and are applied inside visibleWorkflows()
    // — never by removing rows from `workflows`, so clearing a filter cannot
    // require a refetch.
    var filterBtn = root.querySelector('#ws-filter');
    var filterPanel = root.querySelector('#ws-filter-panel');
    var filterBadge = root.querySelector('#ws-filter-badge');

    var WS_FILTER_GROUPS = [
      {
        key: 'status', label: 'ws.filterStatus', options: [
          { v: 'all', label: 'ws.filterAll' },
          { v: 'active', label: 'ws.filterActiveOnly' },
          { v: 'inactive', label: 'ws.filterInactiveOnly' },
        ],
      },
      {
        key: 'live', label: 'ws.filterLive', options: [
          { v: 'all', label: 'ws.filterAll' },
          { v: 'on', label: 'ws.filterLiveOn' },
          { v: 'off', label: 'ws.filterLiveOff' },
        ],
      },
    ];
    var WS_FILTER_CHECKS = [
      { key: 'scheduled', label: 'ws.filterScheduled' },
      { key: 'failing', label: 'ws.filterFailing' },
    ];

    function paintFilterBadge() {
      var n = wsActiveFilterCount();
      filterBadge.hidden = n === 0;
      filterBadge.textContent = n ? String(n) : '';
      filterBtn.setAttribute('title', n
        ? fill(t('ws.filterActiveCount'), { n: n })
        : t('ws.filter'));
    }

    function paintFilterPanel() {
      filterPanel.innerHTML =
        '<p class="ws-filter-title">' + t('ws.filterTitle') + '</p>' +
        WS_FILTER_GROUPS.map(function (g) {
          return '<div class="ws-filter-group">' +
            '<span class="ws-filter-label">' + t(g.label) + '</span>' +
            '<div class="ws-filter-seg" role="group" aria-label="' + esc(t(g.label)) + '">' +
              g.options.map(function (o) {
                var on = wsState.filters[g.key] === o.v;
                return '<button type="button" class="ws-filter-opt' + (on ? ' active' : '') + '"' +
                  ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
                  ' data-fkey="' + g.key + '" data-fval="' + o.v + '">' + t(o.label) + '</button>';
              }).join('') +
            '</div>' +
          '</div>';
        }).join('') +
        WS_FILTER_CHECKS.map(function (c) {
          return '<label class="ws-filter-check">' +
            '<input type="checkbox" data-fcheck="' + c.key + '"' +
            (wsState.filters[c.key] ? ' checked' : '') + ' /> ' + t(c.label) +
          '</label>';
        }).join('') +
        '<button type="button" class="btn btn-ghost btn-sm ws-filter-reset" id="ws-filter-reset">' +
          t('ws.filterReset') + '</button>';

      filterPanel.querySelectorAll('[data-fkey]').forEach(function (b) {
        b.addEventListener('click', function () {
          wsState.filters[b.getAttribute('data-fkey')] = b.getAttribute('data-fval');
          applyFilters();
        });
      });
      filterPanel.querySelectorAll('[data-fcheck]').forEach(function (c) {
        c.addEventListener('change', function () {
          wsState.filters[c.getAttribute('data-fcheck')] = !!c.checked;
          applyFilters();
        });
      });
      filterPanel.querySelector('#ws-filter-reset').addEventListener('click', function () {
        wsState.filters = Object.assign({}, WS_FILTER_DEFAULTS);
        applyFilters();
      });
    }

    function applyFilters() {
      wsState.page = 1;
      paintFilterBadge();
      paintFilterPanel();
      // Filters only narrow the workflow table; other tabs are unaffected.
      if (wsState.tab === 'workflows') paintWorkflowsTab();
    }

    function closeFilterPanel() {
      filterPanel.hidden = true;
      filterBtn.setAttribute('aria-expanded', 'false');
    }

    filterBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = filterPanel.hidden;
      filterPanel.hidden = !open;
      filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) paintFilterPanel();
    });
    filterPanel.addEventListener('click', function (ev) { ev.stopPropagation(); });
    filterPanel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { closeFilterPanel(); filterBtn.focus(); }
    });
    paintFilterBadge();
    root.querySelector('#ws-layout').addEventListener('click', function (ev) {
      // The column chooser is deferred (spec § 6C); the button toggles density.
      wsState.compact = !wsState.compact;
      ev.currentTarget.setAttribute('aria-pressed', wsState.compact ? 'true' : 'false');
      if (wsState.tab === 'workflows') paintWorkflowsTab();
    });
    root.querySelector('#ws-new').addEventListener('click', function () {
      if (window.FlowEditor) window.FlowEditor.newWorkflow();
      pendingWorkflowToOpen = null;
      location.hash = '#/editor';
    });
    var caret = root.querySelector('#ws-new-caret');
    var caretMenu = root.querySelector('#ws-new-menu');
    caret.addEventListener('click', function (ev) {
      ev.stopPropagation();
      caretMenu.hidden = !caretMenu.hidden;
      caret.setAttribute('aria-expanded', caretMenu.hidden ? 'false' : 'true');
    });
    caretMenu.querySelectorAll('[data-create]').forEach(function (b) {
      b.addEventListener('click', function () {
        caretMenu.hidden = true;
        caret.setAttribute('aria-expanded', 'false');
        if (b.getAttribute('data-create') === 'template') {
          wsState.tab = 'templates';
          paintTabs();
          paintPanel();
        } else {
          importWorkflowJson(uid, load);
        }
      });
    });
    // One document-level closer for every popover, so a stray click never
    // leaves a menu floating over the table.
    document.addEventListener('click', function () {
      if (caretMenu) { caretMenu.hidden = true; caret.setAttribute('aria-expanded', 'false'); }
      if (filterPanel && filterPanel.isConnected) closeFilterPanel();
      if (elPanel && elPanel.isConnected) closeRowMenus();
    });

    load();
    // The cards mix live queue counters with browser counts, so a slow poll
    // keeps them honest without the user reaching for a refresh button.
    track(setInterval(function () {
      if (location.hash.indexOf('workspace') === -1) return;
      API.workspaceStats(uid)
        .then(function (d) { if (d && d.stats) paintCards(d.stats); })
        .catch(function () {});
    }, 15000));
  }

  // =============================================
  // SETTINGS — the sixth product area.
  // Holds what the sidebar shed: the account/API key, appearance, and Quota
  // (a property of the account, not a place of its own).
  // =============================================
  function renderSettings(root) {
    var uid = effectiveUserId();
    var key = API.getKey() || '';
    var masked = key ? key.replace(/.(?=.{4})/g, '\u2022') : '—';
    root.innerHTML =
      '<section class="settings">' +
        '<header class="page-head">' +
          '<div>' +
            '<h1 class="page-h1">' + t('settings.title') + '</h1>' +
            '<p class="page-sub">' + t('settings.subtitle') + '</p>' +
          '</div>' +
        '</header>' +
        '<div class="grid grid-cards">' +
          '<div class="card">' +
            '<h3 class="card-title">' + IC('user') + ' ' + t('settings.account') + '</h3>' +
            '<dl class="kv">' +
              '<dt>' + t('settings.userId') + '</dt><dd class="mono">' + esc(uid) + '</dd>' +
              '<dt>' + t('settings.apiKey') + '</dt><dd class="mono">' + esc(masked) + '</dd>' +
            '</dl>' +
            '<div class="wf-actions">' +
              '<a class="btn btn-ghost btn-sm" href="#/quota">' + IC('gauge', 14) + ' ' +
                t('settings.openQuota') + '</a>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<h3 class="card-title">' + IC('palette') + ' ' + t('settings.appearance') + '</h3>' +
            '<p class="muted small">' + t('settings.appearanceHint') + '</p>' +
            '<div class="wf-actions">' +
              '<button type="button" class="btn btn-ghost btn-sm" id="set-lang">' +
                IC('globe', 14) + ' ' + t('settings.language') + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="card">' +
            '<h3 class="card-title">' + IC('shield') + ' ' + t('settings.admin') + '</h3>' +
            '<p class="muted small">' + t('settings.adminHint') + '</p>' +
            '<div class="wf-actions">' +
              '<a class="btn btn-ghost btn-sm" href="#/admin">' + IC('shield', 14) + ' ' + t('nav.admin') + '</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>';

    root.querySelector('#set-lang').addEventListener('click', function () {
      if (window.I18N) window.I18N.toggle();
    });
  }

  function render(route, root) {
    // Views may emit `data-icon="name"` placeholders; hydrate them into inline
    // SVG right after the route paints (Icons.hydrate is idempotent).
    if (window.Icons) {
      setTimeout(function () { window.Icons.hydrate(root); }, 0);
    }
    switch (route) {
      case 'workspace': return renderWorkspace(root);
      case 'settings': return renderSettings(root);
      case 'run': return renderRun(root);
      // Legacy library view: still reachable at #/workflows, but Workspace is
      // the hub the sidebar points at now.
      case 'workflows': return renderWorkflows(root);
      case 'editor': return renderEditor(root);
      case 'jobs': return renderJobs(root);
      case 'browser':
        if (window.BrowserView && typeof window.BrowserView.render === 'function') {
          return window.BrowserView.render(root);
        }
        root.innerHTML = '<div class="placeholder">' + IC('wand') + ' ' + t('common.comingSoon') + '</div>';
        return;
      case 'live':
        if (window.LiveView && typeof window.LiveView.render === 'function') {
          return window.LiveView.render(root);
        }
        root.innerHTML = '<div class="placeholder">' + IC('wand') + ' ' + t('common.comingSoon') + '</div>';
        return;
      case 'quota': return renderQuota(root);
      case 'schedules': return renderSchedules(root);
      case 'admin': return renderAdmin(root);
      default:
        root.innerHTML = '<div class="placeholder">' + IC('wand') + ' ' + t('common.comingSoon') + '</div>';
    }
  }

  // Step 12: allow the Live Browser View (element picker) to inject a
  // step into the linear flow builder. The step shows up next time the
  // Run page renders (and immediately if it is the active view).
  function addStep(step) {
    if (!step || typeof step !== 'object') return;
    builderSteps.push(step);
    var list = document.getElementById('steps-list');
    if (list && list.parentNode) {
      var root = list.closest('.view') || document.getElementById('app-content') || document;
      try { renderStepsList(root); } catch (e) { /* not on run page */ }
    }
  }

  window.Views = { render: render, stopAll: stopAll, addStep: addStep };
})();
