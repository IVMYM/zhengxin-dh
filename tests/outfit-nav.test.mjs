import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/outfit-nav.js';
const { swipeDir, cycle } = globalThis.DHOutfitNav;

test('横向滑动：左滑下一套、右滑上一套，纵向与短距离不算', () => {
  assert.equal(swipeDir({ dx: -120, dy: 10, dt: 400 }), 1);
  assert.equal(swipeDir({ dx: 120, dy: -20, dt: 400 }), -1);
  assert.equal(swipeDir({ dx: -40, dy: 0, dt: 500 }), 0);      // 慢拖太短
  assert.equal(swipeDir({ dx: -40, dy: 0, dt: 150 }), 1);      // 快速轻扫
  assert.equal(swipeDir({ dx: -90, dy: 120, dt: 300 }), 0);    // 偏纵向：交给滚动
  assert.equal(swipeDir({ dx: 0, dy: 0, dt: 100 }), 0);        // 轻触
  assert.equal(swipeDir(null), 0);
});

test('循环取下标：首尾相接，未知当前项从头/尾开始', () => {
  assert.equal(cycle(5, 4, 1), 0);
  assert.equal(cycle(5, 0, -1), 4);
  assert.equal(cycle(5, 2, 1), 3);
  assert.equal(cycle(5, -1, 1), 0);
  assert.equal(cycle(5, -1, -1), 4);
  assert.equal(cycle(0, 0, 1), -1);
  assert.equal(cycle(1, 0, -1), 0);
});
