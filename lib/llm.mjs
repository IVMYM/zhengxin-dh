// 可插拔的 OpenAI 兼容大模型接口。未配置时不启用，系统完全使用本地知识库作答。
import { describeNow, calendarHint } from './clock.mjs';
// 配置来自环境变量或项目根目录的 .env（不入 git）：
//   LLM_BASE_URL        例如 https://api.example.com/v1（含 /v1 前缀）
//   LLM_API_KEY         访问密钥
//   LLM_MODEL           模型名称
//   LLM_FIRST_MS        等第一个字的上限（默认 12000），超时回落知识库
//   LLM_TIMEOUT_MS      整句上限（默认 20000）
//   LLM_EXTRA_BODY      追加到请求体的 JSON（默认 {"reasoning_effort":"low"}：思考最短，首字约 1~2 秒）
//   LLM_MODE            kb-first（默认：知识库有把握的问题直接用知识库口径，其余交给大模型）| always
import { KB, ASSISTANT_NAME } from './kb.mjs';

const DEFAULT_EXTRA = { reasoning_effort: 'low' };

export function llmConfig(env = process.env) {
  const baseUrl = (env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const model = env.LLM_MODEL || '';
  let extra = DEFAULT_EXTRA;
  if (env.LLM_EXTRA_BODY) { try { extra = JSON.parse(env.LLM_EXTRA_BODY); } catch { console.warn('[llm] LLM_EXTRA_BODY 不是合法 JSON，已忽略'); } }
  return {
    enabled: Boolean(baseUrl && model),
    baseUrl,
    apiKey: env.LLM_API_KEY || '',
    model,
    firstMs: Number(env.LLM_FIRST_MS || 12000),
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 20000),
    extra,
    mode: env.LLM_MODE === 'always' ? 'always' : 'kb-first',
  };
}

export function buildMessages(question, contextEntries, history = [], now = new Date()) {
  const ctx = contextEntries.map((e) => `【${e.title}】${e.speech}${e.card ? ' 要点：' + e.card.items.map((i) => i.t + (i.d ? '：' + i.d : '')).join('；') : ''}`).join('\n');
  const system = [
    `你是银行网点征信服务区的数字人服务助理“${ASSISTANT_NAME}”，站在展厅里用语音接待来访客户。`,
    '规则：',
    '1. 征信、个人和企业信用报告、信用知识、本行网点征信服务相关的问题：优先依据下面的参考资料和《征信业管理条例》作答；资料里没有的费用、次数、天数、时限、利率等数字一律不说，举例也不说，改说“具体以网点公示为准，可以咨询大堂经理”。',
    '2. 日常寒暄、闲聊、展厅参观、天气、指路等与展厅接待相关的话题：自然、简短地回应，像现场柜员说话一样，一两句话即可，不必强行扯回征信。',
    '3. 政治敏感、违法违规、人身攻击、医疗诊断、投资荐股、代客理财、索要客户隐私等不宜话题：一句礼貌拒绝，并建议咨询大堂经理；不要展开。',
    '4. 回答会被直接朗读：用亲切自然的普通话口语，1到3句，一般不超过80字；不要 Markdown、编号、括号注释、英文单词和表情。',
    '5. 不推荐任何第三方App或“征信修复”服务；不良记录不能花钱删除，只有信息错误才能走异议申请。',
    '6. 不索要、不复述身份证号、手机号、银行卡号；举例时一律打码，例如 张*、138****5678。',
    '7. 直接说答案，不要输出思考过程。',
    `8. 现在是${describeNow(now)}。${calendarHint(now)}问到今天、明天、几号、星期几、几点等，一律以此为准推算，不要编造日期；是否节假日、网点是否营业等不确定的，说“以网点公示为准”。`,
    ctx ? `参考资料：\n${ctx}` : '参考资料：无。征信类问题只给一般性引导，并建议咨询大堂经理。',
  ].join('\n');
  // IFM/K2 等多轮接口要求每条 assistant 都带 reasoning_content（可为空字符串），否则 HTTP 400
  const turns = history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content).slice(-6)
    .map((m) => (m.role === 'assistant'
      ? { role: 'assistant', content: String(m.content), reasoning_content: typeof m.reasoning_content === 'string' ? m.reasoning_content : '' }
      : { role: 'user', content: String(m.content) }));
  return [
    { role: 'system', content: system },
    ...turns,
    { role: 'user', content: question },
  ];
}

/** 兼容旧格式：模型若输出 {"speech":...} JSON 则取 speech，否则按纯文本 */
export function parseLlmOutput(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j.speech === 'string' && j.speech.trim()) {
        let card = null;
        if (j.card && Array.isArray(j.card.items) && j.card.items.length) {
          card = {
            type: j.card.type === 'steps' ? 'steps' : 'points',
            title: String(j.card.title || '要点'),
            items: j.card.items.slice(0, 5).map((i) => ({ t: String(i.t || i.title || ''), d: i.d ? String(i.d) : '' })).filter((i) => i.t),
          };
        }
        return { speech: j.speech.trim(), card };
      }
    } catch { /* 非 JSON，按纯文本处理 */ }
  }
  const plain = cleanSpeech(text);
  return plain ? { speech: plain.slice(0, 200), card: null } : null;
}

const KEEP_LATIN = /^(APP|App|app|ATM|PIN|IC)$/;
/** 朗读前清理：去 Markdown、思考标签、混入的外文字符和零散英文词 */
export function cleanSpeech(text) {
  let s = String(text || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '');
  s = s.replace(/[#*`>|_]/g, '').replace(/^\s*[-•]\s*/gm, '').replace(/^\s*\d+[.、)]\s*/gm, '');
  // 只保留中文、常用拉丁字符与标点（模型偶尔混入天城文、韩文等乱码）
  s = s.replace(/[^\u0000-\u024f\u2000-\u206f\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/gu, '');
  s = s.replace(/[A-Za-z][A-Za-z']{2,}/g, (w) => (KEEP_LATIN.test(w) ? w : ''));
  s = s.replace(/[（(][^）)]*[)）]/g, '').replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1').replace(/\s+/g, ' ').replace(/\s*([，。！？；、：])\s*/g, '$1');
  return s.replace(/^[，。、\s]+/, '').trim();
}

// 看起来像在输出思考过程（部分服务端不拆分推理内容）
const REASONING_LIKE = /^\s*(\d+\.\s*\*\*|\*\*|#|好的[，,]?用户|用户(问|询问|想)|嗯[，,]|首先|让我|我需要|分析|思考)/;

const FIRST_MIN = 6;
function firstComma(s, min) {
  const re = /[，,：:]/g; let m;
  while ((m = re.exec(s))) if (cleanSpeech(s.slice(0, m.index)).replace(/[，。！？；、：:,\s]/g, '').length >= min) return m.index;
  return -1;
}

/** 把流式文本切成适合朗读的整句：遇到 。！？；或换行即送出；首句在第一个够长的逗号处提前送出 */
export class SentenceSplitter {
  constructor(onSentence) { this.buf = ''; this.n = 0; this.onSentence = onSentence; }
  push(t) {
    this.buf += t;
    for (;;) {
      const m = /[。！？；!?\n]/.exec(this.buf);
      let cut = m ? m.index + 1 : -1;
      // 首句：第一个逗号前已有 8 个字就先送出去合成，尽快开口（约 1 秒），后面的句子边播边合成
      if (cut < 0 && this.n === 0) { const c = firstComma(this.buf, FIRST_MIN); if (c >= 0) cut = c + 1; }
      if (cut < 0) return;
      this.emit(this.buf.slice(0, cut)); this.buf = this.buf.slice(cut);
    }
  }
  emit(raw) { const s = cleanSpeech(raw); if (s && /[\u4e00-\u9fff0-9]/.test(s)) { this.n++; this.onSentence(s); } }
  end() { if (this.buf.trim()) this.emit(this.buf); this.buf = ''; }
}

/**
 * 流式调用大模型。每出一整句就回调 onSentence(sentence)，方便立刻送去合成播报。
 * 成功返回 { speech, firstMs, totalMs }；超时、出错、输出像思考过程时返回 null（由调用方回落知识库）。
 * 已经送出过句子后才出错，返回已说部分（partial:true），避免话说一半又改口。
 */
export async function streamLlm(question, contextEntries, history, cfg = llmConfig(), onSentence = () => {}) {
  if (!cfg.enabled) return null;
  const t0 = Date.now();
  const ctrl = new AbortController();
  let firstAt = 0;
  const firstTimer = setTimeout(() => { if (!firstAt) ctrl.abort(new Error('first token timeout')); }, cfg.firstMs);
  const totalTimer = setTimeout(() => ctrl.abort(new Error('timeout')), cfg.timeoutMs);
  const said = [];
  const splitter = new SentenceSplitter((s) => { if (said.join('').length < 160) { said.push(s); onSentence(s); } });
  let content = '';
  try {
    const session = cfg.sessionId || 'dh-showroom';
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json', accept: 'text/event-stream',
        'x-session-id': session,
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, temperature: 0.3, max_tokens: 400, stream: true, ...cfg.extra, messages: buildMessages(question, contextEntries, history) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) {
      // 服务端不支持流式：按整段处理
      const data = await res.json();
      const p = parseLlmOutput(data?.choices?.[0]?.message?.content);
      if (!p) throw new Error('empty');
      firstAt = Date.now();
      splitter.push(p.speech); splitter.end();
    } else {
      const dec = new TextDecoder();
      let pending = '';
      let checked = false;
      for await (const chunk of res.body) {
        pending += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let delta;
          try { delta = JSON.parse(payload)?.choices?.[0]?.delta; } catch { continue; }
          const piece = delta && typeof delta.content === 'string' ? delta.content : '';
          if (!piece) continue; // reasoning_content（思考过程）不朗读
          content += piece;
          if (!checked) {
            if (content.trim().length < 6) continue;
            checked = true;
            if (REASONING_LIKE.test(content)) throw new Error('reasoning leaked into content');
            firstAt = Date.now();
            splitter.push(content);
          } else splitter.push(piece);
        }
      }
      if (!checked && content.trim()) { firstAt = Date.now(); splitter.push(content); }
      splitter.end();
    }
    if (!said.length) throw new Error('empty answer');
    return { speech: said.join(''), firstMs: firstAt - t0, totalMs: Date.now() - t0 };
  } catch (err) {
    const why = (ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.message) || err.message;
    console.warn(`[llm] ${said.length ? '中途' : ''}失败（${why}，${Date.now() - t0}ms）${said.length ? '，保留已播报部分' : '，回落知识库'}`);
    if (said.length) return { speech: said.join(''), firstMs: firstAt - t0, totalMs: Date.now() - t0, partial: true };
    return null;
  } finally {
    clearTimeout(firstTimer); clearTimeout(totalTimer);
  }
}

/** 非流式接口（兼容旧调用）：内部走流式，返回整段 */
export async function askLlm(question, contextEntries, history, cfg = llmConfig()) {
  const r = await streamLlm(question, contextEntries, history, cfg);
  return r ? { speech: r.speech, card: null } : null;
}

export { KB };
