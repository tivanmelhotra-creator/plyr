p='public/js/profile-manager.js'; s=open(p).read()
if 'VIEWER_NAME' in s: print('already'); raise SystemExit

# 1. shared viewer helper + launch API
old="""  var POLL_MS = 6000;"""
assert old in s
s=s.replace(old,"""  var POLL_MS = 6000;

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
  }""",1)

s=s.replace("""    open: function (id, workflowId) {
      var attempt = 0;
      function once() {
        attempt++;
        return call('/profiles/' + encodeURIComponent(id) + '/open', 'POST', { workflowId: workflowId || undefined })""","""    open: function (id, workflowId, launch) {
      var attempt = 0;
      function once() {
        attempt++;
        return call('/profiles/' + encodeURIComponent(id) + '/open', 'POST', { workflowId: workflowId || undefined, launch: launch || undefined })""",1)
s=s.replace("""    restore: function (id, workflowId) {""","""    launchOptions: function () { return call('/profiles/launch-options'); },
    validateLaunch: function (launch) { return call('/profiles/launch-settings/validate', 'POST', { launch: launch || {} }); },
    restore: function (id, workflowId) {""",1)

# 2. openProfiles: one viewer, launch settings
old_open_start = s.index("    function openProfiles(ids) {")
old_open_end = s.index("    function createProfile(name) {")
new_open = """    function viewHref(r) {
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
      if (fresh) { try { tab.document.title = t('pm.opening', 'Opening\\u2026'); } catch (e) { /* fine */ } }
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

"""
s = s[:old_open_start] + new_open + s[old_open_end:]

# 3. createProfile: same viewer, never close a viewer that was already showing others
cs = s.index("    function createProfile(name) {")
ce = s.index("    function renameProfile(id, name) {")
new_create = """    function createProfile(name) {
      st.busy = 'create';
      paintActions();
      // Claim the shared viewer NOW (inside the submit gesture): the open that
      // follows a successful create would be blocked as a popup otherwise.
      var tab = claimViewer();
      var fresh = isBlankTab(tab);
      var launch = launchUi ? launchUi.value() : null;
      return api.create(name, o.workflowId).then(function (d) {
        st.busy = '';
        hideForm();
        var p = d.profile;
        st.selected = {};
        if (p) st.selected[p.id] = true;
        say(t('pm.created', 'Profile created.') + ' ' + t('pm.openingNew', 'Opening its browser\\u2026'), false);
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

"""
s = s[:cs] + new_create + s[ce:]

# 4. mount launch-settings panel above actions
old_actions = """    root.appendChild(actions);

    host.appendChild(root);"""
assert old_actions in s
s = s.replace(old_actions, """    root.appendChild(actions);

    // Launch settings (preset, options, Custom Flags) for the next Open /
    // the open after New profile. One choice for every selected profile.
    var launchUi = (o.launchSettings === false) ? null : mountLaunchSettings(root, { onSay: say });

    host.appendChild(root);""",1)

s = s.replace("""  window.ProfileManager = { api: api, mount: mount, detailOf: detailOf, overlapText: overlapText };""","""  window.ProfileManager = {
    api: api, mount: mount, detailOf: detailOf, overlapText: overlapText,
    mountLaunchSettings: mountLaunchSettings, viewer: { name: VIEWER_NAME, claim: claimViewer, show: showInViewer, isBlank: isBlankTab }
  };""",1)
open(p,'w').write(s); print('patched')
