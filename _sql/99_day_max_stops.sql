-- 99: a per-date stop limit for the planner (Kostia, 26 Oct 2026: Wed 28 Oct — 25 addresses at most).
-- APPLIED 26 Oct 2026 ~15:30. Backups: dispatch_backups '99:<function>'.
alter table public.sms_day_hours add column if not exists max_stops smallint;
create or replace function subnex_private.day_stop_cap(p_day date) returns int language sql stable security definer set search_path to '' as $f$
 select least(coalesce((select c.day_capacity from subnex_private.auto_plan_config c where c.singleton),40),
              coalesce((select h.max_stops from public.sms_day_hours h where h.day=p_day),32767))::int
$f$;
-- Patched (source replace): auto_plan_days, plan_days_for_point — "cnt>=c.day_capacity" -> "cnt>=day_stop_cap(d)";
-- auto_layout — "l.stops>=c.day_capacity" -> day_stop_cap(d), "l2.stops<c.day_capacity" -> day_stop_cap(l2.day).
insert into public.sms_day_hours(day,opens,closes,closed,max_stops) values('2026-10-28','08:00','20:30',false,25)
 on conflict(day) do update set max_stops=25;
-- Then auto_layout(false) + auto_plan(): 19 new partner requests -> Fri 30 Oct (18 SMS offers, 1 email offer);
-- Wed 28 stays at 25 (19 planned + 6 waiting for an answer).
-- NOT YET: the console's own planner ("Send offers" in Dispatch, ops-dispatch-core.js) does not know max_stops.
