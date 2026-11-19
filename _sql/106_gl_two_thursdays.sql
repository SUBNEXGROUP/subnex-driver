-- 106. Gloucestershire (GL) twice a month, like Bath (19.11.2026).
--
-- Kostia: "GL — два дня, по такому же принципу, как BA. 2 дня в месяц выбери сам".
-- Every Tuesday is already a far trip (1st/3rd Bath, 2nd/4th Swansea), so GL goes on
-- the 2nd and 4th THURSDAY. Thursday is not an ordinary working day: trip days open
-- themselves through open_trip_days(), the same way as the Tuesdays.
--
-- Served: GL1–GL20 (Gloucester, Stroud, Cirencester, Tetbury, Dursley, Wotton,
-- Berkeley, Forest of Dean, Newent, Tewkesbury) and GL50–GL53 (Cheltenham).
-- Not served: GL54–GL56 (north Cotswolds: Bourton, Chipping Campden, Moreton).
-- On-the-way area on a GL day: Bristol (BS) only, as on a Bath day.
-- Minimum 5 / maximum 30 stops, 08:00–18:00 — the general far-trip rules.

insert into subnex_private.dispatch_zones(prefix, name, mode, weekday, week_of_month, num_from, num_to, code, weekdays, weeks_of_month, fillers, updated_at)
values
 ('GL', 'Gloucester, Stroud and Forest of Dean', 'monthly', 4, 2, 1, 20, 'GL1-20', null, array[2,4], array['BS'], now()),
 ('GL', 'Cheltenham', 'monthly', 4, 2, 50, 53, 'GL50-53', null, array[2,4], array['BS'], now()),
 ('GL', 'North Cotswolds (Bourton, Chipping Campden, Moreton)', 'off', null, null, 0, 99, 'GL', null, null, null, now())
on conflict do nothing;

select subnex_private.open_trip_days(92);
