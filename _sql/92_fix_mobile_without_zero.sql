-- 92: в новых заявках UK-мобильный без ведущего нуля («7482374431») дополняется до «07482374431» (14.10.2026).
-- Костя: только для новых заявок; уже подтвердившие по почте остаются на почте. Применено через MCP.
create or replace function subnex_private.fix_mobile_without_zero()
returns trigger language plpgsql set search_path to '' as $$
begin
 if new.phone is not null and regexp_replace(new.phone,'[\s()-]','','g') ~ '^7[0-9]{9}$' then
  new.phone:='0'||regexp_replace(new.phone,'[\s()-]','','g');
 end if;
 return new;
end $$;
create or replace trigger subnex_fix_mobile_without_zero before insert on public.addresses
 for each row execute function subnex_private.fix_mobile_without_zero();
