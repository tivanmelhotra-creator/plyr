# 📋 PLAN.md — بازیابی و تکمیل پروژه `automation-backend-v37`

> این فایل نقشه‌ی راه پروژه است. در هر جلسه **اول این فایل را بخوان**، ببین کدام استپ‌ها `[x]` خورده‌اند، و از **اولین استپ ناتمام** شروع کن.

---

## 🚀 مدل استقرار: Self-Hosted تک‌کاربره/تیمی (تصمیم جلسه‌ی ۲ — بسیار مهم)

> **تصمیم صاحب پروژه:** پروژه **رایگان و پابلیک (open-source)** منتشر می‌شود و هر کاربر آن را **روی سرور شخصی خودش** اجرا می‌کند (کنار n8n خودش). دلیل: سرور عمومی مشترک برای اتوماسیون مرورگر **ریسک امنیتی/سوءاستفاده بالایی** دارد (کارهای مخرب، دردسر اشتراکی) و ارزش مدیریت VIP/اشتراک را ندارد. self-hosted هم امن‌تر است، هم خدمت به جامعه، هم منطقی‌تر (همان جایی که n8n هست).

**🎯 تأثیر روی معماری (بله، تأثیر دارد — و مثبت است: ساده‌سازی بزرگ):**

| بخش | در مدل قبلی (SaaS چندکاربره) | در مدل جدید (Self-Hosted) |
|------|------------------------------|----------------------------|
| **کاربران** | چند کاربر، سطح‌بندی، plan | معمولاً **تک‌کاربر** (صاحب سرور) یا تیم کوچک معتمد |
| **VIP/Free** | منطق Hybrid پیچیده | **حذف تمایز** — همه «full access». مرورگر persistent برای همه |
| **Quota روزانه** | لازم برای جلوگیری از سوءاستفاده | **پیش‌فرض نامحدود** (منابع مال خودته) |
| **Rate Limit** | سخت‌گیرانه | **سبک/اختیاری** (فقط محافظت پایه) |
| **Plan/Level/Override** | سیستم کامل (~۴۷۵ خط UserManager) | **اختیاری/خاموش** به‌صورت پیش‌فرض |
| **block-user / admin بر کاربران** | لازم | **عملاً بی‌معنی** در تک‌کاربر |
| **API Key** | الزامی برای تفکیک کاربر | **یک توکن ساده** برای محافظت سرور شخصی (نه تفکیک کاربر) |
| **امنیت** | محافظت کاربران از هم | **محافظت سرور از اینترنت** (چون پابلیک نصب می‌شود) |

**✅ تصمیم پیاده‌سازی (بدون حذف کد، با سوییچ):**
معرفی متغیر `DEPLOYMENT_MODE` با دو مقدار:
- **`single`** (پیش‌فرض، توصیه‌شده): تک‌کاربره. VIP/Quota/Plan خاموش، همه full-access، یک API token برای محافظت، rate-limit سبک. ساده برای نصب در ۵ دقیقه کنار n8n.
- **`multi`**: حالت SaaS کامل فعلی (همه‌ی منطق VIP/Quota/Plan/Admin فعال) — برای کسانی که می‌خواهند سرویس عمومی بزنند.

> این کار مزیت رقابتی ما (سروری/مقیاس‌پذیر) را **حفظ** می‌کند ولی **مسیر پیش‌فرض را برای جامعه ساده و امن** می‌سازد. → استپ جدید **۱۸**.

**🔐 نکات امنیتی self-hosted پابلیک (چون روی اینترنت نصب می‌شود):**
- مستندسازی محکم: حتماً پشت auth، توصیه به اجرای پشت reverse-proxy/VPN، هشدار درباره‌ی `--no-sandbox`.
- مقدار پیش‌فرض امن: `API_TOKEN` تصادفی هنگام اولین اجرا تولید شود (نه مقدار `change_me`).
- محافظت SSRF و path-traversal که الان هست → حفظ و تقویت شود (در self-hosted مهم‌تر است چون به شبکه‌ی داخلی کاربر دسترسی دارد).

---

## 🏛️ معماری مرجع پروژه (تثبیت‌شده در جلسه‌ی ۲ — منبع حقیقت)

> صاحب پروژه نقشه‌ی اصلی ۲ سال پیش را دقیق به‌خاطر ندارد؛ این بخش **معماری رسمی و مرجع** است که همه‌ی استپ‌ها باید با آن هم‌راستا باشند.

**ایده‌ی کلان:** پروژه دو بخش دارد — **سمت کلاینت (چند منبع)** و **سمت سرور (مغز پردازش)**. هر کلاینتی workflow/دیتای اتوماسیون را به سرور می‌فرستد؛ سرور آن را می‌پذیرد، ذخیره/صف می‌کند، اجرا می‌کند، و یک **مسیر زنده (Live)** برمی‌گرداند تا کاربر روند و باگ‌های اتوماسیونش را لحظه‌به‌لحظه ببیند.

```
┌─────────────── کلاینت‌ها (Producers) ───────────────┐        ┌──────────── سرور (مغز) ────────────┐
│                                                     │        │                                     │
│  • افزونه‌ی مرورگر (ضبط/ارسال اتوماسیون)            │        │  1) دریافت + احراز هویت (API Key)   │
│  • n8n (ارسال/استلاج workflow)                      │─REST──▶│  2) اعتبارسنجی + ذخیره (storage)    │
│  • داشبورد UI (ساخت/اجرای workflow)                 │ /WS    │  3) صف (BullMQ + Redis)            │
│  • هر کلاینت آینده (mobile/CLI/SDK)                 │        │  4) اجرا (Playwright pipeline)     │
│                                                     │        │  5) انتشار رویداد زنده (Live)      │
└─────────────────────────────────────────────────────┘        └──────────────┬──────────────────────┘
                                                                              │
                          ┌───────────── مسیر زنده (Live Channel) ◀───────────┘
                          ▼
        کاربر در داشبورد (یا هر کلاینت) لحظه‌به‌لحظه می‌بیند:
        • لاگ زنده‌ی هر step  • وضعیت/خطا  • تصویر زنده‌ی مرورگر (screencast)  • باگ اتوماسیون
```

**اصول معماری که از این پس رعایت می‌شوند:**
1. **سرور client-agnostic است:** قرارداد یکسان برای همه‌ی کلاینت‌ها (افزونه، n8n، UI، آینده) — یک فرمت workflow + یک API.
2. **هر workflow ذخیره می‌شود (Workflow Storage):** نه فقط اجرای آنی؛ باید بشود ذخیره، بازاجرا، نسخه‌بندی و از طریق هر کلاینت مدیریت کرد. → این یک شکاف فعلی است (پایین).
3. **مسیر زنده (Live Channel) شهروند درجه‌یک است:** یک کانال استاندارد (WebSocket/SSE) که رویدادهای زنده‌ی job را پخش می‌کند: `log`, `step.start`, `step.done`, `step.error`, `screenshot/frame`, `job.done`. هر کلاینت می‌تواند subscribe کند.
4. **یک منبع حقیقت برای وضعیت job:** Redis؛ هم poll (`/job/:id`) هم push (Live) از همان می‌خوانند.

**وضعیت فعلی نسبت به این معماری:**
- ✅ سرور، صف، اجرا، احراز هویت، webhook خروجی — موجود است.
- ⚠️ **«مسیر زنده» فقط ابتدایی است:** الان فقط با poll کردن `/job/:id` یک `liveStatus` ساده (URL فعلی + یک پیام) برمی‌گردد. **استریم زنده‌ی لاگ و تصویر وجود ندارد.** → استپ‌های ۱۲ و یک استپ جدید Live.
- ⚠️ **Workflow Storage مستقل وجود ندارد:** فقط نتیجه‌ی job ذخیره می‌شود، نه خودِ workflowها برای بازاجرا/مدیریت. → استپ جدید.
- ⚠️ **قرارداد client-agnostic رسمی نیست:** فرمت‌ها پراکنده‌اند؛ باید یک اسکیمای واحد + OpenAPI تعریف شود. → استپ ۱۴.

---

## 🧭 پروژه چیست؟

یک **Backend اتوماسیون مرورگر در سطح Enterprise** که با **Node.js + TypeScript** نوشته شده.

| بخش | تکنولوژی |
|------|-----------|
| وب‌سرور | Express 4 + Helmet (CSP) |
| صف کارها | BullMQ روی Redis |
| اتوماسیون مرورگر | Playwright + playwright-extra + stealth |
| ذخیره‌سازی | Redis (ioredis) + فایل JSON روی دیسک |
| اجرای production | PM2 cluster (۴ worker) |
| احراز هویت | API Key + Admin Secret |

**معماری Hybrid:** کاربران VIP مرورگر اختصاصی persistent دارند؛ کاربران Free از یک مرورگر مشترک (GlobalBrowser) با context ایزوله استفاده می‌کنند.

**قابلیت‌های اصلی:**
- موتور Flow با شرط (`if/else`), حلقه (`while`), خطا (`try/catch/finally`), `switch/case`
- اجرای ماژول‌های افزونه‌ای (`modules/*`)
- زمان‌بندی cron (Schedule) با BullMQ repeatable jobs
- سیستم Quota روزانه + Rate Limit + Plan کاربری
- Webhook با retry و محافظت SSRF
- لغو کار (cancel) با بستن tab/browser

**کد:** ~۸٬۰۰۰ خط TypeScript در ۲۳ فایل.

---

## ⚔️ مقایسه با Automa (github.com/AutomaApp/automa)

> Automa مرجع شماره‌یک متن‌باز در حوزه‌ی اتوماسیون مرورگر است. مقایسه برای تعیین مسیر توسعه.

**تفاوت بنیادی معماری:**

| محور | پروژه ما (`automation-backend`) | Automa |
|------|----------------------------------|--------|
| نوع | **Backend سروری** (Node.js + Playwright) | **افزونه‌ی مرورگر** (Chrome/Firefox Extension) |
| اجرا | مرورگر سمت **سرور** کنترل می‌شود | داخل **مرورگر خودِ کاربر** اجرا می‌شود |
| Frontend | ❌ ندارد | ✅ Vue 3 + Vue Flow (ادیتور بصری drag-and-drop) |
| تعریف Flow | JSON (آرایه‌ی steps) | بلوک‌های گرافیکی به‌هم‌متصل |
| مقیاس‌پذیری | ✅ صف، چند کاربر، Quota، VIP/Free، PM2 cluster | تک‌کاربره، محدود به یک مرورگر |
| لایسنس | MIT | AGPL + لایسنس تجاری |

### 💪 نقاط قوت ما (که Automa ندارد)
- **معماری چندکاربره و سروری:** صف BullMQ، اجرای همزمان، Quota روزانه، پلن VIP/Free، Rate Limit، API Key — Automa هیچ‌کدام را ندارد (تک‌دستگاهه).
- **استقرار مرکزی:** یک سرور برای صدها کاربر؛ مناسب SaaS و سرویس‌دهی تجاری.
- **stealth واقعی سمت سرور:** playwright-extra + stealth + پروفایل persistent برای VIP — ضدتشخیص قوی‌تر برای اسکریپینگ سنگین.
- **TypeScript strict + ساختار سرویس‌محور تمیز** (routes/services/middleware/core).
- **Webhook با retry و محافظت SSRF** به‌صورت داخلی.

### 🔻 نقاط ضعف ما (که Automa دارد و ما نداریم)
- **❌ بدون رابط کاربری بصری:** بزرگ‌ترین ضعف. Automa ادیتور flow گرافیکی دارد؛ ما فقط JSON خام. → استپ‌های ۷، ۸، ۱۰
- **❌ تعداد بلوک/اکشن خیلی کمتر:** Automa **~۵۰+ بلوک** آماده دارد (Google Sheets، Drive، Cookie، Clipboard، Proxy، Export به CSV/JSON/PDF، Notification، AI Workflow، Regex/Slice/Sort داده، Loop Elements/Data، JavaScript Code، Dialog handler و...). ما مجموعه‌ی اکشن محدودتری داریم. → استپ ۱۱
- **❌ بدون Marketplace/اشتراک workflow:** Automa بازارچه‌ی اشتراک‌گذاری دارد.
- **❌ بدون Trigger متنوع:** Automa تریگر روی رویدادها/visit/shortcut دارد؛ ما فقط `/run` و cron.
- **❌ بدون i18n و مستندات کاربری غنی.**
- **❌ بدون export/import داده به فرمت‌های Google Sheets/CSV/PDF/xlsx.**

### 🎯 جمع‌بندی استراتژی
ما نباید کلون Automa شویم؛ مزیت ما **سروری/چندکاربره/SaaS** است. اما باید شکاف‌های کلیدی را پر کنیم:
1. **رابط کاربری بصری** (الهام از Vue Flow Automa) — استپ‌های ۷، ۸، ۱۰
2. **افزایش تعداد بلوک‌ها/اکشن‌ها** به‌سبک Automa (Export داده، Loop، Regex، Cookie و...) — استپ ۱۱
3. **تعامل با مرورگر مثل افزونه** (نکته‌ی صاحب پروژه) — استپ‌های ۱۲، ۱۳
4. **ادغام با n8n** (نکته‌ی صاحب پروژه) — استپ‌های ۱۴، ۱۵

---

## 🎯 دو نکته‌ی کلیدی صاحب پروژه (جلسه‌ی ۲) — تحلیل و تصمیم معماری

### نکته ۱ — «باید مثل افزونه‌ی کروم با مرورگر تعامل داشته باشیم»

**مشکل امروز:** پروژه مرورگر را سمت سرور headless کنترل می‌کند و کاربر هیچ ارتباط بصری/مستقیمی با آن ندارد. کاربر باید سلکتورها را دستی در JSON بنویسد — سخت و گیج‌کننده. درست مثل گفته‌ی صاحب پروژه: «با رابط مجزا از مرورگر سخته بفهمه چی به چیه.»

**راه‌حل (دو لایه‌ی مکمل):**

- **راهکار A — Live Browser View در UI (سمت سرور):**
  نمایش زنده‌ی همان مرورگر سروری داخل داشبورد با **CDP Screencast** (استریم فریم‌ها روی WebSocket که از قبل `ws` در deps هست). کاربر صفحه را زنده می‌بیند، روی عناصر کلیک می‌کند، و یک **Element Picker** سلکتور CSS/XPath را خودکار تولید می‌کند و داخل step می‌گذارد. → استپ ۱۲

- **راهکار B — افزونه‌ی کمکی Chrome (سمت کاربر):**
  یک افزونه‌ی سبک کروم که کاربر روی **مرورگر واقعی خودش** نصب می‌کند؛ با کلیک روی هر عنصر سایت، سلکتور را گرفته و به backend می‌فرستد (مثل تجربه‌ی Automa/iMacros). برای «ضبط» اکشن‌ها و ساخت flow از روی رفتار واقعی کاربر هم استفاده می‌شود. → استپ ۱۳

> تصمیم: **راهکار A اولویت بالاتر** دارد (چون با معماری سروری ما جور است و نیاز به نصب چیزی توسط کاربر ندارد). راهکار B به‌عنوان مکمل قدرتمند بعد از آن.

### نکته ۲ — «باید با n8n هم بشه ارتباط گرفت»

**مشکل امروز:** فقط `/run` (async) و یک webhook خروجی ساده داریم. برای n8n کافی نیست: n8n به یک **API قابل‌اتصال و قابل‌پیش‌بینی** + **node اختصاصی** نیاز دارد.

**راه‌حل:**

- **بهبود API برای ادغام (استپ ۱۴):**
  - حالت **sync اختیاری**: `POST /run?wait=true` که تا پایان جاب صبر کند و نتیجه را برگرداند (مناسب node معمولی n8n).
  - **callback/webhook استاندارد** با امضای HMAC برای امنیت (n8n Webhook node آن را می‌گیرد).
  - مستند **OpenAPI/Swagger** (`docs/openapi.yaml`) تا n8n HTTP Request node راحت کانفیگ شود.
  - فرمت خروجی یکدست و قابل‌parse (همان `{ success, jobId, stepOutputs, result }`).

- **n8n Community Node (استپ ۱۵):**
  ساخت پکیج `n8n-nodes-automationbackend` با عملیات: `Run Workflow`, `Get Job Result`, `Create Schedule`, `Cancel Job` + یک **Trigger node** که webhookهای ما را دریافت می‌کند. مطابق استاندارد n8n (credentials = API Key + Base URL).

### نکته ۳ (جلسه‌ی ۳) — «رابط کاربری باید node-based (گراف نودها) باشد مثل Automa»

**خواسته‌ی صاحب پروژه:** پروژه‌ی [Automa](https://github.com/automaapp/automa) را بررسی کن؛ مدل **node-based** آن (هر اکشن یک «نود» روی بوم گرافی، با اتصال نودها به هم برای ساخت جریان) خیلی کمک‌کننده است. صاحب پروژه می‌خواهد UI ما هم **دقیقاً node-based** باشد تا کاربر **اختیار و کنترل بهتری** روی ساخت/ویرایش جریان داشته باشد (درگ-اند-دراپ نودها، اتصال بصری، شاخه/شرط/حلقه به صورت نود) — نه فقط فرم خطی افزودن step.

**تصمیم معماری:** این دقیقاً هدف **استپ ۱۰** است (ادیتور Flow بصری) و این نکته اولویت/دامنه‌ی آن را تقویت می‌کند:
- ادیتور باید گراف node-based واقعی باشد (الهام از Vue Flow/Automa)؛ هر اکشن = یک نود، لبه‌ها = ترتیب/جریان اجرا. تبدیل دوطرفه‌ی گراف ↔ `steps` JSON موجود.
- از آنجا که stack ما vanilla JS بدون build است (CSP سخت: `script-src 'self'`)، برای استپ ۱۰ یا کتابخانه‌ی گراف سبک بدون وابستگی framework (مثل Drawflow/LiteGraph) به صورت فایل استاتیک سرو‌شده استفاده می‌شود، یا یک implementation سبک SVG/canvas اختصاصی.
- فرم خطی فعلی (استپ ۸) به‌عنوان حالت ساده/fallback باقی می‌ماند؛ ادیتور نودی حالت پیشرفته می‌شود.

---

## 🔍 «همه‌چیزهای جزئی» که باید در نظر گرفته شوند (چک‌لیست مهندسی)

این موارد در استپ‌های مرتبط رعایت می‌شوند تا کیفیت production حفظ شود:

- **CORS:** UI و n8n از origin دیگر صدا می‌زنند → باید CORS کنترل‌شده اضافه شود (الان helmet هست ولی CORS صریح نیست). → استپ ۷
- **CSP و WebSocket:** برای Live View، باید `connect-src`/`ws:` در CSP باز شود و سرور WS امن راه بیفتد. → استپ ۱۲
- **Auth یکپارچه برای UI/WS/افزونه/n8n:** همان API Key؛ برای WS از query-token یا header استفاده شود. → استپ‌های ۷، ۱۲
- **Rate limit برای endpointهای جدید** (sync run, screencast). → استپ ۱۴
- **امنیت Element Picker/افزونه:** اعتبارسنجی سلکتور (همان `sanitizeSelector` موجود) قبل از اجرا. → استپ ۱۳
- **HMAC signature روی webhook خروجی** (الان امضا ندارد → برای n8n لازم). → استپ ۱۴
- **Idempotency key** روی `/run` تا n8n با retry جاب تکراری نسازد. → استپ ۱۴
- **مدیریت طول عمر مرورگر برای Live View** (مرورگر باید تا پایان session UI زنده بماند، نه فقط حین jobs). → استپ ۱۲
- **i18n (فارسی/انگلیسی) و RTL** در UI. → استپ ۷
- **مستندسازی همه‌ی اکشن‌ها و رویدادهای webhook** برای کاربر n8n. → استپ ۱۴

---

## 🔴 وضعیت فعلی پروژه (تشخیص جلسه‌ی ۱)

پروژه **روی ویندوز** توسعه داده شده و الان قرار است **Node-base / Linux** اجرا شود. به همین دلیل و به‌دلیل کارِ ناتمام، الان **کامپایل نمی‌شود** (۹ خطای TypeScript). جزئیات کامل در بخش «🐛 باگ‌های یافته‌شده».

---

## 🐛 باگ‌های یافته‌شده (آنالیز کامل جلسه‌ی ۱)

### دسته A — باگ‌های Blocker (مانع کامپایل/اجرا — اولویت بحرانی)

- **[A1] خطای حروف بزرگ/کوچک مسیر import** — `src/index.ts:35` می‌نویسد `from './routes'` اما پوشه `src/Routes/` است. روی ویندوز (case-insensitive) کار می‌کرد، روی Linux خطای `Cannot find module './routes'` می‌دهد. → استپ ۲
- **[A2] کلیدهای config گمشده** — `src/pipeline.ts` از `config.UPLOADS_DIR` و `config.DOWNLOADS_DIR` استفاده می‌کند ولی در `src/config.ts` تعریف **نشده‌اند**. خطای `Property 'UPLOADS_DIR' does not exist`. → استپ ۲
- **[A3] پراپرتی ناشناخته `redis`** — `src/index.ts:320` هنگام صدا زدن `runPipeline` فیلد `redis: connection` می‌فرستد، اما امضای تابع `runPipeline` در `pipeline.ts` چنین پارامتری ندارد. → استپ ۲
- **[A4] `WeakRef` شناخته نمی‌شود** — `src/core/ProfileManager.ts:44,102` از `WeakRef` استفاده می‌کند، ولی `tsconfig.json` با `target: ES2020` آن را نمی‌شناسد (`WeakRef` از ES2021 است). → استپ ۲
- **[A5] خطای `new Date(undefined)`** — `src/Routes/user.routes.ts:199,244` به `new Date(thisSchedule.next)` پاس می‌دهد که ممکن است `undefined` باشد (نوعش `number | undefined`). → استپ ۲
- **[A6] پارامتر `any` ضمنی** — `src/pipeline.ts:525` پارامتر `e` نوع ندارد و با `strict` خطا می‌دهد. → استپ ۲

### دسته B — باگ‌های محیط/استقرار (مانع اجرا روی Node-base/Linux)

- **[B1] مسیر Chrome ویندوزی** — `.env` مقدار `CHROME_EXE=C:\...\chrome.exe` دارد و `config.ts` پیش‌فرض ویندوزی می‌گذارد؛ روی Linux باید مسیر لینوکسی یا Playwright bundled باشد. → استپ ۳
- **[B2] باینری‌های ویندوزی Redis (~۴۸MB)** — پوشه `Redis/` پر از `*.exe` و `*.dll` ویندوزی است که روی Linux بی‌فایده و سنگین است؛ نباید در ریپو باشد. → استپ ۱ (gitignore شد) / استپ ۳ (مستندسازی نصب)
- **[B3] `postinstall` شکننده** — `package.json` دارد `"postinstall": "playwright install --with-deps chromium"` که در محیط بدون sudo/CI شکست می‌خورد. → استپ ۳
- **[B4] `node_modules` ویندوزی در zip** — باینری‌های `.node` ناسازگار با Linux بودند (حذف و دوباره نصب شد). → استپ ۱ ✅

### دسته C — باگ‌های منطقی / Race condition (نیازمند بررسی دقیق)

- **[C1] دوبار `sadd` در active jobs** — هم در `/run` (route) و هم در ابتدای worker، `job.id` به مجموعه active اضافه می‌شود؛ احتمال ناسازگاری شمارش. → استپ ۵
- **[C2] محاسبه‌ی `thisJobNumber` نادرست** — در `/run` بر اساس `scard` قبل از افزودن محاسبه می‌شود؛ با درخواست‌های همزمان درست نیست. → استپ ۵
- **[C3] خطای `unhandledRejection` بدون shutdown** — برخلاف `uncaughtException`، در `unhandledRejection` فقط log می‌شود؛ سیاست ناهماهنگ. → استپ ۵
- **[C4] فقدان Validation مرکزی با Zod** — `zod` در dependencies هست ولی validation دستی در `validation.ts` انجام شده؛ یکپارچه نیست. → استپ ۶
- **[C5] 🔴 باگ قفل توزیع‌شده‌ی ناامن (کشف‌شده در استپ ۵)** — `ProfileManager.tryLockUser` با `SET NX EX` قفل می‌گیرد (درست)، اما `unlockUser` یک `DEL` بدون‌قیدوشرط می‌زند. اگر قفل job A به‌خاطر TTL منقضی شود و job B قفل را بگیرد، پایان job A قفلِ **B** را حذف می‌کند → نقض mutual-exclusion. راه‌حل: token تصادفی هنگام قفل + آزادسازی شرطی با Lua (compare-and-del). **اولویت بالا** → استپ ۵.۵
- **[C6] استفاده از `redis.keys('lock:user:*')`** — در `getLockedUserCount` (و احتمالاً جاهای دیگر) `KEYS` blocking است و در production ضدالگوست؛ باید با شمارنده/`SCAN` جایگزین شود. → استپ ۵.۵

### دسته D — کمبودها / نبود قابلیت

- **[D1] هیچ رابط کاربری (UI) وجود ندارد** — پروژه فقط API است. کاربر صریحاً UI خواسته. باید یک داشبورد وب ساده ساخته شود (ساخت/اجرا/مانیتور جاب‌ها، Quota، زمان‌بندی‌ها). → استپ‌های ۷ و ۸
- **[D2] فقدان مستندات** — نه `README`, نه مستند API. → استپ ۳
- **[D3] فقدان تست** — هیچ تست واحد/یکپارچه‌ای نیست. → استپ ۹
- **[D4] فقدان Dockerfile / docker-compose** — برای استقرار Node-base/Linux لازم است. → استپ ۴
- **[D5] فقدان healthcheck استاندارد و آماده‌ی k8s/compose** — بررسی شود. → استپ ۴

### دسته E — شکاف‌ها نسبت به Automa (از مقایسه)

- **[E1] فقدان ادیتور Flow بصری** — Automa drag-and-drop دارد، ما فقط JSON. ساخت visual flow builder بعد از UI پایه. → استپ ۱۰
- **[E2] تعداد کم بلوک/اکشن** — Automa ~۵۰+ بلوک دارد. افزودن اکشن‌های پرکاربرد: Export داده، Cookie، Clipboard، Loop Elements/Data، Regex/Slice/Sort variable، Notification، JavaScript Code، Dialog handler. → استپ ۱۱
- **[E3] فقدان export داده به فرمت‌های جدول** — CSV/JSON/xlsx. → استپ ۱۱
- **[E4] فقدان Triggerهای متنوع** — فقط `/run` و cron. (اولویت پایین — backlog)
- **[E5] فقدان Marketplace/اشتراک workflow** — (اولویت پایین — backlog)

### دسته F — دو نکته‌ی کلیدی صاحب پروژه (جلسه‌ی ۲)

- **[F1] فقدان تعامل بصری با مرورگر** — کاربر مرورگر را نمی‌بیند و سلکتورها را دستی می‌نویسد. نیاز به Live Browser View + Element Picker. → استپ ۱۲
- **[F2] فقدان افزونه‌ی کمکی مرورگر** — برای انتخاب سلکتور/ضبط اکشن از مرورگر واقعی کاربر، مثل Automa. → استپ ۱۳
- **[F3] API ناکافی برای n8n** — نبود حالت sync، نبود OpenAPI، نبود HMAC، نبود idempotency. → استپ ۱۴
- **[F4] فقدان n8n Community Node** — برای ادغام بومی با n8n. → استپ ۱۵
- **[F5] فقدان CORS صریح** — برای صدا زدن از UI/n8n با origin متفاوت. → استپ ۷

### دسته G — معماری مرجع (جلسه‌ی ۲ — از توضیح صاحب پروژه)

- **[G1] «مسیر زنده» فقط ابتدایی است** — الان فقط poll `liveStatus` ساده. باید کانال زنده‌ی استاندارد (WebSocket/SSE) با رویدادهای `log/step.start/step.done/step.error/job.done` ساخته شود تا کاربر باگ اتوماسیون را لحظه‌به‌لحظه ببیند. → **استپ ۱۶** (پایه‌ی استپ ۱۲)
- **[G2] فقدان Workflow Storage مستقل** — فقط نتیجه‌ی job ذخیره می‌شود، نه خودِ workflowها برای ذخیره/بازاجرا/نسخه‌بندی/مدیریت از هر کلاینت. → **استپ ۱۷**
- **[G3] قرارداد client-agnostic رسمی نیست** — فرمت‌ها پراکنده؛ نیاز به اسکیمای واحد workflow + OpenAPI تا افزونه/n8n/UI/کلاینت آینده همه یکسان وصل شوند. → استپ ۱۴ (+ اسکیما در استپ ۶ Zod)

### دسته H — مدل استقرار Self-Hosted (جلسه‌ی ۲)

- **[H1] پیچیدگی غیرضروری multi-tenant در مدل self-hosted** — ~۱۲۰۰ خط VIP/Quota/Plan/Admin که در تک‌کاربره لازم نیست. باید با `DEPLOYMENT_MODE=single` خاموش‌شدنی شود (نه حذف). → استپ ۱۸
- **[H2] پیش‌فرض‌های ناامن برای نصب پابلیک** — `ADMIN_SECRET=change_me`، API Key دستی. باید توکن تصادفی خودکار + هشدارهای امنیتی نصب. → استپ ۱۸ + استپ ۳ (README امنیتی)
- **[H3] نصب پیچیده برای کاربر عادی جامعه** — باید «نصب ۵ دقیقه‌ای کنار n8n» با docker-compose واحد (app + redis) باشد. → استپ ۴ (compose) + استپ ۳ (docs)

---

## ✅ استپ‌ها

- [x] **استپ ۱ — بازیابی، پاک‌سازی و آپلود اولیه به GitHub** ✅ 2026-06-04
  1. استخراج پروژه از بکاپ و انتقال به مخزن کاری ✅
  2. حذف `node_modules` ویندوزی و نصب مجدد روی Linux ✅
  3. نوشتن `.gitignore` کامل (env، Redis، profiles، logs، dist) ✅
  4. ساخت `.env.example` امن (بدون secret) ✅
  5. ساخت `PLAN.md` با آنالیز کامل باگ‌ها ✅
  6. commit و push اولیه‌ی کل پروژه به GitHub ✅

- [x] **استپ ۲ — رفع ۹ خطای کامپایل TypeScript (دسته A)** ✅ 2026-06-04
  1. ✅ رفع [A1] حروف بزرگ مسیر import (`./routes` → `./Routes`)
  2. ✅ افزودن کلیدهای گمشده `UPLOADS_DIR`/`DOWNLOADS_DIR` به config [A2]
  3. ✅ [A3] فیلد `redis: connection` بلااستفاده بود → از فراخوانی `runPipeline` در `index.ts` حذف شد (داخل `pipeline.ts` اصلاً استفاده نمی‌شد)
  4. ✅ ارتقای `tsconfig` به `target: ES2021` + `lib: ["ES2021","DOM","DOM.Iterable"]` برای `WeakRef` [A4]
  5. ✅ رفع `new Date(undefined)` در `user.routes.ts:199,244` با گارد `?` [A5] و `any` ضمنی `(e: any)` در `pipeline.ts:525` [A6]
  6. ✅ build سبز: `npx tsc --noEmit` → 0 خطا، `npm run build` → خروجی `dist/` تولید شد
  - ⚠️ **نکته‌ی مهم کشف‌شده حین کار:** افزودن صریح `lib` در tsconfig، DOM پیش‌فرض را حذف کرد و ~۳۰ خطای `Cannot find name 'document/window/HTMLElement'` در `page.evaluate()` ایجاد شد (کد سمت مرورگر Playwright). حل: افزودن `"DOM"` و `"DOM.Iterable"` به آرایه‌ی `lib`.

- [x] **استپ ۳ — سازگارسازی با Node-base/Linux + مستندات (دسته B + D2)** ✅ 2026-06-04
  1. ✅ [B1] `CHROME_EXE` خالی‌by‌default → استفاده از Chromium بسته‌بندی‌شده‌ی Playwright (Node-base). مسیر سیستمی فقط در صورت ست‌بودن env اعمال می‌شود؛ به هر دو محل launch (`GlobalBrowser.ts`, `pipeline.ts`) به‌صورت اختیاری `executablePath` تزریق شد. (کشف: قبلاً `CHROME_EXE` تعریف ولی هیچ‌جا استفاده نمی‌شد و پیش‌فرض ویندوزی گمراه‌کننده بود.)
  2. ✅ [B3] `postinstall` امن/قابل‌skip شد: با `SKIP_BROWSER_INSTALL=1` رد می‌شود و خطای دانلود مرورگر non-fatal است؛ اسکریپت‌های صریح `install:browser` و `install:browser:deps` اضافه شد.
  3. ✅ [B2] هیچ ارجاع Windows-Redis در سورس نبود؛ `Redis/` از قبل gitignore شده و `REDIS_URL` env-driven است. راهنمای نصب Redis روی Linux (apt + Docker) به README اضافه شد.
  4. ✅ README کامل شد (نصب، Redis، مرورگر bundled، skip browser، متغیرها + ردیف `CHROME_EXE`، لینک API).
  5. ✅ `docs/API.md` نوشته شد (همه‌ی endpointهای health/user/admin + احراز هویت `x-api-key`/`x-admin-token` + کدهای وضعیت).
  - ✅ تأیید: `npx tsc --noEmit` → 0 خطا؛ گارد postinstall تست شد.

- [x] **استپ ۴ — استقرار Node-base: Docker + Compose (دسته D4/D5)** ✅ 2026-06-04
  1. ✅ `Dockerfile` چندمرحله‌ای: stage build (npm install --ignore-scripts + tsc + prune) و stage runtime روی image رسمی `mcr.microsoft.com/playwright:v1.56.1-jammy` (مرورگر + deps سیستمی bundled). `.dockerignore` هم اضافه شد.
  2. ✅ `docker-compose.yml`: سرویس `app` + `redis:7-alpine` با volume پایدار، `depends_on` با شرط `service_healthy`، و override خودکار `REDIS_URL=redis://redis:6379`. پوشه‌های logs/profiles/uploads/downloads به‌صورت bind-mount پایدار.
  3. ✅ `healthcheck` در هر دو (Dockerfile + compose) روی مسیر `/health` موجود؛ منطق one-liner تست شد (status 200 → exit 0).
  4. ⚠️ تست build واقعی container در sandbox ممکن نبود (Docker در محیط نصب نیست). به‌جای آن اعتبارسنجی استاتیک شد: compose YAML معتبر، `package-lock.json` موجود برای COPY، `npm run build` سبز، و healthcheck cmd تست شد. → **تست end-to-end container روی ماشین کاربر باید انجام شود** (در README مستند شد).
  5. ✅ بخش «اجرا با Docker» به README اضافه شد (compose up/down، docker build/run، توضیح volumeها و healthcheck).

- [x] **استپ ۵ — رفع باگ‌های منطقی/Race (دسته C)** ✅ 2026-06-04
  1. ✅ [C1] worker `sadd` به‌عنوان نقطه‌ی ثبت معتبر برای جاب‌های scheduled مستندسازی شد (idempotent؛ تنها نقطه‌ی removal در `finally{}`). [C2] `thisJobNumber` حالا از `scard` **بعد از** `sadd` گرفته می‌شود → حذف race خواندن‌قبل‌از‌نوشتن در `/run` همزمان.
  2. ✅ [C3] `unhandledRejection` با `uncaughtException` هماهنگ شد: هر دو `shutdown()` graceful را صدا می‌زنند (idempotent؛ supervisor/Docker نمونه‌ی تمیز بالا می‌آورد).
  3. ⚠️ بازبینی قفل‌گذاری → دو باگ جدی کشف شد ([C5] آزادسازی ناامن قفل، [C6] استفاده از `KEYS`). طبق قانون کاری، inline اصلاح نشد؛ در PLAN ثبت و **استپ ۵.۵ با اولویت بالا** پیش از استپ ۶ اضافه شد.
  4. ✅ تأیید: `npx tsc --noEmit` سبز. تست دستی end-to-end نیازمند Redis زنده است (در استپ ۵.۵ همراه با اصلاح قفل انجام می‌شود).

- [x] **استپ ۵.۵ — 🔴 رفع باگ قفل توزیع‌شده‌ی ناامن + حذف `KEYS` (اولویت بالا) (دسته C5/C6)** ✅ 2026-06-04
  1. ✅ [C5] `tryLockUser` حالا `randomUUID()` به‌عنوان مقدار قفل ذخیره می‌کند و token را برمی‌گرداند (یا `null`). در worker، `lockToken` نگه‌داری و به هر دو محل آزادسازی پاس داده می‌شود.
  2. ✅ [C5] `unlockUser(redis, userId, token)` آزادسازی شرطی با Lua (`compare-and-del`): فقط اگر مقدار قفل == token خودش باشد حذف می‌کند؛ بدون token هیچ DELای نمی‌زند. → نقض mutual-exclusion رفع شد.
  3. ✅ [C6] helper مشترک `scanKeys` در `utils/redis-keys.ts` اضافه شد (SCAN غیرمسدودکننده) و همه‌ی `KEYS`ها جایگزین شدند: `ProfileManager.getLockedUserCount`, `admin.routes.ts` (۴ مورد), `UserManager.ts` (۲ مورد).
  4. ✅ تست همزمانی با **Redis زنده** نوشته و اجرا شد (۷ سناریو، همه PASS) — مهم‌ترین: سناریوی ۴ اثبات کرد unlock کهنه دیگر قفل تازه‌ی جاب دیگر را نمی‌دزدد. `tsc` و `npm run build` سبز. (آرتیفکت `dump.rdb` به gitignore اضافه شد.)

- [x] **استپ ۶ — یکپارچه‌سازی Validation با Zod (دسته C4)** ✅ 2026-06-04
  1. ✅ `src/schemas.ts` ساخته شد: `runBodySchema` و `scheduleBodySchema` (envelope: userId, steps غیرخالی، headless loose، webhookUrl معتبر، cron با ۵–۶ فیلد) + helperهای `parseBody` و `formatZodError`.
  2. ✅ هر دو route `/run` و `/schedule` حالا اول با Zod (`parseBody`) اعتبارسنجی envelope را انجام می‌دهند؛ سپس درخت عمیق `steps` همچنان با `validateSteps` سخت‌شده‌ی موجود (legacy format، اندازه، nested if/while/try/switch) sanitize می‌شود. **استراتژی:** Zod برای shape و خطای یکدست، منطق recursive قدیمی برای عمق — بدون شکستن کد battle-tested.
  3. ✅ پیام‌های خطا یکدست شد: قالب واحد `{ success:false, error, details:[{path,message}] }` با کد ۴۰۰.
  4. ✅ تست ورودی‌های نامعتبر: ۱۰ سناریو (userId گمشده/عددی، steps خالی/غیرآرایه، webhookUrl بد، cron خالی/۳-فیلدی/۶-فیلدی) همه PASS. `tsc` و `npm run build` سبز.

- [x] **استپ ۷ — رابط کاربری (UI) — بخش ۱: ساختار و احراز هویت (دسته D1 + F5) — ۲۰۲۶-۰۶-۰۴**
  1. ✅ پوشه‌ی `public/` ساخته شد (`index.html`, `css/styles.css`, `js/{i18n,api,app}.js`) و با `express.static(path.resolve(process.cwd(),'public'))` در روت سرو می‌شود (سازگار با هر دو حالت dev `tsx` و prod `node dist/`). `public ./public` به runtime stage در `Dockerfile` اضافه شد تا در ایمیج هم سرو شود.
  2. ✅ صفحه‌ی ورود با API Key: کلید در `localStorage` (`ab_api_key`) ذخیره می‌شود؛ اعتبارسنجی از طریق endpoint جدید **`GET /me`** (هویت صاحب کلید، **بدون** strict-binding تا هر کلید معتبر به owner خود resolve شود). در boot کلید ذخیره‌شده یک‌بار دوباره اعتبارسنجی می‌شود (کلید باطل/منقضی → بازگشت به login). نمایش/مخفی‌کردن کلید + گزینه‌ی «مرا به خاطر بسپار».
  3. ✅ طرح‌بندی داشبورد: shell با sidebar (داشبورد/اجرا/جاب‌ها/زمان‌بندی/سهمیه) + topbar (زبان/تم/خروج)، روتر hash، تم dark/light، **i18n فارسی↔انگلیسی با سوییچ RTL/LTR کامل** (`dir`/`lang` روی `<html>`، CSS با `inset-inline-*` و logical properties)، واکنش‌گرا (sidebar موبایل).
  4. ✅ اتصال به `/health`: نشانگر سیستم زنده (poll هر ۱۰ث) + سه کارت داشبورد (وضعیت سیستم/مرورگرها/ویژگی‌ها) با badgeهای رنگی.
  5. ✅ **[F5] CORS صریح:** middleware قابل‌تنظیم با `CORS_ALLOWED_ORIGINS` (env)؛ echo امن origin، پشتیبانی `*`, مدیریت preflight (۲۰۴)، هدرهای `x-api-key`/`x-admin-token`. origin غیرمجاز هیچ هدری نمی‌گیرد.
  6. ✅ **تست e2e واقعی (Playwright):** بارگذاری صفحه بدون خطای console، ورود با کلید تست → داشبورد «سیستم آنلاین»، ۳ کارت رندر شد. CORS با curl تأیید شد (allowed→headers، evil→none). `tsc --noEmit` و `npm run build` سبز.

- [x] **استپ ۸ — رابط کاربری (UI) — بخش ۲: ساخت/اجرا/مانیتور جاب (دسته D1)** ✅ 2026-06-04
  1. ✅ فرم ساخت Flow در `public/js/views.js` (`window.Views`): کاتالوگ `ACTIONS` (goto/wait/click/fill/type/press/scroll/extract/screenshot/log) با فیلدهای params پویا، افزودن/حذف/جابجایی step، ورودی userId/webhook/headless، دکمه‌ی نمونه.
  2. ✅ ارسال به `POST /run` (با coerce کردن فیلدهای عددی) و نمایش banner با `jobId` و لینک به صفحه‌ی جاب.
  3. ✅ صفحه‌ی جاب‌ها: جدول لیست + poll هر ۸ث؛ جزئیات جاب (`GET /job/:userId/:jobId`) با poll هر ۳ث، badge وضعیت، نمایش `stepOutputs` به صورت JSON، توقف poll در پایان. دکمه‌ی cancel.
  4. ✅ صفحه‌ی Quota (plan + usage) و صفحه‌ی Schedules (جدول + حذف با تأیید).
  5. ✅ پنل ادمین: گیت توکن (`x-admin-token`) → `GET /admin/stats` → کارت‌های system/queue/raw. آیتم nav «پنل ادمین» اضافه شد.
  6. ✅ i18n (fa+en) و styles توسعه یافت (فرم/جدول/step-builder/state-badge/json-block). `app.js` روتر به `window.Views` دلگیت می‌کند و `window.AppUtil` را export می‌کند. **باگ رفع‌شده:** `views.js` قبل از `app.js` لود می‌شود، پس `AppUtil` به صورت lazy (تابع `U()`) resolve شد نه capture در لود.
  7. ✅ **تست e2e واقعی (Playwright):** login → dashboard → run → jobs → quota → schedules → admin panel، همه رندر شدند، **بدون خطای console**؛ سویچ زبان (dir) تأیید شد. `tsc --noEmit` و `npm run build` سبز؛ endpoint‌ها با curl تأیید شدند.

- [x] **استپ ۹ — تست و پایدارسازی (دسته D3)** ✅
  1. ✅ افزودن `vitest`@2.1.9 + `supertest`@7 + `@types/supertest`؛ `vitest.config.ts` (forks/singleFork، setupFiles). تست واحد: `tests/unit/helpers.test.ts` (۱۴)، `tests/unit/validation.test.ts` (۲۲ — شامل SSRF برای `validateWebhookUrl`)، `tests/unit/condition-engine.test.ts` (۱۹ — عملگرها + regex امن ضد ReDoS + `resolveVariables`)، `tests/unit/schemas.test.ts` (۱۲ — اسکیماهای Zod).
  2. ✅ تست یکپارچه: `tests/integration/api.test.ts` (۱۴) روی یک اپ Express سبک با Supertest، میدل‌ورهای واقعی `requireApiKey`/`requireAdminApiKey`/`requireAdminAuth` + روت `/health`. مسیرهای کلید-env و admin-token بدون Redis کار می‌کنند؛ `tests/integration/setup.ts` env تست را قبل از import شدن `src/config.ts` force می‌کند. عمداً `src/index.ts` import نمی‌شود (به‌خاطر side-effect سطح-ماژولِ `startServer()`).
  3. ✅ اسکریپت‌های npm: `test` (`vitest run`)، `test:watch` (`vitest`)، `check` (`tsc --noEmit`). هر دو سبز.
  4. ✅ به‌روزرسانی README با بخش «تست و پایداری» (دستورها + ساختار تست‌ها).
  5. ✅ **نتیجه:** `npm test` → **۵ فایل، ۸۱ تست سبز** (۶۷ unit + ۱۴ integration)؛ `npm run check` (tsc --noEmit) سبز.

- [x] **استپ ۱۰ — ادیتور Flow بصری node-based (پر کردن شکاف اصلی با Automa) (دسته E1)** ✅ — 🔴 تأکید صاحب پروژه (نکته ۳): مثل Automa گراف نودها شد
  1. ✅ `public/js/flow-editor.js` — ادیتور گراف node-based **vanilla و CSP-safe** (بدون framework/CDN؛ بوم SVG + کارت‌های HTML با position مطلق). drag-and-drop نودها، اتصال بصری لبه‌ها (پورت out → پورت in)، pan با کشیدن پس‌زمینه، zoom با چرخ ماوس، حذف نود/لبه. `window.FlowEditor = { mount, unmount, toSteps, loadSteps, saveLocal, loadLocal, reset }`. هر اکشن = یک نود (همان کاتالوگ `ACTIONS` فرم خطی).
  2. ✅ تبدیل دوطرفه گراف ↔ `steps[]`: `toSteps()` از نود «شروع» زنجیره را دنبال می‌کند و دقیقاً همان `[{action,params}]` بک‌اند را می‌سازد؛ `loadSteps()` از یک آرایه‌ی steps گرافِ زنجیره‌ای می‌سازد. دکمه‌ی «دریافت از فرم اجرا» steps فرم خطی استپ ۸ را وارد می‌کند.
  3. ✅ پنل تنظیمات هر نود (inspector): انتخاب نود → فرم params آن اکشن (text/number/select) با به‌روزرسانی زنده‌ی خلاصه‌ی نود.
  4. ✅ ذخیره/بارگذاری/پاک‌سازی workflow در `localStorage` (کلید `ab_flow_graph`).
  5. ✅ اجرای مستقیم از ادیتور (`POST /run` با خروجی `toSteps()`) + نمایش Job ID و دکمه‌ی پرش به جزئیات جاب؛ دکمه‌ی «نمایش JSON».
  6. ✅ ادغام UI: مسیر/nav جدید `editor` (آیکن 🧩)، اسکریپت در `index.html` (ترتیب: i18n → api → **flow-editor** → views → app)، کلیدهای i18n `fe.*`/`nav.editor` (fa+en)، CSS کامل ادیتور در `styles.css`. `stopAll()` هنگام خروج از view، `FlowEditor.unmount()` را صدا می‌زند (پاک‌سازی listenerهای window).
  7. ✅ **تست e2e (Playwright):** login → editor → افزودن نود (goto+click، بدون overlap) → ویرایش param در inspector → اتصال start→goto→click (۲ لبه) → «نمایش JSON» = ۲ step `goto,click` → save/clear/load roundtrip (۳ نود) → **اجرا → جاب در صف (Job ID: 1)** → سویچ زبان/RTL. **بدون خطای console.** `tsc`/`npm run build`/`npm test` (۸۱) سبز.
  - فرم خطی استپ ۸ به‌عنوان حالت ساده/fallback باقی ماند؛ ادیتور نودی حالت پیشرفته است.

- [x] **استپ ۱۱ — افزایش بلوک‌ها/اکشن‌ها به‌سبک Automa (دسته E2/E3)** ✅ — 2026-06-04
  1. ✅ افزودن اکشن `export-data` (CSV/JSON) [E3] — ذخیره در `downloads/<userId>/`؛ سریالایزر `toCsv`/`csvEscape` (union-header برای آرایه‌ی اشیاء، key/value برای شیء، تک‌ستونه برای آرایه‌ی اسکالر).
  2. ✅ افزودن `cookie` (getAll/get/set/clear). `clipboard` از قبل در بک‌اند بود و حالا در UI هم نمایش داده می‌شود.
  3. ⏭️ حلقه‌ها (`loop`/`foreach`/`while`) از قبل در Flow Engine بک‌اند بودند؛ نودهای کنترل‌جریان چندپورتی به استپ بعدی ادیتور موکول شد (نیاز به چند پورت خروجی — `toSteps()` فعلاً خطی است). breakpoint نیاز به live-channel دارد → استپ ۱۶.
  4. ✅ افزودن `variable` (الیاس `set-variable`/`transform`) با `op`: `set`/`regex`/`replace`/`slice`/`split`/`join`/`sort` — regex امن (cap طول pattern=۱۰۰۰ و ورودی=۱۰۰k، فقط فلگ‌های `gimsu`؛ ضد ReDoS).
  5. ✅ افزودن `notification` (title/message/level → لاگ + خروجی مرحله). `handle-dialog` از قبل در بک‌اند بود.
  6. ✅ مستندسازی کامل همه‌ی اکشن‌ها (موجود+جدید) در `docs/API.md` (بخش «کاتالوگ اکشن‌ها»).
  - ✅ **بازآرایی کلیدی:** کاتالوگ `ACTIONS` که قبلاً در `views.js` و `flow-editor.js` دو کپی بود، به یک ماژول مشترک `public/js/actions.js` (`window.ACTION_CATALOG`) منتقل شد. هر دو فایل حالا از همان منبع می‌خوانند (۱۸ اکشن). ترتیب لود: **actions** → i18n → api → flow-editor → views → app.
  - ✅ **تست:** `npx tsc`/`npm run build` سبز؛ `npm test` = **۹۱ تست** (۸۱ قبلی + ۱۰ تست جدید `export-csv.test.ts` برای `toCsv`/`csvEscape`). e2e Playwright: لاگین → کاتالوگ مشترک با ۸ اکشن جدید → اشتراک FlowEditor↔فرم خطی → `POST /run` با اکشن‌های جدید (status 200، Job ID:1) → **بدون خطای console**. (اجرای واقعی pipeline در sandbox به‌دلیل نبود deps کامل مرورگر سروری ممکن نیست — تست end-to-end مرورگر روی ماشین کاربر/Docker.)

- [x] **استپ ۱۲ — Live Browser View + Element Picker (نکته ۱ صاحب پروژه — راهکار A) (دسته F1)** _(۲۰۲۶-۰۶-۰۴)_
  1. ✅ WebSocket server امن `/browser/ws` (`src/core/BrowserStreamServer.ts`) با auth از طریق `authorizeLive` (همان قوانین استپ ۱۶: env/admin=full؛ کلید کاربر=owner-match). یک listenerِ `upgrade` مستقل که فقط مسیر `/browser/ws` را می‌گیرد و بقیه را رها می‌کند تا با `/live/ws` همزیست شود.
  2. ✅ استریم زنده با CDP Screencast (`src/core/LiveBrowser.ts`): `Page.startScreencast` (jpeg، q=60) → فریم base64 روی WS → رندر روی `<canvas>` در UI. ack هر فریم با `Page.screencastFrameAck`.
  3. ✅ تعامل دوطرفه: کلیک/اسکرول از canvas با مپ مختصات به px دستگاه → `Input.dispatchMouseEvent`؛ تایپ → `Input.insertText`؛ کلیدهای ویژه → `page.keyboard.press`.
  4. ✅ Element Picker: اسکریپت تزریقی (overlay + هایلایت hover) که روی کلیک، سلکتور CSS (با `:nth-of-type` و `CSS.escape`) + XPath را می‌سازد و از طریق binding `__abReportPick` (با `exposeBinding`) به سرور و سپس UI گزارش می‌دهد. تزریق مجدد بعد از ناوبری.
  5. ✅ درج خودکار سلکتور: کارت «عنصر انتخاب‌شده» با کپی CSS/XPath + دکمه‌های «افزودن گام click/extract» که از طریق `window.Views.addStep()` گام را مستقیماً به فرم «اجرای Flow» اضافه می‌کند.
  6. ✅ CSP از قبل (استپ ۱۶) `connect-src: 'self' ws: wss:` و `imgSrc: 'self' data:` را اجازه می‌داد (نیازی به تغییر نبود). مدیریت طول عمر: هر سوکت یک `LiveBrowserSession` ایزوله (context+page اختصاصی)، idle-TTL ۵ دقیقه با auto-close، `LiveBrowserManager` با cap (=min(MAX_CONCURRENT,8))، و بستن در graceful shutdown.
  - ✅ **UI:** `public/js/browser-view.js` (`window.BrowserView`)، آیتم nav + route `browser` در `app.js`/`views.js` + هوک `stopAll`، کلیدهای i18n `bv.*`+`nav.browser` (fa+en)، اسکریپت در index.html (live → **browser-view** → views).
  - ✅ **تست:** `tsc`/`build` سبز؛ `npm test` = **۱۰۳** (+۵ تست `live-browser.test.ts`: یکتایی id، cap، destroy، shutdown، و match مسیر `/browser/ws`). e2e واقعی (Redis نصب شد، deps مرورگر نصب شد): WS auth → no_key=403، bad_key=403، no_userId=400، valid_key=**OPEN**؛ روی سوکت معتبر پیام `error: browser_unavailable` درست emit شد (مرورگر سروری در sandbox به‌دلیل نبود کامل deps بالا نیامد — محدودیت محیطی، نه باگ)؛ رگرسیون `/live/ws` سالم (403/OPEN)؛ UI بدون خطای console/CSP (Playwright). تستِ استریم واقعیِ فریم باید روی Docker/ماشین کاربر انجام شود.

- [x] **استپ ۱۳ — افزونه‌ی کمکی Chrome (نکته ۱ صاحب پروژه — راهکار B) (دسته F2)** _(۲۰۲۶-۰۶-۰۴)_
  1. ✅ اسکلت افزونه (Manifest V3) در `extension/`: `manifest.json` (permissions: storage/activeTab/scripting/tabs، host_permissions http+https، action popup، background service_worker، content_scripts، آیکون‌های 16/48/128). آیکون‌ها با PIL ساخته شدند.
  2. ✅ Element Picker روی مرورگر واقعی (`content/recorder.js` + `content/selector.js`): overlay هایلایت hover، روی کلیک سلکتور CSS+XPath می‌سازد و بدون فعال‌شدن هندلر صفحه به popup گزارش می‌دهد. منطق `window.ABSelector.cssPath/xPath` همان منطق PICKER_SCRIPT بک‌اند است (تأییدشده با تست).
  3. ✅ ضبط اکشن‌ها → steps (`recorder.js`): click→`click`، input/change→`fill`، Enter→`press`، ناوبری→`goto`. وضعیت در `chrome.storage.local` (`ab_picker/ab_recording/ab_steps/ab_last_url`). فرمت گام `{action, params}` مطابق `ACTION_CATALOG` بک‌اند.
  4. ✅ ارسال امن به backend با API Key (`background.js`): `sendFlow` → `POST /run` با هدر `x-api-key` و بدنه `{userId, steps, headless:true, webhookUrl?}`؛ `checkConnection` → `GET /me`. fetch از داخل service worker (با host_permissions) تا محدودیت CORS صفحه دور زده شود. کلید هرگز لاگ نمی‌شود. تأییدشده: `/me`=`{success:true,...}`، `/run` با payload افزونه → `{success:true, jobId:"1"}`، بدون کلید → 401.
  5. ✅ مستند نصب و استفاده: `extension/README.md` (load unpacked در `chrome://extensions`، تنظیم Base URL/API Key/User ID، pick/record/send، جدول مجوزها، و **نکته‌ی CORS**: مسیر background-fetch مستقل از `CORS_ALLOWED_ORIGINS` کار می‌کند؛ توصیه `CORS_ALLOWED_ORIGINS=*` یا origin مشخص افزونه در صورت نیاز).
  - ✅ **UI افزونه:** `popup/popup.html`+`popup.css`+`popup.js` (CSP-safe، بدون inline JS): بخش Backend (Base/Key/User + Save/Test)، Capture (Pick/Record + کارت عنصر انتخاب‌شده با add click/extract/copy)، Steps (شمارش/Clear/Send)، نوار وضعیت.
  - ✅ **تست:** `tsc`/`build` سبز؛ `npm test` = **۱۰۸** (+۵ تست `extension-selector.test.ts`: shortcut `#id`، مسیر class+`:nth-of-type`، خالی برای غیرعنصر، XPath `//*[@id=]`، مسیر مطلق ایندکس‌دار — با fake-DOM در sandbox `vm`، بدون افزودن jsdom). قراردادِ افزونه↔بک‌اند روی سرور در حال اجرا تأیید شد. تست واقعی pick/record در Chrome باید روی ماشین کاربر انجام شود (sandbox مرورگر گرافیکی ندارد).

- [x] **استپ ۱۴ — بهبود API برای ادغام n8n (نکته ۲ صاحب پروژه) (دسته F3/F5)** ✅
  1. ✅ حالت sync: `POST /run?wait=true` — تا پایان جاب صبر می‌کند (سقف `RUN_WAIT_MAX_MS`، پیش‌فرض ۶۰s، با poll هر `RUN_WAIT_POLL_MS`) و نتیجهٔ کامل را inline برمی‌گرداند؛ در صورت timeout پاسخ `202` با `pollUrl` می‌دهد. helper جدید `waitForJobResult` در `user.routes.ts`.
  2. ✅ امضای HMAC-SHA256 روی webhook خروجی: util جدید `src/utils/signature.ts` (`signWebhookBody`/`verifyWebhookSignature`، constant-time)؛ وقتی `WEBHOOK_SECRET` ست باشد هدرهای `X-Signature: sha256=<hex>` و `X-Webhook-Timestamp` به `sendWebhook` اضافه می‌شوند (امضا روی body دقیقِ روی‌سیم).
  3. ✅ Idempotency-Key روی `/run`: هدر `Idempotency-Key` (الگوی `^[A-Za-z0-9_.:-]{1,200}$`)، نگاشت per-user در Redis (`idem:run:<user>:<key>`) با TTL=`IDEMPOTENCY_TTL_SECONDS` (پیش‌فرض ۲۴h)؛ درخواست تکراری همان jobId اصلی را با `idempotent:true` برمی‌گرداند بدون enqueue دوباره. اعتبارسنجی مشترک `isValidIdempotencyKey`.
  4. ✅ `docs/openapi.yaml` (OpenAPI 3.0.3): ۱۰ مسیر + ۹ schema؛ مستندسازی `wait`، `Idempotency-Key`، امنیت `x-api-key`/`x-admin-token` و قرارداد webhook امضاشده.
  5. ✅ CORS [F5] از قبل پیاده بود؛ هدر `Idempotency-Key` به `Access-Control-Allow-Headers` افزوده شد. `smartLimiter` همچنان روی `/run` فعال است (rate limit مشترک). کلیدهای جدید در `.env.example` مستند شدند.
  - ✅ **تست:** `tsc`/`build` سبز؛ `npm test` = **۱۲۷** (+۱۹: ۱۰ `webhook-signature.test.ts`، ۴ `redis-keys.test.ts`، ۵ `run-n8n.test.ts` با mock connection/queue که dedup، sync-result و timeout→202 را روی هندلر واقعی `/run` تأیید می‌کند). بدون نیاز به Redis/مرورگر در sandbox.

- [x] **استپ ۱۵ — n8n Community Node (نکته ۲ صاحب پروژه) (دسته F4)** ✅
  1. ✅ پکیج مستقل `n8n-node/` با نام `n8n-nodes-automationbackend` (ساختار استاندارد n8n: `package.json` با فیلد `n8n.{credentials,nodes}`، `tsconfig.json`، خروجی `dist/`). به‌جای `gulp` (که در sandbox به‌خاطر build نیتیو فریز می‌کرد) از اسکریپت بدون‌وابستگی `copy-icons.js` برای کپی آیکون‌ها استفاده شد.
  2. ✅ **Action node** (`AutomationBackend.node.ts`) با ۴ عملیات: **Run Workflow** (`POST /run` + سوییچ Wait→`?wait=true` + فیلد `Idempotency-Key`)، **Get Job Result** (`GET /job/:userId/:jobId`)، **Create Schedule** (`POST /schedule` + cron + name)، **Cancel Job** (`DELETE /cancel/:userId/:jobId` + `closeBrowser`/`closeTab`). از `httpRequestWithAuthentication` + `continueOnFail` استفاده می‌کند.
  3. ✅ **Trigger node** (`AutomationBackendTrigger.node.ts`): webhook با `httpMethod:POST`؛ تأیید **HMAC** هدر `X-Signature` با همان منطق `src/utils/signature.ts` (constant-time، با/بدون پیشوند `sha256=`)؛ رد امضای نامعتبر با ۴۰۱؛ فیلتر رویداد (`job.completed`/`failed`/`cancelled`/`blocked`/`quota_exhausted`). سازگاری متقابل امضا با بک‌اند با اسکریپت node تأیید شد.
  4. ✅ **Credentials** `AutomationBackendApi`: `baseUrl` + `apiKey` (هدر `x-api-key`) + `webhookSecret` اختیاری (برای تأیید HMAC در Trigger)؛ دکمه‌ی Test → `GET /me`.
  5. ✅ `n8n-node/README.md` (نصب از GUI/npm/سورس، جدول عملیات‌ها/مجوزها، نکته‌ی CORS سمت‌سرور) + `examples/example-workflow.json` (Manual→Run(wait) و Trigger با تأیید امضا) — JSON معتبر.
  - ✅ **تست:** `n8n-workflow` به‌صورت **peerDependency** (نه نصب در sandbox؛ نیازمند build نیتیو `isolated-vm`)؛ یک type-shim محلی `types/n8n-workflow.d.ts` افزوده شد تا پکیج standalone با `tsc` کامپایل شود (نصب با `--legacy-peer-deps` برای رد peer). `npm run build` پکیج **سبز** (dist با فیلد `n8n` در package.json منطبق). tsconfig بک‌اند فقط `src/**` را می‌گیرد پس ایزوله است؛ سوییت بک‌اند بدون رگرسیون **۱۲۷** سبز ماند.

- [x] **استپ ۱۶ — کانال زنده‌ی استاندارد (Live Channel) — قلب «مسیر زنده» (دسته G1)** _(۲۰۲۶-۰۶-۰۴)_
  1. تعریف رویدادهای استاندارد: `job.start`, `log`, `step.start`, `step.done`, `step.error`, `job.done`, `job.error` (در `src/core/LiveBus.ts`)
  2. انتشار رویدادها از داخل pipeline حین اجرای هر step (`onEvent` در `AutomationContext` → emit در `executeStepGroup`؛ worker رویدادهای job-level و log را emit می‌کند)
  3. کانال تحویل: WebSocket (`/live/ws` در `src/core/LiveServer.ts`) + fallback به SSE (`GET /live/sse/:userId/:jobId`)
  4. احراز هویت کانال با API Key (query یا header) + محدودسازی به owner همان job (`authorizeLive`)
  5. بافر کوتاه رویدادها در Redis (capped list ۲۰۰ تایی، TTL ۳۰ دقیقه) + Pub/Sub برای fan-out سازگار با PM2 cluster
  6. تست: ۷ تست جدید (LiveBus integration + authorizeLive) + e2e واقعی (WS replay buffer + live stream + رد کلید نامعتبر) — همه سبز
  7. UI: ویوی «نمایش زنده» (`public/js/live.js`، `window.LiveClient`+`LiveView`) + کلیدهای i18n `live.*` + آیتم nav

- [x] **استپ ۱۷ — Workflow Storage (ذخیره/بازاجرا/مدیریت workflow) (دسته G2)** ✅ 2026-06-04
  1. ✅ مدل ذخیره‌سازی workflow در Redis (`WorkflowService`): کلیدهای per-user `wf:meta`, `wf:index`, `wf:ver`, `wf:verindex`؛ رکورد شامل id (تولید سرور `wf_<hex>`), userId, name, description, steps, headless, webhookUrl, version, createdAt, updatedAt
  2. ✅ CRUD endpoint کامل: `POST /workflows/:userId` (ساخت)، `GET /workflows/:userId` (لیست)، `GET /workflows/:userId/:workflowId` (یکی)، `PUT` (ویرایش + بامپ نسخه)، `DELETE` (حذف + پاک‌سازی history)
  3. ✅ بازاجرا با `POST /workflows/:userId/:workflowId/run` — همان قرارداد `?wait=true` (sync) و `Idempotency-Key` مثل `/run`؛ job با `__workflowId`/`__workflowVersion` تگ می‌شود؛ امکان override کردن headless/webhookUrl در همان run
  4. ✅ نسخه‌بندی ساده: هر update یک snapshot در history ذخیره می‌کند؛ `GET /workflows/:userId/:workflowId/versions` (جدیدترین اول)؛ هرس خودکار به `WORKFLOW_MAX_VERSIONS` (پیش‌فرض ۲۰). تعلق به کاربر با strict API-key binding از طریق `:userId` در مسیر (auth + blockCheck در index.ts)
  5. ✅ مستندسازی: `docs/openapi.yaml` (۵ مسیر `/workflows` + اسکیماهای `WorkflowBody`/`Workflow`/`WorkflowVersion`)، بخش «Saved Workflows» در `n8n-node/README.md`، و README اصلی. اسکیمای واحد steps با `/run` مشترک است (هم‌راستا با افزونه/n8n/UI)
  - ✅ تست: ۹ تست `workflow-service` + ۱۰ تست route + ۴ تست redis-keys (مجموع جدید ۲۳)؛ **۱۵۰ تست سبز**؛ tsc/build سبز
  - **زبان/قرارداد:** `src/**` همه CRLF (ویرایش با Python)، `tests/**`+`docs/**` همه LF

- [x] **استپ ۱۸ — حالت Self-Hosted تک‌کاربره (`DEPLOYMENT_MODE`) (دسته H) — اولویت بالا** ✅ 2026-06-04
  1. ✅ افزودن `DEPLOYMENT_MODE` (`single`/`multi`) به config با پیش‌فرض `single` (+ `IS_SINGLE_USER`، `FULL_ACCESS_PLAN`)
  2. ✅ در حالت `single`: خاموش‌کردن Quota/VIP/Plan/Level — `UserManager.getEffectivePlan` کوتاه‌مدار به `FULL_ACCESS_PLAN` (baseLevel=`single`)؛ `UserManager.isUserBlocked` همیشه `false` (بدون lookup در Redis)
  3. ✅ در حالت `single`: یک `API_TOKEN` ساده مشترک (تولید تصادفی خودکار `tok_<48hex>` اگر تنظیم نشده، یک‌بار در boot چاپ می‌شود) با هویت ثابت `SINGLE_USER_ID='local'`؛ بدون strict binding چندکاربره
  4. ✅ مخفی/غیرفعال‌کردن endpointهای admin مدیریت کاربر در حالت `single` — گارد ۴۰۴ روی پیشوندهای `/set-user-level`, `/user/`, `/users/`, `/api-keys` در `admin.routes.ts`؛ endpointهای عملیاتی (stats/cleanup/reload-lua/restart/reset-quota) باز می‌مانند
  5. ✅ rate-limit سبک پیش‌فرض (`RATE_LIMIT_PER_MINUTE=120` فعال در هر دو حالت) + هشدارهای امنیتی نصب (boot mode-aware: در `single` چاپ توکن تصادفی، در `multi` هشدار `ADMIN_SECRET` پیش‌فرض)؛ `GET /me` اکنون `mode`/`isSingleUser` را برمی‌گرداند؛ مستندسازی کلیدهای `DEPLOYMENT_MODE`/`API_TOKEN` در `.env.example`
  6. ✅ تست هر دو حالت: ۷ تست `single-user-mode` (UserManager + auth + مسیر multi)، تثبیت `DEPLOYMENT_MODE=multi` در `tests/integration/setup.ts`؛ مستندسازی در README
  - ✅ تست: ۷ تست جدید؛ **۱۵۷ تست سبز** (از ۱۵۰)؛ tsc/build سبز
  - **زبان/قرارداد:** `src/**`+`.env.example` همه CRLF (ویرایش با اسکریپت پایتونِ binary-mode)، `tests/**` همه LF

- [x] **استپ ۱۹ — اسکریپت نصب تعاملی `install.sh` + استقرار one-liner/Caddy/Coolify (دسته H3 — نصب آسان)** ✅ 2026-06-04
  - ✅ **نصب تک‌خطی** `curl -fsSL .../install.sh | bash`: بلوک bootstrap در ابتدای اسکریپت تشخیص می‌دهد که از طریق pipe اجرا شده، ریپو را با `git clone --depth 1` در `mktemp -d` می‌گیرد و خودش را با `exec bash ... </dev/tty` دوباره اجرا می‌کند تا پرامپت‌های تعاملی با کیبورد کار کنند (الگوی Docker/nvm/rustup).
  - ✅ اسکریپت `install.sh` تعاملی و **تأییدمحور** با **پیش‌فرض «بله»** (Enter = ادامه). ساختار `set -euo pipefail`، خروجی رنگی TTY-aware، توابع `confirm`/`ask`، تشخیص خودکار پکیج‌منیجر (apt/dnf/yum/pacman/brew)، و نصب خودکار **Node 20** (NodeSource/brew/pacman) در صورت نبود.
  - ✅ پنج هدف در منو: (۱) **Server (Node)** ویزارد ۶ مرحله‌ای `[1/6..6/6]` = وابستگی‌ها → Playwright → `.env`+توکن → build → دامنه/HTTPS → PM2؛ (۲) **Server (Docker)** = `docker compose up -d --build`؛ (۳) **Server (Coolify)** = راهنما + فایل `docker-compose.coolify.yml`؛ (۴) **Client (Chrome)** = راهنمای Load-unpacked؛ (۵) **Client (n8n)** = build و نصب در `~/.n8n/custom`.
  - ✅ **دامنه + HTTPS خودکار با Caddy**: اگر در مسیر Server (Node) دامنه بدهید، Caddy نصب و `/etc/caddy/Caddyfile` از روی `Caddyfile.example` ساخته می‌شود → پنل با Let's Encrypt روی `https://<domain>` بالا می‌آید. راهنمای Cloudflare (ساخت رکورد A + خاموش‌کردن پروکسی نارنجی/DNS only) چاپ می‌شود.
  - ✅ **Coolify (استقرار ایزوله)**: فایل `docker-compose.coolify.yml` (بدون انتشار پورت به host و بدون Caddy، چون Traefik خود Coolify دامنه/TLS را هندل می‌کند؛ named volumes برای persistence) + راهنمای گام‌به‌گام در منو و README.
  - ✅ ساخت `.env` از `.env.example` + تولید `API_TOKEN` تصادفی (`tok_<48hex>`) و نوشتن با sed سازگار GNU/BSD؛ تنظیم `PORT` دلخواه؛ و **چاپ خلاصهٔ نهایی** (آدرس پنل + توکن) در پایان نصب سرور.
  - ✅ پرچم‌های غیرتعاملی: `--server-node`/`--server-docker`/`--coolify`/`--client`/`--client-n8n`/`--domain <host>`/`--port <n>`/`-y|--yes`/`-h|--help`. اعتبارسنجی: `bash -n` سبز، **shellcheck (warning) تمیز**. مستندسازی کامل در README.
  - **زبان/قرارداد:** `install.sh`, `docker-compose.coolify.yml`, `Caddyfile.example` همه با **LF**.

- [x] **استپ ۲۰ — انتشار خودکار Docker image روی ghcr.io + راهنمای Coolify (Docker Image) (دسته H3)** ✅ 2026-06-04
  - ✅ **GitHub Actions** `.github/workflows/docker-publish.yml`: با هر push روی `main` (و tagهای `v*` و `workflow_dispatch`)، image را از روی `Dockerfile` با buildx می‌سازد و روی **`ghcr.io/<owner>/<repo>`** منتشر می‌کند. تگ‌ها: `latest` (روی main)، `sha-<short>`، و `vX.Y.Z` (روی git tag). از `GITHUB_TOKEN` خودکار استفاده می‌کند (بدون secret دستی)؛ نام image با `tr` به lowercase تبدیل می‌شود (الزام ghcr)؛ cache با `type=gha`. خلاصهٔ image در `$GITHUB_STEP_SUMMARY`.
  - ✅ **راهنمای کامل `docs/COOLIFY.md`** برای استقرار با نوع منبع **Docker Image**: چرا اول باید image ساخته شود، عمومی‌کردن package، حذف منبع اشتباه قبلی، ساخت **Redis جدا** (چون Docker Image تنها Redis ندارد)، تنظیم **Ports Exposes=3000** (نه 80)، متغیرهای محیطی (`DEPLOYMENT_MODE`/`NODE_ENV`/`PORT`/`REDIS_URL`/`API_TOKEN`)، دامنه + Cloudflare (A record + DNS only)، Deploy، و جدول مقایسهٔ سه روش (Docker Image / Compose / Dockerfile).
  - ✅ README بخش Coolify گسترش یافت: دو راه (Docker Compose آسان، و Docker Image با ghcr.io) + لینک به `docs/COOLIFY.md`.
  - **زبان/قرارداد:** `.github/workflows/*.yml` و `docs/COOLIFY.md` با **LF**.
  - **علت:** کاربر با نوع منبع **Docker Image** در Coolify راحت بود؛ این استپ زیرساخت لازمِ آن (image منتشرشده + راهنما) را فراهم می‌کند.
  - ⚠️ **نکتهٔ push:** توکن این محیط scope `workflow` ندارد و GitHub اجازهٔ push فایل `.github/workflows/*.yml` را نمی‌دهد؛ فایل workflow روی دیسک ساخته شده ولی باید **دستی توسط صاحب ریپو** اضافه شود (Actions → New workflow → کپی محتوا → Commit). بقیهٔ فایل‌ها (`docs/COOLIFY.md`/README/PLAN/SESSION) push شده‌اند. روش `docs/COOLIFY.md` این مورد را توضیح می‌دهد.

---

## 📝 یادداشت‌ها

- محیط فعلی sandbox **Redis ندارد**؛ تست‌های نیازمند Redis ممکن است نیاز به نصب محلی Redis (لینوکسی) داشته باشند — در استپ مربوطه نصب می‌شود.
- secret واقعی در `.env` نسخه‌ی بکاپ یافت نشد (مقادیر placeholder بودند)، اما `.env` همچنان gitignore شد تا اشتباهی push نشود.
- **ترتیب اجرای پیشنهادی (به‌روز با تصمیم self-hosted):**
  1. پایه‌ای: **کامپایل سبز** (۲) → **حالت Self-Hosted (۱۸)** → **Node-base/Linux** (۳) → **Docker تک‌فرمانه (۴)**
  2. زیرساخت معماری مرجع: **کانال زنده (۱۶)** → **Workflow Storage (۱۷)**
  3. دو نکته‌ی صاحب پروژه:
     - **n8n:** بهبود API + قرارداد client-agnostic (۱۴) → n8n Node (۱۵)
     - **تعامل با مرورگر:** UI پایه (۷-۸) → Live View + Picker (۱۲، روی ۱۶) → افزونه (۱۳)
  4. تکمیلی: باگ‌های منطقی (۵) → Zod (۶) → ادیتور بصری (۱۰) → بلوک‌های بیشتر (۱۱) → تست (۹)
- **چرا استپ ۱۸ زود؟** چون مدل تک‌کاربره/چندکاربره روی auth، quota، routes و UI تأثیر می‌گذارد؛ بهتر است قبل از ساخت UI و n8n تثبیت شود تا دوباره‌کاری نشود.
- **استراتژی نسبت به Automa:** کلون نمی‌کنیم؛ مزیت ما سروری/چندکاربره/SaaS است. شکاف‌های کلیدی (UI بصری، تعامل مرورگر مثل افزونه، تعداد بلوک) را پر می‌کنیم — جزئیات در بخش «⚔️ مقایسه با Automa» و «🎯 دو نکته‌ی کلیدی».
- **نکته‌ی فنی n8n:** بهترین تجربه‌ی کاربری با ترکیب «sync run + Trigger node» حاصل می‌شود؛ webhook بدون HMAC امن نیست.
- **نکته‌ی فنی Live View:** از `ws` موجود + CDP Screencast استفاده می‌کنیم؛ نیازی به وابستگی سنگین جدید نیست.

---

# 🚀 فاز بزرگ بعدی (نسخهٔ نهایی ۱۰۰/۱۰۰) — پلتفرم اتوماسیون وب نودبیس در شأن n8n

> این بخش پس از مطالعهٔ مستندات رسمی n8n (Node types، Data structure، Data mapping/Expressions،
> NDV/UI elements، Error handling، Triggers، Data pinning) بازنویسی شد تا نقشه واقعاً **هم‌تراز با تجربهٔ n8n**
> باشد و کاربرِ آشنا با n8n در محیط ما گم نشود.

## 🎯 مسئلهٔ واقعی که حل می‌کنیم (Positioning)

n8n در «اتصال APIها و سرویس‌ها» عالی است، اما **اتوماسیون مرورگرِ واقعی (کلیک/فرم/اسکرپ روی سایت‌هایی که API ندارند،
سایت‌های پشت لاگین، محتوای رندرشده با JS، کپچا/ضدبات)** را به‌خوبی پوشش نمی‌دهد و کاربر مجبور است به سرویس‌های گران
شخص‌ثالث وصل شود. **ارزش پیشنهادی ما:** یک «موتور اتوماسیون مرورگر» نودبیس و سلف‌هاست که **مثل n8n حس می‌شود** و
به‌عنوان بازوی مرورگرِ n8n عمل می‌کند — n8n ورکفلوی مرورگری ما را با Trigger صدا می‌زند، دیتا تزریق می‌کند، و
نتیجهٔ نودبه‌نود را **لحظه‌ای** هم با Webhook و هم با لینک مشاهدهٔ زنده پس می‌گیرد. افزونهٔ کروم همان پنل است
(لاگین = ورود به سرور) با مزیت **انتخاب مستقیم المان** روی مرورگر کاربر.

## 🧠 درس‌های کلیدی از n8n که در طراحی رعایت می‌شوند

1. **مدل دادهٔ یکنواخت:** بین نودها همیشه «آرایه‌ای از آیتم‌ها» با کلید `json` (و در صورت لزوم `binary`) جریان دارد:
   `[{ json: {...}, binary?: {...} }]`. هر نود روی **هر آیتم** جداگانه اجرا می‌شود (n+1 → چند خروجی).
   → موتور ما هم باید یک «جریان آیتم» استاندارد بین استپ‌ها داشته باشد، نه فقط متغیرهای سراسری.
2. **NDV (Node Detail View) = قلب UX:** با باز کردن نود سه‌ستونه می‌شود: **INPUT** (دادهٔ ورودی از نود قبلی) |
   **Parameters** (فیلدها) | **OUTPUT** (نتیجهٔ اجرای همان نود). کاربر از INPUT فیلد می‌کِشد و رها می‌کند → اکسپرشن
   `{{ $json.field }}` ساخته می‌شود. نمایش داده به‌صورت **Table / JSON / Schema**.
3. **Expressionها:** سینتکس `{{ ... }}` با دسترسی به `$json`, `$node["x"].json`, `$items`, `$now` و … . هر فیلد
   دو حالت دارد: **Fixed** (مقدار ثابت) یا **Expression** (پویا). drag&drop خودکار حالت Expression می‌سازد.
4. **حالت‌های اجرای نود (بصری):** «در حال اجرا» (انیمیشن دور نود/خط چرخان) → «موفق» (هالهٔ سبز + تعداد آیتم‌ها +
   زمان) → «خطا» (هالهٔ قرمز + علامت + پیام). همان جریان `step.start/step.done/step.error` بک‌اند ما این را تغذیه می‌کند.
5. **Triggerها متنوع‌اند:** Manual (تست)، Schedule/Cron، Webhook، Form، Chat، Polling، App-event، Error Trigger.
   آیکون صاعقه ⚡ مخصوص triggerهاست؛ هر ورکفلو با یک trigger شروع می‌شود.
6. **Pinning دادهٔ تست:** خروجی یک نود را می‌توان pin کرد تا بدون اجرای دوبارهٔ مرورگر، توسعهٔ نودهای بعدی سریع شود.
7. **Error handling حرفه‌ای:** هر نود گزینهٔ **Continue On Fail / Retry On Fail (دفعات+فاصله)** دارد؛ و یک
   **Error Workflow** سراسری که هنگام شکست با دادهٔ خطای استاندارد (`execution.error.message/stack`, `lastNodeExecuted`) اجرا می‌شود.
8. **انواع فیلد غنی:** string (+password/+multiline rows)، number (min/max/precision)، boolean (toggle)، options،
   multiOptions، collection (فیلدهای اختیاری)، fixedCollection، **assignmentCollection** (نام/مقدار با drag)،
   dateTime، color، filter (شرط‌ساز). → catalog فیلد ما باید این‌ها را پوشش دهد.

## ✅ سرمایهٔ موجود (بک‌اند جلوتر از UI است)

- موتور workflow کامل در `src/pipeline.ts`: `if/while/loop/foreach/switch/try/break/continue/return/set_variable` + دهها action مرورگری.
- رویدادهای لحظه‌ای هر استپ: `step.start` / `step.done`(success+durationMs) / `step.error`(message) از `onEvent`→`LiveBus`.
- کانال زنده: WebSocket `/live/ws` + SSE fallback. ذخیرهٔ چند-ورکفلو + نسخه‌بندی: `WorkflowService` + CRUD کامل + `/versions` + `/run`.
- Webhook خروجی HMAC: `src/services/webhook.service.ts`. نود n8n + Trigger node. افزونهٔ پایه (`extension/`).
- **شکاف اصلی = UI:** تک‌ورکفلو در localStorage، palette لیستی، بدون NDV، بدون جریان آیتم/Expression، بدون نمایش نتیجهٔ نود.

---

## 📋 استپ‌های فاز نهایی (۲۱ تا ۳۲)

> هر استپ = چرخهٔ کامل: پیاده‌سازی → tsc+build+test سبز → به‌روزرسانی PLAN/SESSION/README → پاک‌سازی artifact → commit+push روی main + لینک کامیت.

- [x] **استپ ۲۱ — مدل دادهٔ یکنواخت آیتم‌محور (زیربنای همه‌چیز، الهام مستقیم از n8n)** ✅ _(۲۰۲۶-۰۶-۰۶)_
  1. ✅ ماژول مستقل و خالصِ `src/core/WorkflowItems.ts`: قرارداد `WorkflowItem = { json: Record<string,unknown>, binary?: Record<string,WorkflowBinary> }` + helperهای `emptyItem/emptyStream/isWorkflowItem/toItem/normalizeToItems/resolveOutputStream/itemsToJson/summarizeItems`.
  2. ✅ «جریان آیتم» در `pipeline.ts`: هر workflow با **یک آیتم خالی** شروع می‌شود (مثل n8n)؛ خروجی هر استپ با `normalizeToItems(result)` به `items[]` تبدیل می‌شود (شیء→۱ آیتم، آرایه→n آیتم، primitive→`{value}`)؛ اگر استپ خروجی نداشته باشد (مثل click) جریان قبلی **pass-through** می‌شود. سازگاری عقب‌رو کامل: `variables`/`set_variable`/`extract`/`saveAs` دست‌نخورده ماندند (مدل آیتم لایه‌ی اضافه است، نه جایگزین).
  3. ✅ ثبت ورودی/خروجی هر استپ: فیلدهای `inputItemCount`/`outputItemCount`/`outputSample`/`outputTruncated` به `StepOutput` و رویداد `step.done` افزوده شد (sample با سقف ~۸KB برای جلوگیری از سیل کانال زنده).
  4. ✅ زمینهٔ Expression: `context.nodeOutputs[nodeKey]` خروجی هر نود را با کلید `saveAs` یا `action#index` نگه می‌دارد (برای ارجاع آیندهٔ `$node["name"].json`).
  - ✅ تست: `tests/unit/workflow-items.test.ts` (۲۳ تست) — قرارداد آیتم + normalize + fan-out n-آیتمی + pass-through + summarize/cap + سازگاری. `tsc`/`build` سبز، `npm test`=**۱۸۰** (۱۵۷→۱۸۰).

- [x] **استپ ۲۲ — کتابخانهٔ چند-ورکفلو در UI + اتصال به CRUD موجود** ✅ _(۲۰۲۶-۰۶-۰۶)_
  1. ✅ ویوی «ورکفلوها» (`renderWorkflows` در `views.js`): گرید کارت از `GET /workflows/:userId` (نام/توضیح/نسخه/تعداد استپ/آخرین ویرایش)؛ آیتم ناوبری `📚 ورکفلوها` + روت `#/workflows` در `app.js`/`index.html`.
  2. ✅ عملیات کامل روی هر کارت: ساخت (`createWorkflow`)/تغییرنام (`updateWorkflow`)/کپی=duplicate/حذف (`deleteWorkflow`)/اجرا (`runWorkflow`)/باز کردن در ادیتور. ادیتور دیگر به یک گراف localStorage محدود نیست: دکمهٔ «💾 ذخیره روی سرور» ورکفلوی جاری را PUT می‌کند (بامپ نسخه) یا برای ورکفلوی جدید نام می‌پرسد و POST می‌کند؛ `flow-editor.js` با `currentWorkflow`/`openWorkflow`/`newWorkflow`/`getCurrentWorkflow` زمینهٔ ورکفلو را نگه می‌دارد و گراف را از `steps[]` بازسازی می‌کند.
  3. ✅ تاریخچهٔ نسخه (`GET /:workflowId/versions`) با باز/بست درون کارت + بازگردانی (restore = ذخیرهٔ snapshot به‌عنوان نسخهٔ جدید با PUT). قرارداد API در `api.js`: `put()` + `wfBase/listWorkflows/getWorkflow/createWorkflow/updateWorkflow/deleteWorkflow/listWorkflowVersions/runWorkflow`.
  - ✅ i18n کامل (fa+en): `nav.workflows` + `fe.saveServer`/`fe.unsaved` + بلوک کامل `wf.*` (۲۸ کلید در هر زبان). CSS کلاس‌های `.wf-grid/.wf-card/.wf-card-head/.wf-name/.wf-desc/.wf-meta/.wf-actions/.wf-versions/.wf-ver-row` + هلپر عمومی `.small`. CRUD سمت سرور از قبل با `tests/integration/workflows.test.ts` + `tests/unit/workflow-service.test.ts` پوشش‌داده شده. `tsc`/`build` سبز، `npm test`=**۱۸۰**. (تصمیم: موقعیت نودها در استپ ۲۲ سمت سرور ذخیره نمی‌شود؛ ادیتور چیدمان خطی تمیز را از `steps[]` بازسازی می‌کند — ذخیرهٔ موقعیت به بازطراحی Canvas در استپ ۲۳ موکول شد.)

- [x] **استپ ۲۳ — بازطراحی بصری Canvas نودبیس (هم‌حسِ n8n، بدون کپی کد — لایسنس AGPL)** ✅ _(۲۰۲۶-۰۶-۰۶)_
  1. ✅ Drag&Drop از palette به کانواس (`text/ab-action` در dataTransfer + `placeNewNode`)، grid-snap (`GRID=20`، `Alt`=جابه‌جایی آزاد)، minimap (پایین-انتها، کلیک=هم‌مرکزسازی)، کنترل‌های zoom/fit (`zoomIn/zoomOut/fitToScreen` با `nodesBBox`)، انتخاب چندتایی (`selSet`) + box-select (`Shift`+درگ روی پس‌زمینه) + جابه‌جایی گروهی، کپی/پیست (`Ctrl+C`/`Ctrl+V`)، انتخاب‌همه (`Ctrl+A`)، حذف (`Delete`/`Backspace`).
  2. ✅ دسته‌بندی و رنگ‌بندی بلوک‌ها: `cat` روی هر ۱۸ اکشن + آرایهٔ `CATEGORIES` (navigation/interaction/data/flow/integration/trigger) با رنگ هگز و لیبل i18n + `categoryById`؛ نوار لهجهٔ رنگی روی نود (`--cat-color` + `border-inline-start`). palette با جست‌وجوی نود (`renderPalette`/`renderPaletteList`) و گروه‌بندی بر اساس دسته.
  3. ✅ **حالت‌های بصری نود** (پایهٔ UI، دادهٔ واقعی در استپ ۲۶): `setNodeStatus(ref,status)`/`clearStatuses()` با `ref=nodeId|index زنجیره`؛ idle / running (هالهٔ چرخان `@keyframes fe-pulse` + نقطهٔ `fe-blink`) / success (سبز) / error (قرمز).
  - ✅ تست DOM-free کاتالوگ اکشن `tests/unit/action-catalog.test.ts` (۹ تست؛ بارگذاری `actions.js` با شیم `window` از طریق `node:vm` — بدون افزودن jsdom). i18n کامل (fa+en): `fe.searchNode/noNodes/zoomIn/zoomOut/fit` + `cat.*` (۱۲ کلید جدید با برابری fa/en) + به‌روزرسانی `fe.hint`. `tsc`/`build` سبز، `npm test`=**۱۸۹** (۱۸۰+۹)، smoke مرورگر=۰ خطای کنسول. (تصمیم: `flow-editor.js` به‌خاطر وابستگی سنگین به DOM با smoke مرورگر پوشش داده شد نه unit؛ موقعیت نودها هنوز سمت سرور ذخیره نمی‌شود — به استپ ۲۴ موکول شد.)

- [x] **استپ ۲۴ — نودهای شاخه‌دار و سریالایز کامل گراف غیرخطی** ✅ _(۲۰۲۶-۰۶-۰۶)_
  1. ✅ پورت‌های خروجی چندگانه: `if`(then/else+next)، `switch`(default + کِیس‌های پویا `case:<v>` از فهرست کامادار + next)، `loop`/`foreach`/`while`(body/done)، `try`(try/catch/finally+next). در `actions.js`: ۶ اکشن دستهٔ `flow` با متادیتای `branches`؛ هلپرهای `branchesOf(id)` (پیش‌فرض تک‌پورت `next`) و `isBranching(id)` به `window.ACTION_CATALOG` اضافه شد. هر یال اکنون `port` دارد؛ `connect(from,to,port)` به‌ازای هر پورت حداکثر یک یال نگه می‌دارد (fan-out شاخه‌ای).
  2. ✅ ماژول مستقل و DOM-free `public/js/graph-serialize.js` (`window.GraphSerialize`): `graphToSteps(graph)` گراف غیرخطی را به `steps[]` تو‌در‌توی بک‌اند نگاشت می‌کند — `if`→`{condition,then,else}`، `switch`→`{params:{variable},cases:{<v>,default}}`، `loop/foreach`→`{params,steps}`، `while`→`{condition,params:{maxIterations},steps}` (کلیدهای شرط از params جدا می‌شوند)، `try`→`{steps,catch,finally}`؛ ادامهٔ زنجیرهٔ اصلی از پورت `next` (برای if/switch/try) یا `done` (برای loop/foreach/while). `stepsToGraph(steps)` معکوس کامل با چیدمان بصری (شاخه‌ها زیر/راستِ والد). گاردِ حلقه در walkChain. سریالایز در `flow-editor.js` به این ماژول واگذار شد (toSteps/loadSteps).
  3. ✅ `validateGraph(graph)` → `{ok, errors[], warnings[]}` با کدها: `empty`/`orphan`(غیرقابل‌دسترس از start)/`unknown-action`/`empty-loop`/`foreach-items`/`empty-if`/`switch-var`؛ پنل اعتبارسنجی زنده در inspector (`appendValidation`) + API عمومی `FlowEditor.validate()`. پیام‌ها کلید i18n (`val.*`).
  - ✅ تست DOM-free `tests/unit/graph-serialize.test.ts` (۱۷ تست via `node:vm` با شیم `window`؛ بارگذاری actions.js+graph-serialize.js): زنجیرهٔ خطی، coerce عدد/حذف خالی، هر شش نوع شاخه با شکل دقیق بک‌اند، گارد حلقه، **رفت‌وبرگشت** steps→graph→steps برای if/loop و switch/try، و ۵ تست اعتبارسنجی. i18n کامل fa+en: ۸ کلید `p.*` شاخه + ۹ `port.*` + ۹ `val.*` (۲۶ کلید با برابری). CSS: پورت‌های رنگی (then/body/try=سبز، else/catch=قرمز، done/finally=نارنجی، case=فیروزه‌ای) + برچسب پورت + یال‌های رنگی + پنل اعتبارسنجی. ترتیب لود اسکریپت: actions→i18n→api→**graph-serialize**→flow-editor. `tsc`/`build` سبز، `npm test`=**۲۰۶** (۱۸۹+۱۷)، smoke مرورگر=۰ خطای کنسول. (هیچ تغییری در `src/**` نبود — بک‌اند از قبل nested AutomationStep را اجرا می‌کرد؛ این استپ صرفاً UI/سریالایز بود. بدون اسکریپت throwaway.)

- [x] **استپ ۲۵ — NDV (Node Detail View) سه‌ستونه + فیلدهای غنی + Expression/Mapping** ✅ _(۲۰۲۶-۰۶-۰۶)_
  1. ✅ پنل سه‌ستونه در inspector: **INPUT** | **Parameters** | **OUTPUT**. ستون INPUT آیتم‌های ورودی (خروجی نود پیشین) را به‌صورت pillهای dot-path قابل‌کشیدن (`$json.x`) نشان می‌دهد؛ Parameters فیلدهای غنی؛ OUTPUT نتیجهٔ JSON همان نود. در دسکتاپ سه‌ستونه (`@media min-width:1100px`)، در عرض کم استک عمودی. APIهای `FlowEditor.setNodeResults(nodeId,{input,output})`/`clearResults()` برای پر شدن توسط رانر زنده در استپ ۲۶.
  2. ✅ ارتقای catalog فیلد در `actions.js`: رجیستری `FIELD_TYPES` (string/password/multiline/number/boolean/options/multiOptions/collection/fixedCollection/assignment/dateTime/code/json/filter) + هلپر `fieldType(field)` که aliasهای legacy (`text`→`string`، `select`→`options`) را نرمال می‌کند و `{type,input,expressionable}` می‌دهد. فیلدها پرچم `expr` (اکسپرشن‌پذیر)، `help` (کلید i18n)، و `min/max` گرفتند. رندر کنترل‌های غنی در `flow-editor.js`: textarea/select/toggle(boolean)/number(min/max)/password/datetime-local/code/json.
  3. ✅ **Expression engine امن و DOM-free** `public/js/expression.js` (`window.ExpressionEngine = {isExpression,evaluate,evaluateTemplate,mapParams}`): tokenizer + Pratt parser + tree-walking interpreter روی گرامر کوچک و سخت‌گیر — **هرگز `eval`/`new Function`/`with`**. پشتیبانی: `{{ $json.x }}`، `$node["n"].json`، `$now`/`$today`/`$index`/`$vars`، عملگرها، ternary، آرایه، و متدهای **whitelist‌شده per-type**. هر فیلد اکسپرشن‌پذیر تاگل **Fixed/Expression** دارد؛ **drag&drop از INPUT** توکن `{{ ... }}` را در محل کرسر می‌چسباند.
  4. ✅ help/description زیر هر فیلد + **پیش‌نمایش/اعتبارسنجی inline** اکسپرشن (ارزیابی زنده روی نمونهٔ INPUT با معنای mapParams؛ هرگز throw نمی‌کند). ⚠️ **امنیت (درس CVE اخیر n8n):** آلودگی پروتوتایپ مسدود (`__proto__/prototype/constructor/__defineGetter__/…`)، فرار کلاسیک `.constructor.constructor("…")()` ناممکن، هیچ مسیری به `Function/eval/globalThis/process/require/window`، و متدهای غیر‌whitelist (مثل `Array.map`) رد می‌شوند.
  - ✅ تست DOM-free `tests/unit/expression.test.ts` (**۳۱ تست** via `node:vm` با شیمِ صرفاً `window` — بدون نشت گلوبال Node): (A) درستی ارزیابی + interpolation + حفظ نوعِ بومی برای اکسپرشن کاملِ تک‌رشته‌ای، (B) `mapParams` → params بک‌اند با جمع‌آوری خطای per-key، (C) **امنیت sandbox** (constructor/proto/global escape + رد متدهای غیر‌whitelist). i18n کامل fa+en: ۱۵ کلید جدید (`ndv.*` ۵ + `expr.*` ۴ + `help.*` ۶) با برابری ۳۲۲ کلید (همه count=2). CSS: چیدمان سه‌ستونه + pillهای INPUT + تاگل Fixed/Expression + toggle بولین (RTL-aware) + pre خروجی + پیش‌نمایش inline. ترتیب لود اسکریپت: actions→i18n→api→**expression**→graph-serialize→flow-editor. `tsc`/`build` سبز، `npm test`=**۲۳۷** (۲۰۶+۳۱)، smoke مرورگر=۰ خطای کنسول. (هیچ تغییری در `src/**` نبود؛ موتور صرفاً سمت‌کلاینت/CSP-safe. بدون اسکریپت throwaway.)

- [ ] **استپ ۲۶ — اجرای زنده + نتیجهٔ هر نود مثل n8n + پنل لاگ همیشه‌جلوی‌چشم**
  1. **پنل لاگ/اجرا** (کشوی پایین قابل‌جمع‌شدن) روی همهٔ صفحات، متصل به WS؛ خط زمانی استپ‌ها با وضعیت لحظه‌ای.
  2. **روی نود:** انیمیشن «در حال اجرا»، سپس badge سبز(✓ + تعداد آیتم + زمان) یا قرمز(✕ + علت)، با tooltip.
  3. **کلیک روی نود → OUTPUT آن استپ** (آیتم‌های خروجی Table/JSON + پارامترهای ورودی + موفق/خطا + پیام دقیق) — درست مثل n8n.
  4. ذخیرهٔ «آخرین اجرا»ی هر ورکفلو برای نمایش پس از reload + **Pinning** خروجی نود برای توسعهٔ سریع بدون اجرای مرورگر.
  - تست reducer وضعیت اجرا + تست e2e جریان رویدادها.

- [ ] **استپ ۲۷ — Error handling حرفه‌ای (هم‌تراز n8n)**
  1. هر نود: گزینه‌های **Continue On Fail** و **Retry On Fail** (تعداد دفعات + فاصله) در تب Settings نود.
  2. **Error Workflow سراسری** per-workflow: هنگام شکست، ورکفلوی خطا با دادهٔ استاندارد (`execution.error.message/stack`, `lastNodeExecuted`, `workflow.id/name`) اجرا شود؛ نود **Error Trigger**.
  3. نود **Stop And Error** برای شکست عمدی تحت شرط.
  - تست retry/continue + تست دادهٔ Error Trigger.

- [ ] **استپ ۲۸ — Triggerها (مدل ب برای n8n) + موتور فعال‌سازی با تزریق دیتا**
  1. **Manual Trigger** (تست از پنل)، **Webhook Trigger** (URL ورودی منحصربه‌فرد per-workflow؛ دیتا به آیتم‌های ورودی تزریق می‌شود)، **Schedule/Cron Trigger** (BullMQ repeatable — «وقتی زمان رسید خودش اجرا کند»).
  2. **Telegram Trigger** (دریافت پیام و فعال‌سازی ورکفلو). مدیریت فعال/غیرفعال trigger + امنیت (HMAC/توکن مسیر).
  3. اتصال trigger → ورکفلوی ذخیره‌شده؛ نگاشت `body/headers/query` ورودی به `items[].json`.
  - تست تزریق دیتای ورودی + تست زمان‌بندی + تست امنیت webhook.

- [ ] **استپ ۲۹ — گزارش لحظه‌ای دوکاناله به بیرون (Webhook هر استپ + لینک مشاهدهٔ زنده)**
  1. **Webhook خروجی per-step:** علاوه بر eventهای job، رویداد هر استپ (success/error + خلاصهٔ آیتم خروجی) لحظه‌ای به URL کلاینت (n8n) با HMAC ارسال شود.
  2. نود **Trigger n8n** برای دریافت `step.start/step.done/step.error` گسترش یابد (multiOptions رویدادها).
  3. **لینک مشاهدهٔ زندهٔ** قابل‌اشتراک per-job (`/live/...`) که نودبه‌نود + خروجی هر استپ را چشمی نشان می‌دهد.
  - تست تحویل webhook هر استپ (retry/HMAC) + تست authorize لینک زنده.

- [ ] **استپ ۳۰ — نود n8n غنی (هم‌تراز فیلدهای پنل)**
  1. ارتقای `AutomationBackend.node.ts`: انتخاب ورکفلوی ذخیره‌شده (loadOptions از `/workflows`)، تزریق دیتا (JSON/Expression)، حالت sync(`wait=true`)/async، resource/operation استاندارد n8n.
  2. عملیات اصلی **مدل ب**: «اجرای ورکفلوی ذخیره‌شده با این دیتا». نمونه‌ورکفلوهای n8n در `n8n-node/examples`.
  - تست قرارداد payload نود ↔ `/workflows/:id/run`.

- [ ] **استپ ۳۱ — افزونهٔ کروم = همان پنل (مدل الف) + Element Picker + تیک/خطا روی نود**
  1. افزونه با **لاگین** (همان API_TOKEN) به سرور وصل می‌شود و **همان پنل/ورکفلوها** را نشان می‌دهد (UI مشترک؛ نه کپی موازی).
  2. **Element Picker** روی مرورگر کاربر (ارتقای `selector.js`) → تولید selector پایدار و درج مستقیم در فیلد نود (مزیت اصلی افزونه).
  3. اشتراک کانال زنده در افزونه: روی هر نود تیک/خطا هم‌راستا با استپ ۲۶ + اجرای مستقیم/تعاملی روی تب فعلی (مدل الف).
  - تست منطق selector + تست پیام‌رسانی background↔content.

- [ ] **استپ ۳۲ — همگام‌سازی کاتالوگ اکشن + Templates + جمع‌بندی/مستندسازی**
  1. **Single Source of Truth:** همگام‌سازی `actions.js` با فهرست اکشن‌های `pipeline.ts` + guard-test «هر اکشن بک‌اند یک تعریف UI دارد».
  2. **Templates:** چند ورکفلوی آمادهٔ نمونه (اسکرپ قیمت، پرکردن فرم پشت لاگین، اسکرین‌شات زمان‌بندی‌شده) در UI.
  3. راهنمای end-to-end در `docs/` (n8n → سرور → مشاهدهٔ زنده/افزونه) + بازبینی ریسپانسیو/تم/دسترس‌پذیری.

---

## 🧱 اصول و قراردادهای این فاز

- **لایسنس:** از Automa (AGPL + لایسنس تجاری) و n8n **فقط الهام UX** می‌گیریم؛ **هیچ کدی کپی نمی‌شود** — بازسازی با استک خالص خودمان (vanilla JS، CSP-safe `script-src 'self'`).
- **معماری «بک‌اند جلوتر است»:** ابتدا UI را به قابلیت‌های آمادهٔ بک‌اند وصل می‌کنیم؛ سپس مدل آیتم/Expression/NDV را اضافه می‌کنیم.
- **قرارداد client-agnostic:** پنل/افزونه/n8n همگی از همان `steps[]`، همان مدل آیتم و همان endpointها استفاده می‌کنند (یک منبع حقیقت).
- **امنیت Expression:** ارزیابی در sandbox محدود (allow-list توابع، بدون دسترسی به `process`/شبکهٔ خام) — درس از CVE-2025-68613 در n8n.
- **خط‌پایان:** `src/**/*.ts` + ریشهٔ `package.json` + `.env.example` + `ecosystem.config.js` با **CRLF**؛ `public/**`، `tests/**`، `docs/**`، `extension/**`، `n8n-node/**`، `*.md`، `.github/**` با **LF**.

## 🗺️ توالی وابستگی‌ها (چرا این ترتیب)

```
۲۱ مدل آیتم  ──┬──► ۲۵ NDV/Expression ──► ۲۶ نتیجهٔ نود زنده ──► ۲۹ webhook هر استپ
               │                                   ▲
۲۲ چند-ورکفلو ─┼──► ۲۳ canvas ──► ۲۴ شاخه‌دار ──────┘
               │
               └──► ۲۷ error handling   ۲۸ triggers ──► ۳۰ نود n8n ──► ۳۱ افزونه ──► ۳۲ جمع‌بندی
```
- ۲۱ (مدل آیتم) زیربنای NDV و Expression و نمایش خروجی نود است → اول.
- ۲۲ (چند-ورکفلو) زیربنای canvas/ادیتور است → دوم.
- ۲۶ (نتیجهٔ زندهٔ نود) به مدل آیتم (۲۱) و رویدادهای موجود بک‌اند وابسته است.
- ۲۹ (webhook هر استپ) و ۳۰ (نود n8n) و ۳۱ (افزونه) همگی روی زیرساخت بالا سوار می‌شوند.
