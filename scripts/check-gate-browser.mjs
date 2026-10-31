// 浏览器里检查门控口型（?mouth=gate）：播一句话，逐帧记录说话视频的帧号和状态，
// 核对句中停顿时画面是否停在闭嘴帧、帧号是否只顺序前进（没有乱跳），并截停顿时的脸部特写。
// 用法：先起服务（npm start），再 node scripts/check-gate-browser.mjs [输出目录]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = process.argv[2] || '/workspace/zhengxin-dh/out/gate-check';
const BASE = process.env.BASE_URL || 'http://localhost:43200';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const TEXT = '您好，我是小信。查询个人信用报告，可以带上本人身份证，到柜台或者自助查询机办理，也可以在手机银行上查询。';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/?mouth=gate&trace=1&greetEvery=0&wake=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.dh && window.dh.state.cfg && document.getElementById('app').classList.contains('gate'), null, { timeout: 15000 });
await page.waitForTimeout(2500);
await page.evaluate(() => { window.dh.speaker.unlock(); window.dh.speaker.stop(); window.__dhTrace.length = 0; });
const meta = await page.evaluate(() => fetch('/media/gate/xiaoxin.json').then((r) => r.json()));
const sayP = page.evaluate((t) => window.dh.say(t), TEXT);
let shot = 0; const t0 = Date.now();
while (!process.env.NOSHOT && Date.now() - t0 < 20000 && shot < 3) {
  const st = await page.evaluate(() => (window.__dhTrace.at(-1) || {}).gate);
  if (st === 'hold' && Date.now() - t0 > 1000) {
    const f = `${OUT}/hold-${shot + 1}.png`;
    await page.screenshot({ path: f, clip: { x: 360, y: 150, width: 360, height: 360 } });
    // 截图要花时间，截完仍在停顿才算数
    if ((await page.evaluate(() => (window.__dhTrace.at(-1) || {}).gate)) === 'hold') { shot++; await page.waitForTimeout(900); } else fs.rmSync(f);
  }
  await page.waitForTimeout(40);
}
const result = await sayP;
const trace = await page.evaluate(() => window.__dhTrace.map((x) => ({ at: Math.round(x.at), ct: x.ct, gate: x.gate, tf: x.tf, talk: x.talk, rate: x.rate, mt: x.mt })));
if (process.env.DUMP) fs.writeFileSync(`${OUT}/trace.json`, JSON.stringify(trace));
const words = await page.evaluate(() => window.dh.speaker.words);
// 句中停顿（≥150ms）中点时的帧
const gaps = []; let prev = 0;
for (const w of words || []) { if (w.t - prev >= 0.15 && prev > 0) gaps.push((prev + w.t) / 2); prev = w.t + w.d; }
const atGap = gaps.map((g) => { const x = trace.find((r) => r.ct >= g); return x ? { at: +g.toFixed(2), gate: x.gate, tf: x.tf, closed: x.tf != null && meta.closed[x.tf] === '1' } : null; }).filter(Boolean);
// 帧号只能顺序前进（每次 0~2 帧）或停住；记录异常跳变
let jumps = 0; let lastTf = null;
// 估算帧号偶尔回退 1 帧不算跳变
for (const r of trace) { if (r.tf == null || !r.talk) { lastTf = null; continue; } if (lastTf != null) { const d = (r.tf - lastTf + meta.n) % meta.n; if (d > 3 && d < meta.n - 3) jumps++; } lastTf = r.tf; }
const report = { result, errors, frames: trace.length, words: words ? words.length : 0, pausesClosed: `${atGap.filter((x) => x.closed).length}/${atGap.length}`, atGap, jumps, states: trace.reduce((a, r) => ((a[r.gate] = (a[r.gate] || 0) + 1), a), {}) };
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
