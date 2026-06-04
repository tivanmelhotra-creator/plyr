# استقرار روی Coolify با روش «Docker Image»

این راهنما مخصوص کسانی است که می‌خواهند با نوع منبع **Docker Image** در Coolify کار
کنند (به‌جای Dockerfile یا Docker Compose). در این روش، image از قبل ساخته و روی
رجیستری منتشر می‌شود و Coolify فقط آن را می‌کشد و اجرا می‌کند — **هیچ build روی سرور
انجام نمی‌شود.**

---

## 🧩 چرا اول باید image ساخته شود؟

نوع **Docker Image** انتظار یک image **آمادهٔ از قبل ساخته‌شده** را دارد، نه آدرس سورس
گیت‌هاب. اگر آدرس ریپو (`github.com/...`) را به‌عنوان image بدهید، Coolify نمی‌تواند
آن را پیدا کند و وضعیت **Exited** می‌شود.

این پروژه یک **GitHub Actions** دارد (`.github/workflows/docker-publish.yml`) که با هر
push روی `main`، image را از روی `Dockerfile` می‌سازد و روی **GitHub Container
Registry (ghcr.io)** منتشر می‌کند:

```
ghcr.io/saeedkhoshafsar/plyr:latest
```

> 📌 **اگر فایل workflow هنوز در ریپو نیست:** به‌دلیل محدودیت توکن، فایل
> `.github/workflows/docker-publish.yml` ممکن است باید دستی اضافه شود. ساده‌ترین راه:
> در گیت‌هاب → تب **Actions** → **New workflow** → **set up a workflow yourself** →
> محتوای فایل را از همین ریپو (مسیر `.github/workflows/docker-publish.yml`) کپی کنید →
> **Commit**. (یا اگر گیت لوکال دارید با scope `workflow`، همان فایل را push کنید.)
> پس از اولین اجرا، طبق «مرحله ۰» package را Public کنید.

---

## مرحله ۰ — یک‌بار: image را بساز و عمومی کن

1. کد را به `main` push کنید (همین حالا که این فایل را دارید یعنی انجام شده). برگهٔ
   **Actions** در گیت‌هاب را باز کنید و منتظر بمانید workflow «Build & Publish Docker
   image» سبز (✓) شود.
2. image را **عمومی (Public)** کنید تا Coolify بدون لاگین بتواند بکشد:
   - GitHub → پروفایلتان → تب **Packages** → بستهٔ **plyr** را باز کنید
   - **Package settings** → **Change visibility** → **Public**

> اگر ترجیح می‌دهید بسته خصوصی بماند، باید در Coolify یک **Docker Registry credential**
> برای `ghcr.io` با یک GitHub Personal Access Token (با scope `read:packages`) اضافه
> کنید. عمومی‌کردن ساده‌تر است.

> 🧩 **معماری CPU (مهم):** workflow این پروژه image را برای **هر دو** معماری
> `linux/amd64` (x86) و `linux/arm64` (ARM) می‌سازد (با `platforms` در buildx +
> QEMU). اگر سرور Coolify شما ARM باشد (مثل Ampere/Graviton/برخی VPSها) و image فقط
> amd64 باشد، هنگام deploy این خطا را می‌بینید:
> `no matching manifest for linux/arm64/v8 ... no match for platform`.
> راه‌حل همان است: مطمئن شوید نسخهٔ به‌روزِ workflow (با خط
> `platforms: linux/amd64,linux/arm64`) اجرا شده و image جدید منتشر شده، سپس در
> Coolify **Redeploy** بزنید.

---

## مرحله ۱ — پاک‌کردن منبع اشتباه قبلی (اگر ساختید)

اگر قبلاً یک منبع `docker-image-...` با آدرس گیت‌هاب ساختید که Exited شده:

- وارد آن منبع شوید → منوی چپ → **Danger Zone** → **Delete**.

---

## مرحله ۲ — ساخت یک Redis جدا

⚠️ مهم: روش **Docker Image** فقط همان یک container برنامه را اجرا می‌کند و **Redis
ندارد**. برنامه برای صف کارها به Redis نیاز دارد، پس یک Redis جداگانه بسازید:

1. داخل پروژه → **+ New** → **Database** → **Redis**.
2. بسازید و **Start** بزنید.
3. آدرس داخلی‌اش را یادداشت کنید (Coolify در صفحهٔ همان Redis یک
   **Internal URL / Connection String** نشان می‌دهد، چیزی شبیه:
   `redis://<redis-service-name>:6379`).

> برنامه و Redis باید در **یک پروژه/شبکهٔ Coolify** باشند تا با نام سرویس به هم
> برسند.

---

## مرحله ۳ — ساخت منبع برنامه با نوع Docker Image

1. داخل پروژه → **+ New** → **Docker Image**.
2. **Image:** آدرس image منتشرشده را وارد کنید:
   ```
   ghcr.io/saeedkhoshafsar/plyr:latest
   ```
   (در فیلد «Docker Image» این را بگذارید و Tag را `latest`.)
3. بسازید.

---

## مرحله ۴ — تنظیمات شبکه (Network)

| فیلد | مقدار درست |
|------|-----------|
| **Ports Exposes** | `3000` ← حتماً از `80` به `3000` تغییر دهید ❗ |
| **Port Mappings** | خالی بگذارید (Coolify با دامنه/پروکسی هندل می‌کند) |

برنامه داخل container روی پورت **۳۰۰۰** گوش می‌دهد. اگر `Ports Exposes` روی `80` بماند،
پروکسی Coolify به پورت اشتباه وصل می‌شود و سایت بالا نمی‌آید. وقتی آن را `3000` کنید،
لیبل‌های traefik/caddy هم خودکار به `3000` به‌روز می‌شوند.

---

## مرحله ۵ — متغیرهای محیطی (Environment Variables)

از منوی چپ → **Environment Variables** این‌ها را اضافه کنید:

```
DEPLOYMENT_MODE=single
NODE_ENV=production
PORT=3000
REDIS_URL=redis://<redis-service-name>:6379
API_TOKEN=
```

- **`REDIS_URL`**: همان آدرس داخلی Redis از مرحلهٔ ۲ را بگذارید. **این مهم‌ترین متغیر
  است**؛ بدون آن برنامه به Redis وصل نمی‌شود.
- **`API_TOKEN`**: یا خالی بگذارید (برنامه موقع بوت یک توکن تصادفی می‌سازد و در
  **Logs** چاپ می‌کند)، یا یک توکن دلخواه مثل `tok_xxxxxxxx` بگذارید.
- `DEPLOYMENT_MODE=single` یعنی حالت تک‌کاربرهٔ Self-Hosted (بدون پلن/سهمیه/ادمین).

---

## مرحله ۶ — دامنه و HTTPS

- برای تست، همان دامنهٔ خودکار `*.sslip.io` که Coolify می‌دهد کافی است.
- برای دامنهٔ واقعی:
  1. در صفحهٔ **General** فیلد **Domains** را روی دامنه‌تان بگذارید، مثلاً
     `https://panel.example.com`.
  2. در **Cloudflare** یک رکورد **A** بسازید: `panel.example.com → IP سرور`.
  3. **تیک نارنجی پروکسی را خاموش کنید** (حالت **DNS only** / ابر خاکستری) تا Coolify
     بتواند گواهی Let's Encrypt بگیرد.

---

## مرحله ۷ — Deploy

دکمهٔ **Deploy** را بزنید. بعد از بالا آمدن:

- پنل را باز کنید: `https://<your-domain>/`
- در صفحهٔ Login همان `API_TOKEN` را وارد کنید.
- اگر `API_TOKEN` را خالی گذاشتید، از تب **Logs** خط مربوط به توکن خودکار را پیدا کنید
  (با جستجوی `API_TOKEN`).

سلامت سرویس: `https://<your-domain>/health`

---

## 🔄 به‌روزرسانی نسخه

هر بار کد را به `main` push کنید، GitHub Actions image جدید با تگ `latest` می‌سازد.
سپس در Coolify فقط **Redeploy** بزنید تا نسخهٔ جدید کشیده شود. (برای آپدیت خودکار،
می‌توانید در Coolify گزینهٔ Webhook/Automatic deploy را هم فعال کنید.)

---

## ❓ مقایسهٔ کوتاه روش‌ها روی Coolify

| روش | build کجا؟ | Redis | پیچیدگی |
|-----|-----------|-------|---------|
| **Docker Image** (این راهنما) | در GitHub Actions (ghcr.io) | باید جدا بسازید | متوسط — یک‌بار Actions + Redis جدا |
| **Docker Compose** (`docker-compose.coolify.yml`) | روی سرور Coolify | خودکار همراه می‌آید | ساده‌ترین — همه‌چیز در یک فایل |
| **Dockerfile** | روی سرور Coolify | باید جدا بسازید | مشابه Docker Image ولی build روی سرور |

> اگر روزی خواستید ساده‌تر شود و Redis هم خودکار بیاید، کافی است منبع را با
> **Docker Compose** و فایل `docker-compose.coolify.yml` بسازید؛ آن‌وقت دیگر نه به
> Redis جدا نیاز دارید نه به `REDIS_URL`.
