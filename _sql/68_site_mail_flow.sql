-- 68: клиенты с сайта (subnex_website) — все сообщения письмами в стиле сайта, с collections@subnex.co.uk.
-- (04.10.2026)
-- • Заявка с сайта сразу получает дату: если сайт прислал координаты (postcodes.io в браузере),
--   subnex_web_booking тут же предлагает ближайший подходящий день письмом с кнопкой; иначе — обычное
--   письмо «заявка принята», а дата придёт с ближайшим автоподбором.
-- • Клиенту с сайта SMS не уходят вообще: предложение даты, подтверждение, напоминание накануне,
--   утреннее окно прибытия, «забрали», «не смогли забрать» (с комментарием водителя), отмена — письмами.
-- • Страница подтверждения отдаёт другие возможные дни по зоне (auto_plan_days) и подтверждает выбранный.
-- Партнёрские заявки не меняются. Повторный запуск безопасен; прежние версии — в dispatch_backups '68:…'.

alter table subnex_private.email_outbox drop constraint if exists email_outbox_kind_check;
alter table subnex_private.email_outbox add constraint email_outbox_kind_check
 check (kind in ('day_offer','reminder','confirmed','collected','closed','day_before','received','eta','not_collected','cancelled'));

-- Адрес письма клиента с сайта (или null — не клиент с сайта / нет нормального email / письма выключены).
create or replace function subnex_private.site_email(p_address uuid) returns text
language sql stable security definer set search_path to '' as $$
 select lower(btrim(a.contact_email))
   from public.addresses a, subnex_private.auto_plan_config c
  where a.id=p_address and c.singleton and c.email_enabled
    and a.kind='d2d' and a.intake_channel='subnex_website'
    and btrim(coalesce(a.contact_email,'')) ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
$$;

-- Кому предлагать дату письмом: клиенты с сайта — всегда; партнёрские — если нет британского мобильного.
create or replace function subnex_private.email_route(p_address uuid) returns text
language sql stable security definer set search_path to '' as $$
 select lower(btrim(a.contact_email))
   from public.addresses a, subnex_private.auto_plan_config c
  where a.id=p_address and c.singleton and c.email_enabled
    and a.kind='d2d' and a.intake_channel in ('subnex_website','partner_email')
    and (a.intake_channel='subnex_website' or coalesce(subnex_private.phone(a.phone),'') !~ '^\+447[0-9]{9}$')
    and btrim(coalesce(a.contact_email,'')) ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
$$;

-- Письмо в стиле сайта. p_extra: day, link, eta_from/eta_to (минуты), reason, note.
create or replace function subnex_private.site_mail(p_kind text, p_address uuid, p_extra jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare a public.addresses; first text; d date; day_txt text; win text; link text; note text; reason text;
 subj text; eyebrow text; h1 text; intro text; rows jsonb:='[]'; tip text; btn text; btn_url text; step int; tail text;
 t text; h text; r jsonb; i int; labels text[]:=array['Request received','Date confirmed','Collection day'];
 esc_first text;
begin
 select * into a from public.addresses where id=p_address;
 first:=coalesce(nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),''),'there');
 d:=coalesce(nullif(p_extra->>'day','')::date,a.date,a.cancelled_date);
 day_txt:=case when d is null then null else to_char(d,'FMDay FMDD FMMonth') end;
 if p_extra ? 'eta_from' then
  win:=subnex_private.sms_clock((p_extra->>'eta_from')::int)||' – '||subnex_private.sms_clock((p_extra->>'eta_to')::int);
 end if;
 link:=nullif(p_extra->>'link','');
 note:=nullif(btrim(coalesce(p_extra->>'note','')),'');
 reason:=coalesce(p_extra->>'reason','');

 if p_kind='received' then
  subj:='We have received your collection request'; eyebrow:='Request received'; h1:='Thank you, '||first||'!';
  intro:='We have received your request for a free clothing collection. Here is what you sent us:';
  rows:=jsonb_build_array(jsonb_build_array('Collection address',a.text),jsonb_build_array('Bags',coalesce(a.bags_text,'—')));
  tip:='We will email you a collection date for your area shortly. Please keep your bags indoors until your date is confirmed.'; step:=1;
 elsif p_kind in ('day_offer','reminder') then
  subj:=case when p_kind='day_offer' then 'Your collection date: '||day_txt else 'Reminder: please confirm your collection on '||day_txt end;
  eyebrow:=case when p_kind='day_offer' then 'Your collection date' else 'Please confirm' end;
  h1:='We can collect on '||day_txt;
  intro:=case when p_kind='day_offer' then 'Thank you for your request, '||first||'. We collect in your area on the date below. Please confirm it, or choose another day that suits you better.'
         else 'We have not heard back from you yet, '||first||'. Please confirm the date below, or choose another day that suits you better.' end;
  rows:=jsonb_build_array(jsonb_build_array('Collection date',day_txt),jsonb_build_array('Collection address',a.text),jsonb_build_array('Bags',coalesce(a.bags_text,'—')));
  btn:='Confirm or choose a date'; btn_url:=link;
  tip:='Please keep your bags indoors until your date is confirmed.'; step:=2;
 elsif p_kind='confirmed' then
  subj:='Collection confirmed: '||day_txt; eyebrow:='Booking confirmed'; h1:='You are booked in, '||first||'!';
  intro:='Your free clothing collection is confirmed for the date below.';
  rows:=jsonb_build_array(jsonb_build_array('Collection date',day_txt),jsonb_build_array('Collection address',a.text),jsonb_build_array('Bags',coalesce(a.bags_text,'—')));
  tip:='On the morning of your collection we will email you a time window. Please leave your bags out that morning where we can see them from the street.'; step:=3;
 elsif p_kind='day_before' then
  subj:='See you tomorrow: your collection is on '||day_txt; eyebrow:='Collection tomorrow'; h1:='See you tomorrow, '||first||'!';
  intro:='Just a friendly reminder that we are collecting your clothing donation tomorrow.';
  rows:=jsonb_build_array(jsonb_build_array('Collection date',day_txt),jsonb_build_array('Collection address',a.text));
  tip:='Please leave your bags out in the morning where we can see them from the street. Tomorrow morning we will email you a time window. If your plans have changed, just reply to this email.'; step:=3;
 elsif p_kind='eta' then
  subj:='We are collecting today between '||coalesce(replace(win,' – ',' and '),'—'); eyebrow:='Collection today'; h1:='We will be with you between '||coalesce(replace(win,' – ',' and '),'—');
  intro:='Good morning, '||first||'. Your collection is today and our driver is on the way.';
  rows:=jsonb_build_array(jsonb_build_array('Arrival window',coalesce(win,'—')),jsonb_build_array('Collection address',a.text));
  tip:='Please make sure your bags are outside and easy to see from the street. If anything has changed, just reply to this email.'; step:=3;
 elsif p_kind='collected' then
  subj:='Thank you, your donation has been collected'; eyebrow:='Collected'; h1:='Thank you, '||first||'!';
  intro:='Your clothing donation has been collected today. Thank you for supporting us, we really appreciate it.';
  rows:=jsonb_build_array(jsonb_build_array('Collection address',a.text));
  tip:='If you have more to donate in the future, just book again on our website or reply to this email.';
  btn:='Book another collection'; btn_url:='https://subnex.co.uk/#book'; step:=4;
 elsif p_kind='not_collected' then
  subj:='We could not collect your donation today'; eyebrow:='Collection update';
  h1:=case when reason='noanswer' then 'Sorry we missed you, '||first else 'We could not complete your collection' end;
  intro:=case when reason='noanswer' then 'Our driver visited today but could not find any bags to collect.'
         else 'Our driver visited today but was unable to complete the collection.' end;
  rows:=jsonb_build_array(jsonb_build_array('Collection address',a.text));
  if note is not null then rows:=rows||jsonb_build_array(jsonb_build_array('Driver''s note',note)); end if;
  tip:='Just reply to this email and we will arrange a new date for you.'; step:=0;
 elsif p_kind='cancelled' then
  subj:='Your collection booking has been cancelled'; eyebrow:='Booking cancelled'; h1:='Your booking has been cancelled';
  intro:=case when reason='area_not_served' then 'We are sorry, '||first||', but we are no longer able to collect in your area, so we have had to cancel your collection.'
         else 'Your collection booking has been cancelled.' end;
  rows:=jsonb_build_array(jsonb_build_array('Collection address',a.text));
  tip:=case when reason='area_not_served' then 'Thank you for thinking of us, and apologies for any inconvenience.'
       else 'If you would still like us to collect, just reply to this email or book again on our website.' end; step:=0;
 else -- closed (no reply)
  subj:='Your collection request has been closed'; eyebrow:='Request closed'; h1:='Your request has been closed';
  intro:='We did not hear back from you about your collection, so we have closed this request.';
  rows:=jsonb_build_array(jsonb_build_array('Collection address',a.text));
  tip:='If you would still like a collection, just reply to this email or book again on our website.';
  btn:='Book a collection'; btn_url:='https://subnex.co.uk/#book'; step:=0;
 end if;

 -- Текстовая версия.
 t:=h1||E'\n\n'||intro||E'\n\n';
 for r in select x from jsonb_array_elements(rows) x loop t:=t||(r->>0)||': '||(r->>1)||E'\n'; end loop;
 if btn_url is not null then t:=t||E'\n'||btn||': '||btn_url||E'\n'; end if;
 t:=t||E'\n'||tip||E'\n\nThank you,\nSUBNEX\nsubnex.co.uk';

 -- HTML.
 h:='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  ||'<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"></head>'
  ||'<body style="margin:0;padding:0;background:#0D0D1A">'
  ||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D0D1A" style="background:#0D0D1A"><tr><td align="center" style="padding:24px 10px">'
  ||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">'
  ||'<tr><td style="padding:0 4px 20px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
  ||'<td style="padding-right:10px"><img src="https://subnex.co.uk/favicon.png" width="40" height="40" alt="SUBNEX" style="display:block;border:0;border-radius:50%"></td>'
  ||'<td style="font-family:Poppins,Arial,Helvetica,sans-serif;line-height:1.1"><div style="color:#FFFFFF;font-size:18px;font-weight:800;letter-spacing:-.2px">SUBNEX</div>'
  ||'<div style="color:#2ECC71;font-size:10px;font-weight:700;letter-spacing:3px">GROUP</div></td></tr></table></td></tr>'
  ||'<tr><td bgcolor="#1C1C30" style="background:#1C1C30;border:1px solid #2A2A44;border-radius:22px;padding:28px 22px">'
  ||'<div style="font-family:Poppins,Arial,Helvetica,sans-serif;color:#2ECC71;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px">&#8212;&nbsp; '||subnex_private.html_esc(eyebrow)||' &nbsp;&#8212;</div>'
  ||'<h1 style="margin:0 0 14px 0;font-family:Poppins,Arial,Helvetica,sans-serif;color:#FFFFFF;font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.4px">'||subnex_private.html_esc(h1)||'</h1>'
  ||'<p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;color:#B8B8D0;font-size:15px;line-height:1.6">'||subnex_private.html_esc(intro)||'</p>'
  ||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#12121F" style="background:#12121F;border:1px solid #2A2A44;border-radius:14px">';
 i:=0;
 for r in select x from jsonb_array_elements(rows) x loop
  i:=i+1;
  h:=h||'<tr><td style="padding:15px 18px;'||case when i<jsonb_array_length(rows) then 'border-bottom:1px solid #2A2A44;' else '' end||'font-family:Arial,Helvetica,sans-serif">'
   ||'<div style="color:#8888AA;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">'||subnex_private.html_esc(r->>0)||'</div>'
   ||'<div style="color:#FFFFFF;font-size:15px;font-weight:bold;line-height:1.4">'||subnex_private.html_esc(r->>1)||'</div></td></tr>';
 end loop;
 h:=h||'</table>';
 if btn_url is not null then
  h:=h||'<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 4px 0"><tr><td bgcolor="#2ECC71" style="background:#2ECC71;border-radius:100px">'
   ||'<a href="'||subnex_private.html_esc(btn_url)||'" style="display:inline-block;padding:14px 30px;font-family:Poppins,Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#0A1A0D;text-decoration:none;border-radius:100px">'
   ||subnex_private.html_esc(btn)||' &rarr;</a></td></tr></table>';
 end if;
 if step>0 then
  h:=h||'<div style="font-family:Poppins,Arial,Helvetica,sans-serif;color:#FFFFFF;font-size:15px;font-weight:700;margin:28px 0 12px 0">Your collection</div>'
   ||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';
  for i in 1..3 loop
   h:=h||'<tr><td width="34" valign="top" style="padding:0 0 12px 0">'
    ||case when i<step then '<div style="width:26px;height:26px;border-radius:50%;background:#2ECC71;color:#0D0D1A;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:26px;text-align:center">&#10003;</div>'
           when i=step then '<div style="width:24px;height:24px;border-radius:50%;border:1px solid #2ECC71;background:#16301F;color:#2ECC71;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:24px;text-align:center">'||i||'</div>'
           else '<div style="width:24px;height:24px;border-radius:50%;border:1px solid #444460;color:#8888AA;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:24px;text-align:center">'||i||'</div>' end
    ||'</td><td valign="top" style="padding:4px 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:'
    ||case when i<=step then '#FFFFFF;font-weight:bold' else '#8888AA' end||'">'||labels[i]
    ||case when i=2 and d is not null and step>=3 then ' &#8212; '||subnex_private.html_esc(day_txt) else '' end||'</td></tr>';
  end loop;
  h:=h||'</table>';
 end if;
 h:=h||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px"><tr>'
  ||'<td style="background:#16301F;border-left:3px solid #2ECC71;border-radius:8px;padding:13px 16px;font-family:Arial,Helvetica,sans-serif;color:#CFEFDC;font-size:14px;line-height:1.5">'
  ||subnex_private.html_esc(tip)||'</td></tr></table>'
  ||'</td></tr>'
  ||'<tr><td align="center" style="padding:22px 10px 0 10px;font-family:Arial,Helvetica,sans-serif;color:#8888AA;font-size:12px;line-height:1.6">'
  ||'SUBNEX Group &middot; Free home clothing collection across South Wales<br>'
  ||'<a href="https://subnex.co.uk" style="color:#2ECC71;text-decoration:none;font-weight:bold">subnex.co.uk</a> &nbsp;&middot;&nbsp; '
  ||'<a href="mailto:collections@subnex.co.uk" style="color:#2ECC71;text-decoration:none">collections@subnex.co.uk</a></td></tr>'
  ||'</table></td></tr></table></body></html>';
 return jsonb_build_object('subject',subj,'text',t,'html',h,'from_name','SUBNEX');
end $$;

-- Положить письмо клиенту с сайта в очередь (от collections@).
create or replace function subnex_private.site_email_enqueue(p_address uuid, p_kind text, p_key text, p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare em text; m jsonb; qid uuid; oid uuid;
begin
 em:=subnex_private.site_email(p_address);
 if em is null then return null; end if;
 m:=subnex_private.site_mail(p_kind,p_address,p_extra);
 select id into oid from subnex_private.email_offers where address_id=p_address order by created_at desc limit 1;
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(oid,p_address,p_kind,p_key,em,m->>'from_name','collections@subnex.co.uk',m->>'subject',m->>'text',m->>'html')
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;

-- Письма по предложениям: для клиентов с сайта — оформление сайта и отправка с collections@.
create or replace function subnex_private.email_enqueue(p_offer uuid, p_kind text, p_key text) returns uuid
language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; m jsonb; qid uuid; site boolean;
begin
 select * into e from subnex_private.email_offers where id=p_offer;
 if e.id is null then return null; end if;
 site:=exists(select 1 from public.addresses a where a.id=e.address_id and a.intake_channel='subnex_website');
 m:=subnex_private.email_content(p_kind,e.id);
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(e.id,e.address_id,p_kind,p_key,e.email,m->>'from_name',case when site then 'collections@subnex.co.uk' end,m->>'subject',m->>'text',m->>'html')
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;

do $patch$
declare def text; f text; pairs text[]; i int;
begin
 foreach f in array array['subnex_private.email_content(text,uuid)','subnex_private.enqueue_auto_sms(uuid,text,text,uuid,uuid,jsonb)',
   'subnex_private.email_day_before(uuid,date)','public.subnex_email_worker(text,text,jsonb)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  if position('site_' in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='68:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('68:'||f,def);
  end if;
  pairs:=case f
   when 'subnex_private.email_content(text,uuid)' then array[
    $q$ link:=c.email_confirm_url||'?t='||e.token;$q$,
    $q$ link:=c.email_confirm_url||'?t='||e.token;
 if a.intake_channel='subnex_website' then return subnex_private.site_mail(p_kind,a.id,jsonb_build_object('day',e.day,'link',link)); end if;$q$]
   when 'subnex_private.enqueue_auto_sms(uuid,text,text,uuid,uuid,jsonb)' then array[
    $q$ if not c.enabled then return '{"state":"disabled"}'; end if;$q$,
    $q$ -- Клиенты с сайта: вместо SMS — письмо в стиле сайта.
 if p_event in ('confirmed','day_before','eta','collected','cancelled') and subnex_private.site_email(p_address) is not null then
  return jsonb_build_object('state','email','id',subnex_private.site_email_enqueue(p_address,p_event,p_key,coalesce(p_extra,'{}'::jsonb)));
 end if;
 if not c.enabled then return '{"state":"disabled"}'; end if;$q$]
   when 'subnex_private.email_day_before(uuid,date)' then array[
    $q$ if a.id is null then return null; end if;$q$,
    $q$ if a.id is null then return null; end if;
 if subnex_private.site_email(a.id) is not null then
  return subnex_private.site_email_enqueue(a.id,'day_before','day_before:'||p_day,jsonb_build_object('day',p_day));
 end if;$q$]
   else array[
    $q$   if q.kind in ('day_offer','reminder') and$q$,
    $q$   if q.kind='eta' and now()>((nullif(split_part(q.event_key,':',2),'')::date+time '20:00') at time zone 'Europe/London') then
    update subnex_private.email_outbox set state='skipped',error='TOO_LATE' where id=q.id; continue;
   end if;
   if q.kind in ('day_offer','reminder') and$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;

-- Водитель отметил «нет дома»/«проблема», или заявку отменили — письмо клиенту с сайта.
create or replace function subnex_private.site_status_mail() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
 if new.intake_channel is distinct from 'subnex_website' or new.kind is distinct from 'd2d' then return new; end if;
 if new.status in ('noanswer','problem') and old.status is distinct from new.status then
  perform subnex_private.site_email_enqueue(new.id,'not_collected','not_collected:'||coalesce(new.date,current_date),
   jsonb_build_object('reason',new.status,'note',new.result_note,'day',new.date));
 elsif new.status='cancelled' and old.status is distinct from 'cancelled' and coalesce(new.cancellation_reason,'')<>'no_reply' then
  perform subnex_private.site_email_enqueue(new.id,'cancelled','cancelled',
   jsonb_build_object('reason',new.cancellation_reason,'day',new.cancelled_date));
 end if;
 return new;
end $$;
create or replace trigger subnex_site_status_mail after update of status on public.addresses
 for each row execute function subnex_private.site_status_mail();

-- Страница подтверждения: другие возможные дни по зоне и подтверждение выбранного дня.
-- Новая функция с выбором дня; страница confirm.html вызывает её.
create or replace function public.subnex_email_choose(p_token text, p_action text default 'peek', p_day date default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; a public.addresses; h subnex_private.dispatch_holds; w jsonb; info jsonb; live boolean; g text; g2 text;
 opts jsonb:='[]'; days date[]; r jsonb;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then perform pg_sleep(0.3); return '{"ok":false,"state":"invalid"}'; end if;
 if p_action='confirm' then
  select * into e from subnex_private.email_offers where token=p_token for update;
 else
  select * into e from subnex_private.email_offers where token=p_token;
 end if;
 if e.id is null then perform pg_sleep(0.3); return '{"ok":false,"state":"invalid"}'; end if;
 select * into a from public.addresses where id=e.address_id;
 w:=subnex_private.day_window(e.day);
 info:=jsonb_build_object('day',e.day,'day_text',to_char(e.day,'FMDay FMDD FMMonth'),
  'window',case when w is null then null else subnex_private.sms_clock(subnex_private.dispatch_clock(w->>'opens'))||' – '||subnex_private.sms_clock(subnex_private.dispatch_clock(w->>'closes')) end,
  'address',a.text,'bags',a.bags_text,'site',a.intake_channel='subnex_website',
  'brand',case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end);
 if e.state='confirmed' then return info||'{"ok":true,"state":"confirmed","already":true}'; end if;
 if e.state<>'sent' then return info||jsonb_build_object('ok',false,'state',e.state); end if;
 select * into h from subnex_private.dispatch_holds where id=e.hold_id;
 live:=h.id is not null and h.state='held' and h.starts_at>now() and a.status='new' and a.collection_start is null and a.date is null
   and not exists(select 1 from subnex_private.dispatch_days dd where dd.driver_id=a.driver_id and dd.day=e.day and dd.started_at is not null);
 if p_action<>'confirm' then
  if live and a.intake_channel='subnex_website' then
   begin days:=subnex_private.auto_plan_days(a.id); exception when others then days:='{}'; end;
   select coalesce(jsonb_agg(jsonb_build_object('day',x,'day_text',to_char(x,'FMDay FMDD FMMonth')) order by x),'[]') into opts
     from (select distinct x from unnest(days) x where x<>e.day and x>(now() at time zone 'Europe/London')::date order by x limit 8) s;
  end if;
  return info||jsonb_build_object('ok',live,'state',case when live then 'sent' else 'expired' end,'options',opts);
 end if;
 if not live then return info||'{"ok":false,"state":"expired"}'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text,73));
 -- Клиент выбрал другой день: проверяем, что он из допустимых, и переносим удержание.
 if p_day is not null and p_day<>e.day then
  if a.intake_channel is distinct from 'subnex_website' then return info||'{"ok":false,"state":"error"}'; end if;
  begin days:=subnex_private.auto_plan_days(a.id); exception when others then days:='{}'; end;
  if not (p_day=any(days)) then return info||'{"ok":false,"state":"day_taken"}'; end if;
  begin
   update subnex_private.dispatch_holds set state='released' where id=h.id;
   r:=subnex_private.auto_hold(a.id,p_day);
   if not coalesce((r->>'ok')::boolean,false) then raise exception 'HOLD'; end if;
   select * into h from subnex_private.dispatch_holds where address_id=a.id and state='held' order by created_at desc limit 1;
   update subnex_private.email_offers set day=p_day,hold_id=h.id where id=e.id returning * into e;
  exception when others then
   return info||'{"ok":false,"state":"day_taken"}';
  end;
  w:=subnex_private.day_window(e.day);
  info:=info||jsonb_build_object('day',e.day,'day_text',to_char(e.day,'FMDay FMDD FMMonth'));
 end if;
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text||':'||e.day::text,1));
 select * into a from public.addresses where id=e.address_id for update;
 select * into h from subnex_private.dispatch_holds where id=e.hold_id for update;
 if h.state<>'held' or a.status<>'new' or a.collection_start is not null then return info||'{"ok":false,"state":"expired"}'; end if;
 begin
  g:=current_setting('subnex.slot_change',true); g2:=current_setting('subnex.overbook',true);
  perform set_config('subnex.slot_change','allowed',true); perform set_config('subnex.overbook','allowed',true);
  update public.addresses set date=e.day,collection_start=h.starts_at,collection_end=h.ends_at,collection_confirmed_at=now(),
   arrival_mode='day',collection_version=collection_version+1,status='planned' where id=a.id;
  perform set_config('subnex.slot_change',coalesce(g,''),true); perform set_config('subnex.overbook',coalesce(g2,''),true);
  update subnex_private.dispatch_holds set state='confirmed' where id=h.id;
  update subnex_private.email_offers set state='confirmed',confirmed_at=now() where id=e.id;
 exception when others then
  return info||jsonb_build_object('ok',false,'state','error');
 end;
 perform subnex_private.email_enqueue(e.id,'confirmed','confirmed:'||e.id);
 return info||'{"ok":true,"state":"confirmed"}';
end $$;
revoke all on function public.subnex_email_choose(text,text,date) from public;
grant execute on function public.subnex_email_choose(text,text,date) to anon, authenticated;
-- Старая public.subnex_email_confirm(text,text) не меняется: старые ссылки работают как раньше.

revoke all on function subnex_private.site_email(uuid) from public;
revoke all on function subnex_private.site_mail(text,uuid,jsonb) from public;
revoke all on function subnex_private.site_email_enqueue(uuid,text,text,jsonb) from public;
revoke all on function subnex_private.site_status_mail() from public;

-- Заявка с сайта: координаты из браузера и сразу предложение даты.
create or replace function public.subnex_web_booking(p_data jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
 v_name text:=left(btrim(coalesce(p_data->>'name','')),100);
 v_email text:=lower(left(btrim(coalesce(p_data->>'email','')),200));
 v_phone_raw text:=left(btrim(coalesce(p_data->>'phone','')),40);
 v_phone text;
 v_pc text:=upper(regexp_replace(left(btrim(coalesce(p_data->>'postcode','')),12),'\s+',' ','g'));
 v_addr text:=left(btrim(regexp_replace(coalesce(p_data->>'address',''),'\s+',' ','g')),300);
 v_bags text:=coalesce(p_data->>'bags','');
 v_note text:=left(btrim(coalesce(p_data->>'notes','')),1000);
 v_text text; v_driver uuid; v_id uuid; v_existing uuid; v_bags_text text; v_first text;
 v_lat float8; v_lng float8; v_days date[]; v_res jsonb; v_offered boolean:=false;
begin
 -- Боты: заполненное скрытое поле или отправка быстрее 3 секунд после открытия формы.
 if coalesce(p_data->>'website','')<>'' or coalesce((p_data->>'elapsed_ms')::numeric,99999)<3000 then
  insert into subnex_private.web_bookings(email,phone,postcode,outcome,detail) values(v_email,v_phone_raw,v_pc,'bot',null);
  return jsonb_build_object('ok',true);
 end if;
 if length(v_name)<2 then raise exception 'NAME_REQUIRED'; end if;
 if v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then raise exception 'EMAIL_INVALID'; end if;
 if length(regexp_replace(v_phone_raw,'\D','','g'))<10 then raise exception 'PHONE_INVALID'; end if;
 if v_pc !~ '^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$' then raise exception 'POSTCODE_INVALID'; end if;
 if length(v_addr)<5 then raise exception 'ADDRESS_REQUIRED'; end if;
 v_bags_text:=case v_bags when '1-5' then '1 to 5 bags' when '5-10' then '5 to 10 bags' when '10+' then '10+ bags' else null end;
 if v_bags_text is null then raise exception 'BAGS_REQUIRED'; end if;
 if v_pc !~ ' ' then v_pc:=left(v_pc,length(v_pc)-3)||' '||right(v_pc,3); end if;

 -- Лимиты: не больше 3 заявок с одного email/телефона в сутки, не больше 300 заявок с сайта в сутки.
 if (select count(*) from subnex_private.web_bookings w where w.created_at>now()-interval '1 day'
      and (w.email=v_email or w.phone=v_phone_raw) and w.outcome in ('created','duplicate'))>=3
   or (select count(*) from subnex_private.web_bookings w where w.created_at>now()-interval '1 day')>=300 then
  insert into subnex_private.web_bookings(email,phone,postcode,outcome,detail) values(v_email,v_phone_raw,v_pc,'limited',null);
  raise exception 'TOO_MANY_REQUESTS';
 end if;

 v_phone:=subnex_private.phone(v_phone_raw);
 -- Координаты из браузера (postcodes.io) — только если похожи на Британию; иначе геокодер сделает сам.
 begin
  v_lat:=nullif(p_data->>'lat','')::float8; v_lng:=nullif(p_data->>'lng','')::float8;
  if not (v_lat between 49.8 and 60.9 and v_lng between -8.7 and 1.8) then v_lat:=null; v_lng:=null; end if;
 exception when others then v_lat:=null; v_lng:=null; end;
 v_text:=case when upper(replace(v_addr,' ','')) like '%'||replace(v_pc,' ','')||'%' then v_addr else v_addr||', '||v_pc end;

 select t.driver_id into v_driver from subnex_private.intake_tokens t
  join public.drivers d on d.id=t.driver_id and d.active
  where t.active and t.channel='subnex_website' order by t.id limit 1;
 if v_driver is null and (select count(*) from public.drivers where active)=1 then
  select id into v_driver from public.drivers where active;
 end if;

 -- Тот же адрес уже в работе — вторую заявку не создаём, но клиенту всё равно подтверждаем.
 select a.id into v_existing from public.addresses a
  where a.status in ('new','planned') and subnex_private.planner_key(a.text)=subnex_private.planner_key(v_text) limit 1;

 if v_existing is null then
  insert into public.addresses(text,phone,note,bags,bags_text,contact_name,contact_email,lat,lng,geocode_source,
   driver_id,status,kind,collection_source,intake_channel,intake_source,intake_ref,estimated_kg,service_minutes,arrival_mode)
  values(v_text,v_phone,v_note,0,v_bags_text,v_name,v_email,v_lat,v_lng,case when v_lat is not null then 'postcode' end,
   v_driver,'new','d2d','subnex','subnex_website','website','web-'||to_char(now(),'YYYYMMDDHH24MISS')||'-'||left(md5(v_email||v_phone_raw),6),
   10,coalesce((select c.service_minutes from subnex_private.auto_plan_config c where c.singleton),1),'window')
  returning id into v_id;
  insert into subnex_private.web_bookings(email,phone,postcode,address_id,outcome) values(v_email,v_phone_raw,v_pc,v_id,'created');
 else
  v_id:=v_existing;
  insert into subnex_private.web_bookings(email,phone,postcode,address_id,outcome) values(v_email,v_phone_raw,v_pc,v_id,'duplicate');
 end if;

 -- Письмо «заявка принята».
 -- Сразу предлагаем дату письмом (кнопка «подтвердить или выбрать другой день»).
 if v_existing is null and v_lat is not null then
  begin
   if subnex_private.auto_plan_skip(v_id) is null then
    v_days:=subnex_private.auto_plan_days(v_id);
    if coalesce(array_length(v_days,1),0)>0 then
     perform pg_advisory_xact_lock(hashtextextended(v_driver::text,73));
     v_res:=subnex_private.email_offer(v_id,v_days[1],true);
     v_offered:=coalesce((v_res->>'ok')::boolean,false);
    end if;
   end if;
  exception when others then v_offered:=false;
  end;
 end if;
 -- Даты пока нет (нет координат, нет свободного дня или адрес уже в работе) — письмо «заявка принята».
 if not v_offered then
  perform subnex_private.site_email_enqueue(v_id,'received','received:'||left(md5(v_email),12),'{}'::jsonb);
 end if;

 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.subnex_web_booking(jsonb) from public;
grant execute on function public.subnex_web_booking(jsonb) to anon, authenticated;
