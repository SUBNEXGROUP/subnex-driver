-- 72: ответы клиентов с сайта на наши письма — в чат приложения; ответ из чата уходит письмом (05.10.2026).
-- • Скрипт ящика collections@ раз в несколько минут передаёт новые письма клиентов в subnex_email_inbound.
--   Письмо попадает в переписку «✉ адрес почты» (sms_threads.phone = 'mailto:…'), только если этот адрес
--   уже оставлял заявку на сайте. Остальные письма остаются в почте, как раньше.
-- • Ответ оператора в такой переписке не идёт в Twilio: ops_sms 'prepare' ставит письмо в очередь
--   email_outbox (kind 'reply', с collections@), скрипт отвечает в той же цепочке писем клиента.
-- • Сторож: понятнее тема письма-тревоги.
-- Без DROP. Повторный запуск безопасен; прежние версии — в dispatch_backups '72:…'.

alter table public.sms_threads add column if not exists email_ref jsonb;
alter table subnex_private.email_outbox add column if not exists reply_ref text;
create index if not exists sms_messages_gmail_id on public.sms_messages((request_payload->>'gmail_id'))
 where direction='in' and request_payload ? 'gmail_id';

-- Письмо-ответ: тёмная карточка сайта, внутри — текст оператора как есть.
create or replace function subnex_private.site_reply_html(p_text text) returns text
language sql immutable set search_path to '' as $$
 select '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  ||'<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"></head>'
  ||'<body style="margin:0;padding:0;background:#0D0D1A">'
  ||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D0D1A" style="background:#0D0D1A"><tr><td align="center" style="padding:24px 10px">'
  ||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">'
  ||'<tr><td style="padding:0 4px 20px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
  ||'<td style="padding-right:10px"><img src="https://subnex.co.uk/favicon.png" width="40" height="40" alt="SUBNEX" style="display:block;border:0;border-radius:50%"></td>'
  ||'<td style="font-family:Poppins,Arial,Helvetica,sans-serif;line-height:1.1"><div style="color:#FFFFFF;font-size:18px;font-weight:800;letter-spacing:-.2px">SUBNEX</div>'
  ||'<div style="color:#2ECC71;font-size:10px;font-weight:700;letter-spacing:3px">GROUP</div></td></tr></table></td></tr>'
  ||'<tr><td bgcolor="#1C1C30" style="background:#1C1C30;border:1px solid #2A2A44;border-radius:22px;padding:26px 22px;font-family:Arial,Helvetica,sans-serif;color:#FFFFFF;font-size:15px;line-height:1.65">'
  ||replace(subnex_private.html_esc(btrim(p_text)),E'\n','<br>')
  ||'<div style="margin-top:20px;color:#8888AA;font-size:14px">SUBNEX</div></td></tr>'
  ||'<tr><td align="center" style="padding:22px 10px 0 10px;font-family:Arial,Helvetica,sans-serif;color:#8888AA;font-size:12px;line-height:1.6">'
  ||'SUBNEX Group &middot; Free home clothing collection across South Wales<br>'
  ||'<a href="https://subnex.co.uk" style="color:#2ECC71;text-decoration:none;font-weight:bold">subnex.co.uk</a> &nbsp;&middot;&nbsp; '
  ||'<a href="mailto:collections@subnex.co.uk" style="color:#2ECC71;text-decoration:none">collections@subnex.co.uk</a></td></tr>'
  ||'</table></td></tr></table></body></html>'
$$;

-- Входящее письмо клиента (вызывает скрипт ящика collections@ с секретом приёма).
create or replace function public.subnex_email_inbound(p_secret text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare tok subnex_private.intake_tokens; a public.addresses; t public.sms_threads;
 em text:=lower(btrim(coalesce(p_data->>'from','')));
 gid text:=left(btrim(coalesce(p_data->>'message_id','')),100);
 body text:=left(btrim(coalesce(p_data->>'body','')),3000);
 subj text:=left(btrim(coalesce(p_data->>'subject','')),200);
begin
 if p_secret is null or length(p_secret)<32 then perform pg_sleep(0.5); raise exception 'EMAIL_DENIED' using errcode='42501'; end if;
 select * into tok from subnex_private.intake_tokens where secret=p_secret and active;
 if tok.id is null then perform pg_sleep(0.5); raise exception 'EMAIL_DENIED' using errcode='42501'; end if;
 if gid='' or em !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then return '{"ok":false,"reason":"BAD_INPUT"}'; end if;
 if exists(select 1 from public.sms_messages m where m.direction='in' and m.request_payload ? 'gmail_id'
    and m.request_payload->>'gmail_id'=gid) then return '{"ok":true,"duplicate":true}'; end if;
 select * into a from public.addresses x
  where lower(btrim(x.contact_email))=em and x.intake_channel='subnex_website' and x.kind='d2d'
  order by (x.status in ('new','planned')) desc, x.created_at desc limit 1;
 if a.id is null then return '{"ok":true,"matched":false}'; end if;
 if body='' then body:='(no text)'; end if;
 perform pg_advisory_xact_lock(hashtextextended('mailto:'||em,5));
 insert into public.sms_threads(phone,driver_id,email_ref,needs_attention,last_activity)
 values('mailto:'||em,a.driver_id,jsonb_build_object('address_id',a.id,'text',a.text,'source',a.collection_source,
   'name',a.contact_name,'status',a.status,'date',a.date),true,now())
 on conflict(phone) do update set email_ref=excluded.email_ref,needs_attention=true,last_activity=now(),
   driver_id=coalesce(excluded.driver_id,public.sms_threads.driver_id)
 returning * into t;
 insert into public.sms_messages(thread_id,direction,body,status,request_payload)
 values(t.id,'in',body,'received',jsonb_build_object('channel','email','gmail_id',gid,'subject',subj,
   'from_name',left(coalesce(p_data->>'from_name',''),100)));
 return jsonb_build_object('ok',true,'matched',true);
end $$;
revoke all on function public.subnex_email_inbound(text,jsonb) from public;
grant execute on function public.subnex_email_inbound(text,jsonb) to anon, authenticated;

-- Ответ оператора в переписке по почте: письмо в очередь вместо SMS. Те же проверки, что у SMS.
create or replace function subnex_private.email_reply_prepare(p_user uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare m public.ops_members; t public.sms_threads; msg public.sms_messages; old public.sms_messages;
 rid uuid; txt text; em text; aid uuid; subj text; gid text;
begin
 select * into m from public.ops_members where user_id=p_user and active;
 if m.user_id is null or (m.role='driver' and not exists(select 1 from public.drivers where id=m.driver_id and active)) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 select * into t from public.sms_threads where id=nullif(p_data->>'thread_id','')::uuid for update;
 if t.id is null or t.phone not like 'mailto:%' or (m.role<>'admin' and t.driver_id is distinct from m.driver_id) then
  raise exception 'ACCESS_DENIED' using errcode='42501';
 end if;
 rid:=nullif(p_data->>'request_id','')::uuid;
 if rid is null then raise exception 'REQUEST_ID_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,2));
 select * into old from public.sms_messages where actor_id=p_user and request_id=rid;
 if found then
  if old.thread_id<>t.id or old.request_payload is distinct from p_data then raise exception 'REQUEST_ID_REUSED'; end if;
  return jsonb_build_object('dispatch',false,'message',to_jsonb(old));
 end if;
 if coalesce(p_data->>'kind','reply')<>'reply' then raise exception 'MESSAGE_KIND'; end if;
 txt:=btrim(coalesce(p_data->>'body',''));
 if length(txt)<1 or length(txt)>1000 then raise exception 'MESSAGE_LENGTH'; end if;
 em:=substr(t.phone,8);
 aid:=nullif(t.email_ref->>'address_id','')::uuid;
 if aid is null or not exists(select 1 from public.addresses where id=aid) then raise exception 'ADDRESS_REQUIRED'; end if;
 if exists(select 1 from public.sms_messages where thread_id=t.id and direction='out' and body=txt
   and created_at>now()-interval '1 minute' and status<>'failed') then raise exception 'RECENT_DUPLICATE'; end if;
 if (select count(*) from public.sms_messages where actor_id=p_user and direction='out' and created_at>now()-interval '1 minute')>=30
   or (select count(*) from public.sms_messages where actor_id=p_user and direction='out' and created_at>now()-interval '24 hours')>=1000
   then raise exception 'RATE_LIMIT'; end if;
 select x.request_payload->>'subject', x.request_payload->>'gmail_id' into subj, gid from public.sms_messages x
  where x.thread_id=t.id and x.direction='in' and x.request_payload ? 'gmail_id' order by x.created_at desc, x.id desc limit 1;
 subj:=coalesce(nullif(btrim(subj),''),'Your SUBNEX collection');
 if subj !~* '^re:' then subj:='Re: '||subj; end if;
 insert into public.sms_messages(thread_id,direction,body,status,actor_id,request_id,request_payload)
 values(t.id,'out',txt,'email_queued',p_user,rid,p_data) returning * into msg;
 insert into subnex_private.email_outbox(address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html,reply_ref)
 values(aid,'reply','reply:'||msg.id,em,'SUBNEX','collections@subnex.co.uk',left(subj,200),
  txt||E'\n\nSUBNEX\nsubnex.co.uk',subnex_private.site_reply_html(txt),gid);
 update public.sms_threads set last_activity=now() where id=t.id;
 return jsonb_build_object('dispatch',false,'message',to_jsonb(msg));
end $$;
revoke all on function subnex_private.email_reply_prepare(uuid,jsonb) from public;

do $patch$
declare def text; f text; pairs text[]; i int; marker text;
begin
 foreach f in array array['public.ops_sms(uuid,text,jsonb)','public.ops_sms_before_dispatch(uuid,text,jsonb)','public.subnex_email_worker(text,text,jsonb)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  marker:=case f when 'public.ops_sms(uuid,text,jsonb)' then 'email_reply_prepare'
                 when 'public.ops_sms_before_dispatch(uuid,text,jsonb)' then 'email_ref' else 'reply_ref' end;
  if position(marker in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='72:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('72:'||f,def);
  end if;
  pairs:=case f
   when 'public.ops_sms(uuid,text,jsonb)' then array[
    $q$ return public.ops_sms_before_dispatch(p_user,p_action,p_data);$q$,
    $q$ if p_action='prepare' and exists(select 1 from public.sms_threads where id=nullif(p_data->>'thread_id','')::uuid and phone like 'mailto:%') then
  return subnex_private.email_reply_prepare(p_user,p_data);
 end if;
 return public.ops_sms_before_dispatch(p_user,p_action,p_data);$q$]
   when 'public.ops_sms_before_dispatch(uuid,text,jsonb)' then array[
    $q$coalesce(ad.text,th.closed_request->>'text') as address$q$,
    $q$coalesce(ad.text,th.closed_request->>'text',th.email_ref->>'text') as address$q$,
    $q$or coalesce(ad.text,th.closed_request->>'text') ilike$q$,
    $q$or coalesce(ad.text,th.closed_request->>'text',th.email_ref->>'text') ilike$q$,
    $q$coalesce(ad.collection_source,th.closed_request->>'source')=p_data->>'source'$q$,
    $q$coalesce(ad.collection_source,th.closed_request->>'source',th.email_ref->>'source')=p_data->>'source'$q$]
   else array[
    $q$'subject',q.subject,'text',q.body_text,'html',q.body_html));$q$,
    $q$'subject',q.subject,'text',q.body_text,'html',q.body_html,'reply_ref',q.reply_ref));$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;

-- Сторож: тема письма-тревоги — какой ящик и чьи письма.
create or replace function subnex_private.email_watchdog() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s text; n int; silent boolean; box text; script text; fn text; res jsonb:='{}'; t text;
begin
 if not coalesce((select email_enabled from subnex_private.auto_plan_config where singleton),false) then return '{"enabled":false}'; end if;
 foreach s in array array['ops','collections'] loop
  select count(*) into n from subnex_private.email_outbox
   where state in ('pending','sending') and coalesce(from_email,'')=case s when 'ops' then '' else 'collections@subnex.co.uk' end
     and created_at<now()-case when kind='not_collected' then interval '40 minutes' else interval '20 minutes' end;
  silent:=exists(select 1 from subnex_private.mail_senders m where m.sender=s and m.last_claim_at<now()-interval '30 minutes');
  if (n>0 or silent) and not exists(select 1 from subnex_private.mail_alerts a where a.about=s and a.created_at>now()-interval '3 hours') then
   box:=case s when 'ops' then 'subnex.operations@gmail.com' else 'collections@subnex.co.uk (ящик info@subnex.co.uk)' end;
   script:=case s when 'ops' then '«SUBNEX — приём заявок с почты»' else '«Subnex Collection Auto Reply»' end;
   fn:=case s when 'ops' then 'проверитьОтправкуПисем, затем включитьОтправкуПисем' else 'сайтПроверить, затем сайтВключить' end;
   t:='Письма клиентам не уходят с адреса '||box||'.'||E'\n\n'
     ||case when n>0 then 'В очереди ждут писем дольше 20 минут: '||n||'.'||E'\n' else '' end
     ||case when silent then 'Скрипт отправки не выходил на связь больше 30 минут.'||E'\n' else '' end
     ||E'\nЧто сделать: открой script.google.com под этим ящиком, проект '||script||', запусти '||fn||'. '
     ||'Письма из очереди уйдут сами, ничего не потеряется.'||E'\n\nSUBNEX';
   insert into subnex_private.mail_alerts(via,about,to_email,subject,body_text,body_html)
   values(case s when 'ops' then 'collections' else 'ops' end,s,'info@subnex.co.uk',
    case s when 'ops' then 'SUBNEX: не уходят письма партнёрским клиентам' else 'SUBNEX: не уходят письма клиентам с сайта' end,t,
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
    ||replace(subnex_private.html_esc(t),E'\n','<br>')||'</div>');
  end if;
  res:=res||jsonb_build_object(s,jsonb_build_object('stuck',n,'silent',silent));
 end loop;
 return res;
end $$;
revoke all on function subnex_private.email_watchdog() from public;
