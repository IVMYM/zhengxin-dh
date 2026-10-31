import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { RateLimiter, checkPassword, isAdmin } from '../lib/security.mjs';
import { PLAYLIST_FILE } from '../lib/playlist.mjs';

test('限流：窗口内超过上限返回 ok=false，窗口过后恢复', () => {
  const r = new RateLimiter();
  for (let i = 0; i < 3; i++) assert.ok(r.hit('k', 3, 1000, 0).ok);
  assert.equal(r.hit('k', 3, 1000, 10).ok, false);
  assert.ok(r.hit('k', 3, 1000, 1001).ok);
});

test('未设置 ADMIN_PASSWORD 时不需要登录；设置后密码校验严格', () => {
  assert.equal(isAdmin({ headers: {} }, {}), true);
  assert.equal(isAdmin({ headers: {} }, { ADMIN_PASSWORD: 'x' }), false);
  assert.equal(checkPassword('abc', { ADMIN_PASSWORD: 'abc' }), true);
  assert.equal(checkPassword('abd', { ADMIN_PASSWORD: 'abc' }), false);
  assert.equal(checkPassword('', { ADMIN_PASSWORD: '' }), false);
});

test('服务器模式：写接口未登录 401，登录后 200；访客聊天限流 429；展厅可汇报 ended', async () => {
  const port = 44000 + (process.pid % 500);
  const backup = fs.existsSync(PLAYLIST_FILE) ? fs.readFileSync(PLAYLIST_FILE, 'utf8') : null;
  const srv = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_PASSWORD: 'test-pw-123', RATE_CHAT_PER_MIN: '3', LLM_BASE_URL: '', LLM_MODEL: '', PYTHON: '/bin/false' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const st = await (await fetch(`${base}/api/admin/status`)).json();
    assert.deepEqual(st, { required: true, authed: false });
    const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/playlist/item', { title: 't', text: '测试' })).status, 401);
    assert.equal((await post('/api/playlist/reorder', { ids: [] })).status, 401);
    assert.equal((await post('/api/playlist/synth', {})).status, 401);
    assert.equal((await post('/api/playlist/control', { action: 'play' })).status, 401);
    assert.equal((await fetch(`${base}/api/playlist`, { method: 'PUT', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/playlist/item`, { method: 'DELETE', body: '{}' })).status, 401);
    assert.equal((await post('/api/playlist/control', { action: 'ended' })).status, 200); // 展厅屏汇报播完
    assert.equal((await fetch(`${base}/api/playlist`)).status, 200); // 读取公开
    assert.equal((await post('/api/admin/login', { password: 'nope' })).status, 401);
    const ok = await post('/api/admin/login', { password: 'test-pw-123' });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes('test-pw-123'));
    const c = cookie.split(';')[0];
    assert.equal((await post('/api/playlist/reorder', { ids: [] }, c)).status, 200);
    assert.equal((await post('/api/playlist/control', { action: 'pause' }, c)).status, 200);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post('/api/chat', { text: '你好' })).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.equal(codes[4], 429);
  } finally {
    srv.kill();
    if (backup == null) fs.rmSync(PLAYLIST_FILE, { force: true }); else fs.writeFileSync(PLAYLIST_FILE, backup);
  }
});

test('转发头只在直连地址受信任时采用，防伪造', async () => {
  const { clientIp, ipMatches } = await import('../lib/security.mjs');
  const req = (peer, h = {}) => ({ socket: { remoteAddress: peer }, headers: h });
  assert.equal(clientIp(req('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }), {}), '203.0.113.9');
  assert.equal(clientIp(req('127.0.0.1', { 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }), {}), '198.51.100.7');
  assert.equal(clientIp(req('::ffff:127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.8' }), {}), '198.51.100.8');
  assert.equal(clientIp(req('172.24.0.1', { 'x-real-ip': '198.51.100.7' }), {}), '172.24.0.1');
  assert.equal(clientIp(req('172.24.0.1', { 'x-real-ip': '198.51.100.7' }), { TRUSTED_PROXIES: '172.24.0.1' }), '198.51.100.7');
  assert.ok(ipMatches('172.24.0.1', '172.16.0.0/12'));
  assert.ok(!ipMatches('100.76.165.71', '172.16.0.0/12'));
});
