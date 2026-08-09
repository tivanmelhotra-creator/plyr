#!/bin/bash
# dev.sh — راه‌اندازی سریع automation-backend در Codespaces / Linux

set -e

echo "🚀 automation-backend v37.1.0 - Codespace setup"
echo ""

# ۰. نصب Redis در صورت عدم وجود
if ! command -v redis-server &> /dev/null; then
    echo "=== ۰. نصب redis-server ==="
    if command -v sudo &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y redis-server
    else
        apt-get update && apt-get install -y redis-server
    fi
fi

# ۰.۵. نصب کتابخانه‌های سیستمی مرورگر (Playwright dependencies)
echo "=== ۰.۵. نصب وابسته های سیستم مرورگر ==="
if command -v sudo &> /dev/null; then
    sudo npx playwright install-deps || true
else
    npx playwright install-deps || true
fi

# ۰.۶. نصب Chromium اگه نبود (مشکلی که داشتی)
if [ ! -d "$HOME/.cache/ms-playwright/chromium-1194" ]; then
    echo "=== ۰.۶. نصب Chromium browser برای Playwright ==="
    if [ ! -d "node_modules" ]; then
        npm install
    fi
    npx playwright install chromium
fi

# ۱. dependencies
echo "=== ۱. نصب dependencies ==="
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "node_modules موجود — رد میشم"
fi

# ۲. env
echo ""
echo "=== ۲. تنظیم کامل .env ==="
if [ ! -f ".env" ]; then
    cp .env.example .env
    sed -i 's/^API_KEY=/API_KEY=admin123/' .env
    echo "API_KEY=admin123" >> .env
    echo "✅ .env ساخته شد"
else
    echo ".env موجود — رد میشم"
fi

# ۳. Redis
echo ""
echo "=== ۳. اجرای Redis ==="
if ! pgrep -x redis-server > /dev/null; then
    if command -v sudo &> /dev/null; then
        sudo service redis-server start || redis-server --daemonize yes --port 6379
    else
        redis-server --daemonize yes --port 6379
    fi
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
echo "🔑 کلید لاگین شما: admin123"
echo "سرور در حال راه‌اندازی روی http://localhost:3000 است."
echo "در Codespaces: از تب Ports در پایین، پورت 3000 رو به Public تغییر بده."
echo ""

exec node dist/index.js
