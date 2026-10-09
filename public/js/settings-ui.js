/* ============================================
   Server settings — the configuration an operator used to edit in .env.
   Every value is a choice where a choice is possible; secrets are generated
   by the server on request. Talks to /settings (src/Routes/settings.routes.ts).
   Exposes window.SettingsUI.render(container).
   ============================================ */
(function () {
  'use strict';

  var GROUPS = ['environment', 'access', 'security', 'browser', 'runs', 'storage'];
  var GROUP_ICON = { environment: 'sliders', access: 'lock', security: 'shield', browser: 'globe', runs: 'play', storage: 'database' };

  function t(k) { return window.I18N ? window.I18N.t(k) : k; }
  function fa() { return !!(window.I18N && window.I18N.getLang && window.I18N.getLang() === 'fa'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function label(o) { return fa() ? o.fa : o.en; }
  function hint(o) { return fa() ? (o.hintFa || '') : (o.hintEn || ''); }
  function toast(msg, kind) {
    if (window.AppUtil && window.AppUtil.toast) window.AppUtil.toast(msg, kind);
  }
  function errText(err) {
    var b = err && err.body;
    if (b && b.errors) {
      return Object.keys(b.errors).map(function (k) {
        var e = b.errors[k]; return (fa() ? e.errorFa : e.error) || e.error;
      }).join(' — ');
    }
    return (err && err.message) || 'Error';
  }

  function sourceBadge(s) {
    var map = { panel: ['ok', 'set.src.panel'], env: ['warn', 'set.src.env'], 'default': ['', 'set.src.default'] };
    var m = map[s.source] || map['default'];
    var out = '<span class="badge ' + m[0] + '">' + esc(t(m[1])) + '</span>';
    if (s.apply === 'restart') out += ' <span class="badge">' + esc(t('set.needsRestart')) + '</span>';
    if (s.pendingRestart) out += ' <span class="badge warn">' + esc(t('set.pendingRestart')) + '</span>';
    if (s.overridesEnv) out += ' <span class="badge warn" title="' + esc(t('set.overridesEnvHint')) + '">' + esc(t('set.overridesEnv')) + '</span>';
    return out;
  }

  function choiceControl(s, state) {
    var opts = s.options || [];
    // Segmented buttons for short lists, a select for long ones.
    if (opts.length <= 3) {
      return '<div class="set-seg" role="radiogroup" data-key="' + esc(s.key) + '">' +
        opts.map(function (o) {
          var disabled = s.key === 'AUTH_MODE' && o.value === 'open' && !state.openAllowed;
          var on = o.value === s.value;
          return '<button type="button" role="radio" class="set-seg-btn' + (on ? ' on' : '') + '"' +
            ' aria-checked="' + on + '" data-value="' + esc(o.value) + '"' +
            (disabled ? ' disabled title="' + esc(t('set.openOnlyDev')) + '"' : '') +
            (hint(o) ? ' data-hint="' + esc(hint(o)) + '"' : '') + '>' + esc(label(o)) + '</button>';
        }).join('') + '</div>';
    }
    return '<select class="set-select" data-key="' + esc(s.key) + '">' +
      opts.map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (o.value === s.value ? ' selected' : '') + '>' + esc(label(o)) + '</option>';
      }).join('') + '</select>';
  }

  function secretControl(s) {
    return '<div class="set-secret" data-key="' + esc(s.key) + '">' +
      '<code class="mono set-secret-val">' + esc(s.hasValue ? s.value : t('set.empty')) + '</code>' +
      '<div class="wf-actions">' +
        (s.hasValue ? '<button type="button" class="btn btn-ghost btn-sm" data-act="reveal">' + esc(t('set.show')) + '</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="copy">' + esc(t('set.copy')) + '</button>' : '') +
        (s.generatable ? '<button type="button" class="btn btn-primary btn-sm" data-act="generate">' + esc(t(s.key === 'API_TOKEN' ? 'set.regenerate' : 'set.generate')) + '</button>' : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="own">' + esc(t('set.useOwn')) + '</button>' +
        (s.clearable && s.hasValue ? '<button type="button" class="btn btn-ghost btn-sm" data-act="clear">' + esc(t('set.clear')) + '</button>' : '') +
      '</div>' +
      '<form class="set-own" hidden><input class="set-input mono" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(t('set.ownPlaceholder')) + '">' +
      '<button class="btn btn-primary btn-sm" type="submit">' + esc(t('set.save')) + '</button></form>' +
      (s.isPublicDefault ? '<p class="set-warn">' + esc(t('set.tokenIsDefault')) + '</p>' : '') +
      '</div>';
  }

  function textControl(s) {
    return '<form class="set-text" data-key="' + esc(s.key) + '">' +
      '<input class="set-input" type="text" dir="ltr" value="' + esc(s.value) + '" placeholder="' + esc(t('set.autoDetect')) + '" autocomplete="off" spellcheck="false">' +
      '<button class="btn btn-primary btn-sm" type="submit">' + esc(t('set.save')) + '</button>' +
      '</form>';
  }

  function row(s, state) {
    var control = s.type === 'secret' ? secretControl(s) : s.type === 'text' ? textControl(s) : choiceControl(s, state);
    return '<div class="set-row" id="set-row-' + esc(s.key) + '" data-key="' + esc(s.key) + '">' +
      '<div class="set-row-head"><span class="set-row-title">' + esc(label(s)) + '</span> ' + sourceBadge(s) + '</div>' +
      '<p class="muted small set-row-hint">' + esc(hint(s)) + '</p>' +
      control +
      '<p class="muted small set-opt-hint" hidden></p>' +
      '</div>';
  }

  function render(container) {
    if (!container) return;
    container.innerHTML = '<div class="card set-card"><p class="muted">' + esc(t('common.loading')) + '</p></div>';
    load(container);
  }

  function load(container) {
    window.API.get('/settings')
      .then(function (d) { paint(container, d); })
      .catch(function (err) {
        container.innerHTML = '<div class="card set-card"><p class="set-warn">' + esc(errText(err)) + '</p></div>';
      });
  }

  function paint(container, d) {
    var state = { openAllowed: d.openAllowed, profile: d.profile };
    var html = '<div class="set-head card">' +
      '<h3 class="card-title"><span data-icon="settings"></span> ' + esc(t('set.title')) + '</h3>' +
      '<p class="muted small">' + esc(t('set.subtitle')) + '</p>' +
      '<p class="muted small">' + esc(t('set.profileNow')) + ' <b>' + esc(t('set.profile.' + d.profile)) + '</b>' +
        (d.authOpen ? ' · <span class="badge warn">' + esc(t('set.openActive')) + '</span>' : '') + '</p>' +
      '</div>';
    GROUPS.forEach(function (g) {
      var items = d.settings.filter(function (s) { return s.group === g; });
      if (!items.length) return;
      html += '<div class="card set-card" data-group="' + g + '"><h3 class="card-title"><span data-icon="' + GROUP_ICON[g] + '"></span> ' +
        esc(t('set.group.' + g)) + '</h3>' + items.map(function (s) { return row(s, state); }).join('') + '</div>';
    });
    container.innerHTML = html;
    if (window.Icons && window.Icons.hydrate) window.Icons.hydrate(container);
    bind(container, d);
  }

  function save(container, changes, okMsg) {
    return window.API.put('/settings', { changes: changes })
      .then(function (r) { afterSave(container, r, okMsg); return r; })
      .catch(function (err) { toast(errText(err), 'error'); load(container); });
  }

  function afterSave(container, r, okMsg) {
    if (r.newApiToken) window.API.setKey(r.newApiToken);
    var notPersisted = Object.keys(r.results || {}).filter(function (k) { return !r.results[k].persisted; });
    if (notPersisted.length) toast(t('set.notPersisted'), 'error');
    else toast(okMsg || (r.restartNeeded ? t('set.savedRestart') : t('set.saved')), 'success');
    load(container);
  }

  function generate(container, key) {
    return window.API.post('/settings/generate', { key: key }).then(function (g) {
      if (g.newApiToken) window.API.setKey(g.newApiToken);
      if (!g.persisted) toast(t('set.notPersisted'), 'error');
      return g;
    });
  }

  function bind(container, d) {
    container.querySelectorAll('.set-seg').forEach(function (seg) {
      var key = seg.getAttribute('data-key');
      seg.querySelectorAll('.set-seg-btn').forEach(function (b) {
        b.addEventListener('mouseenter', function () { showHint(seg, b.getAttribute('data-hint')); });
        b.addEventListener('focus', function () { showHint(seg, b.getAttribute('data-hint')); });
        b.addEventListener('click', function () {
          if (b.classList.contains('on') || b.disabled) return;
          var value = b.getAttribute('data-value');
          var changes = {}; changes[key] = value;
          if (key === 'APP_ENV' && (value === 'server' || value === 'production')) {
            var tok = d.settings.filter(function (s) { return s.key === 'API_TOKEN'; })[0];
            if (tok && tok.isPublicDefault) {
              // A server refuses admin123: offer to generate one in the same click.
              if (!window.confirm(t('set.confirmServerToken'))) return;
              generate(container, 'API_TOKEN').then(function (g) {
                return save(container, changes).then(function () { showNewToken(g.value); });
              }).catch(function (err) { toast(errText(err), 'error'); });
              return;
            }
          }
          save(container, changes);
        });
      });
    });
    container.querySelectorAll('.set-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var changes = {}; changes[sel.getAttribute('data-key')] = sel.value; save(container, changes);
      });
    });
    container.querySelectorAll('.set-text').forEach(function (f) {
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var changes = {}; changes[f.getAttribute('data-key')] = f.querySelector('input').value.trim(); save(container, changes);
      });
    });
    container.querySelectorAll('.set-secret').forEach(function (box) {
      var key = box.getAttribute('data-key');
      var valEl = box.querySelector('.set-secret-val');
      box.addEventListener('click', function (ev) {
        var btn = ev.target.closest && ev.target.closest('button[data-act]');
        if (!btn) return;
        var act = btn.getAttribute('data-act');
        if (act === 'reveal' || act === 'copy') {
          window.API.post('/settings/reveal', { key: key }).then(function (r) {
            if (act === 'reveal') { valEl.textContent = r.value; btn.hidden = true; }
            else copy(r.value);
          }).catch(function (err) { toast(errText(err), 'error'); });
        } else if (act === 'generate') {
          if (key === 'API_TOKEN' && !window.confirm(t('set.confirmRotate'))) return;
          generate(container, key).then(function (g) {
            toast(t('set.generated'), 'success');
            load(container);
            if (key === 'API_TOKEN') showNewToken(g.value);
          }).catch(function (err) { toast(errText(err), 'error'); });
        } else if (act === 'own') {
          var f = box.querySelector('.set-own'); f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input').focus();
        } else if (act === 'clear') {
          var c = {}; c[key] = ''; save(container, c);
        }
      });
      box.querySelector('.set-own').addEventListener('submit', function (ev) {
        ev.preventDefault();
        var v = ev.target.querySelector('input').value.trim();
        if (!v) return;
        var c = {}; c[key] = v; save(container, c);
      });
    });
  }

  function showHint(seg, text) {
    var p = seg.parentNode.querySelector('.set-opt-hint');
    if (!p) return;
    p.textContent = text || ''; p.hidden = !text;
  }

  function copy(text) {
    var done = function () { toast(t('set.copied'), 'success'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { window.prompt(t('set.copy'), text); });
    } else {
      window.prompt(t('set.copy'), text);
    }
  }

  /** The one time a new token is shown in full, with a copy button. */
  function showNewToken(value) {
    var dlg = document.createElement('div');
    dlg.className = 'set-modal';
    dlg.innerHTML = '<div class="set-modal-card card" role="dialog" aria-modal="true">' +
      '<h3 class="card-title">' + esc(t('set.newTokenTitle')) + '</h3>' +
      '<p class="muted small">' + esc(t('set.newTokenHint')) + '</p>' +
      '<code class="mono set-secret-val set-big">' + esc(value) + '</code>' +
      '<div class="wf-actions"><button type="button" class="btn btn-primary btn-sm" data-a="copy">' + esc(t('set.copy')) + '</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-a="close">' + esc(t('set.close')) + '</button></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', function (ev) {
      var a = ev.target.getAttribute && ev.target.getAttribute('data-a');
      if (a === 'copy') copy(value);
      if (a === 'close' || ev.target === dlg) dlg.remove();
    });
  }

  window.SettingsUI = { render: render };
})();
