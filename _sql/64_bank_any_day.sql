-- 64: банки можно назначать на любой день (03.10.2026).
-- Если визит в банк ставится на выходной по графику, этот день автоматически открывается 08:00–18:00
-- (запись в sms_day_hours на эту дату). Клиентские адреса в такой день планировщик не поставит:
-- у всех районов свои дни недели (63_weekly_zones), выходных среди них нет.
-- Триггер назван так, чтобы сработать раньше subnex_dispatch_address_before (порядок по имени).
create or replace function subnex_private.bank_open_day()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
 if new.kind='bank' and new.date is not null and new.status in ('new','planned')
    and (tg_op='INSERT' or new.date is distinct from old.date or new.status is distinct from old.status)
    and subnex_private.day_window(new.date) is null then
  insert into public.sms_day_hours(day,opens,closes,closed) values(new.date,'08:00','18:00',false)
  on conflict(day) do update set closed=false;
 end if;
 return new;
end $$;
revoke all on function subnex_private.bank_open_day() from public;
drop trigger if exists subnex_bank_open_day on public.addresses;
create trigger subnex_bank_open_day before insert or update on public.addresses
 for each row execute function subnex_private.bank_open_day();
