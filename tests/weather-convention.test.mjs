import test from 'node:test';
import assert from 'node:assert/strict';
import { chinaDayTemps } from '../lib/tools.mjs';

// 2026-11-01 合肥的真实形态：凌晨 20℃（冷空气前），白天降到 15℃，当晚到次日清晨降到 11℃
function sample() {
  const time = [], temperature_2m = [];
  const day1 = [19, 20, 20, 20, 20, 17, 16, 16, 16.5, 16, 16, 16, 16, 15.7, 15.5, 15.2, 15, 14.9, 14.6, 14.4, 14.2, 14, 13.9, 13.8];
  const day2 = [13.8, 13.5, 13.2, 12.5, 12, 11.2, 11.5, 12, 12.3, 14, 16, 18, 19, 19.8, 20.1, 19.5, 18.3, 17, 15.5, 15, 14.7, 14.3, 14.1, 13.9];
  day1.forEach((v, h) => { time.push(`2026-11-01T${String(h).padStart(2, '0')}:00`); temperature_2m.push(v); });
  day2.forEach((v, h) => { time.push(`2026-11-02T${String(h).padStart(2, '0')}:00`); temperature_2m.push(v); });
  return {
    daily: { time: ['2026-11-01', '2026-11-02'], temperature_2m_min: [13.8, 11.2], temperature_2m_max: [20, 20.1] },
    hourly: { time, temperature_2m },
  };
}

test('天气按国内口径：白天 08–20 时最高、当晚 20 时到次日 08 时最低（不是 0–24 时自然日）', () => {
  const j = sample();
  assert.deepEqual(chinaDayTemps(j, 0), { temp_min: 11, temp_max: 17 }); // 自然日口径会是 14 到 20
});

test('缺逐时数据或缺次日数据时退回 daily', () => {
  const j = sample();
  assert.deepEqual(chinaDayTemps({ daily: j.daily }, 0), { temp_min: 14, temp_max: 20 });
  // 第二天没有次日 0–8 时数据：夜间只有 20–23 时 4 个点，不足 6 个，最低退回 daily
  assert.deepEqual(chinaDayTemps(j, 1), { temp_min: 11, temp_max: 20 });
});
