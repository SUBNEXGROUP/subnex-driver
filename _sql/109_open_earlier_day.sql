-- 109. Open an earlier empty day instead of pushing a request weeks ahead (19.11.2026).
--
-- Case: Sophie Hucker, 38 Church Road, Weston-super-Mare BS22 9DE (WRC batch 19.11 15:10).
-- Bristol days are Wed/Fri. Next week's Wed 25 was empty, so the layout put her on
-- Tue 1 Dec (Bath trip, Bristol as on-the-way area) — 12 days later.
-- Kostia: "если есть среда на след неделе, то пусть открывает день, а не кидает на
-- следующий месяц"; for all areas; if the day stays thin — go anyway (for now).
--
-- Rule: F(q) = the request's earliest allowed day (zone/area/hours ok). gap = 3 days.
--  * pass 1 ("add to a day that already has stops nearby") no longer takes q on a day
--    later than F(q)+gap — such requests go to pass 2;
--  * pass 2 may open an EMPTY day for q if that day is within F(q)+gap;
--    order: days within F(q)+gap first; then non-empty day nearby (≤ near_detour_minutes),
--    then empty day, then non-empty day with a long detour; then cost, then date.
-- Far (monthly) trip days still never open empty in pass 2. Seeding of new 15-stop days
-- in pass 1 is unchanged.
-- Backup: dispatch_backups '109:subnex_private.auto_layout(boolean)'.

alter table subnex_private.auto_plan_config add column if not exists open_day_gap_days int;
update subnex_private.auto_plan_config set open_day_gap_days=3 where singleton;

insert into subnex_private.dispatch_backups(name, definition)
select '109:subnex_private.auto_layout(boolean)', pg_get_functiondef('subnex_private.auto_layout(boolean)'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='109:subnex_private.auto_layout(boolean)');

do $m$
declare src text;
 d1 text := 'minday int; far boolean; uw numeric;';
 d2 text := ' uw:=coalesce(c.confirm_rate_pct,80)/100.0;';
 p1 text := '      where q.k=v_k and q.day is null and x.cost is not null and x.cost<=tol';
 a1 text := 'and (l2.stops>0 or q.created_at<now()-interval ''5 days'')';
 a2 text := 'order by (l2.stops=0), x.cost, l2.day limit 1;';
 f text := '(select min(lf.day) from _lz_allow af join _lz_day lf on lf.k=v_k and lf.day=af.day where af.k=v_k and af.address_id=q.address_id and lf.win is not null)';
begin
 src := pg_get_functiondef('subnex_private.auto_layout(boolean)'::regprocedure);
 if position('gap:=greatest' in src) > 0 then return; end if;
 if position(d1 in src)=0 or position(d2 in src)=0 or position(p1 in src)=0 or position(a1 in src)=0 or position(a2 in src)=0 then
  raise exception '109: anchor not found in auto_layout';
 end if;
 src := replace(src, d1, 'minday int; far boolean; uw numeric; gap int;');
 src := replace(src, d2, d2 || chr(10) || ' gap:=greatest(coalesce(c.open_day_gap_days,3),0);');
 src := replace(src, p1, p1 || chr(10) || '        and d<=coalesce('||f||',d)+gap');
 src := replace(src, a1, 'and (l2.stops>0 or q.created_at<now()-interval ''5 days'' or l2.day<=coalesce('||f||',l2.day)+gap)');
 src := replace(src, a2, 'order by (l2.day>coalesce('||f||',l2.day)+gap),' || chr(10) ||
  '     case when l2.stops>0 and x.cost<=tol then 0 when l2.stops=0 then 1 else 2 end, x.cost, l2.day limit 1;');
 execute src;
end $m$;
