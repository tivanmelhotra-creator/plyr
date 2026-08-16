/**
 * Environment profiles — settings that tune themselves to the situation.
 *
 * THE OPERATOR'S COMPLAINT (verbatim):
 *
 *   «متغیرها خیلی زیاد شدن و الان بخوام یه حالت استاندارد برسم باید کلی متغیر
 *    سروکله زد، در حالی که من می‌خوام نسبت به موقعیت متغیرها تنظیم بشن.
 *    یعنی اگر توی حالت دولوپ هستیم خب طبیعیه که مرورگر توی حالت آشکار باشه،
 *    ولی وقتی توی حالت پروداکته دیگه حالت آشکار نیاز نیست و برای بهینه عمل
 *    کردن باید رو حالت پنهان باشه.»
 *
 * MEASURED, so the size of the problem is not a matter of opinion: `config.ts`
 * reads **77** distinct environment variables and `.env.example` documents 72.
 * Reaching a sane development setup meant hand-editing a dozen of them and
 * knowing which dozen. That is the defect. Nothing here is a new feature; it is
 * the removal of work that should never have been the operator's.
 *
 * ── THE ONE RULE THAT MATTERS ──────────────────────────────────────────────
 *
 * An explicit value ALWAYS wins. A profile only fills in what the operator left
 * unset. Getting this backwards would be far worse than the sprawl it replaces:
 * an operator who writes `REAL_CHROME_HEADLESS=true` and gets a visible browser
 * anyway has been lied to by their own config file, and would rightly stop
 * trusting every other setting too. So the precedence is, strictly:
 *
 *     explicit environment variable  →  profile default  →  base default
 *
 * `''` (empty string) counts as ABSENT, not as an explicit choice, because
 * `FOO=` in a `.env` file and a commented-out `FOO` are the same intent, and
 * `cleanEnv` already strips `# comments` to empty. But `FOO=false` IS explicit:
 * it is the operator turning something off, which is the whole point.
 *
 * ── WHY PROVENANCE IS RETURNED, NOT JUST VALUES ────────────────────────────
 *
 * The complaint ends «کاربر گیج نمونه» — the user should not end up confused.
 * A resolved value alone reintroduces the confusion in a new place: the
 * operator sees `headless: false` and cannot tell whether they chose it, a
 * profile chose it, or it is a base default. So every value carries WHERE IT
 * CAME FROM, and the UI shows that. "You set this" and "development chose this
 * for you" are different facts and must never look alike.
 */

/** How a resolved value came to be. Ordered from strongest to weakest. */
export type ValueSource = 'explicit' | 'profile' | 'default';

export interface ResolvedValue<T> {
  value: T;
  source: ValueSource;
  /** Present only when `source === 'profile'`: which profile decided. */
  profile?: string;
  /** Human-readable justification, shown in the UI next to the value. */
  why: string;
}

/**
 * The profiles.
 *
 * Deliberately FOUR, not a spectrum. Every extra profile is another thing the
 * operator must understand before they can start, which is the disease, not the
 * cure.
 *
 * `test` exists because the test suite has genuinely different needs (never
 * open a window, never wait 60s for a launch) and because CI setting one
 * variable is better than CI setting nine.
 *
 * ── WHY `server` EXISTS, AND WHY IT IS NOT JUST `production` ───────────────
 *
 * This is the fix for a real, reported defect, so the reasoning is recorded in
 * full.
 *
 * `production` sets `REAL_CHROME_HEADLESS=true` on the entirely sound grounds
 * that nobody is watching the screen and a headed browser costs RAM. But
 * MEASURED with this repo's own launch options (playwright 1.56.1 /
 * chromium-1194, `--load-extension` with `--disable-extensions` stripped):
 *
 *     headless=true   ->  0 extension service workers
 *     headless=false  ->  1 extension service worker
 *
 * A headless Chrome loads NO extensions. Not "fewer" — none. So on any box
 * that set `NODE_ENV=production` (which this repo's OWN Dockerfile and both
 * compose files do), the Remote Browser came up with the Element Inspector and
 * every cookie extension silently absent. That is precisely the
 * "Environment B → Real Chrome silently disabled" outcome we were told to
 * eliminate.
 *
 * Two bad ways to fix it, and why they were rejected:
 *
 *   1. Flip `production` to headed. That breaks the legitimate deployment that
 *      runs ONLY the job queue and wants no X server at all, and it silently
 *      reverses a deliberate resource decision for every existing operator.
 *   2. Leave it and document the trap. Documentation does not stop a silent
 *      failure; it just means the failure is described somewhere.
 *
 * So instead the two intents are given two names, and neither is a guess:
 *
 *     production  — the app in production. Headless. Remote Browser runs
 *                   WITHOUT extensions, and now says so loudly at boot.
 *     server      — a remote server whose job includes the Remote Browser.
 *                   Headed on a virtual display, extensions load, VNC stays
 *                   shut unless asked for.
 *
 * `server` is what the Dockerfile, both compose files and the deployment docs
 * now select, because "I deployed this project to a server" overwhelmingly
 * means "and I want its headline feature to work".
 */
export const PROFILE_IDS = ['development', 'server', 'production', 'test'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface ProfileMeta {
  id: ProfileId;
  label: string;
  labelFa: string;
  summary: string;
  summaryFa: string;
}

export const PROFILES: readonly ProfileMeta[] = [
  {
    id: 'development',
    label: 'Development',
    labelFa: 'توسعه',
    summary: 'Visible browser, verbose errors, nothing hidden. Optimised for seeing what happened.',
    summaryFa: 'مرورگر آشکار، خطاهای کامل، هیچ‌چیز پنهان نیست. برای دیدن اتفاقات بهینه شده.',
  },
  {
    id: 'server',
    label: 'Remote server',
    labelFa: 'سرور راه دور',
    summary:
      'Production hardening, but the Remote Browser works: headed Chrome on a virtual '
      + 'display so extensions and the Element Inspector load. Rate limits on, debug port shut.',
    summaryFa:
      'سخت‌گیری پروداکشن، اما Remote Browser کار می‌کند: کروم آشکار روی نمایشگر مجازی تا '
      + 'افزونه‌ها و Element Inspector بارگذاری شوند. محدودیت نرخ روشن، پورت دیباگ بسته.',
  },
  {
    id: 'production',
    label: 'Production (headless)',
    labelFa: 'محصول نهایی (پنهان)',
    summary:
      'Headless browser, tighter limits, no debug port. Optimised for resources and safety. '
      + 'Extensions do NOT load headless — use the server profile if you need them.',
    summaryFa:
      'مرورگر پنهان، محدودیت‌های سخت‌تر، بدون پورت دیباگ. برای منابع و امنیت بهینه شده. '
      + 'در حالت پنهان افزونه‌ها بارگذاری نمی‌شوند — اگر لازم دارید از پروفایل server استفاده کنید.',
  },
  {
    id: 'test',
    label: 'Test / CI',
    labelFa: 'تست / CI',
    summary: 'Headless, fast failures, no desktop. Optimised for never hanging a CI job.',
    summaryFa: 'پنهان، شکست سریع، بدون دسکتاپ. برای معلق‌نشدن CI بهینه شده.',
  },
];

/**
 * What each profile decides, and WHY — the reason is part of the data because
 * it is shown to the operator. A default with no stated reason is a default
 * nobody can safely change.
 *
 * Only variables whose *correct* value genuinely differs by situation belong
 * here. Ports, directories, secrets and credentials deliberately do NOT: a
 * profile guessing a secret, or silently moving where a user's files are
 * written, would be a far nastier surprise than typing it out.
 */
export interface ProfileEntry {
  value: string;
  why: string;
  whyFa: string;
}

type ProfileTable = Record<ProfileId, Record<string, ProfileEntry>>;

export const PROFILE_DEFAULTS: ProfileTable = {
  development: {
    REAL_CHROME_HEADLESS: {
      value: 'false',
      why: 'You are developing: you need to SEE the browser to know what it did.',
      whyFa: 'در حال توسعه‌اید: باید مرورگر را ببینید تا بفهمید چه کرد.',
    },
    DESKTOP_ENABLED: {
      value: 'true',
      why: 'A visible browser needs a display to be visible on.',
      whyFa: 'مرورگر آشکار به یک نمایشگر نیاز دارد تا دیده شود.',
    },
    REAL_CHROME_RESTORE_TABS: {
      value: 'true',
      why: 'Losing a half-finished login across three tabs on every restart is the reported defect.',
      whyFa: 'از دست دادن ورودِ نیمه‌کاره در سه تب با هر ری‌استارت، همان نقص گزارش‌شده است.',
    },
    RATE_LIMIT_ENABLED: {
      value: 'false',
      why: 'Rate-limiting yourself while testing wastes an afternoon on a non-bug.',
      whyFa: 'محدودکردن نرخ درخواست خودتان هنگام تست، یک بعدازظهر را صرف باگی می‌کند که وجود ندارد.',
    },
    TURBO_MODE: {
      value: 'false',
      why: 'Turbo trades diagnosability for speed; during development that trade is backwards.',
      whyFa: 'توربو، قابلیت عیب‌یابی را با سرعت معاوضه می‌کند؛ در توسعه این معاوضه اشتباه است.',
    },
  },

  /**
   * A remote server that is expected to RUN the Remote Browser.
   *
   * Everything security-related matches `production`. The single difference is
   * the one the measurement above forces: the browser is headed, on a virtual
   * display the server starts itself, because that is the only mode in which
   * an extension exists at all.
   */
  server: {
    REAL_CHROME_HEADLESS: {
      value: 'false',
      why: 'Extensions only load in a headed Chrome (measured: 0 extensions headless, 1 headed). '
        + 'The Element Inspector and cookie extensions are the point of the Remote Browser.',
      whyFa: 'افزونه‌ها فقط در کروم آشکار بارگذاری می‌شوند (اندازه‌گیری‌شده: صفر افزونه در حالت پنهان، '
        + 'یک افزونه در حالت آشکار). Element Inspector و افزونه‌های کوکی، هدف اصلی Remote Browser هستند.',
    },
    // TRUE, and the earlier draft of this table had it FALSE. The reasoning
    // written there — "the X display comes up on demand, the VNC viewer stays
    // off, an idle VNC port is attack surface" — sounded responsible and was
    // wrong on the facts. `DESKTOP_ENABLED` gates NOTHING: the only reader in
    // the entire codebase is `Desktop.status().enabled` (Desktop.ts:779), and
    // `Desktop.start()` brings up Xvfb, x11vnc and websockify whether it is set
    // or not. Declaring it false would therefore have bought exactly zero
    // security and cost a `/browser/status` that reports `desktop.enabled:
    // false` on a box whose desktop is running — the same class of lie this
    // whole change exists to remove.
    DESKTOP_ENABLED: {
      value: 'true',
      why: 'A headed browser needs a display to be headed ON, and this profile is headed. '
        + 'Also lets the operator watch the Remote Browser, which is why they deployed it.',
      whyFa: 'مرورگر آشکار به نمایشگری نیاز دارد که روی آن آشکار باشد، و این پروفایل آشکار است. '
        + 'ضمناً به اپراتور اجازه می‌دهد Remote Browser را تماشا کند، که دلیل استقرار آن است.',
    },
    REAL_CHROME_DEBUG_PORT: {
      value: '0',
      why: 'An open DevTools port is remote code execution and full cookie theft. Off unless asked for.',
      whyFa: 'پورت باز DevTools یعنی اجرای کد از راه دور و سرقت کامل کوکی‌ها. جز با درخواست صریح، خاموش.',
    },
    RATE_LIMIT_ENABLED: {
      value: 'true',
      why: 'A public endpoint without a rate limit is a bill waiting to happen.',
      whyFa: 'اندپوینت عمومی بدون محدودیت نرخ، صورت‌حسابی است که در راه است.',
    },
    REAL_CHROME_RESTORE_TABS: {
      value: 'true',
      why: 'A server restart must not discard the operator\'s half-finished work across tabs.',
      whyFa: 'ری‌استارت سرور نباید کار نیمه‌تمام اپراتور در چند تب را دور بریزد.',
    },
  },

  production: {
    REAL_CHROME_HEADLESS: {
      value: 'true',
      why: 'Nobody is watching the screen. A visible browser costs RAM and a display for nothing. '
        + 'NOTE: no extension loads headless — use APP_ENV=server if you need the Element Inspector.',
      whyFa: 'کسی صفحه را تماشا نمی‌کند. مرورگر آشکار بی‌دلیل رم و نمایشگر مصرف می‌کند. '
        + 'توجه: در حالت پنهان هیچ افزونه‌ای بارگذاری نمی‌شود — اگر Element Inspector لازم دارید APP_ENV=server بگذارید.',
    },
    DESKTOP_ENABLED: {
      value: 'false',
      why: 'A VNC desktop nobody connects to is an idle attack surface.',
      whyFa: 'دسکتاپ VNC که کسی به آن وصل نمی‌شود، یک سطح حملهٔ بی‌استفاده است.',
    },
    REAL_CHROME_DEBUG_PORT: {
      value: '0',
      why: 'An open DevTools port is remote code execution and full cookie theft. Off unless asked for.',
      whyFa: 'پورت باز DevTools یعنی اجرای کد از راه دور و سرقت کامل کوکی‌ها. جز با درخواست صریح، خاموش.',
    },
    RATE_LIMIT_ENABLED: {
      value: 'true',
      why: 'A public endpoint without a rate limit is a bill waiting to happen.',
      whyFa: 'اندپوینت عمومی بدون محدودیت نرخ، صورت‌حسابی است که در راه است.',
    },
  },

  test: {
    REAL_CHROME_HEADLESS: {
      value: 'true',
      why: 'CI has no screen. A headed launch there fails in a way that looks like a code bug.',
      whyFa: 'CI صفحه‌نمایش ندارد. اجرای آشکار در آن، شکستی می‌دهد که شبیه باگ کد به نظر می‌رسد.',
    },
    DESKTOP_ENABLED: {
      value: 'false',
      why: 'Nothing in a test run looks at a desktop.',
      whyFa: 'هیچ بخشی از یک اجرای تست به دسکتاپ نگاه نمی‌کند.',
    },
    REAL_CHROME_DEBUG_PORT: {
      value: '0',
      why: 'Parallel test workers fighting over one fixed port is a flaky-test factory.',
      whyFa: 'رقابت ورکرهای موازی تست بر سر یک پورت ثابت، کارخانهٔ تست‌های بی‌ثبات است.',
    },
    RATE_LIMIT_ENABLED: {
      value: 'false',
      why: 'A rate limit turns a fast test suite into a failing one.',
      whyFa: 'محدودیت نرخ، یک مجموعه تست سریع را به مجموعه‌ای شکست‌خورده تبدیل می‌کند.',
    },
    // DELIBERATELY ABSENT: REAL_CHROME_RESTORE_TABS.
    //
    // An earlier version of this table set it to 'false' here, reasoning that a
    // test should start from a known state. That reasoning was wrong, and
    // chrome-tab-restore.test.ts caught it: vitest sets NODE_ENV=test, so the
    // whole suite began asserting against a value no operator ever runs, and
    // the profile had quietly overturned the shipped default that the §3.2 tab
    // -loss fix exists to guarantee. A profile may tune what is merely
    // environmental; it may not flip a product decision out from under the
    // tests that pin it. A test that really needs tabs off sets the variable
    // explicitly, where it is visible in the test rather than hidden in here.
  },
};

/**
 * Which profile are we in?
 *
 * `APP_ENV` is offered as the explicit, unambiguous name because `NODE_ENV` is
 * overloaded: tooling everywhere writes it (`vitest` sets it to `test`, bundlers
 * set it to `production`), so it makes a poor place for the operator to state
 * an intention. `APP_ENV` is ours and means only this.
 *
 * Unknown values fall back to `development` rather than throwing. A typo in
 * `APP_ENV` must not prevent the server from booting — the operator would get a
 * stack trace where they expected a website, and the safest wrong guess is the
 * one that hides nothing.
 */
export function detectProfile(env: NodeJS.ProcessEnv = process.env): {
  id: ProfileId;
  source: 'APP_ENV' | 'NODE_ENV' | 'default';
  raw: string;
} {
  const appEnv = normalise(env.APP_ENV);
  if (appEnv) {
    const id = coerceProfile(appEnv, true);
    if (id) return { id, source: 'APP_ENV', raw: appEnv };
  }
  const nodeEnv = normalise(env.NODE_ENV);
  if (nodeEnv) {
    const id = coerceProfile(nodeEnv, false);
    if (id) return { id, source: 'NODE_ENV', raw: nodeEnv };
  }
  return { id: 'development', source: 'default', raw: appEnv || nodeEnv || '' };
}

/**
 * `prod`, `PRODUCTION`, `production` all mean the same thing to a human.
 *
 * `allowServer` exists because the two inputs are not equally trustworthy.
 * `APP_ENV` is ours: nothing writes it but the operator, so every word in the
 * vocabulary is a deliberate statement. `NODE_ENV` is written by tooling that
 * knows nothing about this project, so it gets the smaller vocabulary — a
 * bundler or a PaaS that decided to set `NODE_ENV=server` must not silently
 * start an X server and a headed Chrome on a box that never asked for one.
 * `remote` is accepted as a synonym for `server` because the feature is called
 * "Remote Browser" and that is what people type.
 */
function coerceProfile(raw: string, allowServer: boolean): ProfileId | null {
  const v = raw.toLowerCase();
  if (v === 'production' || v === 'prod') return 'production';
  if (v === 'development' || v === 'dev') return 'development';
  if (v === 'test' || v === 'testing' || v === 'ci') return 'test';
  if (allowServer && (v === 'server' || v === 'remote')) return 'server';
  return null;
}

function normalise(val: string | undefined): string {
  if (!val) return '';
  // Same `# comment` stripping as config.ts's cleanEnv: a value of
  // `production # live box` must resolve, not fall through to development.
  return val.split('#')[0].trim();
}

/**
 * Resolve one variable through the precedence chain.
 *
 * This is THE function. Everything else in this file is data.
 */
export function resolveVar(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  profileId?: ProfileId,
): ResolvedValue<string | undefined> {
  const id = profileId ?? detectProfile(env).id;
  const explicit = normalise(env[name]);
  if (explicit !== '') {
    return { value: explicit, source: 'explicit', why: `You set ${name}=${explicit}.` };
  }
  const entry = PROFILE_DEFAULTS[id]?.[name];
  if (entry) {
    return { value: entry.value, source: 'profile', profile: id, why: entry.why };
  }
  return { value: undefined, source: 'default', why: `Not set; using the built-in default.` };
}

/**
 * The value a caller actually wants, with the profile applied.
 *
 * `config.ts` uses this in place of `process.env.X` for the variables listed in
 * PROFILE_DEFAULTS. Everything else keeps reading the environment directly,
 * because a profile has no business guessing a port or a secret.
 */
export function profiledEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  profileId?: ProfileId,
): string | undefined {
  return resolveVar(name, env, profileId).value;
}

/**
 * Everything the profile system decided, for the UI and for `/config/profile`.
 *
 * Includes variables the operator set explicitly as well as ones a profile
 * filled in, because "which of these did I choose?" is exactly the question
 * being answered.
 */
export interface ProfileReport {
  profile: ProfileId;
  detectedFrom: 'APP_ENV' | 'NODE_ENV' | 'default';
  raw: string;
  meta: ProfileMeta;
  values: Array<{
    name: string;
    value: string | undefined;
    source: ValueSource;
    why: string;
    whyFa: string;
    /** What this profile would have chosen, even when overridden. */
    profileValue?: string;
    /** True when an explicit value disagrees with the profile's choice. */
    overridden: boolean;
  }>;
}

export function describeProfile(env: NodeJS.ProcessEnv = process.env): ProfileReport {
  const detected = detectProfile(env);
  const table = PROFILE_DEFAULTS[detected.id] ?? {};
  // Union of everything any profile has an opinion about, so switching profiles
  // in the UI never makes rows appear and disappear.
  const names = new Set<string>();
  for (const id of PROFILE_IDS) {
    for (const key of Object.keys(PROFILE_DEFAULTS[id] ?? {})) names.add(key);
  }

  const values = [...names].sort().map((name) => {
    const resolved = resolveVar(name, env, detected.id);
    const entry = table[name];
    const overridden =
      resolved.source === 'explicit' && entry !== undefined && entry.value !== resolved.value;
    return {
      name,
      value: resolved.value,
      source: resolved.source,
      why: resolved.why,
      whyFa: resolved.source === 'profile' && entry ? entry.whyFa : resolved.why,
      profileValue: entry?.value,
      overridden,
    };
  });

  const meta = PROFILES.find((p) => p.id === detected.id) as ProfileMeta;
  return {
    profile: detected.id,
    detectedFrom: detected.source,
    raw: detected.raw,
    meta,
    values,
  };
}
