-- 67: письмо «заявка принята» в стиле сайта subnex.co.uk (тёмный фон, зелёный акцент, логотип).
-- Вёрстка таблицами с инлайн-стилями — так письмо одинаково выглядит в Gmail, Outlook и на телефоне.
create or replace function subnex_private.web_received_html(p_first text, p_addr text, p_bags text)
returns text language sql immutable set search_path to '' as $f$
select
'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
||'<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"></head>'
||'<body style="margin:0;padding:0;background:#0D0D1A">'
||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D0D1A" style="background:#0D0D1A"><tr><td align="center" style="padding:28px 12px">'
||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">'
-- logo
||'<tr><td style="padding:0 4px 20px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
||'<td style="padding-right:10px"><img src="https://subnex.co.uk/favicon.png" width="40" height="40" alt="SUBNEX" style="display:block;border:0;border-radius:50%"></td>'
||'<td style="font-family:Poppins,Arial,Helvetica,sans-serif;line-height:1.1"><div style="color:#FFFFFF;font-size:18px;font-weight:800;letter-spacing:-.2px">SUBNEX</div>'
||'<div style="color:#2ECC71;font-size:10px;font-weight:700;letter-spacing:3px">GROUP</div></td></tr></table></td></tr>'
-- card
||'<tr><td bgcolor="#1C1C30" style="background:#1C1C30;border:1px solid #2A2A44;border-radius:22px;padding:34px 30px">'
||'<div style="font-family:Poppins,Arial,Helvetica,sans-serif;color:#2ECC71;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px">&#8212;&nbsp; Request received &nbsp;&#8212;</div>'
||'<h1 style="margin:0 0 14px 0;font-family:Poppins,Arial,Helvetica,sans-serif;color:#FFFFFF;font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-.5px">Thank you, '||subnex_private.html_esc(p_first)||'!</h1>'
||'<p style="margin:0 0 24px 0;font-family:Arial,Helvetica,sans-serif;color:#B8B8D0;font-size:15px;line-height:1.6">We have received your request for a free clothing collection. Here is what you sent us:</p>'
-- details
||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#12121F" style="background:#12121F;border:1px solid #2A2A44;border-radius:14px">'
||'<tr><td style="padding:16px 18px;border-bottom:1px solid #2A2A44;font-family:Arial,Helvetica,sans-serif">'
||'<div style="color:#8888AA;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Collection address</div>'
||'<div style="color:#FFFFFF;font-size:15px;font-weight:bold;line-height:1.4">'||subnex_private.html_esc(p_addr)||'</div></td></tr>'
||'<tr><td style="padding:16px 18px;font-family:Arial,Helvetica,sans-serif">'
||'<div style="color:#8888AA;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Bags</div>'
||'<div style="color:#FFFFFF;font-size:15px;font-weight:bold">'||subnex_private.html_esc(p_bags)||'</div></td></tr></table>'
-- steps
||'<div style="font-family:Poppins,Arial,Helvetica,sans-serif;color:#FFFFFF;font-size:16px;font-weight:700;margin:28px 0 14px 0">What happens next</div>'
||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
||'<tr><td width="34" valign="top" style="padding:0 0 14px 0"><div style="width:26px;height:26px;border-radius:50%;background:#2ECC71;color:#0D0D1A;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:26px;text-align:center">&#10003;</div></td>'
||'<td valign="top" style="padding:3px 0 14px 0;font-family:Arial,Helvetica,sans-serif;color:#E8E8F0;font-size:14px;line-height:1.5"><b style="color:#FFFFFF">Request received</b> &#8212; that is this email.</td></tr>'
||'<tr><td width="34" valign="top" style="padding:0 0 14px 0"><div style="width:24px;height:24px;border-radius:50%;border:1px solid #2ECC71;color:#2ECC71;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:24px;text-align:center">2</div></td>'
||'<td valign="top" style="padding:3px 0 14px 0;font-family:Arial,Helvetica,sans-serif;color:#E8E8F0;font-size:14px;line-height:1.5"><b style="color:#FFFFFF">Collection date</b> &#8212; within one working day we will send you a date for your area by text message or email.</td></tr>'
||'<tr><td width="34" valign="top"><div style="width:24px;height:24px;border-radius:50%;border:1px solid #2ECC71;color:#2ECC71;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:24px;text-align:center">3</div></td>'
||'<td valign="top" style="padding:3px 0 0 0;font-family:Arial,Helvetica,sans-serif;color:#E8E8F0;font-size:14px;line-height:1.5"><b style="color:#FFFFFF">We collect</b> &#8212; leave your bags out on the day and we will do the rest.</td></tr></table>'
-- note
||'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px"><tr>'
||'<td style="background:#16301F;border-left:3px solid #2ECC71;border-radius:8px;padding:13px 16px;font-family:Arial,Helvetica,sans-serif;color:#CFEFDC;font-size:14px;line-height:1.5">'
||'Please keep your bags indoors until you hear from us. If anything changes, just reply to this email.</td></tr></table>'
||'</td></tr>'
-- footer
||'<tr><td align="center" style="padding:22px 10px 0 10px;font-family:Arial,Helvetica,sans-serif;color:#8888AA;font-size:12px;line-height:1.6">'
||'SUBNEX Group &middot; Free home clothing collection across South Wales<br>'
||'<a href="https://subnex.co.uk" style="color:#2ECC71;text-decoration:none;font-weight:bold">subnex.co.uk</a> &nbsp;&middot;&nbsp; '
||'<a href="mailto:collections@subnex.co.uk" style="color:#2ECC71;text-decoration:none">collections@subnex.co.uk</a></td></tr>'
||'</table></td></tr></table></body></html>'
$f$;
revoke all on function subnex_private.web_received_html(text,text,text) from public;

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
 v_subj text; v_t text; v_h text;
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
  insert into public.addresses(text,phone,note,bags,bags_text,contact_name,contact_email,
   driver_id,status,kind,collection_source,intake_channel,intake_source,intake_ref,estimated_kg,service_minutes,arrival_mode)
  values(v_text,v_phone,v_note,0,v_bags_text,v_name,v_email,
   v_driver,'new','d2d','subnex','subnex_website','website','web-'||to_char(now(),'YYYYMMDDHH24MISS')||'-'||left(md5(v_email||v_phone_raw),6),
   10,coalesce((select c.service_minutes from subnex_private.auto_plan_config c where c.singleton),1),'window')
  returning id into v_id;
  insert into subnex_private.web_bookings(email,phone,postcode,address_id,outcome) values(v_email,v_phone_raw,v_pc,v_id,'created');
 else
  v_id:=v_existing;
  insert into subnex_private.web_bookings(email,phone,postcode,address_id,outcome) values(v_email,v_phone_raw,v_pc,v_id,'duplicate');
 end if;

 -- Письмо «заявка принята».
 v_first:=coalesce(nullif(split_part(v_name,' ',1),''),'there');
 v_subj:='We have received your collection request';
 v_t:='Hi '||v_first||E',\n\n'
  ||'Thank you for booking a free clothing collection with SUBNEX. We have received your request for '||v_text||E'.\n\n'
  ||E'Within one working day we will send you a collection date for your area by text message or email. Please keep your bags indoors until you hear from us.\n\n'
  ||E'If anything changes, just reply to this email.\n\nThank you,\nSUBNEX';
 v_h:=subnex_private.web_received_html(v_first,v_text,v_bags_text);
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(null,v_id,'received','received:'||left(md5(v_email),12),v_email,'SUBNEX','collections@subnex.co.uk',v_subj,v_t,v_h)
 on conflict(address_id,event_key) do nothing;

 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.subnex_web_booking(jsonb) from public;
grant execute on function public.subnex_web_booking(jsonb) to anon, authenticated;
