/* 征信服务数字人 · 前端主程序（无构建依赖，直接由浏览器加载） */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const params = new URLSearchParams(location.search);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dh.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('dh.' + k, JSON.stringify(v)); } catch {} },
  };

  const S = {
    cfg: null,
    mode: 'attract',          // attract | idle | listening | thinking | speaking
    flow: -1,                 // 自助查询引导当前步骤，-1 表示不在流程中
    lastTouch: Date.now(),
    history: [],
    voice: params.get('voice') || store.get('voice', null),
    wake: params.has('wake') ? params.get('wake') !== '0' : store.get('wake', true),
    micOn: params.has('mic') ? params.get('mic') !== '0' : store.get('micOn', true),
    asrEngine: params.get('asr') || store.get('asr', 'sherpa'),
    playMode: params.get('mode') === 'playlist' ? 'playlist' : 'qa', // qa | playlist
    suggestPage: 0,
    showText: false,          // config/site.json showText；URL ?text=1 / ?text=0 可临时覆盖
  };

  /* ---------- 画面缩放：竖屏/收回时按 1080×1920 等比；横屏展开管理端时用真实视口分栏 ---------- */
  function isLandscape() { return window.innerWidth > window.innerHeight; }
  function fit() {
    const admin = app.classList.contains('admin-open');
    const split = admin && isLandscape();
    app.classList.toggle('admin-landscape', split);
    document.documentElement.classList.toggle('admin-landscape', split);
    const fill = document.getElementById('vStageFill');
    if (fill) {
      if (split) { try { if (fill.paused) fill.play().catch(() => {}); } catch {} }
      else { try { fill.pause(); } catch {} }
    }
    if (split) {
      // 管理端 1:1 可读；右侧整块舞台铺满，单层人物画面 cover+右上锚点（无人影缝）
      const H = window.innerHeight;
      const W = window.innerWidth;
      const adminW = Math.min(520, Math.max(420, Math.round(W * 0.32)));
      const stageW = Math.max(320, W - adminW);
      app.style.transform = 'none';
      app.style.width = W + 'px';
      app.style.height = H + 'px';
      app.style.setProperty('--admin-w', adminW + 'px');
      app.style.setProperty('--stage-w', stageW + 'px');
      // 放大倍数：保证横竖都可裁切，才能把人物锚到右侧且保住脸
      const cover = Math.max(stageW / 720, H / 1280);
      const zoom = Math.max(1.18, (stageW / 720) / cover * 1.05 + 0.2);
      app.style.setProperty('--stage-zoom', String(Math.min(1.55, zoom)));
    } else {
      app.style.width = '1080px';
      app.style.height = '1920px';
      app.style.removeProperty('--stage-w');
      app.style.removeProperty('--stage-zoom');
      app.style.removeProperty('--person-w');
      app.style.removeProperty('--avatar-h');
      if (!admin) app.style.removeProperty('--admin-w');
      else app.style.setProperty('--admin-w', '480px');
      const s = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
      app.style.transform = `scale(${s})`;
    }
  }
  window.addEventListener('resize', fit); fit();
  if (params.get('kiosk') === '1') document.body.classList.add('kiosk');

  /* ---------- 时钟 ---------- */
  const WEEK = '日一二三四五六';
  function tick() {
    const d = new Date();
    $('#clockTime').textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    $('#clockDate').textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  }
  tick(); setInterval(tick, 10000);

  function setMode(m) {
    S.mode = m;
    app.classList.remove('mode-attract', 'mode-idle', 'mode-listening', 'mode-thinking', 'mode-speaking');
    app.classList.add('mode-' + m);
    const txt = { idle: '小信 · 在线服务', listening: '小信 · 正在聆听', thinking: '小信 · 正在查找', speaking: '小信 · 正在讲解', attract: '小信 · 在线服务' };
    $('#presenceText').textContent = txt[m] || txt.idle;
    const ms = { idle: '点击说话', listening: '正在聆听，请说…', thinking: '正在为您查找…', speaking: '点击可打断', attract: '点击说话' };
    $('#micStatus').textContent = ms[m] || '点击说话';
    Cue.render();
    try { MicPower.render(); if (m === 'listening' || m === 'thinking') MicPower.show(0); } catch {}
  }
  function touch() { S.lastTouch = Date.now(); }

  let toastTimer;
  function toast(msg, ms = 2600) {
    if (!S.showText) { console.info('[提示] ' + msg); return; } // 无文字模式：只记日志
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* ---------- 无文字状态提示：底部小图标（待机/聆听/思考/麦克风异常） ---------- */
  const Cue = {
    render() {
      const el = document.getElementById('cue'); if (!el) return;
      let st = S.mode === 'listening' ? 'listening' : S.mode === 'thinking' ? 'thinking' : S.mode === 'speaking' ? 'speaking' : 'ready';
      if (st === 'ready' && !S.micOn) st = 'warn';
      else if (st === 'ready' && S.asrEngine === 'sherpa') {
        if (['denied', 'sysdenied', 'nodevice', 'silent'].includes(ASR.micState) || ASR.status === 'error') st = 'warn';
        else if (ASR.micState !== 'on' || ASR.status !== 'ready') st = 'wait';
      }
      el.dataset.state = st;
    },
  };

  /* ---------- 底部中央麦克风：悬停显示；单击开始/结束对话（不是“关掉麦”） ---------- */
  function micSecureOk() {
    try {
      if (window.isSecureContext) return true;
      const h = location.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch { return false; }
  }
  const MicPower = {
    hideTimer: null,
    hintTimer: null,
    render() {
      const btn = $('#micPower'); if (!btn) return;
      let state = 'idle'; let label = '点击说话'; let hint = ''; let tone = '';
      if (!micSecureOk()) {
        state = 'warn'; label = '无法使用麦克风';
        hint = '当前不是安全环境（请用 http://localhost:43200 打开；局域网 IP 的 http 不能用麦克风）';
        tone = 'warn';
      } else if (S.asrEngine === 'off') {
        state = 'warn'; label = '语音识别已关闭'; hint = '请在设置里打开语音识别，或用文字/话术播单'; tone = 'warn';
      } else if (ASR.micState === 'denied' || ASR.micState === 'sysdenied') {
        state = 'warn'; label = '没有麦克风权限';
        hint = ASR.micState === 'sysdenied'
          ? '系统禁止浏览器用麦克风：系统设置 → 隐私与安全性 → 麦克风'
          : '浏览器已禁止麦克风：点地址栏左侧图标改为“允许”后重试';
        tone = 'warn';
      } else if (ASR.micState === 'nodevice') {
        state = 'warn'; label = '未检测到麦克风'; hint = '请检查系统声音输入设备'; tone = 'warn';
      } else if (ASR.status === 'error') {
        state = 'warn'; label = '识别不可用'; hint = '本机语音模型加载失败，可改用浏览器在线识别或话术播单'; tone = 'warn';
      } else if (ASR.status === 'loading') {
        state = 'idle'; label = '模型加载中…'; hint = `语音模型加载中 ${Math.round((ASR.progress || 0) * 100)}%`; tone = '';
      } else if (S.mode === 'listening' || ASR.listening) {
        state = 'listening'; label = '正在聆听 · 再点结束'; hint = '请说出您的问题，说完稍等或再点一次结束'; tone = 'listen';
      } else if (S.mode === 'thinking') {
        state = 'thinking'; label = '正在查找…'; hint = '正在理解您的问题'; tone = 'ok';
      } else if (S.mode === 'speaking' || Speaker.active) {
        state = 'speaking'; label = '正在回答 · 点此打断'; hint = '点击可打断并重新提问'; tone = 'ok';
      } else {
        state = 'idle'; label = '点击说话';
        hint = ASR.micState === 'on' ? '麦克风已就绪，点击后开始对话' : '点击后将申请麦克风并开始聆听';
        tone = ASR.micState === 'on' ? 'ok' : '';
      }
      btn.dataset.state = state;
      btn.setAttribute('aria-label', label);
      $('#micPowerLabel').textContent = label;
      const h = $('#micHint');
      if (h) {
        if (hint) { h.hidden = false; h.textContent = hint; h.dataset.tone = tone || ''; }
        else { h.hidden = true; h.textContent = ''; }
      }
      Cue.render(); VoiceUI.render();
    },
    show(ms = 5000) {
      const z = $('#micPowerZone'); if (!z) return;
      z.classList.add('show');
      clearTimeout(this.hideTimer);
      // 聆听/异常时保持显示，不要自动收起
      const keep = ['listening', 'thinking', 'warn'].includes(($('#micPower') || {}).dataset?.state);
      if (ms > 0 && !keep && S.mode !== 'listening') this.hideTimer = setTimeout(() => z.classList.remove('show'), ms);
    },
    status(msg, tone = 'warn', ms = 5000) {
      const h = $('#micHint');
      if (h) { h.hidden = false; h.textContent = msg; h.dataset.tone = tone; }
      this.show(ms);
      this.render();
      // 无文字模式 toast 被吞掉，这里用屏幕提示兜底
      console.info('[麦克风] ' + msg);
    },
    /** 单击：开始聆听 / 结束聆听 / 打断播报后再听 */
    async click() {
      this.show(8000);
      this.render();
      if (!micSecureOk()) {
        this.status('请用 http://localhost:43200 打开本页（不要用局域网 IP 的 http），否则浏览器不允许麦克风', 'warn', 10000);
        return;
      }
      if (S.asrEngine === 'off') {
        this.status('语音识别已关闭。可在设置中开启，或打开左侧话术清单播报', 'warn');
        return;
      }
      // 确保可对话
      S.micOn = true; store.set('micOn', true);
      if (ASR.listening) { ASR.finish(); this.render(); return; }
      if (S.mode === 'listening' && ASR.web) { try { ASR.web.stop(); } catch {} this.render(); return; }
      if (Speaker.active || S.mode === 'thinking') {
        askSeq++; Speaker.stop(); ASR.pauseForSpeech(false); setMode('idle');
      }
      if (S.mode === 'attract') exitAttract(false);
      await ASR.start();
      this.render();
      this.show(0); // 聆听中保持显示
      if (!(ASR.listening || S.mode === 'listening')) {
        // start 失败时把原因摊开
        if (ASR.micState === 'denied' || ASR.micState === 'sysdenied') this.status(ASR.micState === 'sysdenied' ? '系统禁止浏览器使用麦克风' : '浏览器未允许麦克风权限', 'warn', 10000);
        else if (ASR.micState === 'nodevice') this.status('未检测到麦克风设备', 'warn');
        else if (ASR.status === 'loading') this.status('语音模型还在加载，请稍后再点', 'warn');
        else if (ASR.status === 'error') this.status('语音识别不可用', 'warn');
        else this.status('未能开始聆听，请再试一次或检查麦克风权限', 'warn');
      } else {
        this.status('正在聆听，请说话…', 'listen', 0);
      }
    },
    // 兼容旧调用：不再把“开关”理解成关掉麦；set(false) 仍可从设置关掉
    set(on) {
      S.micOn = !!on; store.set('micOn', S.micOn);
      if (!S.micOn) { ASR.cancel(); ASR.releaseMic(); ASR.setMic('off', '用户关闭麦克风'); }
      this.render();
    },
    toggle() { this.click(); },
  };

  /* ======================================================================
   * 数字人播报：服务端 edge-tts 流式音频 + 口型（说话循环视频）随音量驱动
   * ====================================================================== */
  const vIdle = $('#vIdle');
  const vTalk = $('#vTalk');
  const Sync = window.DHSync;
  const TRACE = params.get('trace') === '1';
  window.__dhTrace = [];
  window.__dhEvents = [];
  const ev = (type, extra) => { if (TRACE) window.__dhEvents.push({ type, at: performance.now(), ct: Speaker.audio.currentTime, ...extra }); };

  /*
   * 播报状态：
   *  - kind=audio  服务端 edge-tts 音频；字幕按逐词时间戳 + audio.currentTime 切换，口型只在真正有声音时动
   *  - kind=synth  浏览器朗读兜底；字幕按朗读进度（boundary 事件）切换
   *  - kind=muted  浏览器禁止发声（未点击屏幕）；只显示字幕，口型不动
   */
  // 每句音频结尾约 0.6 秒静音：最后一个字说完 0.15 秒就结束这句，接着播下一句（句间停顿约 0.35 秒，不再有近 1 秒的空档）
  const TAIL = 0.15;
  const Speaker = {
    audio: new Audio(),
    audioEl: null, clipEl: null,
    ctx: null, analyser: null, buf: null, attached: false, voiceEnd: Infinity,
    token: 0, active: false, kind: 'audio', playing: false, started: 0, segs: [], est: 0,
    words: null, timings: null, synthChar: 0, synthSpeaking: false,
    unlock() {
      try {
        if (!this.ctx) {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)();
          this.ctx.onstatechange = () => this.attach();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().then(() => this.attach()).catch(() => {});
      } catch {}
      this.attach();
    },
    attach() {
      // 只有 AudioContext 已运行时才接入分析器，否则接入后声音会被静音。
      // 播报音频和口型视频（预渲染视频自带声音时由它出声）都接到同一个分析器
      if (!this.ctx || this.ctx.state !== 'running') return;
      if (!this.analyser) {
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0;
        this.buf = new Float32Array(this.analyser.fftSize);
        this.analyser.connect(this.ctx.destination);
      }
      for (const el of [this.audioEl || this.audio, this.clipEl]) {
        if (!el || el.__dhSrc) continue;
        try { el.__dhSrc = this.ctx.createMediaElementSource(el); el.__dhSrc.connect(this.analyser); } catch {}
      }
      this.attached = Boolean((this.audioEl || this.audio).__dhSrc);
    },
    /** 输出延迟（秒）：声音从播放位置到扬声器真正发出来的时间 */
    outLat() { const c = this.ctx; return this.attached && c ? (c.baseLatency || 0) + (c.outputLatency || 0) : 0; },
    /** 此刻耳朵听到的是音频里第几秒 */
    heardT() { return this.audio.currentTime - this.outLat(); },
    /** 此刻是否正在发出说话声（按逐词时间戳 + 输出延迟；没有时间戳时按真实音量） */
    voiced() {
      if (!this.active) return false;
      if (this.kind === 'synth') return this.synthSpeaking;
      if (this.kind !== 'audio' || !this.playing) return false;
      if (this.words) return Sync.voicedAt(this.words, this.heardT(), 0.02);
      const r = this.rms(); return r === null ? true : r > 0.012;
    },
    /** 每帧调用：最后一个字说完 TAIL 秒就结束这句（跳过音频结尾的长静音） */
    trimTail() {
      if (!this.active || this.kind !== 'audio' || !this.playing || !this._done || !isFinite(this.voiceEnd)) return;
      const a = this.audio, ct = a.currentTime;
      if (ct < this.voiceEnd + TAIL) return;
      if (isFinite(a.duration) && a.duration - ct < 0.05) return;
      const done = this._done; ev('trim', { voiceEnd: this.voiceEnd });
      done('ended');
      try { a.pause(); } catch {}
    },
    /** 当前真实音量（原始 RMS，晓晓说话时约 0.03~0.25）；拿不到音频能量时返回 null */
    rms() {
      if (!this.active) return 0;
      if (this.kind === 'muted') return 0;
      if (this.kind === 'synth') {
        // 浏览器朗读拿不到音频数据：按朗读状态模拟音节起伏
        if (!this.synthSpeaking) return 0;
        const t = (performance.now() - this.started) / 1000;
        return 0.04 + 0.14 * Math.abs(Math.sin(t * 7.3)) * (0.6 + 0.4 * Math.sin(t * 2.1));
      }
      if (!this.playing) return 0;
      if (this.attached && this.ctx.state === 'running') {
        this.analyser.getFloatTimeDomainData(this.buf);
        let sum = 0; for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
        return Math.sqrt(sum / this.buf.length);
      }
      // 没接入分析器：按逐词时间戳判断此刻是否在发声，词内做一点起伏
      if (this.words) {
        if (!Sync.voicedAt(this.words, this.audio.currentTime)) return 0;
        return 0.08 + 0.06 * Math.abs(Math.sin(this.audio.currentTime * 9.1));
      }
      return null;
    },
    /** 音量（0~1）：说话视频显隐、字幕用 */
    rawLevel() { const r = this.rms(); return r === null ? null : Math.min(1, r * 7); },
    /** 当前应显示的字幕段 */
    segIndex() {
      if (this.kind === 'synth') {
        let acc = 0;
        for (let i = 0; i < this.segs.length; i++) { acc += this.segs[i].length; if (this.synthChar < acc) return i; }
        return this.segs.length - 1;
      }
      if (this.kind === 'muted') return Subtitle.byProgress(Math.min(0.999, (performance.now() - this.started) / 1000 / this.est));
      const ct = this.audio.currentTime;
      if (this.timings) return Sync.segmentAt(this.timings, ct);
      const d = this.audio.duration;
      return Subtitle.byProgress(Math.min(0.999, ct / (isFinite(d) && d > 0 ? d : this.est)));
    },
    stop() {
      this.token++;
      this.active = false; this.playing = false; this.synthSpeaking = false;
      for (const el of [this.audioEl, this.clipEl]) { if (!el) continue; try { el.pause(); } catch {} el.onplaying = el.onpause = el.onwaiting = el.onended = el.onerror = null; }
      if (this.clipEl) this.clipEl.muted = true;
      if (window.speechSynthesis) speechSynthesis.cancel();
      Subtitle.hide();
      if (this._resolve) { this._resolve('stopped'); this._resolve = null; }
    },
    async loadTimings(tok, voice, text) {
      // 逐词时间戳：缓存的句子立即返回；新句子由服务端在合成完成后返回（通常早于播放结束）
      for (const wait of [0, 300, 1200]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (tok !== this.token) return;
        try {
          const r = await fetch(`/api/tts/meta?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`);
          if (tok !== this.token) return;
          if (r.ok) {
            const m = await r.json();
            if (tok !== this.token || !m.words || !m.words.length) return;
            // 换算成真正出声的时间（词开始比出声早约 0.1 秒，见 sync.js audibleWords）
            this.words = Sync.audibleWords(m.words); this.timings = Sync.alignSegments(this.segs, this.words);
            const last = this.words[this.words.length - 1]; this.voiceEnd = last.t + last.d;
            ev('timings', { n: m.words.length });
            return;
          }
        } catch {}
      }
    },
    speak(text) {
      this.stop();
      const tok = this.token;
      text = String(text || '').trim();
      if (!text) return Promise.resolve('empty');
      this.segs = Sync.splitSubtitle(text);
      this.est = Math.max(1.5, text.replace(/[，。！？；、“”\s]/g, '').length * 0.235);
      this.kind = 'audio'; this.words = null; this.timings = null; this.playing = false; this.voiceEnd = Infinity;
      Subtitle.prepare(this.segs);
      const voice = S.voice || S.cfg?.defaultVoice || 'female';
      return new Promise((resolve) => {
        this._resolve = resolve;
        const done = (why) => {
          if (tok !== this.token) return;
          this.active = false; this.playing = false; this.synthSpeaking = false; this._resolve = null; this._done = null;
          S.speakEndAt = performance.now();
          ev('done', { why });
          Subtitle.end();
          resolve(why);
        };
        const mutedRun = () => {
          // 无法发声：只显示字幕（按估算时长），数字人不做口型
          if (tok !== this.token || this.kind === 'muted') return;
          this.kind = 'muted'; this.started = performance.now(); this.active = true;
          Subtitle.show(0);
          setTimeout(() => done('muted'), this.est * 1000);
        };
        let fellBack = false;
        const fallback = async () => {
          if (tok !== this.token || fellBack) return; // audio.onerror 与 play() 失败可能同时触发，只兜底一次
          fellBack = true;
          console.warn('[播报] 服务端语音不可用，改用浏览器朗读');
          if (!(window.speechSynthesis && window.SpeechSynthesisUtterance)) return mutedRun();
          const v = await pickLocalVoice();
          if (tok !== this.token) return;
          if (!v) { console.warn('[播报] 系统没有可离线使用的中文语音，只显示字幕'); return mutedRun(); }
          const u = new SpeechSynthesisUtterance(text.replace(/\*+/g, ''));
          u.lang = v.lang || 'zh-CN'; u.voice = v; u.rate = 1.0;
          this.kind = 'synth'; this.synthChar = 0; this.active = true; this.started = performance.now();
          u.onstart = () => { if (tok !== this.token) return; this.synthSpeaking = true; this.started = performance.now(); Subtitle.show(0); };
          u.onboundary = (e) => { if (tok === this.token && typeof e.charIndex === 'number') this.synthChar = e.charIndex; };
          u.onend = () => done('ended');
          u.onerror = (e) => {
            if (tok !== this.token) return;
            console.warn('[播报] 浏览器朗读失败：' + (e && e.error));
            if (!this.synthSpeaking) { if (e && e.error === 'not-allowed') toast('轻触屏幕即可开启声音'); mutedRun(); } else done('error');
          };
          console.info('[播报] 浏览器朗读，语音：' + v.name);
          speechSynthesis.cancel();
          speechSynthesis.speak(u);
          // 1.5 秒还没开始朗读：只显示字幕
          setTimeout(() => { if (tok === this.token && this.active && this.kind === 'synth' && !this.synthSpeaking) { speechSynthesis.cancel(); mutedRun(); } }, 1500);
        };
        this._done = done;
        this.unlock();
        this.active = true;
        this.started = performance.now();
        this.loadTimings(tok, voice, text);
        // 有预渲染口型视频（自带同一份声音）时直接播视频本身的声音，声画天然同步；没有就播 TTS 音频
        const begin = (clipUrl) => {
          if (tok !== this.token) return;
          const a = clipUrl ? this.clipEl : this.audioEl;
          this.audio = a;
          a.onplaying = () => { if (tok !== this.token) return; this.playing = true; ev('playing', { clip: Boolean(clipUrl) }); if (!Subtitle.visible) Subtitle.show(this.segIndex()); };
          a.onpause = a.onwaiting = () => { if (tok === this.token) { this.playing = false; ev('pause'); } };
          a.onended = () => { if (tok !== this.token) return; this.playing = false; ev('ended'); done('ended'); };
          a.onerror = () => { if (tok !== this.token) return; if (clipUrl) { a.onerror = null; begin(null); } else fallback(); };
          if (clipUrl) a.muted = false;
          a.src = clipUrl || `/api/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`;
          a.play().catch((err) => {
            if (tok !== this.token) return;
            if (err && err.name === 'NotAllowedError') {
              console.warn('[播报] 浏览器未允许自动发声，需先轻触屏幕');
              if (S.mode === 'attract') { done('muted'); return; }
              toast('轻触屏幕即可开启声音');
              mutedRun();
            } else if (err && err.name !== 'AbortError') { if (clipUrl) begin(null); else fallback(); }
          });
        };
        if (window.DHLip && window.DHLip.enabled) window.DHLip.check(voice, text, 150).then(begin, () => begin(null));
        else begin(null);
      });
    },
  };

  /** 浏览器朗读用的中文语音：只选本机离线语音（谷歌在线语音在国内无法使用），优先普通话女声 */
  function pickLocalVoice() {
    const choose = () => {
      const all = speechSynthesis.getVoices();
      const zh = all.filter((v) => /^zh/i.test(v.lang) || /Chinese|中文|普通话/i.test(v.name));
      const local = zh.filter((v) => v.localService !== false);
      const cn = local.filter((v) => /zh[-_]CN/i.test(v.lang));
      // 按优先级选：macOS 婷婷 → Windows 晓晓/慧慧/瑶瑶 → 其他普通话语音 → 台湾 美佳
      for (const re of [/Tingting|婷婷/i, /Xiaoxiao|晓晓/i, /Huihui|慧慧/i, /Yaoyao|瑶瑶/i, /Lili|莉莉/i]) {
        const hit = cn.find((v) => re.test(v.name)); if (hit) return hit;
      }
      return cn[0] || local.find((v) => /Meijia|美佳/i.test(v.name)) || local[0] || null;
    };
    const v = choose();
    if (v || !window.speechSynthesis) return Promise.resolve(v);
    // 语音列表是异步加载的
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(choose()), 800);
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(choose()); }, { once: true });
    });
  }

  Speaker.audioEl = Speaker.audio;
  Speaker.clipEl = document.getElementById('vLip');

  const Subtitle = {
    segs: [], idx: -1, weights: [], visible: false,
    prepare(segs) {
      this.segs = segs; this.idx = -1;
      const total = segs.reduce((a, s) => a + s.length, 0) || 1;
      let acc = 0; this.weights = segs.map((s) => (acc += s.length / total));
      // 声音真正开始播放时才显示字幕
      this.visible = false; $('#subtitle').classList.remove('show');
    },
    byProgress(p) { const i = this.weights.findIndex((w) => p < w); return i < 0 ? this.segs.length - 1 : i; },
    show(i) {
      if (!this.visible) { this.visible = true; $('#subtitle').classList.add('show'); }
      if (i === this.idx || !this.segs[i]) return;
      this.idx = i;
      $('#subText').textContent = this.segs[i].replace(/[。；]$/, '');
      ev('seg', { i });
    },
    hide() { this.visible = false; $('#subtitle').classList.remove('show'); },
    end() { setTimeout(() => { if (!Speaker.active) this.hide(); }, 1800); },
  };

  // 渲染循环：真实音量 → 说话视频显隐；播放位置 → 字幕
  // 口型只在“音频正在播放且有声音”时出现，句间停顿超过 HOLD 毫秒即回到待机画面
  const TALK_ON = 0.06, HOLD = 140;
  let env = 0, talkOn = false, lastLoud = -1e9, lastVoiced = -1e9, talkOffAt = -1e9, lastFrame = performance.now();
  /*
   * 口型方式 gate（音量门控说话视频，gate-core.js）：说话时播原始说话视频，停顿时停在说话视频里一帧真实的闭嘴画面，
   * 出声时从那一帧接着播；按逐词时间戳微调播放速度（0.8~1.25 倍），让停顿正好落在闭嘴帧上。
   * 画面只用原视频的真实帧。site.json mouthMode 或 URL ?mouth=gate / ?mouth=loop 选择，默认 loop。
   */
  const DG = window.DHGate;
  const Gate = {
    on: false, meta: null, player: null, avatar: '', seq: 0, voice: DG ? new DG.VoiceGate() : null,
    words: null, pauses: null, media: 0, at: 0,
    deck: {
      frame() {
        const m = Gate.meta; if (!m) return 0;
        const t = Gate.media + (vTalk.paused ? 0 : (performance.now() - Gate.at) / 1000 * vTalk.playbackRate);
        return t * m.fps;
      },
      play() { if (vTalk.paused) { Gate.at = performance.now(); vTalk.play().catch(() => {}); } },
      pause() { if (!vTalk.paused) { vTalk.pause(); Gate.media = vTalk.currentTime; } },
      seek(f) { const t = (f + 0.5) / Gate.meta.fps; try { vTalk.currentTime = t; } catch {} Gate.media = t; Gate.at = performance.now(); },
      setRate(r) { if (Math.abs(vTalk.playbackRate - r) > 0.01) { Gate.media = Gate.deck.frame() / Gate.meta.fps; Gate.at = performance.now(); vTalk.playbackRate = r; } },
    },
    load(avatar) {
      const seq = ++this.seq;
      this.avatar = avatar; this.meta = null; this.player = null;
      if (!DG || !avatar) return; // 两种口型方式都用闭嘴帧素材（loop 只在句末停，gate 句中停顿也停）
      fetch(`/media/gate/${encodeURIComponent(avatar)}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((m) => { if (seq !== this.seq) return; this.meta = m; this.player = new DG.GatePlayer(m, this.deck); })
        .catch(() => console.info('[口型] ' + avatar + ' 没有门控素材，使用说话循环视频'));
    },
  };
  // 说话视频每显示一帧都记下准确的播放位置（帧号由此推算）
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const onTalkFrame = (n, md) => { Gate.media = md.mediaTime; Gate.at = performance.now(); vTalk.requestVideoFrameCallback(onTalkFrame); };
    vTalk.requestVideoFrameCallback(onTalkFrame);
  }
  function showTalk(on) {
    if (on === talkOn) return;
    talkOn = on;
    if (!on) talkOffAt = performance.now();
    vTalk.style.opacity = on ? '1' : '0';
    ev(on ? 'talkOn' : 'talkOff');
  }
  // 门控模式收尾：说话层还盖着时，先把待机视频拨回第 0 帧（收尾的闭嘴帧按它挑过姿势），拨好再淡出，接缝处不重影
  let idleSync = '';
  function gateShow(on) {
    if (on) { idleSync = ''; showTalk(true); return; }
    if (!talkOn || idleSync === 'done') { showTalk(false); return; }
    if (idleSync === 'wait') return;
    idleSync = 'wait';
    const done = () => { if (idleSync === 'wait') idleSync = 'done'; };
    vIdle.addEventListener('seeked', done, { once: true });
    setTimeout(done, 400);
    try { vIdle.currentTime = 0; } catch { done(); }
  }
  function setTalk(on) {
    if (on === talkOn) return;
    talkOn = on;
    // 全身形象：说话视频从起始姿势（双手交握）开始播，接回待机时不跳手势
    if (on && !S.showText && performance.now() - talkOffAt > 1200) { try { vTalk.currentTime = 0; } catch {} }
    if (!on) talkOffAt = performance.now();
    vTalk.style.opacity = on ? '1' : '0';
    if (on && vTalk.paused) vTalk.play().catch(() => {});
    ev(on ? 'talkOn' : 'talkOff');
  }
  function frame() {
    const now = performance.now();
    const dt = Math.min(100, now - lastFrame); lastFrame = now;
    let rms = Speaker.rms();
    if (rms === null) rms = Speaker.playing ? 0.07 : 0; // 极端兜底：只知道在播放
    const lv = Math.min(1, rms * 7);
    env = lv > env ? env + (lv - env) * 0.6 : env + (lv - env) * 0.2;
    if (lv > TALK_ON) lastLoud = now;
    Speaker.trimTail();
    const lipOn = window.DHLip ? window.DHLip.sync(Speaker) : false; // 预渲染口型视频（自带声音）在播时优先显示它
    // 嘴动不动只看“此刻耳朵是否听到说话声”（音频时钟 + 输出延迟 + 逐词时间戳），不看音频元素是否在播放：
    // 每句音频开头约 0.2 秒、结尾约 0.6 秒是静音，按“在播放”判断会在静音里一直动嘴
    const voiced = Speaker.voiced();
    if (voiced) lastVoiced = now;
    const answering = Speaker.active || S.mode === 'speaking'; // 句与句之间也算在回答（不切回待机）
    if (Gate.player) {
      if (Speaker.words !== Gate.words) { Gate.words = Speaker.words; Gate.pauses = Speaker.words ? DG.pausesFrom(Speaker.words) : null; }
      const speaking = Gate.voice.update(voiced ? 1 : 0, dt) && Speaker.active; // 句与句之间（上一句已结束）不算在说
      const active = answering && Speaker.kind !== 'muted' && !lipOn;
      // loop：只在句首、句尾停（句中逗号处照常动）；gate：句中停顿也停在闭嘴帧
      let pauses = Speaker.kind === 'audio' && Speaker.active ? Gate.pauses : null;
      if (pauses && !Gate.on) pauses = pauses.filter((p) => p.start === -Infinity || p.end === Infinity);
      const vis = Gate.player.tick(now, { t: Speaker.heardT(), pauses, speaking, active });
      gateShow(vis && !lipOn);
    } else {
      // 没有闭嘴帧素材：有说话声时显示说话视频，安静 250ms 回到待机
      setTalk(!lipOn && now - lastVoiced < 250);
    }
    const audible = Speaker.active && (Speaker.kind === 'synth' ? Speaker.synthSpeaking : Speaker.kind === 'muted' || Speaker.playing);
    if (audible) Subtitle.show(Speaker.segIndex());
    const gateOn = Boolean(Gate.player);
    if (TRACE && Speaker.active) {
      window.__dhTrace.push({ at: now, ct: Speaker.audio.currentTime, playing: Speaker.playing, lv: Math.round(lv * 1000) / 1000, talk: talkOn, voiced, gate: gateOn ? Gate.player.state : null, tf: gateOn ? Math.floor(Gate.deck.frame()) % Gate.meta.n : null, rate: gateOn ? vTalk.playbackRate : null, mt: gateOn ? Math.round(vTalk.currentTime * 24 * 10) / 10 : null, seg: Subtitle.idx, vis: Subtitle.visible });
      if (window.__dhTrace.length > 20000) window.__dhTrace.splice(0, 5000);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);


  /* ======================================================================
   * 换装：config/outfits.json 的服装清单。轻触画面 = 下一套（循环），淡入淡出；
   * 切换只换视频画面，不影响正在播放的声音。预加载下一套，点了马上就能换。
   * sensitive 服装默认不进轮换，F2 设置里打开“显示敏感服装”后才出现。
   * ====================================================================== */
  const Outfit = {
    list: [], cur: null, switching: false, pending: null,
    sensitive: store.get('sensitive', false),
    init(cfg) {
      this.list = (cfg && cfg.outfits) || [];
      const want = params.get('outfit') || store.get('outfit', null) || (cfg && cfg.default);
      const o = this.find(want) || this.find(cfg && cfg.default) || this.rotation()[0];
      if (o) this.apply(o.id, { fade: false });
    },
    find(id) { return this.list.find((o) => o.id === id && (this.sensitive || !o.sensitive)) || null; },
    rotation() { return this.list.filter((o) => this.sensitive || !o.sensitive); },
    next() {
      const r = this.rotation(); if (!r.length) return null;
      const i = r.findIndex((o) => o.id === (this.cur && this.cur.id));
      return r[(i + 1) % r.length];
    },
    /** 下一套；切换进行中再点就记下来，换完再接着换 */
    step() { const n = this.next(); if (n) this.apply(n.id); },
    apply(id, { fade = true } = {}) {
      const o = this.find(id); if (!o) return false;
      if (this.switching) { this.pending = id; return true; }
      if (this.cur && this.cur.id === o.id) return true;
      this.switching = true;
      const cv = $('#vFade');
      if (fade) {
        // 定格当前画面（口型视频 > 说话视频 > 待机视频）
        const lip = $('#vLip');
        const src = lip.style.opacity === '1' ? lip : (vTalk.style.opacity === '1' ? vTalk : vIdle);
        try { cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height); cv.classList.remove('fading'); cv.classList.add('show'); } catch {}
      }
      this.cur = o; store.set('outfit', o.id);
      const talking = vTalk.style.opacity === '1';
      let ready = 0;
      const done = () => {
        if (++ready < 2) return;
        vIdle.play().catch(() => {});
        if (talking) { try { vTalk.currentTime = 0; } catch {} vTalk.play().catch(() => {}); }
        requestAnimationFrame(() => { cv.classList.add('fading'); cv.classList.remove('show'); });
        setTimeout(() => {
          this.switching = false; cv.classList.remove('fading');
          if (this.pending) { const p = this.pending; this.pending = null; this.apply(p); }
        }, fade ? 480 : 0);
        this.preload();
      };
      const load = (v, url) => {
        let fired = false; const fin = () => { if (!fired) { fired = true; done(); } };
        v.addEventListener('loadeddata', fin, { once: true });
        v.addEventListener('error', fin, { once: true });
        setTimeout(fin, 2500); // 网络慢也不卡住
        v.src = url; v.load();
      };
      vIdle.poster = o.poster || '';
      load(vIdle, o.idle); load(vTalk, o.talk || o.idle);
      const bg = document.querySelector('.stage-bg'); if (bg && o.poster) bg.style.backgroundImage = `url(${o.poster})`;
      const fill = document.getElementById('vStageFill'); if (fill && o.idle) { fill.src = o.idle; fill.load(); fill.play().catch(() => {}); }
      if (window.DHLip) { window.DHLip.avatar = o.lipsyncAvatar || ''; window.DHLip.reset(); }
      Gate.load(o.lipsyncAvatar || o.id);
      ev('outfit', { id: o.id });
      return true;
    },
    /** 预加载下一套的待机/说话视频和海报 */
    preload() {
      const n = this.next(); if (!n || n.id === (this.cur && this.cur.id)) return;
      const pi = $('#vPreIdle'), pt = $('#vPreTalk');
      if (pi.dataset.id === n.id) return;
      pi.dataset.id = n.id; pi.src = n.idle; pi.load();
      pt.src = n.talk || n.idle; pt.load();
      if (n.poster) { const im = new Image(); im.src = n.poster; }
    },
  };

  async function say(text, { keepMode = false } = {}) {
    ASR.pauseForSpeech(true);
    if (!keepMode) setMode('speaking');
    const r = await Speaker.speak(text);
    ASR.pauseForSpeech(false);
    if (r !== 'stopped' && S.mode === 'speaking') setMode('idle');
    return r;
  }

  /* ======================================================================
   * 语音识别：sherpa-onnx WebAssembly 本机离线流式识别（不依赖外网）
   * 兜底：浏览器 Web Speech（需外网，大陆环境通常不可用）
   * ====================================================================== */
  const ASR = {
    status: 'idle', progress: 0, recognizer: null, stream: null,
    micCtx: null, micStream: null, node: null, permission: false,
    listening: false, paused: false, partial: '', lastText: '', heardAt: 0, startedAt: 0, wakeResetAt: 0,
    web: null,
    micState: 'off', // off | prompt | asking | need-gesture | on | denied | nodevice
    lastAudioAt: 0, lastSoundAt: 0, micOpenedAt: 0, wakeHeard: '',
    setStatus(t) { $('#asrStatus').textContent = t; VoiceUI.render(); },
    setMic(st, why) {
      if (st === this.micState) return;
      this.micState = st;
      try { MicPower.render(); } catch {}
      console.info('[语音] 麦克风状态：' + st + (why ? '（' + why + '）' : ''));
      VoiceUI.render();
    },
    load() {
      if (S.asrEngine === 'off') { this.setStatus('语音识别已关闭'); return; }
      if (S.asrEngine === 'webspeech') { this.status = 'ready'; this.setStatus('浏览器在线语音识别'); return; }
      if (this.status !== 'idle') return;
      this.status = 'loading'; this.setStatus('语音模型加载中');
      window.Module = {
        locateFile: (p) => '/asr/' + p,
        setStatus: (s) => {
          const m = /\((\d+)\/(\d+)\)/.exec(s || '');
          if (m && Number(m[2]) > 0) {
            const pct = Math.round((Number(m[1]) / Number(m[2])) * 100);
            this.progress = Number(m[1]) / Number(m[2]);
            if (pct !== this._pct) { this._pct = pct; this.setStatus(`语音模型加载中 ${pct}%`); }
          }
        },
        onRuntimeInitialized: () => {
          try {
            this.recognizer = window.createOnlineRecognizer(window.Module, recognizerConfig());
            this.status = 'ready'; this.setStatus('本机语音识别已就绪');
            console.info('[语音] 离线识别模型已就绪');
            window.__asrReady = true;
            if (S.micOn && S.wake) this.ensureMic(false);
          } catch (e) { this.fail(e); }
        },
      };
      const s1 = document.createElement('script'); s1.src = '/asr/sherpa-onnx-asr.js';
      s1.onload = () => { const s2 = document.createElement('script'); s2.src = '/asr/sherpa-onnx-wasm-main-asr.js'; s2.onerror = (e) => this.fail(e); document.body.appendChild(s2); };
      s1.onerror = (e) => this.fail(e);
      document.body.appendChild(s1);
    },
    fail(e) {
      console.warn('[语音] 识别模型加载失败', e);
      this.status = 'error';
      this.setStatus(webSpeechAvailable() ? '离线识别不可用，已切换浏览器识别' : '语音识别不可用，请使用文字输入');
    },
    /**
     * 打开麦克风。interactive=true 表示由用户点击触发（可以恢复被浏览器挂起的音频）。
     * 页面一打开就会尝试：已授权则直接开始待机监听“你好”；首次访问会弹出浏览器授权框。
     */
    async ensureMic(interactive) {
      if (!S.micOn) { this.setMic('off', '麦克风已关闭'); return false; }
      if (this._opening) return this._opening;
      this._opening = this._ensureMic(interactive).finally(() => { this._opening = null; });
      return this._opening;
    },
    async _ensureMic(interactive) {
      const live = this.micStream && this.micStream.getAudioTracks().some((t) => t.readyState === 'live');
      if (this.micCtx && live) {
        if (this.micCtx.state !== 'running') { try { await this.micCtx.resume(); } catch {} }
        if (this.micCtx.state !== 'running') this.setMic('need-gesture', this.micCtx.state);
        else if (this.micState !== 'silent') this.setMic('on', 'running');
        return this.micCtx.state === 'running';
      }
      if (this.micCtx || this.micStream) this.releaseMic();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.setMic('nodevice', '浏览器不支持或非 localhost/HTTPS'); return false; }
      let perm = null;
      if (navigator.permissions) perm = await navigator.permissions.query({ name: 'microphone' }).then((p) => p.state).catch(() => null);
      if (perm === 'denied') { this.setMic('denied', '浏览器已拒绝麦克风'); if (interactive) toast('麦克风被禁止：请点地址栏左侧图标，允许使用麦克风'); return false; }
      if (perm === 'prompt') this.setMic('asking');
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      } catch (e) {
        console.warn('[语音] 麦克风打开失败', e && e.name, e && e.message);
        const name = e && e.name;
        const sys = /system/i.test((e && e.message) || '');
        if (sys) this.setMic('sysdenied', 'macOS / Windows 系统隐私设置禁止浏览器使用麦克风');
        else if (name === 'NotAllowedError' || name === 'SecurityError') {
          const now = navigator.permissions ? await navigator.permissions.query({ name: 'microphone' }).then((p) => p.state).catch(() => null) : null;
          this.setMic(now === 'denied' ? 'denied' : 'prompt', name);
        }
        else this.setMic('nodevice', name);
        if (interactive) toast(sys ? '系统禁止 Chrome 使用麦克风：系统设置 → 隐私与安全性 → 麦克风' : name === 'NotAllowedError' ? '麦克风未授权：请点地址栏左侧图标允许麦克风' : '未检测到麦克风，请使用文字输入或点选问题');
        return false;
      }
      this.micStream.getAudioTracks().forEach((t) => { t.onended = () => { console.warn('[语音] 麦克风断开，稍后自动重连'); this.releaseMic(); this.setMic('off', '设备断开'); }; });
      this.micCtx = new AudioContext({ sampleRate: 16000 });
      this.micCtx.onstatechange = () => { console.info('[语音] 收音 AudioContext：' + (this.micCtx && this.micCtx.state)); if (this.micCtx) this.setMic(this.micCtx.state === 'running' ? 'on' : 'need-gesture', this.micCtx.state); };
      const src = this.micCtx.createMediaStreamSource(this.micStream);
      this.node = this.micCtx.createScriptProcessor(2048, 1, 1);
      this.micOpenedAt = performance.now(); this.lastSoundAt = performance.now();
      this.node.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        this.lastAudioAt = performance.now();
        for (let i = 0; i < d.length; i += 64) if (Math.abs(d[i]) > 1e-5) { this.lastSoundAt = this.lastAudioAt; break; }
        this.onAudio(d, this.micCtx.sampleRate);
      };
      src.connect(this.node); this.node.connect(this.micCtx.destination);
      this.permission = true;
      if (this.micCtx.state !== 'running') { try { await this.micCtx.resume(); } catch {} }
      // 浏览器要求先有一次点击才允许运行音频：此时提示“轻触屏幕开启语音”
      await new Promise((r) => setTimeout(r, 150));
      this.setMic(this.micCtx && this.micCtx.state === 'running' ? 'on' : 'need-gesture', this.micCtx && this.micCtx.state);
      return this.micState === 'on';
    },
    releaseMic() {
      try { this.node && (this.node.onaudioprocess = null); } catch {}
      try { this.micStream && this.micStream.getTracks().forEach((t) => t.stop()); } catch {}
      try { this.micCtx && this.micCtx.close(); } catch {}
      this.micStream = null; this.micCtx = null; this.node = null;
      if (this.stream) { try { this.stream.free(); } catch {} this.stream = null; }
    },
    /** 看门狗：麦克风掉线、音频被挂起、收不到数据时自动恢复 */
    async watchdog() {
      if (!S.micOn || !S.wake || S.asrEngine !== 'sherpa' || this.status !== 'ready') return;
      if (['denied', 'sysdenied', 'nodevice', 'asking', 'prompt'].includes(this.micState)) return; // 等用户授权或点击后再试
      // 麦克风打开了但一直是完全的静音（被静音、选错输入设备、系统拦截）：提示检查
      if (this.micState === 'on' || this.micState === 'silent') {
        const quiet = performance.now() - this.lastSoundAt > 10000 && performance.now() - this.micOpenedAt > 10000;
        if (quiet && this.micState === 'on') this.setMic('silent', '10 秒内麦克风没有任何声音');
        else if (!quiet && this.micState === 'silent') this.setMic('on', '恢复收音');
      }
      if (this.micCtx && this.micCtx.state === 'running' && ['on', 'silent'].includes(this.micState) && performance.now() - this.lastAudioAt > 4000) {
        console.warn('[语音] 4 秒没有收到麦克风数据，重新打开');
        this.releaseMic();
      }
      if (!this.micCtx || this.micCtx.state !== 'running') await this.ensureMic(false);
    },
    newStream() { if (this.stream) { try { this.stream.free(); } catch {} } this.stream = this.recognizer.createStream(); },
    onAudio(input, rate) {
      let rms = 0; for (let i = 0; i < input.length; i += 4) rms += input[i] * input[i];
      rms = Math.sqrt(rms / (input.length / 4));
      if (this.listening) drawLevel(rms);
      // 数字人播报时（及刚结束 0.6 秒内）不收音，避免识别到自己的声音
      if (this.paused || Speaker.active || !this.recognizer || performance.now() - (S.speakEndAt || 0) < 600) return;
      const wakeMode = !this.listening && S.micOn && S.wake && (S.mode === 'attract' || S.mode === 'idle') && S.flow < 0;
      if (!this.listening && !wakeMode) return;
      if (!this.stream) this.newStream();
      const samples = rate === 16000 ? new Float32Array(input) : downsample(input, rate, 16000);
      this.stream.acceptWaveform(16000, samples);
      while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
      const text = (this.recognizer.getResult(this.stream).text || '').trim();
      const endpoint = this.recognizer.isEndpoint(this.stream);
      if (this.listening) {
        if (text && text !== this.partial) { this.partial = text; this.heardAt = performance.now(); showUtter(text, true); }
        const now = performance.now();
        if ((endpoint && this.partial) || (this.partial && now - this.heardAt > 1600)) return this.finish();
        if (!this.partial && now - this.startedAt > 9000) return this.finish();
        if (now - this.startedAt > 20000) return this.finish();
      } else if (wakeMode) {
        if (text && text !== this.wakeHeard) { this.wakeHeard = text; console.info('[语音] 待机听到：' + text); VoiceUI.heard(text); }
        if (text && Sync.wakeMatch(text)) {
          console.info('[语音] 唤醒词命中：' + text);
          window.__wakeHits = (window.__wakeHits || 0) + 1;
          this.recognizer.reset(this.stream); this.wakeHeard = '';
          wakeUp(true); return;
        }
        if (endpoint || performance.now() - this.wakeResetAt > 8000) { this.recognizer.reset(this.stream); this.wakeHeard = ''; this.wakeResetAt = performance.now(); }
      }
    },
    pauseForSpeech(on) { this.paused = on; if (!on && this.stream && this.recognizer) this.recognizer.reset(this.stream); },
    async start() {
      if (!S.micOn) { toast('麦克风已关闭'); MicPower.show(); return; }
      if (S.asrEngine === 'off') { toast('语音识别已关闭，请使用文字输入'); return; }
      if (S.asrEngine === 'webspeech' || (this.status === 'error' && webSpeechAvailable())) return this.startWeb();
      if (this.status !== 'ready') { toast(this.status === 'loading' ? `语音模型加载中（${Math.round(this.progress * 100)}%），可先点选问题` : '语音识别暂不可用，请使用文字输入'); return; }
      if (!(await this.ensureMic(true))) return;
      Speaker.stop();
      this.paused = false;
      this.newStream();
      this.partial = ''; this.listening = true; this.startedAt = performance.now(); this.heardAt = performance.now();
      setMode('listening'); showUtter('', true);
    },
    finish() {
      if (!this.listening) return;
      this.listening = false;
      let text = this.partial;
      if (this.recognizer && this.stream) {
        // 补一段静音，让模型输出尾字
        this.stream.acceptWaveform(16000, new Float32Array(8000));
        while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
        text = (this.recognizer.getResult(this.stream).text || text || '').trim();
        this.recognizer.reset(this.stream);
      }
      drawLevel(0);
      if (text) ask(text);
      else { setMode('idle'); showUtter('没有听清，请再说一次或点选下方问题'); }
    },
    cancel() { this.listening = false; if (this.web) { try { this.web.abort(); } catch {} this.web = null; } },
    startWeb() {
      const R = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!R) { toast('当前浏览器不支持语音识别，请使用文字输入'); return; }
      Speaker.stop();
      const r = new R(); this.web = r;
      r.lang = 'zh-CN'; r.interimResults = true; r.maxAlternatives = 1;
      let finalText = '';
      r.onresult = (e) => { let t = ''; for (const res of e.results) t += res[0].transcript; finalText = t; showUtter(t, true); };
      r.onerror = () => { setMode('idle'); toast('在线语音识别不可用，请检查网络或使用文字输入'); };
      r.onend = () => { this.web = null; if (finalText) ask(finalText); else if (S.mode === 'listening') setMode('idle'); };
      setMode('listening'); showUtter('', true);
      r.start();
    },
  };

  /* ---------- 待机页语音状态提示（浅色小标签） ---------- */
  const VoiceUI = {
    heardTimer: null,
    render() {
      const pill = $('#voicePill'); if (!pill) return;
      let text, cls;
      if (!S.micOn) { text = '麦克风已关闭 · 轻触底部可重新开启'; cls = 'off'; }
      else if (!S.wake || S.asrEngine === 'off') { text = '语音唤醒已关闭 · 请轻触屏幕'; cls = 'off'; }
      else if (S.asrEngine === 'webspeech') { text = '轻触屏幕开始对话'; cls = 'off'; }
      else if (ASR.status === 'error') { text = '语音识别不可用 · 请轻触屏幕'; cls = 'warn'; }
      else if (ASR.micState === 'asking') { text = '请在浏览器弹窗中点“允许”使用麦克风'; cls = 'warn'; }
      else if (ASR.micState === 'denied') { text = '麦克风被浏览器禁止 · 点地址栏左侧图标改为“允许”'; cls = 'warn'; }
      else if (ASR.micState === 'sysdenied') { text = '系统禁止 Chrome 用麦克风 · 系统设置→隐私与安全性→麦克风'; cls = 'warn'; }
      else if (ASR.micState === 'silent') { text = '麦克风没有声音 · 请检查系统声音输入设备'; cls = 'warn'; }
      else if (ASR.micState === 'nodevice') { text = '未检测到麦克风 · 请轻触屏幕'; cls = 'warn'; }
      else if (ASR.micState !== 'on' && ASR.micState !== 'silent') { text = '轻触此处开启语音唤醒'; cls = 'warn'; }
      else if (ASR.status !== 'ready') { text = `语音模型加载中 ${Math.round(ASR.progress * 100)}%`; cls = 'wait'; }
      else { text = '语音唤醒已开启 · 请说“你好”'; cls = 'on'; }
      pill.className = 'voice-pill ' + cls;
      pill.dataset.state = cls;
      $('#voiceText').textContent = text;
      Cue.render();
    },
    heard(t) {
      const h = $('#voiceHeard'); if (!h) return;
      h.textContent = '听到：' + t.slice(-12);
      clearTimeout(this.heardTimer); this.heardTimer = setTimeout(() => { h.textContent = ''; }, 2500);
    },
  };

  function webSpeechAvailable() { return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition); }

  function recognizerConfig() {
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: './encoder.onnx', decoder: './decoder.onnx', joiner: './joiner.onnx' },
        paraformer: { encoder: '', decoder: '' },
        zipformer2Ctc: { model: '' }, nemoCtc: { model: '' }, toneCtc: { model: '' },
        tokens: './tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: '', modelingUnit: 'cjkchar', bpeVocab: '',
      },
      decodingMethod: 'greedy_search', maxActivePaths: 4,
      enableEndpoint: 1, rule1MinTrailingSilence: 2.0, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 20,
      hotwordsFile: '', hotwordsScore: 1.5,
      ctcFstDecoderConfig: { graph: '', maxActive: 3000 }, ruleFsts: '', ruleFars: '',
    };
  }

  function downsample(buf, from, to) {
    const ratio = from / to; const n = Math.round(buf.length / ratio); const out = new Float32Array(n);
    let o = 0, b = 0;
    while (o < n) { const nb = Math.round((o + 1) * ratio); let acc = 0, c = 0; for (let i = b; i < nb && i < buf.length; i++) { acc += buf[i]; c++; } out[o++] = c ? acc / c : 0; b = nb; }
    return out;
  }

  const bars = [...document.querySelectorAll('#level i')];
  function drawLevel(rms) {
    const v = Math.min(1, rms * 9);
    bars.forEach((b, i) => { const k = 1 - Math.abs(i - 3) / 4; b.style.height = `${6 + v * 18 * (0.5 + k * 0.5 + Math.random() * 0.2)}px`; });
  }

  /* ---------- 对话 ---------- */
  function showUtter(text, live = false) {
    const u = $('#utter');
    u.classList.toggle('live', live);
    $('#utterText').textContent = live ? (text || '请说出您的问题') : text;
  }

  let askSeq = 0;
  const voiceKey = () => S.voice || S.cfg?.defaultVoice || 'female';
  const FILLER_MS = 1800; // 大模型首句超过这个时间还没到，先说一句“好的，我想一想”

  /** 读取 /api/chat/stream 的 NDJSON 事件流，逐个交给 onEvent */
  async function readStream(body, onEvent) {
    const res = await fetch('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error('http ' + res.status);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { onEvent(JSON.parse(line)); } catch {} } }
    }
    if (buf.trim()) { try { onEvent(JSON.parse(buf)); } catch {} }
  }

  async function ask(text, opts = {}) {
    touch();
    text = String(text || '').trim();
    if (!text) return;
    if (S.mode === 'attract') exitAttract(false);
    const seq = ++askSeq;
    const live = () => seq === askSeq;
    showUtter(text);
    setMode('thinking');
    ASR.cancel();

    // 事件队列：大模型每出一句就排队播报，首句一到立即开口；后续句子提前合成
    const q = []; let wake = null; let final = null;
    const t0 = performance.now(); const lat = window.__dhLatency = { text, firstSentence: null, firstAudio: null, firstAudible: null, done: null };
    const push = (ev) => {
      if (!live()) return;
      if (ev.type === 'sentence') {
        if (lat.firstSentence === null) lat.firstSentence = Math.round(performance.now() - t0);
        if (q.some((e) => e.type === 'sentence') || Speaker.active) fetch(`/api/tts/prefetch?voice=${encodeURIComponent(voiceKey())}&text=${encodeURIComponent(ev.text)}`).catch(() => {});
      }
      if (ev.type === 'done') { final = ev; lat.done = Math.round(performance.now() - t0); }
      q.push(ev); if (wake) { wake(); wake = null; }
    };
    readStream({ text, flow: S.flow >= 0, history: S.history.slice(-6) }, push)
      .catch(() => {})
      .finally(() => { if (!final) push({ type: 'done', intent: 'fallback', speech: '网络开小差了，请稍后再试，或咨询大堂经理。', source: 'error' }); });
    const next = () => (q.length ? Promise.resolve(q.shift()) : new Promise((r) => { wake = r; }).then(() => q.shift()));

    // 逐句播报期间一直保持“说话中”（不在句间切回待机，避免句间被当成唤醒监听）
    const speakPart = async (t) => {
      ASR.pauseForSpeech(true);
      const onPlay = () => { if (lat.firstAudible == null) lat.firstAudible = Math.round(performance.now() - t0); };
      Speaker.audio.addEventListener('playing', onPlay, { once: true });
      if (Speaker.clipEl) Speaker.clipEl.addEventListener('playing', onPlay, { once: true });
      const r = await Speaker.speak(t);
      Speaker.audio.removeEventListener('playing', onPlay);
      if (Speaker.clipEl) Speaker.clipEl.removeEventListener('playing', onPlay);
      return r;
    };
    let fillerP = null;
    const fillerTimer = setTimeout(() => { if (live() && !q.length && S.mode === 'thinking' && S.cfg?.filler) fillerP = speakPart(S.cfg.filler); }, FILLER_MS);
    const said = [];
    let ev;
    while ((ev = await next())) {
      if (!live()) return;
      if (ev.type === 'meta') continue;
      clearTimeout(fillerTimer);
      if (fillerP) { const fr = await fillerP; fillerP = null; if (fr === 'stopped' || !live()) return; }
      if (ev.type === 'sentence') {
        if (!said.length) { if (S.flow >= 0) exitFlow(false); hidePanel(); setMode('speaking'); }
        said.push(ev.text);
        const r = await speakPart(ev.text);
        if (r === 'stopped' || !live()) { ASR.pauseForSpeech(false); return; }
        continue;
      }
      if (ev.type === 'done') break;
    }
    ASR.pauseForSpeech(false);
    if (!live()) return;
    const r = final || {};
    window.__lastAnswer = r;
    if (r.intent === 'nav_next') return flowGo(S.flow + 1);
    if (r.intent === 'nav_prev') return flowGo(Math.max(0, S.flow - (/再说|没听清|重复/.test(text) ? 0 : 1)));
    if (r.intent === 'nav_exit') return exitFlow(true);
    if (r.intent === 'empty') { setMode('idle'); return; }

    if (said.length) {
      // 大模型逐句已播完
      S.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.speech || said.join('') });
      if (r.card) showCard(r.card);
      renderChips(r.follow && r.follow.length ? r.follow : null);
      if (S.mode === 'speaking') setMode('idle');
      return afterAnswer();
    }
    S.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.speech });
    if (r.action === 'kiosk_flow') { startFlow(r.speech); return; }
    if (S.flow >= 0 && r.intent !== 'fallback') exitFlow(false);
    if (r.card) showCard(r.card); else if (S.flow < 0 && !['thanks', 'who'].includes(r.intent)) hidePanel();
    renderChips(r.follow && r.follow.length ? r.follow : null);
    if (r.action === 'call_staff') toast('已通知大堂经理，请稍候', 4000);
    if (r.action === 'outfit') { if (!(r.outfit && Outfit.apply(r.outfit))) Outfit.step(); }
    const sr = await say(r.speech);
    if (sr !== 'stopped' && live() && r.intent !== 'bye') afterAnswer();
  }

  /** 无文字模式没有按钮：答完自动再听一轮，方便客户接着问（约 9 秒没说话就回到待机唤醒） */
  function afterAnswer() {
    if (S.micOn && !S.showText && S.mode === 'idle' && S.flow < 0) setTimeout(() => { if (S.micOn && S.mode === 'idle' && !Speaker.active) ASR.start(); }, 250);
  }

  /* ---------- 信息卡 ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function showCard(card) {
    const list = card.items.map((it, i) => `<li data-n="${i + 1}"><div class="it">${esc(it.t)}</div>${it.d ? `<div class="id">${esc(it.d)}</div>` : ''}</li>`).join('');
    $('#panel').innerHTML = `
      <div class="kicker">${card.type === 'steps' ? '办理步骤' : '要点提示'}</div>
      <h3>${esc(card.title)}</h3>
      <ol class="${card.type === 'steps' ? 'steps' : 'points'}">${list}</ol>
      ${card.note ? `<div class="note">${esc(card.note)}</div>` : ''}
      ${card.source ? `<div class="src">依据：${esc(card.source)}</div>` : ''}`;
    app.classList.add('has-panel');
  }
  function hidePanel() { app.classList.remove('has-panel'); }

  /* ---------- 推荐问题 ---------- */
  const EXTRA = ['手机银行能查征信吗', '查询要收费吗', '报告里有哪些内容', '别人能随便查我的征信吗', '动产融资登记怎么办', '怎样维护良好信用', '本人查询影响信用吗', '柜台查询要带什么'];
  function renderChips(follow, only = false) {
    const base = S.cfg ? S.cfg.suggestions : [];
    const pool = [base, EXTRA];
    const main = pool[S.suggestPage % pool.length];
    const chips = [];
    if (follow) follow.forEach((q) => chips.push(`<button class="chip follow" type="button">${esc(q)}</button>`));
    if (!only) main.filter((q) => !(follow || []).includes(q)).slice(0, follow ? 6 - follow.length : 6).forEach((q) => chips.push(`<button class="chip" type="button">${esc(q)}</button>`));
    $('#chips').innerHTML = chips.join('');
    $('#suggestLabel').textContent = follow ? '您可能还想了解' : '您可以这样问我';
  }
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    b.classList.add('pressed'); setTimeout(() => b.classList.remove('pressed'), 300);
    ask(b.textContent);
  });
  $('#moreBtn').addEventListener('click', () => { S.suggestPage++; renderChips(null); touch(); });

  /* ======================================================================
   * 自助查询机操作指引（示例数据全部脱敏）
   * ====================================================================== */
  const silhouette = '<svg viewBox="0 0 100 110"><circle cx="50" cy="38" r="22" fill="#b8c7d3"/><path d="M8 110c4-28 22-40 42-40s38 12 42 40z" fill="#b8c7d3"/></svg>';
  function screenHtml(key) {
    const p = S.cfg.sample;
    switch (key) {
      case 'id': return `
        <div class="screen-bar"><span>个人信用报告自助查询</span><span>步骤 1 / 5</span></div>
        <div class="idcard"><div class="photo">${silhouette}</div>
          <div class="row"><span class="k">姓　　名</span><span>${esc(p.name)}</span></div>
          <div class="row"><span class="k">性　　别</span><span>*</span></div>
          <div class="row"><span class="k">住　　址</span><span>**省**市****</span></div>
          <div class="row"><span class="k">身份号码</span><span>${esc(p.idNo)}</span></div>
        </div>
        <div class="reader">请将身份证放置于读卡区</div>
        <div class="ok">证件读取成功</div>`;
      case 'face': return `
        <div class="screen-bar"><span>人脸识别核验</span><span>步骤 2 / 5</span></div>
        <div class="face"><div class="face-frame">${silhouette}</div>
        <div class="ok">比对通过 · 本人核验成功</div></div>`;
      case 'phone': return `
        <div class="screen-bar"><span>手机号码验证</span><span>步骤 3 / 5</span></div>
        <div class="field"><div class="lab">本人手机号码</div><div class="box">${esc(p.phone)}</div></div>
        <div class="field"><div class="lab">短信验证码</div><div class="box">● ● ● ● ● ●<em>已发送 · 58 秒</em></div></div>
        <div class="ok">验证码校验通过</div>`;
      case 'version': return `
        <div class="screen-bar"><span>选择报告版本</span><span>步骤 4 / 5</span></div>
        <div class="opt sel"><span class="radio"></span><div><div class="ot">本人版（推荐）</div><div class="od">信息最完整，适合个人自查</div></div></div>
        <div class="opt"><span class="radio"></span><div><div class="ot">银行版</div><div class="od">与金融机构查看的内容一致</div></div></div>
        <div class="opt sel"><span class="radio"></span><div><div class="ot">现场打印</div><div class="od">打印后请妥善保管</div></div></div>`;
      case 'report': return `
        <div class="screen-bar"><span>个人信用报告（本人版）· 概要</span><span>步骤 5 / 5</span></div>
        <div class="report">
          <div class="rh"><span>${esc(p.name)}</span><span>${esc(p.idNo)}</span></div>
          <table>
            <tr><th>信用卡</th><td>账户 2 个 · 当前无逾期</td></tr>
            <tr><th>贷款</th><td>住房贷款 1 笔 · 正常还款</td></tr>
            <tr><th>对外担保</th><td>无</td></tr>
            <tr><th>公共信息</th><td>无欠税、强制执行记录</td></tr>
            <tr><th>近两年查询</th><td>本人查询 2 次 · 贷后管理 3 次</td></tr>
          </table>
          <span class="tag">示例数据 · 个人信息已脱敏</span>
        </div>`;
      default: return '';
    }
  }
  function renderFlow() {
    const steps = S.cfg.kioskSteps; const i = S.flow; const st = steps[i];
    const prog = steps.map((_, k) => `<span class="${k < i ? 'done' : k === i ? 'cur' : ''}"></span>`).join('');
    $('#panel').innerHTML = `
      <div class="kicker">自助查询机操作指引</div>
      <h3>${i + 1}. ${esc(st.title)}</h3>
      <div class="flow-progress">${prog}</div>
      <div class="screen">${screenHtml(st.key)}</div>
      <div class="flow-nav">
        <button type="button" data-nav="exit">退出</button>
        <button type="button" data-nav="prev" ${i === 0 ? 'disabled' : ''}>上一步</button>
        <button type="button" class="primary" data-nav="next">${i === steps.length - 1 ? '完成' : '下一步'}</button>
      </div>`;
    app.classList.add('has-panel');
  }
  $('#panel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]'); if (!b) return;
    touch();
    const n = b.dataset.nav;
    if (n === 'next') flowGo(S.flow + 1); else if (n === 'prev') flowGo(S.flow - 1); else exitFlow(true);
  });
  async function startFlow(intro) {
    S.flow = 0; renderFlow();
    renderChips(['下一步', '上一步', '再说一遍', '退出指引'], true);
    $('#suggestLabel').textContent = '您可以说';
    const r = await say(intro || '好的，我带您一步一步在自助查询机上查询。');
    if (r !== 'stopped' && S.flow === 0) await say(S.cfg.kioskSteps[0].speech);
  }
  async function flowGo(i) {
    if (S.flow < 0) { setMode('idle'); return; }
    const steps = S.cfg.kioskSteps;
    if (i >= steps.length) return exitFlow(true, '查询指引已完成。如需打印报告，可前往右侧自助查询机办理。');
    if (i < 0) i = 0;
    S.flow = i; renderFlow();
    await say(steps[i].speech);
  }
  async function exitFlow(speak, line) {
    if (S.flow < 0) return;
    S.flow = -1; hidePanel(); renderChips(null);
    if (speak) await say(line || '好的，已退出查询指引。您还可以继续问我其他问题。');
  }

  /* ======================================================================
   * 待机吸引态：无人互动一段时间后进入，轮播信用小知识，定时问候
   * ====================================================================== */
  let tipIdx = 0, tipTimer = null, attractSince = 0, lastGreet = 0, greetCount = 0;
  function renderTip() {
    const tips = S.cfg.tips; const t = tips[tipIdx % tips.length];
    $('#tipTitle').textContent = t.t; $('#tipDesc').textContent = t.d;
    $('#tipDots').innerHTML = tips.map((_, k) => `<i class="${k === tipIdx % tips.length ? 'on' : ''}"></i>`).join('');
  }
  function enterAttract() {
    ASR.cancel(); Speaker.stop();
    S.flow = -1; hidePanel(); renderChips(null);
    showUtter('请点击下方按钮说话，或直接点选问题');
    setMode('attract'); attractSince = Date.now(); lastGreet = Date.now() - Math.max(0, (Number(params.get('greetEvery') || 120) - 8)) * 1000;
    renderTip();
    clearInterval(tipTimer); tipTimer = setInterval(() => { tipIdx++; renderTip(); }, 7000);
  }
  function exitAttract() { clearInterval(tipTimer); setMode('idle'); touch(); }
  async function wakeUp(byVoice) {
    // 用户没提问时不说话：唤醒只进入聆听，不播欢迎语
    if (S.mode !== 'attract' && !byVoice) return;
    exitAttract();
    showUtter(byVoice ? '你好' : '请点击下方按钮说话，或直接点选问题');
    if (S.micOn && (byVoice || !S.showText) && S.mode === 'idle') ASR.start();
  }
  setInterval(() => {
    if (!S.cfg) return;
    const idleFor = (Date.now() - S.lastTouch) / 1000;
    const busy = Speaker.active || ASR.listening || S.mode === 'thinking';
    if (S.mode !== 'attract' && !busy && idleFor > S.cfg.attractAfterSec) enterAttract();
    // 用户没有提问时不说话：吸引态只轮播画面上的小知识文字，不自动播报
  }, 1000);

  /* ---------- 事件绑定 ---------- */
  // 任意一次点击/按键：解锁声音；麦克风还没开就顺便打开（浏览器要求音频必须由用户操作开启）
  const onGesture = () => {
    Speaker.unlock(); touch();
    if (S.micOn && S.wake && S.asrEngine === 'sherpa' && ASR.micState !== 'on') ASR.ensureMic(true);
  };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  $('#voicePill').addEventListener('click', async (e) => {
    e.stopPropagation(); touch();
    if (await ASR.ensureMic(true)) { MicPower.status('麦克风已开启，可点击底部按钮说话', 'ok'); }
    else MicPower.status('未能开启麦克风', 'warn');
  });
  (() => {
    const zone = $('#micPowerZone'); const btn = $('#micPower'); if (!zone || !btn) return;
    zone.addEventListener('pointerenter', () => MicPower.show(0));
    zone.addEventListener('pointerleave', () => {
      if (S.mode === 'listening' || S.mode === 'thinking') return;
      clearTimeout(MicPower.hideTimer);
      MicPower.hideTimer = setTimeout(() => zone.classList.remove('show'), 800);
    });
    zone.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#micPower') || e.target.closest('#micHint')) return;
      if (!zone.classList.contains('show')) { e.preventDefault(); e.stopPropagation(); MicPower.show(6000); MicPower.render(); }
    }, true);
    btn.addEventListener('click', (e) => { e.stopPropagation(); touch(); MicPower.click(); });
  })();
  $('#attract').addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]');
    if (q) { e.stopPropagation(); exitAttract(); ask(q.dataset.q); return; }
    wakeUp(false);
  });
  // 无文字模式：轻触画面任意位置 = 说话（待机时先问候；播报中轻触 = 打断并开始听）
  function tapTalk() {
    touch();
    if (!S.micOn) { MicPower.show(); toast('麦克风已关闭'); return; }
    if (S.mode === 'attract') return wakeUp(false);
    if (ASR.listening) return ASR.finish();
    if (Speaker.active || S.mode === 'thinking') { askSeq++; Speaker.stop(); ASR.pauseForSpeech(false); setMode('idle'); }
    ASR.start();
  }
  // 画面手势：轻触 = 换下一套衣服（播报中也能换，声音不断）；长按 0.8 秒 = 说话 / 打断播报
  const LONG_MS = 800;
  let pressT = null, pressLong = false, pressXY = null;
  $('#stage').addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('#panel, #cue, #hot, button, a, input, select')) return;
    pressLong = false; pressXY = [e.clientX, e.clientY];
    clearTimeout(pressT); pressT = setTimeout(() => { pressT = null; pressLong = true; tapTalk(); }, LONG_MS);
  });
  $('#stage').addEventListener('pointermove', (e) => {
    if (pressT && pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 30) { clearTimeout(pressT); pressT = null; pressXY = null; }
  });
  $('#stage').addEventListener('pointerup', () => {
    if (!pressT) { pressXY = null; return; }
    clearTimeout(pressT); pressT = null;
    if (!pressLong && pressXY) { touch(); if (S.mode === 'attract') exitAttract(); Outfit.step(); }
    pressXY = null;
  });
  $('#stage').addEventListener('pointercancel', () => { clearTimeout(pressT); pressT = null; pressXY = null; });
  $('#stage').addEventListener('contextmenu', (e) => e.preventDefault());
  // 左上角隐藏热区长按 2 秒打开现场设置（无文字模式下标识不显示）
  let hotTimer;
  $('#hot').addEventListener('pointerdown', (e) => { e.stopPropagation(); hotTimer = setTimeout(openSettings, 2000); });
  ['pointerup', 'pointerleave'].forEach((n) => $('#hot').addEventListener(n, () => clearTimeout(hotTimer)));
  $('#hot').addEventListener('click', (e) => e.stopPropagation());
  $('#micBtn').addEventListener('click', () => {
    touch();
    if (!S.micOn) { MicPower.show(); toast('麦克风已关闭'); return; }
    if (ASR.listening) return ASR.finish();
    if (S.mode === 'listening' && ASR.web) { try { ASR.web.stop(); } catch {} return; }
    if (Speaker.active || S.mode === 'thinking') { askSeq++; Speaker.stop(); ASR.pauseForSpeech(false); setMode('idle'); }
    ASR.start();
  });
  $('#kbBtn').addEventListener('click', () => { app.classList.add('typing'); $('#textInput').focus(); touch(); });
  $('#textClose').addEventListener('click', () => app.classList.remove('typing'));
  $('#textbar').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#textInput').value.trim(); if (!v) return;
    $('#textInput').value = ''; app.classList.remove('typing');
    ask(v);
  });
  $('#textInput').addEventListener('input', touch);
  $('#guideBtn').addEventListener('click', () => { touch(); Speaker.stop(); ask('自助查询机怎么操作'); });

  // 设置面板：长按左上角标识 2 秒
  let pressTimer;
  $('#brand').addEventListener('pointerdown', () => { pressTimer = setTimeout(openSettings, 2000); });
  ['pointerup', 'pointerleave'].forEach((ev) => $('#brand').addEventListener(ev, () => clearTimeout(pressTimer)));
  function openSettings() {
    const sel = $('#setVoice');
    sel.innerHTML = Object.entries(S.cfg.voices).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    sel.value = S.voice || S.cfg.defaultVoice;
    $('#setWake').checked = S.wake; $('#setAsr').value = S.asrEngine;
    const hasSens = Outfit.list.some((o) => o.sensitive);
    $('#setSensitiveRow').hidden = !hasSens; $('#setSensitive').checked = Outfit.sensitive;
    const fillOutfits = () => {
      const os = $('#setOutfit');
      os.innerHTML = Outfit.list.filter((o) => $('#setSensitive').checked || !o.sensitive).map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
      os.value = Outfit.cur ? Outfit.cur.id : '';
    };
    $('#setSensitive').onchange = fillOutfits; fillOutfits();
    $('#settings').hidden = false;
  }
  $('#setClose').addEventListener('click', () => {
    S.voice = $('#setVoice').value; store.set('voice', S.voice);
    S.wake = $('#setWake').checked; store.set('wake', S.wake);
    Outfit.sensitive = $('#setSensitive').checked; store.set('sensitive', Outfit.sensitive);
    if ($('#setOutfit').value) Outfit.apply($('#setOutfit').value);
    if (Outfit.cur && !Outfit.find(Outfit.cur.id)) Outfit.step();
    const eng = $('#setAsr').value;
    if (eng !== S.asrEngine) { S.asrEngine = eng; store.set('asr', eng); ASR.status = 'idle'; ASR.load(); }
    $('#settings').hidden = true;
    if (S.micOn && S.wake) ASR.ensureMic(true);
    MicPower.render(); VoiceUI.render();
  });
  /* ---------- 全屏 / 退出全屏（右上角悬停按钮、F 键、F2 设置里的按钮共用） ---------- */
  const FullScreen = {
    el() { return document.fullscreenElement || document.webkitFullscreenElement || null; },
    supported() {
      const d = document.documentElement;
      return Boolean(d.requestFullscreen || d.webkitRequestFullscreen) && document.fullscreenEnabled !== false && document.webkitFullscreenEnabled !== false;
    },
    note(msg) {
      const n = $('#fsNote'); if (!n) return;
      n.textContent = msg; n.hidden = false;
      clearTimeout(this.noteT); this.noteT = setTimeout(() => { n.hidden = true; }, 3200);
      console.info('[全屏] ' + msg);
    },
    async enter() {
      const d = document.documentElement;
      if (!this.supported()) { this.note('此浏览器不支持网页全屏，可按 F11 或使用浏览器菜单全屏'); return; }
      try {
        if (d.requestFullscreen) await d.requestFullscreen({ navigationUI: 'hide' });
        else d.webkitRequestFullscreen();
      } catch (e) { this.note('浏览器拒绝了全屏，请再点一次或按 F11'); }
    },
    async exit() {
      try {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch {}
    },
    toggle() { touch(); return this.el() ? this.exit() : this.enter(); },
    render() {
      const on = Boolean(this.el());
      const b = $('#fsToggle');
      if (b) {
        b.classList.toggle('is-fs', on);
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', on ? '退出全屏' : '全屏');
        b.title = on ? '退出全屏（F / Esc）' : '全屏（F）';
      }
      document.documentElement.classList.toggle('is-fullscreen', on);
      try { fit(); } catch {}
    },
  };
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((n) => document.addEventListener(n, () => FullScreen.render()));
  ['fullscreenerror', 'webkitfullscreenerror'].forEach((n) => document.addEventListener(n, () => FullScreen.note('浏览器拒绝了全屏，请再点一次或按 F11')));
  $('#fsToggle')?.addEventListener('click', (e) => { e.stopPropagation(); FullScreen.toggle(); $('#layoutToggleZone')?.classList.add('show'); });
  FullScreen.render();
  function toggleFull() { FullScreen.toggle(); }
  $('#setFull').addEventListener('click', toggleFull);
  if (!$('#setPlaylist')) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML = '<button type="button" id="setPlaylist" style="flex:1;padding:12px;border:1px solid #c8d4e0;border-radius:4px;color:#1f4e79;background:#fff">话术清单（侧栏）</button>';
    $('#setClose').parentElement.parentElement.insertBefore(row, $('#setClose').parentElement);
    $('#setPlaylist').addEventListener('click', () => { $('#settings').hidden = true; ScriptDrawer.show(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target === $('#textInput')) return;
    if (e.key === 'F2') openSettings();
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.matches?.('input,textarea,select,[contenteditable]')) { e.preventDefault(); toggleFull(); }
    if (e.key === ' ') { e.preventDefault(); MicPower.click(); }
  });


  /* ======================================================================
   * 话术播单：由操作台（/admin）遥控；展厅屏负责出声与口型
   * ====================================================================== */
  const Playlist = {
    es: null,
    gapTimer: null,
    seq: 0,
    item: null,
    connect() {
      if (this.es) try { this.es.close(); } catch {}
      this.es = new EventSource('/api/playlist/events');
      this.es.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'hello' && msg.store?.player?.autostart) {
          // 仅当操作员显式打开 autostart 时才自动播；默认不自动说话
          const p = msg.store.player;
          if (p.playing && p.currentId) this.applyControl({ action: 'play', player: p, item: this.findItem(msg.store, p.currentId) });
        }
        if (msg.type === 'control') this.applyControl(msg);
        if (msg.type === 'seek') this.seek(msg);
      };
    },
    findItem(store, id) {
      for (const pl of store.playlists || []) {
        const it = (pl.items || []).find((x) => x.id === id);
        if (it) return { id: it.id, title: it.title, text: it.text, voice: (S.cfg?.voices && S.cfg.voices[it.voice]) ? it.voice : 'female' };
      }
      return null;
    },
    async applyControl(msg) {
      const action = msg.action;
      const player = msg.player || {};
      const item = msg.item;
      if (typeof player.volume === 'number') {
        try { Speaker.audio.volume = player.volume; if (Speaker.clipEl) Speaker.clipEl.volume = player.volume; } catch {}
      }
      if (action === 'pause' || (action === 'toggle' && player.paused)) {
        clearTimeout(this.gapTimer);
        try { Speaker.audio.pause(); } catch {}
        return;
      }
      if (action === 'stop') {
        clearTimeout(this.gapTimer); this.seq++; Speaker.stop();
        if (S.mode === 'speaking') setMode('idle');
        return;
      }
      if (action === 'seek') return this.seek(msg);
      if (action === 'mode' || action === 'select' || action === 'state') return;
      if (action === 'ended' && !player.playing) {
        if (S.mode === 'speaking') setMode('idle');
        showUtter('话术播报已结束');
        return;
      }
      // play / next / prev / ended / toggle→play
      if (!item || !item.text) return;
      if (action === 'toggle' && player.playing && Speaker.active && Speaker.audio.paused) {
        try { await Speaker.audio.play(); } catch {}
        return;
      }
      if (!player.playing) return;
      await this.playItem(item, player);
    },
    seek(msg) {
      const a = Speaker.audio;
      if (!a || !Speaker.active) return;
      const d = a.duration;
      if (typeof msg.ratio === 'number' && isFinite(d) && d > 0) a.currentTime = Math.max(0, Math.min(d, msg.ratio * d));
      else if (typeof msg.seconds === 'number' && msg.seconds >= 0 && msg.seconds <= 2 && isFinite(d) && d > 0 && msg.seconds <= 1.0001) {
        // panel 曾把 0~1 当 ratio 传来；兼容
        a.currentTime = msg.seconds * d;
      } else if (typeof msg.seconds === 'number') a.currentTime = Math.max(0, msg.seconds);
    },
    async playItem(item, player) {
      clearTimeout(this.gapTimer);
      const seq = ++this.seq;
      this.item = item;
      S.playMode = 'playlist';
      if (S.mode === 'attract') exitAttract(false);
      ASR.cancel(); ASR.pauseForSpeech(true);
      askSeq++; // 打断问答播报
      setMode('speaking');
      showUtter(item.title || '话术播报');
      const prevVoice = S.voice;
      if (item.voice && S.cfg?.voices?.[item.voice]) S.voice = item.voice;
      if (typeof player.volume === 'number') {
        try { Speaker.audio.volume = player.volume; } catch {}
      }
      const why = await Speaker.speak(item.text);
      if (item.voice) S.voice = prevVoice;
      ASR.pauseForSpeech(false);
      if (seq !== this.seq) return;
      if (why === 'stopped') return;
      // 通知服务端切下一首；服务端会再推 play
      const gap = Math.max(0, Number(player.gapMs) || 0);
      this.gapTimer = setTimeout(() => {
        if (seq !== this.seq) return;
        fetch('/api/playlist/control', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'ended' }),
        }).catch(() => {});
      }, gap);
    },
  };


  /* ---------- 管理端分栏（VS Code 风格：左管理 / 右人物；与侧栏同一状态） ---------- */
  const ScriptDrawer = {
    open: false,
    edgeTimer: null,
    apply(open) {
      this.open = !!open;
      const d = $('#scriptDrawer'); const f = $('#drawerFrame'); const btn = $('#layoutToggle');
      app.classList.toggle('admin-open', this.open);
      if (d) {
        d.classList.toggle('open', this.open);
        d.setAttribute('aria-hidden', this.open ? 'false' : 'true');
      }
      if (this.open && f && (!f.src || f.src === 'about:blank' || f.getAttribute('src') === 'about:blank')) {
        f.src = '/admin?embed=1';
      }
      if (btn) {
        btn.setAttribute('aria-pressed', this.open ? 'true' : 'false');
        btn.setAttribute('aria-label', this.open ? '收回管理端' : '展开管理端');
        btn.title = this.open ? '收回管理端' : '展开管理端';
      }
      try { sessionStorage.setItem('dh.adminOpen', this.open ? '1' : '0'); } catch {}
      // 遮罩不再使用（分栏时人物保持可见可播）
      const m = $('#drawerMask'); if (m) m.hidden = true;
      fit();
    },
    show() { this.apply(true); },
    hide() { this.apply(false); },
    toggle() { this.apply(!this.open); },
  };
  (() => {
    // 会话内恢复展开状态
    try { if (sessionStorage.getItem('dh.adminOpen') === '1') ScriptDrawer.apply(true); } catch {}

    const zone = $('#layoutToggleZone'); const btn = $('#layoutToggle');
    if (zone && btn) {
      let hideT = null;
      zone.addEventListener('pointerenter', () => { clearTimeout(hideT); zone.classList.add('show'); });
      zone.addEventListener('pointerleave', () => {
        if (ScriptDrawer.open) return;
        clearTimeout(hideT); hideT = setTimeout(() => zone.classList.remove('show'), 500);
      });
      btn.addEventListener('click', (e) => { e.stopPropagation(); touch(); ScriptDrawer.toggle(); zone.classList.add('show'); });
    }

    const edge = $('#drawerEdge');
    if (edge) {
      edge.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        clearTimeout(ScriptDrawer.edgeTimer);
        ScriptDrawer.edgeTimer = setTimeout(() => { ScriptDrawer.edgeTimer = null; ScriptDrawer.show(); }, 700);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((n) => edge.addEventListener(n, () => { clearTimeout(ScriptDrawer.edgeTimer); ScriptDrawer.edgeTimer = null; }));
    }
    $('#drawerClose')?.addEventListener('click', () => ScriptDrawer.hide());
    // 从左缘滑动打开
    let sx = null;
    document.addEventListener('pointerdown', (e) => { if (e.clientX <= 24) sx = e.clientX; else sx = null; }, true);
    document.addEventListener('pointerup', (e) => {
      if (sx == null) return;
      if (e.clientX - sx > 60) ScriptDrawer.show();
      sx = null;
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.target.matches?.('input,textarea,select')) return;
      if (e.key === '[' ) { e.preventDefault(); ScriptDrawer.toggle(); }
      if (e.key === 'Escape' && ScriptDrawer.open) ScriptDrawer.hide();
      if ((e.key === 'p' || e.key === 'P') && e.altKey) { e.preventDefault(); ScriptDrawer.toggle(); }
      if ((e.key === 'l' || e.key === 'L') && e.ctrlKey && e.shiftKey) { e.preventDefault(); ScriptDrawer.toggle(); }
      if ((e.key === 'b' || e.key === 'B') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ScriptDrawer.toggle(); } // 贴近 VS Code
    });
  })();

  /* ---------- 启动 ---------- */
  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    S.cfg = cfg;
    // 只保留女声：本地存的/网址里的男声（male、云扬等）一律改回默认女声
    if (S.voice && !(cfg.voices && Object.prototype.hasOwnProperty.call(cfg.voices, S.voice))) {
      S.voice = null; store.set('voice', null);
    }
    S.showText = params.has('text') ? params.get('text') !== '0' : cfg.showText === true;
    app.classList.toggle('no-text', !S.showText);
    if (window.DHLip) window.DHLip.enabled = Boolean(cfg.lipsync);
    // 口型方式：loop = 说话循环视频（默认）；gate = 音量门控说话视频（停顿时停在闭嘴帧）。URL ?mouth=gate 可临时试用
    Gate.on = (params.get('mouth') || cfg.mouthMode || 'loop') === 'gate';
    Gate.voice.holdMs = Gate.on ? 150 : 400; // 没有时间戳时按音量：loop 只在较长的安静处停
    app.classList.add('gate');
    Outfit.init(cfg.outfits);
    if (params.get('attract')) cfg.attractAfterSec = Number(params.get('attract'));
    $('#siteName').textContent = cfg.site.bank ? `${cfg.site.bank} · ${cfg.site.name}` : cfg.site.name;
    $('#siteSub').textContent = cfg.site.subtitle;
    renderChips(null);
    enterAttract();
    Playlist.connect();
    ASR.load();
    // 页面一打开就尝试开麦（首次访问会弹出授权框；展厅 kiosk 启动参数会自动允许）
    if (S.micOn && S.wake && S.asrEngine === 'sherpa') ASR.ensureMic(false);
    MicPower.render(); VoiceUI.render();
  });
  if (navigator.permissions) {
    navigator.permissions.query({ name: 'microphone' }).then((p) => {
      p.onchange = () => { console.info('[语音] 麦克风权限变为 ' + p.state); if (p.state === 'granted' && S.micOn && S.wake) ASR.ensureMic(false); else if (p.state === 'denied') { ASR.releaseMic(); ASR.setMic('denied'); } };
    }).catch(() => {});
  }
  setInterval(() => ASR.watchdog(), 2000);

  // 供现场调试与自动化截图使用
  window.dh = { fullscreen: FullScreen, ask, startFlow, flowGo, exitFlow, enterAttract, wakeUp, say, state: S, asr: ASR, speaker: Speaker, showUtter, setMode, subtitle: Subtitle, voiceUI: VoiceUI, micPower: MicPower, playlist: Playlist, scriptDrawer: ScriptDrawer, isTalking: () => talkOn, outfit: Outfit };
})();
