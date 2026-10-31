import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = path.join(ROOT, 'cache', 'tts');
const SCRIPT = path.join(ROOT, 'scripts', 'tts_stream.py');
// 装了 edge-tts 的 Python：PATH 里第一个 python3 不一定装了（Mac 上 Homebrew 的 python3 在前面，edge-tts 装在系统 /usr/bin/python3），
// 选错了每句实时合成都会失败，页面退回浏览器朗读（声音和嘴型都不对）。启动时逐个试，选第一个能 import edge_tts 的。
export function findPython(candidates) {
  for (const p of candidates) {
    try { if (spawnSync(p, ['-c', 'import edge_tts'], { stdio: 'ignore', timeout: 8000 }).status === 0) return p; } catch {}
  }
  return null;
}
// 环境变量 PYTHON 指定了就用它（不探测）
export const PYTHON = process.env.PYTHON || findPython(['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python']) || 'python3';
if (!process.env.PYTHON) console.log(`[tts] edge-tts 使用 ${PYTHON}`);

export const VOICES = {
  female: { id: 'zh-CN-XiaoxiaoNeural', label: '女声 · 晓晓', rate: '+0%', pitch: '+0Hz' },
  female2: { id: 'zh-CN-XiaoyiNeural', label: '女声 · 晓伊', rate: '+0%', pitch: '+0Hz' },
};
// 只有女性形象，所以只保留女声；旧数据里的 male / 云扬 / 云希 等一律改用晓晓
export const FALLBACK_VOICE = 'female';

/** 把任意音色写法（key 或 edge-tts id）规范成允许的女声 key；男声或未知值回落到晓晓 */
export function normalizeVoiceKey(key) {
  const k = String(key || '').trim();
  if (Object.prototype.hasOwnProperty.call(VOICES, k)) return k;
  const byId = Object.entries(VOICES).find(([, v]) => v.id.toLowerCase() === k.toLowerCase());
  return byId ? byId[0] : FALLBACK_VOICE;
}
export const DEFAULT_VOICE = normalizeVoiceKey(process.env.TTS_VOICE_KEY || FALLBACK_VOICE);

export function resolveVoice(key) {
  return VOICES[normalizeVoiceKey(key || DEFAULT_VOICE)];
}

/** 朗读前的文本整理：去掉网址等不适合朗读的内容，数字读法更自然 */
export function speakable(text) {
  return String(text || '')
    .replace(/www\.pbccrc\.org\.cn/g, '征信中心官网')
    .replace(/www\.zhongdengwang\.org\.cn/g, '中登网')
    .replace(/\*+/g, '')
    .trim();
}

export function cacheKey(voice, text) {
  return createHash('sha1').update(`${voice.id}|${voice.rate}|${voice.pitch}|${text}`).digest('hex');
}

const mp3Path = (voice, text) => path.join(CACHE_DIR, `${cacheKey(voice, text)}.mp3`);
const metaPath = (voice, text) => path.join(CACHE_DIR, `${cacheKey(voice, text)}.json`);

export function cachedFile(voice, text) {
  const f = mp3Path(voice, text);
  return fs.existsSync(f) ? f : null;
}

/** 同一句话在其他音色下的缓存（实时合成失败时兜底，保证数字人不会哑） */
export function cachedFallback(voice, text) {
  const order = [DEFAULT_VOICE, 'female', 'female2'].map((k) => VOICES[k]).filter((v) => v && v.id !== voice.id);
  for (const v of order) {
    const f = cachedFile(v, text);
    if (f && fs.existsSync(metaPath(v, text))) return { voice: v, file: f, meta: metaPath(v, text) };
  }
  for (const v of order) { const f = cachedFile(v, text); if (f) return { voice: v, file: f, meta: null }; }
  return null;
}

/** 解析 tts_stream.py 写到 stderr 的逐词时间戳 */
export function parseBoundaryLines(raw) {
  const words = [];
  for (const line of String(raw).split('\n')) {
    if (!line.startsWith('WB\t')) continue;
    try {
      const o = JSON.parse(line.slice(3));
      if (typeof o.t === 'number' && typeof o.d === 'number' && o.w) words.push({ t: o.t, d: o.d, w: String(o.w) });
    } catch {}
  }
  return words;
}

// 正在合成中的句子：key → Promise<meta|null>，供 /api/tts/meta 等待
const inflight = new Map();

/** 读取逐词时间戳：已缓存直接返回；正在合成（或音频请求稍后才到）时最多等待 waitMs */
export async function readMeta(voice, text, waitMs = 0) {
  const f = metaPath(voice, text);
  const key = cacheKey(voice, text);
  const until = Date.now() + waitMs;
  for (;;) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    const p = inflight.get(key);
    const left = until - Date.now();
    if (left <= 0) return fallbackMeta(voice, text);
    if (p) {
      const m = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), left))]);
      return m || fallbackMeta(voice, text);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function fallbackMeta(voice, text) {
  const fb = cachedFallback(voice, text);
  if (!fb || !fb.meta) return null;
  try { return JSON.parse(fs.readFileSync(fb.meta, 'utf8')); } catch { return null; }
}

/** 这句话正在合成：返回等待合成结束的 Promise（结果为时间戳 meta 或 null），否则 null */
export function pendingSynthesis(voice, text) { return inflight.get(cacheKey(voice, text)) || null; }

/**
 * 启动合成进程，返回子进程（stdout 为 MP3 流）；完成后把音频和逐词时间戳写入缓存，
 * 下次同样的句子直接读缓存（离线可用）。
 */
export function synthesize(voice, text) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(voice, text);
  const target = mp3Path(voice, text);
  const metaTarget = metaPath(voice, text);
  const tmp = `${target}.${process.pid}.${Date.now()}.part`;
  const child = spawn(PYTHON, [SCRIPT, voice.id, voice.rate, voice.pitch], { stdio: ['pipe', 'pipe', 'pipe'] });
  const file = fs.createWriteStream(tmp);
  let bytes = 0;
  let stderr = '';
  let resolveMeta;
  inflight.set(key, new Promise((r) => { resolveMeta = r; }));
  child.stdout.on('data', (d) => { bytes += d.length; file.write(d); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', () => {});
  child.on('close', (code) => {
    file.end(() => {
      const words = parseBoundaryLines(stderr);
      if (code === 0 && bytes > 1000) {
        const meta = { v: 1, voice: voice.id, text, words };
        try { fs.writeFileSync(metaTarget, JSON.stringify(meta)); } catch {}
        fs.rename(tmp, target, () => {});
        resolveMeta(meta);
      } else {
        fs.rm(tmp, { force: true }, () => {});
        if (code !== 0 && code !== null) console.warn('[tts] 合成失败', voice.id, text.slice(0, 16), code, stderr.split('\n').filter((l) => !l.startsWith('WB\t')).slice(-3).join(' '));
        resolveMeta(null);
      }
      setTimeout(() => inflight.delete(key), 30000);
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(text);
  return child;
}

/** 合成整段并等待完成（预热缓存使用）。音频和时间戳都已缓存才算命中，force 时强制重合成 */
export function synthesizeToCache(voice, text, { force = false } = {}) {
  return new Promise((resolve) => {
    if (!force && cachedFile(voice, text) && fs.existsSync(metaPath(voice, text))) return resolve('cached');
    const child = synthesize(voice, text);
    child.on('close', (code) => setTimeout(() => resolve(code === 0 ? 'ok' : 'fail'), 80));
  });
}

/** 预热 edge-tts：启动时合成一句短话，拉起 Python/WebSocket，降低首句首字节时延 */
let warmPromise = null;
export function warmTts(voice = resolveVoice(DEFAULT_VOICE)) {
  if (warmPromise) return warmPromise;
  const text = '嗯。';
  warmPromise = synthesizeToCache(voice, text).then((r) => {
    console.log(`[tts] 预热 ${r}`);
    return r;
  }).catch((e) => { console.warn('[tts] 预热失败', e && e.message); return 'fail'; });
  return warmPromise;
}
