-- 83: подтверждение отмены письмом, если клиент отключил SMS (11.10.2026). Костя: клиент ответил одним
--   словом «Cancel» — Twilio считает это отпиской (как STOP), и SMS об отмене уже не уходит.
--   «Давай будем отправлять email в таких случаях».
-- • subnex_private.cancel_email_enqueue(address, key, extra) — письмо «ваш сбор отменён» на contact_email
--   адреса (если он нормальный и письма включены). Клиентам с сайта — письмо в стиле сайта (site_mail),
--   партнёрским — простое письмо от имени бренда (We Recycle Clothes), как остальные партнёрские письма.
-- • enqueue_auto_sms: событие 'cancelled' + номер отписан → вместо пропуска кладёт письмо и возвращает
--   {"state":"email","reason":"OPTED_OUT"}. Остальные события для отписанных номеров не меняются.
-- Без удаляющих команд. Повторный запуск безопасен; прежняя версия — dispatch_backups '83:…'.

create or replace function subnex_private.cancel_email_enqueue(p_address uuid, p_key text, p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path to '' as $$
declare a public.addresses; em text; brand text; driver text; hi text; d date; day_txt text; lead text; tail text;
 subj text; t text; h text; oid uuid; qid uuid;
begin
 select * into a from public.addresses where id=p_address;
 if a.id is null or a.kind is distinct from 'd2d' then return null; end if;
 if not coalesce((select email_enabled from subnex_private.auto_plan_config where singleton),false) then return null; end if;
 em:=lower(btrim(coalesce(a.contact_email,'')));
 if em !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then return null; end if;
 if a.intake_channel='subnex_website' then
  return subnex_private.site_email_enqueue(a.id,'cancelled',p_key,
   jsonb_build_object('reason',a.cancellation_reason,'day',a.cancelled_date)||coalesce(p_extra,'{}'::jsonb));
 end if;
 brand:=case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end;
 driver:=nullif(btrim((select name from public.drivers where id=a.driver_id)),'');
 hi:='Hi '||coalesce(nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),''),'there')||',';
 d:=coalesce(nullif(p_extra->>'day','')::date,a.cancelled_date,a.date);
 day_txt:=case when d is null then '' else ' on '||to_char(d,'FMDay FMDD FMMonth') end;
 subj:='Your clothing collection has been cancelled';
 lead:='As requested, we have cancelled your clothing collection from '||a.text||day_txt||'.';
 tail:='If you would like a collection in the future, just reply to this email and we will arrange a new date.';
 t:=hi||E'\n\n'||lead||E'\n\n'||tail||E'\n\nThank you,\n'||coalesce(driver||E'\n','')||brand;
 h:='<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
   ||'<p>'||subnex_private.html_esc(hi)||'</p><p>'||subnex_private.html_esc(lead)||'</p>'
   ||'<p>'||subnex_private.html_esc(tail)||'</p><p>Thank you,<br>'||coalesce(subnex_private.html_esc(driver)||'<br>','')
   ||subnex_private.html_esc(brand)||'</p></div>';
 select id into oid from subnex_private.email_offers where address_id=a.id order by created_at desc limit 1;
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(oid,a.id,'cancelled',p_key,em,brand,null,subj,t,h)
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;
revoke all on function subnex_private.cancel_email_enqueue(uuid,text,jsonb) from public, anon, authenticated;

do $patch$
declare f text:='subnex_private.enqueue_auto_sms(uuid,text,text,uuid,uuid,jsonb)'; def text;
 a text:=$q$ if t.opted_out then return '{"state":"skipped","reason":"OPTED_OUT"}'; end if;$q$;
 b text:=$q$ if t.opted_out then
  -- Клиент отписался от SMS (STOP/CANCEL…): подтверждение отмены — письмом, если есть email.
  if p_event='cancelled' and (t.address_id is null and t.closed_request->>'id' is not distinct from p_closure::text) then
   oid:=subnex_private.cancel_email_enqueue(a.id,p_key,coalesce(p_extra,'{}'::jsonb));
   if oid is not null then return jsonb_build_object('state','email','reason','OPTED_OUT','id',oid); end if;
  end if;
  return '{"state":"skipped","reason":"OPTED_OUT"}';
 end if;$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('cancel_email_enqueue' in def)>0 then return; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='83:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('83:'||f,def);
 end if;
 if (length(def)-length(replace(def,a,'')))/length(a)<>1 then raise exception 'PATCH_FRAGMENT %',f; end if;
 execute replace(def,a,b);
end $patch$;
