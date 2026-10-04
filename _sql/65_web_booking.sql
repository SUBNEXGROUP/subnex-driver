-- 65: заявки с сайта subnex.co.uk сразу в приложение + письмо «заявка принята» (04.10.2026).
-- Сайт, кроме Web3Forms (копия на info@), шлёт заявку в public.subnex_web_booking (anon).
-- Функция проверяет поля, ловит ботов (скрытое поле, слишком быстрая отправка, лимиты),
-- создаёт заявку как intake_channel='subnex_website' / collection_source='subnex' и кладёт
-- письмо 'received' в email_outbox. Письмо уходит обычным отправщиком писем (Письма.gs)
-- с адреса collections@subnex.co.uk (from_email), если этот адрес подключён к ящику отправщика.
-- Повторный запуск безопасен.

alter table subnex_private.email_outbox add column if not exists from_email text;
alter table subnex_private.email_outbox drop constraint if exists email_outbox_kind_check;
alter table subnex_private.email_outbox add constraint email_outbox_kind_check
 check (kind in ('day_offer','reminder','confirmed','collected','closed','day_before','received'));

create table if not exists subnex_private.web_bookings (
 id uuid primary key default gen_random_uuid(),
 created_at timestamptz not null default now(),
 email text, phone text, postcode text,
 address_id uuid,
 outcome text not null,
 detail text
);
revoke all on subnex_private.web_bookings from public, anon, authenticated;

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
  ||E'Before you hand over your donation, please check all pockets and bags for valuables or anything you want to keep.\n\n'
  ||E'If anything changes, just reply to this email.\n\nThank you,\nSUBNEX';
 v_h:='<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
  ||'<p>Hi '||subnex_private.html_esc(v_first)||',</p>'
  ||'<p>Thank you for booking a free clothing collection with SUBNEX. We have received your request for <b>'||subnex_private.html_esc(v_text)||'</b>.</p>'
  ||'<p>Within one working day we will send you a collection date for your area by text message or email. Please keep your bags indoors until you hear from us.</p>'
  ||'<p>Before you hand over your donation, please check all pockets and bags for valuables or anything you want to keep.</p>'
  ||'<p>If anything changes, just reply to this email.</p><p>Thank you,<br>SUBNEX</p></div>';
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(null,v_id,'received','received:'||left(md5(v_email),12),v_email,'SUBNEX','collections@subnex.co.uk',v_subj,v_t,v_h)
 on conflict(address_id,event_key) do nothing;

 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.subnex_web_booking(jsonb) from public;
grant execute on function public.subnex_web_booking(jsonb) to anon, authenticated;

-- Отправщик отдаёт адрес отправителя.
do $patch$
declare def text; f text:='public.subnex_email_worker(text,text,jsonb)';
 a text:=$q$'from_name',q.from_name,$q$; b text:=$q$'from_name',q.from_name,'from_email',q.from_email,$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('from_email' in def)>0 then return; end if;
 if (length(def)-length(replace(def,a,'')))/length(a)<>1 then raise exception 'PATCH_FRAGMENT %',f; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='65:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('65:'||f,def);
 end if;
 execute replace(def,a,b);
end $patch$;
