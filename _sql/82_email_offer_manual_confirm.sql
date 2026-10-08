-- 82: подтвердить письмо-предложение вручную (08.10.2026). Костя: клиент ответил на письмо «да, пятница
--   подходит», а кнопку в письме не нажал — заявка висит «Дата отправлена письмом · ждём подтверждения».
-- • public.subnex_email_offer_confirm(address_id) — только для admin. Берёт живое письмо-предложение адреса
--   и проводит его ровно тем же путём, что кнопка в письме (public.subnex_email_confirm 'confirm'):
--   адрес встаёт в маршрут на предложенный день, удержание подтверждается, клиенту уходит письмо
--   «confirmed» (email_outbox → Apps Script). Своей логики маршрута здесь нет — только поиск токена.
-- • email_offers.confirmed_manually — отметка, что подтвердил человек, а не кнопка клиента.
-- Без удаляющих команд. Повторный запуск безопасен.
alter table subnex_private.email_offers add column if not exists confirmed_manually boolean not null default false;

create or replace function public.subnex_email_offer_confirm(p_address_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare tok text; r jsonb;
begin
  if subnex_private.member_role() is distinct from 'admin' then raise exception 'ACCESS_DENIED' using errcode = '42501'; end if;
  select e.token into tok from subnex_private.email_offers e
   where e.address_id = p_address_id and e.state = 'sent' order by e.created_at desc limit 1;
  if tok is null then raise exception 'EMAIL_OFFER_MISSING'; end if;
  r := public.subnex_email_confirm(tok, 'confirm');
  if coalesce((r->>'ok')::boolean, false) and r->>'state' = 'confirmed' and not (r ? 'already') then
    update subnex_private.email_offers set confirmed_manually = true where token = tok;
  elsif r->>'state' = 'expired' then raise exception 'EMAIL_OFFER_EXPIRED';
  elsif not coalesce((r->>'ok')::boolean, false) then raise exception 'EMAIL_OFFER_FAILED';
  end if;
  return r - 'address';
end $$;
revoke all on function public.subnex_email_offer_confirm(uuid) from public, anon;
grant execute on function public.subnex_email_offer_confirm(uuid) to authenticated;
