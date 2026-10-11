#!/usr/bin/env node
'use strict';
/*
 * mutation_test.cjs — 变异实验：证明闸门真的会咬。
 *
 * 对一份现场合成的合法帧逐条注入单一缺陷，断言 validate_frame.cjs 恰好报出对应的 D 规则。
 * 只破坏一个维度 -> 必须红；不破坏 -> 必须绿。
 *
 * 基线不再取自某个 gallery 组（那会让 skill 自检依赖项目状态），
 * 而是从当前 assets/ 的设定卡与画风锁现场拼出来 —— 素材一改，基线跟着改。
 * 底图也是现场生成的真 PNG（Node zlib 手写 IHDR/IDAT/IEND），仓库里不放二进制。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-still-mut-'));
console.log('scratch: ' + OUT);

const W = 1024, H = 768;

function makePng(w, h, rgb) {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = t[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(new Array(h).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
fs.writeFileSync(path.join(OUT, 'base-1.png'), makePng(W, H, [237, 232, 222]));

const rosterRaw = fs.readFileSync(path.join(SKILL, 'assets', 'roster.json'));
const ROSTER = JSON.parse(rosterRaw).characters;
// 帧里记录的 roster 哈希必须与当前 assets 一致，D4 才会强制；
// 篡改类变异要先声明"我就是用当前这版素材做的"。
const CUR = crypto.createHash('sha1').update(rosterRaw).digest('hex').slice(0, 12);
const LOCK = fs.readFileSync(path.join(SKILL, 'assets', 'style-lock.txt'), 'utf8').trim();
const CAST = ['柴犬', '小男孩'];
const freshPrompt = [...CAST.map(c => ROSTER[c].bible), 'SCENE: test.', LOCK].join('\n\n');

const DIALOGUE = '柴犬：你又忘带伞了。\n小男孩：这次是真的忘了。';
const base = {
  schema: 'mood-still/2',
  source: {
    dialogue: DIALOGUE,
    digest: 'sha1:' + crypto.createHash('sha1').update(DIALOGUE).digest('hex').slice(0, 12),
    roster_digest: CUR,
  },
  line_pick: { index: 1, quote: '你又忘带伞了。', why: '变异基线：这句是整段对白的起点，狗在质问，男孩还没答。' },
  cast: CAST,
  scene: { place: '雨棚下', time: '傍晚', weather: '大雨', light: '檐口滴水逆着暖光', mood: '不动声色的怀疑', action: '狗侧身站着看向右前方，眉斑压低', framing: '中景' },
  prompt: { text: freshPrompt, chars: freshPrompt.length },
  image: { file: 'base-1.png', w: W, h: H },
  bubbles: [
    { speaker: '柴犬', text: '你又忘带伞了。', original: '你又忘带伞了。', anchor: [0.3, 0.25], head_r: 0.14, slot: 'mid' },
    { speaker: '小男孩', text: '这次是真的忘了。', original: '这次是真的忘了。', anchor: [0.7, 0.3], head_r: 0.13, slot: 'mid' },
  ],
};

function mutate(fn) { const f = JSON.parse(JSON.stringify(base)); fn(f); return f; }
function run(framePaths) {
  let out = '', code = 0;
  try {
    out = execFileSync('node', [path.join(SKILL, 'scripts', 'validate_frame.cjs'), ...framePaths],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
  return { out, code };
}

const cases = [
  ['green-baseline', base, null],
  ['M1-bible-tampered', mutate(f => { f.prompt.text = freshPrompt.replace('slightly plump', 'very thin'); }), 'D4'],
  ['M2-styllock-cut', mutate(f => { f.prompt.text = freshPrompt.split('HARD PROHIBITIONS')[0]; }), 'D4'],
  ['M3-quote-fabricated', mutate(f => { f.line_pick.quote = '我忘带了'; }), 'D2'],
  ['M4-index-out-of-range', mutate(f => { f.line_pick.index = 9; }), 'D2'],
  ['M5-why-too-short', mutate(f => { f.line_pick.why = '还行'; }), 'D3'],
  ['M6-unknown-speaker', mutate(f => { f.cast = ['柴犬']; }), 'D6'],
  ['M7-three-bubbles', mutate(f => { f.bubbles.push(JSON.parse(JSON.stringify(f.bubbles[0]))); }), 'D6'],
  ['M8-anchor-out-of-range', mutate(f => { f.bubbles[0].anchor = [1.4, 0.5]; }), 'D7'],
  ['M9-head-r-absurd', mutate(f => { f.bubbles[0].head_r = 3.0; }), 'D7'],
  ['M10-image-size-lie', mutate(f => { f.image.w = 999; }), 'D9'],
  ['M11-image-missing', mutate(f => { f.image.file = 'nope.png'; }), 'D9'],
  ['M12-schema-wrong', mutate(f => { f.schema = 'mood-still/1'; }), 'D0'],
  ['M13-bubble-too-long', mutate(f => { f.bubbles[0].text = '你今天有没有带伞呀我真的想知道答案是什么'; }), 'D6'],
  ['M14-silent-with-words', mutate(f => { f.bubbles = []; }), 'D10'],
  // 容量判据必须与 wrap() 同源，两个方向各钉一次（两串都是 19 列，但一个能画一个不能）：
  //   收尾标点允许把行撑破 -> 能画 -> 不许误杀
  ['M17-col-closing-punct-fits', mutate(f => { f.bubbles[0].text = '你今天有没有带伞呀我真的想知道答案！！'; }), null],
  //   启始标点不允许 -> 画不下 -> 不许放过
  ['M19-col-opening-punct-overflows', mutate(f => { f.bubbles[0].text = '你今天有没有带伞呀我真的想知道答案（（'; }), 'D6'],
];

let pass = 0;
for (const [name, frame, expect] of cases) {
  const p = path.join(OUT, name + '.json');
  fs.writeFileSync(p, JSON.stringify(frame, null, 2));
  const { out, code } = run([p]);
  const ok = expect === null ? code === 0 : (code !== 0 && out.includes(expect));
  if (ok) pass++;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name.padEnd(26)} expect=${String(expect || 'PASS').padEnd(4)} got=${code === 0 ? 'PASS' : (out.match(/D\d+/) || ['?'])[0]}`);
}

// D8 需要跨文件统计，单独测：四份同 digest 一起提交，必须有人被判 D8
const four = ['a', 'b', 'c', 'd'].map(s => {
  const p = path.join(OUT, 'D8-' + s + '.json');
  fs.writeFileSync(p, JSON.stringify(base, null, 2));
  return p;
});
const d8 = run(four);
const d8ok = d8.code !== 0 && d8.out.includes('D8');
console.log(`${d8ok ? 'ok  ' : 'BAD '} D8-four-candidates         expect=D8   got=${d8.code === 0 ? 'PASS' : (d8.out.match(/D\d+/) || ['?'])[0]}`);

// 气泡超容量必须由 compose_bubble 明确报错，而不是静默截断画出一张缺字的图
const over = JSON.parse(JSON.stringify(base));
over.bubbles = [{ speaker: '小男孩', text: '你今天有没有带伞呀我真的特别想知道答案到底是什么', anchor: [0.69, 0.25], head_r: 0.13, slot: 'mid' }];
const op = path.join(OUT, 'overflow.json');
fs.writeFileSync(op, JSON.stringify(over, null, 2));
let oflow = '', ocode = 0;
try { execFileSync('python', [path.join(SKILL, 'scripts', 'compose_bubble.py'), op, OUT], { encoding: 'utf8' }); }
catch (e) { oflow = (e.stdout || '') + (e.stderr || ''); ocode = e.status || 1; }
const oflowok = ocode !== 0 && /overflows/.test(oflow) && !/Traceback/.test(oflow);
console.log(`${oflowok ? 'ok  ' : 'BAD '} overflow-no-silent-cut      expect=FAIL(overflows) got=${ocode === 0 ? 'PASS' : oflow.trim().slice(0, 40)}`);

// roster 版本闸：D4 只在"帧记录的 roster 哈希与当前一致"时强制。
// 必须同时证明三件事：一致时 D4 真的还在管（篡改 bible 会红）、
// 它不是被整体关掉的（干净帧会绿）、以及降级时**必须留痕**（否则会被误读成已强制）。
const fresh = () => {
  const f = JSON.parse(JSON.stringify(base));
  f.cast = ['柴犬'];
  f.bubbles = [f.bubbles[0]];
  return f;
};
const extra = [
  ['M15-current-clean', fresh(), 'PASS', (out, code) => code === 0 && !/D\d/.test(out)],
  ['M16-current-tampered', (() => { const f = fresh(); f.prompt.text = f.prompt.text.replace('slightly plump', 'very thin'); return f; })(), 'D4', (out, code) => code !== 0 && out.includes('D4')],
  ['M18-stale-roster-warns', (() => { const f = fresh(); f.source.roster_digest = 'deadbeef1234'; return f; })(), 'PASS+D4skip', (out, code) => code === 0 && /D4 skipped/.test(out)],
];
for (const [name, frame, label, isOk] of extra) {
  const p = path.join(OUT, name + '.json');
  fs.writeFileSync(p, JSON.stringify(frame, null, 2));
  const { out, code } = run([p]);
  const ok = isOk(out, code);
  if (ok) pass++;
  const got = code !== 0 ? (out.match(/D\d+/) || ['?'])[0]
    : (/D4 skipped/.test(out) ? 'PASS+D4skip' : 'PASS');
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name.padEnd(26)} expect=${label.padEnd(11)} got=${got}`);
}

// 合成接缝的两种调用形态。SKILL.md §6 写的是"多帧 + 输出目录"，若脚本只认
// 第一帧、把第二个帧路径当成输出目录，就会静默建出一个名叫 frame-2.json 的目录、
// 把 PNG 塞进去、退出码还是 0 —— 冷启动实测踩过。两头都要钉住。
const batchDir = path.join(OUT, 'batch');
const b1 = path.join(OUT, 'batch-a.json');
const b2 = path.join(OUT, 'batch-b.json');
fs.writeFileSync(b1, JSON.stringify(base, null, 2));
fs.writeFileSync(b2, JSON.stringify(base, null, 2));
let bcode = 0, bout = '';
try { bout = execFileSync('python', [path.join(SKILL, 'scripts', 'compose_bubble.py'), b1, b2, batchDir], { encoding: 'utf8' }); }
catch (e) { bout = (e.stdout || '') + (e.stderr || ''); bcode = e.status || 1; }
const batchok = bcode === 0 && (bout.match(/^OK/gm) || []).length === 2
  && fs.existsSync(path.join(batchDir, 'batch-a.png')) && fs.existsSync(path.join(batchDir, 'batch-b.png'));
console.log(`${batchok ? 'ok  ' : 'BAD '} compose-multi-frame          expect=2 PNGs  got=${bcode !== 0 ? bout.trim().slice(0, 40) : (bout.match(/^OK/gm) || []).length + ' PNGs'}`);

let gcode = 0, gout = '';
try { execFileSync('python', [path.join(SKILL, 'scripts', 'compose_bubble.py'), b1, b2], { encoding: 'utf8' }); }
catch (e) { gout = (e.stdout || '') + (e.stderr || ''); gcode = e.status || 1; }
const guardok = gcode !== 0 && /out_dir is not a directory/.test(gout) && !fs.existsSync(path.join(OUT, 'batch-b.json', 'batch-a.png'));
console.log(`${guardok ? 'ok  ' : 'BAD '} compose-file-as-out-dir      expect=FAIL(guard) got=${gcode === 0 ? 'PASS' : gout.trim().slice(0, 40)}`);

// 拼装器：dubious 的"逐字复用"必须由机器保证，不能靠誊抄。契约有三条——
// 生成的帧要干净过闸（D4 在内）、roster_digest 是裸十六进制、prompt-N.txt 与帧里那份逐字相同。
// 冷启动实测就是在这条路上踩的：手打 sha1: 前缀让 D4 静默降级。
const M20 = path.join(OUT, 'M20');
fs.mkdirSync(M20, { recursive: true });
fs.writeFileSync(path.join(M20, 'base-1.png'), makePng(W, H, [237, 232, 222]));
fs.writeFileSync(path.join(M20, '_scenes.json'), JSON.stringify({
  dialogue: DIALOGUE,
  candidates: [{
    id: 1, line_pick: base.line_pick, cast: CAST, scene: base.scene,
    scene_en: 'Night. A small bedroom. The dog sits facing the camera.', bubbles: base.bubbles,
  }],
}, null, 2));
let m20code = 0, m20err = '';
try { execFileSync('node', [path.join(SKILL, 'scripts', 'assemble_frame.cjs'), path.join(M20, '_scenes.json')], { encoding: 'utf8' }); }
catch (e) { m20err = (e.stdout || '') + (e.stderr || ''); m20code = e.status || 1; }
const m20frame = m20code === 0 ? JSON.parse(fs.readFileSync(path.join(M20, 'frame-1.json'), 'utf8')) : null;
const m20txt = m20code === 0 ? fs.readFileSync(path.join(M20, 'prompt-1.txt'), 'utf8') : '';
const m20v = m20code === 0 ? run([path.join(M20, 'frame-1.json')]) : { code: 1 };
const m20ok = m20code === 0 && m20v.code === 0
  && !/^sha1:/.test(m20frame.source.roster_digest)
  && m20txt === m20frame.prompt.text
  && CAST.every(c => m20frame.prompt.text.includes(ROSTER[c].bible))
  && /absolutely no text/.test(m20frame.prompt.text);
console.log(`${m20ok ? 'ok  ' : 'BAD '} assemble-verbatim-contract   expect=PASS+3 pins got=${m20code !== 0 ? m20err.trim().slice(0, 40) : (m20v.code === 0 ? 'PASS' : 'validate FAIL')}`);

// 看图辅助与合成必须共用同一个圆：anchor_grid.py 是 import compose_bubble.head_disc 的，
// 这里用硬编码的期望像素值把那条公式钉住——口径一旦被改（例如 head_r 改成按宽度归一化），
// 网格上叠出来的圆就不再是合成时避让的那个圆，估出来的锚点会一路指偏。
// 期望值：1024x768、anchor [0.5,0.25]、head_r 0.1 -> cx=512.0 cy=192.0 r=76.8（r 按高度）。
const M21 = path.join(OUT, 'M21');
fs.mkdirSync(M21, { recursive: true });
fs.writeFileSync(path.join(M21, 'base-1.png'), makePng(W, H, [237, 232, 222]));
const probeFrame = mutate(f => {
  f.bubbles = [{ speaker: '柴犬', text: '你又忘带伞了。', original: '你又忘带伞了。', anchor: [0.5, 0.25], head_r: 0.1, slot: 'mid' }];
});
fs.writeFileSync(path.join(M21, 'frame-1.json'), JSON.stringify(probeFrame, null, 2));
let g21code = 0, g21out = '';
try { g21out = execFileSync('python', [path.join(SKILL, 'scripts', 'anchor_grid.py'), '--frame', path.join(M21, 'frame-1.json'), '--out', path.join(M21, 'grid')], { encoding: 'utf8' }); }
catch (e) { g21out = (e.stdout || '') + (e.stderr || ''); g21code = e.status || 1; }
const g21line = (g21out.split(/\r?\n/).find(l => /^DISC\s+0\s/.test(l)) || '').replace(/\s+/g, ' ').trim();
const gridok = g21code === 0 && g21line === 'DISC 0 512.0 192.0 76.8'
  && fs.existsSync(path.join(M21, 'grid', 'grid-M21-base-1.png'))
  && !/[^\x00-\x7F]/.test(g21out);
console.log(`${gridok ? 'ok  ' : 'BAD '} anchor-grid-geometry        expect=DISC 0 512.0 192.0 76.8  got=${g21code !== 0 ? 'exit' + g21code + ' ' + g21out.trim().slice(0, 30) : (g21line || 'no DISC')}`);

// 多组的底图都叫 base-1.png，一起叠网格时输出必须各自落地。
// 只用 basename 命名会让后一组静默覆盖前一组——测试场第一次同时跑四组时就撞了。
const M22 = path.join(OUT, 'M22');
fs.mkdirSync(M22, { recursive: true });
fs.writeFileSync(path.join(M22, 'base-1.png'), makePng(W, H, [200, 210, 220]));
fs.copyFileSync(path.join(M21, 'frame-1.json'), path.join(M22, 'frame-1.json'));
let g22code = 0, g22out = '';
try { g22out = execFileSync('python', [path.join(SKILL, 'scripts', 'anchor_grid.py'), '--frame',
  path.join(M21, 'frame-1.json'), path.join(M22, 'frame-1.json'), '--out', path.join(OUT, 'grid-multi')], { encoding: 'utf8' }); }
catch (e) { g22out = (e.stdout || '') + (e.stderr || ''); g22code = e.status || 1; }
const multiok = g22code === 0
  && fs.existsSync(path.join(OUT, 'grid-multi', 'grid-M21-base-1.png'))
  && fs.existsSync(path.join(OUT, 'grid-multi', 'grid-M22-base-1.png'));
console.log(`${multiok ? 'ok  ' : 'BAD '} anchor-grid-multi-group     expect=2 distinct PNGs got=${g22code !== 0 ? 'exit' + g22code : (fs.existsSync(path.join(OUT, 'grid-multi', 'grid-M22-base-1.png')) ? '2 distinct PNGs' : 'collision: outputs overwrote each other')}`);

// 混组调用合成：两个组都有 frame-1.json，共用一个输出目录时后写的那张会静默盖掉前一张。
// 测试场第一次跑四个组就中了这一枪——必须当场拒绝。
const cg = path.join(OUT, 'crossg');
for (const g of ['A', 'B']) {
  fs.mkdirSync(path.join(cg, g), { recursive: true });
  fs.writeFileSync(path.join(cg, g, 'base-1.png'), makePng(W, H, [237, 232, 222]));
  fs.writeFileSync(path.join(cg, g, 'frame-1.json'), JSON.stringify(base, null, 2));
}
let ccode = 0, cout = '';
try { execFileSync('python', [path.join(SKILL, 'scripts', 'compose_bubble.py'),
  path.join(cg, 'A', 'frame-1.json'), path.join(cg, 'B', 'frame-1.json'), cg], { encoding: 'utf8' }); }
catch (e) { cout = (e.stdout || '') + (e.stderr || ''); ccode = e.status || 1; }
const collideok = ccode !== 0 && /output collision/.test(cout);
console.log(`${collideok ? 'ok  ' : 'BAD '} compose-cross-group        expect=FAIL(collision) got=${ccode === 0 ? 'PASS(silent overwrite)' : cout.trim().slice(0, 40)}`);

// groups/ 下出现散文件时，verify_gallery 要报 STRAY 并判失败，而不是抛 ENOTDIR 堆栈。
const vg = path.join(OUT, 'vg');
fs.mkdirSync(path.join(vg, 'gallery', 'groups', 'g1'), { recursive: true });
fs.copyFileSync(path.join(cg, 'A', 'frame-1.json'), path.join(vg, 'gallery', 'groups', 'g1', 'frame-1.json'));
fs.copyFileSync(path.join(cg, 'A', 'base-1.png'), path.join(vg, 'gallery', 'groups', 'g1', 'base-1.png'));
let vsetup = 0;
try { execFileSync('python', [path.join(SKILL, 'scripts', 'compose_bubble.py'),
  path.join(vg, 'gallery', 'groups', 'g1', 'frame-1.json'), path.join(vg, 'gallery', 'groups', 'g1')], { encoding: 'utf8' }); }
catch (e) { vsetup = e.status || 1; }
fs.writeFileSync(path.join(vg, 'gallery', 'groups', 'stray.png'), 'x');
try { execFileSync('python', [path.join(SKILL, 'scripts', 'build_gallery.py')], { cwd: vg, encoding: 'utf8' }); }
catch (e) { vsetup = e.status || 1; }
let vcode = 0, vout = '';
try { execFileSync('node', [path.join(SKILL, 'scripts', 'verify_gallery.cjs')], { cwd: vg, encoding: 'utf8' }); }
catch (e) { vout = (e.stdout || '') + (e.stderr || ''); vcode = e.status || 1; }
const strayok = vsetup === 0 && vcode !== 0 && /STRAY/.test(vout) && !/ENOTDIR|Error:/.test(vout);
console.log(`${strayok ? 'ok  ' : 'BAD '} verify-stray-in-groups      expect=FAIL(STRAY) got=${vsetup !== 0 ? 'setup-failed' : (vcode === 0 ? 'PASS' : (/ENOTDIR/.test(vout) ? 'CRASHED' : 'FAIL(STRAY)'))}`);

const total = cases.length + 2 + extra.length + 7;
const totalPass = pass + (d8ok ? 1 : 0) + (oflowok ? 1 : 0) + (batchok ? 1 : 0) + (guardok ? 1 : 0) + (m20ok ? 1 : 0) + (gridok ? 1 : 0) + (multiok ? 1 : 0) + (collideok ? 1 : 0) + (strayok ? 1 : 0);
console.log(`\n${totalPass}/${total} checks behaved as expected`);
if (totalPass === total) fs.rmSync(OUT, { recursive: true, force: true });
else console.log('scratch kept for inspection: ' + OUT);
process.exit(totalPass === total ? 0 : 1);
