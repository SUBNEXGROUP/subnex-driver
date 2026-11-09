-- 96. Сервер сам переставляет остановки, прежде чем отказать «день не влезает».
--
-- Что было (09.11.2026): сервер хранит порядок дня «как вставилось». Хороший порядок
-- сохраняют только пульт и телефон — когда кто-то открывает этот день. В среду 11.11
-- лежало ~40 адресов, день никто не открывал, порядок получился «Кардифф → Бристоль →
-- Кардифф → Бристоль», и проверка считала, что маршрут кончится в 04–09 утра следующего дня.
-- Итог: ROUTE_DAY_BOUNDARY на каждое ручное подтверждение, хотя день на деле свободен.
--
-- Что теперь: если новый адрес не встаёт в записанный порядок (или встаёт только с
-- опозданием), dispatch_candidate сначала переставляет остановки по дорогам и проверяет
-- ещё раз. Отказ остаётся только если день не сходится и в хорошем порядке.

-- 1) Улучшение порядка по матрице дорог: разворот отрезка (2-opt) и перенос 1–3 остановок.
--    Окна прибытия здесь не учитываются — результат всё равно проверяет dispatch_evaluate,
--    и новый порядок берётся, только если он проходит и он лучше.
create or replace function subnex_private.dispatch_improve(p_nodes jsonb, p_order text[], cfg jsonb)
 returns text[]
 language plpgsql
 stable
 set search_path to ''
as $function$
declare n int:=coalesce(cardinality(p_order),0); w int; hm int; dp int; m int[]; cnt int;
 o int[]; r int[]; i int; j int; seg int; va int; vb int; vp int; vq int; s1 int; s2 int;
 gain int; fwd int; rev int; moved boolean:=true; rounds int:=0; t0 timestamptz:=clock_timestamp();
begin
 if n<3 or jsonb_array_length(coalesce(p_nodes,'[]'))<>n then return p_order; end if;
 w:=n+2; hm:=n+1; dp:=n+2;
 with pts as (
   select t.ord::int as ord, x.pt
     from unnest(p_order) with ordinality t(nk,ord)
     join lateral (select y as pt from jsonb_array_elements(p_nodes) y where y->>'key'=t.nk limit 1) x on true
   union all select n+1, cfg->'home'
   union all select n+2, cfg->'depot'),
 kp as (select ord, pt, subnex_private.dispatch_point(pt) as pk from pts)
 select array_agg(case when pa.pk=pb.pk then 0
          else coalesce(ceil(rd.seconds/60*(cfg->>'travel_factor')::numeric)::int+(cfg->>'leg_buffer_minutes')::int,
                        subnex_private.dispatch_travel(pa.pt,pb.pt,cfg)) end order by pa.ord,pb.ord), count(*)::int
   into m, cnt
   from kp pa cross join kp pb
   left join subnex_private.dispatch_roads rd on rd.a=pa.pk and rd.b=pb.pk and rd.expires_at>now();
 -- Нет дороги хотя бы для одной пары — улучшать не по чему, порядок не трогаем.
 if cnt is distinct from w*w or array_position(m,null) is not null then return p_order; end if;
 o:=array(select g from generate_series(1,n) g);
 while moved and rounds<80 and clock_timestamp()-t0<interval '600 milliseconds' loop
  moved:=false; rounds:=rounds+1;
  -- разворот отрезка i..j (дороги несимметричны, поэтому считаем обе суммы)
  for i in 1..n-1 loop
   va:=case when i=1 then hm else o[i-1] end; fwd:=0; rev:=0;
   for j in i+1..n loop
    fwd:=fwd+m[(o[j-1]-1)*w+o[j]]; rev:=rev+m[(o[j]-1)*w+o[j-1]];
    vb:=case when j=n then dp else o[j+1] end;
    if m[(va-1)*w+o[j]]+rev+m[(o[i]-1)*w+vb] < m[(va-1)*w+o[i]]+fwd+m[(o[j]-1)*w+vb] then
     o:=o[1:i-1]||array(select o[g] from generate_series(j,i,-1) g)||o[j+1:n];
     moved:=true; exit;
    end if;
   end loop;
  end loop;
  -- перенос отрезка из 1–3 остановок в другое место
  for seg in 1..3 loop
   i:=1;
   while i<=n-seg+1 loop
    va:=case when i=1 then hm else o[i-1] end;
    vb:=case when i+seg-1=n then dp else o[i+seg] end;
    s1:=o[i]; s2:=o[i+seg-1];
    gain:=m[(va-1)*w+s1]+m[(s2-1)*w+vb]-m[(va-1)*w+vb];
    if gain>0 then
     r:=o[1:i-1]||o[i+seg:n];
     for j in 0..n-seg loop
      continue when j=i-1;
      vp:=case when j=0 then hm else r[j] end;
      vq:=case when j=n-seg then dp else r[j+1] end;
      if m[(vp-1)*w+s1]+m[(s2-1)*w+vq]-m[(vp-1)*w+vq] < gain then
       o:=r[1:j]||o[i:i+seg-1]||r[j+1:n-seg];
       moved:=true; exit;
      end if;
     end loop;
    end if;
    i:=i+1;
   end loop;
  end loop;
 end loop;
 return array(select p_order[o[g]] from generate_series(1,n) g order by g);
end $function$;

revoke all on function subnex_private.dispatch_improve(jsonb,text[],jsonb) from public, anon, authenticated;

-- 2) dispatch_candidate: вставляем пересчёт в двух местах. Функция длинная и часто
--    правится, поэтому меняем её текст точечно и проверяем, что обе вставки встали.
do $patch$
declare d text:=pg_get_functiondef('subnex_private.dispatch_candidate(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 nl text:=case when position(E'\r\n' in d)>0 then E'\r\n' else E'\n' end; d0 text;
begin
 if position('REORDER_BEFORE_REFUSING' in d)>0 then raise notice 'already patched'; return; end if;
 d0:=d;
 d:=replace(d,'best2 jsonb; fit2 jsonb; j int;','best2 jsonb; fit2 jsonb; j int; ids3 text[]; fit3 jsonb;');
 if d=d0 then raise exception 'PATCH_DECLARE_NOT_FOUND'; end if;

 -- (а) весь день: не встало или встало с опозданием — пробуем в переставленном порядке
 d0:=d;
 d:=regexp_replace(d,' if best is null then',
  ' -- REORDER_BEFORE_REFUSING: порядок хранится «как вставилось»; прежде чем отказать, переставляем.'||nl||
  ' if (best is null and coalesce(fit->>''code'','''') in (''TIME_CONFLICT'',''DAY_BOUNDARY'')) or coalesce((best->>''late'')::int,0)>0 then'||nl||
  '  ids3:=subnex_private.dispatch_improve(nodes||jsonb_build_array(node),ids||array[node->>''key''],cfg);'||nl||
  '  fit3:=subnex_private.dispatch_evaluate(p_driver,d,nodes||jsonb_build_array(node),ids3);'||nl||
  '  if coalesce((fit3->>''ok'')::boolean,false) and (best is null'||nl||
  '   or coalesce((fit3->>''late'')::int,0)<coalesce((best->>''late'')::int,0)'||nl||
  '   or (coalesce((fit3->>''late'')::int,0)=coalesce((best->>''late'')::int,0) and (fit3->>''drive'')::int<(best->>''drive'')::int)) then best:=fit3; end if;'||nl||
  ' end if;'||nl||
  ' if best is null then');
 if d=d0 then raise exception 'PATCH_MAIN_NOT_FOUND'; end if;

 -- (б) клиент уже согласился (overbook): день считаем по подтверждённым — тоже с перестановкой
 d0:=d;
 d:=replace(d,'     -- Порядок пишем по всему дню',
  '     if best2 is null or coalesce((best2->>''late'')::int,0)>0 then'||nl||
  '      ids3:=subnex_private.dispatch_improve(committed||jsonb_build_array(node),ids2||array[node->>''key''],cfg);'||nl||
  '      fit3:=subnex_private.dispatch_evaluate(p_driver,d,committed||jsonb_build_array(node),ids3);'||nl||
  '      if coalesce((fit3->>''ok'')::boolean,false) and (best2 is null'||nl||
  '       or coalesce((fit3->>''late'')::int,0)<coalesce((best2->>''late'')::int,0)'||nl||
  '       or (coalesce((fit3->>''late'')::int,0)=coalesce((best2->>''late'')::int,0) and (fit3->>''drive'')::int<(best2->>''drive'')::int)) then best2:=fit3; end if;'||nl||
  '     end if;'||nl||
  '     -- Порядок пишем по всему дню');
 if d=d0 then raise exception 'PATCH_OVERBOOK_NOT_FOUND'; end if;
 execute d;
end $patch$;
