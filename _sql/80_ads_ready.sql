-- 80: подготовка сайта к рекламе Google (06.10.2026). Костя: «делай», телефон в форме — необязательный.
-- • subnex_area_check: кроме «обслуживаем / нет» отдаёт дни сбора района (Monday…), чтобы сайт показал
--   «We collect in CF14 on Mondays, Wednesdays, Fridays and Saturdays». Точную дату не обещаем.
-- • subnex_web_booking: телефон необязателен (если указан — проверяется как раньше); лимит «3 заявки в сутки
--   с той же почты/телефона» больше не склеивает всех, кто без телефона; метки рекламы (gclid, utm, страница)
--   сохраняются в web_bookings.ad — по ним видно, какие заявки пришли из рекламы и чем закончились.
-- • site_mail 'collected': если в auto_plan_config.review_url есть ссылка на отзыв Google — главная кнопка письма
--   «Leave us a Google review». Пока ссылки нет — письмо как раньше.
-- Без удаляющих команд. Повторный запуск безопасен; прежние версии — в dispatch_backups '80:…'.
alter table subnex_private.web_bookings add column if not exists ad jsonb;
alter table subnex_private.auto_plan_config add column if not exists review_url text;

create or replace function public.subnex_area_check(p_postcode text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare pc text:=upper(regexp_replace(left(btrim(coalesce(p_postcode,'')),12),'\s+','','g')); z subnex_private.dispatch_zones;
 names text[]:=array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; days text[];
begin
 if pc !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$' then return '{"valid":false}'; end if;
 pc:=left(pc,length(pc)-3)||' '||right(pc,3);
 z:=subnex_private.dispatch_zone_for('x '||pc);
 if z.code is null or z.mode='off' then
  return jsonb_build_object('valid',true,'served',false,'district',split_part(pc,' ',1));
 end if;
 if z.mode='weekly' then
  select array_agg(names[w+1] order by case when w=0 then 7 else w end) into days from unnest(z.weekdays) w where w between 0 and 6;
 elsif z.mode='monthly' and z.weekday between 0 and 6 then
  days:=array[names[z.weekday+1]];
 end if;
 return jsonb_build_object('valid',true,'served',true,'district',split_part(pc,' ',1),'mode',z.mode,
  'days',coalesce(to_jsonb(days),'[]'::jsonb),'week_of_month',z.week_of_month);
end $$;

do $patch$
declare def text; f text:='public.subnex_web_booking(jsonb)'; pairs text[]; i int;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('v_ad jsonb' in def)>0 then return; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='80:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('80:'||f,def);
 end if;
 pairs:=array[
  $q$v_lat float8; v_lng float8;$q$, $q$v_lat float8; v_lng float8; v_ad jsonb;$q$,
  $q$ if length(regexp_replace(v_phone_raw,'\D','','g'))<10 then raise exception 'PHONE_INVALID'; end if;$q$,
  $q$ if v_phone_raw<>'' and length(regexp_replace(v_phone_raw,'\D','','g'))<10 then raise exception 'PHONE_INVALID'; end if;$q$,
  $q$(w.email=v_email or w.phone=v_phone_raw)$q$, $q$(w.email=v_email or (v_phone_raw<>'' and w.phone=v_phone_raw))$q$,
  $q$ v_phone:=subnex_private.phone(v_phone_raw);$q$,
  $q$ select nullif(jsonb_object_agg(k,left(btrim(p_data->'ad'->>k),300)) filter (where coalesce(btrim(p_data->'ad'->>k),'')<>''),'{}'::jsonb)
   into v_ad
   from unnest(array['gclid','gbraid','wbraid','utm_source','utm_medium','utm_campaign','utm_term','utm_content','page','referrer']) k
  where jsonb_typeof(p_data->'ad')='object';
 v_phone:=subnex_private.phone(v_phone_raw);$q$,
  $q$web_bookings(ip,email,phone,postcode,address_id,outcome) values(v_ip,v_email,v_phone_raw,v_pc,v_id,'created');$q$,
  $q$web_bookings(ip,email,phone,postcode,address_id,outcome,ad) values(v_ip,v_email,v_phone_raw,v_pc,v_id,'created',v_ad);$q$,
  $q$web_bookings(ip,email,phone,postcode,address_id,outcome) values(v_ip,v_email,v_phone_raw,v_pc,v_id,'duplicate');$q$,
  $q$web_bookings(ip,email,phone,postcode,address_id,outcome,ad) values(v_ip,v_email,v_phone_raw,v_pc,v_id,'duplicate',v_ad);$q$];
 for i in 1..array_length(pairs,1) by 2 loop
  if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
  def:=replace(def,pairs[i],pairs[i+1]);
 end loop;
 execute def;
end $patch$;

do $patch$
declare def text; f text:='subnex_private.site_mail(text,uuid,jsonb)'; pairs text[]; i int;
begin
 def:=pg_get_functiondef(f::regprocedure);
 if position('v_review' in def)>0 then return; end if;
 if not exists(select 1 from subnex_private.dispatch_backups where name='80:'||f) then
  insert into subnex_private.dispatch_backups(name,definition) values('80:'||f,def);
 end if;
 pairs:=array[
  $q$ labels text[]:=array[$q$, $q$ v_review text; labels text[]:=array[$q$,
  $q$btn:='Book another collection'; btn_url:='https://subnex.co.uk/#booking'; step:=4;$q$,
  $q$btn:='Book another collection'; btn_url:='https://subnex.co.uk/#booking'; step:=4;
  select nullif(btrim(c.review_url),'') into v_review from subnex_private.auto_plan_config c where c.singleton;
  if v_review is not null then
   btn:='Leave us a Google review'; btn_url:=v_review;
   tip:='A quick Google review helps your neighbours find us and takes less than a minute. If you have more to donate in the future, just book again on our website or reply to this email.';
  end if;$q$];
 for i in 1..array_length(pairs,1) by 2 loop
  if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
  def:=replace(def,pairs[i],pairs[i+1]);
 end loop;
 execute def;
end $patch$;
