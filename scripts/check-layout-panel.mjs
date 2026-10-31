// 无头截图：收回 / 悬停按钮 / 展开（竖屏+横屏）。禁止在 Mac 上跑。
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

if (process.platform === 'darwin' || process.platform === 'win32') {
  if (!process.env.AV_ALLOW_LOCAL) { console.error('禁止在 Mac/Windows 跑'); process.exit(2); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CHECK_PORT || 43312);
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LIPSYNC_URL: '' };
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `http://127.0.0.1:${PORT}`;
const stop = (c) => { try { server.kill(); } catch {} process.exit(c); };
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (i > 60) { console.error('server down'); stop(1); }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

async function shot(name, viewport, expand) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.goto(`${base}/?text=0&wake=0&attract=99999`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.dh && window.dh.state.cfg, null, { timeout: 20000 });
  await page.evaluate(() => { try { sessionStorage.removeItem('dh.adminOpen'); } catch {} window.dh.scriptDrawer.hide(); });
  await page.waitForTimeout(400);
  if (!expand) {
    // collapsed: ensure toggle hidden-ish, then hover to reveal
    await page.screenshot({ path: path.join(OUT, name) });
    await page.hover('#layoutToggleZone');
    await page.waitForTimeout(300);
    const op = await page.evaluate(() => getComputedStyle(document.querySelector('#layoutToggle')).opacity);
    console.log(name, 'hover opacity', op);
    if (Number(op) < 0.5) { console.error('toggle not revealed'); await page.close(); return false; }
  } else {
    await page.evaluate(() => window.dh.scriptDrawer.show());
    await page.waitForSelector('#app.admin-open');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, name) });
    const ok = await page.evaluate(() => {
      const app = document.querySelector('#app');
      const av = document.querySelector('#avatar');
      const dr = document.querySelector('#scriptDrawer');
      const title = document.querySelector('.drawer-title');
      const st = getComputedStyle(document.querySelector('#stage'));
      const drRect = dr.getBoundingClientRect();
      const appRect = app.getBoundingClientRect();
      const titleFs = title ? parseFloat(getComputedStyle(title).fontSize) : 0;
      return {
        admin: app.classList.contains('admin-open'),
        landscape: app.classList.contains('admin-landscape'),
        drawerOpen: dr.classList.contains('open'),
        stageLeft: st.left,
        avatarRight: getComputedStyle(av).right,
        avatarWidth: getComputedStyle(av).width,
        drawerCssW: drRect.width,
        appCssW: appRect.width,
        titleFs,
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    console.log(name, ok);
    if (!ok.admin || !ok.drawerOpen) { await page.close(); return false; }
    // 横屏展开：管理端应接近真实 CSS 像素宽度（可读），整页不应再被缩成窄条
    if (viewport.width > viewport.height) {
      if (!ok.landscape) { console.error('expected admin-landscape'); await page.close(); return false; }
      if (ok.drawerCssW < 400 || ok.drawerCssW > 560) { console.error('drawer width not readable', ok.drawerCssW); await page.close(); return false; }
      if (ok.titleFs < 14) { console.error('title font too small', ok.titleFs); await page.close(); return false; }
      if (ok.appCssW < viewport.width * 0.9) { console.error('app not filling viewport', ok.appCssW, viewport.width); await page.close(); return false; }
      const gap = await page.evaluate(() => {
        const stage = document.querySelector('#stage');
        const av = document.querySelector('#avatar');
        const dr = document.querySelector('#scriptDrawer');
        const sr = stage.getBoundingClientRect();
        const ar = av.getBoundingClientRect();
        const drR = dr.getBoundingClientRect();
        // 舞台应从管理端右缘铺到视口右缘；人物贴右且全高
        return {
          stageW: sr.width, stageH: sr.height, stageL: sr.left, stageR: sr.right,
          avW: ar.width, avH: ar.height, avR: ar.right, avL: ar.left,
          drawerR: drR.right, vw: window.innerWidth, vh: window.innerHeight,
          stageTouchesDrawer: Math.abs(sr.left - drR.right) < 3,
          stageTouchesRight: Math.abs(sr.right - window.innerWidth) < 3,
          avFlushRight: Math.abs(ar.right - window.innerWidth) < 4,
          avFullH: ar.height >= window.innerHeight * 0.95,
          // 人物层应铺满整个舞台（无中间空列）
          avFillsStage: Math.abs(ar.width - sr.width) < 8 && Math.abs(ar.left - sr.left) < 8,
          noDeadColumn: sr.width + 1 >= ar.width && sr.left <= drR.right + 2,
        };
      });
      console.log(name, 'gapCheck', gap);
      if (!gap.stageTouchesDrawer || !gap.stageTouchesRight || !gap.avFullH || !gap.avFillsStage) {
        console.error('layout gap/fill failed', gap); await page.close(); return false;
      }
      const playerVis = await page.evaluate(() => {
        const fr = document.getElementById('drawerFrame');
        const doc = fr && fr.contentDocument;
        if (!doc) return { ok: false, reason: 'no-frame' };
        const play = doc.getElementById('btnPlay');
        const modes = doc.getElementById('modes');
        const gapEl = doc.getElementById('gap');
        if (!play || !modes) return { ok: false, reason: 'missing' };
        const vh = doc.defaultView.innerHeight;
        const pr = play.getBoundingClientRect();
        const mr = modes.getBoundingClientRect();
        const playIn = pr.top >= -1 && pr.bottom <= vh + 2;
        const modesIn = mr.top >= -1 && mr.bottom <= vh + 2;
        let gapIn = true;
        if (gapEl && gapEl.offsetParent !== null) {
          const gr = gapEl.getBoundingClientRect();
          gapIn = gr.top >= -1 && gr.bottom <= vh + 2;
        }
        return { ok: playIn && modesIn && gapIn, playIn, modesIn, gapIn, playBottom: pr.bottom, modesBottom: mr.bottom, vh };
      });
      console.log(name, 'playerVisible', playerVis);
      if (!playerVis.ok) {
        console.error('player controls clipped', playerVis); await page.close(); return false;
      }
    }
  }
  await page.close();
  return true;
}

let ok = true;
ok = await shot('panel-collapsed.png', { width: 1080, height: 1920 }, false) && ok;
ok = await shot('panel-expanded.png', { width: 1080, height: 1920 }, true) && ok;
ok = await shot('panel-expanded-landscape.png', { width: 1440, height: 900 }, true) && ok;
ok = await shot('panel-expanded-landscape-1280.png', { width: 1280, height: 800 }, true) && ok;
ok = await shot('panel-expanded-landscape-1024.png', { width: 1024, height: 640 }, true) && ok;
ok = await shot('panel-collapsed-landscape.png', { width: 1440, height: 900 }, false) && ok;

// also hover-revealed intermediate
{
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?text=0&wake=0&attract=99999`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.dh && window.dh.state.cfg);
  await page.evaluate(() => window.dh.scriptDrawer.hide());
  await page.hover('#layoutToggleZone');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, 'panel-toggle-hover.png') });
  await page.close();
}

await browser.close();
console.log(ok ? 'OK layout shots' : 'FAIL');
for (const f of ['panel-collapsed.png', 'panel-expanded.png', 'panel-expanded-landscape.png', 'panel-toggle-hover.png']) {
  const st = fs.statSync(path.join(OUT, f));
  console.log(f, st.size);
}
stop(ok ? 0 : 1);
