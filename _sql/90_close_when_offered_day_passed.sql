-- 90: дату предлагали, клиент не ответил, день прошёл → закрыть сразу (Костя, 14.10.2026: «Сразу закрыть»).
-- SMS-клиенты: close_request(...,'no_reply',true) → SMS «We did not hear back, so we have closed your collection request…».
-- Письмо (сайт и партнёры без мобильного): close_request(...,'no_reply',false) + письмо 'closed'.
-- Не трогает: клиент ответил после предложения (переписка), есть активное предложение/удержание, дата ещё не наступила.
-- cron 'subnex-close-passed-offers' в :05 и :35, только в часы sms_from_hour..sms_to_hour. Применено через MCP.
create or replace function subnex_private.close_passed_offers()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare c subnex_private.auto_plan_config; r record; today date:=(now() at time zone 'Europe/London')::date; n_sms int:=0; n_mail int:=0; res jsonb;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 if subnex_private.uk_hour() not between c.sms_from_hour and c.sms_to_hour-1 then return '{"due":false}'; end if;
 for r in
  select a.id from public.addresses a
   where a.kind='d2d' and a.status='new' and a.date is null and a.collection_start is null
     and not exists(select 1 from public.sms_offers o where o.address_id=a.id and o.state in ('preparing','awaiting','manual'))
     and not exists(select 1 from subnex_private.dispatch_holds h where h.address_id=a.id and h.state='held')
     and not exists(select 1 from subnex_private.email_offers e where e.address_id=a.id and e.state='sent')
     and exists(select 1 from public.sms_offers o where o.address_id=a.id and o.state='expired'
                 and (o.starts_at at time zone 'Europe/London')::date<=today
                 and o.created_at=(select max(o2.created_at) from public.sms_offers o2 where o2.address_id=a.id)
                 and not exists(select 1 from public.sms_messages m join public.sms_threads t on t.id=m.thread_id
                                 where t.phone=subnex_private.phone(a.phone) and m.direction='in' and m.created_at>o.created_at))
 loop
  res:=subnex_private.close_request(r.id,'no_reply',true);
  if coalesce((res->>'closed')::boolean,false) then n_sms:=n_sms+1; end if;
 end loop;
 for r in
  select distinct on (a.id) a.id, e.id offer_id from public.addresses a join subnex_private.email_offers e on e.address_id=a.id
   where a.kind='d2d' and a.status='new' and a.date is null and a.collection_start is null
     and e.state='expired' and e.day<=today
     and not exists(select 1 from subnex_private.email_offers e2 where e2.address_id=a.id and e2.created_at>e.created_at)
     and not exists(select 1 from public.sms_offers o where o.address_id=a.id and o.state in ('preparing','awaiting','manual'))
     and not exists(select 1 from subnex_private.dispatch_holds h where h.address_id=a.id and h.state='held')
   order by a.id, e.created_at desc
 loop
  res:=subnex_private.close_request(r.id,'no_reply',false);
  if coalesce((res->>'closed')::boolean,false) then
   update subnex_private.email_offers set state='closed',closed_at=now() where id=r.offer_id;
   perform subnex_private.email_enqueue(r.offer_id,'closed','closed:'||r.offer_id);
   n_mail:=n_mail+1;
  end if;
 end loop;
 return jsonb_build_object('due',true,'sms',n_sms,'email',n_mail);
end $$;

select cron.schedule('subnex-close-passed-offers','5,35 * * * *','select subnex_private.close_passed_offers()');
