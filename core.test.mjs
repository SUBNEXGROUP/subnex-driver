/* Проверки чистых функций ядра. Запуск: node _test/core.test.mjs
   Без браузера и без сети. Каждая проверка — одна строка «ok» или «FAIL». */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const C = require(path.join(here, '..', 'ops-dispatch-core.js'));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`));
};

/* ---------- телефон ---------- */
eq('phone 07446 932887', C.phone('07446 932887'), '+447446932887');
eq('phone +44 (0)7446932887', C.phone('+44 (0)7446932887'), '+447446932887');
eq('phone +44 (0) 7446 932 887', C.phone('+44 (0) 7446 932 887'), '+447446932887');
eq('phone 0044 7446932887', C.phone('0044 7446932887'), '+447446932887');
eq('phone 447446932887', C.phone('447446932887'), '+447446932887');
eq('phone 01443 123456 (стационарный) остаётся', C.phone('01443 123456'), '01443123456');
eq('phone пусто', C.phone(''), '');

/* ---------- номер дома ---------- */
eq('houseNumber простой', C.houseNumber('15 Joyce Close NP203JD'), '15');
eq('houseNumber Flat 2, 15 X', C.houseNumber('Flat 2, 15 Joyce Close, Newport NP20 3JD'), '15');
eq('houseNumber Unit 3 7 X', C.houseNumber('Unit 3, 7 Station Road, Cardiff CF10 1AA'), '7');
eq('houseNumber 12a', C.houseNumber('12a High Street CF10 1AA'), '12');
eq('houseNumber без номера', C.houseNumber('Silver Birches, Ty Gwyn Avenue CF23 5JJ'), '');

/* ---------- один дом ---------- */
eq('samePlace индекс слитно/раздельно', C.samePlace('Silver birches, Ty gwyn avenue CF235JJ', 'Silver Birches, Ty Gwyn Avenue, Cardiff, CF23 5JJ'), true);
eq('samePlace разные дома', C.samePlace('15 Joyce Close NP20 3JD', '17 Joyce Close NP20 3JD'), false);

/* ---------- разбор вставленной таблицы ---------- */
const rows = C.parseRows('John Smith\tCollection for Shelter\tCollection from 20 Windsor Place, Abertridwr CF83 4DR\t01443 123456\tNo of bags = 4 to 6', '', 'partner_email');
eq('parseRows адрес', rows[0].text, '20 Windsor Place, Abertridwr CF83 4DR');
eq('parseRows стационарный номер сохраняется', rows[0].phone, '01443123456');
eq('parseRows имя', rows[0].contact_name, 'John Smith');
eq('parseRows мешки', rows[0].bags_text, '4 to 6');
const rows2 = C.parseRows('Ann Lee\tCollection for No preference\tCollection from 9 Dan Y Gollen, Crickhowell NP8 1TN\t07700 900123\tNo of bags = 3', '', 'partner_email');
eq('parseRows мобильный', rows2[0].phone, '+447700900123');
const rows3 = C.parseRows('address,phone,bags\n"1 Test St, Cardiff CF10 1AA",+44 (0)7700 900123,4', '', 'partner_whatsapp');
eq('parseRows CSV с заголовком, +44 (0)', rows3[0].phone, '+447700900123');

/* ---------- замечания и ошибки ---------- */
eq('issues: полный адрес ок', C.issues({ text: '1 Test St, Cardiff CF10 1AA', intake_channel: 'partner_email', estimated_kg: 10, service_minutes: 5 }), []);
eq('issues: нет улицы', C.issues({ text: '4, Cardiff CF54TN', intake_channel: 'partner_email', estimated_kg: 10, service_minutes: 5 }).length > 0, true);
eq('warnings: стационарный', C.warnings({ text: '1 Test St CF10 1AA', phone: '01443 123456', intake_channel: 'partner_email' }).length, 1);
eq('warnings: мобильный без замечаний', C.warnings({ text: '1 Test St CF10 1AA', phone: '07700 900123', intake_channel: 'partner_email' }).length, 0);

/* ---------- план без day_penalty_minutes в конфиге ---------- */
const cfg = { home: { lat: 51.7, lng: -3.1 }, depot: { lat: 51.6, lng: -3.4 }, travel_factor: 1.2, leg_buffer_minutes: 5, capacity_kg: 1600, zones: [{ prefix: 'CF', code: 'CF', mode: 'regular' }] };
const day = d => ({ day: d, hours: { opens: '08:00', closes: '16:00' }, nodes: [], order: [], start_minute: 0 });
const req = { id: 'r1', text: '1 Test St, Cardiff CF10 1AA', lat: 51.48, lng: -3.17, created_at: '2026-09-19T10:00:00Z' };
const k = (a, b) => C.pointKey(a) + '>' + C.pointKey(b);
const roads = { [k(cfg.home, req)]: 1800, [k(req, cfg.depot)]: 1800 };
const plan = await C.planBatch([day('2026-09-22'), day('2026-09-23')], [req], cfg, roads);
eq('planBatch: заявка распределена', plan.assigned.length, 1);
eq('planBatch: score — число', Number.isFinite(plan.assigned[0].score), true);
eq('planBatch: первый день предпочтительнее', plan.assigned[0].day, '2026-09-22');

/* ---------- окна и срок ---------- */
eq('offerExpired: неотправленное вчера — мёртвое', C.offerExpired({ offer_state: 'preparing', offered_start: '2026-09-18T09:00:00Z', offered_end: '2026-09-18T09:30:00Z' }, new Date('2026-09-19T00:00:00Z')), true);
eq('offerExpired: завтра — живое', C.offerExpired({ offer_state: 'awaiting', offered_start: '2026-09-20T09:00:00Z', offered_end: '2026-09-20T09:30:00Z' }, new Date('2026-09-19T00:00:00Z')), false);

/* ---------- зоны ---------- */
const zones = [{ prefix: 'SA', code: 'SA1-13', num_from: 1, num_to: 13, mode: 'monthly', weekday: 3, week_of_month: 5, name: 'Суонси' },
  { prefix: 'SA', code: 'SA14-99', num_from: 14, num_to: 99, mode: 'monthly', weekday: 2, week_of_month: 5, name: 'Запад' }];
eq('zoneRule SA43 → запад', C.zoneRule({ zones }, 'Cardigan SA43 1EJ').code, 'SA14-99');
eq('zoneRule SA1 → Суонси', C.zoneRule({ zones }, 'Swansea SA1 3AB').code, 'SA1-13');
eq('nthWeekday последний четверг сентября 2026', C.nthWeekday('2026-09-01', 4, 5), '2026-09-24');


/* ---------- порядок остановок ---------- */
{
  const cfg = { home: { lat: 51.7, lng: -3.1 }, depot: { lat: 51.7, lng: -3.05 }, travel_factor: 1, leg_buffer_minutes: 0, capacity_kg: 1600 };
  const hours = { opens: '08:00', closes: '18:00', closed: false };
  // Четыре точки на прямой к востоку от дома; исходный порядок — вразнобой.
  const pts = [0.01, 0.02, 0.03, 0.04].map((d, i) => ({ key: 'a' + i, address_id: 'a' + i, text: 'A' + i, lat: 51.7, lng: -3.1 + d, earliest: 480, latest: 1080, service: 5, kg: 10, kind: 'confirmed' }));
  const all = [cfg.home, cfg.depot, ...pts];
  const roads = {};
  for (const a of all) for (const b of all) roads[C.pointKey(a) + '>' + C.pointKey(b)] = Math.abs(a.lng - b.lng) * 100000;
  const bad = ['a3', 'a0', 'a2', 'a1'];
  const r = C.optimizeOrder(pts, bad, cfg, hours, roads, 470);
  eq('optimizeOrder: порядок выпрямлен', r.order, ['a0', 'a1', 'a2', 'a3']);
  eq('optimizeOrder: дорога короче', r.fit.drive < C.evaluate(pts, bad, cfg, hours, roads, 470).drive, true);
  // Узкое окно 08:57–09:10 у a3 — оптимизатор его соблюдает (a3 идёт вторым: короче, чем первым).
  const fixed = pts.map((p) => (p.key === 'a3' ? { ...p, earliest: 537, latest: 550 } : p));
  const r2 = C.optimizeOrder(fixed, ['a3', 'a0', 'a1', 'a2'], cfg, hours, roads, 470);
  eq('optimizeOrder: окно соблюдено', [r2.fit.ok, r2.fit.stops.find((x) => x.key === 'a3').arrival <= 550, r2.fit.drive < 185], [true, true, true]);
  eq('isDayWindow день', C.isDayWindow({ earliest: 480, latest: 1080 }, hours), true);
  eq('isDayWindow 30 мин', C.isDayWindow({ earliest: 600, latest: 630 }, hours), false);
}
{
  eq('enShortDate', C.enShortDate('2026-09-23'), 'Wed 23 Sep');
  eq(
    'dayOfferText = day_offer_v1',
    C.dayOfferText('partner', '2026-09-23', 'Kostia'),
    'Hi, this is Kostia from We Recycle Clothes. We can collect your clothing donation on Wed 23 Sep. Reply YES to confirm - we will text you a 1-hour arrival window on the day. If that day does not suit, just reply and tell us.',
  );
  eq('dayOfferText subnex без имени', C.dayOfferText('subnex', '2026-10-01', '').slice(0, 60), 'Hi, this is SUBNEX. We can collect your clothing donation on');
  eq('isDaySpan день', C.isDaySpan('2026-09-23T07:00:00+00:00', '2026-09-23T17:00:00+00:00'), true);
  eq('isDaySpan 30 мин', C.isDaySpan('2026-09-23T10:00:00+00:00', '2026-09-23T10:30:00+00:00'), false);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
