# HANDOFF — Aria Automate UI/UX (جلسه بعدی دقیقاً از اینجا ادامه بده)

> این فایل طوری نوشته شده که **بدون سابقه‌ی چت** هم کامل قابل فهم باشد.
> تاریخ آخرین به‌روزرسانی: 2026-07-27 · برنچ: `genspark_ai_developer`

---

## 0. خلاصه‌ی یک‌خطی

NDV (Node Detail View) برای **دو نودی که پیش‌نمایش قفل‌شده دارند** (`click` و `if`/`while`)
پیاده شده، همراه با «پایه‌ی دیزاین» مشترک و قواعد میان‌بخشی که از **هر شش** تصویر
`docs/uiux/` استخراج شده. بک‌اند هنوز پارامترهای جدید را اجرا نمی‌کند (بخش ۵).

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

## 5. ⚠️ کارهای باقی‌مانده (به ترتیب اولویت)

### اولویت ۱ — بک‌اند: پارامترهای جدید اجرا نمی‌شوند
> این تنها **شکاف عملکردی** واقعی است. UI پارامترها را ذخیره و سریال می‌کند،
> اما موتور نادیده‌شان می‌گیرد. یعنی کاربر تنظیم می‌کند و «هیچ اتفاقی نمی‌افتد».

**الف) `src/pipeline.ts`** (شاخه‌ی `click`، حدود خط 1259) فقط اینها را می‌فهمد:
`timeout, force, human, button, clickCount, delayBeforeMs, scrollIntoView`.
باید اضافه شود: `selectorType` (css/xpath/text)، `clickType` (single/double/triple)،
`waitForSelector`، `visibleOnly`، `stableForMs`، `offsetX`/`offsetY`،
`multipleMatches`، `highlightElement`، `modAlt`/`modCtrl`/`modShift`.
نگاشت Playwright: `clickCount`، `modifiers: ['Alt','Control','Shift']`،
`position: {x: offsetX, y: offsetY}`، `force`، `timeout`.
**⚠️ CRLF این فایل را حفظ کن.**

**ب) `src/core/ConditionEngine.ts`**: `SimpleCondition` فعلاً
`{operator, value?, expected?, selector?}` است و برای مقدار چپ ابتدا `innerText`
و سپس `inputValue` را می‌خواند. باید `source` و `attribute` را بفهمد:

| `source` | مقدار چپ |
|---|---|
| `text` (پیش‌فرض) | `innerText` |
| `attribute` | `getAttribute(attribute)` |
| `value` | `inputValue()` |
| `html` | `innerHTML` |
| `variable` | مقدار متغیر context |

**⚠️ CRLF این فایل را حفظ کن.** بعد از هر دو: `npx tsc --noEmit` و `npm test`.

### اولویت ۲ — تست‌های بک‌اند
`tests/unit/condition-engine.test.ts` را برای `source`/`attribute` گسترش بده؛
یک تست برای پارامترهای جدید click اضافه کن.

### اولویت ۳ — پرداخت‌های میان‌بخشی باقی‌مانده (شل، خارج از دو NDV)
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

### اولویت ۴ — «Run node» واقعی
دکمه‌ی `Run node` در هدر NDV فعلاً `#fe-run` را کلیک می‌کند یعنی **کل ورکفلو**
را اجرا می‌کند، چون endpoint اجرای تک‌نود وجود ندارد. طبق
`shell-editor-condition-ndv.md` §4 باید فقط زیرگراف همان نود را اجرا کند
(در spec ها به‌عنوان سطح **B — Small add** علامت خورده).

---

## 6. وضعیت بیلد و تست (تأییدشده در این جلسه)

```
npx tsc --noEmit   → پاس (بدون خروجی)
npm test           → 28 فایل / 421 تست پاس (قبلاً 408 بود؛ +13 تست جدید)
node --check       → همه‌ی فایل‌های JS دست‌خورده پاس
کنسول مرورگر       → صفر پیام روی #/editor (با PlaywrightConsoleCapture)
خط‌پایان           → public/** همه LF · src/*.ts دست‌نخورده با CRLF
```

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
| `src/pipeline.ts` | **نیاز به کار** — پارامترهای click (CRLF) |
| `src/core/ConditionEngine.ts` | **نیاز به کار** — `source`/`attribute` (CRLF) |
| `tests/unit/ndv-designed-nodes.test.ts` | ۱۳ تست قرارداد دیزاین↔سریالایزر |

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
