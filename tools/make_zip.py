#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_zip.py —— 打包课程提交用的源码 zip（无构建、解压即用）

用法：
    python tools/make_zip.py

产物：项目根目录下的 AP2-src.zip，内部顶层目录为 AP2/。
排除：docs/frames（录屏帧，体积大且可重新生成）、__pycache__、临时文件、zip 自身。
"""

import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "AP2-src.zip")
PREFIX = "AP2"

# 需要打包的目录（相对项目根）
INCLUDE_DIRS = ["css", "lib", "src", "assets", "tools", "docs/screenshots"]
# 需要打包的单个文件
INCLUDE_FILES = ["index.html", "README.md", "docs/roam-10s.gif"]

EXCLUDE_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db", "AP2-src.zip"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo")


def should_include(path_rel: str) -> bool:
    parts = path_rel.split("/")
    if any(p in EXCLUDE_NAMES for p in parts):
        return False
    if path_rel.endswith(EXCLUDE_SUFFIXES):
        return False
    return True


def main():
    files = []

    for name in INCLUDE_FILES:
        full = os.path.join(ROOT, name)
        if os.path.isfile(full):
            files.append(name)
        else:
            print(f"警告：缺少文件 {name}")

    for directory in INCLUDE_DIRS:
        base = os.path.join(ROOT, directory)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES]
            for filename in filenames:
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
                if should_include(rel):
                    files.append(rel)

    files = sorted(set(files))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            zf.write(os.path.join(ROOT, rel), f"{PREFIX}/{rel}")

    size_mb = os.path.getsize(OUT) / (1024 * 1024)
    print(f"已生成 {OUT}")
    print(f"  文件数：{len(files)}，压缩后大小：{size_mb:.2f} MB")

    # 列出关键文件，便于核对
    must_have = ["index.html", "README.md", "src/main.js", "lib/MV.js",
                 "docs/roam-10s.gif", "docs/screenshots/01-overview-perspective.png"]
    names = set(files)
    missing = [m for m in must_have if m not in names]
    print("  关键文件检查：" + ("全部存在" if not missing else f"缺少 {missing}"))


if __name__ == "__main__":
    main()
