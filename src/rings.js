/**
 * src/rings.js —— 程序化环带几何（土星环等）
 *
 * 课程：计算机图形学应用实践 AP2（三维层级场景：太阳系，原生 WebGL 2.0）
 * 定位：纯几何 ES Module。不访问 WebGL / document / window，不 import 项目内其他模块，
 *       无第三方依赖；浏览器 <script type="module"> 与 Node 均可直接 import。
 *
 * 约定
 * ----
 * - 矩阵无关：本模块只生成顶点数据，位置位于对象局部坐标系。
 * - 环位于 XZ 平面（y = 0），圆心在原点；内缘半径 innerRadius，外缘半径 outerRadius。
 * - 法线统一为 (0, 1, 0)（+Y），供渲染时双面/背面剔除策略使用。
 * - UV：u = 径向 0..1（内缘 0，外缘 1），v = 0.5（环带纹理通常只沿径向采样）。
 * - 顶点布局：每个分段 i 两个顶点 —— 2i = 内缘点，2i+1 = 外缘点，
 *   角度 θ_i = 2π i / segments，位置 (R cosθ, 0, R sinθ)。
 * - 索引：每个分段构成一个环带四边形，拆成两个三角形；
 *   从 +Y 俯视（右手定则法线指向观察者）为逆时针绕序。
 */
/* eslint-disable no-mixed-operators */

const TAU = Math.PI * 2;

/**
 * 生成环带几何。
 *
 * @param {object} [options]
 * @param {number} [options.innerRadius=1.35] 内缘半径（> 0）
 * @param {number} [options.outerRadius=2.4] 外缘半径（> innerRadius）
 * @param {number} [options.segments=256] 径向分段数（≥ 3）
 * @returns {{
 *   positions: Float32Array,
 *   normals: Float32Array,
 *   uvs: Float32Array,
 *   indices: Uint16Array|Uint32Array,
 *   innerRadius: number,
 *   outerRadius: number,
 *   segments: number
 * }}
 */
export function buildRingGeometry({ innerRadius = 1.35, outerRadius = 2.4, segments = 256 } = {}) {
  const seg = Math.max(3, Math.floor(segments));
  const vertexCount = seg * 2;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i < seg; i += 1) {
    const theta = (TAU * i) / seg;
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // 内缘顶点：2i，u = 0
    const iOuter = (i * 2 + 1) * 3; // 外缘顶点位置偏移
    const iInner = i * 2 * 3;       // 内缘顶点位置偏移

    positions[iInner + 0] = innerRadius * c;
    positions[iInner + 1] = 0;
    positions[iInner + 2] = innerRadius * s;
    normals[iInner + 0] = 0;
    normals[iInner + 1] = 1;
    normals[iInner + 2] = 0;
    uvs[(i * 2) * 2 + 0] = 0;
    uvs[(i * 2) * 2 + 1] = 0.5;

    // 外缘顶点：2i+1，u = 1
    positions[iOuter + 0] = outerRadius * c;
    positions[iOuter + 1] = 0;
    positions[iOuter + 2] = outerRadius * s;
    normals[iOuter + 0] = 0;
    normals[iOuter + 1] = 1;
    normals[iOuter + 2] = 0;
    uvs[(i * 2 + 1) * 2 + 0] = 1;
    uvs[(i * 2 + 1) * 2 + 1] = 0.5;
  }

  // 索引：四边形 (内_i, 内_j, 外_j, 外_i)，j = (i+1) % seg
  // 三角形 1：(内_i, 内_j, 外_j)   三角形 2：(内_i, 外_j, 外_i)
  // 叉积的 +Y 分量 > 0，即从 +Y 俯视为逆时针（法线 (0,1,0) 朝向观察者）。
  const IndexArray = vertexCount <= 65535 ? Uint16Array : Uint32Array;
  const indices = new IndexArray(seg * 6);
  for (let i = 0; i < seg; i += 1) {
    const j = (i + 1) % seg;
    const iInner = i * 2;
    const iOuter = i * 2 + 1;
    const jInner = j * 2;
    const jOuter = j * 2 + 1;
    const base = i * 6;
    indices[base + 0] = iInner;
    indices[base + 1] = jInner;
    indices[base + 2] = jOuter;
    indices[base + 3] = iInner;
    indices[base + 4] = jOuter;
    indices[base + 5] = iOuter;
  }

  return { positions, normals, uvs, indices, innerRadius, outerRadius, segments: seg };
}

/**
 * 顶点数 = segments * 2。
 * @param {number} segments
 * @returns {number}
 */
export function ringVertexCount(segments) {
  return Math.max(3, Math.floor(segments)) * 2;
}

/**
 * 三角形数 = segments * 2（每分段两个三角形）。
 * @param {number} segments
 * @returns {number}
 */
export function ringTriangleCount(segments) {
  return Math.max(3, Math.floor(segments)) * 2;
}

/**
 * 索引数 = segments * 6。
 * @param {number} segments
 * @returns {number}
 */
export function ringIndexCount(segments) {
  return Math.max(3, Math.floor(segments)) * 6;
}
