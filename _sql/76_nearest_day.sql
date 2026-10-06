-- 76: день для заявки — ближайший, если крюк не больше 30 минут (06.10.2026).
-- Раньше вечерняя раскладка (auto_layout) ставила каждую заявку туда, где вставка дешевле всего по дороге,
-- и клиенты Кардиффа ждали неделю: заявка вторника уходила на следующий понедельник.
-- Теперь раскладка идёт по дням по порядку:
--   1) в ближайший день встаёт всё, что добавляет к его маршруту не больше near_detour_minutes (30);
--   2) новый район в день (или пустой день) открывается, только если рядом набирается
--      min_cluster_stops (5) заявок в пределах ~15 минут друг от друга — полупустых выездов не будет;
--   3) что не встало никуда по этим правилам — как раньше, в самый дешёвый по дороге день.
-- auto_plan_days (письма сайта, список «другой день») — та же логика: сначала ближайший день,
-- где крюк ≤ 30 минут, потом остальные.
-- Без удаляющих команд. Повторный запуск безопасен; прежние версии — в dispatch_backups '76:…'.
alter table subnex_private.auto_plan_config add column if not exists near_detour_minutes int not null default 30;
alter table subnex_private.auto_plan_config add column if not exists min_cluster_stops int not null default 5;

do $b$ begin
 if not exists(select 1 from subnex_private.dispatch_backups where name='76:subnex_private.auto_layout(boolean)') then
  insert into subnex_private.dispatch_backups(name,definition)
  values('76:subnex_private.auto_layout(boolean)',pg_get_functiondef('subnex_private.auto_layout(boolean)'::regprocedure));
 end if;
end $b$;

create or replace function subnex_private.auto_layout(p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c subnex_private.auto_plan_config; cfg jsonb; dr uuid; d date;
 placed int:=0; left_ int:=0; drivers int:=0; seeded int:=0; fallback int:=0; undone int:=0;
 best_addr uuid; best_day date; best_cost numeric; pos int; node jsonb; cap_kg numeric; guard int;
 days_out jsonb:='[]'; tol numeric; minc int; l record; p record; n_put int; v_k uuid;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 tol:=greatest(coalesce(c.near_detour_minutes,30),0);
 minc:=greatest(coalesce(c.min_cluster_stops,5),1);
 perform subnex_private.auto_layout_clean();

 -- Временные таблицы живут до конца сеанса (pg_cron запускает каждую раскладку в новом сеансе); прогоны не мешают друг другу — у каждого свой ключ v_k.
 create temp table if not exists _lz_day(k uuid, day date, points jsonb, kg numeric, svc int, stops int, tour numeric, base_stops int, win int);
 create temp table if not exists _lz_pool(k uuid, address_id uuid, lat float8, lng float8, kg numeric, svc int, created_at timestamptz, day date, cost numeric, how text);
 create temp table if not exists _lz_allow(k uuid, address_id uuid, day date);

 for dr in select id from public.drivers where active order by id loop
  drivers:=drivers+1;
  -- Каждый водитель — свой ключ v_k: временные таблицы не чистим, а фильтруем по ключу.
  v_k:=gen_random_uuid();
  cfg:=subnex_private.dispatch_config(dr);
  if cfg->'home'->>'lat' is null or cfg->'depot'->>'lat' is null then continue; end if;
  cap_kg:=(cfg->>'capacity_kg')::numeric;

  -- Пул: то же, что берёт auto_plan.
  insert into _lz_pool(k,address_id,lat,lng,kg,svc,created_at)
  select v_k, x.id, x.lat, x.lng, x.estimated_kg, x.service_minutes, x.created_at
    from public.addresses x
   where x.driver_id=dr and x.status='new' and x.date is null and x.collection_start is null
     and x.kind='d2d' and x.lat is not null
     and not exists(select 1 from subnex_private.dispatch_holds h where h.address_id=x.id and h.state='held')
     and not exists(select 1 from public.sms_offers o where o.address_id=x.id and o.state in ('preparing','awaiting','manual'))
     and not exists(select 1 from public.sms_threads t where t.address_id=x.id and t.manual_mode and t.active_offer_id is not null)
     and not (x.intake_channel in ('subnex_website','partner_email') and coalesce(subnex_private.phone(x.phone),'') !~ '^\+447[0-9]{9}$' and subnex_private.email_route(x.id) is null)
   order by x.created_at limit 200;

  insert into _lz_allow(k,address_id,day) select v_k, pp.address_id, dd.day from _lz_pool pp cross join lateral unnest(subnex_private.auto_layout_days(pp.address_id)) as dd(day) where pp.k=v_k;

  insert into _lz_day(k,day,points,kg,svc,stops,tour,base_stops,win)
  select v_k, s.day, s.pts, 0, 0, 0, 0, 0,
         (select subnex_private.dispatch_clock(w->>'closes')-subnex_private.dispatch_clock(w->>'opens') from subnex_private.day_window(s.day) w)
    from (select distinct a.day, subnex_private.rough_day_points(dr,a.day) pts from _lz_allow a where a.k=v_k) s;
  update _lz_day set
    kg=coalesce((select sum((x->>'kg')::numeric) from jsonb_array_elements(points) x),0),
    svc=coalesce((select sum((x->>'service')::int) from jsonb_array_elements(points) x),0),
    stops=jsonb_array_length(points), base_stops=jsonb_array_length(points),
    tour=coalesce(subnex_private.rough_tour_minutes(points,cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor),0)
   where _lz_day.k=v_k;

  -- 1–2. По дням по порядку: ближайший день, крюк ≤ tol; новый район — только гнездом от minc заявок.
  for d in select x.day from _lz_day x where x.k=v_k and x.win is not null order by x.day loop
   guard:=0;
   loop
    guard:=guard+1; exit when guard>300;
    select * into l from _lz_day x where x.k=v_k and x.day=d;
    exit when l.stops>=c.day_capacity;
    best_addr:=null; best_cost:=null;
    if l.stops>0 then
     select q.address_id, x.cost into best_addr, best_cost
       from _lz_pool q join _lz_allow a on a.k=v_k and a.address_id=q.address_id and a.day=d
       cross join lateral (select subnex_private.rough_insert_minutes(l.points,jsonb_build_object('lat',q.lat,'lng',q.lng),
                             cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor) as cost) x
      where q.k=v_k and q.day is null and x.cost is not null and x.cost<=tol
        and l.kg+q.kg<=cap_kg and l.tour+x.cost+l.svc+q.svc<=l.win
      order by x.cost, q.created_at limit 1;
    end if;
    if best_addr is null then
     select s.address_id, x.cost into best_addr, best_cost
       from _lz_pool s join _lz_allow a on a.k=v_k and a.address_id=s.address_id and a.day=d
       cross join lateral (select subnex_private.rough_insert_minutes(l.points,jsonb_build_object('lat',s.lat,'lng',s.lng),
                             cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor) as cost) x
       cross join lateral (select count(*) as n from _lz_pool q join _lz_allow qa on qa.k=v_k and qa.address_id=q.address_id and qa.day=d
                            where q.k=v_k and q.day is null and q.address_id<>s.address_id
                              and subnex_private.rough_minutes(jsonb_build_object('lat',s.lat,'lng',s.lng),
                                    jsonb_build_object('lat',q.lat,'lng',q.lng),c.road_speed_kmh,c.detour_factor)<=tol/2) nb
      where s.k=v_k and s.day is null and x.cost is not null and nb.n+1>=minc
        and l.kg+s.kg<=cap_kg and l.tour+x.cost+l.svc+s.svc<=l.win
      order by nb.n desc, x.cost, s.created_at limit 1;
     if best_addr is not null then seeded:=seeded+1; end if;
    end if;
    exit when best_addr is null;
    select * into p from _lz_pool x where x.k=v_k and x.address_id=best_addr;
    node:=jsonb_build_object('lat',to_jsonb(p.lat),'lng',to_jsonb(p.lng),'service',p.svc,'kg',p.kg);
    pos:=subnex_private.rough_insert_pos(l.points,node,cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor);
    update _lz_day x set points=jsonb_insert(x.points,array[pos::text],node), kg=x.kg+p.kg, svc=x.svc+p.svc, stops=x.stops+1 where x.k=v_k and x.day=d;
    update _lz_day x set tour=coalesce(subnex_private.rough_tour_minutes(x.points,cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor),0) where x.k=v_k and x.day=d;
    update _lz_pool x set day=d, cost=best_cost, how='near' where x.k=v_k and x.address_id=best_addr;
   end loop;
   -- Пустой день, где в итоге набралось меньше minc, не открываем: заявки уходят в следующие дни.
   select count(*) into n_put from _lz_pool x where x.k=v_k and x.day=d;
   if (select x.base_stops from _lz_day x where x.k=v_k and x.day=d)=0 and n_put between 1 and minc-1 then
    update _lz_pool x set day=null, cost=null, how=null where x.k=v_k and x.day=d;
    update _lz_day x set points='[]', kg=0, svc=0, stops=0, tour=0 where x.k=v_k and x.day=d;
    undone:=undone+n_put;
   end if;
  end loop;

  -- 3. Остаток — как раньше: самая дешёвая по дороге вставка, при равной цене раньше день.
  guard:=0;
  loop
   guard:=guard+1; exit when guard>300;
   select q.address_id, l2.day, x.cost into best_addr, best_day, best_cost
     from _lz_pool q join _lz_allow a on a.k=v_k and a.address_id=q.address_id
     join _lz_day l2 on l2.k=v_k and l2.day=a.day
     cross join lateral (select subnex_private.rough_insert_minutes(l2.points,jsonb_build_object('lat',q.lat,'lng',q.lng),
                           cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor) as cost) x
    where q.k=v_k and q.day is null and l2.win is not null and x.cost is not null and l2.stops<c.day_capacity
      and l2.kg+q.kg<=cap_kg and l2.tour+x.cost+l2.svc+q.svc<=l2.win
    order by x.cost, l2.day limit 1;
   exit when best_addr is null;
   select * into p from _lz_pool x where x.k=v_k and x.address_id=best_addr;
   select * into l from _lz_day x where x.k=v_k and x.day=best_day;
   node:=jsonb_build_object('lat',to_jsonb(p.lat),'lng',to_jsonb(p.lng),'service',p.svc,'kg',p.kg);
   pos:=subnex_private.rough_insert_pos(l.points,node,cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor);
   update _lz_day x set points=jsonb_insert(x.points,array[pos::text],node), kg=x.kg+p.kg, svc=x.svc+p.svc, stops=x.stops+1 where x.k=v_k and x.day=best_day;
   update _lz_day x set tour=coalesce(subnex_private.rough_tour_minutes(x.points,cfg->'home',cfg->'depot',c.road_speed_kmh,c.detour_factor),0) where x.k=v_k and x.day=best_day;
   update _lz_pool x set day=best_day, cost=best_cost, how='cheapest' where x.k=v_k and x.address_id=best_addr;
   fallback:=fallback+1;
  end loop;

  if not p_dry then
   insert into subnex_private.auto_layout_plan(address_id,day,cost_minutes,computed_at)
   select x.address_id, x.day, x.cost, now() from _lz_pool x where x.k=v_k and x.day is not null
   on conflict(address_id) do update set day=excluded.day, cost_minutes=excluded.cost_minutes, computed_at=now();
  end if;
  placed:=placed+(select count(*) from _lz_pool x where x.k=v_k and x.day is not null);
  left_:=left_+(select count(*) from _lz_pool x where x.k=v_k and x.day is null);

  days_out:=days_out||coalesce((select jsonb_agg(jsonb_build_object(
      'driver',(select name from public.drivers where id=dr),
      'day',l3.day,'stops',l3.stops,'new',(select count(*) from _lz_pool q where q.k=v_k and q.day=l3.day),
      'kg',l3.kg,'drive_minutes',round(l3.tour),'service_minutes',l3.svc) order by l3.day)
    from _lz_day l3 where l3.k=v_k and l3.stops>0),'[]'::jsonb);
 end loop;

 if not p_dry then
  update subnex_private.auto_plan_config set last_layout_at=now() where singleton;
 end if;
 return jsonb_build_object('placed',placed,'left',left_,'drivers',drivers,'dry',p_dry,'seeded',seeded,
  'cheapest_fallback',fallback,'undone_small_days',undone,'near_detour_minutes',tol,'min_cluster_stops',minc,'days',days_out);
end $$;
revoke all on function subnex_private.auto_layout(boolean) from public;

do $patch$
declare def text; f text:='subnex_private.auto_plan_days(uuid)';
 a text:=$q$  order by round((x->>'add')::numeric), case when (x->>'cnt')::int=0 then 1 else 0 end, (x->>'day')::date);$q$;
 b text:=$q$  order by case when (x->>'cnt')::int>0 and (x->>'add')::numeric<=coalesce(c.near_detour_minutes,30) then 0 else 1 end,
   case when (x->>'cnt')::int>0 and (x->>'add')::numeric<=coalesce(c.near_detour_minutes,30) then (x->>'day')::date end,
   round((x->>'add')::numeric), case when (x->>'cnt')::int=0 then 1 else 0 end, (x->>'day')::date);$q$;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('near_detour_minutes' in def)>0 then return; end if;
 if (length(def)-length(replace(def,a,'')))/length(a)<>1 then raise exception 'PATCH_FRAGMENT %',f; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='76:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('76:'||f,def);
 end if;
 execute replace(def,a,b);
end $patch$;

-- Пульт («Рассчитать»): каждый день ожидания стоит 10 минут дороги (было 2) — тот же принцип вручную.
update subnex_private.dispatch_settings set config=config||'{"day_penalty_minutes":10}'::jsonb where driver_id is not null;
