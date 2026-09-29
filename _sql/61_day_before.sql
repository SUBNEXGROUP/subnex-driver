-- 61_day_before.sql — одно дружелюбное напоминание накануне сбора (29.09.2026).
--
-- В day_before_hour (18:00 UK) накануне: всем подтверждённым адресам завтрашнего маршрута (все источники).
-- Британский мобильный → SMS через обычную очередь авто-SMS (событие day_before);
-- мобильного нет, есть email и письма включены → письмо через email_outbox (kind day_before).
-- Одно на адрес и дату (ключ day_before:YYYY-MM-DD). Утреннее окно прибытия (eta) остаётся как было.
-- Перед отправкой проверяется, что адрес всё ещё в маршруте на эту дату; после 21:00 накануне не отправляется.
-- Повторный запуск безопасен; прежние версии правленых функций — в dispatch_backups под именем '61:…'.

alter table subnex_private.auto_plan_config
  add column if not exists day_before_hour int not null default 18;

alter table subnex_private.auto_sms_queue drop constraint if exists auto_sms_queue_event_check;
alter table subnex_private.auto_sms_queue add constraint auto_sms_queue_event_check
  check (event = any (array['confirmed','collected','cancelled','day_offer','reminder','eta','day_before']));

alter table subnex_private.email_outbox drop constraint if exists email_outbox_kind_check;
alter table subnex_private.email_outbox add constraint email_outbox_kind_check
  check (kind in ('day_offer','reminder','confirmed','collected','closed','day_before'));

-- Письмо-напоминание накануне (клиенты без мобильного).
create or replace function subnex_private.email_day_before(p_address uuid, p_day date) returns uuid
language plpgsql security definer set search_path to '' as $$
declare a public.addresses; em text; brand text; driver text; hi text; day_txt text; subj text; lead text; mid text; tail text;
 t text; h text; oid uuid; qid uuid;
begin
 select * into a from public.addresses where id=p_address;
 if a.id is null then return null; end if;
 em:=lower(btrim(coalesce(a.contact_email,'')));
 if em !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then return null; end if;
 brand:=case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end;
 driver:=nullif(btrim((select name from public.drivers where id=a.driver_id)),'');
 hi:='Hi '||coalesce(nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),''),'there')||',';
 day_txt:=to_char(p_day,'FMDay FMDD FMMonth');
 subj:='Reminder: your clothing collection is tomorrow';
 lead:='Just a friendly reminder that we are collecting your clothing donation from '||a.text||' tomorrow, '||day_txt||'.';
 mid:='Please have your bags ready in the morning and leave them where we can see them from the street.';
 tail:='If your plans have changed, just reply to this email and let us know.';
 t:=hi||E'\n\n'||lead||E'\n\n'||mid||E'\n\n'||tail||E'\n\nThank you,\n'||coalesce(driver||E'\n','')||brand;
 h:='<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
   ||'<p>'||subnex_private.html_esc(hi)||'</p><p>'||subnex_private.html_esc(lead)||'</p><p>'||subnex_private.html_esc(mid)||'</p>'
   ||'<p>'||subnex_private.html_esc(tail)||'</p><p>Thank you,<br>'||coalesce(subnex_private.html_esc(driver)||'<br>','')||subnex_private.html_esc(brand)||'</p></div>';
 select id into oid from subnex_private.email_offers where address_id=a.id order by created_at desc limit 1;
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,subject,body_text,body_html)
 values(oid,a.id,'day_before','day_before:'||p_day,em,brand,subj,t,h)
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;
revoke all on function subnex_private.email_day_before(uuid,date) from public;

-- Проход автоподбора: с day_before_hour до sms_to_hour ставит напоминания на завтра. Повторы отсекаются ключом.
create or replace function subnex_private.day_before_reminders() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c subnex_private.auto_plan_config; d date:=(now() at time zone 'Europe/London')::date+1; r record; res jsonb; q uuid;
 n_sms int:=0; n_mail int:=0; n_none int:=0;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 if subnex_private.uk_hour()<c.day_before_hour or subnex_private.uk_hour()>=c.sms_to_hour then return '{"due":false}'; end if;
 for r in select a.id,a.phone,a.contact_email from public.addresses a
   where a.kind='d2d' and a.status='planned' and a.date=d and a.collection_start is not null
     and not exists(select 1 from subnex_private.auto_sms_queue x where x.address_id=a.id and x.event_key='day_before:'||d)
     and not exists(select 1 from subnex_private.email_outbox x where x.address_id=a.id and x.event_key='day_before:'||d)
 loop
  if coalesce(subnex_private.phone(r.phone),'') ~ '^\+447[0-9]{9}$' then
   res:=subnex_private.enqueue_auto_sms(r.id,'day_before','day_before:'||d,null,null,jsonb_build_object('day',d));
   if res->>'state'='pending' then n_sms:=n_sms+1; else n_none:=n_none+1; end if;
  elsif c.email_enabled then
   q:=subnex_private.email_day_before(r.id,d);
   if q is not null then n_mail:=n_mail+1; else n_none:=n_none+1; end if;
  else
   n_none:=n_none+1;
  end if;
 end loop;
 return jsonb_build_object('due',true,'day',d,'sms',n_sms,'email',n_mail,'none',n_none);
end $$;
revoke all on function subnex_private.day_before_reminders() from public;

-- Правки существующих функций: один раз, с бэкапом.
do $patch$
declare def text; f text; pairs text[]; i int;
begin
 foreach f in array array['subnex_private.auto_sms_body(text,jsonb)','subnex_private.auto_sms_invalid(subnex_private.auto_sms_queue)',
   'subnex_private.enqueue_auto_sms(uuid,text,text,uuid,uuid,jsonb)','subnex_private.auto_plan()','public.subnex_email_worker(text,text,jsonb)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  if position('day_before' in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='61:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('61:'||f,def);
  end if;
  pairs:=case f
   when 'subnex_private.auto_sms_body(text,jsonb)' then array[
    $q$ elsif p_event='collected' then$q$,
    $q$ elsif p_event='day_before' then
  body:='Hi from '||brand||': a friendly reminder that we are collecting your clothing donation tomorrow, '
   ||subnex_private.sms_date((p_snapshot->>'day')::date)||'. Please have your bags ready in the morning. If your plans have changed, just reply to this message.';
 elsif p_event='collected' then$q$]
   when 'subnex_private.auto_sms_invalid(subnex_private.auto_sms_queue)' then array[
    $q$ elsif q.event='eta' then$q$,
    $q$ elsif q.event='day_before' then
  if a.status<>'planned' or a.date is distinct from (q.snapshot->>'day')::date or a.collection_start is null then return 'APPOINTMENT_CHANGED'; end if;
 elsif q.event='eta' then$q$]
   when 'subnex_private.enqueue_auto_sms(uuid,text,text,uuid,uuid,jsonb)' then array[
    $q$when p_event='eta' then$q$,
    $q$when p_event='day_before' then ((snap->>'day')::date-1+time '21:00') at time zone 'Europe/London'
  when p_event='eta' then$q$]
   when 'subnex_private.auto_plan()' then array[
    $q$fu:=fu||jsonb_build_object('email',subnex_private.email_followups());$q$,
    $q$fu:=fu||jsonb_build_object('email',subnex_private.email_followups()); fu:=fu||jsonb_build_object('day_before',subnex_private.day_before_reminders());$q$,
    $q$' · email '||(fu->'email')::text else '' end$q$,
    $q$' · email '||(fu->'email')::text else '' end||case when coalesce((fu->'day_before'->>'sms')::int,0)+coalesce((fu->'day_before'->>'email')::int,0)>0 then ' · day-before '||(fu->'day_before')::text else '' end$q$]
   else array[
    $q$   if q.kind in ('day_offer','reminder') and$q$,
    $q$   if q.kind='day_before' and (now()>((split_part(q.event_key,':',2)::date-1+time '21:00') at time zone 'Europe/London')
       or not exists(select 1 from public.addresses x where x.id=q.address_id and x.status='planned' and x.date=split_part(q.event_key,':',2)::date)) then
    update subnex_private.email_outbox set state='skipped',error='APPOINTMENT_CHANGED' where id=q.id; continue;
   end if;
   if q.kind in ('day_offer','reminder') and$q$]
  end;
  i:=1;
  while i<array_length(pairs,1) loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then
    raise exception 'PATCH_61 % #%: not found or not unique',f,(i+1)/2;
   end if;
   def:=replace(def,pairs[i],pairs[i+1]);
   i:=i+2;
  end loop;
  execute def;
 end loop;
end $patch$;
