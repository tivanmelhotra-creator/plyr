/*
 * workflow-exchange.js — the NATIVE workflow file: {format:"plyr-workflow", version, workflow}.
 *
 * ONE implementation, two readers: the editor/workspace loads it as a browser
 * script, and the server evaluates the very same file (src/core/WorkflowExchange.ts)
 * the way it already does for actions.js / browser-options.js. So what the UI
 * exports, what the UI previews and what the server re-validates cannot drift.
 *
 * DOM-free and CSP-safe (no eval, no inline script). It reads the node catalog
 * from window.ACTION_CATALOG and the browser-option catalog from
 * window.BROWSER_OPTIONS at CALL time, so the same file works wherever both exist.
 *
 * WHAT IT DECIDES
 *   - the envelope shape and its version;
 *   - which values never leave the machine in an export (password-type node
 *     fields and secret browser options: webhook secrets, bot tokens, proxy and
 *     HTTP-auth passwords) — they are blanked and LISTED, never silently kept;
 *   - that a Code node is DISABLED when it arrives from a file (it is the
 *     operator's own JavaScript; a file somebody else wrote must not run until
 *     the operator has read it and switched it on);
 *   - the plain-language summary shown BEFORE anything is saved.
 *
 * Deliberately NOT here: any n8n importer (out of scope), and the deep step
 * validation (validateSteps on the server stays the authority).
 */
(function (root) {
  'use strict';

  var FORMAT = 'plyr-workflow';
  var VERSION = 1;
  var CHILD_LISTS = ['then', 'else', 'steps', 'catch', 'finally', 'fallback'];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /** Call fn(step, parentList) for every step, however deeply nested. */
  function walk(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (!isObj(s)) continue;
      fn(s);
      for (var k = 0; k < CHILD_LISTS.length; k++) walk(s[CHILD_LISTS[k]], fn);
      if (isObj(s.cases)) for (var c in s.cases) if (Object.prototype.hasOwnProperty.call(s.cases, c)) walk(s.cases[c], fn);
      if (Array.isArray(s.paths)) for (var p = 0; p < s.paths.length; p++) if (isObj(s.paths[p])) walk(s.paths[p].steps, fn);
    }
  }

  // ---- secrets -------------------------------------------------------------

  function catalogActions() {
    var c = root.ACTION_CATALOG;
    return c && Array.isArray(c.ACTIONS) ? c.ACTIONS : [];
  }

  /** Param keys of an action whose catalogue type is `password`. */
  function secretFieldsOf(action) {
    var acts = catalogActions();
    for (var i = 0; i < acts.length; i++) {
      if (acts[i].id !== action) continue;
      var out = [];
      (acts[i].fields || []).forEach(function (f) { if (f && f.type === 'password' && f.k) out.push(f.k); });
      return out;
    }
    return [];
  }

  function secretBrowserOptionIds() {
    var b = root.BROWSER_OPTIONS;
    var defs = b && Array.isArray(b.OPTIONS) ? b.OPTIONS : [];
    return defs.filter(function (d) { return d && d.secret === true; }).map(function (d) { return d.id; });
  }

  function parseOptions(raw) {
    if (isObj(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
      try { var v = JSON.parse(raw); if (isObj(v)) return v; } catch (e) { /* not JSON */ }
    }
    return null;
  }

  /**
   * Deep copy of `steps` with every secret value blanked.
   * Returns { steps, redacted: ["action.key", ...] } — the list is what the
   * file records and what the importer tells the user to fill in again.
   */
  function redact(steps) {
    var copy = clone(Array.isArray(steps) ? steps : []);
    var redacted = [];
    var secretOpts = secretBrowserOptionIds();
    walk(copy, function (s) {
      if (!isObj(s.params)) return;
      secretFieldsOf(s.action).forEach(function (k) {
        if (s.params[k] !== undefined && s.params[k] !== null && String(s.params[k]) !== '') {
          s.params[k] = '';
          redacted.push(s.action + '.' + k);
        }
      });
      if (s.params.browserOptions !== undefined && s.params.browserOptions !== null && s.params.browserOptions !== '') {
        var wasString = typeof s.params.browserOptions === 'string';
        var o = parseOptions(s.params.browserOptions);
        if (o) {
          var hit = false;
          secretOpts.forEach(function (id) {
            if (o[id] !== undefined) { delete o[id]; redacted.push(s.action + '.browserOptions.' + id); hit = true; }
          });
          if (hit) s.params.browserOptions = wasString ? JSON.stringify(o) : o;
        }
      }
    });
    return { steps: copy, redacted: redacted };
  }

  // ---- the envelope --------------------------------------------------------

  /**
   * @param wf    { name, description?, headless?, steps }
   * @param opts  { now?: Date } (tests pin the timestamp)
   */
  function buildEnvelope(wf, opts) {
    wf = wf || {};
    var r = redact(wf.steps);
    var now = (opts && opts.now) || new Date();
    var out = {
      format: FORMAT,
      version: VERSION,
      exportedAt: now.toISOString(),
      workflow: {
        name: String(wf.name || 'Workflow'),
        description: wf.description ? String(wf.description) : null,
        steps: r.steps,
      },
    };
    if (wf.headless !== undefined && wf.headless !== null) out.workflow.headless = wf.headless;
    if (r.redacted.length) out.redacted = r.redacted;
    return out;
  }

  /**
   * Wrap an OLD plyr export (a bare {name, steps, ...}) so it goes through the
   * same preview + code-disabled path as a native file. Not an importer for any
   * other product: it only recognises what this app itself used to write.
   */
  function fromLegacy(body) {
    if (!isObj(body) || !Array.isArray(body.steps)) return null;
    var wf = { name: typeof body.name === 'string' && body.name.trim() ? body.name : 'Imported workflow', steps: body.steps };
    if (typeof body.description === 'string' && body.description) wf.description = body.description;
    if (body.headless !== undefined && body.headless !== null) wf.headless = body.headless;
    return { format: FORMAT, version: VERSION, workflow: wf, legacy: true };
  }

  /**
   * Cheap client-side look at a picked file's text. The server re-validates with
   * Zod; this only decides which message the user sees first.
   * -> { ok:true, envelope, legacy } | { ok:false, code: 'json'|'format'|'version'|'shape' }
   */
  function parse(text) {
    var body;
    try { body = JSON.parse(String(text)); } catch (e) { return { ok: false, code: 'json' }; }
    if (!isObj(body)) return { ok: false, code: 'shape' };
    if (body.format === undefined) {
      var legacy = fromLegacy(body);
      return legacy ? { ok: true, envelope: legacy, legacy: true } : { ok: false, code: 'format' };
    }
    if (body.format !== FORMAT) return { ok: false, code: 'format' };
    if (typeof body.version !== 'number' || !isFinite(body.version) || body.version < 1 || Math.floor(body.version) !== body.version) {
      return { ok: false, code: 'shape' };
    }
    if (body.version > VERSION) return { ok: false, code: 'version', version: body.version };
    if (!isObj(body.workflow) || !Array.isArray(body.workflow.steps)) return { ok: false, code: 'shape' };
    return { ok: true, envelope: body, legacy: false };
  }

  // ---- Code nodes arrive switched off --------------------------------------

  /** Copy of steps with every `code` step flagged disabled. -> { steps, count } */
  function disableCodeNodes(steps) {
    var copy = clone(Array.isArray(steps) ? steps : []);
    var count = 0;
    walk(copy, function (s) {
      if (s.action === 'code') { s.disabled = true; count++; }
    });
    return { steps: copy, count: count };
  }

  // ---- the summary shown before saving -------------------------------------

  function summarize(envelope) {
    var wf = (envelope && envelope.workflow) || {};
    var counts = {};
    var nodes = 0; var code = 0; var disabled = 0; var launchOpts = 0;
    walk(wf.steps, function (s) {
      nodes++;
      counts[s.action] = (counts[s.action] || 0) + 1;
      if (s.action === 'code') code++;
      if (s.disabled === true) disabled++;
      if (isObj(s.params) && s.params.browserOptions !== undefined && s.params.browserOptions !== null && s.params.browserOptions !== '') launchOpts++;
    });
    var actions = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); })
      .map(function (a) { return { action: a, count: counts[a] }; });
    return {
      name: String(wf.name || ''),
      description: wf.description ? String(wf.description) : '',
      nodeCount: nodes,
      actions: actions,
      codeNodes: code,
      disabledNodes: disabled,
      launchOptionNodes: launchOpts,
      redacted: Array.isArray(envelope && envelope.redacted) ? envelope.redacted.slice() : [],
      legacy: !!(envelope && envelope.legacy),
      exportedAt: envelope && typeof envelope.exportedAt === 'string' ? envelope.exportedAt : '',
    };
  }

  var api = {
    FORMAT: FORMAT, VERSION: VERSION,
    walk: walk, secretFieldsOf: secretFieldsOf, redact: redact,
    buildEnvelope: buildEnvelope, fromLegacy: fromLegacy, parse: parse,
    disableCodeNodes: disableCodeNodes, summarize: summarize,
  };
  root.WorkflowExchange = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
