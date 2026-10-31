// 无头检查：右上角全屏按钮（悬停出现、图标随 fullscreenchange 切换、F 键、拒绝/不支持提示、全屏后布局）。禁止在 Mac 上跑。
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

if ((process.platform === 'darwin' || process.platform === 'win32') && !process.env.AV_ALLOW_LOCAL) { console.error('禁止在 Mac/Windows 跑'); process.exit(2); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 43313);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIPSYNC_URL: '' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (i > 80) { console.error('server down'); server.kill(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 100));
}
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

// 模拟 Fullscreen API：mode = ok | deny | none；全屏时把视口改成 fsViewport 模拟屏幕变大
const mock = (mode) => {
  let fsEl = null;
  const fire = () => document.dispatchEvent(new Event('fullscreenchange'));
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => mode !== 'none' });
  if (mode === 'none') {
    Element.prototype.requestFullscreen = undefined;
    Element.prototype.webkitRequestFullscreen = undefined;
  } else {
    Element.prototype.requestFullscreen = function () {
      window.__fsCalls = (window.__fsCalls || 0) + 1;
      if (mode === 'deny') { document.dispatchEvent(new Event('fullscreenerror')); return Promise.reject(new TypeError('denied')); }
      fsEl = this; setTimeout(fire, 0); return Promise.resolve();
    };
  }
  document.exitFullscreen = function () { fsEl = null; setTimeout(fire, 0); return Promise.resolve(); };
  window.__fsEscape = () => { fsEl = null; fire(); }; // 模拟按 Esc / F11 由浏览器退出
};

const fails = [];
const check = (cond, msg) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + msg); if (!cond) fails.push(msg); };

async function open(viewport, mode) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.addInitScript(mock, mode);
  await page.goto(`${base}/?text=0&wake=0&attract=99999`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.dh && window.dh.state.cfg, null, { timeout: 20000 });
  await page.evaluate(() => { try { sessionStorage.removeItem('dh.adminOpen'); } catch {} window.dh.scriptDrawer.hide(); });
  await page.waitForTimeout(300);
  return page;
}
const state = (page) => page.evaluate(() => {
  const b = document.getElementById('fsToggle');
  const r = b.getBoundingClientRect();
  return {
    opacity: Number(getComputedStyle(b).opacity), isFs: b.classList.contains('is-fs'), label: b.getAttribute('aria-label'), title: b.title,
    enterShown: getComputedStyle(b.querySelector('.ico-fs-enter')).display !== 'none',
    exitShown: getComputedStyle(b.querySelector('.ico-fs-exit')).display !== 'none',
    font: getComputedStyle(b).fontFamily, inView: r.right <= innerWidth && r.top >= 0 && r.width > 15,
    noteHidden: document.getElementById('fsNote').hidden, note: document.getElementById('fsNote').textContent,
    lt: document.getElementById('layoutToggle').getBoundingClientRect().left, fr: r.right,
  };
});

// 1) 竖屏：默认隐藏 → 悬停出现 → 点击进入 → Esc 退出 → F 键
{
  const page = await open({ width: 1080, height: 1920 }, 'ok');
  let s = await state(page);
  check(s.opacity < 0.05, `默认隐藏（opacity ${s.opacity}）`);
  check(s.label === '全屏' && s.enterShown && !s.exitShown, '初始为“全屏”图标');
  await page.mouse.move(5, 900); await page.hover('#layoutToggleZone'); await page.waitForTimeout(350);
  s = await state(page);
  check(s.opacity > 0.95 && s.inView, `悬停后出现（opacity ${s.opacity}）`);
  check(s.fr <= s.lt + 1, '全屏按钮在布局按钮左侧并排');
  await page.screenshot({ path: path.join(OUT, 'fullscreen-button-hover.png'), clip: { x: 800, y: 0, width: 280, height: 120 } });
  await page.screenshot({ path: path.join(OUT, 'fullscreen-button-hover-full.png') });
  await page.click('#fsToggle'); await page.waitForTimeout(150);
  s = await state(page);
  check(s.isFs && s.label === '退出全屏' && s.exitShown && !s.enterShown, '点击后变为“退出全屏”图标');
  check(await page.evaluate(() => document.documentElement.classList.contains('is-fullscreen')), 'html.is-fullscreen');
  await page.screenshot({ path: path.join(OUT, 'fullscreen-button-on.png'), clip: { x: 800, y: 0, width: 280, height: 120 } });
  await page.evaluate(() => window.__fsEscape()); await page.waitForTimeout(100);
  s = await state(page);
  check(!s.isFs && s.label === '全屏', 'Esc/F11 退出后图标同步回“全屏”');
  await page.mouse.move(540, 1200); await page.waitForTimeout(100);
  await page.keyboard.press('f'); await page.waitForTimeout(150);
  check((await state(page)).isFs, 'F 键进入全屏');
  await page.click('#fsToggle'); await page.waitForTimeout(150);
  check(!(await state(page)).isFs, '再点一次退出全屏');
  // 全屏后布局：竖屏改视口模拟屏幕变大，fit 后 #app 居中缩放且不溢出
  await page.setViewportSize({ width: 540, height: 960 }); await page.click('#fsToggle', { force: true }); await page.setViewportSize({ width: 1080, height: 1920 }); await page.waitForTimeout(300);
  const fitOk = await page.evaluate(() => { const r = document.getElementById('app').getBoundingClientRect(); return r.width <= innerWidth + 1 && r.height <= innerHeight + 1 && r.height > innerHeight * 0.95; });
  check(fitOk, '竖屏全屏后 #app 按新视口重新铺满');
  await page.evaluate(() => window.dh.scriptDrawer.show()); await page.waitForTimeout(400);
  const drOk = await page.evaluate(() => { const d = document.getElementById('scriptDrawer').getBoundingClientRect(); return d.width > 100 && d.left >= -1; });
  check(drOk, '竖屏全屏 + 展开管理端正常');
  await page.close();
}

// 2) 横屏：收回/展开都能全屏，按钮可见且舞台无缝
{
  const page = await open({ width: 1280, height: 800 }, 'ok');
  await page.click('#fsToggle', { force: true }); await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(300);
  check((await state(page)).isFs, '横屏收回状态进入全屏');
  await page.evaluate(() => window.dh.scriptDrawer.show()); await page.waitForTimeout(500);
  await page.hover('#layoutToggleZone'); await page.waitForTimeout(350);
  const g = await page.evaluate(() => {
    const st = document.querySelector('.stage').getBoundingClientRect(); const dr = document.getElementById('scriptDrawer').getBoundingClientRect();
    const b = document.getElementById('fsToggle').getBoundingClientRect();
    return { touch: Math.abs(st.left - dr.right) < 3, right: Math.abs(st.right - innerWidth) < 3, btnIn: b.right <= innerWidth && b.top >= 0, op: Number(getComputedStyle(document.getElementById('fsToggle')).opacity) };
  });
  check(g.touch && g.right, '横屏全屏 + 展开：舞台贴管理端且到右边缘');
  check(g.btnIn && g.op > 0.95, '横屏展开时全屏按钮悬停可见');
  await page.screenshot({ path: path.join(OUT, 'fullscreen-landscape-expanded.png') });
  await page.close();
}

// 3) 被拒绝 / 不支持：给出提示，不报错
for (const mode of ['deny', 'none']) {
  const page = await open({ width: 540, height: 960 }, mode);
  await page.hover('#layoutToggleZone'); await page.waitForTimeout(300);
  await page.click('#fsToggle'); await page.waitForTimeout(200);
  const s = await state(page);
  check(!s.isFs && !s.noteHidden && s.note.length > 4, `${mode === 'deny' ? '被拒绝' : '不支持'}时显示提示：${s.note}`);
  if (mode === 'deny') await page.screenshot({ path: path.join(OUT, 'fullscreen-denied-note.png'), clip: { x: 200, y: 0, width: 340, height: 160 } });
  await page.waitForTimeout(3500);
  check((await state(page)).noteHidden, `${mode} 提示自动消失`);
  await page.close();
}

await browser.close(); server.kill();
console.log(fails.length ? `FAIL ${fails.length}` : 'OK fullscreen');
process.exit(fails.length ? 1 : 0);
