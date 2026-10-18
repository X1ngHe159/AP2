/**
 * gl-utils.js —— WebGL 2.0 资源封装
 * ------------------------------------------------------------------
 * 教材的 Common/ 工具库负责上下文与着色器编译（webgl-utils.js / initShaders.js），
 * 本文件在其之上补齐 WebGL2 的 VAO、纹理、网格上传等样板代码。
 * ------------------------------------------------------------------
 */

const MV = window.MV;

/** 用教材的 initShaders.createProgram 建程序，并一次性收集所有 uniform 位置 */
export function createProgram(gl, vsSource, fsSource) {
  const program = window.initShaders.createProgram(gl, vsSource, fsSource);

  const uniforms = {};
  const nUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nUniforms; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  return { program, uniforms };
}

/** 顶点属性在几何数据里的布局（按字段名自动识别） */
const ATTRIBUTE_LAYOUT = [
  { name: 'aPosition', field: 'positions', size: 3 },
  { name: 'aNormal', field: 'normals', size: 3 },
  { name: 'aTexCoord', field: 'uvs', size: 2 },
  { name: 'aAlpha', field: 'alphas', size: 1 },
];

/**
 * 把 CPU 几何数据上传成 VAO。
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program  用于查询 attribute location 的程序
 * @param {object} geometry       含 positions/normals/uvs/alphas/indices 的对象
 * @param {object} options        { mode, usage }
 * @returns {object} mesh 句柄
 */
export function makeMesh(gl, program, geometry, options = {}) {
  const { mode = gl.TRIANGLES, usage = gl.STATIC_DRAW } = options;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const buffers = {};
  let vertexCount = 0;

  for (const attr of ATTRIBUTE_LAYOUT) {
    let data = geometry[attr.field];
    if (!data && attr.field === 'alphas') {
      // flat 程序声明了 aAlpha；没有提供时补 1.0，避免属性默认值 0 导致全透明
      const count = geometry.vertexCount || (geometry.positions ? geometry.positions.length / 3 : 0);
      if (!count) continue;
      data = new Float32Array(count).fill(1);
    }
    if (!data) continue;

    const location = gl.getAttribLocation(program, attr.name);
    if (location < 0) continue;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, attr.size, gl.FLOAT, false, 0, 0);

    buffers[attr.field] = buffer;
    if (attr.field === 'positions') vertexCount = data.length / 3;
  }

  let indexCount = 0;
  let indexType = 0;
  if (geometry.indices) {
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, usage);
    indexCount = geometry.indices.length;
    indexType = geometry.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    buffers.indices = indexBuffer;
  }

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    vao,
    buffers,
    mode,
    indexCount,
    indexType,
    vertexCount,
    drawCount: indexCount || vertexCount,
  };
}

/** 绘制一个 mesh（自动选择 drawElements / drawArrays） */
export function drawMesh(gl, mesh) {
  gl.bindVertexArray(mesh.vao);
  if (mesh.indexCount > 0) {
    gl.drawElements(mesh.mode, mesh.indexCount, mesh.indexType, 0);
  } else {
    gl.drawArrays(mesh.mode, 0, mesh.vertexCount);
  }
  gl.bindVertexArray(null);
}

/** 动态更新 position 缓冲（小行星带每帧动画用） */
export function updateBuffer(gl, buffer, data) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

/** 从 <img> 创建 2D 纹理（含 mipmap） */
export function createTexture(gl, image, options = {}) {
  const {
    flipY = true,
    repeatS = true,
    minFilter = gl.LINEAR_MIPMAP_LINEAR,
    magFilter = gl.LINEAR,
  } = options;

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  // 关键：图片的第 0 行是顶部（北），而 WebGL 纹理坐标 v=0 在底部。
  // 打开 UNPACK_FLIP_Y_WEBGL 后上传时把图片上下翻转，于是
  // v=0 → 图像底部（南极），v=1 → 图像顶部（北极），与球面 UV 一致。
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

  // WebGL2 支持非 2 的幂尺寸纹理的 mipmap，不必再缩放到 2 的幂
  gl.generateMipmap(gl.TEXTURE_2D);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatS ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  // 纬度方向必须 clamp，否则极点会采样到另一半球
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

/** 绑定纹理到指定纹理单元 */
export function bindTexture(gl, texture, unit = 0) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

/** 小工具：把 [x,y,z] 归一化 */
export function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export { MV };
