-- 77: время на адрес в расчёте — 2 минуты (Костя: «до 2 минут»; было 1) (06.10.2026).
update subnex_private.auto_plan_config set service_minutes=2 where singleton;
alter table public.addresses alter column service_minutes set default 2;
update public.addresses set service_minutes=2 where kind='d2d' and status='new' and date is null and service_minutes=1;
