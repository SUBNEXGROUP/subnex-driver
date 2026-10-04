/**
 * SUBNEX — письма клиентам без британского мобильного.
 *
 * Сервер (миграция 60) сам решает, кому и что писать: предложение даты с кнопкой «Confirm collection»,
 * напоминание, подтверждение, закрытие. Этот файл только забирает готовые письма из очереди
 * и отправляет их с этого Gmail. Ничего не решает и ничего не хранит.
 *
 * Кладётся ОТДЕЛЬНЫМ файлом рядом с Код.gs в тот же проект Apps Script:
 * SUPABASE_URL, ANON_KEY и INTAKE_SECRET берутся из Код.gs, вписывать их второй раз не нужно.
 *
 * Один раз: запустить включитьОтправкуПисем() — дальше письма уходят каждые 5 минут.
 */

const ПИСЕМ_ЗА_РАЗ = 10;

function письмаСервер(action, data) {
  const url = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/subnex_email_worker';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY },
    payload: JSON.stringify({ p_secret: INTAKE_SECRET, p_action: action, p_data: data || {} }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Приложение ответило ' + code + ': ' + body);
  return JSON.parse(body);
}

/** Адрес отправителя: если сервер просит отправить с другого адреса (collections@subnex.co.uk)
 *  и этот адрес подключён к ящику как «Отправлять письма как», письмо уходит с него.
 *  Если не подключён — уходит с этого ящика, но ответ клиента придёт на нужный адрес. */
function письмоОпции(job) {
  const opts = { htmlBody: job.html, name: job.from_name };
  if (job.from_email) {
    const aliases = GmailApp.getAliases().map(function (x) { return String(x).toLowerCase(); });
    if (aliases.indexOf(String(job.from_email).toLowerCase()) >= 0) opts.from = job.from_email;
    else opts.replyTo = job.from_email;
  }
  return opts;
}

/** Рабочая функция: её запускает автозапуск каждые 5 минут. */
function отправлятьПисьма() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const jobs = (письмаСервер('claim', { limit: ПИСЕМ_ЗА_РАЗ }).jobs) || [];
    jobs.forEach(function (job) {
      try {
        GmailApp.sendEmail(job.to, job.subject, job.text, письмоОпции(job));
        письмаСервер('done', { id: job.id, ok: true });
      } catch (e) {
        const text = String(e && e.message ? e.message : e);
        // Дневной лимит Gmail — не ошибка письма: оставляем в очереди, сервер отдаст его снова через 10 минут.
        if (/limit|quota|лимит/i.test(text)) { Logger.log('Лимит Gmail на сегодня: ' + text); return; }
        письмаСервер('done', { id: job.id, ok: false, error: text });
        Logger.log('Письмо не ушло на ' + job.to + ': ' + text);
      }
    });
    if (jobs.length) Logger.log('Отправлено писем: ' + jobs.length);
  } finally {
    lock.releaseLock();
  }
}

/** Проверка связи — ничего не отправляет. Показывает, с какого ящика пойдут письма. */
function проверитьОтправкуПисем() {
  const r = письмаСервер('ping');
  Logger.log('Связь с приложением есть. Письма включены в приложении: ' + (r.enabled ? 'да' : 'НЕТ') +
             '. Ждут отправки: ' + r.pending + '.');
  Logger.log('Письма будут уходить с ящика: ' + Session.getEffectiveUser().getEmail());
  const aliases = GmailApp.getAliases();
  Logger.log('Подключённые адреса «Отправлять как»: ' + (aliases.length ? aliases.join(', ') : 'нет') +
             '. Для писем «заявка принята» нужен collections@subnex.co.uk.');
  Logger.log('Сегодня Gmail ещё разрешает отправить: ' + MailApp.getRemainingDailyQuota() + ' писем.');
}

/** Один раз: включает отправку каждые 5 минут (приём заявок не трогает). */
function включитьОтправкуПисем() {
  выключитьОтправкуПисем();
  ScriptApp.newTrigger('отправлятьПисьма').timeBased().everyMinutes(5).create();
  Logger.log('Готово. Письма клиентам будут уходить каждые 5 минут с ящика ' + Session.getEffectiveUser().getEmail() + '.');
}

/** Выключает отправку писем. Очередь на сервере сохраняется. */
function выключитьОтправкуПисем() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'отправлятьПисьма') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Отправка писем выключена.');
}
