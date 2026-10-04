-- 69: клиент с сайта сам отменяет или переносит подтверждённый сбор — как в службах доставки (04.10.2026).
-- • В письмах «confirmed», «day_before», «eta» — ссылка «Need to change or cancel? Manage your booking».
-- • Страница confirm.html для подтверждённого сбора показывает «Cancel collection» и другие дни зоны.
--   Отмена — до старта маршрута в этот день; перенос — на любой допустимый день после сегодняшнего.
-- • Отмена: close_request(...,'customer_cancelled') → клиенту письмо «Booking cancelled» (триггер 68).
--   Перенос: дата сбора меняется, клиенту новое письмо «Collection confirmed».
-- Без DROP. Повторный запуск безопасен; прежние версии — в dispatch_backups '69:…'.
do $patch$
declare def text; f text; pairs text[]; i int;
begin
 foreach f in array array['subnex_private.site_mail(text,uuid,jsonb)','public.subnex_email_choose(text,text,date)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  if position('customer_cancelled' in def)>0 or position('Manage your booking' in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='69:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('69:'||f,def);
  end if;
  pairs:=case f
   when 'subnex_private.site_mail(text,uuid,jsonb)' then array[
    $q$ link:=nullif(p_extra->>'link','');$q$,
    $q$ link:=nullif(p_extra->>'link','');
 if link is null and p_kind in ('confirmed','day_before','eta') then
  select c.email_confirm_url||'?t='||e.token into link from subnex_private.email_offers e, subnex_private.auto_plan_config c
   where c.singleton and e.address_id=p_address and e.state='confirmed' order by e.confirmed_at desc nulls last limit 1;
 end if;$q$,
    $q$ t:=t||E'\n'||tip||E'\n\nThank you,\nSUBNEX\nsubnex.co.uk';$q$,
    $q$ t:=t||E'\n'||tip;
 if link is not null and p_kind in ('confirmed','day_before','eta') then t:=t||E'\n\nNeed to change or cancel? Manage your booking: '||link; end if;
 t:=t||E'\n\nThank you,\nSUBNEX\nsubnex.co.uk';$q$,
    $q$  ||subnex_private.html_esc(tip)||'</td></tr></table>'$q$,
    $q$  ||subnex_private.html_esc(tip)||'</td></tr></table>'
  ||case when link is not null and p_kind in ('confirmed','day_before','eta') then
     '<p style="margin:18px 0 0 0;font-family:Arial,Helvetica,sans-serif;color:#8888AA;font-size:13px;line-height:1.5">Need to change or cancel? '
     ||'<a href="'||subnex_private.html_esc(link)||'" style="color:#2ECC71;font-weight:bold;text-decoration:none">Manage your booking &rarr;</a></p>'
    else '' end$q$]
   else array[
    $q$ if e.state='confirmed' then return info||'{"ok":true,"state":"confirmed","already":true}'; end if;$q$,
    $q$ if e.state='confirmed' then
  -- Подтверждённый сбор: клиент с сайта может отменить (до старта маршрута) или перенести (на день после сегодняшнего).
  live:=a.intake_channel='subnex_website' and a.status='planned' and a.date=e.day and e.day>=(now() at time zone 'Europe/London')::date
    and not exists(select 1 from subnex_private.dispatch_days dd where dd.driver_id=a.driver_id and dd.day=e.day and dd.started_at is not null);
  if p_action not in ('cancel','change') then
   if live and e.day>(now() at time zone 'Europe/London')::date then
    begin days:=subnex_private.auto_plan_days(a.id); exception when others then days:='{}'; end;
    select coalesce(jsonb_agg(jsonb_build_object('day',x,'day_text',to_char(x,'FMDay FMDD FMMonth')) order by x),'[]') into opts
      from (select distinct x from unnest(days) x where x<>e.day and x>(now() at time zone 'Europe/London')::date order by x limit 8) s;
   end if;
   return info||jsonb_build_object('ok',true,'state','confirmed','already',true,'manage',live,'options',opts);
  end if;
  if not live then return info||'{"ok":false,"state":"locked"}'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text,73));
  if p_action='cancel' then
   update subnex_private.email_offers set state='closed',closed_at=now() where id=e.id;
   perform subnex_private.close_request(a.id,'customer_cancelled',false);
   return info||'{"ok":true,"state":"cancelled"}';
  end if;
  if p_day is null or p_day<=(now() at time zone 'Europe/London')::date or p_day=e.day then return info||'{"ok":false,"state":"day_taken"}'; end if;
  begin days:=subnex_private.auto_plan_days(a.id); exception when others then days:='{}'; end;
  if not (p_day=any(days)) then return info||'{"ok":false,"state":"day_taken"}'; end if;
  w:=subnex_private.day_window(p_day);
  perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text||':'||p_day::text,1));
  begin
   g:=current_setting('subnex.slot_change',true); g2:=current_setting('subnex.overbook',true);
   perform set_config('subnex.slot_change','allowed',true); perform set_config('subnex.overbook','allowed',true);
   update public.addresses set date=p_day,collection_start=(w->>'start')::timestamptz,collection_end=(w->>'end')::timestamptz,
    collection_confirmed_at=now(),collection_version=collection_version+1 where id=a.id;
   perform set_config('subnex.slot_change',coalesce(g,''),true); perform set_config('subnex.overbook',coalesce(g2,''),true);
   update subnex_private.email_offers set day=p_day,confirmed_at=now() where id=e.id returning * into e;
  exception when others then
   return info||'{"ok":false,"state":"day_taken"}';
  end;
  perform subnex_private.email_enqueue(e.id,'confirmed','confirmed:'||e.id||':'||p_day);
  return info||jsonb_build_object('ok',true,'state','confirmed','changed',true,'day',e.day,'day_text',to_char(e.day,'FMDay FMDD FMMonth'),'manage',true,'options','[]'::jsonb);
 end if;
 if e.state='closed' and a.status='cancelled' and a.cancellation_reason='customer_cancelled' then
  return info||'{"ok":true,"state":"cancelled"}';
 end if;$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;
