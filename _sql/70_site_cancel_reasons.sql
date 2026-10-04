-- 70: письмо «Booking cancelled» клиенту с сайта — текст по причине, выбранной при отмене (04.10.2026).
do $patch$
declare def text; f text:='subnex_private.site_mail(text,uuid,jsonb)';
 a text:=$q$         else 'Your collection booking has been cancelled.' end;$q$;
 b text:=$q$         when reason='customer_cancelled' then 'As you requested, '||first||', we have cancelled your collection.'
         when reason='already_collected' then 'Our records show your donation has already been collected, so we have closed this booking.'
         when reason='no_bags' then 'As you have no bags to donate at the moment, we have cancelled this collection.'
         when reason='duplicate' then 'This was a second request for the same address, so we have closed it. Your other booking stays in place.'
         else 'Your collection booking has been cancelled.' end;$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('already_collected' in def)>0 then return; end if;
 if (length(def)-length(replace(def,a,'')))/length(a)<>1 then raise exception 'PATCH_FRAGMENT'; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='70:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('70:'||f,def);
 end if;
 execute replace(def,a,b);
end $patch$;
