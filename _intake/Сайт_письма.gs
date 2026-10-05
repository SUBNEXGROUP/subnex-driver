/**
 * SUBNEX — письма клиентам с сайта с адреса collections@subnex.co.uk и их ответы в чат приложения.
 *
 * Кладётся НОВЫМ файлом в проект Apps Script ящика collections@subnex.co.uk
 * (тот, где старый автоответ и Collection Manager). Остальные файлы не трогать.
 *
 * Что делает (сам, каждую минуту):
 *   • забирает из приложения готовые письма клиентам с сайта и отправляет их из этого ящика;
 *     ответ оператора из чата уходит в ту же цепочку писем клиента;
 *   • раз в 3 минуты передаёт в чат приложения новые письма клиентов, которые ответили на
 *     collections@ (только тех, кто оставлял заявку на сайте; остальные письма не трогает).
 * Партнёрские письма сюда не приходят — они уходят с subnex.operations@gmail.com, как раньше.
 *
 * Один раз:
 *   1. Вписать три значения ниже (скопировать из Код.gs проекта subnex.operations).
 *   2. Запустить сайтПроверить() — должна быть «Связь с приложением есть».
 *   3. Запустить сайтВключить() — включает отправку и выключает старый автоответ,
 *      чтобы клиент не получал два письма.
 * Обновление этого файла: вставить новый текст, сохранить, запустить сайтПроверить().
 */

const САЙТ_SUPABASE_URL = 'ВСТАВЬТЕ: SUPABASE_URL из Код.gs';
const САЙТ_ANON_KEY = 'ВСТАВЬТЕ: ANON_KEY из Код.gs';
const САЙТ_СЕКРЕТ = 'ВСТАВЬТЕ: INTAKE_SECRET из Код.gs';

const САЙТ_ОТ_КОГО = 'collections@subnex.co.uk';
const САЙТ_ИМЯ = 'SUBNEX';
const САЙТ_ПИСЕМ_ЗА_РАЗ = 10;
/** Наши собственные адреса: их письма в чат не передаются. */
const САЙТ_НАШИ = ['collections@subnex.co.uk', 'info@subnex.co.uk', 'subnex.operations@gmail.com'];
const САЙТ_ВХОДЯЩИЕ_РАЗ_В_МИНУТ = 3;

/** Старые автозапуски этого проекта, которые больше не нужны: всё делает приложение. */
const САЙТ_СТАРЫЕ_ЗАПУСКИ = ['processNewCollectionBookings', 'syncCollectionManagerBookings'];

function сайтRPC(name, body) {
  const url = САЙТ_SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/' + name;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: САЙТ_ANON_KEY, Authorization: 'Bearer ' + САЙТ_ANON_KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) throw new Error('Приложение ответило ' + code + ': ' + text);
  return JSON.parse(text);
}

function сайтСервер(action, data) {
  return сайтRPC('subnex_email_worker', { p_secret: САЙТ_СЕКРЕТ, p_action: action, p_data: data || {} });
}

/** Если collections@ — псевдоним этого ящика, письмо уходит именно с него. */
function сайтОпции(job) {
  const opts = { htmlBody: job.html, name: job.from_name || САЙТ_ИМЯ, replyTo: САЙТ_ОТ_КОГО };
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  const aliases = GmailApp.getAliases().map(function (x) { return String(x).toLowerCase(); });
  if (me !== САЙТ_ОТ_КОГО && aliases.indexOf(САЙТ_ОТ_КОГО) >= 0) opts.from = САЙТ_ОТ_КОГО;
  return opts;
}

/** Ответ оператора — в ту же цепочку писем клиента; если письмо клиента не найдено — новым письмом. */
function сайтОтправитьОдно(job) {
  const opts = сайтОпции(job);
  if (job.reply_ref) {
    let original = null;
    try { original = GmailApp.getMessageById(job.reply_ref); } catch (e) { original = null; }
    if (original) {
      original.reply(job.text, opts);
      return;
    }
  }
  GmailApp.sendEmail(job.to, job.subject, job.text, opts);
}

/** Рабочая функция: её запускает автозапуск каждую минуту. */
function сайтОтправлять() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const jobs = (сайтСервер('claim', { limit: САЙТ_ПИСЕМ_ЗА_РАЗ, from: САЙТ_ОТ_КОГО }).jobs) || [];
    let stop = false;
    jobs.forEach(function (job) {
      if (stop) return;
      try {
        сайтОтправитьОдно(job);
        сайтСервер('done', { id: job.id, ok: true });
      } catch (e) {
        const text = String(e && e.message ? e.message : e);
        if (/limit|quota|лимит/i.test(text)) { Logger.log('Лимит Gmail на сегодня: ' + text); stop = true; return; }
        сайтСервер('done', { id: job.id, ok: false, error: text });
        Logger.log('Письмо не ушло на ' + job.to + ': ' + text);
      }
    });
    if (jobs.length) Logger.log('Отправлено писем: ' + jobs.length);
    сайтВходящиеПоРасписанию();
  } finally {
    lock.releaseLock();
  }
}

/* ───────────── Ответы клиентов → чат приложения ───────────── */

/** Адрес из «Имя <почта>». */
function сайтАдрес(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Имя из «Имя <почта>». */
function сайтИмя(from) {
  const s = String(from || '');
  const i = s.indexOf('<');
  return i > 0 ? s.slice(0, i).replace(/["']/g, '').trim() : '';
}

/** Только новый текст письма: без цитаты нашего письма и подписи «Sent from my iPhone». */
function сайтЧистыйТекст(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const two = (line + ' ' + String(lines[i + 1] || '').trim()).trim();
    if (/^>/.test(line)) break;
    if (/^On\s.+wrote:$/i.test(line) || (/^On\s/i.test(line) && /wrote:$/i.test(two))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) break;
    if (/^_{5,}$/.test(line)) break;
    if (/^From:\s/i.test(line) && out.join('').trim()) break;
    if (/^Sent from my\s/i.test(line) || /^Get Outlook for\s/i.test(line)) break;
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
}

/** Не чаще раза в САЙТ_ВХОДЯЩИЕ_РАЗ_В_МИНУТ минут — вызывается из сайтОтправлять. */
function сайтВходящиеПоРасписанию() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('сайтВходящиеВремя') || 0);
  if (Date.now() - last < САЙТ_ВХОДЯЩИЕ_РАЗ_В_МИНУТ * 60000 - 5000) return;
  props.setProperty('сайтВходящиеВремя', String(Date.now()));
  try { сайтВходящие(); } catch (e) { Logger.log('Ответы клиентов не переданы: ' + (e && e.message ? e.message : e)); }
}

/** Передаёт в чат новые письма клиентов на collections@ за последние 2 дня. Повтор безопасен. */
function сайтВходящие() {
  const props = PropertiesService.getScriptProperties();
  let seen = [];
  try { seen = JSON.parse(props.getProperty('сайтВходящиеID') || '[]'); } catch (e) { seen = []; }
  const since = Date.now() - 2 * 86400000;
  const threads = GmailApp.search('to:' + САЙТ_ОТ_КОГО + ' newer_than:2d', 0, 30);
  let passed = 0;
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      const id = msg.getId();
      if (seen.indexOf(id) >= 0 || msg.getDate().getTime() < since) return;
      const from = сайтАдрес(msg.getFrom());
      if (САЙТ_НАШИ.indexOf(from) >= 0 || /mailer-daemon|no-?reply|postmaster/i.test(from)) { seen.push(id); return; }
      const to = (msg.getTo() + ',' + msg.getCc()).toLowerCase();
      if (to.indexOf(САЙТ_ОТ_КОГО) < 0) { seen.push(id); return; }
      const r = сайтRPC('subnex_email_inbound', { p_secret: САЙТ_СЕКРЕТ, p_data: {
        message_id: id, from: from, from_name: сайтИмя(msg.getFrom()), subject: msg.getSubject(),
        body: сайтЧистыйТекст(msg.getPlainBody())
      } });
      if (r && r.matched) passed++;
      seen.push(id);
    });
  });
  props.setProperty('сайтВходящиеID', JSON.stringify(seen.slice(-300)));
  if (passed) Logger.log('Ответов клиентов передано в чат: ' + passed);
  return passed;
}

/* ───────────── Проверка, включение, откат ───────────── */

/** Проверка — ничего не отправляет. */
function сайтПроверить() {
  const r = сайтСервер('ping');
  Logger.log('Связь с приложением есть. Письма включены: ' + (r.enabled ? 'да' : 'НЕТ') + '.');
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  const alias = GmailApp.getAliases().map(function (x) { return String(x).toLowerCase(); }).indexOf(САЙТ_ОТ_КОГО) >= 0;
  Logger.log('Ящик скрипта: ' + me + '. Письма уйдут с ' +
             (me === САЙТ_ОТ_КОГО || alias ? САЙТ_ОТ_КОГО : me + ' (collections@ не подключён — ответы всё равно придут на collections@)') + '.');
  const found = GmailApp.search('to:' + САЙТ_ОТ_КОГО + ' newer_than:2d', 0, 30).length;
  Logger.log('Писем на ' + САЙТ_ОТ_КОГО + ' за 2 дня: ' + found + '. Ответы клиентов с сайта попадут в чат приложения.');
  const triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  Logger.log('Автозапуск отправки: ' + (triggers.indexOf('сайтОтправлять') >= 0 ? 'включён' : 'НЕТ — запустите сайтВключить()'));
  const old = triggers.filter(function (h) { return САЙТ_СТАРЫЕ_ЗАПУСКИ.indexOf(h) >= 0; });
  Logger.log('Старые автозапуски: ' + (old.length ? old.join(', ') + ' — их выключит сайтВключить()' : 'нет'));
}

/** Один раз: включает отправку каждую минуту и выключает старый автоответ и импорт в таблицу. */
function сайтВключить() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (h === 'сайтОтправлять' || САЙТ_СТАРЫЕ_ЗАПУСКИ.indexOf(h) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('сайтОтправлять').timeBased().everyMinutes(1).create();
  Logger.log('Готово. Письма клиентам уходят каждую минуту с ' + Session.getEffectiveUser().getEmail() +
             ', ответы клиентов попадают в чат приложения. Старый автоответ выключен (код не удалён).');
}

/** Откат: выключает новую отправку. Старый автоответ обратно не включает. */
function сайтВыключить() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'сайтОтправлять') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Отправка писем с сайта выключена. Очередь на сервере сохраняется.');
}
