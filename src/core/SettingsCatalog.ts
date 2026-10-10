/**
 * SettingsCatalog — the settings an operator can change from the panel.
 *
 * Every entry is a CHOICE wherever a choice is possible: the person in front of
 * the Settings page (or `./plyr setup`) should pick between named options, not
 * guess a number or a variable name. Free text is used only where the value is
 * genuinely the operator's own (a domain, their own token).
 *
 * `apply`:
 *   live     — the very next request uses the new value (config.ts getter).
 *   restart  — read once at startup; saved now, used after the next restart.
 *              The UI says so instead of pretending.
 *
 * This file is DATA plus validation. Persistence is PersistedSettings.ts, the
 * HTTP surface is Routes/settings.routes.ts.
 */
import { randomBytes } from 'crypto';
import { PERSISTABLE_KEYS } from './PersistedSettings';

export type SettingType = 'choice' | 'bool' | 'secret' | 'text';
export type SettingGroup = 'environment' | 'access' | 'security' | 'browser' | 'runs' | 'storage';

export interface ChoiceOption {
  value: string;
  fa: string;
  en: string;
  hintFa?: string;
  hintEn?: string;
}

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  type: SettingType;
  apply: 'live' | 'restart';
  fa: string;
  en: string;
  hintFa: string;
  hintEn: string;
  /** Value used when nothing is set anywhere (string form, as in .env). */
  dflt: string;
  options?: ChoiceOption[];
  /** Secret the server can generate for the user. */
  generatable?: boolean;
  /** Secret that may be cleared. */
  clearable?: boolean;
}

const BOOL: ChoiceOption[] = [
  { value: 'true', fa: 'روشن', en: 'On' },
  { value: 'false', fa: 'خاموش', en: 'Off' },
];

export const CATALOG: readonly SettingSpec[] = Object.freeze([
  {
    key: 'APP_ENV', group: 'environment', type: 'choice', apply: 'restart', dflt: 'development',
    fa: 'نوع اجرا', en: 'Environment',
    hintFa: 'رفتار امنیتی و مرورگر را یکجا تنظیم می‌کند.',
    hintEn: 'Tunes security and browser behaviour in one choice.',
    options: [
      { value: 'development', fa: 'در حال توسعه', en: 'Development',
        hintFa: 'روی سیستم خودتان؛ ورود بدون توکن مجاز است.', hintEn: 'On your own machine; login without a token is allowed.' },
      { value: 'server', fa: 'سرور (پروداکشن با مرورگر)', en: 'Server (production with browser)',
        hintFa: 'برای سرور واقعی؛ توکن اجباری، افزونه‌ها و مرورگر از راه دور فعال.', hintEn: 'For a real server; token required, extensions and Remote Browser on.' },
      { value: 'production', fa: 'پروداکشن بدون نمایشگر', en: 'Production (headless)',
        hintFa: 'فقط صف اجرا؛ مرورگر پنهان و بدون افزونه.', hintEn: 'Job queue only; hidden browser, no extensions.' },
    ],
  },
  {
    key: 'AUTH_MODE', group: 'access', type: 'choice', apply: 'live', dflt: 'token',
    fa: 'ورود به پنل', en: 'Panel login',
    hintFa: 'حالت «بدون ورود» فقط در حالت توسعه و فقط از همین سیستم کار می‌کند.',
    hintEn: '"No login" only works in development, and only from this machine.',
    options: [
      { value: 'open', fa: 'بدون ورود (فقط توسعه)', en: 'No login (development only)' },
      { value: 'token', fa: 'با توکن API', en: 'API token required' },
    ],
  },
  {
    key: 'API_TOKEN', group: 'access', type: 'secret', apply: 'live', dflt: 'admin123', generatable: true,
    fa: 'توکن API (کلید ورود)', en: 'API token (login key)',
    hintFa: 'کلید ورود به پنل و API. با تغییر آن، نشست فعلی شما خودکار به‌روز می‌شود.',
    hintEn: 'The key for the panel and the API. Changing it updates your current session automatically.',
  },
  {
    key: 'PUBLIC_DOMAIN', group: 'access', type: 'text', apply: 'live', dflt: '',
    fa: 'آدرس عمومی سرور', en: 'Public address',
    hintFa: 'آدرسی که افزونه و لینک‌ها به آن وصل می‌شوند. خالی = تشخیص خودکار.',
    hintEn: 'Where the extension and links connect. Empty = detected automatically.',
  },
  {
    key: 'WEBHOOK_SECRET', group: 'security', type: 'secret', apply: 'live', dflt: '', generatable: true, clearable: true,
    fa: 'رمز امضای وب‌هوک', en: 'Webhook signing secret',
    hintFa: 'وب‌هوک‌های خروجی با این رمز امضا می‌شوند. خالی = بدون امضا.',
    hintEn: 'Outgoing webhooks are signed with it. Empty = unsigned.',
  },
  {
    key: 'LIVE_SHARE_TTL_SEC', group: 'security', type: 'choice', apply: 'live', dflt: '7200',
    fa: 'اعتبار لینک اشتراک اجرای زنده', en: 'Live-run share link lifetime',
    hintFa: 'لینک «فقط مشاهده» اجرای زنده پس از این مدت باطل می‌شود.',
    hintEn: 'A view-only live-run link stops working after this long.',
    options: [
      { value: '1800', fa: '۳۰ دقیقه', en: '30 minutes' },
      { value: '3600', fa: '۱ ساعت', en: '1 hour' },
      { value: '7200', fa: '۲ ساعت (پیشنهادی)', en: '2 hours (recommended)' },
      { value: '21600', fa: '۶ ساعت', en: '6 hours' },
      { value: '86400', fa: '۲۴ ساعت', en: '24 hours' },
    ],
  },
  {
    key: 'CODE_NODE_ENABLED', group: 'security', type: 'bool', apply: 'live', dflt: 'true', options: BOOL,
    fa: 'نود کد (JavaScript)', en: 'Code node (JavaScript)',
    hintFa: 'اجازهٔ اجرای کد دلخواه در workflow. کد با دسترسی همین سرور اجرا می‌شود.',
    hintEn: 'Lets workflows run your own code, with this server\'s privileges.',
  },
  {
    key: 'REAL_CHROME_ENABLED', group: 'browser', type: 'bool', apply: 'live', dflt: 'true', options: BOOL,
    fa: 'مرورگر از راه دور (کروم واقعی)', en: 'Remote Browser (real Chrome)',
    hintFa: 'کروم واقعی با افزونه‌ها و پروفایل ماندگار.', hintEn: 'Real Chrome with extensions and a persistent profile.',
  },
  {
    key: 'DEFAULT_HEADLESS', group: 'browser', type: 'choice', apply: 'live', dflt: 'true',
    fa: 'نمایش مرورگر هنگام اجرا', en: 'Browser during runs',
    hintFa: 'وقتی workflow خودش مشخص نکرده باشد.', hintEn: 'When a workflow does not say.',
    options: [
      { value: 'true', fa: 'پنهان (سریع‌تر)', en: 'Hidden (faster)' },
      { value: 'false', fa: 'آشکار', en: 'Visible' },
    ],
  },
  {
    key: 'STEP_TIMEOUT_MS', group: 'runs', type: 'choice', apply: 'live', dflt: '300000',
    fa: 'حداکثر زمان هر مرحله', en: 'Step timeout',
    hintFa: 'مرحله‌ای که بیشتر طول بکشد، خطا می‌گیرد.', hintEn: 'A step that takes longer fails.',
    options: [
      { value: '30000', fa: '۳۰ ثانیه', en: '30 seconds' },
      { value: '60000', fa: '۱ دقیقه', en: '1 minute' },
      { value: '120000', fa: '۲ دقیقه', en: '2 minutes' },
      { value: '300000', fa: '۵ دقیقه (پیش‌فرض)', en: '5 minutes (default)' },
      { value: '600000', fa: '۱۰ دقیقه', en: '10 minutes' },
    ],
  },
  {
    key: 'MAX_CONCURRENT', group: 'runs', type: 'choice', apply: 'restart', dflt: '20',
    fa: 'تعداد اجرای هم‌زمان', en: 'Concurrent runs',
    hintFa: 'عدد کمتر = مصرف رم کمتر.', hintEn: 'Lower = less memory.',
    options: [
      { value: '1', fa: '۱', en: '1' }, { value: '2', fa: '۲', en: '2' }, { value: '5', fa: '۵', en: '5' },
      { value: '10', fa: '۱۰', en: '10' }, { value: '20', fa: '۲۰ (پیش‌فرض)', en: '20 (default)' },
    ],
  },
  {
    key: 'DOWNLOAD_TTL_MINUTES', group: 'storage', type: 'choice', apply: 'live', dflt: '30',
    fa: 'نگهداری فایل‌های دانلودی موقت', en: 'Keep temporary downloads',
    hintFa: 'فایل‌های پوشهٔ downloads خودِ هر workflow پاک نمی‌شوند.', hintEn: 'Files in a workflow\'s own downloads folder are never swept.',
    options: [
      { value: '10', fa: '۱۰ دقیقه', en: '10 minutes' }, { value: '30', fa: '۳۰ دقیقه (پیش‌فرض)', en: '30 minutes (default)' },
      { value: '60', fa: '۱ ساعت', en: '1 hour' }, { value: '240', fa: '۴ ساعت', en: '4 hours' },
    ],
  },
  {
    key: 'EXECUTION_RETENTION_DAYS', group: 'storage', type: 'choice', apply: 'restart', dflt: '30',
    fa: 'نگهداری تاریخچهٔ اجراها', en: 'Keep run history',
    hintFa: 'اجراهای قدیمی‌تر پاک می‌شوند.', hintEn: 'Older runs are deleted.',
    options: [
      { value: '7', fa: '۷ روز', en: '7 days' }, { value: '30', fa: '۳۰ روز (پیش‌فرض)', en: '30 days (default)' },
      { value: '90', fa: '۹۰ روز', en: '90 days' }, { value: '365', fa: '۱ سال', en: '1 year' },
    ],
  },
] as SettingSpec[]);

export const CATALOG_KEYS: readonly string[] = CATALOG.map((s) => s.key);

export function specOf(key: string): SettingSpec | undefined {
  return CATALOG.find((s) => s.key === key);
}

/** A token the server generates for the user: 48 hex chars, URL- and .env-safe. */
export function generateSecret(): string {
  return randomBytes(24).toString('hex');
}

export const PUBLIC_DEFAULT_TOKEN = 'admin123';

/** Context the validator needs; passed in so this module stays pure. */
export interface ValidateCtx {
  /** Profile the change will run under ('development' | 'server' | 'production'). */
  profile: string;
  allowDefaultToken: boolean;
  openAllowed: boolean;
  singleUser: boolean;
}

type Err = { error: string; errorFa: string };

/**
 * Validate one value. Returns the normalised string, or `{ error }`.
 * `null` means "remove the panel's value" (fall back to .env / default).
 */
export function validateValue(spec: SettingSpec, value: unknown, ctx: ValidateCtx): { value: string | null } | Err {
  const devLike = ctx.profile === 'development' || ctx.profile === 'test';
  if (value === null) {
    if (spec.key === 'API_TOKEN' && !devLike) {
      return { error: 'The API token cannot be reset on a server; generate a new one instead.',
        errorFa: 'روی سرور نمی‌توان توکن را به پیش‌فرض برگرداند؛ یک توکن جدید بسازید.' };
    }
    return { value: null };
  }
  if (typeof value === 'boolean') value = value ? 'true' : 'false';
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return { error: 'Value must be a string', errorFa: 'مقدار نامعتبر است.' };
  const v = value.trim();
  if (/[\r\n#]/.test(v)) return { error: 'Value cannot contain line breaks or "#"', errorFa: 'مقدار نباید شامل خط جدید یا # باشد.' };

  if (spec.options && spec.type !== 'secret' && spec.type !== 'text') {
    if (!spec.options.some((o) => o.value === v)) {
      return { error: `Choose one of: ${spec.options.map((o) => o.value).join(', ')}`, errorFa: 'یکی از گزینه‌ها را انتخاب کنید.' };
    }
  }
  if (spec.key === 'AUTH_MODE' && v === 'open') {
    if (!ctx.singleUser) return { error: 'Login without a token is not available in multi-user mode.', errorFa: 'در حالت چندکاربره ورود بدون توکن ممکن نیست.' };
    if (!ctx.openAllowed) {
      return { error: 'Login without a token is only allowed in development.',
        errorFa: 'ورود بدون توکن فقط در حالت توسعه مجاز است. ابتدا «نوع اجرا» را «در حال توسعه» کنید و ری‌استارت کنید.' };
    }
  }
  if (spec.key === 'API_TOKEN') {
    if (v === PUBLIC_DEFAULT_TOKEN) {
      if (!devLike && !ctx.allowDefaultToken) {
        return { error: 'admin123 is public and refused on a server profile.', errorFa: 'admin123 عمومی است و روی سرور پذیرفته نمی‌شود.' };
      }
    } else {
      if (v.length < 16) return { error: 'Use at least 16 characters (or press Generate).', errorFa: 'حداقل ۱۶ کاراکتر (یا دکمهٔ «ساخت خودکار» را بزنید).' };
      if (!/^[A-Za-z0-9._~-]+$/.test(v)) return { error: 'Use letters, digits and . _ ~ - only.', errorFa: 'فقط حروف انگلیسی، عدد و . _ ~ - مجاز است.' };
    }
  }
  if (spec.key === 'WEBHOOK_SECRET' && v !== '' && v.length < 16) {
    return { error: 'Use at least 16 characters (or press Generate).', errorFa: 'حداقل ۱۶ کاراکتر (یا دکمهٔ «ساخت خودکار» را بزنید).' };
  }
  if (spec.key === 'PUBLIC_DOMAIN' && v !== '') {
    const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
    try {
      const u = new URL(withScheme);
      if (!u.hostname || (u.pathname !== '/' && u.pathname !== '') || u.search || u.username) throw new Error('shape');
      return { value: `${u.protocol}//${u.host}` };
    } catch {
      return { error: 'Enter an address like panel.example.com or https://panel.example.com',
        errorFa: 'آدرسی مثل panel.example.com یا https://panel.example.com وارد کنید.' };
    }
  }
  return { value: v };
}

/** Sanity check used by tests: the boot overlay and the catalog agree. */
export function catalogMatchesPersistable(): boolean {
  return [...CATALOG_KEYS].sort().join(',') === [...PERSISTABLE_KEYS].sort().join(',');
}
