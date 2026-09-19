/* Оборачивает русские строки в код T('…') — слой переводов SUBNEX.
   node i18n-wrap.mjs <file> [--write] [--keys keys.json]
   .js  — весь файл; .html — только встроенные <script> без src.
   Правила:
   • строковый литерал с кириллицей → T('…'); если внутри HTML-разметка — переводится
     по кусочкам текста между тегами и в атрибутах (title/placeholder/aria-label…);
   • шаблонная строка: русские куски между ${…} и тегами → ${T('кусок')};
   • регулярные выражения, комментарии, уже обёрнутое T('…') — не трогаются. */
import fs from 'fs';
import * as acorn from 'acorn';
import MagicString from 'magic-string';

const CYR = /[А-Яа-яЁё]/;
const args = process.argv.slice(2);
const file = args[0];
const write = args.includes('--write');
const keysPath = args.includes('--keys') ? args[args.indexOf('--keys') + 1] : null;
const keys = keysPath && fs.existsSync(keysPath) ? JSON.parse(fs.readFileSync(keysPath, 'utf8')) : {};
const addKey = (k) => {
  if (!keys[k]) keys[k] = [];
  if (!keys[k].includes(file)) keys[k].push(file);
};
const q = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
const tplEsc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

/* Разбивает текст на куски: теги, текст между тегами. Русский текст между тегами →
   ${T('…')} (в шаблоне) или помечается для сборки. Возвращает массив [{tag|text|run}] */
function splitRuns(cooked) {
  const out = [];
  const re = /<[^<>]*>/g;
  let last = 0,
    m;
  const pushRun = (text) => {
    if (!text) return;
    if (!CYR.test(text)) {
      out.push({ text });
      return;
    }
    const lead = text.match(/^\s*/)[0],
      trail = text.match(/\s*$/)[0];
    const core = text.slice(lead.length, text.length - trail.length);
    if (lead) out.push({ text: lead });
    out.push({ run: core });
    if (trail) out.push({ text: trail });
  };
  /* Текст вне тегов может содержать куски атрибутов (например, строка
     ' maxlength="200" placeholder="Начните печатать"') — их значения переводим как атрибуты. */
  const pushText = (text) => {
    if (!text) return;
    if (!CYR.test(text)) {
      out.push({ text });
      return;
    }
    const ar = /([a-zA-Z_:-]+=)("([^"]*)"|'([^']*)')/g;
    let pos = 0,
      a,
      any = false;
    while ((a = ar.exec(text))) {
      const val = a[3] ?? a[4];
      if (!CYR.test(val) || /^on/i.test(a[1])) continue;
      any = true;
      pushRun(text.slice(pos, a.index + a[1].length));
      out.push({ attr: val, quote: a[3] !== undefined ? '"' : "'" });
      pos = a.index + a[0].length;
    }
    if (!any) pushRun(text);
    else pushRun(text.slice(pos));
  };
  /* Обрывок тега на краю куска: `…">Текст` в начале или `Текст<input min="` в конце
     (тег разрезан выражением ${…}). Внутри — атрибуты; незакрытое значение атрибута
     с русским текстом переводится как обычный кусок. */
  const pushTagFragment = (frag, side) => {
    if (!frag) return;
    if (!CYR.test(frag)) {
      out.push({ text: frag });
      return;
    }
    let head = '',
      body = frag,
      tail = '';
    if (side === 'lead' || side === 'both') {
      const hm = body.match(/^([^"'<>]*[А-Яа-яЁё][^"'<>]*)(["'])/);
      if (hm) {
        head = hm[1];
        body = body.slice(hm[1].length);
      }
    }
    if (side === 'tail' || side === 'both') {
      const tm = body.match(/([a-zA-Z_:-]+=["'])([^"']*[А-Яа-яЁё][^"']*)$/);
      if (tm) {
        tail = tm[2];
        body = body.slice(0, body.length - tm[2].length);
      }
    }
    if (head) pushRun(head);
    pushText(body);
    if (tail) pushRun(tail);
  };
  let text = cooked;
  // Кусок целиком внутри тега (ни «<», ни «>»), но с атрибутами: обрывок тега с обеих сторон.
  if (!/[<>]/.test(text) && /(^|\s)[a-zA-Z_:-]+=["']/.test(text)) {
    pushTagFragment(text, 'both');
    return out;
  }
  const firstLt = text.indexOf('<'),
    firstGt = text.indexOf('>');
  if (firstGt >= 0 && (firstLt < 0 || firstGt < firstLt)) {
    pushTagFragment(text.slice(0, firstGt + 1), 'lead');
    text = text.slice(firstGt + 1);
    re.lastIndex = 0;
  }
  const lastLt = text.lastIndexOf('<');
  let tailFrag = '';
  if (lastLt >= 0 && text.indexOf('>', lastLt) < 0) {
    tailFrag = text.slice(lastLt);
    text = text.slice(0, lastLt);
  }
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    const tag = m[0];
    if (CYR.test(tag) && !/^<\//.test(tag)) {
      // атрибуты с русским текстом (кроме on*=…)
      const parts = [];
      let pos = 0;
      const ar = /(\s)([a-zA-Z_:-]+)=("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(tag))) {
        const val = a[4] ?? a[5];
        if (!CYR.test(val) || /^on/i.test(a[2])) continue;
        parts.push({ text: tag.slice(pos, a.index + a[1].length + a[2].length + 1) });
        parts.push({ attr: val, quote: a[4] !== undefined ? '"' : "'" });
        pos = a.index + a[0].length;
      }
      parts.push({ text: tag.slice(pos) });
      if (parts.some((p) => p.attr !== undefined)) out.push(...parts);
      else out.push({ text: tag });
    } else out.push({ text: tag });
    last = m.index + tag.length;
  }
  pushText(text.slice(last));
  pushTagFragment(tailFrag, 'tail');
  return out;
}
const hasRun = (parts) => parts.some((p) => p.run !== undefined || p.attr !== undefined);
function toTemplate(parts) {
  return parts
    .map((p) => {
      if (p.run !== undefined) {
        addKey(p.run);
        return '${T(' + q(p.run) + ')}';
      }
      if (p.attr !== undefined) {
        addKey(p.attr);
        return p.quote + '${T(' + q(p.attr) + ')}' + p.quote;
      }
      return tplEsc(p.text);
    })
    .join('');
}

function transformJs(src, offsetNote = '') {
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: false, allowAwaitOutsideFunction: true });
  } catch (e) {
    throw new Error('parse ' + file + offsetNote + ': ' + e.message);
  }
  const ms = new MagicString(src);
  const edits = [];
  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && CYR.test(node.value)) {
      const wrapped = parent && parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'T' && parent.arguments[0] === node;
      const isKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed;
      if (!wrapped && !isKey) {
        const parts = splitRuns(node.value);
        if ((/<[^<>]*>/.test(node.value) || /(^|\s)[a-zA-Z_:-]+=["']/.test(node.value)) && hasRun(parts)) edits.push([node.start, node.end, '`' + toTemplate(parts) + '`']);
        else {
          addKey(node.value);
          edits.push([node.start, node.end, 'T(' + q(node.value) + ')']);
        }
      }
    } else if (node.type === 'TemplateLiteral') {
      for (const el of node.quasis) {
        if (!CYR.test(el.value.cooked || '')) continue;
        const parts = splitRuns(el.value.cooked);
        if (!hasRun(parts)) continue;
        edits.push([el.start, el.end, toTemplate(parts)]);
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node));
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  };
  walk(ast, null);
  for (const [s, e, code] of edits) ms.overwrite(s, e, code);
  return ms.toString();
}

let src = fs.readFileSync(file, 'utf8');
let out;
if (file.endsWith('.html')) {
  out = src.replace(/(<script>)([\s\S]*?)(<\/script>)/g, (m, a, body, c) => a + transformJs(body, ' (inline script)') + c);
} else out = transformJs(src);
if (write) fs.writeFileSync(file, out);
else process.stdout.write(out);
if (keysPath) fs.writeFileSync(keysPath, JSON.stringify(keys, null, 1));
console.error(`${file}: ключей всего ${Object.keys(keys).length}`);
