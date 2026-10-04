/**
 * SUBNEX — письма «заявка принята» клиентам с сайта, с адреса collections@subnex.co.uk.
 *
 * Кладётся НОВЫМ файлом в проект Apps Script ящика collections@subnex.co.uk
 * (тот, где старый автоответ и Collection Manager). Остальные файлы не трогать.
 *
 * Заявки с сайта сразу попадают в приложение SUBNEX. Приложение готовит письмо, а этот файл
 * каждые 5 минут забирает такие письма и отправляет их из этого ящика. Партнёрские письма
 * сюда не приходят — они уходят с subnex.operations@gmail.com, как раньше.
 *
 * Один раз:
 *   1. Вписать три значения ниже (скопировать из Код.gs проекта subnex.operations).
 *   2. Запустить сайтПроверить() — должна быть «Связь с приложением есть».
 *   3. Запустить сайтВключить() — включает отправку и выключает старый автоответ,
 *      чтобы клиент не получал два письма.
 */

const САЙТ_SUPABASE_URL = 'ВСТАВЬТЕ: SUPABASE_URL из Код.gs';
const САЙТ_ANON_KEY = 'ВСТАВЬТЕ: ANON_KEY из Код.gs';
const САЙТ_СЕКРЕТ = 'ВСТАВЬТЕ: INTAKE_SECRET из Код.gs';

const САЙТ_ОТ_КОГО = 'collections@subnex.co.uk';
const САЙТ_ИМЯ = 'SUBNEX';
const САЙТ_ПИСЕМ_ЗА_РАЗ = 10;

/** Старые автозапуски этого проекта, которые больше не нужны: всё делает приложение. */
const САЙТ_СТАРЫЕ_ЗАПУСКИ = ['processNewCollectionBookings', 'syncCollectionManagerBookings'];

function сайтСервер(action, data) {
  const url = САЙТ_SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/subnex_email_worker';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: САЙТ_ANON_KEY, Authorization: 'Bearer ' + САЙТ_ANON_KEY },
    payload: JSON.stringify({ p_secret: САЙТ_СЕКРЕТ, p_action: action, p_data: data || {} }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Приложение ответило ' + code + ': ' + body);
  return JSON.parse(body);
}

/** Если collections@ — псевдоним этого ящика, письмо уходит именно с него. */
function сайтОпции(job) {
  const opts = { htmlBody: job.html, name: job.from_name || САЙТ_ИМЯ, replyTo: САЙТ_ОТ_КОГО };
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  const aliases = GmailApp.getAliases().map(function (x) { return String(x).toLowerCase(); });
  if (me !== САЙТ_ОТ_КОГО && aliases.indexOf(САЙТ_ОТ_КОГО) >= 0) opts.from = САЙТ_ОТ_КОГО;
  return opts;
}

/** Рабочая функция: её запускает автозапуск каждые 5 минут. */
function сайтОтправлять() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const jobs = (сайтСервер('claim', { limit: САЙТ_ПИСЕМ_ЗА_РАЗ, from: САЙТ_ОТ_КОГО }).jobs) || [];
    jobs.forEach(function (job) {
      try {
        GmailApp.sendEmail(job.to, job.subject, job.text, сайтОпции(job));
        сайтСервер('done', { id: job.id, ok: true });
      } catch (e) {
        const text = String(e && e.message ? e.message : e);
        if (/limit|quota|лимит/i.test(text)) { Logger.log('Лимит Gmail на сегодня: ' + text); return; }
        сайтСервер('done', { id: job.id, ok: false, error: text });
        Logger.log('Письмо не ушло на ' + job.to + ': ' + text);
      }
    });
    if (jobs.length) Logger.log('Отправлено писем: ' + jobs.length);
  } finally {
    lock.releaseLock();
  }
}

/** Проверка — ничего не отправляет. */
function сайтПроверить() {
  const r = сайтСервер('ping');
  Logger.log('Связь с приложением есть. Письма включены: ' + (r.enabled ? 'да' : 'НЕТ') + '.');
  const me = String(Session.getEffectiveUser().getEmail()).toLowerCase();
  const alias = GmailApp.getAliases().map(function (x) { return String(x).toLowerCase(); }).indexOf(САЙТ_ОТ_КОГО) >= 0;
  Logger.log('Ящик скрипта: ' + me + '. Письма уйдут с ' +
             (me === САЙТ_ОТ_КОГО || alias ? САЙТ_ОТ_КОГО : me + ' (collections@ не подключён — ответы всё равно придут на collections@)') + '.');
  const old = ScriptApp.getProjectTriggers().filter(function (t) {
    return САЙТ_СТАРЫЕ_ЗАПУСКИ.indexOf(t.getHandlerFunction()) >= 0;
  }).map(function (t) { return t.getHandlerFunction(); });
  Logger.log('Старые автозапуски: ' + (old.length ? old.join(', ') + ' — их выключит сайтВключить()' : 'нет'));
}

/** Один раз: включает отправку каждые 5 минут и выключает старый автоответ и импорт в таблицу. */
function сайтВключить() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const h = t.getHandlerFunction();
    if (h === 'сайтОтправлять' || САЙТ_СТАРЫЕ_ЗАПУСКИ.indexOf(h) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('сайтОтправлять').timeBased().everyMinutes(5).create();
  Logger.log('Готово. Письма «заявка принята» уходят каждые 5 минут с ' + Session.getEffectiveUser().getEmail() +
             '. Старый автоответ выключен (код не удалён).');
}

/** Откат: выключает новую отправку. Старый автоответ обратно не включает. */
function сайтВыключить() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'сайтОтправлять') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Отправка писем с сайта выключена. Очередь на сервере сохраняется.');
}
