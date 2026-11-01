import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeNow, dateTimeAnswer, shanghaiParts } from '../lib/clock.mjs';
import { buildMessages } from '../lib/llm.mjs';
import { answer } from '../lib/brain.mjs';

// 2026-11-01 01:35 UTC = 北京时间 2026-11-01 星期日 09:35
const T = new Date('2026-11-01T01:35:00Z');

test('北京时间与服务器时区无关（UTC 深夜跨日也按北京时间算）', () => {
  assert.deepEqual(shanghaiParts(new Date('2026-10-31T16:30:00Z')), { year: 2026, month: 11, day: 1, hour: 0, minute: 30, weekday: '星期日' });
  assert.equal(describeNow(T), '北京时间2026年11月1日 星期日 上午9点35分');
});

test('大模型提示词带当前北京时间与不编造日期的规则', () => {
  const sys = buildMessages('今天适合出门吗', [], [], T)[0].content;
  assert.match(sys, /现在是北京时间2026年11月1日 星期日 上午9点35分/);
  assert.match(sys, /不要编造日期/);
  assert.match(sys, /本周是10月26日至11月1日；接下来7天：11月2日周一、11月3日周二/);
});

test('纯日期/星期/时间问题直接回答', () => {
  assert.equal(dateTimeAnswer('今天星期几', T), '今天是星期日，11月1日。');
  assert.equal(dateTimeAnswer('今天几号？', T), '今天是2026年11月1日，星期日。');
  assert.equal(dateTimeAnswer('明天星期几呀', T), '明天是星期一，11月2日。');
  assert.equal(dateTimeAnswer('昨天是几号', T), '昨天是2026年10月31日，星期六。');
  assert.equal(dateTimeAnswer('请问现在几点了', T), '现在是上午9点35分。');
  assert.equal(dateTimeAnswer('现在几点', new Date('2026-11-01T06:00:00Z')), '现在是下午2点整。');
  assert.equal(dateTimeAnswer('现在几点', new Date('2026-11-01T04:05:00Z')), '现在是中午12点零5分。');
  assert.equal(dateTimeAnswer('今天网点几点关门', T), null);
  assert.equal(dateTimeAnswer('征信报告多久更新', T), null);
});

test('问答入口：日期问题不经大模型', async () => {
  const out = await answer('今天星期几', { now: T, llm: { enabled: false } });
  assert.equal(out.source, 'rule');
  assert.equal(out.intent, 'datetime');
  assert.equal(out.speech, '今天是星期日，11月1日。');
});
