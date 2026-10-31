import { KB, SMALLTALK } from './kb.mjs';

// 离线语音识别常见同音误识别纠正
const ASR_FIXES = [
  [/正信|证信|争信|征性|正心/g, '征信'],
  [/信用报高|信用保告/g, '信用报告'],
  [/一义|疑义|移议/g, '异议'],
  [/自助查询器|自助查询鸡/g, '自助查询机'],
  [/中登王|中灯网/g, '中登网'],
];

export function normalize(text) {
  let s = String(text || '').toLowerCase().trim();
  s = s.replace(/[\s，。！？、,.!?;；:："“”'‘’（）()【】\[\]…~·-]+/g, '');
  for (const [re, rep] of ASR_FIXES) s = s.replace(re, rep);
  return s;
}

const NAV = [
  ['nav_next', /^(下一步|下一个|继续|好的继续|然后呢|接下来|好了|完成了|放好了)/],
  ['nav_prev', /^(上一步|返回上一步|退回|再说一遍|没听清|重复一下)/],
  ['nav_exit', /^(退出|结束|不用了|返回首页|取消|关闭)/],
];

// 换装口令：本地识别，不交给大模型
export const OUTFIT_RE = /换(一|个|下|件)?(套|身|件|衣服|服装|装扮|装|造型|穿搭|风格)|(换|穿)(成|上)|换回|下一套|再换/;
export function isOutfitCommand(s) { return OUTFIT_RE.test(normalize(s)); }

const SMALL = [
  ['human', /(人工|大堂经理|工作人员|找人|客户经理|真人)/],
  ['bye', /(再见|拜拜|走了|没有了|没事了)$/],
  ['thanks', /^(谢谢|感谢|多谢|好的谢谢|谢了)/],
  ['who', /(你是谁|你叫什么|你是什么|介绍一下你|你能做什么|你会什么)/],
  ['greet', /^(你好|您好|嗨|哈喽|hello|hi|小信|早上好|下午好|在吗)+(小信|啊|呀)?$/],
];

/** 返回按得分排序的知识条目 */
export function rank(text) {
  const s = normalize(text);
  const scored = KB.map((e) => {
    let score = 0;
    const hits = [];
    for (const [kw, w] of e.keywords) {
      if (s.includes(kw.toLowerCase())) { score += w; hits.push(kw); }
    }
    return { entry: e, score, hits };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export const CONFIDENT = 5;

/**
 * 意图路由。flow 表示当前处于自助查询引导流程中，此时优先识别“下一步/上一步/退出”。
 * @returns {{intent:string, score:number, entry?:any, hits?:string[]}}
 */
export function route(text, { flow = false } = {}) {
  const s = normalize(text);
  if (!s) return { intent: 'empty', score: 0 };
  if (flow) {
    for (const [intent, re] of NAV) if (re.test(s)) return { intent, score: 10 };
  }
  if (OUTFIT_RE.test(s) && !/(征信|信用|报告|异议|卡)/.test(s)) return { intent: 'outfit', score: 10 };
  for (const [intent, re] of SMALL) if (re.test(s)) return { intent, score: 10 };
  const ranked = rank(s);
  const top = ranked[0];
  if (top && top.score >= CONFIDENT) {
    return { intent: top.entry.id, score: top.score, entry: top.entry, hits: top.hits };
  }
  // 只命中泛化词（如“查询”）时，按查询渠道兜底
  if (top && top.score >= 2 && /征信|信用/.test(s)) {
    return { intent: top.entry.id, score: top.score, entry: top.entry, hits: top.hits };
  }
  if (/征信|信用报告/.test(s)) {
    const e = KB.find((x) => x.id === 'query_channels');
    return { intent: e.id, score: 2, entry: e, hits: ['征信'] };
  }
  return { intent: 'fallback', score: top ? top.score : 0 };
}

export function smalltalk(intent) {
  return SMALLTALK[intent] || SMALLTALK.fallback;
}
