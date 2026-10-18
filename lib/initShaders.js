/**
 * lib/initShaders.js —— 教材 Common/initShaders.js 风格的着色器编译 / 链接辅助库（经典脚本版）。
 *
 * 只向 window 挂一个 initShaders 命名空间，提供：
 *   initShaders.createShader(gl, type, source) -> WebGLShader
 *   initShaders.createProgram(gl, vsSource, fsSource) -> WebGLProgram
 *
 * 其中 source / vsSource / fsSource 可以是：
 *   1) 着色器源码字符串；
 *   2) <script id="..."> 元素的 id（字符串），例如 <script id="vs" type="x-shader/x-vertex">；
 *   3) 该 <script> 元素对象本身。
 *
 * 编译或链接失败时抛出 Error，错误信息中包含 WebGL 的 info log 与带行号的源码，
 * 便于在控制台直接定位 GLSL 第几行出错。
 */
(function (global) {
  'use strict';

  /** 出错时最多打印多少行源码（防止超大 shader 把控制台刷屏）。 */
  var MAX_SOURCE_LINES = 120;

  /**
   * 给源码加上行号，方便对照编译器的 "ERROR: 0:12" 之类的行号。
   */
  function annotateSource(source) {
    var lines = source.split(/\r?\n/);
    var out = [];
    var count = Math.min(lines.length, MAX_SOURCE_LINES);
    for (var i = 0; i < count; i++) {
      var no = String(i + 1);
      while (no.length < 3) {
        no = ' ' + no;
      }
      out.push(no + ': ' + lines[i]);
    }
    if (lines.length > MAX_SOURCE_LINES) {
      out.push('...（源码共 ' + lines.length + ' 行，仅显示前 ' + MAX_SOURCE_LINES + ' 行）');
    }
    return out.join('\n');
  }

  /**
   * 把“源码字符串 / 元素 id / 元素对象”统一解析为源码字符串。
   * - 字符串若是纯标识符（如 "vs"）且页面上存在对应元素，则读取该元素的 textContent；
   * - 否则把字符串本身当作 GLSL 源码。
   */
  function resolveSource(src, label) {
    if (src === null || src === undefined) {
      throw new Error('initShaders: ' + label + ' 不能为空');
    }

    if (typeof src === 'string') {
      var id = src.charAt(0) === '#' ? src.slice(1) : src;
      // 只对“看起来像元素 id”的短字符串尝试查 DOM；GLSL 源码必然包含空白或符号。
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) &&
          typeof document !== 'undefined' &&
          document && typeof document.getElementById === 'function') {
        var el = document.getElementById(id);
        if (el && typeof el.textContent === 'string') {
          return el.textContent;
        }
      }
      return src;
    }

    // <script> 元素，或任何带 textContent 的节点
    if (typeof src === 'object' && typeof src.textContent === 'string') {
      return src.textContent;
    }

    throw new TypeError('initShaders: ' + label +
      ' 必须是源码字符串、<script> 元素或元素 id');
  }

  /** 把 WebGL 的 shader type 常量翻译成中文，便于读报错。 */
  function shaderTypeName(gl, type) {
    if (type === gl.VERTEX_SHADER) {
      return '顶点着色器 (VERTEX_SHADER)';
    }
    if (type === gl.FRAGMENT_SHADER) {
      return '片段着色器 (FRAGMENT_SHADER)';
    }
    return '未知类型着色器 (type=' + type + ')';
  }

  /**
   * createShader(gl, type, source) -> WebGLShader
   *
   * 步骤：创建 shader 对象 -> 注入源码 -> 编译 -> 检查 COMPILE_STATUS。
   * 编译失败时删除 shader 并抛出带 info log、带行号源码的 Error。
   */
  function createShader(gl, type, source) {
    if (!gl || typeof gl.createShader !== 'function') {
      throw new TypeError('initShaders.createShader: 第一个参数必须是 WebGLRenderingContext');
    }

    var src = resolveSource(source, '着色器源码');
    var shader = gl.createShader(type);
    if (!shader) {
      throw new Error('initShaders.createShader: gl.createShader 返回空，可能显存不足或上下文已丢失');
    }

    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(shader) || '（编译器未返回日志）';
      gl.deleteShader(shader);
      throw new Error(
        '着色器编译失败：' + shaderTypeName(gl, type) + '\n' +
        '--- 编译日志 ---\n' + log + '\n' +
        '--- 源码（带行号）---\n' + annotateSource(src)
      );
    }

    return shader;
  }

  /**
   * createProgram(gl, vsSource, fsSource) -> WebGLProgram
   *
   * 步骤：分别编译顶点 / 片段着色器 -> 创建 program -> attach -> link -> 检查 LINK_STATUS。
   * 链接失败时清理所有对象并抛出带 program info log 的 Error；
   * 链接成功后着色器对象已可删除（program 内部保留编译结果）。
   */
  function createProgram(gl, vsSource, fsSource) {
    if (!gl || typeof gl.createProgram !== 'function') {
      throw new TypeError('initShaders.createProgram: 第一个参数必须是 WebGLRenderingContext');
    }

    var vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    var fs;
    try {
      fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    } catch (e) {
      // 片段着色器失败时清理已经创建好的顶点着色器
      gl.deleteShader(vs);
      throw e;
    }

    var program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('initShaders.createProgram: gl.createProgram 返回空，可能显存不足或上下文已丢失');
    }

    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(program) || '（链接器未返回日志）';
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error('着色器程序链接失败：\n--- 链接日志 ---\n' + log);
    }

    // 链接成功后 shader 对象可以释放；program 已持有编译后的二进制。
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return program;
  }

  global.initShaders = {
    createShader: createShader,
    createProgram: createProgram
  };
})(typeof window !== 'undefined' ? window : globalThis);
