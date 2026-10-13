p='public/js/workflow-files.js'; s=open(p).read()
if '/browser/sessions' in s: print('already'); raise SystemExit
# 1. read state from the ONE registry
old="""    return call('/browser/real/health')
      .then(function (d) {
        // A press in flight owns the display until it finishes.
        if (state !== s || s.browser.busy) return;
        s.browser.running = !!(d && d.running);
        paintBrowser();
      })"""
assert old in s
s=s.replace(old,"""    // The ONE session registry (GET /browser/sessions): the Local Browser and
    // every profile browser. `running` is the Local Browser itself; `others`
    // are the profile browsers on the same desktop (Show browser can reach
    // them through the same shared viewer, Turn off does not close them).
    return call('/browser/sessions')
      .then(function (d) {
        // A press in flight owns the display until it finishes.
        if (state !== s || s.browser.busy) return;
        var list = (d && d.sessions) || [];
        s.browser.running = !!(d && d.localBrowser && d.localBrowser.running);
        s.browser.others = list.filter(function (x) { return x.kind === 'profile' && x.visibility !== 'hidden'; }).length;
        paintBrowser();
      })""",1)
# 2. paint: show 'Show browser' when anything visible is open; label mentions others
old2="""    ui.label.textContent = t('wfm.browserLabel', 'Local Browser') + ' \\u00b7 ' +
      (b.running ? t('wfm.browserOn', 'Running') : t('wfm.browserOff', 'Off'));
    // "Show browser" exists only while the browser is up, and waits while any
    // press (on/off, or a show already opening a tab) is in flight.
    ui.show.hidden = !b.running;"""
assert old2 in s
s=s.replace(old2,"""    ui.label.textContent = t('wfm.browserLabel', 'Local Browser') + ' \\u00b7 ' +
      (b.running ? t('wfm.browserOn', 'Running') : t('wfm.browserOff', 'Off')) +
      (b.others ? ' \\u00b7 ' + t('wfm.browserProfilesOpen', 'profile browsers open') + ': ' + b.others : '');
    // "Show browser" exists while ANY visible browser is on the shared desktop
    // (Local Browser or a profile browser): it only attaches the viewer.
    ui.show.hidden = !(b.running || b.others);""",1)
# 3. Turn off: always settle; say what stayed open
old3="""      return call('/browser/real/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }).then(function () { return done(true); }, function (e) { return done(false, e); });"""
assert old3 in s
s=s.replace(old3,"""      // Bounded on the client too: whatever the server does, the button never
      // stays on "Stopping…" — the server state is re-read in done().
      var closing = call('/browser/real/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      var deadline = new Promise(function (res, rej) {
        setTimeout(function () { rej(new Error(t('wfm.browserStopSlow', 'Turning off is taking too long; showing the current state.'))); }, 25000);
      });
      return Promise.race([closing, deadline]).then(function (d) {
        var left = (d && d.otherSessions) || [];
        var r = done(true);
        if (left.length) say(t('wfm.browserProfilesKept', 'Local Browser turned off. Profile browsers stay open (close them in Browser profiles)') + ': ' + left.map(function (x) { return x.name; }).join(', '), false);
        return r;
      }, function (e) { return done(false, e); });""",1)
# 4. Show browser = attach to the shared viewer, never launch
old4_start = s.index("  function showBrowser() {")
old4_end = s.index("  /** Start the operator's own native picker, targeting `into`. */")
new4 = """  function showBrowser() {
    if (!state || !state.browser || state.browser.busy || state.browser.showing) return Promise.resolve();
    var s = state;
    var b = s.browser;
    var V = window.ProfileManager && window.ProfileManager.viewer;
    if (!V) {
      // Without the shared viewer helper, the old path (reuses a running Chrome).
      b.showing = true; paintBrowser();
      var shown;
      try { shown = window.BrowserView.openRealBrowser('', null, { workflowId: s.workflowId }); } catch (e) { shown = Promise.reject(e); }
      return Promise.resolve(shown).then(function () { b.showing = false; paintBrowser(); return readBrowser(); },
        function (e) { b.showing = false; paintBrowser(); say((e && e.message) || t('wfm.browserShowFailed', 'Could not show the Local Browser.'), true); return readBrowser(); });
    }
    // ATTACH ONLY: the ONE shared viewer tab is reused (named window) or
    // opened, pointed at the desktop with attach=1 — no browser is started,
    // restarted or duplicated. Synchronous: we are inside the click.
    var key = (window.API && window.API.getKey) ? (window.API.getKey() || '') : '';
    var href = '/desktop/chrome?attach=1&api_key=' + encodeURIComponent(key) +
      (s.workflowId ? '&workflowId=' + encodeURIComponent(s.workflowId) : '');
    var tab = V.claim();
    var fresh = V.isBlank(tab);
    // A viewer already on screen keeps its own URL (it already shows the desktop).
    if (fresh || !tab) V.show(tab, href);
    else { try { tab.focus(); } catch (e) { /* fine */ } }
    return readBrowser();
  }

"""
s = s[:old4_start] + new4 + s[old4_end:]
# 5. Turn on opens the viewer in the shared named tab
old5="""      started = window.BrowserView.openRealBrowser('', null, { workflowId: s.workflowId });
    } catch (e) {
      started = Promise.reject(e);
    }
    return Promise.resolve(started).then(function () { return done(true); }, function (e) { return done(false, e); });"""
assert old5 in s
s=s.replace(old5,"""      // The SAME shared viewer tab as Browser Profiles (named window): Turn on
      // never adds a second viewer next to one already showing the desktop.
      var V = window.ProfileManager && window.ProfileManager.viewer;
      var target = V ? V.claim() : null;
      started = window.BrowserView.openRealBrowser('', target, { workflowId: s.workflowId });
    } catch (e) {
      started = Promise.reject(e);
    }
    return Promise.resolve(started).then(function () { return done(true); }, function (e) { return done(false, e); });""",1)
open(p,'w').write(s); print('patched')
