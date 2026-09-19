/* Собирает русские тексты из разметки html (вне <script>/<style>) — ключи для translateDom.
   node html-keys.mjs admin.html keys.json */
import fs from 'fs';
import * as parse5 from 'parse5';
const [file, keysPath] = process.argv.slice(2);
const CYR = /[А-Яа-яЁё]/;
const keys = fs.existsSync(keysPath) ? JSON.parse(fs.readFileSync(keysPath, 'utf8')) : {};
const tag = file + '#html';
const add = (k) => {
  if (!keys[k]) keys[k] = [];
  if (!keys[k].includes(tag)) keys[k].push(tag);
};
const doc = parse5.parse(fs.readFileSync(file, 'utf8'));
let n = 0;
const walk = (node) => {
  if (node.nodeName === 'script' || node.nodeName === 'style') return;
  if (node.nodeName === '#text') {
    const key = node.value.replace(/\s+/g, ' ').trim();
    if (CYR.test(key)) {
      add(key);
      n++;
    }
  }
  for (const a of node.attrs || []) if (['title', 'placeholder', 'aria-label', 'alt', 'data-hint', 'value'].includes(a.name) && CYR.test(a.value)) add(a.value.replace(/\s+/g, ' ').trim());
  (node.childNodes || []).forEach(walk);
  if (node.content) walk(node.content);
};
walk(doc);
fs.writeFileSync(keysPath, JSON.stringify(keys, null, 1));
console.error(`${file}: текстов в разметке ${n}, ключей всего ${Object.keys(keys).length}`);
