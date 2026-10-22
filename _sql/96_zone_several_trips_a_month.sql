-- 96: a monthly zone can have several trips a month (Kostia, 22 Oct 2026: SA twice a month,
--     2nd and 4th Tuesday, both SA1-13 and SA14-99).
-- APPLIED 22 Oct 2026 in steps; backups in subnex_private.dispatch_backups as '96:<function>'.

-- 96a (migration 96a_zone_weeks_of_month)
alter table subnex_private.dispatch_zones add column if not exists weeks_of_month smallint[];

create or replace function subnex_private.zone_month_weeks(z subnex_private.dispatch_zones)
returns smallint[] language sql immutable set search_path to '' as $f$
 select case when coalesce(cardinality(z.weeks_of_month),0)>0
   then array(select distinct w from unnest(z.weeks_of_month) w where w between 1 and 5 order by 1)
   else array[coalesce(z.week_of_month,5)::smallint] end
$f$;

-- Trip dates of a monthly zone in p_months months, starting with the month of p_from (not filtered by p_from).
create or replace function subnex_private.zone_dates(z subnex_private.dispatch_zones, p_from date, p_months int default 3)
returns date[] language sql stable set search_path to '' as $f$
 select coalesce(array_agg(distinct d order by d) filter (where d is not null),'{}')
 from generate_series(0,greatest(p_months,1)-1) n
 cross join unnest(subnex_private.zone_month_weeks(z)) w
 cross join lateral (select subnex_private.dispatch_zone_date(z.weekday,w,
   (date_trunc('month',p_from::timestamp)+(n||' month')::interval)::date) d) x
 where z.mode='monthly' and z.weekday is not null
$f$;

create or replace function subnex_private.zone_on_day(z subnex_private.dispatch_zones, p_day date)
returns boolean language sql stable set search_path to '' as $f$
 select z.mode='monthly' and p_day=any(subnex_private.zone_dates(z,p_day,1))
$f$;

-- 96b: function patches (source replace, see backups for the before-state)
--  * dispatch_area_ok:   p_day=dispatch_zone_date(f/z.weekday,week_of_month,p_day) -> zone_on_day(f/z,p_day)
--  * auto_plan_days, auto_layout_days: the 3-month candidate list -> unnest(zone_dates(z,today,3))
--  * dispatch_same_zone: coalesce(week_of_month,5) equality -> zone_month_weeks(x)=zone_month_weeks(y)
--  * subnex_zones: save accepts weeks_of_month[] (kept when the form does not send it and weekday/week
--    are unchanged); list returns weeks_of_month and next dates from zone_dates(t,today,5)
--  * subnex_area_check: several trips -> mode 'several_monthly', days ['the second and fourth Tuesday
--    of each month'] so the site prints "We collect in SA1 on the second and fourth Tuesday of each month."
--    without a site change.

-- 96c: data
update subnex_private.dispatch_zones set weekday=2, week_of_month=2, weeks_of_month='{2,4}', updated_at=now() where prefix='SA';
-- Tuesday is a day off in sms_week_hours, so the trip Tuesdays are opened one by one for 12 months
-- (2026-10-27 .. 2027-09-28), 08:00-18:00. Extend before Oct 2027.
insert into public.sms_day_hours(day,opens,closes,closed)
 select d,'08:00','18:00',false from unnest(subnex_private.zone_dates((select z from subnex_private.dispatch_zones z where code='SA1-13'),'2026-10-22',12)) d
 where d>'2026-10-22' on conflict(day) do nothing;

-- Console (ops-dispatch-core.js monthWeeks / zoneTripDay / nextTripDays / sameZone; admin.html zone form
-- with week checkboxes) — branch sa-twice-monthly.
