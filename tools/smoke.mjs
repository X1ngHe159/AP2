/**
 * smoke.mjs —— 浏览器端交互冒烟测试（DevTools 协议驱动无头 Edge）
 * ------------------------------------------------------------------
 * 验证真实页面里的键盘 / 鼠标交互是否生效：
 *   1. 页面加载无异常，WebGL 场景就绪
 *   2. O 键切换投影（HUD 文本变化）
 *   3. 空格暂停/恢复漫游（按钮文本变化）
 *   4. P 键暂停天体运动
 *   5. T 键开启轨迹球（复选框状态）
 *   6. 3 键进入日食演示（HUD 时间对齐到 1.3s、说明变为日食）
 *   7. R 键重置视角
 *   8. 鼠标拖拽 / 滚轮不抛异常
 *
 * 用法：node tools/smoke.mjs        （需要非受限环境启动浏览器）
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 8198;
const CDP_PORT = 9367;

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
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400).end(); return; }
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

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function waitForCdp(port, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('CDP 端口未就绪');
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  → ' + detail : ''}`);
}

async function main() {
  const server = await startServer();
  const browser = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((p) => fs.existsSync(p));
  if (!browser) throw new Error('未找到浏览器');

  const userDataDir = path.join(os.tmpdir(), 'ap2-smoke-profile');
  await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});

  const child = spawn(browser, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--disable-breakpad', '--disable-crash-reporter', '--disable-features=Translate',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--force-device-scale-factor=1',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1440,810', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    cdp = await CDP.connect(await waitForCdp(CDP_PORT));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 810, deviceScaleFactor: 1, mobile: false,
    });

    // 收集页面异常
    await cdp.send('Runtime.evaluate', {
      expression: `window.__smokeErrors = [];
        window.addEventListener('error', (e) => window.__smokeErrors.push(String(e.message)));
        window.addEventListener('unhandledrejection', (e) => window.__smokeErrors.push(String(e.reason)));
        true;`,
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

    // 等就绪
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ready: !!(window.__AP2__ && window.__AP2__.ready), err: window.__AP2__ && window.__AP2__.error})',
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value || '{}');
      if (v.err) throw new Error('页面初始化失败：' + v.err);
      ready = v.ready;
      if (!ready) await new Promise((res) => setTimeout(res, 200));
    }
    check('页面加载、WebGL 场景就绪', ready);

    const text = async (id) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `document.getElementById(${JSON.stringify(id)}).textContent.trim()`,
        returnByValue: true,
      });
      return r.result.value;
    };
    const key = async (code) => {
      await cdp.send('Runtime.evaluate', {
        expression: `window.dispatchEvent(new KeyboardEvent('keydown', { code: ${JSON.stringify(code)}, bubbles: true })), true`,
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 120));
    };

    check('初始投影 = 透视', (await text('hud-projection')) === '透视投影', await text('hud-projection'));
    check('初始相机模式 = 预设漫游', (await text('hud-mode')) === '预设漫游', await text('hud-mode'));

    await key('KeyO');
    check('O 键切换到正交投影', (await text('hud-projection')) === '正交投影', await text('hud-projection'));
    await key('KeyO');
    check('再按 O 切回透视投影', (await text('hud-projection')) === '透视投影');

    await key('Space');
    check('空格暂停漫游', (await text('btn-roam')).includes('恢复'), await text('btn-roam'));
    await key('Space');
    check('空格恢复漫游', (await text('btn-roam')).includes('暂停'), await text('btn-roam'));

    await key('KeyP');
    check('P 键暂停天体运动', (await text('btn-pause')).includes('继续'), await text('btn-pause'));
    await key('KeyP');

    await key('KeyT');
    const tb = await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementById("trackball-mode").checked',
      returnByValue: true,
    });
    check('T 键开启轨迹球（E3）', tb.result.value === true);

    await key('Digit3');
    await new Promise((r) => setTimeout(r, 200));
    const eclipseText = await text('eclipse-desc');
    const hudTime = await text('hud-time');
    check('3 键进入日食演示', /日(全|环|偏)食/.test(eclipseText), eclipseText);
    check('日食时间对齐到 t = 1.3 s', hudTime.includes('1.3'), hudTime);

    await key('KeyR');
    await new Promise((r) => setTimeout(r, 200));
    check('R 键重置视角', (await text('eclipse-desc')).includes('未进入'), await text('eclipse-desc'));

    // 鼠标拖拽 + 滚轮
    await cdp.send('Runtime.evaluate', {
      expression: `
        const c = document.getElementById('gl-canvas');
        const opts = { clientX: 700, clientY: 400, bubbles: true, pointerId: 1, button: 0 };
        c.dispatchEvent(new PointerEvent('pointerdown', opts));
        c.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 780, clientY: 430 }));
        c.dispatchEvent(new PointerEvent('pointerup', opts));
        c.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 700, clientY: 400, bubbles: true, cancelable: true }));
        true;`,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 250));

    const errResult = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__smokeErrors || [])',
      returnByValue: true,
    });
    const errors = JSON.parse(errResult.result.value || '[]');
    check('鼠标拖拽 / 滚轮无异常', errors.length === 0, errors.join(' | '));

    const stillGoing = await cdp.send('Runtime.evaluate', {
      expression: '!!(window.__AP2__ && window.__AP2__.ready)',
      returnByValue: true,
    });
    check('交互后场景仍在正常渲染', stillGoing.result.value === true);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    child.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 400));
  }
}

main().catch((err) => {
  console.error('冒烟测试失败：', err.message);
  process.exitCode = 1;
});
