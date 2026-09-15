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
function evaluate(nodes,order,config,hours,roads,startMinute){
 if(!hours||hours.closed)return {ok:false,code:'DAY_CLOSED'};
 if(!validPoint(config.home)||!validPoint(config.depot))return {ok:false,code:'SETTINGS_REQUIRED'};
 const byId=new Map(nodes.map(n=>[n.key,n]));
 if(order.length!==nodes.length||new Set(order).size!==order.length||order.some(id=>!byId.has(id)))return {ok:false,code:'PLAN_CHANGED'};
 let cursor=Math.max(minute(hours.opens),startMinute??0),prev=config.home,previous='Старт',drive=0,service=0,kg=0;
 const stops=[];
 function travel(a,b){if(pointKey(a)===pointKey(b))return 0;const seconds=roads[pointKey(a)+'>'+pointKey(b)];return typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0?Math.ceil(seconds/60*config.travel_factor)+config.leg_buffer_minutes:Infinity;}
 for(const id of order){const n=byId.get(id);
  if(!validPoint(n))return {ok:false,code:'COORDINATES_REQUIRED',address:n.text};
  if(!Number.isFinite(n.earliest)||!Number.isFinite(n.latest)||n.latest<n.earliest)return {ok:false,code:'TIME_REQUIRED',address:n.text};
  const leg=travel(prev,n);if(!Number.isFinite(leg))return {ok:false,code:'ROADS_REQUIRED',from:previous,to:n.text};
  const arrival=Math.max(cursor+leg,n.earliest);if(arrival>n.latest)return {ok:false,code:'TIME_CONFLICT',from:previous,to:n.text,arrival,latest:n.latest};
  kg+=Number(n.kg);service+=Number(n.service);drive+=leg;
  if(kg>config.capacity_kg)return {ok:false,code:'CAPACITY',kg,limit:config.capacity_kg};
  if(n.earliest<minute(hours.opens)||n.latest>minute(hours.closes))return {ok:false,code:'OUTSIDE_HOURS',address:n.text};
  cursor=arrival+Number(n.service);stops.push({key:id,address_id:n.address_id,text:n.text,arrival,departure:cursor,travel:leg,kg,kind:n.kind});prev=n;previous=n.text;
 }
 const endLeg=travel(prev,config.depot);if(!Number.isFinite(endLeg))return {ok:false,code:'ROADS_REQUIRED',from:previous,to:'Склад'};
 drive+=endLeg;const finish=cursor+endLeg;if(finish>minute(hours.closes))return {ok:false,code:'DEPOT_LATE',finish,latest:minute(hours.closes)};
 return {ok:true,order:[...order],stops,finish,drive,service,kg,free_minutes:minute(hours.closes)-Math.max(minute(hours.opens),startMinute??0)-drive-service};
}
function ordered(nodes,previous=[]){const present=new Set(nodes.map(n=>n.key));const out=previous.filter(k=>present.has(k));for(const n of [...nodes].sort((a,b)=>a.earliest-b.earliest||a.key.localeCompare(b.key)))if(!out.includes(n.key))out.push(n.key);return out;}
function placements(day,request,config,roads){
 if(day.started_at||day.hours?.closed||request.not_before&&day.day<request.not_before||zone(request.text)==='Outside area')return [];
 const nodes=day.nodes.filter(n=>n.address_id!==request.id),order=ordered(nodes,day.order);
 const base=evaluate(nodes,order,config,day.hours,roads,day.start_minute);if(!base.ok)return [];
 const node={key:'a:'+request.id,address_id:request.id,text:request.text,lat:request.lat,lng:request.lng,earliest:Math.max(minute(day.hours.opens),day.start_minute||0),latest:minute(day.hours.closes)-30,service:request.service_minutes??10,kg:request.estimated_kg??40,kind:'hold'};
 const result=[];
 for(let i=0;i<=order.length;i++){
  const candidate=[...order.slice(0,i),node.key,...order.slice(i)];let fit=evaluate([...nodes,node],candidate,config,day.hours,roads,day.start_minute);if(!fit.ok)continue;
  const start=Math.ceil(fit.stops.find(n=>n.key===node.key).arrival/5)*5;
  const pinned={...node,earliest:start,latest:start+30};if(pinned.latest>minute(day.hours.closes))continue;
  fit=evaluate([...nodes,pinned],candidate,config,day.hours,roads,day.start_minute);if(!fit.ok||fit.kg>config.capacity_kg-config.reserve_kg||fit.free_minutes<config.reserve_minutes)continue;
  const sameZone=nodes.some(n=>zone(n.text)===zone(request.text));
  result.push({day:day.day,address_id:request.id,start:hm(start),end:hm(start+30),node:pinned,fit,extra_minutes:fit.drive-(nodes.length?base.drive:0),score:fit.drive-(nodes.length?base.drive:0)+(nodes.length&&!sameZone?config.zone_penalty_minutes:0)});
 }
 return result.sort((a,b)=>a.score-b.score||a.start.localeCompare(b.start));
}
async function planBatch(days,requests,config,roads,onProgress=()=>{}){
 const work=days.map(d=>({...d,nodes:[...d.nodes],order:ordered(d.nodes,d.order)})),remaining=[...requests],assigned=[],unassigned=[];
 while(remaining.length){let best=null;
  for(const r of remaining){const options=work.flatMap((d,i)=>placements(d,r,config,roads).slice(0,1).map(p=>({...p,score:p.score+i*config.day_penalty_minutes}))).sort((a,b)=>a.score-b.score||a.day.localeCompare(b.day));
   if(!options.length)continue;
   const choice={request:r,options};
   if(!best||options.length<best.options.length||options.length===best.options.length&&(options[0].score<best.options[0].score||options[0].score===best.options[0].score&&String(r.created_at||r.id)<String(best.request.created_at||best.request.id)))best=choice;
  }
  if(!best)break;
  const chosen=best.options[0],day=work.find(d=>d.day===chosen.day);day.nodes=day.nodes.filter(n=>n.address_id!==chosen.address_id);day.nodes.push(chosen.node);day.order=chosen.fit.order;
  chosen.request_token=best.request.dispatch_token;assigned.push(chosen);remaining.splice(remaining.findIndex(r=>r.id===chosen.address_id),1);onProgress(assigned.length,requests.length);await new Promise(resolve=>setTimeout(resolve,0));
 }
 for(const r of remaining)unassigned.push({address_id:r.id,reason:zone(r.text)==='Outside area'?'Адрес вне зоны автоматического распределения.':'Нет подходящего места с учётом дороги, договорённостей, загрузки и резерва.'});
 return {assigned,unassigned,days:work.map(d=>({...d,fit:evaluate(d.nodes,d.order,config,d.hours,roads,d.start_minute)}))};
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
root.SubnexDispatchCore={sourceNames,sourceOf,postcode,key,phone,hm,minute,ukDay,ukMinute,pointKey,validPoint,zone,evaluate,ordered,placements,planBatch,parseRows,issues};
if(typeof module!=='undefined'&&module.exports)module.exports=root.SubnexDispatchCore;
})(typeof window==='undefined'?globalThis:window);
