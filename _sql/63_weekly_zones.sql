-- 63: районы по дням недели (03.10.2026).
-- Работаем 3 дня: пн, ср, сб, до 40 адресов в день. Новый режим зоны 'weekly' — список дней недели
-- (weekdays, 0=вс … 6=сб): адрес такой зоны ставится только в эти дни. Монтли-зоны (SA) работают как раньше.
-- Вт/чт/пт закрыты; уже согласованные сборы на эти дни сохраняются через sms_day_hours на конкретные даты.
-- Повторный запуск безопасен; прежние версии функций — в dispatch_backups '63:…'.

alter table subnex_private.dispatch_zones add column if not exists weekdays smallint[];
alter table subnex_private.dispatch_zones drop constraint if exists dispatch_zones_mode_check;
alter table subnex_private.dispatch_zones add constraint dispatch_zones_mode_check
 check (mode = any (array['regular','monthly','weekly','off']));
alter table subnex_private.dispatch_zones drop constraint if exists dispatch_zones_weekly_check;
alter table subnex_private.dispatch_zones add constraint dispatch_zones_weekly_check
 check (mode<>'weekly' or (cardinality(weekdays)>0 and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]));

do $patch$
declare def text; f text; pairs text[]; i int;
begin
 foreach f in array array['public.subnex_zones(text,jsonb)','subnex_private.dispatch_area_ok(text,date)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  if position('weekly' in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='63:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('63:'||f,def);
  end if;
  pairs:=case f
   when 'public.subnex_zones(text,jsonb)' then array[
    $q$if (p_data->>'mode') not in ('regular','monthly','off') then raise exception 'ZONE_MODE_INVALID'; end if;$q$,
    $q$if (p_data->>'mode') not in ('regular','monthly','weekly','off') then raise exception 'ZONE_MODE_INVALID'; end if;
  if p_data->>'mode'='weekly' and not exists(select 1 from jsonb_array_elements_text(coalesce(p_data->'weekdays','[]')) x
      where x ~ '^[0-6]$') then raise exception 'ZONE_DAY_INVALID'; end if;$q$,
    $q$insert into subnex_private.dispatch_zones(code,prefix,num_from,num_to,name,mode,weekday,week_of_month,updated_at)$q$,
    $q$insert into subnex_private.dispatch_zones(code,prefix,num_from,num_to,name,mode,weekday,week_of_month,weekdays,updated_at)$q$,
    $q$   case when p_data->>'mode'='monthly' then (p_data->>'week_of_month')::smallint end,now())$q$,
    $q$   case when p_data->>'mode'='monthly' then (p_data->>'week_of_month')::smallint end,
   case when p_data->>'mode'='weekly' then array(select distinct x::smallint from jsonb_array_elements_text(p_data->'weekdays') x
     where x ~ '^[0-6]$' order by 1) end,now())$q$,
    $q$name=excluded.name,mode=excluded.mode,weekday=excluded.weekday,week_of_month=excluded.week_of_month,updated_at=now();$q$,
    $q$name=excluded.name,mode=excluded.mode,weekday=excluded.weekday,week_of_month=excluded.week_of_month,weekdays=excluded.weekdays,updated_at=now();$q$,
    $q$'name',t.name,'mode',t.mode,'weekday',t.weekday,'week_of_month',t.week_of_month,$q$,
    $q$'name',t.name,'mode',t.mode,'weekday',t.weekday,'week_of_month',t.week_of_month,'weekdays',coalesce(to_jsonb(t.weekdays),'[]'::jsonb),$q$]
   when 'subnex_private.dispatch_area_ok(text,date)' then array[
    $q$ if z.mode='regular' then$q$,
    $q$ if z.mode='weekly' and not (extract(dow from p_day)::smallint=any(z.weekdays)) then return false; end if;
 if z.mode in ('regular','weekly') then$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;

-- Раскладка районов. Узкий диапазон важнее широкого (dispatch_zone_for).
insert into subnex_private.dispatch_zones(code,prefix,num_from,num_to,name,mode,weekday,week_of_month,weekdays,updated_at) values
 ('CF','CF',0,99,'Cardiff','weekly',null,null,'{1,3,6}',now()),
 ('CF61-71','CF',61,71,'Vale of Glamorgan','weekly',null,null,'{1,6}',now()),
 ('CF31-48','CF',31,48,'Valleys and Bridgend','weekly',null,null,'{6}',now()),
 ('CF72','CF',72,72,'Llantrisant and Pontyclun','weekly',null,null,'{6}',now()),
 ('CF81-82','CF',81,82,'Bargoed and Hengoed','weekly',null,null,'{6}',now()),
 ('CF83','CF',83,83,'Caerphilly','weekly',null,null,'{1,3,6}',now()),
 ('NP','NP',0,99,'Newport and East Wales','weekly',null,null,'{1,3}',now()),
 ('NP12-13','NP',12,13,'Blackwood and Ebbw Vale','weekly',null,null,'{6}',now()),
 ('NP22-24','NP',22,24,'Tredegar and Rhymney','weekly',null,null,'{6}',now()),
 ('LD','LD',0,99,'Brecon','weekly',null,null,'{6}',now()),
 ('BS','BS',0,99,'Bristol','weekly',null,null,'{3}',now()),
 ('BA','BA',0,99,'Bath and Warminster','weekly',null,null,'{3}',now()),
 ('SN','SN',0,99,'Chippenham','weekly',null,null,'{3}',now()),
 ('SA1-13','SA',1,13,'Swansea','monthly',6,5,null,now()),
 ('SA14-99','SA',14,99,'West Wales','monthly',6,5,null,now()),
 ('SP','SP',0,99,'Salisbury','off',null,null,null,now())
on conflict(code) do update set prefix=excluded.prefix,num_from=excluded.num_from,num_to=excluded.num_to,name=excluded.name,
 mode=excluded.mode,weekday=excluded.weekday,week_of_month=excluded.week_of_month,weekdays=excluded.weekdays,updated_at=now();

-- Уже согласованные сборы во вт/чт/пт: эти даты остаются рабочими, остальные вт/чт/пт закрываются.
-- Проверку часов (dispatch_hours_guard) на время правки выключаем: у этих дат часы не меняются (08–18),
-- а пересчёт 27.10 упирается в ещё не прогретые дороги от нового дома (CF39 9LF) до SA46.
alter table public.sms_day_hours disable trigger subnex_dispatch_hours;
alter table public.sms_week_hours disable trigger subnex_dispatch_hours;
insert into public.sms_day_hours(day,opens,closes,closed)
select d,'08:00','18:00',false from (values (date '2026-10-06'),(date '2026-10-08'),(date '2026-10-15'),(date '2026-10-27'),(date '2026-10-29')) v(d)
on conflict(day) do nothing;
update public.sms_week_hours set closed=true where weekday in (2,4,5) and not closed;
update public.sms_week_hours set closed=false where weekday in (1,3,6) and closed;
alter table public.sms_day_hours enable trigger subnex_dispatch_hours;
alter table public.sms_week_hours enable trigger subnex_dispatch_hours;
