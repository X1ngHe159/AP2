/**
 * capture.mjs —— 用 Edge/Chrome 的 DevTools 协议做无头 WebGL 截图与录屏帧采集
 * ------------------------------------------------------------------
 * 用途：生成 README 所需的截图（双投影对比、日食/月食、土星环等）
 *      以及 10 秒漫游动画的帧序列（再由 tools/make_gif.py 合成 GIF）。
 *
 * 用法：
 *   node tools/capture.mjs                 # 截图 + 录屏帧
 *   node tools/capture.mjs --stills        # 只截图
 *   node tools/capture.mjs --gif           # 只采录屏帧
 *
 * 注意：浏览器子进程需要命名管道通信，必须在非受限环境下运行
 * （本课程环境里用完整权限运行一次即可）。
 * ------------------------------------------------------------------
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');
const FRAME_DIR = path.join(ROOT, 'docs', 'frames');
const PORT = 8199;
const CDP_PORT = 9366;

/* ------------------------------------------------------------------ */
/*  1. 静态服务器                                                      */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};
function startServer() {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, `http://x`).pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ */
/*  2. 极简 CDP 客户端（Node 内置 WebSocket）                          */
/* ------------------------------------------------------------------ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this.listeners.get(msg.method) || [];
        for (const fn of list) fn(msg.params);
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`无法连接 CDP：${url}`));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  waitEvent(event, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待事件超时：${event}`)), timeoutMs);
      this.on(event, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/*  3. 启动浏览器                                                      */
/* ------------------------------------------------------------------ */
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Edge / Chrome，请手动修改 CANDIDATES');
}

async function waitForCdp(port, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('CDP 端口未就绪');
}

/* ------------------------------------------------------------------ */
/*  4. 页面操作                                                        */
/* ------------------------------------------------------------------ */
async function pollReady(cdp, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ ready: !!(window.__AP2__ && window.__AP2__.ready), error: (window.__AP2__ && window.__AP2__.error) || null })',
      returnByValue: true,
    });
    if (result.result && result.result.value) {
      const view = JSON.parse(result.result.value);
      if (view.error) throw new Error(`页面报错：${view.error}`);
      if (view.ready) return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('页面未在超时时间内就绪');
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await pollReady(cdp);
  // 等两帧，确保合成完成
  await new Promise((r) => setTimeout(r, 220));
}

async function screenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await fsp.writeFile(filePath, Buffer.from(data, 'base64'));
  return filePath;
}

/* ------------------------------------------------------------------ */
/*  5. 截图清单                                                        */
/* ------------------------------------------------------------------ */
const BASE = `http://127.0.0.1:${PORT}/index.html?capture=1`;

/** ui=true 保留面板（展示交互），ui=false 纯画面（用于对比图） */
const STILLS = [
  {
    name: '01-overview-perspective',
    query: 'preset=overview&proj=persp&t=7.5&ui=1',
    desc: '总览 · 透视投影（近大远小）',
  },
  {
    name: '02-overview-orthographic',
    query: 'preset=overview&proj=ortho&t=7.5&ui=1',
    desc: '总览 · 正交投影（平行线保持平行）',
  },
  {
    name: '03-earth-closeup-perspective',
    query: 'preset=earth&proj=persp&t=7.5&ui=0',
    desc: '地球特写 · 透视：地轴倾角与月球轨道',
  },
  {
    name: '04-earth-closeup-orthographic',
    query: 'preset=earth&proj=ortho&t=7.5&ui=0',
    desc: '地球特写 · 正交：同一画面无近大远小',
  },
  {
    name: '05-outer-planets',
    query: 'preset=overview&proj=persp&t=3.0&ui=0&orbits=1',
    desc: '外行星 · 土星环 + 小行星带（E1）',
  },
  {
    name: '06-solar-eclipse',
    query: 'eclipse=solar&ui=1',
    desc: '日食 · 月球本影/半影锥投到地球（E2）',
  },
  {
    name: '07-lunar-eclipse',
    query: 'eclipse=lunar&ui=1',
    desc: '月食 · 地球本影包住月球（E2）',
  },
  {
    name: '08-roam-camera',
    query: 'roam=1&roamT=0.28&proj=persp&ui=0&t=7.5',
    desc: '漫游路径中的一帧（预设关键帧插值）',
  },
  {
    name: '09a-transform-order-correct',
    query: 'proj=persp&t=2.5&ui=0&wrongOrder=0&orbits=1&belt=0&tilt=60&cam=1.6,0.02,55',
    desc: '正确顺序：倾角只作用于地球自身（t=2.5s，倾角放大到 60°）',
  },
  {
    name: '09b-transform-order-wrong',
    query: 'proj=persp&t=2.5&ui=0&wrongOrder=1&orbits=1&belt=0&tilt=60&cam=1.6,0.02,55',
    desc: '错误顺序：倾角左乘到轨道外 → 地球脱离黄道面上下“点头”，月球仍在原轨道',
  },
  {
    name: '10-saturn-rings',
    query: 'preset=overview&proj=persp&t=4.2&ui=0',
    desc: '土星环细节（带卡西尼缝）与木星',
  },
];

async function doStills(cdp) {
  await fsp.mkdir(SHOT_DIR, { recursive: true });
  for (const shot of STILLS) {
    const url = `${BASE}&${shot.query}`;
    process.stdout.write(`  截图 ${shot.name} ... `);
    await navigate(cdp, url);
    await screenshot(cdp, path.join(SHOT_DIR, `${shot.name}.png`));
    console.log('ok');
  }
}

/* ------------------------------------------------------------------ */
/*  6. 10 秒漫游帧采集（GIF 素材）                                     */
/* ------------------------------------------------------------------ */
async function doFrames(cdp, { fps = 10, seconds = 10 } = {}) {
  await fsp.rm(FRAME_DIR, { recursive: true, force: true });
  await fsp.mkdir(FRAME_DIR, { recursive: true });

  // 漫游一圈 42 秒，录制其中 10 秒（约 24% 的路径）
  await navigate(cdp, `${BASE}&roam=1&roamT=0&proj=persp&ui=0&t=7.5`);
  const totalFrames = fps * seconds;
  const startT = 0.02;

  for (let i = 0; i < totalFrames; i++) {
    const roamT = startT + (i / totalFrames) * (seconds / 42);
    await cdp.send('Runtime.evaluate', {
      expression: `window.__AP2__.apply({ roamT: ${roamT.toFixed(5)} })`,
      returnByValue: true,
    });
    await screenshot(cdp, path.join(FRAME_DIR, `frame-${String(i).padStart(4, '0')}.png`));
    if (i % 10 === 0) process.stdout.write(`  录屏帧 ${i}/${totalFrames}\r`);
  }
  console.log(`\n  录屏帧采集完成：${totalFrames} 帧 → ${FRAME_DIR}`);
}

/* ------------------------------------------------------------------ */
/*  7. 主流程                                                          */
/* ------------------------------------------------------------------ */
async function main() {
  const args = process.argv.slice(2);
  const onlyStills = args.includes('--stills');
  const onlyGif = args.includes('--gif');

  const server = await startServer();
  console.log(`静态服务器：http://127.0.0.1:${PORT}/`);

  const browser = findBrowser();
  const userDataDir = path.join(os.tmpdir(), 'ap2-capture-profile');
  await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

  console.log(`启动浏览器：${browser}`);
  const child = spawn(browser, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-features=Translate',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1600,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    const wsUrl = await waitForCdp(CDP_PORT);
    cdp = await CDP.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    if (!onlyGif) {
      console.log('采集静态截图…');
      await doStills(cdp);
    }
    if (!onlyStills) {
      console.log('采集 10 秒漫游帧…');
      await doFrames(cdp);
    }
    console.log('全部完成。');
  } finally {
    if (cdp) cdp.close();
    child.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 400));
  }
}

main().catch((err) => {
  console.error('\n截图流程失败：', err.message);
  process.exitCode = 1;
});
