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
          var msg = (data && data.error) || (typeof data === 'string' ? data : 'HTTP ' + res.status);
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
  function listJobs(userId, limit) {
    return get('/jobs/' + encodeURIComponent(userId) + '?limit=' + (limit || 20));
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
  function updateWorkflow(userId, workflowId, body) {
    return put(wfBase(userId) + '/' + encodeURIComponent(workflowId), body);
  }
  function deleteWorkflow(userId, workflowId) {
    return del(wfBase(userId) + '/' + encodeURIComponent(workflowId));
  }
  function listWorkflowVersions(userId, workflowId) {
    return get(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/versions');
  }
  function runWorkflow(userId, workflowId, body) {
    return post(wfBase(userId) + '/' + encodeURIComponent(workflowId) + '/run', body || {});
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

  window.API = {
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    getUserId: getUserId,
    setUserId: setUserId,
    getAdminToken: getAdminToken,
    setAdminToken: setAdminToken,
    runFlow: runFlow,
    listJobs: listJobs,
    getJob: getJob,
    cancelJob: cancelJob,
    getQuota: getQuota,
    listSchedules: listSchedules,
    deleteSchedule: deleteSchedule,
    listWorkflows: listWorkflows,
    getWorkflow: getWorkflow,
    createWorkflow: createWorkflow,
    updateWorkflow: updateWorkflow,
    deleteWorkflow: deleteWorkflow,
    listWorkflowVersions: listWorkflowVersions,
    runWorkflow: runWorkflow,
    adminStats: adminStats,
    validateAdminToken: validateAdminToken,
    request: request,
    get: get,
    post: post,
    put: put,
    del: del,
    health: health,
    validateKey: validateKey,
  };
})();
