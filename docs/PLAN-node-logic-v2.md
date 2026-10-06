# PLAN — منطقی‌سازی عمیق نودها (Node Logic v2) و مسیر Production

> وضعیت: **پیشنهاد (Draft)** — هنوز هیچ کدی طبق این پلن تغییر نکرده.
> مبنا: `main @ e76b3b8` · تاریخ: 2026-10-06
> هر ادعا در بخش «یافته‌ها» با فایل/خط کد تأیید شده، نه از روی اسناد قدیمی.
> ابزار بازتولید ممیزی: `node tools/audit/catalog-parity.js`
> قوانین ثابت پروژه (R1–R5 در `PROJECT.md`) همه‌جا معتبرند؛ به‌خصوص **R3**:
> «کنترلی که هیچ اثری ندارد ship نکن».

---

## 0. خلاصهٔ مدیریتی

پروژه از نظر **زیرساخت** (صف، مرورگر ریموت/لوکال، live stream، inspector،
امنیت) قوی است، ولی **لایهٔ منطق نود** هنوز در حد «لیست قدم‌های مرورگر با
یک گراف روی آن» است و با مدل n8n فاصلهٔ ساختاری دارد. مشکل اصلی کمبود چند
آپشن نیست؛ **قرارداد بین نودها** (داده، expression، هویت نود، تنظیمات اجرا)
ناقص است و هر نود جدیدی که روی آن ساخته شود همان نقص را به ارث می‌برد.

پنج نقص ساختاری که باید **قبل** از افزودن نود جدید حل شوند:

| # | نقص | اثر روی کاربر |
|---|-----|---------------|
| S1 | `{{ $json.x }}` روی سرور **resolve نمی‌شود** (فقط `{{نام_متغیر}}`) | هر expression که در UI پیش‌نمایش درست دارد، در اجرای واقعی رشتهٔ خالی می‌شود |
| S2 | اجرا **per-item نیست**؛ items فقط ثبت می‌شوند | ۱۰ ردیف extract شده → نود بعدی فقط یک‌بار اجرا می‌شود |
| S3 | گراف (مکان نود، نام، رنگ، نود disabled، نود یتیم) روی سرور **ذخیره نمی‌شود**؛ فقط `steps[]` | بازکردن workflow ذخیره‌شده = auto-layout + **حذف نودهای disabled** |
| S4 | رویداد اجرا با `index` ترتیبی به نود canvas وصل می‌شود، نه با `nodeId` | داخل if/loop هالهٔ «در حال اجرا» روی نود اشتباه می‌افتد |
| S5 | تنظیمات اجرا (headless، نوع مرورگر، trigger فعال) **سطح workflow / سرور** است، نه سطح نود | دقیقاً مثالی که فرمودید: Launch Browser نمی‌تواند حالت پنهان/آشکار را تعیین کند |

پلن در ۸ فاز (۰ تا ۷) چیده شده؛ فازهای ۰ و ۱ پیش‌نیاز بقیه‌اند.

---

## 1. یافته‌های ممیزی (Verified Findings)

### 1.1 باگ‌های قطعی (کنترل در UI هست، در اجرا کار نمی‌کند — نقض R3)

| نود | مشکل | شاهد |
|-----|------|------|
| `upload` | UI فیلد `path` می‌فرستد؛ backend فقط `files`/`filePath` می‌خواند ⇒ **همیشه** خطای `File path(s) required` | `actions.js` upload · `pipeline.ts:2171-2176` |
| `extract`, `http-request` | فیلد «Save as» با کلید `name` تعریف شده؛ backend فقط `step.saveAs` را می‌خواند و هیچ‌جا `params.name → saveAs` نگاشت نمی‌شود ⇒ نتیجه هرگز در متغیر ذخیره نمی‌شود | `pipeline.ts:1676, 2648` · `validation.ts:231` |
| `notification` | فقط یک خط log می‌نویسد؛ هیچ اعلانی به جایی ارسال نمی‌شود | `pipeline.ts:3246-3258` |
| `switch` | فقط مقدار **متغیر** را با برابری دقیق رشته مقایسه می‌کند؛ `casesList` فقط پورت می‌سازد. expression / عملگر / item پشتیبانی نمی‌شود | `pipeline.ts:1406-1415` |
| `foreach` | `items` نام یک **متغیر** است نه items جریان داده؛ آرایه نباشد بی‌صدا skip می‌شود | `pipeline.ts:1378-1386` |
| `loop`/`foreach` | `loop_index` یک متغیر سراسری است ⇒ حلقهٔ تو در تو index بیرونی را overwrite می‌کند | `pipeline.ts:1366, 1394` |
| Triggers | `trigger_webhook` و `trigger_telegram` **هیچ route ورودی ندارند**؛ `trigger_schedule` به `/schedule` وصل نیست؛ سوئیچ `Active` چیزی ثبت/لغو نمی‌کند | `grep trigger_webhook src` ⇒ فقط `TriggerEngine.ts` |
| Live browser در پلن free | بی‌صدا headless اجرا می‌شود؛ کاربر فقط در log می‌فهمد | `pipeline.ts ensureFreeContext` |

### 1.2 قابلیت‌های پنهان (runtime پشتیبانی می‌کند، UI ارائه نمی‌دهد)

خروجی `tools/audit/catalog-parity.js` (موارد مهم):

| نود | پارامترهای پنهان در backend |
|-----|------------------------------|
| `goto` | `timeout`, `waitUntil`, `newTab`, `force`, `smartStay` |
| `screenshot` | `selector`, `fullPage`, `type`, `quality` (UI: **صفر فیلد**) |
| `scroll` | `selector`, `x`, `y`, `amount`, `human` |
| `select` | `label`, `index` |
| `http-request` | `auth`, `retries`, `retryDelay`, `followRedirects`, `validateStatus`, `allowInternal` |
| `switch-tab` | `url`, `title`, `createIfNotFound` |
| `close-tab` | `url`, `title`, `allExcept`, `current` |
| `switch-frame` | `index`, `url`, `name` |
| `wait` | `url`, `urlContains`, `load`, `fn` |
| `drag-drop` | `targetX`, `targetY`, `human` |
| `mouse-move` | `selector`, `speed` |
| `add-style` | `selector`, `global` |
| `cookie` | `url`, `path` |
| `remove-element` | `optional` |

### 1.3 نقص‌های سیستم فیلد / UI

1. **نبود `displayOptions` (نمایش شرطی فیلد).** نودهای چند‌عملیاتی (`variable` با ۷ op،
   `cookie`، `clipboard`) همهٔ فیلدها را همیشه نشان می‌دهند ⇒ UI شلوغ و گیج‌کننده.
   این ریشهٔ اصلی «UI نامناسب» است.
2. انواع `collection`, `fixedCollection`, `assignment`, `filter`, `multiOptions`
   در `FIELD_TYPES` **اعلام** شده‌اند اما renderer عمومی (`flow-editor.js:1877-1917`)
   فقط select/toggle/textarea/json/code/text/number/password/datetime را می‌سازد.
3. `coerceParams` هر `number` را `parseInt` می‌کند ⇒ `{{ }}` در فیلد عددی
   (مثلاً `loop.count = {{ $json.n }}`) **حذف** می‌شود و اعشار از بین می‌رود.
4. فیلدهای «Options» (اختیاری) جدا از «Parameters» (الزامی) نیستند؛ n8n
   پارامترهای کم‌کاربرد را پشت «Add option» می‌گذارد.
5. هیچ اعتبارسنجی inline (required / الگو / وابستگی) در سطح فیلد وجود ندارد؛
   `validateGraph` فقط ۴ قاعدهٔ سخت‌کد دارد.

### 1.4 نقص‌های مدل اجرا / اتصال

1. **گراف = درخت.** `graphToSteps` گراف را به `steps[]` تو در تو تبدیل می‌کند؛
   **fan-in / Merge** ممکن نیست و نودی که از دو شاخه به آن وصل شود
   **دو بار کپی** می‌شود.
2. هر پورت فقط یک یال خروجی دارد (`connect()` قبلی را جایگزین می‌کند)؛ n8n اجازهٔ
   fan-out از یک پورت به چند نود را می‌دهد.
3. **خروجی خطا (Error output)** وجود ندارد؛ فقط `continueOnFail` و `try`.
4. نود هویت پایدار (`nodeId`, `name`) در `AutomationStep` ندارد ⇒
   `$node["Extract"]` قابل پیاده‌سازی نیست، رویدادها به نود درست نمی‌رسند (S4)،
   و پوشهٔ خروجی فایل‌ها با جابه‌جایی نود عوض می‌شود.
5. `Run node` کل prefix را دوباره اجرا می‌کند (درست است) اما **Pin data** وجود
   ندارد ⇒ تست یک نود یعنی تکرار همهٔ کلیک‌ها و side-effectهای قبلی.
6. sub-workflow (Execute Workflow)، Error Workflow، Wait-for-resume (approval
   انسانی / webhook بازگشت) وجود ندارند.

### 1.5 نقص‌های Production

| حوزه | وضعیت فعلی |
|------|-------------|
| Secrets | `botToken`، `secret` وبهوک، `auth` در HTTP به‌صورت **plaintext** داخل JSON workflow در Redis؛ مخزن Credential وجود ندارد |
| Schema versioning | `steps[]` نسخهٔ schema ندارد؛ هیچ مسیر migration برای تغییر نام پارامترها نیست |
| Execution history | فقط در BullMQ/Redis با retention محدود؛ داده‌ی per-node کامل (input/output) ذخیره نمی‌شود |
| Observability | endpoint متریک (`/metrics`) و log ساختاریافته (JSON) وجود ندارد |
| E2E مرورگر | تست واقعی headed (Xvfb) در CI نیست (handoff S21 هم همین را می‌گوید) |
| Webhook ورودی | route، rate-limit، احراز امضا، response mode — هیچ‌کدام وصل نیست |

---
## 2. اصول طراحی (قرارداد جدید نود)

این اصول مرجع تصمیم‌گیری همهٔ فازهای بعدی‌اند:

1. **هر رفتاری که یک نود ایجاد می‌کند، تنظیماتش روی همان نود است.**
   تنظیم سراسری workflow فقط مقدار *پیش‌فرض* است، نه اجبار. (مثال مرورگر در فاز ۲.)
2. **یک نود = یک مسئولیت.** نودی که با `op` رفتار کاملاً متفاوت دارد و فیلدهایش
   ربطی به هم ندارد، یا شکسته می‌شود یا با `displayOptions` فیلدهایش جدا می‌شود.
3. **داده از طریق items جریان دارد، متغیرها فقط برای state سراسری‌اند.**
   هر نود باید بتواند `{{ $json.x }}` و `{{ $node["نام"].json.x }}` بخواند.
4. **اجرای پیش‌فرض per-item است** (مثل n8n)، مگر نود خودش «Execute once» باشد
   یا ماهیتاً تک‌بار باشد (Launch/Close Browser، Trigger).
5. **سرور مرجع حقیقت است:** expression، validation و schema نود هم روی کلاینت
   و هم روی سرور با **یک کد** اجرا شوند (همان تکنیکی که `ActionCatalog.ts` برای
   `actions.js` استفاده می‌کند).
6. **R3 همچنان:** هیچ فیلدی بدون backend؛ هر فیلد جدید با تست سرور + تست UI.

### 2.1 قالب جدید تعریف نود (Node Descriptor v2)

`actions.js` توسعه می‌یابد (backward compatible — فیلدهای قدیمی معتبر می‌مانند):

```js
{
  id: 'launch', version: 2, cat: 'browser', icon: 'rocket',
  execution: 'once',              // 'perItem' (پیش‌فرض) | 'once'
  inputs: 1, outputs: [{ id: 'next' }, { id: 'error', kind: 'error', optional: true }],
  provides: ['browser'],          // این نود «منبع» مرورگر است
  requires: [],                   // نودهای مرورگری: requires: ['browser']
  fields: [
    { k: 'visibility', type: 'options', options: ['headless', 'visible'], default: 'headless' },
    { k: 'liveView', type: 'boolean', default: true,
      displayOptions: { show: { visibility: ['visible'] } } },
    ...
  ],
  options: [ /* فیلدهای اختیاری پشت «Add option» */ ],
  credentials: [ /* { type: 'httpBasic', required: false } */ ],
}
```

کلیدهای جدید: `version`, `execution`, `outputs[].kind`, `provides/requires`,
`default`, `required`, `displayOptions.show/hide`, `options` (گروه اختیاری)،
`credentials`. `ActionCatalog.ts` سمت سرور همین را می‌خواند ⇒ یک منبع.

---

## 3. فازها

### فاز ۰ — پایه و ایمنی (پیش‌نیاز همه) · ~۱ هفته

| کار | جزئیات | معیار پذیرش |
|-----|--------|-------------|
| 0.1 تست parity در CI | `tools/audit/catalog-parity.js` به تست vitest تبدیل شود با allow-list صریح برای handlerهای helper‌دار | PR که فیلد بی‌اثر یا پارامتر پنهان بدون توجیه اضافه کند، fail شود |
| 0.2 رفع باگ‌های 1.1 سطح پایین | `upload.path → files`؛ `name → saveAs` برای extract/http/attribute (نگاشت در `validation.ts` یا تغییر کلید UI به `saveAs` + migration)؛ `loop_index` با stack (`$loop.index`, `$loop.parent`) | تست واحد برای هر مورد |
| 0.3 Schema version | فیلد `schemaVersion` روی workflow و `typeVersion` روی هر step + `src/core/WorkflowMigrations.ts` (زنجیرهٔ migration خالص و تست‌پذیر) | workflow قدیمی بدون تغییر رفتار باز و اجرا شود |
| 0.4 ذخیرهٔ گراف روی سرور | `workflow.graph = { nodes, edges, view }` در کنار `steps` (steps همچنان از گراف مشتق می‌شود). باز کردن workflow گراف را برمی‌گرداند، نه auto-layout | disabled/یتیم/مکان/نام/رنگ پس از reload حفظ شود |
| 0.5 هویت پایدار نود | `step.nodeId` و `step.name` در serialize؛ رویدادهای `step.*` با `nodeId`؛ `run-state.js` با `nodeId` map کند؛ پوشهٔ خروجی بر اساس `nodeId` | هاله و خروجی در if/loop روی نود درست؛ تست reducer |

### فاز ۱ — هستهٔ داده و Expression (n8n parity) · ~۲ هفته

| کار | جزئیات |
|-----|--------|
| 1.1 Expression سرور | `public/js/expression.js` همان‌طور که `ActionCatalog` می‌کند روی سرور load شود (یک پیاده‌سازی، بدون eval). `resolveVariables` → `resolveParam(value, ctx)` با `$json`, `$item`, `$index`, `$node["name"]`, `$vars`, `$env` (allow-list)، `$now`, `$execution.id`, `$workflow.id`. سازگاری عقب: `{{name}}` بدون `$` همچنان متغیر است |
| 1.2 Type-preserving | `{{ $json.count }}` به‌تنهایی عدد/آرایه برگرداند (موتور فعلی کلاینت این را دارد؛ سرور فعلاً `String()` می‌کند) |
| 1.3 اجرای per-item | در `executeStepGroup`: برای نود `perItem`، پارامترها برای هر item جدا resolve و handler n بار اجرا شود؛ خروجی‌ها concat. نودهای مرورگری روی یک page **ترتیبی** اجرا می‌شوند. سقف `MAX_ITEMS_PER_NODE` |
| 1.4 تنظیمات اجرای نود (Settings tab) | مانند n8n: `executeOnce`, `alwaysOutputData`, `retryOnFail/maxTries/wait` (موجود)، `onError: stop | continue | continueErrorOutput`، `timeoutMs` هر نود، `notes`, `notesInFlow` |
| 1.5 خروجی خطا | `onError = continueErrorOutput` ⇒ پورت دوم قرمز `error` روی نود؛ item خطادار `{ json: { error, node, ... } }` |
| 1.6 numbers | `coerceParams` روی مقدار `{{ }}` دست نزند؛ `parseFloat` برای فیلد غیر-integer (`integer: true` صریح) |
| 1.7 Pin data | سنجاق کردن خروجی یک نود در NDV (ذخیره در `graph.pinData`)؛ در تست، نود pin‌شده اجرا نمی‌شود و داده‌اش را می‌دهد. در اجرای production نادیده گرفته می‌شود |

### فاز ۲ — مرورگر به‌عنوان منبع (Browser Session Model) · ~۲ هفته

این فاز دقیقاً مثالی است که مطرح کردید. امروز `headless` یک سوئیچ در هدر ادیتور
است (`views.js:1257 headless: !wantLiveBrowser()`) و نوع مرورگر از تنظیم سرور
(`browserModes.modeOf(userId)`) و پلن (VIP/free) تعیین می‌شود؛ نود Launch هیچ
اختیاری ندارد و فقط `headless` جاری را گزارش می‌کند.

**طراحی جدید — نود `Launch Browser` صاحب session است:**

| فیلد | مقادیر | توضیح |
|------|--------|-------|
| `target` | `remote` · `local` · `extension` (Real Chrome) | پیش‌فرض = تنظیم کاربر؛ اگر در دسترس نباشد خطای **روشن** قبل از اجرا (preflight) |
| `visibility` | `headless` (پنهان) · `visible` (آشکار) | فقط برای `remote`؛ `local` همیشه visible است |
| `liveView` | boolean (فقط وقتی `visible`) | آیا هنگام اجرای تست، تب نمایش زنده باز شود |
| `liveViewMode` | `newTab` · `panel` · `none` | باز کردن تب جدید یا پنل کناری در ادیتور |
| `interactive` | boolean | اجازهٔ کلیک/تایپ کاربر در نمای زنده (takeover)؛ پیش‌فرض خاموش در prod |
| `profile` | ephemeral · persistent:<id> | جایگزین وابستگی ضمنی به VIP |
| `viewport`, `userAgent`, `locale`, `timezone`, `proxy`, `blockResources`, `stealth`, `extensions[]` | options | پارامترهایی که الان در env/پروفایل سراسری‌اند |
| `sessionName` | string | برای چند مرورگر هم‌زمان (نود‌ها با `browser: <sessionName>` انتخاب می‌کنند) |

**رفتار اجرای تستی (Test Workflow):**

```
کاربر Test Workflow را می‌زند
  └─ preflight سرور: گراف را می‌خواند، نودهای Launch را جمع می‌کند
       ├─ هیچ Launch با visibility=visible/liveView=true نیست
       │     ⇒ اجرای عادی مثل n8n: فقط هاله‌ها، run panel، خروجی NDV
       └─ حداقل یکی visible + liveView
             ⇒ پاسخ /run شامل liveView: { jobId, sessionName, url, token }
             ⇒ UI بلافاصله (در همان user-gesture کلیک، تا popup-blocker نزند)
                تب جدید باز می‌کند: /#/live-browser?job=…&session=…
                (یا پنل کناری اگر liveViewMode=panel)
             ⇒ تب وقتی Launch واقعاً اجرا شد به stream وصل می‌شود
                (رویداد جدید browser.ready { nodeId, session }) و تا آن زمان
                «در انتظار اجرای نود Launch…» نشان می‌دهد
             ⇒ با Close Browser یا پایان job: browser.closed ⇒ تب پیام پایان + لینک execution
```

**جزئیات پیاده‌سازی:**

- دکمهٔ هدر «Live browser» حذف نمی‌شود اما معنایش عوض می‌شود: **پیش‌فرض workflow**
  برای Launch‌هایی که `visibility` را صریح نگذاشته‌اند (migration در 0.3: مقدار فعلی
  `liveBrowser` به `visibility` نودهای Launch منتقل شود).
- روی خود نود در canvas یک **badge** (چشم / چشم‌خط‌خورده) و در هدر ادیتور، وقتی
  workflow نود visible دارد، دکمهٔ «Open live view» ظاهر می‌شود؛ در حالت headless
  اصلاً نمایش داده نمی‌شود.
- **Launch ضمنی:** اگر workflow نود مرورگری دارد ولی Launch ندارد، validator یک
  warning می‌دهد و runtime مثل امروز با پیش‌فرض‌ها یک session ضمنی می‌سازد
  (سازگاری عقب). نود مرورگری قبل از Launch در مسیر ⇒ **خطای validation**
  (`requires: ['browser']`).
- پلن free / pool مشترک: به‌جای downgrade بی‌صدا، **preflight** خطای قابل‌فهم
  یا warning صریح در UI («این پلن فقط headless است») — نه فقط log.
- امنیت live view: توکن کوتاه‌عمر امضاشده per-job (همان الگوی `StepReporter`
  share token)، فقط owner؛ `interactive` نیاز به consent جداگانه دارد (الگوی
  `RemoteTargetConsent`).
- اجرای production (schedule/webhook) هرگز تب باز نمی‌کند؛ اما اگر visible باشد
  در صفحهٔ Executions دکمهٔ «Watch live» فعال است.
- رسیدگی به منابع: `visible` نیازمند display (Xvfb) است ⇒ `Desktop.ensureDisplay()`
  در preflight، نه در وسط اجرا؛ سقف هم‌زمانی visible جدا از headless
  (`MAX_VISIBLE_SESSIONS`).

### فاز ۳ — بازسازی نودهای موجود (Split / Merge / Options) · ~۲–۳ هفته

#### 3.1 نودهایی که باید **دو (یا چند) نود** شوند

| فعلی | جدید | دلیل |
|------|------|------|
| `variable` (۷ op با فیلدهای نامرتبط) | **Set / Edit Fields** (assignment list، مثل n8n Set) + **Text Transform** (regex/replace/slice/split/join) + **Sort** | سه مسئولیت متفاوت؛ امروز همهٔ ۱۱ فیلد همیشه نمایش داده می‌شوند |
| `cookie` (getAll/get/set/clear) | **Get Cookies** + **Set Cookie** + **Clear Cookies** | ورودی/خروجی متفاوت؛ یا یک نود با `displayOptions` |
| `clipboard` (get/set/copy/paste) | **Clipboard Read** + **Clipboard Write** | |
| `extract` + `extract-data` + `attribute` | **Extract** واحد با `mode: single|list|table` و `fields[]` (fixedCollection: name + selector نسبی + text/attr/html/value) | سه نود هم‌پوشان؛ table-scrape (ردیف × ستون) امروز ممکن نیست |
| `wait` (ms/selector/url/load/fn) | **Delay** (فقط زمان، موجود) + **Wait For** (element/url/load/network idle/function، با displayOptions) | `wait` امروز هر دو کار را می‌کند و UI فقط ۲ تا را نشان می‌دهد |
| `fill` + `type` | یک **Type Text** با `mode: fill|type(human)` + `clearFirst`, `delay`, `pressEnter` | دو نود تقریباً یکسان |
| `dblclick` | ادغام در `click` (`clickType` موجود است) — نگه داشتن alias برای سازگاری | تکراری |
| `check` + `uncheck` | **Set Checkbox** با `state: checked|unchecked|toggle` | |
| `if` | **If** (دو خروجی true/false، ساده) + **Router / Switch** (چند مسیر اولویت‌دار — همان `paths` فعلی) | امروز یک نود دو حالت کاملاً متفاوت UI دارد |
| `close-browser` | فقط session همان Launch را ببندد (با `sessionName`)، و **`return` نکند** | امروز `return: true` برمی‌گرداند ⇒ نودهای بعدی (مثلاً HTTP/notification) اجرا **نمی‌شوند** |

#### 3.2 نودهایی که آپشن کم دارند (افزودن، با backend)

- **Switch:** حالت `rules` (هر case با عملگر Condition Builder) + حالت `expression` (index خروجی)؛ ورودی از `$json` نه فقط متغیر؛ `fallbackOutput`.
- **Loop / ForEach → `Loop Over Items` (Split in Batches):** `batchSize`, منبع = items ورودی یا expression آرایه؛ خروجی `done` همهٔ نتایج جمع‌شده. `loop` شمارشی می‌ماند.
- **HTTP Request:** UI برای `auth` (Credential)، `query params` (collection)، `body type` (json/form/multipart/raw)، `pagination`، `retries`، `followRedirects`، `fullResponse`، `ignoreSSL` (با هشدار)، `proxy`.
- **Goto:** `waitUntil`, `timeout`, `newTab`, `referer`.
- **Screenshot:** `selector`, `fullPage`, `type`, `quality`, `omitBackground`, `outputMode: file|binary|base64`.
- **Scroll:** `mode: page|element|by|infinite` + `untilSelector`, `maxScrolls` (infinite scroll برای scrape ضروری است).
- **Select:** `by: value|label|index` + multi.
- **Switch Tab / Close Tab / Switch Frame:** همهٔ پارامترهای پنهان جدول 1.2.
- **Handle Dialog:** `once` در برابر `persistent`؛ `matchText`؛ خروجی متن دیالوگ.
- **Upload:** منبع فایل = Workflow Files / binary از نود قبل / URL.
- **Download:** خروجی binary روی item (نه فقط مسیر).
- **Notification:** کانال واقعی (فاز ۴).

### فاز ۴ — نودهای جدید (به ترتیب اولویت) · ~۳–۴ هفته

**P0 — بدون این‌ها منطق n8n کامل نیست:**

| نود | کار |
|-----|-----|
| **Merge** | fan-in: `append`, `combineByPosition`, `combineByField`, `chooseBranch`, `waitAll`. نیازمند فاز 5 (اجرای DAG) |
| **Code (sandboxed)** | JS در `isolated-vm`/`vm` با timeout/memory cap، بدون network/fs؛ `$input.all()`, `$json`. یا اگر سیاست «بدون اجرای کد کاربر» حفظ شود: نود **Expression / Formula** قدرتمند. (تصمیم معماری لازم — بخش ۵) |
| **Filter** | حذف items با Condition Builder (موجود) |
| **Sort / Limit / Remove Duplicates / Aggregate / Split Out** | عملیات روی items؛ همه pure و تست‌پذیر |
| **Respond to Webhook** | پاسخ سفارشی به trigger وبهوک (status/headers/body) |
| **Execute Workflow** + **Execute Workflow Trigger** | sub-workflow با ورودی/خروجی items؛ محافظت در برابر بازگشت بی‌نهایت (depth cap) |
| **Error Trigger** | workflow خطا: وقتی workflow دیگری fail شد اجرا شود |
| **No-Op / Sticky Note** | نود عبوری و یادداشت canvas (Sticky فقط در graph، نه steps) |

**P1 — مرورگر:**

`Evaluate / Run Script in page` (با سیاست امنیتی مشخص) · `Get Page Info` (url/title/html) · `Wait for Network / Response` (intercept پاسخ API — برای scrape بسیار ارزشمند) · `Block Requests` · `Set Viewport / Emulate Device` · `Keyboard Shortcut` · `Solve Captcha (provider)` · `Save/Load Session State` (storageState) · `PDF of page` · `Table Scrape` (اگر در Extract ادغام نشود).

**P2 — یکپارچگی و داده:**

`Send Email (SMTP)` · `Telegram Send` · `Slack/Discord webhook` · `Read/Write File` (Workflow Files) · `Spreadsheet (CSV/XLSX parse & build)` · `Date & Time` · `Crypto/Hash` · `HTML Extract (از رشته، بدون مرورگر)` · `XML` · `Compression` · `Wait (resume on webhook / approval)`.

### فاز ۵ — موتور اجرا: از درخت به DAG · ~۳ هفته (پرریسک‌ترین)

1. **Executor جدید گراف‌محور** (`src/core/GraphExecutor.ts`) که مستقیم روی
   `graph.nodes/edges` کار می‌کند: صف اجرای نودها، پشتهٔ اجرای n8n-style، هر یال
   items مخصوص خودش را حمل می‌کند، Merge منتظر ورودی‌ها می‌ماند.
2. `pipeline.ts` handlerها از حلقهٔ ۳۴۰۰ خطی به **رجیستری handler** منتقل شوند:
   `src/nodes/<id>.ts` با `{ descriptor, execute(ctx, items, params) }`. این
   همزمان قابلیت تست واحد per-node و بارگذاری module خارجی را یکسان می‌کند.
3. دوران گذار: `steps[]` قدیمی ⇒ adapter به گراف (`stepsToGraph` سرور) ⇒ یک
   موتور. اجرای موازی دو موتور پشت flag `EXECUTOR=graph|legacy` با تست
   مقایسه‌ای (golden) روی همهٔ fixtureها قبل از حذف legacy.
4. fan-out چند یال از یک پورت؛ اجرای شاخه‌ها **ترتیبی** و قطعی (مثل n8n v1
   execution order) — اجرای موازی شاخه‌ها روی یک page ممنوع.
5. cycle: فقط از طریق نودهای Loop صریح؛ یال برگشتی دلخواه ⇒ خطای validation.

### فاز ۶ — UI/UX ادیتور و NDV · موازی با فازهای ۳–۵

1. **Renderer عمومی** برای `collection`, `fixedCollection`, `assignment`,
   `filter`, `multiOptions`, `resourceLocator` (انتخاب selector/فایل/workflow)،
   با `displayOptions` و بخش «Add option».
2. **Expression editor** با autocomplete متغیرها از خروجی واقعی نودهای قبلی
   (drag فیلد از INPUT به پارامتر ⇒ `{{ $json.price }}`)، پیش‌نمایش نتیجه
   برای item جاری، نمایش خطای expression.
3. **Validation inline:** نشانگر قرمز روی نود و فیلد (required، `requires:
   browser`، expression نامعتبر، credential ناقص) — همان قواعد سرور.
4. **Settings tab** هر نود (فاز 1.4) + **Notes**.
5. نمای اجرا: انتخاب run/iteration در NDV (`runSelector` موجود است)، item
   navigator، table/JSON/binary view، **Pin data**، «Execute previous nodes».
6. Canvas: پورت error قرمز، badge مرورگر/visibility روی Launch، چند یال از یک
   پورت، Sticky note، شمارندهٔ items روی هر یال پس از اجرا.
7. صفحهٔ Live Browser (تب جدید فاز ۲): stream + timeline نودها کنار هم، دکمهٔ
   takeover/release، نشانگر نود جاری.
8. a11y + fa/en parity (R5) برای همهٔ کلیدهای جدید.

### فاز ۷ — Production Readiness · موازی، ولی gate انتشار

| حوزه | کارها |
|------|------|
| **Credentials** | مخزن رمزگذاری‌شده (AES-256-GCM، کلید از `CREDENTIALS_KEY`/KMS)، نوع‌ها (HTTP basic/bearer/header/OAuth2، SMTP، Telegram bot، proxy)؛ workflow فقط `credentialId` نگه می‌دارد؛ هرگز در event/log/export؛ migration برای secretهای plaintext فعلی |
| **Triggers واقعی** | `POST/GET /webhook/:path` و `/webhook-test/:path` (حالت تست = فقط وقتی ادیتور «Listen» می‌زند، مثل n8n)؛ HMAC (`verifyTriggerAuth` موجود)، rate-limit، حداکثر حجم body، response mode (`onReceived`/`lastNode`/`respondNode`). Schedule: `Active` ⇒ ثبت repeatable job، `Inactive` ⇒ حذف (idempotent، هنگام boot reconcile). Telegram: webhook یا long-poll با lock توزیع‌شده |
| **Executions** | ذخیرهٔ پایدار execution + داده‌ی per-node (قابل تنظیم: `saveDataOnSuccess/Error`، `EXECUTIONS_DATA_MAX_AGE`, pruning)؛ «Retry from failed node»؛ Redis برای حجم بالا مناسب نیست ⇒ Postgres/SQLite اختیاری پشت یک repository interface |
| **Concurrency & quotas** | سقف per-workflow، per-user، visible sessions؛ timeout کل workflow؛ cancel تضمینی (بستن page/context)؛ backpressure صف |
| **Observability** | log ساختاریافته JSON با `jobId/nodeId/workflowId`؛ `/metrics` Prometheus (job duration، node failure rate، queue depth، browser pool)؛ health readiness/liveness جدا؛ tracing اختیاری |
| **امنیت** | SSRF guard برای HTTP Request هم (نه فقط webhook خروجی)؛ allow-list `$env`؛ sandbox نود Code؛ CSP حفظ؛ audit log برای credential و تغییر workflow؛ مرور مجوز live-view interactive |
| **Versioning & import/export** | `schemaVersion` + migration (فاز 0.3)؛ export بدون secret؛ import n8n/Automa (سازگاری نسبی) |
| **تست** | واحد per-node (رجیستری فاز ۵)، golden execution fixtures، E2E Playwright روی Xvfb در CI برای visible/live-view، تست بار صف، تست migration |
| **مستندات** | مرجع نود auto-generated از descriptorها (یک منبع)، `docs/API.md` + `openapi.yaml` برای webhook trigger، راهنمای upgrade |
| **Release** | feature flag برای موتور جدید، canary، backup/restore Redis + storage، changelog |

---

## 4. ترتیب پیشنهادی و وابستگی‌ها

```
فاز 0 ──► فاز 1 ──┬──► فاز 2 (مرورگر)  ──┐
                  ├──► فاز 3 (بازسازی)   ──┼──► فاز 4 P1/P2
                  └──► فاز 5 (DAG) ──► فاز 4 P0 (Merge, Sub-workflow)
فاز 6 (UI) موازی با 2–5 · فاز 7 موازی، ولی gate انتشار
```

**Milestoneها:**

| M | محتوا | خروجی قابل‌نمایش |
|---|-------|------------------|
| M1 | فاز 0 + 1.1/1.2/1.6 | `{{ $json.x }}` واقعاً کار می‌کند؛ گراف بعد از reload سالم است؛ باگ‌های upload/saveAs رفع |
| M2 | فاز 1 کامل + فاز 2 | per-item، Settings tab، error output، **Launch Browser با پنهان/آشکار و تب Live view** |
| M3 | فاز 3 + 6.1–6.4 | نودهای بازسازی‌شده با UI تمیز (displayOptions) |
| M4 | فاز 7 (Credentials + Triggers + Executions) | webhook/schedule واقعی؛ secret امن → **قابل استفاده در production** |
| M5 | فاز 5 + فاز 4 P0 | Merge، sub-workflow، موتور DAG |
| M6 | فاز 4 P1/P2 + بقیهٔ 6/7 | کاتالوگ کامل نود، E2E، metrics |

---

## 5. تصمیم‌هایی که صاحب محصول باید بگیرد

1. **نود Code:** اجرای JS کاربر در sandbox (قدرت n8n) یا ماندن روی سیاست فعلی
   «بدون اجرای کد کاربر» و فقط Expression قوی؟ (روی امنیت و پلن multi-tenant اثر دارد.)
2. **ذخیره‌ساز Executions/Credentials:** فقط Redis، یا افزودن Postgres/SQLite؟
3. **شکستن `if` به If + Router** یا نگه داشتن یک نود با دو حالت؟
4. **Live view در تب جدید یا پنل داخل ادیتور** به‌عنوان پیش‌فرض؟
5. **سازگاری با n8n:** فقط مفهومی، یا import فایل JSON n8n هم هدف است؟
6. اولویت M4 (production) قبل از M5 (DAG)؟ — پیشنهاد این سند: **بله**.

---

## 6. ریسک‌ها

| ریسک | کاهش |
|------|------|
| بازنویسی موتور (فاز 5) رفتار workflowهای موجود را عوض کند | دو موتور پشت flag + golden tests + adapter steps→graph |
| per-item روی نودهای مرورگر (یک page) side-effect غیرمنتظره بدهد | پیش‌فرض `executeOnce` برای نودهای navigation؛ هشدار UI وقتی >1 item به نود مرورگری می‌رسد |
| migration پارامترها workflow ذخیره‌شده را خراب کند | migrationهای pure با تست، نسخهٔ قبلی در `versions` حفظ می‌شود |
| visible sessions منابع سرور را تمام کنند | سقف جدا، idle timeout، preflight |
| افزایش سطح حمله (webhook ورودی، Code، live interactive) | rate-limit، HMAC، sandbox، consent، audit log |

---

## 7. گام بعدی پیشنهادی

شروع با **M1** در PRهای کوچک و جدا (هر کدام با تست):
1. `fix(nodes)`: upload path، name→saveAs، loop index stack (0.2)
2. `test(audit)`: parity به‌عنوان تست CI (0.1)
3. `feat(storage)`: graph روی سرور + nodeId در stepها و رویدادها (0.4, 0.5)
4. `feat(expr)`: موتور expression مشترک روی سرور (1.1, 1.2, 1.6)
