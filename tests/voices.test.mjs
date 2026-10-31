import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VOICES, normalizeVoiceKey, resolveVoice, DEFAULT_VOICE } from '../lib/tts.mjs';
import { migrateVoices } from '../lib/playlist.mjs';

const MALE_IDS = /Yun(yang|xi|jian|ze|feng|hao|ye|xia)|云扬|云希|云健|云泽|男声/i;

test('只保留女声：音色表里没有男声', () => {
  assert.deepEqual(Object.keys(VOICES).sort(), ['female', 'female2']);
  for (const v of Object.values(VOICES)) {
    assert.ok(!MALE_IDS.test(v.id + v.label), v.id);
    assert.match(v.label, /^女声/);
  }
  assert.equal(DEFAULT_VOICE, 'female');
});

test('男声、edge-tts 男声 id、未知值都回落到晓晓', () => {
  for (const k of ['male', 'zh-CN-YunyangNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', '', null, undefined, 'xxx']) {
    assert.equal(normalizeVoiceKey(k), 'female', String(k));
    assert.equal(resolveVoice(k).id, 'zh-CN-XiaoxiaoNeural', String(k));
  }
  assert.equal(normalizeVoiceKey('female2'), 'female2');
  assert.equal(normalizeVoiceKey('zh-CN-XiaoyiNeural'), 'female2');
});

test('播单迁移：男声条目改为晓晓并标记重新合成，女声不动', () => {
  const store = { playlists: [{ id: 'p', items: [
    { id: 'a', title: 'A', text: '甲', voice: 'male', synth: 'ready' },
    { id: 'b', title: 'B', text: '乙', voice: 'female2', synth: 'ready' },
    { id: 'c', title: 'C', text: '丙', voice: 'female', synth: 'ready' },
  ] }] };
  const changed = migrateVoices(store);
  assert.deepEqual(changed.map((x) => [x.id, x.from, x.to]), [['a', 'male', 'female']]);
  const [a, b, c] = store.playlists[0].items;
  assert.equal(a.voice, 'female'); assert.equal(a.synth, 'idle'); assert.equal(a.resynth, true);
  assert.equal(b.voice, 'female2'); assert.equal(b.synth, 'ready');
  assert.equal(c.synth, 'ready');
  assert.equal(migrateVoices(store).length, 0); // 幂等
});

test('前端音色选择里没有男声', () => {
  for (const f of ['public/panel.html', 'public/index.html', 'public/admin.html']) {
    if (!fs.existsSync(f)) continue;
    assert.ok(!MALE_IDS.test(fs.readFileSync(f, 'utf8')), f);
    assert.ok(!/value="male"/.test(fs.readFileSync(f, 'utf8')), f);
  }
});
