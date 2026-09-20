/* Shared intake, route proposals and immutable started days. No SMS is sent here. */
(function (root) {
  'use strict';
  /* Перевод подписи (i18n.js). Без слоя переводов — исходный русский текст. */
  const T = root.T || ((s) => s);
  const C = root.SubnexDispatchCore,
    esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /* Показываем обещание клиенту, а не служебный срок проверки: у старых заявок он равен концу дня. */
  const slotOf = (n) => [n.starts_at ? C.ukMinute(n.starts_at) : n.earliest, n.ends_at ? C.ukMinute(n.ends_at) : n.latest];
  /* Почему автоподбор не берёт заявку. Коды приходят из subnex_private.auto_plan_skip. */
  const skipText = (code) =>
    ({
      AUTO_OFF: T('автоподбор выключен в настройках'),
      NO_DRIVER: T('не назначен водитель'),
      NO_COORDS: T('ждём координаты адреса'),
      MANUAL_CHAT: T('идёт ручное согласование в переписке'),
      NO_MOBILE: T('нет британского мобильного — предложите вручную'),
      TWIN_PHONE: T('тот же номер, что у другой заявки — ждёт её'),
      TWIN_HOUSE: T('повтор по дому — решает человек'),
      ATTEMPT_USED: T('автопредложение уже было — предложите вручную'),
      NO_ZONE: T('район не настроен'),
      ZONE_OFF: T('район выключен'),
      NO_DAY: T('нет подходящего дня в горизонте'),
    })[code] || code;
  const arrivalLabel = (n) => {
    const [s, e] = slotOf(n);
    if (Number.isFinite(s) && Number.isFinite(e) && e - s >= 360) return T('в течение дня');
    return s === e ? T('прибытие ') + C.hm(s) : T('интервал ') + C.hm(s) + '–' + C.hm(e);
  };
  const nextDay = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const label = (d) =>
    new Intl.DateTimeFormat(root.SubnexI18n ? root.SubnexI18n.locale() : 'ru-RU', {
      day: 'numeric',
      month: 'long',
      weekday: 'short',
      timeZone: 'UTC',
    }).format(new Date(d + 'T12:00:00Z'));
  /* Код ошибки без приставки ROUTE_ — по нему решаем, беда в одном адресе или во всём сразу. */
  const codeOf = (e) => String(e?.code || e?.message || e || '').replace(/^ROUTE_/, '');
  /* Общий сбой: дело не в адресе, продолжать рассылку бессмысленно и вредно. */
  const BATCH_FATAL = new Set([
    'ACCESS_DENIED',
    'LOGIN_REQUIRED',
    'NOT_CONFIGURED',
    'RATE_LIMIT',
    'SERVICE_UNAVAILABLE',
    'NETWORK',
    'OFFLINE_PENDING',
    'ROUTING_PROVIDER_REQUIRED',
    'SETTINGS_REQUIRED',
    'SETTINGS_INVALID',
    'DATABASE_ERROR',
    'CREATE_AUTH_USER_FIRST',
    'ROUTE_STARTED',
  ]);
  const batchFatal = (e) => {
    const c = codeOf(e);
    return BATCH_FATAL.has(c) || /^ROUTING_HTTP_|Failed to fetch|NetworkError|Нет соединения|не загружен/i.test(c);
  };
  /* Британские дата и время для писем клиентам и партнёру. */
  const longDate = (day) => {
    const d = new Date(day + 'T12:00:00Z'),
      n = d.getUTCDate();
    const suf = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return (
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()] +
      ' ' +
      n +
      suf +
      ' ' +
      ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][
        d.getUTCMonth()
      ]
    );
  };
  const clock = (m) => {
    const h = Math.floor(m / 60);
    return (h % 12 || 12) + ':' + String(m % 60).padStart(2, '0') + (h < 12 ? 'am' : 'pm');
  };
  const errors = {
    ACCESS_DENIED: T('Нет доступа к этому водителю.'),
    SETTINGS_REQUIRED: T('Сначала сохраните старт, склад и параметры машины.'),
    SETTINGS_INVALID: T('Проверьте координаты и параметры машины.'),
    SETTINGS_IN_USE: T('В расписании уже есть договорённости. Старт, склад и параметры дороги пока сохранены; резерв можно изменить.'),
    ROUTING_PROVIDER_REQUIRED: T('Для расчёта дороги нужно подключить сервис маршрутов в настройках функции subnex-routing.'),
    COORDINATES_REQUIRED: T('Уточните координаты всех адресов этого дня.'),
    ROADS_REQUIRED: T('Не удалось получить время поездки. Повторите расчёт после восстановления сервиса.'),
    DAY_CLOSED: T('Выходной по рабочему графику.'),
    TIME_REQUIRED: T('Есть адрес без согласованного времени.'),
    TIME_CONFLICT: T('Не хватает времени на дорогу и сбор.'),
    OUTSIDE_HOURS: T('Интервал выходит за рабочий график.'),
    OUTSIDE_WORKING_HOURS: T('Время выходит за рабочий график этого дня. Продлите часы в Настройки → Часы и доступ.'),
    DEPOT_LATE: T('Проверьте обновление расчёта: время склада должно считаться отдельно.'),
    DAY_BOUNDARY: T('Поездка заканчивается на следующие сутки. Нужна отдельная проверка маршрута.'),
    CAPACITY: T('Превышена ожидаемая загрузка машины.'),
    RESERVE_EXHAUSTED: T('Для этого плана недостаточно свободного времени или запаса по загрузке.'),
    STALE_ADDRESS: T('Заявка изменилась. Обновите список и пересчитайте план.'),
    REQUEST_RESERVED: T('Для заявки уже предложено время. Откройте согласование.'),
    ARRIVAL_WINDOW_30: T('Укажите интервал в 30 минут или отметьте «Только дата».'),
    ALREADY_SCHEDULED_USE_MANUAL: T('У клиента уже подтверждено время. Откройте «Переписку» и предложите новое.'),
    CONFIRMED_FIXED: T('Подтверждённые дату и интервал изменять нельзя.'),
    CONFIRMED_CHANGE_REQUIRES_AGREEMENT: T('Отметьте, что клиент согласовал перенос. Подтверждённое время само не двигается.'),
    USE_CHAT_TO_RESCHEDULE: T('Клиент ещё не ответил на отправленное время. Перенос делается в разделе «Переписка».'),
    REQUEST_ALREADY_FINISHED: T('Эта заявка уже завершена. Обновите список.'),
    PENDING_CONFIRMATIONS: T('Сначала завершите согласование предложений этого дня или снимите неподтверждённые предложения.'),
    START_TODAY_ONLY: T('Начать можно маршрут на сегодняшний день.'),
    EMPTY_ROUTE: T('В этот день пока нет сборов.'),
    DISPATCH_NOT_ENABLED: T('Новая версия установлена, но ещё не включена. Завершите шаг активации.'),
    PARTNER_WITHDRAWAL_REQUIRED: T('Сначала отзовите предложение у партнёра.'),
    USE_CHAT_TO_CLOSE_OFFER: T('Закройте предложение в SMS-переписке, затем обновите очередь.'),
    OUTSIDE_AREA: T('Адрес вне зоны автоматического распределения.'),
    SLOT_IN_PAST: T('Это время уже прошло. Подберите новый интервал.'),
    BEFORE_AVAILABILITY: T('Клиент доступен позже выбранной даты.'),
    SLOT_INVALID: T('Проверьте дату, интервал 30 минут и доступность клиента.'),
    DATE_RANGE: T('Выберите дату от сегодня до 90 дней вперёд.'),
    AGREEMENT_REQUIRED: T('Нужна отметка, что партнёр или клиент подтвердил именно эти дату и время.'),
    BATCH_LIMIT_40: T('За один расчёт выберите не больше 40 заявок.'),
    AUTH_REQUIRED: T('Войдите в приложение заново.'),
    DUPLICATE_BANK_VISIT: T('Этот контейнер уже назначен на выбранный день.'),
    OFFLINE_PENDING: T('Сначала синхронизируйте изменения, сохранённые на устройстве.'),
    REQUEST_ID_REUSED: T('Состав уже сохранённого запроса отличается. Обновите очередь.'),
    ZONE_OFF: T('Этот район выключен в настройках зон выезда.'),
    ZONE_TRIP_DAY: T('Адрес дальней зоны — его ставят только в день выезда в эту зону.'),
    ZONE_DAY_TAKEN: T('В этот день назначен выезд в другую зону.'),
    ROUTE_STARTED: T('Маршрут этого дня уже начат. Новые заявки остаются в очереди на следующие дни.'),
    DAY_OUT_OF_RANGE: T('Этот день вне рассчитанного плана.'),
    START_CANCELLED: T('Старт отменён.'),
    PLAN_CHANGED: T('План изменился. Обновите расчёт.'),
  };
  /* Причина, по которой день не берёт адрес — словами, а не кодом. Заменяет
   бесполезное «места нет»: видно, какой перегон и почему не сходится. */
  const hmOr = (n) => (Number.isFinite(n) ? C.hm(n) : '—');
  const dayIssueText = (r) => {
    if (!r || r.ok) return '';
    switch (r.code) {
      case 'TIME_CONFLICT':
        return `${T('В этот день маршрут не сходится:')} ${r.from || T('предыдущая точка')} → ${r.to || T('следующий адрес')}${T(', расчётное прибытие')} ${hmOr(r.arrival)}${T(', а согласовано не позже')} ${hmOr(r.latest)}.`;
      case 'ROADS_REQUIRED':
        return `${T('В этот день не удалось посчитать дорогу:')} ${r.from || T('старт')} → ${r.to || T('адрес')}.`;
      case 'COORDINATES_REQUIRED':
        return `${T('В этот день есть адрес без координат:')} ${r.address || '—'}.`;
      case 'OUTSIDE_HOURS':
        return `${T('В этот день есть время вне рабочего графика:')} ${r.address || '—'}.`;
      case 'TIME_REQUIRED':
        return `${T('В этот день есть адрес без согласованного времени:')} ${r.address || '—'}.`;
      case 'CAPACITY':
        return T('В этот день машина уже загружена полностью.');
      case 'ZONE_TRIP_DAY':
        return `${T('Это адрес дальней зоны')}${r.zone && r.zone.name ? ' «' + r.zone.name + '»' : ''} ${T('— его ставят только в день выезда в неё.')}`;
      case 'ZONE_DAY_TAKEN':
        return `${T('В этот день назначен выезд')}${r.zone && r.zone.name ? T(' в «') + r.zone.name + '»' : ''} ${T('— чужие адреса туда не ставим.')}`;
      default:
        return errors[r.code] || `${T('В этот день поставить нельзя (')}${r.code || T('причина не определена')}).`;
    }
  };
  /* Опоздание — не то же самое, что невозможный день. Если сегодняшний день не сходится
   только потому, что обещанное время уже прошло, перестановка его не вернёт. */
  function lateOnly(fit, day) {
    if (!fit || fit.ok) return false;
    if (day !== C.ukDay()) return false;
    if (fit.code !== 'TIME_CONFLICT') return false;
    return Number.isFinite(fit.latest) && fit.latest < C.ukMinute(new Date());
  }
  function error(e) {
    let code = String(e?.code || e?.message || e || '');
    if (!errors[code] && e?.message) code = e.message;
    let detail = e?.details || e?.detail;
    try {
      if (typeof detail === 'string') detail = JSON.parse(detail);
    } catch {
      detail = null;
    }
    let key = code.replace(/^ROUTE_/, '');
    if (errors[code]) key = code;
    let text =
      errors[key] ||
      (/^ROUTING_HTTP_429/.test(code)
        ? T('Сервис дорог временно ограничил запросы. Подождите минуту и повторите.')
        : /^ROUTING_HTTP_|fetch|Failed to fetch|network/i.test(code)
          ? T('Сервис дорог недоступен. План не сохранён; повторите позже.')
          : code);
    if (code.includes('DUPLICATE_ADDRESS')) text = T('В пачке или действующих заявках есть этот адрес. Проверьте повторы.');
    if (code.includes('UK_MOBILE_REQUIRED')) text = T('Для согласования по SMS нужен номер +447…');
    if (detail?.to) text += T(' Участок: ') + (detail.from || T('Старт')) + ' → ' + detail.to + '.';
    if (Number.isFinite(detail?.arrival) && Number.isFinite(detail?.latest))
      text += T(' Расчётное прибытие ') + C.hm(detail.arrival) + T(', согласовано не позже ') + C.hm(detail.latest) + '.';
    if (detail?.address) text += ' ' + detail.address + '.';
    return text;
  }
  async function rpc(sb, action, data) {
    const r = await sb.rpc('subnex_dispatch', { p_action: action, p_data: data });
    if (r.error) throw r.error;
    return r.data;
  }
  async function edge(sb, data) {
    const r = await sb.functions.invoke('subnex-routing', { body: data });
    if (r.error) {
      let body;
      try {
        body = await r.error.context?.json();
      } catch {}
      throw new Error(body?.error || r.error.message);
    }
    if (r.data?.error) throw new Error(r.data.error);
    return r.data;
  }
  function online(o) {
    if (o.hasOutbox?.()) throw new Error('OFFLINE_PENDING');
    if (!navigator.onLine) throw new Error(T('Сейчас нет соединения. Сохранение плана требует интернета.'));
  }
  async function ready(sb, driver) {
    const r = await rpc(sb, 'settings', { driver_id: driver });
    if (!C.validPoint(r.config.home) || !C.validPoint(r.config.depot)) throw new Error('SETTINGS_REQUIRED');
    return r;
  }
  async function warm(o, day, addressIds = []) {
    online(o);
    await ready(o.sb, o.driver.id);
    return edge(o.sb, { action: 'matrix', driver_id: o.driver.id, day, address_ids: addressIds });
  }
  async function preflight(o, plan, payload) {
    online(o);
    const driver = plan?.driver_id || o.driver?.id || o.address?.driver_id;
    if (!driver) throw new Error(T('Нужно назначить водителя.'));
    const setup = await rpc(o.sb, 'settings', { driver_id: driver });
    if (!setup.enabled) return null;
    const id = plan?.address_id || o.address?.id;
    if (!id) throw new Error(T('Сначала добавьте адрес.'));
    await warm({ ...o, driver: { id: driver } }, payload.day, [id]);
    await rpc(o.sb, 'check', {
      driver_id: driver,
      address_id: id,
      day: payload.day,
      start: payload.start,
      end: payload.end,
      reoffer: !!payload.reoffer,
    });
    return {};
  }
  /* Лучший порядок остановок по матрице дорог (см. core.optimizeOrder). null — улучшений нет
     или считать не по чему. Окна прибытия соблюдаются, поэтому подтверждённые интервалы не страдают. */
  function betterOrder(state, roads) {
    if (!state || state.started_at || !roads || !Array.isArray(state.nodes) || state.nodes.length < 3) return null;
    try {
      const r = C.optimizeOrder(state.nodes, state.order, state.config, state.hours, roads, state.start_minute ?? null);
      return r.improved ? r.order : null;
    } catch {
      return null;
    }
  }
  async function routeDay(o, day) {
    const before = await rpc(o.sb, 'day', { driver_id: o.driver.id, day });
    if (!before.enabled) return null;
    let warning = '';
    if (!before.started_at) {
      try {
        const roads = (await warm(o, day))?.roads;
        /* Пока день не начат, порядок можно улучшать: сервер хранит порядок «как вставилось»,
           телефон и пульт после расчёта дорог сохраняют переставленный. Ошибка здесь не мешает показу. */
        const order = betterOrder(before, roads);
        if (order) {
          try {
            await rpc(o.sb, 'reorder', { driver_id: o.driver.id, day, token: before.token, order });
          } catch {}
        }
      } catch (e) {
        warning = error(e);
      }
    }
    const state = await rpc(o.sb, 'day', { driver_id: o.driver.id, day });
    let geometry;
    try {
      geometry = await edge(o.sb, { action: 'geometry', driver_id: o.driver.id, day });
      if (geometry.token !== state.token) throw new Error('PLAN_CHANGED');
    } catch (e) {
      warning = warning || error(e);
      const nodes = state.started_at ? state.fit.nodes : state.nodes,
        byId = new Map(nodes.map((n) => [n.key, n]));
      const order = state.fit?.order || state.order;
      const cfg = state.started_at ? state.fit.config : state.config;
      geometry = {
        order: order.filter((k) => k.startsWith('a:')).map((k) => k.slice(2)),
        geometry: [cfg.home, ...order.map((k) => byId.get(k)), cfg.depot].filter(C.validPoint).map((p) => [p.lat, p.lng]),
        km: null,
        min: null,
        sketch: true,
      };
    }
    return { ...geometry, state, warning: warning || (!state.fit.ok ? error({ code: state.fit.code, detail: state.fit }) : '') };
  }
  /* Блокировка старта была чисто клиентской: сервер при p_action='start' fit не проверяет.
   Из-за этого опоздание на один адрес запирало весь день, хотя сборы уже сделаны.
   Теперь опоздание отличаем от невозможного дня и отдаём решение водителю (onLate). */
  /* Старт дня = утренняя оптимизация: дороги → лучший порядок → сервер замораживает план
     и ставит каждому адресу SMS с окном прибытия. Возвращает план дня; в .started — ответ
     сервера (eta_sent — скольким ушла SMS). */
  async function startDay(o, day, opts = {}) {
    online(o);
    const roads = (await warm(o, day))?.roads;
    const state = await rpc(o.sb, 'day', { driver_id: o.driver.id, day });
    if (state.started_at) return state;
    if (!state.fit.ok) {
      if (!lateOnly(state.fit, day)) throw { message: state.fit.code, details: state.fit };
      if (opts.onLate) {
        if (!(await opts.onLate(state.fit))) throw { message: 'START_CANCELLED' };
      } else if (!opts.allowLate) throw { message: state.fit.code, details: state.fit };
    }
    const order = betterOrder(state, roads) || undefined;
    const started = await rpc(o.sb, 'start', { driver_id: o.driver.id, day, token: state.token, order });
    const after = await rpc(o.sb, 'day', { driver_id: o.driver.id, day });
    after.started = started;
    return after;
  }
  const sourceOptions = (selected) =>
    Object.entries(C.sourceNames)
      .map(([v, n]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${n}</option>`)
      .join('');
  const input = (name, title, value = '', type = 'text', extra = '') =>
    `<label>${title}<input data-field="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  /* Напоминание тому, кто не ответил на предложение. Время НЕ пересчитывается:
   повторяем ровно то, что уже обещали, иначе человек получит два разных
   интервала и перестанет понимать, когда его ждать. */
  const reminderMessage = (a, driverName) => {
    const name = String(driverName || '').trim(),
      brand = C.brandOf(a);
    /* Предложение только даты (режим day): напоминаем дату, время придёт утром. Тот же текст шлёт сервер. */
    if (C.isDaySpan(a.offered_start, a.offered_end))
      return `Reminder from ${brand}: we can collect your clothing donation on ${C.enShortDate(C.ukDay(a.offered_start))}. Reply YES to confirm, or tell us another day that suits you.`;
    const when = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(C.ukDay(a.offered_start) + 'T12:00:00Z'));
    const from = C.hm(C.ukMinute(a.offered_start)),
      to = C.hm(C.ukMinute(a.offered_end || a.offered_start));
    return (
      `Hello, this is ${name ? name + ' from ' + brand : brand}.\n\n` +
      `We are still holding your clothing collection at ${a.text} on ${when}, between ${from} and ${to} (UK time).\n\n` +
      `Please reply YES to confirm and we will be there. If that day no longer suits you, just reply and tell us which day works better — we are happy to move it.\n\n` +
      `Kind regards,\n${name ? name + '\n' : ''}${brand}`
    );
  };
  /* Запасной текст для источников без партнёрского шаблона. Смысл тот же, что
   у шаблона: прежний день прошёл, вот новое время, подтвердите. */
  const renewMessage = (a, driverName, day, start, end) => {
    const name = String(driverName || '').trim(),
      brand = C.brandOf(a);
    const when = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(day + 'T12:00:00Z'));
    return (
      `Hello, this is ${name ? name + ' from ' + brand : brand}.\n\n` +
      `We did not hear back about your clothing collection at ${a.text}, so the day we offered has now passed.\n\n` +
      `We can come on ${when}, between ${start} and ${end} (UK time). Please reply YES to confirm, or tell us which day suits you better — we are happy to fit around you.\n\n` +
      `Kind regards,\n${name ? name + '\n' : ''}${brand}`
    );
  };
  /* Список charity — подсказка, а не ограничение: партнёр регулярно присылает новые,
   поэтому поле остаётся текстовым, а список только помогает не плодить написания. */
  const datalist = (id, items) => `<datalist id="${id}">${items.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
  const charityInput = (value, id = 'od-charities') =>
    input(
      'charity',
      T('Charity — для кого сбор'),
      value || '',
      'text',
      `list="${id}" maxlength="200" placeholder="${T('Начните печатать или выберите')}"`,
    );
  let instance;
  class Dispatch {
    constructor(o) {
      this.o = o;
      this.sb = o.sb;
      this.driver = o.driver;
      this.inline = !!o.mount;
      this.tabs = Array.isArray(o.tabs) ? o.tabs : ['queue', 'one', 'batch', 'settings'];
      this.rows = [];
      this.requests = [];
      this.selected = new Set(o.address ? [o.address.id] : []);
      this.mode = o.tab || 'queue';
      this.source = C.sourceNames[o.source] ? o.source : C.sourceOf({ collection_source: o.source });
      this.from = o.fromDay || nextDay(C.ukDay());
      this.days = 14;
      this.busy = false;
      this.importId = crypto.randomUUID();
    }
    $(s) {
      return this.root.querySelector(s);
    }
    call(action, data = {}) {
      return rpc(this.sb, action, { driver_id: this.driver.id, ...data });
    }
    notice(text, bad = false) {
      const n = this.$('.od-notice');
      n.textContent = text || '';
      n.classList.toggle('bad', bad);
      n.hidden = !text;
    }
    async run(fn, progress = T('Загрузка…')) {
      if (this.busy) return;
      this.busy = true;
      this.notice(progress);
      this.root.setAttribute('aria-busy', 'true');
      this.root.querySelectorAll('button,input,select,textarea').forEach((b) => (b.disabled = true));
      try {
        await fn();
      } catch (e) {
        this.notice(error(e), true);
      } finally {
        this.busy = false;
        if (this.closed) return;
        this.root.setAttribute('aria-busy', 'false');
        this.root.querySelectorAll('button,input,select,textarea').forEach((b) => (b.disabled = b.dataset.locked === 'true'));
      }
    }
    async start() {
      this.oldFocus = document.activeElement;
      this.oldOverflow = document.body.style.overflow;
      this.root = document.createElement('div');
      this.root.className = 'od-root' + (this.inline ? ' od-inline' : '');
      if (!this.inline) {
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-modal', 'true');
        this.root.setAttribute('aria-labelledby', 'od-title');
      }
      const tabNames = { queue: T('Очередь'), one: T('Один адрес'), batch: T('Вставить список'), settings: T('Параметры') };
      const tabsHtml =
        this.tabs.length > 1
          ? `<div class="od-tabs" role="navigation" aria-label="${T('Разделы')}">${this.tabs.map((k) => `<button data-action="${k}">${tabNames[k]}</button>`).join('')}</div>`
          : '';
      this.root.innerHTML = `<section class="od-panel">${this.inline ? '' : `<header class="od-top"><div><small>SUBNEX · ${esc(this.driver.name || T('Водитель'))}</small><h2 id="od-title">${T('Заявки и маршруты')}</h2></div><button data-action="close" aria-label="${T('Закрыть')}">✕</button></header>`}${tabsHtml}<div class="od-notice" role="status" hidden></div><main class="od-content"></main></section>`;
      if (this.inline) {
        this.o.mount.replaceChildren(this.root);
      } else {
        document.body.append(this.root);
        document.body.style.overflow = 'hidden';
      }
      this.root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-action]');
        if (b && !b.disabled) this.action(b.dataset.action, b);
      });
      this.root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          const dialog = this.$('.od-dialog');
          if (dialog && !this.modalBusy) {
            dialog.remove();
            this.$('[data-action=close]')?.focus();
          } else if (!dialog && !this.inline) this.close();
        }
        if (e.key === 'Tab') {
          const list = [...(this.$('.od-dialog') || this.root).querySelectorAll('button,input,select,textarea,a')].filter(
            (el) => !el.disabled && el.getClientRects().length,
          );
          if (e.shiftKey && document.activeElement === list[0]) {
            e.preventDefault();
            list.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
            e.preventDefault();
            list[0]?.focus();
          }
        }
      });
      await this.run(async () => {
        await this.reload();
        this.render();
        this.notice(this.enabled ? '' : T('Подготовка новой версии. Планирование включится после активации.'));
      });
      if (!this.inline) this.$('[data-action=close]')?.focus();
    }
    close() {
      if (this.busy || this.modalBusy || this.closed) return;
      this.closed = true;
      this.root.remove();
      if (!this.inline) {
        document.body.style.overflow = this.oldOverflow;
        this.oldFocus?.focus();
      }
      if (instance === this) instance = null;
    }
    async reload() {
      try {
        const z = await this.sb.rpc('subnex_zones', { p_action: 'list', p_data: {} });
        if (!z.error) this.zones = z.data.zones || [];
      } catch (e) {}
      const r = await this.call('queue');
      this.requests = r.requests;
      this.legacy = r.legacy || [];
      this.enabled = r.enabled;
      this.config = r.config;
      this.autoPlan = r.auto_plan || null;
      try {
        const ac = await this.call('auto_plan_settings');
        this.autoCfg = ac.config || null;
        this.autoInfo = ac;
      } catch {
        this.autoCfg = null;
      }
      this.selected = new Set([...this.selected].filter((id) => this.requests.some((a) => a.id === id)));
    }
    render() {
      const beforeMode = this.renderedMode;
      this.renderedMode = this.mode;
      this.$('.od-content').innerHTML =
        this.mode === 'settings'
          ? this.settings()
          : this.mode === 'one' || this.mode === 'batch'
            ? this.intake()
            : this.mode === 'review'
              ? this.review()
              : this.mode === 'plan'
                ? this.planView()
                : this.queue();
      this.root
        .querySelectorAll('.od-tabs button')
        .forEach((b) => b.setAttribute('aria-current', b.dataset.action === this.mode ? 'page' : 'false'));
      this.bind();
      if (beforeMode !== this.mode) this.$('.od-content').scrollTop = 0;
    }
    intake() {
      const one = this.mode === 'one';
      return `<div class="od-intro"><h3>${one ? T('Новая заявка на сбор') : T('Заявки из письма')}</h3><p>${one ? T('Дата и время появятся после подбора и согласования с клиентом.') : T('Скопируйте таблицу из письма партнёра и вставьте сюда — приложение разберёт адреса, телефоны и мешки.')}</p></div><label>${T('Источник')}<select id="od-source">${sourceOptions(this.source)}</select></label>${this.mode === 'batch' ? `<label>${T('Таблица из письма')}<textarea id="od-paste" rows="10" placeholder="${T('Вставьте таблицу целиком. Также подходят строки с адресами или CSV.')}"></textarea></label><button class="od-primary" data-action="parse">${T('Разобрать и проверить')}</button>` : `<div class="od-grid">${input('text', T('Полный адрес'), '', 'text', `placeholder="${T('Дом, улица, город, postcode')}"`)}${input('phone', T('Мобильный телефон'), '', 'tel', 'placeholder="07…"')}${input('bags_text', T('Мешки — как в заявке'), '', 'text', 'placeholder="4 to 10"')}${charityInput('')}${input('not_before', T('Клиент доступен с'), '', 'date')}</div>${datalist('od-charities', this.charities())}<input data-field="estimated_kg" data-num type="hidden" value="10"><input data-field="service_minutes" data-num type="hidden" value="5"><details><summary>${T('Контакт и примечание')}</summary><div class="od-grid">${input('contact_name', T('Имя'))}${input('contact_email', 'Email', '', 'email')}</div><label>${T('Примечание')}<textarea data-field="note" rows="2"></textarea></label></details><button class="od-primary" data-action="review-one">${T('Проверить заявку')}</button>`}`;
    }
    review() {
      return `<div class="od-intro"><h3>${T('Проверка ·')} ${this.rows.length} ${this.rows.length === 1 ? T('заявка') : T('заявок')}</h3><p>${T('Исправьте выделенные поля. Заявки без полного адреса или телефона добавить нельзя.')}</p></div>${this.rows
        .map((r, i) => {
          const known = this.o.addresses?.() || this.requests;
          const issues = C.issues(r, known, this.rows.slice(0, i));
          const warns = C.warnings(r, known, this.rows.slice(0, i));
          return `<article class="od-card ${issues.length ? 'od-invalid' : ''}" data-row="${i}"><div class="od-between"><b>${i + 1}. ${esc(r.text) || T('Без адреса')}</b><button data-action="remove-row" data-index="${i}" aria-label="${T('Убрать заявку')} ${i + 1}">${T('Убрать')}</button></div><div class="od-row-issues" role="status">${issues.map(esc).join(' · ')}</div>${warns.length ? `<p class="od-warning">${warns.map(esc).join(' ')}</p>` : ''}<div class="od-grid">${input('text', T('Адрес'), r.text)}${input('phone', T('Телефон'), r.phone, 'tel')}${input('bags_text', T('Мешки'), r.bags_text)}${charityInput(r.charity)}${input('not_before', T('Доступен с'), r.not_before, 'date')}<label>${T('Источник')}<select data-field="intake_channel">${sourceOptions(r.intake_channel)}</select></label><label>${T('Сбор')}<select data-field="service_minutes"><option value="5" ${+r.service_minutes !== 10 ? 'selected' : ''}>${T('5 минут')}</option><option value="10" ${+r.service_minutes === 10 ? 'selected' : ''}>${T('10 минут')}</option></select></label></div><input data-field="estimated_kg" data-num type="hidden" value="${esc(r.estimated_kg || 10)}"><details><summary>${T('Контакт и примечание из письма')}</summary><div class="od-grid">${input('contact_name', T('Имя'), r.contact_name)}${input('contact_email', 'Email', r.contact_email, 'email')}</div><textarea data-field="note" rows="2">${esc(r.note)}</textarea></details></article>`;
        })
        .join(
          '',
        )}${datalist('od-charities', this.charities())}<div class="od-footer"><button data-action="batch">${T('Другой список')}</button><button class="od-primary" data-action="import">${T('Добавить в очередь ·')} ${this.rows.length}</button></div>`;
    }
    /* Уже встречавшиеся charity — из всех адресов базы и из текущей очереди. Дубли
    по регистру схлопываем, показываем то написание, что встретилось первым. */
    charities() {
      const seen = new Map();
      for (const a of [...(this.o.addresses?.() || []), ...(this.requests || []), ...(this.rows || [])]) {
        const c = String((a && a.charity) || '').trim();
        if (c && !seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en'));
    }

    /* Готовый текст для партнёра: даты и интервалы так, как их назовут клиенту. */
    partnerList(list) {
      const byDay = new Map();
      for (const a of list) {
        const d = C.ukDay(a.held_start);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(a);
      }
      const out = ['Hi, here are the collection times:', ''];
      for (const day of [...byDay.keys()].sort()) {
        out.push(longDate(day));
        for (const a of byDay.get(day).sort((x, y) => C.ukMinute(x.held_start) - C.ukMinute(y.held_start)))
          out.push(
            '- ' +
              a.text +
              ' - ' +
              (C.isDaySpan(a.held_start, a.held_end)
                ? 'during the day (we text a 1-hour window on the morning)'
                : clock(C.ukMinute(a.held_start)) + ' to ' + clock(C.ukMinute(a.held_end))),
          );
        out.push('');
      }
      out.push('All times are UK time. Please confirm with the customers and let us know if any of these do not suit. Thank you.');
      return out.join('\n');
    }
    /* Разбор очереди по категориям: что куда встало и откуда пришло.
    Английский текст — партнёру в WhatsApp; русская сводка — себе, в копию не попадает. */
    scheduleGroups() {
      const order = ['partner_email', 'missing', 'partner_whatsapp', 'subnex_website'];
      const groups = new Map(order.map((k) => [k, []]));
      for (const a of this.requests) {
        const at = a.held_start || a.offered_start;
        if (!at) continue;
        const src = C.sourceOf(a);
        if (!groups.has(src)) groups.set(src, []);
        groups.get(src).push({ ...a, at, awaiting: ['preparing', 'awaiting', 'manual'].includes(a.offer_state) });
      }
      return [...groups.entries()].filter(([, list]) => list.length);
    }
    scheduleText(groups) {
      const out = ['SUBNEX — collection schedule', 'Prepared ' + longDate(C.ukDay()) + '.', ''];
      for (const [src, list] of groups) {
        out.push((C.sourceNames[src] || src).toUpperCase() + ' — ' + list.length);
        const byDay = new Map();
        for (const a of list) {
          const d = C.ukDay(a.at);
          if (!byDay.has(d)) byDay.set(d, []);
          byDay.get(d).push(a);
        }
        for (const day of [...byDay.keys()].sort()) {
          out.push('  ' + longDate(day));
          for (const a of byDay.get(day).sort((x, y) => C.ukMinute(x.at) - C.ukMinute(y.at))) {
            const end = a.held_end || a.offered_end;
            out.push(
              '   ' +
                (C.isDaySpan(a.at, end) ? 'during the day' : clock(C.ukMinute(a.at)) + (end ? '–' + clock(C.ukMinute(end)) : '')) +
                '  ' +
                a.text +
                (a.awaiting ? '  (awaiting customer reply)' : ''),
            );
          }
        }
        out.push('');
      }
      out.push('All times are UK time. Please confirm with the customers and let us know if any of these do not suit. Thank you.');
      return out.join('\n');
    }
    copySchedule() {
      const groups = this.scheduleGroups();
      const total = groups.reduce((n, [, l]) => n + l.length, 0);
      if (!total) {
        this.notice(T('Пока ни одной заявке не назначено время. Сначала распределите очередь и сохраните предложения.'), true);
        return;
      }
      const summary = groups.map(([src, l]) => `${esc(C.sourceNames[src] || src)} — ${l.length}`).join(' · ');
      const text = this.scheduleText(groups);
      const w = this.dialog(
        T('Разбор по категориям'),
        `<p class="od-muted">${T('Всего с назначенным временем:')} <b>${total}</b>. ${summary}.</p>` +
          `<p class="od-muted">${T('Ниже — готовый английский текст для партнёра. Русская строка выше в копию не попадает.')}</p>` +
          `<textarea id="od-sc-text" rows="16" readonly>${esc(text)}</textarea>` +
          `<div class="od-actions" style="margin-top:8px"><button id="od-sc-copy">${T('Скопировать')}</button></div>`,
        null,
      );
      w.querySelector('#od-sc-copy').onclick = async () => {
        const b = w.querySelector('#od-sc-copy'),
          f = w.querySelector('#od-sc-text');
        try {
          await navigator.clipboard.writeText(f.value);
          b.textContent = T('Скопировано');
        } catch (e) {
          f.removeAttribute('readonly');
          f.select();
          b.textContent = T('Выделено — скопируйте вручную');
        }
      };
    }
    copyForPartner() {
      const { direct } = this.sendable();
      if (!direct.length) {
        this.notice(T('Нет заявок от партнёра с назначенным временем. Сначала распределите и сохраните предложения.'), true);
        return;
      }
      const text = this.partnerList(direct);
      const w = this.dialog(
        T('Текст для WhatsApp'),
        `<p class="od-muted">${direct.length} ${direct.length === 1 ? T('адрес') : T('адресов')}${T('. При копировании отметим их как отправленные — чтобы время случайно не сняли.')}</p>` +
          `<textarea id="od-wa-text" rows="14" readonly>${esc(text)}</textarea>` +
          `<div class="od-actions" style="margin-top:8px"><button id="od-wa-copy">${T('Скопировать')}</button></div>`,
        null,
      );
      w.querySelector('#od-wa-copy').onclick = async () => {
        const b = w.querySelector('#od-wa-copy'),
          f = w.querySelector('#od-wa-text');
        b.disabled = true;
        const failed = [];
        for (const a of direct) {
          try {
            await this.call('share', { address_id: a.id });
          } catch (e) {
            failed.push(a.text);
          }
        }
        try {
          await navigator.clipboard.writeText(text);
          b.textContent = T('Скопировано');
        } catch {
          f.select();
          b.textContent = T('Выделено — нажмите Ctrl+C');
        } finally {
          b.disabled = false;
        }
        w.querySelector('.od-dialog-error').textContent = failed.length
          ? T('Не отмечены как отправленные: ') + failed.join('; ') + T('. Текст скопирован, но проверьте эти адреса.')
          : '';
      };
    }
    /* Заявки, у которых уже зарезервировано время, но клиенту ещё ничего не ушло. */
    sendable() {
      const direct = [],
        sms = [],
        blocked = [];
      for (const a of this.requests) {
        if (!a.hold_id || !a.held_start || a.date) continue;
        if (['preparing', 'awaiting', 'manual'].includes(a.offer_state)) continue;
        const src = C.sourceOf(a);
        if (['partner_whatsapp', 'missing'].includes(src)) direct.push(a);
        else if (/^\+447\d{9}$/.test(C.phone(a.phone || ''))) sms.push(a);
        else blocked.push(a);
      }
      return { direct, sms, blocked, total: direct.length + sms.length };
    }
    slotText(a) {
      if (C.isDaySpan(a.held_start, a.held_end)) return label(C.ukDay(a.held_start)) + T(', в течение дня');
      return label(C.ukDay(a.held_start)) + ', ' + C.hm(C.ukMinute(a.held_start)) + '–' + C.hm(C.ukMinute(a.held_end));
    }
    sendAll() {
      const { direct, sms, blocked, total } = this.sendable();
      if (!total) {
        this.notice(T('Нечего отправлять. Сначала распределите заявки по дням и сохраните предложения.'), true);
        return;
      }
      const li = (a) => `<li>${esc(a.text)} <span class="od-muted">· ${esc(this.slotText(a))}</span></li>`;
      const first = sms[0];
      const sample = !first
        ? ''
        : C.isDaySpan(first.held_start, first.held_end)
          ? C.dayOfferText(first.collection_source, C.ukDay(first.held_start), (this.driver.name || '').trim())
          : Ops.offerText(
              first.collection_source,
              C.ukDay(first.held_start),
              C.hm(C.ukMinute(first.held_start)),
              C.hm(C.ukMinute(first.held_end)),
              (this.driver.name || '').trim(),
            );
      this.dialog(
        T('Отправить предложения'),
        (sms.length
          ? `<p><b>${sms.length}</b> ${sms.every((a) => C.isDaySpan(a.held_start, a.held_end)) ? T('— уйдёт SMS с предложенной датой. Адрес встанет в маршрут после ответа YES, окно прибытия уйдёт утром.') : T('— уйдёт SMS с предложенным временем. Адрес встанет в маршрут после ответа YES.')}</p><ul>${sms.map(li).join('')}</ul>` +
            (sample
              ? `<details><summary>${T('Текст первой SMS')}</summary><textarea rows="9" readonly>${esc(sample)}</textarea></details>`
              : '')
          : '') +
          (direct.length
            ? `<p><b>${direct.length}</b> ${T('— от партнёра: сразу в маршрут, клиенту ничего не отправляется.')}</p><ul>${direct.map(li).join('')}</ul>`
            : '') +
          (blocked.length
            ? `<p class="od-muted">${T('Пропустим')} ${blocked.length}${T(': нет британского мобильного —')} ${blocked.map((a) => esc(a.text)).join('; ')}</p>`
            : '') +
          `<p class="od-muted">${T('Пачка идёт до конца: сбойный адрес не остановит остальные. Если сломается что-то общее — доступ, сервис дорог, лимит — отправка остановится и покажет причину.')}</p>` +
          (sms.length
            ? `<label style="margin-top:10px"><input id="od-send-agree" type="checkbox"> ${T('Да, отправить')} ${sms.length} ${T('SMS живым клиентам')}</label>`
            : ''),
        async (w) => {
          if (sms.length && !w.querySelector('#od-send-agree').checked) throw new Error(T('Отметьте подтверждение отправки.'));
          await this.sendBatch(direct, sms);
        },
        T('Отправить'),
      );
    }
    async sendOffer(a) {
      if (!window.Ops?.api || !window.Ops.offerText) throw new Error(T('Модуль переписки не загружен. Обновите страницу.'));
      const day = C.ukDay(a.held_start),
        start = C.hm(C.ukMinute(a.held_start)),
        end = C.hm(C.ukMinute(a.held_end));
      const name = (this.driver.name || '').trim();
      /* Окно на весь рабочий день — предложение только с датой: окно прибытия уйдёт утром. */
      const dayOnly = C.isDaySpan(a.held_start, a.held_end);
      const body = dayOnly ? C.dayOfferText(a.collection_source, day, name) : Ops.offerText(a.collection_source, day, start, end, name);
      if (!body) throw new Error(T('Не удалось собрать текст предложения.'));
      const thread = await Ops.api(this.sb, 'create', { address_id: a.id });
      if (!thread?.thread_id) throw new Error(T('Не удалось открыть переписку по адресу.'));
      const payload = {
        thread_id: thread.thread_id,
        kind: 'offer',
        body,
        day,
        start,
        end,
        version: a.collection_version,
        template: dayOnly ? 'day-v1' : 'wrc-v1',
        expected_source: a.collection_source,
        expected_driver_name: name,
        request_id: crypto.randomUUID(),
      };
      Object.assign(
        payload,
        (await preflight(
          { ...this.o, address: a },
          { dispatch: true, driver_id: this.driver.id, address_id: a.id, day, start, end },
          payload,
        )) || {},
      );
      await Ops.api(this.sb, 'send', payload);
    }
    async sendBatch(direct, sms) {
      let routed = 0,
        sent = 0,
        halt = '';
      const failed = [],
        notes = [];
      // Один проход: сбойный адрес не останавливает остальные. Останавливаемся, только если
      // сломалось что-то общее (нет доступа, сервис молчит, лимит) или подряд упали три —
      // тогда дело почти наверняка не в адресах, и рассылать дальше нельзя.
      const run = async (list, title, step) => {
        let streak = 0;
        for (let i = 0; i < list.length; i++) {
          if (halt) return;
          const a = list[i];
          this.notice(`${title} · ${i + 1} ${T('из')} ${list.length}`);
          try {
            await step(a);
            streak = 0;
          } catch (e) {
            failed.push(esc(a.text) + ' — ' + esc(error(e)));
            if (batchFatal(e)) {
              halt = T('Остановился: ') + error(e) + T(' Это общий сбой, а не адрес — остальные не тронуты.');
              return;
            }
            if (++streak >= 3) {
              notes.push('«' + title + T('»: три подряд не прошли — дальше по этому списку не пошёл.'));
              return;
            }
          }
        }
      };
      await run(direct, T('Ставлю в маршрут'), async (a) => {
        await warm(this.o, C.ukDay(a.held_start), [a.id]);
        await this.call('confirm_partner', { address_id: a.id, agreed: true });
        routed++;
      });
      await run(sms, T('Отправляю SMS'), async (a) => {
        await this.sendOffer(a);
        sent++;
      });
      await this.reload();
      this.render();
      await this.o.onChanged?.();
      const parts = [];
      if (sent) parts.push(T('отправлено ') + sent);
      if (routed) parts.push(T('в маршрут ') + routed);
      if (failed.length) {
        this.notice((parts.join(', ') || T('ничего не отправлено')) + T(' · не прошло ') + failed.length, true);
        this.dialog(
          T('Что не прошло'),
          (parts.length ? `<p>${T('Успешно:')} ${esc(parts.join(', '))}.</p>` : '') +
            (halt ? `<p class="od-warning">${esc(halt)}</p>` : '') +
            notes.map((n) => `<p class="od-warning">${esc(n)}</p>`).join('') +
            `<p class="od-muted">${T('Не прошло')} ${failed.length}:</p><ul>${failed.map((f) => '<li>' + f + '</li>').join('')}</ul>` +
            `<p class="od-muted">${T('Время у этих заявок сохранилось. Исправьте причину и нажмите «Отправить предложения» ещё раз — уже отправленные повторно не уйдут.')}</p>`,
          null,
        );
      } else this.notice(parts.join(', ') + '.');
    }
    available(a) {
      return !a.hold_id && !['preparing', 'awaiting', 'manual'].includes(a.offer_state) && !a.date;
    }
    /* Похожие заявки в очередь не попадают вовсе: они собираются во вкладке
    «Повторы», где видно, с чем совпало, и можно открыть двойника. Решение
    «это не повтор» хранится в базе — колонка duplicate_ignored, — поэтому
    держится на любом компьютере. */
    parked(a) {
      return !!(this.dupExtras && this.dupExtras.has(a.id) && this.available(a));
    }
    queue() {
      const base = this.o.addresses?.() || [];
      const ok = new Set(
        this.requests
          .concat(base)
          .filter((a) => a && a.duplicate_ignored)
          .map((a) => a.id),
      );
      this.dupExtras = new Set([...C.duplicateExtras(this.requests, base)].filter((id) => !ok.has(id)));
      const dupCount = this.requests.filter((a) => this.parked(a)).length;
      const shown = this.requests.filter((a) => !this.parked(a)).slice(0, 500),
        ready = this.sendable();
      const free = this.requests.filter((a) => this.available(a) && !this.parked(a));
      /* Три блока, чтобы новые заявки не путались с теми, где время уже занято
     или клиенту уже написали. Порядок — по убыванию обязательств перед клиентом. */
      const groups = [
        {
          key: 'dead',
          title: T('Время прошло, ответа нет'),
          hint: T('Обещанный день уже позади, клиент так и не подтвердил. Подберите новое время и предложите ещё раз.'),
          rows: shown.filter((a) => C.offerExpired(a)),
        },
        {
          key: 'wait',
          title: T('Ждём ответ клиента'),
          hint: T(
            'Время обещано в SMS, срок ещё не вышел. Если написано «ответил не YES» или «предложение не ушло» — загляните в переписку.',
          ),
          rows: shown.filter((a) => a.offered_start && !C.offerExpired(a)),
        },
        {
          key: 'held',
          title: T('Время занято, не отправлено'),
          hint: T('Место в маршруте есть, клиент про него ещё не знает. Отсюда идёт «Отправить предложения».'),
          rows: shown.filter((a) => !a.offered_start && a.held_start),
        },
        {
          key: 'new',
          title: T('Новые заявки'),
          hint: T('Без времени. Отметьте и посчитайте план.'),
          rows: shown.filter((a) => !a.offered_start && !a.held_start),
        },
      ].filter((g) => g.rows.length);
      const groupHead = (g) =>
        groups.length < 2
          ? ''
          : `<tr><td colspan="7" style="background:var(--surface-3);padding:9px 10px;border-top:1px solid var(--line)"><b>${esc(g.title)} · ${g.rows.length}</b> <span class="od-muted" style="font-weight:400">— ${esc(g.hint)}</span></td></tr>`;

      const zcfg = { zones: this.zones || [] };
      /* Отправленное проверяем ПЕРВЫМ. Раньше первым шло удержанное время, и у заявки,
     где есть и то и другое, факт отправки прятался за зелёным временем — выглядело так,
     будто клиенту ещё ничего не обещали. */
      /* Раньше любая заявка с отправленным временем подписывалась «Ждём ответ»,
     даже если клиент уже ответил не то или письмо вообще не ушло. Теперь пишем,
     что происходит на самом деле, и отдельно — что срок вышел. */
      const when = (a) =>
        C.isDaySpan(a.offered_start, a.offered_end)
          ? label(C.ukDay(a.offered_start)) + T(', в течение дня')
          : label(C.ukDay(a.offered_start)) +
            ', ' +
            C.hm(C.ukMinute(a.offered_start)) +
            (a.offered_end && a.offered_end !== a.offered_start ? '–' + C.hm(C.ukMinute(a.offered_end)) : '');
      const ap = this.autoPlan || {};
      /* Автопредложение: дата ушла сама, ответ ждём до срока закрытия. После срока или
         когда день наступил без YES — сервер закрывает заявку сам (SMS о закрытии). */
      const closesAt = (a) =>
        a.offer_first_at && ap.close_hours ? new Date(Date.parse(a.offer_first_at) + ap.close_hours * 3600e3) : null;
      const closeText = (a) => {
        const c = closesAt(a);
        if (!c) return '';
        const left = Math.round((c - Date.now()) / 3600e3);
        return left > 0 ? ` ${T('· закроется через')} ${left} ${T('ч')}` : T(' · закрывается');
      };
      const state = (a) => {
        if (a.offered_start) {
          const dead = C.offerExpired(a),
            tail = dead ? T(' · срок вышел') : '',
            auto = a.offer_auto ? T('Дата предложена автоматически') : T('Ждём ответ'),
            reminded = a.reminded_at ? T(' · напоминание было') : '';
          if (a.offer_state === 'manual')
            return `<span class="od-chip" style="background:var(--warn-soft);color:var(--warn)">${T('Ответил не YES ·')} ${esc(when(a))}${tail}</span>`;
          if (a.offer_state === 'preparing')
            return `<span class="od-chip" style="background:var(--warn-soft);color:var(--warn)">${T('Предложение не ушло ·')} ${esc(when(a))}${tail}</span>`;
          if (dead)
            return `<span class="od-chip" style="background:var(--crit-soft);color:var(--crit)">${T('Время прошло ·')} ${esc(when(a))}</span>`;
          return `<span class="od-chip" style="background:var(--far-soft);color:var(--far)">${auto} · ${esc(when(a))}${reminded}${a.offer_auto ? esc(closeText(a)) : ''}</span>`;
        }
        if (a.held_start)
          return `<span class="od-slot">${C.isDaySpan(a.held_start, a.held_end) ? T('День занят') : T('Время занято')} · ${esc(this.slotText(a))} ${T('· не отправлено')}</span>`;
        if (a.date) return `<span class="od-chip">${T('В маршруте')}</span>`;
        if (a.offer_attempts > 0)
          return `<span class="od-chip" style="background:var(--crit-soft);color:var(--crit)">${T('Дата предлагалась, ответа нет')}${esc(closeText(a))}</span>`;
        const z = C.zoneRule(zcfg, a.text);
        if (!z)
          return C.postcodeArea(a.text)
            ? `<span class="od-chip" style="background:var(--crit-soft);color:var(--crit)">${T('Район')} ${esc(C.postcodeArea(a.text))} ${T('не настроен')}</span>`
            : `<span class="od-chip" style="background:var(--crit-soft);color:var(--crit)">${T('Неполный почтовый индекс')}</span>`;
        if (z.mode === 'off') return `<span class="od-chip">${T('Район «')}${esc(z.name)}${T('» выключен')}</span>`;
        if (z.mode === 'monthly') {
          const d = C.nextTripDays(z, C.ukDay(), 1)[0];
          return `<span class="od-chip" style="background:var(--far-soft);color:var(--far)">${esc(z.name)} ${T('· выезд')} ${d ? label(d) : T('не задан')}</span>`;
        }
        return `<span class="od-muted">${T('Ждёт распределения')}</span>${a.auto_skip ? `<br><span class="od-muted" style="font-size:11.5px">${esc(skipText(a.auto_skip))}</span>` : ''}`;
      };
      const acts = (a) => {
        const b = [];
        if (a.hold_id && ['partner_whatsapp', 'missing'].includes(C.sourceOf(a)))
          b.push(`<button data-action="partner" data-id="${a.id}">${T('Согласовать')}</button>`);
        else if (a.hold_id || a.offer_state || a.date) b.push(`<button data-action="sms" data-id="${a.id}">SMS</button>`);
        if (a.hold_id && !['preparing', 'awaiting', 'manual'].includes(a.offer_state))
          b.push(`<button data-action="release" data-id="${a.id}">${T('Снять')}</button>`);
        if (C.offerExpired(a)) b.push(`<button data-action="renew" data-id="${a.id}">${T('Предложить новое время')}</button>`);
        else if (a.offer_state === 'awaiting' && a.offered_start && !(a.offer_auto && !a.reminded_at && ap.enabled))
          b.push(`<button data-action="remind" data-id="${a.id}">${T('Напомнить')}</button>`);
        else if (C.offerLive(a) && a.offered_start)
          b.push(`<button data-action="renew" data-id="${a.id}">${T('Предложить новое время')}</button>`);
        if (this.available(a)) b.push(`<button data-action="edit" data-id="${a.id}">${T('Изменить')}</button>`);
        if (!['preparing', 'awaiting', 'manual'].includes(a.offer_state))
          b.push(`<button data-action="move" data-id="${a.id}">${T('Перенести')}</button>`);
        /* «Закрыть» — для заявок, которым ещё ничего не обещали: ни живого предложения,
           ни удержания, ни даты. У остальных сначала «Снять» или «Переписка → Закрыть заявку»,
           иначе в дне останется удержание без заявки. */
        if (!a.hold_id && !a.date && !['preparing', 'awaiting', 'manual'].includes(a.offer_state))
          b.push(`<button data-action="close" data-id="${a.id}">${T('Закрыть')}</button>`);
        b.push(`<button data-action="drop" data-id="${a.id}">${T('Убрать')}</button>`);
        return b.join('');
      };
      const autoLine = ap.enabled
        ? `<p class="od-slot" style="margin-top:8px">${T('Автоподбор включён: новые заявки с мобильным сами получают дату (не раньше чем через 2 дня, до')} ${esc(String(ap.day_capacity || 40))} ${T('адресов в день); YES подтверждает, утром при старте уходит окно прибытия.')}${ap.last_run_at ? ` ${T('Последний проход')} ${esc(C.hm(C.ukMinute(ap.last_run_at)))}${ap.last_run_note ? ' — ' + esc(ap.last_run_note) : ''}.` : ''} ${T('Без мобильного, повторы и WhatsApp — решаете вручную ниже.')}</p>`
        : `<p class="od-muted" style="margin-top:8px">${T('Автоподбор выключен — даты назначаются вручную (кнопка «Распределить по дням»). Включается в «Параметры».')}</p>`;
      return `<div class="od-intro od-between"><div><h3>${T('Заявки без даты ·')} ${this.requests.length}</h3><p>${T('Отметьте адреса — приложение подберёт день и время, заполняя уже начатые дни вплотную к соседним адресам.')}</p>${autoLine}</div><div class="od-actions"><button data-action="sendall" ${ready.total ? '' : 'disabled data-locked="true"'}>${T('Отправить предложения')}${ready.total ? ' · ' + ready.total : ''}</button>${ready.direct.length ? `<button data-action="copypartner">${T('Текст для WhatsApp ·')} ${ready.direct.length}</button>` : ''}<button data-action="schedule">${T('Разбор по категориям')}</button>${ap.enabled ? `<button data-action="autorun">${T('Прогнать автоподбор сейчас')}</button>` : ''}<button data-action="refresh">${T('Обновить')}</button></div></div>
  <details><summary>${T('Искать места с')} ${label(this.from)}${T(', на')} ${this.days} ${T('дней вперёд')}</summary><div class="od-grid"><label>${T('Начиная с')}<input id="od-from" type="date" min="${C.ukDay()}" value="${this.from}"></label><label>${T('Горизонт')}<select id="od-days">${[7, 14, 21, 30, 45, 60].map((n) => `<option value="${n}" ${this.days === n ? 'selected' : ''}>${n} ${T('дней')}</option>`).join('')}</select></label></div></details>
  ${this.requests.length > 500 ? `<p class="od-warning">${T('Показаны первые 500 заявок. Распределите их, затем обновите очередь.')}</p>` : ''}
  ${dupCount ? `<p class="od-warning">${T('Похоже на повтор:')} ${dupCount}${T('. В очередь они не попали — откройте вкладку «Повторы» слева.')}</p>` : ''}
  ${
    shown.length
      ? `<div class="od-selection od-between"><label class="od-select"><input type="checkbox" id="od-all" ${free.length && free.slice(0, 40).every((a) => this.selected.has(a.id)) ? 'checked' : ''}> ${T('Выбрать первые 40 свободных')}</label><b id="od-count">${T('Выбрано:')} ${this.selected.size}</b></div>
  <div class="tscroll"><table class="t"><thead><tr><th style="width:34px"></th><th>${T('Адрес')}</th><th>${T('Источник')}</th><th>${T('Мешки')}</th><th>${T('Телефон')}</th><th>${T('Состояние')}</th><th></th></tr></thead><tbody>${groups.map((g) => groupHead(g) + g.rows.map((a) => `<tr class="${this.selected.has(a.id) ? 'sel' : ''}" data-request="${esc(a.id)}"><td><input type="checkbox" data-select="${esc(a.id)}" ${this.selected.has(a.id) ? 'checked' : ''} ${this.available(a) ? '' : 'disabled data-locked="true"'} aria-label="${T('Выбрать заявку')}"></td><td class="addr"><b>${esc(a.text)}</b>${a.not_before ? `<small>${T('доступен с')} ${esc(label(a.not_before))}</small>` : ''}${C.validPoint(a) ? '' : `<span class="warnrow">${T('координаты определим перед расчётом')}</span>`}</td><td><span class="od-chip">${esc(C.sourceNames[C.sourceOf(a)])}</span>${a.charity ? `<br><span class="od-muted" style="font-size:11.5px">${esc(a.charity)}</span>` : ''}</td><td style="white-space:nowrap">${esc(a.bags_text || a.bags || '—')}</td><td class="mono" style="font-size:12.3px">${/^\+447\d{9}$/.test(C.phone(a.phone || '')) ? esc(a.phone) : `<span style="color:var(--crit)">${esc(a.phone || T('нет телефона'))}</span>${a.contact_email ? `<br><span class="od-muted" style="font-size:11.5px">${esc(a.contact_email)}</span>` : ''}<br><span class="od-muted" style="font-size:11.5px">${T('SMS не уйдёт')}</span>`}</td><td class="od-state">${state(a)}</td><td class="od-actions">${acts(a)}</td></tr>`).join('')).join('')}</tbody></table></div>`
      : `<div class="od-empty">${T('Очередь пуста. Добавьте один адрес или вставьте список из письма.')}</div>`
  }
  ${this.legacy.length ? `<h3 style="margin-top:20px">${T('Ранее переданные партнёрам')}</h3>${this.legacy.map((p) => `<article class="od-card od-between"><div><strong>${esc(p.address)}</strong><p class="od-muted">${label(C.ukDay(p.starts_at))} · ${C.hm(C.ukMinute(p.starts_at))}</p></div><button data-action="legacy" data-id="${p.id}">${T('Партнёр подтвердил')}</button></article>`).join('')}` : ''}
  <div class="od-footer"><label class="od-select" style="flex:1"><input type="checkbox" id="od-exact" ${this.dayMode === false ? 'checked' : ''}> ${T('Обещать точное время (интервал 30 минут)')}<br><span class="od-muted">${this.dayMode === false ? T('Клиенту уйдёт получасовое окно. В день помещается меньше адресов.') : T('Клиенту уйдёт только дата. Окно прибытия он получит утром, когда водитель начнёт маршрут.')}</span></label><button class="od-primary" data-action="calculate">${T('Распределить по дням')}</button></div>`;
    }
    planView() {
      const m = this.plan.metrics,
        mm = (v) => (v >= 60 ? Math.floor(v / 60) + T(' ч ') + (v % 60 ? (v % 60) + T(' мин') : '') : v + T(' мин'));
      const days = this.plan.days.filter((d) => d.nodes.length),
        zcfg = this.planConfig || { zones: this.zones || [] };
      return `<div class="od-intro"><h3>${T('Предложенный план')}</h3><p>${T('Подтверждённые сборы не сдвигаются. При сохранении новые интервалы займут место до ответа клиента.')}</p>${m ? `<div class="daystats" style="margin-top:12px"><div><div class="k">${T('Распределено')}</div><div class="v">${m.assigned} <small>${T('из')} ${m.assigned + m.unassigned}</small></div></div><div><div class="k">${T('Дней занято')}</div><div class="v">${m.days_used}</div></div><div><div class="k">${T('Дорога с запасом')}</div><div class="v">${mm(m.drive)}</div></div><div><div class="k">${T('Простой в днях')}</div><div class="v">${mm(m.wait)}</div></div><div><div class="k">${T('Общий интервал')}</div><div class="v">${m.shared || 0} <small>${T('соседних')}</small></div></div>${m.late ? `<div><div class="k">${T('Позже 7 дней')}</div><div class="v" style="color:var(--warn)">${m.late}</div></div>` : ''}</div>` : ''}</div>
  ${days
    .map((d) => {
      const trip = C.tripZoneOf(zcfg, d.day) || C.occupiedZoneOf(zcfg, d);
      return `<article class="od-card"><div class="od-between"><h3>${label(d.day)}${trip ? ` <span class="od-chip" style="background:var(--far-soft);color:var(--far)">${T('выезд ·')} ${esc(trip.name)}</span>` : ''}</h3><b>${d.started_at ? T('Маршрут начат') : d.fit.ok ? d.fit.stops.length + T(' остановок') + ((added) => (added ? ' (+' + added + T(' новых)') : ''))(this.plan.assigned.filter((a) => a.day === d.day).length) + T(' · выезд ') + C.hm(d.fit.departure) + T(', склад ') + C.hm(d.fit.finish) : T('Требует внимания')}</b></div>${
        d.fit.ok
          ? `<p class="od-muted">${T('Дорога с запасом')} ${d.fit.drive} ${T('мин · сборы')} ${d.fit.service} ${T('мин · простой')} ${d.fit.wait ?? 0} ${T('мин')}</p><ol class="od-stops">${d.fit.stops
              .map((stop, si) => {
                const n = d.nodes.find((n) => n.key === stop.key),
                  fresh = this.plan.assigned.some((a) => a.address_id === stop.address_id);
                const p = si ? d.nodes.find((x) => x.key === d.fit.stops[si - 1].key) : null,
                  together = p && String(slotOf(p)) === String(slotOf(n));
                return `<li><div><strong>${esc(stop.text)}</strong><small>${fresh ? `<span class="od-slot">${T('Новая заявка')}</span> · ` : n.kind === 'confirmed' ? T('Подтверждено · ') : T('Ожидаем ответ · ')}${arrivalLabel(n)}${together ? ` · <span class="od-slot">${T('вместе с предыдущим')}</span>` : ''}${stop.wait ? T(' · простой ') + stop.wait + T(' мин') : ''}</small></div><div class="od-stop-act"><b>≈ ${C.hm(stop.arrival)}</b><button data-action="replan" data-id="${esc(stop.address_id || '')}" data-key="${esc(stop.key)}" data-day="${esc(d.day)}">${T('Перенести')}</button></div></li>`;
              })
              .join('')}</ol>`
          : `<p class="od-warning">${esc(error({ code: d.fit.code, detail: d.fit }))}</p>`
      }</article>`;
    })
    .join('')}
  ${this.plan.unassigned.length ? `<article class="od-card"><h3>${T('Останутся в очереди ·')} ${this.plan.unassigned.length}</h3>${this.plan.unassigned.map((a) => `<p><b>${esc(this.requests.find((r) => r.id === a.address_id)?.text || '')}</b><br><span class="od-muted">${esc(a.reason)}</span></p>`).join('')}</article>` : ''}
  <div class="od-footer"><button data-action="queue">${T('Вернуться к заявкам')}</button><button class="od-primary" data-action="reserve" ${this.plan.assigned.length ? '' : 'disabled data-locked="true"'}>${T('Сохранить предложения ·')} ${this.plan.assigned.length}</button></div>`;
    }
    settings() {
      const c = {
        capacity_kg: 1500,
        travel_factor: 1.2,
        leg_buffer_minutes: 5,
        zone_penalty_minutes: 12,
        day_penalty_minutes: 2,
        home: this.o.home || {},
        depot: this.o.depot || {},
        ...this.config,
        reserve_kg: 0,
        reserve_minutes: 0,
      };
      const pt = (k, title, hint) => {
        const p = c[k] || {},
          ok = C.validPoint(p);
        return `<fieldset data-point="${k}"><legend>${title}</legend><label>${T('Адрес или почтовый индекс')}<input data-field="text" value="${esc(p.text || '')}" placeholder="${hint}"></label><input type="hidden" data-field="lat" data-num value="${p.lat ?? ''}"><input type="hidden" data-field="lng" data-num value="${p.lng ?? ''}"><div class="od-actions" style="margin-top:10px">${ok ? `<span class="od-chip">${T('✓ точка найдена')}</span><a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}" target="_blank" rel="noopener">${T('Проверить на карте')}</a>` : `<span class="od-muted">${T('Координаты найдутся автоматически при сохранении')}</span>`}</div></fieldset>`;
      };
      return `<div class="od-intro"><h3>${T('Старт и склад')}</h3><p>${T('Откуда водитель выезжает утром и куда возвращается вечером. Часы прибытия к клиентам задаются в разделе «Часы и доступ».')}</p></div>
  ${pt('home', T('Старт маршрута'), T('Например: NP13 1DF'))}${pt('depot', T('Склад — конец маршрута'), T('Например: CF43 4SX'))}
  <div id="od-config" hidden>${['capacity_kg', 'reserve_kg', 'reserve_minutes', 'travel_factor', 'leg_buffer_minutes', 'zone_penalty_minutes', 'day_penalty_minutes'].map((k) => `<input type="hidden" data-field="${k}" data-num value="${c[k]}">`).join('')}</div>
  <p class="od-muted">${T('Ограничений по весу и свободному времени нет: день заполняется полностью, пока успевают дорога, сборы и рабочие часы. К расчётному времени в пути добавляется 20% и 5 минут на каждый переезд.')}</p>
  <div class="od-actions"><button class="od-primary" data-action="save-settings">${T('Сохранить')}</button><button data-action="health">${T('Проверить сервис дорог')}</button></div>
  ${this.autoPlanSettings()}`;
    }
    /* Автопланировщик: сервер сам назначает дату новым заявкам и шлёт SMS.
       Включается здесь; всё остальное — разумные значения по умолчанию. */
    autoPlanSettings() {
      const c = this.autoCfg;
      if (!c) return '';
      const num = (k, title, hint, min, max) =>
        `<label>${title}<input data-auto="${k}" type="number" min="${min}" max="${max}" value="${esc(String(c[k] ?? ''))}"><small class="od-muted">${hint}</small></label>`;
      const smsOff = this.autoInfo && this.autoInfo.auto_sms_enabled === false;
      return `<div class="od-intro" style="margin-top:28px"><h3>${T('Автопланировщик')}</h3><p>${T('Новая заявка с британским мобильным сама получает дату: SMS «We can collect on Tue 23 Sep. Reply YES». После YES — подтверждено. Утром, когда водитель нажимает «Начать маршрут», каждому уходит окно прибытия. Нет ответа — напоминание, затем заявка закрывается с SMS. Заявки без мобильного, повторы и WhatsApp остаются в очереди на ручное решение.')}</p></div>
  ${smsOff ? `<p class="od-warning">${T('Авто-SMS выключены (раздел «Переписка → Авто-SMS») — автопланировщик не сможет отправлять даты.')}</p>` : ''}
  <label class="od-select" style="margin:6px 0 12px"><input type="checkbox" data-auto="enabled" ${c.enabled ? 'checked' : ''}> <b>${T('Автоподбор включён')}</b></label>
  <div class="od-grid">
  ${num('day_capacity', T('Адресов в день, не больше'), T('Дальше день считается полным'), 1, 120)}
  ${num('lead_days', T('Дата не раньше чем через, дней'), T('Чтобы напоминание успело до дня сбора'), 1, 7)}
  ${num('horizon_days', T('Горизонт, дней'), T('Как далеко вперёд искать день'), 2, 30)}
  ${num('near_km', T('Рядом — это, км'), T('Сначала день, где уже есть адрес не дальше'), 0, 50)}
  ${num('reminder_hours', T('Напоминание через, часов'), T('Если нет ответа'), 1, 96)}
  ${num('close_hours', T('Закрыть заявку через, часов'), T('От первого предложения, если нет ответа'), 2, 240)}
  ${num('eta_window_minutes', T('Окно прибытия, минут'), T('В утренней SMS'), 30, 180)}
  ${num('sms_from_hour', T('SMS с датой не раньше, час'), T('По UK времени'), 6, 12)}
  ${num('sms_to_hour', T('SMS с датой не позже, час'), T('По UK времени'), 13, 21)}
  </div>
  <p class="od-muted">${c.last_run_at ? `${T('Последний проход:')} ${esc(label(C.ukDay(c.last_run_at)))} ${esc(C.hm(C.ukMinute(c.last_run_at)))} — ${esc(c.last_run_note || '')}` : T('Ещё не запускался.')}${this.autoInfo?.queue_geocoding ? ` ${T('· ищем координаты:')} ${esc(String(this.autoInfo.queue_geocoding))}` : ''}</p>
  <div class="od-actions"><button class="od-primary" data-action="save-auto">${T('Сохранить автопланировщик')}</button><button data-action="autorun">${T('Прогнать сейчас')}</button></div>`;
    }
    bind() {
      this.$('#od-paste')?.addEventListener('paste', (e) => {
        this.pasteHtml = e.clipboardData?.getData('text/html') || '';
      });
      this.$('#od-paste')?.addEventListener('input', (e) => {
        if (e.inputType !== 'insertFromPaste') this.pasteHtml = '';
      });
      this.$('#od-source')?.addEventListener('change', (e) => (this.source = e.target.value));
      this.$('#od-from')?.addEventListener('change', (e) => (this.from = e.target.value));
      this.$('#od-days')?.addEventListener('change', (e) => (this.days = +e.target.value));
      this.root.querySelectorAll('[data-select]').forEach(
        (el) =>
          (el.onchange = () => {
            if (el.checked && this.selected.size >= 40) {
              el.checked = false;
              this.notice(errors.BATCH_LIMIT_40, true);
              return;
            }
            el.checked ? this.selected.add(el.dataset.select) : this.selected.delete(el.dataset.select);
            this.$('#od-count').textContent = T('Выбрано: ') + this.selected.size;
          }),
      );
      this.$('#od-exact')?.addEventListener('change', (e) => {
        /* Основной режим — день. Точное время включается осознанно и только для этого расчёта. */
        this.dayMode = !e.target.checked;
        this.render();
      });
      this.$('#od-all')?.addEventListener('change', (e) => {
        this.selected = new Set(
          e.target.checked
            ? this.requests
                .filter((a) => this.available(a) && !this.parked(a))
                .slice(0, 40)
                .map((a) => a.id)
            : [],
        );
        this.render();
      });
      this.root.querySelectorAll('[data-row] [data-field]').forEach(
        (el) =>
          (el.onchange = () => {
            this.syncRows();
            this.updateIssues();
          }),
      );
    }
    fields(parent) {
      return Object.fromEntries(
        [...parent.querySelectorAll('[data-field]')].map((el) => [
          el.dataset.field,
          el.type === 'number' || el.dataset.num !== undefined || el.dataset.field === 'service_minutes' ? Number(el.value) : el.value,
        ]),
      );
    }
    syncRows() {
      this.root.querySelectorAll('[data-row]').forEach((box) => Object.assign(this.rows[+box.dataset.row], this.fields(box)));
    }
    updateIssues() {
      this.root.querySelectorAll('[data-row]').forEach((box) => {
        const i = +box.dataset.row,
          issues = C.issues(this.rows[i], this.o.addresses?.() || this.requests, this.rows.slice(0, i));
        box.classList.toggle('od-invalid', issues.length > 0);
        box.querySelector('.od-row-issues').textContent = issues.join(' · ');
      });
    }
    async locate(text) {
      const pc = C.postcode(text);
      if (!pc) throw new Error(T('Нужен полный postcode.'));
      const r = await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(pc), { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (!r.ok || !j.result) throw new Error(T('Индекс не найден. Проверьте адрес или введите координаты вручную.'));
      return { lat: j.result.latitude, lng: j.result.longitude, geocode_source: 'postcode' };
    }
    async calculate() {
      online(this.o);
      if (!this.selected.size) throw new Error(T('Выберите хотя бы одну свободную заявку.'));
      if (!C.validPoint(this.config.home) || !C.validPoint(this.config.depot)) {
        this.mode = 'settings';
        this.render();
        throw new Error('SETTINGS_REQUIRED');
      }
      const ids = [...this.selected];
      for (const id of ids) {
        const a = this.requests.find((r) => r.id === id);
        /* Раньше любая занятая заявка роняла весь расчёт кодом REQUEST_RESERVED, и было
     непонятно, какая именно из сорока и почему. Теперь называем адрес и причину. */
        if (!this.available(a))
          throw new Error(
            `${a ? a.text : T('Заявка')} — ${a && a.offer_state === 'manual' ? T('идёт ручное согласование в переписке: клиент ответил не YES. Снимите её из выбора, а время предложите кнопкой «Предложить новое время».') : a && a.offer_state ? T('клиенту уже отправлено предложение. Снимите её из выбора или дождитесь ответа.') : a && a.date ? T('уже стоит в маршруте.') : T('время уже занято.')}`,
          );
        if (!C.validPoint(a)) {
          this.notice(T('Определяю координаты: ') + a.text);
          const p = await this.locate(a.text);
          await this.call('edit_request', { address_id: a.id, ...p });
          Object.assign(a, p);
        }
      }
      /* Горизонт расчёта тянем до ближайшего выезда в дальнюю зону. Иначе адреса из
         месячных зон просто оставались в очереди: их день выезда был за пределами окна,
         а подпись «заявка ждёт этого дня» создавала впечатление, что кто-то её подхватит. */
      let days = this.days;
      const zoneCfg = { ...this.config, zones: this.zones || [] };
      for (const id of ids) {
        const a = this.requests.find((r) => r.id === id);
        const rule = a && C.zoneRule(zoneCfg, a.text);
        if (!rule || rule.mode !== 'monthly') continue;
        const trip = C.nextTripDays(rule, this.from, 1)[0];
        if (!trip) continue;
        const span = Math.round((Date.parse(trip + 'T12:00:00Z') - Date.parse(this.from + 'T12:00:00Z')) / 864e5) + 1;
        if (span > days) days = Math.min(span, 120);
      }
      if (days > this.days)
        this.notice(`${T('Горизонт расширен до')} ${days} ${T('дней: в выборке есть адреса из зоны с выездом раз в месяц.')}`);
      let snap = await this.call('snapshot', { from_day: this.from, days, address_ids: ids });
      let roads = {};
      const skipped = [];
      /* Дорога считается по дням параллельно, по четыре за раз: раньше 14 дней шли
         по очереди и расчёт занимал минуту; сервису дорог четыре запроса не мешают. */
      const openDays = snap.days.filter((d) => !d.started_at && !d.hours?.closed);
      let done = 0;
      for (let i = 0; i < openDays.length; i += 4) {
        await Promise.all(
          openDays.slice(i, i + 4).map(async (d) => {
            try {
              Object.assign(roads, (await warm(this.o, d.day, ids)).roads);
            } catch (e) {
              skipped.push({ day: d.day, error: error(e) });
            }
            this.notice(`${T('Рассчитываю дорогу ·')} ${++done}/${openDays.length}`);
          }),
        );
      }
      snap = await this.call('snapshot', { from_day: this.from, days, address_ids: ids });
      this.tokens = Object.fromEntries(snap.days.map((d) => [d.day, d.token]));
      this.notice(T('Распределяю заявки вокруг договорённостей…'));
      this.planRoads = roads;
      this.planRequests = snap.requests;
      this.planConfig = { ...snap.config, zones: this.zones || [] };
      this.plan = await C.planBatch(
        snap.days,
        snap.requests,
        this.planConfig,
        roads,
        (n, total) => this.notice(`${T('Подобрано')} ${n} ${T('из')} ${total}`),
        this.dayMode !== false,
      );
      this.reserveId = crypto.randomUUID();
      this.mode = 'plan';
      this.render();
      this.notice(
        skipped.length
          ? T('Некоторые дни не рассчитаны: ') + skipped.map((d) => label(d.day) + ' — ' + d.error).join(' ')
          : this.plan.assigned.length
            ? T('Проверьте порядок и время перед сохранением.')
            : /* Раньше здесь была одна фраза на все случаи, и она советовала менять горизонт,
                 даже когда дело было в другом. Теперь показываем настоящую причину из расчёта. */
              this.planReason(),
        !!skipped.length,
      );
    }
    /* Причина, по которой не встала ни одна заявка. Расчёт (ops-dispatch-core) пишет свою
       причину каждому адресу; берём самую частую, чтобы в шапке была правда, а не совет
       «измените горизонт», который помогает далеко не всегда. */
    planReason() {
      const list = (this.plan && this.plan.unassigned) || [];
      if (!list.length) return T('Подходящих мест пока нет. Измените горизонт поиска или проверьте проблемные дни.');
      const count = new Map();
      for (const u of list) {
        const r = (u.reason || '').trim();
        if (r) count.set(r, (count.get(r) || 0) + 1);
      }
      if (!count.size) return T('Подходящих мест пока нет. Измените горизонт поиска или проверьте проблемные дни.');
      const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
      return count.size > 1 ? `${top[0]} ${T('Другие причины — в карточке «Останутся в очереди» внизу.')}` : top[0];
    }
    dialog(title, body, onSave, saveLabel = T('Сохранить')) {
      this.$('.od-dialog')?.remove();
      const wrap = document.createElement('div');
      wrap.className = 'od-dialog';
      wrap.innerHTML = `<section role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${body}<p class="od-dialog-error" role="alert"></p><div class="od-actions"><button class="od-dialog-cancel">${T('Закрыть')}</button>${onSave ? `<button class="od-dialog-save od-primary">${saveLabel}</button>` : ''}</div></section>`;
      this.root.append(wrap);
      wrap.querySelector('.od-dialog-cancel').onclick = () => {
        if (!this.modalBusy) wrap.remove();
      };
      if (onSave)
        wrap.querySelector('.od-dialog-save').onclick = async () => {
          const btn = wrap.querySelector('.od-dialog-save');
          if (this.modalBusy) return;
          this.modalBusy = true;
          btn.disabled = true;
          try {
            await onSave(wrap);
            wrap.remove();
          } catch (e) {
            wrap.querySelector('.od-dialog-error').textContent = error(e);
            btn.disabled = false;
          } finally {
            this.modalBusy = false;
          }
        };
      wrap.querySelector('input,textarea,button')?.focus();
      return wrap;
    }
    /* Дружелюбное сообщение клиенту о смене времени. Английский, как все письма клиентам. */
    /* Напоминание тому, кто не ответил на предложение. Время НЕ пересчитывается:
    повторяем ровно то, что уже обещали, иначе человек получит два разных
    интервала и перестанет понимать, когда его ждать. */
    remindText(a) {
      return reminderMessage(a, this.driver.name);
    }
    remind(a) {
      if (!a.offered_start) {
        this.notice(T('Этому адресу предложение не отправлялось.'), true);
        return;
      }
      const text = this.remindText(a);
      this.dialog(
        T('Напомнить о сборе'),
        `<p><b>${esc(a.text)}</b></p>` +
          `<p class="od-muted">${T('Предложение ушло на')} ${esc(C.isDaySpan(a.offered_start, a.offered_end) ? label(C.ukDay(a.offered_start)) + T(' (в течение дня)') : label(C.ukDay(a.offered_start)) + ', ' + C.hm(C.ukMinute(a.offered_start)) + '–' + C.hm(C.ukMinute(a.offered_end || a.offered_start)))}${T(', ответа нет. Время не меняется — повторяем то же самое.')}</p>` +
          `<textarea id="od-rm-text" rows="9">${esc(text)}</textarea>` +
          `<label><input id="od-rm-send" type="checkbox" checked>${T('Отправить клиенту это сообщение.')}</label>`,
        async (w) => {
          if (!w.querySelector('#od-rm-send').checked) throw new Error(T('Отметьте отправку или закройте окно.'));
          online(this.o);
          if (!window.Ops?.api) throw new Error(T('Модуль переписки не загружен.'));
          const thread = await Ops.api(this.sb, 'create', { address_id: a.id });
          if (!thread?.thread_id) throw new Error(T('Не удалось открыть переписку.'));
          await Ops.api(this.sb, 'send', {
            thread_id: thread.thread_id,
            kind: 'reply',
            body: w.querySelector('#od-rm-text').value,
            request_id: crypto.randomUUID(),
          });
          await this.reload();
          this.render();
          this.notice(T('Напоминание отправлено.'));
          await this.o.onChanged?.();
        },
        T('Отправить напоминание'),
      );
    }
    /* Предложенный день прошёл, клиент не ответил. Повторять мёртвое время
    бессмысленно: подбираем новое по маршруту и шлём обычное предложение —
    то самое, на которое отвечают YES. Текст предложения задаёт шаблон,
    его проверяет сервер, поэтому мы его не сочиняем. */
    renew(a) {
      if (!a.offered_start) {
        this.notice(T('Этому адресу предложение не отправлялось.'), true);
        return;
      }
      const tomorrow = C.ukDay(new Date(Date.now() + 86400000));
      const src = a.collection_source === 'subnex' ? 'subnex' : 'partner';
      const templated = ['subnex', 'partner', 'missing'].includes(a.collection_source);
      let slots = [];
      const w = this.dialog(
        T('Предложить новое время'),
        `<p><b>${esc(a.text)}</b></p>` +
          `<p class="od-muted">${T('Обещали')} ${label(C.ukDay(a.offered_start))}, ${C.hm(C.ukMinute(a.offered_start))}–${C.hm(C.ukMinute(a.offered_end || a.offered_start))}${T('. Ответа не было, день прошёл.')}</p>` +
          `<div class="od-grid"><label>${T('Новая дата')}<input id="od-nw-day" type="date" min="${C.ukDay()}" value="${esc(tomorrow)}"></label>` +
          `<label>${T('Время')}<select id="od-nw-time"><option value="">${T('Считаю…')}</option></select></label></div>` +
          `<p class="od-muted" id="od-nw-note">${T('Подбираю по маршруту этого дня — первым идёт самое выгодное по дороге.')}</p>` +
          `<textarea id="od-nw-text" rows="9" readonly></textarea>` +
          `<label><input id="od-nw-send" type="checkbox" checked>${T('Отправить клиенту это предложение.')}</label>`,
        async (wrap) => {
          const day = wrap.querySelector('#od-nw-day').value,
            slot = slots[+wrap.querySelector('#od-nw-time').value];
          if (!day || !slot) throw new Error(T('Выберите дату и свободное время.'));
          if (!wrap.querySelector('#od-nw-send').checked) throw new Error(T('Отметьте отправку или закройте окно.'));
          online(this.o);
          if (!window.Ops?.api) throw new Error(T('Модуль переписки не загружен.'));
          try {
            await warm(this.o, day, [a.id]);
          } catch (e) {}
          const thread = await Ops.api(this.sb, 'create', { address_id: a.id });
          if (!thread?.thread_id) throw new Error(T('Не удалось открыть переписку.'));
          const payload = {
            thread_id: thread.thread_id,
            kind: 'offer',
            day,
            start: slot.start,
            end: slot.end,
            version: a.collection_version,
            body: wrap.querySelector('#od-nw-text').value,
            request_id: crypto.randomUUID(),
          };
          if (templated)
            Object.assign(payload, {
              template: 'wrc-v1',
              expected_source: a.collection_source,
              expected_driver_name: (this.driver.name || '').trim(),
            });
          await Ops.api(this.sb, 'send', payload);
          await this.reload();
          this.render();
          this.notice(`${T('Новое время предложено:')} ${label(day)}, ${slot.start}–${slot.end}${T('. Ждём YES.')}`);
          await this.o.onChanged?.();
        },
        T('Отправить предложение'),
      );
      const text = () => {
        const box = w.querySelector('#od-nw-text'),
          slot = slots[+w.querySelector('#od-nw-time').value];
        const day = w.querySelector('#od-nw-day').value;
        box.value = slot
          ? templated && window.Ops?.offerText
            ? Ops.offerText(src, day, slot.start, slot.end, this.driver.name || '')
            : renewMessage(a, this.driver.name, day, slot.start, slot.end)
          : '';
      };
      const load = async () => {
        const day = w.querySelector('#od-nw-day').value,
          sel = w.querySelector('#od-nw-time'),
          note = w.querySelector('#od-nw-note');
        slots = [];
        sel.innerHTML = `<option value="">${T('Считаю…')}</option>`;
        note.textContent = T('Считаю дорогу на этот день…');
        text();
        try {
          if (!day) throw new Error(T('Укажите дату.'));
          let roads = {};
          try {
            roads = (await warm(this.o, day, [a.id])).roads || {};
          } catch (e) {}
          const snap = await this.call('snapshot', { from_day: day, days: 1, address_ids: [a.id] });
          const node = {
            key: 'nw:' + a.id,
            address_id: a.id,
            text: a.text,
            lat: a.lat,
            lng: a.lng,
            service: a.service_minutes || C.PLAN_DEFAULTS.service_minutes,
            kg: a.estimated_kg || 10,
          };
          const cfg = { ...snap.config, zones: this.zones || [] };
          slots = C.slotsFor({ days: snap.days, assigned: [], unassigned: [] }, node, day, cfg, roads, 8);
          sel.innerHTML = slots.length
            ? slots
                .map(
                  (x, i) =>
                    `<option value="${i}">${esc(x.start)}–${esc(x.end)}${x.extra_minutes ? ' · +' + x.extra_minutes + T(' мин дороги') : ''}</option>`,
                )
                .join('')
            : `<option value="">${T('Свободного места нет')}</option>`;
          note.textContent = slots.length
            ? `${T('Свободных мест в этот день:')} ${slots.length}${T('. Первое — с наименьшим крюком.')}`
            : dayIssueText(C.dayIssue({ days: snap.days, assigned: [], unassigned: [] }, node, day, cfg, roads)) ||
              T('Свободного времени в этот день не осталось. Выберите другую дату.');
        } catch (e) {
          sel.innerHTML = `<option value="">${T('Не удалось посчитать')}</option>`;
          note.textContent = error(e);
        }
        text();
      };
      w.querySelector('#od-nw-day').addEventListener('change', load);
      w.querySelector('#od-nw-time').addEventListener('change', text);
      load();
    }
    moveText(node, source, day, start, end) {
      const name = (this.driver.name || '').trim(),
        brand = C.brandOf({ collection_source: source });
      const when = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(day + 'T12:00:00Z'));
      return (
        `Hello, this is ${name ? name + ' from ' + brand : brand}.\n\n` +
        (start
          ? `Your clothing collection at ${node.text} has been moved to ${when}, between ${start} and ${end} (UK time).\n\n`
          : `Your clothing collection at ${node.text} has been moved to ${when}. We will text you a 1-hour arrival window on the day.\n\n`) +
        `Sorry for the change, and thank you for your patience. If this no longer suits you, just reply to this message and we will arrange another day.\n\n` +
        `Kind regards,\n${name ? name + '\n' : ''}${brand}`
      );
    }
    /* Перенос одной остановки прямо из плана.
    Новая заявка — двигаем в памяти, ничего никому не обещано.
    Подтверждённый сбор — двигаем на сервере и предлагаем написать клиенту.
    Отправленное предложение без ответа — только через Переписку. */
    replanStop(addressId, dayNow, key) {
      const dayRow = this.plan?.days.find((d) => d.day === dayNow);
      const node = dayRow && dayRow.nodes.find((n) => n.key === key);
      if (!node) {
        this.notice(T('Не нашёл эту остановку. Обновите план.'), true);
        return;
      }
      const fresh = this.plan.assigned.some((a) => a.address_id === addressId);
      if (!fresh && node.kind !== 'confirmed') {
        this.dialog(
          T('Перенести сбор'),
          `<p><b>${esc(node.text)}</b></p>
    <p class="od-muted">${T('Клиенту уже отправлено время, ответа пока нет. Пока он не ответил, менять день здесь нельзя — иначе вы и клиент будете знать разное время.')}</p>
    <p class="od-muted">${T('Дождитесь ответа в «Переписке» или снимите предложение кнопкой «Снять» в очереди заявок.')}</p>`,
          null,
        );
        return;
      }
      const full = (this.o.addresses?.() || []).find((x) => x.id === addressId) || this.requests.find((x) => x.id === addressId) || {};
      const source = full.collection_source || 'partner_email';
      const open = this.plan.days.filter((d) => !d.started_at && !d.hours?.closed);
      const slots = (day) => C.slotsFor(this.plan, node, day, this.planConfig, this.planRoads);
      const w = this.dialog(
        T('Перенести · ') + node.text,
        `
   <p class="od-muted">${fresh ? T('Заявка ещё не отправлена клиенту — перенос останется в плане до нажатия «Сохранить предложения».') : T('Сбор согласован с клиентом. Перенос изменит договорённость.')}</p>
   <div class="od-grid">
    <label>${T('День')}<select id="od-rp-day">${open.map((d) => `<option value="${esc(d.day)}" ${d.day === dayNow ? 'selected' : ''}>${esc(label(d.day))}</option>`).join('')}</select></label>
    <label>${T('Время')}<select id="od-rp-time"></select></label>
   </div>
   <p class="od-muted" id="od-rp-note"></p>
   ${
     fresh
       ? ''
       : `<label><input type="checkbox" id="od-rp-sms" checked>${T('Сообщить клиенту SMS о новом времени.')}</label>
    <textarea id="od-rp-text" rows="7" readonly></textarea>`
   }`,
        async (wrap) => {
          const day = wrap.querySelector('#od-rp-day').value;
          let start = wrap.querySelector('#od-rp-time').value;
          if (!start) {
            const list = slots(day);
            if (!list.length) throw new Error(T('В этот день нет свободного места.'));
            start = list[0].start;
          }
          const end = C.hm(C.minute(start) + 30);
          if (fresh) {
            const res = C.movePlanned(this.plan, this.planRequests, addressId, day, this.planConfig, this.planRoads, start);
            if (!res.ok)
              throw new Error(
                {
                  NO_ROOM: T('В этот день места нет — дорога, часы или день выезда зоны не позволяют.'),
                  NO_ROOM_AT_TIME: T('На это время места нет. Выберите «Подобрать автоматически» или другое время.'),
                  DAY_OUT_OF_RANGE: T('Этот день вне рассчитанного горизонта.'),
                }[res.code] || res.code,
              );
            this.plan = { assigned: res.assigned, unassigned: res.unassigned, days: res.days, metrics: res.metrics };
            this.render();
            this.notice(`${T('Перенесено на')} ${label(day)}, ${res.chosen.start}${T('. Не забудьте «Сохранить предложения».')}`);
            return;
          }
          online(this.o);
          try {
            await warm(this.o, day, [addressId]);
          } catch (e) {}
          const r = await this.sb.rpc('subnex_move_request', {
            p_data: { address_id: addressId, version: full.collection_version, day, start, end, agreed: true },
          });
          if (r.error) throw r.error;
          let tail = '';
          if (wrap.querySelector('#od-rp-sms').checked) {
            try {
              if (!window.Ops?.api) throw new Error(T('Модуль переписки не загружен.'));
              const thread = await Ops.api(this.sb, 'create', { address_id: addressId });
              if (!thread?.thread_id) throw new Error(T('Не удалось открыть переписку.'));
              await Ops.api(this.sb, 'send', {
                thread_id: thread.thread_id,
                kind: 'reply',
                body: wrap.querySelector('#od-rp-text').value,
                request_id: crypto.randomUUID(),
              });
            } catch (e) {
              tail = T(' Сообщение не ушло: ') + error(e) + T(' Напишите клиенту из «Переписки».');
            }
          }
          await this.reload();
          if (this.selected.size) await this.calculate();
          else {
            this.mode = 'queue';
            this.render();
          }
          this.notice(`${T('Сбор перенесён на')} ${label(day)}, ${start}.` + tail, !!tail);
          await this.o.onChanged?.();
        },
        T('Перенести'),
      );
      const fill = () => {
        const day = w.querySelector('#od-rp-day').value,
          list = slots(day);
        const same = list.find((o) => o.start === (node.starts_at ? C.hm(C.ukMinute(node.starts_at)) : null));
        w.querySelector('#od-rp-time').innerHTML =
          `<option value="">${T('Подобрать автоматически')}</option>` +
          list
            .map(
              (o) =>
                `<option value="${esc(o.start)}">${esc(o.start)}–${esc(o.end)}${o.wait_minutes ? T(' · простой ') + o.wait_minutes + T(' мин') : ''}</option>`,
            )
            .join('');
        w.querySelector('#od-rp-note').textContent = list.length
          ? `${T('Свободных мест в этот день:')} ${list.length}${T('. «Подобрать автоматически» возьмёт лучшее по дороге.')}`
          : dayIssueText(C.dayIssue(this.plan, node, day, this.planConfig, this.planRoads)) ||
            T('Свободного времени в этот день не осталось — выберите другой день.');
        const text = w.querySelector('#od-rp-text');
        if (text) {
          const start = w.querySelector('#od-rp-time').value || (list[0] && list[0].start) || '';
          text.value = start ? this.moveText(node, source, day, start, C.hm(C.minute(start) + 30)) : '';
        }
        void same;
      };
      w.querySelector('#od-rp-day').onchange = fill;
      w.querySelector('#od-rp-time').onchange = fill;
      fill();
    }
    /* Перенос заявки: другая дата или возврат в очередь. Подтверждённый сбор переезжает
    сразу — это решение оператора, ответа клиента ждать не нужно; клиенту уходит SMS. */
    moveRequest(a) {
      const confirmed = !!a.collection_start,
        day = a.date || (a.held_start ? C.ukDay(a.held_start) : ''),
        start = a.held_start ? C.hm(C.ukMinute(a.held_start)) : '09:00';
      const w = this.dialog(
        T('Перенести заявку'),
        `<p><b>${esc(a.text)}</b></p>
   ${confirmed ? `<p class="od-muted">${T('Сейчас согласовано:')} ${esc(label(a.date))}, ${esc(C.hm(C.ukMinute(a.collection_start)))}.</p>` : a.date ? `<p class="od-muted">${T('Сейчас в маршруте на')} ${esc(label(a.date))}.</p>` : ''}
   <label>${T('Куда')}<select id="od-move-mode"><option value="day">${T('На другую дату и время')}</option><option value="queue">${T('Вернуть в очередь без даты')}</option></select></label>
   <div class="od-grid" id="od-move-slot"><label>${T('Дата')}<input id="od-move-date" type="date" min="${C.ukDay()}" value="${esc(day)}"></label><label id="od-move-timewrap">${T('Время прибытия')}<input id="od-move-start" type="time" step="300" value="${esc(start)}"></label></div>
   <label id="od-move-wholewrap"><input id="od-move-whole" type="checkbox" checked>${T('В течение дня — окно прибытия уйдёт клиенту утром')}</label>
   <label id="od-move-nbwrap" hidden>${T('Не раньше')}<input id="od-move-nb" type="date" min="${C.ukDay()}"></label>
   <p class="od-muted" id="od-move-help">${T('Клиенту обещается интервал 30 минут. Новое место проверяется по дороге, рабочим часам и дню выезда зоны.')}</p>
   ${
     confirmed
       ? `<label><input id="od-move-sms" type="checkbox" checked>${T('Сообщить клиенту SMS о новом времени.')}</label>
   <p class="od-muted" id="od-move-warn" hidden>${T('Без сообщения клиент будет ждать в прежнее время. Снимайте эту галочку, только если уже сказали ему сами.')}</p>
   <textarea id="od-move-text" rows="6" readonly></textarea>`
       : ''
   }`,
        async (wrap) => {
          const queued = wrap.querySelector('#od-move-mode').value === 'queue';
          const wholeDay = !queued && wrap.querySelector('#od-move-whole')?.checked;
          const data = { address_id: a.id, version: a.collection_version, agreed: confirmed };
          if (queued) {
            data.to_queue = true;
            data.not_before = wrap.querySelector('#od-move-nb').value || null;
          } else {
            const d = wrap.querySelector('#od-move-date').value,
              st = wrap.querySelector('#od-move-start').value;
            if (!d || (!wholeDay && !st)) throw new Error('SLOT_INVALID');
            if (wholeDay) Object.assign(data, { day: d, mode: 'day' });
            else {
              const m = C.minute(st);
              if (!Number.isFinite(m) || m + 30 > 1440) throw new Error('SLOT_INVALID');
              Object.assign(data, { day: d, start: st, end: C.hm(m + 30) });
            }
            online(this.o);
            try {
              await warm(this.o, d, [a.id]);
            } catch (e) {}
          }
          const r = await this.sb.rpc('subnex_move_request', { p_data: data });
          if (r.error) throw r.error;
          let tail = '';
          /* Перенос подтверждённого сбора — клиент должен узнать новое время сам, без вопросов. */
          if (confirmed && !queued && wrap.querySelector('#od-move-sms')?.checked) {
            try {
              if (!window.Ops?.api) throw new Error(T('Модуль переписки не загружен.'));
              const thread = await Ops.api(this.sb, 'create', { address_id: a.id });
              if (!thread?.thread_id) throw new Error(T('Не удалось открыть переписку.'));
              await Ops.api(this.sb, 'send', {
                thread_id: thread.thread_id,
                kind: 'reply',
                body: wrap.querySelector('#od-move-text').value,
                request_id: crypto.randomUUID(),
              });
            } catch (e) {
              tail = T(' Сообщение не ушло: ') + error(e) + T(' Напишите клиенту из «Переписки».');
            }
          }
          await this.reload();
          this.render();
          this.notice((queued ? T('Заявка вернулась в очередь — подберите время заново.') : T('Заявка перенесена.')) + tail);
          await this.o.onChanged?.();
        },
        T('Перенести'),
      );
      const mode = w.querySelector('#od-move-mode'),
        slot = w.querySelector('#od-move-slot'),
        nb = w.querySelector('#od-move-nbwrap'),
        help = w.querySelector('#od-move-help');
      const sms = w.querySelector('#od-move-sms'),
        warn = w.querySelector('#od-move-warn'),
        box = w.querySelector('#od-move-text');
      const whole = w.querySelector('#od-move-whole'),
        timeWrap = w.querySelector('#od-move-timewrap'),
        wholeWrap = w.querySelector('#od-move-wholewrap');
      const fillText = () => {
        const q = mode.value === 'queue',
          d = w.querySelector('#od-move-date').value,
          st = w.querySelector('#od-move-start').value;
        const wholeDay = !q && !!whole?.checked;
        if (timeWrap) timeWrap.hidden = wholeDay;
        if (wholeWrap) wholeWrap.hidden = q;
        if (!box) return;
        const on = !q && !!sms?.checked;
        box.hidden = !on;
        if (warn) warn.hidden = q || !!sms?.checked;
        if (sms) sms.closest('label').hidden = q;
        if (on && d) box.value = this.moveText(a, a.collection_source, d, wholeDay ? null : st, wholeDay ? null : C.hm(C.minute(st) + 30));
      };
      mode.onchange = () => {
        const q = mode.value === 'queue';
        slot.hidden = q;
        nb.hidden = !q;
        help.textContent = q
          ? T('Дата снимется, заявка вернётся в очередь. Планировщик подберёт день заново.')
          : T('Клиенту обещается интервал 30 минут. Новое место проверяется по дороге, рабочим часам и дню выезда зоны.');
        fillText();
      };
      w.querySelector('#od-move-date').addEventListener('change', fillText);
      w.querySelector('#od-move-start').addEventListener('change', fillText);
      sms?.addEventListener('change', fillText);
      whole?.addEventListener('change', fillText);
      fillText();
    }
    /* Закрыть заявку, не удаляя её: статус «Отменено», строка и переписка остаются.
       SMS отсюда не уходит — заявке ещё ничего не обещали, уведомлять не о чем. */
    closeRequest(a) {
      this.dialog(
        T('Закрыть заявку'),
        `<p><b>${esc(a.text)}</b></p>
   <p class="od-muted">${T('Заявка уйдёт из очереди со статусом «Отменено». Адрес, переписка и фотографии останутся в базе — позже по тому же адресу можно создать новую заявку.')}</p>
   <p class="od-muted">${T('SMS клиенту не отправляется: даты ему никто не обещал.')}</p>
   <label><input id="od-close-sure" type="checkbox">${T('Закрыть эту заявку.')}</label>`,
        async (wrap) => {
          if (!wrap.querySelector('#od-close-sure').checked) throw new Error(T('Отметьте подтверждение.'));
          const { error } = await this.sb.from('addresses').update({ status: 'cancelled' }).eq('id', a.id).eq('status', a.status);
          if (error) throw new Error(T('Не удалось закрыть заявку. Обновите список и попробуйте ещё раз.'));
          await this.reload();
          this.render();
          this.notice(T('Заявка закрыта.'));
          await this.o.onChanged?.();
        },
        T('Закрыть заявку'),
      );
    }
    /* Убрать заявку из базы. Это не «закрыть сбор»: история и переписка не сохраняются,
    поэтому для заявок с перепиской путь один — «Переписка → Закрыть заявку». */
    dropRequest(a) {
      this.dialog(
        T('Убрать заявку'),
        `<p><b>${esc(a.text)}</b></p>
   <p class="od-muted">${T('Заявка исчезнет из базы вместе с фотографиями и заметками. Отменить это нельзя.')}</p>
   <p class="od-muted">${T('Если клиенту что-то обещали или по адресу есть переписка — закройте заявку в разделе «Переписка» кнопкой «Закрыть заявку»: тогда история останется, а клиент получит SMS об отмене.')}</p>
   <label><input id="od-drop-sure" type="checkbox">${T('Удалить эту заявку навсегда.')}</label>`,
        async (wrap) => {
          if (!wrap.querySelector('#od-drop-sure').checked) throw new Error(T('Отметьте подтверждение удаления.'));
          const { error } = await this.sb.from('addresses').delete().eq('id', a.id);
          if (error)
            throw new Error(
              T(
                'Не удалось удалить: у заявки есть переписка или подтверждённый сбор. Закройте её в разделе «Переписка» кнопкой «Закрыть заявку».',
              ),
            );
          await this.reload();
          this.render();
          this.notice(T('Заявка удалена.'));
          await this.o.onChanged?.();
        },
        T('Удалить'),
      );
    }
    partner(a) {
      const dayName = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(C.ukDay(a.held_start) + 'T12:00:00Z'));
      const text = C.isDaySpan(a.held_start, a.held_end)
        ? `We can collect from ${a.text} on ${dayName}, during the day — we text the customer a 1-hour arrival window on the morning. Please confirm with the customer and let us know if this is suitable. Thank you.`
        : `We can collect from ${a.text} on ${dayName}, between ${C.hm(C.ukMinute(a.held_start))} and ${C.hm(C.ukMinute(a.held_end))} (UK time). Please confirm with the customer and let us know if this is suitable. Thank you.`;
      const w = this.dialog(
        T('Согласование с партнёром'),
        `<textarea id="od-partner-text" rows="5" readonly>${esc(text)}</textarea><button id="od-copy">${T('Скопировать для WhatsApp')}</button><p class="od-muted">${T('Интервал уже зарезервирован. После ответа партнёра отметьте подтверждение.')}</p><label><input id="od-partner-agreed" type="checkbox">${T('Партнёр подтвердил именно эти дату и интервал.')}</label>`,
        async (w) => {
          if (!w.querySelector('#od-partner-agreed').checked) throw new Error('AGREEMENT_REQUIRED');
          online(this.o);
          await warm(this.o, C.ukDay(a.held_start), [a.id]);
          await this.call('confirm_partner', { address_id: a.id, agreed: true });
          await this.reload();
          this.render();
          this.notice(T('Подтверждено. Адрес добавлен в маршрут.'));
          await this.o.onChanged?.();
        },
        T('Добавить подтверждённый сбор'),
      );
      w.querySelector('#od-copy').onclick = async () => {
        const b = w.querySelector('#od-copy');
        b.disabled = true;
        try {
          await warm(this.o, C.ukDay(a.held_start), [a.id]);
          await this.call('share', { address_id: a.id });
          await navigator.clipboard.writeText(text);
          b.textContent = T('Текст скопирован');
          a.shared_at = new Date().toISOString();
        } catch (e) {
          w.querySelector('.od-dialog-error').textContent = error(e);
          w.querySelector('textarea').select();
        } finally {
          b.disabled = false;
        }
      };
    }
    action(act, b) {
      if (this.busy) return;
      if (act === 'close') {
        this.close();
        return;
      }
      if (['queue', 'one', 'batch', 'settings'].includes(act)) {
        this.mode = act;
        this.notice('');
        this.render();
        return;
      }
      const a = this.requests.find((a) => a.id === b.dataset.id);
      if (act === 'parse') {
        const text = this.$('#od-paste').value;
        this.rows = C.parseRows(text, this.pasteHtml, this.source);
        if (!this.rows.length || this.rows.length > 200) {
          this.notice(T('Вставьте от 1 до 200 заявок.'), true);
          return;
        }
        this.importId = crypto.randomUUID();
        this.mode = 'review';
        this.render();
        return;
      }
      if (act === 'review-one') {
        this.rows = [{ ...this.fields(this.$('.od-content')), intake_channel: this.source }];
        this.importId = crypto.randomUUID();
        this.mode = 'review';
        this.render();
        return;
      }
      if (act === 'remove-row') {
        this.syncRows();
        this.rows.splice(+b.dataset.index, 1);
        this.importId = crypto.randomUUID();
        this.render();
        return;
      }
      if (act === 'partner') {
        this.partner(a);
        return;
      }
      if (act === 'edit') {
        const ok = C.validPoint(a);
        this.dialog(
          T('Изменить заявку'),
          `<p><b>${esc(a.text)}</b></p><div class="od-grid">${input('not_before', T('Клиент доступен начиная с'), a.not_before, 'date')}${charityInput(a.charity)}${datalist('od-charities', this.charities())}<label>${T('Сбор на адресе')}<select data-field="service_minutes"><option value="5" ${a.service_minutes !== 10 ? 'selected' : ''}>${T('5 минут')}</option><option value="10" ${a.service_minutes === 10 ? 'selected' : ''}>${T('10 минут')}</option></select></label></div><input data-field="estimated_kg" data-num type="hidden" value="${esc(a.estimated_kg || 10)}"><p class="od-muted">${T('Точка на карте:')} ${ok ? `${T('определена')}${a.geocode_source === 'postcode' ? T(' по почтовому индексу — это центр индекса, дом может быть в стороне') : ''}. <a href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=18/${a.lat}/${a.lng}" target="_blank" rel="noopener">${T('Проверить')}</a>` : T('не определена — найдём автоматически перед расчётом.')}</p>`,
          async (w) => {
            const data = this.fields(w);
            delete data.lat;
            delete data.lng;
            await this.call('edit_request', { address_id: a.id, ...data });
            await this.reload();
            this.render();
            this.notice(T('Заявка обновлена.'));
          },
        );
        return;
      }
      if (act === 'replan') {
        this.replanStop(b.dataset.id, b.dataset.day, b.dataset.key);
        return;
      }
      if (act === 'move') {
        this.moveRequest(a);
        return;
      }
      if (act === 'remind') {
        this.remind(a);
        return;
      }
      if (act === 'renew') {
        this.renew(a);
        return;
      }
      if (act === 'drop') {
        this.dropRequest(a);
        return;
      }
      if (act === 'close') {
        this.closeRequest(a);
        return;
      }
      if (act === 'release') {
        this.dialog(
          T('Снять предложение'),
          `<p>${esc(a.text)}</p><label><input id="od-withdrawn" type="checkbox">${a.shared_at ? T('Я отозвал это время у партнёра.') : T('Предложение ещё не передано клиенту или уже отозвано.')}</label>`,
          async (w) => {
            if (!w.querySelector('#od-withdrawn').checked) throw new Error('PARTNER_WITHDRAWAL_REQUIRED');
            await this.call('release', { address_id: a.id, acknowledged: true });
            await this.reload();
            this.render();
          },
          T('Снять предложение'),
        );
        return;
      }
      if (act === 'legacy') {
        const p = this.legacy.find((p) => p.id === b.dataset.id);
        this.dialog(
          T('Подтвердить прежнее предложение'),
          `<p>${esc(p.address)} · ${label(C.ukDay(p.starts_at))} ${C.hm(C.ukMinute(p.starts_at))}</p><label><input id="od-legacy-agreed" type="checkbox">${T('Партнёр подтвердил эту дату и время.')}</label>`,
          async (w) => {
            if (!w.querySelector('#od-legacy-agreed').checked) throw new Error('AGREEMENT_REQUIRED');
            await warm(this.o, C.ukDay(p.starts_at));
            await this.call('legacy_confirm', { id: p.id, agreed: true });
            await this.reload();
            this.render();
            await this.o.onChanged?.();
          },
          T('Подтвердить'),
        );
        return;
      }
      if (act === 'sendall') {
        this.sendAll();
        return;
      }
      if (act === 'copypartner') {
        this.copyForPartner();
        return;
      }
      if (act === 'schedule') {
        this.copySchedule();
        return;
      }
      if (act === 'sms') {
        const plan = a.held_start
          ? {
              dispatch: true,
              driver_id: this.driver.id,
              address_id: a.id,
              day: C.ukDay(a.held_start),
              start: C.hm(C.ukMinute(a.held_start)),
              end: C.hm(C.ukMinute(a.held_end)),
            }
          : null;
        if (!this.inline) this.close();
        if (this.o.onChoose && plan) this.o.onChoose(plan);
        else this.o.onSms?.(a.id, plan);
        return;
      }
      this.run(
        async () => {
          if (act === 'refresh') {
            await this.reload();
            this.render();
            this.notice(T('Список обновлён.'));
          } else if (act === 'import') {
            online(this.o);
            this.syncRows();
            if (!this.rows.length) throw new Error(T('В списке нет заявок.'));
            const issues = this.rows.flatMap((r, i) =>
              C.issues(r, this.o.addresses?.() || this.requests, this.rows.slice(0, i)).map((m) => `${i + 1}: ${m}`),
            );
            if (issues.length) {
              this.updateIssues();
              throw new Error(issues.join('\n'));
            }
            const rows = this.rows.map(({ raw, row, ...r }) => r);
            const signature = JSON.stringify(rows);
            if (this.importSignature && this.importSignature !== signature) this.importId = crypto.randomUUID();
            this.importSignature = signature;
            const r = await this.call('import', { request_id: this.importId, rows });
            this.selected = new Set(r.ids.slice(0, 40));
            await this.reload();
            this.mode = 'queue';
            this.render();
            this.notice(`${T('Добавлено:')} ${r.imported}${T('. Теперь можно подобрать время.')}`);
            await this.o.onChanged?.();
          } else if (act === 'calculate') await this.calculate();
          else if (act === 'reserve') {
            online(this.o);
            const orders = Object.fromEntries(this.plan.days.map((d) => [d.day, d.order]));
            const assignments = this.plan.assigned.map(({ address_id, day, start, end, request_token }) => ({
              address_id,
              day,
              start,
              end,
              request_token,
            }));
            await this.call('reserve_plan', { request_id: this.reserveId, assignments, orders, tokens: this.tokens });
            await this.reload();
            this.mode = 'queue';
            this.render();
            this.notice(T('Предложения сохранены. Откройте SMS или скопируйте время для партнёра.'));
            await this.o.onChanged?.();
          } else if (act === 'save-settings') {
            const content = this.$('.od-content'),
              fields = this.fields(content),
              config = {};
            for (const k of ['capacity_kg', 'travel_factor', 'leg_buffer_minutes', 'zone_penalty_minutes', 'day_penalty_minutes'])
              config[k] = fields[k];
            config.reserve_kg = 0;
            config.reserve_minutes = 0;
            config.capacity_kg = 1600;
            config.zone_penalty_minutes = 0;
            for (const k of ['home', 'depot']) {
              const box = this.$('[data-point=' + k + ']'),
                text = box.querySelector('[data-field=text]').value.trim();
              if (!text) throw new Error(T('Укажите адрес старта и склада.'));
              const point = this.fields(box);
              if (!C.validPoint(point) || text !== (this.config?.[k]?.text || '')) {
                this.notice(T('Ищу точку: ') + text);
                const found = await this.locate(text);
                config[k] = { text, lat: found.lat, lng: found.lng };
              } else config[k] = { text, lat: point.lat, lng: point.lng };
            }
            const r = await this.call('save_settings', { config });
            this.config = r.config;
            this.render();
            this.notice(T('Старт и склад сохранены.'));
          } else if (act === 'save-auto') {
            const config = {};
            this.root.querySelectorAll('[data-auto]').forEach((el) => {
              config[el.dataset.auto] = el.type === 'checkbox' ? el.checked : Number(el.value);
            });
            const r = await this.call('save_auto_plan', { config });
            this.autoCfg = r.config;
            await this.reload();
            this.render();
            this.notice(r.config.enabled ? T('Автопланировщик включён: даты уйдут сами в рабочие часы.') : T('Автопланировщик выключен.'));
          } else if (act === 'autorun') {
            const r = await this.call('auto_plan_run');
            await this.reload();
            this.render();
            const h = Math.floor(C.ukMinute(new Date().toISOString()) / 60),
              cfg = this.autoCfg || {},
              quiet = Number.isFinite(cfg.sms_from_hour) && (h < cfg.sms_from_hour || h >= cfg.sms_to_hour);
            this.notice(
              r.enabled === false
                ? T('Автопланировщик выключен — включите его в «Параметрах».')
                : `${T('Проход выполнен: предложено')} ${r.offered}${T(', удержано')} ${r.held}${T(', пропущено')} ${r.skipped}${T(', снято')} ${r.expired}${T(', напоминаний')} ${r.followups?.reminded ?? 0}${T(', закрыто')} ${r.followups?.closed ?? 0}.` +
                    (quiet
                      ? ` ${T('Сейчас не часы SMS (')}${cfg.sms_from_hour}:00–${cfg.sms_to_hour}${T(':00) — даты уйдут утром.')}`
                      : ''),
            );
          } else if (act === 'locate-point') {
            const box = this.$('fieldset[data-point=' + b.dataset.point + ']'),
              p = await this.locate(box.querySelector('[data-field=text]').value);
            box.querySelector('[data-field=lat]').value = p.lat;
            box.querySelector('[data-field=lng]').value = p.lng;
            this.notice(T('Найдена точка по postcode. Проверьте старт или склад на карте и сохраните параметры.'));
          } else if (act === 'health') {
            const r = await edge(this.sb, { action: 'health', driver_id: this.driver.id });
            this.notice(T('Сервис дорог подключён: ') + r.provider + '.');
          }
        },
        act === 'calculate' ? T('Начинаю расчёт…') : T('Выполняю…'),
      );
    }
  }
  root.OpsDispatch = {
    open: async (o) => {
      if (!o.driver?.id) throw new Error(T('Выберите водителя.'));
      if (o.mount) {
        const d = new Dispatch(o);
        await d.start();
        return d;
      }
      if (instance) instance.close();
      if (instance) return;
      instance = new Dispatch(o);
      await instance.start();
      return instance;
    },
    close: () => instance?.close(),
    rpc,
    edge,
    warm,
    preflight,
    routeDay,
    startDay,
    lateOnly,
    dayIssueText,
    reminderMessage,
    renewMessage,
    error,
    core: C,
  };
  /* Старый подбор времени (ops-planner.js, OSRM, часовые окна) убран: он жил параллельно
     с этим планировщиком и считал по другим правилам. Имя OpsPlanner оставлено, чтобы
     переписка и телефон продолжали звать «Подобрать время» как раньше. */
  root.OpsPlanner = {
    open: (o) => root.OpsDispatch.open(o),
    close: () => root.OpsDispatch.close(),
    prepareSms: async (o, plan, payload) => {
      const r = await preflight(o, plan, payload);
      if (r === null) throw new Error('DISPATCH_NOT_ENABLED');
      return {};
    },
  };
})(window);
