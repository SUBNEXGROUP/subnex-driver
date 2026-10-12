-- 86: недоступный мобильный = нет мобильного (12.10.2026).
-- Проблема: Willsbridge BS30 6UU — SMS на номер четыре раза вернулась с ошибкой 30005 (номер не существует/недоступен),
-- а «Отправить предложения» каждый раз снова предлагала SMS. У клиентки есть email.
-- Решение: mobile_dead(phone) — последнее сообщение по номеру кончилось 30005/30006 и клиент после этого не писал.
-- Тогда email_route() считает адрес «письмом» (дата, напоминание накануне, «не забрали»).
-- Применено через MCP как 86_dead_mobile_to_email.
insert into subnex_private.dispatch_backups(name,definition)
select '86:'||x.f, pg_get_functiondef(x.f::regprocedure) from (values
 ('subnex_private.email_route(uuid)'),('subnex_private.day_before_reminders()')) x(f)
where not exists(select 1 from subnex_private.dispatch_backups b where b.name='86:'||x.f);

create or replace function subnex_private.mobile_dead(p_phone text)
returns boolean language sql stable security definer set search_path to '' as $$
 select coalesce((
  select m.error_code in ('30005','30006')
    from public.sms_messages m join public.sms_threads t on t.id=m.thread_id
   where t.phone=subnex_private.phone(p_phone)
     and (m.direction='in' or m.status not in ('auto_skipped','pending_auto','preparing'))
   order by m.created_at desc limit 1), false)
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
$$;

do $m$
declare src text;
begin
 src:=replace(pg_get_functiondef('subnex_private.day_before_reminders()'::regprocedure),E'\r','');
 if position('mobile_dead' in src)=0 then
  src:=replace(src, $o$  if coalesce(subnex_private.phone(r.phone),'') ~ '^\+447[0-9]{9}$' then$o$,
$n$  if coalesce(subnex_private.phone(r.phone),'') ~ '^\+447[0-9]{9}$' and not subnex_private.mobile_dead(r.phone) then$n$);
  if position('mobile_dead' in src)=0 then raise exception 'PATCH_DAY_BEFORE'; end if;
  execute src;
 end if;
end $m$;

do $m$
declare src text;
begin
 src:=replace(pg_get_functiondef('subnex_private.partner_status_notify()'::regprocedure),E'\r','');
 if position('mobile_dead' in src)=0 then
  src:=replace(src, $o$ if coalesce(subnex_private.phone(new.phone),'') ~ '^\+447[0-9]{9}$' then$o$,
$n$ if coalesce(subnex_private.phone(new.phone),'') ~ '^\+447[0-9]{9}$' and not subnex_private.mobile_dead(new.phone) then$n$);
  if position('mobile_dead' in src)=0 then raise exception 'PATCH_PARTNER_NOTIFY'; end if;
  execute src;
 end if;
end $m$;
