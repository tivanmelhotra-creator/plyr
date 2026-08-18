/* ==========================================================================
   consent.js — In-page consent banner for Remote Browser Element Inspection
   ========================================================================== */

(function () {
  'use strict';

  if (window.__AB_CONSENT_LOADED__) return;
  window.__AB_CONSENT_LOADED__ = true;

  var currentOfferId = null;
  var pollInterval = null;

  function createBanner(offer) {
    var existing = document.getElementById('ab-remote-consent-banner');
    if (existing) existing.remove();

    var host = document.createElement('div');
    host.id = 'ab-remote-consent-banner';
    var shadow = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
      '.banner { position: fixed; top: 16px; right: 16px; z-index: 2147483647; background: #1e293b; color: #f8fafc;',
      '  padding: 14px 18px; border-radius: 10px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5);',
      '  display: flex; flex-direction: column; gap: 10px; min-width: 280px; max-width: 380px; border: 1px solid #334155;',
      '  animation: slideIn 0.2s ease-out; }',
      '@keyframes slideIn { from { transform: translateY(-10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }',
      '.header { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; color: #38bdf8; }',
      '.body { font-size: 12px; line-height: 1.4; color: #cbd5e1; }',
      '.node-info { background: #0f172a; padding: 6px 10px; border-radius: 6px; margin: 4px 0; font-family: monospace; font-size: 11px; color: #e2e8f0; }',
      '.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }',
      'button { border: none; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; transition: opacity 0.15s; }',
      'button:hover { opacity: 0.9; }',
      '.btn-accept { background: #0284c7; color: white; }',
      '.btn-reject { background: transparent; color: #94a3b8; }',
      '.btn-reject:hover { background: #334155; color: #f1f5f9; }'
    ].join('\n');
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'banner';

    var hdr = document.createElement('div');
    hdr.className = 'header';
    hdr.innerHTML = '🎯 <span>Automation Inspector Target</span>';
    wrap.appendChild(hdr);

    var bdy = document.createElement('div');
    bdy.className = 'body';
    bdy.textContent = 'A workflow node is requesting element inspection:';
    
    var info = document.createElement('div');
    info.className = 'node-info';
    var target = offer.target || {};
    var nodeLabel = target.nodeName || target.nodeId || 'Unknown Node';
    var fieldLabel = target.fieldName || target.fieldKey || 'Target Field';
    info.textContent = 'Node: ' + nodeLabel + ' ➔ ' + fieldLabel;
    bdy.appendChild(info);
    wrap.appendChild(bdy);

    var acts = document.createElement('div');
    acts.className = 'actions';

    var btnReject = document.createElement('button');
    btnReject.className = 'btn-reject';
    btnReject.textContent = 'Dismiss';
    btnReject.onclick = function () {
      chrome.runtime.sendMessage({ type: 'AB_CONSENT_REJECT', offerId: offer.id });
      host.remove();
    };

    var btnAccept = document.createElement('button');
    btnAccept.className = 'btn-accept';
    btnAccept.textContent = 'Connect Target';
    btnAccept.onclick = function () {
      btnAccept.disabled = true;
      btnAccept.textContent = 'Connecting...';
      chrome.runtime.sendMessage({ type: 'AB_CONSENT_ACCEPT', offerId: offer.id }, function (res) {
        if (res && res.success) {
          host.remove();
        } else {
          btnAccept.textContent = 'Failed';
        }
      });
    };

    acts.appendChild(btnReject);
    acts.appendChild(btnAccept);
    wrap.appendChild(acts);

    shadow.appendChild(wrap);
    document.body.appendChild(host);
  }

  function checkPending() {
    chrome.runtime.sendMessage({ type: 'AB_CONSENT_PENDING' }, function (res) {
      if (chrome.runtime.lastError) return;
      if (res && res.offer) {
        if (currentOfferId !== res.offer.id) {
          currentOfferId = res.offer.id;
          createBanner(res.offer);
        }
      } else {
        var existing = document.getElementById('ab-remote-consent-banner');
        if (existing) existing.remove();
        currentOfferId = null;
      }
    });
  }

  pollInterval = setInterval(checkPending, 2000);
  checkPending();
})();
