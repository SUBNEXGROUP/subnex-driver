-- 66: письмо «заявка принята» уходит из ящика collections@subnex.co.uk (04.10.2026).
-- • Текст письма без абзаца про карманы (просьба Kostia).
-- • subnex_email_worker('claim') делит очередь по отправителю: ящик collections@ забирает только
--   письма с from_email='collections@subnex.co.uk' (p_data.from), остальные отправщики — только
--   письма без from_email. Партнёрские письма по-прежнему уходят с subnex.operations@gmail.com.
-- Повторный запуск безопасен; прежняя версия — в dispatch_backups '66:…'.
do $patch$
declare def text; f text; pairs text[]; i int;
begin
 foreach f in array array['public.subnex_web_booking(jsonb)','public.subnex_email_worker(text,text,jsonb)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  if (f like '%web_booking%' and position('pockets' in def)=0) or (f like '%worker%' and position('p_data->>''from''' in def)>0) then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='66:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('66:'||f,def);
  end if;
  pairs:=case when f like '%web_booking%' then array[
    $q$  ||E'Before you hand over your donation, please check all pockets and bags for valuables or anything you want to keep.\n\n'
$q$, '',
    $q$  ||'<p>Before you hand over your donation, please check all pockets and bags for valuables or anything you want to keep.</p>'
$q$, '']
   else array[
    $q$where state='pending' or (state='sending' and claimed_at<now()-interval '10 minutes' and attempts<3)$q$,
    $q$where (state='pending' or (state='sending' and claimed_at<now()-interval '10 minutes' and attempts<3))
      and coalesce(from_email,'')=coalesce(nullif(lower(btrim(p_data->>'from')),''),'')$q$]
  end;
  for i in 1..array_length(pairs,1) by 2 loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then raise exception 'PATCH_FRAGMENT % #%',f,i; end if;
   def:=replace(def,pairs[i],pairs[i+1]);
  end loop;
  execute def;
 end loop;
end $patch$;
