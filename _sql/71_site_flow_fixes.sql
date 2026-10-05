-- 71: доработки потока писем клиентам с сайта (05.10.2026).
-- 1. Заявка не из наших зон: сразу закрывается с причиной area_not_served_yet, клиенту письмо
--    «пока не обслуживаем, но скоро будем». На сайте есть проверка индекса до отправки (subnex_area_check).
-- 2. Письмо «не смогли забрать» уходит через 15 минут и только если статус всё ещё «нет дома»/«проблема»
--    (водитель мог исправить ошибку).
-- 3. Сторож: если отправщик писем молчит >30 минут или письма ждут >20 минут — письмо на info@
--    через другой отправщик (не чаще раза в 3 часа на каждый).
-- 4. Ссылка «Choose a new date» в письмах «не смогли забрать», «отменено», «закрыто»: клиент сам
--    записывается на новый день своей зоны (subnex_rebook).
-- 5. Лимиты по IP для формы сайта: 5 заявок в час и 15 в сутки с одного адреса.
-- Без DROP функций/триггеров. Повторный запуск безопасен; прежние версии — в dispatch_backups '71:…'.

alter table subnex_private.web_bookings add column if not exists ip text;
create table if not exists subnex_private.mail_senders(
 sender text primary key, last_claim_at timestamptz not null default now());
create table if not exists subnex_private.mail_alerts(
 id uuid primary key default gen_random_uuid(), via text not null, about text not null, to_email text not null,
 subject text not null, body_text text not null, body_html text not null, state text not null default 'pending',
 attempts int not null default 0, claimed_at timestamptz, sent_at timestamptz, error text, created_at timestamptz not null default now());
create table if not exists subnex_private.rebook_links(
 token text primary key default encode(extensions.gen_random_bytes(32),'hex'),
 address_id uuid not null references public.addresses(id) on delete cascade,
 created_at timestamptz not null default now(), used_at timestamptz, new_address_id uuid);
revoke all on subnex_private.mail_senders, subnex_private.mail_alerts, subnex_private.rebook_links from public, anon, authenticated;

alter table subnex_private.email_outbox drop constraint if exists email_outbox_kind_check;
alter table subnex_private.email_outbox add constraint email_outbox_kind_check
 check (kind in ('day_offer','reminder','confirmed','collected','closed','day_before','received','eta','not_collected','cancelled','reply'));

-- Письма клиентам с сайта: ссылка на новую запись в письмах «не забрали / отменено / закрыто».
create or replace function subnex_private.site_email_enqueue(p_address uuid, p_kind text, p_key text, p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare em text; m jsonb; qid uuid; oid uuid; tok text; x jsonb:=coalesce(p_extra,'{}'::jsonb);
begin
 em:=subnex_private.site_email(p_address);
 if em is null then return null; end if;
 if p_kind in ('not_collected','cancelled','closed') and coalesce(x->>'reason','') not like 'area_not_served%'
    and coalesce(x->>'reason','') not in ('duplicate','already_collected')
    and not exists(select 1 from subnex_private.email_outbox o where o.address_id=p_address and o.event_key=p_key) then
  insert into subnex_private.rebook_links(address_id) values(p_address) returning token into tok;
  x:=x||jsonb_build_object('rebook',(select c.email_confirm_url from subnex_private.auto_plan_config c where c.singleton)||'?r='||tok);
 end if;
 m:=subnex_private.site_mail(p_kind,p_address,x);
 select id into oid from subnex_private.email_offers where address_id=p_address order by created_at desc limit 1;
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(oid,p_address,p_kind,p_key,em,m->>'from_name','collections@subnex.co.uk',m->>'subject',m->>'text',m->>'html')
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;

-- Письма по предложениям: клиенты с сайта идут через site_email_enqueue (одно оформление, ссылка на новую дату).
create or replace function subnex_private.email_enqueue(p_offer uuid, p_kind text, p_key text) returns uuid
language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; m jsonb; qid uuid; site boolean;
begin
 select * into e from subnex_private.email_offers where id=p_offer;
 if e.id is null then return null; end if;
 site:=exists(select 1 from public.addresses a where a.id=e.address_id and a.intake_channel='subnex_website');
 if site then
  return subnex_private.site_email_enqueue(e.address_id,p_kind,p_key,jsonb_build_object('day',e.day,
   'link',(select c.email_confirm_url||'?t='||e.token from subnex_private.auto_plan_config c where c.singleton)));
 end if;
 m:=subnex_private.email_content(p_kind,e.id);
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(e.id,e.address_id,p_kind,p_key,e.email,m->>'from_name',null,m->>'subject',m->>'text',m->>'html')
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;

do $patch$
declare def text; f text; pairs text[]; i int; marker text;
begin
 foreach f in array array['subnex_private.site_mail(text,uuid,jsonb)','public.subnex_email_worker(text,text,jsonb)','public.subnex_web_booking(jsonb)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  marker:=case f when 'subnex_private.site_mail(text,uuid,jsonb)' then 'area_not_served_yet'
                 when 'public.subnex_email_worker(text,text,jsonb)' then 'mail_alerts' else 'v_ip' end;
  if position(marker in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='71:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('71:'||f,def);
  end if;
  pairs:=case f
   when 'subnex_private.site_mail(text,uuid,jsonb)' then array[
    $q$ elsif p_kind='cancelled' then$q$,
    $q$ elsif p_kind='cancelled' and reason='area_not_served_yet' then
  subj:='We are not collecting in your area just yet'; eyebrow:='Coming soon'; h1:='We are not in your area yet, '||first;
  intro:='Thank you for your request. At the moment we do not collect in your area, but we are growing and plan to cover more of South Wales soon.';
  rows:=jsonb_build_array(jsonb_build_array('Your address',a.text));
  tip:='We have kept your details and will be in touch as soon as we start collecting near you.'; step:=0;
 elsif p_kind='cancelled' then$q$,
    $q$ t:=h1||E'\n\n'||intro||E'\n\n';$q$,
    $q$ if nullif(p_extra->>'rebook','') is not null and p_kind in ('not_collected','cancelled','closed') then
  btn:='Choose a new date'; btn_url:=p_extra->>'rebook';
  tip:=case when p_kind='not_collected' then 'Choose a new date that suits you, or just reply to this email.'
       else 'If you would still like a collection, choose a new date or just reply to this email.' end;
 end if;
 t:=h1||E'\n\n'||intro||E'\n\n';$q$]
   when 'public.subnex_email_worker(text,text,jsonb)' then array[
    $q$declare tok subnex_private.intake_tokens; q subnex_private.email_outbox; jobs jsonb:='[]'; lim int; st text;$q$,
    $q$declare tok subnex_private.intake_tokens; q subnex_private.email_outbox; jobs jsonb:='[]'; lim int; st text;
 al subnex_private.mail_alerts; snd text:=case when coalesce(nullif(lower(btrim(p_data->>'from')),''),'')='' then 'ops' else 'collections' end;$q$,
    $q$  lim:=least(greatest(coalesce((p_data->>'limit')::int,10),1),20);$q$,
    $q$  lim:=least(greatest(coalesce((p_data->>'limit')::int,10),1),20);
  insert into subnex_private.mail_senders(sender,last_claim_at) values(snd,now()) on conflict(sender) do update set last_claim_at=now();$q$,
    $q$      and coalesce(from_email,'')=coalesce(nullif(lower(btrim(p_data->>'from')),''),'')$q$,
    $q$      and coalesce(from_email,'')=coalesce(nullif(lower(btrim(p_data->>'from')),''),'')
      and not (kind='not_collected' and created_at>now()-interval '15 minutes')$q$,
    $q$   if q.kind in ('day_offer','reminder') and$q$,
    $q$   if q.kind='not_collected' and not exists(select 1 from public.addresses x where x.id=q.address_id and x.status in ('noanswer','problem')) then
    update subnex_private.email_outbox set state='skipped',error='STATUS_CHANGED' where id=q.id; continue;
   end if;
   if q.kind in ('day_offer','reminder') and$q$,
    $q$  return jsonb_build_object('jobs',jobs);$q$,
    $q$  for al in select * from subnex_private.mail_alerts
    where via=snd and (state='pending' or (state='sending' and claimed_at<now()-interval '10 minutes' and attempts<3))
    order by created_at limit 3 for update skip locked
  loop
   update subnex_private.mail_alerts set state='sending',claimed_at=now(),attempts=attempts+1 where id=al.id;
   jobs:=jobs||jsonb_build_array(jsonb_build_object('id',al.id,'to',al.to_email,'from_name','SUBNEX system',
    'from_email',case when snd='collections' then 'collections@subnex.co.uk' end,'subject',al.subject,'text',al.body_text,'html',al.body_html));
  end loop;
  return jsonb_build_object('jobs',jobs);$q$,
    $q$  return jsonb_build_object('ok',found);$q$,
    $q$  if not found then
   update subnex_private.mail_alerts set state=st,sent_at=case when st='sent' then now() end,error=left(nullif(p_data->>'error',''),300)
    where id=(p_data->>'id')::uuid and state='sending';
   return jsonb_build_object('ok',found);
  end if;
  update public.sms_messages m set status=case when st='sent' then 'email_sent' else 'failed' end,updated_at=now()
   from subnex_private.email_outbox o
   where o.id=(p_data->>'id')::uuid and o.kind='reply' and m.id=nullif(split_part(o.event_key,':',2),'')::uuid;
  return jsonb_build_object('ok',true);$q$]
   else array[
    $q$ v_lat float8; v_lng float8; v_days date[]; v_res jsonb; v_offered boolean:=false;$q$,
    $q$ v_lat float8; v_lng float8; v_days date[]; v_res jsonb; v_offered boolean:=false; z subnex_private.dispatch_zones;
 v_ip text:=left(btrim(split_part(coalesce(current_setting('request.headers',true)::json->>'cf-connecting-ip',
   current_setting('request.headers',true)::json->>'x-forwarded-for',''),',',1)),64);$q$,
    $q$   or (select count(*) from subnex_private.web_bookings w where w.created_at>now()-interval '1 day')>=300 then$q$,
    $q$   or (select count(*) from subnex_private.web_bookings w where w.created_at>now()-interval '1 day')>=300
   or (v_ip<>'' and (select count(*) from subnex_private.web_bookings w where w.ip=v_ip and w.created_at>now()-interval '1 hour')>=5)
   or (v_ip<>'' and (select count(*) from subnex_private.web_bookings w where w.ip=v_ip and w.created_at>now()-interval '1 day')>=15) then$q$,
    $q$ if v_existing is null and v_lat is not null then$q$,
    $q$ if v_existing is null then
  z:=subnex_private.dispatch_zone_for(v_text);
  if z.code is null or z.mode='off' then
   perform subnex_private.close_request(v_id,'area_not_served_yet',false);
   return jsonb_build_object('ok',true,'served',false);
  end if;
 end if;
 if v_existing is null and v_lat is not null then$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  if f='public.subnex_web_booking(jsonb)' then
   def:=replace(replace(def,'insert into subnex_private.web_bookings(email,','insert into subnex_private.web_bookings(ip,email,'),'values(v_email,v_phone_raw,v_pc,','values(v_ip,v_email,v_phone_raw,v_pc,');
  end if;
  execute def;
 end loop;
end $patch$;

-- Проверка индекса для сайта (anon): обслуживаем ли этот район.
create or replace function public.subnex_area_check(p_postcode text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare pc text:=upper(regexp_replace(left(btrim(coalesce(p_postcode,'')),12),'\s+','','g')); z subnex_private.dispatch_zones;
begin
 if pc !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$' then return '{"valid":false}'; end if;
 pc:=left(pc,length(pc)-3)||' '||right(pc,3);
 z:=subnex_private.dispatch_zone_for('x '||pc);
 return jsonb_build_object('valid',true,'served',z.code is not null and z.mode<>'off');
end $$;
revoke all on function public.subnex_area_check(text) from public;
grant execute on function public.subnex_area_check(text) to anon, authenticated;

-- Сторож отправки писем.
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
   box:=case s when 'ops' then 'subnex.operations@gmail.com' else 'info@subnex.co.uk (collections@subnex.co.uk)' end;
   script:=case s when 'ops' then '«SUBNEX — приём заявок с почты»' else '«Subnex Collection Auto Reply»' end;
   fn:=case s when 'ops' then 'проверитьОтправкуПисем, затем включитьОтправкуПисем' else 'сайтПроверить, затем сайтВключить' end;
   t:='Письма клиентам не уходят из ящика '||box||'.'||E'\n\n'
     ||case when n>0 then 'В очереди ждут писем дольше 20 минут: '||n||'.'||E'\n' else '' end
     ||case when silent then 'Скрипт отправки не выходил на связь больше 30 минут.'||E'\n' else '' end
     ||E'\nЧто сделать: открой script.google.com под этим ящиком, проект '||script||', запусти '||fn||'. '
     ||'Письма из очереди уйдут сами, ничего не потеряется.'||E'\n\nSUBNEX';
   insert into subnex_private.mail_alerts(via,about,to_email,subject,body_text,body_html)
   values(case s when 'ops' then 'collections' else 'ops' end,s,'info@subnex.co.uk',
    'SUBNEX: письма клиентам не уходят ('||box||')',t,
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
    ||replace(subnex_private.html_esc(t),E'\n','<br>')||'</div>');
  end if;
  res:=res||jsonb_build_object(s,jsonb_build_object('stuck',n,'silent',silent));
 end loop;
 return res;
end $$;
revoke all on function subnex_private.email_watchdog() from public;
select cron.schedule('subnex-email-watchdog','*/10 * * * *','select subnex_private.email_watchdog()');

-- Новая запись по ссылке из письма (anon): 'peek' — дни зоны, 'book' — записать на выбранный день.
create or replace function public.subnex_rebook(p_token text, p_action text default 'peek', p_day date default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare l subnex_private.rebook_links; a public.addresses; n public.addresses; days date[]; opts jsonb:='[]'; nid uuid; r jsonb;
 h subnex_private.dispatch_holds; e subnex_private.email_offers; g text; g2 text; info jsonb;
 today date:=(now() at time zone 'Europe/London')::date; mt text;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then perform pg_sleep(0.3); return '{"ok":false,"state":"invalid"}'; end if;
 if p_action='book' then select * into l from subnex_private.rebook_links where token=p_token for update;
 else select * into l from subnex_private.rebook_links where token=p_token; end if;
 if l.token is null then perform pg_sleep(0.3); return '{"ok":false,"state":"invalid"}'; end if;
 select * into a from public.addresses where id=l.address_id;
 info:=jsonb_build_object('address',a.text,'bags',a.bags_text,'site',true,'brand','SUBNEX');
 if l.used_at is not null then
  select * into n from public.addresses where id=l.new_address_id;
  select token into mt from subnex_private.email_offers where address_id=n.id order by created_at desc limit 1;
  return info||jsonb_build_object('ok',true,'state','rebooked','day',n.date,'day_text',to_char(n.date,'FMDay FMDD FMMonth'),'manage_token',mt);
 end if;
 if exists(select 1 from public.addresses x where x.kind='d2d' and x.status in ('new','planned')
    and subnex_private.planner_key(x.text)=subnex_private.planner_key(a.text)) then
  return info||'{"ok":false,"state":"active"}';
 end if;
 begin days:=subnex_private.auto_plan_days(a.id); exception when others then days:='{}'; end;
 select coalesce(jsonb_agg(jsonb_build_object('day',x,'day_text',to_char(x,'FMDay FMDD FMMonth')) order by x),'[]') into opts
   from (select distinct x from unnest(days) x where x>today order by x limit 8) s;
 if p_action<>'book' then
  return info||jsonb_build_object('ok',jsonb_array_length(opts)>0,'state','rebook','options',opts);
 end if;
 if p_day is null or p_day<=today or not (p_day=any(days)) then return info||'{"ok":false,"state":"day_taken"}'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text,73));
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text||':'||p_day::text,1));
 begin
  insert into public.addresses(text,phone,note,bags,bags_text,contact_name,contact_email,lat,lng,geocode_source,
   driver_id,status,kind,collection_source,intake_channel,intake_source,intake_ref,estimated_kg,service_minutes,arrival_mode)
  values(a.text,a.phone,coalesce(a.note,''),coalesce(a.bags,0),a.bags_text,a.contact_name,a.contact_email,a.lat,a.lng,a.geocode_source,
   a.driver_id,'new','d2d',a.collection_source,a.intake_channel,'rebook','rebook-'||left(a.id::text,8)||'-'||to_char(now(),'YYYYMMDDHH24MISS'),
   a.estimated_kg,a.service_minutes,'day')
  returning id into nid;
  r:=subnex_private.auto_hold(nid,p_day);
  if not coalesce((r->>'ok')::boolean,false) then raise exception 'HOLD'; end if;
  select * into h from subnex_private.dispatch_holds where address_id=nid and state='held' order by created_at desc limit 1;
  insert into subnex_private.email_offers(address_id,hold_id,driver_id,day,email,auto)
  values(nid,h.id,a.driver_id,p_day,lower(btrim(a.contact_email)),false) returning * into e;
  g:=current_setting('subnex.slot_change',true); g2:=current_setting('subnex.overbook',true);
  perform set_config('subnex.slot_change','allowed',true); perform set_config('subnex.overbook','allowed',true);
  update public.addresses set date=p_day,collection_start=h.starts_at,collection_end=h.ends_at,collection_confirmed_at=now(),
   arrival_mode='day',collection_version=collection_version+1,status='planned' where id=nid;
  perform set_config('subnex.slot_change',coalesce(g,''),true); perform set_config('subnex.overbook',coalesce(g2,''),true);
  update subnex_private.dispatch_holds set state='confirmed' where id=h.id;
  update subnex_private.email_offers set state='confirmed',confirmed_at=now() where id=e.id;
  update subnex_private.rebook_links set used_at=now(),new_address_id=nid where token=p_token;
 exception when others then
  return info||'{"ok":false,"state":"day_taken"}';
 end;
 perform subnex_private.email_enqueue(e.id,'confirmed','confirmed:'||e.id);
 return info||jsonb_build_object('ok',true,'state','confirmed','day',p_day,'day_text',to_char(p_day,'FMDay FMDD FMMonth'),'manage_token',e.token);
end $$;
revoke all on function public.subnex_rebook(text,text,date) from public;
grant execute on function public.subnex_rebook(text,text,date) to anon, authenticated;
