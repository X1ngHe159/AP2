/**
 * src/asteroid-belt.js —— 程序化小行星带（确定性随机轨道 + 无分配位置更新）
 *
 * 课程：计算机图形学应用实践 AP2（三维层级场景：太阳系，原生 WebGL 2.0）
 * 定位：纯数学 ES Module。不访问 WebGL / document / window，不 import 项目内其他模块，
 *       无第三方依赖；浏览器 <script type="module"> 与 Node 均可直接 import。
 *
 * 轨道模型
 * --------
 * 每颗小行星的轨道参数在创建时用 mulberry32(seed) 一次性生成（确定性、可复现）：
 *
 *   a            : 轨道半径（世界单位），均匀分布在 [innerRadius, outerRadius)
 *   phase        : 初始相位角（弧度），[0, 2π)
 *   angularSpeed : 角速度，∝ a^(-3/2)（开普勒第三定律，Kepler: n = sqrt(GM/a³)），
 *                  再乘 spinScale；比例常数 VELOCITY_SCALE 只为视觉观感服务
 *   inclination  : 归一化轨道倾角因子 ∈ [-inclination, inclination]（弧度约定值）
 *   node         : 升交点经度（绕 Y 轴旋转角），[0, 2π)
 *
 * 某时刻 t 的位置：
 *   局部圆轨道 p_local = (a cosθ, 0, a sinθ)，θ = phase + angularSpeed * t
 *   绕 Y 轴旋转 node（换成世界方位角）
 *   固定垂直偏移 y_i = thickness * (inclination_i / inclination)
 *   最终 p_world = (a cos(θ - node), y_i, a sin(θ - node))，即 √(x² + z²) ≡ a，|y_i| ≤ thickness。
 *
 * 说明：为让「薄带厚度」这一视觉不变量 |y| ≤ thickness 恒成立（并便于单元测试断言），
 * 这里把 inclination 数组当作归一化倾角因子：其取值在 ±inclination 内，按比例映射为
 * ±thickness 的固定垂直偏移（不随时间/随机数抖动）。若需要物理意义上的轨道面倾斜，
 * 调用方可以把整个小行星带按 inclination 旋转（视觉上等价于带整体倾斜）。
 *
 * 性能：updateAsteroidPositions 只做标量三角运算并直接写入 out，不分配大数组。
 */

const TAU = Math.PI * 2;

/**
 * 视觉角速度比例常数。真实开普勒角速度量级在 a ≈ 48 时约 3e-3 rad/时间单位，
 * 对演示场景太慢；乘以 25 后约 0.07 rad/时间单位（约 90 秒一圈），适合观察。
 * 只用它统一缩放，不改变 angularSpeed ∝ a^(-3/2) 的相对关系。
 */
const VELOCITY_SCALE = 25;

/**
 * mulberry32 确定性伪随机数发生器（32 位状态，无第三方依赖）。
 * 同一个 seed 必定产生完全相同的序列（跨浏览器/Node 一致，因为只用整数运算）。
 *
 * @param {number} seed 32 位无符号种子
 * @returns {() => number} 每次调用返回 [0, 1) 的均匀随机数
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function mulberry32Next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 创建小行星带（只生成参数与 t = 0 的位置，不创建任何 WebGL 资源）。
 *
 * @param {object} [options]
 * @param {number} [options.count=1500] 小行星数量
 * @param {number} [options.innerRadius=44] 环带内半径
 * @param {number} [options.outerRadius=52] 环带外半径
 * @param {number} [options.seed=20240501] 随机种子（决定整条带的布局）
 * @param {number} [options.thickness=0.5] 带的半厚度（世界单位），|y_i| ≤ thickness
 * @param {number} [options.minSize=0.04] 最小尺寸（渲染时映射为缩放/点大小）
 * @param {number} [options.maxSize=0.18] 最大尺寸
 * @param {number} [options.inclination=0.08] 名义轨道倾角（弧度，决定倾角因子取值范围）
 * @param {number} [options.spinScale=1] 角速度整体倍率（1 = 正常，2 = 快一倍，0 = 静止）
 * @returns {{
 *   count: number,
 *   positions: Float32Array,
 *   sizes: Float32Array,
 *   colorSeeds: Float32Array,
 *   orbit: {
 *     a: Float32Array, phase: Float32Array, angularSpeed: Float32Array,
 *     inclination: Float32Array, node: Float32Array,
 *     nodeCos: Float32Array, nodeSin: Float32Array
 *   },
 *   seed: number,
 *   innerRadius: number,
 *   outerRadius: number,
 *   thickness: number,
 *   inclination: number,
 *   spinScale: number,
 *   inclinationScale: number
 * }}
 */
export function createAsteroidBelt({
  count = 1500,
  innerRadius = 44,
  outerRadius = 52,
  seed = 20240501,
  thickness = 0.5,
  minSize = 0.04,
  maxSize = 0.18,
  inclination = 0.08,
  spinScale = 1,
} = {}) {
  const n = Math.max(0, Math.floor(count));
  const rng = mulberry32(seed);

  const a = new Float32Array(n);
  const phase = new Float32Array(n);
  const angularSpeed = new Float32Array(n);
  const incl = new Float32Array(n);
  const node = new Float32Array(n);
  // node 的 cos/sin 在创建时算好，逐帧更新时直接复用（避免每帧大量三元函数调用）
  const nodeCos = new Float32Array(n);
  const nodeSin = new Float32Array(n);

  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const colorSeeds = new Float32Array(n);

  const span = outerRadius - innerRadius;

  for (let i = 0; i < n; i += 1) {
    const ai = innerRadius + span * rng();
    a[i] = ai;
    phase[i] = rng() * TAU;
    // 开普勒：角速度 ∝ a^(-3/2)
    angularSpeed[i] = VELOCITY_SCALE * spinScale * Math.pow(ai, -1.5);
    // 归一化倾角因子 ∈ [-inclination, inclination]
    incl[i] = (rng() * 2 - 1) * inclination;
    node[i] = rng() * TAU;
    nodeCos[i] = Math.cos(node[i]);
    nodeSin[i] = Math.sin(node[i]);
    sizes[i] = minSize + (maxSize - minSize) * rng();
    colorSeeds[i] = rng();
  }

  const belt = {
    count: n,
    positions,
    sizes,
    colorSeeds,
    orbit: { a, phase, angularSpeed, inclination: incl, node, nodeCos, nodeSin },
    seed,
    innerRadius,
    outerRadius,
    thickness,
    inclination,
    spinScale,
    // 归一化倾角因子 → 世界单位垂直偏移的缩放系数
    inclinationScale: inclination > 1e-9 ? thickness / inclination : 0,
  };

  // t = 0 的初始位置直接写进 positions
  updateAsteroidPositions(belt, 0, positions);
  return belt;
}

/**
 * 把 t 时刻所有小行星的位置写入 out（长度 count * 3，原地覆盖）。
 * 不分配大数组，只做标量运算；未提供 out 时按需分配并返回。
 *
 * 轨道（见文件头）：
 *   x = a * cos(θ - node), z = a * sin(θ - node), y = thickness * inclination_i / inclination
 *   θ = phase + angularSpeed * t
 * 因此任意时刻 √(x² + z²) ≡ a ∈ [innerRadius, outerRadius)，|y| ≤ thickness。
 *
 * @param {object} belt createAsteroidBelt 的返回值
 * @param {number} t 动画时间（秒/任意时间单位，与 angularSpeed 单位一致）
 * @param {Float32Array} [out] 输出缓冲区（长度 ≥ count * 3）
 * @returns {Float32Array} out（或新分配的 Float32Array）
 */
export function updateAsteroidPositions(belt, t, out) {
  const n = belt.count | 0;
  const o = belt.orbit;
  const dst = out && out.length >= n * 3 ? out : new Float32Array(n * 3);

  const hScale = belt.inclinationScale || 0;
  const hasNodeCos = !!o.nodeCos;
  const hasNodeSin = !!o.nodeSin;
  const hasIncl = !!o.inclination;

  for (let i = 0; i < n; i += 1) {
    const theta = o.phase[i] + o.angularSpeed[i] * t;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const ai = o.a[i];

    // 绕 Y 轴旋转 node：Ry(α) 把 (x, 0, z) 映射为 (x cosα + z sinα, 0, -x sinα + z cosα)
    const cn = hasNodeCos ? o.nodeCos[i] : Math.cos(o.node[i]);
    const sn = hasNodeSin ? o.nodeSin[i] : Math.sin(o.node[i]);

    const x = ai * c;
    const z = ai * s;
    const k = i * 3;
    dst[k] = x * cn + z * sn;
    dst[k + 1] = hasIncl ? o.inclination[i] * hScale : 0;
    dst[k + 2] = z * cn - x * sn;
  }
  return dst;
}
