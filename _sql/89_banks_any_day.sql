-- 89: банки (контейнеры) можно ставить на любой день, даже выходной по графику (Костя, 12.10.2026).
-- dispatch_evaluate: если день закрыт, но в нём только банки — берём самые широкие часы из рабочих дней.
-- Клиентские адреса на выходной по-прежнему не ставятся. Применено через MCP как 89_banks_any_day.
do $m$
declare src text;
begin
 src:=replace(pg_get_functiondef('subnex_private.dispatch_evaluate(uuid,date,jsonb,text[],integer)'::regprocedure),E'\r','');
 if position('BANKS_ANY_DAY' in src)=0 then
  src:=replace(src, $o$ if h is null or (h->>'closed')::boolean then return jsonb_build_object('ok',false,'code','DAY_CLOSED'); end if;$o$,
$n$ if h is null or (h->>'closed')::boolean then
  -- BANKS_ANY_DAY: банки можно объезжать в любой день, даже выходной; часы — самые широкие из рабочих дней.
  if jsonb_array_length(coalesce(p_nodes,'[]'))>0
     and not exists(select 1 from jsonb_array_elements(p_nodes) x where coalesce(x->>'kind','') not in ('bank')) then
   select jsonb_build_object('opens',min(w.opens)::text,'closes',max(w.closes)::text,'closed',false) into h
     from public.sms_week_hours w where not w.closed;
  end if;
  if h is null or (h->>'closed')::boolean then return jsonb_build_object('ok',false,'code','DAY_CLOSED'); end if;
 end if;$n$);
  execute src;
 end if;
end $m$;
