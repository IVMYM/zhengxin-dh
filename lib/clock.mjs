// 当前北京时间（与服务器时区无关），供大模型提示词与日期类问题的确定性回答使用
const TZ = 'Asia/Shanghai';
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const DAY_MS = 86400000;

/** 取某一时刻在北京时间下的年月日、星期、时分 */
export function shanghaiParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday: WEEK[wd] };
}

function period(h) {
  if (h < 5) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 13) return '中午';
  if (h < 18) return '下午';
  return '晚上';
}

export function spokenTime(p) {
  const h12 = p.hour % 12 === 0 && p.hour >= 12 ? 12 : p.hour % 12;
  return `${period(p.hour)}${h12}点${p.minute === 0 ? '整' : (p.minute < 10 ? '零' : '') + p.minute + '分'}`;
}
const spokenDate = (p) => `${p.year}年${p.month}月${p.day}日`;

/** 例：北京时间2026年11月1日 星期日 上午9点35分 */
export function describeNow(date = new Date()) {
  const p = shanghaiParts(date);
  return `北京时间${spokenDate(p)} ${p.weekday} ${spokenTime(p)}`;
}

const DAY_WORDS = { 前天: -2, 昨天: -1, 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2 };
const FILLER = /^(请问|你好|您好|小信)?[，,。\s]*/;
const TAIL = /[呀啊呢吗嘛啦了哈]*[？?！!。\s]*$/;

/**
 * 纯日期/星期/时间提问的确定性回答（不经大模型）。不是这类问题返回 null。
 * 支持：今天/明天/后天/昨天/前天 + 几号/星期几/周几/礼拜几/什么日子/日期；现在几点/什么时间。
 */
export function dateTimeAnswer(text, date = new Date()) {
  const q = String(text || '').replace(FILLER, '').replace(TAIL, '').replace(/\s+/g, '');
  if (!q || q.length > 16) return null;
  if (/^(现在|当前|目前)?(是)?(几点|几点钟|几点了|什么时间|什么时候了|啥时间)(了)?$/.test(q)) {
    return `现在是${spokenTime(shanghaiParts(date))}。`;
  }
  const m = q.match(/^(前天|昨天|今天|今日|明天|明日|后天)(是)?(几号|几月几号|几月几日|星期几|周几|礼拜几|什么日子|什么日期|哪天|几号星期几|星期几几号)$/);
  if (!m) return null;
  const p = shanghaiParts(new Date(date.getTime() + DAY_WORDS[m[1]] * DAY_MS));
  const word = m[1].replace('今日', '今天').replace('明日', '明天');
  const askWeek = /星期|周|礼拜/.test(m[3]);
  const askDate = /号|日|哪天|日子/.test(m[3]);
  if (askWeek && !askDate) return `${word}是${p.weekday}，${p.month}月${p.day}日。`;
  return `${word}是${spokenDate(p)}，${p.weekday}。`;
}

/** 日期推算参考：本周（周一至周日）范围与接下来 7 天，避免模型算错“下周一”等 */
export function calendarHint(date = new Date()) {
  const today = shanghaiParts(date);
  const idx = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'].indexOf(today.weekday);
  const at = (n) => shanghaiParts(new Date(date.getTime() + n * DAY_MS));
  const md = (p) => `${p.month}月${p.day}日`;
  const mon = at(-idx), sun = at(6 - idx);
  const next = Array.from({ length: 7 }, (_, i) => at(i + 1)).map((p) => `${md(p)}${p.weekday.replace('星期', '周')}`).join('、');
  return `一周从周一算起，本周是${md(mon)}至${md(sun)}；接下来7天：${next}。`;
}
