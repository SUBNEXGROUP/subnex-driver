-- 107. GL minimum 3, 24 Dec closed, layout twice a day (19.11.2026).
--
-- Kostia: "24 декабря закрой", "можно снизить до 3 а там будем смотреть",
-- "сделай дважды в 12:00 и в 18:00".
--
-- 1) dispatch_zones.min_stops — per-zone minimum for opening a far trip day.
--    NULL = general auto_plan_config.min_cluster_stops (5). GL1-20 and GL50-53 → 3.
--    auto_layout: an empty far day keeps its batch if it reaches the smallest
--    min_stops among the monthly zones of that day (else the general minimum).
-- 2) 24 Dec 2026 (GL Thursday) closed in sms_day_hours. open_trip_days never reopens
--    an existing row.
-- 3) auto_plan_config.layout_hours int[] = {12,18}: the layout (and therefore date
--    offers) runs at each listed hour once a day. layout_hour stays for reference.
-- Backups: dispatch_backups '107:…'.

alter table subnex_private.dispatch_zones add column if not exists min_stops int;
update subnex_private.dispatch_zones set min_stops=3, updated_at=now() where code in ('GL1-20','GL50-53');

update public.sms_day_hours set closed=true where day='2026-12-24';

alter table subnex_private.auto_plan_config add column if not exists layout_hours int[];
update subnex_private.auto_plan_config set layout_hours=array[12,18] where singleton;

insert into subnex_private.dispatch_backups(name, definition)
select '107:subnex_private.auto_layout(boolean)', pg_get_functiondef('subnex_private.auto_layout(boolean)'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='107:subnex_private.auto_layout(boolean)');
insert into subnex_private.dispatch_backups(name, definition)
select '107:subnex_private.auto_plan()', pg_get_functiondef('subnex_private.auto_plan()'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='107:subnex_private.auto_plan()');

do $m$
declare src text; a1 text := 'n_put between 1 and (case when far then minc else minday end)-1';
begin
  src := pg_get_functiondef('subnex_private.auto_layout(boolean)'::regprocedure);
  if position('min_stops' in src) > 0 then return; end if;
  if position(a1 in src) = 0 then raise exception '107: anchor not found in auto_layout'; end if;
  src := replace(src, a1,
    'n_put between 1 and (case when far then coalesce((select min(f.min_stops) from subnex_private.dispatch_zones f'
    || ' where f.mode=''monthly'' and subnex_private.zone_on_day(f,d)),minc) else minday end)-1');
  execute src;
end $m$;

do $m$
declare src text;
 a1 text := 'if subnex_private.uk_hour()>=c.layout_hour
    and (c.last_layout_at is null or (c.last_layout_at at time zone ''Europe/London'')::date<today) then';
begin
  src := pg_get_functiondef('subnex_private.auto_plan()'::regprocedure);
  if position('layout_hours' in src) > 0 then return; end if;
  if position(a1 in src) = 0 then raise exception '107: anchor not found in auto_plan'; end if;
  src := replace(src, a1,
'if exists(select 1 from unnest(coalesce(c.layout_hours,array[c.layout_hour])) h(hr)
            where subnex_private.uk_hour()>=h.hr
              and (c.last_layout_at is null
                   or c.last_layout_at < ((today + make_time(h.hr,0,0)) at time zone ''Europe/London''))) then');
  execute src;
end $m$;
