/**
 * ConsentHostPage — the page the SERVER'S OWN browser lands on.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * REPORTED, from live LOCAL-mode testing, as two separate defects that turned
 * out to be one:
 *
 *   «توقع داشتم که بعد اینکه مرورگر بالا اومد خب فقط یه دونه تب باشه … ولی چیزی
 *    که من متوجه شدم دو تا تب داشتیم خب. و یکیش حالت defaultای که وقتی مرورگر
 *    بالا میاد هست و یکی هم … یک تبی بود که وقتی می‌رفتم روش خب اون آلرتی که من
 *    انتظار داشتم … توی اون تب بالا اومده بود»
 *
 *   «ولی هیچ Alert یا تب جدیدی باز نشد که اون Alert رو واسم نشون بده … چون …
 *    اون Node قبلیه هنوز Set باقیمونده روش»
 *
 * ROOT CAUSE, MEASURED AGAINST THE LIVE SERVER
 * --------------------------------------------
 * The Alert is drawn by `extension/content/consent.js`, which is a CONTENT
 * SCRIPT. `extension/manifest.json` matches http and https URLs ONLY, and Chrome
 * injects content scripts into nothing else — `about:blank` included. The
 * server's browser was launched and left exactly there. Measured:
 *
 *     GET /browser/tabs                         ->  count = 1, url = 'about:blank'
 *     GET /inspector/consent?environment=local   ->  count = 2, both pending
 *
 * So the consent existed, correctly, one per node — and the single window in
 * existence was a window in which the code that renders it was never allowed to
 * run. That one fact produces BOTH reports:
 *
 *   TWO TABS. The operator navigated somewhere themselves to reach an http page.
 *   The script finally loaded there and the Alert appeared in THAT tab, with the
 *   untouched `about:blank` sitting beside it as the "default" one.
 *
 *   NO ALERT FOR A SECOND NODE. With the browser already up nothing opens a new
 *   tab, so the only page was still one no content script could run on. The old
 *   node stayed Set and the error the operator predicted followed.
 *
 * WHY A PAGE, RATHER THAN MORE RETRIES OR A FASTER POLL
 * ----------------------------------------------------
 * Every previous attempt at this defect treated it as timing — shorter poll
 * intervals, backoff tuning, extra retries. None of it could ever work: the poll
 * loop lives in a script that was not running at all. The fix is a DESTINATION,
 * and it is the only class of fix that can work.
 *
 * WHAT THIS PAGE IS, AND WHAT IT DELIBERATELY IS NOT
 * --------------------------------------------------
 * It is an ordinary `http://127.0.0.1:<PORT>` page, which is the whole point: a
 * LEGAL INJECTION TARGET, so `consent.js` loads, polls and draws the Alert here.
 * Beyond that it does as little as possible.
 *
 * It is NOT the dashboard. Loading the editor into the server's own window would
 * invite the operator to work in it, and that window belongs to the automation.
 *
 * It carries NO SCRIPT OF ITS OWN. The Alert comes from the extension; a script
 * here would be a second implementation of the same prompt, free to disagree
 * with the one that ships in the extension. It is also served without a key
 * (see the route comment), so it must not be able to read or show anything.
 *
 * It EXPLAINS ITSELF, because a blank page in a window that opened by itself is
 * indistinguishable from a failure. The text names the mechanism, so an operator
 * who sees this and no Alert knows which of the two halves to report — the
 * ambiguity that cost this defect several rounds.
 *
 * Text is bilingual (fa + en) inline rather than through i18n.js: this page is
 * rendered by the SERVER, has no access to the browser i18n bundle, and adding a
 * server-side copy of it for six sentences would be a second source of truth for
 * translations.
 */

/**
 * The landing page's HTML.
 *
 * Static, self-contained, no external requests: this page loads inside a browser
 * that may still be finishing its own start-up, and a stylesheet or font fetch
 * that hangs would leave the operator looking at unstyled text and wondering if
 * THAT is the bug.
 */
export function consentHostPage(): string {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Automation Browser — Ready</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #0f1115; color: #e6e8ee;
    font: 15px/1.75 system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
    padding: 32px;
  }
  .card {
    max-width: 620px; width: 100%;
    background: #161a21; border: 1px solid #262c37; border-radius: 14px;
    padding: 28px 30px;
  }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 650; }
  .dot {
    display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    background: #34d399; margin-inline-end: 9px; vertical-align: 1px;
  }
  p { margin: 12px 0 0; color: #aab2c0; }
  .en { direction: ltr; text-align: left; margin-top: 22px;
        padding-top: 18px; border-top: 1px solid #262c37; }
  strong { color: #e6e8ee; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>مرورگر خودکار آماده است</h1>
    <p>
      این همان مرورگری است که پروژه روی سرور بالا آورده. لازم نیست کاری اینجا
      انجام دهید و لازم نیست تب دیگری باز کنید.
    </p>
    <p>
      وقتی در داشبورد روی آیکون هدف‌گیری یک فیلد بزنید و <strong>Local
      Browser</strong> را انتخاب کنید، درخواست اجازه <strong>در همین صفحه</strong>
      نمایش داده می‌شود و نام نود و فیلد را می‌گوید. با زدن Allow، افزونه به آن
      فیلد وصل می‌شود و عنصر بعدی که انتخاب کنید به همان‌جا می‌رود.
    </p>
    <p>
      برای هر نود جدید یک درخواست تازه همین‌جا ظاهر می‌شود — پس نودِ قبلی
      هیچ‌وقت وصل نمی‌ماند.
    </p>
    <div class="en">
      <p>
        This is the browser this server launched. Nothing needs to be done here,
        and no second tab needs to be opened.
      </p>
      <p>
        Target a field in the dashboard and choose <strong>Local Browser</strong>:
        the approval prompt appears <strong>on this page</strong>, naming the node
        and the field. A new node raises a new prompt here, so a previous node is
        never left connected.
      </p>
    </div>
  </div>
</body>
</html>`;
}
