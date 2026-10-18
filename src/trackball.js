/**
 * src/trackball.js —— 虚拟轨迹球（Virtual Trackball / Shoemake 弧球）
 *
 * 课程：计算机图形学应用实践 AP2（三维层级场景：太阳系，原生 WebGL 2.0）
 * 定位：纯数学 ES Module。不访问 WebGL / document / window，不 import 项目内其他模块，
 *       无第三方依赖；浏览器 <script type="module"> 与 Node（node tools/test-ext.mjs）
 *       均可直接 import。
 *
 * 约定
 * ----
 * - 矩阵：列主序 Float32Array(16)，元素 m[col * 4 + row]，点变换 p' = M * [x, y, z, 1]。
 * - 四元数：[x, y, z, w]（标量 w 在末位），右手定则正角。
 *   旋转矩阵 R = c I + s [u]× + (1 - c) u uᵀ，c = cosθ，s = sinθ，u 为单位轴。
 * - NDC：nx, ny ∈ [-1, 1]，ny 向上（与 WebGL 裁剪空间一致）。
 *   NDC 平面上的拖动被投影到半径 radius（默认 0.8）的球面上：
 *   球内（nx² + ny² ≤ r²/2）用球面公式 z = sqrt(r² - d)，球外用 Shoemake 的双曲抛物面
 *   z = (r²/2) / sqrt(d)，两支在 nx² + ny² = r²/2 处连续。
 *
 * 拖动语义
 * --------
 * 每次 drag 用「上一次球面点 p0」与「本次球面点 p1」做一次最小旋转：
 *   轴 axis = normalize(p0 × p1)，角 angle = acos(clamp(p0 · p1))。
 * 该旋转把 p0 转到 p1（右手定则）。每次增量旋转以四元数左乘累计：
 *   q ← qΔ ⊗ q，q 始终归一化，因此累计矩阵恒正交。
 *
 * 测试提示：由于任何 NDC 点投影后的 z 分量都 > 0，单次有限拖动得到的旋转角严格小于 90°；
 * 若需要精确的「绕 Z 轴 90°」拖动，可把 NDC 取到球外很远处（例如 nx = 1e6）：
 * 此时两个球面点分别趋于 (1,0,0) 与 (0,1,0)，叉积趋于 +Z，夹角趋于 90°（双曲分支连续，
 * 数学上仍有定义）。tools/test-ext.mjs 正是用这种方式自检「轴 = cross(p0,p1)」这一约定。
 */

const EPS = 1e-12;

/* ------------------------------------------------------------------ *
 * 内部基础向量工具
 * ------------------------------------------------------------------ */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize3(a) {
  const len = length3(a);
  if (!(len > EPS)) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/* ------------------------------------------------------------------ *
 * 四元数工具
 * ------------------------------------------------------------------ */

/** 单位四元数（恒等旋转）。@returns {number[]} [x, y, z, w] */
export function quatIdentity() {
  return [0, 0, 0, 1];
}

/**
 * 由「旋转轴 + 弧度角」构造四元数。轴会被归一化；零轴返回单位四元数。
 * @param {ArrayLike<number>} axis 旋转轴（任意非零长度）
 * @param {number} angleRad 右手定则正角（弧度）
 * @returns {number[]} [x, y, z, w]
 */
export function quatFromAxisAngle(axis, angleRad) {
  const n = normalize3(axis);
  if (!(n[0] || n[1] || n[2])) return quatIdentity();
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(half)];
}

/**
 * 四元数乘法（Hamilton 积）：result = a ⊗ b。
 * 其旋转语义为 R(result) = R(a) * R(b)，即先应用 b 再应用 a。
 * @param {ArrayLike<number>} a [x, y, z, w]
 * @param {ArrayLike<number>} b [x, y, z, w]
 * @returns {number[]} [x, y, z, w]
 */
export function quatMultiply(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * 四元数归一化（防止累计误差导致矩阵非正交）。
 * @param {ArrayLike<number>} q
 * @returns {number[]} 单位四元数
 */
export function quatNormalize(q) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(len > EPS)) return quatIdentity();
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * 四元数 → 4x4 旋转矩阵（列主序 Float32Array(16)，无平移分量）。
 * 内部会先归一化，因此传入非单位四元数也能得到正交矩阵。
 * @param {ArrayLike<number>} q [x, y, z, w]
 * @returns {Float32Array} 列主序 4x4 矩阵
 */
export function quatToMatrix(q) {
  const n = quatNormalize([q[0], q[1], q[2], q[3]]);
  const x = n[0], y = n[1], z = n[2], w = n[3];
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;

  const m = new Float32Array(16);
  // 第 0 列 = R * (1,0,0)
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[3] = 0;
  // 第 1 列 = R * (0,1,0)
  m[4] = 2 * (xy - wz);
  m[5] = 1 - 2 * (xx + zz);
  m[6] = 2 * (yz + wx);
  m[7] = 0;
  // 第 2 列 = R * (0,0,1)
  m[8] = 2 * (xz + wy);
  m[9] = 2 * (yz - wx);
  m[10] = 1 - 2 * (xx + yy);
  m[11] = 0;
  // 第 3 列 = 平移（无）
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return m;
}

/* ------------------------------------------------------------------ *
 * 弧球投影
 * ------------------------------------------------------------------ */

/**
 * 把归一化设备坐标 (nx, ny) 投影到半径 radius 的球面上，并返回球面点的单位向量。
 *
 * 球内（nx² + ny² ≤ r²/2）：z = sqrt(r² - nx² - ny²)（Shoemake 球面支）；
 * 球外：z = (r²/2) / sqrt(nx² + ny²)（双曲抛物面支，保证与球面支在边界连续）。
 * 返回前做单位化，故结果长度恒为 1（便于用 acos(dot) 求角）。
 *
 * @param {number} nx NDC x ∈ [-1, 1]
 * @param {number} ny NDC y ∈ [-1, 1]
 * @param {number} [radius=0.8] 虚拟球半径（0 < radius ≤ 1 时最自然）
 * @returns {number[]} 单位向量 [x, y, z]
 */
export function projectToSphere(nx, ny, radius = 0.8) {
  const r = radius;
  const r2 = r * r;
  const d = nx * nx + ny * ny;
  let z;
  if (d <= r2 * 0.5) {
    z = Math.sqrt(Math.max(r2 - d, 0));
  } else {
    // 双曲抛物面：与球面在 d = r²/2 处相切/连续
    z = (r2 * 0.5) / Math.sqrt(d);
  }
  const len = Math.hypot(nx, ny, z);
  if (!(len > EPS)) return [0, 0, 1];
  return [nx / len, ny / len, z / len];
}

/* ------------------------------------------------------------------ *
 * 虚拟轨迹球
 * ------------------------------------------------------------------ */

/**
 * 虚拟轨迹球。
 *
 * ```js
 * const tb = new VirtualTrackball({ radius: 0.8 });
 * canvas.addEventListener('pointerdown', (e) => {
 *   tb.beginDrag(ndcX(e), ndcY(e));
 * });
 * canvas.addEventListener('pointermove', (e) => {
 *   if (tb.isDragging) tb.drag(ndcX(e), ndcY(e));
 * });
 * canvas.addEventListener('pointerup', () => tb.end());
 * // 绘制时：const viewRotation = tb.getMatrix();
 * ```
 */
export class VirtualTrackball {
  /**
   * @param {{ radius?: number }} [options]
   */
  constructor({ radius = 0.8 } = {}) {
    /** @type {number} 虚拟球半径 */
    this.radius = radius > EPS ? radius : 0.8;
    /** @type {number[]} 累计旋转四元数 [x,y,z,w]，初始为单位四元数 */
    this._quat = quatIdentity();
    /** @type {boolean} */
    this._dragging = false;
    /** @type {number[]|null} 上一次的球面点（单位向量） */
    this._last = null;
    /** @type {Float32Array|null} getMatrix 缓存 */
    this._matrixCache = null;
  }

  /** 是否正在拖动（getter，只读）。@returns {boolean} */
  get isDragging() {
    return this._dragging;
  }

  /**
   * 开始拖动：记录按下位置对应的球面点。
   * @param {number} nx NDC x
   * @param {number} ny NDC y
   */
  beginDrag(nx, ny) {
    this._last = projectToSphere(nx, ny, this.radius);
    this._dragging = true;
  }

  /**
   * 拖动到新的 NDC 位置：与上一次球面点做球面增量旋转并左乘累计。
   * 若尚未 beginDrag，则等价于 beginDrag（容错）。
   * @param {number} nx NDC x
   * @param {number} ny NDC y
   * @returns {Float32Array} 当前累计旋转矩阵（列主序）
   */
  drag(nx, ny) {
    const p1 = projectToSphere(nx, ny, this.radius);
    if (!this._last) {
      this._last = p1;
      this._dragging = true;
      return this.getMatrix();
    }
    const p0 = this._last;
    const axis = cross3(p0, p1);
    const axisLen = length3(axis);
    const cosAngle = clamp(dot3(p0, p1), -1, 1);

    if (axisLen > EPS) {
      const angle = Math.acos(cosAngle);
      if (angle > EPS) {
        const qDelta = quatFromAxisAngle([axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen], angle);
        // 左乘累计：新的旋转作用在世界空间（后乘为局部空间）
        this._quat = quatNormalize(quatMultiply(qDelta, this._quat));
        this._matrixCache = null;
      }
    } else if (cosAngle < 0) {
      // p0 与 p1 恰好反向（180°）：叉积退化，任取一个与 p0 垂直的轴
      const ref = Math.abs(p0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const perp = normalize3(cross3(p0, ref));
      this._quat = quatNormalize(
        quatMultiply(quatFromAxisAngle(perp, Math.PI), this._quat)
      );
      this._matrixCache = null;
    }

    this._last = p1;
    return this.getMatrix();
  }

  /** 结束拖动。 */
  end() {
    this._dragging = false;
    this._last = null;
  }

  /** 重置为初始单位矩阵状态。 */
  reset() {
    this._quat = quatIdentity();
    this._dragging = false;
    this._last = null;
    this._matrixCache = null;
  }

  /**
   * 当前累计旋转矩阵（列主序 Float32Array(16)，正交，det = 1）。
   * @returns {Float32Array}
   */
  getMatrix() {
    if (!this._matrixCache) this._matrixCache = quatToMatrix(this._quat);
    // 返回副本，避免调用方修改内部缓存
    return this._matrixCache.slice();
  }

  /**
   * 当前累计旋转四元数 [x, y, z, w]（额外提供，便于调试/插值）。
   * @returns {number[]}
   */
  getQuaternion() {
    return [this._quat[0], this._quat[1], this._quat[2], this._quat[3]];
  }
}
