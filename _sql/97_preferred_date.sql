-- 97. Желаемая дата клиента (Preferred date) из сводок We Recycle Clothes.
--
-- С 18.11.2026 We Recycle Clothes присылает сводку-таблицу с колонкой «Preferred date».
-- Решение Кости: предлагать клиенту именно этот день, если он подходит по зоне и
-- день не переполнен; если не подходит — как обычно, другой день.
--
-- 1) addresses.preferred_date — дата, которую назвал клиент.
-- 2) subnex_intake принимает поле preferred_date (YYYY-MM-DD) и сохраняет его.
-- 3) auto_plan_days: если желаемая дата среди подходящих дней — она идёт первой.
--    Старая логика выбора дня целиком переехала в auto_plan_days_core (без изменений).
-- Бэкапы прежних функций: dispatch_backups '97:…'.

alter table public.addresses add column if not exists preferred_date date;

insert into subnex_private.dispatch_backups(name, definition)
select '97:public.subnex_intake(text,jsonb)', pg_get_functiondef('public.subnex_intake(text,jsonb)'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='97:public.subnex_intake(text,jsonb)');

insert into subnex_private.dispatch_backups(name, definition)
select '97:subnex_private.auto_plan_days(uuid)', pg_get_functiondef('subnex_private.auto_plan_days(uuid)'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='97:subnex_private.auto_plan_days(uuid)');

-- 2) Приём: после вставки адреса записываем желаемую дату (если она есть и не в прошлом).
do $m$
declare src text; anchor text := 'v_created:=v_created+1;';
begin
  src := pg_get_functiondef('public.subnex_intake(text,jsonb)'::regprocedure);
  if position('preferred_date' in src) > 0 then return; end if;
  if position(anchor in src) = 0 then raise exception '97: anchor not found in subnex_intake'; end if;
  src := replace(src, anchor,
    'if coalesce(v_item->>''preferred_date'','''') ~ ''^\d{4}-\d{2}-\d{2}$'' then' || chr(10) ||
    '   update public.addresses set preferred_date=(v_item->>''preferred_date'')::date' || chr(10) ||
    '    where id=v_new_id and (v_item->>''preferred_date'')::date>=(now() at time zone ''Europe/London'')::date;' || chr(10) ||
    '  end if;' || chr(10) || '  ' || anchor);
  execute src;
end $m$;

-- 3) Выбор дня: прежняя функция под новым именем + обёртка с желаемой датой.
do $m$
declare src text;
begin
  src := pg_get_functiondef('subnex_private.auto_plan_days(uuid)'::regprocedure);
  if position('auto_plan_days_core' in src) > 0 then return; end if;
  src := replace(src, 'subnex_private.auto_plan_days(p_address uuid)', 'subnex_private.auto_plan_days_core(p_address uuid)');
  execute src;
end $m$;

create or replace function subnex_private.auto_plan_days(p_address uuid)
 returns date[]
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare days date[]; pref date;
begin
  days := subnex_private.auto_plan_days_core(p_address);
  select preferred_date into pref from public.addresses where id=p_address;
  if pref is not null and pref = any(days) then
    return array[pref] || array(select x from unnest(days) x where x<>pref);
  end if;
  return days;
end $function$;
