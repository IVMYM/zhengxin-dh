// 测量：用户问完 → 首句可读 → 首句 TTS 首字节（≈可出声）。不播放任何声音。
// 默认假大模型（测试机）；--real 用 .env 真实大模型（可在 Mac 上跑）。
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = process.argv.includes('--real');
const PORT = Number(process.env.CHECK_PORT || 43301);
const QUESTION = process.env.PROBE_Q || (REAL ? '今天天气怎么样？' : '信用报告对刚工作的年轻人有什么用？');
const uniq = `测${Date.now().toString(36)}`;

const ANSWER = `刚工作的年轻人${uniq}也要注意信用记录，以后办房贷车贷都会看。平时按时还款，就是在积累好信用。`;

function fakeLlm(firstDelay = 280) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chars = [...ANSWER]; let i = 0;
      setTimeout(function next() {
        if (i >= chars.length) { res.end('data: [DONE]\n\n'); return; }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chars.slice(i, i + 2).join('') } }] })}\n\n`);
        i += 2; setTimeout(next, 35);
      }, firstDelay);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIPSYNC_URL: '' };
let llm = null;
if (!REAL) {
  llm = await fakeLlm();
  Object.assign(env, { LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`, LLM_API_KEY: 'local', LLM_MODEL: 'fake', LLM_MODE: 'always', LLM_EXTRA_BODY: '{}' });
}
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let slog = ''; server.stderr.on('data', (d) => { slog += d; }); server.stdout.on('data', (d) => { slog += d; });
const base = `http://127.0.0.1:${PORT}`;
const stop = (c) => { server.kill(); if (llm) llm.close(); process.exit(c); };
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (i > 80) { console.error('服务没起来\n', slog.slice(-800)); stop(1); }
  await new Promise((r) => setTimeout(r, 100));
}
// 等 TTS 预热结束（日志出现预热 或 最多 8 秒）
const warmUntil = Date.now() + 8000;
while (Date.now() < warmUntil && !/\[tts\] 预热/.test(slog)) await new Promise((r) => setTimeout(r, 100));

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const out = { question: QUESTION, real: REAL, llmFirstMs: null, firstSentenceMs: null, firstSentence: null, ttsFirstByteMs: null, ttsDoneMs: null, ttsBytes: 0, source: null, serverTiming: null };

const res = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: QUESTION, history: [] }) });
const dec = new TextDecoder(); let buf = '';
const jobs = [];
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const ev = JSON.parse(line);
    if (ev.type === 'done') { out.source = ev.source; out.serverTiming = ev.timing || null; if (ev.timing?.firstMs != null) out.llmFirstMs = ev.timing.firstMs; }
    if (ev.type !== 'sentence') continue;
    if (out.firstSentenceMs == null) {
      out.firstSentenceMs = ms();
      out.firstSentence = ev.text;
      jobs.push((async () => {
        const r = await fetch(`${base}/api/tts?voice=female&text=${encodeURIComponent(ev.text)}`);
        const reader = r.body.getReader(); let first = null; let n = 0;
        for (;;) { const { value, done } = await reader.read(); if (done) break; if (first == null) first = ms(); n += value.length; }
        out.ttsFirstByteMs = first; out.ttsDoneMs = ms(); out.ttsBytes = n; out.ttsHttp = r.status;
      })());
    } else {
      fetch(`${base}/api/tts/prefetch?voice=female&text=${encodeURIComponent(ev.text)}`).catch(() => {});
    }
  }
}
await Promise.all(jobs);
out.totalToFirstAudioMs = out.ttsFirstByteMs;
console.log(JSON.stringify(out, null, 2));
console.log(`\n拆解（问完 → 首声可播，约等于 TTS 首字节）：`);
console.log(`  大模型首字/首句：${out.llmFirstMs ?? out.firstSentenceMs} ms（服务端 firstMs） / 客户端收到首句 ${out.firstSentenceMs} ms`);
console.log(`  首句 TTS 首字节：${out.ttsFirstByteMs} ms（距提问）`);
console.log(`  TTS 合成耗时：${out.ttsFirstByteMs != null && out.firstSentenceMs != null ? out.ttsFirstByteMs - out.firstSentenceMs : '?'} ms`);
console.log(`  首句：${out.firstSentence}`);
console.log(`  来源：${out.source}`);
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out', `latency-${REAL ? 'real' : 'fake'}.json`), JSON.stringify(out, null, 2));
stop(0);
