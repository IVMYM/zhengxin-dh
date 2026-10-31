/* 字幕/口型与音频对齐、语音唤醒词匹配（浏览器与 node 测试共用，无依赖） */
(function (root) {
  'use strict';
  const PUNCT = /[\s，。！？；、：:“”‘’"'（）()《》【】\[\]—…·,.!?;*\-]/g;
  function norm(s) { return String(s || '').toLowerCase().replace(PUNCT, ''); }

  /** 按句切分字幕，过长的句子在逗号处再切 */
  function splitSubtitle(text) {
    const parts = String(text || '').match(/[^。！？；]+[。！？；]?/g) || [String(text || '')];
    const out = [];
    for (let p of parts) {
      p = p.trim(); if (!p) continue;
      while (p.length > 30) {
        let cut = p.lastIndexOf('，', 30);
        if (cut < 8) cut = 26;
        out.push(p.slice(0, cut + 1)); p = p.slice(cut + 1);
      }
      if (p) out.push(p);
    }
    return out;
  }

  /**
   * 用 edge-tts 逐词时间戳算出每段字幕在音频中的起止时间（秒）。
   * words: [{t, d, w}]。音频里被改读的内容（如网址读作“征信中心官网”）会自动跳过。
   * 返回 [{start, end}]，与 segs 一一对应。
   */
  function alignSegments(segs, words) {
    const segNorm = segs.map(norm);
    const bounds = []; let acc = 0;
    for (const s of segNorm) { bounds.push(acc); acc += s.length; }
    const full = segNorm.join('');
    const hits = []; let cur = 0;
    for (const w of words || []) {
      const nw = norm(w.w); if (!nw) continue;
      const at = full.indexOf(nw, cur);
      if (at < 0 || at - cur > 24) continue;
      hits.push({ pos: at, t: w.t, e: w.t + w.d });
      cur = at + nw.length;
    }
    const out = segs.map((_, i) => {
      const b = bounds[i], e = i + 1 < bounds.length ? bounds[i + 1] : full.length;
      const inSeg = hits.filter((h) => h.pos >= b && h.pos < e);
      return inSeg.length ? { start: inSeg[0].t, end: inSeg[inSeg.length - 1].e } : null;
    });
    // 没对上词的段落：夹在前后段之间
    for (let i = 0; i < out.length; i++) {
      if (out[i]) continue;
      const prev = out.slice(0, i).reverse().find(Boolean);
      const next = out.slice(i + 1).find(Boolean);
      const s = prev ? prev.end : 0;
      const e = next ? next.start : s + 1;
      out[i] = { start: s, end: Math.max(s, e) };
    }
    return out;
  }

  /**
   * edge-tts 逐词时间戳 → 实际听到声音的时间。按缓存音频（浏览器同样的 MP3 解码）逐词对比能量包络测得：
   * 词的开始比真正出声早约 97ms（10%~90%：68~145ms），词的结束基本准确（+13ms）。
   */
  const WORD_START_LAG = 0.09, WORD_END_LAG = 0.01;
  function audibleWords(words) {
    return (words || []).map((w) => {
      const t = w.t + WORD_START_LAG, e = Math.max(t + 0.02, w.t + w.d + WORD_END_LAG);
      return { t, d: e - t, w: w.w };
    });
  }

  /** 当前播放位置 t（秒）应显示第几段字幕；lead 为提前量（字幕略早于声音出现更自然） */
  function segmentAt(timings, t, lead) {
    lead = lead == null ? 0.08 : lead;
    let i = 0;
    for (let k = 0; k < timings.length; k++) if (t + lead >= timings[k].start) i = k;
    return i;
  }

  /** 播放位置 t 是否处在某个词的发音区间内（pad 为前后余量） */
  function voicedAt(words, t, pad) {
    pad = pad == null ? 0.05 : pad;
    for (const w of words || []) { if (t >= w.t - pad && t <= w.t + w.d + pad) return true; if (w.t - pad > t) break; }
    return false;
  }

  /** 唤醒词：对识别中间结果做宽松匹配（同音误字、拼音、语气词都算） */
  const WAKE = /(你|您|妳|拟|泥|尼|宁|侬|nǐ|ni|nin)(好|号|豪|浩|hao|hǎo)|小(信|新|星|心|欣|鑫|兴)|晓(信|新)|哈(喽|罗|啰|咯)|hello|嗨/;
  function wakeMatch(text) { return WAKE.test(norm(text)); }

  root.DHSync = { norm, splitSubtitle, alignSegments, segmentAt, voicedAt, wakeMatch, audibleWords };
})(typeof window !== 'undefined' ? window : globalThis);
