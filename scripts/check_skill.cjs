#!/usr/bin/env node
'use strict';
/*
 * check_skill.cjs — 自检 skill 自身结构：frontmatter 合法、正文不超长、引用的文件都真实存在。
 * 不检查艺术质量，只保证"文档说的文件在，文件说的闸门在"。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..');
const t = fs.readFileSync(path.join(DIR, 'SKILL.md'), 'utf8');
const fm = t.match(/^---\n([\s\S]*?)\n---\n/);

if (!fm) { console.log('MISSING frontmatter'); process.exit(1); }
const body = t.slice(fm[0].length);

let bad = 0;
const nameM = fm[1].match(/^name:\s*(.+)$/m);
const descM = fm[1].match(/^description:\s*(?:>-|\|)?\s*\n?([\s\S]*?)\n^(argument-hint|allowed-tools|model|tools|when_to_use):/m);
const desc = (descM ? descM[1] : '').replace(/\s+/g, ' ').trim();

// 顶层键必须是预期的那几个 —— 拼错的键（arguement-hint）会被静默忽略
const KNOWN = ['name', 'description', 'argument-hint', 'allowed-tools', 'model', 'tools', 'when_to_use'];
const keys = fm[1].split('\n').filter(l => /^[A-Za-z-]/.test(l)).map(l => l.split(':')[0]);
const unknown = keys.filter(k => !KNOWN.includes(k));

console.log('name            :', nameM ? nameM[1] : '(none)', nameM && /^[a-z0-9-]+$/.test(nameM[1]) ? 'ok' : 'BAD');
console.log('folder matches  :', path.basename(DIR) === (nameM ? nameM[1] : '') ? 'ok' : 'BAD');
console.log('frontmatter keys:', keys.join(', '), unknown.length ? 'UNKNOWN: ' + unknown.join(',') : 'ok');
console.log('description len :', desc.length, desc && desc.length <= 1024 ? 'ok (<=1024)' : 'BAD');
console.log('body lines      :', body.split('\n').length, body.split('\n').length < 500 ? 'ok (<500)' : 'TOO LONG');
if (path.basename(DIR) !== (nameM ? nameM[1] : '') || unknown.length || !desc || desc.length > 1024) bad++;
if (body.split('\n').length >= 500) bad++;

const refs = [...new Set([...t.matchAll(/(?:assets|scripts|references)\/[\w.\-]+(?:\/[\w.\-]+)*/g)].map(m => m[0]))];
let miss = 0;
for (const r of refs.sort()) {
  const ok = fs.existsSync(path.join(DIR, r));
  if (!ok) miss++;
  console.log((ok ? 'OK   ' : 'MISS ') + r);
}

const extraneous = ['README.md', 'CHANGELOG.md', 'INSTALLATION_GUIDE.md']
  .filter(f => fs.existsSync(path.join(DIR, f)));
console.log('extraneous docs :', extraneous.length ? extraneous.join(',') : 'none');
console.log('\n' + (bad || miss || extraneous.length ? 'FAIL' : 'PASS')
            + '  dangling refs=' + miss + '  structural errors=' + bad);
process.exit(bad || miss || extraneous.length ? 1 : 0);
