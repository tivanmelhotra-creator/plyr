# راهنمای سرتاسری (End-to-End) — automation-backend

این راهنما جریان کامل کار را از ساختِ ورکفلو تا اجرای زنده توضیح می‌دهد و سه نقطهٔ ورود (entry point) به موتور یکسانِ سرور را به هم وصل می‌کند:

1. **n8n** — به‌عنوان یک نود سفارشی در گردش‌کارهای n8n.
2. **سرور / پنل وب** — Builder خطی و Visual Editor در `public/`.
3. **افزونهٔ کروم + نمای زنده** — کلاینت سبک (Model A) که فقط یک درخواست می‌فرستد و نتیجه را زنده آینه می‌کند.

> یک حقیقت مهم: **همهٔ این سه مسیر روی یک موتور واحد اجرا می‌شوند** — `src/pipeline.ts` روی سرور. هیچ‌کدام از کلاینت‌ها (افزونه/پنل/n8n) خودشان مرورگر را راه نمی‌اندازند؛ آن‌ها فقط درخواست می‌فرستند و رویدادهای زنده را نمایش می‌دهند.

---

## ۰. نقشهٔ کلی

```
                       ┌────────────────────────────────────────────┐
                       │            automation-backend               │
                       │  Express + BullMQ(Redis) + Playwright        │
   ┌──────────┐        │                                              │
   │   n8n    │──POST──▶│  POST /run            (اجرای inline)         │
   │  node    │        │  POST /workflows/:u/:w/run (اجرای نسخهٔ ذخیره)│
   └──────────┘        │                                              │
                       │  Worker ◀── صف ◀── جاب                        │
   ┌──────────┐        │     │                                        │
   │  پنل وب  │──POST──▶│     ▼ pipeline.ts → Playwright               │
   │ (Builder)│        │  رویدادهای زنده هر استپ                       │
   └──────────┘        │     │                                        │
                       │     ├─▶ WS  /live/ws                          │
   ┌──────────┐        │     └─▶ SSE /live/sse/:u/:jobId               │
   │ افزونهٔ  │──POST──▶│                                              │
   │  کروم    │◀─SSE────│  (افزونه چون MV3 است با fetch+ReadableStream │
   └──────────┘        │   استریم را می‌خواند، نه EventSource)          │
                       └────────────────────────────────────────────┘
```

دو مدل اجرا:

| مدل | چیست | endpoint | کاربرد |
|-----|------|----------|--------|
| **Model A** | اجرای inline؛ کلاینت آرایهٔ `steps` را همان‌جا می‌فرستد | `POST /run` | تست سریع، افزونهٔ کروم، اجرای موقت |
| **Model B** | اجرای یک ورکفلوی **ذخیره‌شده و نسخه‌دار** | `POST /workflows/:userId/:workflowId/run` | تولیدی، زمان‌بندی، تریگرها |

---

## ۱. پیش‌نیازها

```bash
# Redis در حال اجرا
redis-server  # یا از طریق docker-compose پروژه

# نصب و بیلد
npm install
npm run build      # یا برای توسعه: npm run dev
```

متغیرهای کلیدی محیط (کامل در `.env.example`):

| متغیر | توضیح |
|------|-------|
| `PORT` | پیش‌فرض `3000` |
| `REDIS_URL` | اتصال صف BullMQ |
| `API_KEYS` | کلیدهای کاربری (`x-api-key`) |
| `DEPLOYMENT_MODE` | `single` (تک‌کاربره) یا `multi` (چندمستأجری) |
| `DEFAULT_HEADLESS` | حالت پیش‌فرض مرورگر |

سلامت سرویس:

```bash
curl http://localhost:3000/health
# { "status": "ok", "redis": "connected", "lua": true }
```

---

## ۲. ساخت ورکفلو (سه راه، یک خروجی)

همهٔ مسیرها به یک مدل دادهٔ یکسان می‌رسند: آرایه‌ای از استپ‌ها به شکل
`{ action, params }`. مدل دادهٔ بین استپ‌ها هم n8n-style است:
`[{ json, binary? }]`.

### ۲.۱ Builder خطی (پنل وب)
- آدرس پنل: `http://localhost:3000/`
- نودها را از کاتالوگ اکشن (`public/js/actions.js`) اضافه کنید.
- خروجی: یک ورکفلو که می‌توانید **Run** (Model A) یا **Save** (Model B) کنید.

### ۲.۲ Visual Editor
- ویرایش گرافیکی با شاخه‌بندی (if/else، try/catch/finally، loop/foreach).
- همان کاتالوگ اکشن را مصرف می‌کند → تضمین هم‌خوانی نودها با بک‌اند.

### ۲.۳ Templates (الگوهای آماده) — جدید در استپ ۳۲
در صفحهٔ Workflows دکمهٔ **🧩 Templates** را بزنید. سه الگوی آماده:

| الگو | کار |
|------|-----|
| **اسکرپ قیمت** (`price-scrape`) | باز کردن صفحهٔ محصول، استخراج قیمت/عنوان، خروجی JSON |
| **پرکردن فرم لاگین** (`login-form`) | ورود پشت لاگین، استخراج پیام خوش‌آمد (رمز از طریق expression) |
| **اسکرین‌شات زمان‌بندی‌شده** (`scheduled-screenshot`) | تریگر زمان‌بندی روزانه + اسکرین‌شات |

با یک کلیک، الگو به‌عنوان یک ورکفلوی جدید ذخیره می‌شود و آمادهٔ اجرا/ویرایش است.

> منبع داده: `public/js/templates.js`. هر اکشنِ به‌کاررفته در الگوها با تستِ
> `tests/unit/templates.test.ts` در برابر کاتالوگ اکشن اعتبارسنجی می‌شود تا
> هرگز به نودی اشاره نکنند که UI/بک‌اند نمی‌تواند اجرا کند.

---

## ۳. اجرا روی سرور

### Model A — اجرای inline (`POST /run`)
```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_live_xxx" \
  -d '{
    "userId": "u1",
    "headless": true,
    "steps": [
      { "action": "goto", "url": "https://example.com" },
      { "action": "extract", "selector": "h1", "name": "title" }
    ]
  }'
# → { "success": true, "jobId": "123", ... }
```

### Model B — اجرای ورکفلوی ذخیره‌شده
```bash
# ۱) ذخیره
curl -X POST http://localhost:3000/workflows/u1 \
  -H "x-api-key: sk_live_xxx" -H "Content-Type: application/json" \
  -d '{ "name": "my-flow", "steps": [ ... ], "headless": true }'

# ۲) اجرای آخرین نسخه
curl -X POST http://localhost:3000/workflows/u1/<workflowId>/run \
  -H "x-api-key: sk_live_xxx"
```

در هر دو حالت یک `jobId` برمی‌گردد که کلید دیدن اجرای زنده است.

---

## ۴. نمای زنده (Live View) — هر استپ، لحظه‌ای

کارگر (worker) هنگام اجرای هر استپ، رویداد منتشر می‌کند. دو راه برای مصرف:

### ۴.۱ WebSocket
```
ws://localhost:3000/live/ws
```

### ۴.۲ SSE (مناسب کلاینت‌های ساده و افزونه)
```
GET /live/sse/:userId/:jobId
```
احراز هویت یا با هدر `x-api-key` یا با کوئری `?api_key=...` (برای محیط‌هایی که هدر سفارشی ممکن نیست، مثل افزونه).

```bash
curl -N "http://localhost:3000/live/sse/u1/123?api_key=sk_live_xxx"
# data: {"type":"step:start","index":0,"action":"goto"}
# data: {"type":"step:done","index":0}
# data: {"type":"job:done", ...}
```

هر فریم SSE با جداکنندهٔ `\n\n` تمام می‌شود. رویدادهای پایانی (`job:done`/`job:error`) جریان را می‌بندند.

> صفحهٔ آمادهٔ اشتراک‌گذاری: `GET /live/view/:userId/:jobId` و لینک اشتراکی `GET /live/share/:userId/:jobId`.

---

## ۵. افزونهٔ کروم (Model A کلاینت سبک)

افزونه (MV3، بدون build، CSP امن) **هیچ ورکفلویی را محلی اجرا نمی‌کند**. کاری که می‌کند:

1. **یک** درخواست به سرور می‌زند (`/run` یا `/workflows/:u/:w/run`).
2. روی `jobId` برگشتی، کانال SSE را با **fetch + ReadableStream + TextDecoder** می‌خواند (سرویس‌ورکر MV3 شیء `EventSource` ندارد).
3. هر استپ را زنده با ✓/✗ آینه می‌کند.

به همین دلیل **به‌نظر می‌رسد** انگار روی سیستم شما اجرا می‌شود، در حالی که کل اجرا روی سرور است و افزونه فقط آینهٔ زنده است.

امکانات افزونه:
- **Open panel** — باز کردن پنل وبِ همان سرور.
- **Workflows** — فهرست و اجرای ورکفلوهای ذخیره‌شده (Model B از داخل افزونه).
- **Element Picker** — انتخاب عنصر روی صفحه و ساختِ `extract` با نام دلخواه.
- **Live run** — ردیف زندهٔ هر استپ (تیک/خطا).

ماژول مشترک منطق: `extension/lib/ab-core.js` (همان توابع ساختِ URL و نگاشت رویداد که تست‌ها و popup و background استفاده می‌کنند).

---

## ۶. n8n (نود سفارشی)

نود داخل `n8n-node/` همان دو مدل را پوشش می‌دهد: می‌توانید استپ‌ها را inline بفرستید (`/run`) یا یک ورکفلوی ذخیره‌شده را با `workflowId` اجرا کنید. خروجیِ نود به‌صورت آیتم‌های n8n-style (`[{json, binary?}]`) به نودهای بعدی می‌رسد، بنابراین زنجیره‌سازی با بقیهٔ n8n طبیعی است.

جریان معمول:
```
[Trigger n8n] → [automation-backend node: /run یا /workflows/run] → [نودهای بعدی n8n]
```

---

## ۷. منبع واحد حقیقت (Single Source of Truth) برای اکشن‌ها

- **مرجع اجرا:** `src/pipeline.ts` (زنجیرهٔ `if (step.action === ...)`).
- **کاتالوگ UI:** `public/js/actions.js` (`window.ACTION_CATALOG`) که هم Builder خطی و هم Visual Editor از آن تغذیه می‌شوند.
- **گاردتست:** `tests/unit/action-catalog.test.ts` تضمین می‌کند **هر اکشنی که بک‌اند dispatch می‌کند** از طریق کاتالوگ UI قابل‌دسترسی است (مستقیم یا از طریق نامِ مستعار/alias).
- **الگوها:** `tests/unit/templates.test.ts` تضمین می‌کند هر اکشنِ به‌کاررفته در الگوها در کاتالوگ وجود دارد.

اگر اکشن جدیدی به `pipeline.ts` اضافه کردید و تعریف UI نساختید، گاردتست شکست می‌خورد — این عمداً است.

---

## ۸. عیب‌یابی سریع

| نشانه | علت محتمل | راه‌حل |
|-------|-----------|--------|
| `/health` می‌گوید redis disconnected | Redis بالا نیست | `redis-server` یا `REDIS_URL` را بررسی کنید |
| SSE در افزونه چیزی نشان نمی‌دهد | احراز هویت | از `?api_key=` در URL استفاده کنید (هدر در افزونه محدود است) |
| جاب صف می‌شود ولی اجرا نمی‌شود | worker بالا نیست | پروسهٔ worker / `npm run dev` را بررسی کنید |
| اکشن «اجرا نشد» ولی خطا نمی‌دهد | اکشن ناشناخته (بدون allowlist عبور می‌کند) | املای `action` را با کاتالوگ تطبیق دهید |

---

_برای جزئیات کامل endpointها به [`API.md`](./API.md) و [`openapi.yaml`](./openapi.yaml) مراجعه کنید._
