// =====================================================================
// templates.js — Starter workflow templates (Step 32)
// ---------------------------------------------------------------------
// A small, DOM-free catalog of ready-to-run example workflows so a new
// user has something working in one click. Each template is a plain
// object { id, name, description, headless, steps } where `steps` uses
// the SAME canonical { action, params } shape as the backend pipeline and
// the action catalog (public/js/actions.js) — so a template can be saved
// straight through the /workflows CRUD and run unchanged.
//
// Pure data + helpers only (no DOM / no fetch), exposed as window.TEMPLATES
// so views.js can render a picker and tests can load it via `vm` with a
// minimal `window` shim. LF line endings (public/** convention).
// =====================================================================
(function () {
  'use strict';

  // Every action id used below must exist in window.ACTION_CATALOG and be
  // implemented in src/pipeline.ts. The action-catalog guard-test keeps the
  // catalog in sync with the backend; the templates test keeps these steps in
  // sync with the catalog.
  var TEMPLATES = [
    {
      id: 'price-scrape',
      name: 'tpl.priceScrape.name',
      description: 'tpl.priceScrape.desc',
      icon: '🏷️',
      headless: true,
      steps: [
        { action: 'goto', params: { url: 'https://example.com/product/123' } },
        { action: 'wait', params: { selector: '.price', timeout: 15000 } },
        { action: 'extract', params: { selector: '.price', name: 'price' } },
        { action: 'extract', params: { selector: 'h1', name: 'title' } },
        { action: 'export-data', params: { format: 'json', filename: 'price' } }
      ]
    },
    {
      id: 'login-form',
      name: 'tpl.loginForm.name',
      description: 'tpl.loginForm.desc',
      icon: '🔐',
      headless: true,
      steps: [
        { action: 'goto', params: { url: 'https://example.com/login' } },
        { action: 'fill', params: { selector: 'input[name=email]', text: 'you@example.com' } },
        { action: 'fill', params: { selector: 'input[name=password]', text: '{{ $env.PASSWORD }}' } },
        { action: 'click', params: { selector: 'button[type=submit]' } },
        { action: 'wait', params: { selector: '.dashboard', timeout: 20000 } },
        { action: 'extract', params: { selector: '.welcome', name: 'welcome' } }
      ]
    },
    {
      id: 'scheduled-screenshot',
      name: 'tpl.screenshot.name',
      description: 'tpl.screenshot.desc',
      icon: '📸',
      headless: true,
      steps: [
        // A schedule trigger turns this into a recurring job when saved &
        // activated (Step 28 Model B). Running it manually ignores the trigger.
        { action: 'trigger_schedule', params: { cron: '0 9 * * *', timezone: 'UTC' } },
        { action: 'goto', params: { url: 'https://example.com' } },
        { action: 'wait', params: { ms: 2000 } },
        { action: 'screenshot', params: {} }
      ]
    }
  ];

  function list() { return TEMPLATES.slice(); }

  function byId(id) {
    for (var i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].id === id) return TEMPLATES[i];
    }
    return null;
  }

  // Produce a fresh /workflows create body from a template. A deep copy of the
  // steps is returned so editing the saved workflow never mutates the template.
  // `nameOverride` (already resolved/translated) sets the workflow name.
  function toWorkflowBody(id, nameOverride) {
    var tpl = byId(id);
    if (!tpl) return null;
    return {
      name: nameOverride || tpl.id,
      description: null,
      steps: JSON.parse(JSON.stringify(tpl.steps)),
      headless: tpl.headless !== false
    };
  }

  window.TEMPLATES = {
    list: list,
    byId: byId,
    toWorkflowBody: toWorkflowBody,
    ids: function () { return TEMPLATES.map(function (t) { return t.id; }); }
  };
})();
