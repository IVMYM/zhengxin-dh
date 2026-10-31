// 端到端检查：大模型逐句输出 → 每句实时合成语音（晓晓）→ 首句多快能出声。
// 默认起一个本地假大模型（逐字流式吐字，不用密钥、不连外网的大模型），只有 TTS 走真实的 edge-tts。
// 用法：node scripts/check-stream-tts.mjs            （假大模型）
//       node scripts/check-stream-tts.mjs --real     （用 .env 里配置的真实大模型）
// 会在 43299 端口临时起一个服务，结束后关掉，不影响正在运行的展厅服务。
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = process.argv.includes('--real');
const PORT = Number(process.env.CHECK_PORT || 43299);
const QUESTION = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || '信用报告对年轻人有什么用';

// 每次换几个词，避免命中 TTS 缓存，测出来的是真实的实时合成速度
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ANSWER = `${pick(['年轻人', '刚工作的朋友', '大学毕业生'])}的信用报告很重要，以后办房贷车贷都要看它。平时${pick(['信用卡', '花呗', '助学贷款'])}按时还款，就是在积累好的信用记录。如果发现报告里有不对的地方，可以到银行柜台申请异议处理。`;

function fakeLlm() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chars = [...ANSWER]; let i = 0;
      setTimeout(function next() { // 首字 300ms，之后每 40ms 两个字，接近常见大模型的速度
        if (i >= chars.length) { res.end('data: [DONE]\n\n'); return; }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chars.slice(i, i + 2).join('') } }] })}\n\n`);
        i += 2; setTimeout(next, 40);
      }, 300);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIPSYNC_URL: '' };
let llm = null;
if (!REAL) {
  llm = await fakeLlm();
  Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`, LLM_API_KEY: 'local-test', LLM_MODEL: 'fake', LLM_MODE: 'always' });
}
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `http://127.0.0.1:${PORT}`;
const stop = (code) => { server.kill(); if (llm) llm.close(); process.exit(code); };
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (i > 50) { console.error('服务没起来'); stop(1); }
  await new Promise((r) => setTimeout(r, 200));
}

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const sentences = []; const audio = []; let firstSound = null;
async function getAudio(i, text) {
  const r = await fetch(`${base}/api/tts?voice=female&text=${encodeURIComponent(text)}`);
  if (!r.ok) throw new Error(`第 ${i + 1} 句合成失败 HTTP ${r.status}`);
  const reader = r.body.getReader(); let bytes = 0; let first = null; const chunks = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; if (first === null) first = ms(); bytes += value.length; chunks.push(value); }
  const buf = Buffer.concat(chunks);
  // 解码成 PCM 数采样，确认是能播放的音频并得到时长
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { input: buf, maxBuffer: 1 << 26 });
  const seconds = pcm.status === 0 ? pcm.stdout.length / 2 / 16000 : null;
  return { i, text, firstByteMs: first, doneMs: ms(), bytes, seconds };
}
const jobs = [];
const res = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: QUESTION }) });
const dec = new TextDecoder(); let buf = ''; let source = null;
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.type === 'meta') source = ev.source;
    if (ev.type === 'done') source = ev.source;
    if (ev.type !== 'sentence') continue;
    const i = sentences.length; sentences.push({ text: ev.text, atMs: ms() });
    // 和页面一样：首句直接要音频（边合成边下发），后面的句子先让服务端预合成
    if (i > 0) fetch(`${base}/api/tts/prefetch?voice=female&text=${encodeURIComponent(ev.text)}`).catch(() => {});
    jobs.push(i === 0 ? getAudio(0, ev.text).then((a) => { firstSound = a.firstByteMs; return a; }) : Promise.resolve(i));
  }
}
// 后面的句子按播放顺序取（多数已预合成好，直接命中缓存）
for (let i = 0; i < jobs.length; i++) {
  const a = await jobs[i];
  audio.push(typeof a === 'number' ? await getAudio(i, sentences[i].text) : a);
}
console.log(`问题：${QUESTION}（${REAL ? '真实大模型' : '本地假大模型'}，来源 ${source}）`);
for (const [i, s] of sentences.entries()) {
  const a = audio[i];
  console.log(`  第 ${i + 1} 句 @${s.atMs}ms：${s.text}\n      音频 ${a.bytes} 字节 ${a.seconds ? a.seconds.toFixed(2) + ' 秒' : ''}，首字节 @${a.firstByteMs}ms`);
}
console.log(`首句出声（首个音频字节）：${firstSound}ms；首句文字到达：${sentences[0] ? sentences[0].atMs : '-'}ms`);
const ok = sentences.length >= 2 && audio.every((a) => a.bytes > 2000 && a.seconds > 0.3);
console.log(ok ? '通过：逐句都拿到了可播放的语音' : '失败：有句子没有拿到语音');
stop(ok ? 0 : 1);
