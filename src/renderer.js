/**
 * renderer.js —— 场景绘制（WebGL 2.0）
 * ------------------------------------------------------------------
 * 五个部分：
 *   1) 星空点云（flat 程序，POINTS）
 *   2) 天体球面（body 程序：纹理 + 太阳方向光；太阳用 emissive 自发光）
 *   3) 土星环（ring 程序：径向 alpha 纹理 + 双面混合）
 *   4) 小行星带（flat 程序，POINTS，逐帧更新位置）
 *   5) 轨道线 / 日食阴影锥 / 太阳辉光
 * ------------------------------------------------------------------
 */

import {
  createProgram,
  makeMesh,
  drawMesh,
  updateBuffer,
  createTexture,
  bindTexture,
} from './gl-utils.js';
import { createSphere, createUnitCircleLines, createQuad, createStarfield } from './geometry.js';
import {
  BODY_VS, BODY_FS,
  FLAT_VS, FLAT_FS,
  RING_VS, RING_FS,
  GLOW_VS, GLOW_FS,
} from './shaders.js';
import { billboardMatrix } from './transforms.js';
import { buildRingGeometry } from './rings.js';
import { createAsteroidBelt, updateAsteroidPositions } from './asteroid-belt.js';

const MV = window.MV;

export class Renderer {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {object} config
   * @param {Record<string, HTMLImageElement>} images
   */
  constructor(gl, config, images) {
    this.gl = gl;
    this.config = config;

    /* ---------------- 着色器程序 ---------------- */
    this.bodyProgram = createProgram(gl, BODY_VS, BODY_FS);
    this.flatProgram = createProgram(gl, FLAT_VS, FLAT_FS);
    this.ringProgram = createProgram(gl, RING_VS, RING_FS);
    this.glowProgram = createProgram(gl, GLOW_VS, GLOW_FS);

    /* ---------------- 纹理 ---------------- */
    this.textures = {};
    for (const [key, image] of Object.entries(images)) {
      this.textures[key] = createTexture(gl, image, { flipY: true });
    }

    /* ---------------- 几何 ---------------- */
    const R = config.render;
    this.sphere = makeMesh(
      gl, this.bodyProgram.program,
      createSphere(R.sphereLatBands, R.sphereLongBands),
      { mode: gl.TRIANGLES }
    );

    this.circle = makeMesh(
      gl, this.flatProgram.program,
      createUnitCircleLines(R.orbitLineSegments),
      { mode: gl.LINES }
    );

    this.starfield = createStarfield(
      R.starCount, R.starRadiusMin, R.starRadiusMax, 20240518
    );
    this.stars = makeMesh(gl, this.flatProgram.program, {
      positions: this.starfield.positions,
      alphas: this.starfield.alphas,
      vertexCount: this.starfield.count,
    }, { mode: gl.POINTS });

    const bright = createStarfield(R.brightStarCount, R.starRadiusMin, R.starRadiusMax, 987654321);
    this.brightStars = makeMesh(gl, this.flatProgram.program, {
      positions: bright.positions,
      alphas: bright.alphas,
      vertexCount: bright.count,
    }, { mode: gl.POINTS });

    /* ---------------- 土星环（选做 E1） ---------------- */
    const ringCfg = config.planets.find((p) => p.ring).ring;
    this.ringCfg = ringCfg;
    const ringGeometry = buildRingGeometry({
      innerRadius: ringCfg.innerRadius,
      outerRadius: ringCfg.outerRadius,
      segments: 256,
    });
    this.ringMesh = makeMesh(gl, this.ringProgram.program, ringGeometry, { mode: gl.TRIANGLES });
    this.ringTexture = this.textures[ringCfg.texture.replace('.png', '')];

    /* ---------------- 小行星带（选做 E1） ---------------- */
    const beltCfg = config.asteroidBelt;
    this.belt = createAsteroidBelt({
      count: beltCfg.count,
      innerRadius: beltCfg.innerRadius,
      outerRadius: beltCfg.outerRadius,
      thickness: beltCfg.thickness,
      minSize: beltCfg.minSize,
      maxSize: beltCfg.maxSize,
      inclination: beltCfg.inclination,
      seed: beltCfg.seed,
      spinScale: beltCfg.spinScale,
    });
    this.beltPositions = new Float32Array(this.belt.count * 3);
    // t = 0 时的位置先填好
    updateAsteroidPositions(this.belt, 0, this.beltPositions);
    // 小行星没有逐点尺寸图元，用逐点 alpha 表现大小差异（远看更有层次）
    const beltAlphas = new Float32Array(this.belt.count);
    for (let i = 0; i < this.belt.count; i++) {
      beltAlphas[i] = 0.55 + 0.45 * Math.min(1, this.belt.sizes[i] / beltCfg.maxSize);
    }
    this.beltMesh = makeMesh(gl, this.flatProgram.program, {
      positions: this.beltPositions,
      alphas: beltAlphas,
      vertexCount: this.belt.count,
    }, { mode: gl.POINTS, usage: gl.DYNAMIC_DRAW });

    /* ---------------- 太阳辉光广告牌 ---------------- */
    this.quad = makeMesh(gl, this.glowProgram.program, createQuad(), { mode: gl.TRIANGLES });
    this.glowTexture = this.textures['glow'];

    /* ---------------- 日食阴影锥（选做 E2） ---------------- */
    this.coneMeshes = { umbra: null, penumbra: null };
  }

  textureFor(name) {
    if (!name) return null;
    return this.textures[name.replace('.png', '')] || null;
  }

  /* ==================================================================
   *  每帧绘制
   * ================================================================== */
  draw({ scene, camera, state, eclipse }) {
    const gl = this.gl;
    const rc = this.config.render;

    const view = camera.getViewMatrix();
    const proj = camera.getProjMatrix();
    const basis = camera.getBasis();
    const dpr = Math.min(window.devicePixelRatio || 1, rc.maxPixelRatio);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(rc.clearColor[0], rc.clearColor[1], rc.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    /* ---------- 1. 星空（不写深度） ---------- */
    if (state.showStars) {
      this._drawStarfield(view, proj, basis, dpr);
    }

    /* ---------- 2. 太阳（自发光） ---------- */
    const sunCfg = this.config.sun;
    this._drawBody({
      model: scene.sun.model,
      normal: MV.normalMatrix(scene.sun.model),
      texture: this.textureFor(sunCfg.texture),
      color: sunCfg.color,
      emissive: sunCfg.emissive ? 1 : 0,
      ambient: 0.0,
      view, proj,
    });

    /* ---------- 3. 行星 ---------- */
    for (const planet of scene.planets) {
      const P = planet.config;
      this._drawBody({
        model: planet.model,
        normal: planet.normal,
        texture: this.textureFor(P.texture),
        color: P.color,
        emissive: 0,
        ambient: this.config.render.ambient,
        view, proj,
      });
    }

    /* ---------- 4. 地球 + 月球 ---------- */
    this._drawBody({
      model: scene.earth.model,
      normal: scene.earth.normal,
      texture: this.textureFor(this.config.earth.texture),
      color: this.config.earth.color,
      emissive: 0,
      ambient: this.config.render.ambient,
      view, proj,
    });
    this._drawBody({
      model: scene.moon.model,
      normal: scene.moon.normal,
      texture: this.textureFor(this.config.earth.moon.texture),
      color: this.config.earth.moon.color,
      emissive: 0,
      ambient: this.config.render.ambient,
      view, proj,
    });

    /* ---------- 5. 小行星带 ---------- */
    if (state.showBelt) {
      this._drawBelt(state, view, proj, dpr);
    }

    /* ---------- 6. 土星环（混合、双面） ---------- */
    if (state.showRings && scene.ringModel) {
      this._drawRings(scene.ringModel, view, proj);
    }

    /* ---------- 7. 轨道线 ---------- */
    if (state.showOrbits) {
      this._drawOrbitLines(scene.orbitLines, view, proj);
    }

    /* ---------- 8. 日食阴影锥 ---------- */
    if (eclipse && (eclipse.umbra || eclipse.penumbra)) {
      this._drawEclipseCones(eclipse, view, proj);
    }

    /* ---------- 9. 太阳辉光（加色混合） ---------- */
    this._drawGlow(basis, view, proj, dpr);

    /* 还原状态 */
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
  }

  /* ---------------- 天体 ---------------- */
  _drawBody({ model, normal, texture, color, emissive, ambient, view, proj }) {
    const gl = this.gl;
    const { program, uniforms: u } = this.bodyProgram;

    gl.useProgram(program);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);

    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniformMatrix3fv(u.uNormalMatrix, false, normal);
    gl.uniform3fv(u.uSunPos, new Float32Array([0, 0, 0]));
    gl.uniform3fv(u.uBaseColor, new Float32Array(color || [1, 1, 1]));
    gl.uniform1f(u.uAmbient, ambient);
    gl.uniform1f(u.uEmissive, emissive);

    if (texture) {
      bindTexture(gl, texture, 0);
      gl.uniform1i(u.uTexture, 0);
      gl.uniform1f(u.uUseTexture, 1);
    } else {
      gl.uniform1f(u.uUseTexture, 0);
    }

    drawMesh(gl, this.sphere);
  }

  /* ---------------- 星空 ---------------- */
  _drawStarfield(view, proj, basis, dpr) {
    const gl = this.gl;
    const { program, uniforms: u } = this.flatProgram;

    // 星星在无穷远：只用相机的旋转部分（去掉平移），所以没有视差
    const rotationOnlyView = MV.lookAt([0, 0, 0], basis.forward, basis.up);
    const identity = MV.mat4();

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    gl.uniformMatrix4fv(u.uModel, false, identity);
    gl.uniformMatrix4fv(u.uView, false, rotationOnlyView);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniform1f(u.uRoundPoint, 1);

    gl.uniform4fv(u.uColor, new Float32Array([0.85, 0.90, 1.0, 0.85]));
    gl.uniform1f(u.uPointSize, 1.7 * dpr);
    drawMesh(gl, this.stars);

    gl.uniform4fv(u.uColor, new Float32Array([1.0, 0.97, 0.88, 1.0]));
    gl.uniform1f(u.uPointSize, 3.0 * dpr);
    drawMesh(gl, this.brightStars);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /* ---------------- 小行星带 ---------------- */
  _drawBelt(state, view, proj, dpr) {
    const gl = this.gl;
    const beltCfg = this.config.asteroidBelt;
    const t = state.simTime;

    updateAsteroidPositions(this.belt, t, this.beltPositions);
    updateBuffer(gl, this.beltMesh.buffers.positions, this.beltPositions);

    const { program, uniforms: u } = this.flatProgram;
    gl.useProgram(program);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    gl.uniformMatrix4fv(u.uModel, false, MV.mat4());
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniform4fv(u.uColor, new Float32Array([...beltCfg.color, 1.0]));
    gl.uniform1f(u.uPointSize, beltCfg.pointSize * dpr);
    gl.uniform1f(u.uRoundPoint, 1);

    drawMesh(gl, this.beltMesh);
  }

  /* ---------------- 土星环 ---------------- */
  _drawRings(model, view, proj) {
    const gl = this.gl;
    const { program, uniforms: u } = this.ringProgram;
    const cfg = this.ringCfg;

    // 环面法线 = 模型矩阵的 Y 轴列；与太阳方向（土星指向原点）的夹角决定环的明暗，
    // 让环与土星本体的受光方向一致（侧视时环更暗，正视时更亮）。
    const nx = model[4];
    const ny = model[5];
    const nz = model[6];
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const sx = -model[12];
    const sy = -model[13];
    const sz = -model[14];
    const sLen = Math.hypot(sx, sy, sz) || 1;
    const ndl = Math.abs(
      (nx / nLen) * (sx / sLen) + (ny / nLen) * (sy / sLen) + (nz / nLen) * (sz / sLen)
    );
    const brightness = 0.45 + 0.55 * ndl;

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);       // 环是平面，正反两面都要可见

    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniform3fv(u.uTint, new Float32Array(cfg.color));
    gl.uniform1f(u.uAlpha, cfg.alpha);
    gl.uniform1f(u.uBrightness, brightness);
    bindTexture(gl, this.ringTexture, 0);
    gl.uniform1i(u.uTexture, 0);

    drawMesh(gl, this.ringMesh);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  /* ---------------- 轨道线 ---------------- */
  _drawOrbitLines(lines, view, proj) {
    const gl = this.gl;
    const { program, uniforms: u } = this.flatProgram;

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniform1f(u.uPointSize, 1);
    gl.uniform1f(u.uRoundPoint, 0);

    for (const line of lines) {
      gl.uniformMatrix4fv(u.uModel, false, line.model);
      gl.uniform4fv(u.uColor, new Float32Array([...line.color, line.alpha]));
      drawMesh(gl, this.circle);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /* ---------------- 日食阴影锥 ---------------- */
  _drawEclipseCones(eclipse, view, proj) {
    const gl = this.gl;
    const cfg = this.config.eclipse;
    const { program, uniforms: u } = this.flatProgram;

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniform1f(u.uPointSize, 1);
    gl.uniform1f(u.uRoundPoint, 0);

    for (const key of ['penumbra', 'umbra']) {
      const cone = eclipse[key];
      if (!cone || !cone.geometry) continue;

      // 几何每帧重建（锥体半径随日月地位置变化），顶点数固定时复用 VAO
      const mesh = this._coneMesh(key, cone.geometry);
      const color = key === 'umbra' ? cfg.umbraColor : cfg.penumbraColor;
      gl.uniformMatrix4fv(u.uModel, false, cone.modelMatrix);
      gl.uniform4fv(u.uColor, new Float32Array(color));
      drawMesh(gl, mesh);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  _coneMesh(key, geometry) {
    const gl = this.gl;
    const existing = this.coneMeshes[key];
    const vertexCount = geometry.positions.length / 3;

    if (existing && existing.vertexCount === vertexCount) {
      updateBuffer(gl, existing.buffers.positions, geometry.positions);
      return existing;
    }
    if (existing) {
      gl.deleteVertexArray(existing.vao);
    }
    const mesh = makeMesh(gl, this.flatProgram.program, geometry, { mode: gl.TRIANGLES });
    this.coneMeshes[key] = mesh;
    return mesh;
  }

  /* ---------------- 太阳辉光 ---------------- */
  _drawGlow(basis, view, proj, dpr) {
    const gl = this.gl;
    const { program, uniforms: u } = this.glowProgram;
    const sunCfg = this.config.sun;

    const billboard = billboardMatrix(
      [0, 0, 0],
      basis.right,
      basis.up,
      basis.forward,
      sunCfg.radius * sunCfg.glowScale
    );

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    // 加色混合：光晕叠加到已有像素上
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    gl.uniformMatrix4fv(u.uBillboard, false, billboard);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniform3fv(u.uColor, new Float32Array([1.0, 0.82, 0.45]));
    gl.uniform1f(u.uIntensity, sunCfg.glowIntensity || 0.85);
    bindTexture(gl, this.glowTexture, 0);
    gl.uniform1i(u.uTexture, 0);

    drawMesh(gl, this.quad);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }
}
