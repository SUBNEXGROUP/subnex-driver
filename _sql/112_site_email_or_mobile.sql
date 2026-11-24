-- 112: website booking — email OR mobile; mailbox check on the form; bounced emails (decisions 24.11.2026).
--   * The site form needs one contact: email or a UK mobile. Without email every message goes by SMS,
--     the date offer as an SMS with the same confirm link the email has (event site_day_offer).
--   * Email and mobile both given: email as before; if the email bounces, the customer moves to SMS.
--   * Email bounced and no working mobile: a request that is still waiting for a date closes
--     ('email_invalid', no message — nobody can be reached). A booked collection is left alone.
--   * The form asks our mail server (Hostinger, _ops/email-check) whether the mailbox exists;
--     "does not exist" (or an earlier bounce) blocks the booking here too.
-- Re-runnable: create or replace / if not exists only.

/* ───────────── 1. Bounces and mailbox checks ───────────── */

create table if not exists subnex_private.email_bounces(
  email text primary key,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  hits int not null default 1,
  detail text
);
alter table subnex_private.email_bounces enable row level security;

create table if not exists subnex_private.email_checks(
  id bigserial primary key,
  email text not null,
  result text not null check (result in ('valid','invalid','unknown')),
  reason text,
  ip text,
  checked_at timestamptz not null default now()
);
create index if not exists email_checks_email_idx on subnex_private.email_checks(email, checked_at desc);
create index if not exists email_checks_ip_idx on subnex_private.email_checks(ip, checked_at desc);
alter table subnex_private.email_checks enable row level security;

create or replace function subnex_private.email_bounced(p_email text)
returns boolean language sql stable security definer set search_path to '' as $$
 select exists(select 1 from subnex_private.email_bounces b where b.email=lower(btrim(coalesce(p_email,''))))
$$;

/* ───────────── 2. Routes: email, or SMS for site customers without a working email ───────────── */

create or replace function subnex_private.site_email(p_address uuid)
returns text language sql stable security definer set search_path to '' as $$
 select lower(btrim(a.contact_email))
   from public.addresses a, subnex_private.auto_plan_config c
  where a.id=p_address and c.singleton and c.email_enabled
    and a.kind='d2d' and a.intake_channel='subnex_website'
    and btrim(coalesce(a.contact_email,'')) ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
    and not subnex_private.email_bounced(a.contact_email)
$$;

create or replace function subnex_private.email_route(p_address uuid)
returns text language sql stable security definer set search_path to '' as $$
 select lower(btrim(a.contact_email))
   from public.addresses a, subnex_private.auto_plan_config c
  where a.id=p_address and c.singleton and c.email_enabled
    and a.kind='d2d' and a.intake_channel in ('subnex_website','partner_email')
    and (a.intake_channel='subnex_website' or coalesce(subnex_private.phone(a.phone),'') !~ '^\+447[0-9]{9}$'
         or subnex_private.mobile_dead(a.phone))
    and btrim(coalesce(a.contact_email,'')) ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
    and not subnex_private.email_bounced(a.contact_email)
$$;

-- Site customer who left no email (or whose email bounced) but has a working UK mobile: the SMS number.
create or replace function subnex_private.site_sms_route(p_address uuid)
returns text language sql stable security definer set search_path to '' as $$
 select subnex_private.phone(a.phone)
   from public.addresses a
  where a.id=p_address and a.kind='d2d' and a.intake_channel='subnex_website'
    and (btrim(coalesce(a.contact_email,'')) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
         or subnex_private.email_bounced(a.contact_email))
    and coalesce(subnex_private.phone(a.phone),'') ~ '^\+447[0-9]{9}$'
    and not subnex_private.mobile_dead(a.phone)
    and not exists(select 1 from public.sms_threads t where t.phone=subnex_private.phone(a.phone) and t.opted_out)
$$;

/* ───────────── 3. Date offer by SMS with the confirm link ───────────── */

create or replace function subnex_private.site_sms_offer(p_offer uuid, p_key text, p_reminder boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; a public.addresses; t public.sms_threads; c subnex_private.auto_plan_config;
 q subnex_private.auto_sms_queue; num text; body text; first text; link text; daytext text;
begin
 select * into e from subnex_private.email_offers where id=p_offer;
 if e.id is null then return '{"ok":false,"reason":"NOT_FOUND"}'; end if;
 select * into a from public.addresses where id=e.address_id;
 if e.state<>'sent' or a.status<>'new' or a.collection_start is not null then return '{"ok":false,"reason":"STATE"}'; end if;
 num:=subnex_private.site_sms_route(a.id);
 if num is null then return '{"ok":false,"reason":"NO_MOBILE"}'; end if;
 -- One SMS per date offer: a bounce after the SMS already went out must not send it again.
 if not p_reminder and exists(select 1 from subnex_private.auto_sms_queue x where x.address_id=a.id and x.event='site_day_offer'
     and x.snapshot->>'email_offer_id'=e.id::text and not coalesce((x.snapshot->>'reminder')::boolean,false)) then
  return '{"ok":true,"already":true}';
 end if;
 select * into c from subnex_private.auto_plan_config where singleton;
 insert into public.sms_threads(phone,address_id,driver_id,manual_mode) values(num,a.id,a.driver_id,true) on conflict(phone) do nothing;
 select * into t from public.sms_threads where phone=num for update;
 if t.opted_out then return '{"ok":false,"reason":"OPTED_OUT"}'; end if;
 if t.address_id is not null and t.address_id<>a.id
    and exists(select 1 from public.addresses x where x.id=t.address_id and x.status in ('new','planned')) then
  return '{"ok":false,"reason":"PHONE_BUSY"}';
 end if;
 if t.address_id is distinct from a.id or t.driver_id is distinct from a.driver_id then
  update public.sms_threads set address_id=a.id,driver_id=a.driver_id,active_offer_id=null where id=t.id returning * into t;
 end if;
 link:=c.email_confirm_url||'?t='||e.token;
 daytext:=to_char(e.day,'FMDay FMDD FMMonth');
 first:=nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),'');
 body:=case when p_reminder
   then 'Reminder from SUBNEX: we can collect your clothing donation on '||daytext||'. Please confirm, or choose another day, here: '||link
   else 'Hi'||coalesce(' '||first,'')||', this is SUBNEX. We can collect your clothing donation on '||daytext||'. Please confirm, or choose another day, here: '||link
  end||E'\n\nKind regards,\nSUBNEX';
 insert into subnex_private.auto_sms_queue(address_id,thread_id,event,event_key,phone,snapshot,expires_at)
  values(a.id,t.id,'site_day_offer',p_key,num,
   jsonb_build_object('source',a.collection_source,'driver_id',a.driver_id,'text',a.text,
     'email_offer_id',e.id,'day',e.day,'reminder',p_reminder),
   least((e.day+time '07:00') at time zone 'Europe/London',now()+interval '24 hours'))
  on conflict(address_id,event_key) do nothing returning * into q;
 if q.id is null then return '{"ok":true,"repeated":true}'; end if;
 insert into public.sms_messages(id,thread_id,direction,body,status,request_id,request_payload)
  values(q.id,t.id,'out',body,'pending_auto',q.id,
   jsonb_build_object('auto_event','site_day_offer','address_id',a.id,'email_offer_id',e.id));
 perform subnex_private.wake_auto_sms();
 return jsonb_build_object('ok',true,'id',q.id,'channel','sms');
end $$;

-- The SMS worker re-checks every queued message just before sending.
create or replace function subnex_private.auto_sms_invalid(q subnex_private.auto_sms_queue)
returns text language plpgsql stable security definer set search_path to '' as $$
declare a public.addresses; t public.sms_threads; o public.sms_offers;
begin
 select * into a from public.addresses where id=q.address_id;
 select * into t from public.sms_threads where id=q.thread_id;
 if q.expires_at<=now() then return 'EXPIRED'; end if;
 if t.opted_out then return 'OPTED_OUT'; end if;
 if a.id is null or t.id is null or t.phone is distinct from q.phone
  or subnex_private.phone(a.phone) is distinct from q.phone
  or a.driver_id is distinct from (q.snapshot->>'driver_id')::uuid
  or t.driver_id is distinct from a.driver_id
  or a.collection_source is distinct from q.snapshot->>'source'
  or a.text is distinct from q.snapshot->>'text' then return 'CONTACT_CHANGED'; end if;
 if q.event='cancelled' then
  if a.status<>'cancelled' or t.address_id is not null or t.closed_request->>'id' is distinct from q.snapshot->>'closure_id'
  then return 'NEW_REQUEST'; end if;
 elsif t.address_id is distinct from a.id then return 'NEW_REQUEST';
 elsif q.event='confirmed' then
  if a.status<>'planned' or a.collection_cancelled_at is not null
   or a.collection_start is distinct from (q.snapshot->>'start')::timestamptz
   or a.collection_end is distinct from (q.snapshot->>'end')::timestamptz then return 'APPOINTMENT_CHANGED'; end if;
 elsif q.event='collected' and a.status<>'done' then return 'RESULT_CHANGED';
 elsif q.event='not_collected' and (a.status<>'noanswer' or a.date is distinct from (q.snapshot->>'day')::date
   ) then return 'RESULT_CHANGED';
 elsif q.event in ('day_offer','reminder') then
  select * into o from public.sms_offers where id=(q.snapshot->>'offer_id')::uuid;
  if o.id is null or t.active_offer_id is distinct from o.id or o.state not in ('preparing','awaiting')
   or a.status<>'new' or a.collection_start is not null then return 'APPOINTMENT_CHANGED'; end if;
 elsif q.event='site_day_offer' then
  -- 112: the site date offer by SMS — only while that offer is still open.
  if not exists(select 1 from subnex_private.email_offers e where e.id=(q.snapshot->>'email_offer_id')::uuid and e.state='sent')
   or a.status<>'new' or a.collection_start is not null then return 'APPOINTMENT_CHANGED'; end if;
 elsif q.event='day_before' then
  if a.status<>'planned' or a.date is distinct from (q.snapshot->>'day')::date or a.collection_start is null then return 'APPOINTMENT_CHANGED'; end if;
 elsif q.event='eta' then
  if a.status<>'planned' or a.date is distinct from (q.snapshot->>'day')::date or a.collection_start is null
   or not exists(select 1 from subnex_private.dispatch_days x where x.driver_id=a.driver_id and x.day=a.date and x.started_at is not null)
  then return 'APPOINTMENT_CHANGED'; end if;
 end if;
 return null;
end $$;

-- Site emails for an offer; with no working email the same step goes by SMS (offer, reminder, confirmation).
create or replace function subnex_private.email_enqueue(p_offer uuid, p_kind text, p_key text)
returns uuid language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; m jsonb; qid uuid; site boolean;
begin
 select * into e from subnex_private.email_offers where id=p_offer;
 if e.id is null then return null; end if;
 site:=exists(select 1 from public.addresses a where a.id=e.address_id and a.intake_channel='subnex_website');
 if site then
  qid:=subnex_private.site_email_enqueue(e.address_id,p_kind,p_key,jsonb_build_object('day',e.day,
   'link',(select c.email_confirm_url||'?t='||e.token from subnex_private.auto_plan_config c where c.singleton)));
  if qid is null and subnex_private.site_sms_route(e.address_id) is not null then
   begin
    if p_kind in ('day_offer','reminder') then
     perform subnex_private.site_sms_offer(e.id,'site_'||p_key,p_kind='reminder');
    elsif p_kind='confirmed' then
     perform subnex_private.enqueue_auto_sms(e.address_id,'confirmed',p_key);
    end if;
   exception when others then raise warning 'email_enqueue sms: %', sqlerrm;
   end;
  end if;
  return qid;
 end if;
 m:=subnex_private.email_content(p_kind,e.id);
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,from_email,subject,body_text,body_html)
 values(e.id,e.address_id,p_kind,p_key,e.email,m->>'from_name',null,m->>'subject',m->>'text',m->>'html')
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;

-- Date offer for site/partner-email customers: email, or (site, no working email) SMS with the link.
create or replace function subnex_private.email_offer(p_address uuid, p_day date, p_auto boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare a public.addresses; em text; h subnex_private.dispatch_holds; r jsonb; e subnex_private.email_offers;
begin
 select * into a from public.addresses where id=p_address for update;
 if a.id is null or a.status<>'new' or a.date is not null or a.collection_start is not null then return '{"ok":false,"reason":"STATE"}'; end if;
 em:=subnex_private.email_route(a.id);
 if em is null and subnex_private.site_sms_route(a.id) is null then return '{"ok":false,"reason":"NO_EMAIL"}'; end if;
 if exists(select 1 from subnex_private.email_offers x where x.address_id=a.id and x.state='sent') then return '{"ok":false,"reason":"ALREADY"}'; end if;
 select * into h from subnex_private.dispatch_holds where address_id=a.id and state='held' for update;
 if h.id is null then
  r:=subnex_private.auto_hold(a.id,p_day);
  if not coalesce((r->>'ok')::boolean,false) then return r; end if;
  select * into h from subnex_private.dispatch_holds where address_id=a.id and state='held';
 end if;
 if h.starts_at<=now() then return '{"ok":false,"reason":"PAST"}'; end if;
 insert into subnex_private.email_offers(address_id,hold_id,driver_id,day,email,auto)
 values(a.id,h.id,a.driver_id,(h.starts_at at time zone 'Europe/London')::date,coalesce(em,''),p_auto) returning * into e;
 perform subnex_private.email_enqueue(e.id,'day_offer','day_offer:'||e.id);
 return jsonb_build_object('ok',true,'offer_id',e.id,'day',e.day,'channel',case when em is null then 'sms' else 'email' end);
end $$;

-- Reminders sent for an offer: emails plus SMS reminders (112).
create or replace function subnex_private.offer_reminders(p_offer uuid, out n int, out last_at timestamptz)
language sql stable security definer set search_path to '' as $$
 select count(*)::int, max(x.at) from (
  select o.created_at as at from subnex_private.email_outbox o where o.offer_id=p_offer and o.kind='reminder'
  union all
  select q.created_at from subnex_private.auto_sms_queue q
   where q.event='site_day_offer' and q.snapshot->>'email_offer_id'=p_offer::text and coalesce((q.snapshot->>'reminder')::boolean,false)
 ) x
$$;

create or replace function subnex_private.email_followups()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare c subnex_private.auto_plan_config; r record; res jsonb; today date:=(now() at time zone 'Europe/London')::date;
 n_exp int:=0; n_held int:=0; n_rem int:=0; n_closed int:=0; rem int; last_at timestamptz; by_sms boolean;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 if not c.email_enabled then return '{"enabled":false}'; end if;
 with x as (
  update subnex_private.email_offers e set state='expired'
   where e.state='sent' and (
     not exists(select 1 from subnex_private.dispatch_holds h where h.id=e.hold_id and h.state='held')
     or exists(select 1 from public.addresses a where a.id=e.address_id and (a.status<>'new' or a.collection_start is not null)))
  returning 1) select count(*) into n_exp from x;
 if subnex_private.uk_hour() not between c.sms_from_hour and c.sms_to_hour-1 then
  return jsonb_build_object('enabled',true,'expired',n_exp,'sent',0,'reminded',0,'closed',0);
 end if;
 for r in select h.id as hold_id,h.address_id,(h.starts_at at time zone 'Europe/London')::date as day
   from subnex_private.dispatch_holds h join public.addresses a on a.id=h.address_id
  where h.state='held' and (h.starts_at at time zone 'Europe/London')::date>today
    and a.status='new' and a.collection_start is null
    and (subnex_private.email_route(a.id) is not null or subnex_private.site_sms_route(a.id) is not null)
    and not exists(select 1 from subnex_private.email_offers e where e.address_id=a.id and (e.state='sent' or e.hold_id=h.id))
    and not exists(select 1 from public.sms_offers o where o.address_id=a.id and o.state in ('preparing','awaiting','manual'))
  order by h.created_at limit 30
 loop
  perform pg_advisory_xact_lock(hashtextextended((select driver_id::text from public.addresses where id=r.address_id),73));
  res:=subnex_private.email_offer(r.address_id,r.day,false);
  if coalesce((res->>'ok')::boolean,false) then n_held:=n_held+1; end if;
 end loop;
 for r in select e.* from subnex_private.email_offers e where e.state='sent' and e.day>today loop
  select x.n,x.last_at into rem,last_at from subnex_private.offer_reminders(r.id) x;
  if rem<c.reminder_max and coalesce(last_at,r.created_at)<=now()-make_interval(hours=>c.reminder_hours) then
   perform subnex_private.email_enqueue(r.id,'reminder','reminder:'||r.id||':'||(rem+1));
   n_rem:=n_rem+1;
  end if;
 end loop;
 for r in select distinct on (e.address_id) e.* from subnex_private.email_offers e join public.addresses a on a.id=e.address_id
   where a.status='new' and a.collection_start is null and a.date is null
   order by e.address_id, e.created_at desc
 loop
  if r.state not in ('sent','expired') then continue; end if;
  -- SITE_SMS_FALLBACK_V1: the same date was offered by SMS — wait for that answer.
  if exists(select 1 from public.sms_offers o where o.address_id=r.address_id and o.state in ('preparing','awaiting','manual')) then continue; end if;
  if (select min(x.created_at) from subnex_private.email_offers x where x.address_id=r.address_id)>now()-make_interval(hours=>c.close_hours) then continue; end if;
  if r.state='sent' then
   select x.n,x.last_at into rem,last_at from subnex_private.offer_reminders(r.id) x;
   if rem<c.reminder_max or last_at>now()-make_interval(hours=>c.reminder_hours) then continue; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended((select driver_id::text from public.addresses where id=r.address_id),73));
  -- 112: offered by SMS — the "we did not hear back" note goes by SMS too.
  by_sms:=subnex_private.site_sms_route(r.address_id) is not null;
  update subnex_private.email_offers set state='closed',closed_at=now() where address_id=r.address_id and state in ('sent','expired');
  perform subnex_private.close_request(r.address_id,'no_reply',by_sms);
  perform subnex_private.email_enqueue(r.id,'closed','closed:'||r.id);
  n_closed:=n_closed+1;
 end loop;
 return jsonb_build_object('enabled',true,'expired',n_exp,'sent',n_held,'reminded',n_rem,'closed',n_closed);
end $$;

-- Unanswered email offer → the same date by SMS ("reply YES") after 24 h. Not for SMS-link offers.
create or replace function subnex_private.site_sms_fallback()
returns jsonb language plpgsql security definer set search_path to '' as $$
declare c subnex_private.auto_plan_config; r record; res jsonb; n int:=0; skipped jsonb:='[]';
 today date:=(now() at time zone 'Europe/London')::date;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 if not c.enabled or subnex_private.uk_hour() not between c.sms_from_hour and c.sms_to_hour-1 then return '{"due":false}'; end if;
 for r in
  select distinct on (a.id) a.id, a.driver_id, e.id offer_id, e.day
    from subnex_private.email_offers e join public.addresses a on a.id=e.address_id
   where e.state='sent' and e.created_at<=now()-interval '24 hours' and e.day>today
     and e.email<>''
     and a.intake_channel='subnex_website' and a.kind='d2d' and a.status='new' and a.date is null and a.collection_start is null
     and subnex_private.phone(a.phone) ~ '^\+447[0-9]{9}$'
     and not subnex_private.mobile_dead(a.phone)
     and not exists(select 1 from public.sms_threads t where t.phone=subnex_private.phone(a.phone) and t.opted_out)
     and not exists(select 1 from public.sms_offers o where o.address_id=a.id and o.created_at>=e.created_at)
     and not exists(select 1 from subnex_private.auto_sms_queue x where x.address_id=a.id and x.event='site_day_offer')
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
end $$;

-- Driver result for site customers: email as before; without a working email "no answer" goes by SMS.
create or replace function subnex_private.site_status_mail()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
 if new.intake_channel is distinct from 'subnex_website' or new.kind is distinct from 'd2d' then return new; end if;
 if new.status in ('noanswer','problem') and old.status is distinct from new.status then
  perform subnex_private.site_email_enqueue(new.id,'not_collected','not_collected:'||coalesce(new.date,current_date),
   jsonb_build_object('reason',new.status,'note',new.result_note,'day',new.date));
  if new.status='noanswer' and subnex_private.site_sms_route(new.id) is not null then
   begin
    perform subnex_private.enqueue_auto_sms(new.id,'not_collected','not_collected:'||coalesce(new.date,current_date),null,null,
     jsonb_build_object('reason',new.status,'day',coalesce(new.date,current_date)));
   exception when others then raise warning 'site_status_mail sms: %', sqlerrm;
   end;
  end if;
 elsif new.status='cancelled' and old.status is distinct from 'cancelled' and coalesce(new.cancellation_reason,'')<>'no_reply' then
  perform subnex_private.site_email_enqueue(new.id,'cancelled','cancelled',
   jsonb_build_object('reason',new.cancellation_reason,'day',new.cancelled_date));
 end if;
 return new;
end $$;

-- Planner: site customers without a working email get the date offer by SMS with the link (not "reply YES").
do $$
declare src text; old_s text:='elsif subnex_private.email_route(a.id) is not null then res:=subnex_private.email_offer(a.id,d,true);';
 new_s text:='elsif subnex_private.email_route(a.id) is not null or subnex_private.site_sms_route(a.id) is not null then res:=subnex_private.email_offer(a.id,d,true);';
begin
 src:=pg_get_functiondef('subnex_private.auto_plan'::regproc);
 if position(new_s in src)>0 then return; end if;
 if position(old_s in src)=0 then raise exception '112: auto_plan changed, patch point not found'; end if;
 execute replace(src,old_s,new_s);
end $$;

/* ───────────── 4. Bounces from the collections@ mailbox (Сайт_письма.gs) ───────────── */

create or replace function subnex_private.site_after_bounce(p_address uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare a public.addresses; e subnex_private.email_offers; r jsonb;
begin
 select * into a from public.addresses where id=p_address;
 if a.id is null or a.status not in ('new','planned') then return '{"action":"none"}'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text,73));
 if subnex_private.site_sms_route(a.id) is null then
  if a.status<>'new' then return '{"action":"none","reason":"BOOKED_NO_MOBILE"}'; end if;
  -- No working mobile either: nobody can reach the customer, so the waiting request closes.
  update subnex_private.email_offers set state='closed',closed_at=now() where address_id=a.id and state='sent';
  r:=subnex_private.close_request(a.id,'email_invalid',false);
  return jsonb_build_object('action','closed','close',r);
 end if;
 if a.status='new' then
  select * into e from subnex_private.email_offers where address_id=a.id and state='sent' order by created_at desc limit 1;
  if e.id is null then return '{"action":"sms_later"}'; end if;  -- the next offer goes by SMS by itself
  return jsonb_build_object('action','sms_offer','sms',subnex_private.site_sms_offer(e.id,'site_day_offer:bounce:'||e.id,false));
 end if;
 if a.collection_start is not null then
  -- Booked already: the confirmation went to the dead address — repeat it by SMS.
  return jsonb_build_object('action','sms_confirmed',
   'sms',subnex_private.enqueue_auto_sms(a.id,'confirmed','confirmed:bounce:'||a.collection_version));
 end if;
 return '{"action":"none"}';
end $$;

create or replace function public.subnex_email_bounce(p_secret text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare tok subnex_private.intake_tokens; em text; x record; done jsonb:='[]'; r jsonb;
 v_detail text:=nullif(left(btrim(coalesce(p_data->>'detail','')),300),'');
begin
 if p_secret is null or length(p_secret)<32 then perform pg_sleep(0.5); raise exception 'EMAIL_DENIED' using errcode='42501'; end if;
 select * into tok from subnex_private.intake_tokens where secret=p_secret and active;
 if tok.id is null then perform pg_sleep(0.5); raise exception 'EMAIL_DENIED' using errcode='42501'; end if;
 for em in
  select distinct lower(btrim(v)) from jsonb_array_elements_text(
   case when jsonb_typeof(p_data->'emails')='array' then p_data->'emails' else '[]'::jsonb end) v limit 5
 loop
  if em !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then continue; end if;
  -- Only an address we really emailed from collections@ lately: a forged "bounce" changes nothing.
  if not exists(select 1 from subnex_private.email_outbox o where lower(btrim(o.to_email))=em and o.state='sent'
      and o.sent_at>now()-interval '4 days' and o.from_email='collections@subnex.co.uk') then
   done:=done||jsonb_build_object('skipped','NOT_OURS'); continue;
  end if;
  insert into subnex_private.email_bounces(email,detail) values(em,v_detail)
   on conflict(email) do update set last_at=now(),hits=subnex_private.email_bounces.hits+1,
     detail=coalesce(excluded.detail,subnex_private.email_bounces.detail);
  for x in select a.id from public.addresses a where lower(btrim(a.contact_email))=em
      and a.intake_channel='subnex_website' and a.kind='d2d' and a.status in ('new','planned') loop
   r:=subnex_private.site_after_bounce(x.id);
   done:=done||(jsonb_build_object('address_id',x.id)||r);
  end loop;
 end loop;
 return jsonb_build_object('ok',true,'done',done);
end $$;

/* ───────────── 5. Mailbox check log for the edge function subnex-email-check ───────────── */

create or replace function public.subnex_email_check_db(p_action text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_em text:=lower(left(btrim(coalesce(p_data->>'email','')),200)); v_ip text:=left(btrim(coalesce(p_data->>'ip','')),64);
begin
 if p_action='gate' then
  if subnex_private.email_bounced(v_em) then return '{"allow":false,"known":"invalid","reason":"bounced"}'; end if;
  if v_ip<>'' and (select count(*) from subnex_private.email_checks k where k.ip=v_ip and k.checked_at>now()-interval '1 hour')>=30 then
   return '{"allow":false,"reason":"limit"}';
  end if;
  if (select count(*) from subnex_private.email_checks k where k.checked_at>now()-interval '1 hour')>=500 then
   return '{"allow":false,"reason":"limit"}';
  end if;
  return '{"allow":true}';
 elsif p_action='log' then
  if coalesce(p_data->>'result','') not in ('valid','invalid','unknown') then return '{"ok":false}'; end if;
  insert into subnex_private.email_checks(email,result,reason,ip) values(v_em,p_data->>'result',left(p_data->>'reason',80),nullif(v_ip,''));
  delete from subnex_private.email_checks where checked_at<now()-interval '30 days';
  return '{"ok":true}';
 end if;
 raise exception 'ACTION';
end $$;
revoke all on function public.subnex_email_check_db(text,jsonb) from public, anon, authenticated;
grant execute on function public.subnex_email_check_db(text,jsonb) to service_role;

/* ───────────── 6. Site booking: email or UK mobile ───────────── */

create or replace function public.subnex_web_booking(p_data jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
 v_name text:=left(btrim(coalesce(p_data->>'name','')),100);
 v_email text:=lower(left(btrim(coalesce(p_data->>'email','')),200));
 v_phone_raw text:=left(btrim(coalesce(p_data->>'phone','')),40);
 v_phone text;
 v_pc text:=upper(regexp_replace(left(btrim(coalesce(p_data->>'postcode','')),12),'\s+',' ','g'));
 v_addr text:=left(btrim(regexp_replace(coalesce(p_data->>'address',''),'\s+',' ','g')),300);
 v_bags text:=coalesce(p_data->>'bags','');
 v_note text:=left(btrim(coalesce(p_data->>'notes','')),1000);
 v_text text; v_driver uuid; v_id uuid; v_existing uuid; v_bags_text text;
 v_lat float8; v_lng float8; v_booked boolean:=false;
 v_pick date:=case when coalesce(p_data->>'day','') ~ '^\d{4}-\d{2}-\d{2}$' then (p_data->>'day')::date end; v_ad jsonb; v_days date[]; v_res jsonb; v_offered boolean:=false; z subnex_private.dispatch_zones;
 v_ip text:=left(btrim(split_part(coalesce(current_setting('request.headers',true)::json->>'cf-connecting-ip',
   current_setting('request.headers',true)::json->>'x-forwarded-for',''),',',1)),64);
begin
 if coalesce(p_data->>'website','')<>'' or coalesce((p_data->>'elapsed_ms')::numeric,99999)<3000 then
  insert into subnex_private.web_bookings(ip,email,phone,postcode,outcome,detail) values(v_ip,v_email,v_phone_raw,v_pc,'bot',null);
  return jsonb_build_object('ok',true);
 end if;
 if length(v_name)<2 then raise exception 'NAME_REQUIRED'; end if;
 -- 112: email or mobile, at least one. Without email the dates go by SMS, so it must be a UK mobile.
 if v_email='' and v_phone_raw='' then raise exception 'CONTACT_REQUIRED'; end if;
 if v_email<>'' and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then raise exception 'EMAIL_INVALID'; end if;
 if v_phone_raw<>'' and length(regexp_replace(v_phone_raw,'\D','','g'))<10 then raise exception 'PHONE_INVALID'; end if;
 if v_email='' and coalesce(subnex_private.phone(v_phone_raw),'') !~ '^\+447[0-9]{9}$' then raise exception 'MOBILE_REQUIRED'; end if;
 -- 112: the form's mailbox check said "does not exist", or an earlier email to it bounced.
 if v_email<>'' and (subnex_private.email_bounced(v_email) or exists(select 1 from subnex_private.email_checks k
     where k.email=v_email and k.result='invalid' and k.checked_at>now()-interval '1 day')) then
  raise exception 'EMAIL_NOT_FOUND';
 end if;
 if v_pc !~ '^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$' then raise exception 'POSTCODE_INVALID'; end if;
 if length(v_addr)<5 then raise exception 'ADDRESS_REQUIRED'; end if;
 v_bags_text:=case v_bags when '1-5' then '1 to 5 bags' when '5-10' then '5 to 10 bags' when '10+' then '10+ bags' else null end;
 if v_bags_text is null then raise exception 'BAGS_REQUIRED'; end if;
 if v_pc !~ ' ' then v_pc:=left(v_pc,length(v_pc)-3)||' '||right(v_pc,3); end if;

 if (select count(*) from subnex_private.web_bookings w where w.created_at>now()-interval '1 day'
      and ((v_email<>'' and w.email=v_email) or (v_phone_raw<>'' and w.phone=v_phone_raw)) and w.outcome in ('created','duplicate'))>=3
   or (select count(*) from subnex_private.web_bookings w where w.created_at>now()-interval '1 day')>=300
   or (v_ip<>'' and (select count(*) from subnex_private.web_bookings w where w.ip=v_ip and w.created_at>now()-interval '1 hour')>=5)
   or (v_ip<>'' and (select count(*) from subnex_private.web_bookings w where w.ip=v_ip and w.created_at>now()-interval '1 day')>=15) then
  insert into subnex_private.web_bookings(ip,email,phone,postcode,outcome,detail) values(v_ip,v_email,v_phone_raw,v_pc,'limited',null);
  raise exception 'TOO_MANY_REQUESTS';
 end if;

 select nullif(jsonb_object_agg(k,left(btrim(p_data->'ad'->>k),300)) filter (where coalesce(btrim(p_data->'ad'->>k),'')<>''),'{}'::jsonb)
   into v_ad
   from unnest(array['gclid','gbraid','wbraid','utm_source','utm_medium','utm_campaign','utm_term','utm_content','page','referrer','oppref']) k
  where jsonb_typeof(p_data->'ad')='object';
 v_phone:=subnex_private.phone(v_phone_raw);
 begin
  v_lat:=nullif(p_data->>'lat','')::float8; v_lng:=nullif(p_data->>'lng','')::float8;
  if not (v_lat between 49.8 and 60.9 and v_lng between -8.7 and 1.8) then v_lat:=null; v_lng:=null; end if;
 exception when others then v_lat:=null; v_lng:=null; end;
 v_text:=case when upper(replace(v_addr,' ','')) like '%'||replace(v_pc,' ','')||'%' then v_addr else v_addr||', '||v_pc end;

 select t.driver_id into v_driver from subnex_private.intake_tokens t
  join public.drivers d on d.id=t.driver_id and d.active
  where t.active and t.channel='subnex_website' order by t.id limit 1;
 if v_driver is null and (select count(*) from public.drivers where active)=1 then
  select id into v_driver from public.drivers where active;
 end if;

 if subnex_private.oai_is_test(v_email) then /* OAI_TEST_V1: technical test — no address, no emails, no planner */
  return subnex_private.oai_test_booking(p_data,v_ip,v_email,v_phone_raw,v_pc,v_ad,v_text);
 end if;
 select a.id into v_existing from public.addresses a
  where a.status in ('new','planned') and subnex_private.planner_key(a.text)=subnex_private.planner_key(v_text) limit 1;

 if v_existing is null then
  insert into public.addresses(text,phone,note,bags,bags_text,contact_name,contact_email,lat,lng,geocode_source,
   driver_id,status,kind,collection_source,intake_channel,intake_source,intake_ref,estimated_kg,service_minutes,arrival_mode)
  values(v_text,v_phone,v_note,0,v_bags_text,v_name,v_email,v_lat,v_lng,case when v_lat is not null then 'postcode' end,
   v_driver,'new','d2d','subnex','subnex_website','website','web-'||to_char(now(),'YYYYMMDDHH24MISS')||'-'||left(md5(v_email||v_phone_raw),6),
   10,coalesce((select c.service_minutes from subnex_private.auto_plan_config c where c.singleton),1),'window')
  returning id into v_id;
  insert into subnex_private.web_bookings(ip,email,phone,postcode,address_id,outcome,ad) values(v_ip,v_email,v_phone_raw,v_pc,v_id,'created',v_ad);
 else
  v_id:=v_existing;
  insert into subnex_private.web_bookings(ip,email,phone,postcode,address_id,outcome,ad) values(v_ip,v_email,v_phone_raw,v_pc,v_id,'duplicate',v_ad);
 end if;

 if v_existing is null then
  z:=subnex_private.dispatch_zone_for(v_text);
  if z.code is null or z.mode='off' then
   perform subnex_private.close_request(v_id,'area_not_served_yet',false);
   return jsonb_build_object('ok',true,'served',false);
  end if;
 end if;
 if v_existing is null and v_lat is not null then
  begin
   if subnex_private.auto_plan_skip(v_id) is null then
    v_days:=subnex_private.auto_plan_days(v_id);
    if coalesce(array_length(v_days,1),0)>0 then
     perform pg_advisory_xact_lock(hashtextextended(v_driver::text,73));
     -- SITE_DATE_PICK_V1: the customer chose a day on the site — book it straight away if it is still on offer.
     if v_pick is not null and v_pick=any(v_days) then
      begin
       v_res:=subnex_private.site_book_day(v_id,v_pick);
       v_booked:=coalesce((v_res->>'ok')::boolean,false);
      exception when others then v_booked:=false;
      end;
     end if;
     if v_booked then v_offered:=true;
     else
      v_res:=subnex_private.email_offer(v_id,v_days[1],true);
      v_offered:=coalesce((v_res->>'ok')::boolean,false);
     end if;
    end if;
   end if;
  exception when others then v_offered:=false;
  end;
 end if;
 if v_existing is not null then /* DUPLICATE_NOTICE_V1 */
  begin v_offered:=subnex_private.web_duplicate_notice(v_id); exception when others then v_offered:=false; end;
 end if;
 if not v_offered then
  perform subnex_private.site_email_enqueue(v_id,'received','received:'||left(md5(v_email),12),'{}'::jsonb);
 end if;

 return /* OAI_LEAD_V1 */ subnex_private.oai_lead(v_id,p_data,false,v_existing is null)||subnex_private.web_dup_today(v_id,v_existing is not null)||jsonb_build_object('ok',true,'booked',v_booked,'day',case when v_booked then v_pick end,
  'day_label',case when v_booked then to_char(v_pick,'FMDay FMDD FMMonth') end,'picked',v_pick is not null,
  'channel',case when v_email='' then 'sms' else 'email' end);
end $function$;
