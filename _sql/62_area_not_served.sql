-- 62: отмена сборов в районе, который мы больше не обслуживаем (03.10.2026, первый случай — GL).
-- Новая причина 'area_not_served' для close_request: клиенту уходит своё сообщение вместо общего
-- «booking cancelled, book again». Повторный запуск безопасен; прежняя версия — в dispatch_backups '62:…'.
do $patch$
declare def text; f text:='subnex_private.auto_sms_body(text,jsonb)';
 old_frag text:=$q$  if p_snapshot->>'reason'='no_reply' then$q$;
 new_frag text:=$q$  if p_snapshot->>'reason'='area_not_served' then
   body:='We are sorry, but we are no longer able to collect in your area, so we have had to cancel your booked collection. Thank you for thinking of us, and apologies for any inconvenience.';
  elsif p_snapshot->>'reason'='no_reply' then$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('area_not_served' in def)>0 then return; end if;
 if (length(def)-length(replace(def,old_frag,'')))/length(old_frag)<>1 then raise exception 'PATCH_FRAGMENT %',f; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='62:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('62:'||f,def);
 end if;
 execute replace(def,old_frag,new_frag);
end $patch$;
