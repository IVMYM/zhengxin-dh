// 语音唤醒与“声音 / 口型 / 字幕”同步的端到端检查（系统 Chrome + 假麦克风）。
// 用法：先 npm start，再 node scripts/check-voice.mjs <含“你好”的 wav> [输出目录]
//  1. kiosk 启动参数（自动允许麦克风与自动播放）：不点屏幕，说“你好”应能唤醒
//  2. 普通浏览器（已授权麦克风、默认自动播放策略）：点一下屏幕后，说“你好”应能唤醒
//  3. 播报同步：逐帧记录播放位置、音量、口型、字幕，与音频文件里的实际停顿对比
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { cacheKey, resolveVoice, speakable, CACHE_DIR } from '../lib/tts.mjs';

const WAV = process.argv[2];
const OUT = process.argv[3] || '/tmp/dh-check';
const BASE = process.env.BASE_URL || 'http://localhost:43200';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
if (!WAV) { console.error('需要传入 wav 文件'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const result = { wake: {}, sync: [] };
const ONLY = process.env.ONLY || '';

// 有桌面时用有界面的 Chrome（headless 不执行“需用户点击才能出声”的限制），HEADLESS=1 强制无界面
const HEADLESS = process.env.HEADLESS === '1' || !process.env.DISPLAY;
// 模拟最严格的自动播放策略：用户点击之前，页面里的 AudioContext 一律处于挂起状态
// 模拟最严格的自动播放策略：用户真正点击屏幕之前，页面里的 AudioContext 一律处于挂起状态
// （Playwright 的 evaluate 会让 userActivation 变为 true，这里用真实 pointerdown 判断）
const STRICT_GESTURE = `(() => {
  let tapped = false;
  window.addEventListener('pointerdown', () => { tapped = true; }, true);
  window.addEventListener('keydown', () => { tapped = true; }, true);
  const A = window.AudioContext;
  window.AudioContext = class extends A {
    constructor(...a) { super(...a); const hold = () => { if (this.state === 'running' && !tapped) A.prototype.suspend.call(this); }; this.addEventListener('statechange', hold); hold(); }
    resume() { return tapped ? super.resume() : Promise.resolve(); }
  };
  window.webkitAudioContext = window.AudioContext;
})();`;
async function open(args, grant, strict) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: HEADLESS, args, ignoreDefaultArgs: ['--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 540, height: 960 } });
  if (grant) await ctx.grantPermissions(['microphone'], { origin: BASE });
  const page = await ctx.newPage();
  if (strict) await page.addInitScript(STRICT_GESTURE);
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  return { browser, page, logs };
}
const pill = (page) => page.evaluate(() => ({ state: document.querySelector('#voicePill').dataset.state, text: document.querySelector('#voiceText').textContent, mode: window.dh.state.mode, mic: window.dh.asr.micState, hits: window.__wakeHits || 0 }));

async function wakeTest(name, args, grant, tapFirst) {
  const { browser, page, logs } = await open(args, grant, tapFirst);
  await page.goto(`${BASE}/?greetEvery=0`);
  await page.waitForFunction(() => window.__asrReady === true, null, { timeout: 180000 });
  await page.waitForTimeout(800);
  const before = await pill(page);
  await page.screenshot({ path: `${OUT}/${name}_attract.png` });
  const r = { before };
  if (!tapFirst) {
    const t0 = Date.now();
    r.wokeWithoutTap = await page.waitForFunction(() => (window.__wakeHits || 0) > 0, null, { timeout: 15000 }).then(() => true, () => false);
    r.msToWake = r.wokeWithoutTap ? Date.now() - t0 : null;
  } else {
    // 普通模式：先观察不点屏幕时的状态，再点一下语音标签
    r.wokeWithoutTap = await page.waitForFunction(() => (window.__wakeHits || 0) > 0, null, { timeout: 8000 }).then(() => true, () => false);
    if (!r.wokeWithoutTap) {
      await page.click('#voicePill');
      await page.waitForTimeout(500);
      r.afterTap = await pill(page);
      await page.screenshot({ path: `${OUT}/${name}_after_tap.png` });
      const t0 = Date.now();
      r.wokeAfterTap = await page.waitForFunction(() => (window.__wakeHits || 0) > 0, null, { timeout: 15000 }).then(() => true, () => false);
      r.msToWake = r.wokeAfterTap ? Date.now() - t0 : null;
    }
  }
  await page.waitForTimeout(1500);
  r.after = await pill(page);
  r.logs = logs.filter((l) => l.includes('[语音]')).slice(0, 12);
  await browser.close();
  return r;
}

const fake = ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`];
if (!ONLY || ONLY === 'wake') result.wake.kiosk = await wakeTest('wake_kiosk', [...fake, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'], false, false);
console.log('kiosk 唤醒', JSON.stringify(result.wake.kiosk));
if (!ONLY || ONLY === 'wake') result.wake.normal = await wakeTest('wake_normal', [...fake, '--autoplay-policy=user-gesture-required'], true, true);
console.log('普通模式唤醒', JSON.stringify(result.wake.normal));

/* ---------------- 播报同步 ---------------- */
function detectSilence(file) {
  const p = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-38dB:d=0.12', '-f', 'null', '-'], { encoding: 'utf8' });
  const txt = p.stderr;
  const sil = []; let cur = null;
  for (const m of txt.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') cur = { s: Number(m[2]) }; else if (cur) { cur.e = Number(m[2]); sil.push(cur); cur = null; }
  }
  const dur = Number((/Duration: (\d+):(\d+):([\d.]+)/.exec(txt) || []).slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0));
  if (cur) sil.push({ s: cur.s, e: dur });
  return { sil, dur };
}

const texts = [
  ['female', '查询个人信用报告有四种常用方式：带上本人身份证到网点柜台，或在自助查询机上刷证查询；也可以登录网上银行、手机银行，或者征信中心官方网站在线查询。您想了解哪一种？'],
  ['female', '请特别注意，所谓“征信修复”“征信洗白”都是骗局。征信中心和银行从未授权任何机构做征信修复，真实的不良记录谁也删不掉；如果信息确有错误，自己申请异议就能免费更正。'],
  ['female2', '如果发现信用报告信息有误，可以免费提出异议申请。您可以到征信中心查询网点或我行网点提交，也可以在线申请。受理后会在二十日内核查处理，并把结果告诉您。'],
  ['female', `现在是检查时间${Date.now() % 100000}号。这句话没有预先缓存，会边合成边播放。字幕仍然要跟着声音走，停顿时数字人要闭嘴。`],
];
if (ONLY === 'wake') { fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(result, null, 2)); process.exit(0); }
const { browser, page } = await open(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'], false);
await page.goto(`${BASE}/?greetEvery=0&wake=0&trace=1`);
await page.waitForFunction(() => window.dh && window.dh.state.cfg);
await page.click('#attract');
await page.evaluate(() => window.dh.speaker.stop());
for (const [voice, text] of texts) {
  await page.evaluate((v) => { window.dh.state.voice = v; window.__dhTrace = []; window.__dhEvents = []; }, voice);
  const r = await page.evaluate((t) => window.dh.say(t), text);
  const trace = await page.evaluate(() => window.__dhTrace);
  const events = await page.evaluate(() => window.__dhEvents);
  const meta = await page.evaluate(async ([v, t]) => (await fetch(`/api/tts/meta?voice=${v}&text=${encodeURIComponent(t)}`)).json(), [voice, text]);
  const segs = await page.evaluate((t) => window.DHSync.splitSubtitle(t), text);
  const timings = await page.evaluate(([s, w]) => window.DHSync.alignSegments(s, w), [segs, meta.words]);
  const mp3 = `${OUT}/tts_${result.sync.length}.mp3`;
  fs.writeFileSync(mp3, Buffer.from(await (await fetch(`${BASE}/api/tts?voice=${voice}&text=${encodeURIComponent(text)}`)).arrayBuffer()));
  const { sil, dur } = detectSilence(mp3);
  // 有声区间 = 非静音区间
  const voiced = []; let t = 0;
  for (const s of sil) { if (s.s > t + 0.01) voiced.push({ s: t, e: s.s }); t = s.e; }
  if (t < dur - 0.01) voiced.push({ s: t, e: dur });
  const firstVoice = voiced[0] ? voiced[0].s : 0;
  const lastVoice = voiced.length ? voiced[voiced.length - 1].e : dur;
  const evAt = (type) => events.find((e) => e.type === type);
  const talkOnEv = events.find((e) => e.type === 'talkOn');
  const talkOffEv = [...events].reverse().find((e) => e.type === 'talkOff');
  const playingEv = evAt('playing');
  const endedEv = evAt('ended');
  // 帧级统计：内部停顿（≥0.25 秒）中口型是否在动；有声段内口型是否在动
  const pauses = sil.filter((s) => s.s > firstVoice + 0.05 && s.e < lastVoice - 0.05 && s.e - s.s >= 0.25);
  const inPause = (ct) => pauses.some((p) => ct > p.s + 0.2 && ct < p.e - 0.03);
  const inVoice = (ct) => voiced.some((v) => ct > v.s + 0.05 && ct < v.e - 0.05);
  const pf = trace.filter((f) => f.playing && inPause(f.ct));
  const vf = trace.filter((f) => f.playing && inVoice(f.ct));
  // 字幕：每段第一次出现时的播放位置 vs 该段第一个词在音频中的起点
  const segEvents = events.filter((e) => e.type === 'seg');
  const subOffsets = timings.map((tm, i) => { const e = segEvents.find((x) => x.i === i); return e ? Math.round((e.ct - tm.start) * 1000) : null; });
  // 字幕段起点与音频中最近一次“停顿结束”的差（独立于时间戳的校验）
  const pauseEnds = [firstVoice, ...sil.map((s) => s.e)];
  const segVsPause = timings.slice(1).map((tm) => { const near = pauseEnds.reduce((a, b) => (Math.abs(b - tm.start) < Math.abs(a - tm.start) ? b : a)); return Math.round((tm.start - near) * 1000); });
  const row = {
    voice, chars: text.length, result: r, cached: !text.startsWith('现在是检查时间'), durSec: Math.round(dur * 100) / 100, segments: segs.length,
    mouthStartVsAudioStartMs: talkOnEv ? Math.round((talkOnEv.ct - firstVoice) * 1000) : null,
    mouthStartAfterPlayingEventMs: talkOnEv && playingEv ? Math.round(talkOnEv.at - playingEv.at) : null,
    mouthStopVsAudioEndMs: talkOffEv ? Math.round((talkOffEv.ct - lastVoice) * 1000) : null,
    mouthBeforeAudioFrames: trace.filter((f) => f.talk && (!f.playing || f.ct < firstVoice - 0.02)).length,
    mouthAfterEndFrames: trace.filter((f) => f.talk && f.ct > lastVoice + 0.2).length,
    pausesOver250ms: pauses.length, mouthMovingInPausesPct: pf.length ? Math.round((pf.filter((f) => f.talk).length / pf.length) * 100) : null,
    mouthMovingWhileVoicedPct: vf.length ? Math.round((vf.filter((f) => f.talk).length / vf.length) * 100) : null,
    subtitleShownBeforeAudio: trace.some((f) => f.vis && !f.playing && f.ct === 0),
    subtitleOffsetsMs: subOffsets,
    segStartVsAudioPauseMs: segVsPause,
    timingsLoaded: events.some((e) => e.type === 'timings'),
  };
  result.sync.push(row);
  console.log('同步', JSON.stringify(row));
  await page.waitForTimeout(400);
}
await browser.close();
// 删除检查用的临时句子缓存，避免混进预合成缓存
for (const [v, t] of texts.filter(([, t]) => t.startsWith('现在是检查时间'))) {
  const k = cacheKey(resolveVoice(v), speakable(t));
  for (const f of fs.readdirSync(CACHE_DIR)) if (f.startsWith(k)) fs.rmSync(`${CACHE_DIR}/${f}`);
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(result, null, 2));
console.log('报告：', `${OUT}/report.json`);
