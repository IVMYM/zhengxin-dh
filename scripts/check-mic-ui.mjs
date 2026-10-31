// 无头检查：底部中央麦克风单击进入 listening（假麦克风）；侧栏可打开。不在 Mac 上跑。
import { chromium } from 'playwright-core';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

if (process.platform === 'darwin' || process.platform === 'win32') {
  if (!process.env.AV_ALLOW_LOCAL) {
    console.error('禁止在 Mac/Windows 上跑（会碰麦克风）。只在测试机跑。');
    process.exit(2);
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 43310);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIPSYNC_URL: '' };
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `http://127.0.0.1:${PORT}`;
const stop = (c) => { server.kill(); process.exit(c); };
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (i > 60) { console.error('server down'); stop(1); }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 1080, height: 1920 },
  permissions: ['microphone'],
});
const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto(`${base}/?text=0&wake=0&attract=99999`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.dh && window.dh.state.cfg, null, { timeout: 15000 });

// cue must not exist
const cue = await page.$('#cue');
if (cue) { console.error('FAIL: #cue still present'); stop(1); }

// 等离线识别模型就绪（或超时后仍测提示是否可见）
try {
  await page.waitForFunction(() => window.__asrReady === true || window.dh.asr.status === 'ready' || window.dh.asr.status === 'error', null, { timeout: 120000 });
} catch {}
await page.waitForTimeout(300);

// reveal and click center mic
await page.evaluate(() => { window.dh.state.micOn = true; window.dh.micPower.show(0); });
await page.click('#micPower');
await page.waitForTimeout(1200);
const st = await page.evaluate(() => ({
  mode: window.dh.state.mode,
  listening: window.dh.asr.listening,
  micState: window.dh.asr.micState,
  asr: window.dh.asr.status,
  label: document.querySelector('#micPowerLabel')?.textContent,
  hint: document.querySelector('#micHint')?.textContent,
  hintHidden: document.querySelector('#micHint')?.hidden,
  btnState: document.querySelector('#micPower')?.dataset.state,
}));
console.log('after click', st);

const okListen = st.mode === 'listening' || st.listening || st.btnState === 'listening';
const okHint = st.hint && !st.hintHidden;
if (!okListen && !okHint) {
  console.error('FAIL: click did not start listening and no hint shown', st);
  await page.screenshot({ path: path.join(OUT, 'mic-fail.png') });
  await browser.close(); stop(1);
}

// click again should stop if listening
if (okListen) {
  await page.click('#micPower');
  await page.waitForTimeout(400);
  const st2 = await page.evaluate(() => ({ mode: window.dh.state.mode, listening: window.dh.asr.listening }));
  console.log('after second click', st2);
  if (st2.listening) { console.error('FAIL: still listening'); await browser.close(); stop(1); }
}

// drawer
await page.evaluate(() => window.dh.scriptDrawer.show());
await page.waitForSelector('#scriptDrawer.open');
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'sidebar-drawer.png') });
const open = await page.evaluate(() => document.querySelector('#scriptDrawer').classList.contains('open'));
const frameSrc = await page.evaluate(() => document.querySelector('#drawerFrame')?.src || '');
console.log('drawer', open, frameSrc);
if (!open || !/admin/.test(frameSrc)) { console.error('FAIL drawer'); await browser.close(); stop(1); }

await browser.close();
console.log('OK mic+drawer');
stop(0);
