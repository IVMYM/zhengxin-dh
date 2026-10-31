// check-av-sync.mjs 的数据分析：都按“耳朵听到的时间”（分析器时间 + 输出延迟）对比“眼睛看到的画面”。
const THR = 0.012;       // 有声音的 RMS 阈值（晓晓说话约 0.03~0.25，静音 < 0.003）
const MERGE = 0.06;      // 小于 60ms 的音量低谷算同一段声音
const MOVE_WIN = 50;     // 50ms 内（24fps 一帧 42ms）呈现过新的一帧（帧位置变了）且图层可见，算“嘴在动”

export function analyze(d) {
  const lat = ((d.lat && (d.lat.base + d.lat.output)) || 0) * 1000;
  const s = d.s.filter((x) => x.t >= (d.askAt || 0));
  const step = 1000 / 60;
  // 声音段（耳朵听到的时间）
  const voiced = [];
  for (const x of s) {
    const ta = x.t + lat;
    if (x.r > THR) {
      const last = voiced[voiced.length - 1];
      if (last && ta - last.end <= MERGE * 1000) last.end = ta; else voiced.push({ start: ta, end: ta });
    }
  }
  for (const v of voiced) v.end += step;
  // 画面“在动”：说话视频/口型视频可见且有新帧
  const opAt = (t, key) => { let lo = 0, hi = s.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].t <= t) lo = m; else hi = m - 1; } return s[lo] ? s[lo][key] : 0; };
  const moves = [];
  for (const [id, key] of [['vTalk', 'oT'], ['vLip', 'oL']]) {
    const fr = (d.frames[id] || []).filter((f) => f.t >= (d.askAt || 0));
    for (let i = 1; i < fr.length; i++) if (Math.abs(fr[i].mt - fr[i - 1].mt) > 1e-4 && opAt(fr[i].x || fr[i].t, key) >= 0.5) moves.push(fr[i].x || fr[i].t);
  }
  moves.sort((a, b) => a - b);
  const movingAt = (t) => { let lo = 0, hi = moves.length; while (lo < hi) { const m = (lo + hi) >> 1; if (moves[m] <= t) lo = m + 1; else hi = m; } return lo > 0 && t - moves[lo - 1] <= MOVE_WIN; };
  if (!voiced.length) return { label: d.label, mode: d.mode, error: '没有检测到声音', errors: d.errors };
  const v0 = voiced[0].start, v1 = voiced[voiced.length - 1].end;
  const firstMove = moves.find((t) => t >= v0 - 3000);
  const lastMove = [...moves].reverse().find((t) => t <= v1 + 5000);
  // 静音段（声音之间 ≥150ms）
  const ends = [...d.ev.filter((e) => e.e === 'ended').map((e) => e.t + lat), ...(d.dhEvents || []).filter((e) => e.type === 'done').map((e) => e.at + lat)];
  const sil = [];
  for (let i = 1; i < voiced.length; i++) {
    const a = voiced[i - 1].end, b = voiced[i].start;
    if (b - a < 150) continue;
    let mv = 0, firstStill = null, resume = null;
    for (let t = a; t < b; t += 5) { if (movingAt(t)) mv += 5; else if (firstStill === null) firstStill = t; }
    for (let t = b - 200; t < b + 600; t += 5) if (movingAt(t) && !movingAt(t - 5 - MOVE_WIN)) { resume = t; if (t >= b - 200) break; }
    sil.push({ at: Math.round(a - v0), ms: Math.round(b - a), chunkGap: ends.some((e) => e > a - 400 && e < b), movingMs: mv, stopAfter: firstStill === null ? null : Math.round(firstStill - a), resumeVsVoice: resume === null ? null : Math.round(resume - b) });
  }
  let still = 0, speech = 0;
  for (const v of voiced) for (let t = v.start; t < v.end; t += 5) { speech += 5; if (!movingAt(t)) still += 5; }
  const chunkGaps = sil.filter((x) => x.chunkGap); const pauses = sil.filter((x) => !x.chunkGap);
  const sum = (a, k) => a.reduce((p, x) => p + (x[k] || 0), 0);
  // 预渲染口型视频：每一帧画面的位置 vs 此刻耳朵听到的音频位置（正数：画面落后于声音）
  let lip = null;
  const lf = (d.frames.vLip || []).filter((f) => f.t >= (d.askAt || 0));
  if (lf.length) {
    const offs = [];
    for (const f of lf) {
      const tx = f.x || f.t;
      if (opAt(tx, 'oL') < 0.5) continue;
      let lo = 0; while (lo + 1 < s.length && s[lo + 1].t <= tx) lo++;
      const a = s[lo], b = s[lo + 1];
      if (!a || !b || !a.pl) continue;
      const ct = a.ct + (b.ct - a.ct) * ((tx - a.t) / Math.max(1, b.t - a.t));
      offs.push((ct - lat / 1000 - f.mt) * 1000);
    }
    if (offs.length) {
      const so = [...offs].sort((x, y) => x - y), q = (p) => Math.round(so[Math.min(so.length - 1, Math.floor(p * so.length))]);
      lip = { frames: offs.length, median: q(0.5), p10: q(0.1), p90: q(0.9), maxAbs: Math.round(Math.max(...offs.map(Math.abs))), firstFrames: offs.slice(0, 5).map(Math.round), master: s.some((x) => x.lipMaster) ? '视频自带声音' : '静音视频追音频' };
    }
  }
  return {
    lip,
    label: d.label, mode: d.mode, outLatencyMs: Math.round(lat), chunks: d.texts.length,
    speechMs: Math.round(speech),
    onsetMs: firstMove == null ? null : Math.round(firstMove - v0),            // 正数：嘴比声音晚动
    endMs: lastMove == null ? null : Math.round(lastMove + MOVE_WIN - v1),    // 正数：声音停了嘴还在动
    gapCount: chunkGaps.length, gapMeanMs: chunkGaps.length ? Math.round(sum(chunkGaps, 'ms') / chunkGaps.length) : 0,
    gapMovingMs: sum(chunkGaps, 'movingMs'),                                   // 句间空档里嘴在动的总时长
    pauseCount: pauses.length, pauseMovingMs: sum(pauses, 'movingMs'),         // 句中停顿里嘴在动的总时长
    stillInVoiceMs: still,                                                     // 有声音但嘴不动的总时长
    silences: sil, errors: d.errors,
  };
}

export function table(rs) {
  const head = ['标签', '模式', '输出延迟', '开口偏差', '收尾偏差', '句间空档(次/均ms)', '空档里嘴动ms', '句中停顿次数', '停顿里嘴动ms', '有声嘴不动ms', '说话总ms'];
  const rows = rs.map((r) => [r.label, r.mode, r.outLatencyMs, r.onsetMs, r.endMs, `${r.gapCount}/${r.gapMeanMs}`, r.gapMovingMs, r.pauseCount, r.pauseMovingMs, r.stillInVoiceMs, r.speechMs]);
  return [head, ...rows].map((r) => r.join('\t')).join('\n');
}
