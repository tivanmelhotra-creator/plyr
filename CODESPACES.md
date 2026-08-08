# 🚀 Codespaces Quick Start

این پروژه در GitHub Codespaces به راحتی اجرا میشه.

## شروع سریع

۱. در Codespace ترمینال این دستور رو اجرا کن:
```bash
bash dev.sh
```

این اسکریپت همه چیز رو نصب و راه‌اندازی میکنه:
- ✅ npm install
- ✅ ساختن .env از .env.example
- ✅ راه‌اندازی Redis
- ✅ TypeScript build
- ✅ اجرای سرور روی پورت 3000

## دسترسی عمومی

وقتی سرور بالا اومد:
1. پنل **Ports** رو در VSCode باز کن
2. روی پورت **3000** کلیک راست
3. **"Port Visibility" → "Public"** رو بزن
4. آدرس عمومی کپی میشه

## API Token

API Token در `.env` تنظیم شده (یا در اولین اجرا random ساخته میشه).
میتونی از این token برای login در UI استفاده کنی.
