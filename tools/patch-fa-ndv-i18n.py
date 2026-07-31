#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/patch-fa-ndv-i18n.py — one-shot i18n patcher (DEV ONLY, HANDOFF 14)

Standing rule 0.6: every key must exist in BOTH `fa` and `en`, and no English
value may sit in `fa`. The NDV work (HANDOFF 09 → 13) shipped 131 keys into the
`en` dictionary only — `ndv.*`, `click.*`, `cb.*`, `cbs.*`, `op.*`, `pill.*`,
plus a handful of `p.*` / `help.*` / `fe.*` — because the design pass was
English-LTR. `t()` falls back to `en`, so nothing was visibly broken, but a
Persian user hit an English NDV. This script pays that debt off in one pass and
adds the seven new `cb.*Help` keys the Condition NDV info dots need.

Why a script and not the Edit tool: `io.open(..., newline='')` guarantees the
file's existing line endings survive (public/** must stay LF with CR count 0),
and an idempotent assert-then-replace is safer than 138 hand edits.

Run once from the repo root, then delete nothing — tools/ is not counted by
tests/unit/icons.test.ts (it pins public/js/*.js only).
"""
import io
import re
import sys

PATH = 'public/js/i18n.js'

# --- 1. the seven NEW keys (info dots on the Condition Builder fields) -------
NEW_EN = [
    ("cb.leftSourceHelp", "Which part of the element the condition reads: its text, an attribute, an input value, its HTML, or a variable / expression."),
    ("cb.attributeNameHelp", "Attribute to read, e.g. textContent, href or data-state. Any attribute name is accepted."),
    ("cb.cssSelectorHelp", "Element this condition is tested against. Use the target button to pick it from the live browser page."),
    ("cb.operatorHelp", "How the left value is compared. Exists / visible operators test the element itself and need no right value."),
    ("cb.rightValueHelp", "Value to compare against. Switch to fx to build it from an expression."),
    ("cb.maxDepthHelp", "Guard against a runaway nested evaluation. 5 covers every condition the builder can express."),
    ("cb.evaluateModeHelp", "First match stops at the first group that passes. All groups evaluates every group before deciding."),
]

# --- 2. Persian for the seven new keys + the 131 English-only ones -----------
# ZWNJ (U+200C) is written as \u200c so the file stays readable in review.
FA = {
    # new
    "cb.leftSourceHelp": "شرط چه بخشی از المان را می\u200cخواند: متن، یک ویژگی (attribute)، مقدار ورودی، HTML، یا یک متغیر/عبارت.",
    "cb.attributeNameHelp": "نام ویژگی‌ای که خوانده می\u200cشود، مثل textContent یا href یا data-state. هر نامی پذیرفته می\u200cشود.",
    "cb.cssSelectorHelp": "المانی که شرط روی آن سنجیده می\u200cشود. با دکمهٔ هدف می\u200cتوانید آن را از صفحهٔ مرورگر زنده انتخاب کنید.",
    "cb.operatorHelp": "نحوهٔ مقایسهٔ مقدار سمت چپ. عملگرهای «وجود دارد»/«دیده می\u200cشود» خود المان را می\u200cسنجند و به مقدار سمت راست نیاز ندارند.",
    "cb.rightValueHelp": "مقداری که مقایسه با آن انجام می\u200cشود. برای ساختنش از عبارت، به fx سوئیچ کنید.",
    "cb.maxDepthHelp": "محافظ برابر ارزیابی تودرتوی بی\u200cپایان. عدد ۵ همهٔ شرط\u200cهایی که این بیلدر می\u200cسازد را پوشش می\u200cدهد.",
    "cb.evaluateModeHelp": "«اولین تطابق» در نخستین گروهِ درست متوقف می\u200cشود؛ «همهٔ گروه\u200cها» پیش از تصمیم، همه را ارزیابی می\u200cکند.",
    # p.*
    "p.waitUntil": "انتظار تا",
    "p.waitState": "وضعیت المان",
    "p.optional": "اختیاری (با تایم\u200cاوت خطا نده)",
    "p.multiple": "جمع\u200cآوری همهٔ موارد منطبق",
    "p.property": "ویژگی",
    "p.jsonInput": "ورودی JSON",
    "p.jsonPath": "انتخاب مسیر",
    # help.*
    "help.launchUrl": "اختیاری. اگر پر شود، مرورگر بلافاصله پس از اجرا به این نشانی می\u200cرود.",
    "help.waitOptional": "تایم\u200cاوت به\u200cجای شکست اجرا، به\u200cعنوان استپ رد\u200cشده گزارش می\u200cشود.",
    "help.extractMultiple": "روشن برای فهرست همهٔ موارد منطبق؛ خاموش فقط اولی را برمی\u200cگرداند.",
    "help.parseJson": "متن خام JSON (یا عبارتی که آن را تولید می\u200cکند).",
    "help.jsonPath": "مسیر نقطه\u200cای/اندیسی در مقدار پارس\u200cشده، مثل data.items[0].id.",
    "help.parseJsonOptional": "شکست در پارس به\u200cجای خطا دادن، مقدار null می\u200cدهد.",
    # fe.*
    "fe.pinNode": "پین کردن نود",
    "fe.unpinNode": "برداشتن پین نود",
    # pill.*
    "pill.true": "درست",
    "pill.false": "نادرست",
    "pill.body": "حلقه",
    "pill.done": "پایان",
    "pill.catch": "خطا",
    # ndv.*
    "ndv.open": "بازکردن تنظیمات",
    "ndv.tabInstructions": "دستورها",
    "ndv.tabAdvanced": "پیشرفته",
    "ndv.tabError": "خطا",
    "ndv.tabTest": "آزمون",
    "ndv.tabSchema": "ساختار",
    "ndv.tabTable": "جدول",
    "ndv.tabJson": "JSON",
    "ndv.run": "اجرا",
    "ndv.of": "از",
    "ndv.searchInput": "جست\u200cوجو در دادهٔ ورودی...",
    "ndv.searchOutput": "جست\u200cوجو در دادهٔ خروجی...",
    "ndv.noMatch": "فیلد منطبقی نیست.",
    "ndv.dragHint": "مقادیر را به پارامترها بکشید.",
    "ndv.dragHintCond": "مقادیر را به شرط\u200cها بکشید.",
    "ndv.moreFields": "فیلدهای بیشتر",
    "ndv.outEmptyTitle": "برای دیدن خروجی، نود را اجرا کنید",
    "ndv.outEmptySub": "خروجی پس از اجرای این نود همین\u200cجا نمایش داده می\u200cشود.",
    "ndv.status": "وضعیت",
    "ndv.time": "زمان",
    "ndv.size": "حجم",
    "ndv.pickElement": "انتخاب المان از صفحهٔ مرورگر زنده",
    "ndv.pickHint": "برای انتخاب المان، نمای مرورگر زنده را باز کنید.",
    "ndv.advancedEmpty": "همهٔ پارامترهای این نود از قبل در تب «دستورها» هستند.",
    "ndv.testHint": "پیش\u200cنمایش فقط\u200cخواندنی از آنچه این نود به موتور اجرا می\u200cفرستد.",
    # click.*
    "click.secSelector": "سلکتور",
    "click.selectorType": "نوع سلکتور",
    "click.selTypeCss": "سلکتور CSS",
    "click.selTypeXpath": "XPath",
    "click.selTypeText": "متن",
    "click.selectorHelp": "با دکمهٔ هدف، المان را از صفحهٔ مرورگر زنده انتخاب کنید.",
    "click.secClickOptions": "گزینه\u200cهای کلیک",
    "click.clickType": "نوع کلیک",
    "click.typeSingle": "کلیک تک",
    "click.typeDouble": "دوبار کلیک",
    "click.typeTriple": "سه\u200cبار کلیک",
    "click.btnLeft": "چپ",
    "click.btnMiddle": "وسط",
    "click.btnRight": "راست",
    "click.clickCount": "تعداد کلیک",
    "click.delayBefore": "تأخیر پیش از کلیک (ms)",
    "click.secSelectorOptions": "گزینه\u200cهای سلکتور",
    "click.waitForSelector": "انتظار برای سلکتور",
    "click.waitForSelectorHelp": "پیش از کلیک، تا ظاهر شدن سلکتور صبر کن.",
    "click.multipleMatches": "چند مورد منطبق",
    "click.multipleMatchesHelp": "بیش از یک مورد منطبق مجاز باشد، به\u200cجای خطا دادن.",
    "click.highlightElement": "نشانه\u200cگذاری / هایلایت المان",
    "click.highlightElementHelp": "پیش از کلیک، دور المان را لحظه\u200cای مشخص کن (برای عیب\u200cیابی مفید است).",
    "click.visibleOnly": "فقط موارد دیده\u200cشده",
    "click.stableFor": "ثبات به مدت (ms)",
    "click.stableForHelp": "صبر کن تا حرکت المان متوقف شود",
    "click.secOffsets": "جابه\u200cجایی نقطهٔ کلیک",
    "click.offsetX": "جابه\u200cجایی X (px)",
    "click.offsetY": "جابه\u200cجایی Y (px)",
    "click.offsetHelp": "فاصلهٔ نقطهٔ کلیک از مرکز/گوشهٔ بالا-چپ المان",
    "click.secModifiers": "کلیدهای کمکی (اختیاری)",
    "click.modAlt": "Alt",
    "click.modCtrl": "Ctrl / Cmd",
    "click.modShift": "Shift",
    "click.secBehavior": "رفتار",
    "click.humanLike": "حرکت انسان\u200cگونه",
    "click.forceClick": "کلیک اجباری",
    # cb.*
    "cb.builder": "سازندهٔ شرط",
    "cb.addPath": "افزودن مسیر",
    "cb.addPathV2": "مسیرهای خروجی چندگانه در نسخه\u200cای بعدی می\u200cآیند. امروز هر شرط یک مسیر درست و یک مسیر نادرست دارد.",
    "cb.path": "مسیر",
    "cb.allMustMatch": "همهٔ شرط\u200cها باید برقرار باشند (AND)",
    "cb.orNewGroup": "یا (گروه جدید)",
    "cb.leftSource": "منبع سمت چپ",
    "cb.attributeName": "نام ویژگی",
    "cb.cssSelector": "سلکتور CSS",
    "cb.operator": "عملگر",
    "cb.rightValue": "مقدار سمت راست",
    "cb.cloneRow": "تکثیر شرط",
    "cb.collapseRow": "جمع کردن",
    "cb.expandRow": "باز کردن",
    "cb.truePath": "مسیر درست",
    "cb.truePathSub": "وقتی شرط درست باشد اجرا می\u200cشود",
    "cb.falsePath": "مسیر نادرست",
    "cb.falsePathSub": "وقتی شرط نادرست باشد اجرا می\u200cشود",
    "cb.outputPort": "خروجی",
    "cb.maxDepth": "حداکثر عمق",
    "cb.recommended": "پیشنهادی",
    "cb.evaluateMode": "حالت ارزیابی",
    "cb.evalFirst": "اولین تطابق",
    "cb.evalAll": "همهٔ گروه\u200cها",
    "cb.loopGuard": "محافظ حلقه",
    # cbs.*
    "cbs.text": "متن المان",
    "cbs.attribute": "ویژگی المان",
    "cbs.value": "مقدار ورودی",
    "cbs.html": "کد HTML المان",
    "cbs.variable": "متغیر / عبارت",
    # op.*
    "op.exists": "وجود دارد",
    "op.not_exists": "وجود ندارد",
    "op.visible": "دیده می\u200cشود",
    "op.hidden": "پنهان است",
    "op.equals": "برابر است با",
    "op.not_equals": "برابر نیست با",
    "op.contains": "شامل است",
    "op.not_contains": "شامل نیست",
    "op.starts_with": "شروع می\u200cشود با",
    "op.ends_with": "پایان می\u200cیابد با",
    "op.matches_regex": "با الگو (regex) منطبق است",
    "op.greater_than": "بزرگ\u200cتر از",
    "op.less_than": "کوچک\u200cتر از",
    "op.greater_equal": "بزرگ\u200cتر یا برابر",
    "op.less_equal": "کوچک\u200cتر یا برابر",
    "op.is_empty": "خالی است",
    "op.not_empty": "خالی نیست",
    "op.is_true": "درست است",
    "op.is_false": "نادرست است",
}


def esc(v):
    return v.replace('\\', '\\\\').replace("'", "\\'")


def main():
    src = io.open(PATH, encoding='utf-8', newline='').read()
    if 'cb.leftSourceHelp' in src:
        print('already patched — nothing to do')
        return 0

    fa_at = src.index('fa: {')
    en_at = src.index('en: {')
    fa_slice = src[fa_at:en_at]
    en_slice = src[en_at:]

    # ---- append the new keys to `en`, right after 'cb.loopGuard' -----------
    anchor = "      'cb.loopGuard': 'Loop guard',\n"
    assert en_slice.count(anchor) == 1, en_slice.count(anchor)
    add_en = anchor + ''.join(
        "      '%s': '%s',\n" % (k, esc(v)) for k, v in NEW_EN
    )
    en_slice = en_slice.replace(anchor, add_en, 1)

    # ---- insert every missing key into `fa`, before its closing brace ------
    have_fa = set(re.findall(r"'([^']+)':", fa_slice))
    want = [k for k, _ in re.findall(r"'([^']+)': '((?:[^'\\]|\\.)*)'", en_slice)]
    missing = [k for k in want if k not in have_fa]
    unknown = [k for k in missing if k not in FA]
    if unknown:
        print('NO TRANSLATION for: %s' % ', '.join(unknown), file=sys.stderr)
        return 1

    block = ['\n      /* --- NDV / Condition Builder (HANDOFF 14: rule 0.6 debt) --- */\n']
    for k in missing:
        block.append("      '%s': '%s',\n" % (k, esc(FA[k])))
    tail = '    },\n    '
    assert fa_slice.endswith(tail), repr(fa_slice[-40:])
    fa_slice = fa_slice[:-len(tail)] + ''.join(block) + tail

    out = src[:fa_at] + fa_slice + en_slice
    io.open(PATH, 'w', encoding='utf-8', newline='').write(out)
    print('fa += %d keys, en += %d keys' % (len(missing), len(NEW_EN)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
