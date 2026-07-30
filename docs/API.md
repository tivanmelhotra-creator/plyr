# API Reference — automation-backend

مرجع کامل endpointهای HTTP. همه‌ی پاسخ‌ها JSON هستند. مسیرهای کاربری و سلامت روی ریشه (`/`) و مسیرهای ادمین زیر `/admin` mount شده‌اند.

> **Base URL پیش‌فرض:** `http://localhost:3000`

---

## احراز هویت (Authentication)

| نوع | Header | توضیح |
|------|--------|-------|
| کاربر | `x-api-key: <API_KEY>` | لازم برای `/run`, `/cancel`, `/job`, `/jobs`, `/quota`. کلیدها در `API_KEYS` تعریف می‌شوند. |
| ادمین | `x-admin-token: <ADMIN_SECRET>` | لازم برای همه‌ی مسیرهای `/admin/*`. مقدار از `ADMIN_SECRET`. |

> در حالت Self-Hosted تک‌کاربره (`DEPLOYMENT_MODE=single`) احراز هویت ممکن است ساده‌تر/غیرفعال شود — به استپ ۱۸ در `PLAN.md` مراجعه کنید.

نمونه‌ی فراخوانی:

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_live_xxx" \
  -d '{ "userId": "u1", "steps": [ { "action": "goto", "url": "https://example.com" } ] }'
```

---

## Health

### `GET /health`
بررسی سلامت سرویس (Redis، Lua، مرورگر). نیازی به احراز هویت ندارد.

**پاسخ نمونه:**
```json
{ "status": "ok", "redis": "connected", "lua": true }
```

---

## User Endpoints

### `POST /run`
ثبت یک جاب اتوماسیون در صف. _(auth: x-api-key)_

**Body:**
| فیلد | نوع | الزامی | توضیح |
|------|-----|--------|-------|
| `userId` | string | ✅ | شناسه‌ی کاربر |
| `steps` | Step[] | ✅ | آرایه‌ی مراحل اتوماسیون (طبق Flow Engine) |
| `headless` | boolean | ❌ | پیش‌فرض از `DEFAULT_HEADLESS` |
| `webhookUrl` | string (URL) | ❌ | برای دریافت نتیجه‌ی جاب |

**پاسخ موفق (200):**
```json
{
  "success": true,
  "jobId": "123",
  "message": "Job queued successfully",
  "yourJobNumber": 1,
  "queueLimit": 3,
  "priority": 100,
  "userType": "Free",
  "webhookEnabled": false
}
```

**خطاها:** `400` (ورودی نامعتبر)، `429` (سهمیه‌ی روزانه تمام شده یا محدودیت صف).

---

### `POST /run-node` 🆕
اجرای **یک نود** با دادهٔ واقعی نودهای قبلی — «تست تک‌نود» در ادیتور. _(auth: x-api-key)_

کلاینت **پیشوند زنجیره** را می‌فرستد: همهٔ مراحل فعال از تریگر تا خودِ نودِ تحت تست؛
پس نودِ تحت تست همیشه **آخرین** عضو `steps` است. علت اجرای پیشوند (و نه فقط همان یک
مرحله) این است که ورودی نود باید **واقعاً** از اجرای نودهای قبلی تولید شود؛ در غیر این
صورت ستون OUTPUT در پنل نود یک دروغ نمایش می‌داد.

**Body:**
| فیلد | نوع | الزامی | توضیح |
|------|-----|--------|-------|
| `userId` | string | ✅ | شناسه‌ی کاربر |
| `steps` | Step[] | ✅ | پیشوند زنجیره؛ نودِ تحت تست آخرین عضو است |
| `nodeIndex` | integer ≥ 0 | ❌ | فقط **بررسی توافق** با سرور، نه انتخاب‌گر؛ اگر بدهید باید برابر `steps.length - 1` باشد |
| `headless` | boolean | ❌ | پیش‌فرض از `DEFAULT_HEADLESS` |
| `triggerData` | object | ❌ | مثل `POST /run` برای مقداردهی اولیه‌ی آیتم‌ها |

دو فیلد **عمداً** وجود ندارند:
- `webhookUrl` — تست یک نود نباید وبهوک کاربر را شوت کند؛
- `workflowId` — جاب با `__workflowId` مهر نمی‌شود، پس این اجرای **جزئی** هرگز در تب
  Executions یا در آمار Workspace شمرده نمی‌شود. در `GET /jobs` با
  `trigger: "node"` و `partial: true` برمی‌گردد.

سهمیه و محدودیت صف دقیقاً مثل `POST /run` اعمال می‌شوند (تست نود هم دقیقه‌ی مرورگر
مصرف می‌کند و نباید راه فرار از سهمیه باشد).

**پاسخ موفق (200):**
```json
{
  "success": true,
  "jobId": "123",
  "nodeIndex": 2,
  "partial": true,
  "stepCount": 3,
  "message": "Node run queued successfully",
  "priority": 100
}
```

با `?wait=true` نتیجهٔ کامل درجا برمی‌گردد (`partial: true`, `waited: true`)، و اگر از
`RUN_WAIT_MAX_MS` بگذرد `202` با `pollUrl` می‌گیرید.

**خطاها:** `400` (ورودی نامعتبر یا `nodeIndex` که آخرین مرحله را آدرس نمی‌دهد)،
`429` (سهمیه/صف).

---

## کاتالوگ اکشن‌ها (Steps)

هر مرحله یک شیء `{ "action": "...", "params": { ... } }` است (فرمت قدیمی، پارامترها مستقیم کنار `action`، هم پشتیبانی می‌شود). فیلد اختیاری `saveAs` خروجی یک مرحله را در یک متغیر ذخیره می‌کند تا در مراحل بعد با `{{varName}}` استفاده شود.

### ناوبری و زمان‌بندی
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `goto` | `url` | باز کردن یک آدرس (الیاس: `navigate`, `goto-url`) |
| `wait` | `ms` یا `selector`+`state?`+`timeout?` یا `url`/`urlContains` یا `load` یا `fn` | انتظار زمانی یا انتظار برای عنصر/آدرس/بارگذاری/تابع |

### تعامل با صفحه
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `click` | `selector` | کلیک (الیاس‌ها: `dblclick`, `hover`, `focus`) |
| `hover` | `selector` | بردن نشانگر روی عنصر |
| `scroll` | `direction` (`bottom`/`top`) | اسکرول صفحه |
| `mouse-move` | `x`, `y` | حرکت ماوس (الیاس: `move-mouse`) |
| `drag-drop` | `from`, `to` | کشیدن و رها کردن (الیاس: `drag`) |

### فرم و کیبورد
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `fill` | `selector`, `text` | پر کردن سریع ورودی |
| `type` | `selector`, `text` | تایپ کاراکتر به کاراکتر |
| `press` | `text` (نام کلید مثل `Enter`) | فشردن کلید |
| `select` | `selector`, `value` | انتخاب گزینه‌ی `<select>` |
| `check` / `uncheck` | `selector` | تیک زدن/برداشتن چک‌باکس |
| `upload` | `selector`, `path` | آپلود فایل (الیاس: `upload-file`) |

### استخراج و خروجی داده
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `extract` | `selector`, `name` | استخراج متن/داده (الیاس: `scrape`, `get-data`) |
| `attribute` | `selector`, `method` (`get`/`set`/`remove`), `name`, `value?` | کار با صفت عنصر |
| `screenshot` | — | گرفتن اسکرین‌شات (در `saveAs` به‌صورت base64) |
| `export-data` 🆕 | `format` (`json`/`csv`), `from?` (نام متغیر منبع)، `filename?`, `data?` | ذخیره‌ی داده در `downloads/<userId>/`؛ اگر `from`/`data` ندهید، کل متغیرها صادر می‌شود |

### متغیرها و دستکاری داده
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `set_variable` | `name`, `value` یا `selector` | مقداردهی متغیر (از مقدار ثابت یا متن یک عنصر) |
| `variable` 🆕 | `op`, `name`, `from?`/`value?`, ... | تبدیل داده (الیاس: `set-variable`, `transform`) — جدول `op` پایین |

**عملیات `variable` (`op`):**
| op | پارامترهای مرتبط | نتیجه |
|----|------------------|-------|
| `set` | `value` یا `from` | مقدار خام را در `name` می‌گذارد |
| `regex` | `pattern`, `flags?` | با `g`: آرایه‌ی matchها؛ بدون `g`: اولین گروه‌۱ یا کل match (یا `null`) |
| `replace` | `pattern`, `flags?` (پیش‌فرض `g`), `replacement` | جایگزینی regex |
| `slice` | `start`, `end?` | برش رشته یا آرایه |
| `split` | `separator` (پیش‌فرض `,`) | تبدیل رشته به آرایه |
| `join` | `separator` (پیش‌فرض `,`) | تبدیل آرایه به رشته |
| `sort` | `numeric?`, `desc?` | مرتب‌سازی آرایه (یا خطوط یک رشته) |

> امنیت: طول `pattern` به ۱۰۰۰ و طول ورودی به ۱۰۰هزار کاراکتر محدود است و فقط فلگ‌های `g i m s u` پذیرفته می‌شوند (ضد ReDoS).

### کوکی، کلیپ‌بورد و اعلان
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `cookie` 🆕 | `op` (`getAll`/`get`/`set`/`clear`), `name?`, `value?`, `domain?`, `expires?` | مدیریت کوکی‌های context (الیاس: `cookies`) |
| `clipboard` | `action` (`get`/`set`/`copy`/`paste`), `text?`, `selector?` | کار با کلیپ‌بورد |
| `notification` 🆕 | `title`, `message?`, `level?` (`info`/`success`/`warn`/`error`) | ثبت اعلان در لاگ و خروجی مرحله (الیاس: `notify`) |
| `log` | `message` | نوشتن پیام در لاگ جاب |

### مرورگر، تب و فریم
| action | پارامترها | توضیح |
|--------|-----------|-------|
| `switch-frame` | `selector`/`index` | ورود به iframe (الیاس: `switch_frame`) |
| `switch-tab` | `index` | تعویض تب فعال (الیاس: `switch_tab`) |
| `close-tab` | — | بستن تب جاری (الیاس: `close_tab`) |
| `close-browser` | — | بستن کامل مرورگر (الیاس: `close_browser`) |
| `handle-dialog` | `action` (`accept`/`dismiss`), `text?` | پاسخ به dialog/alert (الیاس: `handle_dialog`) |
| `http-request` | `url`, `method?`, `headers?`, `body?` | درخواست HTTP (الیاس: `http`, `fetch`, `api`) — محافظت SSRF |

### کنترل جریان (Flow Engine)
| action | ساختار | توضیح |
|--------|--------|-------|
| `if` | `condition`, `then[]`, `else?[]` | شرط |
| `while` | `condition`, `steps[]` | حلقه‌ی شرطی |
| `loop` | `count`/`steps[]` | حلقه‌ی شمارشی |
| `foreach` | `items`, `steps[]` | پیمایش آرایه |
| `switch` | `variable`, `cases{}` | چندشاخه |
| `try` | `steps[]`, `catch?[]`, `finally?[]` | مدیریت خطا |
| `break` / `continue` / `return` / `fail` | — | کنترل اجرا |

> 🆕 = اکشن‌های افزوده‌شده در استپ ۱۱ (به‌سبک Automa). اکشن‌های جدید هم در فرم خطی و هم در ادیتور بصری از کاتالوگ مشترک `public/js/actions.js` در دسترس‌اند.

---

### `POST /schedule`
ثبت یک جاب زمان‌بندی‌شده‌ی تکرارشونده (cron) با BullMQ repeatable. _(auth: x-api-key)_

**Body:** `userId`, `steps`, `cron` (الگوی cron)، `name?`، `headless?`، `webhookUrl?`.

---

### `GET /schedules/:userId`
فهرست زمان‌بندی‌های فعال یک کاربر. _(auth: x-api-key)_

**پاسخ نمونه:**
```json
{
  "success": true,
  "schedules": [
    { "key": "...", "scheduleId": "...", "name": "daily", "cron": "0 9 * * *", "nextRun": "2026-06-05T09:00:00.000Z", "timezone": "UTC" }
  ]
}
```

---

### `DELETE /schedule/:userId/:key`
حذف یک زمان‌بندی با `key`. _(auth: x-api-key)_

---

### `DELETE /cancel/:userId/:jobId`
لغو یک جاب در حال اجرا یا در صف. _(auth: x-api-key)_

---

### `GET /quota/:userId`
سهمیه‌ی باقی‌مانده/مصرف‌شده‌ی کاربر. _(auth: x-api-key)_

---

### `GET /jobs/:userId`
فهرست جاب‌های اخیر کاربر. _(auth: x-api-key)_

### `GET /job/:userId/:jobId`
جزئیات و نتیجه‌ی یک جاب مشخص. _(auth: x-api-key)_

---

## Admin Endpoints (`/admin/*`)

همه با `x-admin-token`. در حالت `single` این مسیرها معمولاً غیرفعال یا باز می‌شوند (استپ ۱۸).

| Method | Path | توضیح |
|--------|------|-------|
| GET | `/admin/stats` | آمار کلی سیستم |
| POST | `/admin/set-user-level` | تنظیم سطح کاربر |
| GET | `/admin/user/:userId` | اطلاعات کاربر |
| GET | `/admin/user/:userId/settings` | تنظیمات کاربر |
| POST | `/admin/user/:userId/settings` | به‌روزرسانی تنظیمات کاربر |
| POST | `/admin/user/:userId/plan` | تغییر پلن کاربر |
| POST | `/admin/user/:userId/extend` | تمدید اعتبار کاربر |
| POST | `/admin/users/settings` | تنظیمات گروهی |
| POST | `/admin/users/plan` | تغییر پلن گروهی |
| POST | `/admin/users/extend` | تمدید گروهی |
| GET | `/admin/users/blocked` | کاربران مسدود |
| GET | `/admin/users/expiring` | کاربران رو به انقضا |
| GET | `/admin/users/overrides` | overrideهای پلن |
| GET | `/admin/users/sequential` | کاربران sequential |
| POST | `/admin/api-keys/generate` | تولید API key |
| GET | `/admin/api-keys` | فهرست API keyها |
| DELETE | `/admin/api-keys/:key` | حذف API key |
| POST | `/admin/reset-quota/:userId` | ریست سهمیه |
| POST | `/admin/cleanup` | پاک‌سازی فایل‌های موقت |
| POST | `/admin/reload-lua` | بارگذاری مجدد اسکریپت‌های Lua |
| POST | `/admin/restart-global-browser` | ری‌استارت مرورگر مشترک |
| POST | `/admin/system/restart` | ری‌استارت سیستم |

---

## کدهای وضعیت

| کد | معنی |
|----|------|
| `200` | موفق |
| `400` | ورودی نامعتبر |
| `401/403` | احراز هویت ناموفق |
| `404` | مسیر/منبع یافت نشد |
| `429` | محدودیت نرخ یا سهمیه |
| `500` | خطای سرور |

> 📌 مستندات OpenAPI/Swagger و رویدادهای webhook خروجی در استپ‌های ۱۴ و ۱۶ تکمیل می‌شوند.
