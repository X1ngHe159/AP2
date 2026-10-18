#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_gif.py —— 把 tools/capture.mjs 采集的漫游帧合成 10 秒 GIF

用法：
    python tools/make_gif.py [帧目录] [输出文件]
默认：
    帧目录  docs/frames
    输出    docs/roam-10s.gif
"""

import glob
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME_DIR = os.path.join(ROOT, "docs", "frames")
OUT_PATH = os.path.join(ROOT, "docs", "roam-10s.gif")

WIDTH = 800
HEIGHT = 450
DURATION_MS = 100   # 10 fps → 10 秒


def main():
    frame_dir = sys.argv[1] if len(sys.argv) > 1 else FRAME_DIR
    out_path = sys.argv[2] if len(sys.argv) > 2 else OUT_PATH

    files = sorted(glob.glob(os.path.join(frame_dir, "frame-*.png")))
    if not files:
        raise SystemExit(f"没有找到帧文件：{frame_dir}/frame-*.png")

    print(f"读取 {len(files)} 帧 …")
    frames = []
    for path in files:
        image = Image.open(path).convert("RGB")
        if image.size != (WIDTH, HEIGHT):
            image = image.resize((WIDTH, HEIGHT), Image.LANCZOS)
        frames.append(image)

    # 统一调色板（取中间帧），避免逐帧调色板造成颜色闪烁
    base = frames[len(frames) // 3].quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    paletted = [
        frame.quantize(palette=base, dither=Image.Dither.FLOYDSTEINBERG)
        for frame in frames
    ]

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    paletted[0].save(
        out_path,
        save_all=True,
        append_images=paletted[1:],
        duration=DURATION_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"已生成：{out_path}（{len(paletted)} 帧，{size_mb:.2f} MB）")


if __name__ == "__main__":
    main()
