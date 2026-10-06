-- 75: пятница — рабочий день; все CF ездят Пн/Ср/Пт/Сб, Ньюпорт — Пн/Ср/Пт (06.10.2026).
-- Костя: «все пост коды CF ставить и в понедельник и в пятницу… главное, чтобы заявок было побольше на день
-- и меньше недовольных клиентов». NP — тоже в пятницу (маршрут Кардифф+Ньюпорт).
-- NP12-13 (Blackwood/Ebbw Vale) и NP22-24 (Tredegar/Rhymney) раньше были только субботой — им добавлена пятница.
-- Бристоль/BA/SN (ср), Брекон LD (сб), Суонси и Запад Уэльса (последняя суббота) — без изменений.
update public.sms_week_hours set closed=false, opens='08:00', closes='18:00' where weekday=5;
update subnex_private.dispatch_zones set weekdays='{1,3,5,6}' where prefix='CF' and mode='weekly';
update subnex_private.dispatch_zones set weekdays='{1,3,5}' where code='NP';
update subnex_private.dispatch_zones set weekdays='{5,6}' where code in ('NP12-13','NP22-24');
