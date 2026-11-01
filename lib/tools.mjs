// 数字人“智能体大脑”的服务端工具：只在服务端执行，密钥和外部请求都不经过前端。
// 每个工具都有短超时；失败时返回 ok:false，由大模型或兜底口径处理。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeNow, calendarHint, shanghaiParts } from './clock.mjs';
import { rank } from './router.mjs';

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
const WMO = { 0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '有雾', 48: '有雾', 51: '小毛毛雨', 53: '毛毛雨', 55: '较强毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹' };
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
    const j = fetcher ? await fetcher(c) : await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FShanghai&forecast_days=3`);
    wx = { g, j };
    wxCache.set(key, wx);
  }
  const d = wx.j.daily || {};
  const pick = (a) => (Array.isArray(a) ? a[idx] : undefined);
  const label = ['今天', '明天', '后天'][idx];
  const data = {
    city: wx.g.name, day: label, date: pick(d.time),
    weather: WMO[pick(d.weather_code)] || '未知', temp_min: Math.round(pick(d.temperature_2m_min)), temp_max: Math.round(pick(d.temperature_2m_max)),
    rain_probability: pick(d.precipitation_probability_max),
    now: idx === 0 && wx.j.current ? { temp: Math.round(wx.j.current.temperature_2m), weather: WMO[wx.j.current.weather_code] || '' } : undefined,
    source: 'Open-Meteo 预报，仅供参考',
  };
  const rain = Number.isFinite(data.rain_probability) ? `，降水概率${data.rain_probability}%` : '';
  return { ok: true, data, say: `${data.city}${label}${data.weather}，${data.temp_min}到${data.temp_max}度${rain}。` };
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

const IMPL = { get_time: getTime, get_weather: weather, branch_info: branchInfo, search_knowledge: searchKnowledge };

/** 执行一个工具调用；超时或出错返回 ok:false，不抛异常 */
export async function runTool(name, args = {}, impl = IMPL) {
  const fn = impl[name];
  if (!fn) return { ok: false, data: { error: `未知工具 ${name}` }, say: '' };
  const t0 = Date.now();
  try {
    const out = await Promise.race([
      Promise.resolve(fn(args || {})),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tool timeout')), TOOL_TIMEOUT_MS + 500)),
    ]);
    return { ...out, ms: Date.now() - t0 };
  } catch (err) {
    console.warn(`[tool] ${name} 失败：${err.message}`);
    return { ok: false, data: { error: '暂时查不到', detail: err.message }, say: name === 'get_weather' ? '天气暂时查不到，您可以看一下手机上的天气预报。' : '', ms: Date.now() - t0 };
  }
}
export { weather as _weather };
