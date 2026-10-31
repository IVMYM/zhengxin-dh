// 大模型连通与时延探测（只发 HTTP 请求，不播放任何声音）。读取 .env，不打印密钥。
// 用法：node scripts/llm-probe.mjs [variant...]   variant: base | noextra | nomax | effort-none
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
try { for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } } catch {}
const E = { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('LLM_'))) };
const base = (E.LLM_BASE_URL || '').replace(/\/+$/, ''); const key = E.LLM_API_KEY || ''; const model = E.LLM_MODEL;
const redact = (s) => (key ? String(s).split(key).join('***') : String(s));
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ['base'];
const msgs = [{ role: 'system', content: '你是银行展厅的服务助理，用一两句口语回答。' }, { role: 'user', content: '今天天气怎么样？' }];
const { buildMessages } = await import('../lib/llm.mjs');
if (variants.includes('models')) { const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } }); const t = await r.text(); try { console.log('models', JSON.parse(t).data.map((m) => m.id).join(', ')); } catch { console.log('models HTTP', r.status, redact(t.slice(0, 300))); } }
const Q = process.env.PROBE_Q || '今天天气怎么样？';
for (const v of variants.filter((x) => x !== 'models')) {
  let m = msgs;
  if (v.startsWith('app')) m = buildMessages(Q, [], v === 'app-hist' ? [{ role: 'user', content: '你是谁' }, { role: 'assistant', content: '我是小信，征信服务助理。' }] : []);
  const mdl = v.startsWith('model=') ? v.slice(6) : model;
  const body = { model: mdl, messages: m, stream: true, temperature: 0.3, max_tokens: 1200, reasoning_effort: 'low' };
  if (v === 'noextra') delete body.reasoning_effort;
  if (v === 'nomax') { delete body.max_tokens; delete body.reasoning_effort; }
  if (v === 'effort-none') body.reasoning_effort = 'none';
  if (v === 'min') { delete body.reasoning_effort; delete body.max_tokens; delete body.temperature; }
  const t0 = Date.now(); let first = 0, firstReason = 0, text = '', reason = 0;
  try {
    const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    const hdr = Date.now() - t0;
    if (!res.ok) { console.log(v, 'HTTP', res.status, hdr + 'ms', redact((await res.text()).slice(0, 400))); continue; }
    const dec = new TextDecoder(); let buf = '';
    for await (const c of res.body) {
      buf += dec.decode(c, { stream: true }); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try { const d = JSON.parse(line.slice(5)).choices?.[0]?.delta || {}; if (d.reasoning_content || d.reasoning) { reason++; if (!firstReason) firstReason = Date.now() - t0; } if (d.content) { if (!first) first = Date.now() - t0; text += d.content; } } catch {} }
    }
    console.log(v, 'OK headers', hdr + 'ms', 'firstReasoning', firstReason, 'firstContent', first + 'ms', 'total', (Date.now() - t0) + 'ms', 'reasoningChunks', reason, 'text:', text.slice(0, 80));
  } catch (e) { console.log(v, 'ERR', redact(e.message)); }
}
console.log('model', model, 'host', base.replace(/^https?:\/\//, '').split('/')[0]);
