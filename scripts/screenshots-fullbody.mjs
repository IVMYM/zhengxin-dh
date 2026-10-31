// 无文字全屏模式检查：待机、说话中截图，并实测一次大模型问答延迟（首句、整句）。
// 用法：先 npm start，再 node scripts/screenshots-fullbody.mjs [输出目录] [问题]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = process.argv[2] || '/workspace/zhengxin-shots/fullbody';
const Q = process.argv[3] || '征信和芝麻信用有什么区别';
const BASE = process.env.BASE_URL || 'http://localhost:43200';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/?greetEvery=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.dh && window.dh.state.cfg);
await page.waitForTimeout(3000);
const visibleText = () => page.evaluate(() => {
  const out = [];
  const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3 && c.textContent.trim()) { const el = c.parentElement; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && el.closest('#app') && !el.closest('[hidden]')) out.push(c.textContent.trim().slice(0, 20)); } else if (c.nodeType === 1) walk(c); } };
  walk(document.body); return out;
});
await page.screenshot({ path: `${OUT}/01_standby.png` });
const report = { standbyVisibleText: await visibleText(), cue: await page.$eval('#cue', (e) => e.dataset.state) };
const t0 = Date.now();
await page.evaluate((q) => { window.dh.ask(q); }, Q);
await page.waitForFunction(() => window.dh.state.mode === 'thinking');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/02_thinking.png` });
await page.waitForFunction(() => window.dh.speaker.playing && window.dh.isTalking(), null, { timeout: 30000 });
report.firstAudioMs = Date.now() - t0;
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/03_speaking.png` });
report.speakingVisibleText = await visibleText();
await page.waitForFunction(() => window.__lastAnswer, null, { timeout: 60000 });
await page.waitForFunction(() => !window.dh.speaker.active && window.dh.state.mode !== 'speaking', null, { timeout: 60000 });
report.answer = await page.evaluate(() => ({ ...window.__dhLatency, source: window.__lastAnswer.source, timing: window.__lastAnswer.timing, speech: window.__lastAnswer.speech }));
report.totalMs = Date.now() - t0;
await page.waitForTimeout(800);
report.afterMode = await page.evaluate(() => window.dh.state.mode);
await page.screenshot({ path: `${OUT}/04_after_listening.png` });
report.errors = logs.filter((l) => /pageerror|\[error\]/.test(l));
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
