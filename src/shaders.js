/**
 * shaders.js —— 全部 GLSL ES 3.00 着色器源码（WebGL 2.0）
 * ------------------------------------------------------------------
 * 四个程序：
 *   body   纹理 + 太阳方向光（Lambert）—— 行星 / 地球 / 月球 / 太阳（自发光）
 *   flat   纯色几何（轨道线、小行星带点、阴影锥）—— 支持点精灵圆点、逐顶点 alpha
 *   ring   土星环：径向 alpha 纹理，双面、混合
 *   glow   太阳辉光广告牌：径向渐变纹理，加色混合
 * ------------------------------------------------------------------
 */

/* ============================ body ============================ */

export const BODY_VS = `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
in vec2 aTexCoord;

uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
uniform mat3 uNormalMatrix;

out vec3 vNormal;
out vec3 vWorldPos;
out vec2 vTexCoord;

void main() {
    vec4 world = uModel * vec4(aPosition, 1.0);
    vWorldPos = world.xyz;
    // 法线必须用"模型矩阵左上 3x3 的逆转置"变换，才能在非等比缩放下保持垂直
    vNormal = uNormalMatrix * aNormal;
    vTexCoord = aTexCoord;
    gl_Position = uProj * uView * world;
}
`;

export const BODY_FS = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorldPos;
in vec2 vTexCoord;

uniform sampler2D uTexture;
uniform vec3  uSunPos;        // 太阳在世界空间的位置（光源）
uniform vec3  uBaseColor;     // 无纹理时的基础色
uniform float uUseTexture;    // 0/1
uniform float uAmbient;       // 环境光强度
uniform float uEmissive;      // 1 = 自发光（太阳）

out vec4 fragColor;

void main() {
    vec3 base = uUseTexture > 0.5 ? texture(uTexture, vTexCoord).rgb : uBaseColor;

    // 教材 Ch6 的简化光照：环境光 + 漫反射（光源是点光源，位于原点）
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunPos - vWorldPos);
    float ndl = max(dot(N, L), 0.0);
    float lighting = uAmbient + (1.0 - uAmbient) * ndl;

    // 太阳不参与光照（emissive=1 时直接用纹理颜色）
    vec3 color = mix(base * lighting, base, uEmissive);
    fragColor = vec4(color, 1.0);
}
`;

/* ============================ flat ============================ */

export const FLAT_VS = `#version 300 es
in vec3 aPosition;
in float aAlpha;          // 可选的逐顶点透明度（未使用时默认 1）

uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uPointSize;

out float vAlpha;

void main() {
    vAlpha = aAlpha;
    gl_Position = uProj * uView * uModel * vec4(aPosition, 1.0);
    gl_PointSize = uPointSize;
}
`;

export const FLAT_FS = `#version 300 es
precision mediump float;

in float vAlpha;
uniform vec4  uColor;
uniform float uRoundPoint;   // 1 = 用 gl_PointCoord 裁成圆形

out vec4 fragColor;

void main() {
    if (uRoundPoint > 0.5) {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        if (dot(c, c) > 1.0) discard;
    }
    fragColor = vec4(uColor.rgb, uColor.a * vAlpha);
}
`;

/* ============================ ring ============================ */

export const RING_VS = `#version 300 es
in vec3 aPosition;
in vec2 aTexCoord;

uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;

out vec2 vTexCoord;

void main() {
    vTexCoord = aTexCoord;
    gl_Position = uProj * uView * uModel * vec4(aPosition, 1.0);
}
`;

export const RING_FS = `#version 300 es
precision mediump float;

in vec2 vTexCoord;
uniform sampler2D uTexture;
uniform vec3  uTint;
uniform float uAlpha;
uniform float uBrightness;   // 环面法线与太阳方向夹角带来的明暗（简单光照）

out vec4 fragColor;

void main() {
    // 环纹理是一维径向纹理：u = 内缘→外缘，v 固定取 0.5
    vec4 t = texture(uTexture, vec2(vTexCoord.x, 0.5));
    fragColor = vec4(t.rgb * uTint * uBrightness, t.a * uAlpha);
}
`;

/* ============================ glow ============================ */

export const GLOW_VS = `#version 300 es
in vec2 aPosition;        // [-1,1] 四边形
in vec2 aTexCoord;

uniform mat4 uBillboard;  // 由相机右/上向量构造的广告牌矩阵
uniform mat4 uView;
uniform mat4 uProj;

out vec2 vTexCoord;

void main() {
    vTexCoord = aTexCoord;
    gl_Position = uProj * uView * uBillboard * vec4(aPosition, 0.0, 1.0);
}
`;

export const GLOW_FS = `#version 300 es
precision mediump float;

in vec2 vTexCoord;
uniform sampler2D uTexture;
uniform vec3  uColor;
uniform float uIntensity;

out vec4 fragColor;

void main() {
    vec4 t = texture(uTexture, vTexCoord);
    fragColor = vec4(uColor * t.rgb, t.a * uIntensity);
}
`;
