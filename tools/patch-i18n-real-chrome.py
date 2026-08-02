#!/usr/bin/env python3
"""
Add the Real Chrome panel strings to public/js/i18n.js (fa + en).

The dictionary is one big object literal with two language blocks; inserting by
hand into both is exactly the kind of edit that silently lands in one language
only. This patcher inserts after a unique per-language anchor and is idempotent.
"""
from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path(__file__).resolve().parents[1] / "public" / "js" / "i18n.js"

FA_ANCHOR = "      'bvp.forget': 'پاک کردن نشست این مرورگر (کوکی‌ها و خروج از حساب)',\n"
EN_ANCHOR = "      'bvp.forget': 'Forget this browser session (clear cookies and sign out)',\n"

FA_BLOCK = """      // ── Real Chrome panel ────────────────────────────────────────────
      'rc.title': 'کروم واقعی (افزونه‌ها و کوکی‌ها)',
      'rc.browser': 'مرورگر',
      'rc.running': 'در حال اجرا',
      'rc.stopped': 'متوقف',
      'rc.disabled': 'غیرفعال',
      'rc.disabledHint': 'کروم واقعی خاموش است. در فایل .env مقدار REAL_CHROME_ENABLED=true را بگذارید و سرور را دوباره اجرا کنید. بدون آن هیچ افزونه‌ای بارگذاری نمی‌شود.',
      'rc.start': 'اجرا',
      'rc.stop': 'توقف',
      'rc.restart': 'اجرای دوباره',
      'rc.starting': 'در حال اجرا…',
      'rc.devtools': 'پورت DevTools',
      'rc.devtoolsHint': 'می‌توانید هر کلاینت CDP را وصل کنید، یا در کروم خودتان chrome://inspect را باز کنید.',
      'rc.cookies': 'کوکی‌ها',
      'rc.cookiesHint': 'فایلی را که افزونهٔ کوکی شما خروجی گرفته وارد کنید. در پروفایل ذخیره می‌شود، پس هم این پنجره و هم اجراهای خودکار دیگر نیازی به لاگین ندارند.',
      'rc.import': 'ورود فایل کوکی',
      'rc.importing': 'در حال ورود…',
      'rc.imported': 'کوکی‌ها وارد شدند.',
      'rc.rejected': 'کوکی توسط کروم رد شد.',
      'rc.readFail': 'خواندن فایل ممکن نشد.',
      'rc.export': 'خروجی',
      'rc.extensions': 'افزونه‌ها',
      'rc.noExtensions': 'هیچ افزونه‌ای بارگذاری نشده. یک فایل ‎.crx یا ‎.zip بفرستید و بعد مرورگر را دوباره اجرا کنید — کروم افزونه‌ها را فقط هنگام شروع می‌خواند.',
      'rc.open': 'باز کردن اینجا',
      'rc.openHint': 'صفحهٔ پاپ‌آپ خود افزونه را در همین بوم باز می‌کند، با تمام دسترسی‌های افزونه.',
      'rc.remove': 'حذف',
      'rc.restartRequired': 'افزونه بعد از شروع مرورگر نصب شده است. برای بارگذاری، مرورگر را دوباره اجرا کنید.',
      'rc.upload': 'بارگذاری ‎.crx / ‎.zip',
      'rc.uploading': 'در حال بارگذاری…',
      'rc.installed': 'نصب شد.',
      'rc.desktop': 'دسکتاپ از راه دور',
      'rc.desktopHint': 'کل پنجرهٔ کروم روی noVNC — تنها راه کلیک روی دکمهٔ افزونه در نوار ابزار یا پنجرهٔ انتخاب فایل سیستم‌عامل.',
      'rc.startDesktop': 'اجرای دسکتاپ',
      'rc.openDesktop': 'باز کردن دسکتاپ',
      'rc.noVncPassword': 'این صفحه رمز ندارد و همهٔ کوکی‌های شما روی آن است — پورت را عمومی نکنید؛ با SSH تونل بزنید.',
      'rc.loading': 'در حال بارگذاری…',
"""

EN_BLOCK = """      // ── Real Chrome panel ────────────────────────────────────────────
      'rc.title': 'Real Chrome (extensions & cookies)',
      'rc.browser': 'Browser',
      'rc.running': 'running',
      'rc.stopped': 'stopped',
      'rc.disabled': 'disabled',
      'rc.disabledHint': 'Real Chrome is off. Set REAL_CHROME_ENABLED=true in .env and restart the server. Without it, extensions cannot be loaded at all.',
      'rc.start': 'Start',
      'rc.stop': 'Stop',
      'rc.restart': 'Restart',
      'rc.starting': 'starting…',
      'rc.devtools': 'DevTools port',
      'rc.devtoolsHint': 'attach any CDP client, or open chrome://inspect in your own Chrome.',
      'rc.cookies': 'Cookies',
      'rc.cookiesHint': 'Import the file your cookie extension exported. It is stored in the profile, so both this window and queued automation runs skip the login.',
      'rc.import': 'Import cookie file',
      'rc.importing': 'importing…',
      'rc.imported': 'Imported.',
      'rc.rejected': 'cookie(s) were rejected by Chrome.',
      'rc.readFail': 'Could not read the file.',
      'rc.export': 'Export',
      'rc.extensions': 'Extensions',
      'rc.noExtensions': 'No extensions loaded. Upload a .crx or .zip below, then restart the browser — Chrome only reads extensions at launch.',
      'rc.open': 'Open here',
      'rc.openHint': "Opens the extension's own popup page in this canvas, with full extension privileges.",
      'rc.remove': 'Remove',
      'rc.restartRequired': 'An extension was installed after the browser started. Restart to load it.',
      'rc.upload': 'Upload .crx / .zip',
      'rc.uploading': 'uploading…',
      'rc.installed': 'Installed.',
      'rc.desktop': 'Remote desktop',
      'rc.desktopHint': 'The full Chrome window over noVNC — the only way to click the extension toolbar button or a native file dialog.',
      'rc.startDesktop': 'Start desktop',
      'rc.openDesktop': 'Open desktop',
      'rc.noVncPassword': 'This screen has no password. It holds every cookie you import — do not expose the port publicly; tunnel it over SSH instead.',
      'rc.loading': 'Loading…',
"""


def main() -> int:
    raw = TARGET.read_text(encoding="utf8")

    if "'rc.title'" in raw:
        print("[patch-i18n-real-chrome] already applied, nothing to do")
        return 0

    for anchor, block, lang in ((FA_ANCHOR, FA_BLOCK, "fa"), (EN_ANCHOR, EN_BLOCK, "en")):
        if anchor not in raw:
            print(f"[patch-i18n-real-chrome] ERROR: {lang} anchor not found", file=sys.stderr)
            return 1
        raw = raw.replace(anchor, anchor + block, 1)

    TARGET.write_text(raw, encoding="utf8")
    print("[patch-i18n-real-chrome] added rc.* strings to fa + en")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
