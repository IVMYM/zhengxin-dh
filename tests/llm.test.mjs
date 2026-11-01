import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { SentenceSplitter, cleanSpeech, streamLlm, buildMessages, llmConfig } from '../lib/llm.mjs';
import { answerStream } from '../lib/brain.mjs';

test('流式文本按整句切分，首句过长时在逗号处提前送出', () => {
  const out = []; const sp = new SentenceSplitter((s) => out.push(s));
  for (const ch of '您好，信用报告可以在柜台查询。也可以用自助查询机！还有') sp.push(ch);
  sp.end();
  assert.deepEqual(out, ['您好，信用报告可以在柜台查询。', '也可以用自助查询机！', '还有']);
  const long = []; const sp2 = new SentenceSplitter((s) => long.push(s));
  sp2.push('如果您发现信用报告里的信息和实际情况不一致，可以本人携带身份证');
  assert.equal(long.length, 1);
  assert.match(long[0], /，$/);
});

test('朗读清理：去 Markdown、括号注释、乱码与零散英文', () => {
  assert.equal(cleanSpeech('**手机银行App**也能查（如90天）remember。'), '手机银行App也能查。');
  assert.equal(cleanSpeech('<think>想一想</think>可以查询。'), '可以查询。');
  assert.equal(cleanSpeech('联系银行，因为意愿्री诚恳说明。'), '联系银行，因为意愿诚恳说明。');
});

test('系统提示词：小信、可闲聊、口语短句、不编造数字、打码', () => {
  const sys = buildMessages('问题', [], [])[0].content;
  for (const k of ['小信', '1到3句', '数字一律不说', '138****5678', '不要输出思考过程', '日常寒暄']) assert.ok(sys.includes(k), k);
});

test('多轮历史给 assistant 补上 reasoning_content（IFM 要求，否则 HTTP 400）', () => {
  const msgs = buildMessages('接着问', [], [
    { role: 'user', content: '你是谁' },
    { role: 'assistant', content: '我是小信。' },
    { role: 'user', content: '天气如何' },
    { role: 'assistant', content: '挺好的。', reasoning_content: '闲聊' },
  ]);
  const asst = msgs.filter((m) => m.role === 'assistant');
  assert.equal(asst.length, 2);
  assert.equal(asst[0].reasoning_content, '');
  assert.equal(asst[1].reasoning_content, '闲聊');
  assert.equal(msgs.at(-1).content, '接着问');
});

test('非 IFM 目标可以不带 reasoning_content', () => {
  const msgs = buildMessages('接着问', [], [
    { role: 'user', content: '你是谁' },
    { role: 'assistant', content: '我是小信。' },
  ], new Date(), { reasoningContent: false });
  const asst = msgs.find((m) => m.role === 'assistant');
  assert.equal('reasoning_content' in asst, false);
  assert.equal(asst.content, '我是小信。');
});

function fakeLlm(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const cfgFor = (srv, extra = {}) => ({ enabled: true, baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: 'k', model: 'm', firstMs: 800, timeoutMs: 2000, extra: {}, mode: 'kb-first', ...extra });

test('流式接口：逐句回调，思考内容不朗读', async () => {
  const srv = await fakeLlm((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (d) => res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
    send({ reasoning_content: '用户问查询方式。' });
    send({ content: '\n您可以带身份证到柜台查询。' });
    setTimeout(() => { send({ content: '也可以在自助查询机上办理。' }); res.end('data: [DONE]\n\n'); }, 50);
  });
  const got = [];
  const r = await streamLlm('怎么查', [], [], cfgFor(srv), (s) => got.push(s));
  srv.close();
  assert.deepEqual(got, ['您可以带身份证到柜台查询。', '也可以在自助查询机上办理。']);
  assert.ok(r.firstMs >= 0 && r.totalMs >= r.firstMs);
});

test('首字超时与思考过程泄漏都回落知识库', async () => {
  const slow = await fakeLlm((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); });
  const evs = [];
  const r = await answerStream('征信和芝麻信用有什么区别', { llm: cfgFor(slow) }, (e) => evs.push(e.type));
  slow.close();
  assert.notEqual(r.source, 'llm');
  assert.equal(evs.at(-1), 'done');
  const leak = await fakeLlm((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '1.  **拆解用户请求：**核心任务' } }] })}\n\n`);
  });
  const r2 = await streamLlm('问题', [], [], cfgFor(leak));
  leak.close();
  assert.equal(r2, null);
});

test('知识库有把握的问题不调用大模型（合规口径、零延迟）', async () => {
  let called = false;
  const srv = await fakeLlm((req, res) => { called = true; res.end(); });
  const r = await answerStream('逾期记录保存多久', { llm: cfgFor(srv) });
  srv.close();
  assert.equal(r.source, 'kb');
  assert.equal(called, false);
});

function openLlm(handler) {
  const seen = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      seen.push(body);
      try { handler(req, res, body, seen.length); } catch (err) { res.destroy(); throw err; }
    });
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    seen,
    baseUrl: `http://127.0.0.1:${srv.address().port}/v1`,
    close() { srv.close(); for (const s of sockets) s.destroy(); },
  })));
}
const sseOk = (res, text) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
};
const rotCfg = (list, extra = {}) => ({
  enabled: true,
  baseUrl: list[0].baseUrl,
  apiKey: list[0].apiKey || '',
  model: list.map((t) => t.model).join(', '),
  firstMs: 350,
  timeoutMs: 1500,
  extra: {},
  mode: 'kb-first',
  targets: list,
  rotation: { cursor: 0, cooldown: new Map() },
  ...extra,
});
const hist = [{ role: 'user', content: '你是谁' }, { role: 'assistant', content: '我是小信。' }];

test('只配单一接口时配置与以前一致，失败后下次仍会重试', async () => {
  const c = llmConfig({ LLM_BASE_URL: 'https://example.com/v1/', LLM_MODEL: 'plain', LLM_API_KEY: 'k' });
  assert.equal(c.enabled, true);
  assert.equal(c.baseUrl, 'https://example.com/v1');
  assert.equal(c.model, 'plain');
  assert.equal(c.apiKey, 'k');
  assert.deepEqual(c.extra, { reasoning_effort: 'low' });
  assert.equal(c.firstMs, 12000);
  assert.equal(c.timeoutMs, 20000);
  assert.equal(c.mode, 'kb-first');
  assert.equal(c.targets.length, 1);
  assert.equal(c.targets[0].reasoningContent, true);
  assert.equal(llmConfig({}).enabled, false);
  assert.equal(llmConfig({ LLM_MODE: 'always', LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm' }).mode, 'always');
  const same = llmConfig({ LLM_BASE_URL: 'https://example.com/v1/', LLM_MODEL: 'plain', LLM_API_KEY: 'k' });
  assert.equal(same.rotation, c.rotation);

  let n = 0;
  const srv = await fakeLlm((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      n++;
      const body = JSON.parse(raw || '{}');
      if (n === 1) { res.writeHead(429, { 'retry-after': '60' }); return res.end('{}'); }
      assert.equal(body.messages.find((m) => m.role === 'assistant').reasoning_content, '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二次可以查询。' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  const cfg = cfgFor(srv, { model: 'plain-model' });
  const first = await streamLlm('问题', [], hist, cfg);
  const second = await streamLlm('问题', [], hist, cfg);
  srv.close();
  assert.equal(first, null);
  assert.match(second.speech, /第二次可以查询/);
});

test('LLM_MODELS 解析密钥引用，非法项跳过，无效时退回单一接口', () => {
  const env = {
    LLM_BASE_URL: 'https://ignored.example/v1',
    LLM_MODEL: 'ignored',
    LLM_API_KEY: 'ifm-key-value',
    AMD_API_KEY: 'amd-key-value',
    LLM_EXTRA_BODY: '{"foo":1}',
    LLM_MODELS: JSON.stringify([
      { baseUrl: 'https://api.ifm.ai/v1/', apiKeyEnv: 'LLM_API_KEY', model: 'IFM/K2-Horizon-375B-A23B', extra: { reasoning_effort: 'low' } },
      { baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKeyEnv: 'AMD_API_KEY', model: 'DeepSeek-V4-Flash' },
      { baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', apiKeyEnv: 'MISSING_KEY', model: 'MiMo-V2.6-Flash' },
      { baseUrl: 'http://127.0.0.1/v1', apiKey: 'sk-hardcoded', model: 'nope' },
    ]),
  };
  const c = llmConfig(env);
  assert.deepEqual(c.targets.map((t) => t.model), ['IFM/K2-Horizon-375B-A23B', 'DeepSeek-V4-Flash']);
  assert.equal(c.targets[0].baseUrl, 'https://api.ifm.ai/v1');
  assert.equal(c.targets[0].apiKey, 'ifm-key-value');
  assert.equal(c.targets[0].reasoningContent, true);
  assert.deepEqual(c.targets[0].extra, { reasoning_effort: 'low' });
  assert.equal(c.targets[1].reasoningContent, false);
  assert.deepEqual(c.targets[1].extra, { foo: 1 });
  assert.equal(c.model.includes('ifm-key-value') || c.model.includes('amd-key-value'), false);
  const nonce = `solo-${Math.random().toString(16).slice(2)}`;
  const a = llmConfig({ LLM_MODELS: JSON.stringify([{ baseUrl: 'https://example.com/v1', apiKeyEnv: 'K', model: nonce }]), K: 'secret-value' });
  const b = llmConfig({ LLM_MODELS: JSON.stringify([{ baseUrl: 'https://example.com/v1', apiKeyEnv: 'K', model: nonce }]), K: 'secret-value' });
  assert.equal(a.rotation, b.rotation);
  const back = llmConfig({ LLM_MODELS: '{', LLM_BASE_URL: 'https://api.example.com/v1', LLM_MODEL: 'fallback', LLM_API_KEY: 'k' });
  assert.equal(back.model, 'fallback');
  assert.equal(back.targets[0].reasoningContent, true);
  const hard = llmConfig({ LLM_MODELS: '[{"baseUrl":"http://127.0.0.1/v1","apiKey":"sk-live","model":"x"}]', LLM_BASE_URL: 'https://api.example.com/v1', LLM_MODEL: 'fallback', LLM_API_KEY: 'k' });
  assert.equal(hard.model, 'fallback');
});

test('示例里的 LLM_MODELS 含 IFM 与 AMD 免费模型', () => {
  const text = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const line = text.split(/\n/).find((l) => l.startsWith('# LLM_MODELS='));
  const raw = line.replace(/^#\s*LLM_MODELS=/, '');
  const c = llmConfig({ LLM_MODELS: raw, LLM_API_KEY: 'ifm-key', AMD_API_KEY: 'amd-key' });
  assert.deepEqual(c.targets.map((t) => t.model), [
    'IFM/K2-Horizon-375B-A23B', 'DeepSeek-V4-Flash', 'DeepSeek-V4.1-Flash', 'MiMo-V2.6-Flash', 'Qwen3.8-Flash-Next', 'GLM-5.3-Flash',
  ]);
  assert.equal(c.targets[0].baseUrl, 'https://api.ifm.ai/v1');
  assert.ok(c.targets.slice(1).every((t) => t.baseUrl === 'https://developer.amd.com.cn/radeon/api/v1' && t.apiKey === 'amd-key' && t.reasoningContent === false));
  assert.equal(c.targets[0].reasoningContent, true);
  assert.equal(c.targets[0].apiKey, 'ifm-key');
  assert.deepEqual(c.targets[0].extra, { reasoning_effort: 'low' });
});

test('健康目标轮流作答；429 冷却后跳过，恢复后仍可再用', async () => {
  const order = [];
  let aHits = 0;
  const a = await openLlm((req, res) => {
    aHits++;
    order.push('A');
    if (aHits === 1) { res.writeHead(429, { 'retry-after': '45' }); return res.end('{"error":"model_concurrency_rate_limit_exceeded"}'); }
    sseOk(res, '甲模型可以查询。');
  });
  const b = await openLlm((req, res) => { order.push('B'); sseOk(res, '乙模型可以查询。'); });
  const cfg = rotCfg([
    { baseUrl: a.baseUrl, apiKey: 'ifm-secret-key-123', model: 'IFM/K2-Horizon-375B-A23B', extra: { reasoning_effort: 'low' } },
    { baseUrl: b.baseUrl, apiKey: 'amd-secret-key-456', model: 'DeepSeek-V4-Flash', extra: {} },
  ]);
  const logs = [];
  const origLog = console.log; const origWarn = console.warn;
  console.log = (...xs) => { logs.push(xs.join(' ')); origLog(...xs); };
  console.warn = (...xs) => { logs.push(xs.join(' ')); origWarn(...xs); };
  try {
    const r1 = await streamLlm('怎么查', [], hist, cfg);
    assert.match(r1.speech, /乙模型/);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    assert.equal(a.seen[0].messages.find((m) => m.role === 'assistant').reasoning_content, '');
    assert.equal(a.seen[0].reasoning_effort, 'low');
    assert.equal('reasoning_content' in b.seen[0].messages.find((m) => m.role === 'assistant'), false);
    assert.equal(b.seen[0].reasoning_effort, undefined);
    const until = [...cfg.rotation.cooldown.values()][0];
    assert.ok(until - Date.now() > 40_000 && until - Date.now() <= 45_000, until - Date.now());
    const r2 = await streamLlm('怎么查', [], hist, cfg);
    assert.match(r2.speech, /乙模型/);
    assert.equal(a.seen.length, 1);
    cfg.rotation.cooldown.clear();
    const r3 = await streamLlm('怎么查', [], hist, cfg);
    assert.match(r3.speech, /甲模型/);
    assert.equal(a.seen.length, 2);
    assert.ok(logs.some((l) => l.includes('DeepSeek-V4-Flash @') && l.includes('应答')));
    assert.ok(logs.some((l) => l.includes('冷却') && l.includes('切换下一个')));
    assert.equal(logs.some((l) => l.includes('ifm-secret-key-123') || l.includes('amd-secret-key-456')), false);
  } finally {
    console.log = origLog; console.warn = origWarn; a.close(); b.close();
  }
});

test('轮询按顺序经过每个健康目标', async () => {
  const order = [];
  const a = await openLlm((req, res) => { order.push('A'); sseOk(res, '甲处可以查询。'); });
  const b = await openLlm((req, res) => { order.push('B'); sseOk(res, '乙处可以查询。'); });
  const cfg = rotCfg([
    { baseUrl: a.baseUrl, model: 'model-a', apiKey: '' },
    { baseUrl: b.baseUrl, model: 'model-b', apiKey: '' },
  ]);
  try {
    for (let i = 0; i < 4; i++) await streamLlm('怎么查', [], [], cfg);
    assert.deepEqual(order, ['A', 'B', 'A', 'B']);
  } finally { a.close(); b.close(); }
});

test('5xx、连不上、首字超时、空回复与 400 的切换规则', async () => {
  const down = await openLlm((req) => { req.socket.destroy(); });
  const slow = await openLlm(() => {});
  const bad = await openLlm((req, res) => { res.writeHead(400); res.end('no'); });
  const empty = await openLlm((req, res) => sseOk(res, '!!!'));
  const boom = await openLlm((req, res) => { res.writeHead(502, { 'retry-after': '99999' }); res.end('down'); });
  const ok = await openLlm((req, res) => sseOk(res, '备用模型可以查询。'));
  try {
    const five = rotCfg([
      { baseUrl: boom.baseUrl, model: 'boom', apiKey: 'boom-secret-key' },
      { baseUrl: ok.baseUrl, model: 'ok-model', apiKey: '' },
    ]);
    const r5 = await streamLlm('怎么查', [], [], five);
    assert.match(r5.speech, /备用模型/);
    const until = [...five.rotation.cooldown.values()][0];
    assert.ok(until - Date.now() <= 600_000 && until - Date.now() > 590_000);

    const refused = rotCfg([
      { baseUrl: down.baseUrl, model: 'down', apiKey: '' },
      { baseUrl: ok.baseUrl, model: 'ok-model', apiKey: '' },
    ]);
    assert.match((await streamLlm('怎么查', [], [], refused)).speech, /备用模型/);

    const hung = rotCfg([
      { baseUrl: slow.baseUrl, model: 'slow', apiKey: '' },
      { baseUrl: ok.baseUrl, model: 'ok-model', apiKey: '' },
    ], { firstMs: 250, timeoutMs: 2000 });
    const t0 = Date.now();
    assert.match((await streamLlm('怎么查', [], [], hung)).speech, /备用模型/);
    assert.ok(Date.now() - t0 < 1500, Date.now() - t0);
    assert.equal(slow.seen.length, 1);

    const client = rotCfg([
      { baseUrl: bad.baseUrl, model: 'bad-request', apiKey: '' },
      { baseUrl: ok.baseUrl, model: 'ok-model', apiKey: '' },
    ]);
    assert.equal(await streamLlm('怎么查', [], [], client), null);
    assert.equal(ok.seen.length, 3);

    const blank = rotCfg([
      { baseUrl: empty.baseUrl, model: 'empty', apiKey: '' },
      { baseUrl: ok.baseUrl, model: 'ok-model', apiKey: '' },
    ]);
    const before = ok.seen.length;
    assert.equal(await streamLlm('怎么查', [], [], blank), null);
    assert.equal(ok.seen.length, before);
  } finally {
    down.close(); slow.close(); bad.close(); empty.close(); boom.close(); ok.close();
  }
});

test('全部限流后冷却期内不再请求，换目标后仍可调用工具', async () => {
  const a = await openLlm((req, res) => { res.writeHead(429); res.end('{}'); });
  let n = 0;
  const b = await openLlm((req, res) => {
    n++;
    if (n === 1) { res.writeHead(429, { 'retry-after': new Date(Date.now() + 20_000).toUTCString() }); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (d) => res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
    if (n === 2) send({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":"贵阳"}' } }] });
    else send({ content: '贵阳今天小雨，记得带伞。' });
    res.end('data: [DONE]\n\n');
  });
  const cfg = rotCfg([
    { baseUrl: a.baseUrl, model: 'model-a', apiKey: 'a-secret-key' },
    { baseUrl: b.baseUrl, model: 'model-b', apiKey: 'b-secret-key' },
  ]);
  try {
    assert.equal(await streamLlm('天气', [], [], cfg), null);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    const left = [...cfg.rotation.cooldown.values()].map((t) => t - Date.now());
    assert.ok(left.some((ms) => ms > 15_000 && ms <= 20_000), left.join(','));
    assert.equal(await streamLlm('天气', [], [], cfg), null);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
    cfg.rotation.cooldown.clear();
    cfg.rotation.cursor = 1;
    const calls = [];
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
    const out = await streamLlm('天气', [], [], cfg, () => {}, {
      tools, runTool: async (name, args) => { calls.push({ name, args }); return { ok: true, data: { weather: '小雨' }, say: '贵阳今天小雨。', ms: 1 }; },
    });
    assert.deepEqual(calls, [{ name: 'get_weather', args: { city: '贵阳' } }]);
    assert.match(out.speech, /小雨/);
    assert.equal(a.seen.length, 1);
  } finally { a.close(); b.close(); }
});
