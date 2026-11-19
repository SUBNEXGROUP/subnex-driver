-- 108. Сообщения клиентов с портала We Recycle Clothes (19.11.2026).
--
-- Письмо «Customer message for booking #N — Name»: клиент написал по своей брони.
-- Решение Кости (19.11):
--   • клиент у нас есть (активная заявка с тем же телефоном / почтой / домом) —
--     текст сообщения дописывается в заметку заявки; если это отказ
--     («no longer donating», «cancel» …) — заявка закрывается сама, без SMS;
--   • клиента у нас нет и это не отказ — заводится обычная заявка с адресом из письма,
--     текст сообщения в заметке (через subnex_intake: те же проверки и дубли);
--   • клиента нет и это отказ — ничего не делаем, только журнал.
-- Всё пишется в intake_log (outcome 'message'), чтобы было видно, что случилось.

create or replace function public.subnex_wrc_message(p_secret text, p_data jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_tok subnex_private.intake_tokens; m jsonb; v_ref text; msg text; booking text;
 v_phone text; v_email text; v_addr text; is_cancel boolean; a public.addresses; res jsonb; line text;
begin
 if p_secret is null or length(p_secret)<32 then perform pg_sleep(0.5); raise exception 'INTAKE_DENIED' using errcode='42501'; end if;
 select * into v_tok from subnex_private.intake_tokens where secret=p_secret and active;
 if v_tok.id is null then perform pg_sleep(0.5); raise exception 'INTAKE_DENIED' using errcode='42501'; end if;

 m := coalesce(p_data->'message','{}'::jsonb);
 v_ref := coalesce(nullif(btrim(m->>'ref'),''),'msg');
 if exists(select 1 from subnex_private.intake_log l where l.token_id=v_tok.id and l.ref=v_ref) then
  return jsonb_build_object('ok',true,'outcome','already');
 end if;
 msg := btrim(coalesce(m->>'text',''));
 booking := btrim(coalesce(m->>'booking',''));
 v_phone := subnex_private.phone(m->>'phone');
 v_email := lower(btrim(coalesce(m->>'email','')));
 v_addr := btrim(concat_ws(', ', nullif(btrim(m->>'address'),''), nullif(btrim(m->>'postcode'),'')));
 is_cancel := msg ~* '(no longer|not .{0,15}(donat|need|want)|don.?t (need|want)|do not (need|want)|cancel|changed my mind|already (gone|donated|collected|given)|remove (me|my|the)|not required)';
 line := 'WRC message'||case when booking<>'' then ' #'||booking else '' end||' ('||to_char(now() at time zone 'Europe/London','DD/MM HH24:MI')||'): '||msg;

 select * into a from public.addresses x
  where x.kind='d2d' and x.status in ('new','planned')
    and ((v_phone is not null and v_phone<>'' and subnex_private.phone(x.phone)=v_phone)
      or (v_email<>'' and lower(x.contact_email)=v_email)
      or (subnex_private.house_of(v_addr) is not null
          and subnex_private.postcode_of(x.text)=subnex_private.postcode_of(v_addr)
          and subnex_private.house_of(x.text)=subnex_private.house_of(v_addr)))
  order by x.created_at desc limit 1;

 if a.id is not null then
  update public.addresses set note=concat_ws(' · ', nullif(note,''), line) where id=a.id;
  if is_cancel then
   res := subnex_private.close_request(a.id,'customer_cancelled',false);
  end if;
  insert into subnex_private.intake_log(token_id,ref,address_id,outcome,detail,addr_text)
   values(v_tok.id,v_ref,a.id,'message',case when is_cancel then 'cancelled by customer' else 'note added' end,left(line,300));
  return jsonb_build_object('ok',true,'outcome',case when is_cancel then 'cancelled' else 'noted' end,'address_id',a.id,'close',res);
 end if;

 if is_cancel then
  insert into subnex_private.intake_log(token_id,ref,outcome,detail,addr_text)
   values(v_tok.id,v_ref,'message','cancel for unknown booking',left(line||' | '||v_addr,300));
  return jsonb_build_object('ok',true,'outcome','cancel_unknown');
 end if;

 -- Брони у нас нет: заводим обычную заявку тем же путём, что и строки сводки.
 res := public.subnex_intake(p_secret, jsonb_build_object('source','gmail','rows', jsonb_build_array(jsonb_build_object(
   'ref', v_ref, 'text', v_addr, 'phone', m->>'phone', 'contact_email', m->>'email', 'contact_name', m->>'name',
   'charity', m->>'charity', 'bags_text', m->>'bags', 'note', line))));
 return jsonb_build_object('ok',true,'outcome','created','intake',res);
end $function$;

revoke all on function public.subnex_wrc_message(text,jsonb) from public;
grant execute on function public.subnex_wrc_message(text,jsonb) to anon, authenticated;
