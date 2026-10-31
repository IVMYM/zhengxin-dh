// 话术播单：持久化、播放顺序（顺序/列表循环/单曲循环/随机）、批量合成进度。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KB } from './kb.mjs';
import { resolveVoice, speakable, cachedFile, synthesizeToCache, CACHE_DIR, DEFAULT_VOICE, normalizeVoiceKey } from './tts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLAYLIST_FILE = path.join(ROOT, 'data', 'playlist.json');

export const MODES = ['sequence', 'loop', 'single', 'shuffle'];
export const MODE_LABEL = { sequence: '顺序播放', loop: '列表循环', single: '单曲循环', shuffle: '随机播放' };

const SEED_IDS = ['query_channels', 'fee', 'report_content', 'retention', 'dispute', 'repair_scam', 'privacy', 'tips'];

function nid() { return randomUUID().replace(/-/g, '').slice(0, 12); }

export function seedItems() {
  return SEED_IDS.map((id) => {
    const e = KB.find((x) => x.id === id);
    if (!e) return null;
    return {
      id: nid(),
      title: e.title,
      text: e.speech,
      voice: DEFAULT_VOICE,
      enabled: true,
      synth: 'idle',
      error: null,
      duration: null,
      updatedAt: new Date().toISOString(),
    };
  }).filter(Boolean);
}

export function defaultStore() {
  const items = seedItems();
  return {
    version: 1,
    activeId: 'default',
    playlists: [{
      id: 'default',
      name: '征信展厅话术',
      items,
      createdAt: new Date().toISOString(),
    }],
    player: {
      playlistId: 'default',
      mode: 'loop',
      index: 0,
      currentId: items[0]?.id || null,
      gapMs: 800,
      volume: 1,
      autostart: false,
      playing: false,
      paused: false,
      shuffleBag: [],
      updatedAt: new Date().toISOString(),
    },
  };
}

export function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.playlists) || !raw.playlists.length) return defaultStore();
    raw.player = { ...defaultStore().player, ...(raw.player || {}) };
    const migrated = migrateVoices(raw);
    if (migrated.length) { saveStore(raw); console.log(`[playlist] 男声/未知音色已改为晓晓：${migrated.map((x) => x.title).join('、')}`); }
    return raw;
  } catch {
    const s = defaultStore();
    saveStore(s);
    return s;
  }
}

/** 只保留女声：把条目里的男声/未知音色改成晓晓，标记需重新合成；返回改动的条目 */
export function migrateVoices(store) {
  const changed = [];
  for (const pl of store.playlists || []) {
    for (const it of pl.items || []) {
      if (!it) continue;
      const v = normalizeVoiceKey(it.voice);
      if (it.voice !== v) {
        changed.push({ playlistId: pl.id, id: it.id, title: it.title, from: it.voice ?? null, to: v });
        it.voice = v; it.synth = 'idle'; it.error = null; it.duration = null;
        it.resynth = true;
      }
    }
  }
  return changed;
}

export function saveStore(store) {
  fs.mkdirSync(path.dirname(PLAYLIST_FILE), { recursive: true });
  const tmp = PLAYLIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, PLAYLIST_FILE);
}

export function getPlaylist(store, id = store.activeId) {
  return store.playlists.find((p) => p.id === id) || store.playlists[0];
}

export function enabledItems(pl) {
  return (pl.items || []).filter((it) => it && it.enabled !== false && String(it.text || '').trim());
}

export function itemById(pl, id) {
  return (pl.items || []).find((it) => it.id === id) || null;
}

export function refreshSynthStatus(pl) {
  for (const it of pl.items || []) {
    const text = speakable(it.text);
    const voice = resolveVoice(it.voice || DEFAULT_VOICE);
    if (!text) { it.synth = 'idle'; continue; }
    if (cachedFile(voice, text)) {
      if (it.synth !== 'ready') it.synth = 'ready';
      it.error = null;
    } else if (it.synth === 'ready') {
      it.synth = 'idle';
    }
  }
  return pl;
}

/** 洗牌袋：避免刚播完的一首立刻又抽到 */
export function refillShuffleBag(ids, lastId) {
  const bag = [...ids];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  if (bag.length > 1 && lastId && bag[0] === lastId) {
    const k = 1 + Math.floor(Math.random() * (bag.length - 1));
    [bag[0], bag[k]] = [bag[k], bag[0]];
  }
  return bag;
}

/**
 * 根据模式算出下一首。ended=true 表示当前这首播完了。
 * 返回 { index, id, stop }；stop 表示顺序模式播完该停。
 */
export function nextIndex(store, { delta = 1, ended = false } = {}) {
  const pl = getPlaylist(store, store.player.playlistId);
  const list = enabledItems(pl);
  if (!list.length) return { index: 0, id: null, stop: true };
  const mode = MODES.includes(store.player.mode) ? store.player.mode : 'loop';
  let idx = Math.max(0, list.findIndex((it) => it.id === store.player.currentId));
  if (idx < 0) idx = Math.min(store.player.index || 0, list.length - 1);

  if (mode === 'single') {
    if (ended || delta === 0) return { index: idx, id: list[idx].id, stop: false };
    // 手动切歌仍允许
  }

  if (mode === 'shuffle') {
    let bag = Array.isArray(store.player.shuffleBag) ? store.player.shuffleBag.filter((id) => list.some((it) => it.id === id)) : [];
    if (!bag.length) bag = refillShuffleBag(list.map((it) => it.id), store.player.currentId);
    if (delta < 0) {
      // 上一首：简单回到列表上一项
      const cur = list.findIndex((it) => it.id === store.player.currentId);
      const prev = (cur <= 0 ? list.length - 1 : cur - 1);
      return { index: prev, id: list[prev].id, stop: false, shuffleBag: bag };
    }
    const id = bag.shift();
    const nidx = list.findIndex((it) => it.id === id);
    if (!bag.length) bag = refillShuffleBag(list.map((it) => it.id), id);
    return { index: nidx, id, stop: false, shuffleBag: bag };
  }

  if (mode === 'sequence') {
    const n = idx + (ended ? 1 : delta);
    if (n < 0) return { index: 0, id: list[0].id, stop: false };
    if (n >= list.length) return { index: list.length - 1, id: list[list.length - 1].id, stop: true };
    return { index: n, id: list[n].id, stop: false };
  }

  // loop
  const n = ((idx + (ended ? 1 : delta)) % list.length + list.length) % list.length;
  return { index: n, id: list[n].id, stop: false };
}

export function applyCursor(store, { index, id, shuffleBag }) {
  const pl = getPlaylist(store, store.player.playlistId);
  const list = enabledItems(pl);
  let idx = typeof index === 'number' ? index : list.findIndex((it) => it.id === id);
  if (idx < 0) idx = 0;
  const it = list[idx] || list[0] || null;
  store.player.index = idx;
  store.player.currentId = it ? it.id : null;
  if (shuffleBag) store.player.shuffleBag = shuffleBag;
  store.player.updatedAt = new Date().toISOString();
  return it;
}

export function parseImport(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    // CSV: title,text 或 title|text 或 纯文本
    let title = '', body = line;
    if (line.includes('\t')) {
      const [a, ...rest] = line.split('\t');
      title = a.trim(); body = rest.join('\t').trim();
    } else if (/^[^,]+,.+/.test(line) && (line.match(/,/g) || []).length === 1) {
      const i = line.indexOf(',');
      title = line.slice(0, i).trim(); body = line.slice(i + 1).trim();
    } else if (line.includes('|')) {
      const i = line.indexOf('|');
      title = line.slice(0, i).trim(); body = line.slice(i + 1).trim();
    } else if (/^(.+?)[：:](.+)$/.test(line)) {
      const m = line.match(/^(.+?)[：:](.+)$/);
      title = m[1].trim(); body = m[2].trim();
    }
    body = body.replace(/^["']|["']$/g, '').trim();
    if (!body) continue;
    if (!title) title = body.slice(0, 16) + (body.length > 16 ? '…' : '');
    items.push({
      id: nid(), title, text: body, voice: DEFAULT_VOICE, enabled: true,
      synth: 'idle', error: null, duration: null, updatedAt: new Date().toISOString(),
    });
  }
  return items;
}

export function publicItem(it) {
  const text = speakable(it.text);
  const voice = resolveVoice(it.voice || DEFAULT_VOICE);
  const cached = Boolean(text && cachedFile(voice, text));
  return {
    id: it.id, title: it.title, text: it.text, voice: it.voice || DEFAULT_VOICE,
    enabled: it.enabled !== false, synth: cached ? 'ready' : (it.synth || 'idle'),
    error: it.error || null, duration: it.duration || null,
    cacheKey: text ? createHash('sha1').update(`${voice.id}|${voice.rate}|${voice.pitch}|${text}`).digest('hex') : null,
  };
}

export function publicStore(store) {
  const s = structuredClone(store);
  for (const pl of s.playlists) {
    refreshSynthStatus(pl);
    pl.items = pl.items.map(publicItem);
    pl.readyCount = pl.items.filter((i) => i.synth === 'ready').length;
    pl.totalCount = pl.items.length;
  }
  return s;
}

/* ---------- 批量合成 ---------- */
let synthJob = null;

export function synthStatus() {
  return synthJob ? { ...synthJob } : { running: false, done: 0, total: 0, current: null, errors: [] };
}

export async function synthesizePlaylist(store, { playlistId, force = false, onProgress = () => {} } = {}) {
  if (synthJob && synthJob.running) throw new Error('合成进行中');
  const pl = getPlaylist(store, playlistId || store.activeId);
  const targets = (pl.items || []).filter((it) => it.enabled !== false && speakable(it.text));
  synthJob = { running: true, done: 0, total: targets.length, current: null, errors: [], startedAt: Date.now() };
  onProgress(synthStatus());
  for (const it of targets) {
    const text = speakable(it.text);
    const voice = resolveVoice(it.voice || DEFAULT_VOICE);
    synthJob.current = { id: it.id, title: it.title };
    onProgress(synthStatus());
    if (!force && cachedFile(voice, text)) {
      it.synth = 'ready'; it.error = null; delete it.resynth; synthJob.done++; onProgress(synthStatus()); continue;
    }
    it.synth = 'running';
    try {
      const r = await synthesizeToCache(voice, text, { force });
      if (r === 'fail') throw new Error('合成失败');
      it.synth = 'ready'; it.error = null; delete it.resynth;
    } catch (e) {
      it.synth = 'error'; it.error = String(e.message || e);
      synthJob.errors.push({ id: it.id, title: it.title, error: it.error });
    }
    synthJob.done++;
    onProgress(synthStatus());
    saveStore(store);
  }
  saveStore(store);
  synthJob.running = false; synthJob.current = null; synthJob.finishedAt = Date.now();
  onProgress(synthStatus());
  const finished = { ...synthJob };
  setTimeout(() => { if (synthJob && !synthJob.running) synthJob = null; }, 60000);
  return finished;
}

/* ---------- SSE 总线（操作台 ↔ 展厅屏） ---------- */
const clients = new Set();

export function subscribe(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

export function clientCount() { return clients.size; }
