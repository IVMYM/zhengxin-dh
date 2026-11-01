import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWeatherCn, stationFor } from '../lib/weathercn.mjs';
import { _weather } from '../lib/tools.mjs';

const HTML = readFileSync(new URL('./fixtures/weathercn-101220101.html', import.meta.url), 'utf8');
const NOW = new Date('2026-11-01T20:20:00+08:00');
const om = async () => ({
  current: { temperature_2m: 14.2, weather_code: 61 },
  daily: { time: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], weather_code: [61, 3, 80, 61], temperature_2m_max: [19.8, 20.3, 18.4, 16], temperature_2m_min: [13.8, 10.7, 13.6, 11], precipitation_probability_max: [100, 7, 92, 60] },
});

test('中国天气网页面解析：今天/明天/后天的天气与最高/最低', () => {
  assert.deepEqual(parseWeatherCn(HTML, NOW), [
    { date: '2026-11-01', weather: '小雨转阴', temp_min: 8, temp_max: 16 },
    { date: '2026-11-02', weather: '多云转阴', temp_min: 11, temp_max: 20 },
    { date: '2026-11-03', weather: '小雨转中雨', temp_min: 14, temp_max: 18 },
  ]);
});

test('解析拒绝：页面错位（不是今天）、结构不对、温度不合理', () => {
  assert.throws(() => parseWeatherCn(HTML, new Date('2026-11-02T10:00:00+08:00')), /date mismatch/);
  assert.throws(() => parseWeatherCn('<html>维护中</html>', NOW), /no forecast list/);
  assert.throws(() => parseWeatherCn(HTML.replace('<span>20</span>', '<span>5</span>'), NOW), /bad high/);
  // 傍晚后页面只给今天夜间最低：允许，最高温留空
  const evening = parseWeatherCn(HTML.replace('<span>16</span>/', ''), NOW);
  assert.equal(evening[0].temp_min, 8); assert.ok(Number.isNaN(evening[0].temp_max));
});

test('站点表：合肥内置，branch.json 可覆盖/新增，WEATHER_CN=0 关闭', () => {
  assert.equal(stationFor('合肥', {}, {}), '101220101');
  assert.equal(stationFor('芜湖', { weatherStations: { 芜湖: '101220301' } }, {}), '101220301');
  assert.equal(stationFor('贵阳', {}, {}), '');
  assert.equal(stationFor('合肥', {}, { WEATHER_CN: '0' }), '');
});

test('合肥天气用中国天气网的数字；不带降水概率', async () => {
  const out = await _weather({ city: '合肥', day: 'today' }, om, { station: '101220101', cnFetch: async () => HTML, now: NOW });
  assert.equal(out.say, '合肥今天小雨转阴，8到16度。');
  assert.equal(out.data.days[1].summary, '明天多云转阴，11到20度');
  assert.match(out.data.source, /中国天气网/);
});

test('中国天气网页面异常时自动退回 Open-Meteo（并打日志）', async () => {
  const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try {
    const out = await _weather({ city: '合肥测试', day: 'today' }, om, { station: '101220101', cnFetch: async () => '<html><body>502 Bad Gateway</body></html>', now: NOW });
    assert.equal(out.say, '合肥测试今天小雨，14到20度，降水概率100%。'); // 测试数据无逐时，用 daily
    assert.match(out.data.source, /Open-Meteo/);
    assert.ok(warns.some((w) => /中国天气网不可用.*改用 Open-Meteo/.test(w)));
    const out2 = await _weather({ city: '合肥测试2', day: 'today' }, om, { station: '101220101', cnFetch: async () => { throw new Error('timeout'); }, now: NOW });
    assert.match(out2.data.source, /Open-Meteo/);
  } finally { console.warn = orig; }
});

test('傍晚后页面缺今天最高温：用 Open-Meteo 的白天最高补上', async () => {
  const out = await _weather({ city: '合肥傍晚', day: 'today' }, om, { station: '101220101', cnFetch: async () => HTML.replace('<span>16</span>/', ''), now: NOW });
  assert.equal(out.say, '合肥傍晚今天小雨转阴，8到20度。');
});
