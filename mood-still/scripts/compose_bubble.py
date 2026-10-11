#!/usr/bin/env python3
"""
compose_bubble.py — 接缝 S1：帧规格 + 底图 + 固定气泡样式 → 成品 PNG

确定性：同一份帧规格 + 同一张底图 + 同一份 bubble.json，必出逐字节相同的 PNG。
不碰网络、不读环境变量、不用随机数、不用时钟。
中文只在这里出现（绘制），stdout 一律 ASCII —— Windows GBK 控制台会把中文打成 ????。

用法: python compose_bubble.py <frame.json> [<frame.json> ...] <out_dir>
      python compose_bubble.py --fit <frame.json> [...]
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUBBLE_CFG = os.path.join(SKILL_DIR, "assets", "bubble.json")


class BubbleError(Exception):
    """单帧合成失败：报出来、跳过这一帧、继续画下一帧。"""


def die(msg):
    """参数级失败：整条命令都没法开始，直接退出。"""
    sys.stdout.write("FAIL  %s\n" % msg)
    sys.exit(1)


def col_weight(ch, cw):
    o = ord(ch)
    is_cjk = (0x2E80 <= o <= 0x9FFF) or (0x3000 <= o <= 0x303F) or (0xFF00 <= o <= 0xFFEF)
    return cw["cjk"] if is_cjk else cw["other"]


def cols_of(s, cw):
    return sum(col_weight(c, cw) for c in s)


CLOSING = "。，、！？；：）》」』…—-"
OPENING = "（《「『"


def wrap(text, max_cols, max_lines, cw):
    """按显示列数硬换行。

    两条中文排版禁则：
      · 收尾标点不得出现在行首（宁可让该行超 1 列）
      · 启始标点不得出现在行尾
    放不下时返回 None —— 绝不静默丢字（spec §8「禁止静默删改」）。
    """
    lines, cur = [], ""
    for ch in text:
        if cols_of(cur + ch, cw) > max_cols:
            # 禁则一：这个字符是收尾标点，留在本行，允许超列
            if ch in CLOSING:
                cur += ch
                continue
            cut = len(cur) - 1
            for i in range(len(cur) - 1, max(-1, len(cur) - 5), -1):
                if cur[i] in "，。！？；：、…—,.!?;:":
                    cut = i
                    break
            # 禁则二：断点后的字符是启始标点，把它一起留在本行
            while cut + 1 < len(cur) and cur[cut + 1] in OPENING:
                cut += 1
            lines.append(cur[: cut + 1])
            cur = cur[cut + 1 :] + ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    lines = [ln for ln in lines if ln]
    # 自检不变量：禁则若被改坏，宁可当场失败，也不要画出一张行首吊着句号的图
    for ln in lines[1:]:
        if ln[0] in CLOSING:
            raise AssertionError("line-break prohibition violated: line starts with %r" % ln[0])
    return lines if len(lines) <= max_lines else None


def load_font(fb, size):
    for p in [fb["path"]] + list(fb["fallbacks"]):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    raise BubbleError("no CJK font found")


def head_disc(bubble, W, H):
    """气泡避让用的头部圆盘：(cx, cy, r) 像素。

    口径：`anchor` 两分量分别按宽/高归一化，`head_r` **只按高度**归一化。
    这里是全 skill 的唯一定义处——`anchor_grid.py` 也 import 它。
    为什么单源：显示列数那次就是"两处各算一遍"漂掉的（见 spec §12）。
    圆盘几何一旦有两份，看图估的锚点和合成时用的锚点就会不是同一个圆。
    """
    ax = bubble["anchor"][0] * W
    ay = bubble["anchor"][1] * H
    r = max(bubble.get("head_r", 0.09), 0.02) * H
    return ax, ay, r


def rect_disc_overlap(bx, by, bw, bh, cx, cy, r, grid):
    """圆盘被矩形覆盖的面积比（网格采样）。确定性、无额外依赖。"""
    if r <= 0:
        return 0.0
    hit = tot = 0
    x0, y0 = cx - r, cy - r
    step = 2.0 * r / grid
    for j in range(grid):
        py = y0 + step * (j + 0.5)
        for i in range(grid):
            px = x0 + step * (i + 0.5)
            if (px - cx) ** 2 + (py - cy) ** 2 > r * r:
                continue
            tot += 1
            if bx <= px <= bx + bw and by <= py <= by + bh:
                hit += 1
    return hit / float(tot) if tot else 0.0


def fit_mode(paths):
    """只判容量、不渲染。D6 的长度规则由这里独占定义。

    为什么不让 validate_frame 自己算列数：wrap() 的容量不是一个总列数 ——
    收尾标点允许把行撑破 1 列（"……！！" 这种能过），启始标点不行。
    在 JS 里复算一遍必然漂，实测就漂过。所以判据放在算法的宿主里，JS 只读结论。
    输出 ASCII: FIT <文件序号> <气泡序号> ok|over|badslot
    """
    with open(BUBBLE_CFG, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cw = cfg["col_weight"]
    over = 0
    for ordn, p in enumerate(paths):
        if not os.path.exists(p):
            sys.stdout.write("FAIL  frame not found (ordinal %d)\n" % ordn)
            return 2
        with open(p, "r", encoding="utf-8") as f:
            fr = json.load(f)
        for idx, b in enumerate(fr.get("bubbles", [])):
            slot_cols = cfg["slots"].get(b.get("slot", "mid"))
            if slot_cols is None:
                over += 1
                sys.stdout.write("FIT %d %d badslot\n" % (ordn, idx))
                continue
            if wrap(b.get("text", ""), slot_cols, cfg["max_lines"], cw) is None:
                over += 1
                sys.stdout.write("FIT %d %d over\n" % (ordn, idx))
            else:
                sys.stdout.write("FIT %d %d ok\n" % (ordn, idx))
    return 1 if over else 0


def compose_one(frame_path, out_dir):
    if not os.path.exists(frame_path):
        raise BubbleError("frame not found")

    with open(frame_path, "r", encoding="utf-8") as f:
        fr = json.load(f)
    with open(BUBBLE_CFG, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    base = os.path.dirname(os.path.abspath(frame_path))
    img_path = os.path.join(base, fr["image"]["file"])
    if not os.path.exists(img_path):
        raise BubbleError("base image missing: %s" % os.path.basename(img_path))

    img = Image.open(img_path).convert("RGBA")
    W, H = img.size
    # (cx, cy, r) 所有角色的头部圆盘，气泡不得压住。几何一律走 head_disc()，不在这里复算。
    heads = [head_disc(b, W, H) for b in fr.get("bubbles", [])]

    cw = cfg["col_weight"]
    for idx, b in enumerate(fr.get("bubbles", [])):
        ax, ay = b["anchor"][0] * W, b["anchor"][1] * H
        slot_cols = cfg["slots"].get(b.get("slot", "mid"))
        if slot_cols is None:
            raise BubbleError("unknown slot")
        # 超容量与字号无关（列数是抽象单位），所以放不下就直接死，不偷偷放宽槽宽
        lines = wrap(b["text"], slot_cols, cfg["max_lines"], cw)
        if lines is None:
            raise BubbleError("bubble %d overflows %s cols x %d lines; compress it per references/bubble-rules.md"
                              % (idx, slot_cols, cfg["max_lines"]))

        placed = None
        # 避让三档：抬高 -> 侧移 -> 降字号。槽宽始终不变。
        for size in [cfg["font"]["size"],
                     max(cfg["font"]["min_size"], cfg["font"]["size"] - 8),
                     cfg["font"]["min_size"]]:
            font = load_font(cfg["font"], size)
            widths = [font.getbbox(t)[2] for t in lines]
            bw = max(widths) + cfg["padding_x"] * 2
            bh = len(lines) * cfg["font"]["line_height"] + cfg["padding_y"] * 2 - 12
            gaps = [18, 54, 96, 150]
            shifts = [0, -0.10 * W, 0.10 * W, -0.22 * W, 0.22 * W]
            for g in gaps:
                for sx in shifts:
                    bx = min(max(ax + sx - bw / 2.0, cfg["margin"]["side"]), W - bw - cfg["margin"]["side"])
                    by = max(ay - heads[idx][2] * cfg["head_clearance"] - bh - g, cfg["margin"]["top"])
                    worst = max(rect_disc_overlap(bx, by, bw, bh, hx, hy, hr, cfg["overlap_grid"])
                                for hx, hy, hr in heads)
                    if worst <= cfg["head_overlap_max"]:
                        placed = (bx, by, bw, bh)
                        break
                if placed:
                    break
            if placed:
                break
        if not placed:
            raise BubbleError("bubble %d cannot avoid heads (overlap > %d%%); re-estimate anchor" %
                              (idx, cfg["head_overlap_max"] * 100))
        _draw(img, cfg, size, lines, placed, (ax, ay), heads[idx][2])

    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, os.path.basename(frame_path).replace(".json", ".png"))
    img.convert("RGB").save(out, "PNG", optimize=True)
    sys.stdout.write("OK  %s  %dx%d  bubbles=%d\n" % (os.path.basename(out), W, H, len(fr.get("bubbles", []))))


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--fit":
        sys.exit(fit_mode(argv[1:]))
    if len(argv) < 2:
        die("usage: compose_bubble.py <frame.json> [<frame.json> ...] <out_dir>   |   --fit <frame.json> [...]")
    frames, out_dir = argv[:-1], argv[-1]
    # 末位若不是目录而是某个帧路径，os.makedirs 会静默建出一个名叫 frame-2.json 的目录、
    # 把 PNG 塞进去、退出码还是 0。实测踩过，所以宁可当场拒绝。
    if os.path.isfile(out_dir) or out_dir.endswith(".json"):
        die("out_dir is not a directory: %s" % out_dir)
    # 一次调用只能交一组：输出名取自帧文件名，跨组的 frame-1.json 会写进同一个
    # frame-1.png，后一张静默盖掉前一张。实测把四个组混着传就中了这一枪。
    seen = {}
    for frame_path in frames:
        name = os.path.basename(frame_path).replace(".json", ".png")
        if name in seen:
            die("output collision: %s would be written by both %s and %s; pass one group at a time"
                % (name, seen[name], frame_path))
        seen[name] = frame_path
    failed = 0
    for frame_path in frames:
        try:
            compose_one(frame_path, out_dir)
        except BubbleError as e:
            failed += 1
            sys.stdout.write("FAIL  %s: %s\n" % (os.path.basename(frame_path), e))
    sys.exit(1 if failed else 0)


def _draw(img, cfg, size, lines, box, anchor, head_r):
    bx, by, bw, bh = box
    d = ImageDraw.Draw(img)
    fill = _rgba(cfg["fill"], cfg["fill_alpha"])
    line = _rgba(cfg["stroke"], 255)
    sw = cfg["stroke_width"]

    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=cfg["radius"],
                        fill=fill, outline=line, width=sw)

    tx = min(max(anchor[0], bx + cfg["tail"]["half_width"] + sw), bx + bw - cfg["tail"]["half_width"] - sw)
    base_y = by + bh
    dx = anchor[0] - tx
    dy = anchor[1] - base_y
    dist = math.hypot(dx, dy) or 1.0
    hw = cfg["tail"]["half_width"]
    # 引线止于头部圆盘外缘：锚点是头部中心，头越大按比例画就会越长，
    # 特写镜头下会一路插进脸里。所以按"到圆心的距离减去半径"再截断。
    length = min(cfg["tail"]["reach"] * dist, max(dist - head_r * 0.85, 14.0))
    tipx, tipy = tx + dx / dist * length, base_y + dy / dist * length
    d.polygon([(tx - hw, base_y - 2), (tx + hw, base_y - 2), (tipx, tipy)], fill=fill, outline=line, width=sw)
    # 抹掉气泡底边被引线切开的那段描边
    d.rectangle([tx - hw + 1, base_y - sw, tx + hw - 1, base_y - 1], fill=fill)

    # 每行用 anchor="mm" 居中：省略号这类基线字符若按 top-left 绘制会沉在气泡底部，
    # 上半部空着，气泡看起来是半空的。
    for k, t in enumerate(lines):
        cy = by + cfg["padding_y"] + (k + 0.5) * cfg["font"]["line_height"] - 6
        d.text((bx + bw / 2.0, cy), t, font=load_font(cfg["font"], size),
               fill=_rgba(cfg["text_color"], 255), anchor="mm")


def _rgba(hexcolor, alpha):
    h = hexcolor.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # 不吐 traceback：stdout 必须是干净的 ASCII 结论
        sys.stdout.write("FAIL  %s: %s\n" % (type(e).__name__, str(e).encode("ascii", "replace").decode()))
        sys.exit(1)
