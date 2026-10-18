/**
 * scene.js —— 三维层级场景的变换树（AP2 必做 1）
 * ==================================================================
 * 变换嵌套树（每一层都写成"父矩阵 · 子矩阵"，即教材的后乘语义）：
 *
 *   世界
 *   └─ 太阳节点        M_sun  = R_y(太阳自转) · S(R_sun)
 *   └─ 地球轨道节点    M_orbitE = R_y(地球公转角) · T(d_earth, 0, 0)
 *      ├─ 地球自身     M_earth = M_orbitE · [ R_z(轴倾角) · R_y(地球自转) · S(r_earth) ]
 *      └─ 月球轨道节点 M_moonOrbit = M_orbitE · M_plane(倾角,升交点) · R_y(月球公转角) · T(d_moon,0,0)
 *         └─ 月球自身  M_moon = M_moonOrbit · R_y(月球自转) · S(r_moon)
 *   └─ 其他行星       M_planet = R_y(公转角)·T(d,0,0) · R_z(倾角) · R_y(自转) · S(r)
 *
 * 关键结构点：
 *   - 地球的轴倾角放在**地球自身**的矩阵里（M_tilt 在 M_orbit 的右边），
 *     所以倾斜的是地球这个刚体，而不是它绕太阳的位置；
 *   - 月球挂在"地球轨道节点"下而不是"地球自身"下，所以月球跟着地球绕
 *     太阳公转，但**不跟着地球自转**（真实情况：月球不会一天绕地球一圈）；
 *   - 月球轨道面倾角用 transforms.js 里手工拼出来的 4x4 矩阵表示。
 * ==================================================================
 */

import {
  orbitNode,
  moonOrbitPlaneMatrix,
  earthAxialTiltMatrix,
  rotateYMatrix,
  rotateZMatrix,
} from './transforms.js';

const MV = window.MV;

/** 从列主序 4x4 矩阵中取出平移分量（世界位置） */
function positionOf(model) {
  return [model[12], model[13], model[14]];
}

export class SolarSystem {
  constructor(config) {
    this.config = config;

    this.sun = { config: config.sun, model: MV.mat4() };
    this.earth = { config: config.earth, model: MV.mat4(), normal: MV.mat3() };
    this.moon = { config: config.earth.moon, model: MV.mat4(), normal: MV.mat3() };
    this.planets = [];

    this.earthOrbitModel = MV.mat4();
    this.moonOrbitModel = MV.mat4();
    this.moonPlaneModel = MV.mat4();
    this.ringModel = MV.mat4();

    this.orbitLines = [];
    this.positions = { sun: [0, 0, 0], earth: [0, 0, 0], moon: [0, 0, 0] };
  }

  /**
   * 每帧更新整棵变换树。
   * @param {object} state { simTime, spinTime, axialTiltDeg, eclipseAlign, wrongOrder }
   */
  update(state) {
    const C = this.config;
    const { simTime, spinTime, axialTiltDeg, eclipseAlign, wrongOrder } = state;

    /* ---------- 1. 太阳：自转 + 缩放 ---------- */
    const sunSpinDeg = (360 * spinTime) / C.sun.spinPeriodSec;
    const sunRadius = C.sun.radius;
    this.sun.model = MV.mult(
      rotateYMatrix(sunSpinDeg),
      MV.scale(sunRadius, sunRadius, sunRadius)
    );

    /* ---------- 2. 地球轨道节点：R_y(θ) · T(d, 0, 0) ---------- */
    const earthAngleDeg = (360 * simTime) / C.earth.orbitPeriodSec;
    const earthOrbit = orbitNode(earthAngleDeg, C.earth.orbitRadius);
    this.earthOrbitModel = earthOrbit;

    /* ---------- 3. 地球自身：倾角 → 自转 → 缩放 ---------- */
    const earthSpinDeg = (360 * spinTime) / C.earth.spinPeriodSec;
    const earthScale = MV.scale(C.earth.radius, C.earth.radius, C.earth.radius);
    const earthSpin = MV.mult(rotateYMatrix(earthSpinDeg), earthScale);
    const earthTilt = earthAxialTiltMatrix(axialTiltDeg);

    if (wrongOrder) {
      // 演示：把倾角放到轨道节点"外面"（左乘），倾斜就会作用在
      // 地球绕太阳的位置矢量上 —— 地球会像点头一样在轨道上起伏。
      this.earth.model = MV.mult(earthTilt, MV.mult(earthOrbit, earthSpin));
    } else {
      // 正确顺序：倾斜只作用于地球自身，然后整体挂到公转轨道下。
      this.earth.model = MV.mult(earthOrbit, MV.mult(earthTilt, earthSpin));
    }
    this.earth.normal = MV.normalMatrix(this.earth.model);

    /* ---------- 4. 月球：挂在地球轨道节点下 ---------- */
    const M = C.earth.moon;
    const moonAngleDeg = (360 * simTime) / M.orbitPeriodSec;
    // 升交点经度决定"共线时刻月球位于哪个方位"：node=125° 时月球会偏离
    // 日地连线 125°，本影打不到地球；日食/月食演示时把升交点转到日地连线
    // 方向（node=0），月球才真正挡在中间。（注意：在共线时刻月球恒在黄道面
    // 内，5.145° 的倾角此时不起作用，真正决定能不能成食的是升交点方位。）
    const nodeDeg = eclipseAlign ? 0 : M.nodeDeg;
    const moonPlane = moonOrbitPlaneMatrix(M.inclinationDeg, nodeDeg);
    this.moonPlaneModel = moonPlane;

    const moonOrbit = MV.mult(
      earthOrbit,
      MV.mult(moonPlane, MV.mult(rotateYMatrix(moonAngleDeg), MV.translate(M.orbitRadius, 0, 0)))
    );
    this.moonOrbitModel = moonOrbit;

    // 潮汐锁定：月球轨道节点已经带着月球绕地球公转，月球自身不再额外自转，
    // 于是"同一面永远朝向地球"（等价于自转周期 = 公转周期）。
    // 若在这里再乘一次 R_y(公转角)，月球就会变成每公转一圈自转两圈。
    this.moon.model = MV.mult(moonOrbit, MV.scale(M.radius, M.radius, M.radius));
    this.moon.normal = MV.normalMatrix(this.moon.model);

    /* ---------- 5. 其余行星 ---------- */
    const planets = [];
    for (const P of C.planets) {
      // phaseDeg 是每颗行星的初始公转相位，避免 t=0 时所有行星排成一条直线
      const angleDeg = (P.phaseDeg || 0) + (360 * simTime) / P.orbitPeriodSec;
      const orbit = orbitNode(angleDeg, P.orbitRadius);

      const spinDeg = (360 * spinTime) / P.spinPeriodSec;
      const spin = MV.mult(
        rotateYMatrix(spinDeg),
        MV.scale(P.radius, P.radius, P.radius)
      );
      // 行星的轴倾角同样作用在自身，再挂到轨道节点下
      const tilt = rotateZMatrix(P.tiltDeg);
      const model = MV.mult(orbit, MV.mult(tilt, spin));

      planets.push({
        config: P,
        model,
        normal: MV.normalMatrix(model),
      });

      // 土星环：直接沿用土星的模型矩阵（环几何半径以土星半径为单位）
      if (P.ring) {
        this.ringModel = model;
        this.ringConfig = P.ring;
      }
    }
    this.planets = planets;

    /* ---------- 6. 世界位置（供相机预设、日食计算使用） ---------- */
    this.positions.sun = [0, 0, 0];
    this.positions.earth = positionOf(this.earth.model);
    this.positions.moon = positionOf(this.moon.model);

    /* ---------- 7. 轨道线（单位圆 + 缩放矩阵，几何只需一份） ---------- */
    this._buildOrbitLines(earthOrbit, moonPlane);
  }

  _buildOrbitLines(earthOrbit, moonPlane) {
    const C = this.config;
    const lines = [];

    const circleScale = (radius) => MV.scale(radius, 1, radius);

    for (const P of C.planets) {
      lines.push({
        model: circleScale(P.orbitRadius),
        alpha: 0.18,
        color: [0.55, 0.70, 0.95],
      });
    }

    // 地球轨道线稍微亮一点，强调"三级嵌套"的主线
    lines.push({
      model: circleScale(C.earth.orbitRadius),
      alpha: 0.42,
      color: [0.55, 0.78, 1.0],
    });

    // 月球轨道：跟着地球走，并且贴合倾斜的月球轨道面
    lines.push({
      model: MV.mult(
        earthOrbit,
        MV.mult(moonPlane, circleScale(C.earth.moon.orbitRadius))
      ),
      alpha: 0.30,
      color: [0.85, 0.85, 0.95],
    });

    this.orbitLines = lines;
  }

  /**
   * 求解"日食 / 月食"对齐时刻（仿真时间，秒）。
   *
   * 注意：月球轨道角是**相对地球轨道节点坐标系**的局部角，不是世界角：
   *   局部 +X 方向 = 地球背离太阳的方向（因为地球轨道节点已经把 +X 转到
   *   "太阳 → 地球"的径向），所以
   *     局部 0°   → 月球在地球背日一侧 → 月食
   *     局部 180° → 月球在地球向阳一侧 → 日食
   * 因此对准时刻只取决于月球自己的公转周期，与地球公转无关：
   *   日食 t = (180/360)·P_moon，月食 t = 0
   */
  computeEclipseTime(type) {
    const P_moon = this.config.earth.moon.orbitPeriodSec;
    const offsetDeg = type === 'solar' ? 180 : 0;
    return (offsetDeg / 360) * P_moon;
  }
}
