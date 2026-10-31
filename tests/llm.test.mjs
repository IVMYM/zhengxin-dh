import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SentenceSplitter, cleanSpeech, streamLlm, buildMessages } from '../lib/llm.mjs';
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
