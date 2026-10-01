#!/usr/bin/env python3
"""
anchor_grid.py — §5 的看图辅助：给底图叠一张归一化网格（和/或头部圆盘），用来估 `anchor` 与 `head_r`。

它**不参与交付**：只读底图，写一张诊断图到 `work/grid/`（默认），组目录保持干净。
确定性：同一输入必出同一张图；不碰网络、不用随机数、不用时钟。
stdout 一律 ASCII —— Windows GBK 控制台会把中文打成 ????。

为什么要它：SKILL.md §5 说锚点"看图之后再估"，但裸看图估十进制位置误差常有 ±0.05，
引线就会指错人（spec §12 已知风险 3）。叠一张 0.1 网格之后是查表，不是估。

几何口径不在这里定义 —— `head_disc()` 从 compose_bubble.py import，
两边用的是同一个圆。列数口径那次就是"两处各算一遍"漂掉的。

用法:
  python anchor_grid.py <base.png> [...]                 # 只叠网格
  python anchor_grid.py --frame <frame-N.json> [...]     # 叠网格 + 该帧规格里的头部圆盘
  python anchor_grid.py <base.png> --disc 0.54,0.30,0.20 # 叠网格 + 手给的候选圆盘（单图）
  可选 --out DIR（默认 work/grid）
输出:
  GRID <文件> <W>x<H> discs=N
  DISC <序号> <cx> <cy> <r>        # 像素，供人核对；也是变异样本读的数
"""
import json
import os
import sys

sys.dont_write_bytecode = True   # 只是 import 一下几何函数，别把 __pycache__ 写进 skill 目录
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from compose_bubble import head_disc  # noqa: E402  圆盘几何的唯一定义处

MAJOR = (255, 40, 40)     # 0.1 主线 + 刻度数字
MINOR = (0, 200, 255)     # 0.05 细线
DISC = (255, 0, 255)      # 头部圆盘


def die(msg):
    sys.stdout.write("FAIL  %s\n" % msg)
    sys.exit(1)


def draw_grid(img):
    W, H = img.size
    d = ImageDraw.Draw(img)
    fnt = ImageFont.load_default()
    for i in range(1, 20):
        x = int(W * i / 20.0)
        d.line([(x, 0), (x, H)], fill=MAJOR if i % 2 == 0 else MINOR, width=2 if i % 2 == 0 else 1)
    for j in range(1, 20):
        y = int(H * j / 20.0)
        d.line([(0, y), (W, y)], fill=MAJOR if j % 2 == 0 else MINOR, width=2 if j % 2 == 0 else 1)
    for i in range(1, 10):
        x = int(W * i / 10.0)
        d.line([(x, 0), (x, H)], fill=MAJOR, width=2)
        d.text((x + 3, 4), str(i), fill=MAJOR, font=fnt)
    for j in range(1, 10):
        y = int(H * j / 10.0)
        d.line([(0, y), (W, y)], fill=MAJOR, width=2)
        d.text((4, y + 3), str(j), fill=MAJOR, font=fnt)


def draw_disc(img, cx, cy, r, label):
    W, H = img.size
    d = ImageDraw.Draw(img)
    fnt = ImageFont.load_default()
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=DISC, width=3)
    d.line([(cx - 8, cy), (cx + 8, cy)], fill=DISC, width=2)      # 圆心十字，用来对齐 anchor
    d.line([(cx, cy - 8), (cx, cy + 8)], fill=DISC, width=2)
    d.line([(cx, cy), (cx, cy - r)], fill=DISC, width=2)          # 半径竖线，用来对着网格读 head_r
    d.text((cx + 6, cy - r - 14), label, fill=DISC, font=fnt)


def frame_targets(paths):
    """帧规格 → (底图路径, [(cx, cy, r), ...])。尺寸按真图读，不信 w/h 字段。"""
    out = []
    for p in paths:
        if not os.path.exists(p):
            die("frame not found: %s" % p)
        with open(p, "r", encoding="utf-8") as f:
            fr = json.load(f)
        base = os.path.dirname(os.path.abspath(p))
        img_path = os.path.join(base, fr["image"]["file"])
        if not os.path.exists(img_path):
            die("base image missing: %s" % os.path.basename(img_path))
        im = Image.open(img_path)
        W, H = im.size
        im.close()
        discs = [head_disc(b, W, H) for b in fr.get("bubbles", [])]
        out.append((img_path, discs, os.path.basename(p)))
    return out


def main():
    argv = sys.argv[1:]
    if not argv:
        die("usage: anchor_grid.py <base.png> [...] [--frame <frame.json> ...] [--disc X,Y,R] [--out DIR]")

    out_dir, images, frame_paths, manual = "work/grid", [], [], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            i += 1
            if i >= len(argv):
                die("--out needs a value")
            out_dir = argv[i]
        elif a == "--frame":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                frame_paths.append(argv[i])
                i += 1
            continue
        elif a == "--disc":
            i += 1
            if i >= len(argv):
                die("--disc needs X,Y,R")
            parts = argv[i].split(",")
            if len(parts) != 3:
                die("--disc wants X,Y,R (normalized; r by height)")
            try:
                x, y, r = (float(v) for v in parts)
            except ValueError:
                die("--disc wants numbers, got: %s" % argv[i])
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 and 0.0 < r <= 0.5):
                die("--disc out of range: X,Y in [0,1] and R in (0,0.5]")
            manual.append((x, y, r))
        else:
            images.append(a)
        i += 1

    targets = [(p, [], "") for p in images] + frame_targets(frame_paths)
    if not targets:
        die("nothing to draw")
    if manual and len(targets) != 1:
        die("--disc needs exactly one target image (got %d)" % len(targets))

    os.makedirs(out_dir, exist_ok=True)
    for img_path, discs, src_frame in targets:
        im = Image.open(img_path).convert("RGB")
        W, H = im.size
        # 手给的三元组是归一化的，必须走同一条 head_disc 换算成像素——
        # 直接当像素画会得到一个画在左上角、肉眼看不见的圆（实测错过）。
        discs_px = list(discs) + [head_disc({"anchor": [x, y], "head_r": r}, W, H) for (x, y, r) in manual]
        draw_grid(im)
        for n, (cx, cy, r) in enumerate(discs_px):
            draw_disc(im, cx, cy, r, "d%d" % n)
        out = os.path.join(out_dir, "grid-" + os.path.basename(img_path))
        im.save(out)
        note = ("  frame=%s" % src_frame) if src_frame else ""
        sys.stdout.write("GRID  %s  %dx%d  discs=%d%s\n" % (out, W, H, len(discs_px), note))
        for n, (cx, cy, r) in enumerate(discs_px):
            sys.stdout.write("DISC  %d  %.1f %.1f %.1f\n" % (n, cx, cy, r))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # 不吐 traceback：stdout 必须是干净的 ASCII 结论
        sys.stdout.write("FAIL  %s: %s\n" % (type(e).__name__, str(e).encode("ascii", "replace").decode()))
        sys.exit(1)
