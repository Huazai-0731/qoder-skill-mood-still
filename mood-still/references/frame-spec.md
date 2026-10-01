# 帧规格 `mood-still/2`

一次候选 = 一份帧规格。它是 `compose_bubble.py` 与 `drift_check.py` 的唯一输入。

```jsonc
{
  "schema": "mood-still/2",
  "source": { "dialogue": "柴犬：…\n小男孩：…", "digest": "sha1:…", "roster_digest": "6de272e3370a" },
  "line_pick": { "index": 2, "quote": "……没有。", "why": "≥12 字的选句理由" },
  "cast": ["柴犬", "小男孩"],
  "scene": {
    "place": "屋檐下的街口", "time": "傍晚", "weather": "小雨",
    "light": "路灯暖光从右后", "mood": "安静、略带愧疚",
    "action": "谁在左谁在右 + 身体动作", "framing": "中近景双人"
  },
  "scene_en": "<英文 SCENE 段原文：送进图像模型的那一段>",
  "prompt": { "text": "<设定卡 + SCENE + 画风锁 的完整原文>", "chars": 2531 },
  "image":  { "file": "base-1.png", "w": 1024, "h": 768 },
  "bubbles": [
    { "speaker": "小男孩", "text": "……没有。", "original": "……没有。",
      "anchor": [0.693, 0.254], "head_r": 0.13, "slot": "mid" }
  ]
}
```

## 字段口径

**帧规格是生成物，不要手改。** `frame-N.json` 由 `assemble_frame.cjs` 从 `_scenes.json` 生成；下表的"手写/生成"列写明谁负责哪个字段。手改帧规格而不改输入，下一轮重跑就会覆盖。

| 字段 | 约束 | 谁校验 | 谁写 |
|---|---|---|---|
| `source.dialogue` | 对白原文（`drift_check` 按它的行数决定哪些维度是输入锁死的） | — | 生成 |
| `source.digest` | 对白归一化后 sha1：CRLF→LF、去行尾空白、NFC、去首尾空行（带 `sha1:` 前缀） | 约定，不校验 | 生成 |
| `source.roster_digest` | 生成这帧时 `assets/roster.json` 的 sha1 前 12 位，**裸十六进制、不带 `sha1:` 前缀**（带了就与当前素材对不上，D4 会被降级跳过） | 决定 D4 是否强制 | 生成 |

**为什么要 `roster_digest`**：设定卡是会改的固定素材。改了 bible 之后，旧帧的 `prompt.text` 里装的是旧版原文，若 D4 仍按当前版本比对，就会把**历史记录全部判成违规**，于是没人敢改设定卡。所以 D4 只在两把哈希一致时强制；不一致时降级为 `WARN roster drifted … D4 skipped`。
逃生口不能变成总闸：`M15/M16` 两条变异样本专门守住"哈希一致时篡改 bible 仍必须报 D4"以及"一致且干净的帧必须能过"。

| 字段 | 约束 | 谁校验 | 谁写 |
|---|---|---|---|
| `line_pick.index` | 1 起的行号，指向 `source.dialogue` 中非空行 | D2 | 手写 |
| `line_pick.quote` | 必须是该行**子串**，永远是原文，不得改写 | D2 | 手写 |
| `line_pick.why` | ≥12 字，说明为什么是这一句 | D3 | 手写 |
| `cast` | 1..2 项，全部命中 `roster.json` | D1 | 手写 |
| `scene.place/time/weather` | 自由文本，但**参与死板判定**（三元组全等算相同） | — | 手写 |
| `scene.framing` | 远景 / 全景 / 中景 / 中近景双人 / 近景 / 特写 | — | 手写 |
| `scene_en` | 英文 SCENE 段原文——**实际送进图像模型的那一段**，留在帧里可审计 | 约定 | 手写 |
| `prompt.text` | 必须逐字包含每个出场角色的 `bible` 与 `style-lock.txt` 全文，且含 `absolutely no text` | D4 D5 | 生成 |
| `image.file/w/h` | 相对帧规格文件的路径；尺寸必须与 PNG 实际值一致（`w/h` 按真 PNG 的 IHDR 读） | D9 | 生成 |
| `bubbles` | ≤2 个；`speaker` 必须在 `cast` 中 | D6 | 手写 |
| `bubbles.text` | 容量由 `compose_bubble.py --fit`（即 `wrap()`）**独占判定**：≤ `max_lines` 行，且收尾标点允许把行撑破 1 列、启始标点不允许收行。所以容量**不是**一个总列数，别在任何地方复算 | D6 | 手写 |
| `bubbles.original` | 压缩前的原句；与 `text` 不同时画廊会高亮 | 约定 | 手写 |
| `bubbles.anchor` | 归一化 0..1，指向说话人头部中心；**看图之后**再估，改在 `_scenes.json` 里。用 `scripts/anchor_grid.py --frame <帧>` 把网格与当前圆叠上去查，别裸估 | D7 | 手写 |
| `bubbles.head_r` | 归一化到画面**高度**的头部半径，0.02..0.5。像素口径由 `compose_bubble.head_disc()` 单源定义，`anchor_grid.py` import 同一个函数——两边永远是同一个圆 | D7 | 手写 |
| `bubbles.slot` | `small`(7列) / `mid`(9列) / `large`(12列) | D6 | 手写 |

## 死板判定用到的四个维度

`drift_check.py` 两两比较：

1. **选句** — `line_pick.index`
2. **场景** — `place + time + weather` 三元组
3. **构图** — `framing` + 首个气泡锚点落在画面左/右
4. **台词** — 气泡文本集合

任一对有 ≥2 项相同即判 `STALE`。
