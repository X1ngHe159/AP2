/**
 * test-geometry.mjs —— 球体几何回归测试（node 直接运行，无第三方依赖）
 * ------------------------------------------------------------------
 * 重点守护一个真实踩过的坑：球体三角形绕序必须与"顶点法线朝外"一致。
 * 若绕序写反，gl.CULL_FACE 会剔掉外表面、渲染内表面，
 * 现象就是"光照方向整体反向"（面向太阳的一面反而变暗）。
 *
 * 用法：node tools/test-geometry.mjs
 */
import { createSphere, createUnitCircleLines, createQuad } from '../src/geometry.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function v(g, i) {
  return [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
}
function n(g, i) {
  return [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
}

const sphere = createSphere(24, 48);

check('球体顶点数正确', sphere.vertexCount === (24 + 1) * (48 + 1));
check('球体索引数正确', sphere.indexCount === 24 * 48 * 6);
check('索引不越界', Array.from(sphere.indices).every((i) => i >= 0 && i < sphere.vertexCount));

// 法线必须是单位向量（= 顶点位置，单位球外法线）
let normalOk = true;
let maxNormalErr = 0;
for (let i = 0; i < sphere.vertexCount; i++) {
  const p = v(sphere, i);
  const nn = n(sphere, i);
  const len = Math.hypot(nn[0], nn[1], nn[2]);
  maxNormalErr = Math.max(maxNormalErr, Math.abs(len - 1));
  if (Math.abs(p[0] - nn[0]) > 1e-6 || Math.abs(p[1] - nn[1]) > 1e-6 || Math.abs(p[2] - nn[2]) > 1e-6) {
    normalOk = false;
  }
  if (Math.abs(len - 1) > 1e-5) normalOk = false;
}
check('顶点法线是朝外单位向量（= 顶点位置）', normalOk, `最大长度误差 ${maxNormalErr.toExponential(2)}`);

// 所有非退化三角形的面法线必须与顶点法线同向（朝外，逆时针绕序）
let degenerate = 0;
let inward = 0;
const idx = sphere.indices;
for (let t = 0; t < idx.length; t += 3) {
  const a = v(sphere, idx[t]);
  const b = v(sphere, idx[t + 1]);
  const c = v(sphere, idx[t + 2]);
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const fn = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const len = Math.hypot(fn[0], fn[1], fn[2]);
  if (len < 1e-9) { degenerate += 1; continue; }   // 极点处的退化三角形
  const centroid = [
    (a[0] + b[0] + c[0]) / 3,
    (a[1] + b[1] + c[1]) / 3,
    (a[2] + b[2] + c[2]) / 3,
  ];
  const dot = (fn[0] * centroid[0] + fn[1] * centroid[1] + fn[2] * centroid[2]) / len;
  if (dot <= 1e-6) inward += 1;
}
check('没有朝内的三角形（绕序与法线一致）', inward === 0, `朝内 ${inward} 个`);
check('退化三角形只出现在两极', degenerate === 2 * 48, `退化 ${degenerate} 个`);

// 单位圆：LINES 顶点偶数、都在 XZ 平面、半径 1
const circle = createUnitCircleLines(64);
check('单位圆线顶点数为偶数', circle.vertexCount % 2 === 0);
check('单位圆所有点在 XZ 平面且半径为 1',
  Array.from({ length: circle.vertexCount }, (_, i) => {
    const x = circle.positions[i * 3];
    const y = circle.positions[i * 3 + 1];
    const z = circle.positions[i * 3 + 2];
    return Math.abs(y) < 1e-6 && Math.abs(Math.hypot(x, z) - 1) < 1e-6;
  }).every(Boolean));

// 广告牌四边形：4 顶点 / 2 三角形 / uv 覆盖 [0,1]
const quad = createQuad();
check('四边形顶点与索引数正确', quad.vertexCount === 4 && quad.indexCount === 6);

console.log('========================================');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exit(1);
}
console.log('全部测试通过。');
