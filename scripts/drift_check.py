#!/usr/bin/env python3
"""
drift_check.py — 闸二（连测判死板）+ 闸三（负样本自证 / 对照组）

对目录内所有 frame-*.json 两两比较四个维度：选句、场景三元组、构图、台词集合。
任一对在四项中有 >=2 项相同 -> 判死板，退出码 1。
用法: python drift_check.py <dir> [--expect fresh|stale]
  --expect 给了就要同时校验实际结论与期望一致，否则退出码 4。
"""
import glob
import json
import os
import sys


def load_dir(d):
    """只读 frame-*.json。组目录里还有 kept.json / group.json 等非帧文件，
    误读会把闸门直接搞崩（实测踩过）。"""
    files = sorted(glob.glob(os.path.join(d, "frame-*.json")))
    out = []
    for f in files:
        with open(f, "r", encoding="utf-8") as fh:
            fr = json.load(fh)
        if fr.get("schema") != "mood-still/2":
            sys.stdout.write("SKIP  %s  (schema=%s)\n" % (os.path.basename(f), fr.get("schema")))
            continue
        fr["_f"] = os.path.basename(f)
        out.append(fr)
    return out


def dims(fr):
    sc = fr.get("scene") or {}
    bs = fr.get("bubbles") or []
    # 注意求值顺序：空列表时 bs[0] 会先炸，守卫必须写在前面
    side = None if not bs else ("L" if bs[0]["anchor"][0] < 0.5 else "R")
    return {
        "pick": (fr.get("line_pick") or {}).get("index"),
        "scene": (sc.get("place"), sc.get("time"), sc.get("weather")),
        "comp": (sc.get("framing"), side),
        "text": tuple(sorted(b.get("text", "") for b in bs)),
    }


def availability(frames):
    """某一维度只有在「本来可以不同」时才有资格参与判定。

    单句对白里 pick 与 text 被输入锁死，若仍按"相同即扣分"计算，
    闸二会对所有单句对白永远判死板 —— 实测踩过（T4）。
    """
    lines = {((fr.get("source") or {}).get("dialogue") or "").count("\n") + 1 for fr in frames}
    single = max(lines) <= 1
    return {"pick": not single, "text": not single, "scene": True, "comp": True}


def same_dim(a, b, key):
    """构图维度要求两侧都已知才算相同——否则无气泡的帧会被误判成复读。"""
    if a[key] is None or b[key] is None:
        return False
    if key == "comp":
        fa, sa = a[key]
        fb, sb = b[key]
        return fa == fb and sa is not None and sb is not None and sa == sb
    return a[key] == b[key]


def main():
    argv = sys.argv[1:]
    args = [a for a in argv if not a.startswith("--")]
    expect = None
    if "--expect" in argv:
        i = argv.index("--expect")
        if i + 1 >= len(argv):
            sys.stdout.write("FAIL  --expect needs a value (fresh|stale)\n")
            return 2
        expect = argv[i + 1]
    if not args:
        sys.stdout.write("FAIL  usage: drift_check.py <dir> [--expect fresh|stale]\n")
        return 2
    frames = load_dir(args[0])
    if len(frames) < 2:
        sys.stdout.write("FAIL  need at least 2 frames in %s\n" % args[0])
        return 2

    avail = availability(frames)
    usable = [k for k, v in avail.items() if v]
    inert_frames = [fr["_f"] for fr in frames if not fr.get("bubbles")]
    worst, worst_pair = 0, None
    for i in range(len(frames)):
        for j in range(i + 1, len(frames)):
            a, b = dims(frames[i]), dims(frames[j])
            same = [k for k in usable if same_dim(a, b, k)]
            if len(same) > worst:
                worst, worst_pair = len(same), (frames[i]["_f"], frames[j]["_f"], same)

    stale = worst >= 2
    verdict = "STALE" if stale else "FRESH"
    sys.stdout.write("%s  %d frames, worst pair shares %d dims (of %d usable)\n"
                     % (verdict, len(frames), worst, len(usable)))
    if worst_pair:
        sys.stdout.write("      %s vs %s  same=%s\n"
                         % (worst_pair[0], worst_pair[1], ",".join(worst_pair[2]) or "-"))
    if len(usable) < 3:
        sys.stdout.write("WARN  only %d/4 dims could differ for this input (%s locked by a single-line dialogue)\n"
                         % (len(usable), ",".join(k for k in avail if not avail[k])))
    if inert_frames:
        sys.stdout.write("WARN  comp dim inert for bubble-less frames: %s\n" % ", ".join(inert_frames))

    if expect:
        want = {"fresh": "FRESH", "stale": "STALE"}.get(expect)
        if want != verdict:
            sys.stdout.write("GATE  expected %s but got %s\n" % (want, verdict))
            return 4
        sys.stdout.write("GATE  ok\n")
        return 0
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
