#!/usr/bin/env python3
"""
Translate the editor-shell chrome in the `fa` dictionary of public/js/i18n.js.

WHY: the fa/RTL render pass (handoff 11 § 3.2 G10) surfaced 39 `fa` entries whose
value was still the ENGLISH string. They are not "missing keys" — the both-dicts
test passes — so nothing but a render could see them: Persian is the product's
other real locale and the whole ACTIVITY LOG, the OUTLINE panel, the palette
footer and the Save/Export menus were rendering in English inside an RTL frame.

Only VALUES change, and only inside the `fa` slice. `pl.shortcut` is deliberately
left as `K`: it is a key cap, not a word.

ZWNJ (U+200C, نیم‌فاصله) is invisible in a diff, so it is written here as `~` and
substituted on the way out. public/** stays LF-only (io.open(newline='')).

Idempotent by construction: a key whose fa value is no longer the expected
English source string is reported and skipped, never double-translated.

  python3 tools/patch-fa-shell-i18n.py
"""
import io
import re
import sys

PATH = 'public/js/i18n.js'
ZWNJ = '\u200c'

# key: (expected current English value, Persian replacement)
TR = {
    # ---- ACTIVITY LOG dock -------------------------------------------------
    'al.title': ('ACTIVITY LOG', 'گزارش فعالیت'),
    'al.runs': ('Runs', 'اجراها'),
    'al.execution': ('Execution', 'اجرا'),
    'al.variables': ('Variables', 'متغیرها'),
    'al.logs': ('Logs', 'لاگ~ها'),
    'al.allRuns': ('All Runs', 'همهٔ اجراها'),
    'al.clear': ('Clear', 'پاک کردن'),
    'al.autoScroll': ('Auto-scroll', 'پیمایش خودکار'),
    'al.colRunId': ('Run ID', 'شناسهٔ اجرا'),
    'al.colWorkflow': ('Workflow', 'ورکفلو'),
    'al.colStatus': ('Status', 'وضعیت'),
    'al.colDuration': ('Duration', 'مدت'),
    'al.colFinishedAt': ('Finished At', 'زمان پایان'),
    'al.colTrigger': ('Trigger', 'تریگر'),
    # ---- OUTLINE + blocks palette -----------------------------------------
    'ol.title': ('OUTLINE', 'طرح~کلی'),
    'pl.blocks': ('BLOCKS', 'بلوک~ها'),
    'pl.favorites': ('Favorites', 'برگزیده~ها'),
    'pl.templates': ('Templates', 'قالب~ها'),
    'pl.variables': ('Variables', 'متغیرها'),
    'pl.connections': ('Connections', 'اتصال~ها'),
    'pl.settings': ('Settings', 'تنظیمات'),
    'pl.help': ('Help & Docs', 'راهنما و مستندات'),
    'pl.collapse': ('Collapse', 'جمع کردن'),
    # The ellipsis is U+2026, which is why an ASCII-only sweep missed this one.
    'pl.search': ('Search blocks\u2026', 'جست~وجوی بلوک~ها\u2026'),
    # ---- top-bar Save / Export menus + run-info strip ----------------------
    'sh.exportJson': ('Export JSON', 'برون~سپاری JSON'),
    'sh.exportTemplate': ('Export Template', 'برون~سپاری قالب'),
    'sh.exportPdf': ('Export PDF Documentation', 'برون~سپاری مستندات PDF'),
    'sh.publishTemplate': ('Publish Template', 'انتشار قالب'),
    'sh.shareLink': ('Generate Share Link', 'ساخت لینک اشتراک'),
    'sh.saveChanges': ('Save Changes', 'ذخیرهٔ تغییرات'),
    'sh.saveAsVersion': ('Save As New Version', 'ذخیره به~عنوان نسخهٔ جدید'),
    'sh.versionHistory': ('Version History:', 'تاریخچهٔ نسخه~ها:'),
    'sh.versionCurrent': ('Current', 'فعلی'),
    'sh.autoSave': ('Auto Save:', 'ذخیرهٔ خودکار:'),
    'sh.on': ('ON', 'روشن'),
    'sh.off': ('OFF', 'خاموش'),
    'sh.lastRun': ('Last Run:', 'آخرین اجرا:'),
    'sh.duration': ('Duration:', 'مدت:'),
    'sh.variables': ('Variables:', 'متغیرها:'),
}


def main():
    with io.open(PATH, 'r', encoding='utf-8', newline='') as fh:
        text = fh.read()
    if '\r' in text:
        sys.exit('CR found in %s — public/** must be LF only.' % PATH)

    fa_at = text.index('fa: {')
    en_at = text.index('en: {')
    if not fa_at < en_at:
        sys.exit('unexpected dictionary order (fa must come first)')
    fa, tail = text[fa_at:en_at], text[en_at:]

    done, skipped = 0, []
    for key, (old, new) in TR.items():
        pat = re.compile(r"('%s':\s*)'%s'" % (re.escape(key), re.escape(old)))
        fa, n = pat.subn(lambda m: m.group(1) + "'" + new.replace('~', ZWNJ) + "'", fa, count=1)
        if n:
            done += 1
        else:
            skipped.append(key)

    text = text[:fa_at] + fa + tail
    with io.open(PATH, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)

    print('translated %d fa values' % done)
    if skipped:
        print('skipped (value already changed or key absent): %s' % ', '.join(sorted(skipped)))


if __name__ == '__main__':
    main()
