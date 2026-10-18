/**
 * geometry.js —— 程序化几何生成（球面 / 圆环线 / 广告牌四边形 / 星空）
 * ------------------------------------------------------------------
 * 顶点属性约定：
 *   position: vec3
 *   normal  : vec3
 *   uv      : vec2
 *   alpha   : float（仅 flat 程序使用，可选）
 * ------------------------------------------------------------------
 */

/**
 * 生成 UV 球（经度-纬度细分）。
 * 顶点 v = 0 对应南极、v = 1 对应北极；u = 0..1 绕经度一圈。
 *
 * 配合 gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true) 使用
 * （纹理图片"北在上"，翻转后 v=1 采样到图像顶部，正好是北极）。
 *
 * @param {number} latBands  纬度带数
 * @param {number} longBands 经度带数
 */
export function createSphere(latBands = 40, longBands = 80) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let lat = 0; lat <= latBands; lat++) {
    const theta = (lat * Math.PI) / latBands;   // 0 = 北极
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let lon = 0; lon <= longBands; lon++) {
      const phi = (lon * 2 * Math.PI) / longBands;
      const x = Math.cos(phi) * sinTheta;
      const y = cosTheta;
      const z = Math.sin(phi) * sinTheta;

      // 单位球：位置即法线
      positions.push(x, y, z);
      normals.push(x, y, z);
      // u 沿经度；v 从南极 0 到北极 1
      uvs.push(lon / longBands, 1 - lat / latBands);
    }
  }

  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon;
      const second = first + longBands + 1;

      // 两个三角形，从球外看为逆时针绕序（配合 gl.CULL_FACE / gl.BACK）。
      // 注意：绕序必须与"法线朝外"一致，否则背面剔除会剔掉外表面、渲染内表面，
      // 表现为"光照方向整体反向"（面向太阳的一面反而变黑）。
      indices.push(first, first + 1, second);
      indices.push(second, first + 1, second + 1);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
    vertexCount: positions.length / 3,
    indexCount: indices.length,
  };
}

/**
 * 单位圆（半径 1，XZ 平面，y = 0），返回 LINES 图元所需的两点一段列表。
 * 画轨道线时用 uModel 里的 scale 把半径放大即可，非常省内存。
 */
export function createUnitCircleLines(segments = 192) {
  const positions = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    positions.push(
      Math.cos(a0), 0, -Math.sin(a0),
      Math.cos(a1), 0, -Math.sin(a1)
    );
  }
  return {
    positions: new Float32Array(positions),
    vertexCount: positions.length / 3,
  };
}

/** 单位四边形（XY 平面，[-1,1]²，z=0），供广告牌辉光使用 */
export function createQuad() {
  return {
    positions: new Float32Array([
      -1, -1, 0,
       1, -1, 0,
       1,  1, 0,
      -1,  1, 0,
    ]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    indexCount: 6,
  };
}

/** 简单可复现随机数（mulberry32），保证星空/小行星每次一致 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 星空点云：均匀分布在球壳上（内含随机半径抖动），
 * 用 POINTS 渲染。返回 positions 与逐点亮度（作为 alpha 属性）。
 */
export function createStarfield(count, radiusMin, radiusMax, seed = 7) {
  const rand = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const alphas = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 球面均匀采样：z 均匀 + 方位角均匀
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const r = radiusMin + (radiusMax - radiusMin) * rand();
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    positions[i * 3 + 0] = r * s * Math.cos(phi);
    positions[i * 3 + 1] = r * z;
    positions[i * 3 + 2] = r * s * Math.sin(phi);
    alphas[i] = 0.35 + rand() * 0.65;
  }

  return { positions, alphas, count };
}
