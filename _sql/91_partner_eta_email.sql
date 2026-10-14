-- 91: утреннее окно прибытия письмом клиентам партнёров без рабочего мобильного (14.10.2026).
-- Раньше eta уходила только SMS: у клиентов, подтвердивших дату письмом с subnex.operations@, окна не было.
-- enqueue_auto_sms('eta'): если email_route() есть и мобильного нет (или номер недоступен, SQL 86) —
-- письмо kind 'eta' (from_email null → отправляет Письма.gs с subnex.operations@), бренд We Recycle Clothes.
-- Бэкап: dispatch_backups '91:subnex_private.enqueue_auto_sms'. Применено через MCP как 91_partner_eta_email.
create or replace function subnex_private.partner_eta_mail(p_address uuid, p_extra jsonb)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare a public.addresses; brand text; driver text; hi text; win text; lead text; tail text; subj text; t text; h text;
begin
 select * into a from public.addresses where id=p_address;
 brand:=case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end;
 driver:=nullif(btrim((select name from public.drivers where id=a.driver_id)),'');
 hi:='Hi '||coalesce(nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),''),'there')||',';
 win:=subnex_private.sms_clock((p_extra->>'eta_from')::int)||' and '||subnex_private.sms_clock((p_extra->>'eta_to')::int);
 subj:='We are collecting today between '||win;
 lead:='Your clothing collection from '||a.text||' is today. We expect to reach you between '||win||'.';
 tail:='Please leave the bags outside where we can see them from the street. If anything has changed, just reply to this email.';
 t:=hi||E'\n\n'||lead||E'\n\n'||tail||E'\n\nThank you,\n'||coalesce(driver||E'\n','')||brand;
 h:='<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
   ||'<p>'||subnex_private.html_esc(hi)||'</p><p><b>'||subnex_private.html_esc(lead)||'</b></p><p>'||subnex_private.html_esc(tail)||'</p>'
   ||'<p>Thank you,<br>'||coalesce(subnex_private.html_esc(driver)||'<br>','')||subnex_private.html_esc(brand)||'</p></div>';
 return jsonb_build_object('subject',subj,'text',t,'html',h,'from_name',brand);
end $$;
-- + патч enqueue_auto_sms: ветка перед «if not c.enabled» (см. миграцию 91 в Supabase).
