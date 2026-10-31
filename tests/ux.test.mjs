import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');

test('右下角 cue 麦克风已去掉；底部中央 micPower 负责对话', () => {
  assert.doesNotMatch(html, /id="cue"/);
  assert.match(html, /id="micPower"/);
  assert.match(html, /id="micHint"/);
  assert.match(css, /\.cue \{ display: none/);
  assert.match(app, /async click\(\)/);
  assert.match(app, /await ASR\.start\(\)/);
  // 不再把单击理解成关掉麦克风
  assert.doesNotMatch(app, /btn\.addEventListener\('click'[\s\S]{0,80}MicPower\.toggle\(\)/);
});

test('不安全环境与权限失败会给出可见原因', () => {
  assert.match(app, /micSecureOk/);
  assert.match(app, /局域网 IP 的 http/);
  assert.match(app, /系统禁止浏览器使用麦克风|浏览器未允许麦克风权限/);
});

test('话术管理端：右上角悬停按钮 + 分栏展开；边缘长按/快捷键同一状态；/admin 仍保留', () => {
  assert.match(html, /id="scriptDrawer"/);
  assert.match(html, /id="layoutToggle"/);
  assert.match(html, /id="drawerEdge"/);
  assert.match(app, /ScriptDrawer/);
  assert.match(app, /admin-open/);
  assert.match(app, /dh\.adminOpen/);
  assert.match(app, /\/admin\?embed=1/);
  assert.match(css, /--admin-w/);
  assert.match(css, /#app\.admin-open \.avatar/);
  assert.match(app, /admin-landscape/);
  assert.match(css, /admin-landscape/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public/panel.html')));
});

test('用户没提问时不说话：无自动欢迎语、无吸引态定时播报', () => {
  assert.doesNotMatch(app, /await say\(S\.cfg\.greet\)/);
  assert.doesNotMatch(app, /Speaker\.speak\(greetCount/);
  assert.doesNotMatch(app, /Speaker\.speak\(S\.cfg\.attractGreet/);
  assert.match(app, /用户没提问时不说话/);
});

test('全屏按钮：右上角悬停区、Fullscreen API 含 webkit 兜底、随 fullscreenchange 同步、F 键、失败提示', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');
  const css = fs.readFileSync('public/app.css', 'utf8');
  const zone = html.slice(html.indexOf('id="layoutToggleZone"'), html.indexOf('id="layoutToggle"'));
  assert.match(zone, /id="fsToggle"/);
  assert.match(zone, /ico-fs-enter/); assert.match(zone, /ico-fs-exit/); assert.match(zone, /id="fsNote"/);
  assert.match(js, /requestFullscreen/); assert.match(js, /webkitRequestFullscreen/); assert.match(js, /webkitExitFullscreen/);
  assert.match(js, /'fullscreenchange', 'webkitfullscreenchange'/);
  assert.match(js, /'退出全屏'/); assert.match(js, /e\.key === 'f' \|\| e\.key === 'F'/);
  assert.match(js, /fullscreenerror/);
  assert.match(css, /\.fs-toggle\.is-fs \.ico-fs-exit \{ display: block; \}/);
});
