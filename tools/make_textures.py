#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AP2 太阳系纹理程序化生成器 / Procedural texture generator for the AP2 solar system.

用法 / Usage:
    python tools/make_textures.py

输出 / Outputs (assets/textures/):
    earth.png 2048x1024 RGB          moon.png 1024x512 RGB
    sun.png 1024x512 RGB             mercury.png 1024x512 RGB
    venus.png 1024x512 RGB           mars.png 1024x512 RGB
    jupiter.png 1024x512 RGB         saturn.png 1024x512 RGB
    uranus.png 512x256 RGB           neptune.png 512x256 RGB
    saturn_ring.png 1024x64 RGBA     glow.png 256x256 RGBA
    manifest.json

设计约束 / Design notes:
  * 无网络素材，全部程序化生成；固定主种子 MASTER_SEED，可复现（幂等）。
  * 球面贴图使用等距圆柱（equirectangular）投影：
      图像顶部 = 北极(+90°)，底部 = 南极(-90°)；
      水平左缘 = 经度 -180°，水平中心 = 经度 0°，右缘 = +180°。
  * 经度无缝：所有噪声都在“球面三维坐标”上采样
      p = (cos(lat)cos(lon), sin(lat), cos(lat)sin(lon)) * freq
    经度方向天然周期（且极点收敛到同一点），因此 u=0 与 u=1 连续。
    环形纹理（土星环）的 u 是径向，不参与经度自检。
  * 向量化 numpy 实现，无逐像素 Python 循环。
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image

# ----------------------------------------------------------------------------
# 基础设置
# ----------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]
TEX_DIR = ROOT / "assets" / "textures"
MASTER_SEED = 20251018

ENTRIES: list[dict] = []
_NOISE_CACHE: dict[tuple[str, int], "ValueNoise"] = {}


def _seed32(*parts) -> int:
    """Deterministic 32-bit seed derived from the master seed and a tag."""
    txt = ":".join([str(MASTER_SEED)] + [str(p) for p in parts])
    digest = hashlib.sha256(txt.encode("ascii")).digest()
    return int.from_bytes(digest[:4], "little")


def rng_for(*parts) -> np.random.Generator:
    return np.random.default_rng(_seed32("rng", *parts))


# ----------------------------------------------------------------------------
# 三维值噪声（value noise）+ fBm
# ----------------------------------------------------------------------------
class ValueNoise:
    """Lattice value noise, N^3 periodic, trilinear interpolation with quintic fade.

    The period is N lattice cells.  Coordinate ranges used by the generators stay
    below the period for the dominant octaves, and each octave gets its own
    spatial offset so the lattice pattern never visibly repeats.
    """

    def __init__(self, seed: int, n: int = 64):
        if n & (n - 1):
            raise ValueError("n must be a power of two")
        self.n = int(n)
        self.mask = self.n - 1
        rng = np.random.default_rng(seed)
        self.table = rng.random(self.n ** 3, dtype=np.float32)

    def __call__(self, x, y, z):
        xf = np.floor(x)
        yf = np.floor(y)
        zf = np.floor(z)
        tx = x - xf
        ty = y - yf
        tz = z - zf
        # quintic fade (C2 continuous)
        tx = (tx * tx * tx * (tx * (tx * 6.0 - 15.0) + 10.0)).astype(np.float32)
        ty = (ty * ty * ty * (ty * (ty * 6.0 - 15.0) + 10.0)).astype(np.float32)
        tz = (tz * tz * tz * (tz * (tz * 6.0 - 15.0) + 10.0)).astype(np.float32)

        xi = xf.astype(np.int32) & self.mask
        yi = yf.astype(np.int32) & self.mask
        zi = zf.astype(np.int32) & self.mask
        xj = (xi + 1) & self.mask
        yj = (yi + 1) & self.mask
        zj = (zi + 1) & self.mask

        n = self.n
        nn = n * n
        tbl = self.table

        def corner(a, b, c):
            return tbl.take(a * nn + b * n + c)

        c000 = corner(xi, yi, zi)
        c100 = corner(xj, yi, zi)
        c010 = corner(xi, yj, zi)
        c110 = corner(xj, yj, zi)
        c001 = corner(xi, yi, zj)
        c101 = corner(xj, yi, zj)
        c011 = corner(xi, yj, zj)
        c111 = corner(xj, yj, zj)

        c00 = c000 + tx * (c100 - c000)
        c10 = c010 + tx * (c110 - c010)
        c01 = c001 + tx * (c101 - c001)
        c11 = c011 + tx * (c111 - c011)
        c0 = c00 + ty * (c10 - c00)
        c1 = c01 + ty * (c11 - c01)
        return c0 + tz * (c1 - c0)


def noise(tag: str, n: int = 64) -> ValueNoise:
    key = (tag, int(n))
    nz = _NOISE_CACHE.get(key)
    if nz is None:
        nz = ValueNoise(_seed32("noise", tag, n), n)
        _NOISE_CACHE[key] = nz
    return nz


def fbm(nz: ValueNoise, x, y, z, scale=3.0, octaves=5, gain=0.5, lacunarity=2.0):
    """Fractal Brownian motion of ValueNoise; returns values in [0, 1]."""
    total = None
    amp = 1.0
    norm = 0.0
    freq = float(scale)
    for i in range(octaves):
        ox = 5.31 + 2.17 * i
        oy = 9.13 + 4.71 * i
        oz = 3.77 + 6.29 * i
        v = nz(x * freq + ox, y * freq + oy, z * freq + oz)
        total = v * amp if total is None else total + v * amp
        norm += amp
        amp *= gain
        freq *= lacunarity
    return total / np.float32(norm)


# ----------------------------------------------------------------------------
# 通用工具
# ----------------------------------------------------------------------------
def lonlat_deg(W: int, H: int):
    """Pixel-center longitude/latitude in degrees, shapes (1, W) and (H, 1)."""
    lon = (-180.0 + 360.0 * (np.arange(W, dtype=np.float32) + 0.5) / np.float32(W))[None, :]
    lat = (90.0 - 180.0 * (np.arange(H, dtype=np.float32) + 0.5) / np.float32(H))[:, None]
    return lon.astype(np.float32), lat.astype(np.float32)


def sphere_xyz(lon_deg, lat_deg):
    """Unit-sphere positions for every texel (broadcast to (H, W))."""
    lo = np.radians(lon_deg)
    la = np.radians(lat_deg)
    cl = np.cos(la)
    x = (cl * np.cos(lo)).astype(np.float32)
    y = np.broadcast_to(np.sin(la).astype(np.float32), x.shape)
    z = (cl * np.sin(lo)).astype(np.float32)
    return x, y, z


def wrap180(d):
    """Wrap degrees into [-180, 180), element-wise, seamless at +-180."""
    return (d + np.float32(180.0)) % np.float32(360.0) - np.float32(180.0)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def mix3(img, color, t):
    """Blend an RGB image towards a solid color with per-pixel weight t (...,1)."""
    c = np.asarray(color, np.float32)
    return img + (c - img) * t


def colorize(field, stops):
    """Map a scalar field through a list of (position, (r, g, b)) stops."""
    pos = np.asarray([s[0] for s in stops], np.float64)
    cols = np.asarray([s[1] for s in stops], np.float64)
    f = np.asarray(field, np.float64)
    out = np.empty(field.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(f, pos, cols[:, c])
    return out


def lat_palette(lat_deg_field, keys, colors):
    """Latitude-keyed color ramp (keys ascending, in degrees)."""
    keys = np.asarray(keys, np.float64)
    cols = np.asarray(colors, np.float64)
    f = np.asarray(lat_deg_field, np.float64)
    out = np.empty(lat_deg_field.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(f, keys, cols[:, c])
    return out


def _box_blur_x(a, r):
    """Box blur horizontally with wrap-around (seamless in longitude)."""
    pad = np.concatenate([a[:, -r:], a, a[:, :r]], axis=1)
    c = np.cumsum(pad, axis=1, dtype=np.float64)
    c = np.concatenate([np.zeros((a.shape[0], 1), np.float64), c], axis=1)
    w = 2 * r + 1
    return ((c[:, w:] - c[:, :-w]) / float(w)).astype(np.float32)


def _box_blur_y(a, r):
    """Box blur vertically with edge clamping."""
    pad = np.concatenate([np.repeat(a[:1], r, axis=0), a, np.repeat(a[-1:], r, axis=0)], axis=0)
    c = np.cumsum(pad, axis=0, dtype=np.float64)
    c = np.concatenate([np.zeros((1, a.shape[1]), np.float64), c], axis=0)
    w = 2 * r + 1
    return ((c[w:] - c[:-w]) / float(w)).astype(np.float32)


def blur2d(a, radius, wrap_x=True):
    """Approximate Gaussian blur (3 box passes) of a float32 2D field."""
    a = np.asarray(a, np.float32)
    r = int(round(float(radius)))
    if r < 1:
        return a
    out = a
    for _ in range(3):
        out = _box_blur_x(out, r) if wrap_x else out
        out = _box_blur_y(out, r)
    return out


def blur_rgb(img, radius, wrap_x=True):
    return np.stack([blur2d(img[..., c], radius, wrap_x) for c in range(3)], axis=-1)


def ellipse_union(LON, LAT, blobs, soft_lo=0.72, soft_hi=1.02):
    """Union of longitude/latitude ellipses -> soft mask in [0, 1]."""
    out = np.zeros(LON.shape, np.float32)
    for lon0, lat0, rx, ry in blobs:
        dlon = wrap180(LON - np.float32(lon0))
        q = np.sqrt((dlon / np.float32(rx)) ** 2 + ((LAT - np.float32(lat0)) / np.float32(ry)) ** 2)
        w = 1.0 - smoothstep(soft_lo, soft_hi, q)
        np.maximum(out, w, out=out)
    return out


def make_crater_list(rng, count, r_min, r_max, power=3.0, n_big=0,
                     big_range=(3.5, 7.0), lat_limit=84.0,
                     fresh_lo=0.35, fresh_hi=1.25):
    """Deterministic crater parameters (uniform on the sphere, power-law sizes).

    Each crater: (lon, lat, radius_deg, freshness, aspect, rotation, rim_width).
    Longitude wraps naturally, so craters may sit on the +-180 seam and still
    render continuously.
    """
    n = count + n_big
    lons = rng.uniform(-180.0, 180.0, n)
    lats = np.degrees(np.arcsin(2.0 * rng.random(n) - 1.0))
    rads = np.concatenate([
        r_min + (r_max - r_min) * rng.random(count) ** power,
        rng.uniform(big_range[0], big_range[1], n_big) if n_big else np.zeros(0),
    ])
    fresh = np.concatenate([
        fresh_lo + (fresh_hi - fresh_lo) * rng.random(count) ** 1.4,
        rng.uniform(0.65, 1.15, n_big) if n_big else np.zeros(0),
    ])
    aspect = rng.uniform(0.78, 1.22, n)
    ang = rng.uniform(0.0, math.pi, n)
    rim_w = rng.uniform(0.07, 0.135, n)
    lats = np.clip(lats, -lat_limit, lat_limit)
    return list(zip(lons, lats, rads, fresh, aspect, ang, rim_w))


def add_craters(W, H, craters, rough, nz_hi=None, hi_scale=48.0,
                floor_depth=0.16, rim_height=0.18, ejecta=0.05):
    """Stamp crater albedo into a float32 field using per-crater local blocks.

    Each crater is evaluated only inside its (wrapped) bounding box, so hundreds
    of craters cost milliseconds.  ``rough`` is a full-resolution [0,1] noise
    field that modulates rims/ejecta; ``nz_hi`` is sampled at high frequency
    inside each block to warp rims and floors so craters are not perfect rings.
    """
    shade = np.zeros((H, W), np.float32)
    for lon0, lat0, rad, fresh, asp, ang, rim_w in craters:
        asp = float(np.clip(asp, 0.7, 1.4))
        x_rad = rad / asp
        y_rad = rad * asp
        cosl = max(math.cos(math.radians(lat0)), 0.12)
        r0 = int(math.floor((90.0 - (lat0 + 3.1 * y_rad)) / 180.0 * H - 0.5)) - 1
        r1 = int(math.ceil((90.0 - (lat0 - 3.1 * y_rad)) / 180.0 * H - 0.5)) + 2
        r0 = max(0, r0)
        r1 = min(H, r1)
        if r1 <= r0:
            continue
        dlon_deg = min(3.1 * x_rad / cosl, 180.0)
        c0 = int(math.floor((lon0 - dlon_deg + 180.0) / 360.0 * W - 0.5)) - 1
        c1 = int(math.ceil((lon0 + dlon_deg + 180.0) / 360.0 * W - 0.5)) + 2
        if c1 - c0 >= W:
            col_raw = np.arange(W, dtype=np.int64)
            cols = col_raw
            full = True
        else:
            col_raw = np.arange(c0, c1, dtype=np.int64)
            cols = col_raw % W
            full = False
        rows = np.arange(r0, r1, dtype=np.int64)
        latb = (90.0 - 180.0 * (rows + 0.5) / H).astype(np.float32)[:, None]
        lonb = (-180.0 + 360.0 * (col_raw + 0.5) / W).astype(np.float32)[None, :]
        dlon = wrap180(lonb - np.float32(lon0)) * np.cos(np.radians(latb))
        # normalised crater coordinates (x scaled by aspect, y divided by it)
        dx = dlon / np.float32(rad) * np.float32(asp)
        dy = (latb - np.float32(lat0)) / np.float32(rad) / np.float32(asp)
        ca = np.float32(math.cos(ang))
        sa = np.float32(math.sin(ang))
        xr = dx * ca - dy * sa
        yr = dx * sa + dy * ca
        d = np.sqrt(xr * xr + yr * yr)

        rb = rough[np.ix_(rows, cols)].astype(np.float32)
        if nz_hi is not None:
            latr = np.radians(latb)
            lonr = np.radians(lonb)
            cl = np.cos(latr)
            sx = cl * np.cos(lonr)
            sy = np.broadcast_to(np.sin(latr), sx.shape)
            sz = cl * np.sin(lonr)
            dn1 = nz_hi(sx * hi_scale + 13.7, sy * hi_scale + 5.3, sz * hi_scale + 9.1) - 0.5
            dn2 = nz_hi(sx * hi_scale * 2.9 + 3.1, sy * hi_scale * 2.9 + 17.9,
                        sz * hi_scale * 2.9 + 27.7) - 0.5
        else:
            dn1 = np.zeros_like(rb)
            dn2 = np.zeros_like(rb)

        # 高频噪声揉皱坑缘（半径抖动 + 宽度抖动），避免完美圆环
        d_eff = d * (1.0 + 0.20 * dn1 + 0.10 * dn2)
        rim_mod = 0.72 + 0.55 * rb
        inner = np.clip(1.0 - d_eff, 0.0, 1.0)
        prof = -np.float32(floor_depth * fresh) * inner ** 1.35
        prof += np.float32(0.035 * fresh) * inner * dn1
        rimw = rim_w * (1.0 + 0.55 * dn2)
        prof += np.float32(rim_height * fresh) * np.exp(-((d_eff - 1.0) / rimw) ** 2) \
            * rim_mod * (0.80 + 0.45 * dn1)
        prof += np.float32(ejecta * fresh) * np.exp(-((d_eff - 1.30) / 0.55) ** 2) \
            * rim_mod * (0.75 + 0.50 * dn2)
        if rad > 2.5:
            prof += np.float32(0.10 * fresh) * np.exp(-(d * 7.0) ** 2)
        prof *= (d < 3.0)
        prof = prof.astype(np.float32)
        block = shade[r0:r1]
        if full:
            block += prof
        else:
            block[:, cols] += prof
    return shade


def write_texture(fname, rgb, usage, method, seam=True, extra=None):
    """Clip -> uint8 -> save PNG -> reopen and verify -> record manifest entry."""
    H, W = rgb.shape[:2]
    is_rgba = rgb.ndim == 3 and rgb.shape[2] == 4
    mode = "RGBA" if is_rgba else "RGB"
    data = np.clip(rgb, 0.0, 1.0)
    data = (data * np.float32(255.0) + np.float32(0.5)).astype(np.uint8)
    data = np.ascontiguousarray(data)
    path = TEX_DIR / fname
    Image.fromarray(data, mode=mode).save(path, format="PNG", optimize=True)
    with Image.open(path) as im:
        im.load()
        got_size, got_mode = im.size, im.mode
    ok = got_size == (W, H) and got_mode == mode
    size_kib = path.stat().st_size / 1024.0
    print(f"  saved {fname:16s} {got_size[0]}x{got_size[1]} {got_mode}  {size_kib:8.1f} KiB  verified={ok}")
    if not ok:
        raise RuntimeError(f"{fname}: reopened as {got_size} {got_mode}, expected ({W}, {H}) {mode}")

    entry = {
        "file": fname,
        "width": W,
        "height": H,
        "mode": mode,
        "usage": usage,
        "method": method,
    }
    if seam:
        a = data.astype(np.float64)
        edge = float(np.abs(a[:, 0, :] - a[:, -1, :]).mean())
        col_diffs = np.abs(a[:, 1:, :] - a[:, :-1, :]).mean(axis=(0, 2))
        adj = float(col_diffs.mean())
        ratio = edge / adj if adj > 0.0 else 0.0
        pct = float((col_diffs < edge).mean() * 100.0)
        left_n = float(col_diffs[0])
        right_n = float(col_diffs[-1])
        print(f"    seam: |col0-colN-1|={edge:8.4f}   adjacent={adj:8.4f}   ratio={ratio:6.3f}"
              f"   leftN={left_n:7.4f} rightN={right_n:7.4f}   percentile={pct:5.1f}%")
        entry["seamlessLongitude"] = True
        entry["seamCheck"] = {
            "edgeColumnMeanAbsDiff": round(edge, 5),
            "adjacentColumnMeanAbsDiff": round(adj, 5),
            "ratio": round(ratio, 4),
            "leftNeighborMeanAbsDiff": round(left_n, 5),
            "rightNeighborMeanAbsDiff": round(right_n, 5),
            "seamPercentileAmongAdjacentColumns": round(pct, 1),
        }
    else:
        entry["seamlessLongitude"] = False
    if extra:
        entry.update(extra)
    ENTRIES.append(entry)
    return entry


# ----------------------------------------------------------------------------
# 地球 / Earth
# ----------------------------------------------------------------------------
def make_earth():
    W, H = 2048, 1024
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_low = noise("earth_low")
    n_mid = noise("earth_mid")
    n_high = noise("earth_high")
    n_cloud = noise("earth_cloud")
    n_ice = noise("earth_ice")

    # --- 大尺度陆核：宽椭圆偏置场（近似非洲/欧亚/美洲/澳洲/南极）---
    blobs = [
        # 非洲 (Africa)
        (20.0, 2.0, 23.0, 33.0),
        (15.0, -22.0, 14.0, 12.0),
        # 欧洲 (Europe)
        (15.0, 50.0, 18.0, 13.0),
        # 亚洲 (Asia)
        (95.0, 50.0, 55.0, 26.0),
        (140.0, 62.0, 26.0, 14.0),
        (79.0, 20.0, 12.0, 13.0),
        (47.0, 23.0, 10.0, 11.0),
        (107.0, 12.0, 14.0, 16.0),
        # 北美洲 (North America)
        (-100.0, 45.0, 32.0, 22.0),
        (-145.0, 62.0, 18.0, 10.0),
        (-75.0, 55.0, 20.0, 15.0),
        (-90.0, 18.0, 10.0, 9.0),
        # 南美洲 (South America)
        (-62.0, -12.0, 15.0, 27.0),
        (-55.0, 2.0, 14.0, 12.0),
        # 澳洲 (Australia)
        (134.0, -25.0, 19.0, 12.0),
        (145.0, -6.0, 10.0, 5.0),
        # 格陵兰 / 岛弧 (Greenland & islands)
        (-42.0, 73.0, 11.0, 8.0),
        (-2.0, 54.0, 4.0, 5.0),
        (-19.0, 65.0, 4.0, 3.0),
        (47.0, -19.0, 4.0, 8.0),
        (139.0, 39.0, 4.0, 9.0),
        (173.0, -42.0, 4.0, 7.0),
    ]
    bias = np.zeros((H, W), np.float32)
    for lon0, lat0, rx, ry in blobs:
        dlon = wrap180(LON - np.float32(lon0))
        q = np.sqrt((dlon / np.float32(rx)) ** 2 + ((LAT - np.float32(lat0)) / np.float32(ry)) ** 2)
        g = 1.0 - smoothstep(np.float32(0.35), np.float32(1.60), q)
        np.maximum(bias, g, out=bias)

    n_ant = fbm(n_mid, X, Y, Z, scale=4.0, octaves=4)
    ant = smoothstep(np.float32(-56.0) + 10.0 * (n_ant - 0.5),
                     np.float32(-72.0) + 10.0 * (n_ant - 0.5), LAT)
    np.maximum(bias, ant, out=bias)

    # --- 分形高程：海岸线 = fBm 等值线，天然破碎 ---
    elev = fbm(n_low, X, Y, Z, scale=2.3, octaves=8, gain=0.56)
    elev = elev * np.float32(0.85) + np.float32(0.15) * fbm(n_mid, X, Y, Z, scale=7.0, octaves=6, gain=0.52)
    # 局部海平面：陆核处低（成陆），远洋处高（成海）
    sea_level = np.float32(0.72) - np.float32(0.36) * bias
    land_field = elev - sea_level
    land = smoothstep(np.float32(-0.010), np.float32(0.010), land_field).astype(np.float32)
    height = np.clip(land_field / np.float32(0.20), 0.0, 1.0)
    depth = np.clip(-land_field / np.float32(0.42), 0.0, 1.0)

    # --- 海洋：按水深由浅到深（海岸线不规则，不产生均匀亮环）---
    ocean = colorize(depth, [
        (0.00, (0.055, 0.250, 0.400)),
        (0.16, (0.032, 0.175, 0.360)),
        (0.42, (0.018, 0.100, 0.280)),
        (0.72, (0.010, 0.060, 0.200)),
        (1.00, (0.004, 0.032, 0.130)),
    ])
    ocean = ocean * (0.94 + 0.10 * (elev - 0.5))[..., None]

    # --- 陆地：高程 + 湿度 + 沙漠带 + 苔原 ---
    moisture = fbm(n_mid, X, Y, Z, scale=5.0, octaves=6)
    dry_field = fbm(n_low, X, Y, Z, scale=2.8, octaves=5)
    mountain = fbm(n_high, X, Y, Z, scale=16.0, octaves=5)

    green = colorize(moisture, [
        (0.00, (0.040, 0.130, 0.040)),
        (0.35, (0.100, 0.270, 0.070)),
        (0.62, (0.230, 0.360, 0.110)),
        (0.85, (0.400, 0.420, 0.190)),
        (1.00, (0.530, 0.500, 0.290)),
    ])
    dry_band = np.clip(1.0 - np.abs(np.abs(LAT) - np.float32(25.0)) / np.float32(15.0), 0.0, 1.0)
    dry = dry_band * smoothstep(np.float32(0.42), np.float32(0.58), dry_field)
    dry = blur2d(dry, 8.0)
    sand = colorize(dry_field, [(0.0, (0.62, 0.52, 0.34)), (1.0, (0.78, 0.69, 0.48))])
    lnd = mix3(green, sand, (dry * 0.90)[..., None])

    rocky = smoothstep(np.float32(0.35), np.float32(0.85),
                       height * np.float32(0.60) + mountain * np.float32(0.50))
    lnd = mix3(lnd, (0.46, 0.41, 0.32), (rocky * 0.55)[..., None])
    cold = smoothstep(np.float32(50.0), np.float32(70.0), np.abs(LAT))
    lnd = mix3(lnd, (0.52, 0.53, 0.48), (cold * 0.65)[..., None])

    img = ocean * (1.0 - land)[..., None] + lnd * land[..., None]

    # --- 极冠 ---
    b = fbm(n_ice, X, Y, Z, scale=4.5, octaves=5)
    south = smoothstep(np.float32(-58.0) + 8.0 * (b - 0.5),
                       np.float32(-68.0) + 8.0 * (b - 0.5), LAT)
    north = smoothstep(np.float32(70.0) + 7.0 * (b - 0.5),
                       np.float32(78.0) + 7.0 * (b - 0.5), LAT)
    ice_mask = np.clip(south + north, 0.0, 1.0).astype(np.float32)
    ice_col = colorize(b, [
        (0.00, (0.82, 0.88, 0.95)),
        (0.60, (0.93, 0.96, 0.99)),
        (1.00, (1.00, 1.00, 1.00)),
    ])
    img = mix3(img, ice_col, (ice_mask * 0.98)[..., None])

    # --- 少量云斑：域扭曲 + 拉丝边缘 ---
    Xc = X + (dry_field - 0.5) * np.float32(0.80)
    Yc = Y + (dry_field - 0.5) * np.float32(0.25)
    Zc = Z + (dry_field - 0.5) * np.float32(0.80)
    cl1 = fbm(n_cloud, Xc, Yc, Zc, scale=3.2, octaves=6)
    cl2 = fbm(n_cloud, Xc, Yc, Zc, scale=9.0, octaves=3)
    cloud = smoothstep(np.float32(0.62), np.float32(0.74),
                       np.float32(0.85) * cl1 + np.float32(0.15) * cl2)
    cloud = cloud * (0.85 + 0.30 * (mountain - 0.5)) * 0.90
    cloud = np.clip(cloud, 0.0, 1.0).astype(np.float32)
    img = mix3(img, (0.965, 0.975, 1.0), cloud[..., None])

    write_texture(
        "earth.png", img,
        "地球表面球面贴图（等距圆柱：海陆分布、极冠、云斑）",
        "陆核偏置调制局部海平面 + 8 阶 fBm 高程等值线生成分形海岸；高程/水深/湿度/沙漠/冰盖/云斑分层着色",
    )


# ----------------------------------------------------------------------------
# 月球 / Moon
# ----------------------------------------------------------------------------
def make_moon():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_base = noise("moon_base")
    n_fine = noise("moon_fine")
    n_rough = noise("moon_rough")

    rough = fbm(n_rough, X, Y, Z, scale=26.0, octaves=4)

    # 高地较亮、月海较暗；多尺度粗糙度
    base = np.float32(0.47) + np.float32(0.115) * fbm(n_base, X, Y, Z, scale=2.2, octaves=5)
    base += np.float32(0.055) * (fbm(n_fine, X, Y, Z, scale=12.0, octaves=4) - 0.5)
    base += np.float32(0.035) * (rough - 0.5)

    mfield = fbm(n_base, X, Y, Z, scale=1.6, octaves=4)
    maria = smoothstep(np.float32(0.50), np.float32(0.60), blur2d(mfield, 3.0))
    base = base - np.float32(0.155) * maria
    base += np.float32(0.02) * maria * (rough - 0.5)

    # 陨石坑：幂律尺寸分布 + 少量大坑（坑缘亮、坑内暗、高频噪声揉皱坑缘）
    rng = rng_for("moon_craters")
    craters = make_crater_list(rng, 600, 0.8, 3.2, power=3.0, n_big=10,
                               big_range=(3.6, 7.5), lat_limit=85.0)
    shade = add_craters(W, H, craters, rough, nz_hi=noise("moon_hi", 128), hi_scale=48.0,
                        floor_depth=0.22, rim_height=0.25, ejecta=0.055)
    shade *= (1.0 - np.float32(0.45) * maria)
    gray = np.clip(base + shade, 0.02, 0.96)

    img = np.stack([gray, gray * np.float32(0.985), gray * np.float32(0.955)], axis=-1)
    # 月海带一点冷色调
    img = mix3(img, (0.70, 0.75, 0.84), (maria * 0.10)[..., None])

    write_texture(
        "moon.png", img,
        "月球表面球面贴图（灰色月面、密集陨石坑、深色月海）",
        "球面域 fBm 灰色基底 + 低频谱月海 + 610 个幂律分布陨石坑（局部包围盒盖章、高频噪声揉皱坑缘）",
    )


# ----------------------------------------------------------------------------
# 太阳 / Sun
# ----------------------------------------------------------------------------
def make_sun():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)
    coslat = np.cos(np.radians(LAT)).astype(np.float32)

    n_gran = noise("sun_gran", 256)   # large lattice: fine granules must not repeat
    n_mid = noise("sun_mid")
    n_fine = noise("sun_fine", 256)

    g = fbm(n_gran, X, Y, Z, scale=27.0, octaves=3)
    ridge = 1.0 - np.abs(2.0 * g - 1.0)
    gran = ridge ** 1.8
    mid = fbm(n_mid, X, Y, Z, scale=3.0, octaves=5)
    fine = fbm(n_fine, X, Y, Z, scale=78.0, octaves=2)
    lum = np.float32(0.87) + np.float32(0.34) * (gran - np.float32(0.30)) \
        + np.float32(0.11) * (mid - 0.5) + np.float32(0.06) * (fine - 0.5)

    # 少量太阳黑子（本影 + 半影）
    rng = rng_for("sun_spots")
    for i in range(6):
        lo = rng.uniform(-180.0, 180.0)
        la = rng.uniform(-34.0, 34.0)
        rr = rng.uniform(1.2, 3.0)
        dlon = wrap180(LON - np.float32(lo)) * coslat
        d = np.sqrt(dlon * dlon + (LAT - np.float32(la)) ** 2) / np.float32(rr)
        umbra = smoothstep(np.float32(1.10), np.float32(0.45), d)
        pen = smoothstep(np.float32(1.65), np.float32(0.95), d) * (1.0 - umbra)
        fac = smoothstep(np.float32(2.4), np.float32(1.5), d) * 0.06
        lum = lum * (1.0 - np.float32(0.66) * umbra - np.float32(0.22) * pen) + fac

    img = colorize(lum, [
        (0.45, (0.78, 0.28, 0.03)),
        (0.66, (0.97, 0.55, 0.09)),
        (0.86, (1.00, 0.78, 0.27)),
        (1.00, (1.00, 0.93, 0.62)),
        (1.14, (1.00, 1.00, 0.94)),
    ])
    img = np.clip(img, 0.0, 1.0)
    write_texture(
        "sun.png", img,
        "太阳表面球面贴图（米粒组织、少量黑子、整体高亮）",
        "球面域 fBm 脊状（ridged）噪声生成对流米粒 + 低频亮度扰动 + 6 个黑子（本影/半影）",
    )


# ----------------------------------------------------------------------------
# 水星 / Mercury
# ----------------------------------------------------------------------------
def make_mercury():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_base = noise("mercury_base")
    n_fine = noise("mercury_fine")
    n_rough = noise("mercury_rough")

    rough = fbm(n_rough, X, Y, Z, scale=24.0, octaves=4)

    base = np.float32(0.41) + np.float32(0.10) * fbm(n_base, X, Y, Z, scale=2.8, octaves=5)
    base += np.float32(0.075) * (fbm(n_fine, X, Y, Z, scale=13.0, octaves=4) - 0.5)
    base += np.float32(0.045) * (rough - 0.5)
    # 若干较暗的平原
    plains = smoothstep(np.float32(0.55), np.float32(0.66),
                        fbm(n_base, X, Y, Z, scale=2.0, octaves=4))
    base -= np.float32(0.065) * plains

    rng = rng_for("mercury_craters")
    craters = make_crater_list(rng, 650, 0.65, 2.9, power=3.0, n_big=12,
                               big_range=(3.2, 6.2), lat_limit=84.0)
    shade = add_craters(W, H, craters, rough, nz_hi=noise("mercury_hi", 128), hi_scale=52.0,
                        floor_depth=0.20, rim_height=0.23, ejecta=0.05)
    shade *= (1.0 - np.float32(0.25) * plains)
    gray = np.clip(base + shade, 0.02, 0.96)
    img = np.stack([gray * np.float32(1.0), gray * np.float32(0.955), gray * np.float32(0.885)], axis=-1)
    # 局部灰褐色变化
    img *= (np.float32(0.98) + np.float32(0.05) * (fbm(n_rough, X, Y, Z, scale=6.0, octaves=3) - 0.5))[..., None]

    write_texture(
        "mercury.png", img,
        "水星表面球面贴图（灰褐色、密集陨石坑）",
        "球面域 fBm 灰褐基底 + 暗色平原 + 662 个覆盖式陨石坑（局部包围盒盖章、高频噪声揉皱坑缘）",
    )


# ----------------------------------------------------------------------------
# 金星 / Venus
# ----------------------------------------------------------------------------
def make_venus():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_a = noise("venus_a")
    n_b = noise("venus_b")

    n1 = fbm(n_a, X, Y, Z, scale=1.5, octaves=5)
    n2 = fbm(n_b, X, Y, Z, scale=5.5, octaves=4)

    latr = np.radians(LAT)
    band = np.sin(latr * np.float32(6.5) + np.float32(2.8) * n1 + np.float32(1.1) * n2)
    bright = np.float32(0.82) + np.float32(0.075) * band \
        + np.float32(0.07) * (n2 - 0.5) + np.float32(0.035) * (n1 - 0.5)
    # 极区亮罩
    bright += np.float32(0.045) * smoothstep(np.float32(45.0), np.float32(80.0), np.abs(LAT))
    img = colorize(bright, [
        (0.62, (0.66, 0.57, 0.33)),
        (0.72, (0.84, 0.75, 0.50)),
        (0.80, (0.93, 0.87, 0.64)),
        (0.88, (0.98, 0.95, 0.79)),
        (0.96, (1.00, 0.99, 0.91)),
    ])
    write_texture(
        "venus.png", img,
        "金星表面球面贴图（黄白色硫酸云、柔和条带/旋涡）",
        "经度无缝 fBm 扭曲的纬度正弦条带 + 多尺度噪声，映射到黄白/浅黄色阶",
    )


# ----------------------------------------------------------------------------
# 火星 / Mars
# ----------------------------------------------------------------------------
def make_mars():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_a = noise("mars_a")
    n_b = noise("mars_b")
    n_c = noise("mars_c")
    n_rough = noise("mars_rough")

    rough = fbm(n_rough, X, Y, Z, scale=22.0, octaves=4)
    base_t = fbm(n_a, X, Y, Z, scale=2.6, octaves=6)
    img = colorize(base_t, [
        (0.00, (0.46, 0.20, 0.10)),
        (0.38, (0.62, 0.29, 0.14)),
        (0.68, (0.76, 0.39, 0.19)),
        (1.00, (0.88, 0.55, 0.33)),
    ])

    # 暗色反照率区域：椭圆种子 + 强 fBm 扰动 + 域扭曲，得到自然而非几何的轮廓
    dark_blobs = [
        (70.0, 6.0, 17.0, 11.0),
        (35.0, -6.0, 12.0, 8.0),
        (20.0, -24.0, 20.0, 10.0),
        (-45.0, 22.0, 18.0, 9.0),
        (150.0, 28.0, 14.0, 8.0),
        (-120.0, -18.0, 15.0, 8.0),
    ]
    wl = (fbm(n_b, X, Y, Z, scale=2.0, octaves=4) - 0.5) * np.float32(22.0)
    wb = (fbm(n_c, X, Y, Z, scale=2.4, octaves=4) - 0.5) * np.float32(13.0)
    shape = ellipse_union(LON + wl, LAT + wb, dark_blobs, soft_lo=0.45, soft_hi=1.0)
    field = shape + np.float32(1.10) * (fbm(n_b, X, Y, Z, scale=3.6, octaves=5) - 0.5) \
        + np.float32(0.45) * (fbm(n_c, X, Y, Z, scale=9.0, octaves=4) - 0.5)
    dark = smoothstep(np.float32(0.34), np.float32(0.48), field)
    dark = blur2d(dark, 1.2)
    darkcol = colorize(fbm(n_c, X, Y, Z, scale=7.0, octaves=4), [
        (0.00, (0.30, 0.155, 0.10)),
        (0.50, (0.37, 0.20, 0.13)),
        (1.00, (0.45, 0.26, 0.17)),
    ])
    img = mix3(img, darkcol, (dark * 0.85)[..., None])

    # 亮尘/沙丘（沿经度拉长的风成条纹）
    dust_n = fbm(n_c, X, Y * np.float32(4.0), Z, scale=5.0, octaves=4)
    dust = smoothstep(np.float32(0.62), np.float32(0.74), dust_n)
    img = mix3(img, (0.86, 0.60, 0.40), (dust * 0.30)[..., None])

    # 小型陨石坑（火星保留较少、对比度低）
    rng = rng_for("mars_craters")
    craters = make_crater_list(rng, 150, 0.7, 2.2, power=3.0, n_big=4,
                               big_range=(2.6, 4.2), lat_limit=82.0,
                               fresh_lo=0.25, fresh_hi=0.65)
    shade = add_craters(W, H, craters, rough, nz_hi=noise("mars_hi"), hi_scale=55.0,
                        floor_depth=0.10, rim_height=0.11, ejecta=0.025)
    img = np.clip(img + shade[..., None], 0.0, 1.0)

    # 极冠（小而亮，边缘带噪声）
    pn = fbm(n_c, X, Y, Z, scale=5.0, octaves=4)
    north = smoothstep(np.float32(74.0) + 4.5 * (pn - 0.5),
                       np.float32(82.0) + 4.5 * (pn - 0.5), LAT)
    south = smoothstep(np.float32(-76.0) + 5.0 * (pn - 0.5),
                       np.float32(-84.0) + 5.0 * (pn - 0.5), LAT)
    cap = np.clip(north + south, 0.0, 1.0).astype(np.float32)
    capcol = colorize(pn, [(0.0, (0.90, 0.88, 0.85)), (1.0, (0.99, 0.98, 0.97))])
    img = mix3(img, capcol, (np.clip(cap * 1.05, 0.0, 1.0) * 0.98)[..., None])

    write_texture(
        "mars.png", img,
        "火星表面球面贴图（红橙色、暗色反照率区域、两极小极冠）",
        "球面域 fBm 红橙基底 + 域扭曲暗区 + 风成亮尘 + 稀疏小陨石坑 + 带噪声边缘的明亮极冠",
    )


# ----------------------------------------------------------------------------
# 木星 / Jupiter
# ----------------------------------------------------------------------------
def make_jupiter():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)
    coslat = np.cos(np.radians(LAT)).astype(np.float32)

    n_w1 = noise("jup_w1")
    n_w2 = noise("jup_w2")
    n_w3 = noise("jup_w3")
    n_streak = noise("jup_streak")

    warp1 = fbm(n_w1, X, Y, Z, scale=2.2, octaves=5) - 0.5
    warp2 = fbm(n_w2, X, Y, Z, scale=6.5, octaves=4) - 0.5
    warp3 = fbm(n_w3, X, Y, Z, scale=22.0, octaves=3) - 0.5
    latw = LAT + (warp1 * np.float32(4.5) + warp2 * np.float32(1.8) + warp3 * np.float32(1.0)) \
        * (np.float32(0.35) + np.float32(0.65) * np.sqrt(np.clip(coslat, 0.0, 1.0)))

    keys = [-90, -80, -70, -60, -50, -42, -34, -26, -19, -12, -5, 2, 9, 16, 23, 30, 38, 46, 54, 62, 70, 80, 90]
    colors = [
        (0.45, 0.40, 0.36), (0.62, 0.53, 0.44), (0.82, 0.72, 0.56), (0.93, 0.86, 0.70),
        (0.72, 0.53, 0.34), (0.92, 0.85, 0.70), (0.84, 0.73, 0.55), (0.52, 0.34, 0.21),
        (0.93, 0.85, 0.68), (0.75, 0.53, 0.32), (0.94, 0.87, 0.71), (0.86, 0.66, 0.42),
        (0.95, 0.88, 0.73), (0.58, 0.39, 0.24), (0.92, 0.84, 0.68), (0.86, 0.74, 0.53),
        (0.94, 0.87, 0.71), (0.68, 0.49, 0.31), (0.92, 0.85, 0.69), (0.84, 0.74, 0.57),
        (0.65, 0.56, 0.46), (0.53, 0.47, 0.41), (0.45, 0.41, 0.37),
    ]
    img = lat_palette(latw, keys, colors)

    # 沿经度拉长的细条纹 + 带边小尺度湍流
    streak = fbm(n_streak, X, Y * np.float32(3.5), Z, scale=6.5, octaves=4) - 0.5
    festoon = fbm(n_streak, X, Y * np.float32(3.0), Z, scale=9.0, octaves=2)
    fest = smoothstep(np.float32(0.62), np.float32(0.76), festoon)
    eq_w = np.exp(-(LAT / np.float32(22.0)) ** 2)
    img = img * (1.0 + 0.050 * streak - 0.10 * fest * eq_w)[..., None]
    # 极区斑驳
    pol = smoothstep(np.float32(55.0), np.float32(80.0), np.abs(LAT))
    pol_n = fbm(n_w3, X, Y, Z, scale=5.0, octaves=4)
    img = img * (1.0 + 0.12 * (pol_n - 0.5) * pol)[..., None]
    img = np.clip(img, 0.0, 1.0)

    # 大红斑（Great Red Spot）：浅色外晕 + 深红核心 + 内部涡旋
    lon0, lat0 = 132.0, -21.0
    dx = wrap180(LON - np.float32(lon0)) / np.float32(14.0)
    dy = (LAT - np.float32(lat0)) / np.float32(7.0)
    d = np.sqrt(dx * dx + dy * dy)
    halo = smoothstep(np.float32(1.60), np.float32(1.00), d) * np.float32(0.35)
    img = mix3(img, (0.95, 0.90, 0.78), halo[..., None])
    mask = smoothstep(np.float32(1.02), np.float32(0.72), d)
    swirl = fbm(noise("jup_grs"), X * np.float32(3.0), Y * np.float32(3.0), Z * np.float32(3.0),
                scale=4.0, octaves=4)
    radial = smoothstep(np.float32(0.95), np.float32(0.05), d)
    grs = colorize(swirl, [
        (0.25, (0.55, 0.20, 0.10)),
        (0.50, (0.68, 0.28, 0.14)),
        (0.75, (0.82, 0.44, 0.26)),
        (1.00, (0.90, 0.62, 0.42)),
    ])
    grs = mix3(grs, (0.60, 0.24, 0.13), (radial * 0.35)[..., None])
    img = mix3(img, np.clip(grs, 0.0, 1.0), (mask * 0.95)[..., None])
    img = np.clip(img, 0.0, 1.0)

    write_texture(
        "jupiter.png", img,
        "木星表面球面贴图（米色/橙色/棕色水平云带、带边湍流、大红斑）",
        "多尺度纬度扰动 + 高对比纬度色带查找表 + 沿经度拉长湍流 + 带浅色外晕的大红斑",
    )


# ----------------------------------------------------------------------------
# 土星 / Saturn
# ----------------------------------------------------------------------------
def make_saturn():
    W, H = 1024, 512
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)
    coslat = np.cos(np.radians(LAT)).astype(np.float32)

    n_w = noise("sat_w")
    n_s = noise("sat_s")
    n_m = noise("sat_m")

    warp = fbm(n_w, X, Y, Z, scale=2.0, octaves=5) - 0.5
    warp2 = fbm(n_s, X, Y, Z, scale=6.0, octaves=4) - 0.5
    warp3 = fbm(n_m, X, Y, Z, scale=16.0, octaves=3) - 0.5
    streak = fbm(n_s, X, Y * np.float32(4.5), Z, scale=9.0, octaves=3) - 0.5
    latw = LAT + (warp * np.float32(6.0) + warp2 * np.float32(2.2) + warp3 * np.float32(0.8)) \
        * (np.float32(0.35) + np.float32(0.65) * np.sqrt(np.clip(coslat, 0.0, 1.0)))

    keys = [-90, -74, -58, -44, -30, -16, -4, 8, 20, 34, 48, 62, 76, 90]
    colors = [
        (0.52, 0.47, 0.40), (0.70, 0.63, 0.51), (0.84, 0.76, 0.60),
        (0.90, 0.83, 0.65), (0.82, 0.74, 0.56), (0.94, 0.88, 0.71),
        (0.88, 0.81, 0.62), (0.95, 0.90, 0.75), (0.86, 0.79, 0.60),
        (0.93, 0.87, 0.69), (0.85, 0.78, 0.60), (0.92, 0.86, 0.68),
        (0.76, 0.69, 0.55), (0.55, 0.50, 0.43),
    ]
    img = lat_palette(latw, keys, colors)
    mot = fbm(n_m, X, Y, Z, scale=5.0, octaves=4)
    img = np.clip(img * (1.0 + 0.035 * streak + 0.02 * (mot - 0.5))[..., None], 0.0, 1.0)
    img = blur_rgb(img, 1.2)

    write_texture(
        "saturn.png", img,
        "土星表面球面贴图（低对比米黄色水平云带）",
        "纬度色带查找表 + 多尺度球面域 fBm 带边扰动（对比度约为木星一半）+ 轻微柔化",
    )


# ----------------------------------------------------------------------------
# 天王星 / Uranus
# ----------------------------------------------------------------------------
def make_uranus():
    W, H = 512, 256
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_a = noise("uranus_a")
    n_b = noise("uranus_b")
    n1 = fbm(n_a, X, Y, Z, scale=1.4, octaves=4)
    n2 = fbm(n_b, X, Y, Z, scale=5.0, octaves=3)

    t = np.float32(0.5) + np.float32(0.5) * np.sin(np.radians(LAT) * np.float32(2.6)
                                                   + np.float32(0.55) * n1)
    base = colorize(t, [
        (0.00, (0.50, 0.74, 0.78)),
        (0.50, (0.57, 0.80, 0.84)),
        (1.00, (0.63, 0.85, 0.88)),
    ])
    base = base * (np.float32(0.985) + np.float32(0.025) * (n2 - 0.5))[..., None]
    # 极区略亮
    base = mix3(base, (0.68, 0.87, 0.89),
                (smoothstep(np.float32(62.0), np.float32(85.0), np.abs(LAT)) * 0.10)[..., None])
    img = np.clip(base, 0.0, 1.0)

    write_texture(
        "uranus.png", img,
        "天王星表面球面贴图（淡青色、几乎无特征）",
        "极低对比纬度条带 + 球面域 fBm 微扰，淡青色阶",
    )


# ----------------------------------------------------------------------------
# 海王星 / Neptune
# ----------------------------------------------------------------------------
def make_neptune():
    W, H = 512, 256
    lon, lat = lonlat_deg(W, H)
    LON = np.broadcast_to(lon, (H, W))
    LAT = np.broadcast_to(lat, (H, W))
    X, Y, Z = sphere_xyz(LON, LAT)

    n_a = noise("nep_a")
    n_b = noise("nep_b")
    n_c = noise("nep_c")
    n1 = fbm(n_a, X, Y, Z, scale=1.7, octaves=5)
    n2 = fbm(n_b, X, Y, Z, scale=4.5, octaves=4)

    t = np.float32(0.5) + np.float32(0.5) * np.sin(np.radians(LAT) * np.float32(4.0)
                                                   + np.float32(0.55) * n1)
    img = colorize(t, [
        (0.00, (0.050, 0.110, 0.340)),
        (0.50, (0.080, 0.180, 0.500)),
        (1.00, (0.130, 0.270, 0.640)),
    ])
    img = img * (np.float32(0.92) + np.float32(0.13) * n2)[..., None]

    # 少量亮色云团：高空斑块 + 几个明确的拉长亮斑
    cl = fbm(n_c, X, Y * np.float32(3.0), Z, scale=2.6, octaves=5)
    cloud = smoothstep(np.float32(0.72), np.float32(0.80), cl) * np.float32(0.45)
    img = mix3(img, (0.82, 0.90, 1.0), cloud[..., None])
    for lo, la, rlon, rlat, strength in [
        (38.0, -20.0, 10.0, 4.0, 0.55),
        (118.0, 26.0, 8.0, 3.2, 0.45),
        (-74.0, -34.0, 9.0, 3.5, 0.40),
    ]:
        dx = wrap180(LON - np.float32(lo)) / np.float32(rlon)
        dy = (LAT - np.float32(la)) / np.float32(rlat)
        m = smoothstep(np.float32(1.0), np.float32(0.25), np.sqrt(dx * dx + dy * dy)) * np.float32(strength)
        img = mix3(img, (0.85, 0.92, 1.0), m[..., None])
    img = np.clip(img, 0.0, 1.0)

    write_texture(
        "neptune.png", img,
        "海王星表面球面贴图（深蓝色、少量亮色云团）",
        "低对比纬度条带 + 球面域 fBm 深蓝纹理 + 阈值化拉长云团",
    )


# ----------------------------------------------------------------------------
# 土星环 / Saturn ring (u = radial: 0 inner -> 1 outer)
# ----------------------------------------------------------------------------
def make_saturn_ring():
    W, H = 1024, 64
    u = (np.arange(W, dtype=np.float64) + 0.5) / W
    rng = rng_for("saturn_ring")

    # 多条不规则环带（piecewise + 高频细节）
    n_bands = 32
    edges = np.sort(rng.uniform(0.012, 0.988, n_bands))
    vals = rng.uniform(0.25, 1.0, n_bands + 1)
    prof = np.interp(u, edges, vals[:-1])
    fine = np.zeros_like(u)
    for f, a, ph in [(11.0, 0.055, 0.3), (23.0, 0.045, 1.1), (47.0, 0.032, 2.0),
                     (89.0, 0.022, 0.6), (157.0, 0.014, 1.7)]:
        fine += a * np.sin(2.0 * np.pi * (u * f + ph))
    grain = rng.normal(0.0, 1.0, W)
    kernel = np.exp(-0.5 * (np.arange(-3, 4) / 1.4) ** 2)
    kernel /= kernel.sum()
    grain = np.convolve(grain, kernel, mode="same")
    prof = np.clip(prof + fine + 0.05 * grain, 0.0, 1.0)

    alpha = 0.42 + 0.46 * prof           # 0.42 .. 0.88 (before gaps)
    brightness = 0.70 + 0.30 * prof + 0.35 * fine + 0.03 * grain
    color = np.stack([brightness * 1.00,
                      brightness * 0.965,
                      brightness * 0.905], axis=-1)

    def gap_factor(uu, a, b, soft, depth):
        inside = smoothstep(a - soft, a + soft, uu) * (1.0 - smoothstep(b - soft, b + soft, uu))
        return 1.0 - depth * inside

    # 明显的卡西尼缝（低 alpha 暗缝）+ 若干次级环缝
    alpha *= gap_factor(u, 0.585, 0.640, 0.007, 0.93)   # Cassini Division
    alpha *= gap_factor(u, 0.885, 0.897, 0.003, 0.85)   # Encke Gap
    alpha *= gap_factor(u, 0.345, 0.358, 0.004, 0.55)   # Maxwell Gap
    alpha *= gap_factor(u, 0.165, 0.175, 0.003, 0.35)
    alpha *= gap_factor(u, 0.715, 0.722, 0.002, 0.35)
    # 内侧 C 环偏暗
    alpha *= 0.55 + 0.45 * smoothstep(0.02, 0.17, u)
    # 内缘 5% / 外缘 5% 淡出到 0
    alpha *= smoothstep(0.0, 0.05, u)
    alpha *= 1.0 - smoothstep(0.95, 1.0, u)

    # 纵向 64 行：逐行轻微噪声，避免条纹感
    row_alpha = 1.0 + rng.normal(0.0, 0.022, (H, 1))
    row_col = 1.0 + rng.normal(0.0, 0.014, (H, 1))
    row_grain = rng.normal(0.0, 0.012, (H, W))
    alpha2 = np.clip(alpha[None, :] * row_alpha, 0.0, 1.0)
    rgb2 = color[None, :, :] * row_col[..., None] + row_grain[..., None]
    rgba = np.concatenate([rgb2, alpha2[..., None]], axis=-1)
    rgba = np.clip(rgba, 0.0, 1.0)

    # 额外自检：内外缘 alpha 与卡西尼缝 alpha
    a8 = (rgba[..., 3] * 255.0 + 0.5).astype(np.uint8)
    cy = H // 2
    print(f"    ring alpha: inner(u~0)={a8[cy, 0]}/255  "
          f"outer(u~1)={a8[cy, -1]}/255  "
          f"cassini(u=0.61)={a8[cy, int(0.612 * W)]}/255  "
          f"body median={int(np.median(a8[cy, W // 20: W - W // 20]))}/255")

    write_texture(
        "saturn_ring.png", rgba,
        "土星环径向贴图（u=0 内缘 -> u=1 外缘；多条明暗环带 + 卡西尼缝）",
        "径向一维分层环带剖面 + 正弦细纹 + 高斯噪点；3 处环缝 + 内外缘 alpha 渐隐 + 逐行噪声",
        seam=False,
        extra={
            "uvConvention": "u 沿半径方向：u=0 为内缘，u=1 为外缘；v 与角度无关（各行几乎一致）",
            "alphaFade": {"inner": 0.05, "outer": 0.05},
            "mainGap": {"name": "Cassini Division", "uRange": [0.585, 0.640]},
        },
    )


# ----------------------------------------------------------------------------
# 辉光 / Glow
# ----------------------------------------------------------------------------
def make_glow():
    N = 256
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    x = (x + 0.5) / N * 2.0 - 1.0
    y = (y + 0.5) / N * 2.0 - 1.0
    r = np.sqrt(x * x + y * y)
    alpha = np.clip(1.0 - r, 0.0, 1.0) ** 1.9
    # 中心略平顶，边缘严格归零
    alpha = np.where(r < 1.0, alpha, 0.0).astype(np.float32)
    rgba = np.ones((N, N, 4), np.float32)
    rgba[..., 3] = alpha
    print(f"    glow alpha: center={alpha[N // 2, N // 2]:.4f}  "
          f"r=0.5={alpha[N // 2, int(N * 0.75)]:.4f}  edge=0")
    write_texture(
        "glow.png", rgba,
        "白色径向光晕（太阳辉光 / 星点 sprite）",
        "极坐标径向 alpha 衰减 (1-r)^1.9，白色 RGB，边缘 alpha 严格为 0",
        seam=False,
        extra={"uvConvention": "UV 覆盖整张四边形；中心 alpha≈1，半径 1 处 alpha=0"},
    )


# ----------------------------------------------------------------------------
# manifest.json
# ----------------------------------------------------------------------------
def write_manifest():
    manifest = {
        "project": "AP2 - 三维层级场景：太阳系 (WebGL 2.0)",
        "generator": "tools/make_textures.py",
        "reproducible": True,
        "seed": MASTER_SEED,
        "networkAssets": False,
        "coordinateConvention": {
            "projection": "equirectangular（等距圆柱投影）",
            "northPole": "图像顶部（第 0 行） = 纬度 +90°",
            "southPole": "图像底部（最后一行） = 纬度 -90°",
            "longitudeZero": "图像水平中心（u=0.5）= 经度 0°",
            "longitudeRange": "左缘 u=0 = 经度 -180°，右缘 u=1 = 经度 +180°，向东递增",
            "verticalAxis": "图像第 0 行 = 纬度 +90°（北极），最后一行 = 纬度 -90°（南极）",
            "webglFlipY": "若上传时 UNPACK_FLIP_Y_WEBGL=true，则 v=1 对应图像顶行（北极）、v=0 对应底行（南极）；flipY=false 时相反",
            "longitudeSeam": "所有球面贴图在经度方向闭合：u=0 与 u=1 为同一经线，首末列连续，球面接缝不可见",
            "poleConvergence": "噪声在单位球面三维坐标上采样，极点处经度收敛，无接缝/旋涡伪影",
            "legend": "seamCheck 中 edgeColumnMeanAbsDiff 为 |首列-末列| 平均差，adjacentColumnMeanAbsDiff 为同图相邻列平均差；两者接近即经度无缝",
        },
        "textures": ENTRIES,
    }
    path = TEX_DIR / "manifest.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    with Image.open(TEX_DIR / "earth.png") as im:  # sanity: dir is valid
        pass
    print(f"  wrote manifest.json ({path.stat().st_size} bytes, {len(ENTRIES)} entries)")


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    t0 = time.perf_counter()
    TEX_DIR.mkdir(parents=True, exist_ok=True)
    print(f"AP2 procedural textures -> {TEX_DIR}")
    print(f"master seed = {MASTER_SEED}")
    print("generating...")

    for fn in (make_earth, make_moon, make_sun, make_mercury, make_venus,
               make_mars, make_jupiter, make_saturn, make_uranus, make_neptune,
               make_saturn_ring, make_glow):
        t = time.perf_counter()
        fn()
        print(f"  [{fn.__name__}] {time.perf_counter() - t:.2f}s")

    write_manifest()

    print("\nfinal files:")
    total = 0
    expected = [
        "earth.png", "moon.png", "sun.png", "mercury.png", "venus.png", "mars.png",
        "jupiter.png", "saturn.png", "uranus.png", "neptune.png",
        "saturn_ring.png", "glow.png", "manifest.json",
    ]
    for name in expected:
        p = TEX_DIR / name
        exists = p.exists()
        size = p.stat().st_size if exists else 0
        total += size
        if name.endswith(".png"):
            with Image.open(p) as im:
                info = f"{im.size[0]}x{im.size[1]} {im.mode}"
        else:
            info = "-"
        print(f"  {'OK ' if exists else 'MISSING'} {name:16s} {info:14s} {size:9d} bytes")
        if not exists:
            raise RuntimeError(f"missing output: {name}")
    print(f"total {total / 1024.0:.1f} KiB in {time.perf_counter() - t0:.2f}s")


if __name__ == "__main__":
    main()
