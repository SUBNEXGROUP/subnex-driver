-- 110. Remember WRC cancellations that arrive before the booking itself (20.11.2026).
--
-- Case: Mai Mariam, BS14 0UF, booking #447. 19.11 15:40 "Customer message … I am no longer
-- donating" — we had no such booking, so nothing was done. 20.11 08:10 the portal still
-- sent her booking in a batch → new request → day-offer SMS at 12:00 → she replied
-- "I've already sent an email that I won't be donating anymore".
--
-- Now: a cancellation for an unknown booking is stored in subnex_private.wrc_cancellations
-- (phone / email / postcode, 30 days). subnex_intake skips a row whose phone or email
-- matches a stored cancellation (logged as skipped: "Клиент уже отменил (сообщение WRC)").
-- Backups: dispatch_backups '110:…'.

create table if not exists subnex_private.wrc_cancellations(
  id bigint generated always as identity primary key,
  booking text, phone text, email text, postcode text, message text,
  created_at timestamptz not null default now());
alter table subnex_private.wrc_cancellations enable row level security;

insert into subnex_private.dispatch_backups(name, definition)
select '110:public.subnex_intake(text,jsonb)', pg_get_functiondef('public.subnex_intake(text,jsonb)'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='110:public.subnex_intake(text,jsonb)');
insert into subnex_private.dispatch_backups(name, definition)
select '110:public.subnex_wrc_message(text,jsonb)', pg_get_functiondef('public.subnex_wrc_message(text,jsonb)'::regprocedure)
where not exists (select 1 from subnex_private.dispatch_backups where name='110:public.subnex_wrc_message(text,jsonb)');

do $m$
declare src text;
 a1 text := 'v_problem:=''Такой адрес уже в работе''; end if;';
 a2 text := ' if is_cancel then
  insert into subnex_private.intake_log(token_id,ref,outcome,detail,addr_text)';
begin
 src := pg_get_functiondef('public.subnex_intake(text,jsonb)'::regprocedure);
 if position('wrc_cancellations' in src) = 0 then
  if position(a1 in src) = 0 then raise exception '110: anchor not found in subnex_intake'; end if;
  src := replace(src, a1, a1 || chr(10) ||
   '   if v_problem is null and exists(select 1 from subnex_private.wrc_cancellations wc where wc.created_at>now()-interval ''30 days''' || chr(10) ||
   '        and ((v_phone is not null and v_phone<>'''' and wc.phone=v_phone)' || chr(10) ||
   '          or (nullif(lower(btrim(v_item->>''contact_email'')),'''') is not null and wc.email=lower(btrim(v_item->>''contact_email''))))) then' || chr(10) ||
   '    v_problem:=''Клиент уже отменил (сообщение WRC)'';' || chr(10) ||
   '   end if;');
  execute src;
 end if;

 src := pg_get_functiondef('public.subnex_wrc_message(text,jsonb)'::regprocedure);
 if position('wrc_cancellations' in src) = 0 then
  if position(a2 in src) = 0 then raise exception '110: anchor not found in subnex_wrc_message'; end if;
  src := replace(src, a2, ' if is_cancel then' || chr(10) ||
   '  insert into subnex_private.wrc_cancellations(booking,phone,email,postcode,message)' || chr(10) ||
   '   values(nullif(booking,''''),nullif(v_phone,''''),nullif(v_email,''''),subnex_private.postcode_of(v_addr),msg);' || chr(10) ||
   '  insert into subnex_private.intake_log(token_id,ref,outcome,detail,addr_text)');
  execute src;
 end if;
end $m$;

-- Cancellations already received (19–20 Nov) for bookings we did not have at the time.
insert into subnex_private.wrc_cancellations(booking,phone,email,postcode,message,created_at)
select * from (values
 ('447','+447469610262','maia__mariam@outlook.com','BS140UF','Hello, I am no longer donating the item.','2026-11-19 15:40:00+00'::timestamptz)
) v where not exists (select 1 from subnex_private.wrc_cancellations where booking='447');
