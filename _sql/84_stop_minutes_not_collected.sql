-- 84: время на адрес 4 минуты; сообщение «не забрали» клиентам партнёров; фото водителя в письме сайта (12.10.2026).
-- Костя: «давай сделаем 4 минуты на стоп»; клиентам партнёров — SMS, если есть мобильный, иначе письмо;
-- от имени We Recycle Clothes (сайт — SUBNEX); клиентам сайта в письме «не забрали» — маленькое фото с адреса.
-- Сообщение уходит через 15 минут после отметки водителя: если отметка исправлена, оно не уходит.

-- 1. Время на адрес: 4 минуты (было 2).
update subnex_private.auto_plan_config set service_minutes=4 where singleton;
alter table public.addresses alter column service_minutes set default 4;
update public.addresses set service_minutes=4
 where kind='d2d' and status in ('new','planned') and (date is null or date>current_date) and service_minutes is distinct from 4;

-- 2. SMS «не забрали» (новое событие not_collected) с отложенной отправкой.
alter table subnex_private.auto_sms_queue add column if not exists send_after timestamptz;
alter table subnex_private.auto_sms_queue drop constraint if exists auto_sms_queue_event_check;
alter table subnex_private.auto_sms_queue add constraint auto_sms_queue_event_check
 check (event in ('confirmed','collected','cancelled','day_offer','reminder','eta','day_before','not_collected'));

-- 3. Письма: запоминаем параметры, чтобы перед отправкой собрать письмо заново (свежая заметка и фото).
alter table subnex_private.email_outbox add column if not exists extra jsonb;
alter table public.photos add column if not exists mail_token text default replace(gen_random_uuid()::text,'-','');
update public.photos set mail_token=replace(gen_random_uuid()::text,'-','') where mail_token is null;
create unique index if not exists photos_mail_token_key on public.photos(mail_token);
alter table subnex_private.auto_plan_config add column if not exists mail_photo_url text
 default 'https://hgnihlkiccfbrejbpojp.supabase.co/functions/v1/mail-photo';
update subnex_private.auto_plan_config set mail_photo_url='https://hgnihlkiccfbrejbpojp.supabase.co/functions/v1/mail-photo'
 where singleton and mail_photo_url is null;

-- Фото для письма: путь в хранилище по токену (только сервисный ключ, для edge-функции mail-photo).
create or replace function public.subnex_mail_photo(p_token text)
returns text language sql stable security definer set search_path to '' as $$
 select p.path from public.photos p join public.addresses a on a.id=p.address_id
  where p.mail_token=p_token and p_token ~ '^[0-9a-f]{32}$' and a.intake_channel='subnex_website'
    and p.created_at>now()-interval '90 days'
  limit 1
$$;
revoke all on function public.subnex_mail_photo(text) from public, anon, authenticated;
grant execute on function public.subnex_mail_photo(text) to service_role;

-- Последнее фото водителя с адреса (для письма «не забрали»).
create or replace function subnex_private.mail_photo_src(p_address uuid)
returns text language sql stable security definer set search_path to '' as $$
 select c.mail_photo_url||'?t='||p.mail_token
   from public.photos p, subnex_private.auto_plan_config c
  where c.singleton and p.address_id=p_address and p.mail_token is not null and coalesce(c.mail_photo_url,'')<>''
  order by p.created_at desc limit 1
$$;

-- 4. Текст SMS not_collected.
do $m$
declare src text;
begin
 src:=pg_get_functiondef('subnex_private.auto_sms_body(text,jsonb)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('not_collected' in src)=0 then
  src:=replace(src, $o$ elsif p_event='collected' then$o$,
$n$ elsif p_event='not_collected' then
  body:=case when p_snapshot->>'reason'='noanswer'
   then 'Hi from '||brand||': our driver called today to collect your clothing donation but could not find any bags.'
   else 'Hi from '||brand||': our driver visited today but was unable to complete your clothing collection.' end
   ||' If you would still like a collection, just reply to this message and we will arrange a new date.';
 elsif p_event='collected' then$n$);
  if position('not_collected' in src)=0 then raise exception 'PATCH_AUTO_SMS_BODY'; end if;
  execute src;
 end if;
end $m$;

-- Проверка перед отправкой: результат всё ещё «не забрали» на ту же дату.
do $m$
declare src text;
begin
 src:=pg_get_functiondef('subnex_private.auto_sms_invalid(subnex_private.auto_sms_queue)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('not_collected' in src)=0 then
  src:=replace(src, $o$ elsif q.event='collected' and a.status<>'done' then return 'RESULT_CHANGED';$o$,
$n$ elsif q.event='collected' and a.status<>'done' then return 'RESULT_CHANGED';
 elsif q.event='not_collected' and (a.status not in ('noanswer','problem') or a.date is distinct from (q.snapshot->>'day')::date
   ) then return 'RESULT_CHANGED';$n$);
  if position('not_collected' in src)=0 then raise exception 'PATCH_AUTO_SMS_INVALID'; end if;
  execute src;
 end if;
end $m$;

-- Воркер SMS не берёт задания раньше send_after.
do $m$
declare src text;
begin
 src:=pg_get_functiondef('public.subnex_auto_sms_worker(text,text,jsonb)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('send_after' in src)=0 then
  src:=replace(src, $o$where state='pending' or (state='dispatching' and claimed_at<now()-interval '2 minutes')
    order by created_at,id limit 80 loop$o$,
$n$where (state='pending' and coalesce(send_after,'-infinity')<=now()) or (state='dispatching' and claimed_at<now()-interval '2 minutes')
    order by created_at,id limit 80 loop$n$);
  if position('send_after' in src)=0 then raise exception 'PATCH_AUTO_SMS_WORKER'; end if;
  execute src;
 end if;
end $m$;

-- enqueue_auto_sms: срок и задержка для not_collected.
do $m$
declare src text;
begin
 src:=pg_get_functiondef('subnex_private.enqueue_auto_sms(uuid,text,text,uuid,uuid,jsonb)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('send_after' in src)=0 then
  src:=replace(src, $o$  when p_event='eta' then ((snap->>'day')::date+time '23:00') at time zone 'Europe/London'$o$,
$n$  when p_event='eta' then ((snap->>'day')::date+time '23:00') at time zone 'Europe/London'
  when p_event='not_collected' then greatest(now()+interval '2 hours',(current_date+time '21:00') at time zone 'Europe/London')$n$);
  src:=replace(src, $o$insert into subnex_private.auto_sms_queue(address_id,thread_id,event,event_key,phone,snapshot,expires_at)
  values(a.id,t.id,p_event,p_key,num,snap,expiry)$o$,
$n$insert into subnex_private.auto_sms_queue(address_id,thread_id,event,event_key,phone,snapshot,expires_at,send_after)
  values(a.id,t.id,p_event,p_key,num,snap,expiry,case when p_event='not_collected' then now()+interval '15 minutes' end)$n$);
  if position('send_after' in src)=0 or position($x$p_event='not_collected' then greatest$x$ in src)=0 then raise exception 'PATCH_ENQUEUE_AUTO_SMS'; end if;
  execute src;
 end if;
end $m$;

-- cron: будить отправщик только когда есть что отправлять сейчас.
select cron.alter_job((select jobid from cron.job where jobname='subnex-auto-sms'),
 command:=$c$select subnex_private.wake_auto_sms()
 where exists(select 1 from subnex_private.auto_sms_queue
  where (state='pending' and coalesce(send_after,'-infinity')<=now()) or (state='dispatching' and claimed_at<now()-interval '2 minutes'));$c$);

-- 5. Письмо «не забрали» клиентам партнёров без мобильного (с subnex.operations@gmail.com).
create or replace function subnex_private.partner_not_collected_mail(p_address uuid, p_extra jsonb)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare a public.addresses; brand text; driver text; hi text; lead text; tail text; subj text; t text; h text;
begin
 select * into a from public.addresses where id=p_address;
 brand:=case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end;
 driver:=nullif(btrim((select name from public.drivers where id=a.driver_id)),'');
 hi:='Hi '||coalesce(nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),''),'there')||',';
 subj:='We could not collect your donation today';
 lead:=case when coalesce(p_extra->>'reason',a.status)='noanswer'
  then 'Our driver called at '||a.text||' today to collect your clothing donation but could not find any bags.'
  else 'Our driver visited '||a.text||' today but was unable to complete your clothing collection.' end;
 tail:='If you would still like a collection, just reply to this email and we will arrange a new date.';
 t:=hi||E'\n\n'||lead||E'\n\n'||tail||E'\n\nThank you,\n'||coalesce(driver||E'\n','')||brand;
 h:='<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
   ||'<p>'||subnex_private.html_esc(hi)||'</p><p>'||subnex_private.html_esc(lead)||'</p><p>'||subnex_private.html_esc(tail)||'</p>'
   ||'<p>Thank you,<br>'||coalesce(subnex_private.html_esc(driver)||'<br>','')||subnex_private.html_esc(brand)||'</p></div>';
 return jsonb_build_object('subject',subj,'text',t,'html',h,'from_name',brand);
end $$;

-- 6. Фото в письме сайта «не забрали».
do $m$
declare src text;
begin
 src:=pg_get_functiondef('subnex_private.site_mail(text,uuid,jsonb)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('mail_photo_src' in src)=0 then
  src:=replace(src, $o$ v_review text;$o$, $n$ v_review text; photo text;$n$);
  src:=replace(src, $o$  if note is not null then rows:=rows||jsonb_build_array(jsonb_build_array('Driver''s note',note)); end if;$o$,
$n$  if note is not null then rows:=rows||jsonb_build_array(jsonb_build_array('Driver''s note',note)); end if;
  photo:=subnex_private.mail_photo_src(a.id);$n$);
  src:=replace(src, $o$ h:=h||'</table>';
 if btn_url is not null then$o$,
$n$ h:=h||'</table>';
 if photo is not null then
  h:=h||'<div style="font-family:Arial,Helvetica,sans-serif;color:#8888AA;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin:22px 0 8px 0">Photo from our driver</div>'
   ||'<img src="'||subnex_private.html_esc(photo)||'" width="240" alt="Photo taken by our driver at your address" style="display:block;width:240px;max-width:100%;height:auto;border:1px solid #2A2A44;border-radius:12px">';
 end if;
 if btn_url is not null then$n$);
  if position('mail_photo_src' in src)=0 or position('Photo from our driver' in src)=0 then raise exception 'PATCH_SITE_MAIL'; end if;
  execute src;
 end if;
end $m$;

-- site_email_enqueue: сохраняем параметры письма (extra) для пересборки перед отправкой.
do $m$
declare src text;
begin
 src:=pg_get_functiondef('subnex_private.site_email_enqueue(uuid,text,text,jsonb)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('subject,body_text,body_html,extra)' in src)=0 then
  src:=replace(src, $o$insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(oid,p_address,p_kind,p_key,em,m->>'from_name','collections@subnex.co.uk',m->>'subject',m->>'text',m->>'html')$o$,
$n$insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html,extra)
 values(oid,p_address,p_kind,p_key,em,m->>'from_name','collections@subnex.co.uk',m->>'subject',m->>'text',m->>'html',x)$n$);
  if position('subject,body_text,body_html,extra)' in src)=0 then raise exception 'PATCH_SITE_EMAIL_ENQUEUE'; end if;
  execute src;
 end if;
end $m$;

-- Почтовый воркер: письмо «не забрали» собирается заново в момент отправки (свежие заметка, причина, фото).
do $m$
declare src text;
begin
 src:=pg_get_functiondef('public.subnex_email_worker(text,text,jsonb)'::regprocedure);
 src:=replace(src,E'\r','');
 if position('partner_not_collected_mail' in src)=0 then
  src:=replace(src, $o$declare tok subnex_private.intake_tokens;$o$, $n$declare tok subnex_private.intake_tokens; m jsonb; ad public.addresses;$n$);
  src:=replace(src, $o$   update subnex_private.email_outbox set state='sending',claimed_at=now(),attempts=attempts+1 where id=q.id;$o$,
$n$   if q.kind='not_collected' then
    select * into ad from public.addresses where id=q.address_id;
    m:=case when q.from_email is not null
     then subnex_private.site_mail('not_collected',q.address_id,coalesce(q.extra,'{}'::jsonb)||jsonb_build_object('reason',ad.status,'note',ad.result_note,'day',ad.date))
     else subnex_private.partner_not_collected_mail(q.address_id,jsonb_build_object('reason',ad.status)) end;
    update subnex_private.email_outbox set subject=m->>'subject',body_text=m->>'text',body_html=m->>'html' where id=q.id
     returning * into q;
   end if;
   update subnex_private.email_outbox set state='sending',claimed_at=now(),attempts=attempts+1 where id=q.id;$n$);
  if position('partner_not_collected_mail' in src)=0 then raise exception 'PATCH_EMAIL_WORKER'; end if;
  execute src;
 end if;
end $m$;

-- 7. Триггер: клиенту партнёра «не забрали» — SMS (мобильный) или письмо (нет мобильного, есть email).
create or replace function subnex_private.partner_status_notify()
returns trigger language plpgsql security definer set search_path to '' as $$
declare em text; m jsonb; k text;
begin
 if new.kind is distinct from 'd2d' or new.intake_channel='subnex_website' then return new; end if;
 if not (new.status in ('noanswer','problem') and old.status is distinct from new.status and old.status not in ('noanswer','problem')) then return new; end if;
 k:='not_collected:'||coalesce(new.date,current_date);
 if coalesce(subnex_private.phone(new.phone),'') ~ '^\+447[0-9]{9}$' then
  perform subnex_private.enqueue_auto_sms(new.id,'not_collected',k,null,null,
   jsonb_build_object('reason',new.status,'day',coalesce(new.date,current_date)));
 else
  em:=subnex_private.email_route(new.id);
  if em is null then return new; end if;
  m:=subnex_private.partner_not_collected_mail(new.id,jsonb_build_object('reason',new.status));
  insert into subnex_private.email_outbox(address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html,extra)
  values(new.id,'not_collected',k,em,m->>'from_name',null,m->>'subject',m->>'text',m->>'html',jsonb_build_object('reason',new.status))
  on conflict(address_id,event_key) do nothing;
 end if;
 return new;
exception when others then
 -- Сообщение клиенту не должно мешать водителю отметить адрес.
 raise warning 'partner_status_notify: %', sqlerrm;
 return new;
end $$;

drop trigger if exists subnex_partner_status_notify on public.addresses;
create trigger subnex_partner_status_notify after update of status on public.addresses
 for each row execute function subnex_private.partner_status_notify();
