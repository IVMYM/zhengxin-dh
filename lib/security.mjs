// 服务器部署用的最小安全层：管理端密码（会话 Cookie）+ 公共接口按 IP 限流。
// 未设置 ADMIN_PASSWORD 时（本机展厅一体机）不启用密码，行为与原来一致。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'zx_admin';
const SESSION_MS = 12 * 3600 * 1000;
// 进程内随机密钥：重启后旧会话失效（需要重新登录），密码本身不出现在 Cookie 里
const KEY = randomBytes(32);

export function adminPassword(env = process.env) { return String(env.ADMIN_PASSWORD || ''); }
export function adminRequired(env = process.env) { return adminPassword(env).length > 0; }

function sign(exp) { return createHmac('sha256', KEY).update(String(exp)).digest('base64url'); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  if (x.length !== y.length) { timingSafeEqual(x, x); return false; }
  return timingSafeEqual(x, y);
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAdmin(req, env = process.env) {
  if (!adminRequired(env)) return true;
  const tok = parseCookies(req)[COOKIE];
  if (!tok) return false;
  const [exp, mac] = tok.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return safeEq(mac, sign(exp));
}

export function checkPassword(given, env = process.env) {
  const pw = adminPassword(env);
  return pw.length > 0 && safeEq(String(given || ''), pw);
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket?.encrypted);
}

export function sessionCookie(req) {
  const exp = Date.now() + SESSION_MS;
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
}
export function clearCookie(req) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;
}

/** 受信任的反向代理地址：逗号分隔的 IP 或 IPv4 CIDR，默认只信本机回环 */
function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
export function ipMatches(ip, rule) {
  if (!rule) return false;
  if (!rule.includes('/')) return ip === rule;
  const [base, bitsStr] = rule.split('/');
  const bits = Number(bitsStr);
  const a = ipv4ToInt(ip), b = ipv4ToInt(base);
  if (a == null || b == null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
export function trustedProxies(env = process.env) {
  return String(env.TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 客户端 IP：只有直接连进来的地址在 TRUSTED_PROXIES 里时，才看代理头
 * （优先 X-Real-IP，否则取 X-Forwarded-For 最右一项，即代理亲眼看到的地址），
 * 其他来源自带的 X-Forwarded-For 一律忽略，防止伪造绕过限流。
 */
export function clientIp(req, env = process.env) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!trustedProxies(env).some((r) => ipMatches(peer, r))) return peer;
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : peer;
}

/** 固定窗口限流：limit 次 / windowMs，按 key（类别+IP）计数 */
export class RateLimiter {
  constructor() { this.m = new Map(); }
  hit(key, limit, windowMs, now = Date.now()) {
    let e = this.m.get(key);
    if (!e || now >= e.reset) { e = { n: 0, reset: now + windowMs }; this.m.set(key, e); }
    e.n++;
    if (this.m.size > 5000) for (const [k, v] of this.m) if (now >= v.reset) this.m.delete(k);
    return { ok: e.n <= limit, retryAfter: Math.ceil((e.reset - now) / 1000) };
  }
}

export const LIMITS = {
  chat: () => Number(process.env.RATE_CHAT_PER_MIN || 30),
  tts: () => Number(process.env.RATE_TTS_PER_MIN || 120),
  login: () => 10, // 每 10 分钟
};
