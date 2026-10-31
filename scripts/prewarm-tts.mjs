// 预先合成所有固定话术的语音和逐词时间戳，缓存到 cache/tts/（xxx.mp3 + xxx.json），现场断网时这些答复依然有声音、字幕仍与声音同步。
// 用法：node scripts/prewarm-tts.mjs [female,male] [--force] [--prune]
//   --force  全部重新合成；--prune 删除不再使用的旧缓存文件
import fs from 'node:fs';
import path from 'node:path';
import { KB, SMALLTALK, KIOSK_STEPS, ATTRACT_TIPS, ATTRACT_GREET } from '../lib/kb.mjs';
import { VOICES, resolveVoice, speakable, synthesizeToCache, cacheKey, CACHE_DIR } from '../lib/tts.mjs';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const prune = argv.includes('--prune');
const keys = (argv.find((a) => !a.startsWith('--')) || 'female,female2').split(',');
const texts = new Set();
for (const e of KB) texts.add(e.speech);
for (const v of Object.values(SMALLTALK)) texts.add(v.speech);
texts.add(ATTRACT_GREET);
for (const s of KIOSK_STEPS) texts.add(s.speech);
for (const t of ATTRACT_TIPS) texts.add(`信用小知识。${t.t}。${t.d}。`);
texts.add('好的，已退出查询指引。您还可以继续问我其他问题。');
texts.add('查询指引已完成。如需打印报告，可前往右侧自助查询机办理。');
texts.add('好的，我带您一步一步在自助查询机上查询。');
texts.add('抱歉，我没有听清，请您再说一遍，或者点击下方的问题。');
texts.add('好的，我想一想。');
texts.add('网络开小差了，请稍后再试，或咨询大堂经理。');

const keep = new Set();
let failed = 0;
for (const k of keys) {
  if (!VOICES[k]) { console.warn('未知音色', k); continue; }
  const voice = resolveVoice(k);
  let ok = 0, fail = 0, cached = 0;
  for (const t of texts) {
    const s = speakable(t);
    keep.add(cacheKey(voice, s));
    let r = await synthesizeToCache(voice, s, { force });
    if (r === 'fail') r = await synthesizeToCache(voice, s, { force: true }); // 网络抖动重试一次
    if (r === 'ok') ok++; else if (r === 'cached') cached++; else fail++;
  }
  failed += fail;
  console.log(`${voice.label}: 新合成 ${ok}，已缓存 ${cached}，失败 ${fail}`);
}
if (prune && failed === 0) {
  let n = 0;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const k = f.split('.')[0];
    if (!keep.has(k)) { fs.rmSync(path.join(CACHE_DIR, f)); n++; }
  }
  console.log(`清理旧缓存 ${n} 个文件`);
}
if (failed) process.exitCode = 1;
