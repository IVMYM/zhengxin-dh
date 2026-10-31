// 换装：config/outfits.json 里的服装清单。每套有待机/说话视频、海报帧和口型头像 id。
// sensitive:true 的服装默认不进点击轮换，需在 F2 现场设置里打开“显示敏感服装”。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'config', 'outfits.json');
const ID_RE = /^[a-z0-9_]{1,40}$/;

/** 读取并校验服装清单；缺说话视频时用待机视频兜底 */
export function loadOutfits(file = FILE) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = {}; }
  const seen = new Set();
  const outfits = (Array.isArray(raw.outfits) ? raw.outfits : []).filter((o) => {
    if (!o || !ID_RE.test(String(o.id)) || !o.idle || seen.has(o.id)) return false;
    seen.add(o.id); return true;
  }).map((o) => ({
    id: o.id,
    name: String(o.name || o.id),
    idle: o.idle,
    talk: o.talk || o.idle,
    poster: o.poster || '',
    lipsyncAvatar: ID_RE.test(String(o.lipsyncAvatar || '')) ? o.lipsyncAvatar : o.id,
    keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : [],
    sensitive: o.sensitive === true,
  }));
  const def = outfits.find((o) => o.id === raw.default && !o.sensitive) || outfits.find((o) => !o.sensitive) || null;
  return { default: def ? def.id : null, outfits };
}

/** 点击轮换的顺序：默认排除 sensitive */
export function rotation(outfits, { sensitive = false } = {}) {
  return outfits.filter((o) => sensitive || !o.sensitive);
}

/** 下一套（循环）；当前 id 不在轮换里时从第一套开始 */
export function nextOutfit(outfits, currentId, opts = {}) {
  const list = rotation(outfits, opts);
  if (!list.length) return null;
  const i = list.findIndex((o) => o.id === currentId);
  return list[(i + 1) % list.length];
}

/** 按说法找指定服装（“换成旗袍”）；找不到返回 null */
export function matchOutfit(outfits, text, opts = {}) {
  const s = String(text || '');
  let best = null; let bestLen = 0;
  for (const o of rotation(outfits, opts)) {
    for (const k of o.keywords) if (k && s.includes(k) && k.length > bestLen) { best = o; bestLen = k.length; }
  }
  return best;
}

/** 口型服务可用的头像 id（防止页面传任意字符串进缓存路径） */
export function lipsyncAvatars(outfits) {
  return new Set(outfits.map((o) => o.lipsyncAvatar));
}
