#!/usr/bin/env node
'use strict';
/*
 * validate_frame.cjs — 帧规格前置闸 D1-D9
 * 零 npm 依赖。stdout 全 ASCII（Windows GBK 控制台会把中文打成 ????）。
 * 用法: node validate_frame.cjs <frame.json> [frame2.json ...]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.resolve(__dirname, '..');
const ROSTER_RAW = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'roster.json'));
const ROSTER = JSON.parse(ROSTER_RAW);
const STYLE_LOCK = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'style-lock.txt'), 'utf8');
// 素材是有版本的。改了设定卡之后，用旧版本生成的历史帧不该被判违规，
// 但也不能因此放过"这一轮偷偷改写 bible"。所以按 roster 内容哈希分别处理。
const ROSTER_DIGEST = crypto.createHash('sha1').update(ROSTER_RAW).digest('hex').slice(0, 12);

const NO_TEXT_CLAUSE = 'absolutely no text';

function norm(s) {
  return s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/^\s+|\s+$/g, '').normalize('NFC');
}

// 气泡容量（D6 的长度部分）不在 JS 里算。
// wrap() 的容量取决于标点位置：收尾标点允许把行撑破 1 列，启始标点不允许，
// 换成一个"总列数"公式必然两头都错（实测：17 汉字+！！ 能画，17 汉字+（（ 画不下，
// 而两者的总列数都是 19）。所以把整批气泡交给 compose_bubble.py --fit，读它的判决。
// 返回 Map<帧序号, 每条气泡的判决>；无法委托时返回 null（脚本降级为 WARN，不装成已检查）。
function delegateFit(rawFrames) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-still-fit-'));
  const files = [];
  const ordToFrame = new Map();
  try {
    rawFrames.forEach((fr, fi) => {
      if (!fr || !Array.isArray(fr.bubbles) || !fr.bubbles.length) return;
      const p = path.join(dir, 'fit-' + fi + '.json');
      fs.writeFileSync(p, JSON.stringify({ bubbles: fr.bubbles }));
      ordToFrame.set(files.length, fi);
      files.push(p);
    });
    if (!files.length) return new Map();

    let out = '';
    try {
      out = execFileSync('python', [path.join(SKILL_DIR, 'scripts', 'compose_bubble.py'), '--fit', ...files],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = e.stdout || '';   // 退出码 1 = 有气泡超容量，结论照常解析
    }
    const res = new Map();
    // Python 在 Windows 上把 stdout 的 \n 翻成 \r\n，行尾会挂一个 \r
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^FIT (\d+) (\d+) (ok|over|badslot)$/);
      if (!m) continue;
      const fi = ordToFrame.get(+m[1]);
      if (fi == null) continue;
      if (!res.has(fi)) res.set(fi, []);
      res.get(fi)[+m[2]] = m[3];
    }
    return res.size ? res : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function check(fr, file, fit) {
  const errs = [];
  const warns = [];
  const E = (d, m) => errs.push(`D${d} ${m}`);
  const W = m => warns.push(m);

  if (fr.schema !== 'mood-still/2') E(0, `schema must be mood-still/2, got ${JSON.stringify(fr.schema)}`);

  // D1 cast
  const names = Object.keys(ROSTER.characters);
  if (!Array.isArray(fr.cast) || fr.cast.length < 1 || fr.cast.length > 2) {
    E(1, 'cast must hold 1 or 2 characters');
  } else {
    for (const c of fr.cast) if (!names.includes(c)) E(1, `cast item not in roster; available: ${names.join(' | ')}`);
  }

  // D2 quote is substring of the indexed dialogue line
  const lp = fr.line_pick || {};
  const lines = String((fr.source || {}).dialogue || '').split('\n').map(l => l.trim()).filter(Boolean);
  const li = lp.index;
  if (!Number.isInteger(li) || li < 1 || li > lines.length) {
    E(2, `line_pick.index ${li} out of range 1..${lines.length}`);
  } else if (!lines[li - 1].includes(lp.quote || '\u0000')) {
    E(2, `line_pick.quote is not a substring of dialogue line ${li}`);
  }

  // D3 why
  if (typeof lp.why !== 'string' || lp.why.trim().length < 12) E(3, 'line_pick.why must be at least 12 chars');

  // D4 prompt must contain each cast bible verbatim, plus the style lock.
  // 若这帧是用**另一个版本**的 roster 生成的，D4 无法判定，降级为 WARN 而不是 FAIL。
  const p = (fr.prompt || {}).text || '';
  const recorded = (fr.source || {}).roster_digest;
  const drifted = recorded !== ROSTER_DIGEST;
  if (drifted) {
    W(`roster drifted since this frame was made (${recorded || 'unrecorded'} != ${ROSTER_DIGEST}); D4 skipped`);
  } else {
    for (const c of fr.cast || []) {
      const ch = ROSTER.characters[c];
      if (ch && !p.includes(ch.bible)) E(4, `prompt.text does not contain character bible of "${c}" verbatim`);
    }
    if (!p.includes(STYLE_LOCK.trim())) E(4, 'prompt.text does not contain assets/style-lock.txt verbatim');
  }

  // D5 no-text clause must survive
  if (!p.toLowerCase().includes(NO_TEXT_CLAUSE)) E(5, `prompt.text is missing the "${NO_TEXT_CLAUSE}" prohibition`);

  // D6/D7 bubbles
  const bs = fr.bubbles || [];
  if (bs.length > 2) E(6, 'at most 2 bubbles per still');
  if (bs.length && !fit.available) W('bubble fit NOT checked: compose_bubble.py --fit unavailable');
  bs.forEach((b, bi) => {
    if (!fr.cast.includes(b.speaker)) E(6, `bubble speaker "${b.speaker}" is not on stage`);
    const v = fit.verdicts ? fit.verdicts[bi] : undefined;
    if (v === 'over') E(6, `bubble ${bi} does not fit its slot: compose_bubble refuses to lay it out (compress it, don't widen the slot)`);
    if (v === 'badslot') E(6, `unknown bubble slot ${JSON.stringify(b.slot)}`);
    const [ax, ay] = b.anchor || [];
    if (!(ax >= 0 && ax <= 1 && ay >= 0 && ay <= 1)) E(7, `bubble anchor out of 0..1: ${JSON.stringify(b.anchor)}`);
    if (b.head_r != null && !(b.head_r > 0.02 && b.head_r < 0.5)) E(7, `bubble head_r out of range: ${b.head_r}`);
  });

  // D10 沉默可以一个气泡都不放，但只限 quote 本身就是标点的情况
  const silent = /^[\s…‥.。·、\-—]*$/.test(lp.quote || '');
  if (!silent && bs.length === 0) E(10, 'no bubble at all, but the picked line is spoken words');

  // D9 base image must exist and match declared size
  const img = fr.image || {};
  const imgPath = path.join(path.resolve(file, '..'), img.file || '');
  if (!img.file || !fs.existsSync(imgPath)) {
    E(9, `base image missing: ${img.file}`);
  } else {
    const fd = fs.openSync(imgPath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.toString('latin1', 1, 4) !== 'PNG') {
      E(9, 'base image is not a PNG');
    } else {
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      if (w !== img.w || h !== img.h) E(9, `declared ${img.w}x${img.h} but PNG is ${w}x${h}`);
    }
  }

  return { errs, warns };
}

function main() {
  const files = process.argv.slice(2);
  if (!files.length) { process.stdout.write('FAIL  usage: validate_frame.cjs <frame.json> [...]\n'); process.exit(2); }

  // 预扫一遍：D8 需要跨文件统计同一 digest 下的候选数
  const parsed = new Map();
  for (const f of files) {
    try { parsed.set(f, JSON.parse(fs.readFileSync(f, 'utf8'))); }
    catch (e) { parsed.set(f, null); }
  }
  const seen = new Map();
  // D6 的容量判决整批一次委托出去，省掉每帧一个进程
  const fitMap = delegateFit(files.map(f => parsed.get(f)));
  const fit = i => ({ available: fitMap !== null, verdicts: fitMap ? fitMap.get(i) : undefined });

  let bad = 0, skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const fr = parsed.get(f);
    if (fr === null) {
      process.stdout.write(`FAIL  ${path.basename(f)}  unreadable json\n`);
      bad++;
      continue;
    }
    // 组目录里还有 kept.json / group.json 等非帧文件。
    // 判据用"有没有任何帧字段"，而不是看 schema —— schema 写错的真帧必须照常报 D0。
    if (!fr.source && !fr.line_pick && !fr.cast) {
      process.stdout.write(`SKIP  ${path.basename(f)}  (not a frame spec)\n`);
      skipped++;
      continue;
    }
    const dg = (fr.source || {}).digest || '(none)';
    seen.set(dg, (seen.get(dg) || 0) + 1);
    const { errs, warns } = check(fr, f, fit(i));
    if (seen.get(dg) > 3) errs.push('D8 more than 3 candidates share this digest');
    const tag = errs.length ? 'FAIL' : 'PASS';
    process.stdout.write(`${tag}  ${path.basename(f)}\n`);
    errs.slice(0, 12).forEach(e => process.stdout.write(`      ${e}\n`));
    warns.forEach(w => process.stdout.write(`      WARN ${w}\n`));
    if (errs.length) bad++;
  }
  const judged = files.length - skipped;
  process.stdout.write(`\n${judged - bad}/${judged} frames valid` + (skipped ? `  (${skipped} non-frame skipped)\n` : '\n'));
  process.exit(bad ? 1 : 0);
}

main();
