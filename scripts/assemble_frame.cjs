#!/usr/bin/env node
'use strict';
/*
 * assemble_frame.cjs — §3/§5 的机械拼装：scenes 文件 → prompt-N.txt + frame-N.json
 *
 * 为什么需要它：设定卡必须**逐字**复用，但"逐字"原先只能靠人誊抄。冷启动实测一次手写
 * 就踩了两个坑：`roster_digest` 多打 `sha1:` 前缀，D4 静默降级（照文档做出来的帧反而
 * 没有设定卡保护）；提示词里的 SCENE 段与 `scene` 字段各写一遍，两边可以无声漂移。
 * 拼装交给脚本之后，这两类错误没有发生的位置。
 *
 * 用法: node assemble_frame.cjs <组目录>/_scenes.json [...]
 *
 * 输入（手写）:
 *   {
 *     "dialogue": "<多轮对白原文，行首「角色名：台词」>",
 *     "candidates": [
 *       { "id": 1, "line_pick": {…}, "cast": ["柴犬","小男孩"],
 *         "scene": { "place": …, "time": …, "weather": …, "light": …, "mood": …,
 *                    "action": …, "framing": … },        // 中文，给帧规格与人看
 *         "scene_en": "<英文 SCENE 段落：景物/光/站位/表情/景别>",  // 送进图像模型的那段
 *         "bubbles": [ { speaker, text, original, anchor, head_r, slot } ] }
 *     ]
 *   }
 *
 * 输出（与 _scenes.json 同目录）: prompt-<id>.txt 与 frame-<id>.json
 *   - prompt-N.txt 是**原样交给 ImageGen 的那一份**，读它，不要凭记忆打
 *   - frame-N.json 的 source.* / prompt.* 由本脚本算；base-N.png 存在时 image.w/h 也按真图读
 *
 * 只做拼装，不做判据：D0-D10 由 validate_frame.cjs 管，本脚本一条都不复算。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILL = path.resolve(__dirname, '..');
const ROSTER_PATH = path.join(SKILL, 'assets', 'roster.json');
const LOCK_PATH = path.join(SKILL, 'assets', 'style-lock.txt');

function die(msg) {
  process.stdout.write('FAIL  ' + msg + '\n');
  process.exit(1);
}

const rosterRaw = fs.readFileSync(ROSTER_PATH);
const ROSTER = JSON.parse(rosterRaw.toString('utf8')).characters;
const LOCK = fs.readFileSync(LOCK_PATH, 'utf8').trim();
// 裸十六进制。带上 "sha1:" 前缀会让 D4 把"素材漂移"判成真、静默降级成 skipped。
const ROSTER_DIGEST = crypto.createHash('sha1').update(rosterRaw).digest('hex').slice(0, 12);

// 与 SKILL.md §5b 的归一化逐字一致：CRLF→LF、去行尾空白、去首尾空行、NFC
function dialogueDigest(s) {
  const n = s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').trim().normalize('NFC');
  return 'sha1:' + crypto.createHash('sha1').update(n).digest('hex').slice(0, 12);
}

// 零依赖读 PNG 尺寸（IHDR 定长在偏移 16/20）
function pngSize(p) {
  const b = fs.readFileSync(p);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const KNOWN = ['schema', 'source', 'line_pick', 'cast', 'scene', 'scene_en', 'prompt', 'image', 'bubbles'];

function buildOne(dir, c, dialogue, digest) {
  const id = c.id;
  if (id == null || id === '') die('candidate without "id"');
  if (!Array.isArray(c.cast) || c.cast.length < 1 || c.cast.length > 2) {
    die('candidate ' + id + ': cast must list 1..2 names');
  }
  const miss = c.cast.filter(x => !ROSTER[x]);
  if (miss.length) die('candidate ' + id + ': cast not in assets/roster.json: ' + miss.join(', '));
  if (typeof c.scene_en !== 'string' || !c.scene_en.trim()) {
    die('candidate ' + id + ': scene_en missing — the English SCENE paragraph is what the image model reads');
  }

  // 顺序固定：出场角色按 cast 顺序的设定卡原文 → SCENE 段 → 画风锁原文，两两之间空一行
  const promptText = [...c.cast.map(n => ROSTER[n].bible), 'SCENE: ' + c.scene_en, LOCK].join('\n\n');

  const imgFile = 'base-' + id + '.png';
  const imgPath = path.join(dir, imgFile);
  let image = { file: imgFile };
  if (fs.existsSync(imgPath)) {
    const sz = pngSize(imgPath);
    if (!sz) die('candidate ' + id + ': ' + imgFile + ' exists but is not a readable PNG');
    image.w = sz.w;
    image.h = sz.h;
  }

  const fr = {
    schema: 'mood-still/2',
    source: { dialogue: dialogue, digest: digest, roster_digest: ROSTER_DIGEST },
    line_pick: c.line_pick,
    cast: c.cast,
    scene: c.scene,
    scene_en: c.scene_en,
    prompt: { text: promptText, chars: promptText.length },
    image: image,
    bubbles: c.bubbles,
  };
  // 不认识的手写字段原样带走：这个脚本不该静默删掉作者写下的东西
  for (const k of Object.keys(c)) if (!KNOWN.includes(k) && k !== 'id') fr[k] = c[k];

  fs.writeFileSync(path.join(dir, 'prompt-' + id + '.txt'), promptText);
  fs.writeFileSync(path.join(dir, 'frame-' + id + '.json'), JSON.stringify(fr, null, 2) + '\n');
  return { id: id, chars: promptText.length, image: image.w ? image.w + 'x' + image.h : 'pending' };
}

function assemble(scenesPath) {
  if (!fs.existsSync(scenesPath)) die('scenes file not found: ' + scenesPath);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(scenesPath, 'utf8'));
  } catch (e) {
    die('scenes file is not valid JSON: ' + path.basename(scenesPath) + ' (' + e.message + ')');
  }
  if (typeof doc.dialogue !== 'string' || !doc.dialogue.trim()) die('scenes file needs a non-empty "dialogue"');
  if (!Array.isArray(doc.candidates) || !doc.candidates.length) die('scenes file needs a non-empty "candidates" array');

  const dir = path.dirname(path.resolve(scenesPath));
  const digest = dialogueDigest(doc.dialogue);
  const out = doc.candidates.map(c => buildOne(dir, c, doc.dialogue, digest));
  for (const o of out) {
    process.stdout.write('OK  frame-' + o.id + '.json  prompt-' + o.id + '.txt  chars=' + o.chars + '  image=' + o.image + '\n');
  }
  process.stdout.write('OK  n=' + out.length + '  roster_digest=' + ROSTER_DIGEST + '  dialogue_digest=' + digest + '\n');
}

const argv = process.argv.slice(2);
if (!argv.length) die('usage: assemble_frame.cjs <scenes.json> [...]');
for (const p of argv) assemble(p);
