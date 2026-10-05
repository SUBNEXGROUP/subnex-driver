-- 73: «Адрес вне зоны автоматического распределения» теперь называет адрес и день (05.10.2026).
-- Пульт уже дописывает detail.address к тексту ошибки, так что видно, какая заявка из пачки и на какой день не прошла.
-- Без DROP. Повторный запуск безопасен; прежняя версия — в dispatch_backups '73:…'.
do $patch$
declare def text; f text:='public.subnex_dispatch(text,jsonb)';
 a text:=$q$if not subnex_private.dispatch_area_ok(a.text,(st at time zone 'Europe/London')::date) then raise exception 'OUTSIDE_AREA';end if;$q$;
 b text:=$q$if not subnex_private.dispatch_area_ok(a.text,(st at time zone 'Europe/London')::date) then raise exception 'OUTSIDE_AREA'
     using detail=jsonb_build_object('address',a.text||' — '||to_char((st at time zone 'Europe/London')::date,'FMDay DD.MM'),
      'zone',(subnex_private.dispatch_zone_for(a.text)).code,'day',(st at time zone 'Europe/London')::date)::text;end if;$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('''zone'',(subnex_private.dispatch_zone_for(a.text)).code' in def)>0 then return; end if;
 if (length(def)-length(replace(def,a,'')))/length(a)<>1 then raise exception 'PATCH_FRAGMENT %',f; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='73:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('73:'||f,def);
 end if;
 execute replace(def,a,b);
end $patch$;
