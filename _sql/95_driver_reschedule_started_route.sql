-- 95. Водитель может перенести подтверждённый адрес по просьбе клиента — даже когда
-- маршрут дня уже запущен (раньше ROUTE_STARTED не давал ни перенести, ни отменить).
-- Адрес уходит из сегодняшнего маршрута и возвращается в заявки; клиенту с e-mail
-- (сайт и партнёры без мобильного) сразу уходит письмо с ближайшей датой и кнопкой
-- «выбрать другой день». Клиенты с мобильным получат дату обычной автоматикой.
-- Писем «отменено» при этом не уходит: статус не становится cancelled.

-- 1) Проверка маршрута пропускает только это снятие (флаг ставит функция ниже).
create or replace function subnex_private.dispatch_address_before()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare changed boolean; locked boolean; dropping boolean;
begin
 if not subnex_private.dispatch_enabled() then if tg_op='DELETE' then return old;else return new;end if;end if;
 if tg_op='DELETE' then
  if old.collection_start is not null then raise exception 'CLOSE_REQUEST_INSTEAD';end if;return old;
 end if;
 if tg_op='UPDATE' and new.collection_source is distinct from old.collection_source then
  new.intake_channel:=case new.collection_source when 'subnex' then 'subnex_website' when 'missing' then 'missing' else 'partner_email' end;
 end if;
 if tg_op='UPDATE' and old.collection_start is not null and
  (new.date is distinct from old.date or new.collection_start is distinct from old.collection_start or new.collection_end is distinct from old.collection_end or new.driver_id is distinct from old.driver_id) then
  if not ((new.status='cancelled' and current_setting('subnex.close_change',true)='allowed' and new.collection_start is null and new.date is null) or coalesce(current_setting('subnex.slot_change',true),'')='allowed') then raise exception 'CONFIRMED_FIXED';end if;
 end if;
 if tg_op='UPDATE' and new.driver_id is distinct from old.driver_id and
  (exists(select 1 from subnex_private.dispatch_holds where address_id=old.id and state='held')
   or exists(select 1 from public.sms_offers o join public.sms_threads t on t.active_offer_id=o.id where o.address_id=old.id and o.state in ('preparing','awaiting','manual'))) then raise exception 'REQUEST_RESERVED';end if;
 changed:=tg_op='INSERT';
 if tg_op='UPDATE' then changed:=new.date is distinct from old.date or new.driver_id is distinct from old.driver_id or new.collection_start is distinct from old.collection_start or new.collection_end is distinct from old.collection_end
  or new.lat is distinct from old.lat or new.lng is distinct from old.lng or new.text is distinct from old.text or new.estimated_kg is distinct from old.estimated_kg
  or new.service_minutes is distinct from old.service_minutes or new.arrival_mode is distinct from old.arrival_mode
  or new.status in ('new','planned') and old.status not in ('new','planned');end if;
 -- Снятие с запущенного дня по просьбе клиента: адрес уходит в заявки без даты.
 dropping:=tg_op='UPDATE' and coalesce(current_setting('subnex.route_drop',true),'')='allowed'
  and new.status='new' and new.date is null and new.collection_start is null and new.driver_id is not distinct from old.driver_id;
 if changed and new.status in ('new','planned') and not dropping then
  if exists(select 1 from subnex_private.dispatch_days where driver_id=new.driver_id and day=new.date and started_at is not null)
   or tg_op='UPDATE' and exists(select 1 from subnex_private.dispatch_days where driver_id=old.driver_id and day=old.date and started_at is not null)
   then raise exception 'ROUTE_STARTED';end if;
  if new.kind='bank' and new.date is not null and exists(select 1 from public.addresses a where a.id<>new.id and a.bank_id=new.bank_id and a.date=new.date and a.status in ('new','planned')) then raise exception 'DUPLICATE_BANK_VISIT';end if;
  if new.kind<>'bank' and new.date is not null and new.collection_start is null then raise exception 'ROUTE_TIME_REQUIRED';end if;
 end if;
 return new;
end $function$;

-- 2) Перенос по просьбе клиента — из телефона водителя и из пульта.
create or replace function public.subnex_customer_reschedule(p_data jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare a public.addresses; em text; days date[]; d date; r jsonb; g1 text; g2 text;
 today date:=(now() at time zone 'Europe/London')::date;
begin
 if auth.uid() is null or subnex_private.member_role() is null then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 select * into a from public.addresses where id=(p_data->>'address_id')::uuid for update;
 if a.id is null then raise exception 'STALE_ADDRESS'; end if;
 if a.driver_id is null or not subnex_private.can_driver(a.driver_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text,73));
 if a.kind<>'d2d' then raise exception 'USE_CHAT_TO_RESCHEDULE'; end if;
 if a.status not in ('new','planned') then raise exception 'REQUEST_ALREADY_FINISHED'; end if;
 if coalesce((p_data->>'version')::int,a.collection_version)<>a.collection_version then raise exception 'STALE_ADDRESS'; end if;

 -- Прежняя договорённость больше не действует.
 update public.sms_offers set state='superseded'
  where address_id=a.id and state in ('preparing','awaiting','manual','confirmed');
 update public.sms_threads set active_offer_id=null where address_id=a.id;
 update subnex_private.email_offers set state='closed',closed_at=now() where address_id=a.id and state in ('sent','confirmed');
 update subnex_private.dispatch_holds set state='released' where address_id=a.id and state in ('held','confirmed');

 g1:=current_setting('subnex.slot_change',true); g2:=current_setting('subnex.route_drop',true);
 perform set_config('subnex.slot_change','allowed',true); perform set_config('subnex.route_drop','allowed',true);
 update public.addresses set status='new',date=null,collection_start=null,collection_end=null,collection_confirmed_at=null,
   arrival_mode='day',not_before=greatest(coalesce(not_before,today+1),today+1),collection_version=collection_version+1
  where id=a.id;
 perform set_config('subnex.slot_change',coalesce(g1,''),true); perform set_config('subnex.route_drop',coalesce(g2,''),true);

 -- Письмом — тем, кому дату предлагаем по почте (сайт; партнёры без мобильного).
 em:=subnex_private.email_route(a.id);
 if em is not null and (a.intake_channel='subnex_website' or coalesce(subnex_private.phone(a.phone),'')!~'^\+447[0-9]{9}$') then
  begin days:=subnex_private.auto_plan_days(a.id); exception when others then days:='{}'; end;
  select min(x) into d from unnest(days) x where x>today;
  if d is not null then
   r:=subnex_private.email_offer(a.id,d,false);
   if coalesce((r->>'ok')::boolean,false) then
    return jsonb_build_object('ok',true,'channel','email','day',r->>'day');
   end if;
  end if;
  return jsonb_build_object('ok',true,'channel','queue','reason',coalesce(r->>'reason','NO_DAY'));
 end if;
 return jsonb_build_object('ok',true,'channel','queue');
end $function$;

revoke all on function public.subnex_customer_reschedule(jsonb) from public, anon;
grant execute on function public.subnex_customer_reschedule(jsonb) to authenticated;
