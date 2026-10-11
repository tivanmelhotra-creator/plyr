# 🚀 Codespaces Quick Start

این پروژه در GitHub Codespaces به راحتی اجرا میشه.

## شروع سریع

مسیر canonical چرخه‌عمر Plyr این است:

```bash
./plyr install
./plyr start --dev
```

`dev.sh` همچنان برای سازگاری وجود دارد و همین مسیر canonical را صدا می‌زند:

```bash
bash dev.sh
```

برای بررسی وضعیت و عیب‌یابی از این‌ها استفاده کنید:

```bash
./plyr status
./plyr doctor --deep
```

Runtime Manager به‌صورت صریح بررسی می‌کند که Node/npm، Redis، Playwright/Chromium،
نمایشگر و سرویس viewer آماده باشند؛ در صورت نبود وابستگی، نصب موفق اعلام نمی‌شود.

## دسترسی عمومی

وقتی سرور بالا اومد:
1. پنل **Ports** رو در VSCode باز کن
2. روی پورت **3000** کلیک راست
3. **"Port Visibility" → "Public"** رو بزن
4. آدرس عمومی کپی میشه

## ورود

در حالت توسعه (پیش‌فرض Codespaces) صفحهٔ ورود و توکنی وجود ندارد. اگر `APP_ENV=production` بگذاری،
اولین باری که پنل را باز کنی خودش ازت می‌خواهد رمز انتخاب کنی (حداقل ۱۰ کاراکتر با حرف بزرگ و کوچک انگلیسی و عدد).
