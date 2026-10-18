/**
 * transforms.js —— 手工矩阵构造（AP2 必做 2）
 * ==================================================================
 * 教材 Ch4 的变换推导：4x4 齐次变换矩阵、列主序存储，矩阵乘法即变换复合。
 *
 * 本文件故意**不使用** MV.js 里现成的复合函数来拼装这两处运动，而是：
 *   1. 用 mat4() 的 16 个元素位置手工填写旋转矩阵（cos/sin 放在哪一格，
 *      全部按教材公式推导）；
 *   2. 用 mult() 把基本变换按"先作用的后乘"的组合规则拼起来。
 *
 * 组合规则（后乘语义）：若 p' = M · p，且 M = A · B，
 * 则几何意义是"先对 p 施加 B，再施加 A"。
 * 因此"物体自身变换 S，再挂到父节点 P 上"要写成 P · S。
 * ==================================================================
 */

/**
 * 绕 Z 轴旋转的 4x4 矩阵（手写，列主序）。
 *
 *   Rz(θ) = ⎡ c  -s  0  0 ⎤
 *           ⎢ s   c  0  0 ⎥
 *           ⎢ 0   0  1  0 ⎥
 *           ⎣ 0   0  0  1 ⎦
 *
 * 列主序数组按"第 0 列、第 1 列……"排：
 *   [ c, s, 0, 0,   -s, c, 0, 0,   0, 0, 1, 0,   0, 0, 0, 1 ]
 */
export function rotateZMatrix(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return new Float32Array([
    c, s, 0, 0,
    -s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * 绕 X 轴旋转的 4x4 矩阵（手写，列主序）。
 *
 *   Rx(θ) = ⎡ 1   0   0  0 ⎤
 *           ⎢ 0   c  -s  0 ⎥
 *           ⎢ 0   s   c  0 ⎥
 *           ⎣ 0   0   0  1 ⎦
 *   → [ 1,0,0,0,  0,c,s,0,  0,-s,c,0,  0,0,0,1 ]
 */
export function rotateXMatrix(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return new Float32Array([
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * 绕 Y 轴旋转的 4x4 矩阵（手写，列主序）。
 *
 *   Ry(θ) = ⎡  c  0  s  0 ⎤
 *           ⎢  0  1  0  0 ⎥
 *           ⎢ -s  0  c  0 ⎥
 *           ⎣  0  0  0  1 ⎦
 *   → [ c,0,-s,0,  0,1,0,0,  s,0,c,0,  0,0,0,1 ]
 */
export function rotateYMatrix(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return new Float32Array([
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * 【必做 2 的核心】月球轨道面倾角矩阵（手工构造 + mult 组合）。
 *
 * 月球轨道并不在黄道面内，而是倾斜 5.145°；同时升交点方向会进动。
 * 在世界（黄道）坐标系里，"把月球轨道面倾斜"要表达为两次旋转的复合：
 *
 *   轨道平面矩阵 M_plane = R_y(node) · R_x(inclination)
 *
 *   - R_x(5.145°)：把轨道平面绕 X 轴抬起 5.145°（升交点在 +X 方向时）；
 *   - R_y(node)  ：再绕 Y 轴把"升交点"转到 node 方向，使倾斜的方向正确。
 *
 * 两者都用上面手写的基本旋转矩阵，再用 MV.mult 组合——没有用任何
 * "rotateAboutAxis" 之类的复合封装。README 中有这张矩阵的逐元素推导。
 *
 * @param {number} inclinationDeg 倾角（度）
 * @param {number} nodeDeg        升交点经度（度）
 * @returns {Float32Array} 列主序 4x4
 */
export function moonOrbitPlaneMatrix(inclinationDeg, nodeDeg) {
  const tilt = rotateXMatrix(inclinationDeg);
  const node = rotateYMatrix(nodeDeg);
  // mult(A, B) = A·B → 先施加倾角，再施加升交点旋转
  return MV.mult(node, tilt);
}

/**
 * 地球自转轴倾角矩阵：把地球的"自身坐标系"整体绕 Z 轴倾斜 23.44°。
 *
 * 结构上的关键点（必做 1）：倾角必须作用在**地球自身的模型矩阵**上，
 * 然后把"已倾斜的地球"整体挂到公转轨道节点下：
 *
 *   M_earth = M_orbit · [ M_tilt · M_spin ] · S(radius)
 *             └── 父节点 ──┘└──── 地球自身 ────┘
 *
 * 如果顺序反过来写成 M_tilt · M_orbit · ……，那么倾斜会作用在"地球绕
 * 太阳的位置矢量"上，地球会像陀螺一样绕太阳点头（UI 里的"变换顺序演示"
 * 开关就是用来对比这个错误的）。
 */
export function earthAxialTiltMatrix(tiltDeg) {
  return rotateZMatrix(tiltDeg);
}

/**
 * 广告牌（billboard）矩阵：让一个 XY 平面四边形永远正对相机。
 * 由相机的右向量、上向量、视线方向拼出旋转部分，再平移到世界位置。
 *
 * 列主序 4x4 = [ right | up | -forward | position ]
 */
export function billboardMatrix(position, right, up, forward, size) {
  const r = normalizeVec3(right);
  const u = normalizeVec3(up);
  const f = normalizeVec3(forward);
  const s = size;
  return new Float32Array([
    r[0] * s, r[1] * s, r[2] * s, 0,
    u[0] * s, u[1] * s, u[2] * s, 0,
    -f[0] * s, -f[1] * s, -f[2] * s, 0,
    position[0], position[1], position[2], 1,
  ]);
}

/**
 * 绕 Y 轴按角度把物体放到环形轨道上（公转节点）：
 *   M_orbit(θ, r) = R_y(θ) · T(r, 0, 0)
 * 表示"先把物体平移 r 到轨道半径处，再整体绕太阳旋转 θ"。
 */
export function orbitNode(angleDeg, orbitRadius) {
  const rotate = rotateYMatrix(angleDeg);
  const translate = MV.translate(orbitRadius, 0, 0);
  return MV.mult(rotate, translate);
}

/* -------- 内部小工具 -------- */
function normalizeVec3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/* MV 由 lib/MV.js 以经典脚本加载到全局；ES Module 里显式引用 */
const MV = window.MV;
