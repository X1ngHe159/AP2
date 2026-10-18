/**
 * src/eclipse.js —— 日食/月食阴影几何（本影锥 / 半影圆台）与食类型判定
 *
 * 课程：计算机图形学应用实践 AP2（三维层级场景：太阳系，原生 WebGL 2.0）
 * 定位：纯几何/数学 ES Module。不访问 WebGL / document / window，不 import 项目内其他模块，
 *       无第三方依赖；浏览器 <script type="module"> 与 Node 均可直接 import。
 *
 * 锥台局部坐标约定（与常见「顶点在原点」的锥不同，便于直接放矩阵）
 * ------------------------------------------------------------------
 * - 轴向为局部 +Y；y ∈ [0, 1]（不是世界单位长度，y 会被模型矩阵的 S(1, length, 1) 拉伸）。
 * - y = 0 处半径 r0（遮挡体截面），y = 1 处半径 r1；r1 = 0 时为圆锥（顶点在 y = 1）。
 * - 侧面绕序：外法线朝向物体外侧（从外部看为逆时针）。
 * - 可选端盖：capStart 在 y = 0 处以 -Y 为法线，capEnd 在 y = 1 处以 +Y 为法线
 *   （r1 = 0 时自动跳过 end cap）。
 *
 * 世界变换约定
 * ------------
 * - 矩阵列主序 Float32Array(16)，点变换 p' = M * [x, y, z, 1]。
 * - modelMatrix = T(occluderPos) * R(+Y → 背日方向) * S(1, length, 1)
 *   即：先把局部 y ∈ [0,1] 拉伸到 length，再旋转 +Y 到背日方向，最后平移到遮挡体位置。
 *
 * 本影（umbra）
 * -------------
 * 遮挡体背向太阳的收敛锥。设 d = |occluderPos - sunPos|、R = sunRadius、r = occluderRadius，
 * 锥顶距遮挡体 length = d * r / (R - r)；遮挡体截面半径 = r；几何 y ∈ [0,1] 对应
 * y = 0 → 遮挡体（半径 r），y = 1 → 锥顶（半径 0）。
 *
 * 半影（penumbra）
 * ----------------
 * 从遮挡体朝接收体方向扩张的圆台。距遮挡体 t 处半径 = r + (R + r) * t / d。
 * length = (receiverPos - occluderPos) 在背日方向上的投影长度（≤ 0 时用两点距离），
 * y = 0 → 遮挡体，y = 1 → 接收体所在垂直平面。
 */

const EPS = 1e-12;
const RAD_TO_DEG = 180 / Math.PI;

/* ------------------------------------------------------------------ *
 * 内部向量 / 矩阵工具（模块自包含，不依赖项目内其他模块）
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

function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function normalize3(a) {
  const len = length3(a);
  if (!(len > EPS)) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** 角度 ∠(a-vertex, b-vertex)，返回弧度。 */
function angleAtVertex(vertex, a, b) {
  const ua = normalize3(sub3(a, vertex));
  const ub = normalize3(sub3(b, vertex));
  return Math.acos(clamp(dot3(ua, ub), -1, 1));
}

/** 4x4 单位矩阵（列主序）。 */
function identity4() {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** 平移矩阵（列主序）。 */
function translation4(p) {
  const m = identity4();
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  return m;
}

/** 缩放矩阵（列主序）。 */
function scale4(sx, sy, sz) {
  const m = identity4();
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  return m;
}

/**
 * 列主序 4x4 乘法：返回 A * B（先对点应用 B，再应用 A）。
 * out[col*4+row] = Σ_k A[row][k] * B[k][col]。
 */
function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4 + 0];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b0 + a[1 * 4 + row] * b1 + a[2 * 4 + row] * b2 + a[3 * 4 + row] * b3;
    }
  }
  return out;
}

/**
 * 构造把局部 +Y 旋转到 direction 的旋转矩阵（列主序）。
 * 用 Rodrigues 公式：R = c I + s [u]× + (1 - c) u uᵀ，
 * 其中 u = normalize(+Y × direction)，c = dot(+Y, direction)，s = |+Y × direction|。
 * 当 direction ≈ +Y 时返回单位矩阵；当 direction ≈ -Y 时叉积退化，改用绕 X 轴 180°
 * （diag(1, -1, -1)），不会出现除零。
 *
 * @param {ArrayLike<number>} direction 目标方向（非零）
 * @returns {Float32Array} 列主序旋转矩阵
 */
function rotationFromYTo(direction) {
  const m = identity4();
  const d = normalize3(direction);
  if (!(d[0] || d[1] || d[2])) return m;

  const c = clamp(d[1], -1, 1); // cosθ = dot(+Y, d)
  // u = +Y × d = (d.z, 0, -d.x)，未归一化；|u| = sinθ
  let ux = d[2];
  const uy = 0;
  let uz = -d[0];
  const s = Math.hypot(ux, uy, uz);

  if (s < 1e-9) {
    if (c > 0) return m; // direction ≈ +Y
    // direction ≈ -Y：绕 X 轴旋转 180°，R = diag(1, -1, -1)
    m[5] = -1;
    m[10] = -1;
    return m;
  }

  ux /= s;
  uz /= s;
  const t = 1 - c;

  // 行优先元素 R[row][col]
  const r00 = c + t * ux * ux;
  const r01 = -s * uz + t * ux * uy;
  const r02 = s * uy + t * ux * uz;
  const r10 = s * uz + t * uy * ux;
  const r11 = c + t * uy * uy;
  const r12 = -s * ux + t * uy * uz;
  const r20 = -s * uy + t * uz * ux;
  const r21 = s * ux + t * uz * uy;
  const r22 = c + t * uz * uz;

  // 列主序写入：m[col*4+row]
  m[0] = r00; m[1] = r10; m[2] = r20;
  m[4] = r01; m[5] = r11; m[6] = r21;
  m[8] = r02; m[9] = r12; m[10] = r22;
  return m;
}

/* ------------------------------------------------------------------ *
 * 锥台 / 圆锥几何
 * ------------------------------------------------------------------ */

/**
 * 生成沿局部 +Y 的圆台几何：y = 0 处半径 r0，y = 1 处半径 r1（r1 = 0 时为圆锥，顶点在 y = 1）。
 *
 * 顶点布局（不含端盖时）：每分段 2 个顶点，2i = 底面，2i+1 = 顶面；
 * 有端盖时在侧面顶点之后追加「中心点 + segments 个边缘点（法线为端盖法线）」。
 *
 * @param {object} [options]
 * @param {number} [options.r0=1] y = 0 处半径
 * @param {number} [options.r1=0] y = 1 处半径（0 → 圆锥）
 * @param {number} [options.segments=64] 圆周分段数（≥ 3）
 * @param {boolean} [options.capStart=true] 是否封闭 y = 0 端盖（法线 -Y）
 * @param {boolean} [options.capEnd=false] 是否封闭 y = 1 端盖（法线 +Y；r1 = 0 时自动跳过）
 * @returns {{
 *   positions: Float32Array, normals: Float32Array,
 *   indices: Uint16Array|Uint32Array,
 *   segments: number, r0: number, r1: number, vertexCount: number
 * }}
 */
export function buildFrustumGeometry({
  r0 = 1,
  r1 = 0,
  segments = 64,
  capStart = true,
  capEnd = false,
} = {}) {
  const seg = Math.max(3, Math.floor(segments));
  const cone = r1 === 0;
  const hasStartCap = !!capStart;
  const hasEndCap = !!capEnd && r1 > 0;

  const sideVertCount = seg * 2;
  const startCapCount = hasStartCap ? seg + 1 : 0;
  const endCapCount = hasEndCap ? seg + 1 : 0;
  const vertexCount = sideVertCount + startCapCount + endCapCount;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = [];

  // ---- 侧面顶点与法线 ----
  // 侧面法线：normalize((cosθ, r0 - r1, sinθ))（圆柱时退化为 (cosθ, 0, sinθ)）
  const slope = r0 - r1;
  const nInv = 1 / Math.hypot(1, slope);
  for (let i = 0; i < seg; i += 1) {
    const theta = (Math.PI * 2 * i) / seg;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const nx = c * nInv;
    const ny = slope * nInv;
    const nz = s * nInv;

    const b = i * 2 * 3;       // 底面顶点
    const t = (i * 2 + 1) * 3; // 顶面顶点
    positions[b + 0] = r0 * c;
    positions[b + 1] = 0;
    positions[b + 2] = r0 * s;
    positions[t + 0] = r1 * c;
    positions[t + 1] = 1;
    positions[t + 2] = r1 * s;
    normals[b + 0] = nx;
    normals[b + 1] = ny;
    normals[b + 2] = nz;
    normals[t + 0] = nx;
    normals[t + 1] = ny;
    normals[t + 2] = nz;
  }

  // ---- 侧面索引（外法线朝外）----
  for (let i = 0; i < seg; i += 1) {
    const j = (i + 1) % seg;
    const bi = i * 2;
    const ti = i * 2 + 1;
    const bj = j * 2;
    const tj = j * 2 + 1;
    if (cone) {
      // 顶点重合，每个分段一个三角形 (底_i, 顶点_i, 底_j)
      indices.push(bi, ti, bj);
    } else {
      // 四边形 (底_i, 顶_i, 顶_j, 底_j) → 两个三角形
      indices.push(bi, ti, tj);
      indices.push(bi, tj, bj);
    }
  }

  // ---- y = 0 端盖（法线 -Y，从下方看逆时针）----
  if (hasStartCap) {
    const center = sideVertCount;
    const cOff = center * 3;
    positions[cOff + 0] = 0;
    positions[cOff + 1] = 0;
    positions[cOff + 2] = 0;
    normals[cOff + 0] = 0;
    normals[cOff + 1] = -1;
    normals[cOff + 2] = 0;

    for (let i = 0; i < seg; i += 1) {
      const theta = (Math.PI * 2 * i) / seg;
      const vi = center + 1 + i;
      const vOff = vi * 3;
      positions[vOff + 0] = r0 * Math.cos(theta);
      positions[vOff + 1] = 0;
      positions[vOff + 2] = r0 * Math.sin(theta);
      normals[vOff + 0] = 0;
      normals[vOff + 1] = -1;
      normals[vOff + 2] = 0;
    }
    for (let i = 0; i < seg; i += 1) {
      const j = (i + 1) % seg;
      indices.push(center, center + 1 + i, center + 1 + j);
    }
  }

  // ---- y = 1 端盖（法线 +Y，从上方看逆时针；r1 = 0 时跳过）----
  if (hasEndCap) {
    const center = sideVertCount + startCapCount;
    const cOff = center * 3;
    positions[cOff + 0] = 0;
    positions[cOff + 1] = 1;
    positions[cOff + 2] = 0;
    normals[cOff + 0] = 0;
    normals[cOff + 1] = 1;
    normals[cOff + 2] = 0;

    for (let i = 0; i < seg; i += 1) {
      const theta = (Math.PI * 2 * i) / seg;
      const vi = center + 1 + i;
      const vOff = vi * 3;
      positions[vOff + 0] = r1 * Math.cos(theta);
      positions[vOff + 1] = 1;
      positions[vOff + 2] = r1 * Math.sin(theta);
      normals[vOff + 0] = 0;
      normals[vOff + 1] = 1;
      normals[vOff + 2] = 0;
    }
    for (let i = 0; i < seg; i += 1) {
      const j = (i + 1) % seg;
      indices.push(center, center + 1 + j, center + 1 + i);
    }
  }

  const IndexArray = vertexCount <= 65535 ? Uint16Array : Uint32Array;
  return {
    positions,
    normals,
    indices: new IndexArray(indices),
    segments: seg,
    r0,
    r1,
    vertexCount,
  };
}

/**
 * 单位圆锥网格（r0 = 1，r1 = 0，y ∈ [0,1]）：等价于 buildFrustumGeometry({ r0: 1, r1: 0 })。
 * 主要供单元测试与调试使用。
 * @param {{ segments?: number }} [options]
 */
export function buildConeMesh({ segments = 64 } = {}) {
  return buildFrustumGeometry({ r0: 1, r1: 0, segments });
}

/* ------------------------------------------------------------------ *
 * 本影 / 半影
 * ------------------------------------------------------------------ */

/**
 * 计算本影锥（遮挡体背向太阳的收敛锥）的局部几何 + 世界模型矩阵。
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.sunPos 太阳世界坐标 [x,y,z]
 * @param {number} options.sunRadius 太阳半径
 * @param {ArrayLike<number>} options.occluderPos 遮挡体世界坐标（例如月球）
 * @param {number} options.occluderRadius 遮挡体半径
 * @param {number} [options.segments=64] 圆周分段数
 * @param {boolean} [options.capStart=true] 遮挡体处端盖
 * @param {boolean} [options.capEnd=false] y=1 端盖（圆锥时无效）
 * @returns {{
 *   geometry: { positions: Float32Array, normals: Float32Array, indices: Uint16Array|Uint32Array },
 *   modelMatrix: Float32Array,
 *   meta: { length: number, apexPos: number[], radiusAtOccluder: number, sunDistance: number, direction: number[] }
 * }}
 */
export function computeUmbra({
  sunPos,
  sunRadius,
  occluderPos,
  occluderRadius,
  segments = 64,
  capStart = true,
  capEnd = false,
} = {}) {
  const d = distance3(sunPos, occluderPos);
  const away = normalize3(sub3(occluderPos, sunPos));
  const denom = sunRadius - occluderRadius;

  // 锥顶距遮挡体的距离：length = d * r / (R - r)；R ≤ r（无本影）时退化为 0
  const length = d > EPS && denom > EPS ? (d * occluderRadius) / denom : 0;
  const apexPos = add3(occluderPos, scale3(away, length));

  const geometry = buildFrustumGeometry({
    r0: occluderRadius,
    r1: 0,
    segments,
    capStart,
    capEnd,
  });

  const modelMatrix = multiply4(
    translation4(occluderPos),
    multiply4(rotationFromYTo(away), scale4(1, length, 1))
  );

  return {
    geometry,
    modelMatrix,
    meta: {
      length,
      apexPos,
      radiusAtOccluder: occluderRadius,
      sunDistance: d,
      direction: away,
    },
  };
}

/**
 * 计算半影圆台（从遮挡体朝接收体方向扩张）的局部几何 + 世界模型矩阵。
 *
 * 距遮挡体 t 处半径 = r + (R + r) * t / d；length 取 (receiverPos - occluderPos)
 * 在背日方向上的投影（≤ 0 时退化为两点距离）。
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.sunPos
 * @param {number} options.sunRadius
 * @param {ArrayLike<number>} options.occluderPos
 * @param {number} options.occluderRadius
 * @param {ArrayLike<number>} options.receiverPos 接收体（例如地球）世界坐标
 * @param {number} [options.segments=64]
 * @param {boolean} [options.capStart=false] 遮挡体处端盖
 * @param {boolean} [options.capEnd=true] 接收体处端盖
 * @returns {{
 *   geometry: { positions: Float32Array, normals: Float32Array, indices: Uint16Array|Uint32Array },
 *   modelMatrix: Float32Array,
 *   meta: { radiusAtOccluder: number, radiusAtReceiver: number, length: number,
 *           sunDistance: number, direction: number[] }
 * }}
 */
export function computePenumbra({
  sunPos,
  sunRadius,
  occluderPos,
  occluderRadius,
  receiverPos,
  segments = 64,
  capStart = false,
  capEnd = true,
} = {}) {
  const d = distance3(sunPos, occluderPos);
  const away = normalize3(sub3(occluderPos, sunPos));
  const rel = sub3(receiverPos, occluderPos);

  let length = dot3(rel, away); // 接收体在背日方向上的投影响应
  if (!(length > 0)) length = length3(rel); // 退化（接收体在太阳一侧）时用直线距离

  const radiusAtReceiver =
    d > EPS ? occluderRadius + ((sunRadius + occluderRadius) * length) / d : occluderRadius;

  const geometry = buildFrustumGeometry({
    r0: occluderRadius,
    r1: radiusAtReceiver,
    segments,
    capStart,
    capEnd,
  });

  const modelMatrix = multiply4(
    translation4(occluderPos),
    multiply4(rotationFromYTo(away), scale4(1, length, 1))
  );

  return {
    geometry,
    modelMatrix,
    meta: {
      radiusAtOccluder: occluderRadius,
      radiusAtReceiver,
      length,
      sunDistance: d,
      direction: away,
    },
  };
}

/**
 * 组合「月球遮挡太阳 → 日食阴影落到地球」的本影与半影。
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.sunPos
 * @param {number} options.sunRadius
 * @param {ArrayLike<number>} options.earthPos 地球世界坐标
 * @param {number} options.earthRadius 地球半径
 * @param {ArrayLike<number>} options.moonPos 月球世界坐标（遮挡体）
 * @param {number} options.moonRadius 月球半径
 * @param {ArrayLike<number>} [options.receiverPos] 接收体位置（默认 earthPos）
 * @param {number} [options.segments=64]
 * @returns {{
 *   umbra: ReturnType<typeof computeUmbra>,
 *   penumbra: ReturnType<typeof computePenumbra>
 * }}
 */
export function eclipseGeometry({
  sunPos,
  sunRadius,
  earthPos,
  earthRadius,
  moonPos,
  moonRadius,
  receiverPos,
  segments = 64,
} = {}) {
  const receiver = receiverPos || earthPos;
  const umbra = computeUmbra({
    sunPos,
    sunRadius,
    occluderPos: moonPos,
    occluderRadius: moonRadius,
    segments,
  });
  const penumbra = computePenumbra({
    sunPos,
    sunRadius,
    occluderPos: moonPos,
    occluderRadius: moonRadius,
    receiverPos: receiver,
    segments,
  });
  // earthRadius 目前不参与阴影锥构造（本影由日、月半径决定），保留参数以统一调用签名。
  void earthRadius;
  return { umbra, penumbra };
}

/* ------------------------------------------------------------------ *
 * 食类型判定
 * ------------------------------------------------------------------ */

/**
 * 由日、地、月的几何关系判定日食 / 月食 / 无食，并给出中文描述。
 *
 * 判定思路（只依赖几何量，不做天文历表计算）：
 * - 定义以地球为顶点的「太阳方向」与「月球方向」，elongationDeg 为二者夹角（度）：
 *   ≈ 0° 表示新月（日食候选），≈ 180° 表示满月（月食候选）。
 * - moonSunMoonAngleDeg 为以月球为顶点、看太阳与地球的夹角（度）：
 *   日食时月球在日地之间 → ≈ 180°；月食时地球在日月之间 → ≈ 0°。
 * - 日食：月球位于地球朝向太阳的一侧，且日、月视圆面有重叠
 *   （角距 < 太阳视半径 + 月球视半径）→ type = 'solar'；
 *   月球视半径 > 太阳视半径且完全遮住 → isTotal；
 *   太阳视半径 > 月球视半径且月球完全落在日面内 → 日环食（isAnnular）；
 *   否则为日偏食（isPartial）。
 * - 月食：月球位于地球背日侧，且与地影轴线垂直距离小于该处半影半径 + 月球半径
 *   → type = 'lunar'；完全进入本影 → isTotal；部分进入本影 → isPartial；
 *   仅进入半影 → isPenumbral。
 *
 * @param {object} options
 * @param {ArrayLike<number>} options.sunPos
 * @param {ArrayLike<number>} options.earthPos
 * @param {ArrayLike<number>} options.moonPos
 * @param {number} options.sunRadius
 * @param {number} options.earthRadius
 * @param {number} options.moonRadius
 * @returns {{
 *   type: 'solar'|'lunar'|'none',
 *   elongationDeg: number,
 *   moonSunMoonAngleDeg: number,
 *   isTotal: boolean,
 *   isPartial: boolean,
 *   isAnnular: boolean,
 *   isPenumbral: boolean,
 *   kind: 'total'|'annular'|'partial'|'penumbral'|'none',
 *   sunAngularRadiusDeg: number,
 *   moonAngularRadiusDeg: number,
 *   description: string
 * }}
 */
export function eclipseType({
  sunPos,
  earthPos,
  moonPos,
  sunRadius,
  earthRadius,
  moonRadius,
} = {}) {
  const dSE = distance3(sunPos, earthPos);
  const dEM = distance3(earthPos, moonPos);

  const sunFromEarth = normalize3(sub3(sunPos, earthPos));
  const moonFromEarth = normalize3(sub3(moonPos, earthPos));

  const elongation = Math.acos(clamp(dot3(sunFromEarth, moonFromEarth), -1, 1));
  const elongationDeg = elongation * RAD_TO_DEG;
  const moonSunMoonAngleDeg = angleAtVertex(moonPos, sunPos, earthPos) * RAD_TO_DEG;

  // 视半径（从地球看）：sin ρ = 半径 / 距离（clamp 到 [0,1] 防止异常输入产生 NaN）
  const sunAngularRadius = Math.asin(clamp(sunRadius / Math.max(dSE, EPS), 0, 1));
  const moonAngularRadius = Math.asin(clamp(moonRadius / Math.max(dEM, EPS), 0, 1));

  const result = {
    type: /** @type {'solar'|'lunar'|'none'} */ ('none'),
    elongationDeg,
    moonSunMoonAngleDeg,
    isTotal: false,
    isPartial: false,
    isAnnular: false,
    isPenumbral: false,
    kind: /** @type {'total'|'annular'|'partial'|'penumbral'|'none'} */ ('none'),
    sunAngularRadiusDeg: sunAngularRadius * RAD_TO_DEG,
    moonAngularRadiusDeg: moonAngularRadius * RAD_TO_DEG,
    description: '无食：太阳、地球、月球未接近共线',
  };

  // 月球相对地球在太阳方向上的投影：> 0 表示月球在日地之间（日食候选）
  const moonTowardSun = dot3(sub3(moonPos, earthPos), sunFromEarth);

  if (moonTowardSun > 0) {
    // ---------------- 日食候选 ----------------
    const separation = elongation; // 地球看日、月的角距
    const overlap = separation < sunAngularRadius + moonAngularRadius;
    if (overlap) {
      const total = moonAngularRadius >= sunAngularRadius && separation <= moonAngularRadius - sunAngularRadius;
      const annular = sunAngularRadius > moonAngularRadius && separation < sunAngularRadius - moonAngularRadius;
      result.type = 'solar';
      result.isTotal = total;
      result.isAnnular = annular;
      result.isPartial = !total && !annular;
      result.kind = total ? 'total' : annular ? 'annular' : 'partial';
      result.description = total
        ? '日全食：月球本影扫过地球表面'
        : annular
          ? '日环食：月球距离较远，只遮住太阳中心，留下明亮光环'
          : '日偏食：月球只遮挡住太阳圆面的一部分';
      return result;
    }
    return result;
  }

  // ---------------- 月食候选 ----------------
  const antiSun = scale3(sunFromEarth, -1);
  const relMoon = sub3(moonPos, earthPos);
  const axisDist = dot3(relMoon, antiSun); // 沿地影轴线（背日方向）到地球的距离
  if (!(axisDist > 0)) return result;

  // 月球到地影轴线的垂直距离
  const perp = sub3(relMoon, scale3(antiSun, axisDist));
  const perpDist = length3(perp);

  // 地影在该距离处的半径：本影随距离收敛，半影随距离扩张
  const t = axisDist / Math.max(dSE, EPS);
  const umbraRadius = earthRadius - (sunRadius - earthRadius) * t;
  const penumbraRadius = earthRadius + (sunRadius + earthRadius) * t;

  const inUmbraTotal = perpDist + moonRadius < umbraRadius;
  const inUmbraPartial = !inUmbraTotal && perpDist < umbraRadius + moonRadius;
  const inPenumbra = perpDist < penumbraRadius + moonRadius;

  if (inUmbraTotal || inUmbraPartial || inPenumbra) {
    result.type = 'lunar';
    result.isTotal = inUmbraTotal;
    result.isPartial = inUmbraPartial;
    result.isPenumbral = inPenumbra && !inUmbraTotal && !inUmbraPartial;
    result.kind = inUmbraTotal ? 'total' : inUmbraPartial ? 'partial' : 'penumbral';
    result.description = inUmbraTotal
      ? '月全食：月球完全进入地球本影，呈暗红色'
      : inUmbraPartial
        ? '月偏食：月球一部分进入地球本影，出现缺角'
        : '半影月食：月球只进入地球半影，亮度略微变暗';
  }
  return result;
}
