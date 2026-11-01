// 联网搜索（Tavily）。密钥只在服务端环境变量 TAVILY_API_KEY，不进镜像、不发前端、不写日志。
// 有缓存（默认 10 分钟）和每日调用上限（默认 30 次，保护每月免费额度）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shanghaiParts } from './clock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE_FILE = path.join(ROOT, 'data', 'websearch-usage.json');

export function searchConfig(env = process.env) {
  return {
    key: env.TAVILY_API_KEY || '',
    enabled: Boolean(env.TAVILY_API_KEY) && env.WEB_SEARCH !== '0',
    dailyLimit: Number(env.WEB_SEARCH_DAILY_LIMIT || 30),
    timeoutMs: Number(env.WEB_SEARCH_TIMEOUT_MS || 3500),
    cacheMs: Number(env.WEB_SEARCH_CACHE_MS || 600000),
    maxResults: Math.min(5, Math.max(1, Number(env.WEB_SEARCH_MAX_RESULTS || 4))),
  };
}

// 不搜索的话题：征信（以知识库为准）、荐股理财、政治、医疗、征信修复、个人隐私
export const NO_SEARCH = /(征信|信用报告|信用记录|不良记录|逾期|股票|荐股|买什么股|哪只股|基金推荐|理财推荐|炒股|涨停|期货|比特币|虚拟币|政治|领导人|主席|总理|选举|台独|藏独|疆独|示威|游行|疾病|诊断|吃什么药|治疗|医院哪个好|修复征信|征信修复|洗白|删除记录|铲单|身份证号|手机号|银行卡号|住址)/;

const cache = new Map();
let usage = null;
const today = () => { const p = shanghaiParts(); return `${p.year}-${p.month}-${p.day}`; };
function loadUsage(file) {
  if (usage && usage.day === today()) return usage;
  try { const u = JSON.parse(fs.readFileSync(file, 'utf8')); if (u.day === today()) return (usage = u); } catch { /* 新的一天或没有记录 */ }
  return (usage = { day: today(), count: 0 });
}
function saveUsage(file) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(usage)); } catch { /* 只读也不影响 */ } }

export function usageToday(file = USAGE_FILE) { return { ...loadUsage(file) }; }
export function _resetForTest() { cache.clear(); usage = null; }

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const SORRY = '这个我暂时没查到可靠信息，建议以官方渠道发布为准。';

/** 工具实现：返回 { ok, data, say }；data 只含简短摘要，不含网址 */
export async function webSearch({ query } = {}, { cfg = searchConfig(), fetcher = fetch, usageFile = USAGE_FILE } = {}) {
  const q = clip(query, 80);
  if (!q) return { ok: false, data: { error: '没有搜索词' }, say: '' };
  if (!cfg.enabled) return { ok: false, data: { error: '联网搜索未开启' }, say: SORRY };
  if (NO_SEARCH.test(q)) return { ok: false, data: { error: '该话题不联网搜索，征信问题以本行口径为准，不宜话题请礼貌拒绝' }, say: '' };
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cfg.cacheMs) return { ...hit.out, cached: true };
  const u = loadUsage(usageFile);
  if (u.count >= cfg.dailyLimit) return { ok: false, data: { error: '今日联网搜索次数已用完' }, say: SORRY };
  u.count++; saveUsage(usageFile);
  const res = await fetcher('https://api.tavily.com/search', {
    method: 'POST',
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ query: q, search_depth: 'basic', max_results: cfg.maxResults, include_answer: 'basic', topic: 'general' }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const j = await res.json();
  const results = (j.results || []).slice(0, cfg.maxResults).map((r) => ({ title: clip(r.title, 40), snippet: clip(r.content, 160) }));
  const out = {
    ok: true,
    data: { query: q, answer: j.answer ? clip(j.answer, 300) : null, results, note: '网上公开信息，可能不完整；用中文口语转述要点，开头说“据网上公开信息”，不要读网址，不确定就说以官方发布为准' },
    say: '',
  };
  cache.set(key, { at: Date.now(), out });
  return out;
}
webSearch.timeoutMs = searchConfig().timeoutMs;
webSearch.sorry = SORRY;

export const WEB_SEARCH_DEF = { type: 'function', function: { name: 'web_search', description: '联网搜索新闻、近期事件、知识库以外的常识。征信、天气、时间、网点问题不要用；荐股、政治、医疗、征信修复等不宜话题不要用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '中文搜索词，简短' } }, required: ['query'] } } };
