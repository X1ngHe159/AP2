/**
 * lib/webgl-utils.js —— WebGL 2.0 上下文创建与画布尺寸管理（经典脚本版）。
 *
 * 只向 window 挂一个 WebGLUtils 命名空间，提供：
 *   WebGLUtils.setupWebGL(canvasOrId, options) -> WebGL2RenderingContext
 *   WebGLUtils.resizeCanvasToDisplaySize(canvasOrId, gl) -> boolean
 *   WebGLUtils.getContext(canvasOrId, options) -> WebGL2RenderingContext | null
 *
 * 设计要点：
 *   - 本项目是 WebGL 2.0 课程项目（着色器使用 #version 300 es），因此优先且只创建 webgl2 上下文；
 *     创建失败时给出可读的中文提示，而不是返回 null 让后面的代码莫名报错。
 *   - 某些老机器 / 虚拟机在开启抗锯齿时创建上下文会失败，因此 setupWebGL 内部会
 *     依次降级重试（关抗锯齿 -> 最低要求属性），尽最大努力拿到上下文。
 *   - resizeCanvasToDisplaySize 按 devicePixelRatio 调整绘图缓冲尺寸，但把 DPR 上限压到 2，
 *     避免 4K 屏 / 高倍缩放时像素量爆炸导致帧率骤降。
 */
(function (global) {
  'use strict';

  /** 创建上下文时使用的默认属性。 */
  var DEFAULT_ATTRIBUTES = {
    alpha: false,                 // 不需要与页面背景混合，关闭 alpha 可省带宽
    depth: true,                  // 三维场景必须有深度缓冲
    stencil: false,               // 本项目不使用模板缓冲
    antialias: true,              // 默认开启多重采样抗锯齿
    premultipliedAlpha: true,
    preserveDrawingBuffer: false, // 关闭以获得更好的性能（需要截图时可在 options 里打开）
    powerPreference: 'high-performance',
    desynchronized: false,
    failIfMajorPerformanceCaveat: false
  };

  /** devicePixelRatio 的上限：超过 2 之后像素量增长收益很低。 */
  var MAX_DEVICE_PIXEL_RATIO = 2;

  /** 把 canvas 元素或元素 id 统一解析为 canvas 元素。 */
  function resolveCanvas(canvasOrId) {
    if (canvasOrId === null || canvasOrId === undefined) {
      throw new Error('WebGLUtils: 需要传入 <canvas> 元素或它的 id');
    }
    if (typeof canvasOrId === 'string') {
      var el = null;
      if (typeof document !== 'undefined' && document &&
          typeof document.getElementById === 'function') {
        el = document.getElementById(canvasOrId);
      }
      if (!el) {
        throw new Error('WebGLUtils: 页面上找不到 id 为 "' + canvasOrId + '" 的 <canvas> 元素');
      }
      return el;
    }
    if (typeof canvasOrId === 'object' && typeof canvasOrId.getContext === 'function') {
      return canvasOrId;
    }
    throw new TypeError('WebGLUtils: 第一个参数必须是 <canvas> 元素或元素 id');
  }

  /** 合并默认属性与调用者传入的 options（调用者优先）。 */
  function mergeAttributes(options) {
    var attrs = {};
    var key;
    for (key in DEFAULT_ATTRIBUTES) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_ATTRIBUTES, key)) {
        attrs[key] = DEFAULT_ATTRIBUTES[key];
      }
    }
    if (options) {
      for (key in options) {
        if (Object.prototype.hasOwnProperty.call(options, key)) {
          attrs[key] = options[key];
        }
      }
    }
    return attrs;
  }

  /**
   * setupWebGL(canvasOrId, options) -> WebGL2RenderingContext
   *
   * options 支持：alpha / depth / stencil / antialias / premultipliedAlpha /
   *               preserveDrawingBuffer / powerPreference（其余 WebGL 合法属性也可透传）。
   *
   * 重试策略：
   *   第 1 轮：完全按请求的属性创建；
   *   第 2 轮：强制 antialias = false（最常导致创建失败的属性）；
   *   第 3 轮：最低要求（关闭抗锯齿 / 模板，alpha 打开，powerPreference 用 default）。
   * 三轮都失败则抛出带排查建议的 Error。
   */
  function setupWebGL(canvasOrId, options) {
    var canvas = resolveCanvas(canvasOrId);
    var base = mergeAttributes(options);
    var lastError = null;

    var attempts = [
      { antialias: base.antialias },
      { antialias: false },
      {
        antialias: false,
        alpha: true,
        stencil: false,
        powerPreference: 'default',
        failIfMajorPerformanceCaveat: false
      }
    ];

    for (var i = 0; i < attempts.length; i++) {
      var attrs = mergeAttributes(options);
      var overrides = attempts[i];
      for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          attrs[key] = overrides[key];
        }
      }

      var gl = null;
      try {
        gl = canvas.getContext('webgl2', attrs);
      } catch (e) {
        lastError = e;
      }
      if (gl) {
        return gl;
      }
    }

    var hint =
      'WebGLUtils.setupWebGL: 无法创建 WebGL 2.0 上下文。\n' +
      '可能原因：浏览器不支持 WebGL 2.0、WebGL 被禁用、显卡驱动异常，' +
      '或页面在无 GPU 的虚拟机 / 远程桌面中运行。\n' +
      '建议：使用最新版 Chrome / Edge / Firefox；确认已开启硬件加速；' +
      '在 Chrome 中可访问 chrome://gpu 查看 WebGL 状态。';
    if (lastError) {
      hint += '\n底层错误：' + (lastError && lastError.message ? lastError.message : String(lastError));
    }
    throw new Error(hint);
  }

  /**
   * resizeCanvasToDisplaySize(canvasOrId, gl) -> boolean
   *
   * 按 CSS 显示尺寸 × devicePixelRatio（上限 2）设置 canvas.width / canvas.height。
   * 若绘图缓冲尺寸发生变化则返回 true，并顺带调用 gl.viewport 覆盖整个绘图缓冲；
   * 未变化返回 false（调用方可据此跳过重设投影矩阵）。
   */
  function resizeCanvasToDisplaySize(canvasOrId, gl) {
    var canvas = resolveCanvas(canvasOrId);

    var dpr = 1;
    if (typeof global.devicePixelRatio === 'number' && global.devicePixelRatio > 0) {
      dpr = global.devicePixelRatio;
    }
    if (dpr > MAX_DEVICE_PIXEL_RATIO) {
      dpr = MAX_DEVICE_PIXEL_RATIO;
    }

    // clientWidth / clientHeight 是 CSS 像素尺寸；某些隐藏元素上可能为 0，此时退回旧尺寸。
    var cssWidth = canvas.clientWidth || canvas.width || 1;
    var cssHeight = canvas.clientHeight || canvas.height || 1;

    var width = Math.max(1, Math.round(cssWidth * dpr));
    var height = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width === width && canvas.height === height) {
      return false;
    }

    canvas.width = width;
    canvas.height = height;

    if (gl && typeof gl.viewport === 'function') {
      gl.viewport(0, 0, width, height);
    }
    return true;
  }

  /**
   * getContext(canvasOrId, options) -> WebGL2RenderingContext | null
   *
   * 只取当前画布上的 WebGL 2.0 上下文（已有则返回同一个），不抛错。
   * 需要“拿不到上下文就给出友好提示”时请使用 setupWebGL。
   */
  function getContext(canvasOrId, options) {
    var canvas = resolveCanvas(canvasOrId);
    try {
      return canvas.getContext('webgl2', mergeAttributes(options)) || null;
    } catch (e) {
      return null;
    }
  }

  global.WebGLUtils = {
    setupWebGL: setupWebGL,
    resizeCanvasToDisplaySize: resizeCanvasToDisplaySize,
    getContext: getContext
  };
})(typeof window !== 'undefined' ? window : globalThis);
