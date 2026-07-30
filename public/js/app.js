/* ============================================
   App controller — login flow, hash router,
   theme, language, and the dashboard (system status) view.
   Step 7: structure & auth.
   ============================================ */
(function () {
  'use strict';

  // Inline SVG icon helper (public/js/icons.js). Emoji glyphs were removed
  // project-wide: the target font stack has no emoji coverage, so they rendered
  // as empty boxes, and they could not be tinted with `currentColor`.
  function ICN(name, size) {
    return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : '';
  }

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
    launcher: document.getElementById('launcher'),
    launcherBtn: document.getElementById('launcher-btn'),
    launcherMenu: document.getElementById('launcher-menu'),
    langToggle: document.getElementById('lang-toggle'),
    themeToggle: document.getElementById('theme-toggle'),
    logoutBtn: document.getElementById('logout-btn'),

    sysDot: document.getElementById('sys-dot'),
    sysText: document.getElementById('sys-text'),

    toastContainer: document.getElementById('toast-container'),
  };

  var THEME_KEY = 'ab_theme';
  var PREFS_KEY = 'ab_ui_prefs';
  var healthTimer = null;

  // ---------------------------------------------
  // UI preferences
  // ---------------------------------------------
  // Small, sticky view choices (is the blocks palette collapsed? is the OUTLINE
  // panel open?) live in ONE namespaced blob instead of a new localStorage key
  // per switch — the alternative grows an unbounded set of `ab_*` keys that
  // nothing ever cleans up, and makes "reset my layout" impossible to implement.
  //
  // Deliberately NOT for anything the server owns: preferences here are per
  // browser, so putting real user settings in them would silently desync
  // between devices.
  function readPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      // A hand-edited or half-written value must not break booting the app.
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch (e) { return {}; }
  }

  /** Read one preference, returning `fallback` when it was never set. */
  function pref(key, fallback) {
    var all = readPrefs();
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
  }

  /** Persist one preference, leaving every other key untouched. */
  function setPref(key, value) {
    var all = readPrefs();
    all[key] = value;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(all)); } catch (e) { /* quota / private mode */ }
    return value;
  }

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
    document.body.classList.remove('route-fullbleed');
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

  /**
   * The last `/health` payload, kept so views can render REAL server facts
   * (`env`, `mode`, `version`) instead of hardcoding a plausible-looking value.
   * `null` means "not known yet or the probe failed" — consumers must show `—`
   * in that case rather than assuming a default.
   */
  var lastHealth = null;

  function setHealth(data) {
    lastHealth = data || null;
    // A DOM event, so a view can subscribe without app.js knowing it exists.
    document.dispatchEvent(new CustomEvent('health:change', { detail: lastHealth }));
  }

  function fetchHealth() {
    return API.health()
      .then(function (data) {
        var ok = data && data.status === 'ok' && data.redis === 'connected';
        setSysIndicator(ok ? 'ok' : 'warn', ok ? 'status.online' : 'status.degraded');
        setHealth(data);
        return data;
      })
      .catch(function () {
        setSysIndicator('bad', 'status.offline');
        // Drop the stale payload: a cached `production` badge next to an
        // OFFLINE indicator would be worse than no badge at all.
        setHealth(null);
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
  // The six product areas — and ONLY these six — appear in the sidebar and in
  // the App Launcher (docs/uiux/workspace-overview.md § 3A).
  var NAV_ROUTES = ['home', 'workspace', 'dashboard', 'jobs', 'admin', 'settings'];

  /**
   * Deep routes: still addressable, but deliberately absent from the chrome.
   * They are opened FROM something (a workflow row, the editor, Settings), so
   * putting them in the sidebar was the clutter this change removes.
   */
  var DEEP_ROUTES = ['workflows', 'editor', 'run', 'live', 'browser', 'schedules', 'quota'];

  var ROUTES = NAV_ROUTES.concat(DEEP_ROUTES);

  /**
   * Which sidebar entry lights up for a deep route. A user standing in the
   * editor is still "in" the Workspace area; Quota is a Settings sub-page.
   */
  var ROUTE_PARENT = {
    workflows: 'workspace',
    editor: 'workspace',
    run: 'workspace',
    live: 'workspace',
    browser: 'workspace',
    schedules: 'workspace',
    quota: 'settings',
  };

  /**
   * Routes that own the whole viewport. The design images for the editor
   * (`docs/uiux/state-empty-canvas.webp`) show NO app sidebar and NO page
   * heading — the editor's own top bar starts at y=0 and its status bar closes
   * the screen. A route listed here gets `body.route-fullbleed`; the stylesheet
   * hides `.sidebar` / `.topbar` and lets the view fill `100vh`.
   *
   * Only add a route here if its view re-exposes the chrome's destinations
   * itself, otherwise the hidden header takes Logout / Language with it.
   */
  var FULLBLEED_ROUTES = ['editor'];

  // Legacy hashes kept working so bookmarks and in-app links from before the
  // architecture change do not 404 into the default route.
  var ROUTE_ALIAS = { flows: 'workspace', library: 'workspace', account: 'settings' };

  var DEFAULT_ROUTE = 'workspace';

  function currentRoute() {
    var hash = (location.hash || '').replace(/^#\//, '');
    // strip any `?a=b` query the deep views append (jobs?job=…, editor?wf=…)
    var q = hash.indexOf('?');
    if (q !== -1) hash = hash.substring(0, q);
    if (ROUTE_ALIAS[hash]) hash = ROUTE_ALIAS[hash];
    return ROUTES.indexOf(hash) !== -1 ? hash : DEFAULT_ROUTE;
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
          '<div class="placeholder">' + ICN('alert-circle') + ' ' + I18N.t('dash.loadError') +
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
        '<h3 class="card-title">' + ICN('gauge') + ' ' + I18N.t('dash.title') + '</h3>' +
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
        '<h3 class="card-title">' + ICN('globe') + ' ' + I18N.t('dash.browsers') + '</h3>' +
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
        '<h3 class="card-title">' + ICN('sliders') + ' ' + I18N.t('dash.features') + '</h3>' +
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

  /**
   * HOME — the landing area of the six-item architecture.
   *
   * Deliberately thin: it is a set of doors into the real areas plus the live
   * system pulse. Everything operational lives in Workspace (workflows) or
   * Dashboard (system internals); duplicating them here is how landing pages
   * rot.
   */
  var HOME_TILES = [
    { route: 'workspace', icon: 'layout', title: 'nav.workspace', desc: 'home.workspaceDesc' },
    { route: 'dashboard', icon: 'bar-chart', title: 'nav.dashboard', desc: 'home.dashboardDesc' },
    { route: 'jobs', icon: 'layers', title: 'nav.jobs', desc: 'home.jobsDesc' },
    { route: 'admin', icon: 'shield', title: 'nav.admin', desc: 'home.adminDesc' },
    { route: 'settings', icon: 'settings', title: 'nav.settings', desc: 'home.settingsDesc' },
  ];

  function renderHome() {
    var tiles = HOME_TILES.map(function (tile) {
      return '<a class="home-tile" href="#/' + tile.route + '">' +
        '<span class="home-tile-icon">' + ICN(tile.icon, 18) + '</span>' +
        '<span class="home-tile-body">' +
          '<span class="home-tile-title">' + esc(I18N.t(tile.title)) + '</span>' +
          '<span class="home-tile-desc">' + esc(I18N.t(tile.desc)) + '</span>' +
        '</span>' +
        '<span class="home-tile-go">' + ICN('chevron-right', 16) + '</span>' +
      '</a>';
    }).join('');

    el.content.innerHTML =
      '<section class="home">' +
        '<header class="page-head">' +
          '<div>' +
            '<h1 class="page-h1">' + esc(I18N.t('home.title')) + '</h1>' +
            '<p class="page-sub">' + esc(I18N.t('home.subtitle')) + '</p>' +
          '</div>' +
          '<a class="btn btn-primary" href="#/workspace">' + ICN('layout', 15) + ' ' +
            esc(I18N.t('home.openWorkspace')) + '</a>' +
        '</header>' +
        '<div class="home-grid">' + tiles + '</div>' +
      '</section>';
  }

  function renderComingSoon() {
    el.content.innerHTML =
      '<div class="placeholder">' + ICN('wand') + ' ' + I18N.t('common.comingSoon') + '</div>';
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
    var area = ROUTE_PARENT[route] || route;

    // highlight nav: a deep route lights up the AREA it belongs to, so the
    // sidebar never looks "nowhere" while you are inside the editor.
    var items = el.sidebar.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-route') === area);
    }
    markLauncherCurrent(area);

    // page title
    el.pageTitle.setAttribute('data-i18n', 'nav.' + route);
    el.pageTitle.textContent = I18N.t('nav.' + route);

    // FULL-BLEED ROUTES. `docs/uiux/state-empty-canvas.webp` puts the editor's
    // OWN top bar at y=0 and its status bar at the very bottom of the screen:
    // there is no app sidebar and no "Visual Editor" page heading in the design
    // at all, because the editor is a workspace, not a page inside one. Rather
    // than duplicating the shell chrome, the route drops it — one body class the
    // stylesheet keys off (`body.route-fullbleed`, styles.css § Full-bleed).
    // The editor's own bar re-exposes every destination the hidden chrome owned
    // (Home / Workspace links, gear, and the account menu below), so nothing
    // becomes unreachable.
    document.body.classList.toggle('route-fullbleed', FULLBLEED_ROUTES.indexOf(route) !== -1);

    // close mobile sidebar + the launcher panel
    el.sidebar.classList.remove('open');
    closeLauncher();
    removeOverlay();

    // stop any per-view polling from the previous view
    if (window.Views && typeof window.Views.stopAll === 'function') {
      window.Views.stopAll();
    }

    if (route === 'dashboard') { renderDashboardShell(); return; }
    if (route === 'home') { renderHome(); return; }

    if (window.Views && typeof window.Views.render === 'function') {
      window.Views.render(route, el.content);
    } else {
      renderComingSoon();
    }
  }

  // ---------------------------------------------
  // App Launcher (docs/uiux/shell-editor-launcher-menu.md § 2)
  //
  // Lives in the shell, not in a view: the Workspace header and the editor
  // header show the SAME component, so duplicating it per view would guarantee
  // the two drift apart.
  // ---------------------------------------------
  function launcherItems() {
    if (!el.launcherMenu) return [];
    return Array.prototype.slice.call(el.launcherMenu.querySelectorAll('.launcher-item'));
  }

  function launcherOpen() {
    return !!(el.launcherMenu && !el.launcherMenu.hidden);
  }

  function markLauncherCurrent(area) {
    launcherItems().forEach(function (btn) {
      var on = btn.getAttribute('data-route') === area;
      btn.classList.toggle('current', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  function openLauncher() {
    if (!el.launcherMenu || launcherOpen()) return;
    el.launcherMenu.hidden = false;
    el.launcherBtn.setAttribute('aria-expanded', 'true');
    el.launcherBtn.classList.add('open');
    var items = launcherItems();
    if (items.length) items[0].focus();
  }

  function closeLauncher(restoreFocus) {
    if (!el.launcherMenu || !launcherOpen()) return;
    el.launcherMenu.hidden = true;
    el.launcherBtn.setAttribute('aria-expanded', 'false');
    el.launcherBtn.classList.remove('open');
    if (restoreFocus) el.launcherBtn.focus();
  }

  function toggleLauncher() {
    if (launcherOpen()) closeLauncher(true);
    else openLauncher();
  }

  function moveLauncherFocus(delta) {
    var items = launcherItems();
    if (!items.length) return;
    var idx = items.indexOf(document.activeElement);
    var next = idx === -1 ? 0 : (idx + delta + items.length) % items.length;
    items[next].focus();
  }

  function bindLauncher() {
    if (!el.launcherBtn || !el.launcherMenu) return;

    el.launcherBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleLauncher();
    });

    launcherItems().forEach(function (btn) {
      btn.addEventListener('click', function () {
        var route = btn.getAttribute('data-route');
        closeLauncher();
        location.hash = '#/' + route;
      });
    });

    // Keyboard model: arrows cycle, Home/End jump, Esc closes and gives focus
    // back to the button, Tab is NOT trapped (it closes and moves on).
    el.launcherMenu.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveLauncherFocus(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveLauncherFocus(-1); }
      else if (ev.key === 'Home') { ev.preventDefault(); launcherItems()[0].focus(); }
      else if (ev.key === 'End') {
        ev.preventDefault();
        var items = launcherItems();
        items[items.length - 1].focus();
      } else if (ev.key === 'Tab') { closeLauncher(); }
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && launcherOpen()) closeLauncher(true);
    });
    document.addEventListener('click', function (ev) {
      if (!launcherOpen()) return;
      if (el.launcher && el.launcher.contains(ev.target)) return;
      closeLauncher();
    });
    window.addEventListener('blur', function () { closeLauncher(); });
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
    bindLauncher();

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
    // Sticky view state (see PREFS_KEY above). The editor uses these so a
    // collapsed palette / closed OUTLINE survives a reload instead of springing
    // back open on every navigation.
    pref: pref,
    setPref: setPref,
    // Latest /health payload, or null when unknown. Paired with the
    // `health:change` document event above.
    health: function () { return lastHealth; },
    // The full-bleed editor hides the app header, so its own account menu has
    // to be able to end the session. Exposed rather than re-implemented: two
    // logout paths would drift (one clearing `ab_session_only`, one not).
    logout: doLogout,
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
