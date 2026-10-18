-- 95: repeat website form for an address that already has an active request.
-- Before: the duplicate path always sent "received" ("We will email you a collection date shortly"),
-- even when the date was already confirmed (Barry, CF62 8DU, 18 Oct 2026).
-- Now (Kostia, 18 Oct): answer by the request's state
--   * planned with a date (today or later)  -> the "confirmed" email again, with that date and the manage link
--   * email offer sent, not yet confirmed  -> the date offer email again
--   * nothing yet                           -> "received", as before

create or replace function subnex_private.web_duplicate_notice(p_address uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
 a public.addresses; e subnex_private.email_offers;
 k text:=to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS');
 today date:=(now() at time zone 'Europe/London')::date;
 lnk text;
begin
 select * into a from public.addresses where id=p_address;
 if a.id is null or a.status not in ('new','planned') then return false; end if;

 if a.status='planned' and a.date>=today then
  select c.email_confirm_url||'?t='||o.token into lnk
    from subnex_private.email_offers o, subnex_private.auto_plan_config c
   where c.singleton and o.address_id=p_address and o.state='confirmed'
   order by o.confirmed_at desc nulls last limit 1;
  return subnex_private.site_email_enqueue(p_address,'confirmed','confirmed-again:'||k,
   jsonb_strip_nulls(jsonb_build_object('day',a.date,'link',lnk))) is not null;
 end if;

 select * into e from subnex_private.email_offers
  where address_id=p_address and state='sent' and day>=today
  order by created_at desc limit 1;
 if e.id is not null then
  return subnex_private.email_enqueue(e.id,'day_offer','day_offer-again:'||k) is not null;
 end if;

 return false;
end $function$;

revoke all on function subnex_private.web_duplicate_notice(uuid) from public, anon, authenticated;

-- In public.subnex_web_booking, before the "received" fallback:
--   if v_existing is not null then v_offered:=subnex_private.web_duplicate_notice(v_id); end if;
-- (applied by patching the function source; marker DUPLICATE_NOTICE_V1)

-- APPLIED 18 Oct 2026: function created; subnex_web_booking patched (backup 95:subnex_web_booking). Dry runs OK for both branches.
