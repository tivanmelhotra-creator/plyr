# پرامپ شروع جلسهٔ بعد — Aria Automate (Plyr)

> این متن را کامل به‌عنوان اولین پیام جلسهٔ جدید بفرست. (بکاپ و لینک‌ها در بخش ۱ هستند.)

---

## ۱. نقطهٔ شروع (اول این کارها، به همین ترتیب)

1. بکاپ آخرین وضعیت را دانلود و در `/home/user/webapp` باز کن (node_modules داخل بکاپ نیست؛ اگر نبود `npm ci`):
   - بکاپ: `<<لینک بکاپ آخر را اینجا بگذار>>`
   - شاخه: `feat/profile-infrastructure` · آخرین commit بعد از این جلسه: `docs(handoff): …` (درخت باید تمیز باشد).
2. Redis را راه بینداز (`sudo apt-get install -y redis-server && redis-server --daemonize yes`) — تست‌های integration بدون آن skip می‌شوند.
3. فایل‌های `current-handoff.md` → `handoffs/2026-10-12_S24_profile-infrastructure.md` → `PROJECT.md` بخش ۶.۱ را بخوان.
4. **محدودیت sandbox:** حدود ۱ GB RAM. هیچ‌وقت سرور + کل تست‌ها + Chromium را هم‌زمان اجرا نکن (sandbox قفل می‌شود). تست‌ها را تکه‌ای اجرا کن:
   `npx vitest run tests/integration --poolOptions.threads.maxThreads=2` و سپس `tests/unit` همین‌طور.
   بعد از هر گام مهم commit و `ProjectBackup` بگیر.

## ۲. کار معوق از جلسهٔ قبل: PR مرحلهٔ اول

PR هنوز ساخته **نشده** — اتصال GitHub در sandbox توکن معتبر برنگرداند (`setup_github_environment` → No valid authorization).
- اول `setup_github_environment` را صدا بزن. اگر موفق بود: `bash scripts/open-pr-s24.sh`
  (push شاخه + `gh pr create` با بدنهٔ `handoffs/PR-S24-profile-infrastructure.md`).
- اگر باز هم ناموفق بود، متوقف شو و از کاربر بخواه از تب GitHub دوباره authorize کند؛ بدون آن push/PR نکن.
- مخزن: `https://github.com/tivanmelhotra-creator/plyr` · base: `main`.

## ۳. وضعیت مرحلهٔ اول — چک‌لیست کامل الزامات (پرامپ اصلی)

| # | الزام | وضعیت | کجا |
|---|-------|-------|-----|
| 1 | فهرست / ایجاد با نام / تغییر نام / حذف (فقط اگر استفاده/رزرو نشده) | ✅ | `core/ProfileRegistry`, `Routes/profile.routes.ts` (DELETE با blockers) |
| 1 | شناسهٔ پایدار مستقل از نام؛ rename ارجاع‌ها را نمی‌شکند | ✅ | id = پوشه/قفل، نام در `.plyr-profile.json`؛ legacy adopt |
| 1 | وضعیت: آزاد / رزرو / در حال استفاده / نیازمند بررسی | ✅ | `ProfileAccess.deriveStatus` |
| 1 | خطای ایجاد/راه‌اندازی/بازیابی | ✅ | `problem`, `lastOpenError` |
| 1 | ایجاد و باز کردن مستقل؛ بعد از ایجاد در UI خودکار باز شود؛ شکست = پروفایل بماند + retry | ✅ (تست jsdom) | `public/js/profile-manager.js` |
| 2 | اتصال به همان دراور Workflow Files، بدون سیستم/صفحهٔ تکراری | ✅ | `workflow-files.js` (mount) |
| 2 | چند پروفایل انتخاب/باز، ایجاد، rename، حذف، وضعیت مرورگر و دسترسی | ✅ | همان پنل |
| 2 | نمایش در تب جدید با سازوکار فعلی؛ بدون نشست تکراری | ✅ منطق / ⚠️ **Chromium واقعی تأیید نشده** | `/desktop/chrome?profile=<id>`، `ProfileBrowser` (یک launch مشترک) |
| 3 | دستی = visible، خودکار = hidden، مستقل از محیط | ✅ (از قبل، حفظ شد) | `core/RunPolicy` |
| 3 | تغییر Active پروفایل/نشست/مالکیت را خراب نکند | ✅ | setState فقط resync رزرو؛ تست coordinator |
| 4 | جدایی پروفایل / نشست / اجرا / رزرو | ✅ | چهار ماژول جدا |
| 4 | بستن مرورگر ≠ آزادسازی رزرو و برعکس | ✅ | تست routes «close vs release» |
| 5 | حاشیهٔ قبل/بعد قابل تنظیم، پیش‌فرض ۱۰/۱۰ | ✅ | Settings → Workflow Runs |
| 5 | پایان واقعی اجرا لحاظ شود (۱۰:۲۰) | ✅ | fired/settled، تست admission |
| 5 | فقط پروفایل‌های واقعاً اختصاص‌یافته | ✅ | `ProfileCoordinator.bindings` |
| 5 | تشخیص تداخل schedule‌ها | ⚠️ فقط لاگ هنگام boot | `findOverlaps` — **UI ندارد** |
| 5 | اتمیک سمت سرور، رقابت هم‌زمان | ✅ | `ADMIT_LUA`؛ تست ۵۰ هم‌زمان |
| 5 | استفادهٔ دستی از پروفایل رزروشده کنترل + علت | ✅ | hold رد با `reserved` + نام workflow + بازه |
| 5 | اجرای نامشخص/قطع‌شده ایمن؛ آزاد نشود تا تعیین تکلیف | ✅ | sweep مبتنی بر شواهد |
| 6 | نام workflow مرتبط و بازهٔ رزرو نمایش داده شود؛ دور زدن با انتخاب ممکن نباشد | ✅ | checkbox غیرفعال + explanation |
| 6 | استفادهٔ مجاز فقط از مسیر کنترل‌شده (پشتیبانی بدون انتقال ضمنی) | ✅ زیرساخت | `ProfileLeases.grant/revokeGrant` — **به نود وصل نیست** |
| 7 | نگه‌داشتن / بستن بعد از اجرا در سطح workflow | ✅ | `afterRun` + `BrowserLifecycle` |
| 7 | خطا/توقف/timeout هماهنگ با بررسی خطا | ✅ | error/timeout = keep |
| 7 | بستن فقط اگر وابستهٔ دیگری نیست؛ مرورگر مشترک توسط غیرمالک بسته نشود | ✅ | `BrowserSessions.canClose`، نود Close Browser = detach |
| 7 | ذخیرهٔ وضعیت لازم برای بازیابی قبل از بستن | ⚠️ ناقص | فقط persistent user-data-dir؛ snapshot تب‌ها انجام نشده |
| 7 | مهلت بیکاری (پیش‌فرض ۱۰)؛ Wait بیکاری نیست | ✅ | `BROWSER_IDLE_CLOSE_MIN` |
| 8 | پایداری پس از restart؛ نامشخص ≠ آزاد؛ تشخیص باقی‌مانده‌ها | ✅ | `recoverAtBoot` |
| 8 | جلوگیری از نشست تکراری هنگام retry | ✅ | `starting` map + start budget |
| 8 | عدم افشای اطلاعات حساس در لاگ | ✅ | پیام‌ها بدون مسیر/کوکی؛ `sanitizeLogMessage` موجود |

### کارهای باقی‌ماندهٔ مرحلهٔ اول (قبل از شروع مرحلهٔ دوم انجام شود)
1. **PR** (بخش ۲).
2. **تأیید واقعی مرورگر**: روی سروری با Xvfb (یا نصب `xvfb x11vnc` در sandbox اگر RAM اجازه داد، با سرور تنها): ایجاد پروفایل از دراور → تب جدید باز شود و Chromium همان پروفایل دیده شود؛ دو پروفایل هم‌زمان؛ اجرای دستی visible و اجرای schedule‌شده hidden روی یک پروفایل نام‌دار. نتیجه را در handoff ثبت کن.
   - نکتهٔ باز: `/desktop/chrome?profile=<id>` کل دسکتاپ را نشان می‌دهد؛ اگر چند پنجره باز است، باید پنجرهٔ همان پروفایل جلو بیاید (BrowserWindowManager restore/focus) — بررسی و در صورت نیاز پیاده شود.
3. **هشدار تداخل در UI**: `findOverlaps` را در `GET /profiles` (یا Workflow Settings / Schedules) برگردان و نشان بده.
4. **ذخیرهٔ وضعیت قبل از بستن** (الزام ۷): قبل از بستن خودکار (afterRun=close و idle)، `storageState`/لیست تب‌ها را ذخیره کن تا بازیابی ممکن باشد؛ بدون افشا در لاگ.
5. **hold بعد از بستن تب**: الان تا ۳۰ دقیقه می‌ماند؛ بررسی کن با بسته شدن viewer (قطع WebSocket دسکتاپ) dependent اپراتور detach شود (hold بماند یا نه = تصمیم با کاربر؛ بپرس).
6. schedule‌های قدیمی بدون job تأخیری: گزارش «نامشخص» در UI به‌جای سکوت.

## ۴. مرحلهٔ دوم (طبق پرامپ اصلی — بعد از بند ۳)
اتصال نودها به همین زیرساخت؛ **هیچ سیستم موازی نساز**:
- تنظیمات اختصاصی نودها (Launch/Close Browser و نودهای مرورگری: پروفایل، visibility override صریح، …).
- خروجی‌های **Success / Error / Timeout** برای نودها.
- سیاست تلاش مجدد هر نود.
- نود **ادامهٔ نشست بین Workflowها**: فقط از مسیر `ProfileLeases.grant(profileLeaseId, fromOwner, toOwner, ttl)` + attach به `BrowserSessions`؛ هیچ انتقال ضمنی؛ revoke پس از پایان.
- پلن مرجع: `docs/PLAN-node-logic-v2.md` (فاز ۱.۴، ۱.۵ و فاز ۲).

## ۵. قواعد کار (از پرامپ اصلی)
- قبل از تغییر، معماری موجود را بخوان؛ بازنویسی غیرضروری نکن؛ کم‌تغییرترین راه.
- اگر بخشی ناسازگار است، اول مشکل + کم‌تغییرترین راه‌حل را بگو.
- تست‌های هم‌زمانی، رزرو، بازیابی و چرخهٔ عمر را اجرا کن (Redis واقعی).
- در پایان گزارش کامل: تغییرات، تصمیم‌ها، فایل‌ها، تست‌ها، مشکلات باقی‌مانده؛ و ادعای «تأیید شد» فقط برای چیزی که واقعاً اجرا شده.
- گزارش به فارسی.

## ۶. نقشهٔ فایل‌های مرحلهٔ اول
- جدید: `src/core/{ProfileRegistry,ProfileReservations,BrowserSessions,BrowserLifecycle,ProfileAccess,ProfileCoordinator,ProfileBrowser}.ts`، `src/Routes/profile.routes.ts`، `public/js/profile-manager.js`
- تغییر: `src/core/ProfileLease.ts` (ADMIT_LUA، hold، grant)، `src/index.ts` (worker: owner، fired/settled، afterRun، sweep، recovery)، `src/pipeline.ts` (sessions/dependents)، `src/core/ProfileManager.ts` (GC guard)، `src/Routes/user.routes.ts` (resync)، `src/core/SettingsCatalog.ts` + `PersistedSettings.ts` + `config.ts` (۳ تنظیم)، `src/core/ChromeView.ts` (`?profile=`)، `public/js/{workflow-files,views,i18n}.js`، `public/css/styles.css`، `package.json` (cron-parser)
- تست‌ها: `tests/integration/profile-{admission,routes,coordinator}.test.ts`، `tests/unit/profile-{infrastructure,manager-ui}.test.ts`
