#!/usr/bin/env python3
"""
build_gallery.py — 扫描 gallery/groups/，重建 index.html

无服务端、无构建工具链：agent 写完帧规格与 PNG 后跑一次本脚本即可。
保留张靠 kept.json（不用符号链接，Windows 建链接要额外权限）。

画廊长在**当前项目根目录**（cwd），不长在 skill 目录里 —— skill 将来会晋升为全局，
而每个项目的产出必须留在该项目内。
"""
import html
import json
import os
import sys
from datetime import datetime

ROOT = os.getcwd()
GALLERY = os.path.join(ROOT, "gallery")
GROUPS = os.path.join(GALLERY, "groups")


def die(m):
    sys.stdout.write("FAIL  %s\n" % m)
    sys.exit(1)


def load(p):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def esc(s):
    return html.escape(str(s), quote=True)


def main():
    if not os.path.isdir(GROUPS):
        die("no groups dir: %s" % GROUPS)
    groups = []
    for name in sorted(os.listdir(GROUPS)):
        gdir = os.path.join(GROUPS, name)
        if not os.path.isdir(gdir):
            continue
        frames = []
        for fn in sorted(os.listdir(gdir)):
            if fn.startswith("frame-") and fn.endswith(".json"):
                fr = load(os.path.join(gdir, fn))
                fr["_id"] = fn[:-5]
                frames.append(fr)
        if not frames:
            continue
        kept = []
        kp = os.path.join(gdir, "kept.json")
        if os.path.exists(kp):
            kept = load(kp).get("ids") or []
        groups.append({"dir": name, "frames": frames, "kept": kept})

    out = ["<!doctype html><meta charset='utf-8'>",
           "<title>mood-still gallery</title>",
           "<style>body{background:#141821;color:#e8e6e1;font-family:'Microsoft YaHei',system-ui,sans-serif;",
           "margin:0;padding:32px;line-height:1.6}h1{font-size:20px;letter-spacing:.1em}",
           "h2{font-size:15px;color:#9fb0c4;font-weight:500;margin-top:44px}",
           ".row{display:flex;flex-wrap:wrap;gap:20px}",
           ".card{background:#1d232e;border:2px solid #2c3542;border-radius:10px;padding:12px;max-width:420px}",
           ".card.kept{border-color:#e0913f;box-shadow:0 0 0 3px rgba(224,145,63,.18)}",
           ".card img{width:100%;display:block;border-radius:6px}",
           ".why{font-size:13px;color:#c9d3de;margin-top:8px}",
           ".tag{font-size:11px;color:#e0913f;letter-spacing:.08em}",
           ".miss{font-size:12px;color:#8b6a4a}",
           ".diff{color:#f0b370}",
           "pre{white-space:pre-wrap;font:12px/1.5 'Microsoft YaHei',monospace;color:#8fa0b3}</style>"]
    out.append("<h1>mood-still · 意境定格</h1>")
    out.append("<p style='font-size:13px;color:#7f8f9f'>%d 组 · 生成于 %s</p>"
               % (len(groups), datetime.now().strftime("%Y-%m-%d %H:%M")))

    for g in groups:
        d0 = g["frames"][0]
        out.append("<h2>%s &nbsp;<span style='color:#5d6b7a'>%s</span></h2>"
                   % (esc(g["dir"]), esc((d0.get("source") or {}).get("digest", ""))))
        out.append("<pre>%s</pre>" % esc((d0.get("source") or {}).get("dialogue", "")))
        if not g["kept"]:
            out.append("<div class='miss'>未选定</div>")
        out.append("<div class='row'>")
        for fr in g["frames"]:
            is_kept = fr["_id"] in g["kept"]
            out.append("<div class='card%s'>" % (" kept" if is_kept else ""))
            png = fr["_id"] + ".png"
            if os.path.exists(os.path.join(GROUPS, g["dir"], png)):
                out.append("<img loading='lazy' src='groups/%s/%s' alt=''>" % (esc(g["dir"]), esc(png)))
            else:
                out.append("<div class='miss'>missing png</div>")
            lp = fr.get("line_pick") or {}
            out.append("<div class='tag'>%s%s</div>" % ("保留张 · " if is_kept else "", esc(fr["_id"])))
            out.append("<div class='why'>第 %s 句：%s<br>%s</div>"
                       % (esc(lp.get("index")), esc(lp.get("quote")), esc(lp.get("why"))))
            for b in fr.get("bubbles", []):
                shown = b.get("text", "")
                orig = b.get("original", shown)
                cls = " class='diff'" if orig != shown else ""
                out.append("<div%s>%s：%s%s</div>"
                           % (cls, esc(b.get("speaker")), esc(shown),
                              "" if orig == shown else " &nbsp;<span style='color:#6f7d8c'>原句：%s</span>" % esc(orig)))
            out.append("</div>")
        out.append("</div>")

    doc = "\n".join(out)
    # 自检：曾经因为 <style> 没闭合，整页 HTML 被当成 CSS 吞掉，脚本却一路报 OK
    tail = doc.split("</style>")[-1]
    if doc.count("<style>") != doc.count("</style>") or "<h1>" not in tail:
        die("generated html malformed: unbalanced <style> or body swallowed")

    with open(os.path.join(GALLERY, "index.html"), "w", encoding="utf-8") as f:
        f.write(doc)
    sys.stdout.write("OK  gallery/index.html  groups=%d frames=%d\n"
                     % (len(groups), sum(len(g["frames"]) for g in groups)))


if __name__ == "__main__":
    main()
