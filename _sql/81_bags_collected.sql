-- 81: сколько мешков реально забрали с адреса (08.10.2026). Костя: строка ввода у адресов (не у бинов),
--   по желанию — «Выполнено» нажимается и без цифры; показывать в админке и в отчётах партнёрам (K&B).
-- • addresses.bags_collected — целое число ≥ 0 или пусто. Это факт водителя; bags / bags_text — то, что
--   заявил клиент при записи, их не трогаем.
-- Без удаляющих команд. Повторный запуск безопасен.
alter table public.addresses add column if not exists bags_collected integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'addresses_bags_collected_check') then
    alter table public.addresses add constraint addresses_bags_collected_check
      check (bags_collected is null or bags_collected between 0 and 500);
  end if;
end $$;

-- • subnex_reports 'log' отдаёт bags_collected рядом с bags — для таблицы адресов и отчётов партнёрам.
--   Меняется одна строка выборки; прежняя версия сохраняется в dispatch_backups '81:subnex_reports'.
do $$
declare d text := pg_get_functiondef('public.subnex_reports(text,jsonb)'::regprocedure);
begin
  if position('a.bags_collected' in d) = 0 then
    insert into subnex_private.dispatch_backups(name, definition)
      select '81:subnex_reports', d
      where not exists (select 1 from subnex_private.dispatch_backups where name = '81:subnex_reports');
    d := replace(d, 'nullif(a.bags,0)::text) as bags,', 'nullif(a.bags,0)::text) as bags, a.bags_collected,');
    if position('a.bags_collected' in d) = 0 then raise exception 'subnex_reports: bags line not found'; end if;
    execute d;
  end if;
end $$;
