-- 94 (15.10.2026): «двойник по номеру» не срабатывает на пустой номер.
-- Сайт не требует телефон (SQL 80): пустой номер совпадал с пустым номером любой более старой заявки →
-- auto_plan_skip = TWIN_PHONE, дата не предлагалась, клиент получал только «Request received».
-- Случай: kempmairwen@yahoo.co.uk, 12 Gwenllian St (заявка 15.10 09:37). Применено через MCP.
do $m$
declare src text; f text;
begin
 foreach f in array array['subnex_private.auto_plan()','subnex_private.auto_plan_skip(uuid)'] loop
  src:=replace(pg_get_functiondef(f::regprocedure),E'\r','');
  if position('TWIN_PHONE_NONEMPTY' in src)=0 then
   src:=replace(src,'and subnex_private.phone(y.phone)=num','and coalesce(num,'''')<>'''' /* TWIN_PHONE_NONEMPTY */ and subnex_private.phone(y.phone)=num');
   execute src;
  end if;
 end loop;
end $m$;
