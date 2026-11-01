// 可插拔的 OpenAI 兼容大模型接口。未配置时不启用，系统完全使用本地知识库作答。
// 只配 LLM_BASE_URL / LLM_MODEL 时与原来完全一致；配了 LLM_MODELS 则按列表轮询，失败再换下一个。
import { describeNow, calendarHint } from './clock.mjs';
// 配置来自环境变量或项目根目录的 .env（不入 git）：
//   LLM_BASE_URL        例如 https://api.example.com/v1（含 /v1 前缀）
//   LLM_API_KEY         访问密钥
//   LLM_MODEL           模型名称
//   LLM_MODELS          可选，JSON 数组。每项 baseUrl、model、apiKeyEnv（环境变量名，不写密钥本身）、可选 extra
//   LLM_FIRST_MS        等第一个字的上限（默认 12000），超时换下一个目标，全部失败再回落知识库
//   LLM_TIMEOUT_MS      单次整句上限（默认 20000）
//   LLM_EXTRA_BODY      追加到请求体的 JSON（单一接口默认 {"reasoning_effort":"low"}；列表里没写 extra 的项在本变量有值时沿用）
//   LLM_MODE            kb-first（默认：知识库有把握的问题直接用知识库口径，其余交给大模型）| always
import { KB, ASSISTANT_NAME } from './kb.mjs';

const DEFAULT_EXTRA = { reasoning_effort: 'low' };
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
// 轮询游标与冷却挂在进程内，按目标列表区分；同一配置多次 llmConfig() 共用一份
const rotations = new Map();

function hostOf(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return ''; }
}

function targetLabel(t) {
  const host = hostOf(t.baseUrl);
  return host ? `${t.model} @ ${host}` : String(t.model || 'llm');
}

function targetId(t) { return `${t.model}\n${t.baseUrl}`; }

/** IFM/K2 多轮要求 assistant 带 reasoning_content；其它模型不要带这个字段 */
function needsReasoningContent(t) {
  const model = String(t?.model || '');
  const base = String(t?.baseUrl || '');
  return /IFM\/K2|K2-Horizon/i.test(model) || /api\.ifm\.ai/i.test(base);
}

function sharedRotation(key) {
  let s = rotations.get(key);
  if (!s) { s = { cursor: 0, cooldown: new Map() }; rotations.set(key, s); }
  return s;
}

export function _resetRotationForTest() { rotations.clear(); }

function readExtra(env) {
  let extra = DEFAULT_EXTRA;
  let explicit = false;
  if (env.LLM_EXTRA_BODY) {
    try { extra = JSON.parse(env.LLM_EXTRA_BODY); explicit = true; }
    catch { console.warn('[llm] LLM_EXTRA_BODY 不是合法 JSON，已忽略'); }
  }
  return { extra, explicit };
}

function itemExtra(item, globalExtra, explicit) {
  if (item.extra && typeof item.extra === 'object' && !Array.isArray(item.extra)) return item.extra;
  return explicit ? globalExtra : {};
}

/** @returns {object[]|null} null 表示 JSON 无效（调用方改走单一接口） */
function parseModelList(raw, env, globalExtra, explicit) {
  let arr;
  try { arr = JSON.parse(String(raw).trim()); }
  catch { console.warn('[llm] LLM_MODELS 不是合法 JSON，已忽略'); return null; }
  if (!Array.isArray(arr)) { console.warn('[llm] LLM_MODELS 应为 JSON 数组，已忽略'); return null; }
  const targets = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const baseUrl = String(item.baseUrl || item.base_url || '').replace(/\/+$/, '');
    const model = String(item.model || '');
    if (!baseUrl || !model) { console.warn('[llm] 跳过缺少 baseUrl 或 model 的目标'); continue; }
    if (item.apiKey || item.api_key) {
      console.warn(`[llm] 跳过 ${model}：请用 apiKeyEnv 引用环境变量，不要把密钥写进 LLM_MODELS`);
      continue;
    }
    let apiKey = '';
    const keyEnv = item.apiKeyEnv || item.api_key_env;
    if (keyEnv != null && keyEnv !== '') {
      const name = String(keyEnv);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        console.warn(`[llm] 跳过 ${model}：apiKeyEnv 必须是环境变量名`);
        continue;
      }
      apiKey = env[name] || '';
      if (!apiKey) { console.warn(`[llm] 跳过 ${model}：未设置环境变量 ${name}`); continue; }
    }
    const reasoningContent = typeof item.reasoningContent === 'boolean' ? item.reasoningContent : needsReasoningContent({ baseUrl, model });
    targets.push({ baseUrl, apiKey, model, extra: itemExtra(item, globalExtra, explicit), reasoningContent });
  }
  return targets;
}

function legacyTarget(env, extra) {
  const baseUrl = (env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const model = env.LLM_MODEL || '';
  if (!baseUrl || !model) return null;
  // 单一接口保持原行为：历史消息始终带 reasoning_content（IFM/K2 需要，其它模型原来也这样发）
  return { baseUrl, apiKey: env.LLM_API_KEY || '', model, extra, reasoningContent: true };
}

function rotationKey(targets) {
  return targets.map((t) => `${t.model}\n${t.baseUrl}\n${t.reasoningContent ? 1 : 0}`).join('\n---\n');
}

export function llmConfig(env = process.env) {
  const { extra, explicit } = readExtra(env);
  const firstMs = Number(env.LLM_FIRST_MS || 12000);
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 20000);
  const mode = env.LLM_MODE === 'always' ? 'always' : 'kb-first';
  const legacy = legacyTarget(env, extra);
  let targets = null;
  if (env.LLM_MODELS != null && String(env.LLM_MODELS).trim()) {
    const listed = parseModelList(env.LLM_MODELS, env, extra, explicit);
    if (listed && listed.length) targets = listed;
    else if (listed) console.warn('[llm] LLM_MODELS 没有可用目标，改用 LLM_BASE_URL / LLM_MODEL');
  }
  if (!targets) targets = legacy ? [legacy] : [];
  const primary = targets[0];
  const baseUrl = primary ? primary.baseUrl : (env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const model = !primary ? (env.LLM_MODEL || '') : (targets.length === 1 ? primary.model : targets.map((t) => t.model).join(', '));
  return {
    enabled: targets.length > 0,
    baseUrl,
    apiKey: primary ? primary.apiKey : (env.LLM_API_KEY || ''),
    model,
    firstMs,
    timeoutMs,
    extra: primary ? primary.extra : extra,
    mode,
    targets,
    rotation: sharedRotation(rotationKey(targets)),
  };
}

function normalizeTarget(t, { legacy }) {
  const baseUrl = String(t.baseUrl || '').replace(/\/+$/, '');
  const model = String(t.model || '');
  const reasoningContent = typeof t.reasoningContent === 'boolean' ? t.reasoningContent : (legacy ? true : needsReasoningContent({ baseUrl, model }));
  const extra = t.extra && typeof t.extra === 'object' && !Array.isArray(t.extra) ? t.extra : {};
  return { baseUrl, apiKey: String(t.apiKey || ''), model, extra, reasoningContent };
}

function resolveTargets(cfg) {
  if (Array.isArray(cfg.targets) && cfg.targets.length) {
    return cfg.targets.map((t) => normalizeTarget(t, { legacy: false })).filter((t) => t.baseUrl && t.model);
  }
  if (cfg.baseUrl && cfg.model) return [normalizeTarget(cfg, { legacy: true })];
  return [];
}

function healthyCandidates(targets, state) {
  const n = targets.length;
  const start = ((state.cursor % n) + n) % n;
  const now = Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const t = targets[idx];
    const until = state.cooldown.get(targetId(t)) || 0;
    if (until > now) continue;
    if (until) state.cooldown.delete(targetId(t));
    out.push({ t, idx });
  }
  return out;
}

function retryAfterToMs(header) {
  if (header == null || header === '') return undefined;
  const sec = Number(header);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function cooldownMs(retryAfterMs) {
  if (Number.isFinite(retryAfterMs)) return Math.min(Math.max(0, retryAfterMs), MAX_COOLDOWN_MS);
  return DEFAULT_COOLDOWN_MS;
}

function redact(text, secrets) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) s = s.split(secret).join('***');
  }
  return s;
}

function errorWhy(err, signal) {
  const aborted = signal?.aborted && signal.reason && signal.reason.message;
  if (aborted) return aborted;
  return err?.message || String(err);
}

function isRetryable(err, why) {
  if (why === 'reasoning leaked into content' || why === 'empty answer') return false;
  if (err?.status === 429 || (typeof err?.status === 'number' && err.status >= 500 && err.status <= 599)) return true;
  if (why === 'first token timeout' || why === 'timeout') return true;
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) return false;
  if (typeof err?.status === 'number') return false;
  return true;
}

export function buildMessages(question, contextEntries, history = [], now = new Date(), { tools = false, reasoningContent = true } = {}) {
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
    ...(tools ? ['9. 你可以调用工具：问天气先调 get_weather；问本网点营业时间、地址、电话、能办什么业务先调 branch_info；征信问题参考资料不够时调 search_knowledge。天气、营业时间、地址、电话这类实时或本网点信息，只能依据工具结果回答，没有工具结果就先调用工具，绝不凭印象说；工具没给出的信息说“以网点公示为准”。天气默认指网点所在城市，天气按工具结果里该天的 summary 原样说（如“阴天”不要说成“多云”），可以再加一句贴心提醒。不要说“我查一下”之类的话，直接说结果。新闻、近期事件、知识库以外的常识可以调用 web_search（若有）；征信问题以参考资料和知识库为准，不联网搜索；荐股理财、政治、医疗、征信修复等不宜话题不搜索，直接婉拒。用网上结果时以“据网上公开信息”开头，只说要点，不读网址，不确定的说以官方发布为准。不需要工具的问题直接回答。回答里不要提到工具、规则或参考资料本身。'] : []),
    ctx ? `参考资料：\n${ctx}` : '参考资料：无。征信类问题只给一般性引导，并建议咨询大堂经理。',
  ].join('\n');
  // IFM/K2 等多轮接口要求每条 assistant 都带 reasoning_content（可为空字符串），否则 HTTP 400。其它模型不带这个字段。
  const turns = history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content).slice(-6)
    .map((m) => {
      if (m.role !== 'assistant') return { role: 'user', content: String(m.content) };
      const msg = { role: 'assistant', content: String(m.content) };
      if (reasoningContent) msg.reasoning_content = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
      return msg;
    });
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

// 大模型偶尔把“按规则2…”“这不是征信问题”之类的自我说明说出来：整句丢弃
export const META_TALK = /(按(照)?规则|根据规则|规则\s*[0-9一二三四五六七八]|这不是征信(相关)?(的)?问题|属于(日常|闲聊|不宜|寒暄)|用户(问|想|询问|在问|说)|我(应该|需要|要)(回答|调用|简短|按)|系统提示|调用(工具|函数)|工具(结果|返回)|参考资料(里|中)?(没有|显示)|^我(先)?(帮您|帮你|给您)?(查|看)一?下)/;

export const MAX_TOOL_ROUNDS = 2;
const ONLINE_CLAIM = /(据网上|网上公开|据网络|网上(资料|信息|消息)|据(公开)?报道|网传)/;
/** 新句与已说的某句几乎一样（模型偶尔把一句话换个说法重复一遍） */
export function nearDup(a, b) {
  const cj = (x) => x.replace(/[^\u4e00-\u9fff0-9]/g, '');
  const A = cj(a), B = cj(b);
  if (B.length < 8) return false;
  const pool = [...A];
  let hit = 0;
  for (const ch of B) { const i = pool.indexOf(ch); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return hit / B.length >= 0.9;
}

/** 发一次流式请求：正文边到边交给 onText；收集 tool_calls。抛错由调用方处理 */
async function streamOnce(target, messages, { tools, toolChoice, signal, onText, sessionId }) {
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json', accept: 'text/event-stream',
      'x-session-id': sessionId || 'dh-showroom',
      ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: target.model, temperature: 0.3, max_tokens: 400, stream: true, ...target.extra, messages,
      ...(tools ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
    }),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.retryAfterMs = retryAfterToMs(res.headers.get('retry-after'));
    res.body?.cancel?.();
    throw err;
  }
  const calls = {};
  let content = '';
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    for (const [i, tc] of (msg.tool_calls || []).entries()) calls[i] = { id: tc.id || `call_${i}`, name: tc.function?.name || '', args: tc.function?.arguments || '' };
    const p = parseLlmOutput(msg.content);
    if (p) { content = p.speech; onText(p.speech); }
  } else {
    const dec = new TextDecoder();
    let pending = '';
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
        if (!delta) continue;
        for (const tc of delta.tool_calls || []) {
          const k = tc.index ?? 0;
          calls[k] ??= { id: '', name: '', args: '' };
          if (tc.id) calls[k].id = tc.id;
          if (tc.function?.name) calls[k].name += tc.function.name;
          if (tc.function?.arguments) calls[k].args += tc.function.arguments;
        }
        const piece = typeof delta.content === 'string' ? delta.content : '';
        if (piece) { content += piece; onText(piece); } // reasoning_content（思考过程）不朗读
      }
    }
  }
  return { content, toolCalls: Object.values(calls).filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` })) };
}

/**
 * 流式调用大模型（可带工具）。每出一整句就回调 onSentence(sentence)，方便立刻送去合成播报。
 * 配置了多个目标时，按健康目标轮询；遇到 HTTP 429/5xx、连接失败或首字超时，先冷却该目标再换下一个，全部失败才回落知识库。
 * opts.tools / opts.runTool：模型决定是否调用工具，最多 MAX_TOOL_ROUNDS 轮，拿到结果后再作答。
 * 成功返回 { speech, firstMs, totalMs, tools:[...] }；超时、出错、输出像思考过程时返回 null（由调用方回落知识库）。
 * 已经送出过句子后才出错，返回已说部分（partial:true），避免话说一半又改口。
 * 工具已执行但后续大模型失败时，用工具自带的简短口径作答。
 */
export async function streamLlm(question, contextEntries, history, cfg = llmConfig(), onSentence = () => {}, opts = {}) {
  if (!cfg.enabled) return null;
  const t0 = Date.now();
  // 预取的联网搜索失败（超时、超额度）：不让模型凭印象回答，直接说没查到
  const preFiller = opts.preFiller || '';
  const failedSearch = (opts.prefetched || []).find((p) => p.name === 'web_search' && !p.out.ok);
  if (failedSearch && preFiller) {
    const sorry = failedSearch.out.say || '这个我暂时没查到可靠信息，建议以官方渠道发布为准。';
    onSentence(sorry);
    return { speech: preFiller + sorry, firstMs: 0, totalMs: Date.now() - t0, tools: [{ name: 'web_search', ok: false, prefetched: true }] };
  }
  const targets = resolveTargets(cfg);
  if (!targets.length) return null;
  const rotating = targets.length > 1;
  const state = rotating ? (cfg.rotation ||= { cursor: 0, cooldown: new Map() }) : null;
  const candidates = state ? healthyCandidates(targets, state) : targets.map((t, idx) => ({ t, idx }));
  if (!candidates.length) { console.warn('[llm] 全部模型冷却中，回落知识库'); return null; }
  const secrets = targets.map((t) => t.apiKey);

  const park = (t, retryAfterMs) => {
    const ms = cooldownMs(retryAfterMs);
    if (state && ms > 0) state.cooldown.set(targetId(t), Date.now() + ms);
    return ms;
  };

  for (let i = 0; i < candidates.length; i++) {
    const { t, idx } = candidates[i];
    const out = await attemptTarget(t, { canSwitch: Boolean(state && i < candidates.length - 1) });
    if (out.switch) {
      const ms = park(t, out.retryAfterMs);
      console.warn(`[llm] ${targetLabel(t)} 失败（${redact(out.why, secrets)}），冷却 ${Math.round(ms / 1000)}s，切换下一个`);
      continue;
    }
    if (out.cool) {
      const ms = park(t, out.cool.retryAfterMs);
      console.warn(`[llm] ${targetLabel(t)} 后续请求失败（${redact(out.cool.why, secrets)}），冷却 ${Math.round(ms / 1000)}s`);
    } else if (out.failedTarget) park(t, out.retryAfterMs);
    if (out.result && state) state.cursor = (idx + 1) % targets.length;
    if (out.ok) console.log(`[llm] 应答 ${targetLabel(t)}（首字 ${out.result.firstMs}ms）`);
    return out.result;
  }
  return null;

  async function attemptTarget(target, { canSwitch }) {
    const ctrl = new AbortController();
    let firstAt = 0;
    const firstTimer = setTimeout(() => { if (!firstAt) ctrl.abort(new Error('first token timeout')); }, cfg.firstMs);
    const totalTimer = setTimeout(() => ctrl.abort(new Error('timeout')), cfg.timeoutMs);
    const said = [];
    const splitter = new SentenceSplitter((s) => {
      if (META_TALK.test(s) || /[<>]/.test(s)) { console.warn('[llm] 丢弃自我说明/标记句'); return; }
      // 没真正联网却说“据网上公开信息”：是编的，丢弃
      if (ONLINE_CLAIM.test(s) && !used.some((u) => u.name === 'web_search' && u.ok)) { console.warn('[llm] 丢弃无来源的“网上信息”句'); return; }
      if (said.length && nearDup(said.join(''), s)) { console.warn('[llm] 丢弃重复句'); return; }
      if (said.join('').length < 160) { if (!firstAt) firstAt = Date.now(); said.push(s); onSentence(s); }
    });
    const tools = opts.tools && opts.tools.length && opts.runTool ? opts.tools : null;
    const messages = buildMessages(question, contextEntries, history, opts.now || new Date(), { tools: Boolean(tools), reasoningContent: target.reasoningContent !== false });
    const used = [];
    let toolSay = '';
    let filler = preFiller; // 慢工具前说的垫话（不计入 said，避免影响失败回落判断）
    let rateHit = null;
    const sayFiller = (text) => { if (filler || said.length || !text) return; filler = text; if (!firstAt) firstAt = Date.now(); onSentence(text); };
    // 预取的工具结果：按一次已完成的工具调用写进对话，模型第一轮就能直接作答
    for (const [i, pf] of (opts.prefetched || []).entries()) {
      const id = `pre_${i}`;
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: pf.name, arguments: JSON.stringify(pf.args || {}) } }] });
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(pf.out.ok ? pf.out.data : { error: pf.out.data?.error || '查询失败' }) });
      used.push({ name: pf.name, args: pf.args, ok: pf.out.ok, ms: pf.out.ms, prefetched: true });
      if (pf.out.say && !toolSay) toolSay = pf.out.say;
    }
    let content = '';
    let checked = false;
    const onText = (piece) => {
      content += piece;
      if (!checked) {
        if (content.trim().length < 6) return;
        checked = true;
        if (REASONING_LIKE.test(content)) throw new Error('reasoning leaked into content');
        splitter.push(content);
      } else splitter.push(piece);
    };
    const finish = (result, extra = {}) => ({ result, ...extra });
    try {
      for (let round = 0; ; round++) {
        const allowTools = tools && round < MAX_TOOL_ROUNDS;
        let r;
        try {
          r = await streamOnce(target, messages, { tools: tools || undefined, toolChoice: tools && !allowTools ? 'none' : undefined, signal: ctrl.signal, onText, sessionId: cfg.sessionId });
        } catch (err) {
          if (round > 0 && !said.length && toolSay) { rateHit = err; splitter.push(toolSay); break; }
          throw err;
        }
        if (!r.toolCalls.length || !allowTools) break;
        // 模型要用工具：执行后把结果交回模型再答
        for (const c of r.toolCalls) if (opts.fillers?.[c.name]) sayFiller(opts.fillers[c.name]);
        messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
        const results = await Promise.all(r.toolCalls.slice(0, 3).map(async (c) => {
          let args = {};
          try { args = c.args ? JSON.parse(c.args) : {}; } catch { /* 参数坏了按空参数 */ }
          const out = await opts.runTool(c.name, args);
          used.push({ name: c.name, args, ok: out.ok, ms: out.ms });
          if (out.say && !toolSay) toolSay = out.say;
          return { c, out };
        }));
        for (const { c, out } of results) messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out.ok ? out.data : { error: out.data?.error || '查询失败' }) });
        content = ''; checked = false;
      }
      if (!checked && content.trim()) splitter.push(content);
      splitter.end();
      if (!said.length && toolSay) { splitter.push(toolSay); splitter.end(); }
      if (!said.length) throw new Error('empty answer');
      let cool = null;
      if (rotating && rateHit) {
        const why = errorWhy(rateHit, ctrl.signal);
        if (isRetryable(rateHit, why)) cool = { why, retryAfterMs: rateHit.retryAfterMs };
      }
      return finish({ speech: filler + said.join(''), firstMs: firstAt - t0, totalMs: Date.now() - t0, tools: used.length ? used : undefined }, { ok: true, cool });
    } catch (err) {
      const why = errorWhy(err, ctrl.signal);
      const retryable = isRetryable(err, why);
      const committed = used.some((u) => !u.prefetched);
      // 还没开口、也还没执行工具：换成下一个目标，不把这句失败说给客户
      if (canSwitch && retryable && !said.length && !committed) return { switch: true, why, retryAfterMs: err.retryAfterMs };
      const shown = rotating ? redact(why, secrets) : why;
      console.warn(`[llm] ${rotating ? targetLabel(target) + ' ' : ''}${said.length ? '中途' : ''}失败（${shown}，${Date.now() - t0}ms）${said.length ? '，保留已播报部分' : '，回落知识库'}`);
      if (filler && !said.length) {
        const sorry = toolSay || '这个我暂时没查到可靠信息，建议以官方渠道发布为准。';
        onSentence(sorry);
        return finish({ speech: filler + sorry, firstMs: firstAt - t0, totalMs: Date.now() - t0, partial: true, tools: used.length ? used : undefined }, { retryable, why, retryAfterMs: err.retryAfterMs, failedTarget: retryable });
      }
      if (said.length) return finish({ speech: filler + said.join(''), firstMs: firstAt - t0, totalMs: Date.now() - t0, partial: true, tools: used.length ? used : undefined }, { retryable, why, retryAfterMs: err.retryAfterMs });
      return finish(null, { retryable, why, retryAfterMs: err.retryAfterMs, failedTarget: retryable });
    } finally {
      clearTimeout(firstTimer); clearTimeout(totalTimer);
    }
  }
}

/** 非流式接口（兼容旧调用）：内部走流式，返回整段 */
export async function askLlm(question, contextEntries, history, cfg = llmConfig(), opts = {}) {
  const r = await streamLlm(question, contextEntries, history, cfg, () => {}, opts);
  return r ? { speech: r.speech, card: null } : null;
}

export { KB };
