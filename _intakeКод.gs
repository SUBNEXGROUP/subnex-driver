const SUPABASE_URL = 'ВСТАВЬТЕ: https://….supabase.co';
const ANON_KEY = 'ВСТАВЬТЕ: anon-ключ из config.js';
const INTAKE_SECRET = 'ВСТАВЬТЕ: секрет приёма (Пульт → Настройки → Приём заявок)';

/**
 * SUBNEX — приём заявок из почты партнёров. Версия 3 (19.09.2026).
 *
 * Что изменилось по сравнению с версией 2:
 *   • УЧЁТ ПО ПИСЬМАМ, А НЕ ПО ПЕРЕПИСКАМ. Раньше ярлык «принято» ставился
 *     на всю переписку, а поиск такие переписки исключал. Gmail склеивает
 *     письма с одной темой от одного отправителя в одну переписку — и второе,
 *     третье письмо партнёра в ней молча пропускались. Теперь каждое письмо
 *     помнится по своему номеру (в свойствах скрипта), а ярлык — только пометка
 *     для глаз.
 *   • Первый запуск после обновления сам помечает всё, что уже лежит под
 *     ярлыками, как обработанное — повторно в приложение ничего не уйдёт.
 *   • Новая проверка «показатьПропущенные»: печатает письма, которые могли
 *     пройти мимо старой версии (вторые и дальше в помеченных переписках).
 *
 * Имя рабочей функции прежнее — приниматьЗаявки — автозапуск продолжает работать.
 * Ничего не удаляет и ни на что не отвечает.
 */

// ─────────── настройки ───────────

/** Партнёры, письма которых разбираем.
 *  format: 'table'  — заявки в таблице, строка = заявка (K&B);
 *  format: 'fields' — подписанные строки, письмо = одна или несколько заявок. */
const SOURCES = [
  { from: 'k.bcollections@yahoo.com',      name: 'K&B Collections',     format: 'table'  },
  { from: 'info@werecycleclothes.org.uk',  name: 'We Recycle Clothes',  format: 'fields' }
];

/** Ярлык-пометка: в переписке есть хотя бы одно разобранное письмо. */
const LABEL = 'SUBNEX/принято';

/** Ярлык-пометка: в переписке есть письмо, где ничего не удалось разобрать. */
const LABEL_CHECK = 'SUBNEX/проверить';

/** Насколько старые письма смотреть. */
const SEARCH_WINDOW = 'newer_than:14d';

/** Сколько месяцев помнить обработанные письма (по одному свойству на месяц). */
const KEEP_MONTHS = 3;

// ─────────── память о письмах ───────────

const DONE_PREFIX = 'SUBNEX_DONE_';
const MIGRATED_FLAG = 'SUBNEX_V3_MIGRATED';

function свойства() { return PropertiesService.getScriptProperties(); }

function месяц(date) {
  const d = date || new Date();
  return Utilities.formatDate(d, 'Europe/London', 'yyyy-MM');
}

/** Множество номеров писем, обработанных за последние KEEP_MONTHS месяцев. */
function обработанные() {
  const props = свойства().getProperties();
  const out = {};
  Object.keys(props).forEach(function (k) {
    if (k.indexOf(DONE_PREFIX) !== 0) return;
    props[k].split(',').forEach(function (id) { if (id) out[id] = true; });
  });
  return out;
}

/** Запомнить письмо как обработанное — в свойстве текущего месяца. */
function запомнить(id) {
  const key = DONE_PREFIX + месяц();
  const p = свойства();
  const cur = p.getProperty(key) || '';
  if (cur.split(',').indexOf(id) !== -1) return;
  p.setProperty(key, cur ? cur + ',' + id : id);
}

/** Убрать свойства старше KEEP_MONTHS месяцев. */
function почиститьПамять() {
  const p = свойства();
  const keep = [];
  for (let i = 0; i < KEEP_MONTHS; i++) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    keep.push(DONE_PREFIX + месяц(d));
  }
  Object.keys(p.getProperties()).forEach(function (k) {
    if (k.indexOf(DONE_PREFIX) === 0 && keep.indexOf(k) === -1) p.deleteProperty(k);
  });
}

/** Первый запуск после обновления: всё, что уже под ярлыками, считаем обработанным.
 *  Иначе старые письма ушли бы в приложение второй раз. */
function перенестиСтарыеПометки() {
  const p = свойства();
  if (p.getProperty(MIGRATED_FLAG)) return;
  let n = 0;
  ['label:"' + LABEL + '"', 'label:"' + LABEL_CHECK + '"'].forEach(function (q) {
    GmailApp.search(q + ' newer_than:60d', 0, 500).forEach(function (t) {
      t.getMessages().forEach(function (m) { запомнить(m.getId()); n++; });
    });
  });
  p.setProperty(MIGRATED_FLAG, new Date().toISOString());
  Logger.log('Перенос пометок: ' + n + ' писем отмечены как уже обработанные.');
}

// ─────────── основная работа ───────────

function приниматьЗаявки() {
  перенестиСтарыеПометки();
  почиститьПамять();
  const done = ярлык(LABEL);
  const check = ярлык(LABEL_CHECK);
  const seen = обработанные();
  // Переписки НЕ исключаются по ярлыку: новое письмо может прийти в старую переписку.
  const threads = GmailApp.search(запросПисем(), 0, 50);
  if (!threads.length) { Logger.log('Писем от партнёров за ' + SEARCH_WINDOW + ' нет.'); return; }

  let всегоСоздано = 0, всегоПропущено = 0, писем = 0, новых = 0;

  threads.forEach(function (thread) {
    let разобрал = false, пусто = false;
    thread.getMessages().forEach(function (message) {
      const id = message.getId();
      if (seen[id]) return;
      const source = источникПисьма(message);
      if (!source) return;
      новых++;
      const rows = разобратьПисьмо(message, source);
      if (!rows.length) {
        Logger.log('Не нашёл заявок в письме от ' + source.name + ', ' + message.getDate() + ' (' + id + ')');
        пусто = true;
        запомнить(id);
        return;
      }
      const ответ = отправить(rows);
      // Запоминаем ТОЛЬКО после успешного ответа приложения: если сеть упала,
      // письмо останется необработанным и уйдёт в следующий раз.
      запомнить(id);
      разобрал = true;
      писем++;
      всегоСоздано += ответ.created || 0;
      всегоПропущено += ответ.skipped || 0;
      Logger.log(source.name + ', письмо от ' + message.getDate() + ': строк ' + rows.length +
                 ', добавлено ' + ответ.created + ', уже было ' + ответ.duplicates +
                 ', пропущено ' + ответ.skipped);
      (ответ.rows || []).forEach(function (r) {
        if (r.outcome === 'skipped') Logger.log('   • ' + r.ref + ' — ' + r.detail);
      });
    });
    if (разобрал) thread.addLabel(done);
    if (пусто) thread.addLabel(check);
  });

  Logger.log('Итого: новых писем ' + новых + ', с заявками ' + писем + ', новых заявок ' + всегоСоздано +
             ', пропущено ' + всегоПропущено);
}

/** Поисковый запрос по всем партнёрам сразу. */
function запросПисем() {
  return 'from:(' + SOURCES.map(function (s) { return s.from; }).join(' OR ') + ') ' + SEARCH_WINDOW;
}

/** Какому партнёру принадлежит письмо. */
function источникПисьма(message) {
  const from = String(message.getFrom() || '').toLowerCase();
  for (let i = 0; i < SOURCES.length; i++) {
    if (from.indexOf(SOURCES[i].from.toLowerCase()) !== -1) return SOURCES[i];
  }
  return null;
}

/** Разбор одного письма по формату его партнёра. */
function разобратьПисьмо(message, source) {
  const id = message.getId();
  if (source.format === 'fields') {
    const rows = разборПодписей(id, message.getPlainBody());
    if (rows.length) return rows;
    return разборПодписей(id, текст(message.getBody()));
  }
  const rows = разборТаблицы(id, message.getBody());
  if (rows.length) return rows;
  return разборПодписей(id, message.getPlainBody());
}

// ─────────── разбор: общее ───────────

const LABELS = ['From', 'Phone', 'Telephone', 'Mobile', 'Email', 'Collection address',
  'Collection from', 'Address', 'Quantity of bags', 'No of bags', 'Number of bags',
  'Chosen charity', 'Collection for', 'Charity', 'Preferred date', 'Notes', 'Note', 'Message'];

function индекс(s) {
  return /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(s || '');
}

function найти(s, re) { const m = String(s || '').match(re); return m ? m[0].trim() : ''; }

function текст(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Убирает приставку и оставляет сам адрес. Без полного индекса адреса нет. */
function чистыйАдрес(s) {
  const v = String(s || '')
    .replace(/^\s*collection\s+(from|address)\s*:?\s*/i, '')
    .replace(/^\s*address\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
  return индекс(v) ? v : '';
}

/** Понимает и «No of bags = 4 to 10», и голое «4 to 10 bags». */
function найтиМешки(всё) {
  const s = String(всё || '');
  let m = s.match(/(?:no\.?\s*of\s*bags|quantity\s*of\s*bags|number\s*of\s*bags|bags)\s*[=:]\s*(\d+(?:\s*(?:to|[-–])\s*\d+)?)/i);
  if (!m) m = s.match(/^\s*(\d+(?:\s*(?:to|[-–])\s*\d+)?)\s*(?:bags?)?\s*$/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function найтиCharity(всё) {
  const m = String(всё).match(/(?:collection\s+for|chosen\s+charity|charity)\s*[:\-]?\s*([^|\n]+)/i);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
}

/** Любой британский номер, включая стационарный и запись «+44 (0)7…».
 *  Ноль в скобках после кода страны не набирается — убираем его сразу. */
function телефон(s) {
  const m = найти(s, /(?:\+44\s*\(0\)|\+44|0044|0)\s*\d(?:[\s().-]*\d){8,10}/);
  return m.replace(/\(\s*0\s*\)\s*/, '');
}

function почта(s) {
  return найти(s, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
}

// ─────────── разбор: таблица ───────────

function ячейкиТаблицы(html) {
  if (!html) return [];
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while ((td = tdRe.exec(tr[1])) !== null) cells.push(текст(td[1]).replace(/\n+/g, ' ').trim());
    if (cells.length > 1) rows.push(cells);
  }
  return rows;
}

function имяИзСтроки(cells) {
  const c = String(cells[0] || '').trim();
  if (!c || c.length > 60) return '';
  if (индекс(c) || /@|collection|bags/i.test(c) || /\d{6,}/.test(c)) return '';
  return c;
}

function адресИзЯчеек(cells) {
  for (let i = 0; i < cells.length; i++) {
    if (/collection\s+(from|address)/i.test(cells[i])) {
      const a = чистыйАдрес(cells[i]);
      if (a) return a;
    }
  }
  for (let i = 0; i < cells.length; i++) {
    if (/collection\s+for|chosen\s+charity/i.test(cells[i])) continue;
    if (индекс(cells[i])) { const a = чистыйАдрес(cells[i]); if (a) return a; }
  }
  return '';
}

function разборТаблицы(id, html) {
  const out = [];
  ячейкиТаблицы(html).forEach(function (cells, i) {
    const всё = cells.join(' | ');
    const адрес = адресИзЯчеек(cells);
    if (!адрес) return;
    out.push({
      ref: id + '#' + (i + 1),
      text: адрес,
      phone: телефон(всё),
      contact_email: почта(всё),
      contact_name: имяИзСтроки(cells),
      charity: найтиCharity(всё),
      bags_text: найтиМешки(всё),
      note: ''
    });
  });
  return out;
}

// ─────────── разбор: подписанные строки ───────────

/* Перенос строки перед каждой известной подписью. Длинные подписи идут
   раньше коротких, иначе «Address» разрывает «Collection address».
   Письмо может прийти и построчно, и одной склеенной строкой. */
function поПодписям(body) {
  const alt = LABELS.slice().sort(function (a, b) { return b.length - a.length; })
    .map(function (l) { return l.replace(/ /g, '\\s+'); }).join('|');
  const re = new RegExp('[ \\t]*\\b(' + alt + ')\\s*:', 'gi');
  return ('\n' + String(body || '')).replace(re, '\n$1:').replace(/\n{2,}/g, '\n').trim();
}

function поле(block, labels) {
  for (let i = 0; i < labels.length; i++) {
    const re = new RegExp('^\\s*' + labels[i].replace(/ /g, '\\s+') + '\\s*:\\s*(.+)$', 'im');
    const m = block.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

function разборПодписей(id, body) {
  const norm = поПодписям(body);
  const parts = norm.split(/\n(?=\s*From\s*:)/i)
    .map(function (s) { return s.trim(); }).filter(Boolean);
  const blocks = parts.filter(function (p) {
    return /collection\s+address|address\s*:/i.test(p) || индекс(p);
  });
  const src = blocks.length ? blocks : (индекс(norm) ? [norm] : []);
  const out = [];
  src.forEach(function (b, i) {
    const адрес = чистыйАдрес(поле(b, ['Collection address', 'Collection from', 'Address'])) ||
                  чистыйАдрес((b.split('\n').filter(индекс)[0] || ''));
    if (!адрес) return;
    const fromLine = поле(b, ['From']);
    out.push({
      ref: id + '#' + (i + 1),
      text: адрес,
      phone: поле(b, ['Phone', 'Telephone', 'Mobile']) || телефон(b),
      contact_email: почта(fromLine) || поле(b, ['Email']) || почта(b),
      contact_name: fromLine.replace(/<[^>]*>/g, '')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, '').trim(),
      charity: (поле(b, ['Chosen charity', 'Collection for', 'Charity']) || '')
        .replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, ''),
      bags_text: найтиМешки(поле(b, ['Quantity of bags', 'No of bags', 'Number of bags']) || b),
      note: поле(b, ['Notes', 'Note', 'Message'])
    });
  });
  return out;
}

// ─────────── отправка ───────────

function отправить(rows) {
  const url = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/subnex_intake';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY },
    payload: JSON.stringify({
      p_secret: INTAKE_SECRET,
      p_data: { action: 'rows', source: 'gmail', rows: rows }
    }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Приложение ответило ' + code + ': ' + body);
  return JSON.parse(body);
}

function ярлык(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ─────────── проверки, которые ничего не отправляют ───────────

/** Показывает, что разберётся в письмах партнёров. Заявки НЕ добавляются. */
function проверитьПисьма() {
  const seen = обработанные();
  const threads = GmailApp.search(запросПисем(), 0, 30);
  Logger.log('Писем в выборке: ' + threads.length + ' переписок за ' + SEARCH_WINDOW);
  let всего = 0, пустых = 0;
  threads.forEach(function (thread) {
    const ярлыки = thread.getLabels().map(function (l) { return l.getName(); }).join(', ');
    thread.getMessages().forEach(function (message) {
      const source = источникПисьма(message);
      if (!source) return;
      const rows = разобратьПисьмо(message, source);
      всего += rows.length;
      if (!rows.length) пустых++;
      Logger.log('─── ' + source.name + ' · ' + message.getDate() +
                 ' · заявок: ' + rows.length + (seen[message.getId()] ? ' · уже обработано' : ' · НОВОЕ') +
                 (ярлыки ? ' · ярлыки: ' + ярлыки : ' · без ярлыка'));
      rows.forEach(function (r) {
        Logger.log('    ' + r.text +
                   '  ·  ' + (r.charity || 'charity нет') +
                   '  ·  ' + (r.phone || 'телефона нет') +
                   '  ·  ' + (r.contact_email || 'почты нет') +
                   '  ·  ' + (r.bags_text || 'мешки не указаны'));
      });
    });
  });
  Logger.log('Итого заявок разобрано: ' + всего + ', писем без заявок: ' + пустых);
  Logger.log('Это только проверка — ничего не добавлено.');
}

/** Письма, которые могли пройти мимо старой версии: второе и дальше в помеченных
 *  переписках за 60 дней. Сверьте адреса с пультом (Заявки → Все адреса → поиск). */
function показатьПропущенные() {
  const threads = GmailApp.search('label:"' + LABEL + '" newer_than:60d', 0, 200);
  let n = 0;
  threads.forEach(function (thread) {
    const msgs = thread.getMessages();
    if (msgs.length < 2) return;
    msgs.slice(1).forEach(function (message) {
      const source = источникПисьма(message);
      if (!source) return;
      const rows = разобратьПисьмо(message, source);
      if (!rows.length) return;
      n++;
      Logger.log('─── ' + source.name + ' · ' + message.getDate() + ' · тема: ' + message.getSubject() + ' · ' + message.getId());
      rows.forEach(function (r) { Logger.log('    ' + r.text + '  ·  ' + (r.phone || 'телефона нет')); });
    });
  });
  Logger.log(n ? 'Писем, которые могли быть пропущены: ' + n + '. Если адресов нет в пульте — вставьте их через «Вставить список».'
               : 'Похоже, ничего не пропущено.');
}

/** Ищет письма с заявками от ОТПРАВИТЕЛЕЙ, которых нет в SOURCES. */
function найтиНеизвестныхОтправителей() {
  const known = SOURCES.map(function (s) { return s.from.toLowerCase(); });
  const threads = GmailApp.search('("collection address" OR "collection from" OR "chosen charity") newer_than:60d', 0, 200);
  const счёт = {};
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      const from = String(message.getFrom() || '');
      const адрес = (почта(from) || from).toLowerCase();
      if (known.indexOf(адрес) !== -1) return;
      счёт[адрес] = (счёт[адрес] || 0) + 1;
    });
  });
  const список = Object.keys(счёт).sort(function (a, b) { return счёт[b] - счёт[a]; });
  if (!список.length) { Logger.log('Незнакомых отправителей с заявками нет.'); return; }
  Logger.log('Письма с заявками от отправителей, которых скрипт НЕ читает:');
  список.forEach(function (a) { Logger.log('  ' + a + '  —  писем: ' + счёт[a]); });
  Logger.log('Если кто-то из них партнёр — добавьте его в SOURCES вверху файла.');
}

/** Письма, которые скрипт пометил «проверить». */
function посмотретьНеразобранные() {
  const threads = GmailApp.search('label:"' + LABEL_CHECK + '"', 0, 50);
  Logger.log('Помечено «проверить»: ' + threads.length);
  threads.forEach(function (t) {
    const m = t.getMessages()[0];
    Logger.log('  ' + m.getDate() + '  ·  ' + m.getFrom() + '  ·  ' + m.getSubject());
  });
}

// ─────────── настройка ───────────

/** Проверяет связь с приложением и разбор последнего письма. Ничего не добавляет. */
function проверитьНастройку() {
  if (SUPABASE_URL.indexOf('ВСТАВЬТЕ') !== -1 || ANON_KEY.indexOf('ВСТАВЬТЕ') !== -1 ||
      INTAKE_SECRET.indexOf('ВСТАВЬТЕ') !== -1) {
    Logger.log('Сначала впишите SUPABASE_URL, ANON_KEY и INTAKE_SECRET вверху файла.');
    return;
  }
  const url = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/subnex_intake';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY },
    payload: JSON.stringify({ p_secret: INTAKE_SECRET, p_data: { action: 'ping' } }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('Приложение не приняло ключ. Ответ: ' + response.getContentText());
    return;
  }
  const ответ = JSON.parse(response.getContentText());
  Logger.log('Связь есть. Заявки идут водителю: ' + ответ.driver + ' (' + ответ.name + ').');
  проверитьПисьма();
}

/** Включает автоматическую проверку почты каждые 5 минут. */
function включитьАвтоматическийПриём() {
  выключитьАвтоматическийПриём();
  ScriptApp.newTrigger('приниматьЗаявки').timeBased().everyMinutes(5).create();
  Logger.log('Готово. Почта будет проверяться каждые 5 минут.');
}

/** Выключает автоматическую проверку. */
function выключитьАвтоматическийПриём() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'приниматьЗаявки') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Автоматическая проверка выключена.');
}

/** ОСТОРОЖНО: помечает все старые письма обработанными, НИЧЕГО из них не забирая. */
function пропуститьСтарыеПисьма() {
  let всего = 0;
  GmailApp.search(запросПисем().replace(SEARCH_WINDOW, 'newer_than:90d'), 0, 500).forEach(function (t) {
    t.getMessages().forEach(function (m) { запомнить(m.getId()); всего++; });
  });
  Logger.log('Помечено старых писем: ' + всего + '. Их содержимое НЕ попало в приложение.');
}
