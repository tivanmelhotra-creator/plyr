# HANDOFF — وضعیت کار و کارهای باقی‌مانده

> این فایل برای جلسهٔ بعدی نوشته شده که **بدون سابقهٔ چت** شروع می‌شود.
> هدف: مدل بعدی بدون هیچ context قبلی بفهمد چه چیزی انجام شده، چه چیزی نمانده، و دقیقاً از کجا باید ادامه بدهد.
>
> آخرین به‌روزرسانی: 2026-08-02 · شاخه: `genspark_ai_developer` · ریموت: `jalil-ahmadi2/plyr`

---

## 0. TL;DR — از کجا ادامه بدهم؟

سه کار باقی مانده، به‌ترتیب اولویت:

1. **باگ #2 — کلیک روی فضای خالی canvas باید لیست نودها را باز کند.** (پیاده‌سازی نشده — [بخش ۴](#4-باگ-2--کلیک-روی-فضای-خالی-canvas))
2. **باگ #3 — دابل‌کلیک روی نود باید NDV را باز کند.** (در sandbox کار می‌کند؛ نیاز به fallback مقاوم — [بخش ۵](#5-باگ-3--دابل‌کلیک--ndv))
3. موارد اختیاری/تکمیلی Real Chrome — [بخش ۶](#6-موارد-باز-و-بدهی-فنی-real-chrome)

هرچه مربوط به **Real Chrome** است تمام شده، تست‌شده و در همین PR است.

---

## 1. تاریخچهٔ درخواست کاربر (به ترتیب)

کاربر سه باگ گزارش کرد:

| # | گزارش | وضعیت |
|---|-------|-------|
| 1 | مرورگر شبیه‌سازی‌شده (مودالی که با آیکن crosshair / Element Picker باز می‌شود، مسیر `/browser/ws` + `requestPick()`) سایت‌ها را بالا نمی‌آورد | ✅ حل شد — PR #19 |
| 2 | کلیک روی فضای خالی canvas در فلو-ادیتور باید لیست نودها را نشان بدهد | ❌ انجام نشده |
| 3 | دابل‌کلیک روی نود باید NDV را باز کند | ⚠️ در build سندباکس کار می‌کند؛ محیط کاربر بازتولید نشد |

بعد کاربر **تغییر جهت مهمی** داد (نقل‌قول عیناً):

> «من متوجه شدم که مرور گر شبیه سازی شده نمیتونه مقصد ما باشه — علت: ما نیازع که از پلاگین هایی که برای مرورگر کروم هست
> استفاده کنیم یعنی عملا ما به یک مرورگر ولقعی کروم نیاز داریم … یک پلاگین ذخیره کوکی هست که من همیشه استفاده میکنم که
> هربار با مرورگر های مختلف به جای لاگین مجدد از فایل استخراج شده کوکیم استفاده میکنم … یعنی ما نیاز داریم از طریق یک
> پورتی مرورکر کرومیومی که پلی رایت موقع اتوماسیون بالا میاره رو بالا بیاریم»

یعنی: **کروم واقعی + امکان نصب افزونهٔ کروم + در دسترس بودن روی یک پورت.** این همان چیزی است که در این PR ساخته شده.

---

## 2. آنچه ساخته شد (Real Chrome) — ✅ کامل

مستندات کاربری در `README.md` بخش «مرورگر واقعی Chrome». این‌جا فقط نکات مهندسی.

### ۲.۱ فایل‌های جدید

| فایل | نقش |
|------|-----|
| `src/core/RealChrome.ts` | singleton مرورگر پایدار: `launchPersistentContext` + افزونه + پورت DevTools + اعمال کوکی + `unpackedExtensionId()` |
| `src/core/ChromeExtensions.ts` | کشف/نصب/حذف افزونه، تبدیل CRX→ZIP، `extensionLaunchArgs()` |
| `src/core/CookieImport.ts` | پارسر خالص فرمت‌های کوکی + `mergeIntoStorageState()` |
| `src/core/Desktop.ts` | سوپروایزر Xvfb + x11vnc + websockify/noVNC |
| `src/Routes/browser.routes.ts` | REST API زیر `/browser/*` |
| `public/js/real-chrome.js` | پنل UI (`window.RealChromePanel`) |
| `scripts/desktop.sh` | `install \| start \| stop \| restart \| status` |
| `tests/unit/cookie-import.test.ts` | ۲۵ تست |
| `tests/unit/chrome-extensions.test.ts` | ۲۴ تست |
| `tools/probe-real-chrome.js` | probe بک‌اند (۱۱ چک) |
| `tools/probe-real-chrome-ui.js` | probe UI با Playwright (۱۳ چک) |
| `tools/patch-*.py` | اسکریپت‌های idempotent برای پچ‌کردن فایل‌های CRLF |

### ۲.۲ فایل‌های تغییر‌یافته

`src/config.ts` (۹ کلید `REAL_CHROME_*` + ۵ کلید `DESKTOP_*`) ·
`src/Routes/index.ts` · `src/index.ts` (mount زیر auth + blockCheck) ·
`src/core/GlobalBrowser.ts` (شاخهٔ RealChrome + گاردهای shared-context) ·
`src/core/LiveBrowser.ts` (اجازهٔ اسکیم `chrome-extension://` و `about:`) ·
`public/index.html` · `public/js/browser-view.js` · `public/js/i18n.js` (۳۳ رشتهٔ `rc.*` در fa و en) ·
`public/css/styles.css` · `.env.example` · `tests/unit/icons.test.ts` · `README.md`

### ۲.۳ نکاتی که اگر ندانی وقت تلف می‌کنی (⚠️ مهم)

1. **`--load-extension` بی‌صدا بی‌اثر می‌شود** مگر این‌که هر سه با هم باشند:
   `--load-extension=<dirs>` + `--disable-extensions-except=<dirs>` + `ignoreDefaultArgs: ['--disable-extensions']`.
   هیچ خطایی هم نمی‌دهد — فقط افزونه لود نمی‌شود.
2. **افزونه فقط در حالت headed لود می‌شود** → روی سرور حتماً Xvfb (`DISPLAY=:99`).
3. **شناسهٔ افزونهٔ unpacked قطعی است:** `sha256(absolute path)` → ۳۲ کاراکتر hex اول → هر nibble با `0→a … f→p`.
   پس بدون پرسیدن از کروم می‌شود `chrome-extension://<id>/popup.html` ساخت.
4. **ترفند popup-as-a-tab:** popup افزونه فقط یک صفحهٔ افزونه است؛ ناوبری یک tab به آدرس بالا همان UI را با
   دسترسی کامل (`chrome.cookies` و …) رندر می‌کند. به همین دلیل VNC برای افزونهٔ کوکی لازم **نیست**.
5. **context مشترک نباید بسته شود:** در `GlobalBrowser.saveAndCloseContext` و `closeContext` گارد
   `if (RealChrome.isSharedContext(context)) return;` گذاشته شده.
6. **CRX:** CRX2 = `Cr24|ver(4)|pubkeyLen(4)|sigLen(4)|pubkey|sig|ZIP` ، CRX3 = `Cr24|ver(4)|headerLen(4)|protobuf|ZIP`.
7. **کوکی:** `addCookies()` all-or-nothing است → اول دسته‌ای، بعد در صورت خطا تک‌تک retry.
   `sameSite: no_restriction|unspecified`، `expirationDate` اعشاری/میلی‌ثانیه‌ای، `SameSite=None` نیازمند `Secure`.

### ۲.۴ قواعد سبکِ این ریپو (رعایت نکنی تست قرمز می‌شود)

- **بدون هیچ ایموجی/دینگ‌بت در کد فرانت‌اندِ shipped.** `tests/unit/icons.test.ts` این را چک می‌کند.
  همهٔ آیکن‌ها از `window.Icons.svg(name, { size })`. (README می‌تواند ایموجی داشته باشد، مشکلی نیست.)
- **CSP سخت‌گیرانه:** `script-src 'self'` — نه `eval`، نه inline handler. رویدادها فقط `addEventListener`.
- **توکن‌های CSS موجود:** `--bg`, `--bg-elev`, `--bg-elev-2`, `--surface-0`, `--border`, `--border-strong`,
  `--text`, `--text-dim`, `--text-faint`, `--primary`, `--info`, `--success`, `--warn`, `--danger`,
  `--radius`, `--radius-sm`, `--radius-lg`, `--shadow`.
  **وجود ندارند:** `--bg-elev-1`، `--ok`، `--border-faint` (یک‌بار همین باعث شد پنل کاملاً شفاف رندر شود).
- **Line ending:** بیشتر `src/**` با **CRLF** است (`config.ts`, `GlobalBrowser.ts`, `index.ts`, `Routes/*`).
  اما `public/js/**`، `src/core/LiveBrowser.ts`، `src/core/BrowserStreamServer.ts` و همهٔ فایل‌های جدید **LF** هستند.
  برای پچ‌کردن فایل‌های CRLF از اسکریپت‌های پایتونی `tools/patch-*.py` (byte-level و idempotent) استفاده کن.
- **i18n:** هر رشتهٔ UI باید در `public/js/i18n.js` هم در `fa` و هم در `en` باشد (RTL هم پشتیبانی می‌شود).
- **سرور را با `nohup &` بالا نیاور** — وقتی ابزار Bash برمی‌گردد SIGTERM می‌گیرد.
  حتماً `run_in_background: true` ابزار Bash.

---

## 3. وضعیت build / test در لحظهٔ نوشتن این فایل

```
npm run build      → موفق (بدون خطا)
npx tsc --noEmit   → تمیز
npx vitest run     → 42 فایل / 920 تست سبز  (قبل از این کار 871 بود؛ +49)
node tools/probe-real-chrome.js     → 11/11
node tools/probe-real-chrome-ui.js  → 13/13
```

تأیید end-to-end با Chrome/141.0.7390.37: افزونه لود شد، popup به‌صورت tab رندر شد و `chrome.cookies` کار کرد،
پورت DevTools روی 9222 جواب داد، ورود کوکی هم روی مرورگر زنده اعمال شد و هم در پروفایل ذخیره شد، و
`example.com` واقعاً کوکی import‌شده را ارسال کرد.

---

## 4. باگ #2 — کلیک روی فضای خالی canvas

**خواسته:** کلیک (نه درگ) روی فضای خالی بوم، پالت/لیست نودها را باز کند.

**فایل:** `public/js/flow-editor.js`

**نقشهٔ کد (خطوط تقریبی — قبل از ویرایش دوباره چک کن):**

| نقطه | خط تقریبی | توضیح |
|------|-----------|-------|
| `attachCanvasHandlers()` | ~3590 | `mousedown` روی بوم |
| گاردِ hit-test فعلی | داخل همان | `if (ev.target !== dom.canvas && ev.target !== dom.svg && ev.target !== dom.world) return;` |
| رفتار فعلی | | `Shift` → box-select ، در غیر این‌صورت → pan |
| `openAddPalette({ world, from, at })` | — | باز کردن پالت افزودن نود |
| `openAddPaletteForSelection(at)` | — | |
| `closeAddPalette()` | — | |
| کلاس ریشهٔ پالت | — | `.fe-addnode` |
| `Tab` → باز کردن پالت | ~3775 | نمونهٔ فراخوانی آماده |
| هندلرهای کارت نود | 1055 click / 1061 dblclick / 1067 contextmenu | |
| `applySelectionPaint()` | 1362 | |
| `selectNode()` | 2353 | |
| `openNdv(id)` | 1816 | |

**راه‌حل پیشنهادی (بدون شکستن pan و box-select):**

1. داخل `attachCanvasHandlers()`، در `mousedown` مختصات شروع (`startX/startY`) و `Date.now()` را نگه دار.
2. در `mouseup` (همان هندلری که pan را تمام می‌کند):
   - اگر `Shift` یا box-select فعال بوده → کاری نکن.
   - اگر جابه‌جایی کل کمتر از حدود **۴ پیکسل** بود و مدت کمتر از ~۵۰۰ms → این «کلیک» است، نه «درگ».
3. در آن حالت:
   - اگر پالت باز است → `closeAddPalette()` (رفتار toggle، طبیعی‌تر است).
   - وگرنه نقطهٔ کلیک را به مختصات world تبدیل کن (همان تابع تبدیلی که pan/zoom استفاده می‌کند)، به grid اسنپ کن و
     `openAddPalette({ world: snapped, at: { x: ev.clientX, y: ev.clientY } })` را صدا بزن.
4. حواست باشد اگر انتخابی وجود دارد، کلیک روی فضای خالی طبق رفتار قبلی باید انتخاب را هم پاک کند
   (ترتیب: اول deselect، بعد باز کردن پالت) — یا اگر مزاحم بود، فقط وقتی چیزی انتخاب نیست پالت را باز کن.
5. **دابل‌کلیک نباید دوبار پالت باز کند** — با `detail === 1` فیلتر کن یا در `dblclick` پالت را ببند.

**تست دستی:** بوم را درگ کن (نباید پالت باز شود) · یک‌بار کلیک کن (باید باز شود) · دوباره کلیک (باید بسته شود) ·
`Shift`+درگ (box-select سالم بماند).

---

## 5. باگ #3 — دابل‌کلیک → NDV

هندلر در `public/js/flow-editor.js` خط ~1061 وجود دارد و در build سندباکس **کار می‌کند** (با probe تأیید شد).
محیطِ خرابِ کاربر بازتولید نشد.

**fallback پیشنهادی (مقاوم‌سازی):** در هندلر `click` کارت نود (خط ~1055)، `lastClick = { nodeId, ts }` را نگه دار؛
اگر کلیک بعدی روی **همان `nodeId`** و در فاصلهٔ کمتر از ~۳۵۰ms بود، خودت `openNdv(id)` را صدا بزن.
این حالت‌هایی را پوشش می‌دهد که رویداد نیتیو `dblclick` به‌خاطر re-render شدن کارت بین دو کلیک، یا به‌خاطر
touch/pen، اصلاً شلیک نمی‌شود. مراقب باش دوبار باز نشود (بعد از باز کردن `lastClick` را ریست کن).

---

## 6. موارد باز و بدهی فنی (Real Chrome)

اینها **مسدودکننده نیستند** ولی خوب است ثبت شوند:

1. **`profiles/` در `.gitignore` است** — افزونهٔ نمونهٔ `profiles/extensions/cookie-tool/` (یک افزونهٔ MV3 دمو برای تست)
   کامیت نمی‌شود. اگر برای تست لازم شد، دوباره بساز (manifest MV3 با permission `cookies` + `popup.html` + `popup.js`).
2. **`REAL_CHROME_DEBUG_BIND=0.0.0.0` هیچ احراز هویتی ندارد** — پروتکل CDP خودش auth ندارد.
   اگر قرار است از بیرون در دسترس باشد، باید یک reverse-proxy با توکن جلویش گذاشته شود. الان فقط با هشدار در README پوشش داده شده.
3. **`DESKTOP_VNC_PASSWORD` خالی = VNC بدون رمز.** در UI هشدار داده می‌شود ولی جلوی اجرا گرفته نمی‌شود.
4. **آپلود افزونه به `unzip` سیستمی وابسته است** (`unzip -o -qq`). اگر روی image بدون unzip اجرا شود fail می‌کند؛
   یا به Dockerfile اضافه شود یا با یک کتابخانهٔ unzip در Node جایگزین شود.
5. **امضای CRX3 اعتبارسنجی نمی‌شود** — فقط هدر strip می‌شود. برای فایل‌های نامعتبر ممکن است ZIP خراب بدهد.
6. **بدون health-check دوره‌ای برای کروم** — اگر کروم بیرون از برنامه کرش کند، تا اولین درخواست بعدی متوجه نمی‌شویم.
   `RealChrome` موقع درخواست، context قطع‌شده را دوباره بالا می‌آورد، ولی recovery پیش‌دستانه ندارد.
7. **مستندات `docs/API.md` و `docs/openapi.yaml` هنوز `/browser/*` را ندارند.** README دارد.
8. **بدون تست integration برای `browser.routes.ts`** — پوشش فعلی، unit روی پارسرها + دو probe دستی است.
9. **Dockerfile هنوز Xvfb/x11vnc/novnc ندارد** — حالت Real Chrome داخل image فعلی روی سرور بدون صفحه‌نمایش کار نمی‌کند.

---

## 7. دستورهای مفید

```bash
# build + تست
npm run build && npx vitest run

# سرور (حتماً با run_in_background در ابزار Bash)
DISPLAY=:99 node dist/index.js

# دسکتاپ مجازی
sudo ./scripts/desktop.sh install
./scripts/desktop.sh start && ./scripts/desktop.sh status

# probeها
node tools/probe-real-chrome.js
node tools/probe-real-chrome-ui.js

# چک کردن پورت DevTools
curl -s http://127.0.0.1:9222/json/version
```

**سرویس‌های محیط توسعه:** Redis روی 6379 · Xvfb `:99` · x11vnc 5900 · noVNC 6080 · اپ روی 3000 · CDP روی 9222.

---

## 8. یادداشت‌های محیطی (`.env` که gitignore است)

مقادیری که در سندباکس برای تست ست شده بودند:

```bash
REAL_CHROME_ENABLED=true
REAL_CHROME_HEADLESS=false
REAL_CHROME_DISPLAY=:99
REAL_CHROME_DEBUG_PORT=9222
REAL_CHROME_USER_DATA_DIR=./profiles/chrome-profile
REAL_CHROME_EXTENSIONS_DIR=./profiles/extensions
```

⚠️ `scripts/desktop.sh` موقع source کردن `.env` باید CRLF را حذف کند — اگر `.env` با CRLF ذخیره شود،
مقدار `:99\r` می‌شود و Xvfb بالا نمی‌آید. این در اسکریپت با `sed 's/\r$//'` هندل شده؛ اگر جایی دیگر `.env` را
source کردی همین را رعایت کن.
