# NEXT-SESSION — از اینجا ادامه بده / Start here

> **این فایل برای جلسه‌ای نوشته شده که هیچ سابقه‌ی چتی ندارد.**
> اگر تازه شروع کرده‌ای، فقط همین فایل را کامل بخوان؛ هر چیز دیگری که لازم شود
> از داخل همین‌جا آدرس‌دهی شده است.
>
> آخرین به‌روزرسانی: **2026-08-13** · برنچ: **`genspark_ai_developer`**
> · ریپو: **تازه، روی اکانت `@tivanmelhotra-creator`** (اکانت قبلی بن شد)

---

## 0. سه خط خلاصه / TL;DR

1. **Dual Browser Mode + Element Inspector Extension** در این جلسه **تمام شد**
   (طبق مشخصات ۲۰ بخشی فارسی). سند کامل:
   `docs/uiux/20-HANDOFF-dual-browser-mode-inspector.md` ← **قبل از هر کاری روی
   حالت مرورگر یا Inspector، این را کامل بخوان**.
2. کل تست‌ها سبز است: **80 فایل / 1898 تست**، `tsc --noEmit` تمیز.
   ۹۲ تست تازه در ۴ فایل برای این قابلیت.
3. اگر ماموریت تازه‌ای می‌گیری، اول بخش ۱ (قواعد R1..R5) و بخش ۴ (تله‌های واقعی این
   سندباکس) را بخوان. جدول وضعیت ماموریت‌ها در `MISSIONS.md` بخش ۲ است.

---

## 0.1 نتیجه‌ی آدیت ۲۰۲۶-۰۸-۱۳ (این را قبل از دست‌زدن به Inspector یا دانلود بخوان)

هر دو ماموریت مرورگر دوباره و این بار **روی کد در حال اجرا** بررسی شدند. حاصل:
**دو باگ واقعی + یک هشدار اشتباه از طرف خودم**. جدول کامل در `MISSIONS.md` بخش ۶.

1. **باگ ۱ — Element Inspector هیچ‌وقت تحویل نمی‌داد.** داشبورد نود را با یک
   شناسه‌ی per-tab به شکل `ui-…` claim می‌کرد، اکستنشن با شناسه‌ی خودش `ext-…`
   submit می‌کرد، و `InspectorHub.submit` این دو را با `!==` مقایسه می‌کند →
   همیشه `stale_session`. یعنی «Confirm & Add to Node» کاملاً مرده بود.
   **درست شد**؛ تست: `tests/unit/inspector-session-handoff.test.ts` (۹ تست، با
   برگرداندن باگ **۴** تا سرخ می‌شود).
2. **گپ ۲ — اکستنشن Inspector در حالت Remote اصلاً نصب نمی‌شد.** پوشه‌ی
   `profiles/extensions` هرگز توسط چیزی ساخته/پر نمی‌شد، پس شرط «یک Inspector
   برای هر دو حالت» فقط در Local برقرار بود. **درست شد** با
   `src/core/InspectorExtension.ts` و تأیید در یک کرومیوم headed واقعی.
3. **~~باگ ۳~~ — پس گرفته شد.** ادعا کرده بودم قفسه‌ی دانلود داشبورد نصف نام‌ها را
   از دست می‌دهد (۱۲/۲۴). **کد از اول درست بود**؛ آن عدد را probe‌ای گرفته بود که
   کرومیوم را بدون محیط محصول اجرا می‌کرد. محصول در **هر دو** مسیر با
   `withUtf8Locale(process.env)` اجرا می‌شود و با همان محیط نتیجه **۲۴/۲۴** است.
   شرح کامل: `docs/MEASURED-DECISIONS.md` § «The 12/24 that never existed».

> درس قابل انتقال، چون دو بار در همین جلسه تکرار شد: **probe هم یک برنامه است.**
> اگر probe جور دیگری از محصول اجرا شود، چیز دیگری را اندازه گرفته. پیش از آنکه
> یک اندازه‌گیری اجازه پیدا کند کدِ shipped را «باگ‌دار» بنامد، باید نشان داده شود
> که روی **همان مسیر کد** اجرا می‌شود؛ و پیش از آنکه یک fix «لازم» شمرده شود، باید
> با برگرداندنش تستی سرخ شود.

---

## 1. قواعد ثابت پروژه (این‌ها را نقض نکن)

مرجع کامل: `MISSIONS.md` بخش ۰. خلاصه:

| کد | قاعده |
|----|-------|
| **R1** | برای تنظیم آپشن‌های هر نود، حتماً منطق [Automa](https://github.com/automaapp/automa) را مرجع بگیر. |
| **R2/R3** | هیچ کنترلی در UI نساز که در بک‌اند اثری ندارد. «UI دروغین» ممنوع. |
| **R4** | کار روی `genspark_ai_developer`؛ بعد از هر تغییر commit؛ قبل از PR رویٔ `origin/main` ریبیس؛ همه‌ی کامیت‌ها را در **یک** کامیت squash کن؛ force-push؛ PR را باز/به‌روز کن و **لینک PR را به مالک بده**. |
| **R5** | JS ساده و CSP-safe (بدون فریم‌ورک/CDN/inline script/eval)؛ برابری i18n فارسی+انگلیسی؛ سبز بودن `tsc --noEmit` + `node --check` + `vitest run`. |

### R5 — نکته‌ی خط‌پایان (line endings)
- `public/**` → **LF**
- `src/**` → در حالت کلی **CRLF**، اما فایل‌هایی که در این جلسه لمس شدند
  (`src/core/ChromeExtensions.ts`, `src/core/RealChrome.ts`, `src/Routes/browser.routes.ts`)
  **LF** هستند و همان‌طور بمانند. قبل از ادیت با `file <path>` چک کن.

---

## 2. وضعیت دقیق الان / Exact current state

```
branch : genspark_ai_developer
PR     : https://github.com/jalil-ahmadi2/plyr/pull/38
tsc    : ✅ clean
vitest : ✅ 78 files / 1871 tests
build  : npm run build → ✅
open missions : هیچ (Dual Browser Mode + Inspector آخرینشان بود)
```

### چه چیزی در این جلسه شیپ شد

**Dual Browser Mode + Element Inspector Extension**
سند: `docs/uiux/20-HANDOFF-dual-browser-mode-inspector.md` ← **کامل بخوان**

دو قابلیت که یک درز مشترک دارند:

1. **حالت دوگانه‌ی مرورگر** — اتوماسیون یا روی مرورگر **سرور** اجرا می‌شود
   (Remote، بدون هیچ تغییر) یا روی **کروم خود کاربر** (Local، جدید).
   Remote حذف نشد و Local جایگزینش نیست — همان چیزی که مشخصات صریحاً خواسته بود.
2. **Element Inspector** — یک **افزونه‌ی MV3 کروم** که المان را از صفحه‌ی واقعی
   برمی‌دارد و داده‌اش را در نودی که کاربر باز کرده می‌نشاند. **یک** Inspector
   برای هر دو حالت، نه دو تا.

سه نکته‌ای که اگر ندانی وقت تلف می‌کنی:

- **تونل معکوس است.** عامل (agent) از دستگاه کاربر به بیرون زنگ می‌زند
  (WSS/443)؛ پورت CDP روی `127.0.0.1` می‌ماند و هیچ‌وقت expose نمی‌شود. دلیل:
  CDP هیچ authentication ندارد، و NAT/CGNAT اتصال ورودی را برای بیشتر کاربران
  غیرممکن می‌کند.
- **موتور اتوماسیون دوم ساخته نشد.** Playwright سمت سرور می‌ماند و از داخل تونل
  کار می‌کند، پس همه‌ی ~۴۰ اکشن نود در هر دو حالت بدون تغییر کار می‌کنند. تنها
  جایی که از حالت‌ها خبر دارد `src/core/BrowserAdapter.ts` است.
- **`browserShared` را دست نزن.** مسیرهای cleanup قبلاً `browserContext` را
  بی‌قید و شرط می‌بستند؛ در حالت Local **آن مرورگر خود کاربر است**. سه گارد
  روی سه نقطه‌ی close هست (`grep -c browserShared src/pipeline.ts` = 6). بدون
  آن‌ها، پایان یک workflow کروم کاربر را با همه‌ی تب‌هایش می‌بست.

### شیپ‌شده‌های جلسات قبل (برای زمینه)

**Mission 7 — نود شرط با چند مسیر اولویت‌دار**
سند: `docs/uiux/17-HANDOFF-condition-paths.md`

**Mission 9 — نصب اکستنشن از روی لینک Chrome Web Store**
سند: `docs/uiux/18-HANDOFF-webstore-extension-install.md` ← **کامل بخوان اگر روی این بخش کار داری**

خواسته‌ی دقیق مالک این بود:

> «من فقط نیازه که براش ادرس پلاگین رو بدم نصبش کنه خودش
> `https://chromewebstore.google.com/detail/j2team-cookies/okpidcojinmlaakglciglbpcpajaibco`
> و بتونه پلای رایت ازش استفاده کنه»

یعنی: دردسر noVNC / remote desktop حذف شود. حالا کاربر لینک را در پنل
**Real Chrome → Extensions** پیست می‌کند، سرور خودش `.crx` را دانلود، باز و نصب می‌کند،
و Playwright با همان اکستنشن بالا می‌آید.

فایل‌های Mission 9:

| فایل | کار |
|------|-----|
| `src/core/ChromeExtensions.ts` | هسته: پارس لینک، خواندن CRX3، انتخاب کلید درست، pin کردن کلید، حل `__MSG_` ها، دانلود و نصب |
| `src/core/RealChrome.ts` | `loadedExtensions()` حالا `runtimeId` می‌دهد و کلید pin شده را ترجیح می‌دهد |
| `src/Routes/browser.routes.ts` | `POST /browser/extensions/store` |
| `public/js/real-chrome.js` | فیلد لینک + دکمه‌ی Install (اینتر هم کار می‌کند)، نمایش ID، تنزل بخش remote desktop |
| `public/js/i18n.js` | ۷ کلید جدید `rc.*` در فارسی و انگلیسی |
| `public/css/styles.css` | `.rc-ext-id`, `.rc-store`, `.rc-input` |
| `tests/unit/webstore-install.test.ts` | ۲۸ تست آفلاین |

---

## 3. ✅ Mission 5 بخش ۲ — انجام شد (هیچ ماموریت بازی نمانده)

**عنوان:** نود شرط باید value typeهای گروه‌بندی‌شده‌ی Automa را داشته باشد.

بخش ۱ (اپراتورهای گروه‌بندی‌شده، هر ۱۶ تای Automa) قبلاً انجام شده بود.
بخش ۲ در این جلسه بسته شد. **سند کامل و مرجع:
`docs/uiux/19-HANDOFF-condition-value-types.md`** — اگر روی نود شرط کار داری،
کاملش را بخوان.

| Automa value type | نتیجه در Aria |
|---|---|
| Value | از قبل پوشش داشت — kind `content` |
| Element text / attribute | از قبل پوشش داشت — `source: 'text'` / `'attribute'` |
| Element exists / visible / hidden | در همان باکت **اپراتور** `dom` ماند (تصمیم ۱ پایین) |
| **Code** | ✅ جدید — `source: 'code'`؛ اسنیپت JS در صفحه اجرا می‌شود و **مقدار برگشتی‌اش** سمت چپ مقایسه است |
| **Data exists** | ✅ پوشش داده شد، **عمداً بدون کنترل جدید** (تصمیم ۲ پایین) |
| **Element visible / hidden in screen** | ✅ اپراتورهای جدید `in_screen` / `not_in_screen` با `IntersectionObserver` |

**دو تصمیمی که این ماموریت باید می‌گرفت:**

1. **آیا اپراتورهای `dom` مثل Automa به دراپ‌داون value type منتقل شوند؟ نه.**
   تفکیک ما این است: `checkKindOf` مسیر اجرا را انتخاب می‌کند و اپراتور نحوه‌ی
   مقایسه را. انتقالشان یعنی یک انتخاب در دو دراپ‌داون تکرار شود — همان کنترل
   تکراری که قاعده‌ی R3 برای جلوگیری از آن وجود دارد.
2. **آیا «Data exists» value type مستقل لازم دارد؟ نه، دو بار موجود است.**
   `is_truthy`/`is_falsy` و `is_empty`/`not_empty` هر دو همین را جواب می‌دهند و با
   همه‌ی kindها ترکیب می‌شوند: **`code` → `is_truthy` خودِ «Data exists» است.**

**هرچه ساخته شد، اول اندازه‌گیری شد** — `tools/probe-condition-value-types.js`
با ۲۳ چک روی کرومیوم واقعی. **۴ تا از ۷ یافته‌اش بی‌صدا شکست می‌خورند** (شاخه‌ی
اشتباه، نه خطا)، پس پروب کامیت شده و دور ریخته نشده. مهم‌ترین‌ها:

* `page.evaluate('return true;')` **خطا می‌دهد** (*Illegal return statement*) و
  `return true;` دقیقاً seed خودِ Automa است → `looksLikeStatement()`.
* `locator.evaluate('<function source>')` رشته را **expression** حساب می‌کند و
  `undefined` می‌دهد → آبزرور باید **تابع واقعی** پاس داده شود.
* `in_screen` مترادف `visible` **نیست**: عنصری ۴۰۰۰px پایین‌تر از تای صفحه
  `isVisible() === true` می‌دهد.
* اسنیپت بی‌پایان (`while (true) {}`) صفحه را **برای همیشه** قفل می‌کند →
  race با تایم‌اوت، و تایم‌اوت باید «شرط برقرار نیست» بدهد نه retry.
* یافته‌ی ۵ **نقشه‌ی خودِ `MISSIONS.md` را باطل کرد**: تست
  `boundingBox()` ∩ viewport برای عنصری که داخل کانتینر `overflow:hidden` از
  دید خارج شده، IN-VIEW گزارش می‌کند؛ یک مستطیل نمی‌تواند کلیپ‌شدن توسط
  اجداد را حساب کند. `IntersectionObserver` درست جواب می‌دهد.

سه تیونبل در `src/config.ts` (+ `.env.example`): `CONDITION_IN_SCREEN_TIMEOUT_MS`،
`CONDITION_CODE_MAX_LENGTH`، `CONDITION_CODE_TIMEOUT_MS`.

**نکته‌ی مهم برای جلسه‌ی بعد:** «check kind» هرگز **ذخیره نمی‌شود** — از خودِ
فیلدهای row استنتاج می‌شود (`checkKindOf` / `applyCheckKind`). به همین دلیل
`params.groups` ورک‌فلوهای ذخیره‌شده **بایت‌به‌بایت** دست‌نخورده ماند. `codeContext`
هم به همین خاطر عمداً در `blankRow()` نیست.

---

## 4. یادداشت‌های اضافه / Incidental findings (این‌ها را دوباره کشف نکن)

این‌ها چیزهایی است که در عمل به آن‌ها خوردیم. هرکدام یک تله‌ی واقعی است.

### 4.1 💥 core dump ریشه‌ی مخزن را پر می‌کند
یک بار یک فایل **`core` به حجم ۵۲۳ مگابایت** در ریشه‌ی مخزن پیدا شد (کرش کروم/نود).
روی این سندباکس که **فقط ۹۸۵ مگابایت RAM** دارد، همین باعث شد
`npx vitest run` که معمولاً ۲۴ ثانیه است، بعد از **۴۲۰ ثانیه** تایم‌اوت کند.

- ✅ رفع شد: `core` و `core.*` به `.gitignore` اضافه شد.
- اگر تست‌ها بی‌دلیل کند/معلق شدند، **اول** این را چک کن:
  ```bash
  cd /home/user/webapp && ls -la core 2>/dev/null; free -m | head -2
  ```
- روی این باکس تست را تک‌فورکی اجرا کن تا OOM نشود:
  ```bash
  npx vitest run --pool=forks --poolOptions.forks.maxForks=1
  ```

### 4.2 فایل `.env` با خط‌پایان CRLF است
`sed 's/^API_TOKEN=$/.../'` **بی‌صدا شکست می‌خورد** چون انتهای خط `\r` دارد. به‌جایش:
```bash
perl -pi -e 's/^API_TOKEN=\r?$/API_TOKEN=aria_demo_token_2026\r/' .env
```

### 4.3 CRX3 می‌تواند چند کلید عمومی داشته باشد — اولی معمولاً غلط است
برای J2TEAM Cookies سه proof key وجود داشت. برداشتن «اولی» ID غلط
`lfoeajgcchlidpicbabpmckkejpckcfb` را می‌داد. ID درست
`okpidcojinmlaakglciglbpcpajaibco` است و فقط با تطبیق‌دادن کلید با
`crx_id` داخل `signed_header_data` (فیلد ۱۰۰۰۰) به‌دست می‌آید.
اندازه‌گیری واقعی:
```
proof keys found: 3
crx_id (signed) : okpidcojinmlaakglciglbpcpajaibco
  key[0] len=294 id=lfoeajgcchlidpicbabpmckkejpckcfb
  key[1] len=294 id=okpidcojinmlaakglciglbpcpajaibco   <-- MATCH
  key[2] len=91  id=gbphpckglpmphemnalmbpocejhmmjlae
```

### 4.4 ID اکستنشن unpacked از **مسیر پوشه** می‌آید
یعنی با هر redeploy عوض می‌شود و آدرس‌های `chrome-extension://<id>/…` که
کاربر در ورک‌فلو ذخیره کرده می‌شکنند. به همین دلیل هنگام نصب از استور،
`manifest.key` تزریق می‌شود تا ID پایدار و برابر ID رسمی وب‌استور بماند.

### 4.5 `var(--accent)` در این استایل‌شیت وجود ندارد
`tests/unit/node-toolbox.test.ts` (حدود خط ۵۹۸) توکن‌های ممنوع را asserts می‌کند:
`var(--accent`، `var(--text-mute`، `var(--surface-2`، `var(--text-disabled`.
**هر CSS جدیدی که به انتهای `styles.css` اضافه کنی داخل همان اسلایس تست می‌افتد.**
از `var(--primary)` / `var(--primary-soft)` / `var(--text-dim)` استفاده کن.

### 4.6 پوشه‌ی `_metadata` مشکلی ندارد
فرض کرده بودم کروم پوشه‌های شروع‌شده با `_` را رد می‌کند؛ تست زنده نشان داد
اکستنشن بدون مشکل لود می‌شود. **کد اضافه برای حذفش ننویس.**

### 4.7 کلیدهای واقعی localStorage
برای اسکریپت‌های اسکرین‌شات/تست: زبان `ab_lang`، توکن `ab_api_key`.

### 4.8 اکستنشن فقط هنگام launch خوانده می‌شود
Playwright باید `launchPersistentContext` + `ignoreDefaultArgs: ['--disable-extensions']`
+ **هر دوی** `--disable-extensions-except=` و `--load-extension=` را بدهد.
بعد از نصب یک اکستنشن، مرورگر باید **restart** شود؛ API همین را در
`restartRequired` برمی‌گرداند و UI هم پیام می‌دهد.

### 4.9 PM2 و پرچم اشتباه
`--no-autorestart=false` یک اپ قلابی `/usr/bin/false` می‌سازد. اگر دیدی، حذفش کن.

---

## 5. بالا آوردن پروژه / Bring the stack up

```bash
cd /home/user/webapp

# 1) وابسته‌های سیستمی (اگر سندباکس تازه است)
sudo apt-get install -y redis-server xvfb zip

# 2) سرویس‌های جانبی
redis-server --daemonize yes
Xvfb :99 -screen 0 1920x1080x24 > /dev/null 2>&1 &

# 3) .env  (فایل CRLF است — بند ۴.۲ را ببین)
#    PORT=3000
#    API_TOKEN=aria_demo_token_2026
#    REAL_CHROME_ENABLED=true
#    REAL_CHROME_HEADLESS=false
#    DEFAULT_HEADLESS=true
#    REAL_CHROME_DISPLAY=:99

# 4) بیلد و اجرا
#    ⚠️ نقطه‌ی ورود dist/index.js است، نه dist/server.js
npm run build
npx pm2 start dist/index.js --name aria-automate
npx pm2 logs aria-automate --nostream

# 5) سلامت
curl -s http://localhost:3000/health
```

بعد با ابزار `GetServiceUrl` روی پورت **3000** آدرس عمومی را بگیر و به مالک بده
(خواسته‌ی همیشگی: «لینکش رو هم برام بفرس»).

⚠️ `ecosystem.config.js` روی cluster×4 است و روی این باکس ۹۸۵ مگابایتی OOM می‌دهد.
از همان دستور fork-mode بالا استفاده کن.

---

## 6. تست دستی فیچر جدید (Mission 9)

از UI:
1. مرورگر → دکمه‌ی **Real Chrome** → بخش **Extensions**
2. لینک را پیست کن و **Install** بزن (اینتر هم کار می‌کند):
   `https://chromewebstore.google.com/detail/j2team-cookies/okpidcojinmlaakglciglbpcpajaibco`
3. مرورگر را **restart** کن تا لود شود.

از API:
```bash
curl -s -X POST http://localhost:3000/browser/extensions/store \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: aria_demo_token_2026' \
  -d '{"url":"https://chromewebstore.google.com/detail/j2team-cookies/okpidcojinmlaakglciglbpcpajaibco"}'
```

هر دو شکل لینکی که مالک داده بود کار می‌کند، و همین‌طور خود ID خالی
(۳۲ حرف در بازه‌ی `a`..`p`).

---

## 7. چک‌لیست پایان هر کار (R4)

```bash
npx tsc --noEmit
node --check public/js/<فایل‌های لمس‌شده>.js
npx vitest run --pool=forks --poolOptions.forks.maxForks=1

git add -A && git commit -m "type(scope): description"
git fetch origin main && git rebase origin/main      # تعارض؟ اولویت با کد ریموت
git reset --soft $(git merge-base HEAD origin/main) && git commit -m "پیام جامع"
git push -f origin genspark_ai_developer
# سپس PR را به‌روز کن و **لینکش را به مالک بده**
```

---

## 8. نقشه‌ی اسناد / Where to read next

| اگر روی این کار می‌کنی | این را بخوان |
|---|---|
| هر چیزی — نقطه‌ی شروع | `MISSIONS.md` |
| نصب اکستنشن از وب‌استور | `docs/uiux/18-HANDOFF-webstore-extension-install.md` |
| مسیرهای چندگانه‌ی نود شرط | `docs/uiux/17-HANDOFF-condition-paths.md` |
| Element picker / مرورگر واقعی | `docs/uiux/15-…` و `16-…` |
| پایه‌ی دیزاین NDV | `HANDOFF_NEXT_SESSION.md` |
