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
export type SettingGroup = 'general' | 'server' | 'access' | 'security' | 'runs' | 'storage';

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
    key: 'APP_ENV', group: 'server', type: 'choice', apply: 'restart', dflt: 'development',
    fa: 'نوع اجرا', en: 'Environment',
    hintFa: 'فقط مدل امنیتی را تعیین می‌کند؛ نمایش مرورگر به نحوهٔ شروع اجرا بستگی دارد.',
    hintEn: 'Decides the security model only; browser visibility follows how a run was started.',
    options: [
      { value: 'development', fa: 'توسعه', en: 'Development',
        hintFa: 'روی سیستم خودتان؛ بدون ورود و بدون توکن.', hintEn: 'Your own machine; no login and no token from this machine.' },
      { value: 'production', fa: 'پروداکشن', en: 'Production',
        hintFa: 'نمونهٔ مستقرشده؛ رمز عبور مالک در اولین اجرا انتخاب می‌شود و ورود لازم است.', hintEn: 'A deployed instance; you choose the owner password on first run and sign in afterwards.' },
    ],
  },

  {
    key: 'API_TOKEN', group: 'access', type: 'secret', apply: 'live', dflt: '', generatable: true, clearable: true,
    fa: 'توکن اسکریپت/API (اختیاری)', en: 'Script/API token (optional)',
    hintFa: 'فقط برای اسکریپت‌ها و ابزارهای خارجی (هدر x-api-key). برای ورود به پنل لازم نیست؛ ورود با رمز عبور است. خالی = غیرفعال.',
    hintEn: 'Only for scripts and external tools (x-api-key header). Not used to sign in to the panel — that is the owner password. Empty = disabled.',
  },
  {
    key: 'PUBLIC_DOMAIN', group: 'server', type: 'text', apply: 'live', dflt: '',
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
    key: 'DOWNLOAD_TTL_MINUTES', group: 'storage', type: 'choice', apply: 'live', dflt: '30',
    fa: 'نگهداری فایل‌های دانلودی موقت', en: 'Keep temporary downloads',
    hintFa: 'فایل‌های پوشهٔ downloads خودِ هر workflow پاک نمی‌شوند.', hintEn: 'Files in a workflow\'s own downloads folder are never swept.',
    options: [
      { value: '10', fa: '۱۰ دقیقه', en: '10 minutes' }, { value: '30', fa: '۳۰ دقیقه (پیش‌فرض)', en: '30 minutes (default)' },
      { value: '60', fa: '۱ ساعت', en: '1 hour' }, { value: '240', fa: '۴ ساعت', en: '4 hours' },
    ],
  },

  {
    key: 'EXECUTION_RETENTION_DAYS', group: 'storage', type: 'choice', apply: 'live', dflt: '30',
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

/** Context the validator needs; passed in so this module stays pure. */
export interface ValidateCtx {
  /** Environment the change will run under ('development' | 'production'). */
  profile: string;
}

type Err = { error: string; errorFa: string };

/**
 * Validate one value. Returns the normalised string, or `{ error }`.
 * `null` means "remove the panel's value" (fall back to .env / default).
 */
export function validateValue(spec: SettingSpec, value: unknown, ctx: ValidateCtx): { value: string | null } | Err {
  if (value === null) {
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
  if (spec.key === 'API_TOKEN') {
    if (v !== '') {
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
