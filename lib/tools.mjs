// 数字人“智能体大脑”的服务端工具：只在服务端执行，密钥和外部请求都不经过前端。
// 每个工具都有短超时；失败时返回 ok:false，由大模型或兜底口径处理。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeNow, calendarHint, shanghaiParts } from './clock.mjs';
import { rank } from './router.mjs';
import { webSearch, WEB_SEARCH_DEF, searchConfig, NO_SEARCH } from './websearch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH_FILES = [path.join(ROOT, 'data', 'branch.json'), path.join(ROOT, 'config', 'branch.example.json')];
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 3000);

export const TOOL_DEFS = [
  { type: 'function', function: { name: 'get_time', description: '获取当前北京时间、星期，以及本周和未来 7 天的日期。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_weather', description: '查询天气预报（今天、明天、后天）。没说城市时查网点所在城市。', parameters: { type: 'object', properties: { city: { type: 'string', description: '城市中文名，如 贵阳；不确定就留空' }, day: { type: 'string', enum: ['today', 'tomorrow', 'day_after'] } } } } },
  { type: 'function', function: { name: 'branch_info', description: '本网点信息：名称、地址、电话、营业时间、可办理的征信业务。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_knowledge', description: '检索本行审定的征信知识库（信用报告查询、异议、逾期影响等），返回标准口径。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

// ---------- 网点信息 ----------
let branchCache = { file: '', mtime: 0, data: null };
export function loadBranch(files = BRANCH_FILES) {
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (branchCache.file === f && branchCache.mtime === st.mtimeMs) return branchCache.data;
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      branchCache = { file: f, mtime: st.mtimeMs, data };
      return data;
    } catch { /* 下一个 */ }
  }
  return {};
}
const filled = (v) => typeof v === 'string' && v.trim() && !/^[*＊xX?？]+$/.test(v.trim());

function branchInfo() {
  const b = loadBranch();
  const h = b.hours || {};
  const data = {
    name: filled(b.name) ? b.name : null, city: filled(b.city) ? b.city : null,
    address: filled(b.address) ? b.address : null, phone: filled(b.phone) ? b.phone : null,
    hours: { weekday: filled(h.weekday) ? h.weekday : null, weekend: filled(h.weekend) ? h.weekend : null, holiday: filled(h.holiday) ? h.holiday : null },
    services: Array.isArray(b.services) ? b.services.filter(filled) : [],
    notes: filled(b.notes) ? b.notes : null,
    unknown_policy: '为 null 的项目没有配置，不要猜，回答“以网点公示为准，可以咨询大堂经理”。',
  };
  const say = data.hours.weekday
    ? `本网点营业时间：工作日${data.hours.weekday}${data.hours.weekend ? '，周末' + data.hours.weekend : ''}，具体以网点公示为准。`
    : '具体营业时间以网点公示为准，可以咨询大堂经理。';
  return { ok: true, data, say };
}

// ---------- 天气（Open-Meteo，免密钥） ----------
const WMO = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴天', 45: '有雾', 48: '有雾', 51: '小毛毛雨', 53: '毛毛雨', 55: '较强毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹' };
const geoCache = new Map();
const wxCache = new Map();
async function getJson(url, ms = TOOL_TIMEOUT_MS) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'zhengxin-dh/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function geocode(city) {
  if (geoCache.has(city)) return geoCache.get(city);
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
  const g = j?.results?.[0];
  if (!g) throw new Error('city not found');
  const out = { name: g.name, lat: g.latitude, lon: g.longitude, admin: g.admin1 || '' };
  geoCache.set(city, out);
  return out;
}
export function defaultCity(env = process.env) {
  const b = loadBranch();
  return (filled(env.WEATHER_CITY) && env.WEATHER_CITY) || (filled(b.city) && b.city) || '';
}
async function weather({ city, day } = {}, fetcher = null) {
  const c = (filled(city) ? city : defaultCity()).replace(/(市|今天|明天|后天)$/g, '');
  if (!c) return { ok: false, data: { error: '没有配置网点所在城市' }, say: '您想查哪个城市的天气呢？' };
  const idx = day === 'tomorrow' ? 1 : day === 'day_after' ? 2 : 0;
  const key = `${c}|${Math.floor(Date.now() / 600000)}`;
  let wx = wxCache.get(key);
  if (!wx) {
    const g = fetcher ? { name: c } : await geocode(c);
    const j = fetcher ? await fetcher(c) : await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,weather_code&hourly=temperature_2m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FShanghai&forecast_days=4`);
    wx = { g, j };
    wxCache.set(key, wx);
  }
  const d = wx.j.daily || {};
  const labels = ['今天', '明天', '后天'];
  const days = labels.map((label, i) => ({
    day: label, date: d.time?.[i], weather: WMO[d.weather_code?.[i]] || '未知',
    ...chinaDayTemps(wx.j, i),
    rain_probability: d.precipitation_probability_max?.[i],
  }));
  for (const x of days) x.summary = `${x.day}${x.weather}，${x.temp_min}到${x.temp_max}度${Number.isFinite(x.rain_probability) ? `，降水概率${x.rain_probability}%` : ''}`;
  const one = days[idx];
  const data = {
    city: wx.g.name, asked: labels[idx], days,
    now: wx.j.current ? { temp: Math.round(wx.j.current.temperature_2m), weather: WMO[wx.j.current.weather_code] || '' } : undefined,
    source: 'Open-Meteo 预报（按白天最高、夜间最低口径），仅供参考',
  };
  const rain = Number.isFinite(one.rain_probability) ? `，降水概率${one.rain_probability}%` : '';
  return { ok: true, data, say: `${data.city}${one.day}${one.weather}，${one.temp_min}到${one.temp_max}度${rain}。` };
}

/**
 * 按国内天气预报口径取第 i 天的气温：最高 = 当天白天 08–20 时最高，最低 = 当天 20 时到次日 08 时（当晚）最低。
 * Open-Meteo 的 daily 最高/最低是 0–24 时自然日，遇到冷空气（如凌晨 20℃、白天降到 15℃）会和中国天气网差很多；
 * 有逐时数据就按国内口径算，没有再退回 daily。
 */
export function chinaDayTemps(j, i) {
  const d = j?.daily || {}, h = j?.hourly || {};
  const day = d.time?.[i], next = d.time?.[i + 1];
  const fallback = { temp_min: Math.round(d.temperature_2m_min?.[i]), temp_max: Math.round(d.temperature_2m_max?.[i]) };
  if (!day || !Array.isArray(h.time) || !Array.isArray(h.temperature_2m)) return fallback;
  const hi = [], lo = [];
  h.time.forEach((t, k) => {
    const v = h.temperature_2m[k]; if (!Number.isFinite(v)) return;
    const date = String(t).slice(0, 10), hour = Number(String(t).slice(11, 13));
    if (date === day && hour >= 8 && hour <= 20) hi.push(v);
    if ((date === day && hour >= 20) || (next && date === next && hour <= 8)) lo.push(v);
  });
  return {
    temp_min: lo.length >= 6 ? Math.round(Math.min(...lo)) : fallback.temp_min,
    temp_max: hi.length >= 6 ? Math.round(Math.max(...hi)) : fallback.temp_max,
  };
}

/** 生产环境启动后预热默认城市天气，并每 10 分钟刷新，问天气时不用现查 */
export function warmWeather() {
  const run = () => { if (defaultCity()) weather({}).catch(() => {}); };
  run();
  const t = setInterval(run, 600000); t.unref?.();
}
if (!process.env.NODE_TEST_CONTEXT && process.env.AGENT_TOOLS !== '0') setTimeout(warmWeather, 2000).unref?.();

// ---------- 意图预取：明显要查天气/网点信息的问题，先查好再一次性交给模型，少一轮往返 ----------
const WEATHER_RE = /(天气|下雨|下雪|降雨|雨伞|带伞|气温|温度|冷不冷|热不热|刮风|晴天|阴天|多少度)/;
const BRANCH_RE = /(营业时间|几点(开门|关门|下班|上班|开|关)|上班时间|下班|开门|关门|周末.*(上班|营业|开)|(网点|你们|银行).*(地址|在哪|电话|位置|怎么走)|地址|营业)/;
// 明显需要联网的问题（新闻、近期事件、获奖、政策利率等），直接先搜
const SEARCH_RE = /(新闻|最近|最新|近期|近来|今年|去年|前年|本月|这个月|上个月|这周|本周|上周|昨天|前几天|刚刚|目前|如今|是谁|谁是|谁获|谁得|谁赢|获奖|得主|冠军|夺冠|发布会|上市了|降息|加息|降准|利率|LPR|汇率|油价|金价|房价|新政|政策|放假安排|调休)/i;
const FOLLOW_RE = /^(那|那么)?(明天|后天|今天|周末|晚上|下午|上午)?(呢|怎么样|如何)?[？?。！!]*$/;
/** 从“北京明天天气怎么样”里取城市名；取不到返回 ''（用网点所在城市） */
export function cityFromQuestion(q) {
  const m = String(q || '').match(/^(.*?)(的)?(天气|气温|温度|会不会下雨|会下雨|下雨|下雪|冷不冷|热不热|多少度)/);
  if (!m) return '';
  const left = m[1]
    .replace(/(请问|麻烦|帮我|帮忙|给我|查查|查一下|查下|看看|看一下|你知道|知道|小信|一下|你好|您好)/g, '')
    .replace(/(今天|明天|后天|现在|今晚|明早|这几天|周末|本地|这里|这边|那边|当地|外面|我们|你们|咱们|这儿|那儿|市区)/g, '')
    .replace(/[，,。？?！!\s]/g, '').replace(/市$/, '');
  return /^[\u4e00-\u9fa5]{2,6}$/.test(left) ? left : '';
}

export async function prefetchTools(text, history = [], run = runTool, { onSlow, env = process.env } = {}) {
  const q = String(text || '');
  const lastUser = [...history].reverse().find((m) => m && m.role === 'user')?.content || '';
  const plan = [];
  const weatherFollow = FOLLOW_RE.test(q.replace(/\s+/g, '')) && WEATHER_RE.test(lastUser);
  if (WEATHER_RE.test(q) || weatherFollow) {
    const city = cityFromQuestion(q) || (weatherFollow ? cityFromQuestion(lastUser) : '');
    plan.push(['get_weather', { ...(city ? { city } : {}), day: /后天/.test(q) ? 'day_after' : /明天/.test(q) ? 'tomorrow' : 'today' }]);
  }
  else if (BRANCH_RE.test(q)) plan.push(['branch_info', {}]);
  else if (searchConfig(env).enabled && SEARCH_RE.test(q) && !NO_SEARCH.test(q)) plan.push(['web_search', { query: q.replace(/^(请问|小信|你好|您好)[，,\s]*/, '').replace(/[？?！!。]+$/, '') }]);
  for (const [name] of plan) if (SLOW_TOOLS[name] && onSlow) onSlow(SLOW_TOOLS[name]);
  return Promise.all(plan.map(async ([name, args]) => ({ name, args, out: await run(name, args) })));
}

// ---------- 知识库 ----------
function searchKnowledge({ query } = {}) {
  const hits = rank(String(query || '')).slice(0, 3).map((x) => ({ title: x.entry.title, answer: x.entry.speech }));
  if (!hits.length) return { ok: true, data: { results: [], note: '知识库没有相关条目，只给一般性引导并建议咨询大堂经理' }, say: '' };
  return { ok: true, data: { results: hits, note: '这是审定口径，按此回答，不要添加数字' }, say: hits[0].answer };
}

function getTime() {
  const p = shanghaiParts();
  return { ok: true, data: { now: describeNow(), calendar: calendarHint() }, say: `现在是${describeNow().replace('北京时间', '')}。`.replace(/ /g, '，'), parts: p };
}

const IMPL = { get_time: getTime, get_weather: weather, branch_info: branchInfo, search_knowledge: searchKnowledge, web_search: (a) => webSearch(a) };
IMPL.web_search.timeoutMs = webSearch.timeoutMs;

/** 当前可用的工具定义：配置了 TAVILY_API_KEY 才提供 web_search */
export function toolDefs(env = process.env) {
  return searchConfig(env).enabled ? [...TOOL_DEFS, WEB_SEARCH_DEF] : TOOL_DEFS;
}
/** 慢工具：调用时先说一句垫话，减少等待感 */
export const SLOW_TOOLS = { web_search: '我帮您查一下网上的公开信息。' };

/** 执行一个工具调用；超时或出错返回 ok:false，不抛异常 */
export async function runTool(name, args = {}, impl = IMPL) {
  const fn = impl[name];
  if (!fn) return { ok: false, data: { error: `未知工具 ${name}` }, say: '' };
  const t0 = Date.now();
  try {
    const out = await Promise.race([
      Promise.resolve(fn(args || {})),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tool timeout')), (fn.timeoutMs || TOOL_TIMEOUT_MS) + 500)),
    ]);
    return { ...out, ms: Date.now() - t0 };
  } catch (err) {
    console.warn(`[tool] ${name} 失败：${err.message}`);
    return { ok: false, data: { error: '暂时查不到', detail: err.message }, say: name === 'get_weather' ? '天气暂时查不到，您可以看一下手机上的天气预报。' : name === 'web_search' ? webSearch.sorry : '', ms: Date.now() - t0 };
  }
}
export { weather as _weather };
