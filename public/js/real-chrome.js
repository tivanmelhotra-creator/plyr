/* ============================================
   real-chrome.js — control panel for the REAL Chrome.

   WHY THIS PANEL EXISTS
   ---------------------
   The picker canvas is a screencast of a PAGE. It can never show a Chrome
   extension's toolbar popup, chrome://extensions, or the native file dialog,
   because none of those are drawn by the page. People who rely on a cookie
   export/import extension therefore hit a hard wall in the simulated view.

   This panel exposes the three ways out, in the order of least effort:

     1. Import cookie file   — the fastest path to "I am logged in". Parses a
        Cookie-Editor / EditThisCookie / cookies.txt export server-side and puts
        the cookies in the profile, so BOTH the picker and queued runs get them.
     2. Open an extension    — an extension popup is also an extension PAGE, so
        it can be opened as a tab right inside this canvas, with full extension
        privileges. This is how you drive your cookie extension without a VNC.
     3. Open the desktop     — the whole Chrome window over noVNC, for the cases
        that genuinely need the toolbar or a native dialog.

   Exposes window.RealChromePanel.
   No inline handlers, no eval: the app runs under a strict CSP.
   ============================================ */
(function () {
  'use strict';

  var T = (window.I18N && window.I18N.t) ? window.I18N.t : function (k) { return k; };

  function t(key, fallback) {
    var v = T(key);
    // i18n returns the key itself when a string is missing; prefer readable
    // English over a raw dotted key leaking into the UI.
    return (v && v !== key) ? v : fallback;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function btn(label, cls) {
    var b = el('button', cls || 'btn btn-sm', label);
    b.type = 'button';
    return b;
  }

  /**
   * Icon-only button.
   *
   * Glyphs like "✕" are banned in shipped UI code (tests/unit/icons.test.ts
   * enforces it): they render differently per platform, some fonts have no
   * coverage at all, and they are invisible to a screen reader. Everything goes
   * through the shared SVG registry, with a text label as the accessible name.
   */
  function iconBtn(name, label, cls) {
    var b = el('button', cls || 'icon-btn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (window.Icons && window.Icons.svg) {
      b.innerHTML = window.Icons.svg(name, { size: 14 });
    } else {
      b.textContent = label;
    }
    return b;
  }

  /**
   * Tell the extension page WHICH site it is being opened for.
   *
   * MEASURED (tools/probe-j2team-tmp.js, real J2TEAM Cookies):
   *
   *   popup.html              → "Cookies for this page", no download at all
   *   popup.html?url=<base64> → "Cookies for 127.0.0.1",
   *                             downloads 127.0.0.1_09-08-2026.json
   *
   * The reason is that "Open here" opens the popup as a TAB, so the extension's
   * own `chrome.tabs.query({active: true})` finds the popup instead of the site.
   * Import still worked (a file needs no site) but Export silently did nothing —
   * exactly the reported bug. `?url=` is the extension's own convention for the
   * open-as-tab case; its own "open in tab" button builds the same link.
   *
   * Two rules, both measured (tools/probe-b64-tmp.js):
   *   1. btoa() THROWS on any code unit > 0xff, so encode `new URL(u).href`,
   *      which is always ASCII, not the raw text. Otherwise a Persian/IDN URL
   *      such as https://مهدی.com/ would throw and break "Open here" entirely.
   *   2. http(s) only — about:blank and chrome-extension:// give origin `null`,
   *      which is no site at all.
   *
   * Returns the URL unchanged when there is nothing useful to add, so no other
   * extension's behaviour changes.
   */
  function pageUrlParam(popupUrl, pageUrl) {
    if (!popupUrl) return popupUrl;
    if (popupUrl.indexOf('?url=') >= 0 || popupUrl.indexOf('&url=') >= 0) return popupUrl;
    var href;
    try {
      var u = new URL(String(pageUrl || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return popupUrl;
      href = u.href;
    } catch (e) {
      return popupUrl;
    }
    var b64;
    try {
      b64 = btoa(href);
    } catch (e) {
      return popupUrl; // never let encoding break opening the popup
    }
    return popupUrl + (popupUrl.indexOf('?') >= 0 ? '&' : '?')
      + 'url=' + encodeURIComponent(b64);
  }

  // ── state ─────────────────────────────────────────────────────────────────
  // `pageUrl` is a getter for the URL the picker canvas is currently on: the
  // extension is opened FOR that page, and some extensions must be told so.
  var current = null; // { root, onNavigate, pageUrl, status }

  function close() {
    if (!current) return;
    if (current.root && current.root.parentNode) {
      current.root.parentNode.removeChild(current.root);
    }
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    current = null;
  }

  function onOutside(ev) {
    if (!current) return;
    if (current.root.contains(ev.target)) return;
    // The trigger button toggles; ignoring it here stops close-then-reopen.
    if (current.anchor && current.anchor.contains(ev.target)) return;
    close();
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && current) {
      ev.stopPropagation();
      close();
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function setBusy(node, busy, label) {
    node.disabled = !!busy;
    if (busy) {
      node.dataset.label = node.textContent;
      node.textContent = label || '…';
    } else if (node.dataset.label) {
      node.textContent = node.dataset.label;
      delete node.dataset.label;
    }
  }

  function section(parent, title) {
    var s = el('div', 'rc-section');
    s.appendChild(el('div', 'rc-section-title', title));
    parent.appendChild(s);
    return s;
  }

  function note(parent, text, kind) {
    var n = el('div', 'rc-note' + (kind ? ' is-' + kind : ''), text);
    parent.appendChild(n);
    return n;
  }

  function render(root, status) {
    root.innerHTML = '';

    var head = el('div', 'rc-head');
    head.appendChild(el('span', 'rc-title', t('rc.title', 'Real Chrome')));
    var closeBtn = iconBtn('x', t('bvp.cancel', 'Close'), 'icon-btn rc-close');
    closeBtn.addEventListener('click', close);
    head.appendChild(closeBtn);
    root.appendChild(head);

    var body = el('div', 'rc-body');
    root.appendChild(body);

    var rc = status.realChrome || {};
    var desk = status.desktop || {};

    // ── 1. Browser state ────────────────────────────────────────────────────
    var s1 = section(body, t('rc.browser', 'Browser'));
    var stateRow = el('div', 'rc-row');
    var chip = el('span', 'badge ' + (rc.running ? 'ok' : ''),
      rc.running
        ? t('rc.running', 'running') + (rc.browserVersion ? ' · ' + rc.browserVersion : '')
        : (rc.enabled ? t('rc.stopped', 'stopped') : t('rc.disabled', 'disabled')));
    stateRow.appendChild(chip);
    s1.appendChild(stateRow);

    if (!rc.enabled) {
      note(s1,
        t('rc.disabledHint',
          'Real Chrome is off. Set REAL_CHROME_ENABLED=true in .env and restart the server. ' +
          'Without it, extensions cannot be loaded at all.'),
        'warn');
    } else {
      var acts = el('div', 'rc-row');
      var startBtn = btn(rc.running ? t('rc.restart', 'Restart') : t('rc.start', 'Start'),
        'btn btn-primary btn-sm');
      startBtn.addEventListener('click', function () {
        setBusy(startBtn, true, t('rc.starting', 'starting…'));
        window.API.post(rc.running ? '/browser/restart' : '/browser/start', {})
          .then(refresh)
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () { setBusy(startBtn, false); });
      });
      acts.appendChild(startBtn);

      if (rc.running) {
        var stopBtn = btn(t('rc.stop', 'Stop'), 'btn btn-sm');
        stopBtn.addEventListener('click', function () {
          setBusy(stopBtn, true);
          window.API.post('/browser/stop', {})
            .then(refresh)
            .catch(function (e) { toast(e.message, 'error'); })
            .then(function () { setBusy(stopBtn, false); });
        });
        acts.appendChild(stopBtn);
      }
      s1.appendChild(acts);

      if (rc.lastError) note(s1, rc.lastError, 'error');
      if (rc.debugUrl) {
        note(s1, t('rc.devtools', 'DevTools port') + ': ' + rc.debugUrl +
          ' — ' + t('rc.devtoolsHint',
            'attach any CDP client, or open chrome://inspect in your own Chrome.'));
      }
    }

    // ── 1b. Launch options ──────────────────────────────────────────────────
    // THE OPERATOR'S COMPLAINT: «به جای اینکه من بخوام دونه دونه سرچ کنم تگ‌ها
    // رو پیدا کنم … با فرم‌های چک‌باکس مشخص کنم … و باید در کنارش حواسمون به
    // کاربران تازه‌کار هم باشه که در کنار چک‌باکس‌ها گزینه‌های استاندارد هم باشه»
    //
    // So: presets FIRST (a beginner never has to understand a single switch),
    // the checkboxes second and collapsed (an expert loses nothing), and the
    // environment profile shown alongside so nobody has to guess which of 77
    // variables decided what.
    //
    // The catalogue is FETCHED, never hard-coded here. A copy in the front-end
    // would drift from the flags Chrome actually gets, and a settings screen
    // that lies about the running configuration is worse than none.
    /**
     * Draw the preset picker, the grouped checkboxes and the profile rows.
     *
     * Renders a placeholder immediately and fills it in when the catalogue
     * arrives, so a slow request degrades to "loading" instead of a section that
     * silently never appears.
     */
    function renderLaunchOptions(host) {
      // Local, not shared: reopening the panel must not inherit half-finished
      // edits from a previous session that were never saved.
      var chosen = null;   // Set of flag ids that are ticked
      var presetId = null;
      var catalogue = null;

      var loading = note(host, t('rc.loading', 'Loading…'));

      window.API.get('/browser/real/flags')
        .then(function (d) {
          catalogue = d || {};
          presetId = (d && d.selected && d.selected.presetId) || (d && d.defaultPreset) || 'standard';
          chosen = idSet((d && d.selected && d.selected.ids) || []);
          if (loading && loading.parentNode) loading.parentNode.removeChild(loading);
          paint(host);
        })
        .catch(function (e) {
          if (loading && loading.parentNode) loading.parentNode.removeChild(loading);
          note(host, e.message, 'error');
        });

      function idSet(list) {
        var s = {};
        (list || []).forEach(function (id) { s[id] = true; });
        return s;
      }

      function presetById(id) {
        var list = (catalogue && catalogue.presets) || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
      }

      /**
       * Localised text off a catalogue entry: the API ships both languages.
       *
       * I18N exposes getLang(), NOT a `.lang` property — reading `.lang` yields
       * undefined and would silently pin this whole form to English for a
       * Persian-speaking operator, which is the one user this project has.
       */
      function isFa() {
        return !!(window.I18N && typeof window.I18N.getLang === 'function'
          && window.I18N.getLang() === 'fa');
      }

      function loc(obj, key) {
        return (isFa() && obj[key + 'Fa']) ? obj[key + 'Fa'] : obj[key];
      }

      function isRequired(id) {
        var req = (catalogue && catalogue.required) || [];
        return req.indexOf(id) >= 0;
      }

      function paint(hostNode) {
        hostNode.innerHTML = '';

        // ── the profile, and who decided what ────────────────────────────────
        renderProfile(hostNode);

        // ── presets: the beginner's whole answer ─────────────────────────────
        note(hostNode, t('rc.presetHint',
          'Pick a standard option. Only open the switches below if you need something specific.'));

        var presetWrap = el('div', 'rc-presets');
        ((catalogue && catalogue.presets) || []).forEach(function (p) {
          var row = el('label', 'rc-preset' + (p.id === presetId ? ' is-on' : ''));
          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'rc-preset';
          radio.value = p.id;
          radio.checked = p.id === presetId;
          radio.addEventListener('change', function () {
            presetId = p.id;
            // Switching to a named preset REPLACES the ticks. Switching to
            // custom keeps them: that is the point of custom — start from a
            // preset and adjust, as the operator asked.
            if (p.id !== 'custom') chosen = idSet(p.flags);
            paint(hostNode);
          });
          row.appendChild(radio);
          var txt = el('span', 'rc-preset-text');
          var name = el('span', 'rc-preset-name', loc(p, 'label'));
          if (p.recommended) {
            name.appendChild(el('span', 'badge ok rc-preset-badge',
              t('rc.recommended', 'recommended')));
          }
          txt.appendChild(name);
          txt.appendChild(el('span', 'rc-preset-why', loc(p, 'summary')));
          row.appendChild(txt);
          presetWrap.appendChild(row);
        });
        hostNode.appendChild(presetWrap);

        // ── the switches, grouped and collapsed ──────────────────────────────
        var det = document.createElement('details');
        det.className = 'rc-flags';
        // Open straight away in custom mode: the operator chose custom in order
        // to see these, so making them click twice would be silly.
        det.open = presetId === 'custom';
        var sum = document.createElement('summary');
        sum.textContent = t('rc.advancedFlags', 'Individual switches') +
          ' (' + Object.keys(chosen).length + ')';
        det.appendChild(sum);

        ((catalogue && catalogue.groups) || []).forEach(function (g) {
          var flags = ((catalogue && catalogue.flags) || []).filter(function (f) {
            return f.group === g.id;
          });
          if (!flags.length) return;

          var grp = el('div', 'rc-flag-group');
          grp.appendChild(el('div', 'rc-flag-group-title', loc(g, 'label')));
          grp.appendChild(el('div', 'rc-flag-group-desc', loc(g, 'description')));

          flags.forEach(function (f) {
            var row = el('label', 'rc-flag risk-' + f.risk);
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!chosen[f.id] || isRequired(f.id);

            // A computed flag carries a value from configuration, and a required
            // one cannot be turned off without breaking startup. Both are SHOWN
            // (the operator asked to see the whole list) but not offered as
            // choices: a checkbox that bricks the browser is a trap, not freedom.
            var locked = isRequired(f.id) || f.computed;
            cb.disabled = locked;
            if (!locked) {
              cb.addEventListener('change', function () {
                if (cb.checked) chosen[f.id] = true; else delete chosen[f.id];
                // Any hand edit means this is no longer a named preset. Saying so
                // is honest; leaving "Standard" selected while the flags differ
                // would be the settings screen lying again.
                presetId = 'custom';
                paint(hostNode);
              });
            }
            row.appendChild(cb);

            var txt = el('span', 'rc-flag-text');
            var head = el('span', 'rc-flag-name', loc(f, 'label'));
            if (f.risk !== 'safe') {
              head.appendChild(el('span', 'badge rc-flag-risk',
                f.risk === 'dangerous'
                  ? t('rc.riskDangerous', 'risky')
                  : t('rc.riskCaution', 'trade-off')));
            }
            if (isRequired(f.id)) {
              head.appendChild(el('span', 'badge rc-flag-risk',
                t('rc.flagRequired', 'always on')));
            }
            if (f.computed) {
              head.appendChild(el('span', 'badge rc-flag-risk',
                t('rc.flagComputed', 'from settings')));
            }
            txt.appendChild(head);
            txt.appendChild(el('span', 'rc-flag-why', loc(f, 'why')));
            txt.appendChild(el('code', 'rc-flag-raw', f.flag));
            row.appendChild(txt);
            grp.appendChild(row);
          });

          det.appendChild(grp);
        });
        hostNode.appendChild(det);

        // ── apply ───────────────────────────────────────────────────────────
        var acts = el('div', 'rc-row');
        // "Apply", not "Save for next start": the server relaunches Chrome
        // itself when the switches changed, so the button does what it says
        // rather than leaving the operator a chore. The label must not promise
        // less than the code delivers.
        var save = btn(t('rc.applyFlags', 'Apply'), 'btn btn-sm');
        save.addEventListener('click', function () {
          setBusy(save, true, t('rc.applying', 'applying…'));
          window.API.post('/browser/real/flags', {
            preset: presetId,
            flags: Object.keys(chosen),
          })
            .then(function (d) {
              var sel = (d && d.selected) || {};
              // An unknown or forced flag is REPORTED, never swallowed. A switch
              // the operator believes they set and the browser never received is
              // the exact class of bug that cost this project days.
              if (sel.unknown && sel.unknown.length) {
                toast(t('rc.flagsUnknown', 'Ignored unknown switches: ') +
                  sel.unknown.join(', '), 'error');
              } else if (sel.forced && sel.forced.length) {
                toast(t('rc.flagsForced', 'These cannot be turned off: ') +
                  sel.forced.join(', '), 'error');
              } else if (d && d.problem) {
                // Healing is not pretending: a relaunch that genuinely failed
                // says so, and names the cause.
                toast(String(d.problem) + (d.hint ? ' — ' + d.hint : ''), 'error');
              } else if (d && d.applied) {
                toast(t('rc.flagsApplied',
                  'Applied. The browser was relaunched with these switches.'), 'ok');
              } else {
                toast(t('rc.flagsSaved', 'Saved. The next start will use these.'), 'ok');
              }
              // The running browser just changed underneath the rest of the
              // panel (version, tabs, debug URL), so re-read it rather than
              // leaving stale numbers on screen.
              if (d && d.applied) refresh();
            })
            .catch(function (e) { toast(e.message, 'error'); })
            .then(function () { setBusy(save, false); });
        });
        acts.appendChild(save);

        // Reported as an observation, never as an instruction: the operator is
        // not asked to restart anything. `inSync` can only be false transiently
        // — for instance when an earlier relaunch failed.
        if (catalogue && catalogue.inSync === false) {
          note(hostNode, t('rc.flagsNotLive',
            'The running browser is not using these switches yet. Apply to relaunch it.'), 'warn');
        }
        hostNode.appendChild(acts);
      }

      /**
       * Which environment profile is active, and which values it chose.
       *
       * The complaint ends «کاربر گیج نمونه» — the user must not end up
       * confused. A bare value would move the confusion rather than remove it:
       * `headless: false` never says whether the operator chose it or the
       * profile did. So every row is tagged with its provenance.
       */
      function renderProfile(hostNode) {
        var box = el('div', 'rc-profile');
        hostNode.appendChild(box);
        window.API.get('/config/profile')
          .then(function (d) {
            if (!d || !d.meta) return;
            var head = el('div', 'rc-row');
            head.appendChild(el('span', 'badge ok', loc(d.meta, 'label')));
            head.appendChild(el('span', 'rc-profile-src',
              d.detectedFrom === 'default'
                ? t('rc.profileDefault', 'no APP_ENV set — assuming development')
                : t('rc.profileFrom', 'from ') + d.detectedFrom));
            box.appendChild(head);
            note(box, loc(d.meta, 'summary'));

            var list = el('div', 'rc-profile-vals');
            (d.values || []).forEach(function (v) {
              var row = el('div', 'rc-profile-row src-' + v.source);
              row.appendChild(el('code', 'rc-profile-name', v.name));
              row.appendChild(el('span', 'rc-profile-val',
                v.value === undefined ? '—' : String(v.value)));
              // "You set this" and "development set this for you" must never
              // look alike, so the source is always spelled out.
              row.appendChild(el('span', 'badge rc-profile-src-tag',
                v.source === 'explicit'
                  ? t('rc.srcYou', 'you set it')
                  : (v.source === 'profile'
                    ? t('rc.srcProfile', 'profile chose it')
                    : t('rc.srcDefault', 'built-in default'))));
              if (v.overridden) {
                row.appendChild(el('span', 'rc-profile-why',
                  t('rc.overrides', 'overrides ') + String(v.profileValue)));
              } else {
                row.appendChild(el('span', 'rc-profile-why',
                  (isFa() && v.whyFa) ? v.whyFa : v.why));
              }
              list.appendChild(row);
            });
            box.appendChild(list);
          })
          .catch(function () {
            // A missing profile endpoint must not take the flag form down with
            // it: the flags are the part the operator actually asked for.
          });
      }
    }

    if (rc.enabled) renderLaunchOptions(section(body, t('rc.launch', 'Launch options')));

    // ── 2. Cookies ──────────────────────────────────────────────────────────
    var s2 = section(body, t('rc.cookies', 'Cookies'));
    note(s2, t('rc.cookiesHint',
      'Import the file your cookie extension exported. It is stored in the profile, ' +
      'so both this window and queued automation runs skip the login.'));

    var cookieRow = el('div', 'rc-row');
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.txt,application/json,text/plain';
    fileInput.className = 'rc-file';

    var importBtn = btn(t('rc.import', 'Import cookie file'), 'btn btn-primary btn-sm');
    importBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      setBusy(importBtn, true, t('rc.importing', 'importing…'));
      var reader = new FileReader();
      reader.onerror = function () {
        setBusy(importBtn, false);
        toast(t('rc.readFail', 'Could not read the file.'), 'error');
      };
      reader.onload = function () {
        window.API.post('/browser/cookies/import', { text: String(reader.result || '') })
          .then(function (res) {
            toast(res.message || t('rc.imported', 'Imported.'), 'ok');
            if (res.rejected && res.rejected.length) {
              toast(res.rejected.length + ' ' +
                t('rc.rejected', 'cookie(s) were rejected by Chrome.'), 'warn');
            }
            return refresh();
          })
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () {
            setBusy(importBtn, false);
            fileInput.value = '';
          });
      };
      reader.readAsText(file);
    });

    cookieRow.appendChild(importBtn);
    cookieRow.appendChild(fileInput);

    var exportBtn = btn(t('rc.export', 'Export'), 'btn btn-sm');
    exportBtn.addEventListener('click', function () {
      // A plain link download: the endpoint sets Content-Disposition, and the
      // API key rides in the query so the browser's own GET is authenticated.
      var key = window.API.getKey ? window.API.getKey() : '';
      var url = '/browser/cookies/export' + (key ? '?api_key=' + encodeURIComponent(key) : '');
      window.open(url, '_blank', 'noopener');
    });
    cookieRow.appendChild(exportBtn);
    s2.appendChild(cookieRow);

    // ── 3. Extensions ───────────────────────────────────────────────────────
    var s3 = section(body, t('rc.extensions', 'Extensions'));

    // Install from the Web Store first: it is the path that needs nothing from
    // the user but a link they already have open.
    note(s3, t('rc.storeHint',
      'Paste a Chrome Web Store link and the server downloads, unpacks and ' +
      'installs the extension itself. No .crx hunting and no remote desktop.'));

    var storeRow = el('div', 'rc-row rc-store');
    var storeInput = document.createElement('input');
    storeInput.type = 'text';
    storeInput.className = 'rc-input';
    storeInput.placeholder = t('rc.storePlaceholder',
      'https://chromewebstore.google.com/detail/…');
    storeInput.spellcheck = false;
    // Pasting a long URL into a narrow field is unreadable; the title shows all.
    storeInput.addEventListener('input', function () {
      storeInput.title = storeInput.value;
    });

    var storeBtn = btn(t('rc.installStore', 'Install'), 'btn btn-primary btn-sm');

    function installFromStore() {
      var value = storeInput.value.trim();
      if (!value) {
        toast(t('rc.storeEmpty', 'Paste a Chrome Web Store link first.'), 'warn');
        storeInput.focus();
        return;
      }
      setBusy(storeBtn, true, t('rc.installing', 'installing…'));
      storeInput.disabled = true;
      window.API.post('/browser/extensions/store', { url: value })
        .then(function (res) {
          toast(res.message || t('rc.installed', 'Installed.'), 'ok');
          storeInput.value = '';
          return refresh();
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () {
          setBusy(storeBtn, false);
          storeInput.disabled = false;
        });
    }

    storeBtn.addEventListener('click', installFromStore);
    // Enter is what everybody presses after pasting a URL.
    storeInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); installFromStore(); }
    });

    storeRow.appendChild(storeInput);
    storeRow.appendChild(storeBtn);
    s3.appendChild(storeRow);

    var list = el('div', 'rc-list');
    var exts = rc.extensions || [];
    if (!exts.length) {
      note(list, t('rc.noExtensions',
        'No extensions loaded. Install one from the Web Store above, or upload a ' +
        '.crx / .zip — then restart the browser, because Chrome only reads ' +
        'extensions at launch.'));
    } else {
      exts.forEach(function (ext) {
        var row = el('div', 'rc-ext');
        var meta = el('div', 'rc-ext-meta');
        meta.appendChild(el('div', 'rc-ext-name', ext.name));
        var sub = 'v' + ext.version + ' · MV' + ext.manifestVersion;
        meta.appendChild(el('div', 'rc-ext-ver', sub));
        if (ext.runtimeId) {
          // The id is what a workflow step needs to build a chrome-extension://
          // URL by hand, so it must be visible and selectable, not just implied.
          var idRow = el('div', 'rc-ext-id', ext.runtimeId);
          idRow.title = t('rc.extIdHint',
            'The id Chrome assigns this extension. Store installs keep the ' +
            'official id, so chrome-extension:// links stay valid.');
          meta.appendChild(idRow);
        }
        row.appendChild(meta);

        var openBtn = btn(t('rc.open', 'Open here'), 'btn btn-sm');
        openBtn.title = t('rc.openHint',
          'Opens the extension\'s own popup page in this canvas, with full extension privileges.');
        openBtn.disabled = !(ext.popupUrl || ext.optionsUrl || ext.url);
        openBtn.addEventListener('click', function () {
          var url = ext.popupUrl || ext.optionsUrl || ext.url;
          if (!url) return;
          if (current && typeof current.onNavigate === 'function') {
            // Pass the page we are opening the extension FOR. Without this an
            // extension that reads the active tab sees the popup tab itself, and
            // an action like "export this site's cookies" has no site to act on.
            var forPage = '';
            try {
              forPage = current.pageUrl ? String(current.pageUrl() || '') : '';
            } catch (e) { forPage = ''; }
            current.onNavigate(pageUrlParam(url, forPage));
            close();
          }
        });
        row.appendChild(openBtn);

        var delBtn = iconBtn('trash', t('rc.remove', 'Remove'));
        delBtn.addEventListener('click', function () {
          setBusy(delBtn, true);
          window.API.del('/browser/extensions/' + encodeURIComponent(ext.id))
            .then(refresh)
            .catch(function (e) { toast(e.message, 'error'); })
            .then(function () { setBusy(delBtn, false); });
        });
        row.appendChild(delBtn);

        list.appendChild(row);
      });
    }
    s3.appendChild(list);

    if (rc.restartRequired) {
      note(s3, t('rc.restartRequired',
        'An extension was installed after the browser started. Restart to load it.'), 'warn');
    }

    var upRow = el('div', 'rc-row');
    var extFile = document.createElement('input');
    extFile.type = 'file';
    extFile.accept = '.crx,.zip';
    extFile.className = 'rc-file';
    var upBtn = btn(t('rc.upload', 'Upload .crx / .zip'), 'btn btn-sm');
    upBtn.addEventListener('click', function () { extFile.click(); });
    extFile.addEventListener('change', function () {
      var file = extFile.files && extFile.files[0];
      if (!file) return;
      setBusy(upBtn, true, t('rc.uploading', 'uploading…'));
      // Raw body, not multipart: no server-side multipart dependency, and the
      // File object is already a Blob fetch can send as-is.
      fetch('/browser/extensions?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-api-key': window.API.getKey ? window.API.getKey() : '',
        },
        body: file,
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error((r.d && r.d.error) || 'upload failed');
          toast(r.d.message || t('rc.installed', 'Installed.'), 'ok');
          return refresh();
        })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () { setBusy(upBtn, false); extFile.value = ''; });
    });
    upRow.appendChild(upBtn);
    upRow.appendChild(extFile);
    s3.appendChild(upRow);

    // ── 3b. Live tabs (light remote mode) ──────────────────────────────────
    // When the picker canvas wedges, the operator wants to see whether the real
    // Chrome still has the pages they were working with, and to kill a hung tab
    // without restarting the browser. This section reads /browser/tabs and lets
    // each row POST /browser/tabs/close.
    var sTabs = section(body, t('rc.tabs', 'Live tabs'));
    note(sTabs, t('rc.tabsHint',
      'Open tabs in the real Chrome. Refresh to see what is still alive; use ' +
      'Kill to close a wedged tab without restarting the browser.'));
    var tabsRow = el('div', 'rc-row');
    var refreshTabsBtn = btn(t('rc.refreshTabs', 'Refresh'), 'btn btn-sm');
    refreshTabsBtn.addEventListener('click', function () {
      setBusy(refreshTabsBtn, true, t('rc.refreshing', 'refreshing…'));
      refreshTabs(refreshTabsBtn);
    });
    tabsRow.appendChild(refreshTabsBtn);
    sTabs.appendChild(tabsRow);
    var tabsList = el('div', 'rc-tabs-list');
    sTabs.appendChild(tabsList);

    function renderTabs(tabs) {
      tabsList.innerHTML = '';
      if (!tabs || !tabs.length) {
        note(tabsList, t('rc.tabsEmpty', 'No tabs open (or Chrome is not running).'));
        return;
      }
      tabs.forEach(function (tab) {
        var row = el('div', 'rc-tab-row');
        var title = el('div', 'rc-tab-title', tab.title || tab.url || '(no title)');
        var url = el('div', 'rc-tab-url', tab.url || '');
        row.appendChild(title);
        row.appendChild(url);
        var kill = btn(t('rc.killTab', 'Kill'), 'btn btn-sm');
        kill.title = t('rc.killTabHint', 'Close this tab in the real Chrome.');
        kill.addEventListener('click', function () {
          if (!confirm(t('rc.killConfirm', 'Close this tab?') + '\n' + (tab.url || ''))) return;
          setBusy(kill, true, t('rc.killing', 'closing…'));
          window.API.post('/browser/tabs/close', { url: tab.url })
            .then(function () { toast(t('rc.killed', 'Tab closed.'), 'ok'); return refreshTabs(kill); })
            .catch(function (e) { toast(e.message, 'error'); })
            .then(function () { setBusy(kill, false); });
        });
        row.appendChild(kill);
        tabsList.appendChild(row);
      });
    }

    function refreshTabs(btn) {
      return window.API.get('/browser/tabs')
        .then(function (d) { renderTabs(d && d.tabs); })
        .catch(function (e) { tabsList.innerHTML = ''; note(tabsList, e.message, 'error'); })
        .then(function () { if (btn) setBusy(btn, false); });
    }

    refreshTabs();

    // ── 4. Remote desktop ───────────────────────────────────────────────────
    var s4 = section(body, t('rc.desktop', 'Remote desktop'));
    note(s4, t('rc.desktopHint',
      'Optional. Installing from the Web Store above and opening an extension ' +
      'with “Open here” covers almost everything. This is only for a native OS ' +
      'file dialog or the toolbar button itself, and needs extra packages.'));

    var dRow = el('div', 'rc-row');
    var dChip = el('span', 'badge ' + (desk.running ? 'ok' : ''),
      desk.running ? t('rc.running', 'running') : t('rc.stopped', 'stopped'));
    dRow.appendChild(dChip);

    // The screen and the viewer are two different things, and only the screen
    // decides whether Chrome can start at all. Say which one is missing.
    if (desk.displayRunning && !desk.running) {
      note(s4, t('rc.displayOnly',
        'The virtual screen is up, so the browser and its extensions work — you ' +
        'just cannot watch the full Chrome window (x11vnc/websockify are not installed).'));
    } else if (!desk.displayRunning && desk.missing &&
               desk.missing.indexOf('Xvfb') !== -1 && rc.enabled && !rc.headless) {
      // This one IS a warning: with no display a headed Chrome cannot start,
      // which is the single failure people hit and cannot diagnose.
      note(s4, t('rc.displayMissing',
        'There is no screen to draw on. A headed Chrome — the only kind that loads ' +
        'extensions — cannot start without one: install Xvfb, or set ' +
        'REAL_CHROME_HEADLESS=true (no extensions in that mode).'), 'warn');
    }

    if (desk.missing && desk.missing.length && !desk.displayRunning) {
      // Deliberately NOT styled as a warning. Nothing is broken: the desktop is
      // an optional extra now that extensions install from the store, and an
      // orange block here reads as "your setup is wrong" for a feature most
      // people never need.
      // "Not installed" no longer means "go install it": pressing Start desktop
      // provisions the stack without root. So the button is offered here too,
      // rather than only in the branch where nothing was missing -- that branch
      // condition was the UI half of the same dead end as the Retry button:
      // the one state that needed the action was the one state that hid it.
      note(s4, t('rc.desktopProvisionable',
        'Not installed yet — the server can install it itself, no root needed. ' +
        'Start desktop does it; the first run takes about a minute.'));
      var provDesk = btn(t('rc.startDesktop', 'Start desktop'), 'btn btn-sm');
      provDesk.addEventListener('click', function () {
        setBusy(provDesk, true, t('rc.installing', 'installing…'));
        window.API.post('/browser/desktop/start', {})
          .then(refresh)
          .catch(function (e) {
            // The server's hint describes what IT could not do (mirror
            // unreachable, provisioning disabled). That is the actionable part,
            // so it is preferred over the bare transport error.
            toast(desk.installHint || e.message, 'error');
          })
          .then(function () { setBusy(provDesk, false); });
      });
      dRow.appendChild(provDesk);
    } else if (desk.running) {
      var openDesk = btn(t('rc.openDesktop', 'Open desktop'), 'btn btn-primary btn-sm');
      openDesk.addEventListener('click', function () {
        // Same hostname, different port: noVNC is its own server, not proxied
        // through this app, so the URL is built from location.hostname.
        var url = window.location.protocol + '//' + window.location.hostname +
          ':' + desk.novncPort + (desk.novncPath || '/vnc.html');
        window.open(url, '_blank', 'noopener');
      });
      dRow.appendChild(openDesk);

      var stopDesk = btn(t('rc.stop', 'Stop'), 'btn btn-sm');
      stopDesk.addEventListener('click', function () {
        setBusy(stopDesk, true);
        window.API.post('/browser/desktop/stop', {})
          .then(refresh)
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () { setBusy(stopDesk, false); });
      });
      dRow.appendChild(stopDesk);
    } else if (!desk.missing || !desk.missing.length) {
      var startDesk = btn(t('rc.startDesktop', 'Start desktop'), 'btn btn-sm');
      startDesk.addEventListener('click', function () {
        setBusy(startDesk, true, t('rc.starting', 'starting…'));
        window.API.post('/browser/desktop/start', {})
          .then(refresh)
          .catch(function (e) { toast(e.message, 'error'); })
          .then(function () { setBusy(startDesk, false); });
      });
      dRow.appendChild(startDesk);
    }
    s4.appendChild(dRow);

    if (desk.running && !desk.passwordProtected) {
      note(s4, t('rc.noVncPassword',
        'This screen has no password. It holds every cookie you import — do not ' +
        'expose the port publicly; tunnel it over SSH instead.'), 'warn');
    }
  }

  function toast(msg, kind) {
    if (window.AppUtil && typeof window.AppUtil.toast === 'function') {
      window.AppUtil.toast(msg, kind === 'error' ? 'error' : (kind || 'info'));
      return;
    }
    if (!current) return;
    var n = current.root.querySelector('.rc-toast');
    if (!n) {
      n = el('div', 'rc-toast');
      current.root.appendChild(n);
    }
    n.className = 'rc-toast is-' + (kind || 'info');
    n.textContent = msg;
  }

  function refresh() {
    if (!current) return Promise.resolve();
    return window.API.get('/browser/status')
      .then(function (status) {
        if (!current) return;
        current.status = status;
        render(current.root, status);
      })
      .catch(function (e) {
        if (!current) return;
        current.root.innerHTML = '';
        note(current.root, e.message, 'error');
      });
  }

  /**
   * Open the panel.
   *
   * opts.anchor     element the panel is positioned under (the toolbar button)
   * opts.onNavigate fn(url) — used by "Open here" to point the picker canvas at
   *                 a chrome-extension:// page.
   * opts.pageUrl    fn() → the URL the canvas is on right now. A getter, not a
   *                 value, because the panel can sit open across navigations and
   *                 the extension must be told about the page as it is AT CLICK
   *                 TIME, not as it was when the panel opened.
   */
  function openPanel(opts) {
    opts = opts || {};
    if (current) { close(); return; }

    var root = el('div', 'rc-panel');
    root.setAttribute('role', 'dialog');
    (opts.container || document.body).appendChild(root);

    if (opts.anchor && opts.anchor.getBoundingClientRect) {
      var r = opts.anchor.getBoundingClientRect();
      root.style.position = 'fixed';

      // Clamp horizontally: the trigger lives at the right edge of the picker
      // toolbar, so anchoring naively puts most of the panel off-screen.
      var left = Math.min(Math.round(r.left), window.innerWidth - 380);
      root.style.left = Math.max(8, left) + 'px';

      // Clamp vertically too. The panel is tall (four sections) and the toolbar
      // is near the top, but on a short window the bottom section — the remote
      // desktop controls, which is what half of this feature is about — would
      // otherwise be pushed below the fold with no way to reach it.
      var top = Math.round(r.bottom + 6);
      var available = window.innerHeight - top - 12;
      if (available < 260) {
        // Not enough room below: sit above the trigger instead.
        root.style.top = 'auto';
        root.style.bottom = Math.max(8, window.innerHeight - Math.round(r.top) + 6) + 'px';
        root.style.maxHeight = Math.max(220, Math.round(r.top) - 20) + 'px';
      } else {
        root.style.top = top + 'px';
        root.style.maxHeight = available + 'px';
      }
    }

    current = {
      root: root,
      anchor: opts.anchor || null,
      onNavigate: opts.onNavigate || null,
      pageUrl: typeof opts.pageUrl === 'function' ? opts.pageUrl : null,
    };

    note(root, t('rc.loading', 'Loading…'));
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);

    refresh();
  }

  window.RealChromePanel = {
    open: openPanel,
    close: close,
    isOpen: function () { return !!current; },
  };
})();
