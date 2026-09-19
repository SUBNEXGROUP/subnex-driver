/* SUBNEX dispatch: pure calculations. No network, writes or SMS. */
(function (root) {
  'use strict';
  const T = root.T || ((s) => s);
  const sourceNames = {
    subnex_website: 'SUBNEX Collections',
    partner_email: 'Partner Email',
    partner_whatsapp: 'Partner WhatsApp',
    missing: 'Missing Collections',
  };
  const sourceOf = (a) => a.intake_channel || { subnex: 'subnex_website', missing: 'missing' }[a.collection_source] || 'partner_email';
  /* Бренд в SMS решается в одном месте. Сервер знает collection_source — он главный;
     intake_channel — запасной путь для строк, где collection_source ещё не проставлен. */
  const brandOf = (a) =>
    (a && a.collection_source ? a.collection_source === 'subnex' : sourceOf(a || {}) === 'subnex_website')
      ? 'SUBNEX'
      : 'We Recycle Clothes';
  /* Источник для шаблона SMS: subnex / partner / missing — так его называет сервер. */
  const templateSource = (a) =>
    a && a.collection_source
      ? a.collection_source
      : sourceOf(a || {}) === 'subnex_website'
        ? 'subnex'
        : sourceOf(a || {}) === 'missing'
          ? 'missing'
          : 'partner';
  const postcode = (s) => {
    const m = String(s || '')
      .toUpperCase()
      .match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
    return m ? m[1] + ' ' + m[2] : '';
  };
  const key = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  /* «+44 (0)7…» — обычная британская запись: ноль в скобках при международном коде не набирается.
     Раньше он оставался, получалось 13 цифр и «SMS не уйдёт». */
  const phone = (s) => {
    let p = String(s || '')
      .replace(/\(\s*0\s*\)/g, '')
      .replace(/[\s().-]/g, '');
    if (p.startsWith('0044')) p = '+' + p.slice(2);
    if (/^\+440\d{10}$/.test(p)) p = '+44' + p.slice(4);
    if (/^07\d{9}$/.test(p)) p = '+44' + p.slice(1);
    if (/^44\d{10}$/.test(p)) p = '+' + p;
    return p;
  };
  /* Любой британский номер, включая стационарный: его нужно СОХРАНИТЬ, даже если SMS на него не уйдёт. */
  const anyPhone = (s) => {
    const m = String(s || '').match(/(?:\+44\s*\(0\)|\+44|0044|0)\s*\d(?:[\s().-]*\d){8,10}\b/);
    return m ? m[0] : '';
  };
  const UK_MOBILE = /^\+447\d{9}$/;
  const isUkMobile = (s) => UK_MOBILE.test(phone(s));
  const hm = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  const minute = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const ukParts = (d) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(d))
        .map((x) => [x.type, x.value]),
    );
  const ukDay = (d) => {
    const p = ukParts(d || new Date());
    return `${p.year}-${p.month}-${p.day}`;
  };
  const ukMinute = (d) => {
    const p = ukParts(d);
    return +p.hour * 60 + +p.minute;
  };
  const pointKey = (p) => Number(p.lat).toFixed(5) + ',' + Number(p.lng).toFixed(5);
  const validPoint = (p) =>
    p &&
    typeof p.lat === 'number' &&
    Number.isFinite(p.lat) &&
    p.lat >= 49 &&
    p.lat <= 61 &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lng) &&
    p.lng >= -9 &&
    p.lng <= 3;
  function zone(address) {
    const p = postcode(address).split(' ')[0];
    if (/^CF(62|63|64)$/.test(p)) return 'Barry / Vale';
    if (/^CF(31|32|33|34|35|36)$/.test(p)) return 'Bridgend';
    if (/^CF(37|38|39|40|41|42|43)$/.test(p)) return 'Rhondda / Pontypridd';
    if (/^CF(44|45|46|47|48)$/.test(p)) return 'Merthyr / Aberdare';
    if (/^CF(81|82|83)$/.test(p) || /^NP(11|12|13|22|23)$/.test(p)) return 'Caerphilly / Valleys';
    if (p.startsWith('CF')) return 'Cardiff';
    if (p.startsWith('NP')) return 'Newport / East Wales';
    if (p.startsWith('SA')) return 'Swansea';
    if (p === 'LD3') return 'Brecon';
    return 'Outside area';
  }
  const legMinutes = (a, b, config, roads) => {
    if (pointKey(a) === pointKey(b)) return 0;
    const seconds = roads[pointKey(a) + '>' + pointKey(b)];
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? Math.ceil((seconds / 60) * config.travel_factor) + config.leg_buffer_minutes
      : Infinity;
  };
  /* ---------- зоны выезда ----------
   Дальние районы (BS, SA) обслуживаются в назначенный день месяца.
   Правила приходят с сервера (public.subnex_zones) и кладутся в config.zones. */
  const postcodeArea = (s) => {
    const m = String(s || '')
      .toUpperCase()
      .match(/\b([A-Z]{1,2})\d[A-Z\d]?\s*\d[A-Z]{2}\b/);
    return m ? m[1] : '';
  };
  /* Номер индекса: «… Cardigan SA43 1EJ» → 43. Нужен, чтобы отделить Суонси (SA1–13)
   от запада Уэльса (SA14–99) — буквы у них общие, а поездки разные. */
  const postcodeNumber = (s) => {
    const m = String(s || '')
      .toUpperCase()
      .match(/\b[A-Z]{1,2}(\d\d?)[A-Z]?\s*\d[A-Z]{2}\b/);
    return m ? parseInt(m[1], 10) : null;
  };
  const zoneSpan = (z) => (z.num_to ?? 99) - (z.num_from ?? 0);
  const zoneKey = (z) => z && (z.code || z.prefix);
  /* Одна поездка может охватывать несколько районов: Бристоль, BA и SN едут в один
   четверг. Поэтому зоны считаются «своими» друг другу не только по коду, но и когда
   у них совпадает день выезда — тогда день поездки открыт для всех троих.
   Зоны с разными днями (Суонси по средам, запад по вторникам) не смешиваются. */
  const sameZone = (x, y) => {
    if (!x || !y) return false;
    if (zoneKey(x) === zoneKey(y)) return true;
    return (
      x.mode === 'monthly' &&
      y.mode === 'monthly' &&
      Number(x.weekday) === Number(y.weekday) &&
      Number(x.week_of_month || 5) === Number(y.week_of_month || 5)
    );
  };
  /* Зона адреса: совпали буквы и номер попал в диапазон. Выигрывает самый узкий диапазон. */
  const zoneRule = (config, text) => {
    const a = postcodeArea(text);
    if (!a) return null;
    const n = postcodeNumber(text) ?? 0;
    const hits = (config.zones || []).filter((z) => z.prefix === a && n >= (z.num_from ?? 0) && n <= (z.num_to ?? 99));
    return hits.length ? hits.sort((x, y) => zoneSpan(x) - zoneSpan(y))[0] : null;
  };
  /* n-й день недели месяца; week=5 — последний. Возвращает YYYY-MM-DD. */
  function nthWeekday(day, weekday, week) {
    const [y, m] = day.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const hits = [];
    for (let d = 1; d <= last; d++) {
      const t = new Date(Date.UTC(y, m - 1, d));
      if (t.getUTCDay() === weekday) hits.push(d);
    }
    const pick = week >= 5 ? hits[hits.length - 1] : hits[week - 1];
    return pick ? `${y}-${String(m).padStart(2, '0')}-${String(pick).padStart(2, '0')}` : null;
  }
  const zoneTripDay = (rule, day) =>
    rule && rule.mode === 'monthly' && Number.isFinite(rule.weekday) ? nthWeekday(day, rule.weekday, rule.week_of_month || 5) : null;
  /* Зона, чей выезд назначен на этот день: такой день занимают только её адреса.
   Но день держится за зоной ТОЛЬКО пока в ней есть заявки. Иначе каждый месяц
   один рабочий день пропадал бы впустую ради зоны, из которой ничего не пришло.
   Список зон с заявками приходит в config.active_zones; если его нет — правило
   работает по-старому. */
  const tripZoneOf = (config, day) => {
    const on = (config.zones || []).filter((z) => z.mode === 'monthly' && zoneTripDay(z, day) === day);
    if (!on.length) return null;
    const active = config.active_zones;
    if (!Array.isArray(active)) return on[0];
    /* В один день может выезжать несколько зон (Бристоль, BA, SN). Берём ту,
    у которой есть заявки, иначе день освобождается под обычные адреса. */
    return on.find((z) => active.includes(zoneKey(z))) || null;
  };
  /* Зона, чей адрес уже стоит в дне (подтверждённый или удержанный): такой день считается
   днём поездки в эту зону, даже если это не назначенная дата выезда. */
  const occupiedZoneOf = (config, day) => {
    for (const n of day.nodes || []) {
      const z = zoneRule(config, n.text);
      if (z && z.mode === 'monthly') return z;
    }
    return null;
  };
  /* Зоны, задействованные в этом расчёте: есть заявка в очереди или уже стоящий
   в дне адрес. Кладётся в config.active_zones перед планированием. */
  const activeZones = (config, requests, days) => {
    const out = new Set();
    const add = (t) => {
      const z = zoneRule(config, t);
      if (z && z.mode === 'monthly') out.add(zoneKey(z));
    };
    (requests || []).forEach((r) => add(r && r.text));
    (days || []).forEach((d) => (d.nodes || []).forEach((n) => add(n && n.text)));
    return [...out];
  };
  /* Ближайшие даты выезда зоны начиная с дня. */
  function nextTripDays(rule, from, count = 3) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    for (let i = 0; i < 14 && out.length < count; i++) {
      const d = nthWeekday(`${y}-${String(m).padStart(2, '0')}-01`, rule.weekday, rule.week_of_month || 5);
      if (d && d >= from) out.push(d);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }
  function zoneReason(config, text, from) {
    const rule = zoneRule(config, text);
    if (!rule)
      return postcodeArea(text)
        ? `${T('Район')} ${postcodeArea(text)} ${T('не настроен. Добавьте его в «Настройки → Зоны выезда» или назначьте сбор вручную.')}`
        : T('В адресе нет полного почтового индекса — район определить нельзя.');
    if (rule.mode === 'off') return `${T('Зона «')}${rule.name}${T('» выключена в настройках.')}`;
    if (rule.mode === 'monthly') {
      const d = nextTripDays(rule, from, 1)[0];
      return `${T('Зона «')}${rule.name}${T('» — выезд раз в месяц')}${d ? T(': ближайший ') + d : ''}${T('. Заявка ждёт этого дня.')}`;
    }
    return null;
  }

  function evaluate(nodes, order, config, hours, roads, startMinute) {
    if (!hours || hours.closed) return { ok: false, code: 'DAY_CLOSED' };
    if (!validPoint(config.home) || !validPoint(config.depot)) return { ok: false, code: 'SETTINGS_REQUIRED' };
    const byId = new Map(nodes.map((n) => [n.key, n]));
    if (order.length !== nodes.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id)))
      return { ok: false, code: 'PLAN_CHANGED' };
    // Working hours bound arrivals at collections. Outbound and return travel sit outside them.
    const opens = minute(hours.opens),
      closes = minute(hours.closes),
      departFloor = Math.max(0, startMinute ?? 0),
      availableFrom = Math.max(opens, departFloor);
    let cursor = departFloor,
      prev = config.home,
      previous = T('Старт'),
      drive = 0,
      service = 0,
      kg = 0,
      departure = null,
      collectionWork = 0,
      wait = 0;
    const stops = [];
    const travel = (a, b) => legMinutes(a, b, config, roads);
    for (const id of order) {
      const n = byId.get(id);
      if (!validPoint(n)) return { ok: false, code: 'COORDINATES_REQUIRED', address: n.text };
      if (!Number.isFinite(n.earliest) || !Number.isFinite(n.latest) || n.latest < n.earliest)
        return { ok: false, code: 'TIME_REQUIRED', address: n.text };
      const leg = travel(prev, n);
      if (!Number.isFinite(leg)) return { ok: false, code: 'ROADS_REQUIRED', from: previous, to: n.text };
      if (n.earliest < opens || n.latest > closes) return { ok: false, code: 'OUTSIDE_HOURS', address: n.text };
      const first = stops.length === 0;
      const arrival = Math.max(cursor + leg, n.earliest, opens);
      if (arrival > n.latest) return { ok: false, code: 'TIME_CONFLICT', from: previous, to: n.text, arrival, latest: n.latest };
      const w = first ? 0 : Math.max(0, arrival - (cursor + leg));
      if (first) departure = arrival - leg;
      else {
        collectionWork += leg;
        wait += w;
      }
      kg += Number(n.kg);
      service += Number(n.service);
      drive += leg;
      if (kg > config.capacity_kg) return { ok: false, code: 'CAPACITY', kg, limit: config.capacity_kg };
      collectionWork += Math.max(0, Math.min(arrival + Number(n.service), closes) - Math.max(arrival, availableFrom));
      cursor = arrival + Number(n.service);
      stops.push({ key: id, address_id: n.address_id, text: n.text, arrival, departure: cursor, travel: leg, kg, kind: n.kind, wait: w });
      prev = n;
      previous = n.text;
    }
    if (!stops.length)
      return {
        ok: true,
        order: [],
        stops: [],
        departure: null,
        finish: null,
        drive: 0,
        service: 0,
        kg: 0,
        wait: 0,
        switches: 0,
        collection_work_minutes: 0,
        free_minutes: Math.max(0, closes - availableFrom),
      };
    const endLeg = travel(prev, config.depot);
    if (!Number.isFinite(endLeg)) return { ok: false, code: 'ROADS_REQUIRED', from: previous, to: T('Склад') };
    drive += endLeg;
    const finish = cursor + endLeg;
    if (finish >= 1440) return { ok: false, code: 'DAY_BOUNDARY', finish };
    let switches = 0;
    for (let i = 1; i < order.length; i++) if (zone(byId.get(order[i]).text) !== zone(byId.get(order[i - 1]).text)) switches++;
    return {
      ok: true,
      order: [...order],
      stops,
      departure,
      finish,
      drive,
      service,
      kg,
      wait,
      switches,
      collection_work_minutes: collectionWork,
      free_minutes: Math.max(0, closes - availableFrom - collectionWork),
    };
  }
  function ordered(nodes, previous = []) {
    const present = new Set(nodes.map((n) => n.key));
    const out = previous.filter((k) => present.has(k));
    for (const n of [...nodes].sort((a, b) => a.earliest - b.earliest || a.key.localeCompare(b.key)))
      if (!out.includes(n.key)) out.push(n.key);
    return out;
  }
  /* Окно «весь рабочий день» (режим day): клиенту обещана дата, время придёт при старте. */
  const isDayWindow = (n, hours) =>
    !!n && !!hours && Number.isFinite(n.earliest) && Number.isFinite(n.latest)
      ? n.earliest <= minute(hours.opens) && n.latest >= minute(hours.closes)
      : false;
  /* То же для строк очереди: у предложения/удержания начало и конец — ISO-время. */
  const isDaySpan = (start, end) => !!start && !!end && Date.parse(end) - Date.parse(start) >= 6 * 3600e3;
  /* Дата по-английски для SMS с датой: «Tue 23 Sep» — ровно как subnex_private.sms_date. */
  const enShortDate = (day) => {
    const d = new Date(day + 'T12:00:00Z');
    return (
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] +
      ' ' +
      d.getUTCDate() +
      ' ' +
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
    );
  };
  /* Текст предложения даты (шаблон day-v1). Сервер собирает тот же текст
   (subnex_private.day_offer_v1) и сверяет — менять только вместе. */
  const dayOfferText = (source, day, driverName) => {
    const name = String(driverName || '').trim();
    const brand = ['partner', 'missing'].includes(source) ? 'We Recycle Clothes' : 'SUBNEX';
    return (
      'Hi, this is ' +
      (name ? name + ' from ' : '') +
      brand +
      '. We can collect your clothing donation on ' +
      enShortDate(day) +
      '. Reply YES to confirm - we will text you a 1-hour arrival window on the day. If that day does not suit, just reply and tell us.'
    );
  };
  /* Порядок остановок дня: локальный поиск по матрице дорог. Сервер расставляет
   заявки по мере поступления (дешёвая вставка); утром телефон пробует переставить
   остановки — перенос одной (or-opt) и разворот отрезка (2-opt) — пока сокращается
   дорога. Окна прибытия соблюдаются: вариант, который не сходится в evaluate, отбрасывается.
   Возвращает лучший найденный порядок; если улучшений нет — исходный. */
  function optimizeOrder(nodes, order, config, hours, roads, startMinute, limitMs = 1500) {
    const fit = evaluate(nodes, order, config, hours, roads, startMinute);
    if (!fit.ok || order.length < 3) return { order: [...order], fit, improved: false };
    const cost = (f) => f.drive * 10 + f.wait;
    let best = [...order],
      bestFit = fit,
      bestCost = cost(fit),
      improved = false;
    const started = Date.now();
    const tryOrder = (candidate) => {
      const f = evaluate(nodes, candidate, config, hours, roads, startMinute);
      if (f.ok && cost(f) < bestCost - 0.5) {
        best = candidate;
        bestFit = f;
        bestCost = cost(f);
        improved = true;
        return true;
      }
      return false;
    };
    for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      // or-opt: одну остановку — в любое другое место
      for (let i = 0; i < best.length && !moved; i++) {
        for (let j = 0; j <= best.length - 1; j++) {
          if (j === i || j === i - 1) continue;
          const cand = [...best];
          const [k] = cand.splice(i, 1);
          cand.splice(j > i ? j - 1 : j, 0, k);
          if (tryOrder(cand)) {
            moved = true;
            break;
          }
        }
        if (Date.now() - started > limitMs) return { order: best, fit: bestFit, improved };
      }
      // 2-opt: разворот отрезка
      for (let i = 0; i < best.length - 1 && !moved; i++) {
        for (let j = i + 1; j < best.length; j++) {
          const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
          if (tryOrder(cand)) {
            moved = true;
            break;
          }
        }
        if (Date.now() - started > limitMs) return { order: best, fit: bestFit, improved };
      }
      if (!moved) break;
    }
    return { order: best, fit: bestFit, improved };
  }
  /* Мягкие приоритеты планировщика (минуты «стоимости»). Не требования бизнеса, а выбранные коэффициенты — см. описание этапа 2.
   wait_weight — каждая минута простоя, которую создаёт вставка; empty_day_penalty — открытие пустого дня, когда есть начатые;
   sla_days / sla_penalty — срок сбора после заявки; max_wait — простой сверх этого штрафуется вдвое. */
  const PLAN_DEFAULTS = {
    wait_weight: 1,
    empty_day_penalty: 120,
    sla_days: 7,
    sla_penalty: 90,
    max_wait: 15,
    cluster_penalty: 0,
    service_minutes: 5,
    estimated_kg: 10,
    same_slot_minutes: 6,
    day_penalty_minutes: 2,
  };
  const planParam = (config, k) => (Number.isFinite(+config[k]) ? +config[k] : PLAN_DEFAULTS[k]);
  const slaDeadline = (request, config) => {
    const c = request.created_at ? ukDay(request.created_at) : null;
    if (!c) return null;
    const d = new Date(Date.parse(c + 'T12:00:00Z') + planParam(config, 'sla_days') * 86400000);
    return d.toISOString().slice(0, 10);
  };
  /* dayMode — основной режим: клиенту обещается день, а не получасовое окно.
     Узел остаётся непривязанным (earliest = открытие, latest = закрытие), поэтому маршрут
     свободен уложить адрес где угодно внутри дня, и в день помещается заметно больше точек.
     dayMode = false оставлен для адресов, которым действительно обещают точное время. */
  function placements(day, request, config, roads, dayMode = true) {
    if (day.started_at || day.hours?.closed || (request.not_before && day.day < request.not_before)) return [];
    const rule = zoneRule(config, request.text);
    if (!rule || rule.mode === 'off') return [];
    // День поездки в дальнюю зону: либо назначенная дата выезда, либо день, где уже стоит адрес этой зоны.
    const trip = tripZoneOf(config, day.day) || occupiedZoneOf(config, day);
    // Адрес дальней зоны допускается только в день поездки в неё.
    if (rule.mode === 'monthly' && !sameZone(trip, rule)) return [];
    // День поездки занимают только адреса этой зоны, иначе поездка расплывётся в зигзаг.
    if (trip && !sameZone(trip, rule)) return [];
    const nodes = day.nodes.filter((n) => n.address_id !== request.id),
      order = ordered(nodes, day.order);
    const base = evaluate(nodes, order, config, day.hours, roads, day.start_minute);
    if (!base.ok) return [];
    const opens = minute(day.hours.opens),
      closes = minute(day.hours.closes),
      earliestMin = Math.max(opens, day.start_minute || 0),
      svc = request.service_minutes ?? PLAN_DEFAULTS.service_minutes;
    const node = {
      key: 'a:' + request.id,
      address_id: request.id,
      text: request.text,
      lat: request.lat,
      lng: request.lng,
      earliest: earliestMin,
      latest: closes,
      service: svc,
      kg: request.estimated_kg ?? PLAN_DEFAULTS.estimated_kg,
      kind: 'hold',
    };
    const byId = new Map(nodes.map((n) => [n.key, n]));
    const deadline = slaDeadline(request, config),
      late = deadline && day.day > deadline;
    const result = [];
    if (dayMode) {
      for (let i = 0; i <= order.length; i++) {
        const candidate = [...order.slice(0, i), node.key, ...order.slice(i)];
        const fit = evaluate([...nodes, node], candidate, config, day.hours, roads, day.start_minute);
        if (!fit.ok || fit.kg > config.capacity_kg - config.reserve_kg || fit.free_minutes < config.reserve_minutes) continue;
        const extra = fit.drive - (nodes.length ? base.drive : 0);
        // Простоя из-за обещанного окна здесь нет: адрес можно взять в любой момент дня.
        const score = extra + (nodes.length ? 0 : planParam(config, 'empty_day_penalty')) + (late ? planParam(config, 'sla_penalty') : 0);
        result.push({
          day: day.day,
          address_id: request.id,
          start: day.hours.opens.slice(0, 5),
          end: day.hours.closes.slice(0, 5),
          day_only: true,
          node,
          fit,
          extra_minutes: extra,
          wait_minutes: 0,
          score,
          late: !!late,
        });
      }
      return result.sort((a, b) => a.score - b.score);
    }
    for (let i = 0; i <= order.length; i++) {
      const candidate = [...order.slice(0, i), node.key, ...order.slice(i)];
      const probe = evaluate([...nodes, node], candidate, config, day.hours, roads, day.start_minute);
      if (!probe.ok) continue;
      const arrival = probe.stops.find((n) => n.key === node.key).arrival;
      const starts = new Set([Math.ceil(arrival / 5) * 5]);
      // Вторая точка: вплотную ПЕРЕД следующей остановкой, чтобы не оставлять простой перед её окном.
      const next = i < order.length ? byId.get(order[i]) : null;
      if (next) {
        const leg = legMinutes(node, next, config, roads);
        if (Number.isFinite(leg)) {
          const tight = Math.floor((next.earliest - leg - svc) / 5) * 5;
          if (tight > arrival) starts.add(tight);
        }
      }
      for (let start of starts) {
        start = Math.min(start, closes - 30);
        if (start < earliestMin) continue;
        const pinned = { ...node, earliest: start, latest: start + 30 };
        if (pinned.latest > closes) continue;
        const fit = evaluate([...nodes, pinned], candidate, config, day.hours, roads, day.start_minute);
        if (!fit.ok || fit.kg > config.capacity_kg - config.reserve_kg || fit.free_minutes < config.reserve_minutes) continue;
        const extra = fit.drive - (nodes.length ? base.drive : 0),
          waitDelta = Math.max(0, fit.wait - base.wait);
        // Цена вставки — только реальные минуты: добавленная дорога и добавленный простой.
        // Район адреса значения не имеет: CF и NP в одном дне допустимы, если они рядом.
        const idle = waitDelta * planParam(config, 'wait_weight') + (waitDelta > planParam(config, 'max_wait') ? waitDelta : 0);
        const score =
          extra + idle + (nodes.length ? 0 : planParam(config, 'empty_day_penalty')) + (late ? planParam(config, 'sla_penalty') : 0);
        result.push({
          day: day.day,
          address_id: request.id,
          start: hm(start),
          end: hm(start + 30),
          node: pinned,
          fit,
          extra_minutes: extra,
          wait_minutes: waitDelta,
          score,
          late: !!late,
        });
      }
    }
    return result.sort((a, b) => a.score - b.score || a.start.localeCompare(b.start));
  }
  const dayOptions = (work, r, config, roads, dayMode = true) =>
    work
      .flatMap((d, i) =>
        placements(d, r, config, roads, dayMode)
          .slice(0, 3)
          .map((p) => ({ ...p, score: p.score + i * planParam(config, 'day_penalty_minutes') })),
      )
      .sort((a, b) => a.score - b.score || a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
  const applyChoice = (work, chosen) => {
    const day = work.find((d) => d.day === chosen.day);
    day.nodes = day.nodes.filter((n) => n.address_id !== chosen.address_id);
    day.nodes.push(chosen.node);
    day.order = chosen.fit.order;
  };
  const removeFrom = (work, address_id) => {
    for (const d of work) {
      if (d.nodes.some((n) => n.address_id === address_id)) {
        d.nodes = d.nodes.filter((n) => n.address_id !== address_id);
        d.order = ordered(d.nodes, d.order);
        return d;
      }
    }
    return null;
  };
  function summarize(work, config, roads, assigned, unassigned) {
    const days = work.map((d) => ({ ...d, fit: evaluate(d.nodes, d.order, config, d.hours, roads, d.start_minute) }));
    const used = days.filter((d) => d.fit.ok && d.fit.stops.length);
    return {
      days,
      metrics: {
        assigned: assigned.length,
        unassigned: unassigned.length,
        days_used: used.length,
        drive: used.reduce((s, d) => s + d.fit.drive, 0),
        wait: used.reduce((s, d) => s + d.fit.wait, 0),
        switches: used.reduce((s, d) => s + d.fit.switches, 0),
        late: assigned.filter((a) => a.late).length,
        extra_drive: assigned.reduce((s, a) => s + a.extra_minutes, 0),
      },
    };
  }
  /* Соседние адреса — один интервал.
   Если от предыдущей остановки ехать считанные минуты (та же или соседняя улица),
   клиенту называется то же время: водитель делает оба адреса за один подход.
   Интервал расширяется только если пересчёт дня подтверждает, что машина успевает. */
  /* Как интервал выглядит для клиента: у подтверждённых сборов это их обещанное окно,
   у новых — подобранное. Ровно то же показывает пульт. */
  const slotKey = (n) => (n.starts_at ? ukMinute(n.starts_at) : n.earliest) + '-' + (n.ends_at ? ukMinute(n.ends_at) : n.latest);
  function sharedPairs(work) {
    let n = 0;
    for (const day of work) {
      const byKey = new Map(day.nodes.map((x) => [x.key, x]));
      for (let i = 1; i < day.order.length; i++) {
        const a = byKey.get(day.order[i - 1]),
          b = byKey.get(day.order[i]);
        if (a && b && slotKey(a) === slotKey(b)) n++;
      }
    }
    return n;
  }
  function shareSlots(work, assigned, config, roads) {
    const limit = planParam(config, 'same_slot_minutes');
    if (!(limit > 0)) return sharedPairs(work);
    const mine = new Map(assigned.map((a) => [a.address_id, a]));
    let merged = 0;
    for (const day of work) {
      const byKey = new Map(day.nodes.map((n) => [n.key, n]));
      let anchor = null;
      for (const key of day.order) {
        const n = byKey.get(key);
        if (!n) {
          anchor = null;
          continue;
        }
        const own = mine.get(n.address_id);
        if (anchor && own && own.day === day.day && (n.earliest !== anchor.earliest || n.latest !== anchor.latest)) {
          const leg = legMinutes(anchor, n, config, roads);
          if (Number.isFinite(leg) && leg <= limit && anchor.earliest <= n.earliest) {
            const trial = { ...n, earliest: anchor.earliest, latest: anchor.latest };
            const nodes = day.nodes.map((x) => (x.key === key ? trial : x));
            const fit = evaluate(nodes, day.order, config, day.hours, roads, day.start_minute);
            if (fit.ok) {
              day.nodes = nodes;
              byKey.set(key, trial);
              own.start = hm(trial.earliest);
              own.end = hm(trial.latest);
              own.node = trial;
              own.shared = true;
              merged++;
              continue;
            }
          }
        }
        anchor = n;
      }
    }
    // Считаем не правки, а результат: сколько соседних адресов делят одно окно.
    return sharedPairs(work);
  }
  async function planBatch(days, requests, config, roads, onProgress = () => {}, dayMode = true) {
    const work = days.map((d) => ({ ...d, nodes: [...d.nodes], order: ordered(d.nodes, d.order) })),
      remaining = [...requests],
      assigned = [],
      unassigned = [];
    const byId = new Map(requests.map((r) => [r.id, r]));
    // 1. Жадный проход: сначала самые ограниченные заявки (меньше вариантов), затем лучший вариант.
    while (remaining.length) {
      let best = null;
      for (const r of remaining) {
        const options = dayOptions(work, r, config, roads, dayMode);
        if (!options.length) continue;
        const choice = { request: r, options };
        if (
          !best ||
          options.length < best.options.length ||
          (options.length === best.options.length &&
            (options[0].score < best.options[0].score ||
              (options[0].score === best.options[0].score &&
                String(r.created_at || r.id) < String(best.request.created_at || best.request.id))))
        )
          best = choice;
      }
      if (!best) break;
      const chosen = best.options[0];
      applyChoice(work, chosen);
      chosen.request_token = best.request.dispatch_token;
      assigned.push(chosen);
      remaining.splice(
        remaining.findIndex((r) => r.id === chosen.address_id),
        1,
      );
      onProgress(assigned.length, requests.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // 2. Улучшение: каждую распределённую заявку пробуем переставить, если в новом контексте есть место лучше.
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let idx = 0; idx < assigned.length; idx++) {
        const a = assigned[idx],
          r = byId.get(a.address_id);
        if (!r) continue;
        removeFrom(work, a.address_id);
        const options = dayOptions(work, r, config, roads, dayMode);
        const current = options.find((o) => o.day === a.day && o.start === a.start),
          bestOpt = options[0];
        if (bestOpt && (!current || bestOpt.score < current.score - 1) && !(bestOpt.day === a.day && bestOpt.start === a.start)) {
          applyChoice(work, bestOpt);
          bestOpt.request_token = r.dispatch_token;
          assigned[idx] = bestOpt;
          improved = true;
        } else if (current) {
          applyChoice(work, current);
          current.request_token = r.dispatch_token;
          assigned[idx] = current;
        } else applyChoice(work, a);
      }
      // 3. Заявки без места пробуем ещё раз — после перестановок оно могло появиться.
      for (const r of [...remaining]) {
        const options = dayOptions(work, r, config, roads, dayMode);
        if (options.length) {
          applyChoice(work, options[0]);
          options[0].request_token = r.dispatch_token;
          assigned.push(options[0]);
          remaining.splice(remaining.indexOf(r), 1);
          improved = true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!improved) break;
    }
    const shared = shareSlots(work, assigned, config, roads);
    const from = days[0]?.day || ukDay();
    for (const r of remaining)
      unassigned.push({
        address_id: r.id,
        reason: zoneReason(config, r.text, from) || T('Нет подходящего места с учётом дороги, договорённостей и рабочих часов.'),
      });
    const out = { assigned, unassigned, ...summarize(work, config, roads, assigned, unassigned) };
    out.metrics.shared = shared;
    return out;
  }
  /* Перенос одной уже распределённой заявки на другой день внутри посчитанного плана.
   Остальные адреса не двигаются: пересчитываются только день-донор и день-получатель.
   start — «ЧЧ:ММ», если время выбрано вручную; иначе берётся лучшее место дня.
   Возвращает либо {ok:false,code}, либо новый план той же формы, что даёт planBatch. */
  function movePlanned(plan, requests, address_id, day, config, roads, start) {
    const r = (requests || []).find((x) => x.id === address_id);
    if (!r) return { ok: false, code: 'NOT_A_REQUEST' };
    if (!plan.assigned.some((a) => a.address_id === address_id)) return { ok: false, code: 'NOT_NEW' };
    const work = plan.days.map((d) => {
      const nodes = d.nodes.filter((n) => n.address_id !== address_id);
      const { fit, ...rest } = d;
      return { ...rest, nodes, order: ordered(nodes, d.order) };
    });
    const target = work.find((d) => d.day === day);
    if (!target) return { ok: false, code: 'DAY_OUT_OF_RANGE' };
    let options = placements(target, r, config, roads);
    if (start) options = options.filter((o) => o.start === start);
    if (!options.length) return { ok: false, code: start ? 'NO_ROOM_AT_TIME' : 'NO_ROOM' };
    const chosen = { ...options[0], request_token: r.dispatch_token };
    applyChoice(work, chosen);
    const assigned = plan.assigned.filter((a) => a.address_id !== address_id).concat(chosen);
    const unassigned = (plan.unassigned || []).filter((u) => u.address_id !== address_id);
    const out = { ok: true, chosen, assigned, unassigned, ...summarize(work, config, roads, assigned, unassigned) };
    out.metrics.shared = sharedPairs(work);
    return out;
  }
  /* Свободные места для адреса в конкретном дне — для переноса уже согласованных сборов,
   которые живут в базе, а не в пачке. node — узел этого адреса из плана. */
  function slotsFor(plan, node, day, config, roads, limit = 6) {
    const work = plan.days.map((d) => {
      const nodes = d.nodes.filter((n) => n.key !== node.key && !(node.address_id && n.address_id === node.address_id));
      const { fit, ...rest } = d;
      return { ...rest, nodes, order: ordered(nodes, d.order) };
    });
    const target = work.find((d) => d.day === day);
    if (!target) return [];
    const request = {
      id: node.address_id || node.key,
      text: node.text,
      lat: node.lat,
      lng: node.lng,
      service_minutes: node.service,
      estimated_kg: node.kg,
      not_before: null,
    };
    return placements(target, request, config, roads).slice(0, limit);
  }
  /* Почему в этот день нельзя поставить адрес. Считает день БЕЗ этого адреса, то есть
   отвечает «что мешает», а не «влезет ли». Нужна, чтобы в диалогах переноса писать
   настоящую причину вместо бесполезного «места нет». */
  function dayIssue(plan, node, day, config, roads) {
    const work = plan.days.map((d) => {
      const nodes = d.nodes.filter((n) => n.key !== node.key && !(node.address_id && n.address_id === node.address_id));
      const { fit, ...rest } = d;
      return { ...rest, nodes, order: ordered(nodes, d.order) };
    });
    const target = work.find((d) => d.day === day);
    if (!target) return { ok: false, code: 'DAY_OUT_OF_RANGE' };
    if (target.started_at) return { ok: false, code: 'ROUTE_STARTED' };
    if (target.hours && target.hours.closed) return { ok: false, code: 'DAY_CLOSED' };
    const rule = zoneRule(config, node.text);
    if (!rule || rule.mode === 'off') return { ok: false, code: 'ZONE_OFF' };
    const trip = tripZoneOf(config, target.day) || occupiedZoneOf(config, target);
    if (rule.mode === 'monthly' && !sameZone(trip, rule)) return { ok: false, code: 'ZONE_TRIP_DAY', zone: rule };
    if (trip && !sameZone(trip, rule)) return { ok: false, code: 'ZONE_DAY_TAKEN', zone: trip };
    const base = evaluate(target.nodes, target.order, config, target.hours, roads, target.start_minute);
    if (!base.ok) return base;
    return { ok: true, free_minutes: base.free_minutes, stops: base.stops ? base.stops.length : 0 };
  }
  function splitDelimited(text, delimiter) {
    const rows = [];
    let row = [],
      cell = '',
      quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (quoted || !cell) quoted = !quoted;
        else cell += c;
      } else if (c === delimiter && !quoted) {
        row.push(cell.trim());
        cell = '';
      } else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }
  function parseRows(text, html, source) {
    let rows = [];
    if (html && typeof DOMParser !== 'undefined') {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      rows = [...doc.querySelectorAll('tr')]
        .map((tr) => [...tr.querySelectorAll(':scope > td,:scope > th')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()))
        .filter((r) => r.length > 1);
    }
    if (!rows.length) {
      const delim = text.includes('\t')
        ? '\t'
        : text.includes(';')
          ? ';'
          : /^(?:\s*"|[^\n,]*(?:address|адрес)[^\n,]*,|[^\n]*,\s*(?:address|адрес)\s*,)/i.test(text)
            ? ','
            : null;
      rows = delim
        ? splitDelimited(text, delim)
        : text
            .split(/\r?\n/)
            .filter((s) => s.trim())
            .map((s) => [s.trim()]);
    }
    const head = rows[0] || [],
      headers = head.map((x) => x.toLowerCase());
    const named = headers.some((x) => /^(address|адрес|адреса|collection address)$/.test(x));
    if (named) rows.shift();
    return rows.map((cells, i) => {
      const all = cells.join(' | ');
      let address = '',
        name = '',
        tel = '',
        email = '',
        bags = '',
        note = '';
      if (named) {
        const get = (re) => cells[headers.findIndex((h) => re.test(h))] || '';
        address = get(/address|адрес/);
        name = get(/name|имя/);
        tel = get(/phone|mobile|телефон/);
        email = get(/email|e-mail|почта/);
        if (!email) email = (tel.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
        tel = anyPhone(tel) || tel;
        bags = get(/bags|мешк/);
        note = get(/note|comment|примеч/);
      } else {
        const index = cells.findIndex((c) => /collection from/i.test(c));
        address = index >= 0 ? cells[index].replace(/^\s*collection from\s*/i, '') : cells.find((c) => postcode(c)) || cells[0];
        if (index >= 0 && index > 0) name = cells[0];
        /* Сначала мобильный, иначе любой британский номер: стационарный тоже нужен — по нему звонят. */
        tel = (all.match(/(?:\+44\s*\(0\)|\+44|0044|0)\s*7(?:[\s().-]*\d){9}\b/) || [])[0] || anyPhone(all);
        email = (all.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
        const b = all.match(/(?:no\.?\s*of\s*bags\s*=|bags\s*[:=])\s*(\d+(?:\s*(?:to|[-–])\s*\d+)?)/i);
        bags = b?.[1] || '';
        note = cells.filter((_, j) => j !== (index >= 0 ? index : cells.indexOf(address))).join(' | ');
        if (cells.length === 1) {
          address = address.replace(tel, '').replace(email, '').replace(/\|+/g, ',').trim();
        }
      }
      return {
        row: i + 1,
        text: address.trim(),
        contact_name: name,
        phone: phone(tel),
        contact_email: email,
        bags_text: bags,
        note,
        intake_channel: source,
        estimated_kg: PLAN_DEFAULTS.estimated_kg,
        service_minutes: PLAN_DEFAULTS.service_minutes,
        not_before: null,
        raw: all,
      };
    });
  }
  /* Один и тот же дом партнёр пишет по-разному: «CF235JJ» и «CF23 5JJ», с городом и без.
   Сравнение по сырому тексту такие пары пропускает — так в очередь попал второй
   «Silver Birches». Сравниваем по индексу плюс словам адреса без индекса и города. */
  const CITY_WORDS =
    /\b(cardiff|newport|swansea|bridgend|barry|caerphilly|tredegar|pontypridd|merthyr|tydfil|blackwood|risca|penarth|cwmbran|abergavenny|wales|uk|unitedkingdom|england)\b/g;
  const placeKey = (s) => {
    const pc = postcode(s);
    if (!pc) return null;
    const body = String(s || '')
      .toLowerCase()
      .replace(new RegExp(pc.replace(' ', '\\s*'), 'i'), ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(CITY_WORDS, ' ');
    return key(pc) + '|' + body.split(/\s+/).filter(Boolean).join('');
  };
  const samePlace = (a, b) => {
    const ka = placeKey(a),
      kb = placeKey(b);
    return ka && kb ? ka === kb : key(a) === key(b);
  };
  /* Предложение «в работе»: ушло клиенту и ждёт развязки. preparing — ещё не
   отправлено, awaiting — ждём YES, manual — клиент ответил что-то другое. */
  const OFFER_LIVE = ['preparing', 'awaiting', 'manual'];
  const offerLive = (a) => !!a && OFFER_LIVE.includes(a.offer_state);
  /* Предложение, чьё время уже прошло: развязки не случилось, а обещанный
   интервал остался позади. Это верно для всех трёх состояний: и неотправленное,
   и застрявшее в ручном согласовании одинаково мертвы, когда день позади. */
  const offerExpired = (a, now) => {
    if (!offerLive(a) || !a.offered_start) return false;
    const when = now || new Date(),
      end = a.offered_end || a.offered_start;
    const today = ukDay(when),
      day = ukDay(end);
    if (day < today) return true;
    if (day > today) return false;
    return ukMinute(end) <= ukMinute(when);
  };
  /* ---------- похоже на дубль ----------
   Два партнёра присылают один и тот же дом, написанный по-разному:
   «15 Joyce Close, Gaer Newport NP203JD» и «15 Joyce Close, NP203JD».
   Для сервера это разные адреса, и обе заявки честно встают в очередь.
   Ничего не блокируем — помечаем, чтобы человек увидел пару и решил сам. */
  const houseNumber = (s) => {
    const pc = postcode(s);
    let body = pc ? String(s || '').replace(new RegExp(pc.replace(' ', '\\s*'), 'i'), ' ') : String(s || '');
    /* «Flat 2, 15 Joyce Close»: номер квартиры — не номер дома. Иначе две квартиры одного дома
       выглядели бы разными домами, а «Flat 2» и «2 Joyce Close» — одним. */
    body = body.replace(/\b(?:flat|apartment|apt|unit|room|floor)\s*\d+[a-z]?\b/gi, ' ');
    const m = body.match(/\b(\d{1,4})\s*[a-z]?\b/i);
    return m ? m[1] : '';
  };
  const DUP_WHY = { house: T('тот же дом'), tel: T('тот же телефон') };
  /* Порядок важен: если пара совпала и по дому, и по телефону, показываем
   более сильную причину — дом.
   Только индекс приметой НЕ считаем: в одном индексе живёт полтора десятка
   домов, и такая пометка была бы шумом, а шуму перестают верить. */
  const DUP_ORDER = ['house', 'tel'];
  const dupKeys = (a) => {
    const out = [];
    const p = phone((a && a.phone) || '');
    if (p.replace(/\D/g, '').length >= 10) out.push('tel|' + p);
    const pc = postcode((a && a.text) || ''),
      n = pc ? houseNumber((a && a.text) || '') : '';
    if (pc && n) out.push('house|' + key(pc) + '|' + n);
    return out;
  };
  /* Какая из пары лишняя. В очереди остаётся та, что пришла первой. Если двойник
   уже в работе — в плане или в маршруте, — то лишней считается та, что в очереди:
   ехать второй раз некуда. */
  function duplicateExtras(requests, existing) {
    const notes = duplicateNotes(requests, existing);
    const all = new Map();
    (requests || []).concat(existing || []).forEach((a) => {
      if (a && a.id && !all.has(a.id)) all.set(a.id, a);
    });
    const inQueue = new Set((requests || []).filter(Boolean).map((a) => a.id));
    const older = (x, y) => {
      const a = String(x.created_at || ''),
        b = String(y.created_at || '');
      return a === b ? String(x.id) < String(y.id) : a < b;
    };
    const out = new Set();
    (requests || []).forEach((r) => {
      if (!r || !r.id) return;
      const twins = (notes.get(r.id) || []).map((t) => all.get(t.id)).filter(Boolean);
      if (twins.some((t) => !inQueue.has(t.id) || older(t, r))) out.add(r.id);
    });
    return out;
  }
  function duplicateNotes(requests, existing) {
    const pool = [],
      seen = new Set();
    const take = (a) => {
      if (!a || !a.id || seen.has(a.id)) return;
      if (['cancelled', 'done'].includes(a.status)) return;
      seen.add(a.id);
      pool.push(a);
    };
    (requests || []).forEach(take);
    (existing || []).forEach(take);
    const buckets = new Map();
    pool.forEach((a) =>
      dupKeys(a).forEach((k) => {
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(a);
      }),
    );
    const out = new Map();
    DUP_ORDER.forEach((kind) =>
      buckets.forEach((rows, k) => {
        if (k.split('|')[0] !== kind || rows.length < 2) return;
        rows.forEach((a) =>
          rows.forEach((b) => {
            if (a.id === b.id) return;
            const list = out.get(a.id) || [];
            if (list.some((x) => x.id === b.id)) return;
            list.push({ id: b.id, text: b.text, status: b.status, why: DUP_WHY[kind] });
            out.set(a.id, list);
          }),
        );
      }),
    );
    return out;
  }
  /* Замечания, которые НЕ мешают добавить заявку: один номер на два разных дома
   бывает по делу (заказ для себя и для матери). Показываем и пропускаем. */
  function warnings(row, existing = [], previous = []) {
    const out = [];
    const p = phone(row.phone);
    /* Нет мобильного — не причина выбросить заявку: у партнёра попадаются
    стационарные номера и строки с одной только почтой. Раньше такие терялись. */
    if (['subnex_website', 'partner_email'].includes(row.intake_channel) && !/^\+447\d{9}$/.test(p))
      out.push(
        p
          ? T('Это не британский мобильный — SMS не уйдёт, связывайтесь по email.')
          : T('Телефона нет — SMS не уйдёт, связывайтесь по email.'),
      );
    if (!p) return out;
    const twin = (existing || []).find(
      (a) => ['new', 'planned'].includes(a.status) && phone(a.phone) === p && !samePlace(a.text, row.text),
    );
    if (twin)
      out.push(T('Этот номер уже у заявки «') + twin.text + T('». Если это другой дом — всё в порядке, предложения уйдут по очереди.'));
    else if ((previous || []).some((a) => phone(a.phone) === p && !samePlace(a.text, row.text)))
      out.push(T('Этот номер уже есть выше в этой пачке — проверьте, не один ли это дом.'));
    return out;
  }
  function issues(row, existing = [], previous = []) {
    const out = [];
    const pc = postcode(row.text);
    if (!pc || key(row.text).replace(key(pc), '').length < 3) out.push(T('Нужны дом, улица и полный postcode'));
    if (/^(?:collection from\s*)?\d+\s*,?\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(row.text)) out.push(T('Не указана улица'));
    if (
      /^\d+[a-z]?\s*,?\s*(?:Cardiff|Newport|Barry|Bridgend|Caerphilly|Tredegar|Pontypridd|Wales)\s*,?\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(
        row.text,
      )
    )
      out.push(T('Не указана улица'));
    if (!sourceNames[row.intake_channel]) out.push(T('Выберите источник'));
    if (!Number.isFinite(+row.estimated_kg) || +row.estimated_kg <= 0) out.push(T('Укажите ожидаемый вес'));
    if (![5, 10].includes(+row.service_minutes)) out.push(T('Сбор: 5 или 10 минут'));
    if (previous.some((a) => samePlace(a.text, row.text))) out.push(T('Повтор в этой пачке'));
    const twin = existing.find((a) => ['new', 'planned'].includes(a.status) && samePlace(a.text, row.text));
    if (twin)
      out.push(
        key(twin.text) === key(row.text)
          ? T('Адрес уже есть в действующих заявках')
          : T('Это тот же дом, что и «') + twin.text + T('» — заявка на него уже есть'),
      );
    return out;
  }
  root.SubnexDispatchCore = {
    sourceNames,
    sourceOf,
    brandOf,
    templateSource,
    postcode,
    key,
    phone,
    anyPhone,
    isUkMobile,
    UK_MOBILE,
    hm,
    minute,
    ukDay,
    ukMinute,
    pointKey,
    validPoint,
    zone,
    evaluate,
    ordered,
    optimizeOrder,
    isDayWindow,
    isDaySpan,
    enShortDate,
    dayOfferText,
    placements,
    planBatch,
    shareSlots,
    parseRows,
    issues,
    warnings,
    samePlace,
    placeKey,
    duplicateNotes,
    duplicateExtras,
    offerExpired,
    offerLive,
    houseNumber,
    dayIssue,
    PLAN_DEFAULTS,
    postcodeArea,
    zoneRule,
    zoneKey,
    zoneTripDay,
    tripZoneOf,
    occupiedZoneOf,
    activeZones,
    postcodeNumber,
    sameZone,
    movePlanned,
    slotsFor,
    nextTripDays,
    zoneReason,
    nthWeekday,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SubnexDispatchCore;
})(typeof window === 'undefined' ? globalThis : window);
