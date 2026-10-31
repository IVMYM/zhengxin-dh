/* 音量门控说话视频：说话时播原始说话视频，停顿时停在说话视频里一帧真实的闭嘴画面，出声时从那一帧接着播。
 * 画面全部是原视频的真实帧：不贴图、不变形、两帧之间也不混合。
 * 为了让停顿那一刻正好落在闭嘴帧上：按 TTS 逐词时间戳提前知道整句话的停顿在哪，规划一条路线
 * （起始帧 + 每个停顿落在哪帧闭嘴画面，结尾优先落在与待机姿势一致的帧），
 * 播放时把速度在 0.8~1.25 倍之间微调，按时走到（闭嘴帧由 scripts/build-talk-gate.py 离线标好）。
 * 没有时间戳时退回按音量判断：安静超过 150ms 就把画面快放到下一帧闭嘴画面停住。
 * 只做逻辑，不碰 DOM：浏览器、node 测试和样片渲染共用同一份代码。 */
(function (root) {
  'use strict';
  const RATE_MIN = 0.8, RATE_MAX = 1.25, RUN_RATE = 1.5;
  // 最后一段放宽一点：为了收尾停在与待机姿势一致的帧（接回待机视频时手势不重影）
  const FINAL_MIN = 0.75, FINAL_MAX = 1.4, END_PENALTY = 3, SKIP_COST = 3;
  const bounds = (final) => (final ? [FINAL_MIN, FINAL_MAX] : [RATE_MIN, RATE_MAX]);

  /** 声音门：RMS 超过 gate 视为在说话；连续安静超过 holdMs 才算停顿（字间的短暂低谷不算） */
  function VoiceGate(opts) {
    opts = opts || {};
    this.gate = opts.gate == null ? 0.02 : opts.gate;
    this.holdMs = opts.holdMs == null ? 150 : opts.holdMs;
    this.quietMs = 1e9;
  }
  VoiceGate.prototype.update = function (rms, dtMs) {
    if ((rms || 0) > this.gate) this.quietMs = 0; else this.quietMs += dtMs;
    return this.speaking();
  };
  VoiceGate.prototype.speaking = function () { return this.quietMs < this.holdMs; };

  /** 逐词时间戳 → 停顿区间 [{start, end}]（秒）。第一个词之前是开头停顿（start=-Infinity，音频开头约 0.2 秒静音时不开口）；
   *  词间空隙 ≥ minGap 才算停顿；最后一个词之后是结尾停顿（end=Infinity） */
  function pausesFrom(words, minGap) {
    minGap = minGap == null ? 0.15 : minGap;
    const out = []; let prevEnd = 0;
    const ws = (words || []).filter((w) => w && isFinite(w.t)).slice().sort((a, b) => a.t - b.t);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (i > 0 && w.t - prevEnd >= minGap) out.push({ start: prevEnd, end: w.t });
      prevEnd = Math.max(prevEnd, w.t + (w.d || 0));
    }
    if (ws.length) { out.push({ start: prevEnd, end: Infinity }); out.unshift({ start: -Infinity, end: ws[0].t }); }
    return out;
  }

  const mod = (a, n) => ((a % n) + n) % n;
  function isClosed(meta, f) { return meta.closed.charAt(mod(Math.floor(f), meta.n)) === '1'; }

  /** 说话段落：[{from, to}]（秒），to 是下一个停顿开始；最后一段的 to 是结尾停顿开始 */
  function segmentsFrom(pauses, t0) {
    const segs = []; let from = t0;
    for (const p of pauses) {
      if (p.end <= t0) continue;
      if (p.start > from) segs.push({ from, to: p.start, final: p.end === Infinity });
      from = Math.max(from, p.end);
      if (p.end === Infinity) break;
    }
    return segs;
  }

  /** 从帧 p 播 secs 秒到闭嘴帧 k：可多绕几圈，选速度最接近 1 的圈数。返回 {d 要走的帧数, r 速度} */
  function reach(meta, p, k, secs) {
    const n = meta.n, need = Math.max(0.001, secs) * meta.fps;
    let d = mod(k + 0.5 - p, n);
    if (d < 0.3) d += n;
    let best = null;
    for (let j = 0; j < 8; j++) {
      const dd = d + j * n, r = dd / need;
      if (!best || Math.abs(Math.log(r)) < Math.abs(Math.log(best.r))) best = { d: dd, r };
      if (r > 1) break;
    }
    return best;
  }

  /**
   * 整段话的路线：每个停顿落在哪一帧闭嘴画面（动态规划，全局最优）。
   * starts：可选的起始帧（刚开口时 = 与待机姿势一致的闭嘴帧；说到一半才拿到时间戳时 = 当前帧）。
   * 每段按时到达（速度在 0.8~1.25 倍内）优先，其次速度越接近 1 越好；结尾优先落在与待机姿势一致的帧。
   * 返回 {start, stops: [{at 停顿开始秒数, frame}], misses 够不着的停顿数}
   */
  function route(meta, starts, t0, pauses) {
    const segs = segmentsFrom(pauses || [], t0);
    const closed = [];
    for (let k = 0; k < meta.n; k++) if (meta.closed.charAt(k) === '1') closed.push(k);
    if (!segs.length || !closed.length) return { start: starts[0], stops: [], misses: 0 };
    const n = meta.n, fps = meta.fps;
    // 状态：当前位置（帧，带小数）、累计代价、经过的落点
    let layer = starts.map((s) => ({ pos: s, cost: 0, path: [], start: s }));
    segs.forEach((seg, si) => {
      const secs = seg.to - seg.from;
      const pauseSecs = si + 1 < segs.length ? segs[si + 1].from - seg.to : 0;
      const next = new Map();
      const put = (st) => { const key = Math.round(st.pos * 2); const o = next.get(key); if (!o || st.cost < o.cost) next.set(key, st); };
      for (const st of layer) {
        let anyFit = false;
        for (const k of closed) {
          const rr = reach(meta, st.pos, k, secs);
          const [lo, hi] = bounds(seg.final);
          if (rr.r < lo || rr.r > hi) continue;
          anyFit = true;
          let c = st.cost + Math.abs(Math.log(rr.r));
          if (seg.final && meta.endOk) c += meta.endOk.charAt(k) === '1' ? 0 : END_PENALTY;
          put({ pos: k + 0.5, cost: c, path: st.path.concat([{ at: seg.to, frame: k, fit: true, final: seg.final }]), start: st.start });
        }
        if (!seg.final) {
          // 跳过这个句中停顿（嘴照常动过去，和 loop 一样）：换来后面的停顿、尤其句末能按时闭嘴
          const pos = mod(st.pos + (secs + pauseSecs) * fps, n);
          put({ pos, cost: st.cost + SKIP_COST, path: st.path.concat([{ at: seg.to, frame: null, fit: false, skip: true }]), start: st.start });
        }
        if (!anyFit) {
          // 够不着：照常速播，停顿开始后快放到下一帧闭嘴画面（嘴会晚一点闭上）
          let pos = mod(st.pos + secs * fps, n);
          let steps = 0; const maxSteps = Math.max(1, pauseSecs) * fps * RUN_RATE;
          while (!isClosed(meta, pos) && steps < maxSteps) { pos = mod(pos + 1, n); steps++; }
          put({ pos, cost: st.cost + 10 + (seg.final ? END_PENALTY : 0), path: st.path.concat([{ at: seg.to, frame: Math.floor(pos), fit: false, final: seg.final }]), start: st.start });
        }
      }
      layer = [...next.values()];
    });
    const best = layer.reduce((a, b) => (b.cost < a.cost ? b : a));
    return { start: best.start, stops: best.path, misses: best.path.filter((x) => !x.fit && !x.skip).length, skips: best.path.filter((x) => x.skip).map((x) => x.at) };
  }

  /** 开口时可选的起始帧：与待机姿势一致的闭嘴帧（不跳手势） */
  function startFrames(meta) {
    const out = [];
    const ok = meta.startOk || meta.endOk;
    for (let k = 0; k < meta.n; k++) if (ok ? ok.charAt(k) === '1' : k === 0) out.push(k + 0.5);
    return out.length ? out : [0.5];
  }

  /**
   * deck 接口（一个说话视频播放器）：frame() 当前帧号（可带小数）；play()；pause()；seek(frame)；setRate(r)。
   */
  function GatePlayer(meta, deck, opts) {
    opts = opts || {};
    this.meta = meta; this.deck = deck;
    this.offAfterMs = opts.offAfterMs || 700;  // 整段话说完、安静这么久后回到待机视频
    this.resetAfterMs = opts.resetAfterMs || 1200;
    this.lead = opts.lead == null ? 0.04 : opts.lead; // 停顿结束前提前这么多秒开播，嘴型跟上声音
    this.stallMs = opts.stallMs || 120; this.lastT = -1; this.tMovedAt = -1e9;
    this.state = 'off'; this.quietSince = 0; this.offAt = -1e9; this.plan = null; this.planFor = null; this.primed = null;
  }
  /**
   * 每帧调用。inp: {t 播报音频当前秒数, pauses 停顿区间（没有时间戳时为 null）, speaking 音量门, active 播报是否还在进行}
   * 返回 true 表示应显示说话视频（否则显示待机视频）。
   */
  GatePlayer.prototype.tick = function (now, inp) {
    const m = this.meta, D = this.deck;
    const t = inp.t || 0;
    // 音频时钟卡住（流式音频还在缓冲、句与句之间）时不往前播，当作停顿处理，免得画面跑到声音前面
    if (t !== this.lastT) { this.lastT = t; this.tMovedAt = now; }
    const stalled = inp.pauses && now - this.tMovedAt > this.stallMs;
    let inPause = null;
    // 拿到这句话的时间戳：规划整段路线（刚开口时连起始帧一起选）
    if (inp.pauses && inp.active && this.planFor !== inp.pauses) {
      const fresh = this.state === 'off' && now - this.offAt > this.resetAfterMs;
      this.plan = route(m, fresh ? startFrames(m) : [D.frame()], t, inp.pauses);
      this.planFor = inp.pauses;
      if (fresh) this.seekTo = this.plan.start;
    }
    const skips = this.plan && this.planFor === inp.pauses ? this.plan.skips : null;
    if (inp.pauses && inp.active) for (const p of inp.pauses) if (t >= p.start && t < p.end - this.lead && !(skips && skips.includes(p.start))) { inPause = p; break; }
    // 该不该出声的画面：有时间戳按时间戳，没有就按音量
    const talkNow = inp.active && (inp.pauses ? !inPause && !stalled : inp.speaking);
    if (talkNow) this.quietSince = now;
    switch (this.state) {
      case 'off': {
        // 久未说话：从与待机姿势一致的帧开始，避免一出声就跳手势。
        // 音频已在播（开头静音）时先把说话视频拨到起始帧（图层还没显示），真正出声时立刻就能播，不用等跳转解码
        const fresh = now - this.offAt > this.resetAfterMs;
        const target = fresh ? Math.floor(this.seekTo != null ? this.seekTo : startFrames(m)[0]) : null;
        if (!talkNow) {
          if (!inp.active) return false;
          // 回答已开始、还没出声（音频开头静音 / 首句还在缓冲）：先显示说话视频的起始闭嘴帧（与待机姿势一致），
          // 出声那一刻直接开播，不用再等图层淡入
          if (target != null && this.primed !== target) { D.seek(target); this.primed = target; }
          D.pause(); this.seekTo = null; this.primed = null; this.quietSince = now; this.state = 'hold';
          return true;
        }
        if (target != null && this.primed !== target) D.seek(target);
        this.seekTo = null; this.primed = null;
        D.setRate(1); D.play(); this.state = 'talk';
        break;
      }
      case 'talk': {
        if (!talkNow) {
          const f = D.frame();
          if (isClosed(m, f)) { D.pause(); this.state = 'hold'; break; }
          // 刚刚走过闭嘴帧 1~2 帧（播放时钟有一两帧抖动）：退回那一帧停住（相邻帧几乎一样，看不出跳），
          // 否则要快放到下一组闭嘴帧，嘴会在没声音时多动 0.5 秒以上
          for (let k = 1; k <= 2; k++) if (isClosed(m, f - k)) { D.pause(); D.seek(mod(Math.floor(f) - k, m.n)); this.state = 'hold'; break; }
          if (this.state === 'hold') break;
          D.setRate(RUN_RATE); this.state = 'run';
          break;
        }
        // 按路线调速：正好在下一个停顿开始时走到计划的闭嘴帧
        const stop = this.plan && this.planFor === inp.pauses ? this.plan.stops.find((x) => x.at > t && !x.skip) : null;
        if (stop && stop.fit) {
          const rr = reach(m, D.frame(), stop.frame, stop.at - t);
          const [lo, hi] = bounds(stop.final);
          D.setRate(Math.min(hi, Math.max(lo, rr.r)));
        } else D.setRate(1);
        break;
      }
      case 'run': // 停顿开始时嘴还开着：快放到下一帧闭嘴画面
        if (talkNow) { D.setRate(1); this.state = 'talk'; this.planFor = null; break; }
        if (isClosed(m, D.frame())) { D.pause(); this.state = 'hold'; }
        break;
      case 'hold':
        if (talkNow) { D.setRate(1); D.play(); this.state = 'talk'; this.planFor = null; break; } // 每段重新规划（以实际停住的帧为准）
        if (!inp.active && now - this.quietSince > this.offAfterMs) { this.state = 'off'; this.offAt = now; return false; }
        break;
    }
    return true;
  };
  /** 打断/换装：立即回到待机 */
  GatePlayer.prototype.reset = function (now) { this.deck.pause(); this.state = 'off'; this.offAt = now || 0; this.primed = null; };

  root.DHGate = { VoiceGate, GatePlayer, pausesFrom, route, reach, startFrames, isClosed, RATE_MIN, RATE_MAX };
})(typeof window !== 'undefined' ? window : globalThis);
