// =====================================================================
// browser-options.js — the ONE catalog of per-run browser options.
// ---------------------------------------------------------------------
// Consumed by three things, which must never disagree:
//   1. the "Add option" panel on the Launch Browser node (browser-options-ui.js),
//   2. the server (src/core/BrowserOptions.ts evaluates THIS file, the same way
//      core/ActionCatalog.ts evaluates actions.js, and builds its Zod whitelist
//      from these definitions),
//   3. the tests (tests/unit/browser-options.test.ts walks CATALOG, so an option
//      added here without a sample / bad value / effect test fails the build).
//
// A control that changes nothing is a bug (rule R3). Every option below maps to
// exactly one Playwright launch/context key (see buildPlan) and has a real
// Chromium test in tests/browser/browser-options.test.ts.
//
// Pure + DOM-free + CSP-safe (no eval, no inline script). LF line endings.
// =====================================================================
(function (root) {
  'use strict';

  var GROUPS = [
    { id: 'mode',     fa: 'اجرا و سرعت',      en: 'Run & speed' },
    { id: 'display',  fa: 'صفحه و دستگاه',    en: 'Screen & device' },
    { id: 'identity', fa: 'هویت مرورگر',      en: 'Browser identity' },
    { id: 'location', fa: 'مکان و زبان',      en: 'Location & language' },
    { id: 'network',  fa: 'شبکه و پروکسی',    en: 'Network & proxy' },
    { id: 'behavior', fa: 'رفتار صفحه',       en: 'Page behaviour' },
    { id: 'advanced', fa: 'پیشرفته',          en: 'Advanced' }
  ];

  // Playwright permission names that Chromium (playwright 1.56) accepts.
  var PERMISSIONS = ['geolocation', 'notifications', 'camera', 'microphone',
    'clipboard-read', 'clipboard-write', 'midi', 'midi-sysex', 'background-sync',
    'accelerometer', 'gyroscope', 'magnetometer', 'payment-handler'];

  // Chrome switches that would break the product's own wiring or its security.
  // Matched on the switch NAME (the part before `=`).
  var ARG_DENY = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address',
    'user-data-dir', 'load-extension', 'disable-extensions-except', 'proxy-server',
    'proxy-pac-url', 'proxy-bypass-list', 'window-size', 'headless', 'app', 'user-agent',
    'lang', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher',
    'browser-subprocess-path', 'crash-dumps-dir', 'disk-cache-dir', 'log-file',
    'disable-web-security', 'allow-running-insecure-content', 'no-sandbox',
    'disable-setuid-sandbox', 'single-process', 'enable-logging', 'js-flags'];

  var HEADER_DENY = ['host', 'content-length', 'transfer-encoding', 'connection',
    'upgrade', 'proxy-authorization', 'te', 'trailer', 'keep-alive'];

  // kind: boolean | int | number | string | enum | set | headers | lines
  // scope: 'launch' (needs a new browser process) | 'context' (per context)
  // sample / bad: a valid and an invalid value; tests drive off them.
  var OPTIONS = [
    // ---- Run & speed ---------------------------------------------------
    { id: 'headless', group: 'mode', kind: 'boolean', scope: 'launch',
      label: { fa: 'بدون نمایش (Headless)', en: 'Headless' },
      help: { fa: 'خاموش = پنجرهٔ مرورگر دیده می‌شود (برای تماشای زنده). روشن = پشت صحنه.',
              en: 'Off = the browser window is visible (live view). On = runs in the background.' },
      sample: false, bad: 'yes' },
    { id: 'slowMo', group: 'mode', kind: 'int', scope: 'launch', min: 0, max: 10000, unit: 'ms',
      label: { fa: 'کند کردن مراحل (slowMo)', en: 'Slow motion (slowMo)' },
      help: { fa: 'بین هر عمل مرورگر این‌قدر میلی‌ثانیه صبر می‌کند؛ برای دیدن مراحل با چشم.',
              en: 'Waits this many ms between browser actions so you can follow along.' },
      sample: 120, bad: -5 },
    { id: 'chromeArgs', group: 'mode', kind: 'lines', scope: 'launch', max: 20,
      label: { fa: 'سوییچ‌های Chrome', en: 'Chrome flags' },
      help: { fa: 'هر خط یک سوییچ مثل --mute-audio. سوییچ‌های خطرناک یا تکراری رد می‌شوند.',
              en: 'One switch per line, e.g. --mute-audio. Dangerous or duplicated switches are refused.' },
      sample: ['--mute-audio', '--hide-scrollbars'], bad: ['--remote-debugging-port=9222'] },

    // ---- Screen & device -----------------------------------------------
    { id: 'viewportWidth', group: 'display', kind: 'int', scope: 'context', min: 200, max: 7680, unit: 'px',
      label: { fa: 'عرض صفحه', en: 'Viewport width' },
      help: { fa: 'عرض ناحیهٔ صفحه به پیکسل (پیش‌فرض ۱۲۸۰).', en: 'Page area width in px (default 1280).' },
      sample: 900, bad: 50 },
    { id: 'viewportHeight', group: 'display', kind: 'int', scope: 'context', min: 200, max: 4320, unit: 'px',
      label: { fa: 'ارتفاع صفحه', en: 'Viewport height' },
      help: { fa: 'ارتفاع ناحیهٔ صفحه به پیکسل (پیش‌فرض ۷۲۰).', en: 'Page area height in px (default 720).' },
      sample: 640, bad: 99999 },
    { id: 'deviceScaleFactor', group: 'display', kind: 'number', scope: 'context', min: 0.5, max: 4,
      label: { fa: 'تراکم پیکسل (DPR)', en: 'Device pixel ratio' },
      help: { fa: 'مثلاً ۲ برای صفحهٔ Retina؛ روی اندازهٔ اسکرین‌شات اثر دارد.',
              en: 'E.g. 2 for a Retina screen; changes screenshot resolution.' },
      sample: 2, bad: 0 },
    { id: 'isMobile', group: 'display', kind: 'boolean', scope: 'context',
      label: { fa: 'حالت موبایل', en: 'Mobile mode' },
      help: { fa: 'متا‌ی viewport و رفتار موبایل را فعال می‌کند.', en: 'Enables the mobile viewport meta and behaviour.' },
      sample: true, bad: 'yes' },
    { id: 'hasTouch', group: 'display', kind: 'boolean', scope: 'context',
      label: { fa: 'صفحهٔ لمسی', en: 'Touch screen' },
      help: { fa: 'رویدادهای لمسی را در دسترس صفحه می‌گذارد.', en: 'Exposes touch events to the page.' },
      sample: true, bad: 'yes' },

    // ---- Browser identity ----------------------------------------------
    { id: 'userAgent', group: 'identity', kind: 'string', scope: 'context', max: 512,
      label: { fa: 'User-Agent', en: 'User-Agent' },
      help: { fa: 'رشتهٔ هویت مرورگر که سایت می‌بیند.', en: 'The browser identity string sites see.' },
      sample: 'PlyrTest/1.0 (custom)', bad: 'a\nb' },
    { id: 'colorScheme', group: 'identity', kind: 'enum', scope: 'context',
      values: ['light', 'dark', 'no-preference'],
      label: { fa: 'تم رنگی', en: 'Colour scheme' },
      help: { fa: 'مقدار prefers-color-scheme برای صفحه.', en: 'The page\'s prefers-color-scheme value.' },
      sample: 'dark', bad: 'blue' },
    { id: 'reducedMotion', group: 'identity', kind: 'enum', scope: 'context',
      values: ['reduce', 'no-preference'],
      label: { fa: 'کاهش انیمیشن', en: 'Reduced motion' },
      help: { fa: 'مقدار prefers-reduced-motion برای صفحه.', en: 'The page\'s prefers-reduced-motion value.' },
      sample: 'reduce', bad: 'maybe' },

    // ---- Location & language -------------------------------------------
    { id: 'locale', group: 'location', kind: 'string', scope: 'context', max: 35,
      pattern: '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$',
      label: { fa: 'زبان (Locale)', en: 'Locale' },
      help: { fa: 'مثل fa-IR یا en-US؛ روی navigator.language و قالب تاریخ اثر دارد.',
              en: 'E.g. fa-IR or en-US; affects navigator.language and date formats.' },
      sample: 'fa-IR', bad: 'not a locale' },
    { id: 'timezoneId', group: 'location', kind: 'string', scope: 'context', max: 64, check: 'timezone',
      label: { fa: 'منطقهٔ زمانی', en: 'Timezone' },
      help: { fa: 'مثل Asia/Tehran؛ ساعت صفحه را عوض می‌کند.', en: 'E.g. Asia/Tehran; changes the page clock.' },
      sample: 'Asia/Tehran', bad: 'Mars/Olympus' },
    { id: 'geolocationLat', group: 'location', kind: 'number', scope: 'context', min: -90, max: 90,
      label: { fa: 'عرض جغرافیایی', en: 'Geolocation latitude' },
      help: { fa: 'همراه با طول جغرافیایی؛ مجوز geolocation خودکار داده می‌شود.',
              en: 'Use with longitude; the geolocation permission is granted automatically.' },
      sample: 35.6892, bad: 120 },
    { id: 'geolocationLon', group: 'location', kind: 'number', scope: 'context', min: -180, max: 180,
      label: { fa: 'طول جغرافیایی', en: 'Geolocation longitude' },
      help: { fa: 'همراه با عرض جغرافیایی.', en: 'Use with latitude.' },
      sample: 51.389, bad: 999 },
    { id: 'geolocationAccuracy', group: 'location', kind: 'number', scope: 'context', min: 0, max: 10000, unit: 'm',
      label: { fa: 'دقت مکان', en: 'Geolocation accuracy' },
      help: { fa: 'دقت مکان به متر (اختیاری).', en: 'Accuracy in metres (optional).' },
      sample: 25, bad: -1 },
    { id: 'permissions', group: 'location', kind: 'set', scope: 'context', values: PERMISSIONS, max: 13,
      label: { fa: 'مجوزهای صفحه', en: 'Page permissions' },
      help: { fa: 'مجوزهایی که بدون پرسش به صفحه داده می‌شود.', en: 'Permissions granted to pages without prompting.' },
      sample: ['notifications', 'clipboard-read'], bad: ['teleport'] },

    // ---- Network & proxy -----------------------------------------------
    { id: 'proxyServer', group: 'network', kind: 'string', scope: 'launch', max: 256,
      pattern: '^(https?|socks5)://[^\\s/:@]+(:\\d{1,5})?$',
      label: { fa: 'پروکسی', en: 'Proxy server' },
      help: { fa: 'مثل http://host:8080 یا socks5://host:1080.', en: 'E.g. http://host:8080 or socks5://host:1080.' },
      sample: 'http://127.0.0.1:8080', bad: 'host:8080' },
    { id: 'proxyUsername', group: 'network', kind: 'string', scope: 'launch', max: 256, secret: false,
      label: { fa: 'نام کاربری پروکسی', en: 'Proxy username' },
      help: { fa: 'فقط همراه با پروکسی معنی دارد.', en: 'Only meaningful with a proxy server.' },
      sample: 'proxy-user', bad: '' },
    { id: 'proxyPassword', group: 'network', kind: 'string', scope: 'launch', max: 256, secret: true,
      label: { fa: 'گذرواژهٔ پروکسی', en: 'Proxy password' },
      help: { fa: 'همراه با نام کاربری پروکسی. در workflow ذخیره می‌شود؛ جای گذرواژهٔ مهم نیست.',
              en: 'With the proxy username. Stored in the workflow; do not reuse an important password.' },
      sample: 's3cret', bad: '' },
    { id: 'proxyBypass', group: 'network', kind: 'string', scope: 'launch', max: 512,
      pattern: '^[A-Za-z0-9.*,_\\- ]+$',
      label: { fa: 'استثنای پروکسی', en: 'Proxy bypass' },
      help: { fa: 'میزبان‌هایی که مستقیم وصل می‌شوند، با کاما جدا: .example.com,intranet',
              en: 'Hosts that connect directly, comma separated: .example.com,intranet' },
      sample: 'bypass.test', bad: 'bad;host' },
    { id: 'extraHTTPHeaders', group: 'network', kind: 'headers', scope: 'context', max: 30,
      label: { fa: 'هدرهای HTTP اضافه', en: 'Extra HTTP headers' },
      help: { fa: 'JSON به شکل {"X-Name":"value"}؛ روی همهٔ درخواست‌ها اضافه می‌شود.',
              en: 'JSON like {"X-Name":"value"}; added to every request.' },
      sample: { 'X-Plyr-Test': 'yes' }, bad: { 'Host': 'evil.test' } },
    { id: 'httpUsername', group: 'network', kind: 'string', scope: 'context', max: 256,
      label: { fa: 'نام کاربری HTTP Basic', en: 'HTTP auth username' },
      help: { fa: 'برای سایت‌هایی که با پنجرهٔ ورود Basic Auth محافظت شده‌اند.', en: 'For sites behind a Basic-Auth prompt.' },
      sample: 'basic-user', bad: '' },
    { id: 'httpPassword', group: 'network', kind: 'string', scope: 'context', max: 256, secret: true,
      label: { fa: 'گذرواژهٔ HTTP Basic', en: 'HTTP auth password' },
      help: { fa: 'همراه با نام کاربری HTTP.', en: 'With the HTTP username.' },
      sample: 'basic-pass', bad: '' },

    // ---- Page behaviour ------------------------------------------------
    { id: 'javaScriptEnabled', group: 'behavior', kind: 'boolean', scope: 'context',
      label: { fa: 'جاوااسکریپت صفحه', en: 'Page JavaScript' },
      help: { fa: 'خاموش = اسکریپت‌های صفحه اجرا نمی‌شوند.', en: 'Off = the page\'s scripts do not run.' },
      sample: false, bad: 'no' },
    { id: 'ignoreHTTPSErrors', group: 'behavior', kind: 'boolean', scope: 'context',
      label: { fa: 'نادیده گرفتن خطای HTTPS', en: 'Ignore HTTPS errors' },
      help: { fa: 'گواهی نامعتبر یا خودامضا مانع باز شدن سایت نمی‌شود.', en: 'Invalid or self-signed certificates do not block the page.' },
      sample: true, bad: 'yes' },
    { id: 'offline', group: 'behavior', kind: 'boolean', scope: 'context',
      label: { fa: 'حالت آفلاین', en: 'Offline mode' },
      help: { fa: 'همهٔ درخواست‌های شبکه شکست می‌خورند.', en: 'All network requests fail.' },
      sample: true, bad: 'yes' },
    { id: 'bypassCSP', group: 'behavior', kind: 'boolean', scope: 'context',
      label: { fa: 'دور زدن CSP', en: 'Bypass CSP' },
      help: { fa: 'سیاست امنیتی محتوای سایت را نادیده می‌گیرد (برای تزریق اسکریپت).',
              en: 'Ignores the site\'s Content-Security-Policy (for script injection).' },
      sample: true, bad: 'yes' }
  ];

  var BY_ID = {};
  OPTIONS.forEach(function (o) { BY_ID[o.id] = o; });

  function def(id) { return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null; }
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function hasCtl(s) { return /[\u0000-\u001f\u007f]/.test(s); }

  function validTimezone(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  // Returns null when `value` is acceptable for option `d`, else a short code.
  function check(d, value) {
    if (typeof d === 'string') d = def(d);
    if (!d) return 'unknown';
    var i;
    switch (d.kind) {
      case 'boolean':
        return typeof value === 'boolean' ? null : 'type';
      case 'int':
        if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) return 'type';
        return (value < d.min || value > d.max) ? 'range' : null;
      case 'number':
        if (typeof value !== 'number' || !isFinite(value)) return 'type';
        return (value < d.min || value > d.max) ? 'range' : null;
      case 'string':
        if (typeof value !== 'string') return 'type';
        if (value.length < 1 || value.length > d.max) return 'length';
        if (hasCtl(value)) return 'format';
        if (d.pattern && !new RegExp(d.pattern).test(value)) return 'format';
        if (d.check === 'timezone' && !validTimezone(value)) return 'format';
        return null;
      case 'enum':
        return d.values.indexOf(value) !== -1 ? null : 'enum';
      case 'set':
        if (!Array.isArray(value) || value.length < 1 || value.length > d.max) return 'type';
        for (i = 0; i < value.length; i++) {
          if (d.values.indexOf(value[i]) === -1) return 'enum';
          if (value.indexOf(value[i]) !== i) return 'duplicate';
        }
        return null;
      case 'headers': {
        if (!isPlainObject(value)) return 'type';
        var names = Object.keys(value);
        if (names.length < 1 || names.length > d.max) return 'length';
        for (i = 0; i < names.length; i++) {
          var n = names[i], v = value[n];
          if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(n)) return 'format';
          if (HEADER_DENY.indexOf(n.toLowerCase()) !== -1) return 'denied';
          if (typeof v !== 'string' || v.length > 1024 || hasCtl(v)) return 'format';
        }
        return null;
      }
      case 'lines':
        if (!Array.isArray(value) || value.length < 1 || value.length > d.max) return 'type';
        for (i = 0; i < value.length; i++) {
          var a = value[i];
          if (typeof a !== 'string' || !/^--[a-z0-9][a-z0-9-]*(=[^\s\u0000]{0,512})?$/.test(a)) return 'format';
          if (ARG_DENY.indexOf(a.slice(2).split('=')[0]) !== -1) return 'denied';
          if (value.indexOf(a) !== i) return 'duplicate';
        }
        return null;
      default:
        return 'unknown';
    }
  }

  // Unknown ids and invalid values are reported, never dropped silently.
  function validate(options) {
    var errors = [], clean = {};
    if (options === undefined || options === null) return { ok: true, options: clean, errors: errors };
    if (!isPlainObject(options)) return { ok: false, options: clean, errors: [{ id: '', code: 'type' }] };
    Object.keys(options).forEach(function (id) {
      var d = def(id);
      if (!d) { errors.push({ id: id, code: 'unknown' }); return; }
      var code = check(d, options[id]);
      if (code) errors.push({ id: id, code: code }); else clean[id] = options[id];
    });
    return { ok: errors.length === 0, options: clean, errors: errors };
  }

  // ---- incompatibility / sanity diagnostics ------------------------------
  // ctx: { actions: ['open-extension', ...] } — the action ids used by the workflow.
  function diagnose(options, ctx) {
    options = options || {};
    var out = [];
    function has(id) { return options[id] !== undefined; }
    function add(level, ids, code, fa, en) { out.push({ level: level, ids: ids, code: code, fa: fa, en: en }); }
    var actions = (ctx && ctx.actions) || [];

    ['proxyUsername', 'proxyPassword', 'proxyBypass'].forEach(function (id) {
      if (has(id) && !has('proxyServer')) {
        add('warn', [id, 'proxyServer'], 'needs-proxy', 'بدون «پروکسی» این گزینه نادیده گرفته می‌شود.',
          'Without a proxy server this option is ignored.');
      }
    });
    if (has('proxyPassword') && !has('proxyUsername')) {
      add('warn', ['proxyPassword', 'proxyUsername'], 'proxy-pass-no-user', 'گذرواژهٔ پروکسی بدون نام کاربری نادیده گرفته می‌شود.',
        'A proxy password without a username is ignored.');
    }
    if (has('httpUsername') !== has('httpPassword')) {
      add('warn', ['httpUsername', 'httpPassword'], 'http-auth-pair', 'نام کاربری و گذرواژهٔ HTTP باید با هم تنظیم شوند؛ وگرنه نادیده گرفته می‌شوند.',
        'HTTP username and password must be set together; otherwise they are ignored.');
    }
    if (has('geolocationLat') !== has('geolocationLon')) {
      add('warn', ['geolocationLat', 'geolocationLon'], 'geo-pair', 'عرض و طول جغرافیایی باید با هم تنظیم شوند؛ وگرنه نادیده گرفته می‌شوند.',
        'Latitude and longitude must be set together; otherwise they are ignored.');
    }
    if (has('geolocationAccuracy') && !(has('geolocationLat') && has('geolocationLon'))) {
      add('warn', ['geolocationAccuracy'], 'geo-accuracy', 'دقت مکان بدون عرض و طول جغرافیایی اثری ندارد.',
        'Accuracy has no effect without latitude and longitude.');
    }
    if (has('geolocationLat') && has('geolocationLon') &&
        !(Array.isArray(options.permissions) && options.permissions.indexOf('geolocation') !== -1)) {
      add('info', ['geolocationLat', 'permissions'], 'geo-permission', 'مجوز geolocation خودکار به صفحه داده می‌شود.',
        'The geolocation permission is granted to the page automatically.');
    }
    if (options.offline === true && has('proxyServer')) {
      add('warn', ['offline', 'proxyServer'], 'offline-proxy', 'حالت آفلاین همهٔ درخواست‌ها را قطع می‌کند؛ پروکسی بی‌اثر می‌شود.',
        'Offline mode blocks every request; the proxy has no effect.');
    }
    if (options.javaScriptEnabled === false) {
      add('warn', ['javaScriptEnabled'], 'js-off', 'با خاموش بودن جاوااسکریپت، نودهایی که روی صفحه اسکریپت اجرا می‌کنند (Code با مرورگر، شرط کد، انتخابگر) کار نمی‌کنند.',
        'With JavaScript off, nodes that run scripts on the page (Code with browser, code conditions, the picker) will not work.');
    }
    if (options.headless === true && actions.indexOf('open-extension') !== -1) {
      add('warn', ['headless'], 'headless-ext', 'Chrome در حالت headless افزونه بارگذاری نمی‌کند؛ این workflow نود افزونه دارد.',
        'Headless Chrome loads no extensions; this workflow has an extension node.');
    }
    if (has('slowMo') && options.slowMo > 0 && options.headless === true) {
      add('info', ['slowMo', 'headless'], 'slowmo-headless', 'کند کردن مراحل در حالت headless فقط زمان اجرا را بیشتر می‌کند.',
        'Slow motion in headless mode only makes the run longer.');
    }
    var hdr = isPlainObject(options.extraHTTPHeaders) ? Object.keys(options.extraHTTPHeaders).map(function (k) { return k.toLowerCase(); }) : [];
    if (has('userAgent') && hdr.indexOf('user-agent') !== -1) {
      add('warn', ['userAgent', 'extraHTTPHeaders'], 'ua-header', 'User-Agent هم در گزینه و هم در هدرها تنظیم شده؛ فقط یکی را نگه دارید.',
        'User-Agent is set both as an option and as a header; keep only one.');
    }
    if (has('locale') && hdr.indexOf('accept-language') !== -1) {
      add('warn', ['locale', 'extraHTTPHeaders'], 'lang-header', 'زبان هم در گزینه و هم در هدر Accept-Language تنظیم شده؛ ممکن است با هم تداخل کنند.',
        'Locale is set both as an option and as an Accept-Language header; they may conflict.');
    }
    if (options.isMobile === true && options.hasTouch !== true) {
      add('info', ['isMobile', 'hasTouch'], 'mobile-touch', 'دستگاه موبایل معمولاً صفحهٔ لمسی دارد؛ «صفحهٔ لمسی» را هم روشن کنید.',
        'Mobile devices normally have a touch screen; consider turning Touch screen on too.');
    }
    if (has('viewportWidth') !== has('viewportHeight')) {
      add('info', ['viewportWidth', 'viewportHeight'], 'viewport-half', 'بعد دیگر از پیش‌فرض (۱۲۸۰×۷۲۰) گرفته می‌شود.',
        'The other dimension uses the default (1280x720).');
    }
    if (options.bypassCSP === true) {
      add('info', ['bypassCSP'], 'csp', 'سیاست امنیتی محتوای سایت‌ها نادیده گرفته می‌شود.', 'Sites\' Content-Security-Policy is ignored.');
    }
    if (options.ignoreHTTPSErrors === true) {
      add('info', ['ignoreHTTPSErrors'], 'https', 'گواهی‌های نامعتبر پذیرفته می‌شوند؛ فقط برای سایت‌های مورد اعتماد.',
        'Invalid certificates are accepted; use only for sites you trust.');
    }
    if (Array.isArray(options.permissions) &&
        (options.permissions.indexOf('camera') !== -1 || options.permissions.indexOf('microphone') !== -1)) {
      add('info', ['permissions'], 'media', 'مجوز دوربین/میکروفون داده می‌شود ولی دستگاه واقعی در سرور نیست.',
        'Camera/microphone permission is granted, but a server has no real device.');
    }
    return out;
  }

  // ---- plan: options -> Playwright keys ----------------------------------
  // tier: 'vip'      persistent context = launch + context options both apply
  //       'free'     shared browser: only context-scope options can apply
  //       'attached' the user's own / Real Chrome is driven as-is: nothing applies
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStringify(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  function buildPlan(options, opts) {
    options = options || {};
    var tier = (opts && opts.tier) || 'vip';
    var plan = { launch: {}, context: {}, ignored: [], hash: '' };
    var applicable = {};

    Object.keys(options).forEach(function (id) {
      var d = def(id);
      if (!d) return;
      if (tier === 'attached') {
        plan.ignored.push({ id: id, reason: 'attached' });
      } else if (tier === 'free' && d.scope === 'launch') {
        plan.ignored.push({ id: id, reason: 'shared-browser' });
      } else {
        applicable[id] = options[id];
      }
    });
    var o = applicable;
    function has(id) { return o[id] !== undefined; }

    if (has('headless')) plan.launch.headless = o.headless;
    if (has('slowMo') && o.slowMo > 0) plan.launch.slowMo = o.slowMo;
    if (has('chromeArgs')) plan.launch.args = o.chromeArgs.slice();
    if (has('proxyServer')) {
      var p = { server: o.proxyServer };
      if (has('proxyUsername') && has('proxyPassword')) { p.username = o.proxyUsername; p.password = o.proxyPassword; }
      else if (has('proxyUsername')) { p.username = o.proxyUsername; }
      if (has('proxyBypass')) p.bypass = o.proxyBypass;
      plan.launch.proxy = p;
    }
    ['proxyUsername', 'proxyPassword', 'proxyBypass'].forEach(function (id) {
      if (has(id) && !has('proxyServer')) plan.ignored.push({ id: id, reason: 'needs-proxy' });
    });
    if (has('proxyPassword') && !has('proxyUsername') && has('proxyServer')) {
      plan.ignored.push({ id: 'proxyPassword', reason: 'needs-username' });
    }

    if (has('viewportWidth') || has('viewportHeight')) {
      plan.context.viewport = { width: has('viewportWidth') ? o.viewportWidth : 1280,
                                height: has('viewportHeight') ? o.viewportHeight : 720 };
    }
    ['deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent', 'colorScheme', 'reducedMotion', 'locale',
     'timezoneId', 'extraHTTPHeaders', 'javaScriptEnabled', 'ignoreHTTPSErrors', 'offline', 'bypassCSP']
      .forEach(function (id) { if (has(id)) plan.context[id] = o[id]; });

    if (has('geolocationLat') && has('geolocationLon')) {
      plan.context.geolocation = { latitude: o.geolocationLat, longitude: o.geolocationLon };
      if (has('geolocationAccuracy')) plan.context.geolocation.accuracy = o.geolocationAccuracy;
    } else {
      ['geolocationLat', 'geolocationLon', 'geolocationAccuracy'].forEach(function (id) {
        if (has(id)) plan.ignored.push({ id: id, reason: 'geo-incomplete' });
      });
    }
    var perms = has('permissions') ? o.permissions.slice() : [];
    if (plan.context.geolocation && perms.indexOf('geolocation') === -1) perms.push('geolocation');
    if (perms.length) plan.context.permissions = perms;

    if (has('httpUsername') && has('httpPassword')) {
      plan.context.httpCredentials = { username: o.httpUsername, password: o.httpPassword };
    } else {
      ['httpUsername', 'httpPassword'].forEach(function (id) {
        if (has(id)) plan.ignored.push({ id: id, reason: 'http-incomplete' });
      });
    }

    plan.hash = (Object.keys(plan.launch).length || Object.keys(plan.context).length)
      ? stableStringify({ launch: plan.launch, context: plan.context }) : '';
    return plan;
  }

  // `headless` the run will really use: the Launch node's own option wins over
  // the run-level switch, so the UI and the server decide with the same rule.
  function effectiveHeadless(options, runHeadless) {
    if (options && typeof options.headless === 'boolean') return options.headless;
    return runHeadless !== false;
  }

  var api = {
    GROUPS: GROUPS, OPTIONS: OPTIONS, PERMISSIONS: PERMISSIONS,
    ARG_DENY: ARG_DENY, HEADER_DENY: HEADER_DENY,
    def: def, check: check, validate: validate, diagnose: diagnose,
    buildPlan: buildPlan, effectiveHeadless: effectiveHeadless, stableStringify: stableStringify
  };
  root.BROWSER_OPTIONS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
