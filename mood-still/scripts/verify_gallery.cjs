#!/usr/bin/env node
'use strict';
/*
 * verify_gallery.cjs — 交付路径完整性
 *   1. 画廊引用的每张图都真实存在
 *   2. 被隔离的废图不得出现在画廊里，也不得被任何帧规格当作底图
 *   3. kept.json 的每个 id 都指向真实存在的帧（打错字会让整组静默不高亮）
 * 用法: 在项目根目录跑  node <skill>/scripts/verify_gallery.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const INDEX = path.join(ROOT, 'gallery', 'index.html');
const GROUPS = path.join(ROOT, 'gallery', 'groups');
if (!fs.existsSync(INDEX)) {
  console.log('FAIL  no gallery/index.html under ' + ROOT + ' (run build_gallery.py first)');
  process.exit(1);
}

const html = fs.readFileSync(INDEX, 'utf8');
const refs = [...new Set([...html.matchAll(/src='([^']+)'/g)].map(m => m[1]))];

let bad = 0;
for (const r of refs) {
  const ok = fs.existsSync(path.join(ROOT, 'gallery', r.replace(/\\/g, '/')));
  if (!ok) bad++;
  console.log((ok ? 'OK   ' : 'MISS ') + r);
}

const rejDir = path.join(ROOT, 'work', 'rejected');
const rejected = fs.existsSync(rejDir) ? fs.readdirSync(rejDir) : [];
const leaked = rejected.filter(n => html.includes(n));

const groups = fs.existsSync(GROUPS) ? fs.readdirSync(GROUPS) : [];
// groups/ 下只该有组目录。散落的文件多半是 compose_bubble 传错输出目录留下的
// （实测把多个组的帧混进一次调用，成品就落在了 groups/ 根上）——报出来，别崩。
for (const g of [...groups]) {
  if (fs.statSync(path.join(GROUPS, g)).isDirectory()) continue;
  console.log('STRAY ' + g + '  (groups/ 下只该有组目录；成品可能写错了位置)');
  bad++;
  groups.splice(groups.indexOf(g), 1);
}
for (const g of groups) {
  for (const f of fs.readdirSync(path.join(GROUPS, g))) {
    if (!f.startsWith('frame-') || !f.endsWith('.json')) continue;
    const fr = JSON.parse(fs.readFileSync(path.join(GROUPS, g, f), 'utf8'));
    if (/reject/i.test((fr.image || {}).file || '')) { console.log('LEAK ' + g + '/' + f); bad++; }
  }
}

for (const g of groups) {
  const kp = path.join(GROUPS, g, 'kept.json');
  if (!fs.existsSync(kp)) continue;
  const ids = JSON.parse(fs.readFileSync(kp, 'utf8')).ids || [];
  if (!ids.length) { console.log('EMPTY ' + g + '/kept.json has no ids'); bad++; }
  for (const id of ids) {
    if (!fs.existsSync(path.join(GROUPS, g, id + '.json'))) {
      console.log('DANGLE ' + g + '/kept.json -> ' + id + ' has no such frame'); bad++;
    }
  }
}

console.log('\n' + refs.length + ' img refs, ' + bad + ' broken');
console.log(rejected.length + ' quarantined rejects, ' + leaked.length + ' referenced by gallery');
console.log(bad || leaked.length ? 'FAIL' : 'PASS  delivery path clean');
process.exit(bad || leaked.length ? 1 : 0);
