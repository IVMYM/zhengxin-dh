import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, normalize } from '../lib/router.mjs';
import { answer, maskPII } from '../lib/brain.mjs';
import { parseLlmOutput } from '../lib/llm.mjs';
import { KB, SUGGESTIONS, KIOSK_STEPS, SAMPLE_PERSON } from '../lib/kb.mjs';

const OFF = { enabled: false };

test('常见问法路由到正确意图', () => {
  const cases = {
    '怎么查个人信用报告': 'query_channels',
    '我想查一下个人信用报告': 'query_channels',
    '自助查询机怎么操作': 'kiosk_flow',
    '手机银行能查征信吗': 'online_query',
    '查询要收费吗': 'fee',
    '报告里有哪些内容': 'report_content',
    '逾期记录保存多久': 'retention',
    '不良记录五年后会删除吗': 'retention',
    '报告信息有错怎么办': 'dispute',
    '我的贷款记录不是我办的': 'dispute',
    '有人说花钱能修复征信': 'repair_scam',
    '征信洗白靠谱吗': 'repair_scam',
    '别人能随便查我的征信吗': 'privacy',
    '企业信用报告怎么查': 'enterprise',
    '应收账款质押登记怎么办': 'movable',
    '怎样维护良好信用': 'tips',
    '查多了会影响信用吗': 'query_impact',
    '柜台查询要带什么材料': 'counter',
  };
  for (const [q, intent] of Object.entries(cases)) assert.equal(route(q).intent, intent, q);
});

test('推荐问题全部能命中知识库', () => {
  for (const q of SUGGESTIONS) assert.notEqual(route(q).intent, 'fallback', q);
});

test('寒暄、转人工与兜底', () => {
  assert.equal(route('你好').intent, 'greet');
  assert.equal(route('您好小信').intent, 'greet');
  assert.equal(route('谢谢').intent, 'thanks');
  assert.equal(route('我要找大堂经理').intent, 'human');
  assert.equal(route('今天股票涨了吗').intent, 'fallback');
});

test('离线识别常见误字纠正', () => {
  assert.equal(normalize('正信报告怎么查？'), '征信报告怎么查');
  assert.equal(route('一义申请怎么办').intent, 'dispute');
});

test('自助查询流程中识别导航指令', () => {
  assert.equal(route('下一步', { flow: true }).intent, 'nav_next');
  assert.equal(route('再说一遍', { flow: true }).intent, 'nav_prev');
  assert.equal(route('退出指引', { flow: true }).intent, 'nav_exit');
  assert.notEqual(route('下一步').intent, 'nav_next'); // 不在流程中时不当作导航
});

test('answer：离线模式下返回口播与卡片', async () => {
  const r = await answer('逾期记录保存多久', { llm: OFF });
  assert.equal(r.source, 'kb');
  assert.match(r.speech, /五年/);
  assert.ok(r.card && r.card.items.length >= 3);
  const k = await answer('自助查询机怎么操作', { llm: OFF });
  assert.equal(k.action, 'kiosk_flow');
  const f = await answer('明天会下雨吗', { llm: OFF });
  assert.equal(f.intent, 'fallback');
  assert.ok(f.speech.length > 10);
});

test('大模型不可用时自动回落知识库', async () => {
  const r = await answer('征信报告里有哪些内容', { llm: { enabled: true, baseUrl: 'http://127.0.0.1:9', model: 'x', timeoutMs: 500 }, llmFirst: true });
  assert.equal(r.source, 'kb');
  assert.equal(r.intent, 'report_content');
});

test('大模型输出解析', () => {
  const p = parseLlmOutput('好的：{"speech":"可以在手机银行查询。","card":{"title":"渠道","items":[{"t":"手机银行","d":"在线查询"}]}}');
  assert.equal(p.speech, '可以在手机银行查询。');
  assert.equal(p.card.items[0].t, '手机银行');
  assert.equal(parseLlmOutput('纯文本答复').speech, '纯文本答复');
});

test('口播长度适合朗读', () => {
  for (const e of KB) assert.ok(e.speech.length <= 130, `${e.id} 口播过长：${e.speech.length}`);
});

test('个人信息全部脱敏', () => {
  assert.equal(maskPII('身份证110101199001011234，电话13812345678'), '身份证110101********1234，电话138****5678');
  const all = JSON.stringify({ KB, KIOSK_STEPS, SAMPLE_PERSON });
  assert.doesNotMatch(all, /\d{17}[\dXx]/); // 无完整身份证号
  assert.doesNotMatch(all, /1[3-9]\d{9}/); // 无完整手机号
  assert.match(SAMPLE_PERSON.name, /^.\*$/);
});
