// 导出离线预渲染口型视频的任务清单：所有固定话术（与 prewarm-tts.mjs 同一份）× 指定头像。
// 用法：node scripts/export-lipsync-jobs.mjs <输出目录> [female] [xiaoxin,qipao|all]
//   在 <输出目录>/audio/ 放入每句的 mp3（来自 cache/tts/，缺的先实时合成），写出 jobs.json。
// 视频按 cache/lipsync/<头像>-<AVATAR_REV>/<cacheKey>.mp4 命名，渲染完解压到 cache/lipsync/ 即可被页面直接使用。
import fs from 'node:fs';
import path from 'node:path';
import { KB, SMALLTALK, KIOSK_STEPS, ATTRACT_TIPS, ATTRACT_GREET } from '../lib/kb.mjs';
import { resolveVoice, speakable, synthesizeToCache, cacheKey, cachedFile } from '../lib/tts.mjs';
import { loadOutfits, lipsyncAvatars } from '../lib/outfits.mjs';
import { AVATAR_REV } from '../lib/lipsync.mjs';

const [outDir, voiceKey = 'female', avArg = 'xiaoxin'] = process.argv.slice(2);
if (!outDir) { console.error('用法：node scripts/export-lipsync-jobs.mjs <输出目录> [female] [xiaoxin|all]'); process.exit(1); }
export function fixedTexts() {
  const t = new Set();
  for (const e of KB) t.add(e.speech);
  for (const v of Object.values(SMALLTALK)) t.add(v.speech);
  t.add(ATTRACT_GREET);
  for (const s of KIOSK_STEPS) t.add(s.speech);
  for (const x of ATTRACT_TIPS) t.add(`信用小知识。${x.t}。${x.d}。`);
  for (const s of ['好的，已退出查询指引。您还可以继续问我其他问题。', '查询指引已完成。如需打印报告，可前往右侧自助查询机办理。',
    '好的，我带您一步一步在自助查询机上查询。', '抱歉，我没有听清，请您再说一遍，或者点击下方的问题。', '好的，我想一想。', '网络开小差了，请稍后再试，或咨询大堂经理。']) t.add(s);
  return [...t].map(speakable);
}
const voice = resolveVoice(voiceKey);
const avatars = avArg === 'all' ? [...lipsyncAvatars(loadOutfits().outfits)] : avArg.split(',');
fs.mkdirSync(path.join(outDir, 'audio'), { recursive: true });
const texts = fixedTexts();
const clips = [];
let synthesized = 0, missing = 0;
for (const text of texts) {
  let f = cachedFile(voice, text);
  if (!f) { const r = await synthesizeToCache(voice, text); f = cachedFile(voice, text); if (r === 'ok') synthesized++; }
  if (!f) { missing++; console.warn('缺音频：', text.slice(0, 20)); continue; }
  const key = cacheKey(voice, text);
  fs.copyFileSync(f, path.join(outDir, 'audio', `${key}.mp3`));
  clips.push({ key, text });
}
const jobs = { voice: voice.id, rev: AVATAR_REV, avatars, clips };
fs.writeFileSync(path.join(outDir, 'jobs.json'), JSON.stringify(jobs, null, 1));
console.log(`句子 ${clips.length}（新合成 ${synthesized}，缺 ${missing}）× 头像 ${avatars.length} = ${clips.length * avatars.length} 段`);
if (missing) process.exitCode = 1;
