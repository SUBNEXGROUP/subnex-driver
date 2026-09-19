/* Полнота словаря переводов: каждая русская подпись в коде (T('…')) и в разметке пульта
   должна иметь английский перевод. Запуск: node _test/i18n.test.mjs */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const I = require(path.join(root, 'i18n.js'));
const CYR = /[А-Яа-яЁё]/;
const unescape = (s) => s.replace(/\\(.)/g, (m, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
const keys = new Map();
const add = (k, where) => {
  if (!keys.has(k)) keys.set(k, new Set());
  keys.get(k).add(where);
};
for (const f of ['ops-dispatch-core.js', 'ops-dispatch.js', 'ops-chat.js', 'admin.html']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/\bT\('((?:[^'\\]|\\.)*)'\)/g)) add(unescape(m[1]), f);
}
/* Разметка пульта: текст между тегами и подписи-атрибуты, вне <script>/<style>. */
const html = fs
  .readFileSync(path.join(root, 'admin.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '');
for (const m of html.matchAll(/>([^<>]*)</g)) {
  const k = m[1].replace(/\s+/g, ' ').trim();
  if (CYR.test(k)) add(k, 'admin.html#html');
}
for (const m of html.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) {
  const k = m[1].replace(/\s+/g, ' ').trim();
  if (CYR.test(k)) add(k, 'admin.html#html');
}
/* Русские строки, не обёрнутые в T('…') — новая подпись без перевода. Регулярные выражения не считаем. */
const unwrapped = [];
for (const f of ['ops-dispatch-core.js', 'ops-dispatch.js', 'ops-chat.js', 'admin.html']) {
  let src = fs.readFileSync(path.join(root, f), 'utf8');
  if (f.endsWith('.html')) src = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  src = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bT\(\s*'(?:[^'\\]|\\.)*'\s*,?\s*\)/g, '')
    .replace(/\bT\(\s*'(?:[^'\\]|\\.)*'\s*,/g, 'T(');
  src.split('\n').forEach((line, i) => {
    if (/\.test\(|\.match\(|replace\(\/|new RegExp/.test(line)) return;
    if (/(['"\`])(?:(?!\1).)*[А-Яа-яЁё]/.test(line)) unwrapped.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 100));
  });
}
const all = [...keys.keys()];
const missing = I.missing(all);
let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + extra));
};
ok(`словарь: ключей в коде и разметке ${all.length}`, all.length > 1000);
ok('словарь: все ключи переведены', missing.length === 0, '\n     ' + missing.slice(0, 20).map((k) => JSON.stringify(k) + ' ← ' + [...keys.get(k)].join(',')).join('\n     '));
const empty = Object.entries(I.EN).filter(([k, v]) => !v || CYR.test(v));
ok('код: русских строк без T() нет', unwrapped.length === 0, '\n     ' + unwrapped.slice(0, 15).join('\n     '));
ok('словарь: переводы без кириллицы и не пустые', empty.length === 0, JSON.stringify(empty.slice(0, 5)));
I.set('en');
ok('T: перевод', I.t('Заявки без даты ·') === 'Requests without a date ·');
ok('T: неизвестный ключ возвращается как есть', I.t('нет такого ключа') === 'нет такого ключа');
ok('T: подстановки', I.t('Выбрано: {n}', { n: 3 }) === 'Выбрано: 3');
I.set('ru');
ok('T: русский без изменений', I.t('Заявки без даты ·') === 'Заявки без даты ·');
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
