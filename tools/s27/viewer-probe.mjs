// Plays the operator's own browser: opens the viewer for a profile (Local Browser OFF)
// and checks after 8 s that the tab is still there, connected and not "ended".
import { chromium } from 'playwright';
const B = 'http://localhost:3000';
const id = process.argv[2];
const br = await chromium.launch({ headless: true });
const page = await br.newPage();
let closedBySelf = false;
page.on('close', () => { closedBySelf = true; });
const sessCalls = []; const healthCalls = [];
page.on('request', (r) => { const u = r.url(); if (u.includes('/browser/sessions')) sessCalls.push(u); if (u.includes('/browser/real/health')) healthCalls.push(u); if (u.includes('/browser/real/open')) healthCalls.push('OPEN:' + u); });
await page.goto(`${B}/desktop/chrome?profile=${id}&workflowId=wf_e2e01`);
await page.waitForTimeout(8000);
const ended = closedBySelf ? 'n/a' : await page.evaluate(() => !document.getElementById('ended').hidden);
const canvas = closedBySelf ? 0 : await page.evaluate(() => document.querySelectorAll('canvas').length);
console.log(JSON.stringify({ closedBySelf, endedShown: ended, vncCanvas: canvas, sessionsPolls: sessCalls.length, realHealthOrOpenCalls: healthCalls }));
// Second open in the SAME tab (named-window reuse is client-side; here: same page navigates)
await page.goto(`${B}/desktop/chrome?profile=default&workflowId=wf_e2e01`);
await page.waitForTimeout(2000);
console.log('viewer set:', await page.evaluate(() => sessionStorage.getItem('aria.viewer.profiles')));
await br.close();
