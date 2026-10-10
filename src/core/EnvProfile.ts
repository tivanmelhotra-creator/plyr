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
 * TWO operator-facing environments, plus `test` for the suite:
 *
 *     development — the operator's own machine. Rate limits off, verbose, and
 *                   the panel needs no token FROM THIS MACHINE (loopback only).
 *     production  — a deployed instance. Token required, rate limits on,
 *                   DevTools port shut, VNC desktop off unless asked for.
 *
 * WHAT A PROFILE NO LONGER DECIDES: whether the browser is visible. That used
 * to be the difference between the old `server` and `production` profiles, and
 * it mixed two unrelated questions ("where am I deployed?" and "should this run
 * show a window?"). Visibility is now a property of each RUN (core/RunPolicy):
 * a run the operator started by clicking Run is visible, a run started by a
 * trigger/schedule/API is hidden — in every environment. Hidden runs use
 * Chromium's new headless mode, which loads extensions (measured: 1 extension
 * service worker in new headless, 0 in the old headless shell), so hiding a run
 * no longer costs its extensions.
 *
 * `server` / `remote` are still ACCEPTED as input (existing .env files, the
 * Dockerfile and compose files used them) and mean `production`.
 */
export const PROFILE_IDS = ['development', 'production', 'test'] as const;
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
    summary: 'Your own machine: no token needed from this machine, rate limits off, verbose errors.',
    summaryFa: 'سیستم خودتان: از همین سیستم نیازی به توکن نیست، محدودیت نرخ خاموش، خطاهای کامل.',
  },
  {
    id: 'production',
    label: 'Production',
    labelFa: 'پروداکشن',
    summary: 'A deployed instance: the access token is required for every request, rate limits on, debug port shut.',
    summaryFa: 'نمونهٔ مستقرشده: توکن دسترسی برای هر درخواست لازم است، محدودیت نرخ روشن، پورت دیباگ بسته.',
  },
  {
    id: 'test',
    label: 'Test / CI',
    labelFa: 'تست / CI',
    summary: 'Fast failures, no desktop. Optimised for never hanging a CI job.',
    summaryFa: 'شکست سریع، بدون دسکتاپ. برای معلق‌نشدن CI بهینه شده.',
  },
];

/**
 * What each profile decides, and WHY — the reason is part of the data because
 * it is shown to the operator. Only variables whose correct value genuinely
 * differs by situation belong here; browser visibility does NOT (see above).
 */
export interface ProfileEntry {
  value: string;
  why: string;
  whyFa: string;
}

type ProfileTable = Record<ProfileId, Record<string, ProfileEntry>>;

export const PROFILE_DEFAULTS: ProfileTable = {
  development: {
    DESKTOP_ENABLED: {
      value: 'true',
      why: 'A visible run needs a display to be visible on.',
      whyFa: 'اجرای آشکار به یک نمایشگر نیاز دارد.',
    },
    REAL_CHROME_RESTORE_TABS: {
      value: 'true',
      why: 'Losing a half-finished login across three tabs on every restart is the reported defect.',
      whyFa: 'از دست دادن ورودِ نیمه‌کاره در سه تب با هر ری‌استارت، همان نقص گزارش‌شده است.',
    },
    RATE_LIMIT_ENABLED: {
      value: 'false',
      why: 'Rate-limiting yourself while testing wastes an afternoon on a non-bug.',
      whyFa: 'محدودکردن نرخ درخواست خودتان هنگام تست، وقت را صرف باگی می‌کند که وجود ندارد.',
    },
    TURBO_MODE: {
      value: 'false',
      why: 'Turbo trades diagnosability for speed; during development that trade is backwards.',
      whyFa: 'توربو، قابلیت عیب‌یابی را با سرعت معاوضه می‌کند؛ در توسعه این معاوضه اشتباه است.',
    },
  },

  production: {
    // TRUE: a manual run (the operator pressed Run) is visible on the virtual
    // display and watched through the live tab. DESKTOP_ENABLED gates nothing
    // but the reported status (Desktop.status().enabled), so `false` here would
    // only make /browser/status lie about a running display.
    DESKTOP_ENABLED: {
      value: 'true',
      why: 'Manual runs are visible (watched through the live tab), so a virtual display is part of a production box.',
      whyFa: 'اجرای دستی آشکار است (از تب زنده دیده می‌شود)، پس نمایشگر مجازی بخشی از سرور است.',
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

  test: {
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
    // DELIBERATELY ABSENT: REAL_CHROME_RESTORE_TABS (a profile may tune what is
    // environmental; it may not flip a product decision under the tests).
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
  // Legacy names for a deployed instance. Only APP_ENV may say so (a tool
  // writing NODE_ENV=server must not switch the instance to production).
  if (allowServer && (v === 'server' || v === 'remote')) return 'production';
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
