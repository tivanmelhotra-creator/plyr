# NEXT-SESSION — از اینجا ادامه بده / Start here

> **این فایل برای جلسه‌ای نوشته شده که هیچ سابقه‌ی چتی ندارد.**
> اگر تازه شروع کرده‌ای، فقط همین فایل را کامل بخوان؛ هر چیز دیگری که لازم شود
> از داخل همین‌جا آدرس‌دهی شده است.
>
> آخرین به‌روزرسانی: **2026-08-02** · برنچ: **`genspark_ai_developer`** · PR: **#20**

---

## 0. سه خط خلاصه / TL;DR

1. دو ماموریت در جلسه‌ی قبل **تمام شد**: «مسیرهای چندگانه‌ی نود شرط» (Mission 7) و
   «نصب اکستنشن کروم فقط با پیست‌کردن لینک وب‌استور» (Mission 9).
2. کل تست‌ها سبز است: **44 فایل / 977 تست**، `tsc --noEmit` تمیز.
3. تنها ماموریت باز، **Mission 5 بخش ۲** است (value typeهای گروه‌بندی‌شده‌ی نود شرط).
   نقشه‌ی کامل و گام‌به‌گامش در `MISSIONS.md` بخش «۳. Open missions» آمده.

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
PR     : https://github.com/jalil-ahmadi2/plyr/pull/20
tsc    : ✅ clean
vitest : ✅ 44 files / 977 tests
build  : npm run build → ✅
```

### چه چیزی در این جلسه شیپ شد

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

## 3. تنها ماموریت باز: Mission 5 — بخش ۲

**عنوان:** نود شرط باید value typeهای گروه‌بندی‌شده‌ی Automa را داشته باشد.

بخش ۱ (اپراتورهای گروه‌بندی‌شده، هر ۱۶ تای Automa) **انجام شده**.
بخش ۲ باز است. نقشه‌ی دقیق با شماره‌ی فایل و ترتیب اجرا در
**`MISSIONS.md` → «## 3. Open missions» → «⬜ Part 2»** آمده. خلاصه‌اش:

| Automa value type | امروز در Aria | کار لازم |
|---|---|---|
| Value | `content` kind | ✅ پوشش داده شده |
| Element text / attribute | `source: 'text'` / `'attribute'` | قابلیت هست، باید به‌عنوان گزینه‌ی درجه‌یک در یک دراپ‌داون گروه‌بندی‌شده دیده شود |
| Element exists / visible / … | باکت `dom` اپراتورها | تصمیم بگیر که مثل Automa به دراپ‌داون value type منتقل شوند یا نه |
| **Code** | ✗ | اجرای یک عبارت JS در صفحه + دراپ‌داون Background/Active tab، با seed `return true;` |
| **Data exists** | نسبی (`is_empty`/`not_empty`) | یک value type صریح روی متغیر/expression |
| **Element visible/hidden in screen** | ✗ | چک in-viewport (`boundingBox()` ∩ viewport یا `IntersectionObserver`) — با `visible`/`hidden` فرق دارد |

**ترتیب اجرا (بک‌اند را رد نکن — قاعده‌ی R3):**

1. `public/js/ndv-model.js` — رجیستری گروه‌بندی‌شده‌ی `CONDITION_VALUE_TYPES`
2. `src/core/ConditionEngine.ts` — ورودی‌های جدید `ConditionSource` + `SOURCES` + `readFromElement`
3. `public/js/graph-serialize.js` — round-trip در `buildCondition` / `conditionToGroups` / `CONDITION_ONLY_PARAMS`
4. `public/js/actions.js` — هر پارامتر جدید را declare کن، وگرنه هنگام save دور ریخته می‌شود
5. `public/js/i18n.js` — کلیدهای fa + en (برابری‌شان تست دارد)
6. تست‌ها: model، engine و round-trip

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
