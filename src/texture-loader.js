/**
 * texture-loader.js —— 位图纹理加载
 * ------------------------------------------------------------------
 * 所有天体纹理都是 assets/textures/ 下的真实 PNG 位图，通过 HTMLImageElement
 * 加载后交给 gl.texImage2D 上传（见 gl-utils.createTexture）。
 * 注意：必须通过静态服务器访问（http://），直接双击 file:// 打开时
 * 浏览器会把本地图片视为跨源资源，WebGL 会拒绝上传（这是浏览器安全策略）。
 * ------------------------------------------------------------------
 */

/**
 * @param {Record<string,string>} urls  逻辑名 → 图片 URL
 * @returns {Promise<Record<string, HTMLImageElement>>}
 */
export function loadTextures(urls) {
  const keys = Object.keys(urls);
  return Promise.all(
    keys.map((key) =>
      loadImage(urls[key]).then((image) => [key, image])
    )
  ).then((pairs) => Object.fromEntries(pairs));
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`纹理加载失败：${url}（请用静态服务器打开本项目，而不是 file://）`));
    image.src = url;
  });
}
