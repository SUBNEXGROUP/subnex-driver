/* Поддельный Supabase для дымовой проверки в браузере. Подменяет CDN-скрипт supabase-js.
   Хранит данные в памяти, отвечает на те же RPC и edge-функции, что и настоящий сервер,
   и пишет журнал вызовов в window.__calls — по нему проверяется, что клиент делает. */
(function () {
  'use strict';
  const calls = (window.__calls = []);
  const log = (kind, name, data) => calls.push({ kind, name, data: JSON.parse(JSON.stringify(data ?? null)) });
  const C = () => window.SubnexDispatchCore;
  const today = () => C().ukDay();
  const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const iso = (day, hm) => new Date(day + 'T' + hm + ':00+01:00').toISOString();
  const role = window.__role || 'admin';
  const DRIVER = { id: 'd1', name: 'Kostia', active: true, created_at: '2026-08-01T00:00:00Z' };
  const HOME = { text: 'Abertillery NP13 1DF', lat: 51.73, lng: -3.13 },
    DEPOT = { text: 'CF43 4SX', lat: 51.66, lng: -3.44 };
  const banks = [{ id: 'bk1', name: 'Glyncoch Community Centre', text: 'Pontypridd CF37 3DA', note: '', active: true, rate_type: 'fixed', rate_value: 50, contact_name: 'Lyndon', contact_email: 'l@x.org', show_weights: true, lat: 51.62, lng: -3.33, created_at: '2026-08-01T00:00:00Z' }];
  const photos = [];
  const hours = { week: [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ weekday: wd, opens: '08:00:00', closes: '18:00:00', closed: wd === 0 })), days: [] };
  const config = { home: HOME, depot: DEPOT, capacity_kg: 1600, reserve_kg: 0, reserve_minutes: 0, travel_factor: 1.2, leg_buffer_minutes: 5, zone_penalty_minutes: 0, day_penalty_minutes: 2 };
  const started = {};
  const holds = {};
  const tables = { addresses: [], banks, photos, drivers: [DRIVER], driver_locations: [], sms_inbox: [] };
  const A = (id, o) => ({
    id,
    text: '',
    bags: 0,
    phone: '',
    note: '',
    date: null,
    lat: null,
    lng: null,
    geocode_source: 'postcode',
    status: 'new',
    collection_start: null,
    collection_end: null,
    collection_version: 1,
    collection_source: 'partner',
    driver_id: 'd1',
    kind: 'd2d',
    bank_id: null,
    fill_level: null,
    estimated_kg: 10,
    service_minutes: 5,
    intake_channel: 'partner_email',
    bags_text: '4 to 6',
    not_before: null,
    charity: 'Shelter Cymru',
    result_note: '',
    done_at: null,
    created_at: '2026-09-15T10:00:00Z',
    cancelled_date: null,
    cancellation_reason: null,
    collection_cancelled_at: null,
    duplicate_ignored: false,
    ...o,
  });
  let T, Y, TM, addresses, zones, threads, booted = false;
  /* Фикстура с датами собирается при первом обращении: ядро (SubnexDispatchCore) грузится позже этого файла. */
  function boot() {
    if (booted) return;
    booted = true;
    T = today();
    Y = addDays(T, -1);
    TM = addDays(T, 1);
    addresses = tables.addresses;
    addresses.push(
      A('a1', { text: '15 Joyce Close, Newport NP20 3JD', phone: '07700900001', lat: 51.58, lng: -3.02, date: T, status: 'planned', collection_start: iso(T, '09:00'), collection_end: iso(T, '09:30') }),
      A('a2', { text: '3 Station Road, Cardiff CF10 1AA', phone: '07700900002', lat: 51.48, lng: -3.17, date: T, status: 'planned', collection_start: iso(T, '10:30'), collection_end: iso(T, '11:00'), collection_source: 'subnex', intake_channel: 'subnex_website' }),
      A('a3', { text: '20 Windsor Place, Abertridwr CF83 4DR', phone: '+44 (0)7700 900003', lat: 51.6, lng: -3.27, created_at: '2026-09-18T09:00:00Z' }),
      A('a4', { text: '9 Dan Y Gollen, Crickhowell NP8 1TN', phone: '01873 123456', lat: 51.86, lng: -3.14, created_at: '2026-09-18T10:00:00Z' }),
      A('a5', { text: '10 Bridgewater Road, Sully CF64 5RE', phone: '07700900005', lat: 51.4, lng: -3.2, created_at: '2026-09-18T11:00:00Z' }),
      A('a6', { text: '7 Park Lane, Barry CF62 6QH', phone: '07700900006', lat: 51.41, lng: -3.28, date: Y, status: 'done', done_at: Y + 'T12:00:00Z', collection_start: iso(Y, '12:00'), collection_end: iso(Y, '12:30') }),
      A('a7', { text: '2 Day Street, Newport NP20 1AB', phone: '07700900007', lat: 51.585, lng: -3.0, date: T, status: 'planned', arrival_mode: 'day', collection_start: iso(T, '08:00'), collection_end: iso(T, '18:00'), collection_source: 'subnex', intake_channel: 'subnex_website' }),
      A('a8', { text: '5 Auto Road, Newport NP20 5EE', phone: '07700900008', lat: 51.59, lng: -2.995, created_at: '2026-09-18T12:00:00Z', arrival_mode: 'day' }),
      A('b1', { text: 'Glyncoch Community Centre — Pontypridd CF37 3DA', kind: 'bank', bank_id: 'bk1', lat: 51.62, lng: -3.33, date: T, status: 'planned', collection_source: null, intake_channel: null, charity: null, bags_text: null, geocode_source: 'osm' }),
    );
    zones = [
      { code: 'CF', prefix: 'CF', num_from: 0, num_to: 99, name: 'Кардифф', mode: 'regular' },
      { code: 'NP', prefix: 'NP', num_from: 0, num_to: 99, name: 'Ньюпорт', mode: 'regular' },
      { code: 'BS', prefix: 'BS', num_from: 0, num_to: 99, name: 'Бристоль', mode: 'monthly', weekday: 4, week_of_month: 5, dates: [C().nthWeekday(T, 4, 5)] },
    ];
    holds['a8'] = { id: 'h-auto', address_id: 'a8', day: addDays(T, 2), start: '08:00', end: '18:00', offer_state: 'awaiting', offered: true, auto: true };
    threads = [{ id: 't1', phone: '+447700900003', address_id: 'a3', address: addresses[2].text, last_body: 'Hi', last_activity: new Date().toISOString(), needs_attention: false, driver_id: 'd1', opted_out: false, manual_mode: false, active_offer_id: null, offer_state: null, date: null }];
  }
  const messages = [{ id: 'm1', direction: 'out', body: 'Hello', status: 'delivered', created_at: new Date().toISOString(), num_media: 0 }];

  /* ---- фильтрующий конструктор запросов ---- */
  const matchOr = (row, expr) =>
    expr.split(',').some((part) => {
      const m = part.match(/^([a-z_]+)\.(in|gte|lte|eq|gt|lt)\.(.*)$/);
      if (!m) return false;
      const [, col, op, val] = m,
        v = row[col];
      if (op === 'in') return val.replace(/[()]/g, '').split(',').includes(String(v));
      if (v == null) return false;
      if (op === 'gte') return String(v) >= val;
      if (op === 'lte') return String(v) <= val;
      if (op === 'gt') return String(v) > val;
      if (op === 'lt') return String(v) < val;
      return String(v) === val;
    });
  function builder(table) {
    boot();
    const rows = tables[table] || [];
    const q = { filters: [], op: 'select', payload: null, limitN: null, single: false };
    const chain = {
      select(cols) {
        if (q.op === 'select') q.cols = cols;
        q.returning = true;
        return chain;
      },
      insert(p) {
        q.op = 'insert';
        q.payload = p;
        return chain;
      },
      update(p) {
        q.op = 'update';
        q.payload = p;
        return chain;
      },
      upsert(p) {
        q.op = 'upsert';
        q.payload = p;
        return chain;
      },
      delete() {
        q.op = 'delete';
        return chain;
      },
      eq(c, v) {
        q.filters.push((r) => String(r[c]) === String(v));
        return chain;
      },
      is(c, v) {
        q.filters.push((r) => r[c] === v);
        return chain;
      },
      gte(c, v) {
        q.filters.push((r) => r[c] != null && String(r[c]) >= v);
        return chain;
      },
      lt(c, v) {
        q.filters.push((r) => r[c] != null && String(r[c]) < v);
        return chain;
      },
      or(expr) {
        q.filters.push((r) => matchOr(r, expr));
        return chain;
      },
      order() {
        return chain;
      },
      limit(n) {
        q.limitN = n;
        return chain;
      },
      single() {
        q.single = true;
        return chain;
      },
      then(res, rej) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    function run() {
      const hit = rows.filter((r) => q.filters.every((f) => f(r)));
      log('table', table + '.' + q.op, q.payload);
      if (q.op === 'select') {
        let out = q.limitN ? hit.slice(0, q.limitN) : hit;
        return { data: q.single ? out[0] || null : out, error: null };
      }
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        list.forEach((p) => rows.push({ ...p }));
        return { data: list.map((p) => ({ id: p.id })), error: null };
      }
      if (q.op === 'update') {
        hit.forEach((r) => Object.assign(r, q.payload));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      if (q.op === 'upsert') {
        const i = rows.findIndex((r) => r.id === q.payload.id);
        if (i >= 0) Object.assign(rows[i], q.payload);
        else rows.push({ ...q.payload });
        return { data: [{ id: q.payload.id }], error: null };
      }
      if (q.op === 'delete') {
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
    }
    return chain;
  }

  /* ---- планировщик на сервере: дни, узлы, проверка ---- */
  const dayHours = (day) => {
    const wd = new Date(day + 'T12:00:00Z').getUTCDay();
    const h = hours.week.find((x) => x.weekday === wd);
    return { opens: h.opens.slice(0, 5), closes: h.closes.slice(0, 5), closed: h.closed };
  };
  const nodesOf = (day) =>
    addresses
      .filter((a) => a.date === day && ['planned', 'new'].includes(a.status) && a.collection_start)
      .map((a) => ({
        key: 'a:' + a.id,
        address_id: a.id,
        text: a.text,
        lat: a.lat,
        lng: a.lng,
        earliest: C().ukMinute(a.collection_start),
        latest: C().ukMinute(a.collection_end),
        starts_at: a.collection_start,
        ends_at: a.collection_end,
        service: a.service_minutes || 5,
        kg: a.estimated_kg || 10,
        kind: 'confirmed',
      }))
      .concat(
        Object.values(holds)
          .filter((h) => h.day === day)
          .map((h) => {
            const a = addresses.find((x) => x.id === h.address_id);
            return { key: 'a:' + a.id, address_id: a.id, text: a.text, lat: a.lat, lng: a.lng, earliest: C().minute(h.start), latest: C().minute(h.end), service: 5, kg: 10, kind: 'hold' };
          }),
      );
  const roadsAll = () => {
    const pts = [HOME, DEPOT, ...addresses.filter((a) => a.lat != null)];
    const out = {};
    for (const a of pts)
      for (const b of pts) {
        const k = C().pointKey(a) + '>' + C().pointKey(b);
        const d = Math.hypot(a.lat - b.lat, (a.lng - b.lng) * 0.62) * 111;
        out[k] = Math.round((d / 40) * 3600);
      }
    return out;
  };
  const orders = {},
    etas = {};
  const autoPlan = { enabled: false, day_capacity: 40, horizon_days: 14, near_km: 6, reminder_hours: 24, close_hours: 48, sms_from_hour: 8, sms_to_hour: 20, eta_window_minutes: 60, lead_days: 2, last_run_at: null, last_run_note: null };
  const dayState = (day) => {
    const nodes = nodesOf(day),
      order = C().ordered(nodes, orders[day] || []);
    const fit = C().evaluate(nodes, order, config, dayHours(day), roadsAll(), started[day] ? 0 : 0);
    return { enabled: true, day, started_at: started[day] || null, nodes, order, hours: dayHours(day), config, token: 'tok-' + day + '-' + nodes.length, fit: { ...fit, nodes, config }, eta: etas[day] || {} };
  };
  const queueRow = (a) => ({
    ...a,
    hold_id: holds[a.id]?.id || null,
    held_start: holds[a.id] ? iso(holds[a.id].day, holds[a.id].start) : null,
    held_end: holds[a.id] ? iso(holds[a.id].day, holds[a.id].end) : null,
    offer_state: holds[a.id]?.offer_state || null,
    offered_start: holds[a.id]?.offered ? iso(holds[a.id].day, holds[a.id].start) : null,
    offered_end: holds[a.id]?.offered ? iso(holds[a.id].day, holds[a.id].end) : null,
    offer_auto: holds[a.id]?.auto || false,
    offer_attempts: holds[a.id]?.auto ? 1 : 0,
    offer_first_at: holds[a.id]?.auto ? new Date(Date.now() - 3600e3).toISOString() : null,
    reminded_at: null,
    dispatch_token: 'dt-' + a.id,
  });

  function dispatch(action, d) {
    log('rpc', 'subnex_dispatch.' + action, d);
    switch (action) {
      case 'settings':
        return { enabled: true, driver_id: 'd1', config };
      case 'queue':
        return {
          enabled: true,
          config,
          requests: addresses.filter((a) => a.status === 'new' && !a.date && a.kind !== 'bank').map(queueRow),
          legacy: [],
          auto_plan: { enabled: autoPlan.enabled, last_run_at: autoPlan.last_run_at, last_run_note: autoPlan.last_run_note, close_hours: autoPlan.close_hours, reminder_hours: autoPlan.reminder_hours, day_capacity: autoPlan.day_capacity },
        };
      case 'auto_plan_settings':
        return { config: { ...autoPlan }, auto_sms_enabled: true, queue_geocoding: 0 };
      case 'save_auto_plan':
        Object.assign(autoPlan, d.config);
        return { config: { ...autoPlan } };
      case 'auto_plan_run':
        autoPlan.last_run_at = new Date().toISOString();
        autoPlan.last_run_note = 'offered 0, held 0, skipped 0';
        return autoPlan.enabled ? { enabled: true, offered: 0, held: 0, skipped: 0, expired: 0, followups: { reminded: 0, closed: 0 } } : { enabled: false };
      case 'reorder':
        orders[d.day] = d.order;
        return { ok: true };
      case 'snapshot': {
        const days = [];
        for (let i = 0; i < d.days; i++) {
          const day = addDays(d.from_day, i);
          days.push({ day, hours: dayHours(day), nodes: nodesOf(day), order: [], started_at: started[day] || null, start_minute: 0, token: 'tok-' + day });
        }
        return { config, days, requests: addresses.filter((a) => d.address_ids.includes(a.id)).map(queueRow) };
      }
      case 'day':
        return dayState(d.day);
      case 'check':
        return {};
      case 'start': {
        started[d.day] = new Date().toISOString();
        if (Array.isArray(d.order)) orders[d.day] = d.order;
        const st = dayState(d.day);
        etas[d.day] = {};
        let n = 0;
        if (st.fit.ok)
          for (const stop of st.fit.stops) {
            const a = addresses.find((x) => x.id === stop.address_id);
            if (!a || a.kind === 'bank') continue;
            const from = a.arrival_mode === 'day' ? Math.max(480, Math.floor((stop.arrival - 15) / 5) * 5) : C().ukMinute(a.collection_start);
            etas[d.day][a.id] = { from, to: a.arrival_mode === 'day' ? from + 60 : C().ukMinute(a.collection_end), state: 'accepted' };
            n++;
          }
        return { started: true, eta_sent: n };
      }
      case 'reserve_plan':
        d.assignments.forEach((x, i) => (holds[x.address_id] = { id: 'h' + i, address_id: x.address_id, day: x.day, start: x.start, end: x.end }));
        return { reserved: d.assignments.length };
      case 'edit_request': {
        const a = addresses.find((x) => x.id === d.address_id);
        Object.assign(a, d);
        return {};
      }
      case 'import':
        d.rows.forEach((r, i) => addresses.push(A('imp' + Date.now() + i, { ...r, created_at: new Date().toISOString() })));
        return { imported: d.rows.length, ids: d.rows.map((_, i) => 'imp' + i) };
      case 'release':
        delete holds[d.address_id];
        return {};
      case 'share':
        return {};
      case 'confirm_partner': {
        const h = holds[d.address_id],
          a = addresses.find((x) => x.id === d.address_id);
        Object.assign(a, { date: h.day, status: 'planned', collection_start: iso(h.day, h.start), collection_end: iso(h.day, h.end) });
        delete holds[d.address_id];
        return {};
      }
      case 'road_context':
        return { config, days: [{ nodes: nodesOf(d.from_day) }], requests: addresses.filter((a) => d.address_ids.includes(a.id)) };
      case 'save_settings':
        Object.assign(config, d.config);
        return { config };
      default:
        throw new Error('MOCK_UNKNOWN_' + action);
    }
  }
  function sms(action, d) {
    log('edge', 'subnex-sms.' + action, d);
    switch (action) {
      case 'profile':
        return { user_id: 'u1', email: 'info@subnex.co.uk', role, driver_id: 'd1', driver_name: 'Kostia' };
      case 'list':
        return { threads };
      case 'detail':
        return { thread: threads[0], address: addresses.find((a) => a.id === 'a3'), offer: null, messages };
      case 'hours':
        return hours;
      case 'members':
        return { members: [{ email: 'info@subnex.co.uk', role: 'admin', active: true, driver_id: 'd1' }] };
      case 'create':
        return { thread_id: 't1' };
      case 'send':
        if (d.kind === 'offer') holds[d.thread_id === 't1' ? 'a3' : 'a3'] = { ...(holds['a3'] || { id: 'hx', address_id: 'a3', day: d.day, start: d.start, end: d.end }), offer_state: 'awaiting', offered: true };
        messages.push({ id: 'm' + messages.length, direction: 'out', body: d.body, status: 'queued', created_at: new Date().toISOString(), num_media: 0 });
        return { message: { id: 'mx', status: 'queued' } };
      case 'read':
      case 'save_hours':
      case 'save_member':
      case 'assign':
      case 'legacy_date':
      case 'confirm':
        return {};
      default:
        throw new Error('MOCK_UNKNOWN_' + action);
    }
  }
  function routing(body) {
    log('edge', 'subnex-routing.' + body.action, body);
    if (body.action === 'health') return { ok: true, provider: 'openrouteservice', enabled: true };
    if (body.action === 'matrix') return { roads: roadsAll(), provider: 'openrouteservice' };
    const st = dayState(body.day);
    const byId = new Map(st.nodes.map((n) => [n.key, n]));
    const pts = [config.home, ...st.order.map((k) => byId.get(k)), config.depot];
    return { geometry: pts.map((p) => [p.lat, p.lng]), km: 42.5, min: 75, order: st.order.map((k) => k.slice(2)), token: st.token, provider: 'openrouteservice' };
  }
  const client = {
    auth: {
      signInWithPassword: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }),
      getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
    },
    from: builder,
    rpc: async (name, args) => {
      boot();
      try {
        if (name === 'subnex_dispatch') return { data: dispatch(args.p_action, args.p_data), error: null };
        if (name === 'subnex_zones') {
          log('rpc', 'subnex_zones.' + args.p_action, args.p_data);
          return { data: { zones }, error: null };
        }
        if (name === 'subnex_intake_admin') return { data: { tokens: [{ id: 'tk1', name: 'Почта партнёра', active: true, tail: 'f3b', driver: 'Kostia', used_count: 12, created_rows: 30, last_used_at: new Date().toISOString() }], recent: [] }, error: null };
        if (name === 'subnex_reports') return { data: { totals: [] }, error: null };
        if (name === 'subnex_move_request') {
          log('rpc', 'subnex_move_request', args.p_data);
          return { data: {}, error: null };
        }
        if (name === 'subnex_close_collection_notified') return { data: { id: 'c1', notification: { state: 'pending' } }, error: null };
        return { data: null, error: { message: 'MOCK_UNKNOWN_RPC_' + name, code: 'PGRST202' } };
      } catch (e) {
        return { data: null, error: { message: e.message, code: 'P0001' } };
      }
    },
    functions: {
      invoke: async (name, { body }) => {
        boot();
        try {
          if (name === 'subnex-sms') return { data: sms(body.action, body.data), error: null };
          if (name === 'subnex-routing') return { data: routing(body), error: null };
          return { data: null, error: new Error('MOCK_UNKNOWN_FN_' + name) };
        } catch (e) {
          return { data: { error: e.message }, error: null };
        }
      },
    },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel() {},
    removeAllChannels() {},
    storage: {
      from: () => ({
        createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'data:,x' })), error: null }),
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  };
  window.supabase = { createClient: () => client };
  window.__mock = { get addresses() { boot(); return addresses; }, holds, started, tables };
})();
