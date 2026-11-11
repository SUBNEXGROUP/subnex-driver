-- 102. Суонси два раза в месяц + попутные адреса + «район пока не обслуживаем» (решения 10.11.2026).
--
-- 1. Зоны: Суонси = SA1–SA18 (2-й и 4-й вторник). SA19–SA99 (Кармартен, Пембрукшир, Кередигион) выключены.
-- 2. День поездки в Суонси добирается попутными адресами CF/NP (крюк не больше near_detour_minutes),
--    не больше 30 остановок в такой день.
-- 3. Минимум 5 адресов на выезд считается вместе с попутными. Меньше — заявки Суонси ждут следующего
--    вторника выезда (правило «старше 5 дней — ставим на пустой день» на дни поездки больше не действует).
-- 4. Закрытие с причиной area_not_served_yet и notify=true: клиенту партнёра уходит SMS (есть мобильный)
--    или письмо (нет мобильного) «пока не работаем в вашем районе, но расширяемся».
-- Повторный запуск безопасен; прежние версии функций — в dispatch_backups '102:…'.

-- 1) Зоны.
update subnex_private.dispatch_zones
   set code='SA1-18', num_from=1, num_to=18, name='Swansea', mode='monthly', weekday=2, week_of_month=2,
       weeks_of_month=array[2,4]::smallint[], updated_at=now()
 where code='SA1-13';
update subnex_private.dispatch_zones
   set code='SA19-99', num_from=19, num_to=99, name='West Wales', mode='off', weekday=null, week_of_month=null,
       weeks_of_month=null, updated_at=now()
 where code='SA14-99';

-- 2) Потолок 30 остановок в дни выезда в Суонси.
update public.sms_day_hours h set max_stops=30
 where h.max_stops is null and h.day>=(now() at time zone 'Europe/London')::date
   and exists(select 1 from subnex_private.dispatch_zones f where f.mode='monthly' and subnex_private.zone_on_day(f,h.day));

-- 3) Поездка в дальнюю зону на этот день «открыта»: её адрес уже стоит в дне, удержан или предложен клиенту.
create or replace function subnex_private.far_trip_open(p_day date) returns boolean
language sql stable set search_path to '' as $$
 select exists(
  select 1 from subnex_private.dispatch_zones f
   where f.mode='monthly' and subnex_private.zone_on_day(f,p_day)
     and (exists(select 1 from public.addresses x
                  where x.status in ('new','planned') and x.kind<>'bank' and x.date=p_day
                    and (subnex_private.dispatch_zone_for(x.text)).code=f.code)
       or exists(select 1 from subnex_private.dispatch_holds h join public.addresses x on x.id=h.address_id
                  where h.state='held' and (h.starts_at at time zone 'Europe/London')::date=p_day
                    and (subnex_private.dispatch_zone_for(x.text)).code=f.code)
       or exists(select 1 from public.sms_offers o join public.addresses x on x.id=o.address_id
                  where o.state in ('preparing','awaiting','manual')
                    and (o.starts_at at time zone 'Europe/London')::date=p_day
                    and (subnex_private.dispatch_zone_for(x.text)).code=f.code)))
$$;
revoke all on function subnex_private.far_trip_open(date) from public, anon, authenticated;

-- 4) Можно ли ставить адрес в этот день. Новое: CF/NP — попутные в открытый день дальней поездки.
insert into subnex_private.dispatch_backups(name,definition)
select '102:dispatch_area_ok', pg_get_functiondef('subnex_private.dispatch_area_ok(text,date)'::regprocedure)
on conflict(name) do nothing;

create or replace function subnex_private.dispatch_area_ok(p_text text, p_day date)
 returns boolean language plpgsql stable set search_path to '' as $function$
declare z subnex_private.dispatch_zones;
begin
 if p_day is null then return false; end if;
 z:=subnex_private.dispatch_zone_for(p_text);
 if z.code is null or z.mode='off' then return false; end if;
 if z.mode in ('regular','weekly') then
  -- 102: Кардифф и Ньюпорт добирают день по дороге, когда поездка в дальнюю зону уже открыта.
  if z.prefix in ('CF','NP') and subnex_private.far_trip_open(p_day) then return true; end if;
  if z.mode='weekly' and not (extract(dow from p_day)::smallint=any(z.weekdays)) then return false; end if;
  -- Остальным районам день дальней поездки закрыт, пока ей есть кого везти.
  return not exists(
   select 1 from subnex_private.dispatch_zones f
    where f.mode='monthly'
      and subnex_private.zone_on_day(f,p_day)
      and exists(select 1 from public.addresses x
                  where x.status in ('new','planned') and x.kind<>'bank'
                    and (x.date=p_day or x.date is null)
                    and (subnex_private.dispatch_zone_for(x.text)).code=f.code));
 end if;
 if subnex_private.zone_on_day(z,p_day) then return true; end if;
 -- День уже занят этой зоной: согласованный сбор той же зоны на эту дату…
 if exists(select 1 from public.addresses x
            where x.status in ('new','planned') and x.date=p_day and x.collection_start is not null
              and subnex_private.dispatch_same_zone(subnex_private.dispatch_zone_for(x.text),z)) then return true; end if;
 -- …или удержанное место планировщика…
 if exists(select 1 from subnex_private.dispatch_holds h join public.addresses x on x.id=h.address_id
            where h.state='held' and (h.starts_at at time zone 'Europe/London')::date=p_day
              and subnex_private.dispatch_same_zone(subnex_private.dispatch_zone_for(x.text),z)) then return true; end if;
 -- …или отправленное клиенту предложение.
 if exists(select 1 from public.sms_offers o join public.addresses x on x.id=o.address_id
            where o.state in ('preparing','awaiting','manual')
              and (o.starts_at at time zone 'Europe/London')::date=p_day
              and subnex_private.dispatch_same_zone(subnex_private.dispatch_zone_for(x.text),z)) then return true; end if;
 return false;
end $function$;

-- 5) Точечные правки больших функций: каждый фрагмент обязан встретиться ровно один раз.
do $patch$
declare f text; def text; pairs text[]; i int; marker text;
begin
 foreach f in array array[
   'subnex_private.auto_layout(boolean)',
   'subnex_private.close_request(uuid,text,boolean)',
   'subnex_private.auto_sms_body(text,jsonb)',
   'subnex_private.cancel_email_enqueue(uuid,text,jsonb)'] loop
  def:=replace(pg_get_functiondef(f::regprocedure),E'\r','');
  marker:=case f when 'subnex_private.auto_layout(boolean)' then 'far boolean'
                 when 'subnex_private.close_request(uuid,text,boolean)' then 'qid uuid'
                 else 'area_not_served_yet' end;
  if position(marker in def)>0 then continue; end if;
  insert into subnex_private.dispatch_backups(name,definition) values('102:'||f,def) on conflict(name) do nothing;
  pairs:=case f
   when 'subnex_private.auto_layout(boolean)' then array[
    -- переменные
    $q$ days_out jsonb:='[]'; tol numeric; minc int; l record; p record; n_put int; v_k uuid; minday int;$q$,
    $q$ days_out jsonb:='[]'; tol numeric; minc int; l record; p record; n_put int; v_k uuid; minday int; far boolean;$q$,
    -- попутные CF/NP получают день поездки, на который претендуют заявки дальней зоны
    $q$  insert into _lz_day(k,day,points,kg,svc,stops,tour,base_stops,win)$q$,
    $q$  insert into _lz_allow(k,address_id,day)
  select distinct v_k, pp.address_id, fa.day
    from _lz_pool pp
    join public.addresses x on x.id=pp.address_id
    cross join (select distinct a2.day from _lz_allow a2 join public.addresses y on y.id=a2.address_id
                 where a2.k=v_k and (subnex_private.dispatch_zone_for(y.text)).mode='monthly') fa
   where pp.k=v_k
     and (subnex_private.dispatch_zone_for(x.text)).prefix in ('CF','NP')
     and (subnex_private.dispatch_zone_for(x.text)).mode in ('regular','weekly')
     and fa.day>=greatest((now() at time zone 'Europe/London')::date+greatest(c.lead_days,1),
                          coalesce(x.not_before,(now() at time zone 'Europe/London')::date+1))
     and not exists(select 1 from _lz_allow e where e.k=v_k and e.address_id=pp.address_id and e.day=fa.day);

  insert into _lz_day(k,day,points,kg,svc,stops,tour,base_stops,win)$q$,
    -- признак «день дальней поездки»
    $q$   guard:=0;
   loop
    guard:=guard+1; exit when guard>300;
    select * into l from _lz_day x where x.k=v_k and x.day=d;$q$,
    $q$   guard:=0;
   far:=exists(select 1 from subnex_private.dispatch_zones f where f.mode='monthly' and subnex_private.zone_on_day(f,d));
   loop
    guard:=guard+1; exit when guard>300;
    select * into l from _lz_day x where x.k=v_k and x.day=d;$q$,
    -- пустой день поездки начинается только с адреса дальней зоны
    $q$      where s.k=v_k and s.day is null and x.cost is not null and nb.n+1>=minc$q$,
    $q$      where s.k=v_k and s.day is null and x.cost is not null
        and ((not far and nb.n+1>=minc)
          or (far and (select (subnex_private.dispatch_zone_for(y.text)).mode from public.addresses y where y.id=s.address_id)='monthly'))$q$,
    -- минимум: обычный новый день — min_new_day_stops, день поездки — min_cluster_stops вместе с попутными
    $q$=0 and n_put between 1 and minday-1 then$q$,
    $q$=0 and n_put between 1 and (case when far then minc else minday end)-1 then$q$,
    -- запасной проход: день поездки не открывается ради старой заявки, попутные — только с малым крюком
    $q$      and (l2.stops>0 or q.created_at<now()-interval '5 days')$q$,
    $q$      and (l2.stops>0 or q.created_at<now()-interval '5 days')
      and (not exists(select 1 from subnex_private.dispatch_zones f where f.mode='monthly' and subnex_private.zone_on_day(f,l2.day))
        or (l2.stops>0 and (x.cost<=tol
             or (select (subnex_private.dispatch_zone_for(y.text)).mode from public.addresses y where y.id=q.address_id)='monthly')))$q$]
   when 'subnex_private.close_request(uuid,text,boolean)' then array[
    $q$notify boolean; note jsonb;$q$,
    $q$notify boolean; note jsonb; qid uuid;$q$,
    $q$ select * into t from public.sms_threads where address_id=a.id for update;$q$,
    $q$ -- 102: «район не обслуживаем» — переписки ещё нет, а сообщить клиенту нужно: заводим её под SMS.
 if p_reason='area_not_served_yet' and coalesce(p_notify,false)
    and coalesce(subnex_private.phone(a.phone),'') ~ '^\+447[0-9]{9}$'
    and not exists(select 1 from public.sms_threads x where x.address_id=a.id) then
  insert into public.sms_threads(phone,address_id,driver_id,manual_mode)
   values(subnex_private.phone(a.phone),a.id,a.driver_id,true) on conflict(phone) do nothing;
 end if;
 select * into t from public.sms_threads where address_id=a.id for update;$q$,
    $q$  note:=subnex_private.enqueue_auto_sms(a.id,'cancelled','cancelled',t.id,saved.id,jsonb_build_object('reason',p_reason));
 end if;$q$,
    $q$  note:=subnex_private.enqueue_auto_sms(a.id,'cancelled','cancelled',t.id,saved.id,jsonb_build_object('reason',p_reason));
 end if;
 -- 102: SMS не ушло (нет мобильного, отписка, номер занят другой заявкой) — то же самое письмом.
 if notify and p_reason='area_not_served_yet' and coalesce(note->>'state','') not in ('pending','email')
    and not coalesce((note->>'repeated')::boolean,false) then
  qid:=subnex_private.cancel_email_enqueue(a.id,'cancelled',jsonb_build_object('reason',p_reason));
  if qid is not null then note:=jsonb_build_object('state','email','id',qid); end if;
 end if;$q$]
   when 'subnex_private.auto_sms_body(text,jsonb)' then array[
    $q$  elsif p_snapshot->>'reason'='no_reply' then$q$,
    $q$  elsif p_snapshot->>'reason'='area_not_served_yet' then
   body:='Thank you for your clothing collection request. We are sorry, but we do not collect in your area just yet. We are expanding all the time and hope to reach you soon, so please do try us again in the future.';
  elsif p_snapshot->>'reason'='no_reply' then$q$]
   else array[
    $q$ tail:='If you would like a collection in the future, just reply to this email and we will arrange a new date.';$q$,
    $q$ tail:='If you would like a collection in the future, just reply to this email and we will arrange a new date.';
 if coalesce(p_extra->>'reason',a.cancellation_reason,'')='area_not_served_yet' then
  subj:='We are not collecting in your area just yet';
  lead:='Thank you for your request for a clothing collection from '||a.text||'. We are sorry to say that we do not collect in your area at the moment.';
  tail:='We are growing and adding new areas all the time, so we hope to reach you soon. Please do get in touch again in the future - we would love to help.';
 end if;$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;
