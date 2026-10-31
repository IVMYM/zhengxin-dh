import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultStore, nextIndex, applyCursor, refillShuffleBag, parseImport,
  enabledItems, getPlaylist, saveStore, loadStore, PLAYLIST_FILE, publicItem,
  refreshSynthStatus,
} from '../lib/playlist.mjs';
import { resolveVoice, speakable, cacheKey, CACHE_DIR } from '../lib/tts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'data', 'playlist.test.json');

test('默认播单含约 8 条征信话术种子', () => {
  const s = defaultStore();
  assert.equal(s.playlists[0].items.length, 8);
  assert.ok(s.playlists[0].items.every((it) => it.title && it.text && !/\d{15,}/.test(it.text)));
});

test('顺序播放：播到最后一首结束则 stop', () => {
  const s = defaultStore();
  const pl = getPlaylist(s);
  const list = enabledItems(pl);
  applyCursor(s, { index: list.length - 1 });
  s.player.mode = 'sequence';
  const n = nextIndex(s, { ended: true });
  assert.equal(n.stop, true);
  assert.equal(n.id, list[list.length - 1].id);
});

test('列表循环：最后一首结束后回到第一首', () => {
  const s = defaultStore();
  const pl = getPlaylist(s);
  const list = enabledItems(pl);
  applyCursor(s, { index: list.length - 1 });
  s.player.mode = 'loop';
  const n = nextIndex(s, { ended: true });
  assert.equal(n.stop, false);
  assert.equal(n.id, list[0].id);
});

test('单曲循环：结束后仍是当前首', () => {
  const s = defaultStore();
  const list = enabledItems(getPlaylist(s));
  applyCursor(s, { index: 2 });
  s.player.mode = 'single';
  const n = nextIndex(s, { ended: true });
  assert.equal(n.id, list[2].id);
  assert.equal(n.stop, false);
});

test('随机播放：洗牌袋不会立刻重复刚播完的一首', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (let i = 0; i < 40; i++) {
    const bag = refillShuffleBag(ids, 'a');
    assert.equal(bag.length, 5);
    assert.notEqual(bag[0], 'a');
  }
  const s = defaultStore();
  s.player.mode = 'shuffle';
  s.player.shuffleBag = [];
  applyCursor(s, { index: 0 });
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const n = nextIndex(s, { ended: true });
    applyCursor(s, n);
    seen.add(n.id);
    assert.ok(n.id);
  }
  assert.ok(seen.size >= 4);
});

test('导入：支持 标题|正文 与纯文本多行', () => {
  const items = parseImport('收费说明|互联网查询免费。\n不良记录保存五年。\n');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '收费说明');
  assert.match(items[1].text, /五年/);
});

test('禁用条目不参与播放队列', () => {
  const s = defaultStore();
  const pl = getPlaylist(s);
  pl.items[0].enabled = false;
  assert.equal(enabledItems(pl).length, pl.items.length - 1);
  applyCursor(s, { index: 0 });
  s.player.mode = 'loop';
  // current may be disabled — nextIndex uses enabled list
  s.player.currentId = enabledItems(pl)[0].id;
  const n = nextIndex(s, { ended: true });
  assert.ok(enabledItems(pl).some((it) => it.id === n.id));
});

test('持久化：写入再读回保持顺序与模式', () => {
  const prev = PLAYLIST_FILE;
  // 直接测 save/load 用临时文件：临时替换内容
  const s = defaultStore();
  s.player.mode = 'shuffle';
  s.player.gapMs = 1200;
  const ids = s.playlists[0].items.map((it) => it.id).reverse();
  const map = new Map(s.playlists[0].items.map((it) => [it.id, it]));
  s.playlists[0].items = ids.map((id) => map.get(id));
  const backup = fs.existsSync(PLAYLIST_FILE) ? fs.readFileSync(PLAYLIST_FILE, 'utf8') : null;
  try {
    saveStore(s);
    const loaded = loadStore();
    assert.equal(loaded.player.mode, 'shuffle');
    assert.equal(loaded.player.gapMs, 1200);
    assert.deepEqual(loaded.playlists[0].items.map((it) => it.id), ids);
  } finally {
    if (backup == null) fs.rmSync(PLAYLIST_FILE, { force: true });
    else fs.writeFileSync(PLAYLIST_FILE, backup);
  }
});

test('合成缓存：文本哈希不变则判定为已合成', () => {
  const s = defaultStore();
  const it = s.playlists[0].items[0];
  const voice = resolveVoice(it.voice);
  const text = speakable(it.text);
  const key = cacheKey(voice, text);
  const mp3 = path.join(CACHE_DIR, key + '.mp3');
  const had = fs.existsSync(mp3);
  if (!had) fs.writeFileSync(mp3, Buffer.alloc(1200));
  try {
    refreshSynthStatus(s.playlists[0]);
    assert.equal(publicItem(it).synth, 'ready');
  } finally {
    if (!had) fs.rmSync(mp3, { force: true });
  }
});
