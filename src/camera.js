/**
 * camera.js —— 观察与投影：预设漫游、鼠标接管、双投影、虚拟轨迹球
 * ==================================================================
 * 必做 5：一段预设路径的环绕漫游（关键帧 + Catmull-Rom 插值），
 *         空格暂停/继续；漫游与鼠标拖拽可随时互相接管。
 * 必做 4：O 键在正交投影 / 透视投影之间切换（同一画面）。
 * 选做 E3：教材 Virtual Trackball 思想的轨迹球视角控制。
 * ==================================================================
 */

import { VirtualTrackball } from './trackball.js';

const MV = window.MV;

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale3v(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Catmull-Rom 样条插值（首尾相接时自动循环） */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

export class CameraController {
  constructor(config) {
    this.cfg = config.camera;
    this.renderCfg = config.render;
    this.earthCfg = config.earth;

    this.target = [...this.cfg.target];
    this.orbit = { ...this.cfg.defaultOrbit };
    this.eye = this._sphericalToEye(this.orbit);

    this.projection = 'persp';
    this.roamEnabled = true;
    this.roamTime = 0;                 // 归一化到 [0,1)
    this.roamSpeed = 1;
    this.trackballMode = false;
    this.trackball = new VirtualTrackball({ radius: 0.8 });

    // 预设视角的"跟随天体"模式：'earth' | 'moon' | 'earth-surface' | null
    this.follow = null;
    // 地表视角看向哪：'sun'（日食）| 'moon'（月食）
    this.surfaceLook = 'sun';
    this.surfaceFovDeg = 80;           // 地表视角的宽视野

    this.dragging = false;
    this.lastPointer = null;
    this.aspect = 1;
    this.instant = false;              // 截图模式：不做平滑
  }

  resize(width, height) {
    this.aspect = height > 0 ? width / height : 1;
  }

  /* -------------------- 球坐标 ↔ 世界坐标 -------------------- */

  _sphericalToEye(orbit) {
    const ce = Math.cos(orbit.elevation);
    return [
      this.target[0] + orbit.distance * ce * Math.sin(orbit.azimuth),
      this.target[1] + orbit.distance * Math.sin(orbit.elevation),
      this.target[2] + orbit.distance * ce * Math.cos(orbit.azimuth),
    ];
  }

  /** 从当前 eye/target 反算球坐标（鼠标接管时保持视角连续） */
  _eyeToSpherical() {
    const rel = sub3(this.eye, this.target);
    const distance = Math.hypot(rel[0], rel[1], rel[2]) || 1;
    this.orbit.distance = distance;
    this.orbit.elevation = Math.asin(Math.max(-1, Math.min(1, rel[1] / distance)));
    this.orbit.azimuth = Math.atan2(rel[0], rel[2]);
  }

  /* -------------------- 每帧更新 -------------------- */

  /**
   * @param {number} dt
   * @param {{earth?:number[], moon?:number[]}} [positions] 天体世界位置（跟随模式用）
   */
  update(dt, positions) {
    // 地表视角：相机贴在地球表面（日-地连线上向太阳的一侧），每帧跟随天体位置重算，
    // 抬头看太阳（日食）或看月亮（月食）。这是 E2 的"地面观测者"视角。
    // 相机会稍微偏离日-地连线：日食时月球只比太阳大一点点，完全正对会遮成一片黑，
    // 偏一点才能看到"钻石环"（太阳边缘的一线光）；月食时让月亮不完全居中。
    if (this.follow === 'earth-surface' && positions && positions.earth) {
      const E = positions.earth;
      const R = this.earthCfg.radius;
      if (this.surfaceLook === 'moon' && positions.moon) {
        const moonDir = normalize3(sub3(positions.moon, E));
        const side = normalize3(cross3([0, 1, 0], moonDir));
        this.eye = add3(E, add3(scale3v(moonDir, R + 0.18), scale3v(side, 0.10)));
        this.target = [...positions.moon];
      } else {
        const sunDir = normalize3(scale3v(E, -1));   // 地球 → 太阳（太阳在原点）
        const side = normalize3(cross3([0, 1, 0], sunDir));
        this.eye = add3(E, add3(
          scale3v(sunDir, R + 0.18),
          add3(scale3v(side, 0.06), scale3v([0, 1, 0], 0.04))
        ));
        this.target = [0, 0, 0];
      }
      return;
    }

    // 跟随模式：预设视角（地球/月球特写、日食/月食）把 target 钉在天体上，
    // 这样地球继续公转时画面不会把天体甩出去。
    if (this.follow) {
      if (positions && positions[this.follow]) {
        this.target = [...positions[this.follow]];
      }
      this.eye = this._sphericalToEye(this.orbit);
      return;
    }

    if (this.roamEnabled) {
      this.roamTime = (this.roamTime + (dt * this.roamSpeed) / this.cfg.roamDurationSec) % 1;
      if (this.roamTime < 0) this.roamTime += 1;

      const pose = this._roamPose(this.roamTime);
      this.target = [0, 0, 0];
      this.orbit = pose;

      const desired = this._sphericalToEye(pose);
      if (this.instant) {
        this.eye = desired;
      } else {
        // 指数平滑，避免"接管/恢复"瞬间跳变
        const k = 1 - Math.exp(-dt * 4.5);
        this.eye = [
          this.eye[0] + (desired[0] - this.eye[0]) * k,
          this.eye[1] + (desired[1] - this.eye[1]) * k,
          this.eye[2] + (desired[2] - this.eye[2]) * k,
        ];
      }
    } else {
      // 手动 / 预设视角：直接跟随球坐标，保证鼠标拖拽无延迟
      this.eye = this._sphericalToEye(this.orbit);
    }
  }

  /** 漫游路径：关键帧（方位角/仰角/距离）上的循环 Catmull-Rom 插值 */
  _roamPose(tNormalized) {
    const kf = this.cfg.roamKeyframes;
    const n = kf.length;
    const u = tNormalized * n;
    const i = Math.floor(u) % n;
    const f = u - Math.floor(u);

    const pick = (field) => {
      const value = (idx) => {
        const k = kf[((idx % n) + n) % n];
        return k[field];
      };
      let v0 = value(i - 1);
      let v1 = value(i);
      let v2 = value(i + 1);
      let v3 = value(i + 2);

      if (field === 'azimuth') {
        // 方位角是周期量：把相邻关键帧 unwrap 到 v1 附近，保证环绕一周连续
        const period = Math.PI * 2;
        const unwrap = (v, ref) => {
          while (v < ref - period / 2) v += period;
          while (v > ref + period / 2) v -= period;
          return v;
        };
        v0 = unwrap(v0, v1);
        v2 = unwrap(v2, v1);
        v3 = unwrap(v3, v2);
        // 让 v2 落在 v1 的"前方"（顺时针单调增加）
        if (v2 <= v1) v2 += period;
        if (v3 <= v2) v3 += period;
      }

      return catmullRom(v0, v1, v2, v3, f);
    };

    return {
      azimuth: pick('azimuth') % (Math.PI * 2),
      elevation: Math.max(-1.45, Math.min(1.45, pick('elevation'))),
      distance: Math.max(this.cfg.minDistance, pick('distance')),
    };
  }

  /** 切回漫游时，把路径时间对准当前视角最近的采样点，避免镜头跳飞 */
  _seekRoamTime() {
    const samples = 240;
    let bestT = 0;
    let bestD = Infinity;
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const pose = this._roamPose(t);
      const eye = this._sphericalToEye(pose);
      const d = Math.hypot(eye[0] - this.eye[0], eye[1] - this.eye[1], eye[2] - this.eye[2]);
      if (d < bestD) {
        bestD = d;
        bestT = t;
      }
    }
    this.roamTime = bestT;
  }

  /* -------------------- 交互 -------------------- */

  setRoamEnabled(enabled) {
    if (enabled && !this.roamEnabled) {
      // 从手动视角切回漫游：把路径时间对准最接近当前视角的采样点
      this._seekRoamTime();
      this.follow = null;
      this.target = [0, 0, 0];
    }
    this.roamEnabled = enabled;
  }

  toggleRoam() {
    this.setRoamEnabled(!this.roamEnabled);
    return this.roamEnabled;
  }

  /**
   * 鼠标按下：接管漫游/跟随，并把当前 eye 反算成球坐标，
   * 这样后续拖拽从当前视角继续，不会跳变。
   */
  beginDrag(x, y, size) {
    this.dragging = true;
    this.lastPointer = [x, y];
    this._eyeToSpherical();
    if (this.trackballMode) {
      const [nx, ny] = this._toNDC(x, y, size);
      this.trackball.beginDrag(nx, ny);
    }
    this.setRoamEnabled(false);
  }

  drag(x, y, size) {
    if (!this.dragging || !this.lastPointer) return;
    const [nx, ny] = this._toNDC(x, y, size);

    if (this.trackballMode) {
      this.trackball.drag(nx, ny);
      this.lastPointer = [x, y];
      return;
    }

    const dx = x - this.lastPointer[0];
    const dy = y - this.lastPointer[1];
    this.lastPointer = [x, y];

    this.orbit.azimuth -= dx * 0.0055;
    this.orbit.elevation += dy * 0.0045;
    const limit = Math.PI / 2 - 0.02;
    this.orbit.elevation = Math.max(-limit, Math.min(limit, this.orbit.elevation));
  }

  endDrag() {
    this.dragging = false;
    this.lastPointer = null;
    if (this.trackballMode) this.trackball.end();
  }

  /** 滚轮：改变距离；若在漫游中则先接管漫游（否则下一帧就被漫游覆盖） */
  wheel(deltaY) {
    if (this.roamEnabled) this.setRoamEnabled(false);
    this.orbit.distance *= Math.exp(deltaY * 0.0011);
    this.orbit.distance = Math.max(
      this.cfg.minDistance,
      Math.min(this.cfg.maxDistance, this.orbit.distance)
    );
  }

  _toNDC(x, y, size) {
    const w = size && size.width ? size.width : 1;
    const h = size && size.height ? size.height : 1;
    return [((x / w) * 2 - 1), -((y / h) * 2 - 1)];
  }

  /* -------------------- 投影切换 -------------------- */

  toggleProjection() {
    this.projection = this.projection === 'persp' ? 'ortho' : 'persp';
    return this.projection;
  }

  setProjection(p) {
    this.projection = p;
  }

  getProjMatrix() {
    const { near, far } = this.renderCfg;
    // 地表视角用更宽的视野：本项目的月球轨道被压缩到只有地球半径的 ~1.7 倍，
    // 站在地表仰望月亮时它会显得非常大，80° 视野才能同时看到月亮边缘与天空。
    const fovDeg = this.follow === 'earth-surface' ? this.surfaceFovDeg : this.renderCfg.fovDeg;
    if (this.projection === 'ortho') {
      // 正交投影：取"与透视在 target 平面处同样视野"的半高，
      // 这样切换投影时画面大小可比，差异只体现在近大远小/平行线。
      const halfH = this.orbit.distance * Math.tan((fovDeg * Math.PI) / 360);
      const halfW = halfH * this.aspect;
      return MV.ortho(-halfW, halfW, -halfH, halfH, near, far);
    }
    return MV.perspective(fovDeg, this.aspect, near, far);
  }

  /* -------------------- 轨迹球：绕 target（场景中心）旋转 -------------------- */

  /** 轨迹球模式下，相机位置绕 target 旋转后的实际 eye */
  _effectiveEye() {
    if (!this.trackballMode) return this.eye;
    const R = this.trackball.getMatrix();
    const rel = sub3(this.eye, this.target);
    // 列主序 4x4 的左上 3x3 作用于向量
    const rotated = [
      R[0] * rel[0] + R[4] * rel[1] + R[8] * rel[2],
      R[1] * rel[0] + R[5] * rel[1] + R[9] * rel[2],
      R[2] * rel[0] + R[6] * rel[1] + R[10] * rel[2],
    ];
    return add3(this.target, rotated);
  }

  /** 轨迹球模式下相机的上方向（同样被旋转） */
  _effectiveUp() {
    if (!this.trackballMode) return [0, 1, 0];
    const R = this.trackball.getMatrix();
    return [
      R[4],
      R[5],
      R[6],
    ];
  }

  getViewMatrix() {
    return MV.lookAt(this._effectiveEye(), this.target, this._effectiveUp());
  }

  /* -------------------- 相机基向量（广告牌/星空用） -------------------- */

  getBasis() {
    const eye = this._effectiveEye();
    const forward = normalize3(sub3(this.target, eye));
    const right = normalize3(cross3(forward, [0, 1, 0]));
    const up = cross3(right, forward);
    return { forward, right, up };
  }

  /* -------------------- 预设视角 -------------------- */

  /**
   * @param {'overview'|'earth'|'moon'|'solar-eclipse'|'lunar-eclipse'} name
   * @param {{earth:number[], moon:number[]}} positions 当前世界位置
   */
  setPreset(name, positions) {
    const E = positions.earth;
    const M = positions.moon;
    const dir = normalize3(E);                    // 太阳 → 地球
    const side = normalize3(cross3([0, 1, 0], dir));
    const up = [0, 1, 0];

    this.setRoamEnabled(false);
    this.trackballMode = false;
    this.trackball.reset();
    this.follow = null;

    let eye;
    let target;

    switch (name) {
      case 'earth': {
        // 地球特写：从侧面偏上方看，能看到轴倾角、月球与月球轨道
        target = [...E];
        eye = add3(E, add3(scale3v(side, 5.2), add3(scale3v(up, 2.6), scale3v(dir, -1.4))));
        this.follow = 'earth';
        break;
      }
      case 'moon': {
        target = [...M];
        eye = add3(M, add3(scale3v(side, 1.1), add3(scale3v(dir, 0.5), scale3v(up, 0.7))));
        this.follow = 'moon';
        break;
      }
      case 'solar-eclipse': {
        // 从向阳侧上方看：既能看见地球亮面，也能看见落在地球上的本影/半影暗区
        target = add3(E, scale3v(dir, -0.3));
        eye = add3(E, add3(scale3v(side, 5.4), add3(scale3v(up, 2.8), scale3v(dir, -2.4))));
        this.follow = 'earth';
        break;
      }
      case 'lunar-eclipse': {
        // 侧上方看地球本影锥把月球包住：月球在地球背日一侧
        target = add3(E, scale3v(dir, 1.6));
        eye = add3(E, add3(scale3v(side, 8.0), add3(scale3v(up, 3.0), scale3v(dir, 1.6))));
        this.follow = 'earth';
        break;
      }
      case 'earth-surface': {
        // 地面观测者视角：站在地球表面（面向太阳一侧的外壳外一点点），抬头看天。
        // 日食时看太阳被月球遮住，月食时看月亮被地球本影染红。
        const R = this.earthCfg.radius;
        if (this.surfaceLook === 'moon') {
          const moonDir = normalize3(sub3(M, E));
          eye = add3(E, scale3v(moonDir, R + 0.18));
          target = [...M];
        } else {
          const sunDir = normalize3(scale3v(E, -1));
          eye = add3(E, scale3v(sunDir, R + 0.18));
          target = [0, 0, 0];
        }
        this.follow = 'earth-surface';
        break;
      }
      case 'overview':
      default: {
        target = [...this.cfg.target];
        eye = this._sphericalToEye({ ...this.cfg.defaultOrbit });
        break;
      }
    }

    const rel = sub3(eye, target);
    const distance = Math.hypot(rel[0], rel[1], rel[2]);
    this.target = target;
    this.orbit = {
      distance,
      elevation: Math.asin(Math.max(-1, Math.min(1, rel[1] / distance))),
      azimuth: Math.atan2(rel[0], rel[2]),
    };
    this.eye = eye;
  }

  /** 重置到默认视角 */
  reset() {
    this.roamEnabled = false;
    this.follow = null;
    this.trackball.reset();
    this.trackballMode = false;
    this.target = [...this.cfg.target];
    this.orbit = { ...this.cfg.defaultOrbit };
    this.eye = this._sphericalToEye(this.orbit);
  }

  /** 直接设置球坐标视角（截图脚本用来固定机位） */
  setOrbit(orbit) {
    this.roamEnabled = false;
    this.follow = null;
    this.target = [...this.cfg.target];
    this.orbit = { ...this.orbit, ...orbit };
    this.eye = this._sphericalToEye(this.orbit);
  }

  /** 直接设置 eye / target（调试与截图用，例如"相机放在天体与太阳之间"） */
  setEyeTarget(eye, target) {
    this.roamEnabled = false;
    this.follow = null;
    this.target = [...target];
    this.eye = [...eye];
    this._eyeToSpherical();
  }

  setTrackballMode(enabled) {
    this.trackballMode = enabled;
    if (enabled) {
      this.trackball.reset();
      this.setRoamEnabled(false);
      this.follow = null;
      this._eyeToSpherical();
    } else {
      this.trackball.reset();
    }
  }

  /** 地表视角看向哪里：'sun' = 日食看太阳，'moon' = 月食看月亮 */
  setSurfaceLook(kind) {
    this.surfaceLook = kind === 'moon' ? 'moon' : 'sun';
  }

  /** 供 HUD 显示 */
  describeMode() {
    if (this.trackballMode) return '轨迹球（E3）';
    if (this.follow === 'earth-surface') {
      return this.surfaceLook === 'moon' ? '地表 · 望月' : '地表 · 观日';
    }
    if (this.follow === 'earth') return '跟随地球';
    if (this.follow === 'moon') return '跟随月球';
    if (this.roamEnabled) return '预设漫游';
    return '手动视角';
  }
}
