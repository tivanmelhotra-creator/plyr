  /**
   * The Launch settings panel (collapsed by default): Preset, categorized
   * options, Custom Flags, and a live check against the server's validator
   * (POST /profiles/launch-settings/validate) showing the final arguments,
   * errors (app-controlled / conflicting / malformed) and warnings (risky,
   * need a tick). value() returns null while nothing was changed, so the
   * default Open keeps the browser exactly as it always started.
   */
  function mountLaunchSettings(parent, opts) {
    var oo = opts || {};
    var cat = null;
    var touched = false;
    var state = { preset: 'standard', options: {}, customFlags: '', acknowledgeRisk: false };
    var det = document.createElement('details');
    det.className = 'pm-launch';
    var sum = document.createElement('summary');
    sum.className = 'pm-launch-sum';
    sum.textContent = t('pm.launchSettings', 'Launch settings');
    det.appendChild(sum);
    var body = document.createElement('div');
    body.className = 'pm-launch-body';
    det.appendChild(body);
    parent.appendChild(det);

    var presetRow = document.createElement('label');
    presetRow.className = 'pm-launch-row';
    var presetLbl = document.createElement('span');
    presetLbl.textContent = t('pm.preset', 'Preset');
    presetRow.appendChild(presetLbl);
    var presetSel = document.createElement('select');
    presetSel.className = 'pm-launch-preset';
    presetRow.appendChild(presetSel);
    body.appendChild(presetRow);
    var presetDesc = document.createElement('p');
    presetDesc.className = 'pm-launch-desc';
    body.appendChild(presetDesc);

    var optsBox = document.createElement('div');
    optsBox.className = 'pm-launch-options';
    body.appendChild(optsBox);

    var customLbl = document.createElement('label');
    customLbl.className = 'pm-launch-row pm-launch-custom';
    var customT = document.createElement('span');
    customT.textContent = t('pm.customFlags', 'Custom Flags');
    customLbl.appendChild(customT);
    var custom = document.createElement('textarea');
    custom.className = 'pm-launch-flags';
    custom.rows = 3;
    custom.spellcheck = false;
    custom.placeholder = '--lang=fa\n--window-size=1280,800';
    custom.setAttribute('aria-label', t('pm.customFlags', 'Custom Flags'));
    customLbl.appendChild(custom);
    body.appendChild(customLbl);
    var customHint = document.createElement('small');
    customHint.className = 'pm-launch-hint';
    customHint.textContent = t('pm.customFlagsHint', 'One flag per line, as --name or --name=value. Quotes only group a value with spaces. Flags the application controls (data directory, debugging, headless, extensions) are refused.');
    body.appendChild(customHint);

    var ackLbl = document.createElement('label');
    ackLbl.className = 'pm-launch-ack';
    ackLbl.hidden = true;
    var ack = document.createElement('input');
    ack.type = 'checkbox';
    ack.className = 'pm-launch-ack-box';
    ackLbl.appendChild(ack);
    var ackT = document.createElement('span');
    ackT.textContent = t('pm.ackRisk', 'I understand the risks of the flags marked with a warning.');
    ackLbl.appendChild(ackT);
    body.appendChild(ackLbl);

    var result = document.createElement('div');
    result.className = 'pm-launch-result';
    result.setAttribute('aria-live', 'polite');
    body.appendChild(result);

    function paintOptions() {
      optsBox.innerHTML = '';
      if (!cat) return;
      var preset = null;
      for (var i = 0; i < cat.presets.length; i++) if (cat.presets[i].id === state.preset) preset = cat.presets[i];
      presetDesc.textContent = preset ? preset.description : '';
      var on = {};
      (preset ? preset.options : []).forEach(function (id) { on[id] = true; });
      Object.keys(state.options).forEach(function (id) { on[id] = state.options[id]; });
      cat.categories.forEach(function (c) {
        var group = cat.options.filter(function (x) { return x.category === c.id; });
        if (!group.length) return;
        var fs = document.createElement('fieldset');
        fs.className = 'pm-launch-group';
        var lg = document.createElement('legend');
        lg.textContent = c.label;
        fs.appendChild(lg);
        group.forEach(function (op) {
          var l = document.createElement('label');
          l.className = 'pm-launch-opt';
          l.title = op.description + ' (' + op.arg + ')';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!on[op.id];
          cb.setAttribute('data-option', op.id);
          cb.addEventListener('change', function () {
            touched = true;
            state.options[op.id] = cb.checked;
            check();
          });
          l.appendChild(cb);
          var sp = document.createElement('span');
          sp.textContent = op.label;
          l.appendChild(sp);
          var code = document.createElement('code');
          code.textContent = op.arg;
          l.appendChild(code);
          fs.appendChild(l);
        });
        optsBox.appendChild(fs);
      });
    }

    function showResult(r) {
      result.innerHTML = '';
      if (!r) return;
      var argsP = document.createElement('p');
      argsP.className = 'pm-launch-args';
      var b = document.createElement('b');
      b.textContent = t('pm.launchArgs', 'Chromium will start with') + ': ';
      argsP.appendChild(b);
      var c = document.createElement('code');
      c.textContent = (r.args || []).join(' ');
      argsP.appendChild(c);
      result.appendChild(argsP);
      (r.errors || []).forEach(function (e) {
        var p = document.createElement('p');
        p.className = 'pm-launch-err';
        p.setAttribute('role', 'alert');
        p.textContent = '\u2716 ' + (e.flag ? e.flag + ' \u2014 ' : '') + e.message;
        result.appendChild(p);
      });
      (r.warnings || []).forEach(function (w) {
        var p = document.createElement('p');
        p.className = 'pm-launch-warn';
        p.textContent = '\u26a0 ' + (w.flag ? w.flag + ' \u2014 ' : '') + w.message;
        result.appendChild(p);
      });
      ackLbl.hidden = !(r.warnings && r.warnings.length);
    }

    var timer = 0;
    var seq = 0;
    function check() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var my = ++seq;
        api.validateLaunch(current()).then(function (d) { if (my === seq) showResult(d.launch); }).catch(function () { /* shown on Open */ });
      }, 250);
    }

    function current() {
      return { preset: state.preset, options: state.options, customFlags: custom.value, acknowledgeRisk: !!ack.checked };
    }

    presetSel.addEventListener('change', function () {
      touched = true;
      state.preset = presetSel.value;
      state.options = {};
      paintOptions();
      check();
    });
    custom.addEventListener('input', function () { touched = true; check(); });
    ack.addEventListener('change', function () { touched = true; check(); });
    det.addEventListener('toggle', function () { if (det.open && cat) check(); });

    api.launchOptions().then(function (d) {
      cat = d;
      presetSel.innerHTML = '';
      d.presets.forEach(function (p) {
        var op = document.createElement('option');
        op.value = p.id;
        op.textContent = p.label;
        if (p.id === d.defaultPreset) op.selected = true;
        presetSel.appendChild(op);
      });
      state.preset = d.defaultPreset;
      paintOptions();
    }).catch(function () {
      if (oo.onSay) oo.onSay(t('pm.launchLoadFailed', 'Launch settings could not be loaded; the standard settings are used.'), true);
    });

    return {
      el: det,
      /** null = unchanged (Standard, an open browser is reused as it is). */
      value: function () { return touched ? current() : null; },
      showResult: function (r) { det.open = true; showResult(r); },
      set: function (v) {
        touched = true;
        state.preset = (v && v.preset) || state.preset;
        state.options = (v && v.options) || {};
        custom.value = (v && v.customFlags) || '';
        ack.checked = !!(v && v.acknowledgeRisk);
        if (cat) { presetSel.value = state.preset; paintOptions(); }
      }
    };
  }

