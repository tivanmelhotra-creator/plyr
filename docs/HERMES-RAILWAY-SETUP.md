#!/bin/bash
# Hermes Railway Setup Guide
# ==========================================
# این فایل مراحل کامل راه‌اندازی Hermes روی Railway را مستند می‌کند.
# بعد از هر تغییر، gateway را از Railway UI → Restart کنید.

# === مرحله ۱: تنظیم متغیرهای محیطی در Railway Dashboard ===
# Variables → Add Variable:
#   TELEGRAM_BOT_TOKEN=<token>
#   OPENAI_BASE_URL=https://9router-production-30f8.up.railway.app/v1
#   OPENAI_API_KEY=<api_key>
#   HERMES_TOOL_PROGRESS_MODE=all
#   HERMES_DISPLAY_PLATFORMS_TELEGRAM_LIVE_STATUS=full

# === مرحله ۲: تنظیم config.yaml (پس از اولین deploy) ===
# در Railway Console:
cat >> /data/.hermes/config.yaml << 'EOF'

display:
  platforms:
    telegram:
      tool_progress: all
      live_status: full
EOF

# === مرحله ۳: Restart gateway ===
# از Railway UI → Service → Settings → Restart (نه Redeploy)

# === نکته‌های مهم ===
# 1. اگر cleanup_progress یا tool_progress=verbose در config.yaml است، با sed حذف کنید:
#    sed -i '/cleanup_progress/d' /data/.hermes/config.yaml
#    sed -i 's/tool_progress: verbose/tool_progress: all/' /data/.hermes/config.yaml
#
# 2. متغیرهای HERMES_DISPLAY_PLATFORMS_* از config.yaml خوانده می‌شوند (نه env vars)
# 3. HERMES_TOOL_PROGRESS_MODE از env vars خوانده می‌شود
# 4. Railway Volume باعث می‌شود config.yaml و حافظه بین deployها باقی بمانند
# 5. اگر مشکل پیش آمد، همیشه cat /data/.hermes/config.yaml را چک کنید
# 6. cat /proc/1/environ | tr '\0' '\n' | grep HERMES برای بررسی env vars
# 7. متغیرهای اضافی مثل SHOW_REASONING و TOOL_PREVIEW_LENGTH تأثیری ندارند، نگران نباشید
