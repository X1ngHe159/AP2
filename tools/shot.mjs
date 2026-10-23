/**
 * shot.mjs —— 单张截图工具（开发/验证用）
 * ------------------------------------------------------------------
 * 用途：给任意页面查询串截一张图，便于检查某个相机机位/参数下的画面。
 * 默认启动本地静态服务器；也可以用 --url 直接截线上地址。
 *
 * 用法：
 *   node tools/shot.mjs "capture=1&t=0&eye=12,0,0&target=21,0,0" out.png
 *   node tools/shot.mjs "capture=1&preset=earth" out.png --url https://x1nghe159.github.io/AP2/
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CDP_PORT = 9371;

const args = process.argv.slice(2);
const urlFlagIndex = args.indexOf('--url');
const REMOTE_BASE = urlFlagIndex >= 0 ? args[urlFlagIndex + 1] : null;
const positional = urlFlagIndex >= 0
  ? args.filter((_, i) => i !== urlFlagIndex && i !== urlFlagIndex + 1)
  : args;
const QUERY = positional[0] || 'capture=1&t=0';
const OUT = positional[1] || path.join(os.tmpdir(), 'shot.png');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

let server = null;
let base = REMOTE_BASE;

if (!base) {
  const PORT = 8196;
  server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
      if (p === '/') p = '/index.html';
      const f = path.normalize(path.join(ROOT, p));
      if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404).end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${PORT}`;
}

const url = `${base.replace(/\/$/, '')}/index.html?${QUERY}`;

const browser = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find((x) => fs.existsSync(x));
const userDataDir = path.join(os.tmpdir(), 'ap2-shot-profile');
await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
const child = spawn(browser, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-breakpad', '--disable-crash-reporter', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--force-device-scale-factor=1', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

const t0 = Date.now();
let wsUrl = null;
while (Date.now() - t0 < 45000) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((x) => x.type === 'page');
    if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 400));
}
if (!wsUrl) throw new Error('CDP 未就绪');

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  pending.set(id, { resolve, reject });
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 45000);
});

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log('URL:', url);
  await send('Page.navigate', { url });
  let ok = false;
  let err = null;
  for (let i = 0; i < 200; i++) {
    const r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready: !!(window.__AP2__ && window.__AP2__.ready), err: (window.__AP2__ && window.__AP2__.error)||null})',
      returnByValue: true,
    });
    const v = JSON.parse(r.result.value || '{}');
    if (v.err) { err = v.err; break; }
    if (v.ready) { ok = true; break; }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (err) console.error('页面错误:', err);
  await new Promise((r2) => setTimeout(r2, 300));
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await fsp.writeFile(OUT, Buffer.from(shot.data, 'base64'));
  console.log((ok ? 'ok' : 'not ready') + ' -> ' + OUT);
} finally {
  ws.close();
  child.kill();
  if (server) server.close();
}
