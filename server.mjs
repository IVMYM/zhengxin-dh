import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answer, answerStream } from './lib/brain.mjs';
import { llmConfig } from './lib/llm.mjs';
import { SUGGESTIONS, ATTRACT_TIPS, KIOSK_STEPS, SAMPLE_PERSON, ASSISTANT_NAME, SMALLTALK, ATTRACT_GREET } from './lib/kb.mjs';
import { loadOutfits, lipsyncAvatars } from './lib/outfits.mjs';
import { clipStatus, cachedClip, lipsyncUrl, hasPrerendered, serviceHealth, state as lipState } from './lib/lipsync.mjs';
import { VOICES, DEFAULT_VOICE, normalizeVoiceKey, resolveVoice, speakable, cachedFile, cachedFallback, synthesize, readMeta, pendingSynthesis, warmTts } from './lib/tts.mjs';
import {
  loadStore, saveStore, publicStore, getPlaylist, enabledItems, itemById, nextIndex, applyCursor,
  parseImport, synthesizePlaylist, synthStatus, subscribe, broadcast, clientCount, refreshSynthStatus,
  MODE_LABEL, MODES,
} from './lib/playlist.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 本地配置 .env（不入 git）：KEY=VALUE，已有的环境变量优先
(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 43200);
const HOST = process.env.HOST || '0.0.0.0';

// 展厅品牌信息：可在 config/site.json 中修改，无需改代码
function siteConfig() {
  const f = path.join(ROOT, 'config', 'site.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const heavy = /\.(data|wasm|mp4)$/.test(file);
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': heavy ? 'public, max-age=604800' : 'no-cache' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function handleTts(req, res, url) {
  const text = speakable((url.searchParams.get('text') || '').slice(0, 600));
  if (!text) return sendJson(res, 400, { error: 'empty text' });
  const voice = resolveVoice(url.searchParams.get('voice'));
  let hit = cachedFile(voice, text);
  if (hit) return serveFile(req, res, hit);
  // 预合成（/api/tts/prefetch）进行中：等它完成直接用缓存，不重复合成
  const pending = pendingSynthesis(voice, text);
  if (pending) {
    await Promise.race([pending, new Promise((r) => setTimeout(r, 8000))]);
    await new Promise((r) => setTimeout(r, 30)); // 等缓存文件改名落盘
    hit = cachedFile(voice, text);
    if (hit) return serveFile(req, res, hit);
  }

  const child = synthesize(voice, text);
  let started = false;
  // 实时合成失败（未安装 edge-tts、断网、超时）时，改用同一句话其他音色的缓存；都没有才返回错误，由浏览器朗读兜底
  let failed = false;
  const failOver = (why) => {
    if (failed || res.headersSent) return;
    failed = true;
    const fb = cachedFallback(voice, text);
    if (fb) { console.warn(`[tts] ${voice.id} ${why}，改用缓存音色 ${fb.voice.id}`); res.setHeader('x-tts-voice', fb.voice.id); return serveFile(req, res, fb.file); }
    sendJson(res, why === 'timeout' ? 504 : 502, { error: `tts ${why}` });
  };
  const firstByteTimer = setTimeout(() => {
    if (!started) { child.kill('SIGKILL'); failOver('timeout'); }
  }, Number(process.env.TTS_TIMEOUT_MS || 8000));
  child.stdout.on('data', (d) => {
    if (failed) return; // 已改用缓存
    if (!started) {
      started = true; clearTimeout(firstByteTimer);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-tts-voice': voice.id });
    }
    res.write(d);
  });
  child.on('close', () => {
    clearTimeout(firstByteTimer);
    if (!started) failOver('unavailable');
    else res.end();
  });
  req.on('close', () => { if (!res.writableEnded && started) child.kill('SIGKILL'); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') {
      const cfg = llmConfig();
      return sendJson(res, 200, { ok: true, llm: cfg.enabled ? cfg.model : null, voice: DEFAULT_VOICE });
    }
    if (url.pathname === '/api/config') {
      const site = siteConfig();
      return sendJson(res, 200, {
        assistant: ASSISTANT_NAME,
        site: { name: site.name || '征信服务区', subtitle: site.subtitle || '个人信用报告查询 · 异议受理 · 信用知识普及', bank: site.bank || '', hotline: site.hotline || '' },
        suggestions: SUGGESTIONS, tips: ATTRACT_TIPS, kioskSteps: KIOSK_STEPS, sample: SAMPLE_PERSON,
        greet: SMALLTALK.greet.speech, attractGreet: ATTRACT_GREET,
        voices: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v.label])), defaultVoice: DEFAULT_VOICE,
        attractAfterSec: Number(process.env.ATTRACT_AFTER_SEC || site.attractAfterSec || 60),
        llm: llmConfig().enabled,
        lipsync: Boolean(lipsyncUrl()) || hasPrerendered(),
        showText: site.showText === true,
        mouthMode: site.mouthMode === 'gate' ? 'gate' : 'loop',
        filler: '好的，我想一想。',
        outfits: loadOutfits(),
      });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const out = await answer(String(body.text || '').slice(0, 300), { flow: Boolean(body.flow), history: Array.isArray(body.history) ? body.history : [] });
      return sendJson(res, 200, out);
    }
    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      // 流式问答（NDJSON）：meta → sentence…（大模型逐句）→ done
      const body = JSON.parse((await readBody(req)) || '{}');
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const t0 = Date.now();
      const out = await answerStream(String(body.text || '').slice(0, 300), { flow: Boolean(body.flow), history: Array.isArray(body.history) ? body.history : [] },
        (ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); });
      if (out.source === 'llm') console.log(`[chat] 大模型 首字 ${out.timing?.firstMs}ms 整句 ${out.timing?.totalMs}ms`);
      else console.log(`[chat] ${out.source}/${out.intent} ${Date.now() - t0}ms`);
      return res.end();
    }
    if (url.pathname.startsWith('/api/lipsync/')) {
      // 口型同步视频：status 查询/触发生成，clip 取视频（与 /api/tts 同一份音频生成）
      const text = speakable((url.searchParams.get('text') || '').slice(0, 600));
      const voice = resolveVoice(url.searchParams.get('voice'));
      if (url.pathname === '/api/lipsync/health') return sendJson(res, 200, { url: lipsyncUrl() || null, service: await serviceHealth(), ...lipState });
      if (!text) return sendJson(res, 400, { error: 'empty text' });
      // 当前服装的口型头像；不在服装清单里的一律按默认头像处理
      const reqAv = url.searchParams.get('avatar') || '';
      const avatar = lipsyncAvatars(loadOutfits().outfits).has(reqAv) ? reqAv : undefined;
      if (url.pathname === '/api/lipsync/status') {
        const wait = Math.min(3000, Number(url.searchParams.get('wait')) || 0);
        return sendJson(res, 200, { state: await clipStatus(voice, text, wait, avatar) });
      }
      if (url.pathname === '/api/lipsync/clip') {
        const f = cachedClip(voice, text, avatar);
        if (!f) return sendJson(res, 404, { error: 'not ready' });
        return serveFile(req, res, f);
      }
    }

    // ---------- 话术播单 ----------
    if (url.pathname === '/api/playlist' && req.method === 'GET') {
      const store = loadStore();
      for (const pl of store.playlists) refreshSynthStatus(pl);
      return sendJson(res, 200, { ...publicStore(store), modes: MODE_LABEL, clients: clientCount() });
    }
    if (url.pathname === '/api/playlist' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)) || '{}');
      const cur = loadStore();
      if (Array.isArray(body.playlists)) cur.playlists = body.playlists;
      if (body.activeId) cur.activeId = body.activeId;
      if (body.player && typeof body.player === 'object') cur.player = { ...cur.player, ...body.player, updatedAt: new Date().toISOString() };
      saveStore(cur);
      broadcast({ type: 'store', store: publicStore(cur) });
      return sendJson(res, 200, publicStore(cur));
    }
    if (url.pathname === '/api/playlist/item' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = loadStore();
      const pl = getPlaylist(store, body.playlistId || store.activeId);
      const it = {
        id: body.id || randomUUID().replace(/-/g, '').slice(0, 12),
        title: String(body.title || '').slice(0, 80) || '未命名',
        text: String(body.text || '').slice(0, 800),
        voice: normalizeVoiceKey(body.voice),
        enabled: body.enabled !== false,
        synth: 'idle', error: null, duration: null, updatedAt: new Date().toISOString(),
      };
      if (!it.text.trim()) return sendJson(res, 400, { error: 'empty text' });
      const exist = pl.items.findIndex((x) => x.id === it.id);
      if (exist >= 0) pl.items[exist] = { ...pl.items[exist], ...it, id: pl.items[exist].id };
      else pl.items.push(it);
      refreshSynthStatus(pl); saveStore(store);
      broadcast({ type: 'store', store: publicStore(store) });
      return sendJson(res, 200, { item: pl.items.find((x) => x.id === it.id || x.text === it.text), store: publicStore(store) });
    }
    if (url.pathname === '/api/playlist/item' && req.method === 'DELETE') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = loadStore();
      const pl = getPlaylist(store, body.playlistId || store.activeId);
      pl.items = pl.items.filter((x) => x.id !== body.id);
      if (store.player.currentId === body.id) {
        const list = enabledItems(pl);
        store.player.currentId = list[0]?.id || null;
        store.player.index = 0;
      }
      saveStore(store); broadcast({ type: 'store', store: publicStore(store) });
      return sendJson(res, 200, publicStore(store));
    }
    if (url.pathname === '/api/playlist/reorder' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = loadStore();
      const pl = getPlaylist(store, body.playlistId || store.activeId);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const map = new Map(pl.items.map((it) => [it.id, it]));
      const next = [];
      for (const id of ids) if (map.has(id)) { next.push(map.get(id)); map.delete(id); }
      for (const it of map.values()) next.push(it);
      pl.items = next; saveStore(store);
      broadcast({ type: 'store', store: publicStore(store) });
      return sendJson(res, 200, publicStore(store));
    }
    if (url.pathname === '/api/playlist/import' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)) || '{}');
      const store = loadStore();
      const pl = getPlaylist(store, body.playlistId || store.activeId);
      const items = parseImport(body.text || '');
      if (!items.length) return sendJson(res, 400, { error: 'no items' });
      if (body.replace) pl.items = items; else pl.items.push(...items);
      refreshSynthStatus(pl); saveStore(store);
      broadcast({ type: 'store', store: publicStore(store) });
      return sendJson(res, 200, { imported: items.length, store: publicStore(store) });
    }
    if (url.pathname === '/api/playlist/synth' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = loadStore();
      // 异步跑，立刻返回；进度走 SSE + GET status
      if (synthStatus().running) return sendJson(res, 409, { error: 'busy', status: synthStatus() });
      synthesizePlaylist(store, {
        playlistId: body.playlistId, force: Boolean(body.force),
        onProgress: (st) => broadcast({ type: 'synth', status: st }),
      }).then(() => { broadcast({ type: 'store', store: publicStore(loadStore()) }); }).catch((e) => broadcast({ type: 'synth', status: { running: false, error: String(e.message || e) } }));
      return sendJson(res, 202, { ok: true, status: synthStatus() });
    }
    if (url.pathname === '/api/playlist/synth' && req.method === 'GET') {
      return sendJson(res, 200, synthStatus());
    }
    if (url.pathname === '/api/playlist/control' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const store = loadStore();
      const action = String(body.action || '');
      const pl = getPlaylist(store, body.playlistId || store.player.playlistId || store.activeId);
      store.player.playlistId = pl.id;
      if (typeof body.gapMs === 'number') store.player.gapMs = Math.max(0, Math.min(10000, body.gapMs));
      if (typeof body.volume === 'number') store.player.volume = Math.max(0, Math.min(1, body.volume));
      if (typeof body.autostart === 'boolean') store.player.autostart = body.autostart;
      if (body.mode && MODES.includes(body.mode)) store.player.mode = body.mode;

      if (action === 'play') {
        if (body.id || typeof body.index === 'number') applyCursor(store, { id: body.id, index: body.index });
        else if (!store.player.currentId) applyCursor(store, { index: store.player.index || 0 });
        store.player.playing = true; store.player.paused = false;
      } else if (action === 'pause') {
        store.player.playing = false; store.player.paused = true;
      } else if (action === 'toggle') {
        if (store.player.playing && !store.player.paused) { store.player.playing = false; store.player.paused = true; }
        else { store.player.playing = true; store.player.paused = false; if (!store.player.currentId) applyCursor(store, { index: 0 }); }
      } else if (action === 'stop') {
        store.player.playing = false; store.player.paused = false;
      } else if (action === 'next' || action === 'prev') {
        const n = nextIndex(store, { delta: action === 'next' ? 1 : -1, ended: false });
        applyCursor(store, n);
        store.player.playing = true; store.player.paused = false;
      } else if (action === 'ended') {
        // 展厅屏汇报当前条目播完
        const n = nextIndex(store, { ended: true });
        if (n.stop) { store.player.playing = false; store.player.paused = false; }
        else { applyCursor(store, n); store.player.playing = true; store.player.paused = false; }
      } else if (action === 'seek') {
        broadcast({ type: 'seek', seconds: body.seconds, ratio: body.ratio, currentId: store.player.currentId });
        return sendJson(res, 200, { ok: true });
      } else if (action === 'mode') {
        // mode already set above
      } else if (action === 'select') {
        applyCursor(store, { id: body.id, index: body.index });
      } else if (action === 'state') {
        // 展厅屏回传本地状态
        if (typeof body.playing === 'boolean') store.player.playing = body.playing;
        if (typeof body.paused === 'boolean') store.player.paused = body.paused;
        if (body.currentId) store.player.currentId = body.currentId;
      }

      store.player.updatedAt = new Date().toISOString();
      saveStore(store);
      const cur = itemById(pl, store.player.currentId);
      const payload = { type: 'control', action, player: store.player, item: cur ? { id: cur.id, title: cur.title, text: cur.text, voice: normalizeVoiceKey(cur.voice) } : null };
      broadcast(payload);
      broadcast({ type: 'store', store: publicStore(store) });
      return sendJson(res, 200, { player: store.player, item: payload.item });
    }
    if (url.pathname === '/api/playlist/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store', 'connection': 'keep-alive', 'x-accel-buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', store: publicStore(loadStore()), clients: clientCount() + 1 })}\n\n`);
      subscribe(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
      res.on('close', () => clearInterval(hb));
      return;
    }
    if (url.pathname === '/admin' || url.pathname === '/panel') {
      return serveFile(req, res, path.join(PUBLIC, 'panel.html'));
    }

    if (url.pathname === '/api/tts') return handleTts(req, res, url);
    if (url.pathname === '/api/tts/prefetch') {
      // 大模型逐句输出时，后面的句子提前合成，轮到播放时直接命中缓存
      const text = speakable((url.searchParams.get('text') || '').slice(0, 600));
      const voice = resolveVoice(url.searchParams.get('voice'));
      if (!text) return sendJson(res, 400, { error: 'empty text' });
      if (cachedFile(voice, text)) return sendJson(res, 200, { state: 'cached' });
      if (!pendingSynthesis(voice, text)) { const c = synthesize(voice, text); c.stdout.resume(); }
      return sendJson(res, 200, { state: 'started' });
    }
    if (url.pathname === '/api/tts/meta') {
      // 逐词时间戳（秒），用于字幕跟随实际音频；新句子在合成中时最多等待 6 秒
      const text = speakable((url.searchParams.get('text') || '').slice(0, 600));
      const meta = text ? await readMeta(resolveVoice(url.searchParams.get('voice')), text, 6000) : null;
      if (!meta) return sendJson(res, 404, { error: 'no timing' });
      return sendJson(res, 200, { words: meta.words || [] });
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, file);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = llmConfig();
  console.log(`征信服务数字人已启动： http://localhost:${PORT}`);
  console.log(`大模型：${cfg.enabled ? cfg.model + ' @ ' + cfg.baseUrl : '未配置（使用本地知识库作答）'}`);
  warmTts().catch(() => {});
  resynthMigratedVoices().catch((e) => console.warn('[playlist] 重新合成失败', e.message || e));
});

/** 启动时：音色被改成晓晓的条目（原为男声）重新合成，展厅播放直接命中缓存 */
async function resynthMigratedVoices() {
  const store = loadStore();
  for (const pl of store.playlists || []) {
    const items = (pl.items || []).filter((it) => it && it.resynth);
    if (!items.length) continue;
    console.log(`[playlist] 重新合成（改为晓晓）：${items.map((it) => it.title).join('、')}`);
    while (synthStatus().running) await new Promise((r) => setTimeout(r, 500));
    const r = await synthesizePlaylist(store, { playlistId: pl.id, onProgress: (st) => broadcast({ type: 'synth', status: st }) });
    console.log(`[playlist] 重新合成完成：${r.done}/${r.total}，失败 ${r.errors.length}`);
    broadcast({ type: 'store', store: publicStore(loadStore()) });
  }
}
