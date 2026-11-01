import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { webSearch, NO_SEARCH, _resetForTest } from '../lib/websearch.mjs';
import { toolDefs } from '../lib/tools.mjs';
import { streamLlm } from '../lib/llm.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')), 'usage.json');
const cfg = (o = {}) => ({ key: 'k', enabled: true, dailyLimit: 2, timeoutMs: 1000, cacheMs: 60000, maxResults: 3, ...o });
const okFetch = (calls) => async (url, init) => {
  calls.push(JSON.parse(init.body));
  return { ok: true, json: async () => ({ answer: '安妮·卡森获2026年诺贝尔文学奖。', results: [{ title: '加拿大诗人安妮·卡森获奖', content: 'x'.repeat(400), url: 'https://example.com/a' }] }) };
};

test('联网搜索：只给模型简短摘要，不含网址；有缓存', async () => {
  _resetForTest();
  const calls = []; const f = tmp();
  const a = await webSearch({ query: '今年诺贝尔文学奖是谁' }, { cfg: cfg(), fetcher: okFetch(calls), usageFile: f });
  assert.equal(a.ok, true);
  assert.equal(calls[0].search_depth, 'basic');
  assert.ok(a.data.results[0].snippet.length <= 161);
  assert.ok(!JSON.stringify(a.data).includes('http'));
  const b = await webSearch({ query: '今年诺贝尔文学奖是谁' }, { cfg: cfg(), fetcher: okFetch(calls), usageFile: f });
  assert.equal(b.cached, true);
  assert.equal(calls.length, 1);
});

test('联网搜索：每日上限、未开启、不宜话题都不调用 Tavily', async () => {
  _resetForTest();
  const calls = []; const f = tmp();
  await webSearch({ query: 'a1' }, { cfg: cfg(), fetcher: okFetch(calls), usageFile: f });
  await webSearch({ query: 'a2' }, { cfg: cfg(), fetcher: okFetch(calls), usageFile: f });
  const over = await webSearch({ query: 'a3' }, { cfg: cfg(), fetcher: okFetch(calls), usageFile: f });
  assert.equal(over.ok, false); assert.match(over.data.error, /用完/);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).count, 2);
  assert.equal((await webSearch({ query: 'x' }, { cfg: cfg({ enabled: false }), fetcher: okFetch(calls), usageFile: tmp() })).ok, false);
  for (const q of ['推荐一只股票', '怎么查征信报告', '征信修复公司靠谱吗', '感冒吃什么药']) {
    assert.ok(NO_SEARCH.test(q), q);
    assert.equal((await webSearch({ query: q }, { cfg: cfg(), fetcher: okFetch(calls), usageFile: tmp() })).ok, false);
  }
  assert.equal(calls.length, 2);
  assert.ok(!NO_SEARCH.test('合肥最近有什么新闻'));
});

test('只有配置了密钥才提供 web_search 工具', () => {
  assert.ok(!toolDefs({}).some((t) => t.function.name === 'web_search'));
  assert.ok(toolDefs({ TAVILY_API_KEY: 'k' }).some((t) => t.function.name === 'web_search'));
  assert.ok(!toolDefs({ TAVILY_API_KEY: 'k', WEB_SEARCH: '0' }).some((t) => t.function.name === 'web_search'));
});

function mockLlm(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      if (step.status) { res.writeHead(step.status); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (d) => res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
      if (step.call) send({ tool_calls: [{ index: 0, id: 'c1', function: { name: step.call, arguments: '{"query":"诺贝尔文学奖"}' } }] });
      else send({ content: step.text });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ cfg: { enabled: true, baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'm', firstMs: 5000, timeoutMs: 8000, extra: {} }, seen, close: () => srv.close() })));
}
const defs = toolDefs({ TAVILY_API_KEY: 'k' });
const fillers = { web_search: '我帮您查一下网上的公开信息。' };

test('调用联网搜索时先说垫话，再说结果', async () => {
  const m = await mockLlm([{ call: 'web_search' }, { text: '据网上公开信息，今年的诺贝尔文学奖颁给了加拿大诗人安妮·卡森。' }]);
  const sent = [];
  try {
    const out = await streamLlm('今年诺贝尔文学奖是谁', [], [], m.cfg, (s) => sent.push(s), { tools: defs, fillers, runTool: async () => ({ ok: true, data: { answer: '安妮·卡森' }, say: '', ms: 5 }) });
    assert.equal(sent[0], '我帮您查一下网上的公开信息。');
    assert.match(out.speech, /^我帮您查一下网上的公开信息。据网上公开信息/);
  } finally { m.close(); }
});

test('垫话之后大模型失败：补一句“没查到”，不回落成别的话', async () => {
  const m = await mockLlm([{ call: 'web_search' }, { status: 429 }]);
  const sent = [];
  try {
    const out = await streamLlm('今年诺贝尔文学奖是谁', [], [], m.cfg, (s) => sent.push(s), { tools: defs, fillers, runTool: async () => ({ ok: true, data: {}, say: '', ms: 5 }) });
    assert.equal(sent.length, 2);
    assert.match(out.speech, /没查到可靠信息/);
  } finally { m.close(); }
});
