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
    // Cleared BOTH ways on purpose: `poll` holds an interval on the remote path
    // and a one-shot timeout on the LOCAL auto-close path. In browsers the two id
    // spaces are shared, so clearing both is correct and neither call can harm
    // the other kind of handle — whereas clearing only the interval would leave a
    // LOCAL timer alive to close a dialog the operator had already replaced.
    if (d.poll) { clearInterval(d.poll); clearTimeout(d.poll); d.poll = null; }
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
   * REMOVED: writeClipboard(), copyButton(), baseUrlRow().
   *
   * All three existed to serve ONE screen — the LOCAL Authorization Code dialog —
   * whose entire job was to move two values (an 8-character code and a Base URL)
   * out of this page and into an extension running on a DIFFERENT machine. That
   * machine does not exist in this product: `LOCAL BROWSER` is the Browser Runtime
   * on the same server as the backend, and both values are now resolved
   * internally and never shown.
   *
   * They are deleted rather than left in place unused. A clipboard helper sitting
   * next to a flow that must never ask the operator to copy a credential is an
   * invitation to reintroduce exactly the defect this change removes, and the
   * i18n keys it consumed (tgt.copied, tgt.baseUrl, tgt.baseDetected, …) would
   * have kept the vocabulary of a credential form alive in the UI's dictionary.
   */

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
    } else if (opt.needsRemoteApproval) {
      // The one thing that still genuinely differs between the two cards, and so
      // the only thing worth warning about BEFORE the click. REPLACES the
      // `needsAuthorization` badge ("an Authorization Code will be shown"), which
      // can no longer be true in either environment.
      noteCls += 'is-code';
      noteText = t('tgt.needsApproval');
    } else {
      // LOCAL, in every case. Paired or not, the connection is automatic, so
      // there is no honest distinction left to draw here — the old `paired` /
      // `noCode` split existed only to promise whether a code was coming.
      noteCls += 'is-ok';
      noteText = t('tgt.automatic');
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
  // Step 2 — LOCAL: the automatic progression
  // ---------------------------------------------------------------------------

  /**
   * WHAT USED TO BE HERE, AND WHY IT IS GONE
   * ----------------------------------------
   * `renderAuthorize()`: an 8-character Authorization Code, a Base URL, a Copy
   * button for each, a "waiting for the extension…" line, and a 1s poll of
   * `targetingStatus` until the operator had retyped both values into the
   * extension popup.
   *
   * Every one of those was addressed to a browser on a DIFFERENT machine. In this
   * product `LOCAL BROWSER` is the Browser Runtime on the SAME server the backend
   * runs on, so there is no second machine to carry a secret to:
   *
   *     «LOCAL باید کاملاً internal/automatic باشد … بدون Base URL، بدون
   *      API Key، بدون Authorization Code، بدون Alert»
   *
   * The server now attaches the destination itself in `/inspector/targeting/begin`
   * (see the shared server-granted branch in src/Routes/mode.routes.ts), so by the
   * time this screen appears there is nothing left to ask and nothing left to
   * wait for. What replaces it is a REPORT of work already done, not a form.
   *
   * WHY IT IS SHOWN AT ALL, RATHER THAN CLOSING SILENTLY
   * ---------------------------------------------------
   * The required flow names its own steps:
   *
   *     LOCAL BROWSER → Detect local browser runtime → Ensure browser ready
   *     → Resolve internal backend/runtime context → Resolve target
   *     → Connected to Target → Ready to Send
   *
   * Rendering them is what makes an automatic connection legible instead of
   * merely fast. A crosshair that flashes and closes leaves the operator unable
   * to tell "connected" from "silently did nothing" — the same ambiguity the old
   * dialog's confirmation delay existed to prevent.
   */
  function renderLocalProgress(panel, res, ctx) {
    var dlg = openDialog;
    header(panel, 'tgt.localTitle', t('tgt.localAuto'));

    var target = res.target || {};

    // Each line is a step the SERVER has already completed. They are rendered
    // resolved rather than animated: inventing a spinner for work that finished
    // before the response arrived would be theatre, and this dialog's whole
    // claim is that nothing is pending.
    var list = el('div', 'tgt-steps');
    var steps = [
      ['tgt.stepRuntime', t('tgt.stepRuntimeOk')],
      ['tgt.stepContext', t('tgt.stepContextOk')],
      ['tgt.stepTarget', target.fieldKey || ctx.fieldKey || ''],
    ];
    for (var i = 0; i < steps.length; i++) {
      var row = el('div', 'tgt-step is-ok');
      row.appendChild(el('span', 'tgt-step-name', t(steps[i][0])));
      row.appendChild(el('span', 'tgt-step-val', steps[i][1]));
      list.appendChild(row);
    }
    panel.appendChild(list);

    // The identity of what is now connected — node, field, and the address the
    // value will land at. Shown because "Connected to Target" with no target
    // named is exactly as unverifiable as the silent close above.
    var idw = el('div', 'tgt-target');
    idw.appendChild(el('div', 'tgt-target-head', t('tgt.connectedTo')));
    var pairs = [
      ['insp.node', target.nodeId || ctx.nodeId || ''],
      ['insp.field', target.label || target.fieldKey || ctx.fieldKey || ''],
      ['insp.fieldId', target.targetFieldId || ''],
    ];
    for (var j = 0; j < pairs.length; j++) {
      if (!pairs[j][1]) continue;
      var line = el('div', 'tgt-target-row');
      line.appendChild(el('span', 'tgt-target-label', t(pairs[j][0])));
      line.appendChild(el('span', 'tgt-target-value', String(pairs[j][1])));
      idw.appendChild(line);
    }
    panel.appendChild(idw);

    var status = el('div', 'tgt-status is-ok', t('tgt.readyToSend'));
    panel.appendChild(status);

    footer(panel, [button(t('tgt.close'), 'is-ghost', closeDialog)]);

    // Arm immediately — the field IS live, so withholding it until the operator
    // dismisses a confirmation would make the dialog load-bearing. It closes on
    // its own so the flow ends where the old one did, at a usable crosshair.
    armed(res.target, 'local', ctx, 'tgt.readyLocal');
    dlg.poll = setTimeout(function () {
      if (openDialog === dlg) closeDialog();
    }, 1600);
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
  function armed(target, environment, ctx, note) {
    if (ctx && typeof ctx.onArmed === 'function') {
      try { ctx.onArmed(target, environment); } catch (e) { /* see above */ }
    }
    // `note` lets the REMOTE branch say something truer than "opening the
    // browser" when the browser is already open and the operator's next move is
    // to answer a prompt inside it. Defaults to the original wording, so LOCAL
    // and the first-launch case are unchanged.
    var key = note || (environment === 'remote' ? 'tgt.readyRemote' : 'tgt.readyLocal');
    toast(t(key), 'info');
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

      // There is no longer an `authorize` step to branch on. The server answers
      // `targeting` for both environments because it attaches the destination
      // itself in either case — see planTargeting in src/core/BrowserEnvironment.ts.
      if (res.openRemoteBrowser) {
        closeDialog();
        openOrReuseRemote(res, ctx, environment, tab);
        return;
      }

      if (tab) { try { tab.close(); } catch (e) {} }

      // ── LOCAL: report the automatic connection ────────────────────────────
      //
      // Replaces the code screen. `renderLocalProgress` arms the field itself and
      // closes on its own, so the flow still ends at a usable crosshair — it just
      // gets there without asking the operator for anything.
      var dlg = buildShell();
      renderLocalProgress(dlg.panel, res, ctx);
    });
  }

  /**
   * REMOTE, second time onwards: do NOT relaunch a browser that is already up.
   *
   * Reported:
   *
   *   «اگر کاربر مرورگر رو نبنده و برم نود بعدی رو باز کنه و گیج میشه که الان من
   *    مرورگرم بالا هست آیا نیازه مجدد آیکون پیکر رو بزنم تا مرورگر بالا بیاد،
   *    اگرم بیاد بهینه نیست»
   *
   *   «یعنی مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد در دفعات تکراری»
   *
   * The server has already raised a consent prompt for this field (res.consent),
   * and that prompt renders inside whatever page the remote browser is showing —
   * see extension/content/consent.js, which polls. So when the browser is live
   * there is nothing to open: the question is already on the operator's screen,
   * and re-launching would throw away the page they were working on and cost a
   * cold start for no gain.
   *
   * The liveness probe decides, not a local flag. A flag would go stale the
   * moment the operator closed the tab themselves, and then the flow would
   * cheerfully tell them to answer a prompt in a browser that is not running.
   * On ANY doubt — probe failed, no BrowserView, not responsive — this falls back
   * to opening the browser, because a needless relaunch is an annoyance while a
   * skipped one is a dead end.
   */
  function openOrReuseRemote(res, ctx, environment, tab) {
    var client = ic();
    var bv = window.BrowserView;
    var env = res.environment || environment;

    // No way to open one at all: nothing to reuse, nothing to launch.
    if (!bv || typeof bv.openRealBrowser !== 'function') {
      if (tab) { try { tab.close(); } catch (e) {} }
      armed(res.target, env, ctx);
      return;
    }

    function launch() {
      // Not awaited: the operator is told by the toast below, and
      // openRealBrowser reports its own failure inside the tab they are
      // actually looking at. It rethrows for callers that do await, so the
      // rejection is swallowed here to avoid a duplicate unhandled report.
      bv.openRealBrowser(ctx.url || '', tab).catch(function () {});
      armed(res.target, env, ctx);
    }

    if (!client || typeof client.remoteBrowserLive !== 'function') { launch(); return; }

    client.remoteBrowserLive().then(function (live) {
      if (!live) { launch(); return; }

      // Already up. Release the tab we speculatively claimed for the popup
      // blocker — leaving it would strand a blank window on screen, which looks
      // exactly like the broken relaunch this branch exists to avoid.
      if (tab) { try { tab.close(); } catch (e) {} }

      // `reused` means the server refreshed an EXISTING question about this same
      // field rather than asking a new one — the operator pressed the picker
      // twice. Saying "still waiting" is honest; repeating "a new prompt is
      // waiting" would imply a second thing to answer that does not exist.
      var reused = !!(res.consent && res.consent.reused);
      armed(res.target, env, ctx, reused ? 'tgt.consentWaiting' : 'tgt.consentAsked');
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
