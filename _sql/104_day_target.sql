-- 104. Цель дня — 30 ПОДТВЕРЖДЁННЫХ адресов; неответивший клиент считается долей адреса (решение 16.11.2026).
--
-- Было: потолок в штуках (day_capacity 40) считал подтверждённых и неответивших одинаково, а расчёт
-- в пульте не считал штуки вовсе. Стало:
--   нагрузка дня = подтверждённые + заявки без подтверждения (WhatsApp, Missing) + 0,8 × ждущие ответа;
--   новая заявка ставится в день, пока нагрузка + 0,8 ≤ цели (30). Контейнеры в цель не входят.
-- Пустому дню дата предлагается примерно 37 клиентам; при 30 подтверждённых предложения прекращаются.
-- sms_day_hours.max_stops (дни поездок, 30) теперь — цель этого дня, а не потолок вместе с неответившими.
-- day_capacity (40) остаётся жёстким потолком остановок в день.
-- Повторный запуск безопасен; прежние версии функций — в dispatch_backups '104:…'.

alter table subnex_private.auto_plan_config add column if not exists day_target integer not null default 30;
alter table subnex_private.auto_plan_config add column if not exists confirm_rate_pct integer not null default 80;

-- Жёсткий потолок остановок: теперь только общий. Число дня (max_stops) ушло в цель.
insert into subnex_private.dispatch_backups(name,definition)
select '104:subnex_private.day_stop_cap(date)', pg_get_functiondef('subnex_private.day_stop_cap(date)'::regprocedure)
on conflict(name) do nothing;

create or replace function subnex_private.day_stop_cap(p_day date) returns integer
language sql stable security definer set search_path to '' as $$
 select coalesce((select c.day_capacity from subnex_private.auto_plan_config c where c.singleton),40)::int
$$;

create or replace function subnex_private.day_target(p_day date) returns numeric
language sql stable security definer set search_path to '' as $$
 select least(coalesce((select c.day_target from subnex_private.auto_plan_config c where c.singleton),30),
              coalesce((select h.max_stops from public.sms_day_hours h where h.day=p_day),32767))::numeric
$$;

-- Сколько весит заявка, пока клиент не ответил.
create or replace function subnex_private.request_weight(p_address uuid) returns numeric
language sql stable security definer set search_path to '' as $$
 select case when a.kind='bank' then 0
             when a.collection_start is not null or a.intake_channel in ('partner_whatsapp','missing') then 1
             else coalesce((select c.confirm_rate_pct from subnex_private.auto_plan_config c where c.singleton),80)/100.0 end
   from public.addresses a where a.id=p_address
$$;

-- Нагрузка дня: те же адреса, что видит маршрут дня (dispatch_nodes), но с весами.
create or replace function subnex_private.day_load(p_driver uuid, p_day date, p_ignore uuid default null) returns numeric
language sql stable security definer set search_path to '' as $$
 select coalesce(sum(case
          when a.collection_start is not null or a.intake_channel in ('partner_whatsapp','missing') then 1
          else coalesce((select c.confirm_rate_pct from subnex_private.auto_plan_config c where c.singleton),80)/100.0 end),0)
   from public.addresses a
  where a.driver_id=p_driver and a.id is distinct from p_ignore and a.status in ('new','planned') and a.kind<>'bank'
    and (a.date=p_day or (a.collection_start at time zone 'Europe/London')::date=p_day
      or (a.collection_start is null and (
           exists(select 1 from public.sms_offers o join public.sms_threads t on t.active_offer_id=o.id
                   where o.address_id=a.id and o.state in ('preparing','awaiting','manual')
                     and (o.starts_at at time zone 'Europe/London')::date=p_day)
        or exists(select 1 from subnex_private.dispatch_holds h
                   where h.address_id=a.id and h.state='held' and (h.starts_at at time zone 'Europe/London')::date=p_day))))
$$;

create or replace function subnex_private.day_has_room(p_driver uuid, p_day date, p_ignore uuid default null) returns boolean
language sql stable security definer set search_path to '' as $$
 select subnex_private.day_load(p_driver,p_day,p_ignore)
        + coalesce((select c.confirm_rate_pct from subnex_private.auto_plan_config c where c.singleton),80)/100.0
        <= subnex_private.day_target(p_day)
$$;

revoke all on function subnex_private.day_target(date) from public, anon, authenticated;
revoke all on function subnex_private.request_weight(uuid) from public, anon, authenticated;
revoke all on function subnex_private.day_load(uuid,date,uuid) from public, anon, authenticated;
revoke all on function subnex_private.day_has_room(uuid,date,uuid) from public, anon, authenticated;

-- Точечные правки функций: каждый фрагмент обязан встретиться ровно один раз.
do $patch$
declare f text; def text; pairs text[]; i int; marker text;
begin
 foreach f in array array[
   'subnex_private.auto_plan_days(uuid)',
   'subnex_private.plan_days_for_point(text,double precision,double precision,uuid)',
   'subnex_private.auto_layout(boolean)',
   'public.subnex_dispatch(text,jsonb)'] loop
  def:=replace(pg_get_functiondef(f::regprocedure),E'\r','');
  marker:=case f when 'subnex_private.auto_layout(boolean)' then '_lz_load'
                 when 'public.subnex_dispatch(text,jsonb)' then 'confirm_rate_pct'
                 else 'day_has_room' end;
  if position(marker in def)>0 then continue; end if;
  insert into subnex_private.dispatch_backups(name,definition) values('104:'||f,def) on conflict(name) do nothing;
  pairs:=case f
   when 'subnex_private.auto_layout(boolean)' then array[
    $q$minday int; far boolean;$q$,
    $q$minday int; far boolean; uw numeric;$q$,
    $q$ perform subnex_private.auto_layout_clean();$q$,
    $q$ uw:=coalesce(c.confirm_rate_pct,80)/100.0;
 perform subnex_private.auto_layout_clean();
 create temp table if not exists _lz_load(k uuid, day date, base numeric, put numeric);$q$,
    $q$  for d in select x.day from _lz_day x where x.k=v_k and x.win is not null order by x.day loop$q$,
    $q$  -- 104: нагрузка дня с весами — подтверждённые целиком, ждущие ответа долей.
  insert into _lz_load(k,day,base,put) select v_k, x.day, subnex_private.day_load(dr,x.day), 0 from _lz_day x where x.k=v_k;

  for d in select x.day from _lz_day x where x.k=v_k and x.win is not null order by x.day loop$q$,
    $q$exit when l.stops>=subnex_private.day_stop_cap(d);$q$,
    $q$exit when l.stops>=subnex_private.day_stop_cap(d)
      or (select ld.base+ld.put+uw from _lz_load ld where ld.k=v_k and ld.day=d)>subnex_private.day_target(d);$q$,
    $q$update _lz_pool x set day=d, cost=best_cost, how='near' where x.k=v_k and x.address_id=best_addr;$q$,
    $q$update _lz_pool x set day=d, cost=best_cost, how='near' where x.k=v_k and x.address_id=best_addr;
    update _lz_load ld set put=ld.put+subnex_private.request_weight(best_addr) where ld.k=v_k and ld.day=d;$q$,
    $q$update _lz_pool x set day=null, cost=null, how=null where x.k=v_k and x.day=d;$q$,
    $q$update _lz_pool x set day=null, cost=null, how=null where x.k=v_k and x.day=d;
    update _lz_load ld set put=0 where ld.k=v_k and ld.day=d;$q$,
    $q$and l2.stops<subnex_private.day_stop_cap(l2.day)$q$,
    $q$and l2.stops<subnex_private.day_stop_cap(l2.day)
      and (select ld.base+ld.put+uw from _lz_load ld where ld.k=v_k and ld.day=l2.day)<=subnex_private.day_target(l2.day)$q$,
    $q$update _lz_pool x set day=best_day, cost=best_cost, how='cheapest' where x.k=v_k and x.address_id=best_addr;$q$,
    $q$update _lz_pool x set day=best_day, cost=best_cost, how='cheapest' where x.k=v_k and x.address_id=best_addr;
   update _lz_load ld set put=ld.put+subnex_private.request_weight(best_addr) where ld.k=v_k and ld.day=best_day;$q$]
   when 'public.subnex_dispatch(text,jsonb)' then array[
    $q$day_capacity=least(greatest(coalesce((item->>'day_capacity')::int,day_capacity),1),120),$q$,
    $q$day_capacity=least(greatest(coalesce((item->>'day_capacity')::int,day_capacity),1),120),
   day_target=least(greatest(coalesce((item->>'day_target')::int,day_target),1),120),
   confirm_rate_pct=least(greatest(coalesce((item->>'confirm_rate_pct')::int,confirm_rate_pct),10),100),$q$]
   else array[
    $q$if cnt>=subnex_private.day_stop_cap(d) then continue; end if;$q$,
    $q$if cnt>=subnex_private.day_stop_cap(d) or not subnex_private.day_has_room(a.driver_id,d,a.id) then continue; end if;$q$,
    -- решение вечерней раскладки исполняем, только пока в её дне ещё есть место
    $q$and lp.day>=(now() at time zone 'Europe/London')::date) then$q$,
    $q$and lp.day>=(now() at time zone 'Europe/London')::date
            and subnex_private.day_has_room(a.driver_id,lp.day,a.id)) then$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;
