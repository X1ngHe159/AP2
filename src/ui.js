/**
 * ui.js —— HTML 参数面板 / HUD 绑定
 * ------------------------------------------------------------------
 * 面板负责：公转速度、自转速度、轴倾角、显示开关、轨迹球开关、
 * 相机/投影按钮、日食/月食演示入口。
 * 与 3D 逻辑解耦：只修改 state，并通过回调通知 main.js。
 * ------------------------------------------------------------------
 */

export function createUI(state, handlers = {}) {
  const $ = (id) => document.getElementById(id);
  const notify = (key) => handlers.onChange && handlers.onChange(key, state[key]);

  const els = {
    orbitSpeed: $('orbit-speed'),
    orbitSpeedVal: $('orbit-speed-val'),
    spinSpeed: $('spin-speed'),
    spinSpeedVal: $('spin-speed-val'),
    axialTilt: $('axial-tilt'),
    axialTiltVal: $('axial-tilt-val'),
    wrongOrder: $('demo-wrong-order'),
    showOrbits: $('show-orbits'),
    showBelt: $('show-belt'),
    showRings: $('show-rings'),
    showStars: $('show-stars'),
    showCones: $('show-cones'),
    trackball: $('trackball-mode'),
    btnPause: $('btn-pause'),
    btnRoam: $('btn-roam'),
    btnProjection: $('btn-projection'),
    hudProjection: $('hud-projection'),
    hudMode: $('hud-mode'),
    hudTime: $('hud-time'),
    eclipseDesc: $('eclipse-desc'),
    panel: $('panel'),
    btnCollapse: $('btn-collapse'),
  };

  /* ---------------- 滑条 ---------------- */

  function bindRange(input, output, key, format) {
    const update = () => {
      state[key] = parseFloat(input.value);
      if (output) output.textContent = format(state[key]);
    };
    input.addEventListener('input', () => {
      update();
      notify(key);
    });
    update();
  }

  bindRange(els.orbitSpeed, els.orbitSpeedVal, 'orbitSpeed', (v) => `${v.toFixed(2)}×`);
  bindRange(els.spinSpeed, els.spinSpeedVal, 'spinSpeed', (v) => `${v.toFixed(2)}×`);
  bindRange(els.axialTilt, els.axialTiltVal, 'axialTiltDeg', (v) => `${v.toFixed(1)}°`);

  /* ---------------- 复选框 ---------------- */

  function bindCheck(input, key) {
    const update = () => { state[key] = input.checked; };
    input.addEventListener('change', () => {
      update();
      notify(key);
    });
    update();
  }

  bindCheck(els.wrongOrder, 'demoWrongOrder');
  bindCheck(els.showOrbits, 'showOrbits');
  bindCheck(els.showBelt, 'showBelt');
  bindCheck(els.showRings, 'showRings');
  bindCheck(els.showStars, 'showStars');
  bindCheck(els.showCones, 'showCones');
  bindCheck(els.trackball, 'trackball');

  /* ---------------- 按钮 ---------------- */

  const buttons = [
    ['btn-pause', 'pause'],
    ['btn-roam', 'roam'],
    ['btn-projection', 'projection'],
    ['btn-reset', 'reset'],
    ['btn-overview', 'overview'],
    ['btn-earth', 'earth'],
    ['btn-solar', 'solar-eclipse'],
    ['btn-lunar', 'lunar-eclipse'],
    ['btn-surface', 'earth-surface'],
    ['btn-cones', 'cones'],
  ];
  for (const [id, action] of buttons) {
    const el = $(id);
    if (el) el.addEventListener('click', () => handlers.onButton && handlers.onButton(action));
  }

  /* ---------------- 面板折叠 ---------------- */
  if (els.btnCollapse && els.panel) {
    els.btnCollapse.addEventListener('click', () => {
      els.panel.classList.toggle('collapsed');
      els.btnCollapse.textContent = els.panel.classList.contains('collapsed') ? '+' : '−';
    });
  }

  /* ---------------- 同步 ---------------- */

  function syncAll() {
    els.orbitSpeed.value = state.orbitSpeed;
    els.orbitSpeedVal.textContent = `${state.orbitSpeed.toFixed(2)}×`;
    els.spinSpeed.value = state.spinSpeed;
    els.spinSpeedVal.textContent = `${state.spinSpeed.toFixed(2)}×`;
    els.axialTilt.value = state.axialTiltDeg;
    els.axialTiltVal.textContent = `${state.axialTiltDeg.toFixed(1)}°`;

    els.wrongOrder.checked = state.demoWrongOrder;
    els.showOrbits.checked = state.showOrbits;
    els.showBelt.checked = state.showBelt;
    els.showRings.checked = state.showRings;
    els.showStars.checked = state.showStars;
    els.showCones.checked = state.showCones;
    els.trackball.checked = state.trackball;

    setPauseLabel(state.paused);
    setProjectionLabel(state.projection);
  }

  function setPauseLabel(paused) {
    els.btnPause.textContent = paused ? '继续运动 (P)' : '暂停运动 (P)';
    els.btnPause.classList.toggle('active', paused);
  }

  function setRoamLabel(roamEnabled) {
    els.btnRoam.textContent = roamEnabled ? '暂停漫游 (空格)' : '恢复漫游 (空格)';
    els.btnRoam.classList.toggle('active', roamEnabled);
  }

  function setProjectionLabel(projection) {
    els.btnProjection.textContent = projection === 'persp' ? '正交投影 (O)' : '透视投影 (O)';
    els.hudProjection.textContent = projection === 'persp' ? '透视投影' : '正交投影';
  }

  function syncHud({ mode, time, eclipseText }) {
    els.hudMode.textContent = mode;
    els.hudTime.textContent = `t = ${time.toFixed(1)} s`;
    if (eclipseText !== undefined) els.eclipseDesc.textContent = eclipseText;
  }

  syncAll();
  setRoamLabel(true);

  return { syncAll, syncHud, setPauseLabel, setRoamLabel, setProjectionLabel };
}
