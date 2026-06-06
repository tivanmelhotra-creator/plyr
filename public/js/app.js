/* ============================================
   App controller — login flow, hash router,
   theme, language, and the dashboard (system status) view.
   Step 7: structure & auth.
   ============================================ */
(function () {
  'use strict';

  var I18N = window.I18N;
  var API = window.API;

  var el = {
    loginScreen: document.getElementById('login-screen'),
    loginForm: document.getElementById('login-form'),
    apiKeyInput: document.getElementById('api-key-input'),
    rememberKey: document.getElementById('remember-key'),
    loginError: document.getElementById('login-error'),
    loginBtn: document.getElementById('login-btn'),
    toggleKey: document.getElementById('toggle-key'),
    langToggleLogin: document.getElementById('lang-toggle-login'),

    app: document.getElementById('app'),
    sidebar: document.getElementById('sidebar'),
    content: document.getElementById('content'),
    pageTitle: document.getElementById('page-title'),
    menuToggle: document.getElementById('menu-toggle'),
    langToggle: document.getElementById('lang-toggle'),
    themeToggle: document.getElementById('theme-toggle'),
    logoutBtn: document.getElementById('logout-btn'),

    sysDot: document.getElementById('sys-dot'),
    sysText: document.getElementById('sys-text'),

    toastContainer: document.getElementById('toast-container'),
  };

  var THEME_KEY = 'ab_theme';
  var healthTimer = null;

  // ---------------------------------------------
  // Theme
  // ---------------------------------------------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }
  function initTheme() {
    var saved = localStorage.getItem(THEME_KEY) || 'dark';
    applyTheme(saved);
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    applyTheme(cur);
  }

  // ---------------------------------------------
  // Toast
  // ---------------------------------------------
  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    el.toastContainer.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 200);
    }, 3000);
  }

  // ---------------------------------------------
  // Login flow
  // ---------------------------------------------
  function showLogin() {
    stopHealthPolling();
    el.app.hidden = true;
    el.loginScreen.hidden = false;
    el.apiKeyInput.value = '';
    el.loginError.hidden = true;
  }

  function showApp() {
    el.loginScreen.hidden = true;
    el.app.hidden = false;
    startHealthPolling();
    handleRoute();
  }

  function setLoginError(msgKey) {
    el.loginError.textContent = I18N.t(msgKey);
    el.loginError.hidden = false;
  }

  function doLogin(ev) {
    if (ev) ev.preventDefault();
    var key = (el.apiKeyInput.value || '').trim();
    if (!key) { setLoginError('login.empty'); return; }

    el.loginError.hidden = true;
    el.loginBtn.disabled = true;
    var labelSpan = el.loginBtn.querySelector('span');
    var origLabel = labelSpan ? labelSpan.textContent : '';
    if (labelSpan) labelSpan.textContent = I18N.t('login.checking');

    API.validateKey(key)
      .then(function (result) {
        if (!result || !result.valid) { setLoginError('login.invalid'); return; }
        API.setKey(key);
        API.setUserId(result.userId || '');
        if (!el.rememberKey.checked) {
          // mark as session-only: clear on tab close
          sessionStorage.setItem('ab_session_only', '1');
        } else {
          sessionStorage.removeItem('ab_session_only');
        }
        showApp();
      })
      .catch(function () {
        setLoginError('login.invalid');
      })
      .finally(function () {
        el.loginBtn.disabled = false;
        if (labelSpan) labelSpan.textContent = origLabel || I18N.t('login.submit');
      });
  }

  function doLogout() {
    API.clearKey();
    sessionStorage.removeItem('ab_session_only');
    toast(I18N.t('common.logoutDone'));
    showLogin();
  }

  // ---------------------------------------------
  // Health / system status
  // ---------------------------------------------
  function setSysIndicator(state, textKey) {
    el.sysDot.className = 'dot ' + (state || '');
    el.sysText.textContent = I18N.t(textKey);
  }

  function formatUptime(sec) {
    sec = Math.max(0, parseInt(sec, 10) || 0);
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var parts = [];
    if (d) parts.push(d + 'd');
    if (h) parts.push(h + 'h');
    if (m) parts.push(m + 'm');
    parts.push(s + (I18N.getLang() === 'fa' ? '' : 's'));
    return parts.join(' ');
  }

  function fetchHealth() {
    return API.health()
      .then(function (data) {
        var ok = data && data.status === 'ok' && data.redis === 'connected';
        setSysIndicator(ok ? 'ok' : 'warn', ok ? 'status.online' : 'status.degraded');
        return data;
      })
      .catch(function () {
        setSysIndicator('bad', 'status.offline');
        throw new Error('health failed');
      });
  }

  function startHealthPolling() {
    stopHealthPolling();
    fetchHealth().catch(function () {});
    healthTimer = setInterval(function () {
      fetchHealth()
        .then(function (data) {
          // if dashboard view is open, refresh its content too
          if (currentRoute() === 'dashboard') renderDashboardData(data);
        })
        .catch(function () {});
    }, 10000);
  }
  function stopHealthPolling() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  // ---------------------------------------------
  // Views
  // ---------------------------------------------
  var ROUTES = ['dashboard', 'run', 'workflows', 'editor', 'jobs', 'live', 'browser', 'schedules', 'quota', 'admin'];

  function currentRoute() {
    var hash = (location.hash || '').replace(/^#\//, '');
    return ROUTES.indexOf(hash) !== -1 ? hash : 'dashboard';
  }

  function boolBadge(val) {
    var on = !!val;
    return '<span class="badge ' + (on ? 'ok' : 'bad') + '">' +
      I18N.t(on ? 'dash.on' : 'dash.off') + '</span>';
  }

  function renderDashboardShell() {
    el.content.innerHTML =
      '<div class="grid grid-cards" id="dash-cards">' +
        '<div class="placeholder"><span class="spinner"></span> ' + I18N.t('common.loading') + '</div>' +
      '</div>';
    fetchHealth()
      .then(renderDashboardData)
      .catch(function () {
        el.content.innerHTML =
          '<div class="placeholder">⚠️ ' + I18N.t('dash.loadError') +
          ' <br><br><button class="btn btn-ghost btn-sm" id="dash-retry">' + I18N.t('dash.refresh') + '</button></div>';
        var r = document.getElementById('dash-retry');
        if (r) r.addEventListener('click', renderDashboardShell);
      });
  }

  function renderDashboardData(data) {
    if (currentRoute() !== 'dashboard') return;
    if (!data) return;
    var b = data.browsers || {};
    var f = data.features || {};
    var redisOk = data.redis === 'connected';
    var luaOk = data.luaScripts === 'loaded';

    var html = '';

    // System card
    html +=
      '<div class="card">' +
        '<h3 class="card-title">🩺 ' + I18N.t('dash.title') + '</h3>' +
        '<dl class="kv">' +
          '<dt>' + I18N.t('dash.version') + '</dt><dd>v' + esc(data.version) + '</dd>' +
          '<dt>' + I18N.t('dash.uptime') + '</dt><dd>' + esc(formatUptime(data.uptime)) + '</dd>' +
          '<dt>' + I18N.t('dash.redis') + '</dt><dd>' +
            '<span class="badge ' + (redisOk ? 'ok' : 'bad') + '">' +
            I18N.t(redisOk ? 'dash.connected' : 'dash.disconnected') + '</span></dd>' +
          '<dt>' + I18N.t('dash.lua') + '</dt><dd>' +
            '<span class="badge ' + (luaOk ? 'ok' : 'warn') + '">' +
            I18N.t(luaOk ? 'dash.loaded' : 'dash.fallback') + '</span></dd>' +
        '</dl>' +
      '</div>';

    // Browsers card
    html +=
      '<div class="card">' +
        '<h3 class="card-title">🌐 ' + I18N.t('dash.browsers') + '</h3>' +
        '<dl class="kv">' +
          '<dt>' + I18N.t('dash.vip') + '</dt><dd>' + num(b.vip) + '</dd>' +
          '<dt>' + I18N.t('dash.free') + '</dt><dd>' + num(b.free) + '</dd>' +
          '<dt>' + I18N.t('dash.total') + '</dt><dd>' + num(b.total) + '</dd>' +
          '<dt>' + I18N.t('dash.pages') + '</dt><dd>' + num(b.registeredPages) + '</dd>' +
        '</dl>' +
      '</div>';

    // Features card
    html +=
      '<div class="card">' +
        '<h3 class="card-title">⚙️ ' + I18N.t('dash.features') + '</h3>' +
        '<dl class="kv">' +
          '<dt>' + I18N.t('feat.flattener') + '</dt><dd>' + boolBadge(f.flattenerEnabled) + '</dd>' +
          '<dt>' + I18N.t('feat.resourceBlocking') + '</dt><dd>' + boolBadge(f.resourceBlocking) + '</dd>' +
          '<dt>' + I18N.t('feat.turbo') + '</dt><dd>' + boolBadge(f.turboMode) + '</dd>' +
          '<dt>' + I18N.t('feat.sequential') + '</dt><dd>' + boolBadge(f.freeForceSequential) + '</dd>' +
          '<dt>' + I18N.t('feat.webhookRetries') + '</dt><dd>' + num(f.webhookRetries) + '</dd>' +
        '</dl>' +
      '</div>';

    el.content.innerHTML = '<div class="grid grid-cards">' + html + '</div>';
  }

  function renderComingSoon() {
    el.content.innerHTML =
      '<div class="placeholder">🚧 ' + I18N.t('common.comingSoon') + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) {
    return (n == null || isNaN(n)) ? '—' : String(n);
  }

  // ---------------------------------------------
  // Router
  // ---------------------------------------------
  function handleRoute() {
    if (el.app.hidden) return;
    var route = currentRoute();

    // highlight nav
    var items = el.sidebar.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-route') === route);
    }
    // page title
    el.pageTitle.setAttribute('data-i18n', 'nav.' + route);
    el.pageTitle.textContent = I18N.t('nav.' + route);

    // close mobile sidebar
    el.sidebar.classList.remove('open');
    removeOverlay();

    // stop any per-view polling from the previous view
    if (window.Views && typeof window.Views.stopAll === 'function') {
      window.Views.stopAll();
    }

    if (route === 'dashboard') { renderDashboardShell(); return; }

    if (window.Views && typeof window.Views.render === 'function') {
      window.Views.render(route, el.content);
    } else {
      renderComingSoon();
    }
  }

  // ---------------------------------------------
  // Mobile sidebar overlay
  // ---------------------------------------------
  function removeOverlay() {
    var ov = document.querySelector('.sidebar-overlay');
    if (ov) ov.remove();
  }
  function toggleSidebar() {
    var open = el.sidebar.classList.toggle('open');
    removeOverlay();
    if (open) {
      var ov = document.createElement('div');
      ov.className = 'sidebar-overlay';
      ov.addEventListener('click', function () {
        el.sidebar.classList.remove('open');
        removeOverlay();
      });
      document.body.appendChild(ov);
    }
  }

  // ---------------------------------------------
  // Wire up events
  // ---------------------------------------------
  function bind() {
    el.loginForm.addEventListener('submit', doLogin);
    el.toggleKey.addEventListener('click', function () {
      el.apiKeyInput.type = el.apiKeyInput.type === 'password' ? 'text' : 'password';
    });
    el.langToggleLogin.addEventListener('click', function () { I18N.toggle(); });

    el.logoutBtn.addEventListener('click', doLogout);
    el.langToggle.addEventListener('click', function () { I18N.toggle(); });
    el.themeToggle.addEventListener('click', toggleTheme);
    el.menuToggle.addEventListener('click', toggleSidebar);

    window.addEventListener('hashchange', handleRoute);

    document.addEventListener('i18n:change', function () {
      // update login toggle label
      el.langToggleLogin.textContent = I18N.meta().label;
      // re-render current view so dynamic text follows language
      if (!el.app.hidden) handleRoute();
    });
  }

  // ---------------------------------------------
  // Shared utilities exposed to views.js
  // ---------------------------------------------
  window.AppUtil = {
    toast: toast,
    esc: esc,
    num: num,
    t: function (k) { return I18N.t(k); },
    navigate: function (route) { location.hash = '#/' + route; },
    lang: function () { return I18N.getLang(); },
    formatUptime: formatUptime,
  };

  // ---------------------------------------------
  // Boot
  // ---------------------------------------------
  function boot() {
    initTheme();
    I18N.apply();
    el.langToggleLogin.textContent = I18N.meta().label;
    bind();

    var storedKey = API.getKey();
    if (storedKey) {
      // Re-validate the stored key once on boot so revoked/expired keys
      // fall back to the login screen instead of a broken dashboard.
      API.validateKey(storedKey)
        .then(function (result) {
          if (result && result.valid) {
            if (result.userId) API.setUserId(result.userId);
            showApp();
          } else {
            API.clearKey();
            showLogin();
          }
        })
        .catch(function () {
          // network error: optimistically show the app, health polling will warn
          showApp();
        });
    } else {
      showLogin();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
