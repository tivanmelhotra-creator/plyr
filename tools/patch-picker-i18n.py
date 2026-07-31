#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
One-shot, idempotent i18n patcher for the Element Picker (HANDOFF 15, Phase B).

Adds the `bvp.*` block (the picker modal) after the `bv.expired` anchor in BOTH
dictionaries, and relabels the Condition row's selector field from
"CSS Selector" to "CSS selector or XPath" — the field already accepts both,
because ConditionEngine hands the string straight to page.locator() and
Playwright sniffs a leading `//` as XPath. See rule 0.6 (fa/en parity, ZWNJ)
and rule 0.9 (label must not understate what the backend consumes).

Run:  python3 tools/patch-picker-i18n.py
"""
import io
import sys

PATH = 'public/js/i18n.js'

FA = [
    ("bvp.title", "انتخاب المان"),
    ("bvp.cancel", "بستن بدون انتخاب"),
    ("bvp.seeThrough", "نیمه‌شفاف کردن پنل"),
    ("bvp.mode", "نوع سلکتور"),
    ("bvp.modeCss", "سلکتور CSS"),
    ("bvp.modeXpath", "XPath"),
    ("bvp.parent", "انتخاب المان والد (یک پله بالاتر)"),
    ("bvp.child", "انتخاب اولین فرزند (یک پله پایین‌تر)"),
    ("bvp.selPlaceholder", "روی صفحه کلیک کنید یا سلکتور را دستی بنویسید"),
    ("bvp.verify", "بررسی کن چند المان با این سلکتور مطابقت دارد"),
    ("bvp.copy", "کپی سلکتور"),
    ("bvp.attributes", "ویژگی‌ها"),
    ("bvp.noAttrs", "هنوز المانی انتخاب نشده."),
    ("bvp.use", "استفاده از این سلکتور"),
    ("bvp.hint", "با موس روی صفحه حرکت کنید تا پیش‌نمایش ببینید؛ با کلیک یا کلید Space المان قطعی می‌شود."),
    ("bvp.needUrl", "آدرس صفحه‌ای را که می‌خواهید از آن سلکتور بگیرید وارد کنید."),
    ("bvp.matchOne", "دقیقاً ۱ المان — سلکتور یکتاست."),
    ("bvp.matchMany", "المان مطابقت دارد — سلکتور یکتا نیست."),
    ("bvp.matchNone", "هیچ المانی مطابقت ندارد."),
    ("bvp.matchBad", "سلکتور نامعتبر است."),
]

EN = [
    ("bvp.title", "Pick element"),
    ("bvp.cancel", "Close without picking"),
    ("bvp.seeThrough", "Make the panel see-through"),
    ("bvp.mode", "Selector type"),
    ("bvp.modeCss", "CSS Selector"),
    ("bvp.modeXpath", "XPath"),
    ("bvp.parent", "Select the parent element (one step up)"),
    ("bvp.child", "Select the first child (one step down)"),
    ("bvp.selPlaceholder", "Click on the page, or type a selector"),
    ("bvp.verify", "Check how many elements this selector matches"),
    ("bvp.copy", "Copy selector"),
    ("bvp.attributes", "Attributes"),
    ("bvp.noAttrs", "No element picked yet."),
    ("bvp.use", "Use this selector"),
    ("bvp.hint", "Move the pointer over the page to preview; click or press Space to lock the element in."),
    ("bvp.needUrl", "Enter the URL of the page you want to pick a selector from."),
    ("bvp.matchOne", "Exactly 1 element — the selector is unique."),
    ("bvp.matchMany", "elements match — the selector is not unique."),
    ("bvp.matchNone", "No element matches."),
    ("bvp.matchBad", "Invalid selector."),
]

RELABEL = [
    # (old line fragment, new line fragment)
    ("      'cb.cssSelector': 'سلکتور CSS',",
     "      'cb.cssSelector': 'سلکتور CSS یا XPath',"),
    ("      'cb.cssSelector': 'CSS Selector',",
     "      'cb.cssSelector': 'CSS selector or XPath',"),
    ("      'cb.cssSelectorHelp': 'المانی که شرط روی آن سنجیده می‌شود. با دکمهٔ هدف می‌توانید آن را از صفحهٔ مرورگر زنده انتخاب کنید.',",
     "      'cb.cssSelectorHelp': 'المانی که شرط روی آن سنجیده می‌شود. همین یک فیلد هم سلکتور CSS و هم XPath (شروع با //) را می‌پذیرد. با دکمهٔ هدف می‌توانید المان را از صفحهٔ مرورگر زنده انتخاب کنید.',"),
    ("      'cb.cssSelectorHelp': 'Element this condition is tested against. Use the target button to pick it from the live browser page.',",
     "      'cb.cssSelectorHelp': 'Element this condition is tested against. This one field takes a CSS selector or an XPath (starting with //). Use the target button to pick it from the live browser page.',"),
]


def block(pairs):
    return ''.join("      '%s': '%s',\n" % (k, v.replace("'", "\\'")) for k, v in pairs)


def main():
    with io.open(PATH, 'r', encoding='utf-8', newline='') as fh:
        src = fh.read()

    if "'bvp.title'" in src:
        print('i18n: bvp.* already present — nothing to insert.')
    else:
        for anchor, pairs in (
            ("      'bv.expired': 'نشست مرورگر به‌دلیل بی‌کاری بسته شد.',\n", FA),
            ("      'bv.expired': 'Browser session closed due to inactivity.',\n", EN),
        ):
            if anchor not in src:
                print('MISSING ANCHOR: %r' % anchor[:40])
                return 1
            src = src.replace(anchor, anchor + block(pairs), 1)

    for old, new in RELABEL:
        if new in src:
            continue
        if old not in src:
            print('MISSING RELABEL SOURCE: %r' % old[:50])
            return 1
        src = src.replace(old, new, 1)

    with io.open(PATH, 'w', encoding='utf-8', newline='') as fh:
        fh.write(src)
    print('i18n patched.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
