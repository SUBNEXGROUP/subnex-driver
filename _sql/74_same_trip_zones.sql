-- 74: Суонси (SA1-13) и Запад Уэльса (SA14-99) — одна поездка, как уже считает пульт (05.10.2026).
-- Пульт ставил адрес Neath SA11 на вторник 27.10, где уже подтверждён сбор SA46 (Запад Уэльса),
-- а сервер отказывал «вне зоны»: он сравнивал зоны только по коду. Теперь «своими» считаются и
-- месячные зоны с одним днём выезда (sameZone в ops-dispatch-core.js) — план сохраняется.
-- Без DROP. Повторный запуск безопасен; прежняя версия — в dispatch_backups '74:…'.
create or replace function subnex_private.dispatch_same_zone(x subnex_private.dispatch_zones, y subnex_private.dispatch_zones)
returns boolean language sql immutable set search_path to '' as $$
 select x.code is not null and y.code is not null and (x.code=y.code or (x.mode='monthly' and y.mode='monthly'
  and x.weekday is not distinct from y.weekday and coalesce(x.week_of_month,5)=coalesce(y.week_of_month,5)))
$$;

do $patch$
declare def text; f text:='subnex_private.dispatch_area_ok(text,date)';
 a text:=$q$(subnex_private.dispatch_zone_for(x.text)).code=z.code$q$;
 b text:=$q$subnex_private.dispatch_same_zone(subnex_private.dispatch_zone_for(x.text),z)$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('dispatch_same_zone' in def)>0 then return; end if;
 if (length(def)-length(replace(def,a,'')))/length(a)<>3 then raise exception 'PATCH_FRAGMENT %',f; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='74:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('74:'||f,def);
 end if;
 execute replace(def,a,b);
end $patch$;
