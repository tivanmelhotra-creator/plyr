// Read-only: feed BrowserWindowManager's own parsers with the REAL wmctrl line
// measured on Xvfb + openbox (tools/s32 report). Changes no Task View code.
import { parseWmctrlList, parseBrowserTitle } from '../../src/core/BrowserWindowManager';
const host = process.argv[2] || '487a8594ff11';
const lines = [
  `0x00400003  0 5245   chromium-browser (/app/profiles/local/chrome-profile).Chromium-browser  ${host} about:blank - Chromium`,
  `0x01000003  0 5348   chromium-browser (/app/profiles/chrome-profile).Chromium-browser  ${host} about:blank - Chromium`,
];
for (const r of parseWmctrlList(lines.join('\n'))) {
  console.log(JSON.stringify({ windowId: r.windowId, pid: r.pid, wmClass: r.wmClass, titleParsed: r.title, taskViewTitle: parseBrowserTitle(r.title).page }));
}
