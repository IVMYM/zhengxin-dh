// 声画同步测量：无头 Chrome 打开页面，问一个问题（大模型逐句回答 → 每句实时合成语音），
// 逐帧记录：真实输出音量（WebAudio 分析器）、音频事件、说话视频/口型视频每一帧的呈现时间和帧位置、图层透明度，
// 算出“开口比声音早/晚多少毫秒”“声音停了嘴还动多久”“有声音嘴不动多久”“句间空档”等，写 out/av-sync/<标签>.json。
// 用法：node scripts/check-av-sync.mjs <标签> [loop|gate] [--real]   （默认起假大模型；--real 用 .env 的真实大模型）
//       BASE_URL=http://localhost:43200 node scripts/check-av-sync.mjs mac-loop loop   （测已在运行的服务）
//       SAY='信用小知识。…' node scripts/check-av-sync.mjs lip loop                  （直接播一句，有预渲染口型视频时测它）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 会真的播放声音（浏览器朗读兜底时 macOS 系统语音不受 --mute-audio 控制）：只在服务器/测试机上跑，不在展厅或办公电脑上跑
if (process.platform === 'darwin' || process.platform === 'win32') { if (!process.env.AV_ALLOW_LOCAL) { console.error('这个测量会出声，只在 Linux 测试机上运行（确需本机运行设置 AV_ALLOW_LOCAL=1）'); process.exit(2); } }
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const LABEL = args[0] || 'run';
const MODE = args[1] || 'loop';
const REAL = process.argv.includes('--real');
const PORT = Number(process.env.CHECK_PORT || 43299);
const OUT = path.join(ROOT, 'out', 'av-sync');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const QUESTION = process.env.QUESTION || '信用报告对年轻人有什么用';
fs.mkdirSync(OUT, { recursive: true });

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ANSWER = process.env.ANSWER || `${pick(['年轻人', '刚工作的朋友', '大学毕业生', '新入职的同事'])}的信用报告很重要，以后办房贷、车贷都要看它。平时${pick(['信用卡', '花呗', '助学贷款', '消费贷'])}按时还款，就是在积累好的信用记录。如果发现报告里有不对的地方，可以到银行柜台申请异议处理。`;

function fakeLlm() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chars = [...ANSWER]; let i = 0;
      setTimeout(function next() {
        if (i >= chars.length) { res.end('data: [DONE]\n\n'); return; }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chars.slice(i, i + 2).join('') } }] })}\n\n`);
        i += 2; setTimeout(next, 40);
      }, 300);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let server = null; let llm = null; let BASE = process.env.BASE_URL;
if (!BASE) {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIPSYNC_URL: process.env.LIPSYNC_URL ?? '' };
  if (!REAL) { llm = await fakeLlm(); Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`, LLM_API_KEY: 'local-test', LLM_MODEL: 'fake', LLM_MODE: 'always' }); }
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', ...(process.env.MUTE ? ['--mute-audio'] : [])] }); // MUTE=1：扬声器不出声（分析器照常有数据）
const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
// 浏览器朗读兜底会走系统语音（不受静音参数控制），测量时禁用
await page.addInitScript(() => { if (window.speechSynthesis) { window.speechSynthesis.speak = () => {}; } });
await page.goto(`${BASE}/?mouth=${MODE}&greetEvery=0&wake=0&trace=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.dh && window.dh.state.cfg, null, { timeout: 15000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const sp = window.dh.speaker; sp.unlock();
  const A = window.__av = { s: [], ev: [], frames: { vTalk: [], vLip: [], vIdle: [] }, texts: [], lat: null };
  const a = sp.audio;
  for (const e of ['play', 'playing', 'waiting', 'pause', 'ended', 'loadstart', 'canplay']) a.addEventListener(e, () => A.ev.push({ e, t: performance.now(), ct: a.currentTime }));
  const vLip = document.getElementById('vLip');
  if (vLip) for (const e of ['play', 'playing', 'pause', 'ended']) vLip.addEventListener(e, () => A.ev.push({ e: 'lip-' + e, t: performance.now(), ct: vLip.currentTime }));
  for (const id of ['vTalk', 'vLip', 'vIdle']) {
    const v = document.getElementById(id); if (!v || !v.requestVideoFrameCallback) continue;
    const cb = (now, md) => { A.frames[id].push({ t: md.presentationTime, x: md.expectedDisplayTime, mt: md.mediaTime }); v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb);
  }
  const orig = sp.speak.bind(sp);
  sp.speak = (text) => { A.texts.push({ t: performance.now(), text }); return orig(text); };
  const vT = document.getElementById('vTalk');
  const loop = () => {
    const ctx = sp.ctx;
    if (ctx && !A.lat) A.lat = { base: ctx.baseLatency || 0, output: ctx.outputLatency || 0 };
    let r = 0;
    if (sp.attached && sp.analyser) { sp.analyser.getFloatTimeDomainData(sp.buf); let s = 0; for (const x of sp.buf) s += x * x; r = Math.sqrt(s / sp.buf.length); }
    A.s.push({ t: performance.now(), r, ct: sp.audio.currentTime, lipMaster: sp.audio === vLip, act: sp.active, pl: sp.playing, oT: +getComputedStyle(vT).opacity, oL: vLip ? +getComputedStyle(vLip).opacity : 0, mt: vT.currentTime, tp: vT.paused, kind: sp.kind });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
const t0 = Date.now();
// SAY=一句话：直接播报这句（测固定话术 / 预渲染口型视频）；否则问 QUESTION 走大模型逐句回答
await page.evaluate(([q, say]) => { window.__av.askAt = performance.now(); if (say) window.dh.say(say); else window.dh.ask(q); }, [QUESTION, process.env.SAY || '']);
// 等回答说完（说话状态结束后再多录 2.5 秒，看收尾）
await page.waitForFunction(() => window.__av.texts.length > 0, null, { timeout: 30000 });
await page.waitForFunction(() => window.dh.state.mode !== 'speaking' && window.dh.state.mode !== 'thinking' && !window.dh.speaker.active, null, { timeout: 90000, polling: 100 });
await page.waitForTimeout(2500);
const data = await page.evaluate(() => Object.assign(window.__av, { trace: window.__dhTrace.map((x) => ({ at: x.at, ct: x.ct, v: x.voiced, g: x.gate, tf: x.tf, talk: x.talk })), dhEvents: window.__dhEvents }));
data.mode = MODE; data.label = LABEL; data.errors = errors; data.ua = await page.evaluate(() => navigator.userAgent);
data.idleFps = 24;
fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(data));
await browser.close();
if (server) server.kill(); if (llm) llm.close();
const { analyze, table } = await import('./av-sync-analyze.mjs');
const r = analyze(data);
if (r.lip) console.log('口型视频：', JSON.stringify(r.lip));
fs.writeFileSync(path.join(OUT, `${LABEL}.report.json`), JSON.stringify(r, null, 2));
console.log(table([r]));
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，原始数据 out/av-sync/${LABEL}.json`);
