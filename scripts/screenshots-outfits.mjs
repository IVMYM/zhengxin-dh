// 换装自检：逐套轻触切换并截图待机画面；检查播报中轻触换装不打断声音、长按 0.8 秒开始说话/打断、语音“换一套”、F2 设置。
// 用法：先 npm start，再 node scripts/screenshots-outfits.mjs [输出目录]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = process.argv[2] || '/workspace/zhengxin-shots/outfits';
const BASE = process.env.BASE_URL || 'http://localhost:43200';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
fs.mkdirSync(`${OUT}/standby`, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => localStorage.clear());
await page.goto(`${BASE}/?greetEvery=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.dh && window.dh.outfit && window.dh.outfit.cur);
await page.waitForTimeout(2500);
const step = (k, v) => { report.checks[k] = v; console.log(k, v); };
const cur = () => page.evaluate(() => window.dh.outfit.cur.id);
const settled = () => page.waitForFunction(() => !window.dh.outfit.switching && document.querySelector('#vIdle').readyState >= 2, null, { timeout: 15000 });
const tap = async () => { await page.mouse.move(270, 500); await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up(); };
const report = { order: [], checks: {} };
const rot = await page.evaluate(() => window.dh.outfit.rotation().map((o) => o.id));
report.rotation = rot.length;
for (let i = 0; i < rot.length; i++) {
  const id = await cur();
  await settled(); await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/standby/${String(i).padStart(2, '0')}_${id}.png` });
  report.order.push(id);
  const preloaded = await page.evaluate(() => document.querySelector('#vPreIdle').dataset.id);
  await tap(); await page.waitForTimeout(80);
  const after = await cur();
  if (after === id) step(`tap_${id}`, 'NO_CHANGE');
  if (i === 0) step('preloadNext', preloaded === after ? 'ok' : `preloaded ${preloaded} next ${after}`);
}
await settled();
step('cycled', (await cur()) === rot[0] ? 'ok' : `ended at ${await cur()}`);

// 播报中轻触：换装但声音继续
await page.evaluate(() => { window.dh.say(window.dh.state.cfg.greet); });
const okPlay = await page.waitForFunction(() => window.dh.speaker.playing, null, { timeout: 20000 }).then(() => true).catch(() => false);
const sp = await page.evaluate(() => ({ kind: window.dh.speaker.kind, active: window.dh.speaker.active }));
if (!okPlay) step('speakerStart', JSON.stringify(sp));
await page.waitForTimeout(800);
const t1 = await page.evaluate(() => window.dh.speaker.audio.currentTime);
const before = await cur();
await tap(); await page.waitForTimeout(900);
const s2 = await page.evaluate(() => ({ t: window.dh.speaker.audio.currentTime, active: window.dh.speaker.active, playing: window.dh.speaker.playing, id: window.dh.outfit.cur.id, talk: window.dh.isTalking() }));
await page.screenshot({ path: `${OUT}/check_tap_while_speaking.png` });
step('tapWhileSpeaking', (s2.id !== before && s2.active && (sp.kind !== 'audio' || (s2.playing && s2.t > t1))) ? `ok kind=${sp.kind} t ${t1.toFixed(2)}→${s2.t.toFixed(2)} talk=${s2.talk}` : JSON.stringify({ before, ...s2, t1, sp }));
// 长按 0.8 秒：打断播报并开始听
await page.mouse.move(270, 500); await page.mouse.down(); await page.waitForTimeout(1000); await page.mouse.up();
await page.waitForTimeout(400);
const s3 = await page.evaluate(() => ({ active: window.dh.speaker.active, mode: window.dh.state.mode, id: window.dh.outfit.cur.id }));
step('longPressInterrupt', (!s3.active && s3.id === s2.id) ? `ok (mode=${s3.mode}, 未换装)` : JSON.stringify(s3));
await page.evaluate(() => { window.dh.asr.cancel(); window.dh.setMode('idle'); });
// 语音“换一套”/“换成旗袍”
await settled();
const b4 = await cur();
await page.evaluate(() => { window.__lastAnswer = null; window.dh.ask('换一套'); });
await page.waitForFunction(() => window.__lastAnswer && window.__lastAnswer.action === 'outfit', null, { timeout: 15000 });
await page.waitForTimeout(600);
step('voiceNext', (await cur()) !== b4 ? `ok ${b4} → ${await cur()}（${await page.evaluate(() => window.__lastAnswer.speech)}）` : 'NO_CHANGE');
await settled();
await page.evaluate(() => { window.__lastAnswer = null; window.dh.ask('换成旗袍'); });
await page.waitForFunction(() => window.__lastAnswer && window.__lastAnswer.action === 'outfit', null, { timeout: 15000 });
await page.waitForTimeout(600);
step('voiceQipao', (await cur()) === 'qipao' ? 'ok' : await cur());
await page.evaluate(() => { window.dh.speaker.stop && window.dh.speaker.stop(); });
// 左上角热区长按 2 秒打开设置，且不触发换装
await settled();
const b5 = await cur();
await page.mouse.move(30, 30); await page.mouse.down(); await page.waitForTimeout(2300); await page.mouse.up();
await page.waitForTimeout(300);
step('hotZoneSettings', await page.evaluate((b) => (!document.querySelector('#settings').hidden && window.dh.outfit.cur.id === b ? 'ok' : `open=${!document.querySelector('#settings').hidden} id=${window.dh.outfit.cur.id}`), b5));
report.settings = await page.evaluate(() => ({ outfitOptions: document.querySelectorAll('#setOutfit option').length, sensitiveRow: !document.querySelector('#setSensitiveRow').hidden }));
await page.screenshot({ path: `${OUT}/check_settings.png` });
report.noDemoText = await page.evaluate(() => (/演示|DEMO/i.test(document.body.innerText) ? 'FOUND' : 'ok'));
report.logs = logs;
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
console.log('DONE', report.rotation, JSON.stringify(report.settings), report.noDemoText, logs);
await browser.close();
