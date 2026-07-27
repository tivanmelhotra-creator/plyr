# HANDOFF — Aria Automate UI/UX Implementation (جلسه بعدی از اینجا ادامه بده)

## زمینه (Context)
کاربر فایل «Final ui-ux (2).zip» (دیزاین Aria Automate) را داد — این spec ها اکنون در `docs/uiux/` داخل ریپو هستند (source of truth). هدف: پیاده‌سازی کامل UI/UX روی فرانت vanilla-JS موجود (public/) + رفع کمبودهای بک‌اند. برنچ: `genspark_ai_developer`.

## ✅ کارهای انجام‌شده (این PR)
1. **توکن‌های دیزاین Aria (dark)** در `public/css/styles.css` — :root با پالت نارنجی #FF8A1F، بوم #0B0F14، dot-grid 20px.
2. **شل ادیتور**: `.fe-topbar` (برند + عنوان ورکفلو + بج Draft/Saved + دکمه‌ها)، `.fe-layout` = پالت 240px + بوم. در `views.js#renderEditor` بازنویسی شد (fe-shell/fe-topbar، refreshWfLabel بج می‌سازد).
3. **NDV به‌صورت مودال** (`flow-editor.js#renderInspector` بازنویسی کامل): `.ndv-backdrop/.ndv-modal`، هدر (آیکون/عنوان/بج وضعیت/دکمه Run node/×)، سه ستون INPUT|Parameters|OUTPUT. باز شدن با **دابل‌کلیک روی نود** (openNdv/closeNdv/ndvOpen). Esc می‌بندد. CSS مودال انتهای styles.css اضافه شد.
4. **Condition Builder** برای نودهای if/while در `flow-editor.js#buildConditionBuilder`: گروه‌های AND (ردیف‌ها) + OR بین گروه‌ها + کارت‌های نتیجه true/false. ذخیره در `node.params.groups` (JSON [[row,...],...]).
5. **سریال‌سازی شرط‌های ترکیبی** در `graph-serialize.js`: buildSimpleCondition/parseGroups/buildCondition (groups→{any:[{all:[...]}]})/conditionToGroups (برعکس، stepsToGraph مقدار params.groups را برمی‌گرداند). بک‌اند ConditionEngine از قبل all/any/not را پشتیبانی می‌کند — تغییر بک‌اند لازم نبود.
6. **Click Element غنی**: `actions.js` فیلدهای button/clickCount/delayBeforeMs/timeout/scrollIntoView/human/force؛ `src/pipeline.ts` (~خط 1263) این‌ها را اجرا می‌کند (tsc پاس شد).
7. **Empty canvas state card** (`flow-editor.js#renderEmptyState`): وقتی فقط نود start هست، کارت «Start building your workflow» + CTA.
8. **i18n fa+en**: کلیدهای ndv.runNode/statusIdle...، fe.brand/untitled/draft/testWorkflow/emptyTitle/emptySub/addFirstNode، cb.* (group/and/or/addAnd/addOr/removeRow/removeGroup/ifTrue/ifFalse/whileTrue/whileFalse) و پارامترهای کلیک (p.mouseButton و…).
- همه فایل‌های JS با `node --check` پاس شدند؛ `npx tsc --noEmit` پاس شد (قبل از این جلسه).

## ⚠️ کارهای باقی‌مانده (به ترتیب اولویت)
1. **تست‌ها**: `npm test` هنوز در این جلسه اجرا نشده! اول اجرا کن. احتمال شکست:
   - `tests/unit/action-catalog.test.ts` — فیلدهای جدید click ممکن است snapshot/count را بشکند.
   - `tests/unit/graph-serialize.test.ts` — باید هنوز پاس شود (buildCondition backward-compatible است).
   - سپس تست‌های جدید برای condition groups اضافه کن (انتهای graph-serialize.test.ts، describe جدید): groups JSON → {any:[{all:[...]}]}، تک‌گروه→{all}، تک‌ردیف→simple، round-trip stepsToGraph بازگرداندن params.groups.
2. **تأیید بصری**: `npm run dev` یا سرور را با run_in_background بالا بیاور، GetServiceUrl پورت، با PlaywrightConsoleCapture چک کن: صفحه ادیتور (#/editor)، دابل‌کلیک نود → مودال NDV، نود if → Condition Builder، بوم خالی → کارت empty.
3. **نکته احتمالی باگ**: در NDV مودال دکمه Run node به `#fe-run` کلیک می‌فرستد (کل ورکفلو را اجرا می‌کند نه تک‌نود — بک‌اند اجرای تک‌نود ندارد؛ اگر خواستی endpoint جدید بساز POST /flow/run-node یا همین رفتار را نگه دار).
4. **`fe.selectHint` و insp-head دیگر استفاده نمی‌شوند** — پاکسازی اختیاری.
5. **Activity Log / Minimap polish** (shell-activity-log.md، shell-minimap.md): RunPanel موجود است؛ فقط استایل Aria (فعلاً کافی است، اولویت پایین).
6. **پس از پاس شدن تست‌ها**: squash + push + PR (این PR فعلی را آپدیت کن).

## فایل‌های تغییر یافته
- public/css/styles.css — توکن‌ها + شل + مودال NDV + Condition Builder CSS (انتهای فایل)
- public/js/flow-editor.js — NDV مودال (renderInspector بازنویسی)، openNdv/closeNdv، buildConditionBuilder، renderEmptyState، dblclick روی نود، renderFieldFeedback از ndvRoot() می‌خواند
- public/js/views.js — renderEditor: fe-shell/fe-topbar/fe-wf-badge؛ refreshWfLabel جدید
- public/js/graph-serialize.js — شرط‌های ترکیبی (خطوط ~98-160، export خط ~477)
- public/js/actions.js — فیلدهای click
- public/js/i18n.js — کلیدهای جدید fa (~خط 294) و en (~خط 758)
- src/pipeline.ts — اجرای پارامترهای کلیک (CRLF حفظ شود!)
- docs/uiux/ — spec های دیزاین (source of truth)

## دستورات شروع جلسه بعد
```bash
cd /home/user/webapp && git checkout genspark_ai_developer && npm test 2>&1 | tail -30
```
