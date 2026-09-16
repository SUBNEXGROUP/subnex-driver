/* SUBNEX dispatch: pure calculations. No network, writes or SMS. */
(function(root){
'use strict';
const sourceNames={subnex_website:'SUBNEX Collections',partner_email:'Partner Email',partner_whatsapp:'Partner WhatsApp',missing:'Missing Collections'};
const sourceOf=a=>a.intake_channel||({subnex:'subnex_website',missing:'missing'}[a.collection_source])||'partner_email';
const postcode=s=>{const m=String(s||'').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);return m?m[1]+' '+m[2]:'';};
const key=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const phone=s=>{let p=String(s||'').replace(/[\s().-]/g,'');if(p.startsWith('0044'))p='+'+p.slice(2);if(/^07\d{9}$/.test(p))p='+44'+p.slice(1);if(/^44\d{10}$/.test(p))p='+'+p;return p;};
const hm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const minute=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
const ukParts=d=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(d)).map(x=>[x.type,x.value]));
const ukDay=d=>{const p=ukParts(d||new Date());return `${p.year}-${p.month}-${p.day}`;};
const ukMinute=d=>{const p=ukParts(d);return +p.hour*60+(+p.minute);};
const pointKey=p=>Number(p.lat).toFixed(5)+','+Number(p.lng).toFixed(5);
const validPoint=p=>p&&typeof p.lat==='number'&&Number.isFinite(p.lat)&&p.lat>=49&&p.lat<=61&&typeof p.lng==='number'&&Number.isFinite(p.lng)&&p.lng>=-9&&p.lng<=3;
function zone(address){const p=postcode(address).split(' ')[0];
 if(/^CF(62|63|64)$/.test(p))return 'Barry / Vale';
 if(/^CF(31|32|33|34|35|36)$/.test(p))return 'Bridgend';
 if(/^CF(37|38|39|40|41|42|43)$/.test(p))return 'Rhondda / Pontypridd';
 if(/^CF(44|45|46|47|48)$/.test(p))return 'Merthyr / Aberdare';
 if(/^CF(81|82|83)$/.test(p)||/^NP(11|12|13|22|23)$/.test(p))return 'Caerphilly / Valleys';
 if(p.startsWith('CF'))return 'Cardiff';if(p.startsWith('NP'))return 'Newport / East Wales';
 if(p.startsWith('SA'))return 'Swansea';if(p==='LD3')return 'Brecon';return 'Outside area';
}
const legMinutes=(a,b,config,roads)=>{if(pointKey(a)===pointKey(b))return 0;const seconds=roads[pointKey(a)+'>'+pointKey(b)];return typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?Math.ceil(seconds/60*config.travel_factor)+config.leg_buffer_minutes:Infinity;};
/* ---------- зоны выезда ----------
   Дальние районы (BS, SA) обслуживаются в назначенный день месяца.
   Правила приходят с сервера (public.subnex_zones) и кладутся в config.zones. */
const postcodeArea=s=>{const m=String(s||'').toUpperCase().match(/\b([A-Z]{1,2})\d[A-Z\d]?\s*\d[A-Z]{2}\b/);return m?m[1]:'';};
const zoneRule=(config,text)=>{const a=postcodeArea(text);return a?(config.zones||[]).find(z=>z.prefix===a)||null:null;};
/* n-й день недели месяца; week=5 — последний. Возвращает YYYY-MM-DD. */
function nthWeekday(day,weekday,week){
 const [y,m]=day.split('-').map(Number);const last=new Date(Date.UTC(y,m,0)).getUTCDate();const hits=[];
 for(let d=1;d<=last;d++){const t=new Date(Date.UTC(y,m-1,d));if(t.getUTCDay()===weekday)hits.push(d);}
 const pick=week>=5?hits[hits.length-1]:hits[week-1];
 return pick?`${y}-${String(m).padStart(2,'0')}-${String(pick).padStart(2,'0')}`:null;
}
const zoneTripDay=(rule,day)=>rule&&rule.mode==='monthly'&&Number.isFinite(rule.weekday)?nthWeekday(day,rule.weekday,rule.week_of_month||5):null;
/* Зона, чей выезд назначен на этот день: такой день занимают только её адреса. */
const tripZoneOf=(config,day)=>(config.zones||[]).find(z=>z.mode==='monthly'&&zoneTripDay(z,day)===day)||null;
/* Ближайшие даты выезда зоны начиная с дня. */
function nextTripDays(rule,from,count=3){const out=[];let [y,m]=from.split('-').map(Number);
 for(let i=0;i<14&&out.length<count;i++){const d=nthWeekday(`${y}-${String(m).padStart(2,'0')}-01`,rule.weekday,rule.week_of_month||5);
  if(d&&d>=from)out.push(d);m++;if(m>12){m=1;y++;}}
 return out;}
function zoneReason(config,text,from){
 const rule=zoneRule(config,text);
 if(!rule)return postcodeArea(text)?`Район ${postcodeArea(text)} не настроен. Добавьте его в «Настройки → Зоны выезда» или назначьте сбор вручную.`:'В адресе нет полного почтового индекса — район определить нельзя.';
 if(rule.mode==='off')return `Зона «${rule.name}» выключена в настройках.`;
 if(rule.mode==='monthly'){const d=nextTripDays(rule,from,1)[0];return `Зона «${rule.name}» — выезд раз в месяц${d?': ближайший '+d:''}. Заявка ждёт этого дня.`;}
 return null;
}

function evaluate(nodes,order,config,hours,roads,startMinute){
 if(!hours||hours.closed)return {ok:false,code:'DAY_CLOSED'};
 if(!validPoint(config.home)||!validPoint(config.depot))return {ok:false,code:'SETTINGS_REQUIRED'};
 const byId=new Map(nodes.map(n=>[n.key,n]));
 if(order.length!==nodes.length||new Set(order).size!==order.length||order.some(id=>!byId.has(id)))return {ok:false,code:'PLAN_CHANGED'};
 // Working hours bound arrivals at collections. Outbound and return travel sit outside them.
 const opens=minute(hours.opens),closes=minute(hours.closes),departFloor=Math.max(0,startMinute??0),availableFrom=Math.max(opens,departFloor);
 let cursor=departFloor,prev=config.home,previous='Старт',drive=0,service=0,kg=0,departure=null,collectionWork=0,wait=0;
 const stops=[];
 const travel=(a,b)=>legMinutes(a,b,config,roads);
 for(const id of order){const n=byId.get(id);
  if(!validPoint(n))return {ok:false,code:'COORDINATES_REQUIRED',address:n.text};
  if(!Number.isFinite(n.earliest)||!Number.isFinite(n.latest)||n.latest<n.earliest)return {ok:false,code:'TIME_REQUIRED',address:n.text};
  const leg=travel(prev,n);if(!Number.isFinite(leg))return {ok:false,code:'ROADS_REQUIRED',from:previous,to:n.text};
  if(n.earliest<opens||n.latest>closes)return {ok:false,code:'OUTSIDE_HOURS',address:n.text};
  const first=stops.length===0;
  const arrival=Math.max(cursor+leg,n.earliest,opens);if(arrival>n.latest)return {ok:false,code:'TIME_CONFLICT',from:previous,to:n.text,arrival,latest:n.latest};
  const w=first?0:Math.max(0,arrival-(cursor+leg));if(first)departure=arrival-leg;else{collectionWork+=leg;wait+=w;}
  kg+=Number(n.kg);service+=Number(n.service);drive+=leg;
  if(kg>config.capacity_kg)return {ok:false,code:'CAPACITY',kg,limit:config.capacity_kg};
  collectionWork+=Math.max(0,Math.min(arrival+Number(n.service),closes)-Math.max(arrival,availableFrom));
  cursor=arrival+Number(n.service);stops.push({key:id,address_id:n.address_id,text:n.text,arrival,departure:cursor,travel:leg,kg,kind:n.kind,wait:w});prev=n;previous=n.text;
 }
 if(!stops.length)return {ok:true,order:[],stops:[],departure:null,finish:null,drive:0,service:0,kg:0,wait:0,switches:0,collection_work_minutes:0,free_minutes:Math.max(0,closes-availableFrom)};
 const endLeg=travel(prev,config.depot);if(!Number.isFinite(endLeg))return {ok:false,code:'ROADS_REQUIRED',from:previous,to:'Склад'};
 drive+=endLeg;const finish=cursor+endLeg;if(finish>=1440)return {ok:false,code:'DAY_BOUNDARY',finish};
 let switches=0;for(let i=1;i<order.length;i++)if(zone(byId.get(order[i]).text)!==zone(byId.get(order[i-1]).text))switches++;
 return {ok:true,order:[...order],stops,departure,finish,drive,service,kg,wait,switches,collection_work_minutes:collectionWork,free_minutes:Math.max(0,closes-availableFrom-collectionWork)};
}
function ordered(nodes,previous=[]){const present=new Set(nodes.map(n=>n.key));const out=previous.filter(k=>present.has(k));for(const n of [...nodes].sort((a,b)=>a.earliest-b.earliest||a.key.localeCompare(b.key)))if(!out.includes(n.key))out.push(n.key);return out;}
/* Мягкие приоритеты планировщика (минуты «стоимости»). Не требования бизнеса, а выбранные коэффициенты — см. описание этапа 2.
   wait_weight — каждая минута простоя, которую создаёт вставка; empty_day_penalty — открытие пустого дня, когда есть начатые;
   sla_days / sla_penalty — срок сбора после заявки; max_wait — простой сверх этого штрафуется вдвое. */
const PLAN_DEFAULTS={wait_weight:1,empty_day_penalty:45,sla_days:7,sla_penalty:90,max_wait:15,cluster_penalty:12};
const planParam=(config,k)=>Number.isFinite(+config[k])?+config[k]:PLAN_DEFAULTS[k];
const slaDeadline=(request,config)=>{const c=request.created_at?ukDay(request.created_at):null;if(!c)return null;const d=new Date(Date.parse(c+'T12:00:00Z')+planParam(config,'sla_days')*86400000);return d.toISOString().slice(0,10);};
function placements(day,request,config,roads){
 if(day.started_at||day.hours?.closed||request.not_before&&day.day<request.not_before)return [];
 const rule=zoneRule(config,request.text);
 if(!rule||rule.mode==='off')return [];
 // Адрес дальней зоны допускается только в её день выезда.
 if(rule.mode==='monthly'&&zoneTripDay(rule,day.day)!==day.day)return [];
 // День выезда зоны занимают только адреса этой зоны, иначе поездка расплывётся.
 const trip=tripZoneOf(config,day.day);
 if(trip&&trip.prefix!==rule.prefix)return [];
 const nodes=day.nodes.filter(n=>n.address_id!==request.id),order=ordered(nodes,day.order);
 const base=evaluate(nodes,order,config,day.hours,roads,day.start_minute);if(!base.ok)return [];
 const opens=minute(day.hours.opens),closes=minute(day.hours.closes),earliestMin=Math.max(opens,day.start_minute||0),svc=request.service_minutes??10;
 const node={key:'a:'+request.id,address_id:request.id,text:request.text,lat:request.lat,lng:request.lng,earliest:earliestMin,latest:closes,service:svc,kg:request.estimated_kg??40,kind:'hold'};
 const byId=new Map(nodes.map(n=>[n.key,n])),rz=zone(request.text),sameZoneInDay=nodes.some(n=>zone(n.text)===rz);
 const deadline=slaDeadline(request,config),late=deadline&&day.day>deadline;
 const result=[];
 for(let i=0;i<=order.length;i++){
  const candidate=[...order.slice(0,i),node.key,...order.slice(i)];
  const probe=evaluate([...nodes,node],candidate,config,day.hours,roads,day.start_minute);if(!probe.ok)continue;
  const arrival=probe.stops.find(n=>n.key===node.key).arrival;
  const starts=new Set([Math.ceil(arrival/5)*5]);
  // Вторая точка: вплотную ПЕРЕД следующей остановкой, чтобы не оставлять простой перед её окном.
  const next=i<order.length?byId.get(order[i]):null;
  if(next){const leg=legMinutes(node,next,config,roads);if(Number.isFinite(leg)){const tight=Math.floor((next.earliest-leg-svc)/5)*5;if(tight>arrival)starts.add(tight);}}
  for(let start of starts){
   start=Math.min(start,closes-30);if(start<earliestMin)continue;
   const pinned={...node,earliest:start,latest:start+30};if(pinned.latest>closes)continue;
   const fit=evaluate([...nodes,pinned],candidate,config,day.hours,roads,day.start_minute);
   if(!fit.ok||fit.kg>config.capacity_kg-config.reserve_kg||fit.free_minutes<config.reserve_minutes)continue;
   const extra=fit.drive-(nodes.length?base.drive:0),waitDelta=Math.max(0,fit.wait-base.wait),switchDelta=Math.max(0,fit.switches-base.switches);
   const prev=i>0?byId.get(order[i-1]):null,adjacent=(prev&&zone(prev.text)===rz)||(next&&zone(next.text)===rz);
   const cluster=nodes.length&&!adjacent?(sameZoneInDay?planParam(config,'cluster_penalty'):config.zone_penalty_minutes):0;
   const idle=waitDelta*planParam(config,'wait_weight')+(waitDelta>planParam(config,'max_wait')?waitDelta:0);
   const score=extra+idle+switchDelta*config.zone_penalty_minutes+cluster+(nodes.length?0:planParam(config,'empty_day_penalty'))+(late?planParam(config,'sla_penalty'):0);
   result.push({day:day.day,address_id:request.id,start:hm(start),end:hm(start+30),node:pinned,fit,extra_minutes:extra,wait_minutes:waitDelta,score,late:!!late});
  }
 }
 return result.sort((a,b)=>a.score-b.score||a.start.localeCompare(b.start));
}
const dayOptions=(work,r,config,roads)=>work.flatMap((d,i)=>placements(d,r,config,roads).slice(0,3).map(p=>({...p,score:p.score+i*config.day_penalty_minutes}))).sort((a,b)=>a.score-b.score||a.day.localeCompare(b.day)||a.start.localeCompare(b.start));
const applyChoice=(work,chosen)=>{const day=work.find(d=>d.day===chosen.day);day.nodes=day.nodes.filter(n=>n.address_id!==chosen.address_id);day.nodes.push(chosen.node);day.order=chosen.fit.order;};
const removeFrom=(work,address_id)=>{for(const d of work){if(d.nodes.some(n=>n.address_id===address_id)){d.nodes=d.nodes.filter(n=>n.address_id!==address_id);d.order=ordered(d.nodes,d.order);return d;}}return null;};
function summarize(work,config,roads,assigned,unassigned){
 const days=work.map(d=>({...d,fit:evaluate(d.nodes,d.order,config,d.hours,roads,d.start_minute)}));
 const used=days.filter(d=>d.fit.ok&&d.fit.stops.length);
 return {days,metrics:{assigned:assigned.length,unassigned:unassigned.length,days_used:used.length,
  drive:used.reduce((s,d)=>s+d.fit.drive,0),wait:used.reduce((s,d)=>s+d.fit.wait,0),switches:used.reduce((s,d)=>s+d.fit.switches,0),
  late:assigned.filter(a=>a.late).length,extra_drive:assigned.reduce((s,a)=>s+a.extra_minutes,0)}};
}
async function planBatch(days,requests,config,roads,onProgress=()=>{}){
 const work=days.map(d=>({...d,nodes:[...d.nodes],order:ordered(d.nodes,d.order)})),remaining=[...requests],assigned=[],unassigned=[];
 const byId=new Map(requests.map(r=>[r.id,r]));
 // 1. Жадный проход: сначала самые ограниченные заявки (меньше вариантов), затем лучший вариант.
 while(remaining.length){let best=null;
  for(const r of remaining){const options=dayOptions(work,r,config,roads);if(!options.length)continue;const choice={request:r,options};
   if(!best||options.length<best.options.length||options.length===best.options.length&&(options[0].score<best.options[0].score||options[0].score===best.options[0].score&&String(r.created_at||r.id)<String(best.request.created_at||best.request.id)))best=choice;}
  if(!best)break;
  const chosen=best.options[0];applyChoice(work,chosen);chosen.request_token=best.request.dispatch_token;assigned.push(chosen);
  remaining.splice(remaining.findIndex(r=>r.id===chosen.address_id),1);onProgress(assigned.length,requests.length);await new Promise(resolve=>setTimeout(resolve,0));
 }
 // 2. Улучшение: каждую распределённую заявку пробуем переставить, если в новом контексте есть место лучше.
 for(let pass=0;pass<3;pass++){let improved=false;
  for(let idx=0;idx<assigned.length;idx++){const a=assigned[idx],r=byId.get(a.address_id);if(!r)continue;
   removeFrom(work,a.address_id);const options=dayOptions(work,r,config,roads);
   const current=options.find(o=>o.day===a.day&&o.start===a.start),bestOpt=options[0];
   if(bestOpt&&(!current||bestOpt.score<current.score-1)&&!(bestOpt.day===a.day&&bestOpt.start===a.start)){applyChoice(work,bestOpt);bestOpt.request_token=r.dispatch_token;assigned[idx]=bestOpt;improved=true;}
   else if(current){applyChoice(work,current);current.request_token=r.dispatch_token;assigned[idx]=current;}
   else applyChoice(work,a);
  }
  // 3. Заявки без места пробуем ещё раз — после перестановок оно могло появиться.
  for(const r of [...remaining]){const options=dayOptions(work,r,config,roads);if(options.length){applyChoice(work,options[0]);options[0].request_token=r.dispatch_token;assigned.push(options[0]);remaining.splice(remaining.indexOf(r),1);improved=true;}}
  await new Promise(resolve=>setTimeout(resolve,0));if(!improved)break;
 }
 const from=days[0]?.day||ukDay();
 for(const r of remaining)unassigned.push({address_id:r.id,reason:zoneReason(config,r.text,from)||'Нет подходящего места с учётом дороги, договорённостей и рабочих часов.'});
 return {assigned,unassigned,...summarize(work,config,roads,assigned,unassigned)};
}
function splitDelimited(text,delimiter){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else cell+=c;}else if(c===delimiter&&!quoted){row.push(cell.trim());cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}row.push(cell.trim());if(row.some(Boolean))rows.push(row);return rows;}
function parseRows(text,html,source){
 let rows=[];if(html&&typeof DOMParser!=='undefined'){const doc=new DOMParser().parseFromString(html,'text/html');rows=[...doc.querySelectorAll('tr')].map(tr=>[...tr.querySelectorAll(':scope > td,:scope > th')].map(td=>td.textContent.replace(/\s+/g,' ').trim())).filter(r=>r.length>1);}
 if(!rows.length){const delim=text.includes('\t')?'\t':text.includes(';')?';':/^(?:\s*"|[^\n,]*(?:address|адрес)[^\n,]*,|[^\n]*,\s*(?:address|адрес)\s*,)/i.test(text)?',':null;rows=delim?splitDelimited(text,delim):text.split(/\r?\n/).filter(s=>s.trim()).map(s=>[s.trim()]);}
 const head=rows[0]||[],headers=head.map(x=>x.toLowerCase());const named=headers.some(x=>/^(address|адрес|адреса|collection address)$/.test(x));if(named)rows.shift();
 return rows.map((cells,i)=>{const all=cells.join(' | ');let address='',name='',tel='',email='',bags='',note='';
  if(named){const get=re=>cells[headers.findIndex(h=>re.test(h))]||'';address=get(/address|адрес/);name=get(/name|имя/);tel=get(/phone|mobile|телефон/);email=get(/email|e-mail|почта/);if(!email)email=(tel.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0]||'';tel=(tel.match(/(?:\+44|0044|0)7(?:[\s().-]*\d){9}\b/)||[])[0]||tel;bags=get(/bags|мешк/);note=get(/note|comment|примеч/);}
  else {const index=cells.findIndex(c=>/collection from/i.test(c));address=index>=0?cells[index].replace(/^\s*collection from\s*/i,''):cells.find(c=>postcode(c))||cells[0];
   if(index>=0&&index>0)name=cells[0];tel=(all.match(/(?:\+44|0044|0)7(?:[\s().-]*\d){9}\b/)||[])[0]||'';
   email=(all.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)||[])[0]||'';
   const b=all.match(/(?:no\.?\s*of\s*bags\s*=|bags\s*[:=])\s*(\d+(?:\s*(?:to|[-–])\s*\d+)?)/i);bags=b?.[1]||'';
   note=cells.filter((_,j)=>j!==(index>=0?index:cells.indexOf(address))).join(' | ');
   if(cells.length===1){address=address.replace(tel,'').replace(email,'').replace(/\|+/g,',').trim();}
  }
  return {row:i+1,text:address.trim(),contact_name:name,phone:phone(tel),contact_email:email,bags_text:bags,note,intake_channel:source,estimated_kg:40,service_minutes:10,not_before:null,raw:all};
 });
}
function issues(row,existing=[],previous=[]){const out=[];const pc=postcode(row.text);
 if(!pc||key(row.text).replace(key(pc),'').length<3)out.push('Нужны дом, улица и полный postcode');
 if(/^(?:collection from\s*)?\d+\s*,?\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(row.text))out.push('Не указана улица');
 if(['subnex_website','partner_email'].includes(row.intake_channel)&&!/^\+447\d{9}$/.test(phone(row.phone)))out.push('Для SMS нужен мобильный номер Великобритании');
 if(/^\d+[a-z]?\s*,?\s*(?:Cardiff|Newport|Barry|Bridgend|Caerphilly|Tredegar|Pontypridd|Wales)\s*,?\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(row.text))out.push('Не указана улица');
 if(!sourceNames[row.intake_channel])out.push('Выберите источник');
 if(!Number.isFinite(+row.estimated_kg)||+row.estimated_kg<=0)out.push('Укажите ожидаемый вес');
 if(![5,10].includes(+row.service_minutes))out.push('Сбор: 5 или 10 минут');
 if(previous.some(a=>key(a.text)===key(row.text)))out.push('Повтор в этой пачке');
 if(existing.some(a=>['new','planned'].includes(a.status)&&key(a.text)===key(row.text)))out.push('Адрес уже есть в действующих заявках');
 return out;
}
root.SubnexDispatchCore={sourceNames,sourceOf,postcode,key,phone,hm,minute,ukDay,ukMinute,pointKey,validPoint,zone,evaluate,ordered,placements,planBatch,parseRows,issues,PLAN_DEFAULTS,postcodeArea,zoneRule,zoneTripDay,tripZoneOf,nextTripDays,zoneReason,nthWeekday};
if(typeof module!=='undefined'&&module.exports)module.exports=root.SubnexDispatchCore;
})(typeof window==='undefined'?globalThis:window);
