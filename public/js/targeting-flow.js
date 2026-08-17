/* ============================================
   Targeting Flow — the LOCAL / REMOTE chooser (window.TargetingFlow).

   THE STEP THAT WAS MISSING
   -------------------------
   Clicking the crosshair used to go straight to the server's Chromium:

     pickerBtn (ndv-nodes.js) -> BrowserView.requestPick -> openRealBrowser()

   openRealBrowser() was called UNCONDITIONALLY, so "target this field" and "use
   the remote browser" were the same action and there was no point at which the
   operator could say otherwise. The requirement is explicit that they are not
   the same action:

     «وقتی روی آیکون 🎯 Target This Field کلیک می‌شود، اولین قدم باید انتخاب
      محیط مرورگر باشد، نه انتخاب حالت اتصال.»

   So this module inserts ONE step in front of the pick:

     Target This Field -> [ LOCAL BROWSER | REMOTE BROWSER ] -> ...

   REMOTE — the server owns that Chromium and the extension inside it, so the
            backend binds the Inspector itself and picking starts at once. No
            Authorization Code, by requirement.
   LOCAL  — the operator's own browser. If THIS Target Field has never been
            paired for this extension, a code is issued for THIS FIELD and the
            dialog waits for it to be typed in. Once accepted the pairing is
            durable, so the next time the same field is targeted the chooser
            reports "already paired" and no code is asked for.

   WHERE THE DECISION ACTUALLY LIVES
   ---------------------------------
   Not here. Every branch shown below is computed server-side by
   src/core/BrowserEnvironment.ts (planTargeting / environmentOptions) and
   returned by /inspector/targeting/{options,begin}. This file RENDERS a plan
   and never invents one — that is what keeps the dialog from promising "no code
   needed" and then producing a code, and it is why the requirement to implement
   this in the backend as well as the UI is satisfied rather than mimicked.

   THE THREE IDENTITIES THIS FLOW KEEPS APART
   ------------------------------------------
     Browser Environment = LOCAL / REMOTE          (chosen here, per pick)
     Session / Handoff   = as_… remote-browser infra (untouched by this file)
     targetFieldId       = the data destination     (minted by the server)

   No session id appears anywhere in this module. A pick is routed by the
   Target Field it was registered against, never by a session.

   CSP-safe: no inline handlers, no eval, no innerHTML with interpolation.
   ============================================ */
(function () {
  'use strict';

  // --- ambient helpers -----------------------------------------------------
  // Resolved lazily on every call rather than captured at load time: this file
  // is loaded before views.js, and in the unit harness some of these are
  // installed after the module is evaluated.

  function t(k) {
    return (window.AppUtil && window.AppUtil.t) ? window.AppUtil.t(k) : k;
  }
  function toast(msg, kind) {
    if (window.AppUtil && window.AppUtil.toast) window.AppUtil.toast(msg, kind || 'info');
  }
  function ic() {
    var c = window.InspectorClient;
    return (c && typeof c.targetingBegin === 'function') ? c : null;
  }

  /** Element factory. Text goes through textContent, so a label can never inject markup. */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // Notes that mean "this environment cannot be used", mapped to the sentence
  // that says why. Kept as a table because the server sends the KEY, never a
  // prose string — the message has to be translatable on this side.
  var NOTE_KEYS = {
    local_disabled: 'tgt.localDisabled',
    local_unavailable: 'tgt.localUnavailable',
  };

  // ---------------------------------------------------------------------------
  // Dialog shell
  // ---------------------------------------------------------------------------

  // Exactly one chooser at a time. Two open dialogs would race for the same
  // field and the second `begin` would re-mint the address the first is polling
  // on, so the first would wait forever for a pairing recorded against an
  // address nobody holds.
  var openDialog = null;

  function closeDialog() {
    var d = openDialog;
    openDialog = null;
    if (!d) return;
    if (d.poll) { clearInterval(d.poll); d.poll = null; }
    if (d.onKey) {
      document.removeEventListener('keydown', d.onKey, true);
      d.onKey = null;
    }
    if (d.backdrop && d.backdrop.parentNode) {
      d.backdrop.parentNode.removeChild(d.backdrop);
    }
  }

  /**
   * Build (or rebuild) the modal shell and return { backdrop, panel }.
   *
   * Called a second time when the flow moves from the chooser to the code
   * screen: replacing the panel wholesale is what guarantees no stale card,
   * badge or poll timer from step one survives into step two.
   */
  function buildShell() {
    closeDialog();

    var backdrop = el('div', 'tgt-backdrop');
    var panel = el('div', 'tgt-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    backdrop.appendChild(panel);

    var dlg = { backdrop: backdrop, panel: panel, poll: null, onKey: null };
    openDialog = dlg;

    // Guarded by the target test: a click that STARTED on a card and drifted
    // onto the backdrop must not be read as "cancel".
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeDialog();
    });

    // Capture phase, on document: the panel may not hold focus (the operator
    // may never have clicked inside it), and Escape must still close.
    dlg.onKey = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        closeDialog();
      }
    };
    document.addEventListener('keydown', dlg.onKey, true);

    document.body.appendChild(backdrop);
    return dlg;
  }

  function header(panel, titleKey, subText) {
    var head = el('div', 'tgt-head');
    head.appendChild(el('div', 'tgt-title', t(titleKey)));
    if (subText) head.appendChild(el('div', 'tgt-sub', subText));
    panel.appendChild(head);
    return head;
  }

  function button(label, cls, onClick) {
    var b = el('button', 'tgt-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function footer(panel, buttons) {
    var foot = el('div', 'tgt-foot');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i]) foot.appendChild(buttons[i]);
    }
    panel.appendChild(foot);
    return foot;
  }

  /**
   * The Base URL, beside the code, with its own Copy button.
   *
   * Its own button rather than one that copies both: they go into two different
   * fields in the extension, so a combined copy would only have to be pulled
   * apart again by hand. The address is rendered LTR and `user-select:all` for
   * the same reason as the code — it is retyped into another application, and a
   * bidi-reordered URL is a URL that gets mistyped in an RTL page.
   *
   * `source` is shown because "detected" and "configured" do not deserve equal
   * confidence. A detected LAN address is a good guess that the operator may
   * need to correct; saying so is what lets them realise they should set
   * PUBLIC_DOMAIN instead of concluding the product is broken.
   */
  function baseUrlRow(baseUrl, source) {
    var wrap = el('div', 'tgt-base');

    var head = el('div', 'tgt-base-head');
    head.appendChild(el('span', 'tgt-base-label', t('tgt.baseUrl')));
    var hintKey = source === 'configured' ? 'tgt.baseConfigured'
      : source === 'request' ? 'tgt.baseRequest'
        : source === 'detected' ? 'tgt.baseDetected'
          : source === 'loopback' ? 'tgt.baseLoopback' : '';
    if (hintKey) {
      head.appendChild(el('span', 'tgt-base-src' + (source === 'configured' ? ' is-ok' : ''), t(hintKey)));
    }
    wrap.appendChild(head);

    var line = el('div', 'tgt-base-line');
    // textContent, never innerHTML: this string is assembled from a Host header.
    var value = el('code', 'tgt-base-url', baseUrl);
    line.appendChild(value);

    var copy = button(t('insp.copy'), 'is-quiet tgt-base-copy', function () {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(baseUrl);
      } catch (e) { /* it is on screen; copying is a convenience */ }
      // Confirm the copy on the button itself. Without it a click on a
      // clipboard button is indistinguishable from a click that did nothing.
      var was = copy.textContent;
      copy.textContent = t('tgt.copied');
      setTimeout(function () { copy.textContent = was; }, 1200);
    });
    line.appendChild(copy);
    wrap.appendChild(line);

    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Step 1 — the chooser
  // ---------------------------------------------------------------------------

  /**
   * One environment card.
   *
   * The badge is the honest part of this dialog: it says, BEFORE the click,
   * whether a code is coming. `opt` is the server's own EnvironmentOption, so
   * the badge cannot disagree with what /begin will actually do.
   */
  function optionCard(opt, onChoose) {
    var isLocal = opt.id === 'local';
    var card = el('button', 'tgt-card' + (opt.available ? '' : ' is-off'));
    card.type = 'button';
    card.setAttribute('data-env', opt.id);

    card.appendChild(el('div', 'tgt-card-name', t(isLocal ? 'tgt.local' : 'tgt.remote')));
    card.appendChild(el('div', 'tgt-card-desc', t(isLocal ? 'tgt.localDesc' : 'tgt.remoteDesc')));

    var noteCls = 'tgt-card-note ';
    var noteText;
    if (!opt.available) {
      noteCls += 'is-warn';
      noteText = t(NOTE_KEYS[opt.note] || 'tgt.localUnavailable');
    } else if (opt.needsAuthorization) {
      noteCls += 'is-code';
      noteText = t('tgt.needsCode');
    } else if (isLocal && opt.paired) {
      noteCls += 'is-ok';
      noteText = t('tgt.paired');
    } else {
      noteCls += 'is-ok';
      noteText = t('tgt.noCode');
    }
    card.appendChild(el('div', noteCls, noteText));

    if (!opt.available) {
      card.disabled = true;
      card.setAttribute('aria-disabled', 'true');
    } else {
      card.addEventListener('click', function () { onChoose(opt.id); });
    }
    return card;
  }

  function renderChooser(panel, res, ctx) {
    // The field being targeted is named in the subtitle. "Target with which
    // browser?" on its own is ambiguous the moment a node has two pickable
    // fields, and this dialog's entire purpose is per-FIELD choice.
    var sub = ctx.label ? (t('tgt.subtitle') + ' — ' + ctx.label) : t('tgt.subtitle');
    header(panel, 'tgt.title', sub);

    var grid = el('div', 'tgt-grid');
    var options = (res && res.options) || [];
    for (var i = 0; i < options.length; i++) {
      grid.appendChild(optionCard(options[i], function (env) { choose(env, ctx); }));
    }
    panel.appendChild(grid);

    var buttons = [button(t('tgt.cancel'), 'is-ghost', closeDialog)];

    // Offered ONLY when a pairing exists, because this is the one and only
    // thing that brings the code back. Closing a node, switching modes and
    // letting an address expire all deliberately leave the pairing alone.
    if (res && res.paired) {
      buttons.unshift(button(t('tgt.unpair'), 'is-quiet', function () {
        var client = ic();
        if (!client) return;
        client.targetingUnpair(ctx.nodeId, ctx.fieldKey, { workflowId: ctx.workflowId })
          .then(function () {
            closeDialog();
            toast(t('tgt.unpaired'), 'info');
          });
      }));
    }

    footer(panel, buttons);
  }

  // ---------------------------------------------------------------------------
  // Step 2 — the Authorization Code (LOCAL, first time for this field)
  // ---------------------------------------------------------------------------

  /**
   * Show the code and wait for the extension to accept it.
   *
   * POLLED, not pushed. The dashboard cannot observe the extension directly —
   * they are different browsers, which is the entire point of LOCAL — so the
   * server, the only party that sees both sides, is asked. This also keeps
   * working behind a proxy that breaks WebSockets.
   */
  function renderAuthorize(panel, res, ctx) {
    var dlg = openDialog;
    header(panel, 'tgt.authTitle', t('tgt.authHint'));

    // `display` is the grouped form (e.g. "4821-9930"). LTR and user-select:all
    // are set in CSS so the code reads correctly and copies cleanly in an RTL
    // page — a digit group must not be reordered by the bidi algorithm.
    var code = el('div', 'tgt-code', res.display || res.code || '');
    panel.appendChild(code);
    panel.appendChild(el('div', 'tgt-expires', t('insp.codeExpires')));

    // ── The other half of the pairing ────────────────────────────────────────
    // A code alone is not usable: the extension needs an address to send it to,
    // and until now the operator had to work that out themselves. On a laptop
    // the guess is localhost:3000 and usually right; behind Cloudflare, on a
    // VPS or in a Codespace it is not, and the result is an extension that
    // cannot connect while this dialog insists a valid code is waiting.
    //
    // The server sends it because only the server knows its configured domain
    // and listening port. If it sends nothing (an older server), this block is
    // skipped entirely rather than inventing an address here — a made-up Base
    // URL presented this confidently is worse than none.
    if (res.baseUrl) {
      panel.appendChild(baseUrlRow(res.baseUrl, res.baseUrlSource));
    }

    var status = el('div', 'tgt-status', t('tgt.waiting'));
    panel.appendChild(status);

    footer(panel, [
      button(t('insp.copy'), 'is-quiet', function () {
        try {
          if (navigator.clipboard) navigator.clipboard.writeText(res.code || '');
        } catch (e) { /* the code is on screen; copying is a convenience */ }
      }),
      button(t('tgt.cancel'), 'is-ghost', closeDialog),
    ]);

    var client = ic();
    if (!client) return;

    var targetFieldId = res.target && res.target.targetFieldId;
    if (!targetFieldId) return;

    dlg.poll = setInterval(function () {
      // A timer that outlived its dialog would write into a detached node and,
      // worse, arm a field the operator has since cancelled.
      if (openDialog !== dlg) { clearInterval(dlg.poll); return; }
      client.targetingStatus(targetFieldId).then(function (s) {
        if (openDialog !== dlg) return;
        if (!s || !s.paired) return;
        clearInterval(dlg.poll);
        dlg.poll = null;
        status.textContent = t('tgt.pairedNow');
        status.className = 'tgt-status is-ok';
        // Held briefly so the confirmation is actually read before the dialog
        // disappears; without it the panel vanishes the instant the code is
        // accepted and the operator cannot tell success from a crash.
        setTimeout(function () {
          if (openDialog !== dlg) return;
          closeDialog();
          armed(res.target, 'local', ctx);
        }, 900);
      });
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Arming
  // ---------------------------------------------------------------------------

  /**
   * The field is now a live destination: tell the caller and say so out loud.
   *
   * `onArmed` is wrapped because it belongs to the NDV, and a throw from a
   * re-render there must not leave the operator with a silently dead crosshair
   * after a pairing they just completed.
   */
  function armed(target, environment, ctx) {
    if (ctx && typeof ctx.onArmed === 'function') {
      try { ctx.onArmed(target, environment); } catch (e) { /* see above */ }
    }
    toast(t(environment === 'remote' ? 'tgt.readyRemote' : 'tgt.readyLocal'), 'info');
  }

  // ---------------------------------------------------------------------------
  // The choice
  // ---------------------------------------------------------------------------

  function choose(environment, ctx) {
    var client = ic();
    if (!client) { toast(t('tgt.failed'), 'error'); return; }

    // POPUP BLOCKER: window.open() only survives while the call stack is still
    // inside the user gesture. `begin` is awaited, so a tab opened after it
    // returns is blocked. The remote branch therefore CLAIMS the tab here,
    // synchronously, and hands it to openRealBrowser() later — that function
    // already accepts an existing tab as its second argument for exactly this.
    // If the plan turns out not to need it, the tab is closed below.
    var tab = (environment === 'remote') ? window.open('', '_blank') : null;

    client.targetingBegin(ctx.nodeId, ctx.fieldKey, environment, {
      action: ctx.action,
      workflowId: ctx.workflowId,
      label: ctx.label,
    }).then(function (res) {
      if (!res || !res.success) {
        if (tab) { try { tab.close(); } catch (e) {} }
        // A refusal carries a REASON key (local_disabled / local_unavailable).
        // Reporting it beats a generic failure, and it is the visible proof
        // that the server refuses loudly instead of silently downgrading LOCAL
        // to REMOTE behind the operator's back.
        var key = res && res.reason && NOTE_KEYS[res.reason];
        toast(t(key || 'tgt.failed'), 'error');
        return;
      }

      if (res.step === 'authorize') {
        if (tab) { try { tab.close(); } catch (e) {} }
        var dlg = buildShell();
        renderAuthorize(dlg.panel, res, ctx);
        return;
      }

      // step === 'targeting' — nothing more to ask.
      closeDialog();

      if (res.openRemoteBrowser) {
        var bv = window.BrowserView;
        if (bv && typeof bv.openRealBrowser === 'function') {
          // Not awaited: the operator is told by the toast below, and
          // openRealBrowser reports its own failure inside the tab they are
          // actually looking at. It rethrows for callers that do await, so the
          // rejection is swallowed here to avoid a duplicate unhandled report.
          bv.openRealBrowser(ctx.url || '', tab).catch(function () {});
        } else if (tab) {
          try { tab.close(); } catch (e) {}
        }
      } else if (tab) {
        try { tab.close(); } catch (e) {}
      }

      armed(res.target, res.environment || environment, ctx);
    });
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  /**
   * Open the chooser for one field.
   *
   * ctx = {
   *   nodeId, fieldKey,          // required — the destination's identity
   *   action, workflowId, label, // registration detail
   *   url,                       // page the remote browser should land on
   *   onArmed(target, env),      // called once the field is a live destination
   * }
   */
  function start(ctx) {
    var c = ctx || {};
    if (!c.nodeId || !c.fieldKey) return false;

    var client = ic();
    if (!client) {
      // Deliberately NOT falling back to opening the remote browser. That
      // fallback is precisely the behaviour this module was written to remove;
      // silently reinstating it whenever the client is missing would make the
      // old bug reappear under the exact conditions nobody tests.
      toast(t('tgt.failed'), 'error');
      return false;
    }

    client.targetingOptions(c.nodeId, c.fieldKey, { workflowId: c.workflowId })
      .then(function (res) {
        if (!res) { toast(t('tgt.failed'), 'error'); return; }
        var dlg = buildShell();
        renderChooser(dlg.panel, res, c);
      });
    return true;
  }

  window.TargetingFlow = {
    start: start,
    close: closeDialog,
    isOpen: function () { return !!openDialog; },
  };
})();
