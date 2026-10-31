import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOutfits, rotation, nextOutfit, matchOutfit, lipsyncAvatars } from '../lib/outfits.mjs';
import { route } from '../lib/router.mjs';
import { answer, answerStream, OUTFIT_REPLY } from '../lib/brain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFF = { enabled: false };

test('服装清单：默认是藏青套装，每套素材文件都在', () => {
  const { default: def, outfits } = loadOutfits();
  assert.equal(def, 'navy');
  assert.ok(rotation(outfits).length >= 20);
  for (const o of outfits) {
    for (const k of ['idle', 'talk', 'poster']) assert.ok(fs.existsSync(path.join(ROOT, 'public', o[k])), `${o.id} ${k} 缺文件`);
  }
});

test('轮换：循环，sensitive 默认排除、打开后才出现', () => {
  const tmp = path.join(os.tmpdir(), `outfits-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ default: 'a', outfits: [
    { id: 'a', name: 'A', idle: '/a.mp4' }, { id: 'b', name: 'B', idle: '/b.mp4', talk: '/bt.mp4' },
    { id: 'hidden', name: 'H', idle: '/h.mp4', sensitive: true, keywords: ['隐藏'] }, { id: 'BAD id', idle: '/x.mp4' },
  ] }));
  const { outfits } = loadOutfits(tmp);
  fs.unlinkSync(tmp);
  assert.deepEqual(outfits.map((o) => o.id), ['a', 'b', 'hidden']);
  assert.equal(outfits[0].talk, '/a.mp4', '没有说话视频时用待机视频');
  assert.equal(nextOutfit(outfits, 'a').id, 'b');
  assert.equal(nextOutfit(outfits, 'b').id, 'a');
  assert.equal(nextOutfit(outfits, 'b', { sensitive: true }).id, 'hidden');
  assert.equal(nextOutfit(outfits, 'zzz').id, 'a');
  assert.equal(matchOutfit(outfits, '换成隐藏的'), null);
  assert.equal(matchOutfit(outfits, '换成隐藏的', { sensitive: true }).id, 'hidden');
  assert.ok(lipsyncAvatars(outfits).has('b'));
});

test('“换一套”等口令走本地换装意图，不误伤业务问题', () => {
  for (const t of ['换一套', '小信换一套衣服', '换个造型', '换成旗袍', '再换', '换回原来的']) assert.equal(route(t).intent, 'outfit', t);
  for (const t of ['信用报告怎么查', '换卡了征信会变吗', '你好']) assert.notEqual(route(t).intent, 'outfit', t);
});

test('换装答复：好的，我换一套；指定款式带服装 id', async () => {
  const a = await answer('换一套', { llm: OFF });
  assert.equal(a.speech, OUTFIT_REPLY); assert.equal(a.action, 'outfit'); assert.equal(a.outfit, null);
  const b = await answer('换成旗袍', { llm: OFF });
  assert.equal(b.outfit, 'qipao');
  const c = await answer('换回原来的', { llm: OFF });
  assert.equal(c.outfit, 'navy');
  const evs = [];
  const d = await answerStream('换一身', { llm: OFF }, (e) => evs.push(e));
  assert.equal(d.action, 'outfit'); assert.equal(evs.at(-1).type, 'done');
});
