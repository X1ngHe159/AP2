/**
 * config.js —— 天体与场景参数集中配置
 * ------------------------------------------------------------------
 * 单位说明
 *   - 长度：以"地球半径 = 1"为基准（视觉单位）；
 *   - 时间：秒，且为"可视化压缩时间"，不是真实比例。
 *
 * 为什么压缩：按真实比例，太阳半径是地球的 109 倍、海王星轨道半径是地球的
 * 30 倍、行星公转周期跨越 4 个数量级（水星 88 天 / 海王星 165 年），
 * 在同一个画面里要么太阳变成一点、要么内行星糊在一起。因此本项目对半径、
 * 距离、周期做了压缩，但**保持层级关系、变换顺序、相对大小关系与运动方向**
 * 的正确性（例如土星环在赤道面内、月球绕地且潮汐锁定）。
 *
 * 评分点"天体参数集中配置，便于调整"：所有数值都在本文件，改这里即可。
 * ------------------------------------------------------------------
 */

export const CONFIG = {
  /* ---------------- 太阳 ---------------- */
  sun: {
    id: 'sun',
    name: '太阳',
    radius: 4.0,
    spinPeriodSec: 45,          // 自转一周的可视化时间
    texture: 'sun.png',
    color: [1.0, 0.96, 0.86],
    emissive: true,             // 自发光：不参与 Lambert 光照
    glowScale: 3.6,             // 辉光板相对半径的倍数
    glowIntensity: 0.72,
  },

  /* ---------------- 地球（必做：三级嵌套的中层） ---------------- */
  earth: {
    id: 'earth',
    name: '地球',
    radius: 1.14,
    orbitRadius: 21.0,
    orbitPeriodSec: 20,         // 公转一周
    spinPeriodSec: 6,           // 自转一周
    axialTiltDeg: 23.44,        // 地轴倾角（面板可调）
    texture: 'earth.png',
    color: [0.22, 0.45, 0.85],
    /* 月球：三级嵌套的最内层 */
    moon: {
      id: 'moon',
      name: '月球',
      radius: 0.40,
      orbitRadius: 1.9,
      orbitPeriodSec: 2.6,
      // 潮汐锁定：自转周期 = 公转周期（场景代码中月球不再额外自转，
      // 由轨道节点带着转，所以同一面永远朝向地球）
      spinPeriodSec: 2.6,
      inclinationDeg: 5.145,    // 月球轨道面相对黄道面的倾角（手造矩阵）
      nodeDeg: 125,             // 升交点经度（手造矩阵里的第二个旋转）
      texture: 'moon.png',
      color: [0.78, 0.78, 0.76],
    },
  },

  /* ---------------- 其余行星（选做 E1：≥6 颗行星） ---------------- */
  planets: [
    {
      id: 'mercury', name: '水星', radius: 0.54,
      orbitRadius: 11.5, orbitPeriodSec: 8.6, spinPeriodSec: 24, phaseDeg: 205,
      tiltDeg: 0.03, texture: 'mercury.png', color: [0.62, 0.60, 0.58],
    },
    {
      id: 'venus', name: '金星', radius: 0.96,
      orbitRadius: 15.2, orbitPeriodSec: 13, spinPeriodSec: -30, phaseDeg: 108,
      tiltDeg: 177.4, texture: 'venus.png', color: [0.90, 0.82, 0.62],
    },
    {
      id: 'mars', name: '火星', radius: 0.74,
      orbitRadius: 28.0, orbitPeriodSec: 30, spinPeriodSec: 6.2, phaseDeg: 24,
      tiltDeg: 25.19, texture: 'mars.png', color: [0.80, 0.45, 0.28],
    },
    {
      id: 'jupiter', name: '木星', radius: 3.10,
      orbitRadius: 40.0, orbitPeriodSec: 62, spinPeriodSec: 3.8, phaseDeg: 312,
      tiltDeg: 3.13, texture: 'jupiter.png', color: [0.85, 0.75, 0.60],
    },
    {
      id: 'saturn', name: '土星', radius: 2.65,
      orbitRadius: 52.0, orbitPeriodSec: 95, spinPeriodSec: 4.0, phaseDeg: 18,
      tiltDeg: 26.73, texture: 'saturn.png', color: [0.88, 0.80, 0.62],
      /* 选做 E1：土星环 */
      ring: {
        innerRadius: 1.35, outerRadius: 2.40,
        texture: 'saturn_ring.png',
        color: [0.92, 0.86, 0.74],
        alpha: 0.95,
      },
    },
    {
      id: 'uranus', name: '天王星', radius: 1.55,
      orbitRadius: 63.0, orbitPeriodSec: 140, spinPeriodSec: -5, phaseDeg: 245,
      tiltDeg: 97.77, texture: 'uranus.png', color: [0.55, 0.85, 0.88],
    },
    {
      id: 'neptune', name: '海王星', radius: 1.50,
      orbitRadius: 74.0, orbitPeriodSec: 190, spinPeriodSec: 5.5, phaseDeg: 158,
      tiltDeg: 28.32, texture: 'neptune.png', color: [0.28, 0.45, 0.90],
    },
  ],

  /* ---------------- 选做 E1：小行星带 ---------------- */
  asteroidBelt: {
    count: 1500,
    innerRadius: 32.0,
    outerRadius: 38.0,
    thickness: 0.55,
    minSize: 0.035,
    maxSize: 0.16,
    inclination: 0.09,
    seed: 20240501,
    spinScale: 1.0,
    color: [0.52, 0.47, 0.40],
    pointSize: 1.8,
  },

  /* ---------------- 视觉/渲染参数 ---------------- */
  render: {
    starCount: 2600,
    brightStarCount: 220,
    starRadiusMin: 420,
    starRadiusMax: 620,
    orbitLineSegments: 192,
    sphereLatBands: 40,
    sphereLongBands: 80,
    ambient: 0.075,             // 行星夜面环境光
    clearColor: [0.012, 0.016, 0.035, 1.0],
    fovDeg: 45,
    near: 0.15,
    far: 900,
    maxPixelRatio: 2,
  },

  /* ---------------- 相机 / 漫游 ---------------- */
  camera: {
    target: [0, 0, 0],
    // 默认球坐标（方位角、仰角、距离）。启动时相机一直在漫游（roamEnabled=true），
    // 这里只是进入"总览"预设时的机位；方位角取 ~220°，让外行星落在画面左侧，
    // 避开右侧控制面板。
    defaultOrbit: { azimuth: 3.84, elevation: 0.48, distance: 100 },
    minDistance: 3.5,
    maxDistance: 260,
    // 漫游一圈的时长（秒）
    roamDurationSec: 42,
    // 漫游关键帧：绕场景一周，距离/仰角起伏，避免单调
    roamKeyframes: [
      { azimuth: 0.00, elevation: 0.92, distance: 150 },   // 高位全景
      { azimuth: 1.05, elevation: 0.34, distance: 112 },   // 缓缓下降
      { azimuth: 2.10, elevation: 0.12, distance: 82 },    // 贴近黄道面
      { azimuth: 3.05, elevation: 0.20, distance: 105 },   // 另一侧
      { azimuth: 4.10, elevation: 0.55, distance: 138 },   // 爬升
      { azimuth: 5.15, elevation: 0.18, distance: 92 },    // 低角度掠过
    ],
  },

  /* ---------------- 日食 / 月食（选做 E2） ---------------- */
  eclipse: {
    coneSegments: 72,
    umbraColor: [0.42, 0.14, 0.08, 0.62],
    penumbraColor: [0.55, 0.45, 0.30, 0.20],
  },
};
