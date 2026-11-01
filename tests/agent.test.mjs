import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamLlm, META_TALK } from '../lib/llm.mjs';
import { runTool, loadBranch, _weather, TOOL_DEFS } from '../lib/tools.mjs';
import { answerStream } from '../lib/brain.mjs';

/** 假的 OpenAI 兼容服务：按脚本逐次返回 SSE（工具调用或正文）或错误码 */
function mockLlm(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      if (step.status) { res.writeHead(step.status); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
      if (step.call) {
        send({ content: '\n' });
        send({ tool_calls: [{ index: 0, id: 'c1', function: { name: step.call, arguments: '' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args || {}) } }] }, 'tool_calls');
      } else {
        for (const t of step.text.match(/.{1,4}/gsu)) send({ content: t });
        send({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    cfg: { enabled: true, baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'm', apiKey: 'k', firstMs: 5000, timeoutMs: 8000, extra: {} },
    seen, close: () => srv.close(),
  })));
}
const fakeTool = (calls) => async (name, args) => { calls.push({ name, args }); return { ok: true, data: { city: '贵阳', weather: '小雨', temp_min: 12, temp_max: 17 }, say: '贵阳今天小雨，12到17度。', ms: 1 }; };

test('模型调用工具：执行后把结果交回模型，再流式作答', async () => {
  const m = await mockLlm([{ call: 'get_weather', args: { city: '贵阳', day: 'today' } }, { text: '贵阳今天有小雨，气温十二到十七度。出门记得带伞。' }]);
  const calls = []; const sentences = [];
  try {
    const out = await streamLlm('贵阳今天天气怎么样', [], [], m.cfg, (s) => sentences.push(s), { tools: TOOL_DEFS, runTool: fakeTool(calls) });
    assert.deepEqual(calls, [{ name: 'get_weather', args: { city: '贵阳', day: 'today' } }]);
    assert.equal(sentences.join(''), '贵阳今天有小雨，气温十二到十七度。出门记得带伞。');
    assert.equal(out.tools[0].name, 'get_weather');
    assert.ok(m.seen[0].tools.length >= 4);
    const second = m.seen[1].messages;
    assert.equal(second.at(-2).tool_calls[0].function.name, 'get_weather');
    assert.equal(second.at(-1).role, 'tool');
    assert.match(second.at(-1).content, /小雨/);
  } finally { m.close(); }
});

test('工具执行后大模型失败（如 429）：用工具自带口径作答', async () => {
  const m = await mockLlm([{ call: 'get_weather' }, { status: 429 }]);
  try {
    const out = await streamLlm('天气', [], [], m.cfg, () => {}, { tools: TOOL_DEFS, runTool: fakeTool([]) });
    assert.equal(out.speech, '贵阳今天小雨，12到17度。');
  } finally { m.close(); }
});

test('第一次请求就失败：返回 null，由调用方回落知识库', async () => {
  const m = await mockLlm([{ status: 429 }]);
  try { assert.equal(await streamLlm('天气', [], [], m.cfg, () => {}, { tools: TOOL_DEFS, runTool: fakeTool([]) }), null); } finally { m.close(); }
});

test('工具轮数上限：连续要工具时，第 3 次请求禁止工具', async () => {
  const m = await mockLlm([{ call: 'get_time' }, { call: 'get_time' }, { text: '今天是星期日。' }]);
  try {
    const out = await streamLlm('今天呢', [], [], m.cfg, () => {}, { tools: TOOL_DEFS, runTool: fakeTool([]) });
    assert.equal(m.seen.length, 3);
    assert.equal(m.seen[2].tool_choice, 'none');
    assert.equal(out.speech, '今天是星期日。');
  } finally { m.close(); }
});

test('自我说明句（按规则…）整句丢弃', async () => {
  assert.ok(META_TALK.test('这不是征信问题，按规则2日常话题简短回应。'));
  assert.ok(!META_TALK.test('您可以带身份证到柜台查询。'));
  const m = await mockLlm([{ text: '这不是征信问题，按规则2简短回应。这个需要咨询大堂经理。' }]);
  try {
    const out = await streamLlm('开户要带什么', [], [], m.cfg, () => {});
    assert.equal(out.speech, '这个需要咨询大堂经理。');
  } finally { m.close(); }
});

test('流式问答入口：KB 有把握的征信问题仍用审定口径，不调大模型', async () => {
  const m = await mockLlm([{ text: '不该被调用。' }]);
  try {
    const events = [];
    const out = await answerStream('征信不良记录能花钱删除吗', { llm: { ...m.cfg, mode: 'kb-first' } }, (e) => events.push(e));
    assert.equal(out.source, 'kb');
    assert.equal(m.seen.length, 0);
  } finally { m.close(); }
});

test('工具：未知工具与超时不抛异常', async () => {
  assert.equal((await runTool('nope', {})).ok, false);
  const slow = { slow: () => new Promise((r) => setTimeout(() => r({ ok: true }), 10000)) };
  const t0 = Date.now();
  const out = await runTool('slow', {}, slow);
  assert.equal(out.ok, false);
  assert.ok(Date.now() - t0 < 5000);
});

test('网点信息：占位/空值不编造', async () => {
  const b = loadBranch();
  assert.ok(b && typeof b === 'object');
  const out = await runTool('branch_info', {});
  assert.equal(out.ok, true);
  if (!out.data.hours.weekday) assert.match(out.say, /以网点公示为准/);
});

test('天气：解析 Open-Meteo 数据并给出口径', async () => {
  const j = { current: { temperature_2m: 15.4, weather_code: 3 }, daily: { time: ['2026-11-01', '2026-11-02', '2026-11-03'], weather_code: [61, 0, 2], temperature_2m_max: [17.2, 20, 19], temperature_2m_min: [12.1, 11, 10], precipitation_probability_max: [80, 5, 10] } };
  const out = await _weather({ city: '测试市', day: 'tomorrow' }, async () => j);
  assert.equal(out.data.weather, '晴');
  assert.equal(out.say, '测试明天晴，11到20度，降水概率5%。');
});
