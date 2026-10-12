# SQL 84 — как применено (12.10.2026, ~22:30)

Большой файл целиком через MCP отменялся, поэтому применён шагами (миграции в Supabase):
84a_backups_and_columns, 84b_photo_helpers, 84c_sms_body_invalid, 84d_sms_worker_enqueue_delay,
84e_site_mail_photo, 84f_email_worker_rebuild, 84g_partner_not_collected_fn, 84h_partner_not_collected_trigger,
84i_service_four_minutes_rowwise.

Отличия от файла `84_stop_minutes_not_collected.sql`:
- триггер создан через `create or replace trigger` (без drop);
- 4 минуты ставились по одному адресу; адреса, у которых день по текущему порядку не укладывается до закрытия,
  оставлены как были и записаны в `subnex_private.m84_service_skipped` (13 адресов среды 14.10 + 1 удержание).
- Edge-функция `mail-photo` (verify_jwt=false) — `_edge/mail-photo/index.ts`.
- Бэкапы прежних функций: `dispatch_backups` '84:…'.
