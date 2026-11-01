import { route, rank, smalltalk, CONFIDENT } from './router.mjs';
import { dateTimeAnswer } from './clock.mjs';
import { askLlm, streamLlm, llmConfig } from './llm.mjs';
import { toolDefs, runTool, prefetchTools, SLOW_TOOLS } from './tools.mjs';

/** 智能体工具：AGENT_TOOLS=0 可关闭；测试可通过 opts.tools/opts.runTool 注入 */
function agentOpts(opts) {
  if (opts.tools === false || process.env.AGENT_TOOLS === '0') return { now: opts.now };
  return { tools: opts.tools || toolDefs(), runTool: opts.runTool || runTool, now: opts.now, fillers: opts.fillers || SLOW_TOOLS };
}
import { SMALLTALK } from './kb.mjs';
import { loadOutfits, matchOutfit } from './outfits.mjs';

export const OUTFIT_REPLY = '好的，我换一套';
/** 换装口令的答复：action=outfit，outfit 为指定服装 id（没说具体哪套时为 null = 下一套） */
function outfitAnswer(base, text, outfits) {
  const list = outfits || loadOutfits().outfits;
  const hit = /换回|默认|原来/.test(text) ? null : matchOutfit(list, text, { sensitive: true });
  const def = /换回|默认|原来/.test(text) ? (loadOutfits().default) : null;
  return { ...base, speech: OUTFIT_REPLY, source: 'rule', action: 'outfit', outfit: hit ? hit.id : def };
}

const MASK_RULES = [
  [/(\d{6})\d{8}(\d{3}[\dxX])/g, '$1********$2'], // 18 位身份证
  [/(1[3-9]\d)\d{4}(\d{4})/g, '$1****$2'], // 手机号
  [/(\d{4})\d{8,11}(\d{4})/g, '$1********$2'], // 银行卡
];

/** 对答复中可能出现的个人敏感信息做兜底脱敏 */
export function maskPII(text) {
  let s = String(text || '');
  for (const [re, rep] of MASK_RULES) s = s.replace(re, rep);
  return s;
}

/**
 * 问答主入口：知识库优先（保证合规口径与离线可用），知识库不确定时再交给大模型。
 * @param {string} text
 * @param {{flow?:boolean, history?:any[], llm?:any, llmFirst?:boolean}} opts
 */
export async function answer(text, opts = {}) {
  const dt = dateTimeAnswer(text, opts.now);
  if (dt) return { query: maskPII(text), intent: 'datetime', score: 10, speech: dt, source: 'rule' };
  const r = route(text, { flow: opts.flow });
  const base = { query: maskPII(text), intent: r.intent, score: r.score };

  if (r.intent.startsWith('nav_')) return { ...base, speech: '', source: 'rule' };
  if (r.intent === 'empty') return { ...base, speech: '', source: 'rule' };
  if (r.intent === 'outfit') return outfitAnswer(base, text, opts.outfits);
  if (SMALLTALK[r.intent] && r.intent !== 'fallback') {
    return { ...base, speech: smalltalk(r.intent).speech, source: 'rule', action: r.intent === 'human' ? 'call_staff' : undefined };
  }

  const cfg = opts.llm || llmConfig();
  const kbConfident = r.entry && r.score >= CONFIDENT;
  if (cfg.enabled && (!kbConfident || opts.llmFirst || cfg.mode === 'always')) {
    const ctx = rank(text).slice(0, 3).map((x) => x.entry);
    const ao = agentOpts(opts);
    if (ao.runTool) ao.prefetched = await prefetchTools(text, opts.history || [], ao.runTool).catch(() => []);
    const out = await askLlm(text, ctx, opts.history || [], cfg, ao);
    if (out) {
      return {
        ...base,
        speech: maskPII(out.speech),
        card: out.card || (kbConfident ? r.entry.card : undefined),
        follow: kbConfident ? r.entry.follow : undefined,
        source: 'llm',
      };
    }
  }

  if (r.entry) {
    return { ...base, speech: r.entry.speech, card: r.entry.card, follow: r.entry.follow, action: r.entry.action, source: 'kb' };
  }
  return { ...base, intent: 'fallback', speech: SMALLTALK.fallback.speech, source: 'rule' };
}

/**
 * 流式问答：规则/知识库命中时一次性返回整段口播；交给大模型时每出一句就 emit({type:'sentence'})，
 * 页面拿到首句即开始合成播报。最后 emit({type:'done'}) 带完整结果。大模型失败自动回落知识库。
 * @param {(ev:object)=>void} emit
 */
export async function answerStream(text, opts = {}, emit = () => {}) {
  const finish = (out) => { emit({ type: 'done', ...out }); return out; };
  const dt = dateTimeAnswer(text, opts.now);
  if (dt) return finish({ query: maskPII(text), intent: 'datetime', score: 10, speech: dt, source: 'rule' });
  const r = route(text, { flow: opts.flow });
  const base = { query: maskPII(text), intent: r.intent, score: r.score };

  if (r.intent.startsWith('nav_') || r.intent === 'empty') return finish({ ...base, speech: '', source: 'rule' });
  if (r.intent === 'outfit') return finish(outfitAnswer(base, text, opts.outfits));
  if (SMALLTALK[r.intent] && r.intent !== 'fallback') {
    return finish({ ...base, speech: smalltalk(r.intent).speech, source: 'rule', action: r.intent === 'human' ? 'call_staff' : undefined });
  }
  const cfg = opts.llm || llmConfig();
  const kbConfident = r.entry && r.score >= CONFIDENT;
  // 自助查询引导是固定流程，始终走知识库
  const useLlm = cfg.enabled && r.entry?.action !== 'kiosk_flow' && (!kbConfident || opts.llmFirst || cfg.mode === 'always');
  if (useLlm) {
    emit({ type: 'meta', ...base, source: 'llm' });
    const ctx = rank(text).slice(0, 3).map((x) => x.entry);
    const ao = agentOpts(opts);
    if (ao.runTool) ao.prefetched = await prefetchTools(text, opts.history || [], ao.runTool).catch(() => []);
    const out = await streamLlm(text, ctx, opts.history || [], cfg, (s) => emit({ type: 'sentence', text: maskPII(s) }), ao);
    if (out) {
      return finish({
        ...base, speech: maskPII(out.speech), streamed: true, source: 'llm',
        card: kbConfident ? r.entry.card : undefined, follow: kbConfident ? r.entry.follow : undefined,
        timing: { firstMs: out.firstMs, totalMs: out.totalMs }, partial: out.partial || undefined, tools: out.tools,
      });
    }
  }
  if (r.entry) return finish({ ...base, speech: r.entry.speech, card: r.entry.card, follow: r.entry.follow, action: r.entry.action, source: 'kb' });
  return finish({ ...base, intent: 'fallback', speech: SMALLTALK.fallback.speech, source: 'rule' });
}
