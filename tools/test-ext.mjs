/**
 * tools/test-ext.mjs —— AP2 选做扩展算法模块的 Node 单元测试（零依赖）
 *
 * 运行：node tools/test-ext.mjs
 * 约定：矩阵列主序 Float32Array(16)；点变换 p' = M * [x, y, z, 1]。
 * 容差：默认 1e-4；失败以非零码退出，全绿退出码 0。
 *
 * 覆盖：
 *  1. 虚拟轨迹球：projectToSphere 单位化/连续性、Z 轴 90° 拖动、正交性/det、reset、
 *     四元数工具（quatToMatrix 与 rotateZ 90° 一致、乘法顺序）。
 *  2. 环带几何：数组长度、半径/法线/UV、索引范围、三角形数、从 +Y 俯视逆时针绕序。
 *  3. 小行星带：同种子确定性、a 范围、动画后半径与 y 的包络、数组长度、RNG。
 *  4. 日食阴影：本影锥顶/长度公式、modelMatrix 映射后截面半径、半影扩张公式、
 *     共线时的 solar / lunar 判定、-Y 方向旋转无奇异。
 */

import {
  projectToSphere,
  VirtualTrackball,
  quatIdentity,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatToMatrix,
} from '../src/trackball.js';
import {
  buildRingGeometry,
  ringVertexCount,
  ringTriangleCount,
  ringIndexCount,
} from '../src/rings.js';
import {
  createAsteroidBelt,
  updateAsteroidPositions,
  mulberry32,
} from '../src/asteroid-belt.js';
import {
  buildFrustumGeometry,
  buildConeMesh,
  computeUmbra,
  computePenumbra,
  eclipseGeometry,
  eclipseType,
} from '../src/eclipse.js';

/* ------------------------------------------------------------------ *
 * 轻量断言框架
 * ------------------------------------------------------------------ */

const TOL = 1e-4;
let checkCount = 0;
let failureCount = 0;
let sectionStartCheck = 0;
let sectionStartFailure = 0;

function section(title) {
  sectionStartCheck = checkCount;
  sectionStartFailure = failureCount;
  console.log(`\n== ${title} ==`);
}

function sectionEnd() {
  const passed = checkCount - sectionStartCheck;
  if (failureCount === sectionStartFailure) console.log(`  ✓ ${passed} 项检查通过`);
  else console.log(`  ✗ 本节出现失败（本节 ${passed} 项检查）`);
}

function ok(cond, label) {
  checkCount += 1;
  if (!cond) {
    failureCount += 1;
    console.error(`  ✗ ${label}`);
  }
}

function near(actual, expected, tol, label) {
  checkCount += 1;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    failureCount += 1;
    console.error(`  ✗ ${label} → 实际 ${actual}，期望 ${expected}（容差 ${tol}）`);
  }
}

function vecNear(actual, expected, tol, label) {
  checkCount += 1;
  const a = Array.from(actual);
  const e = Array.from(expected);
  const err = Math.max(...a.map((v, i) => Math.abs(v - e[i])));
  if (!Number.isFinite(err) || err > tol) {
    failureCount += 1;
    console.error(
      `  ✗ ${label} → 实际 [${a.map((v) => v.toFixed(6)).join(', ')}]，` +
        `期望 [${e.map((v) => v.toFixed(6)).join(', ')}]（误差 ${err}）`
    );
  }
}

/* ------------------------------------------------------------------ *
 * 矩阵辅助（测试侧独立实现，避免用被测代码自证）
 * ------------------------------------------------------------------ */

function identity4() {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** p' = M * [x, y, z, 1]（列主序） */
function applyMat4Vec3(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

/** 列主序 4x4 乘法：A * B（先应用 B） */
function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function det3(m) {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5])
  );
}

/** 返回旋转矩阵各项最大偏差（列长 1、两两正交、det=1、无平移分量）。 */
function rotationMatrixError(m) {
  const c0 = [m[0], m[1], m[2]];
  const c1 = [m[4], m[5], m[6]];
  const c2 = [m[8], m[9], m[10]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  let err = 0;
  err = Math.max(err, Math.abs(len(c0) - 1), Math.abs(len(c1) - 1), Math.abs(len(c2) - 1));
  err = Math.max(err, Math.abs(dot(c0, c1)), Math.abs(dot(c0, c2)), Math.abs(dot(c1, c2)));
  err = Math.max(err, Math.abs(det3(m) - 1));
  err = Math.max(err, Math.abs(m[3]), Math.abs(m[7]), Math.abs(m[11]));
  err = Math.max(err, Math.abs(m[12]), Math.abs(m[13]), Math.abs(m[14]), Math.abs(m[15] - 1));
  return err;
}

/** 三角形 (a,b,c) 的右手叉积 (+Y 分量)。 */
function triangleCrossY(positions, a, b, c) {
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const e1x = positions[b * 3] - ax;
  const e1y = positions[b * 3 + 1] - ay;
  const e1z = positions[b * 3 + 2] - az;
  const e2x = positions[c * 3] - ax;
  const e2y = positions[c * 3 + 1] - ay;
  const e2z = positions[c * 3 + 2] - az;
  // (e1 × e2).y = e1.z * e2.x - e1.x * e2.z
  return e1z * e2x - e1x * e2z;
}

/* ================================================================== *
 * 1. 虚拟轨迹球
 * ================================================================== */

section('1. 虚拟轨迹球（Virtual Trackball / 四元数）');

// ---- 1.1 projectToSphere：单位向量 + 边界连续 ----
{
  const probes = [
    [0, 0],
    [0.3, 0.2],
    [-0.45, 0.6],
    [0.7, 0.7],
    [0.99, 0.99],
    [-0.9, 0.4],
    [1.6, -2.3],
    [3, 4],
  ];
  let worst = 0;
  for (const [nx, ny] of probes) {
    const p = projectToSphere(nx, ny, 0.8);
    worst = Math.max(worst, Math.abs(Math.hypot(p[0], p[1], p[2]) - 1));
  }
  ok(worst < 1e-6, `projectToSphere 结果均为单位向量（最大长度偏差 ${worst.toExponential(2)}）`);
  near(projectToSphere(0, 0, 0.8)[2], 1, 1e-6, 'projectToSphere(0,0) 的 z = 1（球心正上方）');
  const boundary = Math.sqrt((0.8 * 0.8) / 2);
  const pMinus = projectToSphere(boundary - 1e-6, 0, 0.8);
  const pPlus = projectToSphere(boundary + 1e-6, 0, 0.8);
  near(
    Math.hypot(pMinus[0] - pPlus[0], pMinus[1] - pPlus[1], pMinus[2] - pPlus[2]),
    0,
    1e-4,
    '球面支 / 双曲抛物面支在 nx²+ny² = r²/2 处连续'
  );
}

// ---- 1.2 绕 Z 轴拖 90°：矩阵作用于 (1,0,0) ≈ (0,1,0) ----
{
  const tb = new VirtualTrackball({ radius: 0.8 });
  ok(!tb.isDragging, '新建轨迹球 isDragging = false');
  ok(
    rotationMatrixError(tb.getMatrix()) < 1e-6,
    '初始 getMatrix() 为单位矩阵（正交、det=1）'
  );

  // 说明：任何 NDC 点投影后的 z 分量都 > 0，有限距离的单次拖动角严格 < 90°。
  // 取球外极远处（nx = 1e6）时，双曲支的两个球面点分别趋于 (1,0,0) 与 (0,1,0)，
  // 叉积趋于 +Z、夹角趋于 90°，从而精确复现「绕 Z 轴拖 90°」这一约定。
  tb.beginDrag(1e6, 0);
  ok(tb.isDragging, 'beginDrag 后 isDragging = true');
  tb.drag(0, 1e6);
  const m = tb.getMatrix();
  ok(m instanceof Float32Array && m.length === 16, 'getMatrix() 返回 Float32Array(16)');
  vecNear(applyMat4Vec3(m, [1, 0, 0]), [0, 1, 0], TOL, '绕 Z 轴拖 90° 后 M·(1,0,0) ≈ (0,1,0)');
  vecNear(applyMat4Vec3(m, [0, 1, 0]), [-1, 0, 0], TOL, '绕 Z 轴拖 90° 后 M·(0,1,0) ≈ (-1,0,0)');
  vecNear(applyMat4Vec3(m, [0, 0, 1]), [0, 0, 1], TOL, '绕 Z 轴拖 90° 后 M·(0,0,1) ≈ (0,0,1)');
  const rotErr = rotationMatrixError(m);
  ok(rotErr < 1e-5, `90° 拖动累计矩阵正交且 det=1（最大偏差 ${rotErr.toExponential(2)}）`);

  tb.end();
  ok(!tb.isDragging, 'end() 后 isDragging = false');
  tb.reset();
  const identity = identity4();
  let resetErr = 0;
  const mr = tb.getMatrix();
  for (let i = 0; i < 16; i += 1) resetErr = Math.max(resetErr, Math.abs(mr[i] - identity[i]));
  ok(resetErr < 1e-9, 'reset() 后矩阵恢复为单位矩阵');
}

// ---- 1.3 常规拖动：轴 = cross(p0,p1)、角 = acos(dot)，把 p0 转到 p1 ----
{
  const tb = new VirtualTrackball({ radius: 0.8 });
  const n0 = [0.1, -0.2];
  const n1 = [0.45, 0.35];
  const p0 = projectToSphere(n0[0], n0[1], 0.8);
  const p1 = projectToSphere(n1[0], n1[1], 0.8);
  tb.beginDrag(n0[0], n0[1]);
  tb.drag(n1[0], n1[1]);
  const m = tb.getMatrix();
  vecNear(applyMat4Vec3(m, p0), p1, TOL, '拖拽增量旋转把球面点 p0 转到 p1');
  ok(rotationMatrixError(m) < 1e-5, '常规拖动后矩阵正交、det=1');
  // 返回的是副本，外部修改不影响内部状态
  m[0] = 123;
  ok(Math.abs(tb.getMatrix()[0]) < 1, 'getMatrix() 返回副本（外部修改不污染内部状态）');
}

// ---- 1.4 多次拖动累计仍严格正交（无漂移） ----
{
  const tb = new VirtualTrackball();
  tb.beginDrag(0.9, 0);
  for (let i = 0; i < 200; i += 1) {
    const a = (i * 0.137) % (Math.PI * 2);
    tb.drag(Math.cos(a) * 0.9, Math.sin(a) * 0.9);
  }
  const err = rotationMatrixError(tb.getMatrix());
  ok(err < 1e-5, `200 次拖动累计后矩阵仍正交、det≈1（最大偏差 ${err.toExponential(2)}）`);
  tb.end();
  ok(!tb.isDragging, '累计拖动 end() 后 isDragging = false');
}

// ---- 1.5 四元数工具 ----
{
  let qErr = 0;
  const mi = quatToMatrix(quatIdentity());
  const eye = identity4();
  for (let i = 0; i < 16; i += 1) qErr = Math.max(qErr, Math.abs(mi[i] - eye[i]));
  ok(qErr < 1e-9, 'quatToMatrix(quatIdentity()) = 单位矩阵');

  const mq = quatToMatrix(quatFromAxisAngle([0, 0, 1], Math.PI / 2));
  // 列主序 Rz(90°)：x → y，y → -x
  const rz90 = new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let zErr = 0;
  for (let i = 0; i < 16; i += 1) zErr = Math.max(zErr, Math.abs(mq[i] - rz90[i]));
  ok(zErr < 1e-6, 'quatToMatrix(quatFromAxisAngle([0,0,1], π/2)) 与 rotateZ 90° 矩阵一致');
  vecNear(applyMat4Vec3(mq, [1, 0, 0]), [0, 1, 0], TOL, '四元数 Z90 矩阵作用于 (1,0,0) ≈ (0,1,0)');

  // 四元数乘法语义：R(a⊗b) = R(a) * R(b)（先应用 b）
  const qa = quatFromAxisAngle([1, 0, 0], 0.5);
  const qb = quatFromAxisAngle([0, 1, 0], 0.9);
  const mComposed = quatToMatrix(quatMultiply(qa, qb));
  const mExpected = multiply4(quatToMatrix(qa), quatToMatrix(qb));
  let cErr = 0;
  for (let i = 0; i < 16; i += 1) cErr = Math.max(cErr, Math.abs(mComposed[i] - mExpected[i]));
  ok(cErr < 1e-6, 'quatMultiply(a,b) 对应 R(a)·R(b)（先应用 b 的乘法顺序）');

  const naive = quatMultiply(qb, qa);
  let orderDiff = 0;
  for (let i = 0; i < 16; i += 1) {
    orderDiff = Math.max(orderDiff, Math.abs(quatToMatrix(naive)[i] - mComposed[i]));
  }
  ok(orderDiff > 0.01, 'quatMultiply 顺序敏感（a⊗b ≠ b⊗a）');

  const qn = quatNormalize([1, 2, 3, 4]);
  near(Math.hypot(qn[0], qn[1], qn[2], qn[3]), 1, 1e-9, 'quatNormalize 输出单位四元数');
  ok(quatToMatrix(qn) instanceof Float32Array, 'quatToMatrix 返回 Float32Array');
}

sectionEnd();

/* ================================================================== *
 * 2. 环带几何
 * ================================================================== */

section('2. 环带几何（Saturn Rings）');

{
  const segments = 256;
  const innerRadius = 1.35;
  const outerRadius = 2.4;
  const ring = buildRingGeometry({ innerRadius, outerRadius, segments });
  const vertexCount = segments * 2;

  ok(ring.positions.length === vertexCount * 3, `positions 长度 = segments*2*3 = ${vertexCount * 3}`);
  ok(ring.normals.length === vertexCount * 3, `normals 长度 = segments*2*3 = ${vertexCount * 3}`);
  ok(ring.uvs.length === vertexCount * 2, `uvs 长度 = segments*2*2 = ${vertexCount * 2}`);
  ok(
    ring.indices instanceof Uint16Array || ring.indices instanceof Uint32Array,
    'indices 为 Uint16Array 或 Uint32Array'
  );
  ok(ring.innerRadius === innerRadius && ring.outerRadius === outerRadius, '返回 innerRadius / outerRadius');
  ok(ring.segments === segments, '返回 segments');
  ok(
    ringVertexCount(segments) === vertexCount &&
      ringTriangleCount(segments) === segments * 2 &&
      ringIndexCount(segments) === segments * 6,
    'ringVertexCount / ringTriangleCount / ringIndexCount 与几何一致'
  );

  let radiusOk = true;
  let yOk = true;
  let normalOk = true;
  let uvOk = true;
  let innerUOk = true;
  let outerUOk = true;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = ring.positions[i * 3];
    const y = ring.positions[i * 3 + 1];
    const z = ring.positions[i * 3 + 2];
    const r = Math.hypot(x, z);
    if (r < innerRadius - TOL || r > outerRadius + TOL) radiusOk = false;
    if (Math.abs(y) > 1e-6) yOk = false;
    if (
      ring.normals[i * 3] !== 0 ||
      ring.normals[i * 3 + 1] !== 1 ||
      ring.normals[i * 3 + 2] !== 0
    ) {
      normalOk = false;
    }
    const u = ring.uvs[i * 2];
    const v = ring.uvs[i * 2 + 1];
    if (!(u >= -1e-6 && u <= 1 + 1e-6) || Math.abs(v - 0.5) > 1e-6) uvOk = false;
    if (i % 2 === 0 && Math.abs(u) > 1e-6) innerUOk = false;
    if (i % 2 === 1 && Math.abs(u - 1) > 1e-6) outerUOk = false;
  }
  ok(radiusOk, '所有顶点的 √(x²+z²) 落在 [innerRadius, outerRadius] 内');
  ok(yOk, '所有顶点 y ≈ 0（环位于 XZ 平面）');
  ok(normalOk, '所有法线均为 (0,1,0)');
  ok(uvOk, 'uv：u ∈ [0,1]，v = 0.5');
  ok(innerUOk && outerUOk, 'uv：内缘 u=0、外缘 u=1');

  let maxIndex = -1;
  for (let i = 0; i < ring.indices.length; i += 1) maxIndex = Math.max(maxIndex, ring.indices[i]);
  ok(maxIndex < vertexCount, `索引最大下标 ${maxIndex} < 顶点数 ${vertexCount}`);
  ok(ring.indices.length === segments * 6, `索引数 = segments*6 = ${segments * 6}`);
  ok(ring.indices.length / 3 === segments * 2, `三角形数 = segments*2 = ${segments * 2}`);

  // 绕序：每三角形右手叉积的 +Y 分量 > 0 ⇔ 从 +Y 俯视为逆时针
  let windingOk = true;
  let minCrossY = Infinity;
  for (let t = 0; t < ring.indices.length; t += 3) {
    const crossY = triangleCrossY(
      ring.positions,
      ring.indices[t],
      ring.indices[t + 1],
      ring.indices[t + 2]
    );
    minCrossY = Math.min(minCrossY, crossY);
    if (!(crossY > 0)) windingOk = false;
  }
  ok(windingOk, `所有三角形从 +Y 俯视为逆时针（最小叉积 +Y 分量 ${minCrossY.toExponential(2)}）`);

  // 自定义参数（低分段）仍满足不变量
  const small = buildRingGeometry({ innerRadius: 1, outerRadius: 2, segments: 3 });
  let smallOk = small.positions.length === 3 * 2 * 3 && small.indices.length === 3 * 6;
  for (let t = 0; t < small.indices.length; t += 3) {
    if (
      !(
        triangleCrossY(small.positions, small.indices[t], small.indices[t + 1], small.indices[t + 2]) >
        0
      )
    ) {
      smallOk = false;
    }
  }
  ok(smallOk, 'segments=3 时长度正确且绕序仍为逆时针');
}

sectionEnd();

/* ================================================================== *
 * 3. 小行星带
 * ================================================================== */

section('3. 小行星带（Asteroid Belt）');

{
  const options = {
    count: 200,
    innerRadius: 44,
    outerRadius: 52,
    seed: 12345,
    thickness: 0.5,
    minSize: 0.04,
    maxSize: 0.18,
  };
  const beltA = createAsteroidBelt(options);
  const beltB = createAsteroidBelt(options);

  ok(beltA.count === options.count, 'count 与请求一致');
  ok(beltA.positions.length === options.count * 3, `positions 长度 = count*3 = ${options.count * 3}`);
  ok(beltA.sizes.length === options.count, 'sizes 长度 = count');
  const orbitKeys = ['a', 'phase', 'angularSpeed', 'inclination', 'node'];
  let orbitLenOk = true;
  for (const key of orbitKeys) orbitLenOk = orbitLenOk && beltA.orbit[key].length === options.count;
  ok(orbitLenOk, 'orbit 各数组长度 = count');

  // 同种子确定性（逐元素完全相等，含浮点位模式）
  let aEqual = true;
  let posEqual = true;
  for (let i = 0; i < options.count; i += 1) {
    if (beltA.orbit.a[i] !== beltB.orbit.a[i]) aEqual = false;
  }
  for (let i = 0; i < options.count * 3; i += 1) {
    if (beltA.positions[i] !== beltB.positions[i]) posEqual = false;
  }
  ok(aEqual, '同 seed 两次 createAsteroidBelt 的 orbit.a 逐元素相等');
  ok(posEqual, '同 seed 两次 createAsteroidBelt 的 positions 逐元素相等');

  // a 范围与其余参数范围
  let aRangeOk = true;
  let sizeRangeOk = true;
  let nodeRangeOk = true;
  let inclRangeOk = true;
  for (let i = 0; i < options.count; i += 1) {
    const a = beltA.orbit.a[i];
    if (!(a >= options.innerRadius && a <= options.outerRadius)) aRangeOk = false;
    const size = beltA.sizes[i];
    if (size < options.minSize - TOL || size > options.maxSize + TOL) sizeRangeOk = false;
    const node = beltA.orbit.node[i];
    if (node < 0 || node >= Math.PI * 2 + TOL) nodeRangeOk = false;
    if (Math.abs(beltA.orbit.inclination[i]) > 0.08 + TOL) inclRangeOk = false;
  }
  ok(aRangeOk, '所有 a ∈ [innerRadius, outerRadius]');
  ok(sizeRangeOk, '所有 sizes ∈ [minSize, maxSize]');
  ok(nodeRangeOk, '所有 node ∈ [0, 2π)');
  ok(inclRangeOk, '所有 inclination ∈ [-inclination, inclination]');
  ok(new Set(Array.from(beltA.orbit.a)).size > 10, 'a 不是常数（随机分布合理）');

  // mulberry32 自身确定性
  {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    const seq1 = [];
    const seq2 = [];
    let rangeOk = true;
    for (let i = 0; i < 16; i += 1) {
      const v1 = r1();
      seq1.push(v1);
      seq2.push(r2());
      if (!(v1 >= 0 && v1 < 1)) rangeOk = false;
    }
    ok(seq1.every((v, i) => v === seq2[i]), 'mulberry32：同 seed 产生相同序列');
    ok(rangeOk, 'mulberry32 输出 ∈ [0,1)');
    const r3 = mulberry32(8);
    ok(seq1.some((v) => v !== r3()), 'mulberry32：不同 seed 产生不同序列');
  }

  // t = 0 / 1 / 10 的动画位置包络
  {
    const count = options.count;
    const out = new Float32Array(count * 3);
    let radiusOk = true;
    let yOk = true;
    let minR = Infinity;
    let maxR = -Infinity;
    let maxAbsY = 0;
    for (const t of [0, 1, 10]) {
      const ret = updateAsteroidPositions(beltA, t, out);
      ok(ret === out, `t=${t} 时 updateAsteroidPositions 原地写入并返回 out`);
      for (let i = 0; i < count; i += 1) {
        const x = out[i * 3];
        const y = out[i * 3 + 1];
        const z = out[i * 3 + 2];
        const r = Math.hypot(x, z);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        maxAbsY = Math.max(maxAbsY, Math.abs(y));
        if (r < options.innerRadius - 1 || r > options.outerRadius + 1) radiusOk = false;
        if (Math.abs(y) > options.thickness + TOL) yOk = false;
      }
    }
    ok(
      radiusOk,
      `t=0/1/10 时 √(x²+z²) 均在 [inner-1, outer+1] 内（实测 ${minR.toFixed(3)}..${maxR.toFixed(3)}）`
    );
    ok(yOk, `t=0/1/10 时 |y| ≤ thickness + 容差（实测 max ${maxAbsY.toFixed(3)}）`);

    // 未提供 out 时应自动分配
    const allocated = updateAsteroidPositions(beltA, 2.5);
    ok(
      allocated instanceof Float32Array && allocated.length === count * 3,
      '未提供 out 时自动分配 Float32Array(count*3)'
    );

    // t = 0 的位置与建带时缓存的 positions 完全一致
    const zero = updateAsteroidPositions(beltA, 0);
    let zeroEqual = true;
    for (let i = 0; i < count * 3; i += 1) if (zero[i] !== beltA.positions[i]) zeroEqual = false;
    ok(zeroEqual, 'updateAsteroidPositions(t=0) 与 createAsteroidBelt 缓存的 positions 一致');
  }

  // 角速度 ∝ a^(-3/2)，且 spinScale 为整体倍率
  {
    const i0 = 0;
    const i1 = 1;
    const ratioA = beltA.orbit.a[i1] / beltA.orbit.a[i0];
    const ratioSpeed = beltA.orbit.angularSpeed[i1] / beltA.orbit.angularSpeed[i0];
    near(ratioSpeed, Math.pow(ratioA, -1.5), 1e-5, 'angularSpeed ∝ a^(-3/2)（开普勒第三定律）');

    const fast = createAsteroidBelt({ ...options, spinScale: 2 });
    let spinOk = true;
    for (let i = 0; i < options.count; i += 1) {
      if (Math.abs(fast.orbit.angularSpeed[i] - beltA.orbit.angularSpeed[i] * 2) > 1e-7) spinOk = false;
    }
    ok(spinOk, 'spinScale 为角速度整体倍率（×2 生效）');

    const staticBelt = createAsteroidBelt({ ...options, spinScale: 0 });
    const p0 = updateAsteroidPositions(staticBelt, 0);
    const p1 = updateAsteroidPositions(staticBelt, 42);
    let staticOk = true;
    for (let i = 0; i < options.count * 3; i += 1) if (p0[i] !== p1[i]) staticOk = false;
    ok(staticOk, 'spinScale = 0 时位置不随时间变化（静止）');
  }

  // 边界情况：count = 0
  {
    const empty = createAsteroidBelt({ count: 0 });
    ok(empty.count === 0 && empty.positions.length === 0, 'count=0 时数组为空且不崩溃');
    const outEq = updateAsteroidPositions(empty, 1, new Float32Array(0));
    ok(outEq.length === 0, 'count=0 时 update 正常返回空缓冲');
  }
}

sectionEnd();

/* ================================================================== *
 * 4. 日食阴影几何
 * ================================================================== */

section('4. 日食阴影几何（本影 / 半影 / 食类型）');

{
  const sunPos = [0, 0, 0];
  const sunRadius = 10;
  const moonPos = [30, 0, 0];
  const moonRadius = 0.3;
  const segments = 32;

  // ---- 4.1 本影锥 ----
  const expectedLength = (30 * 0.3) / (10 - 0.3);
  const umbra = computeUmbra({
    sunPos,
    sunRadius,
    occluderPos: moonPos,
    occluderRadius: moonRadius,
    segments,
  });
  ok(umbra.modelMatrix instanceof Float32Array && umbra.modelMatrix.length === 16, '本影 modelMatrix 为 Float32Array(16)');
  near(umbra.meta.length, expectedLength, TOL, '本影 length = d*r/(R-r)');
  vecNear(umbra.meta.apexPos, [30 + expectedLength, 0, 0], TOL, '本影锥顶 apexPos = 遮挡体 + 背日方向*length');
  vecNear(umbra.meta.direction, [1, 0, 0], TOL, '本影背日方向 = (1,0,0)');
  near(umbra.meta.radiusAtOccluder, moonRadius, TOL, '本影遮挡体处半径 = occluderRadius');

  {
    // 用 modelMatrix 变换 y=0 截面顶点，到遮挡体中心距离应 ≈ occluderRadius
    const g = umbra.geometry;
    let maxErr = 0;
    for (let i = 0; i < segments; i += 1) {
      // 侧面顶点布局：2i = 底面 (y=0)
      const idx = i * 2;
      const p = applyMat4Vec3(umbra.modelMatrix, [
        g.positions[idx * 3],
        0,
        g.positions[idx * 3 + 2],
      ]);
      const d = Math.hypot(p[0] - moonPos[0], p[1] - moonPos[1], p[2] - moonPos[2]);
      maxErr = Math.max(maxErr, Math.abs(d - moonRadius));
    }
    ok(maxErr < TOL, `经 modelMatrix 变换后 y=0 截面半径 ≈ 0.3（最大误差 ${maxErr.toExponential(2)}）`);
  }
  vecNear(
    applyMat4Vec3(umbra.modelMatrix, [0, 1, 0]),
    umbra.meta.apexPos,
    TOL,
    'modelMatrix 把局部 (0,1,0) 映射到锥顶 apexPos'
  );
  vecNear(
    applyMat4Vec3(umbra.modelMatrix, [0, 0.5, 0]),
    [30 + expectedLength * 0.5, 0, 0],
    TOL,
    'modelMatrix 的 +Y 轴映射为背日方向（长度按 S(1,length,1) 拉伸）'
  );

  // ---- 4.2 半影圆台 ----
  const receiverPos = [50, 0, 0];
  const expectedPenLength = 20;
  const expectedPenRadius = 0.3 + ((10 + 0.3) * expectedPenLength) / 30;
  const penumbra = computePenumbra({
    sunPos,
    sunRadius,
    occluderPos: moonPos,
    occluderRadius: moonRadius,
    receiverPos,
    segments,
  });
  near(penumbra.meta.length, expectedPenLength, TOL, '半影 length = 接收体在背日方向上的投影');
  near(
    penumbra.meta.radiusAtReceiver,
    expectedPenRadius,
    TOL,
    '半影 radiusAtReceiver = r + (R+r)*t/d'
  );
  near(penumbra.meta.radiusAtOccluder, moonRadius, TOL, '半影遮挡体处半径 = occluderRadius');
  {
    const g = penumbra.geometry;
    // 侧面索引 1 = i=0 的顶面顶点 (y=1, 半径 radiusAtReceiver)
    const top = [g.positions[1 * 3], g.positions[1 * 3 + 1], g.positions[1 * 3 + 2]];
    const p = applyMat4Vec3(penumbra.modelMatrix, top);
    const rel = [p[0] - moonPos[0], p[1] - moonPos[1], p[2] - moonPos[2]];
    const axial = rel[0]; // 背日方向 = +X
    const radial = Math.hypot(rel[1], rel[2]);
    near(axial, expectedPenLength, TOL, '半影 y=1 截面位于接收体垂直平面（轴向距离 = length）');
    near(radial, expectedPenRadius, TOL, '半影 y=1 截面半径 = radiusAtReceiver');
  }

  // ---- 4.3 eclipseGeometry 组合 ----
  {
    const combo = eclipseGeometry({
      sunPos,
      sunRadius,
      earthPos: [50, 0, 0],
      earthRadius: 0.5,
      moonPos,
      moonRadius,
      segments: 16,
    });
    ok(!!combo.umbra && !!combo.penumbra, 'eclipseGeometry 返回 { umbra, penumbra }');
    near(combo.umbra.meta.length, expectedLength, TOL, 'eclipseGeometry.umbra 长度公式一致');
    near(
      combo.penumbra.meta.radiusAtReceiver,
      expectedPenRadius,
      TOL,
      'eclipseGeometry.penumbra 默认以 earthPos 为接收体'
    );
  }

  // ---- 4.4 背日方向 = -Y 时旋转矩阵无奇异（叉积退化分支）----
  {
    const down = computeUmbra({
      sunPos: [0, 10, 0],
      sunRadius: 10,
      occluderPos: [0, 0, 0],
      occluderRadius: 0.3,
      segments: 8,
    });
    const expected = (10 * 0.3) / (10 - 0.3);
    near(down.meta.length, expected, TOL, '-Y 方向本影长度公式一致');
    vecNear(down.meta.apexPos, [0, -expected, 0], TOL, '-Y 方向本影锥顶位置正确');
    vecNear(
      applyMat4Vec3(down.modelMatrix, [0, 1, 0]),
      down.meta.apexPos,
      TOL,
      '背日方向为 -Y 时 modelMatrix 的 +Y 轴正确映射（无除零/NaN）'
    );
    let finite = true;
    for (let i = 0; i < 16; i += 1) if (!Number.isFinite(down.modelMatrix[i])) finite = false;
    ok(finite, '背日方向为 -Y 时 modelMatrix 全部有限');
  }

  // ---- 4.5 圆锥 / 圆台几何 ----
  {
    const cone = buildConeMesh({ segments: 16 });
    ok(cone.positions.length === cone.vertexCount * 3, 'buildConeMesh positions 长度 = vertexCount*3');
    ok(
      cone.indices.length === 16 * 3 + 16 * 3,
      'buildConeMesh 索引 = 侧面三角形 + y=0 端盖三角形'
    );
    // 「等价 buildFrustumGeometry({ r0: 1, r1: 0 })」：逐元素比对
    const coneRef = buildFrustumGeometry({ r0: 1, r1: 0, segments: 16 });
    let coneEquivalent =
      coneRef.positions.length === cone.positions.length &&
      coneRef.indices.length === cone.indices.length;
    if (coneEquivalent) {
      for (let i = 0; i < cone.positions.length; i += 1) {
        if (coneRef.positions[i] !== cone.positions[i]) coneEquivalent = false;
      }
      for (let i = 0; i < cone.indices.length; i += 1) {
        if (coneRef.indices[i] !== cone.indices[i]) coneEquivalent = false;
      }
    }
    ok(coneEquivalent, 'buildConeMesh 等价于 buildFrustumGeometry({r0:1, r1:0})');
    let coneOk = true;
    for (let i = 0; i < cone.vertexCount; i += 1) {
      const y = cone.positions[i * 3 + 1];
      if (y < -1e-6 || y > 1 + 1e-6) coneOk = false;
    }
    let maxIdx = -1;
    for (let i = 0; i < cone.indices.length; i += 1) maxIdx = Math.max(maxIdx, cone.indices[i]);
    ok(coneOk, '圆锥所有顶点 y ∈ [0,1]');
    ok(maxIdx < cone.vertexCount, '圆锥索引范围合法');

    const frustum = buildFrustumGeometry({ r0: 2, r1: 1, segments: 8 });
    let ringRadiiOk = true;
    for (let i = 0; i < 8; i += 1) {
      const bottom = Math.hypot(frustum.positions[i * 2 * 3], frustum.positions[i * 2 * 3 + 2]);
      const top = Math.hypot(
        frustum.positions[(i * 2 + 1) * 3],
        frustum.positions[(i * 2 + 1) * 3 + 2]
      );
      if (Math.abs(bottom - 2) > TOL || Math.abs(top - 1) > TOL) ringRadiiOk = false;
    }
    ok(ringRadiiOk, 'buildFrustumGeometry：y=0 半径 r0、y=1 半径 r1');
  }

  // ---- 4.6 eclipseType：共线 solar / lunar / none ----
  {
    const common = { sunPos, sunRadius, earthRadius: 0.5, moonRadius };
    const solar = eclipseType({ ...common, earthPos: [50, 0, 0], moonPos: [30, 0, 0] });
    ok(solar.type === 'solar', `日、月、地共线且月球在中间 → type = solar（实际 ${solar.type}）`);
    near(solar.elongationDeg, 0, TOL, '日食共线时 elongationDeg ≈ 0');
    near(solar.moonSunMoonAngleDeg, 180, TOL, '日食共线时 moonSunMoonAngleDeg ≈ 180');
    ok(typeof solar.description === 'string' && solar.description.includes('日'), '日食描述为中文且含「日」');
    ok(typeof solar.isTotal === 'boolean' && typeof solar.isPartial === 'boolean', 'isTotal / isPartial 为布尔值');

    const lunar = eclipseType({ ...common, earthPos: [30, 0, 0], moonPos: [50, 0, 0] });
    ok(lunar.type === 'lunar', `日、地、月共线且地球在中间 → type = lunar（实际 ${lunar.type}）`);
    near(lunar.elongationDeg, 180, TOL, '月食共线时 elongationDeg ≈ 180');
    near(lunar.moonSunMoonAngleDeg, 0, TOL, '月食共线时 moonSunMoonAngleDeg ≈ 0');
    ok(typeof lunar.description === 'string' && lunar.description.includes('月'), '月食描述为中文且含「月」');

    const none = eclipseType({ ...common, earthPos: [50, 0, 0], moonPos: [50, 0, 30] });
    ok(none.type === 'none', `日月地位相不共线 → type = none（实际 ${none.type}）`);
    ok(none.description.includes('无食'), '无食描述为中文且含「无食」');
    ok(
      !solar.isTotal && solar.isAnnular && solar.kind === 'annular',
      '该几何下为日环食（月球视半径小于太阳视半径），isTotal=false、isAnnular=true'
    );
  }
}

sectionEnd();

/* ================================================================== *
 * 汇总
 * ================================================================== */

console.log('\n========================================');
console.log(`总计：${checkCount} 项检查，${failureCount} 项失败`);
if (failureCount > 0) {
  console.error('测试失败 ✗');
  process.exit(1);
}
console.log('全部通过 ✓');
process.exit(0);
