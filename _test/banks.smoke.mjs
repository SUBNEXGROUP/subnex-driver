/* Визиты к контейнерам: убрать из карточки, добавить и убрать через окно «Визиты на день».
   Настоящий Chromium, поддельный Supabase.
   Запуск: node _test/banks.smoke.mjs  (PW_CHROMIUM=путь — свой Chromium, если версия playwright другая). */
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

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' ' + extra));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
async function open(lang) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    if (/supabase-js|supabase\.min\.js/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: `window.__role='admin';` + mock });
    if (/bank-holidays/.test(u)) return route.fulfill({ contentType: 'application/json', body: '{"england-and-wales":{"events":[]}}' });
    if (/postcodes\.io/.test(u)) return route.fulfill({ contentType: 'application/json', body: '{"status":200,"result":{"latitude":51.5,"longitude":-3.2}}' });
    if (/nominatim/.test(u)) return route.fulfill({ contentType: 'application/json', body: '[]' });
    return route.fulfill({ status: 204, body: '' });
  });
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.accept();
  });
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('subnex_lang', l);
    } catch {}
  }, lang);
  await page.goto(base + 'admin.html#day');
  await page.waitForSelector('#main', { state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#day-tl .tl-row').length > 0, null, { timeout: 15000 });
  return { page, errors, dialogs };
}
const names = (page, prefix) => page.evaluate((k) => window.__calls.filter((c) => c.name.startsWith(k)).map((c) => c.name), prefix);
const bankVisits = (page) =>
  page.evaluate(() => window.__mock.addresses.filter((a) => a.kind === 'bank').map((a) => ({ id: a.id, bank_id: a.bank_id, date: a.date, status: a.status })));
const toastText = (page) => page.evaluate(() => document.getElementById('toast').textContent);
const listState = (page) =>
  page.$$eval('#as-list label', (els) =>
    els.map((l) => ({
      text: l.innerText.replace(/\s+/g, ' ').trim(),
      checked: l.querySelector('input').checked,
      disabled: l.querySelector('input').disabled,
    })),
  );
const today = (page) => page.evaluate(() => window.SubnexDispatchCore.ukDay());
const plus = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

{
  const { page, errors, dialogs } = await open('ru');
  const T = await today(page);

  /* ---- 1. Карточка визита: «Убрать» снимает визит с дня ---- */
  ok('день: визит к контейнеру стоит в маршруте', /Glyncoch/.test(await page.textContent('#day-tl')));
  await page.click('#day-tl button.stop:has-text("Glyncoch")');
  await page.waitForSelector('#m-addr-bg.show');
  ok('карточка: заголовок «Визит к контейнеру»', (await page.textContent('#m-addr-title')) === 'Визит к контейнеру');
  ok('карточка: кнопка «Убрать» видна', await page.isVisible('#ma-del'));
  await page.click('#ma-del');
  await page.waitForFunction(() => !document.getElementById('m-addr-bg').classList.contains('show'), null, { timeout: 10000 });
  ok('карточка: спросили подтверждение про визит', dialogs.some((m) => /Убрать этот визит к контейнеру/.test(m)), JSON.stringify(dialogs));
  ok('карточка: «Визит убран.»', (await toastText(page)) === 'Визит убран.', await toastText(page));
  ok('карточка: визита в базе больше нет', (await bankVisits(page)).length === 0, JSON.stringify(await bankVisits(page)));
  ok('карточка: сервер закрытия заявок не вызывался', (await names(page, 'subnex_dispatch.close_request')).length === 0);
  ok('карточка: перед удалением проверены фото', (await names(page, 'photos.select')).length > 0 && (await names(page, 'addresses.delete')).length === 1);
  await page.waitForFunction(() => !/Glyncoch/.test(document.getElementById('day-tl').textContent), null, { timeout: 15000 });
  ok('день: визит исчез из маршрута', true);
  ok('контейнер остался в списке', await page.evaluate(() => window.__mock.tables.banks.length === 1));

  /* ---- 2. Окно «Визиты на день» со страницы дня: добавить ---- */
  await page.click('button:has-text("Контейнеры на этот день")');
  await page.waitForSelector('#m-assign-bg.show');
  ok('окно: дата — открытый день', (await page.inputValue('#as-date')) === T, await page.inputValue('#as-date'));
  ok('окно: строка о дне — сегодня, контейнеров 0', /сегодня/.test(await page.textContent('#as-day')) && /контейнеров 0/.test(await page.textContent('#as-day')), await page.textContent('#as-day'));
  let st = await listState(page);
  ok('окно: контейнер в списке, без галочки', st.length === 1 && !st[0].checked && !st[0].disabled, JSON.stringify(st));
  await page.click('#as-save');
  ok('окно: без изменений не сохраняет', /Изменений нет/.test(await toastText(page)) && (await page.isVisible('#m-assign-bg.show')));
  await page.check('#as-list input[value="bk1"]');
  st = await listState(page);
  ok('окно: отмеченный — «добавится»', st[0].checked && /добавится/.test(st[0].text), JSON.stringify(st));
  ok('окно: итог «Добавится: 1»', (await page.textContent('#as-plan')) === 'Добавится: 1', await page.textContent('#as-plan'));
  await page.click('#as-save');
  await page.waitForFunction(() => !document.getElementById('m-assign-bg').classList.contains('show'), null, { timeout: 15000 });
  ok('окно: «Добавлено визитов: 1»', (await toastText(page)) === 'Добавлено визитов: 1', await toastText(page));
  let v = await bankVisits(page);
  ok('окно: визит создан на этот день', v.length === 1 && v[0].bank_id === 'bk1' && v[0].date === T && v[0].status === 'planned', JSON.stringify(v));
  await page.waitForFunction(() => /Glyncoch/.test(document.getElementById('day-tl').textContent), null, { timeout: 15000 });
  ok('день: визит появился в маршруте', true);

  /* ---- 3. Смена даты: галочки показывают выбранный день, «добавить» переезжает ---- */
  await page.click('button:has-text("Контейнеры на этот день")');
  await page.waitForSelector('#m-assign-bg.show');
  st = await listState(page);
  ok('окно: стоящий в дне — с галочкой и «в этом дне»', st[0].checked && /в этом дне/.test(st[0].text), JSON.stringify(st));
  await page.fill('#as-date', plus(T, 1));
  await page.dispatchEvent('#as-date', 'change');
  st = await listState(page);
  ok('окно: на завтра контейнера нет — галочки нет', !st[0].checked && !/в этом дне/.test(st[0].text), JSON.stringify(st));
  await page.check('#as-list input[value="bk1"]');
  ok('окно: на завтра — «Добавится: 1»', (await page.textContent('#as-plan')) === 'Добавится: 1');
  await page.fill('#as-date', T);
  await page.dispatchEvent('#as-date', 'change');
  st = await listState(page);
  ok('окно: вернули сегодня — он уже в дне, добавлять нечего', st[0].checked && /в этом дне/.test(st[0].text) && (await page.textContent('#as-plan')) === '', JSON.stringify(st));

  /* ---- 4. Убрать через окно ---- */
  await page.click('#m-assign-bg button:has-text("Снять все")');
  st = await listState(page);
  ok('окно: «Снять все» — «уберётся»', !st[0].checked && /уберётся/.test(st[0].text) && (await page.textContent('#as-plan')) === 'Уберётся: 1', JSON.stringify(st));
  await page.click('#m-assign-bg button:has-text("Отметить все")');
  ok('окно: «Отметить все» — отмена удаления', (await listState(page))[0].checked && (await page.textContent('#as-plan')) === '');
  await page.uncheck('#as-list input[value="bk1"]');
  await page.click('#as-save');
  await page.waitForFunction(() => !document.getElementById('m-assign-bg').classList.contains('show'), null, { timeout: 15000 });
  ok('окно: «Убрано визитов: 1»', (await toastText(page)) === 'Убрано визитов: 1', await toastText(page));
  ok('окно: визита больше нет', (await bankVisits(page)).length === 0);

  /* ---- 5. Сразу добавить на другой день (с вкладки «Контейнеры») ---- */
  await page.click('#nav button[data-page="banks"]');
  await page.click('button:has-text("Визиты на день: добавить / убрать")');
  await page.waitForSelector('#m-assign-bg.show');
  await page.fill('#as-date', plus(T, 3));
  await page.dispatchEvent('#as-date', 'change');
  await page.click('#m-assign-bg button:has-text("Отметить все")');
  await page.click('#as-save');
  await page.waitForFunction(() => !document.getElementById('m-assign-bg').classList.contains('show'), null, { timeout: 15000 });
  v = await bankVisits(page);
  ok('окно: визит поставлен на выбранный день', v.length === 1 && v[0].date === plus(T, 3) && v[0].status === 'planned', JSON.stringify(v));

  /* ---- 6. Визит с фото и выполненный визит не убираются ---- */
  await page.evaluate((d) => {
    const m = window.__mock;
    m.tables.banks.push({ id: 'bk2', name: 'Bodyshop', text: 'Tonypandy CF40 1HL', note: '', active: true, rate_type: 'none', rate_value: 0, lat: 51.62, lng: -3.45, created_at: '2026-08-02T00:00:00Z' });
    m.tables.banks.push({ id: 'bk3', name: 'B&Q', text: 'Cardiff CF23 8NL', note: '', active: false, rate_type: 'none', rate_value: 0, lat: 51.54, lng: -3.14, created_at: '2026-08-03T00:00:00Z' });
    const base = { ...m.addresses.find((a) => a.kind === 'bank') };
    m.addresses.push({ ...base, id: 'bv-photo', bank_id: 'bk2', text: 'Bodyshop — Tonypandy CF40 1HL', date: d, status: 'planned' });
    m.addresses.push({ ...base, id: 'bv-done', bank_id: 'bk3', text: 'B&Q — Cardiff CF23 8NL', date: d, status: 'done', done_at: d + 'T10:00:00Z', fill_level: 40 });
    m.tables.photos.push({ id: 'ph1', address_id: 'bv-photo', path: 'd1/x.jpg', kind: 'photo', driver_id: 'd1', created_at: new Date().toISOString() });
  }, plus(T, 3));
  await page.evaluate(() => refreshAll(true));
  await wait(400);
  await page.click('button:has-text("Визиты на день: добавить / убрать")');
  await page.waitForSelector('#m-assign-bg.show');
  await page.fill('#as-date', plus(T, 3));
  await page.dispatchEvent('#as-date', 'change');
  st = await listState(page);
  const row = (n) => st.find((x) => x.text.startsWith(n));
  ok('окно: визит с фото заблокирован', row('Bodyshop')?.checked && row('Bodyshop')?.disabled && /есть фото/.test(row('Bodyshop').text), JSON.stringify(st));
  ok('окно: выполненный визит заблокирован (и выключенный контейнер показан)', row('B&Q')?.checked && row('B&Q')?.disabled && /Выполнено/.test(row('B&Q').text), JSON.stringify(st));
  await page.click('#m-assign-bg button:has-text("Снять все")');
  ok('окно: «Снять все» трогает только свободный визит', (await page.textContent('#as-plan')) === 'Уберётся: 1', await page.textContent('#as-plan'));
  await page.click('#as-save');
  await page.waitForFunction(() => !document.getElementById('m-assign-bg').classList.contains('show'), null, { timeout: 15000 });
  v = await bankVisits(page);
  ok('окно: с фото и выполненный остались, свободный убран', v.length === 2 && v.every((x) => ['bv-photo', 'bv-done'].includes(x.id)), JSON.stringify(v));
  /* из карточки визит с фото тоже не удаляется */
  await page.evaluate(() => openAddrModal('bv-photo'));
  await page.waitForSelector('#m-addr-bg.show');
  await page.click('#ma-del');
  await wait(500);
  ok('карточка: визит с фото не удалён, причина названа', /уже есть фото/.test(await toastText(page)) && (await bankVisits(page)).some((x) => x.id === 'bv-photo'), await toastText(page));
  await page.evaluate(() => closeModal('m-addr-bg'));

  /* ---- 7. Обычная заявка по-прежнему закрывается сервером ---- */
  await page.evaluate(() => openAddrModal('a3'));
  await page.waitForSelector('#m-addr-bg.show');
  await page.click('#ma-del');
  await page.waitForFunction(() => !document.getElementById('m-addr-bg').classList.contains('show'), null, { timeout: 10000 });
  ok('заявка клиента: закрывает сервер, прямого удаления нет', (await names(page, 'subnex_dispatch.close_request')).length === 1 && (await page.evaluate(() => window.__mock.addresses.find((a) => a.id === 'a3').status)) === 'cancelled');
  ok('ru: ошибок в консоли нет', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---- английский интерфейс (по умолчанию у Кости) ---- */
{
  const { page, errors } = await open('en');
  ok('en: кнопка на странице дня', await page.isVisible('button:has-text("Banks on this day")'));
  await page.click('button:has-text("Banks on this day")');
  await page.waitForSelector('#m-assign-bg.show');
  ok('en: заголовок окна', (await page.textContent('#m-assign-bg h2')) === 'Visits for a day: add / remove', await page.textContent('#m-assign-bg h2'));
  const st = await listState(page);
  ok('en: стоящий в дне — «on this day»', st[0].checked && /on this day/.test(st[0].text), JSON.stringify(st));
  ok('en: строка о дне', /today/.test(await page.textContent('#as-day')) && /banks 1/.test(await page.textContent('#as-day')), await page.textContent('#as-day'));
  await page.click('#m-assign-bg button:has-text("Untick all")');
  ok('en: «To remove: 1»', (await page.textContent('#as-plan')) === 'To remove: 1', await page.textContent('#as-plan'));
  await page.screenshot({ path: process.env.SHOT || '/tmp/banks-modal.png' });
  await page.click('#as-save');
  await page.waitForFunction(() => !document.getElementById('m-assign-bg').classList.contains('show'), null, { timeout: 15000 });
  ok('en: «Visits removed: 1»', (await toastText(page)) === 'Visits removed: 1', await toastText(page));
  ok('en: нет русского текста в окне', !/[А-Яа-яЁё]/.test(await page.evaluate(() => document.getElementById('m-assign-bg').innerText)));
  ok('en: ошибок в консоли нет', errors.length === 0, errors.join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
