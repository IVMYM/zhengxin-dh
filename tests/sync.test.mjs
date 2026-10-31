import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { parseBoundaryLines, resolveVoice, speakable, cacheKey, cachedFallback, CACHE_DIR } from '../lib/tts.mjs';
import { KB } from '../lib/kb.mjs';
import '../public/sync.js';

const { wakeMatch, splitSubtitle, alignSegments, segmentAt, voicedAt } = globalThis.DHSync;

test('唤醒词：识别中间结果里的常见说法都能唤醒', () => {
  for (const t of ['你好', '你好啊', '您好', '你好小信', '小信你好', 'ni hao', 'nihao', '你号', '哈喽', 'hello', '你好，我想问一下']) assert.ok(wakeMatch(t), t);
  for (const t of ['', '你', '好的', '我想查征信', '谢谢', '再见']) assert.ok(!wakeMatch(t), t);
});

test('字幕按逐词时间戳切换，网址改读也能对齐', () => {
  const text = '您好，我是小信。请登录www.pbccrc.org.cn，验证后提交。谢谢！';
  const segs = splitSubtitle(text);
  assert.equal(segs.length, 3);
  const words = [
    { t: 0.1, d: 0.5, w: '您好' }, { t: 0.8, d: 0.1, w: '我' }, { t: 0.9, d: 0.1, w: '是' }, { t: 1.0, d: 0.5, w: '小信' },
    { t: 2.2, d: 0.4, w: '请' }, { t: 2.8, d: 0.4, w: '登录' }, { t: 3.2, d: 1.2, w: '征信中心官网' },
    { t: 5.2, d: 0.4, w: '验证' }, { t: 5.6, d: 0.2, w: '后' }, { t: 5.8, d: 0.4, w: '提交' },
    { t: 6.8, d: 0.5, w: '谢谢' },
  ];
  const tm = alignSegments(segs, words);
  assert.deepEqual(tm.map((x) => x.start), [0.1, 2.2, 6.8]);
  assert.equal(segmentAt(tm, 0), 0);
  assert.equal(segmentAt(tm, 2.0), 0);
  assert.equal(segmentAt(tm, 2.15), 1); // 提前约 0.08 秒出字
  assert.equal(segmentAt(tm, 6.5), 1);
  assert.equal(segmentAt(tm, 7), 2);
  assert.ok(voicedAt(words, 1.2));
  assert.ok(!voicedAt(words, 1.8)); // 句间停顿不算发声
});

test('没有时间戳的段落按前后段插值，不会乱序', () => {
  const segs = ['第一句。', '第二句。', '第三句。'];
  const tm = alignSegments(segs, [{ t: 0.2, d: 0.6, w: '第一句' }, { t: 3, d: 0.6, w: '第三句' }]);
  assert.ok(tm[1].start >= tm[0].start && tm[1].start <= tm[2].start);
});

test('解析 tts_stream.py 输出的逐词时间戳', () => {
  const raw = 'WB\t{"t": 0.1, "d": 0.4875, "w": "您好"}\nsome warning\nWB\t{"t": 0.8125, "d": 0.125, "w": "我"}\nWB\tbad json\n';
  assert.deepEqual(parseBoundaryLines(raw), [{ t: 0.1, d: 0.4875, w: '您好' }, { t: 0.8125, d: 0.125, w: '我' }]);
});

test('预合成缓存：知识库话术两种女声都有音频和时间戳', () => {
  for (const key of ['female', 'female2']) {
    const voice = resolveVoice(key);
    for (const e of KB) {
      const k = cacheKey(voice, speakable(e.speech));
      assert.ok(fs.existsSync(`${CACHE_DIR}/${k}.mp3`), `${key} ${e.id} 缺少音频`);
      const meta = JSON.parse(fs.readFileSync(`${CACHE_DIR}/${k}.json`, 'utf8'));
      assert.ok(meta.words.length > 5, `${key} ${e.id} 缺少时间戳`);
      const segs = splitSubtitle(e.speech);
      const tm = alignSegments(segs, meta.words);
      for (let i = 1; i < tm.length; i++) assert.ok(tm[i].start >= tm[i - 1].start, `${key} ${e.id} 字幕时间倒序`);
    }
  }
});

test('实时合成失败时改用其他音色的缓存，播报不会没声音', async () => {
  const text = `兜底测试${process.pid}。这句话只缓存了女声。`;
  const female = resolveVoice('female');
  const k = cacheKey(female, text);
  const src = fs.readdirSync(CACHE_DIR).find((f) => f.endsWith('.mp3'));
  fs.copyFileSync(`${CACHE_DIR}/${src}`, `${CACHE_DIR}/${k}.mp3`);
  fs.writeFileSync(`${CACHE_DIR}/${k}.json`, JSON.stringify({ v: 1, words: [{ t: 0.1, d: 0.5, w: '兜底' }] }));
  assert.equal(cachedFallback(resolveVoice('female2'), text).voice.id, female.id);
  const port = 43000 + (process.pid % 500);
  const srv = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), PYTHON: '/bin/false' }, stdio: 'pipe' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${port}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const q = `voice=female2&text=${encodeURIComponent(text)}`;
    const r = await fetch(`http://localhost:${port}/api/tts?${q}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-tts-voice'), female.id);
    assert.ok((await r.arrayBuffer()).byteLength > 1000);
    const m = await fetch(`http://localhost:${port}/api/tts/meta?${q}`);
    assert.equal(m.status, 200);
    assert.equal((await m.json()).words[0].w, '兜底');
    const none = await fetch(`http://localhost:${port}/api/tts?voice=female2&text=${encodeURIComponent('没有任何缓存的句子' + process.pid)}`);
    assert.equal(none.status, 502); // 前端收到错误后改用浏览器朗读或仅字幕
  } finally {
    srv.kill();
    for (const f of fs.readdirSync(CACHE_DIR)) if (f.startsWith(k)) fs.rmSync(`${CACHE_DIR}/${f}`);
  }
});
