/* SUBNEX partner time finder. Does not send messages or move appointments. */
(function(root){
'use strict';
const SERVICE=10, BUFFER=1.2, LEG_MARGIN=5;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const key=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const coord=p=>p&&typeof p.lat==='number'&&Number.isFinite(p.lat)&&p.lat>=49&&p.lat<=61&&typeof p.lng==='number'&&Number.isFinite(p.lng)&&p.lng>=-9&&p.lng<=3;
const ukParts=x=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(x)).map(p=>[p.type,p.value]));
const ukDay=x=>{const p=ukParts(x);return `${p.year}-${p.month}-${p.day}`;};
const at=x=>{const p=ukParts(x);return +p.hour*60+(+p.minute);};
const hm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(Math.floor(m%60)).padStart(2,'0')}`;
const clock=s=>/^\d{2}:\d{2}(:\d{2})?$/.test(s||'')?Number(s.slice(0,2))*60+Number(s.slice(3,5)):NaN;
const nextDay=d=>new Date(Date.parse(d+'T12:00:00Z')+86400000).toISOString().slice(0,10);
const dayLabel=d=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',weekday:'short',day:'numeric',month:'long'}).format(new Date(d+'T12:00:00Z'));
const englishDate=d=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(d+'T12:00:00Z'));
const postcode=text=>{const m=String(text||'').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);return m?m[1]+m[2]:null;};
const textFor=p=>`We can collect from ${p.address} on ${englishDate(ukDay(p.starts_at))} at ${hm(at(p.starts_at))} (UK time). Please confirm with the customer and let us know if this time is agreed.`;

function blocksFor(day){
 const h=day.hours, opens=clock(h?.opens),closes=clock(h?.closes);
 if(!h||!Number.isFinite(opens)||!Number.isFinite(closes)||opens>=closes)return {error:'Не задан рабочий график.'};
 if(h.closed)return {error:'Выходной по рабочему графику.'};
 const blocks=[];
 for(const a of day.addresses||[]){
  if(!a.collection_start||!a.collection_end)return {error:'Есть адрес без согласованного времени: '+a.text};
  if(a.date!==day.day||ukDay(a.collection_start)!==day.day||ukDay(a.collection_end)!==day.day)return {error:'Проверьте дату и время адреса: '+a.text};
  blocks.push({...a,start:a.collection_start,end:a.collection_end,type:'confirmed'});
 }
 for(const a of day.offers||[])blocks.push({...a,id:'sms:'+a.id,start:a.starts_at,end:a.ends_at,type:'sms'});
 for(const a of day.holds||[])blocks.push({...a,id:'partner:'+a.id,start:a.starts_at,end:a.ends_at,type:'partner'});
 for(const b of blocks){
  if(!coord(b))return {error:'Нет координат: '+b.text};
  if(!Number.isFinite(Date.parse(b.start))||!Number.isFinite(Date.parse(b.end))||Date.parse(b.end)<=Date.parse(b.start)||ukDay(b.start)!==day.day||ukDay(b.end)!==day.day)return {error:'Проверьте интервал: '+b.text};
  b.from=at(b.start); const end=at(b.end);
  // A broad arrival window is kept entirely free, plus handling after its latest arrival.
  b.to=b.type==='sms'||end-b.from>SERVICE?end+SERVICE:Math.max(end,b.from+SERVICE);
 }
 blocks.sort((a,b)=>a.from-b.from||String(a.id).localeCompare(String(b.id)));
 return {blocks,opens,closes};
}

function evaluate(day,point,matrix,home,depot,requestedTime){
 const b=blocksFor(day);if(b.error)return b;
 if(!coord(point)||!coord(home)||!coord(depot))return {error:'Нужны координаты адреса, старта и финиша.'};
 const {blocks,opens,closes}=b,n=blocks.length,c=n+1,f=n+2;
 if(!Array.isArray(matrix)||matrix.length!==n+3)return {error:'Не удалось рассчитать дорогу.'};
 const raw=(i,j)=>{const v=matrix[i]?.[j];return typeof v==='number'&&Number.isFinite(v)&&v>=0?v/60:Infinity;};
 const travel=(i,j)=>Math.ceil(raw(i,j)*BUFFER)+LEG_MARGIN;
 // Existing appointments are immutable. A conflicting day is reported, never repaired here.
 for(let i=0;i<=n;i++){
  const prev=i===0?{to:opens,text:home.text||'Старт'}:blocks[i-1];
  const dest=i===n?{from:closes,text:depot.text||'Финиш'}:blocks[i];
  const j=i===n?f:i+1;
  if(prev.to+travel(i,j)>dest.from)return {error:'Не хватает времени: '+prev.text+' → '+dest.text+'. Проверьте существующий график и дорогу.'};
 }
 const candidates=[];
 for(let i=0;i<=n;i++){
  const previous=i===0?{to:opens,text:home.text||'Старт'}:blocks[i-1];
  const next=i===n?{from:closes,text:depot.text||'Финиш'}:blocks[i];
  const j=i===n?f:i+1;
  const earliest=Math.ceil((previous.to+travel(i,c))/5)*5;
  const latest=Math.floor((next.from-travel(c,j)-SERVICE)/5)*5;
  const arrival=requestedTime===undefined?earliest:requestedTime;
  if(!Number.isFinite(arrival)||arrival<earliest||arrival>latest)continue;
  const added=raw(i,c)+raw(c,j)-raw(i,j);
  if(!Number.isFinite(added))continue;
  candidates.push({day:day.day,start:hm(arrival),end:hm(arrival+SERVICE),arrival,
    extra:Math.max(0,Math.round(added)),before:previous.text,after:next.text,
    inMinutes:Math.ceil(raw(i,c)),outMinutes:Math.ceil(raw(c,j)),token:day.token,
    existing:blocks.length});
 }
 candidates.sort((a,b)=>a.extra-b.extra||a.arrival-b.arrival);
 return candidates.length?{candidates,blocks}:{error:'Свободного промежутка с учётом дороги и 10 минут на сбор нет.'};
}

async function getJSON(url,signal){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 if(signal?.aborted)controller.abort();
 try{const r=await fetch(url,{signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json();}
 finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
const roadCache=new Map();
async function roadMatrix(day,point,home,depot,signal){
 const b=blocksFor(day);if(b.error)throw new Error(b.error);
 const points=[home,...b.blocks,point,depot];
 if(points.length>90)throw new Error('В этот день слишком много остановок для одного расчёта.');
 if(!points.every(coord))throw new Error('Проверьте координаты старта и финиша в настройках.');
 const k=points.map(p=>`${p.lng},${p.lat}`).join(';');
 const cached=roadCache.get(k);if(cached&&Date.now()-cached.time<300000)return cached.matrix;
 const j=await getJSON(`https://router.project-osrm.org/table/v1/driving/${k}?annotations=duration`,signal);
 if(j.code!=='Ok'||!Array.isArray(j.durations)||j.durations.length!==points.length||j.durations.some(row=>!Array.isArray(row)||row.length!==points.length))throw new Error('Сервис дорог не вернул полный расчёт. Попробуйте позже.');
 // Null legs stay unreachable; they are never replaced by straight-line estimates.
 if(roadCache.size>20)roadCache.clear();roadCache.set(k,{time:Date.now(),matrix:j.durations});return j.durations;
}
async function locate(text,signal){
 const pc=postcode(text);if(!pc)throw new Error('Добавьте полный британский postcode к адресу.');
 if(key(text).replace(pc.toLowerCase(),'').length<3)throw new Error('Кроме postcode, нужны номер или название дома и улица.');
 let data;try{data=await getJSON('https://api.postcodes.io/postcodes/'+encodeURIComponent(pc),signal);}
 catch(e){if(e?.message==='HTTP 404')throw new Error('Postcode не найден. Проверьте написание адреса.');throw e;}
 const p={lat:data.result?.latitude,lng:data.result?.longitude,postcode:pc};
 if(data.status!==200||!coord(p))throw new Error('Postcode не найден. Проверьте написание адреса.');
 return p;
}
const errors={
 PLAN_CHANGED:'Маршрут или предложения изменились. Нажмите «Подобрать время» заново.',
 PARTNER_TIME_RESERVED:'Этот промежуток уже предложен партнёру. Нужно подобрать другое время.',
 SLOT_CONFLICT:'В это время появилась другая заявка. Подберите время заново.',
 DUPLICATE_ADDRESS:'Такой адрес уже есть в активных заявках или ожидающих предложениях. Откройте существующую запись.',
 OUTSIDE_WORKING_HOURS:'Время выходит за текущий рабочий график.',
 SLOT_IN_PAST:'Предложенное время уже прошло. Нужен новый подбор и согласование.',
 PROPOSAL_CLOSED:'Предложение отменено. Создайте новое при необходимости.',
 DATE_RANGE:'Для нового предложения выберите дату начиная с завтрашнего дня, не дальше 90 дней.',
 AGREEMENT_REQUIRED:'Отметьте, что партнёр подтвердил именно эту дату и время.',
 ADDRESS_INVALID:'Проверьте полный адрес с postcode и заполненные поля.',
 ACCESS_DENIED:'Нет доступа к этому водителю. Перезайдите в приложение.',
 REQUEST_ID_REUSED:'Предложение уже сохранено с другими данными. Обновите список.',
 ALREADY_CONFIRMED:'Сбор уже добавлен в маршрут.',
 '40P01':'Данные одновременно менялись. Повторите действие: изменения не сохранены.'
};
function errorText(e){
 const msg=String(e?.message||e||'Ошибка');
 for(const [code,txt]of Object.entries(errors))if(msg.includes(code)||e?.code===code)return txt;
 if(e?.code==='PGRST202'||msg.includes('subnex_partner_planner'))return 'Подбор ещё не подключён к базе. Выполните файл 01_partner_planner.sql из обновления.';
 if(e?.name==='AbortError')return 'Расчёт прерван или сервис дорог не ответил. Повторите поиск.';
 if(e instanceof TypeError||/Failed to fetch|NetworkError/.test(msg))return 'Нет связи. Проверьте интернет и повторите действие.';
 return msg;
}

let ctx=null,modal=null,controller=null,epoch=0,busy=false,results=[],originalFocus=null,originalOverflow='';
const $=id=>modal?.querySelector('#pp-'+id);
function status(text){if($('status'))$('status').textContent=text;}
function setBusy(v){busy=v;if(modal)modal.querySelectorAll('button[data-work],input,select,textarea').forEach(el=>el.disabled=v||el.hasAttribute('data-expired'));}
async function rpc(action,data={}){
 const c=ctx;if(!c)throw new Error('Сеанс закрыт.');
 const {data:value,error}=await c.sb.rpc('subnex_partner_planner',{p_action:action,p_data:{...data,driver_id:c.driver.id}});
 if(ctx!==c)throw new DOMException('Сеанс закрыт.','AbortError');
 if(error)throw error;return value;
}
function clearResults(){results=[];if($('results'))$('results').replaceChildren();}
function close(){
 epoch++;controller?.abort();controller=null;ctx=null;results=[];busy=false;roadCache.clear();
 if(!modal)return;modal.remove();modal=null;
 if(root.document)document.body.style.overflow=originalOverflow;
 if(originalFocus?.isConnected)originalFocus.focus();
}
function buildShell(){
 modal=document.createElement('div');modal.className='pp-overlay';
 modal.innerHTML=`<section class="pp-panel" role="dialog" aria-modal="true" aria-labelledby="pp-title">
  <header class="pp-header"><div><h2 id="pp-title">Подобрать время</h2><p>WhatsApp партнёра · Missing Collections</p></div><button id="pp-close" aria-label="Закрыть подбор">Закрыть ×</button></header>
  <div class="pp-body"><p>Вставьте адрес. Приложение предложит место в графике для согласования с партнёром.</p>
   <p class="pp-help" id="pp-points"></p>
   <form id="pp-form">
    <label>Источник<select id="pp-source"><option value="partner_whatsapp">Partner Collections WhatsApp</option><option value="missing">Missing Collections</option></select></label>
    <label>Полный адрес с postcode<textarea id="pp-address" required maxlength="2000" rows="2" placeholder="Номер дома, улица, город, postcode"></textarea></label>
    <div class="pp-grid"><label>Мешки, если известно<input id="pp-bags" maxlength="80" placeholder="Например: 4–10"></label><label>Телефон, необязательно<input id="pp-phone" type="tel" maxlength="80"></label></div>
    <label>Примечание<input id="pp-note" maxlength="4000" placeholder="Доступ, этаж, пожелания клиента"></label>
    <label>Искать на 7 дней, начиная с<input id="pp-from" type="date" required></label>
    <p class="pp-help">Время Великобритании. На сбор — 10 минут. К дороге добавляется запас 20% и 5 минут на каждый переезд. Поиск начинается с завтрашнего дня.</p>
    <button type="submit" class="pp-primary" data-work>Подобрать время</button>
   </form>
   <p id="pp-status" role="status" aria-live="polite"></p><div id="pp-results"></div>
   <div class="pp-section-title"><h3>Ожидаем подтверждения партнёра</h3><button id="pp-refresh" data-work>Обновить</button></div>
   <p class="pp-help">Сохранённые предложения учитываются при следующем подборе. После ответа партнёра откройте предложение и вручную добавьте сбор.</p>
   <div id="pp-pending"></div>
  </div></section>`;
 document.body.append(modal);
 $('close').onclick=close;
 modal.addEventListener('keydown',e=>{
  if(e.key==='Escape'){close();return;}
  if(e.key==='Tab'){
   const items=[...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary')].filter(el=>el.getClientRects().length);
   const first=items[0],last=items.at(-1);
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
 });
 $('form').onsubmit=e=>{e.preventDefault();search();};
 $('form').addEventListener('input',clearResults);
 $('refresh').onclick=()=>run(async()=>{clearResults();await loadPending();status('Список обновлён.');});
 $('points').textContent=`Водитель: ${ctx.driver.name}. Старт: ${ctx.home?.text||'не указан'}. Финиш: ${ctx.depot?.text||'не указан'}.`;
 $('from').min=nextDay(ukDay(Date.now()));$('from').value=$('from').min;
 $('address').focus();
}
async function run(fn){
 if(busy||!ctx)return;const current=epoch;setBusy(true);status('');
 try{await fn(current);}catch(e){if(current===epoch)status(errorText(e));}
 finally{if(current===epoch)setBusy(false);}
}
async function open(options){
 if(modal)close();ctx={...options,home:{...options.home},depot:{...options.depot}};
 originalFocus=document.activeElement;originalOverflow=document.body.style.overflow;document.body.style.overflow='hidden';buildShell();
 await run(async()=>{await loadPending();});
}
async function loadPending(){
 const current=epoch,data=await rpc('pending');if(current!==epoch)return;
 const container=$('pending');container.replaceChildren();
 if(!data.items.length){container.textContent='Пока нет предложений.';return;}
 for(const p of data.items){
  const old=Date.parse(p.starts_at)<=Date.now();
  const card=document.createElement('article');card.className='pp-card';
  card.innerHTML=`<h4>${esc(p.address)}</h4><p><strong>${esc(dayLabel(ukDay(p.starts_at)))} · ${esc(hm(at(p.starts_at)))} UK</strong></p>
   <p class="pp-help">${p.source==='missing'?'Missing Collections':'Partner Collections WhatsApp'}${old?' · Время прошло, нужен новый подбор':''}</p>
   <details><summary>Текст для WhatsApp и подтверждение</summary><label>Сообщение партнёру<textarea readonly rows="5">${esc(textFor(p))}</textarea></label>
   <button data-copy ${old?'disabled data-expired':''}>Копировать текст</button>
   <label class="pp-check"><input type="checkbox" data-agreed> Партнёр подтвердил эту дату и время</label>
   <button class="pp-primary" data-confirm data-work ${old?'disabled data-expired':''}>Партнёр подтвердил — добавить</button>
   <p class="pp-help">Перед добавлением заново проверим дорогу и занятые интервалы.</p></details>
   <button class="pp-cancel" data-cancel data-work>Отменить предложение</button>`;
  card.querySelector('[data-copy]').onclick=()=>copyText(card.querySelector('textarea'),p);
  card.querySelector('[data-confirm]').onclick=()=>run(async()=>{
   if(!card.querySelector('[data-agreed]').checked)throw new Error(errors.AGREEMENT_REQUIRED);
   await confirmProposal(p);
  });
  card.querySelector('[data-cancel]').onclick=()=>run(async()=>{
   if(!confirm('Отменить предложение для '+p.address+'? Время освободится.'))return;
   await rpc('cancel',{id:p.id});clearResults();await loadPending();status('Предложение отменено. При необходимости подберите новое время.');
  });
  container.append(card);
 }
}
async function copyText(textarea,p){
 try{await navigator.clipboard.writeText(textFor(p));status('Текст скопирован. Перешлите его партнёру в WhatsApp.');}
 catch{textarea.focus();textarea.select();status('Выделен готовый текст. Скопируйте его и перешлите партнёру.');}
}
async function search(){await run(async current=>{
 clearResults();const data={address:$('address').value.trim(),source:$('source').value,bags_text:$('bags').value.trim(),phone:$('phone').value.trim(),note:$('note').value.trim(),from_day:$('from').value};
 if(data.address.length<5)throw new Error('Введите полный адрес.');
 if(data.from_day<$('from').min)throw new Error(errors.DATE_RANGE);
 if(!coord(ctx.home)||!coord(ctx.depot))throw new Error('Сначала укажите старт и финиш с координатами в настройках приложения.');
 if(ctx.hasOutbox?.())throw new Error('Сначала синхронизируйте несохранённые изменения адресов.');
 const duplicates=(ctx.addresses?.()||[]).filter(a=>!['done','noanswer','problem'].includes(a.status)&&key(a.text)===key(data.address));
 if(duplicates.length)throw new Error(errors.DUPLICATE_ADDRESS);
 controller?.abort();controller=new AbortController();const signal=controller.signal;
 status('Проверяю postcode и занятые интервалы…');
 const snapshot=await rpc('snapshot',{from_day:data.from_day});if(current!==epoch)return;
 const point=await locate(data.address,signal);if(current!==epoch)return;
 const found=[],skipped=[];
 for(const day of snapshot.days){
  if(current!==epoch)return;status('Считаю дорогу: '+dayLabel(day.day)+'…');
  const base=blocksFor(day);if(base.error){skipped.push({day:day.day,reason:base.error});continue;}
  try{const matrix=await roadMatrix(day,point,ctx.home,ctx.depot,signal);if(current!==epoch)return;
   const r=evaluate(day,point,matrix,ctx.home,ctx.depot);
   if(r.error)skipped.push({day:day.day,reason:r.error});else found.push(r.candidates[0]);
  }catch(e){if(current!==epoch)return;skipped.push({day:day.day,reason:errorText(e)});}
 }
 if(current!==epoch)return;
 found.sort((a,b)=>a.extra-b.extra||a.day.localeCompare(b.day)||a.arrival-b.arrival);
 results=found.slice(0,3).map(r=>({...r,...point,...data,id:crypto.randomUUID()}));
 const area=$('results');area.innerHTML='<h3>Варианты для согласования</h3><p class="pp-help">Вначале — варианты с меньшим добавочным временем в дороге. Координаты нового адреса — центр postcode: проверьте дом и подъезд. Расчёт дороги ориентировочный, без прогноза пробок.</p>';
 if(!results.length)area.insertAdjacentHTML('beforeend','<p>На выбранные дни проверенного варианта нет. Ниже указаны причины; можно выбрать другую неделю.</p>');
 results.forEach((r,i)=>{
  const card=document.createElement('article');card.className='pp-card';
  card.innerHTML=`<h4>${esc(dayLabel(r.day))} · ${esc(r.start)} UK</h4><p>Примерно +${r.extra} мин дороги к маршруту</p>
   <p><small>После</small> ${esc(r.before)}<br><small>Перед</small> ${esc(r.after)}</p>
   <p class="pp-help">Переезды: около ${r.inMinutes} и ${r.outMinutes} мин без запаса. Сбор — до 10 мин.</p>
   <button class="pp-primary" data-work>Сохранить предложение</button>`;
  card.querySelector('button').onclick=()=>run(async()=>{
   if(ctx.hasOutbox?.())throw new Error('Сначала синхронизируйте изменения адресов.');
   const {from_day,extra,before,after,inMinutes,outMinutes,existing,arrival,end,...payload}=r;
   const saved=await rpc('reserve',payload);
   if(saved.item.state!=='held'){
    clearResults();await loadPending();
    throw new Error(saved.item.state==='confirmed'?errors.ALREADY_CONFIRMED:errors.PROPOSAL_CLOSED);
   }
   clearResults();await loadPending();
   const ta=document.createElement('textarea');ta.readOnly=true;ta.value=textFor(saved.item);ta.rows=5;
   const box=$('results');box.innerHTML='<h3>Предложение сохранено</h3><p>Перешлите этот текст партнёру. Время удерживается до подтверждения или отмены предложения.</p>';box.append(ta);
   const copy=document.createElement('button');copy.className='pp-primary';copy.textContent='Копировать для WhatsApp';copy.onclick=()=>copyText(ta,saved.item);box.append(copy);
   status('Ожидаем ответ партнёра. После ответа добавьте сбор кнопкой ниже.');
  });area.append(card);
 });
 if(skipped.length){const details=document.createElement('details');details.innerHTML='<summary>Почему другие дни не предложены</summary><ul>'+skipped.map(x=>`<li><strong>${esc(dayLabel(x.day))}:</strong> ${esc(x.reason)}</li>`).join('')+'</ul>';if(!results.length)details.open=true;area.append(details);}
 status(results.length?'Выберите вариант для пересылки партнёру.':'Подбор завершён.');
});}
async function confirmProposal(p){
 const current=epoch;if(ctx.hasOutbox?.())throw new Error('Сначала синхронизируйте изменения адресов.');
 status('Проверяю предложение перед добавлением…');
 const data=await rpc('review',{id:p.id});if(current!==epoch)return;
 if(data.item.state==='confirmed'){status(data.item.address_id?'Этот сбор уже добавлен.':'Подтверждение ранее записано; адрес уже удалён.');await loadPending();return;}
 if(data.item.state!=='held')throw new Error(errors.PROPOSAL_CLOSED);
 if(Date.parse(data.item.starts_at)<=Date.parse(data.now))throw new Error(errors.SLOT_IN_PAST);
 controller?.abort();controller=new AbortController();
 const matrix=await roadMatrix(data.day,data.item,ctx.home,ctx.depot,controller.signal);if(current!==epoch)return;
 const evaluated=evaluate(data.day,data.item,matrix,ctx.home,ctx.depot,at(data.item.starts_at));
 if(evaluated.error)throw new Error('Сейчас добавление не проходит проверку: '+evaluated.error+' Предложенное время сохранено; согласуйте изменения с партнёром.');
 const reply=await rpc('confirm',{id:p.id,token:data.day.token,agreed:true});if(current!==epoch)return;
 clearResults();await loadPending();
 status('Сбор добавлен в маршрут на '+dayLabel(ukDay(p.starts_at))+' в '+hm(at(p.starts_at))+' UK.');
 try{await ctx.onChanged?.(reply.address_id);}catch{status('Сбор добавлен. Обновите главный экран, чтобы увидеть его в маршруте.');}
}
root.OpsPlanner={open,close,core:{evaluate,blocksFor,coord,postcode,key,ukDay,at,hm,nextDay,textFor,roadMatrix,locate,errorText}};
})(typeof window!=='undefined'?window:globalThis);
