#!/usr/bin/env python3
"""
identity_check.py — 同一性回归检查：把"重出把原本正确的项弄坏"变成可机读的拦阻。

为什么需要它：测试场跨五轮统计，重出弄坏原本已达标项 4/9 = 44.4%，
而现有五道闸门查的全是文本字段与气泡几何——**画面里角色变了脸，机器一概不知**。
判据来自 reviews/round-2-v3.md 里审核员实测出的阈值，量法照抄它的口径：

  · 亮度 lum = 0.299R + 0.587G + 0.114B
  · 饱和 sat_of_mean = (max-min)/max × 255，对区域的**平均色**求（审核员的 174.7 就是这么来的）
  · 舌色像素 = 口鼻区里满足 r>140 且 r-g>35 且 r-b>25 的像素数

三条自动判定（阈值可用帧里的 identity_expect 覆盖）：

  I1 眼下平色极差 ≤ 15     —— 脸上多出腮红粉斑/短线时这一项会跳到几十
  I2 尾卷心 sat ≥ 130      —— 尾巴螺旋中心被画成水泥色时掉到 60 以下
  I3 舌色像素与基准同数量级 —— 狗嘴从"张开带舌"闭成笑线时掉一个数量级

两项**不自动判**，只把裁图固定下来供人或审核员量（口径没写死就复现不出来）：
眼裂/脸宽、头身比。工具会把这两个框按同一坐标裁出来，避免每次换个量法。

区域从帧规格的 `identity` 字段读（归一化 0..1 的 [x0,y0,x1,y1]），
`identity` 写在 `_scenes.json` 里由 assemble_frame 原样带走。

用法: python identity_check.py <frame.json> [...]
退出码: 0 全部通过；1 有 FAIL；2 缺区域/缺底图等无法判定
stdout 一律 ASCII（Windows GBK 会把中文打成 ????）。
"""
import json
import os
import sys

from PIL import Image

DEFAULTS = {"pink_delta": 25, "tongue_order_tolerance": 10.0,
            "smudge_sat_ratio": 0.55, "smudge_lum_ratio": 0.85,
            "under_eye_flat_max": 15.0, "eye_dark_lum": 60.0}


def die(msg):
    sys.stdout.write("FAIL  %s\n" % msg)
    sys.exit(2)


def region(img, box):
    x0, y0, x1, y1 = box
    W, H = img.size
    px = (int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))
    if px[2] - px[0] < 2 or px[3] - px[1] < 2:
        die("region too small: %s" % (box,))
    return px


def lum(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def sample(img, px):
    """返回区域内的像素列表（步长采样，保证确定性且足够稳）。"""
    crop = img.crop(px)
    W, H = crop.size
    pts = list(crop.getdata())
    return pts


def flatness(img, px):
    """I1b：小面积皮肤框内的亮度极差 + 最暗像素。

    与 I1a 互补，缺一不可（实测）：极差抓得住 r2-06 的缺陷（106.0 对 07 的 7.4），
    因为那处真正的破绽是**几道暗短线**而不是"更粉"；但它对框的位置极敏感——
    往下挪 2% 会从 19.0 跳到 112.7，压到瞳孔更是直接 244.7。
    所以最暗像素 < eye_dark_lum 时报 INCONCLUSIVE 而不是 FAIL：那是框标歪，不是缺陷。
    粉团（I1a）对框歪免疫，但同一块腮红它测不出来（中位 r-g 本来就 71）。
    """
    lums = sorted(lum(*c[:3]) for c in sample(img, px))
    return lums[-1] - lums[0], lums[len(lums) // 2], lums[0]


def pink_cluster(img, px, pink_delta):
    """I1a：脸颊区里"比周围更粉"的成团像素。散点与描边不算。"""
    x0, y0, x1, y1 = px
    pts = list(sample(img, px))
    rs = sorted(p[0] for p in pts)
    gs = sorted(p[1] for p in pts)
    bs = sorted(p[2] for p in pts)
    m = len(rs) // 2
    mr, mg, mb = rs[m], gs[m], bs[m]
    med_pink = mr - mg
    cw, ch = max(1, x1 - x0), max(1, y1 - y0)
    hits = []
    for y in range(ch):
        for x in range(cw):
            p = img.getpixel((x0 + x, y0 + y))
            if (p[0] - p[1]) > med_pink + pink_delta and abs(p[1] - p[2]) < 30 and 60 < lum(*p[:3]) < 235:
                hits.append((x, y))
    if not hits:
        return None, (med_pink, (mr, mg, mb))
    hx0 = min(h[0] for h in hits); hx1 = max(h[0] for h in hits)
    hy0 = min(h[1] for h in hits); hy1 = max(h[1] for h in hits)
    bw, bh = hx1 - hx0 + 1, hy1 - hy0 + 1
    density = len(hits) / float(bw * bh)
    aspect = bw / float(bh)
    blob = len(hits) >= 15 and density >= 0.15 and 0.3 <= aspect <= 3.3
    return ((len(hits), density, aspect, (hx0, hy0, bw, bh)) if blob else ("scattered", len(hits), density, aspect)), (med_pink, (mr, mg, mb))


def sat_of_mean(img, px):
    pts = list(sample(img, px))
    n = float(len(pts))
    mr = sum(p[0] for p in pts) / n
    mg = sum(p[1] for p in pts) / n
    mb = sum(p[2] for p in pts) / n
    mx, mn = max(mr, mg, mb), min(mr, mg, mb)
    return (0.0 if mx <= 0 else (mx - mn) / mx * 255.0), (int(mr), int(mg), int(mb))


def find_grey_smudge(img, px, sat_ratio, lum_ratio):
    """在尾巴邻域里数"又暗又灰"的像素——这才是杂点，低饱和本身不是。

    为什么不能只比饱和度：柴犬合法的奶油色尾尖 sat 只有 38，比那块水泥杂点（43.8）还低，
    单按 sat 判会把尾尖判成缺陷（实测 06/07 因此双双误判）。杂点的特征是**同时**比周围暗、
    比周围灰，所以拿区域中位色当参照逐像素分类。

    为什么不用滑窗找最差小块：窗口一旦比缺陷大，均值就被好毛稀释（合成样本里 14x12 的杂点
    落在 19x19 的窗里，sat 从 43.8 被抬到 136，直接漏判）。逐像素计数不需要猜窗口尺寸。
    """
    x0, y0, x1, y1 = px
    pts = list(sample(img, px))
    rs = sorted(p[0] for p in pts)
    gs = sorted(p[1] for p in pts)
    bs = sorted(p[2] for p in pts)
    m = len(rs) // 2
    mr, mg, mb = rs[m], gs[m], bs[m]
    mx, mn = max(mr, mg, mb), min(mr, mg, mb)
    med_sat = 0.0 if mx <= 0 else (mx - mn) / float(mx) * 255.0
    med_lum = lum(mr, mg, mb)
    sat_cut, lum_cut = sat_ratio * med_sat, lum_ratio * med_lum
    cw = max(1, x1 - x0)
    ch = max(1, y1 - y0)
    hits = []
    for y in range(0, ch, 1):
        row = (y0 + y) * img.size[0]
        for x in range(0, cw, 1):
            p = img.getpixel((x0 + x, y0 + y))
            mx, mn = max(p[:3]), min(p[:3])
            s = 0.0 if mx <= 0 else (mx - mn) / float(mx) * 255.0
            if s < sat_cut and lum(*p[:3]) < lum_cut:
                hits.append((x, y))
    if not hits:
        return None, (med_sat, med_lum, (mr, mg, mb))
    hx0 = min(h[0] for h in hits); hx1 = max(h[0] for h in hits)
    hy0 = min(h[1] for h in hits); hy1 = max(h[1] for h in hits)
    bw, bh = hx1 - hx0 + 1, hy1 - hy0 + 1
    density = len(hits) / float(bw * bh)
    aspect = bw / float(bh)
    # 只有"成团的块"才算杂点。实测三种命中：02 是 10x9 实心块（密度 0.30）；
    # 07 是贴左边界的 8x55 竖线（描边/背景交界，密度 0.11、长宽比 0.15）；
    # 06 是 5 个散点。后两种必须放过，否则闸门一开就是误判干净帧。
    is_blob = len(hits) >= 15 and density >= 0.15 and 0.3 <= aspect <= 3.3
    worst = (len(hits), density, aspect, (hx0, hy0, bw, bh)) if is_blob else None
    return worst, (med_sat, med_lum, (mr, mg, mb))


def tongue_count(img, px):
    """舌头粉 = 红明显高于绿，且绿≈蓝。

    必须带 |g-b| 这一条：琥珀色狗毛 (232,160,88) 的 r-g 也有 72，只按 r-g 判会把整张嘴毛
    数成舌头（实测同一框从 108 涨到 846）。舌头粉 (230,140,140) 的特征是 g≈b。
    """
    return sum(1 for p in sample(img, px)
               if p[0] > 140 and (p[0] - p[1]) > 40 and abs(p[1] - p[2]) < 25)


def check(frame_path):
    if not os.path.exists(frame_path):
        die("frame not found: %s" % frame_path)
    with open(frame_path, "r", encoding="utf-8") as f:
        fr = json.load(f)
    ident = fr.get("identity")
    if not ident:
        sys.stdout.write("SKIP  %s  no identity regions recorded\n" % os.path.basename(frame_path))
        return None
    base = os.path.dirname(os.path.abspath(frame_path))
    img_path = os.path.join(base, fr["image"]["file"])
    if not os.path.exists(img_path):
        die("base image missing: %s" % os.path.basename(img_path))
    img = Image.open(img_path).convert("RGB")
    th = dict(DEFAULTS)
    th.update(fr.get("identity_expect") or {})

    fails, inconclusive, lines = 0, 0, []

    for key, label in (("under_eye_near", "I1 cheek near"), ("under_eye_far", "I1 cheek far")):
        if key in ident:
            blob, (med_pink, medrgb) = pink_cluster(img, region(img, ident[key]), th["pink_delta"])
            if blob is None:
                lines.append("%s-a  no pink cluster (median r-g=%d)  ok" % (label, med_pink))
            elif blob[0] == "scattered":
                lines.append("%s-a  pink px=%d but scattered (density=%.2f aspect=%.2f)  ok"
                             % (label, blob[1], blob[2], blob[3]))
            else:
                fails += 1
                lines.append("%s-a  PINK BLOB hits=%d density=%.2f aspect=%.2f box=%s  FAIL"
                             % (label, blob[0], blob[1], blob[2], blob[3]))
            rng, med, darkest = flatness(img, region(img, ident[key]))
            if rng > th["under_eye_flat_max"] and darkest < th["eye_dark_lum"]:
                lines.append("%s-b  range=%.1f min=%.1f  INCONCLUSIVE 框压到眼睛，往下挪" % (label, rng, darkest))
                inconclusive += 1
            elif rng > th["under_eye_flat_max"]:
                fails += 1
                lines.append("%s-b  range=%.1f med=%.1f min=%.1f  FAIL" % (label, rng, med, darkest))
            else:
                lines.append("%s-b  range=%.1f med=%.1f min=%.1f  ok" % (label, rng, med, darkest))

    if "tail_region" in ident:
        worst, med = find_grey_smudge(img, region(img, ident["tail_region"]),
                                      th["smudge_sat_ratio"], th["smudge_lum_ratio"])
        ok = worst is None
        fails += 0 if ok else 1
        lines.append("I2 tail median sat=%.1f lum=%.1f %s" % (med[0], med[1], med[2]))
        lines.append("I2 %s" % ("no grey blob  ok" if ok else
                                "GREY BLOB hits=%d density=%.2f aspect=%.2f box=%s  FAIL" % worst))

    if "dog_muzzle" in ident:
        n = tongue_count(img, region(img, ident["dog_muzzle"]))
        b = th.get("tongue_baseline")
        if b is None:
            lines.append("I3 tongue-px=%d  (no baseline set)" % n)
        else:
            lo, hi = max(1.0, float(b) / th["tongue_order_tolerance"],), float(b) * th["tongue_order_tolerance"]
            ok = lo <= n <= hi
            fails += 0 if ok else 1
            lines.append("I3 tongue-px=%d baseline=%s  %s" % (n, b, "ok" if ok else "FAIL"))

    for key, label in (("boy_eyes", "crop eyes"), ("boy_head_body", "crop head/body")):
        if key in ident:
            img.crop(region(img, ident[key])).save(os.path.join(base, "idcrop-" + label.split()[1] + ".png"))
            lines.append("CROP  %s -> idcrop-%s.png (measure by hand, same口径)" % (label, label.split()[1]))

    verdict = "PASS" if fails == 0 else "FAIL"
    if fails == 0 and inconclusive:
        verdict = "SKIP?"        # 有指标因框标歪而无法判定——不能当成通过
    sys.stdout.write("%s  %s\n" % (verdict, os.path.basename(frame_path)))
    for ln in lines:
        sys.stdout.write("      %s\n" % ln)
    return fails, inconclusive


def main():
    argv = sys.argv[1:]
    if not argv:
        die("usage: identity_check.py <frame.json> [...]")
    total_fail = total_inc = 0
    for p in argv:
        r = check(p)
        if r:
            total_fail += r[0]
            total_inc += r[1]
    if total_fail:
        sys.stdout.write("\nFAIL  identity failures=%d inconclusive=%d\n" % (total_fail, total_inc))
        sys.exit(1)
    if total_inc:
        sys.stdout.write("\nSKIP?  no failure, but %d metric(s) unmeasurable (box misplaced)\n" % total_inc)
        sys.exit(2)
    sys.stdout.write("\nPASS  identity clean\n")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        sys.stdout.write("FAIL  %s: %s\n" % (type(e).__name__, str(e).encode("ascii", "replace").decode()))
        sys.exit(2)
