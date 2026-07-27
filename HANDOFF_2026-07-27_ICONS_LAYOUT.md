# HANDOFF — جلسه‌ی «آیکون‌ها + اکشن‌های گمشده + چیدمان افقی»

> **این فایل برای مدلی نوشته شده که هیچ سابقه‌ی چتی ندارد.**
> اگر تازه شروع کرده‌ای: این فایل را کامل بخوان، بعد `HANDOFF_NEXT_SESSION.md`
> (سند پایه‌ی دیزاین NDV) را بخوان. این دو مکمل هم‌اند و همپوشانی ندارند.
>
> تاریخ: 2026-07-27 · برنچ: `genspark_ai_developer` · تست‌ها: **521 سبز / 31 فایل**

---

## 0. TL;DR — در سه خط

۱. سه نقص از اسکرین‌شات‌های کاربر **بسته شد**: آیکون‌های شکسته (مربع خالی)،
خطاهای `Unknown action`، و چیدمان عمودی نودها.
۲. کارِ باقی‌مانده **فقط پوسته‌ی ادیتور** است (پنل‌ها و نوارها) — بخش ۴ این فایل.
۳. هر تغییری می‌دهی، اول بخش ۵ (دام‌ها) را بخوان وگرنه چیزی را بی‌صدا خراب می‌کنی.

---

## 1. زمینه — این پروژه چیست و کاربر چه خواسته

**پروژه:** `Aria Automate` — یک بک‌اند اتوماسیون مرورگر (Node/TypeScript + Playwright)
با یک **ویژوال ادیتور** فرانت‌اند (vanilla JS، بدون فریم‌ورک).

**درخواست حاکم کاربر (فارسی، هنوز معتبر):**

> «این تصاویر نتیجه نهایی تا اینجایه پروژمونه در حالی که باید پروژه نهایی به این شکل باشند:
> `https://github.com/jalil-ahmadi2/plyr/tree/main/docs/uiux`
> برای محقق شدن این امر هر کاری نیازه رو شروع کن به انجام دادن و توسعه رو ادامه بده.
> اگر سوالی هم پیش اومد از من نپرس خودت سرچ کن پیدا کن، چون همه‌چیزهای ظاهر توی تصاویر کامل مشخصه.»

یعنی: **سؤال نپرس، خودت تصمیم بگیر و جلو برو.** مرجع تصویری در همین ریپو است:
`docs/uiux/*.webp` + `docs/uiux/*.md` (۶ صفحه‌ی قفل‌شده).

**چهار اسکرین‌شاتی که کاربر داد و نقص‌ها را نشان می‌داد:**

| # | تصویر | نقصی که نشان می‌داد | وضعیت |
|---|---|---|---|
| ۱ | ادیتور با ۸ نود | آیکون‌ها مربع خالی · نودها عمودی روی هم | ✅ هر دو حل شد |
| ۲ | NDV نود Click | آیکون‌های داخل مودال مربع خالی | ✅ حل شد |
| ۳ | NDV نود Condition | خطاهای `launch/waitFor/close: Unknown action` | ✅ حل شد |
| ۴ | بوم خالی | نبودِ پوسته‌ی کامل (OUTLINE/ACTIVITY LOG/…) | ⬜ باقی‌مانده |

---

## 2. ✅ در این جلسه چه چیزی ساخته شد

### 2.1 رجیستری آیکون SVG درون‌خطی — `public/js/icons.js` (فایل جدید)

**ریشه‌ی نقص:** کل UI هر گلیف را با **ایموجی** می‌کشید. فونت‌استک محصول پوشش
ایموجی ندارد ⇒ کاربر مربع خالی می‌دید. ضمناً ایموجی `currentColor` را ارث
نمی‌برد و عرضش وابسته به پلتفرم است ⇒ ارتفاع دکمه‌ها می‌لرزید.

**راه‌حل:** یک رجیستری ۸۲ آیکونیِ SVG درون‌خطی (زبان بصری Lucide).

```js
window.Icons = { svg, el, has, names, action, hydrate, ACTION_ICONS };
```

| تابع | کار |
|---|---|
| `Icons.svg(name, {size, cls, stroke})` | رشته‌ی SVG برمی‌گرداند؛ نام ناشناس ⇒ فال‌بک `dot` |
| `Icons.action(actionId, opts)` | آیکون یک اکشن از روی `ACTION_ICONS` |
| `Icons.el(name, opts)` | همان ولی به‌صورت DOM node |
| `Icons.has(name)` / `Icons.names()` | بررسی/فهرست رجیستری |
| `Icons.hydrate(root)` | مارک‌آپ **استاتیک** را پر می‌کند: `data-icon="zap"` (+ `data-icon-size`) — idempotent است |

**قرارداد هر آیکون** (تست‌شده در `tests/unit/icons.test.ts`):
`viewBox="0 0 24 24"` · `stroke="currentColor"` · `fill="none"` · `aria-hidden="true"`
· `focusable="false"` · کلاس `ic` · بدون `<script>`، بدون `url()`، بدون رنگ هارد‌کد.

**ترتیب بارگذاری — حیاتی:** `icons.js` باید **اولین** اسکریپت فرانت در
`public/index.html` باشد (خط ۱۴۵)، چون ماژول‌های بعدی موقع تعریف‌شدن
`window.Icons` را صدا می‌زنند. تست این را قفل کرده است.

**هلپرهای محلی در هر مصرف‌کننده** (چون هر فایل IIFE جداست):

| فایل | هلپر |
|---|---|
| `flow-editor.js` | `IC(name, size)` و `ICON(actionId, size)` |
| `views.js` | `IC()` |
| `app.js` | `ICN()` |
| `browser-view.js` | `BIC()` |
| `live.js` | `LIC()` |
| `live-view.js` | `LVIC()` |
| `run-panel.js` | `RIC()` |

همه یک الگو دارند و در برابر نبودِ رجیستری امن‌اند:
```js
function IC(name, size) { return window.Icons ? window.Icons.svg(name, { size: size || 16 }) : ''; }
```

> **استثنا:** در `ndv-nodes.js` خط ۱۰۹ رشته‌ی `'fx'` عمداً **متن** است، نه آیکون.
> `ui.iconBtn()` اگر نام در رجیستری نباشد به متن فال‌بک می‌کند و دکمه‌ی fx باید
> حروف «fx» را نشان دهد. آن را «آیکون گمشده» فرض نکن و اضافه نکن.

**CSS:** بخش مستندشده‌ی «Inline SVG icon set» در انتهای `public/css/styles.css`.

> ⚠️ `.ic` عمداً **width/height ندارد**. اگر `width:1em;height:1em` بگذاری،
> اتریبیوت‌های `width`/`height` که `icons.js` می‌نویسد را override می‌کند و
> پارامتر `size` بی‌اثر می‌شود (درخواست ۱۶px با فونت ۱۳px رندر می‌شد).
> این باگ در همین جلسه پیدا و رفع شد؛ دوباره برنگردان.

### 2.2 پنج اکشن هسته‌ای که «Unknown action» می‌دادند

اسکرین‌شات ۳ این خطاها را نشان می‌داد. علت: این اکشن‌ها در
`public/js/actions.js#ACTIONS` نبودند، پس `validateGraph → strictAction()`
کد `val.unknownAction` می‌داد.

| اکشن جدید | دسته | آیکون | فیلدها |
|---|---|---|---|
| `launch` | navigation | `rocket` | url, timeout, waitUntil |
| `wait-element` | navigation | `eye` | selector, state, timeout, optional |
| `delay` | navigation | `hourglass` | ms |
| `extract-data` | data | `database` | selector, multiple, attribute, property, timeout, optional |
| `parse-json` | data | `braces` | json, path, optional |

**سمت بک‌اند در `src/pipeline.ts`:**
- **بلوک جدید ۳۷b — LAUNCH BROWSER** (`launch` / `launch-browser` / `launch_browser`)
  — idempotent: اگر کانتکست زنده باشد از آن استفاده می‌کند، وگرنه
  `ensureVipBrowser`/`ensureFreeContext`. اگر `url` بدهی همان‌جا ناوبری می‌کند.
  خروجی: `{action:'reused'|'launched', headless, url}`.
- **بلوک جدید ۳۷c — PARSE JSON** (`parse-json` / `parse_json` / `json-parse`)
  — `JSON.parse` + مسیر نقطه‌ای/ایندکسی اختیاری (`a.b[0].c`)؛ `optional` خطا را
  به `null` تنزل می‌دهد.
- **الیاس‌های افزوده به هندلرهای موجود:** `extract` ← `extract-data` ·
  `close-browser` ← `close` · `wait` ← `wait-element` و `delay`.

### 2.3 چیدمان افقی (Pipeline) — `graph-serialize.js#stepsToGraph`

**قبل:** `curY += 120` با `x` ثابت ⇒ ستون عمودی بلند (دقیقاً چیزی که در
اسکرین‌شات ۱ دیده می‌شد).
**حالا:** خط اصلی به راست می‌رود، شاخه‌ها در ستون بعدی به لِین‌های جدا می‌افتند.

ثابت‌ها (همه مضرب گرید ۲۰px ادیتور):
```js
var COL_W = 260;   // گام افقی (NODE_W=190 + 70 فاصله برای یال)
var ROW_H = 140;   // گام عمودی بین لِین‌های خواهر
var ORIGIN_X = 280, ORIGIN_Y = 200;   // ORIGIN_Y با y نود start یکی است
```

`layoutGroup()` حالا `{firstId, right, bottom}` برمی‌گرداند و
`layoutPort()` حالا `{nextY, right}` — تا نودِ بعد از یک شاخه بتواند از کل
زیردرخت عبور کند و روی آن نیفتد.

نمونه‌ی خروجی واقعی (اسکرین‌شات ۱ بازسازی‌شده):
```
   60  200  __start__
  280  200  launch
  540  200  goto
  800  200  wait-element
 1060  200  type
 1320  200  click
 1580  200  if
 1840  340  log      ← شاخه‌ی then
 1840  480  log      ← شاخه‌ی else
 2100  340  screenshot
 2360  200  close    ← از کل زیردرخت عبور کرد
```

---

### ۲ج. آیتم‌های F و G — چرم بوم (این جلسه)

هر دو در `flow-editor.js#buildOverlay` ساخته شدند.

**F — مینی‌مپ با هدر واقعی.** بدنه‌ی `.fe-minimap` حالا داخل
`.fe-minimap-wrap` قرار دارد که یک هدر با عنوان `MINIMAP` + چهار دکمه
(`−`/`+`/`Fit`/`✕`) دارد. `✕` ویجت را جمع می‌کند و به‌جایش یک چیپ
`.fe-mm-restore` نشان می‌دهد (نه اینکه کامل ناپدید شود).

**G — نوار شناور بوم.** سه گروه جدا با خط‌کش نازک:
- ابزارهای اشاره‌گر: `select` · `pan` · `lock` · `grid` (میان‌بر `V` و `H`)
- خوشه‌ی زوم: `−` · قرص `100%` (خودش دکمه‌ی reset است) · `+` · `Fit`
- کنش‌های نما: `fullscreen` · `Auto Layout` · `Focus Mode`

**اندازه‌های تأییدشده در مرورگر (viewport 1440×900):**

| مورد | مقدار |
|---|---|
| مینی‌مپ (wrap / head / body) | ۱۸۰×۱۲۸ / ۱۷۸×۲۶ / ۱۷۸×**۱۰۰** |
| فاصله از لبه‌ها | راست **۲۴px** · پایین **۲۴px** |
| نوار ابزار | ۵۵۳×۴۰ · فاصله‌ی چپ/پایین **۲۴px** |
| فاصله‌ی نوار ↔ مینی‌مپ | ۳۹۷px (بدون همپوشانی) |
| چیپ بازگردانی | ۹۸×۲۸ |
| Focus Mode | عرض بوم ۱۱۷۸px → **۱۴۱۸px** |
| Auto Layout | steps دست‌نخورده · ۰ همپوشانی · ۰ off-grid · نود یتیم حفظ شد |

**چهار نکته‌ی معماری که باید بدانی:**

1. **پرچم‌های چرم بیرون از `state` هستند.** `canvasTool` / `canvasLocked` /
   `gridVisible` / `minimapOpen` متغیرهای سطح-ماژول‌اند، چون *ترجیح کارگاه*‌اند
   نه دادهٔ گراف. اگر روی `state` بگذاری‌شان، به `serialize()` / `saveLocal()`
   و شکل `steps[]` نفوذ می‌کنند. تست این را قفل کرده است.
2. **`Auto Layout` چیدمان دوم نمی‌سازد.** گراف را از `toSteps()` عبور می‌دهد و
   به `GS().stepsToGraph()` می‌سپارد — یعنی همان چیدمانی که یک ورک‌فلوی
   ذخیره‌شده‌ی بازگشایی‌شده می‌گیرد. **هیچ‌وقت** ثابت‌های `COL_W`/`ROW_H` را
   اینجا کپی نکن.
3. **نودهای یتیم باید صریح حفظ شوند.** `stepsToGraph()` فقط زنجیره‌ی متصل به
   `start` را می‌بیند؛ نودهای بی‌اتصال در `steps[]` نیستند و اگر دستی
   برنگردانی‌شان، `Auto Layout` بی‌صدا حذفشان می‌کند. کد آن‌ها را در یک ردیف
   مرتب زیر گراف پارک می‌کند (روی گرید).
4. **قفل بوم فقط هندسه را می‌بندد.** `if (canvasLocked) return;` **بعد از**
   `selectNode()` می‌آید، پس نود قفل‌شده هنوز قابل انتخاب و باز کردن NDV است.

---

## 3. 🔒 تست‌های محافظ که اضافه شد

| فایل | تعداد | چه چیزی را قفل می‌کند |
|---|---|---|
| `tests/unit/icons.test.ts` (جدید) | ۲۵ | هر اکشن آیکون واقعی دارد (نه فال‌بک `dot`) · هیچ فیلد `icon` ایموجی نیست · مارک‌آپ CSP-inert و `currentColor` است · **هر نامی که از هر ماژولی صدا زده می‌شود واقعاً در رجیستری هست** · `icons.js` اولین اسکریپت است · هیچ ایموجی روی خطوط اجرایی نمانده |
| `tests/unit/graph-serialize.test.ts` (+۸) | ۲۹ | زنجیره‌ی خطی یک ردیف افقی می‌ماند · گام ستون از عرض کارت بیشتر است · شاخه‌ها لِین جدا می‌گیرند · نود بعدِ شاخه از زیردرخت عبور می‌کند · **هیچ دو کارتی همپوشانی ندارند** · همه روی گرید ۲۰px · round-trip سالم می‌ماند |
| `tests/unit/canvas-chrome.test.ts` (جدید) | ۳۱ | ساختار نوار ابزار و هدر مینی‌مپ · **پرچم‌های چرم به گراف سریالایز نشده نفوذ نمی‌کنند** · `Auto Layout` از سریالایزر استفاده می‌کند و نود یتیم را حفظ می‌کند · قفل بوم انتخاب را نمی‌بندد · هر کلید i18n در **هر دو** دیکشنری هست · هر آیکون در رجیستری هست · **CSS ای که JS تاگل می‌کند واقعاً وجود دارد** · پالت Focus Mode با عرض صفر جمع می‌شود نه `display:none` |
| `tests/unit/action-catalog.test.ts` (ویرایش) | — | الیاس‌های جدید بک‌اند در نقشه‌ی `ALIASES` ثبت شد |

> **نکته درباره‌ی `EMOJI_RE` در `icons.test.ts`:** رنج `U+2190..U+21FF`
> (فلش‌های ساده مثل `→` در متن‌های i18n) **عمداً مستثنا شده**. آن‌ها کاراکتر
> تایپوگرافیک عادی با پوشش کامل فونت‌اند و *نثر*اند نه آیکون. فقط رنج‌های
> تصویری (پیکتوگرافیک) ممنوع‌اند.

---

## 4. ⬜ کارِ باقی‌مانده — «پوسته‌ی ادیتور»

همه‌ی موارد زیر **فقط UI شل** هستند. هسته (اکشن‌ها، NDV، موتور، چیدمان) کامل است.
مرجع دقیق هر کدام: `docs/uiux/shell-editor-click-ndv.md` و
`docs/uiux/shell-add-node-palette.md` و `docs/uiux/state-empty-canvas.md`.

به ترتیب **بیشترین اثر بصری به کمترین** مرتب شده — از بالا شروع کن:

| # | آیتم | فایل هدف (لنگر) | توضیح |
|---|---|---|---|
| **A** | پوسته‌ی full-bleed + نوار بالا | `views.js#renderEditor` (~خط ۸۷۹) | برند · `Home` · `Workspace ▾` · نوار تب‌های ورک‌فلو (`Login Flow`/`Payment Flow`/`Instagram Bot`/`Scraper`/`+ New Workflow`) · undo/redo · دکمه‌ی قرمز `Stop` · زنگ · تنظیمات · آواتار. ارتفاع نوار ۵۲–۵۶px. |
| **B** | منوهای `Export ▾` / `Save ▾` | `views.js#renderEditor` | Export: JSON/Template/PDF/Share Link/Publish · Save: Save Changes/Save As New Version/Version History/Auto Save toggle |
| **C** | پنل OUTLINE | `views.js#renderEditor` + CSS | درخت تودرتوی شماره‌دار (`1 Trigger`→`1.1 Webhook`، `4 Condition`→`4.1 True`→`4.1.1 Extract Data`) · دکمه‌ی `✕` · همگام‌سازی انتخاب با بوم |
| **D** | ارتقای سایدبار چپ | `flow-editor.js#renderPalette` (~۱۶۶۰/۱۶۹۰) | `Search blocks...` + `⌘K` · `Favorites` · شمارنده‌ی هر دسته راست‌چین · بخش‌های `Templates`/`Variables`/`Connections`/`Settings`/`Help & Docs`/`Collapse` |
| **E** | ACTIVITY LOG | `run-panel.js` (کل drawer) | تب‌های `Runs`\|`Execution`\|`Variables`\|`Logs` · سوییچ `Auto-scroll` · آیکون دانلود · جدول Runs (`Status`/`Run ID`/`Workflow`/`Trigger`/`Duration`/`Finished At`) · تایم‌لاین Execution |
| **H** | پالت شناور Add Node | `flow-editor.js#renderEmptyState` (~۷۷۵) | عنوان `Add Node` · `Search nodes...` · ریل دسته‌ها (Triggers/Browser/Web Interaction/Data/AI/Flow Control/Integrations/Utilities) · لیست پریست |
| **I** | انتخاب گروهی | `flow-editor.js#renderBoxSelect` (~۱۸۹۵) | مستطیل خط‌چین آبی + نوار پایینی گروه (Disable/Delete/Clone/Group/Convert Subflow/Add Comment/More) |
| **J** | منوی کامل راست‌کلیک نود | `flow-editor.js#openNodeMenu` (~۶۹۴) | ۹ آیتم: Clone/Delete/Rename/Disable/Change Color+نقاط/Add Comment/Add to Favorites/Convert to Subflow/Advanced ▸ |
| **N** | `Run node` تک‌نود | `api.js` + `src/Routes/user.routes.ts` | اندپوینت اجرای زیرگراف + `API.runNode()` + سیم‌کشی به NDV. طبق `docs/uiux/shell-editor-condition-ndv.md` §۴ سطح B است. |

**پیشنهاد ترتیب کار:** A → C → E → D → H → J → I → N

> ✅ **F و G انجام شدند** (این جلسه). جزئیات در بخش ۲ج پایین‌تر.
(A پوسته را می‌سازد که بقیه داخلش می‌نشینند؛ N مستقل و بک‌اندی است، آخر.)

---

## 5. ⚠️ دام‌های شناخته‌شده — قبل از هر ویرایش بخوان

۱. **افتادن بی‌صدای پارامتر.** `GraphSerialize.coerceParams()` **فقط** کلیدهایی
را کپی می‌کند که در `actions.js#fields` اعلام شده‌اند. هر کنترل UI جدید
⇒ **حتماً** یک ورودی field جدید، وگرنه مقدارش موقع save/run بی‌صدا دور ریخته می‌شود.

۲. **`CONDITION_ONLY_PARAMS`** در `graph-serialize.js` (~خط ۱۰۰). کلید جدید
Condition Builder را اینجا هم ثبت کن وگرنه `while` دوباره سریالایزش می‌کند.

۳. **خط‌پایان.** `public/**` = **LF** · `src/*.ts` = **CRLF**.
`src/pipeline.ts` خط‌پایان **مخلوط** دارد (شاخه‌ی click با LF، بقیه CRLF).
حتماً بایت‌به‌بایت با پایتون پچ کن:
```python
io.open(p, encoding='utf-8', newline='')   # و '\r\n' صریح در رشته‌های جست‌وجو
```
هرگز از ابزاری که LF نرمال می‌کند استفاده نکن.

۴. **گاردِ همگامی بک‌اند/UI.** `tests/unit/action-catalog.test.ts` فایل
`src/pipeline.ts` را برای `step.action === '…'` پارس می‌کند و اصرار دارد هر
کدام از `window.ACTION_CATALOG` قابل دسترسی باشد. **اگر الیاس جدیدی به
pipeline اضافه کردی، نقشه‌ی `ALIASES` همان تست را هم به‌روز کن**، وگرنه تست
می‌شکند.

۵. **پیش‌فرض‌های سازگار با گذشته.** الگو: مقدار فقط وقتی سخت‌گیرانه می‌شود که
**حاضر و false** باشد؛ `undefined` رفتار قدیمی را نگه می‌دارد
(مثل `multipleMatches` و حالا `extract-data#multiple`).

۶. **`.ic` نباید width/height بگیرد** — بخش ۲.۱ بالا.

۷. **`'fx'` آیکون نیست** — بخش ۲.۱ بالا.

۸. **Redis نصب نیست.** `npm start` / `npm run dev` بالا نمی‌آید.
برای بررسی بصری از سرور استاتیک استفاده کن:
```bash
cd /home/user/webapp/public && python3 -m http.server 8099
```
بعد با ابزار `GetServiceUrl` روی پورت ۸۰۹۹ آدرس عمومی بگیر.

۹. **دیکشنری `fa` را حذف نکن.** `DEFAULT_LANG='en'` است و `t()` به `en`
فال‌بک می‌کند؛ فقط کلید `en` اضافه کردن کافی است. در `i18n.js` بلوک
`en: {` از حدود خط ۴۷۳ شروع می‌شود.

۱۰. **`display:none` روی ستون grid، بوم را صفر می‌کند.** در Focus Mode اولین
تلاش `.fe-palette` را `display:none` کرد؛ aside از جریان grid خارج شد، بوم به
ستون اول (عرض `0`) لغزید و **عرضش صفر شد**. راه درست: عنصر را در جریان نگه دار
و فقط کلیپش کن (`width:0` + `visibility:hidden`). تست این را قفل کرده است.

۱۱. **`t()` از `window.AppUtil` می‌گذرد، نه مستقیم از `I18N`.** در
`flow-editor.js` تابع `t()` یعنی `window.AppUtil.t()` و `AppUtil` در
**`app.js`** ساخته می‌شود. اگر صفحه‌ی آزمایشی بسازی که `app.js` را لود نکند،
همه‌ی برچسب‌ها به‌صورت کلید خام (`fe.minimap`) رندر می‌شوند — این باگ محصول
نیست، نقص هارنس است.

۱۲. **مدیا-کوئری `≤980px` اندازه‌گیری را خراب می‌کند.** ابزار
`PlaywrightConsoleCapture` کنترل viewport نمی‌دهد و پیش‌فرضش باریک است، پس
مینی‌مپ `0×0` گزارش می‌شود. راه‌حل: صفحه‌ی سنجش را داخل `<iframe width="1440">`
بگذار — مدیا-کوئری نسبت به جعبه‌ی خود iframe حل می‌شود. (نصب مرورگر محلی
Playwright بدون `sudo` شکست می‌خورد: کتابخانه‌های سیستمی موجود نیستند.)

---

## 6. توکن‌های قفل‌شده‌ی دیزاین

از هر ۶ اسپک استخراج شده و در `:root` فایل `styles.css` موجود است:

| نقش | مقدار |
|---|---|
| بوم | `#0B0F14` |
| سطوح | `#0F141B` / `#11161E` / `#151C25` |
| خط مرزی | `rgba(255,255,255,0.08)` |
| نارنجی اصلی | `#FF8A1F` → `#FF9A1F` |
| آبی info | `#2BA6FF` |
| سبز success | `#2ECC71` |
| قرمز danger | `#E45555` |
| متن | `#E8EDF4` / `#97A2B3` / `#5E6876` |
| گرید نقطه‌ای | ۲۰px |

**هندسه‌ی نود** (در `flow-editor.js`):
`NODE_W=190` · `NODE_H_MIN=64` · `PORT_SLOT=22` · `PORT_R=7` · `GRID=20`.

---

## 7. دستورهای تأیید (همیشه قبل از commit اجرا کن)

```bash
cd /home/user/webapp

npm test                 # باید 521 سبز باشد (31 فایل)
npx tsc --noEmit         # باید بی‌خروجی باشد

# چک نحوی هر ماژول فرانت
for f in public/js/*.js; do node --check "$f" || echo "FAIL: $f"; done

# چک خط‌پایان (نباید عوض شده باشد)
grep -c $'\r' src/pipeline.ts     # ≈ 2922
grep -c $'\r' public/js/icons.js  # باید 0 باشد
```

**بررسی بصری:**
```bash
cd /home/user/webapp/public && python3 -m http.server 8099 &
# سپس GetServiceUrl(port=8099) و PlaywrightConsoleCapture روی آدرس
```

---

## 8. نقشه‌ی فایل‌ها (فقط چیزهایی که لازم داری)

```
public/js/
  icons.js           ← ⭐ جدید. رجیستری SVG. اولین اسکریپت index.html
  actions.js         ← کاتالوگ ۵۰ اکشن + فیلدها. «افتادن بی‌صدا» اینجاست
  graph-serialize.js ← steps↔graph + چیدمان pipeline + validateGraph
  flow-editor.js     ← شل/بوم/کارت/یال/مودال NDV  (هدف آیتم‌های D,F,G,H,I,J)
  views.js           ← روت‌ها؛ renderEditor ~۸۷۹  (هدف آیتم‌های A,B,C)
  run-panel.js       ← drawer اجرا            (هدف آیتم E)
  ndv-model.js       ← منطق خالص بدون DOM
  ndv-ui.js          ← پریمیتیوهای aria-*
  ndv-nodes.js       ← ستون مرکزی Click/Condition
  api.js             ← کلاینت HTTP           (هدف آیتم N)
  i18n.js            ← fa + en؛ en از ~۴۷۳

src/
  pipeline.ts        ← دیسپچ اکشن‌ها (بلوک ۳۷b/۳۷c جدید). CRLF مخلوط!
  index.ts           ← CSP: scriptSrc ['self'] · static از public/ · Redis لازم
  Routes/user.routes.ts  ← (هدف آیتم N)

docs/uiux/           ← ⭐ منبع حقیقت دیزاین: ۶ .webp + ۶ .md
tests/unit/          ← ۳۱ فایل، ۵۲۱ تست
```

---

## 9. وضعیت گیت

```
برنچ:   genspark_ai_developer
ریموت:  https://github.com/jalil-ahmadi2/plyr.git
پایه:   origin/main @ 6097e0b
```

**گردش‌کار اجباری بعد از هر تغییر:**
```bash
git add -A && git commit -m "type(scope): description"
git fetch origin main && git rebase origin/main
git reset --soft HEAD~N && git commit -m "پیام جامع"   # squash
git push -f origin genspark_ai_developer
# سپس PR بساز/به‌روز کن و لینکش را به کاربر بده
```

---

## 10. اگر تازه شروع کرده‌ای — سه قدم اول

```bash
cd /home/user/webapp
git log --oneline -5          # ببین کجا هستی
npm test                      # باید سبز باشد؛ اگر نیست اول همان را درست کن
```

بعد:
1. `docs/uiux/shell-editor-click-ndv.md` را بخوان (کامل‌ترین اسپک پوسته).
2. تصویر `docs/uiux/shell-editor-click-ndv.webp` را نگاه کن.
3. از **آیتم A** بخش ۴ شروع کن.

**یادت باشد:** کاربر گفته سؤال نپرس؛ خودت تصمیم بگیر و بساز.
