-- 93 (14.10.2026): если у адреса время совпадает с целым рабочим днём, он «в течение дня» (arrival_mode='day').
-- Иначе утром клиент получал «окно» 08:00–19:00. Перед этим вручную переведены 4 Heol Isaf (16.10),
-- 13 Jasmin Grove и 47 Southville Road (21.10), а также CF48 1PE и NP8 1DH (17.10, Missing — сняли точное время).
create or replace function subnex_private.day_window_mode()
returns trigger language plpgsql set search_path to '' as $$
begin
 if new.kind='d2d' and new.collection_start is not null and new.arrival_mode is distinct from 'day'
    and subnex_private.is_day_window(new.collection_start,new.collection_end) then
  new.arrival_mode:='day';
 end if;
 return new;
end $$;
create or replace trigger subnex_day_window_mode before insert or update of collection_start, collection_end, arrival_mode on public.addresses
 for each row execute function subnex_private.day_window_mode();
