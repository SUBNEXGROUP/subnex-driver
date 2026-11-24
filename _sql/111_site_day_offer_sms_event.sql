-- 111 (applied 24.11.2026): site customers can get the date offer by SMS with the confirm link.
-- First used for Cheryl (email bounced, mobile in the request). The full flow for
-- phone-only site customers and bounced emails comes in the next migration.
alter table subnex_private.auto_sms_queue
  drop constraint auto_sms_queue_event_check,
  add constraint auto_sms_queue_event_check check (event = any (array[
    'confirmed','collected','cancelled','day_offer','reminder','eta','day_before','not_collected','site_day_offer']));
