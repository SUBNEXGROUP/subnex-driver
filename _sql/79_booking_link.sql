-- 79: кнопка «Book another collection» в письмах вела на https://subnex.co.uk/#book — такого места на сайте нет,
-- форма заявки называется #booking (06.10.2026). Меняет обе ссылки в site_mail.
-- Без удаляющих команд. Повторный запуск безопасен; прежняя версия — в dispatch_backups '79:…'.
do $patch$
declare def text; f text:='subnex_private.site_mail(text,uuid,jsonb)'; n int;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('subnex.co.uk/#booking' in def)>0 then return; end if;
 n:=(length(def)-length(replace(def,$q$subnex.co.uk/#book'$q$,'')))/length($q$subnex.co.uk/#book'$q$);
 if n<>2 then raise exception 'PATCH_FRAGMENT % found %',f,n; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='79:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('79:'||f,def);
 end if;
 def:=replace(def,$q$subnex.co.uk/#book'$q$,$q$subnex.co.uk/#booking'$q$);
 execute def;
end $patch$;
