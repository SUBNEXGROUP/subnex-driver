-- 85: удержания «на день» следуют за часами работы (12.10.2026).
-- Проблема: Костя продлил ср/пт/сб до 19:00, а удержание сайта на ср 14.10 осталось 08:00–18:00.
-- «Отправить предложения» падало с ARRIVAL_WINDOW_30, подтверждение письмом упало бы так же.
-- Решение: realign_day_holds() подгоняет удержания на весь день под текущее окно дня;
-- вызывается из dispatch_hours_guard при каждом изменении часов. Применено через MCP как 85_realign_day_holds.
insert into subnex_private.dispatch_backups(name,definition)
select '85:subnex_private.dispatch_hours_guard()', pg_get_functiondef('subnex_private.dispatch_hours_guard()'::regprocedure)
where not exists(select 1 from subnex_private.dispatch_backups where name='85:subnex_private.dispatch_hours_guard()');

create or replace function subnex_private.realign_day_holds(p_driver uuid default null, p_day date default null)
returns int language plpgsql security definer set search_path to '' as $$
declare n int;
begin
 update subnex_private.dispatch_holds h
    set starts_at=(x.w->>'start')::timestamptz, ends_at=(x.w->>'end')::timestamptz
   from (select h2.id, subnex_private.day_window((h2.starts_at at time zone 'Europe/London')::date) w
           from subnex_private.dispatch_holds h2
          where h2.state='held' and h2.ends_at-h2.starts_at>=interval '6 hours'
            and (p_driver is null or h2.driver_id=p_driver)
            and (p_day is null or (h2.starts_at at time zone 'Europe/London')::date=p_day)
            and (h2.starts_at at time zone 'Europe/London')::date>=(now() at time zone 'Europe/London')::date) x
  where h.id=x.id and x.w is not null
    and (h.starts_at is distinct from (x.w->>'start')::timestamptz or h.ends_at is distinct from (x.w->>'end')::timestamptz);
 get diagnostics n=row_count;
 return n;
end $$;

do $m$
declare src text;
begin
 src:=replace(pg_get_functiondef('subnex_private.dispatch_hours_guard()'::regprocedure),E'\r','');
 if position('realign_day_holds' in src)=0 then
  src:=replace(src, $o$  n:=subnex_private.dispatch_nodes(r.driver_id,r.day);$o$,
$n$  perform subnex_private.realign_day_holds(r.driver_id,r.day);
  n:=subnex_private.dispatch_nodes(r.driver_id,r.day);$n$);
  if position('realign_day_holds' in src)=0 then raise exception 'PATCH_HOURS_GUARD'; end if;
  execute src;
 end if;
end $m$;

select subnex_private.realign_day_holds();
