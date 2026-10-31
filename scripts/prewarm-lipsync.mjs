// 为所有已缓存的固定话术预生成口型同步视频（cache/lipsync/），GPU 链路断开时展厅仍可对口型。
// 用法：LIPSYNC_URL=http://<GPU 主机>:8787 node scripts/prewarm-lipsync.mjs [female,female2]
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, VOICES } from '../lib/tts.mjs';
import { ensureClip, cachedClip, lipsyncUrl, serviceHealth, state } from '../lib/lipsync.mjs';

if (!lipsyncUrl()) { console.error('未设置 LIPSYNC_URL'); process.exit(1); }
const h = await serviceHealth(8000);
if (!h) { console.error('口型服务不可达：', lipsyncUrl()); process.exit(1); }
console.log('口型服务：', h.model, h.gpu);
const keys = (process.argv[2] || 'female,female2').split(',');
const metas = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'))
  .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
let fail = 0;
for (const k of keys) {
  const voice = VOICES[k]; if (!voice) continue;
  const list = metas.filter((m) => m.voice === voice.id);
  let ok = 0, cached = 0, bad = 0; const t0 = Date.now();
  for (const m of list) {
    if (cachedClip(voice, m.text)) { cached++; continue; }
    const r = await ensureClip(voice, m.text, { mp3WaitMs: 0 });
    if (r) { ok++; process.stdout.write('.'); } else { bad++; process.stdout.write('x'); }
  }
  fail += bad;
  console.log(`\n${voice.label}: 新生成 ${ok}，已缓存 ${cached}，失败 ${bad}，用时 ${Math.round((Date.now() - t0) / 1000)}s，最近速度 x${state.lastRatio}`);
}
if (fail) process.exitCode = 1;
