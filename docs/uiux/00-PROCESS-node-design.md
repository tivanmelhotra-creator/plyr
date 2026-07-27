# فرآیند طراحی نود (Aria Automate × plyr backend)

## قانون طلایی
قبل از پیاده‌سازی UI هر نود:

1. **Backend را چک کن** (`src/pipeline.ts` + `public/js/actions.js` + `ConditionEngine` در صورت نیاز)
2. اگر backend **کامل** بود → دست نزن؛ فقط UI را مطابق تصویر نهایی بساز
3. اگر backend **خلأ** داشت → خلأ را در فایل `.md` هم‌نام تصویر بنویس
4. تصویر نهایی در `Final ui-ux/` ذخیره می‌شود
5. فایل `همون-نام.md` کنار تصویر، **دستورالعمل پیاده‌سازی** است (نه `.txt`)
6. آخر کار فقط طبق `.md` + تصویر: UI بساز + خلأ backend را پر کن

## اولویت فعلی (v1)
High-priority browser nodes only.
Later (not now): Online Services, MCP, Marketplace, full Templates publish.

### Core nodes order
1. Condition (`if` / builder)
2. Click Element
3. Type Text / Fill
4. Wait Element
5. Open URL / Goto
6. Launch Browser
7. Trigger / Webhook
8. Extract Data
9. Delay
10. Close Browser
11. Parse JSON (if needed)

## قرارداد نام‌گذاری فایل‌ها
```
Final ui-ux/
  ndv-condition-final.webp        # تصویر قفل‌شده
  ndv-condition-final.md          # دستورالعمل + mapping + backend gaps
  lite/ndv-condition-final.jpg    # نسخه سبک برای تحلیل
  ndv-click-element-final.webp
  ndv-click-element-final.md
  shell-editor-main-final.webp    # shell کلی ادیتور
  shell-editor-main-final.md
  state-empty-canvas.webp
  state-empty-canvas.md
```

## قالب فایل `.md` هر نود
```
# <NODE NAME> — implementation spec
## Status: LOCKED visual | backend: READY / GAPS
## Files: full / lite paths

## UI structure (from final image)
...

## Params mapping (UI field → backend params)
| UI field | Backend param | Status A/B/C |
...

## A — Ready now (wire only)
## B — Small backend add required
## C — Defer to later version

## Serialize rules
## Do not implement yet
```

## سطوح فیلد
- **A Ready now**: مستقیم به backend موجود
- **B Small add**: قبل/هم‌زمان با UI، pipeline را گسترش بده
- **C Later**: در v1 نساز یا فقط UI غیرفعال بدون promise

## نقش‌ها
- **صاحب محصول**: تصویر نهایی را gen/approve می‌کند و در Final ui-ux می‌گذارد
- **Agent**: backend audit → prompt تصویر (با پوشش gaps) → بعد از lock تصویر، فایل md می‌نویسد → در فاز build طبق md پیاده می‌کند
