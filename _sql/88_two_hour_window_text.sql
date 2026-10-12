-- 88: в SMS «1-hour arrival window» → «2-hour» (окно у клиентов 2 часа с 03.10). 12.10.2026.
-- day_offer_v1 и auto_sms_body: замена текста; ops_sms_before_dispatch на переходный период принимает и старый текст
-- (если в пульте открыта старая версия). Бэкапы: dispatch_backups '88:…'. Применено через MCP.
do $m$
declare src text;
begin
 src:=replace(pg_get_functiondef('public.ops_sms_before_dispatch(uuid,text,jsonb)'::regprocedure),E'\r','');
 if position('2-hour' in src)=0 then
  src:=replace(src, $o$        if txt is distinct from btrim(p_data->>'body') then raise exception 'STALE_ADDRESS'; end if;$o$,
$n$        if txt is distinct from btrim(p_data->>'body') and replace(txt,'2-hour','1-hour') is distinct from btrim(p_data->>'body') then raise exception 'STALE_ADDRESS'; end if;$n$);
  execute src;
 end if;
 src:=replace(pg_get_functiondef('subnex_private.day_offer_v1(date,text,text)'::regprocedure),E'\r','');
 if position('1-hour' in src)>0 then execute replace(src,'1-hour','2-hour'); end if;
 src:=replace(pg_get_functiondef('subnex_private.auto_sms_body(text,jsonb)'::regprocedure),E'\r','');
 if position('1-hour' in src)>0 then execute replace(src,'1-hour','2-hour'); end if;
end $m$;
