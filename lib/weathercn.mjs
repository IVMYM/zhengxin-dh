/* 中国天气网（weather.com.cn）7 天预报页解析：只用于配置了站点编号的城市（默认 合肥=101220101）。
 * 页面口径就是国内口径：白天最高 / 夜间最低。抓不到、解析失败、数据不合理都抛错，由调用方退回 Open-Meteo。
 * 礼貌使用：调用方 10 分钟缓存一次请求，普通浏览器 UA，3 秒超时。 */
import { shanghaiParts } from './clock.mjs';

export const CN_STATIONS = { 合肥: '101220101' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 城市 → 站点编号：branch.json 的 weatherStations 优先，其次内置表；WEATHER_CN=0 关闭 */
export function stationFor(city, branch = {}, env = process.env) {
  if (env.WEATHER_CN === '0') return '';
  const own = branch && typeof branch.weatherStations === 'object' ? branch.weatherStations : {};
  const id = own[city] || CN_STATIONS[city] || '';
  return /^\d{9}$/.test(String(id)) ? String(id) : '';
}

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
const num = (s) => { const m = String(s || '').match(/-?\d+/); return m ? Number(m[0]) : NaN; };

/**
 * 解析 7 天列表的前 3 天。now 用来核对第一天是不是北京时间今天（页面过期/错位就不用）。
 * 返回 [{ date, weather, temp_min, temp_max }]，傍晚以后页面可能不给今天的最高温，此时 temp_max 为 NaN。
 */
export function parseWeatherCn(html, now = new Date()) {
  const ul = String(html || '').match(/<ul class="t clearfix">([\s\S]*?)<\/ul>/);
  if (!ul) throw new Error('no forecast list');
  const lis = ul[1].match(/<li[\s\S]*?<\/li>/g) || [];
  if (lis.length < 3) throw new Error('forecast list too short');
  const t = shanghaiParts(now);
  const base = Date.UTC(t.year, t.month - 1, t.day);
  const days = lis.slice(0, 3).map((li, i) => {
    const h1 = strip((li.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1]);
    const wea = strip((li.match(/<p[^>]*class="wea"[^>]*>([\s\S]*?)<\/p>/) || [])[1]);
    const tem = (li.match(/<p class="tem">([\s\S]*?)<\/p>/) || [])[1] || '';
    const hi = num((tem.match(/<span>([\s\S]*?)<\/span>/) || [])[1]);
    const lo = num((tem.match(/<i>([\s\S]*?)<\/i>/) || [])[1]);
    const d = new Date(base + i * 86400000);
    if (num(h1) !== d.getUTCDate()) throw new Error(`date mismatch: ${h1}`);
    if (!wea || wea.length > 12) throw new Error('bad weather text');
    if (!Number.isFinite(lo) || lo < -45 || lo > 45) throw new Error('bad low');
    if (Number.isFinite(hi) && (hi < -40 || hi > 50 || hi < lo)) throw new Error('bad high');
    if (!Number.isFinite(hi) && i > 0) throw new Error('missing high');
    return { date: d.toISOString().slice(0, 10), weather: wea, temp_min: lo, temp_max: hi };
  });
  return days;
}

export async function fetchWeatherCn(id, { timeoutMs = 3000, fetchHtml = null, now = new Date() } = {}) {
  const url = `https://www.weather.com.cn/weather/${id}.shtml`;
  const html = fetchHtml ? await fetchHtml(url) : await (async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept: 'text/html' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  })();
  return parseWeatherCn(html, now);
}
