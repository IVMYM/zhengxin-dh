// 口型同步：把 TTS 音频交给 GPU 口型服务（MuseTalk），生成与声音逐帧对上的说话视频并缓存。
// 服务地址：环境变量 LIPSYNC_URL 或 config/site.json 的 lipsyncUrl；未配置、服务不可达或超时，
// 页面自动退回“有声音就动嘴”的循环视频，展厅不会卡住。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheKey, cachedFile } from './tts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIPSYNC_DIR = path.join(ROOT, 'cache', 'lipsync');
// 默认头像（藏青套装）；换装后由页面传当前服装的头像 id，口型缓存按头像分目录
export const DEFAULT_AVATAR = process.env.LIPSYNC_AVATAR || 'xiaoxin';
const AV_RE = /^[a-z0-9_]{1,40}$/;
const av = (a) => (a && AV_RE.test(a) ? a : DEFAULT_AVATAR);
// 头像素材版本：换素材后旧口型视频自动失效（full = 2026-10-31 全身站姿版）
export const AVATAR_REV = process.env.LIPSYNC_AVATAR_REV || 'full1';
const GEN_TIMEOUT_MS = Number(process.env.LIPSYNC_TIMEOUT_MS || 90000);
const MP3_WAIT_MS = 25000; // 新句子：等实时合成把 mp3 写进缓存
const DOWN_BACKOFF_MS = 30000;

export function lipsyncUrl() {
  if (process.env.LIPSYNC_URL !== undefined) return process.env.LIPSYNC_URL.replace(/\/+$/, '');
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8')).lipsyncUrl || '').replace(/\/+$/, ''); } catch { return ''; }
}

export const clipPath = (voice, text, avatar) => path.join(LIPSYNC_DIR, `${av(avatar)}-${AVATAR_REV}`, `${cacheKey(voice, text)}.mp4`);
export function cachedClip(voice, text, avatar) { const f = clipPath(voice, text, avatar); return fs.existsSync(f) ? f : null; }

// 离线预渲染的口型视频（cache/lipsync/<头像>-<rev>/*.mp4）：有就让页面启用口型播放，没有 GPU 服务也能用；
// 某句话没有视频时页面照旧用“有声音就动嘴”的循环视频
let preCheck = { at: 0, has: false };
export function hasPrerendered() {
  if (Date.now() - preCheck.at < 30000) return preCheck.has;
  let has = false;
  try {
    for (const d of fs.readdirSync(LIPSYNC_DIR)) {
      if (!d.endsWith(`-${AVATAR_REV}`)) continue;
      if (fs.readdirSync(path.join(LIPSYNC_DIR, d)).some((f) => f.endsWith('.mp4'))) { has = true; break; }
    }
  } catch {}
  preCheck = { at: Date.now(), has };
  return has;
}

const inflight = new Map();
let downUntil = 0;
let queue = Promise.resolve();
export const state = { lastError: null, generated: 0, lastRatio: null };

async function waitForMp3(voice, text, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const f = cachedFile(voice, text);
    if (f) return f;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function generate(base, avatar, mp3, target) {
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'speech.mp3');
  form.append('avatar', av(avatar));
  form.append('with_audio', '1');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GEN_TIMEOUT_MS);
  try {
    const t0 = Date.now();
    const r = await fetch(`${base}/lipsync`, { method: 'POST', body: form, signal: ctl.signal });
    if (!r.ok) throw new Error(`lipsync http ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10000) throw new Error('lipsync empty clip');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    state.generated++;
    const dur = Number(r.headers.get('x-duration')) || 0;
    state.lastRatio = dur ? +(dur / ((Date.now() - t0) / 1000)).toFixed(2) : null;
    return target;
  } finally { clearTimeout(timer); }
}

/**
 * 确保这句话的口型视频存在；返回文件路径，服务不可用时返回 null。
 * 同一句话并发请求只生成一次；发往 GPU 的请求串行排队。
 */
export function ensureClip(voice, text, { mp3WaitMs = MP3_WAIT_MS, avatar } = {}) {
  avatar = av(avatar);
  const hit = cachedClip(voice, text, avatar);
  if (hit) return Promise.resolve(hit);
  const base = lipsyncUrl();
  if (!base || Date.now() < downUntil) return Promise.resolve(null);
  const key = `${avatar}:${cacheKey(voice, text)}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    // 只用与页面播放的同一份 mp3 生成，保证画面与声音完全一致
    const mp3 = await waitForMp3(voice, text, mp3WaitMs);
    if (!mp3) return null;
    const job = queue.then(() => generate(base, avatar, mp3, clipPath(voice, text, avatar)));
    queue = job.catch(() => {});
    try { return await job; } catch (err) {
      state.lastError = String(err.message || err);
      downUntil = Date.now() + DOWN_BACKOFF_MS;
      console.warn('[lipsync] 生成失败，30 秒内改用循环口型：', state.lastError);
      return null;
    }
  })();
  inflight.set(key, p);
  p.finally(() => setTimeout(() => inflight.delete(key), 1000));
  return p;
}

/** 页面查询：ready（可播放）/ pending（生成中）/ off（未配置或不可用） */
export async function clipStatus(voice, text, waitMs = 0, avatar) {
  if (cachedClip(voice, text, avatar)) return 'ready';
  if (!lipsyncUrl() || Date.now() < downUntil) return 'off';
  const p = ensureClip(voice, text, { avatar });
  if (waitMs > 0) {
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(undefined), waitMs))]);
    if (r) return 'ready';
    if (r === null) return 'off';
  }
  return 'pending';
}

export async function serviceHealth(timeoutMs = 4000) {
  const base = lipsyncUrl();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
