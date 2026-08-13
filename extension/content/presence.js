/* ============================================================
   presence.js — lets the app page know this extension is installed.

   WHY THIS FILE EXISTS
   --------------------
   The "Switch to Local" flow has to answer one question before it can show the
   user anything useful: is the extension already here, or does this person need
   to install it first? Those are two completely different screens — a pairing
   code versus an install link — and guessing wrong means either sending someone
   to install what they already have, or showing a code to a browser that has
   nothing to redeem it.

   WHY NOT web_accessible_resources
   --------------------------------
   The usual trick is to fetch chrome-extension://<id>/installed.json from the
   page. That needs the extension ID to be known and stable. This extension is
   installed UNPACKED (Load unpacked) and side-loaded into the remote browser,
   and an unpacked extension's ID is derived from its path — so it differs on
   every machine. A detector built on a hardcoded ID would report "not
   installed" for every real user. A DOM marker needs no ID at all.

   WHY A DOM ATTRIBUTE AND NOT postMessage
   ---------------------------------------
   A handshake over postMessage only answers if the page is listening at the
   moment the message is sent, which makes it a race against page load. An
   attribute is state, not an event: whenever the page decides to look — on
   load, on a click, five minutes later — the answer is already sitting there.

   TRUST BOUNDARY
   --------------
   This marker is a HINT for choosing which UI to show. It is not a credential
   and is not treated as one: any script on the page can set the same attribute.
   Nothing is authorised on the strength of it — the pairing code is still
   redeemed against the server, which is what actually decides. The worst a
   forged marker can do is show a pairing box to someone who then cannot use it.
   ============================================================ */
'use strict';

(function () {
  // `document_idle` can still run before <html> exists in edge cases, and a
  // throw here would abort the whole content-script bundle for this frame —
  // taking the inspector down with it. Cheap guard, no downside.
  if (!document || !document.documentElement) return;

  try {
    var root = document.documentElement;

    // Read by public/js code as `document.documentElement.dataset.abExtension`.
    root.setAttribute('data-ab-extension', '1');
    root.setAttribute('data-ab-extension-version',
      (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '');

    // Some pages replace documentElement's attributes during hydration (SPA
    // frameworks rewriting the root element), which would silently erase the
    // marker and make an installed extension look absent. Answering a direct
    // question survives that, so the attribute is a fast path and this is the
    // reliable one.
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;                 // ignore other frames
      var data = ev.data;
      if (!data || data.type !== 'AB_EXTENSION_PING') return;
      window.postMessage({
        type: 'AB_EXTENSION_PONG',
        version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || ''
      }, '*');
    }, false);
  } catch (e) {
    // A hostile or sandboxed page can make any of the above throw. Failing
    // silently degrades to "extension not detected", which shows the install
    // link — a harmless outcome — whereas an uncaught error would break the
    // sibling content scripts loaded from the same manifest entry.
  }
})();
