# HANDOFF — Executions tab, Connections tab, Filter panel + the remaining backlog

> **این فایل برای یک جلسه‌ی کاملاً تازه و بدون سابقه‌ی چت نوشته شده.**
> اگر تازه شروع کرده‌ای: **همین فایل را کامل بخوان**، بعد در صورت نیاز به سه
> سند قبلی مراجعه کن (فهرست در بخش ۹). این فایل خودکفاست: هر تصمیمی که گرفته
> شده، دلیلش، و هر کاری که مانده با لنگر خط‌به‌خط اینجا هست.

| | |
|---|---|
| **برنچ** | `genspark_ai_developer` (پایه: `origin/main` @ `145d42a`) |
| **تاریخ نگارش** | 2026-07-28 |
| **منبع حقیقت دیزاین** | `docs/uiux/workspace-overview.{webp,md}` + پنج spec دیگر در `docs/uiux/` |
| **وضعیت** | ✅ سبز. `npx tsc --noEmit` بی‌خروجی · `npx vitest run` → **34 فایل / 614 تست پاس** |
| **دو کامیت این جلسه** | `86793c6` تست‌های integration · `24c19c9` سه بخش UI |

---

## 0. TL;DR — در پنج خط

۱. **§4.1 سند قبلی بسته شد**: ۲۹ تست integration برای سه اندپوینت Workspace
   نوشته شد (`tests/integration/workspace.test.ts`).
۲. `npx vitest run` **کامل** (شامل integration) اجرا شد → §4.2 هم بسته شد.
۳. سه قلم از §4.3 (پرداخت‌های معوق) واقعی شدند: **تب Executions**،
   **تب Connections**، و **پنل Filter**.
۴. بک‌اند: `GET /jobs/:userId` حالا فیلتر `?workflowId=` و پنج فیلد انتساب اجرا
   (`workflowId`/`workflowVersion`/`trigger`/`startedAt`/`finishedAt`/`durationMs`) می‌دهد.
۵. **کارِ مانده** دقیقاً در بخش ۵ همین فایل است — با ترتیب پیشنهادی و لنگر فایل.

---

## 1. زمینه — این پروژه چیست و کاربر چه خواسته

**پروژه:** `Aria Automate` — بک‌اند اتوماسیون مرورگر (Node/TypeScript + Playwright +
BullMQ/Redis) با یک **ویژوال ادیتور** فرانت‌اند به vanilla JS (بدون فریم‌ورک،
بدون بیلد، CSP `script-src 'self'`).

**درخواست حاکم کاربر (فارسی، هنوز معتبر):**

> «این تصاویر نتیجه نهایی تا اینجایه پروژمونه در حالی که باید پروژه نهایی به این
> شکل باشند: `docs/uiux`. برای محقق شدن این امر هر کاری نیازه رو شروع کن به
> انجام دادن و توسعه رو ادامه بده. **اگر سوالی هم پیش اومد از من نپرس** خودت
> سرچ کن پیدا کن، چون همه‌چیزهای ظاهر توی تصاویر کامل مشخصه.»

یعنی: **سؤال نپرس، خودت تصمیم بگیر و جلو برو.** جایی که spec نوشتاری و تصویر
اختلاف دارند، **تصویر برنده است** (این قاعده در `workspace-overview.md` §3D
مستند و با تست قفل شده).

---

## 2. ✅ کارِ انجام‌شده در این جلسه (کامیت `86793c6`) — تست‌های integration

### 2.1 فایل جدید: `tests/integration/workspace.test.ts` (۲۹ تست)

سه اندپوینتی که جلسه‌ی قبل ساخته شد ولی تست integration نداشت:

| گروه | تست‌ها | چه چیزی قفل شد |
|---|---|---|
| `PATCH /workflows/:userId/:workflowId/state` | ۱۴ | پیش‌فرض‌ها (`active:true`, `liveBrowser:false`) · **بدون bump نسخه** · هر سه حالت جدول درستی `liveBrowserViewable` · patch جزئی پرچم خواهر را دست نمی‌زند · persist · بدنه‌ی خالی `400` (به‌خاطر `.refine`) · کلید ناشناخته `400` (به‌خاطر `.strict()`) و **اثبات اینکه نوشتن جزئی رخ نداده** · نوع غیربولین `400` · `404` برای id ناموجود · `400` برای id بدشکل · **کار نکردن روی ورکفلوی کاربر دیگر** · **صفر رکورد تاریخچه** · اینکه `PUT` پرچم‌ها را حفظ می‌کند و اگر در بدنه بیایند **نادیده** می‌گیرد |
| `POST /workflows/:userId/:workflowId/run` (گیت ۴۰۹) | ۳ | `409` + `error:'Workflow is inactive'` و **`queue.addCalls` تغییر نمی‌کند** · فعال‌سازی مجدد → اجرا برمی‌گردد · گیت **قبل از** بررسی quota/queue است و override بدنه آن را دور نمی‌زند |
| `GET /workspace/:userId/stats` | ۱۲ | هر هفت کلید حاضر و **دقیقاً هفت‌تا** · `successRate === null` نه `0` · شمارش **فقط اجراهای terminal** · گرد کردن به یک رقم اعشار (۶۶.۷ نه ۶۶.۶۶) · نادیده گرفتن جاب کاربر دیگر · جاب بدون تگ در آمار کل می‌آید ولی **به هیچ ردیفی نمی‌چسبد** · `lastRunAt`/`lastRunState` = جدیدترین · شمارش schedule بر اساس segment نام (case-insensitive) · جدایی `totalFlows` از `activeFlows` · `liveBrowsers` از `profileManager` · کاربر بدون ورکفلو · شکل دقیق هر ردیف `perWorkflow` |

### 2.2 دو نکته‌ی هارنس که وقتت را می‌خرد

۱. **`profileManager` را `{}` نگذار.** خواهرِ این فایل
   (`tests/integration/workflows.test.ts`) این کار را می‌کند، ولی مسیر stats
   `profileManager.getActiveBrowserCount()` را صدا می‌زند ⇒ `500`.
   این فایل `{ getActiveBrowserCount: () => browserCount }` می‌دهد.
۲. **استور in-memory بین تست‌های همین فایل مشترک است.** هر تستی که *تعداد*
   ورکفلوها را می‌شمارد باید **namespace کاربری خودش** را بگیرد. تست
   «separates totalFlows from activeFlows» اول با `u1` نوشته شد و **شکست**
   (۱۷ در برابر ۲۵)؛ با `u_counts` قطعی شد. `beforeEach` فقط `queue` را reset
   می‌کند، نه Redis stub را.

### 2.3 §4.2 هم بسته شد
`npx vitest run` **کامل** اجرا شد (نه فقط `tests/unit`): **۳۴ فایل / ۶۱۴ تست پاس**.
سوییت‌های integration که Redis می‌خواهند خودشان skip می‌کنند و چیزی regress نکرد.

---

## 3. ✅ کارِ انجام‌شده در این جلسه (کامیت `24c19c9`) — سه بخش UI

اینها از **§4.3 «Deferred UI polish»** سند قبلی برداشته شدند.

### 3.1 بک‌اند: `GET /jobs/:userId` انتساب اجرا می‌دهد

`src/Routes/user.routes.ts` (~خط ۶۰۰). سه تغییر:

```
?workflowId=<id>   ← فیلتر اختیاری. با همان isValidWorkflowId اعتبارسنجی می‌شود؛
                     مقدار بدشکل ⇒ 400 (نه «همه را برگردان»).
```

و هر ردیف پنج فیلد جدید گرفت:

| فیلد | منبع | نکته |
|---|---|---|
| `workflowId` | `job.data.__workflowId` | جاب ad-hoc `/run` ندارد ⇒ `null` |
| `workflowVersion` | `job.data.__workflowVersion` | فقط اگر `number` باشد |
| `trigger` | مشتق | `'schedule'` اگر `__scheduled` · وگرنه `'workflow'` اگر تگ دارد · وگرنه `'manual'` |
| `startedAt` / `finishedAt` | `job.processedOn` / `job.finishedOn` | ISO یا `null` |
| `durationMs` | `finishedOn - processedOn` | **زمان اجرا، نه انتظار در صف.** با `timestamp` حساب نشد چون جابی که در صف مانده مدت متورم گزارش می‌کرد |

> **⚠️ چرا فیلتر سمت سرور است و نه کلاینت:** صف، اجراهای همه‌ی کاربران را دارد
> و پاسخ `limit` می‌خورد. فیلتر کلاینتی یعنی ردیف‌های بعد از limit **بی‌صدا**
> حذف می‌شوند.

**خط‌پایان:** این فایل CRLF است. با پایتون بایت‌به‌بایت پچ شد
(`io.open(p, encoding='utf-8', newline='')` + `\r\n` صریح + `assert count==1`).
بعد از پچ: `grep -c $'\r'` = **1190** و `tsc --noEmit` تمیز.

### 3.2 `public/js/api.js` — `listJobs` پارامتر سوم گرفت

```js
listJobs(userId, limit, workflowId)   // workflowId اختیاری
```
امضای قبلی دو-آرگومانی دست‌نخورده کار می‌کند (`renderJobs` تغییری نخواست).

### 3.3 تب **Executions** — واقعی شد (`public/js/views.js`)

قبلاً یک empty-state با لینک «Go to Jobs» بود. حالا:

* **نوار کنترل**: select ورکفلو (`All workflows` + هر ورکفلو) · چک‌باکس
  `Auto-refresh` · دکمه‌ی refresh دستی (`rotate-cw`).
* **جدول ۷ ستونه**: `Status · Run ID · Workflow · Trigger · Duration · Started · Actions`
  — همان ستون‌هایی که `shell-editor-click-ndv.md` برای درایور `Runs` می‌خواهد.
* هر ردیف: نقطه‌ی وضعیت رنگی، نام ورکفلو + `v<n>`، برچسب trigger + نام schedule،
  مدت خوانا، زمان نسبی، و دکمه‌های `View` / `Cancel` (فقط برای اجرای در جریان).
* جاب بدون تگ ⇒ برچسب `Ad-hoc run`. جابی که ورکفلویش حذف شده ⇒ `Deleted workflow`
  با رنگ خاموش (تاریخچه دروغ نمی‌گوید که کدام ورکفلو بود).
* **poll هشت‌ثانیه‌ای** که با `track()` ثبت می‌شود.

سه محافظِ عمری که حتماً باید بمانند:

```js
if (wsState.tab !== 'executions') stopExecPoll();   // در paintPanel — خروج از تب، تایمر را می‌کشد
if (wsState.tab !== 'executions') return;           // در .then — پاسخ دیرهنگام روی تب دیگر نقاشی نکند
execTimer = track(setInterval(...))                 // خروج از کل view هم تایمر را جمع می‌کند
```

### 3.4 تب **Connections** — واقعی شد

**تصمیم معماری (مهم):** «اتصال‌های» یک ورکفلو یعنی لبه‌هایش به دنیای بیرون:
وبهوک خروجی و راه‌اندازش. **این دو در ادیتور صاحب دارند**، پس این تب فقط
**می‌خواند** و به ادیتور لینک می‌دهد. اگر اینجا ویرایش می‌گذاشتیم، دو صاحبِ
رقیب برای یک داده می‌ساختیم.

هر ورکفلو یک کارت با چیپ‌ها:
* `Outgoing webhook` + URL (آبی) — اگر `wf.webhookUrl` باشد
* `Trigger` + id اکشن (بنفش) — اگر یکی از
  `trigger`/`webhook-trigger`/`schedule-trigger`/`telegram-trigger` در steps باشد
* `Runs headless` / `Visible browser` (خاموش) — **همیشه** حاضر است

> **دام:** چیپ headless همیشه هست، پس «اتصال ندارد» یعنی `chips.length - 1 === 0`.
> شمارنده‌ی badge هم همین `real` را نشان می‌دهد، نه `chips.length`.

### 3.5 پنل **Filter** — از inert به واقعی

دکمه‌ی filter در تصویر قفل‌شده هست ولی قبلاً فقط فوکوس را به search می‌داد.
حالا یک popover واقعی است:

* دو گروه segmented: `Status` (All/Active only/Inactive only) و
  `Live Browser` (All/On/Off)
* دو چک‌باکس: `Scheduled only` · `Success below 80%`
* دکمه‌ی `Clear filters` + **badge تعداد فیلتر فعال** روی دکمه

سه تصمیم که با تست ارزش قفل شدن دارند:

۱. **فیلترها در `visibleWorkflows()` اعمال می‌شوند، نه با حذف از `workflows`** —
   پس پاک کردن فیلتر هرگز refetch لازم ندارد.
۲. `wsPassesFilters(wf, st, f)` یک **تابع خالص** بیرون از `renderWorkspace` است
   تا قابل استدلال/تست باشد.
۳. **`failing` یعنی «نرخِ سنجیده‌شده‌ی بد»**، نه «نرخ ندارد». ورکفلویی که هرگز
   اجرا نشده `successRate === null` دارد و **متهم به شکست نمی‌شود**:
   ```js
   if (f.failing && !(st && st.successRate != null && st.successRate < 80)) return false;
   ```

بستن پنل: کلیک بیرون (از طریق همان listener سطح document که caret و row-menu را
می‌بندد) · `Escape` که فوکوس را به دکمه برمی‌گرداند.

### 3.6 i18n و CSS

* **~۴۹ کلید جدید** در **هر دو** دیکشنری `fa` و `en` اضافه شد
  (`ws.exec.*`, `ws.conn.*`, `ws.filter*`). تست `workspace-ui.test.ts` تقارن را
  در سطح سورس اجبار می‌کند.
* دو کلید معنایشان عوض شد چون دیگر placeholder نیستند:
  `ws.executionsEmpty` از «تاریخچه در Jobs است» به **«هنوز اجرایی ثبت نشده»**.
* **۲۳ کلاس CSS جدید** (~۱۴۰ خط) ته `public/css/styles.css`. صفر کلاس بی‌استایل
  (تست `every CSS class the views emit is styled` این را قفل کرده).

---

## 4. ⚠️ دام‌هایی که باید بدانی — قبل از هر ویرایش بخوان

۱. **افتادن بی‌صدای پارامتر.** `GraphSerialize.coerceParams()` **فقط** کلیدهای
   اعلام‌شده در `public/js/actions.js#fields` را کپی می‌کند. هر کنترل UI جدید
   ⇒ **حتماً** یک field جدید، وگرنه مقدارش موقع save/run **بدون هیچ خطایی**
   دور ریخته می‌شود.

۲. **`CONDITION_ONLY_PARAMS`** در `public/js/graph-serialize.js` (~خط ۱۰۰).
   کلید جدید Condition Builder را اینجا هم ثبت کن وگرنه برای `while` دوبار
   سریالایز می‌شود.

۳. **خط‌پایان.** `public/**` و `docs/**` = **LF** (ابزار `Edit` مشکلی ندارد).
   `src/**/*.ts` = **CRLF** و **`Edit`/`MultiEdit` روی آنها شکست می‌خورد**.
   با پایتون پچ کن:
   ```python
   s = io.open(p, encoding='utf-8', newline='').read()
   assert s.count(old) == 1          # همیشه گارد بگذار
   io.open(p, 'w', encoding='utf-8', newline='').write(s)
   ```
   `src/pipeline.ts` خط‌پایان **مخلوط** دارد (شاخه‌ی click با LF، بقیه CRLF).
   یکدست‌سازی = دیف چندهزارخطی. **دست نزن.**
   چک: `grep -c $'\r' src/Routes/user.routes.ts` ≈ **1190** ·
   `grep -c $'\r' src/pipeline.ts` ≈ **2922**.

۴. **گاردِ همگامی بک‌اند/UI.** `tests/unit/action-catalog.test.ts` سورس
   `src/pipeline.ts` را برای `step.action === '…'` پارس می‌کند. الیاس جدید به
   pipeline اضافه کردی ⇒ نقشه‌ی `ALIASES` همان تست را هم به‌روز کن.

۵. **`tests/unit/icons.test.ts` یک آرایه‌ی `JS_ALL` دارد که باید *دقیقاً* برابر
   `readdirSync('public/js')` منهای `icons.js` باشد.** هر فایل جدید
   `public/js/*.js` آن تست را می‌شکند تا لیست را به‌روز کنی. این جلسه فایلی
   اضافه نکرد.

۶. **نام آیکون‌ها را حدس نزن.** `refresh` **وجود ندارد** (وقت گرفت). درست:
   `rotate-cw`. قبل از استفاده چک کن:
   ```bash
   node -e "global.window={};require('./public/js/icons.js');
   console.log(window.Icons.has('NAME'))"
   ```
   کلیدهای رجیستری وقتی identifier معتبرند **بدون کوتیشن** هستند، پس
   `grep "'refresh'"` جواب غلط می‌دهد. همیشه از `Icons.has()` بپرس.

۷. **`.ic` نباید width/height بگیرد** · **`'fx'` آیکون نیست** (جزئیات در
   the icon-registry / shell-layout brief, §2.1).

۸. **Redis نصب نیست.** `npm start` / `npm run dev` بالا نمی‌آید. برای بررسی
   بصری از سرور استاتیک استفاده کن:
   ```bash
   cd /home/user/webapp/public && python3 -m http.server 8099
   ```
   بعد ابزار `GetServiceUrl(port=8099)`.

۹. **دیکشنری `fa` را حذف نکن.** `DEFAULT_LANG='en'` و `t()` به `en` فال‌بک
   می‌کند، پس کلید `fa` گمشده **در runtime دیده نمی‌شود** — و دقیقاً همین است
   که تقارن را در سطح سورس تست می‌کنیم. شکاف‌های موجود `fa` برای
   `p.*`/`ndv.*`/`click.*` **عمدی و خارج از دامنه** هستند.

۱۰. **`display:none` روی ستون grid، بوم را صفر می‌کند.** در Focus Mode راه درست
    `width:0` + `visibility:hidden` است (تست قفلش کرده).

۱۱. **`t()` از `window.AppUtil` می‌گذرد**، نه مستقیم از `I18N`. و `AppUtil` در
    `app.js` ساخته می‌شود. صفحه‌ی آزمایشی که `app.js` را لود نکند، همه‌ی
    برچسب‌ها را کلید خام نشان می‌دهد — نقص هارنس است نه محصول.

۱۲. **مدیا-کوئری `≤980px`**: `PlaywrightConsoleCapture` کنترل viewport نمی‌دهد و
    پیش‌فرضش باریک است. صفحه‌ی سنجش را در `<iframe width="1440">` بگذار.

۱۳. **CSP `script-src 'self'`** — بدون inline handler، بدون CDN، بدون bundler.
    همه‌چیز delegated event listener روی vanilla JS.

۱۴. **استور in-memory در `tests/integration/*` بین تست‌های یک فایل مشترک است.**
    هر تستی که تعداد می‌شمارد، `userId` مخصوص خودش بگیرد (بخش ۲.۲ بالا).

---

## 5. ⬜ کارِ باقی‌مانده — از اینجا شروع کن

به ترتیب **بیشترین ارزش به کمترین**. هیچ‌کدام برنچ را قرمز نمی‌کند؛ همه‌چیز
همین حالا سبز است.

### اولویت ۱ — تست‌های گارد برای سه بخشِ همین جلسه ⭐ **از اینجا شروع کن**

سه بخش UI ساخته شد ولی **تست اختصاصی نگرفت** (تست‌های موجود فقط تضمین کردند که
چیزی نشکسته و همه‌ی کلاس/آیکون/کلید resolve می‌شود). این بدهیِ آگاهانه است.

فرانت DOM-bound IIFE است، پس الگوی درست **گاردِ سطح سورس** است — عیناً مثل
`tests/unit/workspace-ui.test.ts` (آن را بخوان و کپی کن؛ سورس را با
`readFileSync` می‌خواند و روی رشته assert می‌زند).

پیشنهاد فایل جدید: `tests/unit/workspace-ui.test.ts` (شامل شد)

| مورد | چه چیزی assert شود |
|---|---|
| هفت ستون Executions | `['status','runId','workflow','trigger','duration','startedAt','actions']` به همین ترتیب و هر کدام با `<th scope="col">` |
| نشتی تایمر | سورس **هر سه** محافظ بخش ۳.۳ را داشته باشد: `stopExecPoll()` در `paintPanel`، `wsState.tab !== 'executions'` در `.then`، و `track(setInterval` |
| فیلتر سمت سرور | `listJobs` سه آرگومان بگیرد و `paintExecutionsTab` `wsState.execWorkflow` را پاس بدهد (اثبات اینکه فیلتر کلاینتی برنگشته) |
| `failing` منطق null | رشته‌ی `st.successRate != null && st.successRate < 80` عیناً حاضر باشد |
| شمارش چیپ Connections | `chips.length - 1` حاضر باشد (چیپ headless شمرده نشود) |
| Connections فقط-خواندنی | اسلایس تب Connections **نباید** `API.updateWorkflow` یا `API.setWorkflowState` داشته باشد |
| `wsActiveFilterCount` | با `WS_FILTER_DEFAULTS` مقایسه کند نه با لیست hard-code |
| کلید/کلاس/آیکون | همان سه گارد `workspace-ui.test.ts` روی کلیدهای جدید (که الان به‌صورت عمومی پاس می‌شوند، اینجا صریح شوند) |

و برای بک‌اند، یک `describe` به **`tests/integration/workspace.test.ts`** اضافه کن
(هارنس آماده است، فقط `queue.seedJob` را با `processedOn`/`finishedOn` غنی کن):

| مورد | انتظار |
|---|---|
| `GET /jobs/u1?workflowId=<id>` | فقط جاب‌های همان ورکفلو |
| `GET /jobs/u1?workflowId=bad id!` | `400 Invalid workflow id` |
| `GET /jobs/u1` بدون فیلتر | همه‌ی جاب‌های کاربر (سازگاری با گذشته) |
| فیلدهای انتساب | `trigger` سه‌حالته درست · `durationMs` = `finishedOn-processedOn` · جاب در جریان `durationMs === null` |

> **دقت:** `makeQueue().seedJob` فعلاً `processedOn`/`finishedOn` نمی‌سازد.
> امضایش را گسترش بده (آرگومان چهارم/پنجم) — این تنها تغییرِ لازم در هارنس است.

### اولویت ۲ — `Run node` تک‌نود (آیتم N سند آیکون‌ها)

دکمه‌ی `Run node` در هدر NDV فعلاً `#fe-run` را کلیک می‌کند، یعنی **کل ورکفلو**
را اجرا می‌کند، چون اندپوینت اجرای تک‌نود وجود ندارد.
طبق `docs/uiux/shell-editor-condition-ndv.md` §4 باید فقط زیرگراف همان نود اجرا
شود (در spec سطح **B — Small add** علامت خورده).

مسیر پیاده‌سازی:
1. `src/Routes/user.routes.ts` — اندپوینت اجرای زیرگراف (الگو: مسیر
   `/workflows/:userId/:workflowId/run`؛ **گیت ۴۰۹ inactive را هم اعمال کن**).
2. `public/js/api.js` — `API.runNode()`.
3. `public/js/flow-editor.js` — سیم‌کشی به دکمه‌ی NDV.

### اولویت ۳ — بقیه‌ی «پوسته‌ی ادیتور» (بخش ۴ سند آیکون‌ها)

اینها هنوز باز هستند. ترتیب پیشنهادی همان سند: **A → C → E → D → H → J → I**.

| # | آیتم | فایل هدف (لنگر) |
|---|---|---|
| **A** | پوسته‌ی full-bleed + نوار تب‌های ورک‌فلو + undo/redo + `Stop` قرمز + زنگ/تنظیمات/آواتار | `views.js#renderEditor` |
| **B** | منوهای `Export ▾` / `Save ▾` (+ `Version History`, `Auto Save` toggle) | `views.js#renderEditor` |
| **C** | پنل OUTLINE — درخت تودرتوی شماره‌دار (`4 Condition`→`4.1 True`→`4.1.1 …`) + همگام‌سازی انتخاب با بوم | `views.js#renderEditor` + CSS |
| **D** | ارتقای سایدبار چپ — `Search blocks...` + `⌘K` · `Favorites` · شمارنده‌ی دسته‌ها | `flow-editor.js#renderPalette` |
| **E** | ACTIVITY LOG — تب‌های `Runs\|Execution\|Variables\|Logs` · `Auto-scroll` · تایم‌لاین Execution | `run-panel.js` |
| **H** | پالت شناور Add Node — ریل دسته‌ها + لیست پریست | `flow-editor.js#renderEmptyState` |
| **I** | انتخاب گروهی — مستطیل خط‌چین + نوار پایینی گروه | `flow-editor.js#renderBoxSelect` |
| **J** | منوی کامل راست‌کلیک نود (۹ آیتم) | `flow-editor.js#openNodeMenu` |

> **⚠️ توجه:** بخشی از E (تب `Execution`) حالا با تب Executions همپوشانی مفهومی
> دارد. **آن را دوباره ننویس** — منطق ردیف و برچسب trigger را از
> `views.js#execRow` بردار و مشترک کن، وگرنه دو نمایش از یک داده می‌سازی
> (همان دامی که در بریف اولیهٔ طراحی NDV ثبت شده بود).

### اولویت ۴ — پرداخت‌های کوچکِ باقی‌مانده از §4.3 سند قبلی

* **ستون Owner** فقط `ws.owner.personal`/`ws.owner.team` را از رکورد مشتق
  می‌کند؛ **مدل تیم واقعی وجود ندارد**.
* **دکمه‌ی `layout`** به‌جای column-chooser، density را toggle می‌کند
  (عمدی، `workspace-overview.md` §6C).
* **`renderSettings()`** یک landing page است، نه یک سطح تنظیمات کامل.
* **auto-refresh کارت‌ها** یک `setInterval` ۱۵ ثانیه‌ای است. اگر کانال
  websocket/SSE آمد، همان‌جا عوضش کن.
* **تب Templates** اگر `window.TEMPLATES` نباشد `ws.templatesUnavailable` می‌دهد.

### اولویت ۵ — اختیاری: تست دود واقعی مرورگر

هلپرهای click الان unit-test دارند ولی مسیر انتها-به-انتها تست نشده (کلیک با
offset، با modifier، و `stableForMs` روی عنصر انیمیشن‌دار). نیاز به
`playwright install chromium` دارد — **نصب محلی بدون `sudo` شکست می‌خورد**
(کتابخانه‌های سیستمی نیستند).

---

## 6. دستورهای تأیید — همیشه قبل از commit اجرا کن

```bash
cd /home/user/webapp

npx tsc --noEmit          # باید بی‌خروجی باشد
npx vitest run             # باید 34 فایل / 614 تست سبز باشد

# چک نحوی هر ماژول فرانت (بدون بیلد، پس این تنها گارد نحوی است)
for f in public/js/*.js; do node --check "$f" || echo "FAIL: $f"; done

# چک خط‌پایان (نباید عوض شده باشد)
grep -c $'\r' src/Routes/user.routes.ts   # ≈ 1190
grep -c $'\r' src/pipeline.ts             # ≈ 2922
grep -c $'\r' public/js/views.js          # باید 0 باشد

# صفر کلاس بی‌استایل
node -e "var fs=require('fs'),css=fs.readFileSync('public/css/styles.css','utf8'),s=new Set();
['public/js/views.js','public/js/app.js'].forEach(function(p){var m,re=/class=\"((?:ws|home|split|page)-[a-z-]+)/g,x=fs.readFileSync(p,'utf8');
while((m=re.exec(x)))s.add(m[1]);});var u=[...s].filter(function(c){return css.indexOf('.'+c)===-1;});
console.log(u.length?'UNSTYLED: '+u.join(' '):'ALL_STYLED');"

# آیکون هست یا نه
node -e "global.window={};require('./public/js/icons.js');console.log(window.Icons.has('rotate-cw'))"
```

---

## 7. نقشه‌ی فایل‌ها (فقط چیزی که لازم داری)

```
public/js/
  icons.js           ← رجیستری SVG (۹۶ آیکون). اولین <script> در index.html
  actions.js         ← کاتالوگ اکشن‌ها — «افتادن بی‌صدا» اینجاست
  graph-serialize.js ← graph ⇄ steps[] + CONDITION_ONLY_PARAMS + validateGraph
  views.js           ← روت‌ها؛ renderWorkspace (تب‌ها/فیلتر/جدول) · renderEditor (هدف A,B,C)
  flow-editor.js     ← شل/بوم/کارت/یال/مودال NDV  (هدف D,H,I,J)
  run-panel.js       ← drawer اجرا                (هدف E)
  ndv-model.js       ← منطق خالص بدون DOM (unit-testable با node:vm)
  ndv-ui.js          ← پریمیتیوهای aria-*
  ndv-nodes.js       ← ستون مرکزی Click/Condition
  api.js             ← کلاینت HTTP (listJobs سه‌آرگومانی · setWorkflowState · workspaceStats)
  i18n.js            ← fa + en؛ بلوک en از ~۴۷۳
  app.js             ← NAV_ROUTES/DEEP_ROUTES/ROUTE_PARENT · App Launcher · AppUtil

src/
  Routes/user.routes.ts  ← CRLF! جاب‌ها (~۶۰۰) · run+گیت۴۰۹ (~۸۷۶) · PATCH state (~۱۰۱۶) · stats (~۱۰۵۶)
  services/workflow.service.ts ← setState() بدون bump نسخه و بدون snapshot
  schemas.ts             ← workflowStateSchema (strict + refine)
  pipeline.ts            ← دیسپچ اکشن‌ها. **CRLF مخلوط — دست نزن**
  core/ConditionEngine.ts ← source/attribute + readFromElement/readVariable

docs/uiux/           ← ⭐ منبع حقیقت: ۸ .webp + spec .md هرکدام
tests/unit/          ← ۲۹ فایل
tests/integration/   ← ۶ فایل (شامل workspace.test.ts جدید)
```

---

## 8. وضعیت گیت

```
برنچ:  genspark_ai_developer
ریموت: https://github.com/jalil-ahmadi2/plyr.git
پایه:  origin/main @ 145d42a
```

**گردش‌کار اجباری بعد از هر تغییر:**
```bash
git add -A && git commit -m "type(scope): description"
git fetch origin main && git rebase origin/main
git reset --soft HEAD~N && git commit -m "پیام جامع"   # squash به یک کامیت
git push -f origin genspark_ai_developer
# سپس PR بساز/به‌روز کن و **لینکش را به کاربر بده**
```

---

## 9. اسناد همراه (به این ترتیب بخوان)

| فایل | چه چیزی دارد |
|---|---|
| **این فایل** | Executions/Connections/Filters + **فهرست معتبر کارِ مانده** |
| `docs/uiux/02-HANDOFF-workspace-architecture.md` | معماری قفل‌شده‌ی ۶ ناحیه، Workspace hub، App Launcher، جدول درستی Live Browser |
| بریف آیکون/پوسته *(بازنشسته)* | رجیستری آیکون، پنج اکشن هسته‌ای، چیدمان افقی، **بخش ۴ = آیتم‌های A..N پوسته** — نسخهٔ جاری: `04-HANDOFF-editor-shell-outline-activity.md` |
| بریف طراحی NDV *(بازنشسته)* | پایه‌ی دیزاین NDV (دو نود `click` و `if`/`while`)، توکن‌های قفل‌شده، دام‌های سریالایزر — نسخهٔ جاری: `ndv-click-element-final.md` + `ndv-condition-final.md` |
| `docs/uiux/01-REPORT-ui-architecture-update.md` | گزارش کاربر، عیناً |
| `docs/uiux/00-PROCESS-node-design.md` | فرایند طراحی هر نود |

---

## 10. اگر تازه شروع کرده‌ای — سه قدم اول

```bash
cd /home/user/webapp
git log --oneline -5      # ببین کجا هستی
npx vitest run            # باید 614 سبز باشد؛ اگر نیست اول همان را درست کن
```

بعد:
1. بخش **۴ (دام‌ها)** همین فایل را بخوان — وگرنه چیزی را بی‌صدا خراب می‌کنی.
2. از **اولویت ۱ بخش ۵** شروع کن (تست‌های گارد برای کارِ همین جلسه).
3. بعد **اولویت ۲** (`Run node` تک‌نود) که مستقل و بک‌اندی است.

**یادت باشد:** کاربر گفته **سؤال نپرس**؛ خودت تصمیم بگیر و بساز. جایی که spec
نوشتاری و تصویر اختلاف داشتند، **تصویر برنده است**.
