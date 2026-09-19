/* Дымовая проверка обеих страниц в настоящем Chromium с поддельным Supabase.
   Запуск: node _test/smoke.mjs   (нужен пакет playwright и Chromium). */
import { createRequire } from 'module';
import { execSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/* playwright берётся из проекта, а если его там нет — из глобальных пакетов npm. */
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

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + extra));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
async function open(file, role, lang) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  if (lang) await page.addInitScript((l) => localStorage.setItem('subnex_lang', l), lang);
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    if (/supabase-js|supabase\.min\.js/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: `window.__role='${role}';` + mock });
    if (/bank-holidays/.test(u)) return route.fulfill({ contentType: 'application/json', body: '{"england-and-wales":{"events":[]}}' });
    if (/postcodes\.io/.test(u)) return route.fulfill({ contentType: 'application/json', body: '{"status":200,"result":{"latitude":51.5,"longitude":-3.2}}' });
    if (/nominatim/.test(u)) return route.fulfill({ contentType: 'application/json', body: '[]' });
    return route.fulfill({ status: 204, body: '' }); // leaflet, fonts, pdfmake, tiles — не нужны для проверки
  });
  page.on('dialog', (d) => d.accept());
  await page.goto(base + file);
  return { page, errors };
}
const calls = (page, kind) => page.evaluate((k) => window.__calls.filter((c) => !k || c.name.startsWith(k)).map((c) => c.name), kind);

/* ---------------- ПУЛЬТ ---------------- */
{
  const { page, errors } = await open('admin.html', 'admin');
  await page.waitForSelector('#main', { state: 'visible', timeout: 15000 });
  await wait(800);
  ok('пульт: вход и главная', await page.isVisible('#dash-stats') && (await page.textContent('#dash-stats')).includes('Сборов на день'));
  ok('пульт: адреса грузятся с окном истории', (await page.evaluate(() => window.__calls.find((c) => c.name === 'addresses.select'))) !== undefined);
  ok('пульт: плитка зоны считает по правилу', (await page.textContent('#dash-stats')).includes('Бристоль'));

  await page.click('#nav button[data-page="requests"]');
  await page.waitForSelector('#req-queue .od-root', { timeout: 15000 });
  await wait(500);
  const queueText = await page.textContent('#req-queue');
  ok('очередь: четыре заявки без даты', /Заявки без даты · 4/.test(queueText), queueText.slice(0, 200));
  ok('очередь: автопредложение подписано', /Дата предложена автоматически/.test(queueText) && /в течение дня/.test(queueText) && /закроется через/.test(queueText), queueText.slice(0, 400));
  ok('очередь: автоподбор выключен — подсказка', /Автоподбор выключен/.test(queueText));
  ok('очередь: +44 (0) номер принят как мобильный', !(await page.evaluate(() => [...document.querySelectorAll('#req-queue td.mono')].some((td) => td.textContent.includes('900003') && td.textContent.includes('SMS не уйдёт')))));
  ok('очередь: стационарный помечен', await page.evaluate(() => [...document.querySelectorAll('#req-queue td.mono')].some((td) => td.textContent.includes('01873') && td.textContent.includes('SMS не уйдёт'))));

  await page.check('#od-all');
  await wait(300);
  await page.click('#req-queue [data-action="calculate"]');
  await page.waitForFunction(() => document.querySelector('#req-queue [data-action="reserve"]'), null, { timeout: 20000 });
  await wait(300);
  const planText = await page.textContent('#req-queue');
  ok('план: посчитан', /Предложенный план/.test(planText));
  ok('план: распределено 3 из 3', /Распределено\s*3\s*из 3/.test(planText.replace(/\s+/g, ' ')), planText.slice(0, 300));
  const roadCalls = (await calls(page, 'subnex-routing.matrix')).length;
  ok('план: дорога считалась параллельно по дням (>1 вызова)', roadCalls > 1, String(roadCalls));

  await page.click('#req-queue [data-action="reserve"]');
  await page.waitForFunction(() => /Предложения сохранены/.test(document.querySelector('#req-queue .od-notice')?.textContent || ''), null, { timeout: 15000 });
  await wait(300);
  ok('план: сохранено → время занято у заявок', (await page.textContent('#req-queue')).split('Время занято ·').length - 1 === 3);
  ok('план: кнопка отправки активна', !(await page.isDisabled('#req-queue [data-action="sendall"]')));

  await page.click('#req-queue [data-action="sendall"]');
  await page.waitForSelector('#req-queue .od-dialog', { timeout: 5000 });
  const dlg = await page.textContent('#req-queue .od-dialog');
  ok('отправка: диалог с SMS и пропуском стационарного', /уйдёт SMS/.test(dlg) && /Пропустим 1/.test(dlg), dlg.slice(0, 300));
  await page.check('#od-send-agree');
  await page.click('#req-queue .od-dialog-save');
  await page.waitForFunction(() => /отправлено/.test(document.querySelector('#req-queue .od-notice')?.textContent || ''), null, { timeout: 15000 });
  ok('отправка: SMS ушли', (await calls(page, 'subnex-sms.send')).length >= 2, String((await calls(page, 'subnex-sms.send')).length));
  ok('отправка: шаблон wrc-v1 и expected_source', await page.evaluate(() => window.__calls.filter((c) => c.name === 'subnex-sms.send').every((c) => c.data.template === 'wrc-v1' && c.data.expected_source)));

  await page.click('#nav button[data-page="day"]');
  await page.waitForFunction(() => document.querySelectorAll('#day-tl .tl-row').length > 0, null, { timeout: 15000 });
  const tl = await page.textContent('#day-tl');
  ok('день: таймлайн с выездом и складом', /Выезд/.test(tl) && /Склад/.test(tl));
  ok('день: прибытия рассчитаны', /≈/.test(tl));

  await page.click('#nav button[data-page="chat"]');
  await page.waitForSelector('#chat-host .oc-list button', { timeout: 15000 });
  ok('переписка: список загружен', (await page.textContent('#chat-host .oc-list')).includes('+447700900003'));
  const before = (await calls(page, 'subnex-sms.list')).length;
  await page.click('#nav button[data-page="today"]');
  await wait(9000);
  const after = (await calls(page, 'subnex-sms.list')).length;
  ok('переписка: опрос остановлен на другой странице', after === before, `${before} → ${after}`);
  await page.click('#nav button[data-page="chat"]');
  await wait(500);
  ok('переписка: при возврате обновилась', (await calls(page, 'subnex-sms.list')).length > after);

  await page.click('#nav button[data-page="requests"]');
  await page.click('#req-tabs button[data-sub="all"]');
  await wait(300);
  await page.click('#addr-tbody tr.tap >> nth=0');
  await page.waitForSelector('#m-addr-bg.show');
  ok('карточка: дата заблокирована', await page.isDisabled('#ma-date'));
  await page.fill('#ma-note', 'knock loudly');
  await page.click('#ma-save');
  await wait(600);
  const upd = await page.evaluate(() => window.__calls.filter((c) => c.name === 'addresses.update').pop());
  ok('карточка: пишет только свои поля (без date/status/kind)', upd && !('date' in upd.data) && !('kind' in upd.data) && !('status' in upd.data) && upd.data.note === 'knock loudly', JSON.stringify(upd?.data));

  await page.click('#nav button[data-page="reports"]');
  await wait(500);
  ok('отчёты: партнёрам', /Shelter Cymru/.test(await page.textContent('#cr-tbody')));
  await page.click('#rp-tabs button[data-sub="events"]');
  await wait(800);
  ok('отчёты: что случилось', /Выполнено|Запланировано/.test(await page.textContent('#ev-tbody')));

  await page.click('#nav button[data-page="settings"]');
  await page.click('#set-tabs button[data-sub="zones"]');
  await wait(400);
  ok('настройки: зоны', /Бристоль/.test(await page.textContent('#zones-list')));
  /* Автопланировщик: раздел в «Старт и склад», включение сохраняется на сервере. */
  await page.click('#set-tabs button[data-sub="dispatch"]');
  await page.waitForSelector('#set-dispatch .od-root', { timeout: 15000 });
  await wait(400);
  const setText = await page.textContent('#set-dispatch');
  ok('автопланировщик: раздел есть', /Автопланировщик/.test(setText) && /Адресов в день/.test(setText), setText.slice(0, 300));
  await page.check('#set-dispatch [data-auto="enabled"]');
  await page.click('#set-dispatch [data-action="save-auto"]');
  await page.waitForFunction(() => /Автопланировщик включён/.test(document.querySelector('#set-dispatch .od-notice')?.textContent || ''), null, { timeout: 15000 });
  const saved = await page.evaluate(() => window.__calls.filter((c) => c.name === 'subnex_dispatch.save_auto_plan'));
  ok('автопланировщик: сохранён на сервере', saved.length === 1 && saved[0].data.config.enabled === true && saved[0].data.config.day_capacity === 40, JSON.stringify(saved[0]?.data));
  await page.click('#nav button[data-page="requests"]');
  await page.click('#req-tabs button[data-sub="queue"]');
  await wait(300);
  await page.click('#req-queue [data-action="refresh"]');
  await wait(600);
  ok('очередь: автоподбор включён — строка статуса', /Автоподбор включён/.test(await page.textContent('#req-queue')), (await page.textContent('#req-queue')).slice(0, 300));
  ok('пульт: без ошибок в консоли', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------------- ТЕЛЕФОН ---------------- */
{
  const { page, errors } = await open('index.html', 'driver');
  await page.waitForSelector('#v-day.active', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#day-list .ph-stop').length > 0, null, { timeout: 15000 });
  await wait(1500);
  ok('телефон: сегодняшние остановки', (await page.$$('#day-list .ph-stop')).length === 4);
  ok('телефон: план подгрузился сам', /≈/.test(await page.textContent('#day-list')), await page.textContent('#day-list'));
  ok('телефон: адрес «на день» без времени до старта', /в течение дня/.test(await page.textContent('#day-list')));
  ok('телефон: кнопка старта', await page.isVisible('#btn-start-route') && !(await page.isDisabled('#btn-start-route')));
  ok('телефон: нет кнопки удаления', (await page.$('#btn-del')) === null);
  const addrCalls = await page.evaluate(() => window.__calls.filter((c) => c.name === 'addresses.select').length);
  ok('телефон: адреса грузятся', addrCalls > 0);

  await page.click('#btn-start-route');
  await page.waitForFunction(() => /Маршрут начат/.test(document.querySelector('#dispatch-day-note')?.textContent || ''), null, { timeout: 15000 });
  ok('телефон: маршрут начат', await page.isDisabled('#btn-start-route'));
  const startCalls = await calls(page, 'subnex_dispatch.start');
  ok('телефон: сервер получил start', startCalls.length === 1);
  ok('телефон: после старта — сколько SMS ушло', /окно прибытия: 3/.test(await page.textContent('#dispatch-day-note')), await page.textContent('#dispatch-day-note'));
  ok('телефон: у остановок окно из SMS', (await page.textContent('#day-list')).split('SMS: ').length - 1 === 3, await page.textContent('#day-list'));

  await page.click('#day-list .ph-stop >> nth=0');
  await page.waitForSelector('#v-addr.active');
  ok('телефон: карточка остановки', /Joyce Close|Station Road|Glyncoch/.test(await page.textContent('#ai-text')));
  const isBank = await page.evaluate(() => document.getElementById('bank-sec').style.display !== 'none');
  if (!isBank) {
    await page.click('#result-btns button.ok');
    await wait(500);
    const upd = await page.evaluate(() => window.__calls.filter((c) => c.name === 'addresses.update').pop());
    ok('телефон: результат записан', upd && upd.data.status === 'done', JSON.stringify(upd?.data));
  } else ok('телефон: контейнер открыт (результат пропущен)', true);

  await page.click('#nav-set');
  await page.waitForSelector('#v-set.active');
  ok('телефон: старт и склад с сервера', /NP13 1DF/.test(await page.textContent('#s-points')));
  ok('телефон: нет полей топлива', (await page.$('#s-fuel')) === null);
  await page.selectOption('#s-lang', 'en');
  await page.evaluate(() => saveSettings());
  /* Смена языка перезагружает страницу: модули собирают подписи при загрузке. */
  await wait(1500);
  await page.waitForSelector('#v-day.active', { timeout: 15000 });
  await wait(800);
  ok('телефон: английский на кнопке старта', /Route started|Start route/.test(await page.textContent('#btn-start-route')), await page.textContent('#btn-start-route'));
  ok('телефон: английский на вкладке архива', /Cancelled/.test(await page.textContent('#tab-cancelled')));
  ok('телефон: язык общий с модулями', (await page.evaluate(() => localStorage.getItem('subnex_lang'))) === 'en');
  ok('телефон: без ошибок в консоли', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------------- ПУЛЬТ ПО-АНГЛИЙСКИ ---------------- */
{
  const { page, errors } = await open('admin.html', 'admin', 'en');
  await page.waitForSelector('#main', { state: 'visible', timeout: 15000 });
  await wait(800);
  const noCyr = (t) => !/[А-Яа-яЁё]/.test(t);
  ok('EN: меню', /Today.*Requests.*Duplicates.*Calendar.*Route day.*SMS chat.*Banks.*Reports.*Settings/s.test(await page.textContent('#nav')) && noCyr(await page.textContent('#nav')), await page.textContent('#nav'));
  ok('EN: заголовок страницы', /Console/.test(await page.title()), await page.title());
  ok('EN: переключатель языка', (await page.inputValue('#ui-lang')) === 'en');
  ok('EN: главная', /Collections today/.test(await page.textContent('#dash-stats')));
  await page.click('#nav button[data-page="requests"]');
  await page.waitForSelector('#req-queue .od-root', { timeout: 15000 });
  await wait(500);
  const q = await page.textContent('#req-queue');
  ok('EN: очередь', /Requests without a date · 4/.test(q) && /Date offered automatically/.test(q) && /Plan by day/.test(q), q.slice(0, 300));
  ok('EN: очередь без кириллицы в подписях', noCyr(await page.textContent('#req-queue .od-intro')) && noCyr(await page.textContent('#req-queue .od-footer')) && noCyr(await page.textContent('#req-queue thead')), (await page.textContent('#req-queue .od-intro')).slice(0, 200));
  await page.click('#nav button[data-page="day"]');
  await page.waitForFunction(() => document.querySelectorAll('#day-tl .tl-row').length > 0, null, { timeout: 15000 });
  const tl = await page.textContent('#day-tl');
  ok('EN: день маршрута', /Departure/.test(tl) && /Depot/.test(tl) && /during the day/.test(tl), tl.slice(0, 200));
  await page.click('#nav button[data-page="chat"]');
  await page.waitForSelector('#chat-host .oc-list button', { timeout: 15000 });
  await page.click('#chat-host .oc-list button >> nth=0');
  await wait(800);
  const chat = await page.textContent('#chat-host');
  ok('EN: переписка', /Offer a time/.test(chat) && /Confirm manually/.test(chat) && /Message/.test(chat), chat.slice(0, 300));
  await page.click('#nav button[data-page="settings"]');
  await page.click('#set-tabs button[data-sub="dispatch"]');
  await page.waitForSelector('#set-dispatch .od-root', { timeout: 15000 });
  await wait(400);
  const st = await page.textContent('#set-dispatch');
  ok('EN: настройки планировщика', /Start and depot/.test(st) && /Auto-planner/.test(st) && /Addresses per day/.test(st) && noCyr(st), st.slice(0, 300));
  await page.click('#set-tabs button[data-sub="zones"]');
  await wait(300);
  ok('EN: зоны (названия зон — данные, остаются как есть)', /monthly|regular area/.test(await page.textContent('#zones-list')), (await page.textContent('#zones-list')).slice(0, 200));
  ok('EN: без ошибок в консоли', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
