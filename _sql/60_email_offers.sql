-- 60_email_offers.sql — предложение даты письмом тем, у кого нет британского мобильного.
--
-- Поток: автоподбор даёт заявке день (удержание dispatch_holds, как у WhatsApp) и кладёт письмо
-- в subnex_private.email_outbox. Скрипт почты в Apps Script (subnex.operations@gmail.com) забирает
-- письма через public.subnex_email_worker и отправляет их. В письме кнопка → страница confirm.html
-- на GitHub Pages → public.subnex_email_confirm → адрес встаёт в маршрут (как «Согласовать»).
-- Нет ответа — напоминания (reminder_hours/reminder_max), затем закрытие через close_hours,
-- как у SMS. Удержания, поставленные вручную, тоже получают письмо (это то же, что «Отправить»).
--
-- Всё выключено, пока auto_plan_config.email_enabled=false.
-- Повторный запуск безопасен: таблицы if not exists, функции create or replace, правки чужих
-- функций накладываются один раз, прежняя версия сохраняется в dispatch_backups под именем '60:…'.

alter table subnex_private.auto_plan_config
  add column if not exists email_enabled boolean not null default false,
  add column if not exists email_confirm_url text not null default 'https://subnexgroup.github.io/subnex-driver/confirm.html';

create table if not exists subnex_private.email_offers (
  id uuid primary key default gen_random_uuid(),
  address_id uuid not null references public.addresses(id) on delete cascade,
  hold_id uuid references subnex_private.dispatch_holds(id),
  driver_id uuid not null references public.drivers(id),
  day date not null,
  email text not null,
  token text not null unique default (replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')),
  auto boolean not null default true,
  state text not null default 'sent' check (state in ('sent','confirmed','expired','closed','superseded')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  closed_at timestamptz
);
create unique index if not exists email_offers_one_live on subnex_private.email_offers(address_id) where state='sent';
create index if not exists email_offers_address on subnex_private.email_offers(address_id, created_at desc);
alter table subnex_private.email_offers enable row level security;

create table if not exists subnex_private.email_outbox (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid references subnex_private.email_offers(id) on delete cascade,
  address_id uuid not null references public.addresses(id) on delete cascade,
  kind text not null check (kind in ('day_offer','reminder','confirmed','closed')),
  event_key text not null,
  to_email text not null,
  from_name text not null,
  subject text not null,
  body_text text not null,
  body_html text not null,
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','skipped')),
  attempts int not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (address_id, event_key)
);
create index if not exists email_outbox_pending on subnex_private.email_outbox(created_at) where state in ('pending','sending');
alter table subnex_private.email_outbox enable row level security;

-- Кому можно писать: сайт/почта партнёра, нет британского мобильного, есть нормальный email, письма включены.
create or replace function subnex_private.email_route(p_address uuid) returns text
language sql stable security definer set search_path to '' as $$
 select lower(btrim(a.contact_email))
   from public.addresses a, subnex_private.auto_plan_config c
  where a.id=p_address and c.singleton and c.email_enabled
    and a.kind='d2d' and a.intake_channel in ('subnex_website','partner_email')
    and coalesce(subnex_private.phone(a.phone),'') !~ '^\+447[0-9]{9}$'
    and btrim(coalesce(a.contact_email,'')) ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
$$;

create or replace function subnex_private.html_esc(t text) returns text
language sql immutable set search_path to '' as $$
 select replace(replace(replace(replace(coalesce(t,''),'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;')
$$;

-- Тексты писем (английский, британские даты). Бренд как в SMS: партнёрские — We Recycle Clothes.
create or replace function subnex_private.email_content(p_kind text, p_offer uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare e subnex_private.email_offers; a public.addresses; c subnex_private.auto_plan_config; w jsonb;
 brand text; driver text; hi text; day_txt text; win text; link text; lead text; tail text; subj text; btn text; t text; h text;
begin
 select * into e from subnex_private.email_offers where id=p_offer;
 select * into a from public.addresses where id=e.address_id;
 select * into c from subnex_private.auto_plan_config where singleton;
 brand:=case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end;
 driver:=nullif(btrim((select name from public.drivers where id=e.driver_id)),'');
 hi:='Hi '||coalesce(nullif(split_part(btrim(coalesce(a.contact_name,'')),' ',1),''),'there')||',';
 day_txt:=to_char(e.day,'FMDay FMDD FMMonth');
 w:=subnex_private.day_window(e.day);
 win:=case when w is null then '' else ', between '||subnex_private.sms_clock(subnex_private.dispatch_clock(w->>'opens'))
      ||' and '||subnex_private.sms_clock(subnex_private.dispatch_clock(w->>'closes')) end;
 link:=c.email_confirm_url||'?t='||e.token;
 if p_kind='day_offer' then
  subj:='Please confirm your clothing collection on '||day_txt;
  lead:='This is '||coalesce(driver||' from ','')||brand||'. We can collect your clothing donation from '||a.text||' on '||day_txt||win||'.';
  tail:='If that day does not suit you, just reply to this email and tell us which day works better.';
  btn:='Confirm collection';
 elsif p_kind='reminder' then
  subj:='Reminder: please confirm your collection on '||day_txt;
  lead:='We have not heard back from you yet. We can collect your clothing donation from '||a.text||' on '||day_txt||win||'.';
  tail:='If that day does not suit you, just reply to this email and tell us which day works better.';
  btn:='Confirm collection';
 elsif p_kind='confirmed' then
  subj:='Collection confirmed: '||day_txt;
  lead:='Thank you for confirming. We will collect your clothing donation from '||a.text||' on '||day_txt||win||'.';
  tail:='Please have your bags ready from the start of the day and leave them where we can see them from the street. If we should knock instead, just reply to this email.';
 else
  subj:='Your collection request has been closed';
  lead:='We did not hear back from you about the collection from '||a.text||', so we have closed this request.';
  tail:='If you would still like us to collect your donation, just reply to this email and we will arrange a new date.';
 end if;
 t:=hi||E'\n\n'||lead||E'\n\n'
   ||case when btn is not null then 'Please confirm this date here:'||E'\n'||link||E'\n\n' else '' end
   ||tail||E'\n\nThank you,\n'||coalesce(driver||E'\n','')||brand;
 h:='<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a18;max-width:560px">'
   ||'<p>'||subnex_private.html_esc(hi)||'</p><p>'||subnex_private.html_esc(lead)||'</p>'
   ||case when btn is not null then
      '<p style="margin:26px 0"><a href="'||subnex_private.html_esc(link)||'" style="background:#1f9d55;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:8px;display:inline-block">'
      ||btn||'</a></p><p style="font-size:13px;color:#6b6b66">If the button does not work, open this link: <a href="'||subnex_private.html_esc(link)||'">'||subnex_private.html_esc(link)||'</a></p>'
     else '' end
   ||'<p>'||subnex_private.html_esc(tail)||'</p><p>Thank you,<br>'||coalesce(subnex_private.html_esc(driver)||'<br>','')||subnex_private.html_esc(brand)||'</p></div>';
 return jsonb_build_object('subject',subj,'text',t,'html',h,'from_name',brand);
end $$;

create or replace function subnex_private.email_enqueue(p_offer uuid, p_kind text, p_key text) returns uuid
language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; m jsonb; qid uuid;
begin
 select * into e from subnex_private.email_offers where id=p_offer;
 if e.id is null then return null; end if;
 m:=subnex_private.email_content(p_kind,e.id);
 insert into subnex_private.email_outbox(offer_id,address_id,kind,event_key,to_email,from_name,subject,body_text,body_html)
 values(e.id,e.address_id,p_kind,p_key,e.email,m->>'from_name',m->>'subject',m->>'text',m->>'html')
 on conflict(address_id,event_key) do nothing returning id into qid;
 return qid;
end $$;

-- Предложить день письмом: удержание (своё или уже стоящее) + письмо в очередь.
create or replace function subnex_private.email_offer(p_address uuid, p_day date, p_auto boolean default true) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a public.addresses; em text; h subnex_private.dispatch_holds; r jsonb; e subnex_private.email_offers;
begin
 select * into a from public.addresses where id=p_address for update;
 if a.id is null or a.status<>'new' or a.date is not null or a.collection_start is not null then return '{"ok":false,"reason":"STATE"}'; end if;
 em:=subnex_private.email_route(a.id);
 if em is null then return '{"ok":false,"reason":"NO_EMAIL"}'; end if;
 if exists(select 1 from subnex_private.email_offers x where x.address_id=a.id and x.state='sent') then return '{"ok":false,"reason":"ALREADY"}'; end if;
 select * into h from subnex_private.dispatch_holds where address_id=a.id and state='held' for update;
 if h.id is null then
  r:=subnex_private.auto_hold(a.id,p_day);
  if not coalesce((r->>'ok')::boolean,false) then return r; end if;
  select * into h from subnex_private.dispatch_holds where address_id=a.id and state='held';
 end if;
 if h.starts_at<=now() then return '{"ok":false,"reason":"PAST"}'; end if;
 insert into subnex_private.email_offers(address_id,hold_id,driver_id,day,email,auto)
 values(a.id,h.id,a.driver_id,(h.starts_at at time zone 'Europe/London')::date,em,p_auto) returning * into e;
 perform subnex_private.email_enqueue(e.id,'day_offer','day_offer:'||e.id);
 return jsonb_build_object('ok',true,'offer_id',e.id,'day',e.day,'channel','email');
end $$;

-- Каждый проход автоподбора: протухшие предложения, письма по ручным удержаниям, напоминания, закрытие.
create or replace function subnex_private.email_followups() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c subnex_private.auto_plan_config; r record; res jsonb; today date:=(now() at time zone 'Europe/London')::date;
 n_exp int:=0; n_held int:=0; n_rem int:=0; n_closed int:=0; rem int; last_at timestamptz;
begin
 select * into c from subnex_private.auto_plan_config where singleton;
 if not c.email_enabled then return '{"enabled":false}'; end if;
 -- 1. Удержание снято (день наступил, «Снять», закрытие) или адрес ушёл из очереди — предложение протухло.
 with x as (
  update subnex_private.email_offers e set state='expired'
   where e.state='sent' and (
     not exists(select 1 from subnex_private.dispatch_holds h where h.id=e.hold_id and h.state='held')
     or exists(select 1 from public.addresses a where a.id=e.address_id and (a.status<>'new' or a.collection_start is not null)))
  returning 1) select count(*) into n_exp from x;
 if subnex_private.uk_hour() not between c.sms_from_hour and c.sms_to_hour-1 then
  return jsonb_build_object('enabled',true,'expired',n_exp,'sent',0,'reminded',0,'closed',0);
 end if;
 -- 2. Удержание, поставленное вручную, без письма — отправляем (для SMS это кнопка «Отправить»).
 for r in select h.id as hold_id,h.address_id,(h.starts_at at time zone 'Europe/London')::date as day
   from subnex_private.dispatch_holds h join public.addresses a on a.id=h.address_id
  where h.state='held' and (h.starts_at at time zone 'Europe/London')::date>today
    and a.status='new' and a.collection_start is null
    and subnex_private.email_route(a.id) is not null
    and not exists(select 1 from subnex_private.email_offers e where e.address_id=a.id and (e.state='sent' or e.hold_id=h.id))
    and not exists(select 1 from public.sms_offers o where o.address_id=a.id and o.state in ('preparing','awaiting','manual'))
  order by h.created_at limit 30
 loop
  perform pg_advisory_xact_lock(hashtextextended((select driver_id::text from public.addresses where id=r.address_id),73));
  res:=subnex_private.email_offer(r.address_id,r.day,false);
  if coalesce((res->>'ok')::boolean,false) then n_held:=n_held+1; end if;
 end loop;
 -- 3. Напоминания: как у SMS — через reminder_hours, не больше reminder_max, пока день впереди.
 for r in select e.* from subnex_private.email_offers e where e.state='sent' and e.day>today loop
  select count(*),max(created_at) into rem,last_at from subnex_private.email_outbox o where o.offer_id=r.id and o.kind='reminder';
  if rem<c.reminder_max and coalesce(last_at,r.created_at)<=now()-make_interval(hours=>c.reminder_hours) then
   perform subnex_private.email_enqueue(r.id,'reminder','reminder:'||r.id||':'||(rem+1));
   n_rem:=n_rem+1;
  end if;
 end loop;
 -- 4. Закрытие: первое письмо старше close_hours, подтверждения нет, напоминания исчерпаны или день прошёл.
 for r in select distinct on (e.address_id) e.* from subnex_private.email_offers e join public.addresses a on a.id=e.address_id
   where a.status='new' and a.collection_start is null and a.date is null
   order by e.address_id, e.created_at desc
 loop
  if r.state not in ('sent','expired') then continue; end if;
  if (select min(x.created_at) from subnex_private.email_offers x where x.address_id=r.address_id)>now()-make_interval(hours=>c.close_hours) then continue; end if;
  if r.state='sent' then
   select count(*),max(created_at) into rem,last_at from subnex_private.email_outbox o where o.offer_id=r.id and o.kind='reminder';
   if rem<c.reminder_max or last_at>now()-make_interval(hours=>c.reminder_hours) then continue; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended((select driver_id::text from public.addresses where id=r.address_id),73));
  update subnex_private.email_offers set state='closed',closed_at=now() where address_id=r.address_id and state in ('sent','expired');
  perform subnex_private.close_request(r.address_id,'no_reply',false);
  perform subnex_private.email_enqueue(r.id,'closed','closed:'||r.id);
  n_closed:=n_closed+1;
 end loop;
 return jsonb_build_object('enabled',true,'expired',n_exp,'sent',n_held,'reminded',n_rem,'closed',n_closed);
end $$;

-- Страница подтверждения (anon): 'peek' — что предлагали, 'confirm' — подтвердить. Токен — 64 hex.
create or replace function public.subnex_email_confirm(p_token text, p_action text default 'peek') returns jsonb
language plpgsql security definer set search_path to '' as $$
declare e subnex_private.email_offers; a public.addresses; h subnex_private.dispatch_holds; w jsonb; info jsonb; live boolean; g text; g2 text;
begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then perform pg_sleep(0.3); return '{"ok":false,"state":"invalid"}'; end if;
 if p_action='confirm' then
  select * into e from subnex_private.email_offers where token=p_token for update;
 else
  select * into e from subnex_private.email_offers where token=p_token;
 end if;
 if e.id is null then perform pg_sleep(0.3); return '{"ok":false,"state":"invalid"}'; end if;
 select * into a from public.addresses where id=e.address_id;
 w:=subnex_private.day_window(e.day);
 info:=jsonb_build_object('day',e.day,'day_text',to_char(e.day,'FMDay FMDD FMMonth'),
  'window',case when w is null then null else subnex_private.sms_clock(subnex_private.dispatch_clock(w->>'opens'))||' – '||subnex_private.sms_clock(subnex_private.dispatch_clock(w->>'closes')) end,
  'address',a.text,'brand',case when a.collection_source in ('partner','missing') then 'We Recycle Clothes' else 'SUBNEX' end);
 if e.state='confirmed' then return info||'{"ok":true,"state":"confirmed","already":true}'; end if;
 if e.state<>'sent' then return info||jsonb_build_object('ok',false,'state',e.state); end if;
 select * into h from subnex_private.dispatch_holds where id=e.hold_id;
 live:=h.id is not null and h.state='held' and h.starts_at>now() and a.status='new' and a.collection_start is null and a.date is null
   and not exists(select 1 from subnex_private.dispatch_days dd where dd.driver_id=a.driver_id and dd.day=e.day and dd.started_at is not null);
 if p_action<>'confirm' then return info||jsonb_build_object('ok',live,'state',case when live then 'sent' else 'expired' end); end if;
 if not live then return info||'{"ok":false,"state":"expired"}'; end if;
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text,73));
 perform pg_advisory_xact_lock(hashtextextended(a.driver_id::text||':'||e.day::text,1));
 select * into a from public.addresses where id=e.address_id for update;
 select * into h from subnex_private.dispatch_holds where id=e.hold_id for update;
 if h.state<>'held' or a.status<>'new' or a.collection_start is not null then return info||'{"ok":false,"state":"expired"}'; end if;
 begin
  g:=current_setting('subnex.slot_change',true); g2:=current_setting('subnex.overbook',true);
  perform set_config('subnex.slot_change','allowed',true); perform set_config('subnex.overbook','allowed',true);
  update public.addresses set date=e.day,collection_start=h.starts_at,collection_end=h.ends_at,collection_confirmed_at=now(),
   arrival_mode='day',collection_version=collection_version+1,status='planned' where id=a.id;
  perform set_config('subnex.slot_change',coalesce(g,''),true); perform set_config('subnex.overbook',coalesce(g2,''),true);
  update subnex_private.dispatch_holds set state='confirmed' where id=h.id;
  update subnex_private.email_offers set state='confirmed',confirmed_at=now() where id=e.id;
 exception when others then
  return info||jsonb_build_object('ok',false,'state','error');
 end;
 perform subnex_private.email_enqueue(e.id,'confirmed','confirmed:'||e.id);
 return info||'{"ok":true,"state":"confirmed"}';
end $$;
revoke all on function public.subnex_email_confirm(text,text) from public;
grant execute on function public.subnex_email_confirm(text,text) to anon, authenticated;

-- Отправщик писем (Apps Script): тот же секрет, что у приёма заявок.
create or replace function public.subnex_email_worker(p_secret text, p_action text, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare tok subnex_private.intake_tokens; q subnex_private.email_outbox; jobs jsonb:='[]'; lim int; st text;
begin
 if p_secret is null or length(p_secret)<32 then perform pg_sleep(0.5); raise exception 'EMAIL_DENIED' using errcode='42501'; end if;
 select * into tok from subnex_private.intake_tokens where secret=p_secret and active;
 if tok.id is null then perform pg_sleep(0.5); raise exception 'EMAIL_DENIED' using errcode='42501'; end if;
 if p_action='ping' then
  return jsonb_build_object('ok',true,'enabled',(select email_enabled from subnex_private.auto_plan_config where singleton),
   'pending',(select count(*) from subnex_private.email_outbox where state='pending'));
 elsif p_action='claim' then
  if not (select email_enabled from subnex_private.auto_plan_config where singleton) then return '{"jobs":[]}'; end if;
  lim:=least(greatest(coalesce((p_data->>'limit')::int,10),1),20);
  for q in select * from subnex_private.email_outbox
    where state='pending' or (state='sending' and claimed_at<now()-interval '10 minutes' and attempts<3)
    order by created_at limit lim for update skip locked
  loop
   if q.kind in ('day_offer','reminder') and (select e.state from subnex_private.email_offers e where e.id=q.offer_id) is distinct from 'sent' then
    update subnex_private.email_outbox set state='skipped',error='OFFER_CLOSED' where id=q.id; continue;
   end if;
   update subnex_private.email_outbox set state='sending',claimed_at=now(),attempts=attempts+1 where id=q.id;
   jobs:=jobs||jsonb_build_array(jsonb_build_object('id',q.id,'to',q.to_email,'from_name',q.from_name,'subject',q.subject,'text',q.body_text,'html',q.body_html));
  end loop;
  return jsonb_build_object('jobs',jobs);
 elsif p_action='done' then
  st:=case when coalesce((p_data->>'ok')::boolean,false) then 'sent' else 'failed' end;
  update subnex_private.email_outbox set state=st,sent_at=case when st='sent' then now() end,error=left(nullif(p_data->>'error',''),300)
   where id=(p_data->>'id')::uuid and state='sending';
  return jsonb_build_object('ok',found);
 end if;
 raise exception 'EMAIL_ACTION';
end $$;
revoke all on function public.subnex_email_worker(text,text,jsonb) from public;
grant execute on function public.subnex_email_worker(text,text,jsonb) to anon, authenticated;

revoke all on function subnex_private.email_route(uuid) from public;
revoke all on function subnex_private.email_content(text,uuid) from public;
revoke all on function subnex_private.email_enqueue(uuid,text,text) from public;
revoke all on function subnex_private.email_offer(uuid,date,boolean) from public;
revoke all on function subnex_private.email_followups() from public;

-- Правки существующих функций: один раз, с бэкапом прежней версии.
do $patch$
declare def text; nd text; f text; pairs text[]; i int;
begin
 foreach f in array array['subnex_private.auto_plan()','subnex_private.auto_layout(boolean)','subnex_private.auto_plan_skip(uuid)','public.subnex_dispatch(text,jsonb)'] loop
  def:=pg_get_functiondef(f::regprocedure);
  if position('email_route' in def)>0 or position('email_offers' in def)>0 then continue; end if;
  if not exists(select 1 from subnex_private.dispatch_backups where name='60:'||f) then
   insert into subnex_private.dispatch_backups(name,definition) values('60:'||f,def);
  end if;
  pairs:=case f
   when 'subnex_private.auto_plan()' then array[
    $q$and num!~'^\+447[0-9]{9}$' then skipped:=skipped+1; continue; end if;$q$,
    $q$and coalesce(num,'')!~'^\+447[0-9]{9}$' and subnex_private.email_route(a.id) is null then skipped:=skipped+1; continue; end if;$q$,
    $q$select count(*) into attempts from public.sms_offers o where o.address_id=a.id and o.actor_id is null;$q$,
    $q$select count(*)+(select count(*) from subnex_private.email_offers eo where eo.address_id=a.id) into attempts from public.sms_offers o where o.address_id=a.id and o.actor_id is null;$q$,
    $q$then res:=subnex_private.auto_hold(a.id,d); else res:=subnex_private.auto_offer(a.id,d); end if;$q$,
    $q$then res:=subnex_private.auto_hold(a.id,d); elsif subnex_private.email_route(a.id) is not null then res:=subnex_private.email_offer(a.id,d,true); else res:=subnex_private.auto_offer(a.id,d); end if;$q$,
    $q$fu:=subnex_private.auto_followups();$q$,
    $q$fu:=subnex_private.auto_followups(); fu:=fu||jsonb_build_object('email',subnex_private.email_followups());$q$,
    $q$fu->>'closed',geo->>'geocoded')$q$,
    $q$fu->>'closed',geo->>'geocoded')||case when fu->'email'->>'enabled'='true' then ' · email '||(fu->'email')::text else '' end$q$]
   when 'subnex_private.auto_layout(boolean)' then array[
    $q$and not (x.intake_channel in ('subnex_website','partner_email') and subnex_private.phone(x.phone) !~ '^\+447[0-9]{9}$')$q$,
    $q$and not (x.intake_channel in ('subnex_website','partner_email') and coalesce(subnex_private.phone(x.phone),'') !~ '^\+447[0-9]{9}$' and subnex_private.email_route(x.id) is null)$q$]
   when 'subnex_private.auto_plan_skip(uuid)' then array[
    $q$and num!~'^\+447[0-9]{9}$' then return 'NO_MOBILE'; end if;$q$,
    $q$and coalesce(num,'')!~'^\+447[0-9]{9}$' and subnex_private.email_route(a.id) is null then return 'NO_MOBILE'; end if;$q$,
    $q$if (select count(*) from public.sms_offers o where o.address_id=a.id and o.actor_id is null)>=1 then return 'ATTEMPT_USED'; end if;$q$,
    $q$if (select count(*) from public.sms_offers o where o.address_id=a.id and o.actor_id is null)+(select count(*) from subnex_private.email_offers eo where eo.address_id=a.id)>=1 then return 'ATTEMPT_USED'; end if;$q$]
   else array[
    $q$subnex_private.auto_plan_skip(qa.id) as auto_skip$q$,
    $q$subnex_private.auto_plan_skip(qa.id) as auto_skip,(select to_jsonb(eo)-'token' from subnex_private.email_offers eo where eo.address_id=qa.id order by eo.created_at desc limit 1) as email_offer,subnex_private.email_route(qa.id) as email_route$q$,
    $q$update subnex_private.dispatch_holds set state='released' where id=h.id;return '{"ok":true}';$q$,
    $q$update subnex_private.email_offers set state='superseded' where address_id=aid and state='sent';update subnex_private.dispatch_holds set state='released' where id=h.id;return '{"ok":true}';$q$]
  end;
  i:=1;
  while i<array_length(pairs,1) loop
   if (length(def)-length(replace(def,pairs[i],'')))/length(pairs[i])<>1 then
    raise exception 'PATCH_60 % #%: фрагмент не найден или встречается не один раз',f,(i+1)/2;
   end if;
   def:=replace(def,pairs[i],pairs[i+1]);
   i:=i+2;
  end loop;
  execute def;
 end loop;
end $patch$;
