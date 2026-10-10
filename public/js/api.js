/* ============================================
   API client — thin fetch wrapper.
   Stores the API key in localStorage and attaches
   it as x-api-key to every authenticated request.
   Step 7. Exposes window.API.
   ============================================ */
(function () {
  'use strict';

  var KEY_STORAGE = 'ab_api_key';
  var ADMIN_STORAGE = 'ab_admin_token';

  function getKey() {
    return localStorage.getItem(KEY_STORAGE) || '';
  }
  function setKey(k) {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  }
  function clearKey() {
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(ADMIN_STORAGE);
    localStorage.removeItem('ab_user_id');
  }
  function getAdminToken() {
    return localStorage.getItem(ADMIN_STORAGE) || '';
  }
  function setAdminToken(t) {
    if (t) localStorage.setItem(ADMIN_STORAGE, t);
    else localStorage.removeItem(ADMIN_STORAGE);
  }

  /**
   * Core request. Resolves with parsed JSON.
   * Throws { status, message, body } on non-2xx.
   * opts: { method, body, auth (bool, default true), admin (bool) }
   */
  /**
   * Turn a non-JSON error body into ONE readable line.
   *
   * A failure between the browser and this app is answered by whatever sits in
   * between, and that is usually an HTML page. MEASURED: when the sandbox host
   * could not reach port 3000 the operator's toast became the entire
   * "Closed Port Error" document — every CSS rule, a base64 logo and all —
   * three times over, with the one useful sentence buried inside it.
   *
   * So HTML is never shown raw. The <title> is the page's own summary and is
   * what a human would read; the status code says who is complaining.
   */
  function errorTextOf(data, status) {
    if (typeof data !== 'string') return 'HTTP ' + status;
    var text = data.trim();
    if (!text) return 'HTTP ' + status;

    var looksHtml = /^<(?:!doctype|html|head|body)\b/i.test(text) || /<html[\s>]/i.test(text);
    if (looksHtml) {
      var title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
      var summary = title && title[1] ? title[1].replace(/\s+/g, ' ').trim() : '';
      return summary
        ? 'HTTP ' + status + ' — ' + summary
        : 'HTTP ' + status + ' (the server returned a web page, not an answer)';
    }
    // Plain text: still cap it. A stack trace in a toast pushes everything else
    // off the screen and cannot be scrolled.
    return text.length > 300 ? text.slice(0, 300) + '…' : text;
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) {
      var key = getKey();
      if (key) headers['x-api-key'] = key;
    }
    if (opts.admin) {
      var at = getAdminToken();
      if (at) headers['x-admin-token'] = at;
    }

    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) || errorTextOf(data, res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.body = data;
          throw err;
        }
        return data;
      });
    });
  }

  function get(path, opts) {
    return request(path, Object.assign({ method: 'GET' }, opts || {}));
  }
  function post(path, body, opts) {
    return request(path, Object.assign({ method: 'POST', body: body }, opts || {}));
  }
  function put(path, body, opts) {
    return request(path, Object.assign({ method: 'PUT', body: body }, opts || {}));
  }
  function patch(path, body, opts) {
    return request(path, Object.assign({ method: 'PATCH', body: body }, opts || {}));
  }
  function del(path, opts) {
    return request(path, Object.assign({ method: 'DELETE' }, opts || {}));
  }

  /** Public, unauthenticated health endpoint. */
  function health() {
    return request('/health', { auth: false });
  }

  var USER_STORAGE = 'ab_user_id';
  function getUserId() {
    return localStorage.getItem(USER_STORAGE) || '';
  }
  function setUserId(id) {
    if (id) localStorage.setItem(USER_STORAGE, id);
    else localStorage.removeItem(USER_STORAGE);
  }

  /**
   * Validate an API key by calling the identity endpoint /me.
   * /me requires a valid key but performs no strict user-binding,
   * so any valid key resolves to its owner.
   * Resolves with { valid, userId, isAdmin } — rejects only on network errors.
   */
  /** Public: does this server want a login at all? (AUTH_MODE, see settings.routes.ts) */
  function authMode() {
    return fetch('/auth/mode', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { mode: 'token' }; });
  }

  function validateKey(key) {
    return fetch('/me', {
      headers: { 'x-api-key': key, Accept: 'application/json' },
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        return { valid: false };
      }
      return res
        .json()
        .then(function (data) {
          return {
            valid: !!(data && data.success),
            userId: (data && data.userId) || '',
            isAdmin: !!(data && data.isAdmin),
          };
        })
        .catch(function () {
          // 2xx but unexpected body: still treat as passed auth
          return { valid: res.ok };
        });
    });
  }

  // ---------------------------------------------
  // High-level resource helpers (step 8)
  // ---------------------------------------------
  function runFlow(payload) {
    return post('/run', payload);
  }
  /**
   * Mint a signed, job-bound, expiring SHARE token for the live-view tab. The API
   * key travels in the x-api-key HEADER (request() adds it); only the returned
   * token ever appears in a URL.
   */
  function liveShare(userId, jobId) {
    return post('/live/share/' + encodeURIComponent(userId) + '/' + encodeURIComponent(jobId), {});
  }
  /**
   * Item N — run ONE node: `steps` is the chain PREFIX up to and including it,
   * so the node under test is the LAST step and its input is produced by really
   * executing its ancestors (never synthesised). The server tags the job
   * `__runNode` and does NOT stamp `__workflowId`, so a node test never shows up
   * as a workflow execution or in the workspace stats.
   * body = { steps, nodeIndex?, headless?, triggerData? }
   */
  function runNode(userId, body) {
    var payload = { userId: userId };
    var b = body || {};
    for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) payload[k] = b[k]; }
    return post('/run-node', payload);
  }
  /**
   * List a user's jobs, newest first.
   * `workflowId` is optional and narrows the list to the runs of ONE saved
   * workflow — that is what the Workspace "Executions" tab asks for. Filtering
   * server-side matters: the queue holds every user's runs, so paging a
   * client-side filter would silently drop rows past the limit.
   */
  function listJobs(userId, limit, workflowId) {
    var q = '?limit=' + (limit || 20);
    if (workflowId) q += '&workflowId=' + encodeURIComponent(workflowId);
    return get('/jobs/' + encodeURIComponent(userId) + q);
  }
  function getJob(userId, jobId) {
    return get('/job/' + encodeURIComponent(userId) + '/' + encodeURIComponent(jobId));
  }
  function cancelJob(userId, jobId) {
    return del('/cancel/' + encodeURIComponent(userId) + '/' + encodeURIComponent(jobId));
  }
  function getQuota(userId) {
    return get('/quota/' + encodeURIComponent(userId));
  }
  function listSchedules(userId) {
    return get('/schedules/' + encodeURIComponent(userId));
  }
  function deleteSchedule(userId, key) {
    return del('/schedule/' + encodeURIComponent(userId) + '/' + encodeURIComponent(key));
  }

  // ---------------------------------------------
  // Saved workflows (Step 22 — multi-workflow library).
  // All endpoints are scoped per-user; ids are server-generated (wf_<hex>).
  // ---------------------------------------------
  function wfBase(userId) {
    return '/workflows/' + encodeURIComponent(userId);
  }
  function listWorkflows(userId) {
    return get(wfBase(userId));
  }
  function getWorkflow(userId, workflowId) {
    return get(wfBase(userId) + '/' + encodeURIComponent(workflowId));
  }
  function createWorkflow(userId, body) {
    return post(wfBase(userId), body);
  }
  /** Dry run of a workflow FILE: what would saving it do? Stores nothing. */
  function previewWorkflowImport(userId, envelope) {
    return post(wfBase(userId) + '/import/preview', envelope);
  }
  /** Save a workflow FILE (Code nodes arrive disabled, workflow inactive). */
  function importWorkflow(userId, envelope) {
    return post(wfBase(userId) + '/import', envelope);
  }
  function updateWorkflow(userId, workflowId, body) {
    return put(wfBase(userId) + '/' + encodeURIComponent(workflowId), body);
  }
  function deleteWorkflow(userId, workflowId) {
    return del(wfBase(userId) + '/' + encodeURIComponent(workflowId));
  }
  function listWorkflowVersions(userId, workflowId) {
    return get(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/versions');
  }
  /** Manual save: a restorable version tagged 'manual' (separate from autosave). */
  function saveWorkflowVersion(userId, workflowId, label) {
    return post(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/save', label ? { label: label } : {});
  }
  /** Restore a saved version into the editable design (ordinary edit; Active untouched). */
  function restoreWorkflowVersion(userId, workflowId, version) {
    return post(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/versions/' + encodeURIComponent(String(version)) + '/restore', {});
  }
  function runWorkflow(userId, workflowId, body) {
    return post(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/run', body || {});
  }

  /**
   * Flip the Workspace row switches without touching the workflow design.
   * state: { active?: boolean, liveBrowser?: boolean } — at least one required.
   * The server never bumps Workflow.version for a state change (see
   * docs/uiux/workspace-overview.md section 6).
   */
  function setWorkflowState(userId, workflowId, state) {
    return patch(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/state', state || {});
  }

  /** Aggregated Workspace counters + per-workflow run stats. */
  function workspaceStats(userId) {
    return get('/workspace/' + encodeURIComponent(userId) + '/stats');
  }

  /** Admin stats (requires admin token). */
  function adminStats() {
    return get('/admin/stats', { admin: true });
  }

  /**
   * Validate an admin secret by calling /admin/stats with the token.
   * Returns true on 2xx, false on 403.
   */
  function validateAdminToken(token) {
    return fetch('/admin/stats', {
      headers: { 'x-admin-token': token, Accept: 'application/json' },
    }).then(function (res) {
      return res.ok;
    });
  }

  function getRaw(path, opts) {
    opts = opts || {};
    var key = getKey();
    var headers = Object.assign({}, opts.headers || {});
    if (key) headers['Authorization'] = 'Bearer ' + key;
    return fetch(path, Object.assign({}, opts, { headers: headers, credentials: 'same-origin' }));
  }

  // ---- node output images (screenshots) --------------------------------------
  // A node's image is referenced by a RELATIVE url of exactly one of two shapes:
  //
  //   WORKFLOW WORKSPACE (a run of a saved workflow - the normal case):
  //     /browser/workflow-files/<wf_id>/download?path=downloads/<NN-node>/<file>.png&userId=<u>
  //   PER-JOB STORE (an unsaved canvas / ad-hoc run - no workspace exists):
  //     /job/<user>/<job>/artifact/step-<n>.png
  //
  // An <img src> cannot send the API key, so the bytes are fetched with the
  // key and handed to the <img> as a data: URL. NOT a blob: URL: the page's
  // Content-Security-Policy is `img-src 'self' data:`, and a blob: source is
  // refused by it - which is exactly why the output panel used to show only the
  // alt text and no picture. Widening the CSP would trade a cosmetic bug for an
  // exfiltration surface, so the bytes travel as data: instead.
  //
  // Only those exact shapes are accepted: the key must never be sent to
  // anything a workflow's output merely NAMED.
  var JOB_ARTIFACT_URL = /^\/job\/[^/?#]+\/[^/?#]+\/artifact\/step-\d{1,6}\.(png|jpg)$/;
  var WORKSPACE_IMAGE_URL = /^\/browser\/workflow-files\/[A-Za-z0-9_-]{1,64}\/download\?path=downloads%2F[A-Za-z0-9_-]{1,60}%2F(?:[A-Za-z0-9._()-]|%(?!2[Ff]|5[Cc])){1,300}\.(png|jpg|jpeg)&userId=[A-Za-z0-9_%-]{1,100}$/i;
  var artifactCache = {};   // url -> Promise<data: url>

  function isArtifactUrl(url) {
    return typeof url === 'string' && (JOB_ARTIFACT_URL.test(url) || WORKSPACE_IMAGE_URL.test(url));
  }

  // The download route answers application/octet-stream (it is a download), so
  // the type the <img> needs comes from the file extension we already vetted.
  function imageMimeOf(url) {
    return /\.png(&|$)/i.test(url) ? 'image/png' : 'image/jpeg';
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsDataURL(blob);
    });
  }

  function loadArtifactImage(url) {
    if (!isArtifactUrl(url)) return Promise.reject(new Error('Not an artifact url'));
    if (!artifactCache[url]) {
      artifactCache[url] = getRaw(url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      }).then(function (blob) {
        // Re-type: the download route answers application/octet-stream.
        return blobToDataUrl(blob.slice(0, blob.size, imageMimeOf(url)));
      });
      // A failed load must be retryable (the file may not be flushed yet).
      artifactCache[url].catch(function () { delete artifactCache[url]; });
    }
    return artifactCache[url];
  }

  // Browsers refuse a top-level navigation to a data: URL, so "open full size"
  // converts the bytes to a blob: URL first. A blob: URL opened as a TAB is not
  // governed by img-src (only <img> loads are), so this is safe and CSP-clean.
  function openDataUrlInTab(dataUrl) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(String(dataUrl || ''));
    if (!m) return false;
    var bin = atob(m[2]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var href = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
    window.open(href, '_blank', 'noopener');
    return true;
  }

  window.API = {
    openDataUrlInTab: openDataUrlInTab,
    isArtifactUrl: isArtifactUrl,
    loadArtifactImage: loadArtifactImage,
    getRaw: getRaw,
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    getUserId: getUserId,
    setUserId: setUserId,
    getAdminToken: getAdminToken,
    setAdminToken: setAdminToken,
    runFlow: runFlow,
    liveShare: liveShare,
    runNode: runNode,
    listJobs: listJobs,
    getJob: getJob,
    cancelJob: cancelJob,
    getQuota: getQuota,
    listSchedules: listSchedules,
    deleteSchedule: deleteSchedule,
    listWorkflows: listWorkflows,
    getWorkflow: getWorkflow,
    createWorkflow: createWorkflow,
    previewWorkflowImport: previewWorkflowImport,
    importWorkflow: importWorkflow,
    updateWorkflow: updateWorkflow,
    deleteWorkflow: deleteWorkflow,
    listWorkflowVersions: listWorkflowVersions,
    saveWorkflowVersion: saveWorkflowVersion,
    restoreWorkflowVersion: restoreWorkflowVersion,
    runWorkflow: runWorkflow,
    setWorkflowState: setWorkflowState,
    workspaceStats: workspaceStats,
    adminStats: adminStats,
    validateAdminToken: validateAdminToken,
    request: request,
    get: get,
    post: post,
    put: put,
    patch: patch,
    del: del,
    health: health,
    validateKey: validateKey,
    authMode: authMode,
  };
})();
