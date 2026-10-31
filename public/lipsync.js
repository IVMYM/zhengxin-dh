/* 口型同步视频（MuseTalk 预渲染 / GPU 生成，视频里带同一份 TTS 声音）。
 * 有现成视频时，播报直接用视频自己的声音（Speaker 把它当音源，接到同一个分析器），声音和嘴型来自同一个文件、同一个时钟，
 * 不再“静音视频追着另一个音频元素跑”（那样开头要先跳转解码，偏差 120ms 以内不会校正）。
 * 没有现成视频（未配置、GPU 生成中、服务不可达）时这句话照常播 TTS 音频 + 说话循环视频；GPU 生成好的视频下次同一句话再用。 */
(function () {
  'use strict';
  const el = document.getElementById('vLip');
  const DHLip = {
    enabled: false, avatar: '', shown: false,
    query(voice, text) { return `voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}${this.avatar ? `&avatar=${encodeURIComponent(this.avatar)}` : ''}`; },
    /** 这句话有没有现成的口型视频：有就返回视频地址（最多等 ms 毫秒，不耽误开口），没有返回 null（同时触发 GPU 生成，供下次使用） */
    async check(voice, text, ms) {
      if (!this.enabled || !el) return null;
      const q = this.query(voice, text);
      const timeout = new Promise((r) => setTimeout(() => r(null), ms || 150));
      const st = fetch(`/api/lipsync/status?${q}`).then((r) => r.json()).then((j) => j.state).catch(() => null);
      return (await Promise.race([st, timeout])) === 'ready' ? `/api/lipsync/clip?${q}` : null;
    },
    reset() { this.hide(); },
    hide() { if (el && this.shown) { this.shown = false; el.style.opacity = '0'; } },
    /** 每帧调用：口型视频正在当音源播放时显示它，返回 true */
    sync(sp) {
      const on = Boolean(el && sp.audio === el && sp.active && sp.kind === 'audio' && (sp.playing || el.currentTime > 0));
      if (on && !this.shown) { this.shown = true; el.style.opacity = '1'; }
      else if (!on) this.hide();
      return on;
    },
  };
  window.DHLip = DHLip;
})();
