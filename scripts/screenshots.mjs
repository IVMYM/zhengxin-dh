// 使用系统 Chrome 对竖屏界面做端到端检查并截图（1080×1920）。
// 用法：先 npm start，再 node scripts/screenshots.mjs [输出目录] [测试语音 wav]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const OUT = process.argv[2] || '/workspace/zhengxin-shots';
const WAV = process.argv[3] || '';
const BASE = process.env.BASE_URL || 'http://localhost:43200';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
fs.mkdirSync(OUT, { recursive: true });

const args = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (WAV) args.push(`--use-file-for-fake-audio-capture=${WAV}`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const report = {};
const shot = async (name) => { console.log('  状态', name, await page.evaluate(() => [window.dh.state.mode, window.dh.speaker.active, window.dh.speaker.audio.currentTime.toFixed(2), document.querySelector('#subText').textContent.slice(0, 10)].join(' | '))); await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('截图', name); };

await page.goto(`${BASE}/?greetEvery=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.dh && window.dh.state.cfg);
await page.waitForTimeout(2500);
await shot('01_attract_idle');

// 等待离线语音模型加载
const t0 = Date.now();
await page.waitForFunction(() => window.__asrReady === true, null, { timeout: 180000 });
report.asrLoadMs = Date.now() - t0;
console.log('ASR 模型加载完成', report.asrLoadMs, 'ms');

// 唤醒并开始聆听（麦克风使用假设备 / 测试语音文件）
await page.click('#attract');
await page.waitForTimeout(400);
await page.evaluate(() => { window.dh.speaker.stop(); });
await page.waitForTimeout(300);
await page.click('#micBtn');
await page.waitForFunction(() => document.querySelector('#app').classList.contains('mode-listening'));
if (WAV) {
  await page.waitForFunction(() => !/请说出您的问题/.test(document.querySelector('#utterText').textContent) && document.querySelector('#utterText').textContent.length > 2 && document.querySelector('#utter').classList.contains('live'), null, { timeout: 20000 }).catch(() => {});
} else {
  await page.evaluate(() => window.dh.showUtter('我想查一下个人信用报告', true));
}
await page.waitForTimeout(300);
await shot('02_listening');

// 识别结束 → 问答 → 播报 + 信息卡
await page.waitForFunction(() => document.querySelector('#app').classList.contains('has-panel'), null, { timeout: 30000 });
report.asrText = await page.evaluate(() => window.__lastAnswer && window.__lastAnswer.query);
report.asrIntent = await page.evaluate(() => window.__lastAnswer && window.__lastAnswer.intent);
// 采样口型：说话视频显隐
const samples = [];
for (let i = 0; i < 30; i++) {
  samples.push(await page.evaluate(() => ({ talk: document.querySelector('#vTalk').style.opacity, active: window.dh.speaker.active, attached: window.dh.speaker.attached, t: window.dh.speaker.audio.currentTime })));
  if (i === 8) await shot('03_answer_card');
  await page.waitForTimeout(150);
}
report.lipSamples = samples;

// 步骤类卡片
await page.evaluate(() => { window.dh.ask('报告信息有错怎么办'); });
await page.waitForTimeout(1800);
await shot('04_answer_steps_dispute');

// 自助查询指引流程
await page.click('#guideBtn');
await page.waitForTimeout(1500);
await shot('05_selfservice_step1_id');
await page.evaluate(() => { window.dh.flowGo(2); });
await page.waitForTimeout(1500);
await shot('06_selfservice_step3_phone');
await page.evaluate(() => { window.dh.flowGo(4); });
await page.waitForTimeout(1500);
await shot('07_selfservice_step5_report');

// 文字输入
await page.evaluate(() => { window.dh.exitFlow(false); });
await page.click('#kbBtn');
await page.fill('#textInput', '有人说花钱能修复征信');
await page.waitForTimeout(300);
await shot('08_text_input');
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
await shot('09_answer_scam');

// 整页文字中的个人信息检查
report.pageTextSample = await page.evaluate(() => document.body.innerText.slice(0, 200));
report.speak = await page.evaluate(() => ({ attached: window.dh.speaker.attached, ctx: window.dh.speaker.ctx && window.dh.speaker.ctx.state }));
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ ...report, logs: logs.slice(-40) }, null, 2));
console.log(JSON.stringify({ asrLoadMs: report.asrLoadMs, asrText: report.asrText, asrIntent: report.asrIntent, speak: report.speak }, null, 0));
console.log('口型采样', samples.map((s) => (s.talk === '1' ? '█' : '·')).join(''));
await browser.close();
