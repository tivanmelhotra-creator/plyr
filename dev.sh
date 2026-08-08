#!/bin/bash
# dev.sh — راه‌اندازی سریع automation-backend در Codespace
# استفاده: bash dev.sh

set -e

echo "🚀 automation-backend v37.1.0 - Codespace setup"
echo ""

# ۱. dependencies
echo "=== ۱. نصب dependencies ==="
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "node_modules موجود — رد میشم"
fi

# ۲. env
echo ""
echo "=== ۲. تنظیم .env ==="
if [ ! -f ".env" ]; then
    cp .env.example .env
    sed -i 's/^CHROME_EXE=$/CHROME_EXE=/' .env
    echo "✅ .env ساخته شد"
else
    echo ".env موجود — رد میشم"
fi

# ۳. Redis
echo ""
echo "=== ۳. Redis ==="
if ! pgrep -x redis-server > /dev/null; then
    redis-server --daemonize yes --port 6379
    sleep 1
    echo "✅ Redis شروع شد"
else
    echo "Redis در حال اجراست"
fi

# ۴. Build
echo ""
echo "=== ۴. TypeScript build ==="
npm run build

# ۵. اجرا
echo ""
echo "=== ۵. اجرای سرور ==="
echo "سرور در حال راه‌اندازی روی http://localhost:3000"
echo "در Codespaces: پنل Ports رو باز کن، پورت 3000 رو Public کن"
echo ""

# اگه playwright browsers نصب نیست
if [ ! -d "$HOME/.cache/ms-playwright" ]; then
    echo "نصب Chromium..."
    npx playwright install chromium
fi

# Token رو نشون بده
TOKEN=$(grep "^API_TOKEN=" .env 2>/dev/null | cut -d'=' -f2)
if [ -z "$TOKEN" ] || [ "$TOKEN" = "" ]; then
    echo ""
    echo "⚠️ API_TOKEN در .env تنظیم نشده — یکی random ساخته میشه"
fi

# اجرا در foreground
exec node dist/index.js