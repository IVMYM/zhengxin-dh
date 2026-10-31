// 音量门控说话视频样片：用页面同一份逻辑（public/gate-core.js）模拟播放一段真实播报音频，
// 再用原视频的真实帧合成 mp4（白底，混入同一段 TTS 音频），用来逐帧检查有没有跳帧、重影。
// 用法：node scripts/render-gate-sample.mjs [头像id] [输出.mp4] [要说的话]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../public/gate-core.js';
import '../public/sync.js';
import { resolveVoice, cachedFile, synthesizeToCache, readMeta } from '../lib/tts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = globalThis.DHGate;
const avatar = process.argv[2] || 'xiaoxin';
const out = path.resolve(process.argv[3] || path.join(ROOT, 'out', 'audio-gate-sample.mp4'));
const text = process.argv[4] || '您好，我是小信。查询个人信用报告，可以带上本人身份证，到柜台或者自助查询机办理，也可以在手机银行上查询。';

const voice = resolveVoice('female');
let mp3 = cachedFile(voice, text);
if (!mp3) { await synthesizeToCache(voice, text); mp3 = cachedFile(voice, text); }
if (!mp3) { console.error('TTS 合成失败'); process.exit(1); }
const SR = 48000;
const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', mp3, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
const s = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.length / 4);
const dur = s.length / SR;
const rmsAt = (t) => { const i0 = Math.round(t * SR) - 512; let q = 0, n = 0; for (let i = Math.max(0, i0); i < Math.min(s.length, i0 + 512); i++) { q += s[i] * s[i]; n++; } return n ? Math.sqrt(q / n) : 0; };

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'media', 'gate', `${avatar}.json`), 'utf8'));
const fps = meta.fps;
// 模拟浏览器里的 <video>：按播放速度走帧
const deck = { pos: 0, playing: false, rate: 1,
  frame() { return this.pos; }, play() { this.playing = true; }, pause() { this.playing = false; },
  seek(f) { this.pos = f + 0.5; }, setRate(r) { this.rate = r; },
  step(dt) { if (this.playing) this.pos = (this.pos + this.rate * fps * dt) % meta.n; } };
const words = globalThis.DHSync.audibleWords((await readMeta(voice, text, 0) || {}).words); // 换算成真正出声的时间（与页面相同）
const pauses = process.env.NO_WORDS ? null : G.pausesFrom(words);
const gate = new G.VoiceGate();
const player = new G.GatePlayer(meta, deck);
const TICK = 1 / 60; const lead = 0.6; const tail = 1.4;
let wrap = 0; let wasVis = false; let idlePos = 0; let t = -lead; let nextOut = 0; const frames = []; const states = {}; const rates = [];
while (t < dur + tail) {
  const active = t >= 0 && t < dur;
  const r = active ? rmsAt(t) : 0;
  gate.update(r, TICK * 1000);
  const vis = player.tick((t + lead) * 1000, { t: Math.max(0, t), pauses, speaking: gate.speaking(), active });
  // 页面逻辑：收尾前先把（被说话层盖住的）待机视频拨回第 0 帧（与收尾闭嘴帧姿势一致），再用 CSS 0.15s 线性淡出
  if (!vis && wasVis) idlePos = 0;
  wasVis = vis;
  wrap = vis ? Math.min(1, wrap + TICK / 0.15) : Math.max(0, wrap - TICK / 0.15);
  deck.step(TICK); if (deck.playing) rates.push(deck.rate);
  idlePos += fps * TICK;
  while (nextOut / fps <= t + lead) {
    frames.push({ idle: Math.floor(idlePos), wrap: +wrap.toFixed(3), decks: [{ f: Math.floor(deck.pos) % meta.n, a: 1 }], state: player.state, rms: +r.toFixed(3), closed: G.isClosed(meta, deck.pos) });
    states[player.state] = (states[player.state] || 0) + 1;
    nextOut++;
  }
  t += TICK;
}
const outfit = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'outfits.json'), 'utf8')).outfits.find((o) => (o.lipsyncAvatar || o.id) === avatar);
const plan = path.join(os.tmpdir(), `gate-plan-${avatar}-${process.pid}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(plan, JSON.stringify({ idle: path.join(ROOT, 'public', outfit.idle.slice(1)), talk: path.join(ROOT, 'public', outfit.talk.slice(1)), fps, lead, audio: mp3, out, frames }));
const res = spawnSync('python3', [path.join(ROOT, 'scripts', 'render-gate-sample.py'), plan], { stdio: 'inherit' });
fs.rmSync(plan, { force: true });
fs.writeFileSync(out.replace(/\.mp4$/, '.frames.json'), JSON.stringify(frames));
// 停顿里嘴是否闭着：每个停顿区间中间时刻那一帧
const pauseCheck = (pauses || []).filter((p) => p.end !== Infinity).map((p) => { const fr = frames[Math.round(((p.start + p.end) / 2 + lead) * fps)]; return fr ? fr.closed : null; });
console.log(`样片 ${out}：${frames.length} 帧（${JSON.stringify(states)}），音频 ${dur.toFixed(2)} 秒；句中停顿闭嘴 ${pauseCheck.filter(Boolean).length}/${pauseCheck.length}；播放速度 ${Math.min(...rates).toFixed(2)}~${Math.max(...rates).toFixed(2)}`);
process.exit(res.status || 0);
