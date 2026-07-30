#!/usr/bin/env python3
"""One-shot patcher: give every node display-name key a home in BOTH dictionaries.

`t()` falls back fa -> en -> key, so an en-only `nk.*` key silently rendered
English node names inside the Persian (default) locale, and a key missing from
both rendered its own raw name on the canvas. flow-editor.js `NODE_DISPLAY_NAMES`
now maps all 50 catalog actions, so both dictionaries have to carry the set.

Line endings: public/** is LF (0 CR). io.open(newline='') keeps whatever the file
already uses instead of rewriting it.

Persian compound words need ZWNJ (U+200C, نیم‌فاصله): "کوکیها" is a misspelling
of "کوکی\u200cها". ZWNJ is invisible in a source diff, so it is written here as
the placeholder `~` and substituted on the way out -- a reviewer can SEE it.
"""
import io
import sys

PATH = 'public/js/i18n.js'
ZWNJ = u'\u200c'

FA_ANCHOR = "      'admin.disconnect': 'قطع اتصال',\n"
EN_ANCHOR = "      'nk.loopCondition': 'Loop condition',\n"

FA = [
    ('nk.openUrl', 'باز کردن نشانی'),
    ('nk.wait', 'انتظار'),
    ('nk.launchBrowser', 'اجرای مرورگر'),
    ('nk.waitElement', 'انتظار برای عنصر'),
    ('nk.delay', 'تأخیر'),
    ('nk.switchFrame', 'تغییر فریم'),
    ('nk.switchTab', 'تغییر تب'),
    ('nk.closeTab', 'بستن تب'),
    ('nk.closeBrowser', 'بستن مرورگر'),
    ('nk.handleDialog', 'مدیریت پنجره پیام'),
    ('nk.clickElement', 'کلیک روی عنصر'),
    ('nk.click', 'کلیک'),
    ('nk.doubleClick', 'دوبار کلیک'),
    ('nk.hover', 'قرار دادن نشانگر'),
    ('nk.focusElement', 'فوکوس روی عنصر'),
    ('nk.moveMouse', 'حرکت ماوس'),
    ('nk.dragDrop', 'کشیدن و رها کردن'),
    ('nk.scrollPage', 'پیمایش صفحه'),
    ('nk.typeText', 'نوشتن متن'),
    ('nk.typeKeystrokes', 'تایپ کلید~به~کلید'),
    ('nk.pressKey', 'فشردن کلید'),
    ('nk.selectOption', 'انتخاب گزینه'),
    ('nk.checkBox', 'تیک زدن'),
    ('nk.uncheckBox', 'برداشتن تیک'),
    ('nk.uploadFile', 'بارگذاری فایل'),
    ('nk.removeElement', 'حذف عنصر'),
    ('nk.injectCss', 'تزریق CSS'),
    ('nk.extractText', 'استخراج متن'),
    ('nk.extractData', 'استخراج داده'),
    ('nk.parseJson', 'تجزیه JSON'),
    ('nk.exportData', 'خروجی گرفتن داده'),
    ('nk.screenshot', 'عکس صفحه'),
    ('nk.downloadFile', 'دانلود فایل'),
    ('nk.readAttribute', 'خواندن ویژگی'),
    ('nk.setVariable', 'تنظیم متغیر'),
    ('nk.cookies', 'کوکی~ها'),
    ('nk.clipboard', 'کلیپ~بورد'),
    ('nk.notification', 'اعلان'),
    ('nk.logMessage', 'ثبت پیام'),
    ('nk.httpRequest', 'درخواست HTTP'),
    ('nk.condition', 'شرط'),
    ('nk.switchCase', 'انتخاب چندحالته'),
    ('nk.loop', 'حلقه'),
    ('nk.forEach', 'به~ازای هر مورد'),
    ('nk.whileLoop', 'حلقه شرطی'),
    ('nk.tryCatch', 'تلاش / خطا'),
    ('nk.stopAndError', 'توقف با خطا'),
    ('nk.manualTrigger', 'شروع دستی'),
    ('nk.webhookTrigger', 'شروع با وب~هوک'),
    ('nk.scheduleTrigger', 'شروع زمان~بندی~شده'),
    ('nk.telegramTrigger', 'شروع با تلگرام'),
    ('nk.loopCondition', 'شرط حلقه'),
]

EN = [
    ('nk.wait', 'Wait'),
    ('nk.switchFrame', 'Switch Frame'),
    ('nk.switchTab', 'Switch Tab'),
    ('nk.closeTab', 'Close Tab'),
    ('nk.handleDialog', 'Handle Dialog'),
    ('nk.doubleClick', 'Double Click'),
    ('nk.hover', 'Hover'),
    ('nk.focusElement', 'Focus Element'),
    ('nk.moveMouse', 'Move Mouse'),
    ('nk.dragDrop', 'Drag & Drop'),
    ('nk.scrollPage', 'Scroll Page'),
    ('nk.typeText', 'Type Text'),
    ('nk.typeKeystrokes', 'Type Keystrokes'),
    ('nk.pressKey', 'Press Key'),
    ('nk.selectOption', 'Select Option'),
    ('nk.checkBox', 'Check Box'),
    ('nk.uncheckBox', 'Uncheck Box'),
    ('nk.uploadFile', 'Upload File'),
    ('nk.removeElement', 'Remove Element'),
    ('nk.injectCss', 'Inject CSS'),
    ('nk.extractText', 'Extract Text'),
    ('nk.exportData', 'Export Data'),
    ('nk.screenshot', 'Screenshot'),
    ('nk.downloadFile', 'Download File'),
    ('nk.readAttribute', 'Read Attribute'),
    ('nk.setVariable', 'Set Variable'),
    ('nk.cookies', 'Cookies'),
    ('nk.clipboard', 'Clipboard'),
    ('nk.notification', 'Notification'),
    ('nk.logMessage', 'Log Message'),
    ('nk.switchCase', 'Switch'),
    ('nk.loop', 'Loop'),
    ('nk.forEach', 'For Each'),
    ('nk.tryCatch', 'Try / Catch'),
    ('nk.stopAndError', 'Stop and Error'),
    ('nk.telegramTrigger', 'Telegram Trigger'),
]

HEAD = ('\n      // -- Node display names -- every catalog action, both dictionaries.\n'
        '      // An unmapped action falls back to its raw id, so the canvas read\n'
        '      // "fill" / "wait" / "extract" instead of product language.\n')


def block(pairs):
    return HEAD + ''.join(
        "      '%s': '%s',\n" % (k, v.replace('~', ZWNJ)) for k, v in pairs)


def main():
    with io.open(PATH, 'r', encoding='utf-8', newline='') as fh:
        src = fh.read()

    for name, anchor in (('fa', FA_ANCHOR), ('en', EN_ANCHOR)):
        n = src.count(anchor)
        if n != 1:
            sys.exit('%s anchor found %d times, expected 1' % (name, n))

    src = src.replace(FA_ANCHOR, FA_ANCHOR + block(FA))
    src = src.replace(EN_ANCHOR, EN_ANCHOR + block(EN))

    for key, _ in FA:
        if src.count("'%s':" % key) != 2:
            sys.exit('%s does not appear exactly twice (fa + en)' % key)

    with io.open(PATH, 'w', encoding='utf-8', newline='') as fh:
        fh.write(src)
    print('patched %s: +%d fa, +%d en' % (PATH, len(FA), len(EN)))


if __name__ == '__main__':
    main()
