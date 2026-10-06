-- 78: максимально забитые дни (06.10.2026). Костя: «нужно максимально забитые дни» — порог «как ты скажешь».
-- • Совсем пустой день (например, пятница) открывается, только если в нём набирается min_new_day_stops (15) заявок.
--   Новый район в уже начатый день — по-прежнему от min_cluster_stops (5).
-- • Остаток («самый дешёвый по дороге день») в пустой день больше не ставится — только в начатые дни;
--   исключение: заявка ждёт дольше 5 дней, тогда может открыть день, чтобы никто не ждал бесконечно.
-- Без удаляющих команд. Повторный запуск безопасен; прежняя версия — в dispatch_backups '78:…'.
alter table subnex_private.auto_plan_config add column if not exists min_new_day_stops int not null default 15;

do $patch$
declare def text; f text:='subnex_private.auto_layout(boolean)'; pairs text[]; i int;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('min_new_day_stops' in def)>0 then return; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='78:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('78:'||f,def);
 end if;
 pairs:=array[
  $q$n_put int; v_k uuid;$q$, $q$n_put int; v_k uuid; minday int;$q$,
  $q$ minc:=greatest(coalesce(c.min_cluster_stops,5),1);$q$,
  $q$ minc:=greatest(coalesce(c.min_cluster_stops,5),1);
 minday:=greatest(coalesce(c.min_new_day_stops,15),minc);$q$,
  $q$=0 and n_put between 1 and minc-1 then$q$, $q$=0 and n_put between 1 and minday-1 then$q$,
  $q$    where q.k=v_k and q.day is null and l2.win is not null and x.cost is not null and l2.stops<c.day_capacity$q$,
  $q$    where q.k=v_k and q.day is null and l2.win is not null and x.cost is not null and l2.stops<c.day_capacity
      and (l2.stops>0 or q.created_at<now()-interval '5 days')$q$,
  $q$    order by x.cost, l2.day limit 1;$q$, $q$    order by (l2.stops=0), x.cost, l2.day limit 1;$q$,
  $q$'near_detour_minutes',tol,'min_cluster_stops',minc,$q$, $q$'near_detour_minutes',tol,'min_cluster_stops',minc,'min_new_day_stops',minday,$q$];
 for i in 1..array_length(pairs,1) by 2 loop
  if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
  def:=replace(def,pairs[i],pairs[i+1]);
 end loop;
 execute def;
end $patch$;
