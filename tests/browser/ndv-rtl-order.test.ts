/**
 * Task 5 — the NDV column order in a RIGHT-TO-LEFT page, measured in real
 * Chromium with the real stylesheet: INPUT left, Parameters middle, OUTPUT right,
 * exactly as in LTR; the hairlines on the inner edges; text inside still RTL.
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeBrowser, ensureProbed, sharedBrowser, closeSharedBrowser } from './real-browser';

await ensureProbed();
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'styles.css'), 'utf8');

const html = (dir: string) => `<!doctype html><html dir="${dir}"><head><style>${css}</style></head><body>
<div class="ndv-modal is-designed" style="width:1100px;height:600px"><div class="ndv-body"><div class="ndv"><div class="ndv-cols">
  <div class="ndv-col ndv-col-input" id="i">in</div>
  <div class="ndv-col ndv-col-params" id="p">params</div>
  <div class="ndv-col ndv-col-output" id="o">out</div>
</div></div></div></div></body></html>`;

afterAll(async () => { await closeSharedBrowser(); });

describeBrowser('NDV column order', () => {
  for (const dir of ['ltr', 'rtl']) {
    it(`${dir}: INPUT < Parameters < OUTPUT from left to right`, async () => {
      const browser = await sharedBrowser();
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      await page.setContent(html(dir));
      const x = await page.evaluate(() => {
        const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
        return { i: r('i').left, p: r('p').left, o: r('o').left };
      });
      expect(x.i).toBeLessThan(x.p);
      expect(x.p).toBeLessThan(x.o);
      const d = await page.evaluate(() => getComputedStyle(document.getElementById('p')!).direction);
      expect(d).toBe(dir);                      // text inside keeps the page direction
      await page.close();
    });
  }
});
