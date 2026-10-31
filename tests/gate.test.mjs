import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../public/gate-core.js';
import { SentenceSplitter } from '../lib/llm.mjs';
import { loadOutfits } from '../lib/outfits.mjs';
import { CACHE_DIR } from '../lib/tts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { VoiceGate, GatePlayer, pausesFrom, route, reach, isClosed, RATE_MIN, RATE_MAX } = globalThis.DHGate;
const gateMeta = (av) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'media', 'gate', `${av}.json`), 'utf8'));

test('逐词时间戳 → 停顿区间：第一个词之前、词间空隙 ≥150ms、最后一个词之后', () => {
  const p = pausesFrom([{ t: 0.1, d: 0.5 }, { t: 0.7, d: 0.3 }, { t: 1.3, d: 0.4 }, { t: 1.75, d: 0.2 }]);
  assert.deepEqual(p.map((x) => [+x.start.toFixed(2), x.end === Infinity ? 'end' : +x.end.toFixed(2)]), [[-Infinity, 0.1], [1, 1.3], [1.95, 'end']]);
  assert.deepEqual(pausesFrom([]), []);
});

test('声音门：字间低谷不算停顿，安静超过 150ms 才算', () => {
  const g = new VoiceGate();
  g.update(0.1, 16);
  for (let i = 0; i < 6; i++) g.update(0, 16); // 96ms
  assert.equal(g.speaking(), true);
  for (let i = 0; i < 4; i++) g.update(0, 16);
  assert.equal(g.speaking(), false);
});

test('路线：每个停顿都落在闭嘴帧，速度在 0.8~1.25 倍内；结尾优先落在与待机姿势一致的帧', () => {
  // 合成素材：每 10 帧一帧闭嘴，只有第 0 帧与待机一致
  const n = 100; const closed = [...Array(n)].map((_, i) => (i % 10 === 5 || i === 0 ? '1' : '0')).join('');
  const meta = { fps: 25, n, closed, endOk: '1' + '0'.repeat(n - 1) };
  const pauses = [{ start: 1.0, end: 1.3 }, { start: 2.5, end: 2.8 }, { start: 4.4, end: Infinity }];
  const r = route(meta, [0.5], 0, pauses);
  assert.equal(r.misses, 0);
  assert.equal(r.stops.length, 3);
  for (const s of r.stops) assert.equal(closed[s.frame], '1');
  assert.equal(r.stops[2].frame, 0);
  const rr = reach(meta, 0.5, 25, 1.0);
  assert.ok(rr.r >= RATE_MIN && rr.r <= RATE_MAX);
});

test('每套服装都有门控素材：闭嘴帧够用，帧数与说话视频一致', () => {
  for (const o of loadOutfits().outfits) {
    const m = gateMeta(o.lipsyncAvatar);
    assert.equal(m.closed.length, m.n, o.id);
    assert.ok(m.n >= 100, o.id);
    const c = [...m.closed].filter((x) => x === '1').length;
    assert.ok(c >= 10, `${o.id} 闭嘴帧只有 ${c}`);
    assert.ok(m.endOk && m.endOk.includes('1'), `${o.id} 没有与待机姿势一致的闭嘴帧`);
  }
});

/** 按页面逻辑模拟播放一段真实播报（逐词时间戳来自 TTS 缓存），返回每个句中停顿中点时嘴是否闭着 */
function simulate(meta, words, dur) {
  const fps = meta.fps;
  const deck = { pos: 0, playing: false, rate: 1, rates: [],
    frame() { return this.pos; }, play() { this.playing = true; }, pause() { this.playing = false; },
    seek(f) { this.pos = f + 0.5; }, setRate(r) { this.rate = r; } };
  const pauses = pausesFrom(words);
  const p = new GatePlayer(meta, deck);
  const mids = pauses.filter((x) => x.end !== Infinity).map((x) => (x.start + x.end) / 2);
  const closedAt = []; let mi = 0; const dt = 1 / 60;
  for (let t = 0; t < dur + 1; t += dt) {
    p.tick(t * 1000, { t, pauses, speaking: false, active: t < dur });
    if (deck.playing) { deck.pos = (deck.pos + deck.rate * fps * dt) % meta.n; deck.rates.push(deck.rate); }
    if (mi < mids.length && t >= mids[mi]) { closedAt.push(isClosed(meta, deck.pos)); mi++; }
  }
  return { closedAt, rates: deck.rates, state: p.state };
}

test('真实播报的时间戳：大多数句中停顿嘴是闭着的，速度只在 0.75~1.5 倍间变化，说完回到待机', () => {
  const metas = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')))
    .filter((m) => m.words && m.words.length > 15).slice(0, 12);
  assert.ok(metas.length >= 3);
  let ok = 0, all = 0;
  for (const av of ['xiaoxin', 'qipao', 'spring_blouse']) {
    const meta = gateMeta(av);
    for (const tm of metas) {
      const last = tm.words.at(-1); const dur = last.t + last.d + 0.3;
      const r = simulate(meta, tm.words, dur);
      ok += r.closedAt.filter(Boolean).length; all += r.closedAt.length;
      assert.ok(Math.min(...r.rates) >= 0.75 - 1e-9 && Math.max(...r.rates) <= 1.5 + 1e-9);
      assert.equal(r.state, 'off');
    }
  }
  assert.ok(all > 20);
  assert.ok(ok / all >= 0.7, `停顿闭嘴比例 ${ok}/${all}`);
});

test('首句在第一个够长的逗号处送出，尽快开口', () => {
  const out = []; const sp = new SentenceSplitter((x) => out.push(x));
  for (const ch of '个人信用报告可以免费查询，每年有两次机会。还可以在手机银行查') sp.push(ch);
  sp.end();
  assert.deepEqual(out, ['个人信用报告可以免费查询，', '每年有两次机会。', '还可以在手机银行查']);
  const short = []; const sp2 = new SentenceSplitter((x) => short.push(x));
  sp2.push('好的，'); assert.equal(short.length, 0);
});

test('逐词时间戳换算成真正出声的时间：开始推后约 0.09 秒，结束推后 0.01 秒', async () => {
  await import('../public/sync.js');
  const [w] = globalThis.DHSync.audibleWords([{ t: 0.1, d: 0.3, w: '您' }]);
  assert.equal(+w.t.toFixed(3), 0.19);
  assert.equal(+(w.t + w.d).toFixed(3), 0.41);
});

test('回答开头的静音里不动嘴：先显示起始闭嘴帧停住，出声那一刻才开播；说完立刻停', () => {
  const meta = gateMeta('xiaoxin');
  const deck = { pos: 0, playing: false, rate: 1, frame() { return this.pos; }, play() { this.playing = true; }, pause() { this.playing = false; }, seek(f) { this.pos = f + 0.5; }, setRate(r) { this.rate = r; } };
  const words = [{ t: 0.2, d: 0.4 }, { t: 0.6, d: 0.5 }, { t: 1.1, d: 0.6 }, { t: 1.7, d: 0.5 }, { t: 2.2, d: 0.6 }, { t: 2.8, d: 0.6 }];
  const pauses = pausesFrom(words);
  const p = new GatePlayer(meta, deck);
  let vis = p.tick(1000, { t: 0.05, pauses, speaking: false, active: true });
  assert.equal(vis, true); assert.equal(p.state, 'hold'); assert.equal(deck.playing, false);
  p.tick(1100, { t: 0.15, pauses, speaking: false, active: true });
  assert.equal(deck.playing, false);
  p.tick(1150, { t: 0.2, pauses, speaking: false, active: true });
  assert.equal(deck.playing, true);
  for (let t = 0.2; t < 3.6; t += 1 / 60) { p.tick(1000 + t * 1000, { t, pauses, speaking: false, active: true }); if (deck.playing) deck.pos = (deck.pos + deck.rate * meta.fps / 60) % meta.n; }
  assert.equal(deck.playing, false); // 3.4 秒最后一个字说完后停住
  assert.ok(isClosed(meta, deck.pos));
});
