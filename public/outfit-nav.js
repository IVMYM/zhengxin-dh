/* 换装手势的纯逻辑（不碰 DOM）：浏览器与 node 测试共用。
 * swipeDir：横向滑动判定。横向位移超过阈值、且明显大于纵向位移才算换装；快速轻扫（短时间内）阈值放低。
 *   手指向左滑 = 下一套（+1），向右滑 = 上一套（-1），其余返回 0（交给轻触/长按/纵向滚动）。
 * cycle：在轮换列表里按方向循环取下标。 */
(function (root) {
  'use strict';
  function swipeDir(g, opts) {
    opts = opts || {};
    const min = opts.min == null ? 60 : opts.min;         // 普通拖动的最小横向距离（舞台坐标 px）
    const flickMin = opts.flickMin == null ? 36 : opts.flickMin; // 快速轻扫的最小距离
    const flickMs = opts.flickMs == null ? 260 : opts.flickMs;
    const ratio = opts.ratio == null ? 1.4 : opts.ratio;  // 横向必须是纵向的 1.4 倍以上
    const dx = Number(g && g.dx) || 0, dy = Number(g && g.dy) || 0, dt = Number(g && g.dt) || 0;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < ratio * ay) return 0;
    const need = dt > 0 && dt <= flickMs ? flickMin : min;
    if (ax < need) return 0;
    return dx < 0 ? 1 : -1;
  }
  function cycle(len, i, dir) {
    if (!(len > 0)) return -1;
    const base = i >= 0 && i < len ? i : (dir < 0 ? 0 : -1);
    return (((base + dir) % len) + len) % len;
  }
  root.DHOutfitNav = { swipeDir, cycle };
})(typeof window !== 'undefined' ? window : globalThis);
