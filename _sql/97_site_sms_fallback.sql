-- 97: website customers who do not answer the email date offer get the same date by SMS (Kostia, 24 Oct 2026).
-- Why: of 30 Google Ads leads (8-23 Oct) 4 were closed as "no reply" to the email offer; 3 of them had a mobile.
-- Rule: email offer still 'sent' 24h after it went out, the offered day is tomorrow or later, the address is a
-- website request with a working UK mobile, the thread is not opted out and no SMS offer was made after the email
-- -> auto_offer(address, same day): "Hi, this is Kostia from SUBNEX. We can collect ... Reply YES".
-- The email link keeps working; whichever comes first wins.

-- 97a: the fallback job
create or replace function subnex_private.site_sms_fallback()
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare c subnex_private.auto_plan_config; r record; res jsonb; n int:=0; skipped jsonb:='[]';
 today date:=(now() at time zone 'Europe/London')::date;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 if not c.enabled or subnex_private.uk_hour() not between c.sms_from_hour and c.sms_to_hour-1 then return '{"due":false}'; end if;
 for r in
  select distinct on (a.id) a.id, a.driver_id, e.id offer_id, e.day
    from subnex_private.email_offers e join public.addresses a on a.id=e.address_id
   where e.state='sent' and e.created_at<=now()-interval '24 hours' and e.day>today
     and a.intake_channel='subnex_website' and a.kind='d2d' and a.status='new' and a.date is null and a.collection_start is null
     and subnex_private.phone(a.phone) ~ '^\+447[0-9]{9}$'
     and not subnex_private.mobile_dead(a.phone)
     and not exists(select 1 from public.sms_threads t where t.phone=subnex_private.phone(a.phone) and t.opted_out)
     and not exists(select 1 from public.sms_offers o where o.address_id=a.id and o.created_at>=e.created_at)
   order by a.id, e.created_at desc
   limit 20
 loop
  perform pg_advisory_xact_lock(hashtextextended(r.driver_id::text,73));
  begin
   res:=subnex_private.auto_offer(r.id,r.day);
  exception when others then res:=jsonb_build_object('ok',false,'reason',sqlerrm);
  end;
  if coalesce((res->>'ok')::boolean,false) then n:=n+1;
  else skipped:=skipped||jsonb_build_object('address_id',r.id,'res',res); end if;
 end loop;
 return jsonb_build_object('due',true,'sms',n,'skipped',skipped);
end $function$;
revoke all on function subnex_private.site_sms_fallback() from public, anon, authenticated;

-- 97b (patches, applied by source replace; backups '97:<function>'):
--  * (no confirm_offer change needed: dispatch_address_after already turns the 'held' hold into 'confirmed'
--    when the address becomes planned.)
--  * email_followups: the "no reply -> close" loop skips addresses with an active SMS offer.
--  * subnex_email_confirm: an email link opened after the date was confirmed by SMS shows "confirmed".

-- 97c: cron every 10 minutes (the function itself checks 08-20 UK)
select cron.schedule('subnex-site-sms-fallback','2,12,22,32,42,52 * * * *','select subnex_private.site_sms_fallback()');

-- APPLIED 24 Oct 2026 ~01:00. Dry runs (rolled back) on a test website address: email offer -> 25h later SMS
-- "Hi, this is Kostia from SUBNEX ... Reply YES" for the same day -> YES -> planned, hold confirmed, email offer
-- expired, email link shows "confirmed"; an old unanswered email offer is not closed while the SMS offer waits.
