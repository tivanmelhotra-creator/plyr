# HANDOFF — Aria Automate UI/UX (جلسه بعدی دقیقاً از اینجا ادامه بده)

> این فایل طوری نوشته شده که **بدون سابقه‌ی چت** هم کامل قابل فهم باشد.
> تاریخ آخرین به‌روزرسانی: 2026-07-27 · برنچ: `genspark_ai_developer`
>
> 📎 **این فایل یک سند همراه دارد:** `HANDOFF_2026-07-27_ICONS_LAYOUT.md`
> — رجیستری آیکون‌ها، پنج اکشن هسته‌ای جدید، چیدمان افقی، و **فهرست به‌روزِ
> کارهای باقی‌مانده**. اول این فایل (پایه‌ی دیزاین NDV) را بخوان، بعد آن را.
>
> 🚩 **آخرین وضعیت (2026-07-28) — از اینجا شروع کن:**
> **`docs/uiux/04-HANDOFF-editor-shell-outline-activity.md`**
> زیرساخت آماده شد (outline tree، undo/redo، onChange، revealNode، centerOnNode) و
> کارهای باقی‌مانده‌ی UI (شل بالای ادیتور، منوهای Export/Save، پنل OUTLINE،
> ACTIVITY LOG، سایدبار، آیتم‌های H/I/J/N) با جزئیات کامل و ترتیب اجرا در همان
> فایل مستند شده است. **اول تصاویر UI را ببین، بعد کد بزن.**

---

## 0. خلاصه‌ی یک‌خطی

NDV (Node Detail View) برای **دو نودی که پیش‌نمایش قفل‌شده دارند** (`click` و `if`/`while`)
پیاده شده، همراه با «پایه‌ی دیزاین» مشترک و قواعد میان‌بخشی که از **هر شش** تصویر
`docs/uiux/` استخراج شده. **بک‌اند حالا کامل است**: هر پارامتری که UI ذخیره می‌کند
واقعاً اجرا می‌شود (بخش ۵). کار باقی‌مانده فقط پرداخت‌های شل و «Run node» تک‌نود است
(بخش ۵b).

---

## 1. قوانین ثابت پروژه (هرگز نقض نشود)

| قانون | جزئیات |
|---|---|
| **دامنه‌ی دیزاین** | فقط نودهایی که در `docs/uiux/` پیش‌نمایش دارند طراحی می‌شوند. دقیقاً **دو مورد**: `ndv-click-element-final.*` (اکشن `click`) و `ndv-condition-final.*` (اکشن‌های `if`/`while`). **بقیه‌ی نودها را طراحی نکن.** |
| **دامنه‌ی مطالعه** | ولی **همه‌ی شش** تصویر/spec باید خوانده شود، چون قواعد میان‌بخشی دارند (✅ در این جلسه انجام شد). |
| **اولویت** | «منطق دیزاین» و پایه/foundation، نه طراحی سطحی همه‌ی نودها. |
| **تم و زبان** | فعلاً **فقط dark + English LTR**. fa/RTL و light theme بعداً. دیکشنری `fa` در `i18n.js` حذف نشده، فقط `DEFAULT_LANG='en'` است و `t()` به en فال‌بک می‌کند. |
| **فرانت** | vanilla JS، **CSP-safe** (`script-src 'self'`): بدون فریم‌ورک، CDN، اسکریپت inline، `eval`/`Function`. بارگذاری با `<script>` مرتب در `public/index.html`. |
| **خط‌پایان** | `public/**` = **LF** · `src/*.ts` = **CRLF** (حتماً حفظ شود). |
| **گیت** | برنچ `genspark_ai_developer` · بعد از هر تغییر commit · قبل از PR: `fetch`+`rebase origin/main` · squash به یک کامیت · force-push · PR بساز/به‌روز کن · **لینک PR را به کاربر بده**. |

---

## 2. معماری لایه‌بندی‌شده (پایه‌ی دیزاین → هر نود)

```
public/js/ndv-model.js    ← منطق خالص، بدون DOM، unit-testable با node:vm + {window:{}}
        ↓
public/js/ndv-ui.js       ← پریمیتیوهای DOM قابل استفاده مجدد (aria-*)
        ↓
public/js/ndv-nodes.js    ← ستون مرکزی اختصاصی هر نود (Click / Condition)
        ↓
public/js/flow-editor.js  ← شل + بوم + فال‌بک عمومی برای نودهای بدون دیزاین
```

**ترتیب بارگذاری در `index.html` مهم است** (باید قبل از `flow-editor.js` باشند):
```html
<script src="/js/graph-serialize.js"></script>
<script src="/js/ndv-model.js"></script>
<script src="/js/ndv-ui.js"></script>
<script src="/js/ndv-nodes.js"></script>
<script src="/js/flow-editor.js"></script>
```

### API عمومی هر ماژول
- `window.NdvModel` = `{ CONDITION_SOURCES, CONDITION_OPERATORS, CONDITION_MAX_PATHS_V1:1, EVALUATE_MODES, operatorMeta, sourceMeta, blankRow, normalizeRow, readGroups, writeGroups, rowChips, rowIsBlank, conditionSummary, CLICK_DEFAULTS, CLICK_SELECTOR_TYPES, CLICK_TYPES, CLICK_BUTTONS, normalizeClickParams, clickPayloadPreview, DESIGNED_NODES:{click,if,while}, isDesigned }`
- `window.NdvUI` = `{ el, t, esc, segmented, runSelector, searchField, section, fieldCell, withInfo, selectCell, textCell, numberCell, toggle, toggleRow, checkbox, iconBtn, treeFrom, dataTree, dragChips, outputEmpty, outputIllustration, statusStrip }`
- `window.NdvNodes` = `{ renderInput, renderOutput, renderCenter, exprField, pickerBtn, conditionRow }` — `renderCenter` برای اکشن بدون دیزاین **false** برمی‌گرداند.

---

## 3. توکن‌های قفل‌شده‌ی دیزاین (در هر ۶ spec تکرار شده‌اند)

```
بوم:        #0B0F14 – #0E1218 (dot-grid با فاصله‌ی 20px)
سطوح:       #0F141B / #11161E / #151C25
حاشیه:      rgba(255,255,255,0.08)
نارنجی اصلی: #FF8A1F – #FF9A1F
آبی info:   #2BA6FF
سبز:        #2ECC71   قرمز: #E45555
متن:        #E8EDF4 / #97A2B3 / #5E6876 (اصلی/ثانویه/غیرفعال)
فونت:       Inter / SF Pro / system-ui
```
شبکه‌ی فاصله: 4/8/12/16/20/24 · شعاع کارت 10–12 · شعاع مودال 14–16 ·
ارتفاع input 32–36 · دکمه‌ی primary 34–36 · ردیف سایدبار 28–30 · تب‌ها 32 ·
**ارتفاع کارت نود 48–58**.

---

## 4. ✅ کارهای انجام‌شده (تا این کامیت)

### 4.1 پایه‌ی دیزاین و دو NDV
- `ndv-model.js` (~345 خط)، `ndv-ui.js` (405 خط)، `ndv-nodes.js` (682 خط) ساخته شدند.
- `flow-editor.js#renderInspector()` به دو مسیر تقسیم شد: **designed** (تب‌های
  `Instructions | Advanced | Error | Test`) و **undesigned** (ادیتور عمومی قبلی).
- بیلدر شرط قدیمی و مرده (۱۵۹ خط) از `flow-editor.js` حذف شد.
- ~۸۰۰ خط CSS اضافه شد: shell مودال + `aria-*` + tree/chips/output + `cb-*`.
- ~۱۱۰ کلید انگلیسی به `i18n.js` اضافه شد (`ndv.*`, `nk.*`, `click.*`, `cb.*`, `cbs.*`, `op.*`).
- `actions.js`: اکشن `click` از ۸ فیلد به **۲۰ فیلد** رسید.

### 4.2 قواعد میان‌بخشی که در این جلسه از ۴ تصویر دیگر استخراج و اعمال شد

| قاعده | فایل | وضعیت |
|---|---|---|
| **مرز/glow مودال بر اساس دسته‌بندی** — آبی برای HTTP/browser، نارنجی برای click/condition | `flow-editor.js#ndvEdgeTone` + `--ndv-edge` در CSS | ✅ |
| **آناتومی کارت نود** — ~190×64، شعاع 8، مرز رنگ دسته (نه نوار کناری)، تایل آیکون مربعی، عنوان دوخطی، کباب `⋮`، نقطه‌ی وضعیت | `flow-editor.js#renderNode` + CSS `.flow-node*` | ✅ |
| **پورت‌ها وسط لبه‌ها** — تک‌پورت دقیقاً در مرکز عمودی، چندپورت متقارن حول مرکز | `nodeH`/`portY`/`inPort` (ثابت‌های `NODE_W`/`NODE_H_MIN`/`PORT_SLOT`/`PORT_R`) | ✅ |
| **قرص‌های میان‌سیم `True`/`False`** — سبز `#10b981` / قرمز `#ef4444`، لنگر در نقطه‌ی وسط بزیه | `renderEdges` + `curveMidpoint` + `EDGE_PILL_PORTS` + `.fe-edge-pill` | ✅ |
| **منوی شناور نود** (کباب + راست‌کلیک) — سطح `#1a1d24` | `openNodeMenu`/`closeNodeMenu` + `.fe-ctxmenu` | ✅ |
| **نوار وضعیت** — Version · Auto-save ● · Last saved · Workflow ID · Environment ● | `views.js#refreshStatusBar` + `.fe-statusbar` + کلیدهای `sb.*` | ✅ |
| خلاصه‌ی خوانا روی کارت `if`/`while` | `nodeCardSummary` → `NdvModel.conditionSummary` | ✅ |

### 4.3 اصلاحات صحت داده (مهم‌ترین بخش این جلسه)

1. **`actions.js`**: `if` و `while` حالا `groups`, `source`, `attribute`, `maxDepth`,
   `evaluateMode` را اعلام می‌کنند.
   > **چرا حیاتی است:** `GraphSerialize.coerceParams()` **فقط** کلیدهای اعلام‌شده در
   > `act.fields` را کپی می‌کند. هر پارامتری که اعلام نشود، در ذخیره/اجرا **بی‌صدا حذف می‌شود.**
2. **فیلد `internal: true`**: `groups` یک بلاب JSON است و نباید در ادیتور عمومی
   به‌عنوان input خام ظاهر شود. فیلتر شد در: `views.js` (بیلدر خطی)، تب
   `Advanced` و مسیر undesigned در `flow-editor.js`، و `nodeCardSummary`.
3. **`graph-serialize.js`**: ثابت `CONDITION_ONLY_PARAMS` معرفی شد و در
   `buildNode` برای `while` همه‌ی آن‌ها از `step.params` حذف می‌شوند
   (قبلاً فقط ۴ کلید حذف می‌شد ⇒ داده دوبار سریال می‌شد).
   نتیجه‌ی تأییدشده: `while` فقط `{"maxIterations":50}` را در params نگه می‌دارد.
4. **`stepsToGraph`**: مسیر SimpleCondition ساده حالا `source`/`attribute` را هم
   بازسازی می‌کند (وگرنه با باز کردن مجدد ورکفلو، بی‌صدا به `text` برمی‌گشت).
5. **باگ واقعی که تست پیدا کرد**: `conditionSummary({})` روی نود شرطی خالی
   `Exists` نشان می‌داد. با `rowIsBlank()` اصلاح شد → حالا `''` برمی‌گرداند و
   کارت به «No parameters» فال‌بک می‌کند.

### 4.4 تست
`tests/unit/ndv-designed-nodes.test.ts` ساخته شد (**۱۳ تست**) که این‌ها را قفل می‌کند:
- دقیقاً `click`/`if`/`while` طراحی‌شده‌اند و `http-request`/`goto` نیستند
- هر کلید `CLICK_DEFAULTS` در کاتالوگ اعلام شده (ضد حذف بی‌صدا)
- رفت‌وبرگشت کامل پارامترهای click
- `if`/`while` همه‌ی پارامترهای بیلدر را اعلام می‌کنند و `groups` internal است
- `while` فقط `maxIterations` را در params نگه می‌دارد
- کامپایل دو گروه به `{any:[{all:[...]}]}` با حفظ `source`/`attribute`
- حذف `source` وقتی مقدارش `text` (پیش‌فرض موتور) است
- رفت‌وبرگشت `condition` ⇄ `groups`
- خلاصه‌ی خوانا و رشته‌ی خالی برای حالت پیکربندی‌نشده

---

## 5. ✅ اولویت ۱ و ۲ (بک‌اند) — در این جلسه انجام شد

> شکاف عملکردی بسته شد: تمام پارامترهایی که UI ذخیره می‌کرد، حالا در موتور
> **واقعاً اجرا** می‌شوند.

### 5.1 `src/pipeline.ts` — شاخه‌ی `click`/`dblclick`/`hover`/`focus`

چهار هلپر خالص و **export شده** (تا بدون Redis/مرورگر تست‌پذیر باشند) بالای فایل
کنار `sanitizeSelector` اضافه شد:

| هلپر | کنترل دیزاین | نگاشت |
|---|---|---|
| `buildEngineSelector(sel, type)` | `Selector type` | `css` بدون تغییر · `xpath=…` · `text=…` (بدون پیشوند دوباره، case-insensitive، فیلتر امنیتی حفظ شد) |
| `clickModifiers(params)` | `Optional modifiers` | `modAlt→Alt` · `modCtrl→ControlOrMeta` · `modShift→Shift` (ترتیب ثابت) |
| `waitForStableBox(el, ms, timeout)` | `Stable for (ms)` | نظرسنجی `boundingBox` تا وقتی برای بازه‌ی خواسته‌شده بی‌تغییر بماند؛ کران‌دار با deadline |
| `clickPosition(el, dx, dy)` | `Offset X/Y (px)` | دیزاین **مرکز-محور** است، Playwright از **گوشه‌ی چپ-بالا** → تبدیل به `{x: w/2+dx, y: h/2+dy}` |

نکات مهم پیاده‌سازی:
- `clickType` و `clickCount` هم‌تراز می‌شوند: **مقدار مشخص‌تر برنده است**، پس
  «double click» هرگز یک بار اجرا نمی‌شود (`Math.max(clickCount, typedCount)`).
- `waitForSelector` و `visibleOnly` هر دو پیش‌فرض **true** هستند (رفتار قبلی
  یک `waitFor({state:'visible'})` بی‌قید‌وشرط بود). `visibleOnly:false` →
  `state:'attached'`.
- **`multipleMatches` سازگار با گذشته**: کد قدیم همیشه روی `.first()` عمل می‌کرد.
  پس فقط وقتی این فیلد **حاضر باشد و false باشد** حالت strict فعال می‌شود
  (`strictSingleMatch`) و بیش از یک تطبیق خطای واضح می‌دهد. ورکفلوهای قدیمی که
  این کلید را ندارند دست‌نخورده کار می‌کنند.
- ترتیب اجرا: `count` → `waitFor` → `scrollIntoView` → **`waitForStableBox`** →
  `highlight` → `delayBeforeMs` → `clickPosition` → کلیک.
  (پایداری **بعد از** اسکرول سنجیده می‌شود، وگرنه خودِ اسکرول همان حرکتی است که
  منتظرش هستیم.)
- مسیر `humanClick` فقط برای کلیک چپ ساده‌ی تک‌باره **بدون** offset و modifier
  استفاده می‌شود؛ هر چیز غنی‌تر مستقیم به Playwright می‌رود تا همه‌ی گزینه‌ها
  واقعاً اعمال شوند.
- `dblclick`/`hover` هم `modifiers`/`position` را می‌گیرند (`pointerOpts`/`hoverOpts`).
- **payload خروجی گسترش یافت**: `selectorType`, `clickType`, و به‌شرط تنظیم‌شدن
  `modifiers`/`position`.

### 5.2 `src/core/ConditionEngine.ts` — `source` / `attribute`

- تایپ جدید `ConditionSource` صادر شد و `SimpleCondition` دو فیلد اختیاری
  `source?` و `attribute?` گرفت. ثابت `SOURCES` برای اعتبارسنجی.
- دو متد خصوصی جدید:
  - `readFromElement(selector, source, attribute)`:
    | `source` | مقدار چپ |
    |---|---|
    | `text` (پیش‌فرض) | `innerText`، و اگر خالی بود **فال‌بک به `inputValue`** (سازگاری با گذشته) |
    | `attribute` | `getAttribute(attribute)`؛ نام attribute هم `{{var}}` را می‌فهمد؛ نبودِ attribute → `''`؛ نام خالی → فال‌بک به text |
    | `value` | `inputValue()` (حتی اگر عنصر متن داشته باشد) |
    | `html` | `innerHTML` |
  - `readVariable(raw)`: برای `source:'variable'` **بدون لمس DOM**. هم `status`
    و هم `{{status}}` را می‌فهمد. **نام ناشناخته → `''`** (دقیقاً مثل توکن
    ناشناخته)، تا یک غلط تایپی «خالی» خوانده شود نه مقایسه با نام متغیر.
- عنصر پیدانشده برای هر source برابر `''` می‌شود (خطا پرت نمی‌شود) تا
  `is_empty` پاس و `equals` رد شود.
- `source` ناشناخته بی‌صدا به `text` تنزل می‌کند؛ اپراتورهای DOM-only
  (`exists`/`visible`/…) اصلاً `source` را نمی‌خوانند.

### 5.3 تست‌های بک‌اند (اولویت ۲)

| فایل | تست‌ها |
|---|---|
| `tests/unit/click-runtime.test.ts` (**جدید**) | **۱۶ تست** روی چهار هلپر: پیشوند موتور و ضد-پیشوندِ دوباره و فیلتر امنیتی · نگاشت ControlOrMeta و ترتیب ثابت و پذیرش فرم رشته‌ای · تبدیل offset مرکز→گوشه و فال‌بک بدون box · no-op بودن `stableForMs=0` و کران‌دار بودن با deadline |
| `tests/unit/condition-engine.test.ts` (گسترش) | از ۱۹ به **۳۴** تست: هر پنج `source`، اینکه `attribute` متن عنصر را لو نمی‌دهد، `{{var}}` در نام attribute، `variable` که `page.locator` را **هرگز** صدا نمی‌زند، تنزل source ناشناخته، عنصر گم‌شده، و ترکیب سه source داخل یک `all` |
| `tests/unit/ndv-designed-nodes.test.ts` (گسترش) | از ۱۳ به **۱۸** تست. دو گارد **ضد-واگرایی** که *سورس واقعی* `pipeline.ts` را می‌خوانند: (۱) هر کلیدی که پیش‌نمایش OUTPUT نشان می‌دهد باید در payload واقعی باشد و `ControlOrMeta` همان چیزی باشد که موتور می‌فرستد؛ (۲) **هر `finalParams.x` که pipeline می‌خواند باید در `actions.js#fields` اعلام شده باشد** — این همان دام «حذف بی‌صدا» است که حالا خودکار گرفته می‌شود |

### 5.4 دو اصلاح کوچک UI (هم‌خوان‌سازی با بک‌اند)
- `ndv-model.js#clickPayloadPreview` بازنویسی شد تا **عیناً** شکل payload واقعی
  runtime را نشان دهد + هلپر `clickModifierList` صادر شد.
- `ndv-nodes.js` بخش `Behavior`: تاگل `Continue on fail` که spec §2.6 نشان می‌دهد
  اضافه شد. **این یک پارامتر click نیست** — روی `node.errorPolicy` نوشته می‌شود
  (همان منبعی که تب Error ویرایش می‌کند) تا داده دوجا ذخیره نشود.

---

## 5b. ⚠️ کارهای باقی‌مانده (به ترتیب اولویت)

> 🔄 **این بخش تا حدی منسوخ شده.** بعد از این جلسه، سه نقصِ اسکرین‌شات‌ها
> (آیکون‌های شکسته · خطاهای `Unknown action` · چیدمان عمودی نودها) حل شد و
> فهرست باقی‌مانده دقیق‌تر و با لنگرِ خط‌به‌خط بازنویسی شد.
> **فهرست معتبر و به‌روز در `HANDOFF_2026-07-27_ICONS_LAYOUT.md` بخش ۴ است؛
> از آنجا شروع کن.** بخش زیر فقط برای زمینه‌ی تاریخی نگه داشته شده.

### اولویت ۱ — پرداخت‌های میان‌بخشی باقی‌مانده (شل، خارج از دو NDV)
اینها در spec ها مستند شده‌اند ولی هنوز پیاده نشده‌اند. **قبل از شروع، از کاربر
اولویت بگیر** — چون خارج از دامنه‌ی «دو نود طراحی‌شده» هستند:
- **پنل Outline** — درخت شماره‌دار تودرتو (`1 Trigger`, `4 Condition` → `4.1.1 True`).
- **Activity Log سبک `Execution`** — تایم‌لاین با دایره‌ی تیک سبز + نام مرحله +
  توضیح پس از em-dash + زمان راست‌چین. (سبک `Runs` جدولی است.)
- **Minimap** با هدر + `✕` و دکمه‌های `+`/`−`/`Fit`.
- **تولبار شناور بوم** — cursor/hand/lock/frame · زوم − · `100%` · زوم + · fullscreen،
  به‌علاوه `Auto Layout` و `Focus Mode`.
- **منوهای Export ▾ / Save ▾** با `Version History` و `Auto Save: Toggle ON`.
- **انتخاب گروهی** — مستطیل خط‌چین آبی + تولبار پایین گروه.
- **NDV نود HTTP Request** — ردیف‌های تکرارشوی key/value با چیپ توکن و دکمه‌های
  خط‌چین `+ Add Parameter` / `+ Add Header`. **توجه: این نود پیش‌نمایش قفل‌شده
  ندارد** — طبق قانون بخش ۱ نباید طراحی شود، فقط برای زمینه ذکر شده.

### اولویت ۲ — «Run node» واقعی
دکمه‌ی `Run node` در هدر NDV فعلاً `#fe-run` را کلیک می‌کند یعنی **کل ورکفلو**
را اجرا می‌کند، چون endpoint اجرای تک‌نود وجود ندارد. طبق
`shell-editor-condition-ndv.md` §4 باید فقط زیرگراف همان نود را اجرا کند
(در spec ها به‌عنوان سطح **B — Small add** علامت خورده).

### اولویت ۳ — تست دود واقعی مرورگر (اختیاری)
هلپرهای click حالا unit-test دارند، ولی مسیر انتها-به-انتها (Playwright روی یک
صفحه‌ی محلی) تست نشده: کلیک با offset، کلیک با modifier، و `stableForMs` روی یک
عنصر انیمیشن‌دار. برای این کار `playwright install chromium` لازم است.

---

## 6. وضعیت بیلد و تست (تأییدشده در این جلسه)

```
npx tsc --noEmit   → پاس (بدون خروجی)
npm test           → 30 فایل / 490 تست پاس  ← به‌روزشده در جلسه‌ی آیکون/چیدمان
                     (در زمان نگارش این بخش: 29 فایل / 457 تست)
node --check       → همه‌ی فایل‌های JS دست‌خورده پاس
کنسول مرورگر       → صفر پیام روی #/editor (با PlaywrightConsoleCapture)
خط‌پایان           → public/** همه LF · src/*.ts دست‌نخورده با CRLF
```

تفکیک ۳۶ تست جدید: `click-runtime` ۱۶ · `condition-engine` +۱۵ · `ndv-designed-nodes` +۵.

---

## 7. نقشه‌ی فایل‌ها

| فایل | نقش |
|---|---|
| `docs/uiux/*.md` + `*.webp` + `lite/*.jpg` | **منبع حقیقت.** ۶ صفحه: ۲ NDV قفل‌شده + ۴ صفحه‌ی شل/حالت. همه خوانده شده‌اند. |
| `docs/uiux/00-PROCESS-node-design.md` | فرایند طراحی هر نود |
| `public/js/ndv-model.js` | مدل خالص بدون DOM |
| `public/js/ndv-ui.js` | پریمیتیوهای `aria-*` |
| `public/js/ndv-nodes.js` | ستون مرکزی Click + Condition |
| `public/js/flow-editor.js` | شل، بوم، کارت نود، لبه‌ها، منوی زمینه، مودال NDV |
| `public/js/actions.js` | کاتالوگ اکشن‌ها — **هر پارامتر UI باید اینجا اعلام شود** |
| `public/js/graph-serialize.js` | گراف ⇄ `steps[]` بک‌اند |
| `public/js/views.js` | `renderEditor()` = تاپ‌بار + layout + نوار وضعیت |
| `public/js/i18n.js` | `DEFAULT_LANG='en'` + فال‌بک en |
| `public/css/styles.css` | همه‌ی استایل‌ها (~2400 خط) |
| `src/pipeline.ts` | ✅ پارامترهای غنی click + ۴ هلپر export شده (CRLF/LF مخلوط — دست نزن) |
| `src/core/ConditionEngine.ts` | ✅ `source`/`attribute` + `readFromElement`/`readVariable` (CRLF) |
| `tests/unit/ndv-designed-nodes.test.ts` | ۱۸ تست قرارداد دیزاین↔سریالایزر↔runtime |
| `tests/unit/click-runtime.test.ts` | ۱۶ تست روی هلپرهای خالص click |
| `tests/unit/condition-engine.test.ts` | ۳۴ تست، شامل هر پنج `source` |

---

## 8. دام‌های شناخته‌شده (خیلی مهم)

1. **حذف بی‌صدای پارامتر** — پارامتری که در `actions.js#fields` اعلام نشود توسط
   `coerceParams` حذف می‌شود، **بدون هیچ خطایی**. هر کنترل جدید UI = یک فیلد جدید اینجا.
2. **CRLF در `src/*.ts`** — ابزارها ممکن است به LF تبدیل کنند و کل فایل دیف شود.
   با `file src/pipeline.ts` بررسی کن.
3. **پارامترهای فقط-شرطی** — هر کلید جدید بیلدر شرط باید به
   `CONDITION_ONLY_PARAMS` در `graph-serialize.js` اضافه شود، وگرنه برای `while`
   دوبار سریال می‌شود.
4. **`localStorage` در تست‌ها** — `ndv-model.js` فقط `window` را لمس می‌کند، ولی
   `i18n.js` به `localStorage` نیاز دارد؛ در `node:vm` شیم بده.
5. **رشته‌های fa** — دیکشنری fa را حذف نکن. فقط اضافه کردن کلید en کافی است،
   چون `t()` به en فال‌بک می‌کند.
6. **`src/pipeline.ts` خط‌پایان مخلوط دارد** — شاخه‌ی `click` **LF** است و بقیه‌ی
   فایل **CRLF**. با `file src/pipeline.ts` باید «with CRLF, LF line terminators»
   ببینی. یکدست‌سازی = دیف چندهزارخطی؛ برای ویرایش دقیق از پچ بایتی (python)
   استفاده کن نه ابزارهایی که خط‌پایان را نرمال می‌کنند.
7. **پیش‌فرض‌های سازگار با گذشته** — پارامترهای گیت‌کننده‌ی جدید باید طوری
   پیش‌فرض بگیرند که ورکفلوهای قدیمی (که آن کلید را ندارند) رفتارشان عوض نشود.
   نمونه‌ی زنده: `multipleMatches` فقط وقتی **حاضر و false** باشد strict می‌شود؛
   `undefined` = رفتار قدیمی `.first()`. اگر با `parseBoolean` مستقیم می‌گرفتیم،
   هر ورکفلو قدیمی با سلکتور چندتطبیقی **می‌شکست**.
8. **دو نمایش از یک payload** — پیش‌نمایش OUTPUT در `ndv-model.js` و payload
   واقعی در `pipeline.ts` باید هم‌خوان بمانند. تست `ndv-designed-nodes` سورس
   pipeline را می‌خواند و واگرایی را می‌گیرد؛ اگر آن تست شکست، **هر دو** را
   به‌روز کن.
