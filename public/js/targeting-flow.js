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

   THE TWO NAMES, READ FROM WHERE THE PROJECT STANDS
   -------------------------------------------------
   These two were the wrong way round in this file, and the report was exact:

     «مشکل از پروژه هست که نام گذاری اشتباهی داره — یعنی موقعی که روی پیکر
      می‌زنم و باکس بالا میاد که لوکال می‌خوای یا ریموت، وقتی لوکال می‌زنم باید
      مرورگر لوکال سرور بالا بیاد ولی برعکسه. و منطقی‌تره این عمل.»

   LOCAL  — the browser runtime on the SAME SERVER as this project: local TO THE
            PROJECT. Pressing it launches that browser, or REUSES the window
            already open, and the server raises an in-page prompt inside it
            naming the node and field. One machine, so there is nothing to
            transport: no Base URL, no API key, no Authorization Code. The
            prompt is not ceremony either — one server browser is shared across
            every field, so it must be told which field this pick belongs to.
   REMOTE — a browser on the OPERATOR'S OWN machine: remote FROM the project.
            Two machines with a real network between them, and this server can
            neither launch it nor see it. So nothing opens here; instead the
            server issues a single-use code FOR THIS FIELD, reports its own
            public address, and the extension over there redeems both. A fresh
            code per field is deliberate — «هر بار فیلد جدید اتورایز جدید باعث
            شد ما همیشه با فیلد جدید ست بمونیم».

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
   * RESTORED, for REMOTE only: writeClipboard(), copyButton(), valueRow().
   *
   * These were deleted, and the reasoning was half right. They exist to move two
   * values — a code and an address — out of this page and into an extension
   * running on a DIFFERENT machine, and the previous revision concluded that no
   * such machine exists in this product.
   *
   * That is true of LOCAL and false of REMOTE. LOCAL is the browser runtime on
   * the same server as the backend: both values are internal there, and neither
   * is ever shown — no code screen, no Copy button, no Base URL. REMOTE is a
   * browser on the OPERATOR'S OWN machine, and for that one the two-machine
   * problem is the entire situation:
   *
   *   «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند … پس ما هم به یک اتورایز
   *    نیاز داریم تا تایید بشه که فرد خودش است و هم به یک بیس یو ار ال»
   *
   * So the helpers come back, scoped to the one screen that legitimately has
   * something to carry. What does NOT come back is an API-key row or a password
   * row: the extension authenticates with its own key, and the address plus a
   * per-field code is the whole of what crosses the gap.
   */

  /**
   * Copy to clipboard, with a same-gesture fallback.
   *
   * navigator.clipboard is unavailable on plain http:// origins, which is exactly
   * how a self-hosted instance on a LAN is usually reached — the case this screen
   * is FOR. The execCommand path is deprecated but still the only thing that
   * works there, and a Copy button that silently does nothing on the deployment
   * most likely to need it is worse than no button.
   */
  function writeClipboard(text) {
    var s = String(text == null ? '' : text);
    if (!s) return Promise.resolve(false);
    if (window.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(s); });
    }
    return Promise.resolve(legacyCopy(s));
  }

  function legacyCopy(s) {
    try {
      var ta = document.createElement('textarea');
      ta.value = s;
      // Off-screen rather than display:none — a hidden textarea cannot be
      // selected, and an unselected one copies nothing.
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand ? document.execCommand('copy') : false;
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * A Copy button that says what happened ON ITSELF.
   *
   * A clipboard button that looks identical before and after the press cannot be
   * told apart from one that did nothing, and a failed copy is otherwise
   * invisible until the operator pastes the wrong thing into the extension and
   * gets an unexplained rejection.
   */
  function copyButton(getText, cls) {
    var b = button(t('tgt.copy'), cls, function () {
      writeClipboard(getText()).then(function (ok) {
        b.textContent = t(ok ? 'tgt.copied' : 'tgt.copyManual');
        b.className = 'tgt-btn ' + (cls || '') + (ok ? ' is-ok' : ' is-warn');
        setTimeout(function () {
          // Only if this button is still on screen: the dialog may have been
          // closed and rebuilt, and writing to a detached node is harmless but
          // pointless, while writing to a REPLACED one would be wrong.
          if (!b.parentNode) return;
          b.textContent = t('tgt.copy');
          b.className = 'tgt-btn ' + (cls || '');
        }, 1400);
      });
    });
    return b;
  }

  /**
   * One labelled, copyable value. Used for both the code and the address, so the
   * two cannot drift into looking like different kinds of thing.
   */
  function valueRow(labelKey, value, opts) {
    var o = opts || {};
    var wrap = el('div', 'tgt-base' + (o.wrapCls ? ' ' + o.wrapCls : ''));

    var head = el('div', 'tgt-base-head');
    head.appendChild(el('span', 'tgt-base-label', t(labelKey)));
    if (o.srcKey) {
      head.appendChild(el('span', 'tgt-base-src' + (o.srcOk ? ' is-ok' : ''), t(o.srcKey)));
    }
    wrap.appendChild(head);

    var line = el('div', 'tgt-base-line');
    line.appendChild(el('div', o.valueCls || 'tgt-base-url', value));
    line.appendChild(copyButton(function () { return value; }, o.copyCls || 'tgt-base-copy'));
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
   * the badge cannot disagree with what /begin will actually do — and now that
   * the two environments differ again, that guarantee is load-bearing rather
   * than decorative. An operator who presses REMOTE and is then shown a form
   * they were not warned about has been misled by this badge.
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
      // REMOTE. Checked FIRST because it is the heavier promise: a code and an
      // address have to be moved onto another machine, and someone who would
      // rather not do that should be able to decide before pressing, not after.
      //
      // This badge is BACK, having been removed on the belief that no
      // environment could ever need a code. Half of that was right — the
      // server's own browser cannot need one — but it was applied to both.
      noteCls += 'is-code';
      noteText = t('tgt.needsCode');
    } else if (opt.needsInPageApproval) {
      // LOCAL. No credential anywhere, but not silent either: the server browser
      // is shared across fields and outlives any one pick, so it asks which field
      // this is for. Saying "automatic" flatly would leave the operator waiting
      // at a picker for a prompt they were never told to answer.
      noteCls += 'is-ok';
      noteText = t('tgt.needsApproval');
    } else {
      // Available, no code, no prompt — a field already bound in this browser.
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
  // Step 2a — REMOTE: the authorization screen
  // ---------------------------------------------------------------------------

  /**
   * REMOTE: show the code and the address, then wait for the other machine.
   *
   * WHY THIS SCREEN EXISTS AGAIN
   * ---------------------------
   * It was deleted, and for LOCAL that deletion is permanent and correct — the
   * browser on this server needs nothing carried to it. But it was deleted for
   * BOTH environments, on the premise that both belonged to the server. Only one
   * does. REMOTE is a browser on the operator's own machine, and across that gap
   * there is no channel except the operator:
   *
   *   «سرور و سیستم شخصی دو تا ارتباط ریموتی دارند … پس ما هم به یک اتورایز نیاز
   *    داریم تا تایید بشه که فرد خودش است و هم به یک بیس یو ار ال»
   *
   * WHAT IS DIFFERENT FROM THE OLD VERSION
   * -------------------------------------
   * The old screen could show a code that belonged to nobody, because
   * /inspector/authorize minted codes with no field attached. That route is NOT
   * restored. This code is minted inside /inspector/targeting/begin, so it cannot
   * exist without the field it was issued for — which is why the field is named
   * on screen, and why a fresh code per field is the desired behaviour rather
   * than a nuisance:
   *
   *   «هر بار فیلد جدید اتورایز جدید باعث شد ما همیشه با فیلد جدید ست بمونیم»
   *
   * The poll is on `targetingStatus`, not on a timer that assumes success. The
   * pairing completes on the OTHER machine, so this page cannot know it happened
   * until the server says so — and closing optimistically would leave a crosshair
   * armed for a binding that was never made.
   */
  function renderAuthorize(panel, res, ctx) {
    var dlg = openDialog;
    var auth = res.authorization || {};
    var target = res.target || {};
    var label = target.label || auth.label || target.fieldKey || ctx.fieldKey || '';

    header(panel, 'tgt.authTitle', label ? (t('tgt.authHint') + ' — ' + label) : t('tgt.authHint'));

    // The code first and largest: it is the thing that expires, and the thing
    // being transcribed right now. The address is needed too but rarely changes,
    // so the two must not compete for the same attention.
    panel.appendChild(valueRow('tgt.authCode', auth.code || '', {
      wrapCls: 'tgt-code-wrap',
      valueCls: 'tgt-code',
      copyCls: 'tgt-code-copy',
    }));

    // Where THIS browser can reach the server. Resolved by the server itself
    // (src/core/PublicBaseUrl.ts) rather than assembled here, because a page can
    // only see the address it was itself loaded from — which is frequently not
    // the address a different machine has to use.
    if (auth.baseUrl) {
      panel.appendChild(valueRow('tgt.baseUrl', auth.baseUrl, {}));
    }

    var status = el('div', 'tgt-status', t('tgt.waiting'));
    panel.appendChild(status);

    footer(panel, [button(t('tgt.close'), 'is-ghost', closeDialog)]);

    // ── wait for the other machine ─────────────────────────────────────────
    //
    // A 1s poll rather than a socket: the completing event happens on a machine
    // this page has no connection to, and the server is the only party that sees
    // both sides. One second is short enough that the transition feels immediate
    // and long enough that an idle dialog is not a load source.
    var targetFieldId = target.targetFieldId || '';
    if (!targetFieldId) return;

    var client = ic();
    if (!client || typeof client.targetingStatus !== 'function') return;

    dlg.poll = setInterval(function () {
      // The dialog may have been closed or replaced while a request was in
      // flight; writing into a panel the operator has already dismissed would
      // resurrect a screen they closed.
      if (openDialog !== dlg) { clearInterval(dlg.poll); return; }

      client.targetingStatus(targetFieldId).then(function (st) {
        if (openDialog !== dlg) return;
        if (!st || !st.paired) return;

        clearInterval(dlg.poll);
        dlg.poll = null;
        status.className = 'tgt-status is-ok';
        status.textContent = t('tgt.pairedNow');

        // Armed only NOW, on the server's word. Arming when the code was issued
        // would light the crosshair for a browser that never redeemed it.
        armed(target, 'remote', ctx, 'tgt.pairedNow');
        setTimeout(function () {
          if (openDialog === dlg) closeDialog();
        }, 1200);
      });
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Step 2 — LOCAL: the automatic progression
  // ---------------------------------------------------------------------------

  /**
   * LOCAL: nothing to ask, nothing to carry — so this REPORTS instead of asking.
   *
   * WHY THERE IS NO CODE SCREEN ON THIS PATH
   * ---------------------------------------
   * `renderAuthorize()` above is REMOTE's, and it stays REMOTE's. Everything it
   * does — a code, an address, a Copy button for each, a poll while the operator
   * transcribes them — is addressed to a browser on a DIFFERENT machine. LOCAL is
   * the browser runtime on the SAME server as the backend, so there is no second
   * machine and nothing to carry:
   *
   *     «LOCAL باید کاملاً internal/automatic باشد … بدون Base URL، بدون
   *      API Key، بدون Authorization Code»
   *
   * The server grants itself access inside `/inspector/targeting/begin` (see the
   * `plan.serverMayGrant` branch in src/Routes/mode.routes.ts), so by the time
   * this screen appears there is no address to show and no credential to hand
   * over. What replaces the form is a REPORT of work already done.
   *
   * ONE THING IS STILL PENDING, AND IT IS NOT A CREDENTIAL
   * ----------------------------------------------------
   * The original wording — "nothing left to ask and nothing left to wait for" —
   * was too strong, and dropping the last part is the correction. There IS a
   * prompt, raised inside the server's own browser, and it exists for a reason
   * that has nothing to do with trust: ONE server browser is shared by every
   * field and outlives any single pick, so it has to be told which field this
   * one belongs to. Confirmed as intended for both cases:
   *
   *     «اگر بالا باشه که الرت میده، اگر بالا نباشه یکی بالا میاره و بعدش الرت میده»
   *
   * That prompt is answered in that browser, not here — which is why this screen
   * still closes on its own. This particular screen is reached when the field is
   * ALREADY bound and even the prompt is behind us.
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
    // returns is blocked. The branch that will need a tab therefore CLAIMS one
    // here, synchronously, and hands it to openRealBrowser() later — that
    // function already accepts an existing tab as its second argument for
    // exactly this. If the plan turns out not to need it, it is closed below.
    //
    // THE CONDITION IS INVERTED FROM WHAT IT WAS, and this is the visible half
    // of the bug. The tab used to be claimed for `remote`, which is the browser
    // this server cannot open — so pressing LOCAL opened nothing while pressing
    // REMOTE opened the server's own window. Exactly the reported symptom:
    // «وقتی لوکال می‌زنم باید مرورگر لوکال سرور بالا بیاد ولی برعکسه». The only
    // browser this page can put on screen belongs to the server, and that is
    // LOCAL.
    var tab = (environment === 'local') ? window.open('', '_blank') : null;

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

      // ── LOCAL: the server's own browser, opened or reused ─────────────────
      //
      // Driven by the SERVER's flag rather than by the `environment` argument, so
      // a server that declines to open anything cannot be overruled by this page.
      if (res.openServerBrowser) {
        closeDialog();
        openOrReuseServerBrowser(res, ctx, environment, tab);
        return;
      }

      if (tab) { try { tab.close(); } catch (e) {} }

      // ── REMOTE: hand over the code and the address ────────────────────────
      //
      // The `authorize` step, restored — to the environment that always needed
      // it. Its earlier deletion was correct for the browser on this server and
      // wrong for a browser on the operator's own machine, where there is no
      // channel except the operator themselves.
      if (res.step === 'authorize' && res.authorization) {
        var adlg = buildShell();
        renderAuthorize(adlg.panel, res, ctx);
        return;
      }

      // Already bound: no window to open, no code to carry. Reported rather than
      // closed silently, for the same reason the LOCAL progression is shown —
      // "it worked" and "it did nothing" must not look identical.
      var dlg = buildShell();
      renderLocalProgress(dlg.panel, res, ctx);
    });
  }

  /**
   * LOCAL, second time onwards: do NOT relaunch a browser that is already up.
   *
   * RENAMED from `openOrReuseRemote`, and moved to the other environment. The
   * behaviour was always right; it was attached to the wrong word. This function
   * calls `BrowserView.openRealBrowser()` and probes `/browser/real/health` —
   * both of which are about the Chromium THIS SERVER manages. That is the LOCAL
   * browser, local TO THE PROJECT, and while it was labelled "remote" pressing
   * LOCAL opened nothing at all.
   *
   * Reported:
   *
   *   «اگر کاربر مرورگر رو نبنده و برم نود بعدی رو باز کنه و گیج میشه که الان من
   *    مرورگرم بالا هست آیا نیازه مجدد آیکون پیکر رو بزنم تا مرورگر بالا بیاد،
   *    اگرم بیاد بهینه نیست»
   *
   *   «یعنی مرورگر مجدد بالا نمیاد و فقط الرت بالا میاد در دفعات تکراری»
   *
   * and confirmed as the intended shape of BOTH cases:
   *
   *   «اگر بالا باشه که الرت میده، اگر بالا نباشه یکی بالا میاره و بعدش الرت میده»
   *
   * — the prompt happens either way; only the launch is conditional. The server
   * has already raised a consent request for this field (res.consent), and it
   * renders inside whatever page that browser is showing — see
   * extension/content/consent.js, which polls. So when the browser is live there
   * is nothing to open: the question is already on screen, and re-launching would
   * throw away the page being worked on and cost a cold start for no gain.
   *
   * The liveness probe decides, not a local flag. A flag would go stale the
   * moment the window was closed by hand, and the flow would then tell the
   * operator to answer a prompt in a browser that is not running. On ANY doubt —
   * probe failed, no BrowserView, not responsive — this falls back to opening the
   * browser, because a needless relaunch is an annoyance while a skipped one is a
   * dead end.
   */
  function openOrReuseServerBrowser(res, ctx, environment, tab) {
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

    if (!client || typeof client.serverBrowserLive !== 'function') { launch(); return; }

    client.serverBrowserLive().then(function (live) {
      if (!live) { launch(); return; }

      // Already up. Release the tab we speculatively claimed for the popup
      // blocker — leaving it would strand a blank window on screen, which looks
      // exactly like the broken relaunch this branch exists to avoid.
      if (tab) { try { tab.close(); } catch (e) {} }

      // `reused` means the server refreshed an EXISTING question about this same
      // field rather than asking a new one — the picker was pressed twice.
      // Saying "still waiting" is honest; repeating "a new prompt is waiting"
      // would imply a second thing to answer that does not exist.
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
   *   url,                       // page the SERVER's browser should land on
   *                              // (LOCAL only — a browser on the operator's own
   *                              //  machine is already showing something, and
   *                              //  this server cannot navigate it)
   *   onArmed(target, env),      // called once the field is a live destination
   * }
   */
  function start(ctx) {
    var c = ctx || {};
    if (!c.nodeId || !c.fieldKey) return false;

    var client = ic();
    if (!client) {
      // Deliberately NOT falling back to opening the server's browser. That
      // fallback is precisely the behaviour this module was written to remove —
      // it made "target this field" and "launch the server browser" the same
      // action, with no point at which the operator could say otherwise.
      // Silently reinstating it whenever the client is missing would make the old
      // bug reappear under the exact conditions nobody tests.
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
