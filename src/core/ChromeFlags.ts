/**
 * The Chrome flag catalogue — a menu, not a scavenger hunt.
 *
 * THE OPERATOR'S COMPLAINT (verbatim):
 *
 *   «یا تگ‌هایی که موقع بالا اومدن مرورگر هست، به جای اینکه من بخوام دونه دونه
 *    سرچ کنم تگ‌ها رو پیدا کنم، ما باید یه لیست از تگ‌هایی داشته باشیم که موقعی
 *    که مرورگر رو می‌خوام بالا بیارم با فرم‌های چک‌باکس مشخص کنم از بین اون همه
 *    تگ با کدوم‌ها می‌خوام با تیک زدن بالا بیاره. و باید در کنارش حواسمون به
 *    کاربران تازه‌کار هم باشه که در کنار چک‌باکس‌ها گزینه‌های استاندارد هم باشه.»
 *
 * Before this, the launch flags were a hard-coded array inside `RealChrome.launch()`
 * plus `ANTI_AUTOMATION_ARGS` in `BrowserProfile.ts`. Changing one meant reading
 * the source, searching the web for what the switch does, editing TypeScript and
 * restarting. Every flag below was already being passed — none of this is new
 * behaviour. What is new is that they now have NAMES, GROUPS, DESCRIPTIONS and
 * consequences the UI can render.
 *
 * ── WHY EACH FLAG CARRIES A `risk` AND A `why` ─────────────────────────────
 *
 * A checkbox list of 30 raw Chrome switches would replace one confusion with a
 * worse one: a beginner ticking `--no-sandbox` because it sounds harmless has
 * disabled the single most important security boundary in the browser. So every
 * entry states what it does, in what situation it is right, and what it costs.
 * The presets exist so that a beginner never has to make the choice at all —
 * which is what the operator asked for, twice.
 *
 * ── THE NON-NEGOTIABLE PART ────────────────────────────────────────────────
 *
 * Some flags are `required: true`. Those are not offered as choices because
 * unticking them does not produce a differently-configured browser, it produces
 * a browser that does not start (or starts and immediately breaks the product's
 * own features). Offering a checkbox that bricks the app is not freedom, it is
 * a trap. `--load-extension` handling stays out of this catalogue entirely: it
 * is computed from what is actually installed on disk.
 */

export type FlagGroupId =
  | 'container'
  | 'stealth'
  | 'session'
  | 'performance'
  | 'privacy'
  | 'debug';

export interface FlagGroup {
  id: FlagGroupId;
  label: string;
  labelFa: string;
  description: string;
  descriptionFa: string;
}

export const FLAG_GROUPS: readonly FlagGroup[] = [
  {
    id: 'container',
    label: 'Container & sandbox',
    labelFa: 'کانتینر و سندباکس',
    description: 'Needed to run inside Docker/CI at all. Wrong here means Chrome will not start.',
    descriptionFa: 'برای اجرا داخل داکر/CI لازم است. اشتباه در اینجا یعنی کروم بالا نمی‌آید.',
  },
  {
    id: 'stealth',
    label: 'Look like a real user',
    labelFa: 'شبیه کاربر واقعی',
    description: 'Hides the signs that a robot is driving. Turn off only when debugging.',
    descriptionFa: 'نشانه‌های رباتی‌بودن را پنهان می‌کند. فقط هنگام عیب‌یابی خاموش کنید.',
  },
  {
    id: 'session',
    label: 'Tabs & session',
    labelFa: 'تب‌ها و نشست',
    description: 'What happens to your open tabs when the browser restarts.',
    descriptionFa: 'سرنوشت تب‌های باز شما هنگام ری‌استارت مرورگر.',
  },
  {
    id: 'performance',
    label: 'Speed & memory',
    labelFa: 'سرعت و حافظه',
    description: 'Trades features for resources. Useful on a small box, costly in fidelity.',
    descriptionFa: 'قابلیت‌ها را با منابع معاوضه می‌کند. روی سرور کوچک مفید، به قیمت دقت.',
  },
  {
    id: 'privacy',
    label: 'Privacy & background traffic',
    labelFa: 'حریم خصوصی و ترافیک پس‌زمینه',
    description: 'Stops Chrome phoning home and syncing while you work.',
    descriptionFa: 'جلوی ارتباط کروم با سرورهای گوگل و همگام‌سازی را می‌گیرد.',
  },
  {
    id: 'debug',
    label: 'Debugging',
    labelFa: 'عیب‌یابی',
    description: 'Opens doors for inspection. Every door here is also a door for an attacker.',
    descriptionFa: 'درهایی برای بازرسی باز می‌کند. هر درِ اینجا برای مهاجم هم در است.',
  },
];

export type FlagRisk = 'safe' | 'caution' | 'dangerous';

export interface FlagDef {
  /** Stable id used by the API and the checkboxes. Never the raw flag. */
  id: string;
  /** What is actually handed to Chrome. */
  flag: string;
  group: FlagGroupId;
  label: string;
  labelFa: string;
  /** What it does, in one sentence a non-expert can act on. */
  why: string;
  whyFa: string;
  risk: FlagRisk;
  /**
   * Cannot be turned off through the UI: unticking it breaks startup or a
   * product feature rather than reconfiguring anything.
   */
  required?: boolean;
  /**
   * Not a boolean switch — the value comes from configuration (window size,
   * debug port). Listed so the UI can SHOW it, never as a checkbox.
   */
  computed?: boolean;
}

/**
 * The catalogue.
 *
 * `flag` values here are exactly the strings that were previously hard-coded, so
 * adopting this file changes no launch behaviour by itself. Verified by the
 * `default preset reproduces the previously hard-coded arg list` test.
 */
export const FLAG_CATALOGUE: readonly FlagDef[] = [
  // ── container ────────────────────────────────────────────────────────────
  {
    id: 'no-sandbox',
    flag: '--no-sandbox',
    group: 'container',
    label: 'Disable the OS sandbox',
    labelFa: 'غیرفعال‌کردن سندباکس سیستم',
    why: 'Required inside most Docker containers, which cannot grant the kernel privileges the sandbox needs. On a normal desktop this weakens security for no gain.',
    whyFa: 'در بیشتر کانتینرهای داکر لازم است، چون مجوزهای کرنل مورد نیاز سندباکس را ندارند. روی دسکتاپ معمولی، بی‌دلیل امنیت را کم می‌کند.',
    risk: 'dangerous',
    required: true,
  },
  {
    id: 'disable-setuid-sandbox',
    flag: '--disable-setuid-sandbox',
    group: 'container',
    label: 'Disable the setuid sandbox helper',
    labelFa: 'غیرفعال‌کردن هلپر سندباکس setuid',
    why: 'Goes with the flag above; the helper binary is usually not installed in slim images. Like it, this weakens the security boundary between a web page and the host, so it belongs only in a container you control.',
    whyFa: 'همراه گزینهٔ بالا؛ فایل هلپر معمولاً در ایمیج‌های سبک نصب نیست. مانند آن، مرز امنیتی بین صفحهٔ وب و سیستم را ضعیف می‌کند، پس فقط در کانتینری که خودتان کنترل می‌کنید جای دارد.',
    risk: 'dangerous',
    required: true,
  },
  {
    id: 'disable-dev-shm-usage',
    flag: '--disable-dev-shm-usage',
    group: 'container',
    label: 'Do not use /dev/shm',
    labelFa: 'استفاده نکردن از /dev/shm',
    why: 'Docker gives /dev/shm only 64 MB by default; without this, tabs crash with no useful error on pages that use much memory.',
    whyFa: 'داکر به‌طور پیش‌فرض فقط ۶۴ مگابایت /dev/shm می‌دهد؛ بدون این، تب‌ها در صفحات سنگین بدون خطای مفید کرش می‌کنند.',
    risk: 'safe',
    required: true,
  },

  // ── stealth ──────────────────────────────────────────────────────────────
  {
    id: 'disable-automation-controlled',
    flag: '--disable-blink-features=AutomationControlled',
    group: 'stealth',
    label: 'Hide the automation marker from websites',
    labelFa: 'پنهان‌کردن نشانهٔ اتومیشن از سایت‌ها',
    why: 'Without it, `navigator.webdriver` is true and bot-detection scripts block or captcha you.',
    whyFa: 'بدون آن، `navigator.webdriver` مقدار true دارد و اسکریپت‌های تشخیص ربات شما را بلاک یا کپچا می‌کنند.',
    risk: 'safe',
  },
  {
    id: 'no-first-run',
    flag: '--no-first-run',
    group: 'stealth',
    label: 'Skip the first-run wizard',
    labelFa: 'رد کردن ویزارد اولین اجرا',
    why: 'Otherwise a welcome screen steals focus and your first click goes to it instead of the page.',
    whyFa: 'در غیر این صورت صفحهٔ خوش‌آمد فوکوس را می‌گیرد و اولین کلیک شما به جای صفحه به آن می‌رسد.',
    risk: 'safe',
  },
  {
    id: 'no-default-browser-check',
    flag: '--no-default-browser-check',
    group: 'stealth',
    label: 'Do not ask about the default browser',
    labelFa: 'نپرسیدن دربارهٔ مرورگر پیش‌فرض',
    why: 'Suppresses an infobar that covers the top of the page.',
    whyFa: 'نواری را که بالای صفحه را می‌پوشاند حذف می‌کند.',
    risk: 'safe',
  },

  // ── session ──────────────────────────────────────────────────────────────
  {
    id: 'restore-last-session',
    flag: '--restore-last-session',
    group: 'session',
    label: 'Reopen the tabs from last time',
    labelFa: 'بازکردن تب‌های دفعهٔ قبل',
    why: 'MEASURED: this flag AND the restore_on_startup preference are both required — either one alone restores zero tabs.',
    whyFa: 'اندازه‌گیری‌شده: این فلگ و تنظیم restore_on_startup هر دو لازم‌اند — هرکدام به‌تنهایی هیچ تبی برنمی‌گرداند.',
    risk: 'safe',
  },

  // ── privacy ──────────────────────────────────────────────────────────────
  {
    id: 'disable-background-networking',
    flag: '--disable-background-networking',
    group: 'privacy',
    label: 'No background network chatter',
    labelFa: 'بدون ترافیک پس‌زمینه',
    why: 'Stops update checks and metrics uploads competing with your own traffic.',
    whyFa: 'جلوی بررسی به‌روزرسانی و ارسال آمار را که با ترافیک خودتان رقابت می‌کنند می‌گیرد.',
    risk: 'safe',
  },
  {
    id: 'disable-sync',
    flag: '--disable-sync',
    group: 'privacy',
    label: 'Do not sync to a Google account',
    labelFa: 'همگام‌سازی نکردن با حساب گوگل',
    why: 'Keeps this profile local. Turn off only if you deliberately want a signed-in synced profile.',
    whyFa: 'این پروفایل را محلی نگه می‌دارد. فقط اگر عمداً پروفایل همگام‌شده می‌خواهید خاموش کنید.',
    risk: 'safe',
  },

  // ── performance ──────────────────────────────────────────────────────────
  {
    id: 'disable-site-isolation',
    flag: '--disable-features=IsolateOrigins,site-per-process',
    group: 'performance',
    label: 'Turn off site isolation',
    labelFa: 'خاموش‌کردن جداسازی سایت‌ها',
    why: 'Saves a process (and real RAM) per site and lets automation reach into cross-origin iframes. It also removes a defence against cross-site attacks: right for a controlled workspace, wrong for browsing the open web.',
    whyFa: 'یک پروسه (و رم واقعی) به ازای هر سایت صرفه‌جویی می‌کند و به اتومیشن اجازهٔ دسترسی به آی‌فریم‌های میان‌دامنه می‌دهد. در عوض یک دفاع مهم را حذف می‌کند: برای محیط کنترل‌شده مناسب، برای گردش در وب آزاد نامناسب.',
    risk: 'caution',
  },
  {
    id: 'disable-gpu',
    flag: '--disable-gpu',
    group: 'performance',
    label: 'No GPU acceleration',
    labelFa: 'بدون شتاب‌دهندهٔ گرافیکی',
    why: 'On a headless server there is no GPU to use and attempting it wastes time and logs errors. On a real display this makes scrolling and video visibly worse.',
    whyFa: 'روی سرور پنهان، GPU وجود ندارد و تلاش برای آن وقت هدر می‌دهد و خطا لاگ می‌کند. روی نمایشگر واقعی، اسکرول و ویدیو را محسوس بدتر می‌کند.',
    risk: 'caution',
  },
  // ── WHY THERE IS NO `disable-extensions` CHECKBOX ANYMORE ─────────────────
  //
  // It used to be offered here as "Load no extensions", risk: 'caution'. It has
  // been REMOVED rather than re-described, because ticking it did far more than
  // its label admitted:
  //
  //   extension_util.cc:71-74     --disable-extensions makes
  //                               ExtensionsDisabledViaCommandLine() true
  //   extension_registrar.cc:112  → extensions_enabled = false
  //   crx_installer.cc:404-408    → every install is DECLINED with
  //                               INSTALL_NOT_ENABLED, i.e. the user gets
  //                               "Installation is not enabled" and no
  //                               explanation of what caused it.
  //
  // So the real consequence was not "start leaner"; it was "this browser can
  // never install an extension again, and the error will blame Chrome". That is
  // exactly the trap this file's own header promises not to set: «Offering a
  // checkbox that bricks the app is not freedom, it is a trap.» An operator who
  // genuinely wants no extensions can simply install none — the flag is not
  // needed to achieve it, and `--load-extension` is only emitted when something
  // is actually installed (see extensionLaunchArgs).
  {
    id: 'disable-background-timer-throttling',
    flag: '--disable-background-timer-throttling',
    group: 'performance',
    label: 'Keep background tabs running at full speed',
    labelFa: 'اجرای تب‌های پس‌زمینه با سرعت کامل',
    why: 'Chrome slows timers in tabs you are not looking at, which stalls automation running in them. Costs CPU.',
    whyFa: 'کروم تایمرها را در تب‌هایی که نگاه نمی‌کنید کند می‌کند و اتومیشن داخل آنها معلق می‌ماند. به قیمت مصرف CPU.',
    risk: 'safe',
  },

  // ── debug ────────────────────────────────────────────────────────────────
  {
    id: 'remote-debugging',
    flag: '--remote-debugging-port',
    group: 'debug',
    label: 'Open the DevTools port',
    labelFa: 'بازکردن پورت DevTools',
    why: 'Lets you attach DevTools or CDP tooling. Anyone who can reach this port can run code and steal every cookie, so the address it binds to matters as much as the port.',
    whyFa: 'اجازهٔ اتصال DevTools یا ابزارهای CDP را می‌دهد. هر کسی که به این پورت دسترسی داشته باشد می‌تواند کد اجرا کند و همهٔ کوکی‌ها را بدزدد، پس آدرس bind به‌اندازهٔ پورت مهم است.',
    risk: 'dangerous',
    computed: true,
  },
  {
    id: 'window-size',
    flag: '--window-size',
    group: 'debug',
    label: 'Window size',
    labelFa: 'اندازهٔ پنجره',
    why: 'Computed from the real screen so the page fills the view instead of leaving a black margin.',
    whyFa: 'از اندازهٔ واقعی صفحه محاسبه می‌شود تا صفحه کل نمایش را پر کند و حاشیهٔ سیاه نماند.',
    risk: 'safe',
    computed: true,
  },
];

/** Flags that are always on and not offered as choices. */
export const REQUIRED_FLAG_IDS: readonly string[] = FLAG_CATALOGUE.filter(
  (f) => f.required,
).map((f) => f.id);

export interface PresetDef {
  id: string;
  label: string;
  labelFa: string;
  summary: string;
  summaryFa: string;
  /** Selectable flag ids. Required ones are added automatically. */
  flags: readonly string[];
  /** Shown first in the UI and used when nothing is chosen. */
  recommended?: boolean;
}

/**
 * The presets — the answer to «کاربران تازه‌کار».
 *
 * `standard` is deliberately identical to what the code shipped before this
 * file existed. A beginner picking the recommended option gets exactly the
 * behaviour that was already tested and measured, not a new guess.
 */
export const PRESETS: readonly PresetDef[] = [
  {
    id: 'standard',
    label: 'Standard (recommended)',
    labelFa: 'استاندارد (پیشنهادی)',
    summary: 'What this product has always used. Extensions work, tabs come back, sites do not see a robot.',
    summaryFa: 'همان چیزی که این محصول همیشه استفاده کرده. افزونه‌ها کار می‌کنند، تب‌ها برمی‌گردند، سایت‌ها ربات نمی‌بینند.',
    recommended: true,
    flags: [
      'no-first-run',
      'no-default-browser-check',
      'disable-background-networking',
      'disable-sync',
      'disable-automation-controlled',
      'disable-site-isolation',
      'restore-last-session',
    ],
  },
  {
    id: 'stealth',
    label: 'Maximum stealth',
    labelFa: 'حداکثر پنهان‌کاری',
    summary: 'For sites with aggressive bot detection. Keeps site isolation ON, because turning it off is itself detectable.',
    summaryFa: 'برای سایت‌های با تشخیص ربات سخت‌گیرانه. جداسازی سایت را روشن نگه می‌دارد، چون خاموش‌کردنش خودش قابل تشخیص است.',
    flags: [
      'no-first-run',
      'no-default-browser-check',
      'disable-background-networking',
      'disable-sync',
      'disable-automation-controlled',
      'restore-last-session',
    ],
  },
  {
    id: 'lean',
    label: 'Low memory',
    labelFa: 'کم‌مصرف',
    summary: 'For a small server. Gives up GPU, site isolation and background timers to save RAM and CPU.',
    summaryFa: 'برای سرور کوچک. GPU، جداسازی سایت و تایمرهای پس‌زمینه را فدا می‌کند تا رم و CPU صرفه‌جویی شود.',
    flags: [
      'no-first-run',
      'no-default-browser-check',
      'disable-background-networking',
      'disable-sync',
      'disable-automation-controlled',
      'disable-site-isolation',
      'disable-gpu',
      'restore-last-session',
    ],
  },
  {
    id: 'debug',
    label: 'Debugging',
    labelFa: 'عیب‌یابی',
    summary: 'Everything visible and inspectable. Do not use for real work: sites can tell it is automated.',
    summaryFa: 'همه‌چیز آشکار و قابل بازرسی. برای کار واقعی استفاده نکنید: سایت‌ها می‌فهمند اتوماتیک است.',
    flags: [
      'no-first-run',
      'no-default-browser-check',
      'disable-site-isolation',
      'restore-last-session',
      'disable-background-timer-throttling',
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    labelFa: 'سفارشی',
    summary: 'Your own selection. Start from a preset and adjust — the checkboxes stay where you put them.',
    summaryFa: 'انتخاب خودتان. از یک پریست شروع کنید و تغییر دهید — چک‌باکس‌ها همان‌جا که گذاشتید می‌مانند.',
    flags: [],
  },
];

export const DEFAULT_PRESET_ID = 'standard';

export interface ResolveFlagsInput {
  preset?: string;
  /** Explicit ids, used when `preset === 'custom'`. */
  flags?: readonly string[];
  /** Turn a specific flag on/off on top of the preset. */
  overrides?: Record<string, boolean>;
}

export interface ResolvedFlags {
  presetId: string;
  /** Ids that are on, required ones included, sorted for stable comparison. */
  ids: string[];
  /** The actual Chrome switches, in catalogue order. */
  args: string[];
  /** Ids that were asked for but do not exist — reported, never silently dropped. */
  unknown: string[];
  /** Ids that cannot be switched off, if something tried. */
  forced: string[];
}

/**
 * Turn a UI selection into Chrome switches.
 *
 * Unknown ids are REPORTED rather than ignored. A silently dropped flag is the
 * worst possible outcome here: the operator believes they configured something,
 * the browser disagrees, and nothing anywhere says so. That is precisely the
 * class of bug that cost this project days on the tab-restore hunt.
 */
export function resolveFlags(input: ResolveFlagsInput = {}): ResolvedFlags {
  const byId = new Map(FLAG_CATALOGUE.map((f) => [f.id, f]));
  const presetId = input.preset && PRESETS.some((p) => p.id === input.preset)
    ? input.preset
    : DEFAULT_PRESET_ID;
  const preset = PRESETS.find((p) => p.id === presetId) as PresetDef;

  const requested = presetId === 'custom' ? (input.flags ?? []) : preset.flags;
  const unknown: string[] = [];
  const on = new Set<string>();

  for (const id of requested) {
    if (byId.has(id)) on.add(id);
    else unknown.push(id);
  }

  const forced: string[] = [];
  for (const [id, want] of Object.entries(input.overrides ?? {})) {
    const def = byId.get(id);
    if (!def) {
      unknown.push(id);
      continue;
    }
    if (!want && def.required) {
      forced.push(id);
      continue;
    }
    if (want) on.add(id);
    else on.delete(id);
  }

  // Required flags are never optional, and a `computed` flag is never emitted
  // from here — its value lives in configuration, so RealChrome appends it.
  for (const def of FLAG_CATALOGUE) {
    if (def.required) on.add(def.id);
    if (def.computed) on.delete(def.id);
  }

  const ids = FLAG_CATALOGUE.filter((f) => on.has(f.id)).map((f) => f.id);
  const args = FLAG_CATALOGUE.filter((f) => on.has(f.id)).map((f) => f.flag);
  return { presetId, ids, args, unknown: [...new Set(unknown)], forced };
}

/** Everything the UI needs to draw the form, in one payload. */
export function flagCatalogue(): {
  groups: readonly FlagGroup[];
  flags: readonly FlagDef[];
  presets: readonly PresetDef[];
  defaultPreset: string;
  required: readonly string[];
} {
  return {
    groups: FLAG_GROUPS,
    flags: FLAG_CATALOGUE,
    presets: PRESETS,
    defaultPreset: DEFAULT_PRESET_ID,
    required: REQUIRED_FLAG_IDS,
  };
}
