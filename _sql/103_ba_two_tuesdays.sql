-- 103. Bath (BA) два раза в месяц, как Суонси (решения 16.11.2026).
--
-- 1. Зоны: BA1–BA3 (Bath) и BA11–BA15 (Frome, Warminster, Trowbridge) — 1-й и 3-й вторник, одной поездкой.
--    Остальной BA (Wells, Street, Yeovil) и весь SN (Chippenham) выключены: «пока не обслуживаем».
-- 2. Попутные адреса у каждой дальней зоны свои (dispatch_zones.fillers): Суонси добирают CF и NP,
--    Bath — только Бристоль (BS). Раньше CF/NP были зашиты в код для любой дальней поездки.
-- 3. Дни поездок дальних зон открываются сами на три месяца вперёд (08:00–18:00, до 30 остановок):
--    раз в сутки по расписанию и сразу после сохранения зоны. Дни, у которых уже есть своя запись
--    в sms_day_hours (в том числе закрытые вручную), не трогаются.
-- Минимум 5 адресов на выезд (вместе с попутными) и остальная логика дальних поездок — из 102, без изменений.
-- Повторный запуск безопасен; прежние версии функций — в dispatch_backups '103:…'.

-- 1) Попутные районы — свойство дальней зоны.
alter table subnex_private.dispatch_zones add column if not exists fillers text[];
comment on column subnex_private.dispatch_zones.fillers is
 'Буквы индексов районов, которыми добирается день поездки в эту зону (только для mode=monthly).';

update subnex_private.dispatch_zones set fillers=array['CF','NP'] where code='SA1-18' and fillers is null;

-- 2) Зоны BA и SN.
insert into subnex_private.dispatch_zones(code,prefix,num_from,num_to,name,mode,weekday,week_of_month,weekdays,weeks_of_month,fillers,updated_at)
values ('BA1-3','BA',1,3,'Bath','monthly',2,1,null,array[1,3]::smallint[],array['BS'],now()),
       ('BA11-15','BA',11,15,'Frome, Warminster and Trowbridge','monthly',2,1,null,array[1,3]::smallint[],array['BS'],now())
on conflict(code) do update set prefix=excluded.prefix,num_from=excluded.num_from,num_to=excluded.num_to,name=excluded.name,
  mode=excluded.mode,weekday=excluded.weekday,week_of_month=excluded.week_of_month,weekdays=excluded.weekdays,
  weeks_of_month=excluded.weeks_of_month,fillers=excluded.fillers,updated_at=now();

update subnex_private.dispatch_zones
   set name='Somerset south (Wells, Street, Yeovil)', mode='off', weekday=null, week_of_month=null, weekdays=null,
       weeks_of_month=null, fillers=null, updated_at=now()
 where code='BA' and mode<>'off';

update subnex_private.dispatch_zones
   set mode='off', weekday=null, week_of_month=null, weekdays=null, weeks_of_month=null, fillers=null, updated_at=now()
 where code='SN' and mode<>'off';

-- 3) Какими районами можно добирать этот день: попутные тех дальних зон, чья поездка на этот день «открыта»
--    (адрес зоны уже стоит в дне, удержан или предложен клиенту).
create or replace function subnex_private.far_trip_fillers(p_day date) returns text[]
language sql stable set search_path to '' as $$
 select coalesce(array_agg(distinct p.x),'{}'::text[])
   from subnex_private.dispatch_zones f
   cross join lateral unnest(f.fillers) p(x)
  where f.mode='monthly' and subnex_private.zone_on_day(f,p_day)
    and (exists(select 1 from public.addresses x
                 where x.status in ('new','planned') and x.kind<>'bank' and x.date=p_day
                   and (subnex_private.dispatch_zone_for(x.text)).code=f.code)
      or exists(select 1 from subnex_private.dispatch_holds h join public.addresses x on x.id=h.address_id
                 where h.state='held' and (h.starts_at at time zone 'Europe/London')::date=p_day
                   and (subnex_private.dispatch_zone_for(x.text)).code=f.code)
      or exists(select 1 from public.sms_offers o join public.addresses x on x.id=o.address_id
                 where o.state in ('preparing','awaiting','manual')
                   and (o.starts_at at time zone 'Europe/London')::date=p_day
                   and (subnex_private.dispatch_zone_for(x.text)).code=f.code))
$$;
revoke all on function subnex_private.far_trip_fillers(date) from public, anon, authenticated;

-- 4) Дни поездок дальних зон открыты заранее. Вторник в обычной неделе закрыт, поэтому каждому дню
--    выезда нужна своя запись. Ближайшие два дня не трогаем: на них уже ничего не планируется.
create or replace function subnex_private.open_trip_days(p_days integer default 92) returns integer
language plpgsql set search_path to '' as $$
declare today date:=(now() at time zone 'Europe/London')::date; r record; w public.sms_week_hours; n int:=0; c int;
begin
 for r in
  select distinct d.day
    from subnex_private.dispatch_zones z
    cross join lateral unnest(subnex_private.zone_dates(z,today,p_days/28+2)) d(day)
   where z.mode='monthly' and d.day between today+2 and today+p_days
     and not exists(select 1 from public.sms_day_hours h where h.day=d.day)
   order by d.day
 loop
  select * into w from public.sms_week_hours where weekday=extract(dow from r.day)::int;
  begin
   insert into public.sms_day_hours(day,opens,closes,closed,max_stops)
   values(r.day,
          case when w.closed is false then w.opens else time '08:00' end,
          case when w.closed is false then w.closes else time '18:00' end,
          false,30)
   on conflict(day) do nothing;
   get diagnostics c = row_count;
   n:=n+c;
  exception when others then
   -- В дне уже что-то стоит и с новыми часами он не сходится: день не открываем, остальные — открываем.
   raise warning 'open_trip_days: % not opened: %', r.day, sqlerrm;
  end;
 end loop;
 return n;
end $$;
revoke all on function subnex_private.open_trip_days(integer) from public, anon, authenticated;

-- 5) Точечные правки функций: каждый фрагмент обязан встретиться ровно один раз.
do $patch$
declare f text; def text; pairs text[]; i int; marker text;
begin
 foreach f in array array[
   'subnex_private.dispatch_area_ok(text,date)',
   'subnex_private.auto_layout(boolean)',
   'public.subnex_zones(text,jsonb)'] loop
  def:=replace(pg_get_functiondef(f::regprocedure),E'\r','');
  marker:=case f when 'subnex_private.dispatch_area_ok(text,date)' then 'far_trip_fillers'
                 when 'subnex_private.auto_layout(boolean)' then 'fa.fillers'
                 else 'open_trip_days' end;
  if position(marker in def)>0 then continue; end if;
  insert into subnex_private.dispatch_backups(name,definition) values('103:'||f,def) on conflict(name) do nothing;
  pairs:=case f
   when 'subnex_private.dispatch_area_ok(text,date)' then array[
    $q$if z.prefix in ('CF','NP') and subnex_private.far_trip_open(p_day) then return true; end if;$q$,
    $q$-- 103: попутные районы у каждой дальней зоны свои (Суонси — CF/NP, Bath — BS).
  if z.prefix=any(subnex_private.far_trip_fillers(p_day)) then return true; end if;$q$]
   when 'subnex_private.auto_layout(boolean)' then array[
    $q$cross join (select distinct a2.day from _lz_allow a2 join public.addresses y on y.id=a2.address_id$q$,
    $q$cross join (select distinct a2.day, (subnex_private.dispatch_zone_for(y.text)).fillers as fillers from _lz_allow a2 join public.addresses y on y.id=a2.address_id$q$,
    $q$and (subnex_private.dispatch_zone_for(x.text)).prefix in ('CF','NP')$q$,
    $q$and (subnex_private.dispatch_zone_for(x.text)).prefix=any(coalesce(fa.fillers,'{}'::text[]))$q$]
   else array[
    $q$'weekdays',coalesce(to_jsonb(t.weekdays),'[]'::jsonb),$q$,
    $q$'weekdays',coalesce(to_jsonb(t.weekdays),'[]'::jsonb),'fillers',coalesce(to_jsonb(t.fillers),'[]'::jsonb),$q$,
    $q$ elsif p_action='delete' then$q$,
    $q$  -- 103: попутные районы дня поездки (только у режима monthly) и сразу открытые дни выезда.
  if p_data ? 'fillers' then
   update subnex_private.dispatch_zones
      set fillers=case when p_data->>'mode'='monthly' then nullif(array(
           select distinct upper(btrim(x)) from jsonb_array_elements_text(
             case when jsonb_typeof(p_data->'fillers')='array' then p_data->'fillers' else '[]'::jsonb end) x
            where upper(btrim(x)) ~ '^[A-Z]{1,2}$' order by 1),'{}'::text[]) end
    where code=norm;
  elsif p_data->>'mode'<>'monthly' then
   update subnex_private.dispatch_zones set fillers=null where code=norm and fillers is not null;
  end if;
  perform subnex_private.open_trip_days();
 elsif p_action='delete' then$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;

-- 6) Открыть дни уже сейчас и держать их открытыми дальше.
select subnex_private.open_trip_days();
select cron.schedule('subnex-open-trip-days','20 3 * * *',$$select subnex_private.open_trip_days()$$);
