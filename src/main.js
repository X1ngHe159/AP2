/**
 * main.js —— 应用入口：初始化、渲染循环、交互、截图自动化接口
 * ==================================================================
 * 渲染管线：
 *   状态时间推进 → scene.update（变换树）→ camera.update（漫游/手动）
 *   → 日食阴影锥 → renderer.draw → HUD
 *
 * 截图/自检模式：index.html?capture=1&t=...&proj=ortho&preset=overview
 * 会按 URL 参数把场景摆到确定状态并只渲染一帧，供 tools/capture.mjs 使用。
 * ==================================================================
 */

import { CONFIG } from './config.js';
import { loadTextures } from './texture-loader.js';
import { Renderer } from './renderer.js';
import { SolarSystem } from './scene.js';
import { CameraController } from './camera.js';
import { createUI } from './ui.js';
import { computeUmbra, computePenumbra, eclipseType } from './eclipse.js';

const TEXTURE_NAMES = [
  'sun', 'earth', 'moon', 'mercury', 'venus', 'mars',
  'jupiter', 'saturn', 'saturn_ring', 'uranus', 'neptune', 'glow',
];

/* ---------------- 应用状态 ---------------- */
const state = {
  paused: false,
  simTime: 0,
  spinTime: 0,
  orbitSpeed: 1,
  spinSpeed: 1,
  axialTiltDeg: CONFIG.earth.axialTiltDeg,
  showOrbits: true,
  showBelt: true,
  showRings: true,
  showStars: true,
  trackball: false,
  demoWrongOrder: false,
  eclipseMode: 'off',
  eclipseInfo: null,
  projection: 'persp',
};

let gl = null;
let canvas = null;
let renderer = null;
let scene = null;
let camera = null;
let ui = null;
let eclipseData = null;
let lastFrameTime = 0;
let captureMode = false;

/**
 * 统一把应用状态同步给场景变换树。
 * eclipseAlign：日食/月食演示时把月球轨道面的升交点转到日-地连线方向，
 * 否则 node = 125° 时月球在共线时刻会偏离日地连线 125°，本影打不到地球。
 */
function updateScene() {
  scene.update({
    simTime: state.simTime,
    spinTime: state.spinTime,
    axialTiltDeg: state.axialTiltDeg,
    eclipseAlign: state.eclipseMode !== 'off',
    wrongOrder: state.demoWrongOrder,
  });
}

/* ==================================================================
 *  启动
 * ================================================================== */
async function boot() {
  canvas = document.getElementById('gl-canvas');
  gl = window.WebGLUtils.setupWebGL(canvas, {
    antialias: true,
    depth: true,
    alpha: false,
    powerPreference: 'high-performance',
  });

  window.__AP2__ = { ready: false, error: null, info: null, apply: applyPatch };

  const urls = Object.fromEntries(
    TEXTURE_NAMES.map((name) => [name, `assets/textures/${name}.png`])
  );
  const images = await loadTextures(urls);

  renderer = new Renderer(gl, CONFIG, images);
  scene = new SolarSystem(CONFIG);
  camera = new CameraController(CONFIG);

  updateScene();                 // 先算一遍，保证 positions 有效
  ui = createUI(state, { onChange: onStateChange, onButton: onButton });

  onResize();
  window.addEventListener('resize', onResize);
  bindPointer();
  window.addEventListener('keydown', onKeyDown);

  const params = new URLSearchParams(window.location.search);
  if (params.get('capture') === '1') {
    captureMode = true;
    runCapture(params);
  } else {
    const loading = document.getElementById('loading');
    if (loading) loading.style.display = 'none';
    lastFrameTime = performance.now();
    requestAnimationFrame(frame);
    window.__AP2__.ready = true;
  }
}

/* ==================================================================
 *  渲染循环
 * ================================================================== */
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrameTime) / 1000));
  lastFrameTime = now;

  // 天体运动（P 键暂停）；相机漫游由空格单独控制，两者互不影响
  if (!state.paused) {
    state.simTime += dt * state.orbitSpeed;
    state.spinTime += dt * state.spinSpeed;
  }

  updateScene();
  camera.update(dt, scene.positions);
  eclipseData = computeEclipse();

  renderer.draw({ scene, camera, state, eclipse: eclipseData });

  const info = state.eclipseInfo;
  ui.syncHud({
    mode: camera.describeMode(),
    time: state.simTime,
    eclipseText: info && info.type !== 'none'
      ? `${info.description}（日-地-月夹角 ${info.elongationDeg.toFixed(1)}°）`
      : (state.eclipseMode === 'off'
        ? '当前未进入日食/月食演示。按 3 / 4 查看。'
        : info ? info.description : ''),
  });

  requestAnimationFrame(frame);
}

/* ==================================================================
 *  日食 / 月食（选做 E2）
 * ================================================================== */
function computeEclipse() {
  if (state.eclipseMode === 'off') {
    state.eclipseInfo = null;
    return null;
  }

  const S = CONFIG.sun;
  const E = CONFIG.earth;
  const M = CONFIG.earth.moon;
  const sunPos = [0, 0, 0];
  const earthPos = scene.positions.earth;
  const moonPos = scene.positions.moon;
  const segments = CONFIG.eclipse.coneSegments;

  state.eclipseInfo = eclipseType({
    sunPos, earthPos, moonPos,
    sunRadius: S.radius,
    earthRadius: E.radius,
    moonRadius: M.radius,
  });

  // 日食：月球遮挡太阳，阴影落在（接收体）地球
  // 月食：地球遮挡太阳，阴影落在（接收体）月球
  const solar = state.eclipseMode === 'solar';
  const occluderPos = solar ? moonPos : earthPos;
  const occluderRadius = solar ? M.radius : E.radius;
  const receiverPos = solar ? earthPos : moonPos;

  return {
    umbra: computeUmbra({
      sunPos,
      sunRadius: S.radius,
      occluderPos,
      occluderRadius,
      segments,
      // 不画端盖：半透明锥体的端盖会像一块挡板糊在天体前面
      capStart: false,
      capEnd: false,
    }),
    penumbra: computePenumbra({
      sunPos,
      sunRadius: S.radius,
      occluderPos,
      occluderRadius,
      receiverPos,
      segments,
      capStart: false,
      capEnd: false,
    }),
  };
}

/* ==================================================================
 *  交互
 * ================================================================== */
function onResize() {
  window.WebGLUtils.resizeCanvasToDisplaySize(canvas, gl);
  gl.viewport(0, 0, canvas.width, canvas.height);
  camera.resize(canvas.width, canvas.height);
  if (captureMode) {
    // 窗口尺寸确定后重画一帧，保证截图内容与视口匹配
    drawCaptureFrame();
  }
}

function bindPointer() {
  const pointerPos = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      size: { width: rect.width, height: rect.height },
    };
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // 合成事件可能没有活动指针，setPointerCapture 会抛错，这里容错
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch { /* ignore */ }
    const p = pointerPos(event);
    camera.beginDrag(p.x, p.y, p.size);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!camera.dragging) return;
    const p = pointerPos(event);
    camera.drag(p.x, p.y, p.size);
  });

  const end = (event) => {
    camera.endDrag();
    canvas.classList.remove('dragging');
    try {
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    } catch { /* ignore */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    camera.wheel(event.deltaY);
  }, { passive: false });
}

function onKeyDown(event) {
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  switch (event.code) {
    case 'Space':
      event.preventDefault();
      toggleRoam();
      break;
    case 'KeyO':
      toggleProjection();
      break;
    case 'KeyP':
      togglePause();
      break;
    case 'KeyR':
      resetView();
      break;
    case 'KeyT':
      toggleTrackball();
      break;
    case 'KeyL':
      state.showOrbits = !state.showOrbits;
      ui.syncAll();
      break;
    case 'Digit1':
      applyPreset('overview');
      break;
    case 'Digit2':
      applyPreset('earth');
      break;
    case 'Digit3':
      enterEclipse('solar');
      break;
    case 'Digit4':
      enterEclipse('lunar');
      break;
    default:
      break;
  }
}

function onStateChange(key) {
  if (key === 'trackball') {
    camera.setTrackballMode(state.trackball);
    ui.setRoamLabel(camera.roamEnabled);
  }
}

function onButton(action) {
  switch (action) {
    case 'pause': togglePause(); break;
    case 'roam': toggleRoam(); break;
    case 'projection': toggleProjection(); break;
    case 'reset': resetView(); break;
    case 'overview': applyPreset('overview'); break;
    case 'earth': applyPreset('earth'); break;
    case 'solar-eclipse': enterEclipse('solar'); break;
    case 'lunar-eclipse': enterEclipse('lunar'); break;
    default: break;
  }
}

function togglePause() {
  state.paused = !state.paused;
  ui.setPauseLabel(state.paused);
}

function toggleRoam() {
  const enabled = camera.toggleRoam();
  if (enabled) {
    camera.trackballMode = false;
    state.trackball = false;
    ui.syncAll();
  }
  ui.setRoamLabel(enabled);
}

function toggleProjection() {
  state.projection = camera.toggleProjection();
  ui.setProjectionLabel(state.projection);
}

function toggleTrackball() {
  state.trackball = !state.trackball;
  camera.setTrackballMode(state.trackball);
  ui.syncAll();
  ui.setRoamLabel(camera.roamEnabled);
}

function resetView() {
  state.eclipseMode = 'off';
  state.paused = false;
  state.trackball = false;
  camera.reset();
  ui.syncAll();
  ui.setRoamLabel(camera.roamEnabled);
  ui.syncHud({
    mode: camera.describeMode(),
    time: state.simTime,
    eclipseText: '当前未进入日食/月食演示。按 3 / 4 查看。',
  });
}

function applyPreset(name) {
  state.eclipseMode = 'off';
  state.paused = false;
  state.trackball = false;
  updateScene();
  camera.setPreset(name, scene.positions);
  ui.syncAll();
  ui.setRoamLabel(camera.roamEnabled);
  ui.syncHud({
    mode: camera.describeMode(),
    time: state.simTime,
    eclipseText: '当前未进入日食/月食演示。按 3 / 4 查看。',
  });
}

/** 进入日食 / 月食演示：把时间对齐到共线时刻，暂停运动，切换预设视角 */
function enterEclipse(mode) {
  state.eclipseMode = mode;
  state.paused = true;
  state.trackball = false;
  camera.setTrackballMode(false);

  state.simTime = scene.computeEclipseTime(mode);
  state.spinTime = state.simTime;
  updateScene();

  camera.setPreset(mode === 'solar' ? 'solar-eclipse' : 'lunar-eclipse', scene.positions);
  ui.syncAll();
  ui.setRoamLabel(camera.roamEnabled);
}

/* ==================================================================
 *  截图 / 自检模式
 * ================================================================== */
/**
 * 运行时接口（供 tools/capture.mjs 录制漫游 GIF 时逐帧摆姿势）：
 * 设置确定状态后立即重绘一帧，不依赖 requestAnimationFrame。
 */
function applyPatch(patch = {}) {
  if (patch.simTime !== undefined) {
    state.simTime = patch.simTime;
    if (patch.spinTime === undefined) state.spinTime = patch.simTime;
  }
  if (patch.spinTime !== undefined) state.spinTime = patch.spinTime;
  if (patch.tilt !== undefined) state.axialTiltDeg = patch.tilt;
  if (patch.wrongOrder !== undefined) state.demoWrongOrder = patch.wrongOrder;
  if (patch.showOrbits !== undefined) state.showOrbits = patch.showOrbits;
  if (patch.showBelt !== undefined) state.showBelt = patch.showBelt;
  if (patch.showRings !== undefined) state.showRings = patch.showRings;
  if (patch.showStars !== undefined) state.showStars = patch.showStars;
  if (patch.projection) {
    state.projection = patch.projection;
    camera.setProjection(patch.projection);
  }

  updateScene();

  if (patch.preset) {
    camera.setPreset(patch.preset, scene.positions);
  }
  if (patch.roamT !== undefined) {
    camera.roamEnabled = true;
    camera.roamTime = patch.roamT;
  }

  camera.instant = true;
  camera.update(0, scene.positions);
  updateScene();
  eclipseData = computeEclipse();
  drawCaptureFrame();
  return window.__AP2__.info;
}

function runCapture(params) {
  const num = (key, fallback) =>
    params.has(key) ? parseFloat(params.get(key)) : fallback;
  const flag = (key, fallback) =>
    params.has(key) ? params.get(key) === '1' : fallback;

  state.paused = true;
  state.axialTiltDeg = num('tilt', state.axialTiltDeg);
  state.showOrbits = flag('orbits', true);
  state.showBelt = flag('belt', true);
  state.showRings = flag('rings', true);
  state.showStars = flag('stars', true);
  state.demoWrongOrder = flag('wrongOrder', false);

  state.simTime = num('t', 0);
  state.spinTime = num('spin', state.simTime);

  const eclipseMode = params.get('eclipse') || 'off';
  if (eclipseMode !== 'off') {
    state.eclipseMode = eclipseMode;
    state.simTime = scene.computeEclipseTime(eclipseMode);
    state.spinTime = state.simTime;
  }

  updateScene();

  camera.instant = true;
  state.projection = params.get('proj') || 'persp';
  camera.setProjection(state.projection);

  if (flag('roam', false)) {
    camera.roamEnabled = true;
    camera.roamTime = num('roamT', 0.15);
  } else {
    const preset = params.get('preset')
      || (eclipseMode === 'solar' ? 'solar-eclipse'
        : eclipseMode === 'lunar' ? 'lunar-eclipse' : 'overview');
    camera.setPreset(preset, scene.positions);
  }

  if (flag('ui', true) === false) document.body.classList.add('hide-ui');

  // 可选：cam=azimuth,elevation,distance 直接指定机位（用于对比截图）
  const camParam = params.get('cam');
  if (camParam) {
    const [az, el, dist] = camParam.split(',').map(Number);
    camera.setOrbit({
      ...(Number.isFinite(az) ? { azimuth: az } : {}),
      ...(Number.isFinite(el) ? { elevation: el } : {}),
      ...(Number.isFinite(dist) ? { distance: dist } : {}),
    });
  }

  // 可选：eye=x,y,z&target=x,y,z 直接指定相机与观察点（调试用）
  const eyeParam = params.get('eye');
  const targetParam = params.get('target');
  if (eyeParam && targetParam) {
    camera.setEyeTarget(eyeParam.split(',').map(Number), targetParam.split(',').map(Number));
  }

  ui.syncAll();
  ui.setRoamLabel(camera.roamEnabled);
  camera.update(0, scene.positions);
  updateScene();
  eclipseData = computeEclipse();
  drawCaptureFrame();
}

function drawCaptureFrame() {
  if (!renderer) return;
  gl.viewport(0, 0, canvas.width, canvas.height);
  camera.update(0, scene.positions);
  renderer.draw({ scene, camera, state, eclipse: eclipseData });

  const info = state.eclipseInfo;
  ui.syncHud({
    mode: camera.describeMode(),
    time: state.simTime,
    eclipseText: info && info.description
      ? info.description
      : (state.eclipseMode === 'off' ? '当前未进入日食/月食演示。按 3 / 4 查看。' : ''),
  });

  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';

  window.__AP2__.ready = true;
  window.__AP2__.info = {
    simTime: state.simTime,
    projection: state.projection,
    cameraMode: camera.describeMode(),
    earthPosition: scene.positions.earth,
    moonPosition: scene.positions.moon,
    eclipseMode: state.eclipseMode,
    eclipseInfo: state.eclipseInfo,
    canvas: [canvas.width, canvas.height],
  };
}

/* ==================================================================
 *  错误兜底：把异常显示到页面上，便于截图/控制台排查
 * ================================================================== */
function showError(error) {
  console.error(error);
  if (window.__AP2__) {
    window.__AP2__.error = String(error && error.stack ? error.stack : error);
  }
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'flex';
    loading.innerHTML = `<pre style="color:#ff8080;white-space:pre-wrap;max-width:90vw">${String(error && error.message ? error.message : error)}</pre>`;
  }
}

boot().catch(showError);
