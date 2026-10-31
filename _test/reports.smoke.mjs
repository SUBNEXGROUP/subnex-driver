/* Отчёты → Итоги месяца в настоящем Chromium с поддельным Supabase.
   Запуск: node _test/reports.smoke.mjs  (PW_CHROMIUM=путь — свой Chromium, если версия playwright другая). */
import { createRequire } from 'module';
import { execSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFrom = (dir) => createRequire(path.join(dir, 'x.js'));
let chromium;
try {
  ({ chromium } = requireFrom(root)('playwright'));
} catch {
  ({ chromium } = requireFrom(execSync('npm root -g').toString().trim())('playwright'));
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream' }).end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port + '/';
const mock = fs.readFileSync(path.join(root, '_test', 'mock-supabase.js'), 'utf8');
/* pdfmake заменяется заглушкой, которая запоминает документ — проверяем содержимое PDF, а не картинку. */
const pdfStub = `window.pdfMake={createPdf:(d)=>({download:(n,cb)=>{(window.__pdfs=window.__pdfs||[]).push({name:n,doc:d});cb&&cb();}})};`;

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + extra));
};
/* ExcelJS — из локального node_modules (EXCELJS=путь к exceljs.min.js), иначе проверка Excel пропускается. */
const excelJsPath = process.env.EXCELJS || path.join(root, 'node_modules', 'exceljs', 'dist', 'exceljs.min.js');
const haveExcel = fs.existsSync(excelJsPath);
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
async function open(lang) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await page.addInitScript((l) => {
    localStorage.setItem('subnex_lang', l);
    window.__reportFixture = true;
  }, lang);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    if (/supabase-js|supabase\.min\.js/.test(u))
      return route.fulfill({ contentType: 'text/javascript', body: `window.__role='admin';` + mock });
    if (/pdfmake/.test(u) && !/vfs/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: pdfStub });
    if (/exceljs/.test(u) && haveExcel) return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(excelJsPath, 'utf8') });
    if (/bank-holidays/.test(u)) return route.fulfill({ contentType: 'application/json', body: '{"england-and-wales":{"events":[]}}' });
    return route.fulfill({ status: 204, body: '' });
  });
  page.on('dialog', (d) => d.accept());
  await page.goto(base + 'admin.html#reports');
  await page.waitForSelector('#mo-tiles .tile', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#mo-cats [data-mo-cat]').length === 4, null, { timeout: 15000 });
  return { page, errors };
}

{
  const { page, errors } = await open('ru');
  ok('ru: вкладка «Итоги месяца» открыта по умолчанию', await page.isVisible('#rp-month'));
  const tiles = await page.$$eval('#mo-tiles .tile', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').toLowerCase()));
  ok('ru: пять плиток — итог + 4 категории', tiles.length === 5, JSON.stringify(tiles));
  ok('ru: всего сделано 4 (убранная оператором не считается)', /сделано адресов за месяц 4 не сделано: 2/.test(tiles[0]), tiles[0]);
  ok('ru: Partner Email — 1 сделан, 1 не сделан', /partner email 1 не сделано: 1/.test(tiles[1]), tiles[1]);
  ok('ru: Partner WhatsApp — 1', /partner whatsapp 1 не сделано: 0/.test(tiles[2]), tiles[2]);
  ok('ru: Missing — 1', /missing collections 1/.test(tiles[3]), tiles[3]);
  ok('ru: SUBNEX — 1 сделан, 1 закрыт', /subnex collections 1 не сделано: 1/.test(tiles[4]), tiles[4]);
  const email = await page.innerText('[data-mo-cat="partner_email"]');
  ok(
    'ru: в Partner Email адрес, charity, клиент, заметка',
    /1 Email Street/.test(email) &&
      /Shelter Cymru/.test(email) &&
      /Ann Email/.test(email) &&
      /ann@example\.com/.test(email) &&
      /Knock loudly/.test(email),
    email.slice(0, 400),
  );
  ok('ru: время сбора показано', /10:15|09:15/.test(email));
  ok('ru: две миниатюры фото', (await page.$$('[data-mo-cat="partner_email"] tbody img')).length === 2);
  ok('ru: убранная оператором заявка не в отчёте', !/Removed Road/.test(await page.innerText('#mo-cats')));
  await page.click('[data-mo-cat="partner_email"] summary');
  ok(
    'ru: несделанный показан с итогом',
    /2 Email Street[\s\S]*Не открыли дверь/.test(await page.innerText('[data-mo-cat="partner_email"]')),
  );
  await page.click('[data-mo-cat="subnex_website"] summary');
  const sub = await page.innerText('[data-mo-cat="subnex_website"]');
  ok('ru: закрытая заявка SUBNEX с причиной', /Клиент отменил сбор/.test(sub), sub.slice(0, 300));

  await page.click('[data-mo-pdf="partner_email"]');
  await page.waitForFunction(() => (window.__pdfs || []).length === 1, null, { timeout: 15000 });
  const pdf = await page.evaluate(() => {
    const p = window.__pdfs[0];
    return { name: p.name, orient: p.doc.pageOrientation, json: JSON.stringify(p.doc.content) };
  });
  ok('pdf: имя файла', /^Subnex-Partner-Email-\d{4}-\d{2}\.pdf$/.test(pdf.name), pdf.name);
  ok('pdf: альбомный', pdf.orient === 'landscape');
  ok('pdf: по-английски, без кириллицы', !/[А-Яа-яЁё]/.test(pdf.json), pdf.json.match(/.{30}[А-Яа-яЁё].{30}/)?.[0]);
  ok(
    'pdf: адрес, клиент, charity, заметка',
    /1 Email Street/.test(pdf.json) && /Ann Email/.test(pdf.json) && /Shelter Cymru/.test(pdf.json) && /Knock loudly/.test(pdf.json),
  );
  ok('pdf: разделы сделанных и несделанных', /Addresses collected · 1/.test(pdf.json) && /Collections not completed · 1/.test(pdf.json));
  ok('pdf: чужие категории не попали', !/Whatsapp Road|Site Avenue|Missing Lane/.test(pdf.json));

  await page.evaluate(() => (window.__pdfs = []));
  await page.click('button[onclick="monthAllPdf()"]');
  await page.waitForFunction(() => (window.__pdfs || []).length === 4, null, { timeout: 20000 });
  ok(
    'pdf: «по всем категориям» — 4 файла',
    (await page.evaluate(() => window.__pdfs.map((p) => p.name).join(','))).split(',').length === 4,
  );

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button[onclick="monthCsv(\'\')"]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  const lines = csv.trim().split(/\r\n/);
  ok('csv: 6 адресов + заголовок', lines.length === 7, String(lines.length));
  ok(
    'csv: первая колонка — категория, есть ссылки на фото',
    /^﻿?Category;/.test(lines[0]) && /Photos/.test(lines[0]) && /data:,x/.test(csv),
    lines[0],
  );
  ok('csv: без кириллицы', !/[А-Яа-яЁё]/.test(csv));
  if (haveExcel) {
    const ExcelJS = createRequire(excelJsPath)(excelJsPath);
    const readX = async (src) => {
      const [d] = await Promise.all([page.waitForEvent('download'), page.click(`[data-mo-xlsx="${src}"]`)]);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(fs.readFileSync(await d.path()));
      const ws = wb.getWorksheet('Collections');
      const grid = [];
      ws.eachRow((row, n) => (grid[n] = row.values.map((v) => (v && typeof v === 'object' && 'result' in v ? v.result : v))));
      return { name: d.suggestedFilename(), grid };
    };
    const em = await readX('partner_email');
    const hr = em.grid.findIndex((r) => r && r.includes('Name'));
    const head = em.grid[hr];
    ok('xlsx: колонки без «Bags collected»', head.join('|') === '||Name|Collection Date|Address|Phone|N/bags|Status|Notes|Charity', head.join('|'));
    const rowOf = (g, t) => g.find((r) => r && r.some((v) => typeof v === 'string' && v.includes(t)));
    ok('xlsx: N/bags = отметка водителя (6, не «4 to 10»)', rowOf(em.grid, '1 Email Street')?.[6] === 6, JSON.stringify(rowOf(em.grid, '1 Email Street')));
    ok('xlsx: у несделанного мешков нет', rowOf(em.grid, '2 Email Street')?.[6] == null);
    ok('xlsx: в сводке сумма мешков по charity', em.grid[2]?.[8] === 'Bags' && rowOf(em.grid.slice(0, hr), 'Shelter Cymru')?.[8] === 6, JSON.stringify(em.grid.slice(1, hr)));
    const wa = await readX('partner_whatsapp');
    ok('xlsx: без отметки — число из заявки (8)', rowOf(wa.grid, '3 Whatsapp Road')?.[6] === 8, JSON.stringify(rowOf(wa.grid, '3 Whatsapp Road')));
    const mi = await readX('missing');
    ok('xlsx: нет ни отметки, ни заявки — пусто', rowOf(mi.grid, '4 Missing Lane')?.[6] == null, JSON.stringify(rowOf(mi.grid, '4 Missing Lane')));
    const files = [];
    page.on('download', (d) => files.push(d.suggestedFilename()));
    await page.click('button[onclick="monthAllXlsx()"]');
    await page.waitForTimeout(5000);
    ok('xlsx: «по всем категориям» — 4 файла, включая SUBNEX', files.length === 4 && files.some((f) => /SUBNEX/i.test(f)), files.join(','));
  } else console.log('skip Excel: нет exceljs (EXCELJS=путь)');
  ok('ru: ошибок в консоли нет', errors.length === 0, errors.join(' | '));
  await page.close();
}
{
  const { page, errors } = await open('en');
  const t = await page.textContent('#rp-month');
  ok(
    'en: подписи по-английски',
    /Addresses done this month/.test(t) &&
      /Month summary|PDF for all categories/.test(await page.innerText('section[data-page="reports"]')),
    t.slice(0, 200),
  );
  ok('en: на вкладке нет кириллицы', !/[А-Яа-яЁё]/.test(t), t.match(/.{20}[А-Яа-яЁё].{20}/)?.[0]);
  ok('en: ошибок в консоли нет', errors.length === 0, errors.join(' | '));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await page.close();
}
await browser.close();
server.close();
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
