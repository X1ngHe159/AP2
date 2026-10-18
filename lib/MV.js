/**
 * lib/MV.js —— 教材（Angel & Shreiner《Interactive Computer Graphics》第 8 版）
 *              Common/MV.js 风格的矩阵 / 向量工具库（经典脚本版）。
 *
 * 约定（与课程 AP2 应用代码一致）：
 *   - 矩阵和向量都是普通 JavaScript 数组（也接受 Float32Array 作为输入）；
 *   - 矩阵按 WebGL 要求的「列主序」存储：
 *         第 0 列 = m[0..3]，第 1 列 = m[4..7]，第 2 列 = m[8..11]，第 3 列 = m[12..15]。
 *     用 (行, 列) 记号表示，M(r, c) 存放在 m[c * 4 + r]（mat3 为 m[c * 3 + r]）。
 *   - 变换作用于列向量：p' = M * p；mult(A, B) = A * B，含义是「先作用 B，再作用 A」。
 *   - 所有函数都返回新数组，绝不原地修改传入的矩阵 / 向量。
 *   - 本文件是经典脚本（IIFE 立即执行函数），只在 window 上挂一个 MV 命名空间，
 *     不使用模块语法，因此可以被普通 <script src="lib/MV.js"> 直接加载。
 *
 * 本文件中的公式均按教材第 4 章（变换）的推导写出，注释给出了每一列元素的来历。
 */
(function (global) {
  'use strict';

  /* =========================================================================
   * 一、基础工具
   * ========================================================================= */

  /** 判断是否为“下标访问 + length”的数组式对象（普通数组或 TypedArray）。 */
  function isArrayLike(v) {
    return v !== null && typeof v === 'object' && typeof v.length === 'number';
  }

  /** 把任意数组式对象复制成新的普通数组（保证不会与入参共享内存）。 */
  function copyArray(v) {
    var out = new Array(v.length);
    for (var i = 0; i < v.length; i++) {
      out[i] = v[i];
    }
    return out;
  }

  /** 读取三个分量：既支持 vec3([x, y, z])，也支持 (x, y, z)。 */
  function toXYZ(a, b, c) {
    if (isArrayLike(a) && b === undefined && c === undefined) {
      return [a[0], a[1], a[2]];
    }
    return [a, b, c];
  }

  /* =========================================================================
   * 二、向量与矩阵构造函数
   * ========================================================================= */

  /**
   * vec3(x, y, z) -> [x, y, z]
   * 也支持 vec3([x, y, z]) 复制，缺省分量为 0。
   */
  function vec3(x, y, z) {
    if (isArrayLike(x)) {
      return [x[0] || 0, x[1] || 0, x[2] || 0];
    }
    return [x === undefined ? 0 : x,
            y === undefined ? 0 : y,
            z === undefined ? 0 : z];
  }

  /**
   * vec4(x, y, z, w) -> [x, y, z, w]
   * 便利重载：vec4([x, y, z]) -> [x, y, z, 1]；vec4([x, y, z, w]) -> 复制。
   * （图形学里点的 w 默认为 1，方向的 w 默认为 0，本函数默认取 1。）
   */
  function vec4(x, y, z, w) {
    if (isArrayLike(x)) {
      return [x[0] || 0, x[1] || 0, x[2] || 0,
              x[3] === undefined ? 1 : x[3]];
    }
    if (x === undefined) {
      return [0, 0, 0, 1];
    }
    return [x, y === undefined ? 0 : y, z === undefined ? 0 : z,
            w === undefined ? 1 : w];
  }

  /**
   * mat4() -> 4x4 单位矩阵（列主序，长度 16）
   * mat4(m) -> 复制 m（便于写“先克隆再修改”的代码，本库内部并不依赖它）。
   */
  function mat4(m) {
    if (m === undefined) {
      return [
        1, 0, 0, 0, // 第 0 列
        0, 1, 0, 0, // 第 1 列
        0, 0, 1, 0, // 第 2 列
        0, 0, 0, 1  // 第 3 列
      ];
    }
    if (!isArrayLike(m) || m.length !== 16) {
      throw new TypeError('MV.mat4: 参数必须是长度为 16 的矩阵');
    }
    return copyArray(m);
  }

  /**
   * mat3() -> 3x3 单位矩阵（列主序，长度 9）
   * mat3(m) -> 若 m 是 3x3 则复制；若 m 是 4x4 则取左上角 3x3（法线矩阵常用）。
   */
  function mat3(m) {
    if (m === undefined) {
      return [
        1, 0, 0, // 第 0 列
        0, 1, 0, // 第 1 列
        0, 0, 1  // 第 2 列
      ];
    }
    if (!isArrayLike(m)) {
      throw new TypeError('MV.mat3: 参数必须是 3x3 或 4x4 矩阵');
    }
    if (m.length === 9) {
      return copyArray(m);
    }
    if (m.length === 16) {
      // 4x4 的列主序为 m[c*4 + r]，左上 3x3 取 r,c ∈ {0,1,2}
      return [m[0], m[1], m[2],
              m[4], m[5], m[6],
              m[8], m[9], m[10]];
    }
    throw new TypeError('MV.mat3: 参数必须是 3x3 或 4x4 矩阵');
  }

  /* =========================================================================
   * 三、矩阵乘法
   * ========================================================================= */

  /**
   * mult4(A, B) = A * B（均为列主序 4x4）
   *
   *   (A*B)(r, c) = Σ_k A(r, k) * B(k, c)
   *
   * 列主序下 A(r, k) = A[k * 4 + r]，B(k, c) = B[c * 4 + k]，
   * 因此结果第 c 列第 r 行的元素为：
   *   out[c*4 + r] = Σ_k A[k*4 + r] * B[c*4 + k]
   */
  function mult4(a, b) {
    var out = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  /** mult3(A, B) = A * B（列主序 3x3），公式与 mult4 相同，只是阶数为 3。 */
  function mult3(a, b) {
    var out = new Array(9);
    for (var c = 0; c < 3; c++) {
      for (var r = 0; r < 3; r++) {
        out[c * 3 + r] =
          a[0 * 3 + r] * b[c * 3 + 0] +
          a[1 * 3 + r] * b[c * 3 + 1] +
          a[2 * 3 + r] * b[c * 3 + 2];
      }
    }
    return out;
  }

  /** mult(A, B) = A * B（先作用 B，再作用 A），返回新矩阵。 */
  function mult(a, b) {
    if (!isArrayLike(a) || !isArrayLike(b)) {
      throw new TypeError('MV.mult: 两个参数都必须是矩阵');
    }
    if (a.length === 16 && b.length === 16) {
      return mult4(a, b);
    }
    if (a.length === 9 && b.length === 9) {
      return mult3(a, b);
    }
    throw new TypeError('MV.mult: 只支持 4x4 与 4x4、3x3 与 3x3 相乘');
  }

  /* =========================================================================
   * 四、三种基本变换：平移、旋转、缩放
   *     每个变换都有两种调用形式：
   *       translate(tx, ty, tz)        -> T
   *       translate(m, tx, ty, tz)     -> m * T
   *     rotate / scale 同理。
   * ========================================================================= */

  /**
   * 平移矩阵 T（列主序）：
   *
   *       | 1 0 0 tx |            第 0 列 = (1, 0, 0, 0)
   *   T = | 0 1 0 ty |            第 1 列 = (0, 1, 0, 0)
   *       | 0 0 1 tz |            第 2 列 = (0, 0, 1, 0)
   *       | 0 0 0 1  |            第 3 列 = (tx, ty, tz, 1)
   *
   * 对点 p = (x, y, z, 1) 有 T * p = (x + tx, y + ty, z + tz, 1)。
   * 注意列主序数组中平移量位于 m[12], m[13], m[14]（即第 3 列）。
   *
   * 带矩阵形式 m * T 只改变结果的第 3 列：
   *   (m*T) 的平移列 = m 的前三列线性组合出的 tx,ty,tz 再加上 m 原有的平移列。
   */
  function translate(a, b, c, d) {
    var m, tx, ty, tz, out;

    if (arguments.length === 3) {
      // translate(tx, ty, tz)
      m = mat4();
      tx = a; ty = b; tz = c;
    } else if (arguments.length === 4) {
      // translate(m, tx, ty, tz)
      m = a; tx = b; ty = c; tz = d;
    } else if (arguments.length === 1 && isArrayLike(a)) {
      // 便利形式：translate([tx, ty, tz])
      m = mat4();
      tx = a[0]; ty = a[1]; tz = a[2];
    } else if (arguments.length === 2 && isArrayLike(b)) {
      // 便利形式：translate(m, [tx, ty, tz])
      m = a; tx = b[0]; ty = b[1]; tz = b[2];
    } else {
      throw new Error('MV.translate: 用法为 translate(tx,ty,tz) 或 translate(m,tx,ty,tz)');
    }

    if (!isArrayLike(m) || m.length !== 16) {
      throw new TypeError('MV.translate: 第一个参数必须是 4x4 矩阵');
    }

    // out = m * T，T 只有第 3 列非单位，故只需重算第 3 列：
    //   out[12 + r] = Σ_k m[k*4 + r] * T(k, 3) = m[0*4+r]*tx + m[1*4+r]*ty + m[2*4+r]*tz + m[3*4+r]*1
    out = copyArray(m);
    out[12] = m[0] * tx + m[4] * ty + m[8] * tz + m[12];
    out[13] = m[1] * tx + m[5] * ty + m[9] * tz + m[13];
    out[14] = m[2] * tx + m[6] * ty + m[10] * tz + m[14];
    out[15] = m[3] * tx + m[7] * ty + m[11] * tz + m[15];
    return out;
  }

  /**
   * 绕任意轴旋转 angleDeg 度的旋转矩阵 R（列主序 4x4）。
   *
   * 推导：设单位轴 n = (x, y, z)，c = cosθ，s = sinθ，t = 1 - c。
   * 罗德里格斯（Rodrigues）公式给出 3x3 旋转矩阵：
   *
   *       | t*x*x + c     t*x*y - s*z   t*x*z + s*y |
   *   R = | t*x*y + s*z   t*y*y + c     t*y*z - s*x |
   *       | t*x*z - s*y   t*y*z + s*x   t*z*z + c   |
   *
   * 把 R 嵌入 4x4 的上左 3x3，第 4 行 / 列取 (0,0,0,1)，即得到齐次旋转矩阵。
   * 列主序下：
   *   第 0 列 = (R00, R10, R20, 0)
   *   第 1 列 = (R01, R11, R21, 0)
   *   第 2 列 = (R02, R12, R22, 0)
   *   第 3 列 = (0, 0, 0, 1)
   *
   * 轴会先被归一化，因此传入 (0,0,2) 与 (0,0,1) 等价（“不正交化”也能工作）。
   * 带矩阵形式 m * R 表示“在 m 的局部坐标系里再旋转”。
   */
  function rotate(a, b, c) {
    var m, angleDeg, axis;

    if (arguments.length === 2) {
      // rotate(angleDeg, axis)
      angleDeg = a;
      axis = b;
    } else if (arguments.length === 3) {
      // rotate(m, angleDeg, axis)
      m = a;
      angleDeg = b;
      axis = c;
    } else {
      throw new Error('MV.rotate: 用法为 rotate(angleDeg, axis) 或 rotate(m, angleDeg, axis)');
    }

    if (!isArrayLike(axis) || axis.length < 3) {
      throw new TypeError('MV.rotate: axis 必须是 [x, y, z] 数组');
    }
    if (m !== undefined && (!isArrayLike(m) || m.length !== 16)) {
      throw new TypeError('MV.rotate: 第一个参数必须是 4x4 矩阵');
    }

    var x = axis[0], y = axis[1], z = axis[2];
    var len = Math.sqrt(x * x + y * y + z * z);
    if (len === 0) {
      throw new Error('MV.rotate: 旋转轴不能是零向量');
    }
    x /= len; y /= len; z /= len;

    var rad = angleDeg * Math.PI / 180;
    var s = Math.sin(rad);
    var c0 = Math.cos(rad);
    var t = 1 - c0;

    var R = mat4();
    // 第 0 列
    R[0] = x * x * t + c0;
    R[1] = y * x * t + z * s;
    R[2] = z * x * t - y * s;
    // 第 1 列
    R[4] = x * y * t - z * s;
    R[5] = y * y * t + c0;
    R[6] = z * y * t + x * s;
    // 第 2 列
    R[8] = x * z * t + y * s;
    R[9] = y * z * t - x * s;
    R[10] = z * z * t + c0;
    // 第 3 列保持单位矩阵的 (0,0,0,1)

    return (m === undefined) ? R : mult4(m, R);
  }

  /**
   * 缩放矩阵 S（列主序）：
   *
   *       | sx 0  0  0 |           第 0 列 = (sx, 0, 0, 0)
   *   S = | 0  sy 0  0 |           第 1 列 = (0, sy, 0, 0)
   *       | 0  0  sz 0 |           第 2 列 = (0, 0, sz, 0)
   *       | 0  0  0  1 |           第 3 列 = (0, 0, 0, 1)
   *
   * 带矩阵形式 m * S：相当于对 m 的三列分别乘以 sx, sy, sz
   * （因为 (m*S) 的第 c 列 = m 的第 c 列 * S(c,c)），平移列不变。
   * 注意：对法线必须使用 normalMatrix(m) 而不是左上 3x3 直接乘。
   */
  function scale(a, b, c, d) {
    var m, sx, sy, sz, out;

    if (arguments.length === 3) {
      // scale(sx, sy, sz)
      m = mat4();
      sx = a; sy = b; sz = c;
    } else if (arguments.length === 4) {
      // scale(m, sx, sy, sz)
      m = a; sx = b; sy = c; sz = d;
    } else if (arguments.length === 1 && isArrayLike(a)) {
      // 便利形式：scale([sx, sy, sz])
      m = mat4();
      sx = a[0]; sy = a[1]; sz = a[2];
    } else if (arguments.length === 2 && isArrayLike(b)) {
      // 便利形式：scale(m, [sx, sy, sz])
      m = a; sx = b[0]; sy = b[1]; sz = b[2];
    } else {
      throw new Error('MV.scale: 用法为 scale(sx,sy,sz) 或 scale(m,sx,sy,sz)');
    }

    if (!isArrayLike(m) || m.length !== 16) {
      throw new TypeError('MV.scale: 第一个参数必须是 4x4 矩阵');
    }

    out = copyArray(m);
    out[0] *= sx; out[1] *= sx; out[2] *= sx; out[3] *= sx;   // 第 0 列整体乘 sx
    out[4] *= sy; out[5] *= sy; out[6] *= sy; out[7] *= sy;   // 第 1 列整体乘 sy
    out[8] *= sz; out[9] *= sz; out[10] *= sz; out[11] *= sz; // 第 2 列整体乘 sz
    // 第 3 列（齐次坐标 / 平移列）保持不变
    return out;
  }

  /* =========================================================================
   * 五、投影矩阵与视图矩阵
   * ========================================================================= */

  /**
   * perspective(fovyDeg, aspect, near, far) -> 4x4 透视投影矩阵（列主序）
   *
   * 记 f = 1 / tan(fovy/2)（fovy 为垂直视场角，单位为度），n = near，fFar = far。
   *
   *        | f/aspect  0   0                         0 |
   *   P =  | 0         f   0                         0 |
   *        | 0         0   (far+near)/(near-far)     2*far*near/(near-far) |
   *        | 0         0   -1                        0 |
   *
   * 推导要点：视图空间相机看向 -z；透视除法由 w' = -z_eye 完成，
   * 近平面 z_eye = -near 映射到 NDC z = -1，远平面 z_eye = -far 映射到 NDC z = +1。
   *
   * 列主序存储位置：
   *   m[0] = f/aspect, m[5] = f,
   *   m[10] = (far+near)/(near-far), m[11] = -1,
   *   m[14] = 2*far*near/(near-far)。
   */
  function perspective(fovyDeg, aspect, near, far) {
    if (!(aspect > 0)) {
      throw new Error('MV.perspective: aspect 必须为正数');
    }
    if (!(near > 0)) {
      throw new Error('MV.perspective: near 必须为正数');
    }
    if (!(far > near)) {
      throw new Error('MV.perspective: far 必须大于 near');
    }

    var f = 1 / Math.tan((fovyDeg * Math.PI / 180) / 2);
    var m = mat4();

    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    m[15] = 0;

    return m;
  }

  /**
   * ortho(left, right, bottom, top, near, far) -> 4x4 正交投影矩阵（列主序）
   *
   * 正交投影没有透视除法，w' 恒为 1。它把视图空间的长方体
   * [left,right] × [bottom,top] × [-near,-far] 线性映射到 NDC 立方体 [-1,1]³：
   *
   *        | 2/(r-l)   0         0         -(r+l)/(r-l) |
   *   O =  | 0         2/(t-b)   0         -(t+b)/(t-b) |
   *        | 0         0        -2/(f-n)   -(f+n)/(f-n) |
   *        | 0         0         0          1           |
   *
   * 注意 z 方向因相机看向 -z 而要取负号：z_eye = -near -> NDC -1，z_eye = -far -> NDC +1。
   * 列主序存储位置：m[0]、m[5]、m[10]，平移列 m[12]、m[13]、m[14]。
   */
  function ortho(left, right, bottom, top, near, far) {
    if (right === left) {
      throw new Error('MV.ortho: left 不能等于 right');
    }
    if (top === bottom) {
      throw new Error('MV.ortho: bottom 不能等于 top');
    }
    if (far === near) {
      throw new Error('MV.ortho: near 不能等于 far');
    }

    var rl = right - left;
    var tb = top - bottom;
    var fn = far - near;
    var m = mat4();

    m[0] = 2 / rl;
    m[5] = 2 / tb;
    m[10] = -2 / fn;
    m[12] = -(right + left) / rl;
    m[13] = -(top + bottom) / tb;
    m[14] = -(far + near) / fn;
    m[15] = 1;

    return m;
  }

  /**
   * lookAt(eye, at, up) -> 4x4 视图矩阵（列主序）
   *
   * 构造相机坐标系：相机位于 eye，看向 at，up 为近似“上方向”。
   *   观察方向的反向 n = normalize(eye - at)   // 相机坐标系的 +z（从 at 指向 eye）
   *   右方向       u = normalize(cross(up, n)) // 相机坐标系的 +x
   *   上方向       v = cross(n, u)             // 相机坐标系的 +y
   *
   * 视图矩阵 = 先平移到原点，再旋转到相机坐标轴：
   *
   *        | ux uy uz  -dot(u, eye) |
   *   V =  | vx vy vz  -dot(v, eye) |
   *        | nx ny nz  -dot(n, eye) |
   *        | 0  0  0    1           |
   *
   * 对列向量 p 有 V * eye = 0；例如 eye 在 +z 轴上看向原点时，原点映射为 (0,0,-|eye|)。
   * 列主序存储：第 0 列 = (ux, vx, nx, 0)，第 1 列 = (uy, vy, ny, 0)，
   *             第 2 列 = (uz, vz, nz, 0)，第 3 列 = (-dot(u,eye), -dot(v,eye), -dot(n,eye), 1)。
   */
  function lookAt(eye, at, up) {
    if (!isArrayLike(eye) || !isArrayLike(at) || !isArrayLike(up)) {
      throw new TypeError('MV.lookAt: eye / at / up 都必须是 [x, y, z] 数组');
    }

    var n = normalize(subtract(eye, at));
    var u = cross(up, n);
    if (length(u) < 1e-12) {
      throw new Error('MV.lookAt: up 与视线方向平行，无法建立视图矩阵');
    }
    u = normalize(u);
    var v = cross(n, u);

    var m = mat4();
    // 第 0 列
    m[0] = u[0];
    m[1] = v[0];
    m[2] = n[0];
    // 第 1 列
    m[4] = u[1];
    m[5] = v[1];
    m[6] = n[1];
    // 第 2 列
    m[8] = u[2];
    m[9] = v[2];
    m[10] = n[2];
    // 第 3 列：把 eye 平移到原点
    m[12] = -dot(u, eye);
    m[13] = -dot(v, eye);
    m[14] = -dot(n, eye);

    return m;
  }

  /* =========================================================================
   * 六、矩阵的转置、求逆与法线矩阵
   * ========================================================================= */

  /** transpose(m) -> m 的转置，返回新矩阵（支持 4x4 与 3x3）。 */
  function transpose(m) {
    if (!isArrayLike(m)) {
      throw new TypeError('MV.transpose: 参数必须是矩阵');
    }
    if (m.length === 16) {
      var out4 = new Array(16);
      for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
          // 转置后 (r,c) 位置 = 原矩阵 (c,r) = m[r * 4 + c]
          out4[c * 4 + r] = m[r * 4 + c];
        }
      }
      return out4;
    }
    if (m.length === 9) {
      var out3 = new Array(9);
      for (var c3 = 0; c3 < 3; c3++) {
        for (var r3 = 0; r3 < 3; r3++) {
          out3[c3 * 3 + r3] = m[r3 * 3 + c3];
        }
      }
      return out3;
    }
    throw new TypeError('MV.transpose: 只支持 4x4 与 3x3 矩阵');
  }

  /**
   * inverse3(m) -> 3x3 逆矩阵（列主序）。
   *
   * 按行主序记 m 的元素 a(r,c)，则
   *   a(r,c) = m[c * 3 + r]。
   * 逆矩阵 = 伴随矩阵 / 行列式，其中伴随矩阵的每个元素是代数余子式（带符号的余子式）。
   * 这里直接写出 2x2 余子式展开的结果，避免循环带来的间接性。
   */
  function inverse3(m) {
    var a00 = m[0], a01 = m[3], a02 = m[6];
    var a10 = m[1], a11 = m[4], a12 = m[7];
    var a20 = m[2], a21 = m[5], a22 = m[8];

    var det = a00 * (a11 * a22 - a12 * a21)
            - a01 * (a10 * a22 - a12 * a20)
            + a02 * (a10 * a21 - a11 * a20);

    if (Math.abs(det) < 1e-12) {
      throw new Error('MV.inverse: 3x3 矩阵不可逆（行列式接近 0）');
    }
    var invDet = 1 / det;

    // 行主序的逆矩阵元素（伴随矩阵转置 / det）
    var i00 = (a11 * a22 - a12 * a21) * invDet;
    var i01 = (a02 * a21 - a01 * a22) * invDet;
    var i02 = (a01 * a12 - a02 * a11) * invDet;
    var i10 = (a12 * a20 - a10 * a22) * invDet;
    var i11 = (a00 * a22 - a02 * a20) * invDet;
    var i12 = (a02 * a10 - a00 * a12) * invDet;
    var i20 = (a10 * a21 - a11 * a20) * invDet;
    var i21 = (a01 * a20 - a00 * a21) * invDet;
    var i22 = (a00 * a11 - a01 * a10) * invDet;

    // 按列主序写回：第 c 列 = (i(0,c), i(1,c), i(2,c))
    return [i00, i10, i20,
            i01, i11, i21,
            i02, i12, i22];
  }

  /**
   * cross4(u, v, w) -> 4 维“叉积”向量 c，满足 c · a = det(以 a,u,v,w 为列的 4x4 矩阵)。
   *
   * c 的第 i 个分量 = (-1)^i × (删掉第 i 行后，由 u,v,w 三列组成的 3x3 余子式)。
   * 用 4x4 逆矩阵的推导（按列展开）会用到它。
   */
  function cross4(u, v, w) {
    var c = new Array(4);
    for (var i = 0; i < 4; i++) {
      // 其余三行（保持原顺序，用于计算余子式）
      var r0, r1, r2;
      if (i === 0) { r0 = 1; r1 = 2; r2 = 3; }
      else if (i === 1) { r0 = 0; r1 = 2; r2 = 3; }
      else if (i === 2) { r0 = 0; r1 = 1; r2 = 3; }
      else { r0 = 0; r1 = 1; r2 = 2; }

      // 3x3 矩阵的三行分别是 (u[r], v[r], w[r])，按第一行展开求行列式
      var minor =
          u[r0] * (v[r1] * w[r2] - v[r2] * w[r1])
        - v[r0] * (u[r1] * w[r2] - u[r2] * w[r1])
        + w[r0] * (u[r1] * v[r2] - u[r2] * v[r1]);

      // 与代数余子式的符号 (-1)^i 相乘
      c[i] = (i % 2 === 0) ? minor : -minor;
    }
    return c;
  }

  /**
   * inverse4(m) -> 4x4 逆矩阵（列主序），按列向量做伴随矩阵推导：
   *
   * 设 A = [a0 | a1 | a2 | a3]（a_k 为第 k 列），令
   *   r0 =  cross4(a1, a2, a3)
   *   r1 = -cross4(a0, a2, a3)
   *   r2 =  cross4(a0, a1, a3)
   *   r3 = -cross4(a0, a1, a2)
   * 则 det = r0 · a0，且 A⁻¹ 的第 k 行 = r_k / det。
   * 验证：第 k 行与第 j 列点乘 = det(A 的第 j 列被第 k 列替换) / det = δ(k,j)。
   * 最后按列主序写回：out[c * 4 + r] = (A⁻¹)(r, c) = r_c[r] / det。
   */
  function inverse4(m) {
    var a0 = [m[0], m[1], m[2], m[3]];
    var a1 = [m[4], m[5], m[6], m[7]];
    var a2 = [m[8], m[9], m[10], m[11]];
    var a3 = [m[12], m[13], m[14], m[15]];

    var r0 = cross4(a1, a2, a3);
    var r1 = cross4(a0, a2, a3);
    var r2 = cross4(a0, a1, a3);
    var r3 = cross4(a0, a1, a2);

    // 交替符号：r1、r3 取负
    for (var i = 0; i < 4; i++) {
      r1[i] = -r1[i];
      r3[i] = -r3[i];
    }

    // det = r0 · a0（展开第一列）
    var det = r0[0] * a0[0] + r0[1] * a0[1] + r0[2] * a0[2] + r0[3] * a0[3];
    if (Math.abs(det) < 1e-12) {
      throw new Error('MV.inverse: 4x4 矩阵不可逆（行列式接近 0）');
    }
    var invDet = 1 / det;

    var rows = [r0, r1, r2, r3];
    var out = new Array(16);
    for (var row = 0; row < 4; row++) {
      for (var col = 0; col < 4; col++) {
        out[col * 4 + row] = rows[row][col] * invDet;
      }
    }
    return out;
  }

  /** inverse(m) -> m 的逆矩阵，返回新矩阵（支持 4x4 与 3x3）。 */
  function inverse(m) {
    if (!isArrayLike(m)) {
      throw new TypeError('MV.inverse: 参数必须是矩阵');
    }
    if (m.length === 16) {
      return inverse4(m);
    }
    if (m.length === 9) {
      return inverse3(m);
    }
    throw new TypeError('MV.inverse: 只支持 4x4 与 3x3 矩阵');
  }

  /**
   * normalMatrix(m) -> 左上 3x3 的逆转置（mat3，列主序长度 9）。
   *
   * 为什么需要它：若模型矩阵 M 含非等比缩放，法线不能直接用 M 的 3x3 部分变换，
   * 否则法线会与表面不再垂直。正确做法是 N = (M₃₋₃⁻¹)ᵀ。
   * 推导：切向量 t 满足 t' = M·t，法线 n 需满足 n'·t' = 0，
   *       取 n' = (M⁻¹)ᵀ·n 即可：((M⁻¹)ᵀn)ᵀ(Mt) = nᵀM⁻¹Mt = nᵀt = 0。
   * 本函数只取 m 的左上 3x3（忽略平移），返回 mat3。
   */
  function normalMatrix(m) {
    if (!isArrayLike(m)) {
      throw new TypeError('MV.normalMatrix: 参数必须是 3x3 或 4x4 矩阵');
    }
    var a;
    if (m.length === 16) {
      a = [m[0], m[1], m[2],
           m[4], m[5], m[6],
           m[8], m[9], m[10]];
    } else if (m.length === 9) {
      a = copyArray(m);
    } else {
      throw new TypeError('MV.normalMatrix: 参数必须是 3x3 或 4x4 矩阵');
    }
    // N = (M₃₋₃⁻¹)ᵀ = transpose(inverse(M₃₋₃))
    return transpose(inverse3(a));
  }

  /* =========================================================================
   * 七、上传给 WebGL 的辅助函数
   * ========================================================================= */

  /**
   * flatten(m) -> Float32Array。
   * WebGL 的 uniformMatrix4fv / uniformMatrix3fv 需要 Float32Array。
   * 若入参本身已经是 Float32Array，直接返回（不复制）；否则新建副本。
   * 注意：列主序数组可以直接上传，WebGL 默认 transpose = false 正是指“列主序”。
   */
  function flatten(m) {
    if (m instanceof Float32Array) {
      return m;
    }
    if (m instanceof Float64Array) {
      return new Float32Array(m);
    }
    if (!isArrayLike(m)) {
      throw new TypeError('MV.flatten: 参数必须是数组或 TypedArray');
    }
    return new Float32Array(m);
  }

  /* =========================================================================
   * 八、向量运算
   * ========================================================================= */

  /** cross(a, b) -> 三维叉积 a × b。 */
  function cross(a, b) {
    if (!isArrayLike(a) || !isArrayLike(b) || a.length < 3 || b.length < 3) {
      throw new TypeError('MV.cross: 参数必须是三维向量');
    }
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  /** normalize(v) -> 与 v 同方向、长度为 1 的新向量；零向量返回同长度的零向量。 */
  function normalize(v) {
    if (!isArrayLike(v)) {
      throw new TypeError('MV.normalize: 参数必须是向量');
    }
    var out = copyArray(v);
    var sum = 0;
    for (var i = 0; i < out.length; i++) {
      sum += out[i] * out[i];
    }
    var len = Math.sqrt(sum);
    if (len === 0) {
      return out; // 零向量没有方向，返回零向量而不是 NaN
    }
    for (var j = 0; j < out.length; j++) {
      out[j] /= len;
    }
    return out;
  }

  /** dot(a, b) -> 点积（要求两向量维度相同）。 */
  function dot(a, b) {
    if (!isArrayLike(a) || !isArrayLike(b) || a.length !== b.length) {
      throw new TypeError('MV.dot: 两个参数必须是维度相同的向量');
    }
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  /** subtract(a, b) -> a - b（逐分量）。 */
  function subtract(a, b) {
    if (!isArrayLike(a) || !isArrayLike(b) || a.length !== b.length) {
      throw new TypeError('MV.subtract: 两个参数必须是维度相同的向量');
    }
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      out[i] = a[i] - b[i];
    }
    return out;
  }

  /** add(a, b) -> a + b（逐分量）。 */
  function add(a, b) {
    if (!isArrayLike(a) || !isArrayLike(b) || a.length !== b.length) {
      throw new TypeError('MV.add: 两个参数必须是维度相同的向量');
    }
    var out = new Array(a.length);
    for (var i = 0; i < a.length; i++) {
      out[i] = a[i] + b[i];
    }
    return out;
  }

  /** length(v) -> 向量长度（欧几里得范数）。 */
  function length(v) {
    if (!isArrayLike(v)) {
      throw new TypeError('MV.length: 参数必须是向量');
    }
    var sum = 0;
    for (var i = 0; i < v.length; i++) {
      sum += v[i] * v[i];
    }
    return Math.sqrt(sum);
  }

  /**
   * equal(a, b) -> 两个数组在容差 eps（默认 1e-6）内逐分量相等则返回 true。
   * 浮点矩阵比较几乎总要用容差，因此这里不采用严格 ===。
   */
  function equal(a, b, eps) {
    var tol = (eps === undefined) ? 1e-6 : eps;
    if (!isArrayLike(a) || !isArrayLike(b) || a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > tol) {
        return false;
      }
    }
    return true;
  }

  /* =========================================================================
   * 九、角度 / 弧度换算
   * ========================================================================= */

  /** radians(deg) -> 弧度。 */
  function radians(deg) {
    return deg * Math.PI / 180;
  }

  /** degrees(rad) -> 角度。 */
  function degrees(rad) {
    return rad * 180 / Math.PI;
  }

  /* =========================================================================
   * 十、导出（只挂一个 window.MV，避免污染其它全局名）
   * ========================================================================= */

  var MV = {
    // 构造
    mat4: mat4,
    mat3: mat3,
    vec3: vec3,
    vec4: vec4,
    // 乘法
    mult: mult,
    // 基本变换
    translate: translate,
    rotate: rotate,
    scale: scale,
    // 投影 / 视图
    perspective: perspective,
    ortho: ortho,
    lookAt: lookAt,
    // 矩阵辅助
    normalMatrix: normalMatrix,
    flatten: flatten,
    transpose: transpose,
    inverse: inverse,
    // 向量
    cross: cross,
    normalize: normalize,
    dot: dot,
    subtract: subtract,
    add: add,
    length: length,
    equal: equal,
    // 角度
    radians: radians,
    degrees: degrees
  };

  global.MV = MV;
})(typeof window !== 'undefined' ? window : globalThis);
