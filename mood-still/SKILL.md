---
name: mood-still
description:
  把一段多轮对白演成一张动漫画风的静态定格插画。当用户贴出一段带角色名的对话（每行形如「角色名：台词」）并想要插画、漫画格、意境图、把这一幕画出来时使用；输出 2-3 张不同选句的候选、落进本地画廊并等人工挑选保留张。角色一致性靠逐字复用的设定卡与人工看图闸门，不靠骨骼与素材图片。不做动画片段、不做骨骼绑定、不做脱离对白的随机配图。
argument-hint: <多轮对白，行首为「角色名：台词」>
---

# 意境定格（mood-still）

## Overview

输入一段多轮对白，输出 2-3 张**动漫画风的静态插画**，每张定格对白中"关系发生位移"的那一句，配中文台词气泡，沉淀进本地画廊由人挑选保留张。

一期只交静态图。会动的演求是二期，本 skill 不做。

**前置条件**：本机需有 `node`（跑 `.cjs` 拼装器与闸门，零 npm 依赖）与 Python + Pillow（`compose_bubble.py` 叠气泡）。中文字体路径写在 `assets/bubble.json`（含两条回退），三处都没有时脚本会明确报 `no CJK font found`，不会画出一张空气泡。产物一律落在**当前项目**的 `gallery/groups/` 下——换项目用就是各建各的画廊，skill 本体不带任何数据。

## 核心不变量

1. **中文绝不由图像模型生成**。模型画中文必崩。画面提示词必须包含禁文字子句，台词一律由 `compose_bubble.py` 后期叠加。
2. **角色设定卡与画风锁逐字复用**。它们是本 skill 唯一的"素材"。改写一个字就可能让角色漂移。`validate_frame.cjs` 的 D4 会拒绝未逐字包含的版本。
3. **每张候选必须带选句声明**（`line_pick.why`，≥12 字）。没有声明的产出视为不合格，等同于没做。
4. **表达不了就说表达不了**。若一段对白的情绪无法落成具体画面，直接回答"表达不了 + 缺哪个维度"，禁止硬凑一个画面交差。
5. **机器判据全绿不等于通过**。最终由用户看图签字。

## 工作流

### 1. 解析对白

- 按行拆 `角色名：台词`。行首名字必须命中 `assets/roster.json`；不命中就**停下来**列出可用角色让用户改，不要猜。
- 舞台上最多 2 个角色。超过 2 个则说明本 skill 一期不支持，不要硬排。

### 2. 选句

从对白里挑**关系发生位移**的那一句：靠近、退开、隐瞒、被揭穿、欲言又止。不要默认挑最后一句，也不要挑最吵的那句。

一句都挑不出来（每一行都是纯信息往来、关系一动没动）时，按核心不变量 #4 回答「表达不了 + 缺哪个维度」（缺的通常是**选句**维度），**不产出候选**：没有位移的一句，`line_pick.why` 只能写成空话，画面再好看也与台词无关。语料 T5 就是这个用例；边界见其"防过度拒绝"条。

同一批 2-3 张候选必须选**不同**的句子或不同场景，否则会被 §6 的死板闸拦下。

### 3. 组装画面提示词

**不要手打提示词**——设定卡逐字复用这件事由脚本保证。先写一份 `_scenes.json` 当成这一组的输入，放在组目录里：

```jsonc
{
  "dialogue": "<多轮对白原文，行首「角色名：台词」>",
  "candidates": [
    { "id": 1,
      "line_pick": { "index": 3, "quote": "…", "why": "…" },
      "cast": ["柴犬", "小男孩"],
      "scene": { "place": "…", "time": "…", "weather": "…", "light": "…", "mood": "…",
                 "action": "谁在左谁在右 + 身体动作", "framing": "中近景双人" },
      "scene_en": "<英文 SCENE 段：景物/光/站位/表情/景别>",
      "bubbles": [ { "speaker": "…", "text": "…", "original": "…", "anchor": [0.7,0.27], "head_r": 0.17, "slot": "mid" } ] }
  ]
}
```

然后跑：

```bash
node <skill>/scripts/assemble_frame.cjs gallery/groups/<组>/_scenes.json
```

它写出 `prompt-N.txt`（原样交给 ImageGen 的那一份）与 `frame-N.json`。拼装顺序固定：按 `cast` 顺序的设定卡原文 → `SCENE: <scene_en>` → 画风锁原文，两两之间空一行；`source.*` 与 `prompt.*` 由它算，`base-N.png` 已在时连 `image.w/h` 也按真图读。

`SCENE` 段必须显式写出**谁在左谁在右**和身体动作——气泡锚点要靠它来估。

**表情只写在 `scene_en` 里**。设定卡只描述不变的外观（毛色、眼型、体型、尾巴），不含任何情绪词——T4 实测：bible 里写「gentle, curious, open face」会让低沉场景里的角色笑出来。需要表情时，在 `scene_en` 里明确写眉眼嘴的状态。

### 4. 生成底图

用 `ImageGen`，尺寸 1024x768，提示词用 `prompt-N.txt` 的完整原文（**读文件，不要凭记忆打**）。把结果复制为组目录下的 `base-N.png`，然后重跑一次 §3 的命令，把 `image.w/h` 按真图写进帧规格。

### 4b. 看图自查（不可跳过）

底图落盘后**必须自己读一遍那张图**，逐条核对：

- **表情是否与所选那句相符？** 冲突就判这张作废重出。这是最容易漏的一项：模型对「柴犬」「anime」的先验会把脸往笑上拉，即使场景段里明确写了「not smiling」也只部分服从（T4 实测）。低沉、告别、羞愧这类句子尤其容易被画成开心。
- 左右站位是否与 `scene.action` 一致（气泡锚点依赖它）。
- 画面里有没有混进文字、招牌、水印。
- 角色还是不是同一只（配色分布、眼型、尾巴形态）。
- **解剖与视角是否自洽？** 这是模型不稳定的典型信号，**一律作废，绝不交付**。具体查：要求的视角和实际露出的部位对不对得上（实测过失败的例子：要求"完全背对、脸不可见"，结果画成**身体背面 + 头上长着正脸的眼睛和眉斑**的嵌合体）；四肢数量与着地关系；头颈连接；影子方向。

**废图必须隔离，不能留在候选池里**。把不合格的原图移出 `vibe_images/`，改名放进项目的 `work/rejected/`（目录不存在就建），用文件名写清废因，例如
`REJECT-ANATOMY-BROKEN_back-body-front-face__<原名>.png`。
它们只是诊断证据，**永远不进 `gallery/`、不进候选、不参与选句、不作为交付物**。

重出时**不要靠描述嘴和眼去改表情**——这条路已被两次实测否证：写「not smiling」只部分服从，改写成肯定式的「mouth a flat horizontal line, lids heavy」反而画出一副半眯眼的得意 smirk。真正有效的杠杆是**姿态与构图**：

- 低沉 / 等待 / 被留下：让它**趴下**（下巴压住前爪）、或**背对镜头**不露脸、或只给剪影与倒影。
- 高兴 / 期待：正面坐姿、耳朵前倾、尾巴高位。
- 羞愧：身体转向一侧、露出后脑。

理由（T3 修正过，早期版本把这条说反了）：模型对「柴犬 + anime + **坐着面向镜头**」的先验确实是一张满足的笑脸，而**否定式措辞几乎无效**（写「not smiling」仍笑）。但**具体几何的肯定式描述是有效的**——T3 的 C2 靠「两枚奶油眉斑压低并向中间靠、眼睑半垂、闭合成一条平线的嘴」拿到了标准的怀疑脸。

所以杠杆按有效性排序：**① 换姿态**（趴下、下巴压爪、头低垂——最强，且必须保持正面或四分之三视角）；**② 眉部与眼睑的几何描述**（次强，实测可用）；**③ 否定式"不要笑"**（基本无效，不要浪费提示词预算）。

**但姿态要换得画得出来**：实测要求"完全背面、脸不可见"会得到一个解剖错误的嵌合体——身体背面 + 头上却画着正脸的眼睛。可用的低沉姿态必须**保持正面或四分之三视角**：趴下、下巴压住两只前爪、头低垂、半闭眼。"趴着"这个骨架本身就已经足够低能量，不需要靠转身。同一候选最多重出 2 次，仍不合就如实告诉用户"这一句我拿不到对的表情"，不要交一张错的。

**重出会把你已经拿到的东西一起重掷。** 测试场跨五轮的统计是：首抽过四闸门 33%，而**重出把原本已达标项弄坏 44.4%**（其中闸门级 22.2%）——同一张图里"狗站起来了"和"狗别咧嘴"在模型端是竞争关系，不是并列关系。由此三条：

- **一次只钉一个会互相抢像素的缺陷**，其余原样保留；否则你不知道到底是哪个改动起了作用，也不知道什么被弄坏了。修完必须回头复查上一版已经对的那几项。
- **否定式对"可见性"也无效**。`so the paws are NOT visible`、`no blush`、`no stray marks` 这三句在实测里全部没被执行；有效写法是**用另一件肯定事实占住那圈像素**："脸颊与额头是同一种平涂肤色"、"从狗身侧往右扫过：体毛 → 尾巴带 → 毯子，两条前腿都留在那条带子后面"。
- **别人给你的措辞就照抄，别顺手加工**。实测把建议句改写成 `high eye-to-face ratio typical of a NINE OR TEN YEAR OLD` 之后，这句字面要的正是幼儿特征，还和设定卡的 `about eight years old` / `soft round face` 三处打架。

**所有文本闸门查的都是字段与几何；画面里角色在笑还是在哭、有没有换脸，机器一概不知**——除了 §6 的 `identity_check.py`，它量的是像素。这一步仍是人工终审之前唯一的自查机会。

### 5. 写帧规格

`frame-N.json`，schema `mood-still/2`。字段见 `references/frame-spec.md`。**它由 §3 的 `assemble_frame.cjs` 生成，不要手改**——要改就改 `_scenes.json` 再重跑，否则下一轮重跑会覆盖你的手改。你唯一需要手写的数是：

- `bubbles[].anchor` 是**归一化坐标**（0..1），指向说话人头部中心；`head_r` 是头部圆盘半径（归一化到高度）。**看图之后再估**，估准了引线才不会指错人——但别裸估：跑 `python <skill>/scripts/anchor_grid.py --frame gallery/groups/<组>/frame-N.json`，它把 0.1 归一化网格与**当前这两个数画出的圆**叠在底图上，输出到 `work/grid/`（不进组目录、不进画廊）。圆压在头发上而不是脸上 → 调 `anchor`；圆盖不住头部质量 → 调 `head_r`。改 `_scenes.json` 重跑 §3 与 §6，再叠一次确认。帧还没生成时给它底图路径 + `--disc X,Y,R` 探一个候选圆。**首估必偏**：实测三个组的圆盘全部估歪，靠这一步一轮才改准。
- `identity`（可选但强烈建议）：给 §6 同一性检查用的归一化区域框 `{ "under_eye_near": [x0,y0,x1,y1], "tail_region": [...], "dog_muzzle": [...] }`。**框必须由看过图的人标**——按颜色自动定位杂点不可行（那块水泥斑的 RGB 与背景墙几乎一样，实测命中 3567 处）。`identity_expect.tongue_baseline` 填同一场景已通过帧的舌色像素数，跨版本一比就知道狗嘴有没有从"张开带舌"闭成笑线。
- 气泡文本超长按 `references/bubble-rules.md` 压缩，并在 `why` 末尾追加 `（已压缩：原句 <…>）`；`line_pick.quote` 永远是原文。**压缩不许丢掉态度词**（实测把「你激动什么」切掉，等于把这句的刀锋剪了）；`why` 里声称改了什么，必须以文件为准。

`source.digest` / `source.roster_digest` / `prompt.text` / `prompt.chars` / `image.w/h` 都由脚本写，不要手填——手填的 `roster_digest` 只要格式差一点（例如多打一个 `sha1:` 前缀）就会与素材对不上，D4 被降级跳过，这一帧就失去设定卡保护，而退出码还是 0。

### 5b. 命名与 digest 约定

**组目录**：`gallery/groups/<YYYY-MM-DD>-<NN>/`，NN 是当天第几组，从 `01` 起两位补零。建组前先列 `gallery/groups/`，取当天已有最大 NN+1。同一组内的多张候选共享一个目录，**不同对白必须另起一组**——否则 D8 与死板闸会把两组混算。

**对白 digest 由 `assemble_frame.cjs` 按固定归一化算**（CRLF→LF、去行尾空白、NFC、去首尾空行），它写在 `source.digest` 里并打进 stdout。不要自己发明归一化——发明了就分组失效，连测闸会拿错配的对手比。想核对历史帧的 hash 才需要手算，用的还是同一条：

```bash
node -e "const c=require('crypto'),fs=require('fs');
let s=fs.readFileSync(0,'utf8');
s=s.replace(/\r\n/g,'\n').split('\n').map(l=>l.replace(/[ \t]+$/,'')).join('\n').trim().normalize('NFC');
console.log('sha1:'+c.createHash('sha1').update(s).digest('hex').slice(0,12))" <<< "柴犬：你带伞了吗？
小男孩：……没有。"
```

### 6. 过闸

前五条每轮必跑。

```bash
node  <skill>/scripts/validate_frame.cjs  gallery/groups/<组>/frame-1.json ...
python <skill>/scripts/compose_bubble.py  gallery/groups/<组>/frame-1.json  gallery/groups/<组>
python <skill>/scripts/drift_check.py     gallery/groups/<组> --expect fresh
python <skill>/scripts/identity_check.py  gallery/groups/<组>/frame-1.json ...
python <skill>/scripts/build_gallery.py
```

`identity_check.py` 量的是**像素**，专治"重出把角色换了脸"：I1 眼下/脸颊（两条互补判据都跑）——**I1a 粉团**（比区域中位色更粉且成团，对框歪免疫）与 **I1b 亮度极差 ≤15**（抓的是暗短线与斑块，实测 r2-06=106.0 对 07=7.4，但**它对框的位置极敏感**：往下挪 2% 就从 19.0 跳到 112.7，压到瞳孔会到 244.7；工具因此会报 `INCONCLUSIVE 框压到眼睛`而不是假称抓到缺陷）；I2 尾巴邻域里有没有"又暗又灰的实心块"（杂点与合法奶油尾尖单靠饱和度分不开，必须同时比周围暗，且要成团）；I3 口鼻区舌色像素与已通过帧是否同数量级（狗嘴从"张开带舌"闭成笑线会掉一个数量级）。它没标 `identity` 区域就只报 SKIP——**没有区域等于没检查**，别把 SKIP 当通过。

注意 `validate_frame.cjs` 的 D8 数的是**单次调用传入的帧**，所以**必须逐组跑**；把多个组一次喂进去，跨版本累积的候选会被判成刷图。

只要动过 skill 自身（`assets/`、`scripts/`、`SKILL.md`），再多跑这三条：

```bash
node <skill>/scripts/mutation_test.cjs    # 变异实验：证明闸门真的会咬，30 例
node <skill>/scripts/check_skill.cjs      # frontmatter / 正文长度 / 引用的文件是否都存在
node <skill>/scripts/verify_gallery.cjs   # 在项目根跑：画廊引用的图都在，废图没混进交付
```

- `validate_frame` 报错就**改 `_scenes.json` 再重跑装配**，不要放宽脚本，也不要直接手改 `frame-N.json`（会与输入漂移）。
- 气泡放不放得下**只有一个定义**：`compose_bubble.py` 的 `wrap()`。`validate_frame` 把整批气泡交给 `compose_bubble.py --fit` 判，自己不算列数——换行禁则让"总列数"这个公式两头都错（17 汉字+`！！` 画得下，17 汉字+`（（` 画不下，总列数都是 19）。所以**不要**在 JS 里重算列宽。
- 若 `validate_frame` 打出 `WARN bubble fit NOT checked`，说明本机 python 不可用，容量这一条这轮没被检查——别把它当成通过。
- `drift_check` 判 `STALE` 说明候选互相复读：换选句、换景别、换主体位置，重来。不许改阈值。
- `drift_check` 需要**至少 2 帧**；只出 1 张时跳过它（它会以 `FAIL need at least 2 frames` 退出，那不是错误）。`gallery/groups/2026-09-25-01` 就是这种单帧施工样本（也是用 v1 素材做的），保留作演变证据，跑闸时跳过。
- 它若打出 `WARN comp dim inert`，说明有候选没有气泡，构图维度没参与判定——这一轮的"不重复"结论比平时弱，要人工多看一眼。
- `compose_bubble` 若报 `cannot avoid heads`，说明锚点估偏了，重估而不是改脚本。

### 7. 交人工终审

把候选 PNG 路径列给用户，逐张说明选了哪句、为什么。**等用户指定保留张**再写 `kept.json`：

```bash
# kept.json 形如（保留张可以有 1 张以上，用 ids 列表）
{"ids":["frame-2","frame-3"],"at":"2026-09-25T10:12:00","note":"引线最干净"}
```

写完重跑 `build_gallery.py` 刷新高亮。

## 首次使用前的闸门自证

在任何功能验收之前，先跑一次判据自证（夹具已内置）：

```bash
F=<skill>/references/fixtures
python <skill>/scripts/drift_check.py $F/negative            --expect stale
python <skill>/scripts/drift_check.py $F/pass                --expect fresh
python <skill>/scripts/drift_check.py $F/single-line-fresh   --expect fresh
python <skill>/scripts/drift_check.py $F/single-line-stale   --expect stale
```

四条都必须 `GATE  ok`。后两条守的是一个真实陷阱：**单句对白里 `pick` 与 `text` 被输入锁死**，若不把"本来就不能不同"的维度排除出去，闸二会对所有单句对白永远判死板（T4 实测踩过）。

若前两条被判反，说明死板判据是空的或过紧了——**先修判据，别开始出图**。

## Resources

- `assets/roster.json` — 角色注册表与逐字设定卡（柴犬 / 小男孩）。新增角色只改这里。
- `assets/style-lock.txt` — 画风锁原文，含禁文字硬条款。
- `assets/bubble.json` — 气泡样式：字体、字号、槽宽、描边、引线、避让阈值。
- `scripts/assemble_frame.cjs` — §3/§5 的机械拼装：`_scenes.json` → `prompt-N.txt` + `frame-N.json`，两个 digest 与 `image.w/h` 由它算。零 npm 依赖。
- `scripts/validate_frame.cjs` — D0-D10 前置闸。零 npm 依赖。
- `scripts/compose_bubble.py` — 接缝 S1，确定性合成。需 Pillow。用法 `<帧> [<帧> ...] <输出目录>` 或 `--fit <帧> ...`。头部圆盘几何 `head_disc()` 是**唯一定义处**。
- `scripts/anchor_grid.py` — §5 的看图辅助（不参与交付）：叠 0.05/0.1 归一化网格与头部圆盘，输出到 `work/grid/`。圆盘几何 import 自 `compose_bubble.head_disc`，两边永远是同一个圆。
- `scripts/identity_check.py` — §6 的同一性回归检查：读帧规格里的 `identity` 区域，**量像素**判眼下平色 / 尾巴灰块 / 口鼻舌色。它是为"重出把角色换脸"这一类失败专门造的，此前没有任何检查会拦。
- `scripts/drift_check.py` — 连测判死板闸 + 负样本/对照自证。
- `scripts/build_gallery.py` — 重建 `./gallery/index.html`。画廊长在**当前项目根目录**，不在 skill 目录内。
- `scripts/mutation_test.cjs` — 变异实验：证明闸门真的会咬。改了 `assets/`、`scripts/` 或本文件就跑它。
- `scripts/check_skill.cjs` — frontmatter / 正文长度 / 正文引用的文件是否都存在。
- `scripts/verify_gallery.cjs` — 在项目根跑：画廊引用的图都在、废图没混进交付、`kept.json` 没有悬空 id。
- `references/frame-spec.md` — 帧规格完整字段与取值域。
- `references/bubble-rules.md` — 长台词压缩与换行口径。
- `references/scene-vocab.md` — 意境到场景/光/景别的检索表。
- `references/test-dialogues.md` — 固定测试语料。

## 约束

- 脚本不碰网络。`ImageGen` 只由 agent 调用。
- 脚本 stdout 一律 ASCII——Windows GBK 控制台会把中文打成 `????`。
- 一次调用候选数上限 3，超出即不合格产出。
- 成品是 PNG。不要交付 `.svg`：内嵌位图的 SVG 会被部分看图程序只渲染背景。
