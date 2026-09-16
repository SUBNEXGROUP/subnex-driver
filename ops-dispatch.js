/* Shared intake, route proposals and immutable started days. No SMS is sent here. */
(function(root){
'use strict';
const C=root.SubnexDispatchCore,esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* Показываем обещание клиенту, а не служебный срок проверки: у старых заявок он равен концу дня. */
const slotOf=n=>[n.starts_at?C.ukMinute(n.starts_at):n.earliest,n.ends_at?C.ukMinute(n.ends_at):n.latest];
const arrivalLabel=n=>{const [s,e]=slotOf(n);return s===e?'прибытие '+C.hm(s):'интервал '+C.hm(s)+'–'+C.hm(e);};
const nextDay=d=>new Date(Date.parse(d+'T12:00:00Z')+86400000).toISOString().slice(0,10);
const label=d=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',weekday:'short',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));
const errors={ACCESS_DENIED:'Нет доступа к этому водителю.',SETTINGS_REQUIRED:'Сначала сохраните старт, склад и параметры машины.',SETTINGS_INVALID:'Проверьте координаты и параметры машины.',SETTINGS_IN_USE:'В расписании уже есть договорённости. Старт, склад и параметры дороги пока сохранены; резерв можно изменить.',ROUTING_PROVIDER_REQUIRED:'Для расчёта дороги нужно подключить сервис маршрутов в настройках функции subnex-routing.',COORDINATES_REQUIRED:'Уточните координаты всех адресов этого дня.',ROADS_REQUIRED:'Не удалось получить время поездки. Повторите расчёт после восстановления сервиса.',DAY_CLOSED:'Выходной по рабочему графику.',TIME_REQUIRED:'Есть адрес без согласованного времени.',TIME_CONFLICT:'Не хватает времени на дорогу и сбор.',OUTSIDE_HOURS:'Интервал выходит за рабочий график.',OUTSIDE_WORKING_HOURS:'Время выходит за рабочий график этого дня. Продлите часы в Настройки → Часы и доступ.',DEPOT_LATE:'Проверьте обновление расчёта: время склада должно считаться отдельно.',DAY_BOUNDARY:'Поездка заканчивается на следующие сутки. Нужна отдельная проверка маршрута.',CAPACITY:'Превышена ожидаемая загрузка машины.',RESERVE_EXHAUSTED:'Для этого плана недостаточно свободного времени или запаса по загрузке.',PLAN_CHANGED:'Список заявок изменился. Пересчитайте план перед сохранением.',STALE_ADDRESS:'Заявка изменилась. Обновите список и пересчитайте план.',REQUEST_RESERVED:'Для заявки уже предложено время. Откройте согласование.',ARRIVAL_WINDOW_30:'Для нового предложения укажите интервал в 30 минут.',CONFIRMED_FIXED:'Подтверждённые дату и интервал изменять нельзя.',ROUTE_STARTED:'Маршрут уже начат. Новые заявки остаются в очереди на следующие дни.',PENDING_CONFIRMATIONS:'Сначала завершите согласование предложений этого дня или снимите неподтверждённые предложения.',START_TODAY_ONLY:'Начать можно маршрут на сегодняшний день.',EMPTY_ROUTE:'В этот день пока нет сборов.',DISPATCH_NOT_ENABLED:'Новая версия установлена, но ещё не включена. Завершите шаг активации.',PARTNER_WITHDRAWAL_REQUIRED:'Сначала отзовите предложение у партнёра.',USE_CHAT_TO_CLOSE_OFFER:'Закройте предложение в SMS-переписке, затем обновите очередь.',OUTSIDE_AREA:'Адрес вне зоны автоматического распределения.',SLOT_IN_PAST:'Это время уже прошло. Подберите новый интервал.',BEFORE_AVAILABILITY:'Клиент доступен позже выбранной даты.',SLOT_INVALID:'Проверьте дату, интервал 30 минут и доступность клиента.',DATE_RANGE:'Выберите дату от сегодня до 90 дней вперёд.',AGREEMENT_REQUIRED:'Отметьте подтверждение партнёра.',BATCH_LIMIT_40:'За один расчёт выберите не больше 40 заявок.',AUTH_REQUIRED:'Войдите в приложение заново.',DUPLICATE_BANK_VISIT:'Этот контейнер уже назначен на выбранный день.',OFFLINE_PENDING:'Сначала синхронизируйте изменения, сохранённые на устройстве.',REQUEST_ID_REUSED:'Состав уже сохранённого запроса отличается. Обновите очередь.'};
function error(e){let code=String(e?.code||e?.message||e||'');if(!errors[code]&&e?.message)code=e.message;let detail=e?.details||e?.detail;try{if(typeof detail==='string')detail=JSON.parse(detail);}catch{detail=null;}let key=code.replace(/^ROUTE_/,'');if(errors[code])key=code;let text=errors[key]||(/^ROUTING_HTTP_429/.test(code)?'Сервис дорог временно ограничил запросы. Подождите минуту и повторите.':/^ROUTING_HTTP_|fetch|Failed to fetch|network/i.test(code)?'Сервис дорог недоступен. План не сохранён; повторите позже.':code);if(code.includes('DUPLICATE_ADDRESS'))text='В пачке или действующих заявках есть этот адрес. Проверьте повторы.';if(code.includes('UK_MOBILE_REQUIRED'))text='Для согласования по SMS нужен номер +447…';if(detail?.to)text+=' Участок: '+(detail.from||'Старт')+' → '+detail.to+'.';if(Number.isFinite(detail?.arrival)&&Number.isFinite(detail?.latest))text+=' Расчётное прибытие '+C.hm(detail.arrival)+', согласовано не позже '+C.hm(detail.latest)+'.';if(detail?.address)text+=' '+detail.address+'.';return text;}
async function rpc(sb,action,data){const r=await sb.rpc('subnex_dispatch',{p_action:action,p_data:data});if(r.error)throw r.error;return r.data;}
async function edge(sb,data){const r=await sb.functions.invoke('subnex-routing',{body:data});if(r.error){let body;try{body=await r.error.context?.json();}catch{}throw new Error(body?.error||r.error.message);}if(r.data?.error)throw new Error(r.data.error);return r.data;}
function online(o){if(o.hasOutbox?.())throw new Error('OFFLINE_PENDING');if(!navigator.onLine)throw new Error('Сейчас нет соединения. Сохранение плана требует интернета.');}
async function ready(sb,driver){const r=await rpc(sb,'settings',{driver_id:driver});if(!C.validPoint(r.config.home)||!C.validPoint(r.config.depot))throw new Error('SETTINGS_REQUIRED');return r;}
async function warm(o,day,addressIds=[]){online(o);await ready(o.sb,o.driver.id);return edge(o.sb,{action:'matrix',driver_id:o.driver.id,day,address_ids:addressIds});}
async function preflight(o,plan,payload){online(o);const driver=plan?.driver_id||o.driver?.id||o.address?.driver_id;if(!driver)throw new Error('Нужно назначить водителя.');const setup=await rpc(o.sb,'settings',{driver_id:driver});if(!setup.enabled)return null;const id=plan?.address_id||o.address?.id;if(!id)throw new Error('Сначала добавьте адрес.');await warm({...o,driver:{id:driver}},payload.day,[id]);await rpc(o.sb,'check',{driver_id:driver,address_id:id,day:payload.day,start:payload.start,end:payload.end});return {};}
async function routeDay(o,day){const before=await rpc(o.sb,'day',{driver_id:o.driver.id,day});if(!before.enabled)return null;let warning='';if(!before.started_at){try{await warm(o,day);}catch(e){warning=error(e);}}const state=await rpc(o.sb,'day',{driver_id:o.driver.id,day});let geometry;
 try{geometry=await edge(o.sb,{action:'geometry',driver_id:o.driver.id,day});if(geometry.token!==state.token)throw new Error('PLAN_CHANGED');}catch(e){warning=warning||error(e);const nodes=state.started_at?state.fit.nodes:state.nodes,byId=new Map(nodes.map(n=>[n.key,n]));const order=state.fit?.order||state.order;const cfg=state.started_at?state.fit.config:state.config;geometry={order:order.filter(k=>k.startsWith('a:')).map(k=>k.slice(2)),geometry:[cfg.home,...order.map(k=>byId.get(k)),cfg.depot].filter(C.validPoint).map(p=>[p.lat,p.lng]),km:null,min:null,sketch:true};}
 return {...geometry,state,warning:warning||(!state.fit.ok?error({code:state.fit.code,detail:state.fit}):'')};}
async function startDay(o,day){online(o);await warm(o,day);const state=await rpc(o.sb,'day',{driver_id:o.driver.id,day});if(state.started_at)return state;if(!state.fit.ok)throw {message:state.fit.code,details:state.fit};await rpc(o.sb,'start',{driver_id:o.driver.id,day,token:state.token});return await rpc(o.sb,'day',{driver_id:o.driver.id,day});}
const sourceOptions=selected=>Object.entries(C.sourceNames).map(([v,n])=>`<option value="${v}" ${v===selected?'selected':''}>${n}</option>`).join('');
const input=(name,title,value='',type='text',extra='')=>`<label>${title}<input data-field="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
let instance;
class Dispatch{
 constructor(o){this.o=o;this.sb=o.sb;this.driver=o.driver;this.inline=!!o.mount;this.tabs=Array.isArray(o.tabs)?o.tabs:['queue','one','batch','settings'];this.rows=[];this.requests=[];this.selected=new Set(o.address?[o.address.id]:[]);this.mode=o.tab||'queue';this.source=C.sourceNames[o.source]?o.source:C.sourceOf({collection_source:o.source});this.from=o.fromDay||nextDay(C.ukDay());this.days=14;this.busy=false;this.importId=crypto.randomUUID();}
 $(s){return this.root.querySelector(s);}call(action,data={}){return rpc(this.sb,action,{driver_id:this.driver.id,...data});}
 notice(text,bad=false){const n=this.$('.od-notice');n.textContent=text||'';n.classList.toggle('bad',bad);n.hidden=!text;}
 async run(fn,progress='Загрузка…'){if(this.busy)return;this.busy=true;this.notice(progress);this.root.setAttribute('aria-busy','true');this.root.querySelectorAll('button,input,select,textarea').forEach(b=>b.disabled=true);try{await fn();}catch(e){this.notice(error(e),true);}finally{this.busy=false;if(this.closed)return;this.root.setAttribute('aria-busy','false');this.root.querySelectorAll('button,input,select,textarea').forEach(b=>b.disabled=b.dataset.locked==='true');}}
 async start(){this.oldFocus=document.activeElement;this.oldOverflow=document.body.style.overflow;this.root=document.createElement('div');this.root.className='od-root'+(this.inline?' od-inline':'');if(!this.inline){this.root.setAttribute('role','dialog');this.root.setAttribute('aria-modal','true');this.root.setAttribute('aria-labelledby','od-title');}const tabNames={queue:'Очередь',one:'Один адрес',batch:'Вставить список',settings:'Параметры'};const tabsHtml=this.tabs.length>1?`<div class="od-tabs" role="navigation" aria-label="Разделы">${this.tabs.map(k=>`<button data-action="${k}">${tabNames[k]}</button>`).join('')}</div>`:'';this.root.innerHTML=`<section class="od-panel">${this.inline?'':`<header class="od-top"><div><small>SUBNEX · ${esc(this.driver.name||'Водитель')}</small><h2 id="od-title">Заявки и маршруты</h2></div><button data-action="close" aria-label="Закрыть">✕</button></header>`}${tabsHtml}<div class="od-notice" role="status" hidden></div><main class="od-content"></main></section>`;if(this.inline){this.o.mount.replaceChildren(this.root);}else{document.body.append(this.root);document.body.style.overflow='hidden';}this.root.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b&&!b.disabled)this.action(b.dataset.action,b);});this.root.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();const dialog=this.$('.od-dialog');if(dialog&&!this.modalBusy){dialog.remove();this.$('[data-action=close]')?.focus();}else if(!dialog&&!this.inline)this.close();}if(e.key==='Tab'){const list=[...(this.$('.od-dialog')||this.root).querySelectorAll('button,input,select,textarea,a')].filter(el=>!el.disabled&&el.getClientRects().length);if(e.shiftKey&&document.activeElement===list[0]){e.preventDefault();list.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===list.at(-1)){e.preventDefault();list[0]?.focus();}}});await this.run(async()=>{await this.reload();this.render();this.notice(this.enabled?'':'Подготовка новой версии. Планирование включится после активации.');});if(!this.inline)this.$('[data-action=close]')?.focus();}
 close(){if(this.busy||this.modalBusy||this.closed)return;this.closed=true;this.root.remove();if(!this.inline){document.body.style.overflow=this.oldOverflow;this.oldFocus?.focus();}if(instance===this)instance=null;}
 async reload(){try{const z=await this.sb.rpc('subnex_zones',{p_action:'list',p_data:{}});if(!z.error)this.zones=z.data.zones||[];}catch(e){}const r=await this.call('queue');this.requests=r.requests;this.legacy=r.legacy||[];this.enabled=r.enabled;this.config=r.config;this.selected=new Set([...this.selected].filter(id=>this.requests.some(a=>a.id===id)));}
 render(){const beforeMode=this.renderedMode;this.renderedMode=this.mode;this.$('.od-content').innerHTML=this.mode==='settings'?this.settings():this.mode==='one'||this.mode==='batch'?this.intake():this.mode==='review'?this.review():this.mode==='plan'?this.planView():this.queue();this.root.querySelectorAll('.od-tabs button').forEach(b=>b.setAttribute('aria-current',b.dataset.action===this.mode?'page':'false'));this.bind();if(beforeMode!==this.mode)this.$('.od-content').scrollTop=0;}
 intake(){const one=this.mode==='one';return `<div class="od-intro"><h3>${one?'Новая заявка на сбор':'Заявки из письма'}</h3><p>${one?'Дата и время появятся после подбора и согласования с клиентом.':'Скопируйте таблицу из письма партнёра и вставьте сюда — приложение разберёт адреса, телефоны и мешки.'}</p></div><label>Источник<select id="od-source">${sourceOptions(this.source)}</select></label>${this.mode==='batch'?'<label>Таблица из письма<textarea id="od-paste" rows="10" placeholder="Вставьте таблицу целиком. Также подходят строки с адресами или CSV."></textarea></label><button class="od-primary" data-action="parse">Разобрать и проверить</button>':`<div class="od-grid">${input('text','Полный адрес','','text','placeholder="Дом, улица, город, postcode"')}${input('phone','Мобильный телефон','','tel','placeholder="07…"')}${input('bags_text','Мешки — как в заявке','','text','placeholder="4 to 10"')}${input('not_before','Клиент доступен с','','date')}</div><input data-field="estimated_kg" data-num type="hidden" value="10"><input data-field="service_minutes" data-num type="hidden" value="5"><details><summary>Контакт и примечание</summary><div class="od-grid">${input('contact_name','Имя')}${input('contact_email','Email','','email')}</div><label>Примечание<textarea data-field="note" rows="2"></textarea></label></details><button class="od-primary" data-action="review-one">Проверить заявку</button>`}`;}
 review(){return `<div class="od-intro"><h3>Проверка · ${this.rows.length} ${this.rows.length===1?'заявка':'заявок'}</h3><p>Исправьте выделенные поля. Заявки без полного адреса или телефона добавить нельзя.</p></div>${this.rows.map((r,i)=>{const issues=C.issues(r,this.o.addresses?.()||this.requests,this.rows.slice(0,i));return `<article class="od-card ${issues.length?'od-invalid':''}" data-row="${i}"><div class="od-between"><b>${i+1}. ${esc(r.text)||'Без адреса'}</b><button data-action="remove-row" data-index="${i}" aria-label="Убрать заявку ${i+1}">Убрать</button></div><div class="od-row-issues" role="status">${issues.map(esc).join(' · ')}</div><div class="od-grid">${input('text','Адрес',r.text)}${input('phone','Телефон',r.phone,'tel')}${input('bags_text','Мешки',r.bags_text)}${input('not_before','Доступен с',r.not_before,'date')}<label>Источник<select data-field="intake_channel">${sourceOptions(r.intake_channel)}</select></label><label>Сбор<select data-field="service_minutes"><option value="5" ${+r.service_minutes!==10?'selected':''}>5 минут</option><option value="10" ${+r.service_minutes===10?'selected':''}>10 минут</option></select></label></div><input data-field="estimated_kg" data-num type="hidden" value="${esc(r.estimated_kg||10)}"><details><summary>Контакт и примечание из письма</summary><div class="od-grid">${input('contact_name','Имя',r.contact_name)}${input('contact_email','Email',r.contact_email,'email')}</div><textarea data-field="note" rows="2">${esc(r.note)}</textarea></details></article>`;}).join('')}<div class="od-footer"><button data-action="batch">Другой список</button><button class="od-primary" data-action="import">Добавить в очередь · ${this.rows.length}</button></div>`;}


 /* Готовый текст для партнёра: даты и интервалы так, как их назовут клиенту. */
 partnerList(list){
  const longDate=day=>{const d=new Date(day+'T12:00:00Z'),n=d.getUTCDate();
   const suf=n%100>=11&&n%100<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th');
   return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()]+' '+n+suf+' '
    +['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()];};
  const clock=m=>{const h=Math.floor(m/60);return (h%12||12)+':'+String(m%60).padStart(2,'0')+(h<12?'am':'pm');};
  const byDay=new Map();
  for(const a of list){const d=C.ukDay(a.held_start);if(!byDay.has(d))byDay.set(d,[]);byDay.get(d).push(a);}
  const out=['Hi, here are the collection times:',''];
  for(const day of [...byDay.keys()].sort()){
   out.push(longDate(day));
   for(const a of byDay.get(day).sort((x,y)=>C.ukMinute(x.held_start)-C.ukMinute(y.held_start)))
    out.push('- '+a.text+' - '+clock(C.ukMinute(a.held_start))+' to '+clock(C.ukMinute(a.held_end)));
   out.push('');
  }
  out.push('All times are UK time. Please confirm with the customers and let us know if any of these do not suit. Thank you.');
  return out.join('\n');
 }
 copyForPartner(){
  const {direct}=this.sendable();
  if(!direct.length){this.notice('Нет заявок от партнёра с назначенным временем. Сначала распределите и сохраните предложения.',true);return;}
  const text=this.partnerList(direct);
  const w=this.dialog('Текст для WhatsApp',
   `<p class="od-muted">${direct.length} ${direct.length===1?'адрес':'адресов'}. При копировании отметим их как отправленные — чтобы время случайно не сняли.</p>`
   +`<textarea id="od-wa-text" rows="14" readonly>${esc(text)}</textarea>`
   +`<div class="od-actions" style="margin-top:8px"><button id="od-wa-copy">Скопировать</button></div>`,null);
  w.querySelector('#od-wa-copy').onclick=async()=>{
   const b=w.querySelector('#od-wa-copy'),f=w.querySelector('#od-wa-text');b.disabled=true;
   const failed=[];
   for(const a of direct){try{await this.call('share',{address_id:a.id});}catch(e){failed.push(a.text);}}
   try{await navigator.clipboard.writeText(text);b.textContent='Скопировано';}
   catch{f.select();b.textContent='Выделено — нажмите Ctrl+C';}
   finally{b.disabled=false;}
   w.querySelector('.od-dialog-error').textContent=failed.length?'Не отмечены как отправленные: '+failed.join('; ')+'. Текст скопирован, но проверьте эти адреса.':'';
  };
 }
 /* Заявки, у которых уже зарезервировано время, но клиенту ещё ничего не ушло. */
 sendable(){
  const direct=[],sms=[],blocked=[];
  for(const a of this.requests){
   if(!a.hold_id||!a.held_start||a.date)continue;
   if(['preparing','awaiting','manual'].includes(a.offer_state))continue;
   const src=C.sourceOf(a);
   if(['partner_whatsapp','missing'].includes(src))direct.push(a);
   else if(/^\+447\d{9}$/.test(C.phone(a.phone||'')))sms.push(a);
   else blocked.push(a);
  }
  return {direct,sms,blocked,total:direct.length+sms.length};
 }
 slotText(a){return label(C.ukDay(a.held_start))+', '+C.hm(C.ukMinute(a.held_start))+'–'+C.hm(C.ukMinute(a.held_end));}
 sendAll(){
  const {direct,sms,blocked,total}=this.sendable();
  if(!total){this.notice('Нечего отправлять. Сначала распределите заявки по дням и сохраните предложения.',true);return;}
  const li=a=>`<li>${esc(a.text)} <span class="od-muted">· ${esc(this.slotText(a))}</span></li>`;
  const first=sms[0];
  const sample=first?Ops.offerText(first.collection_source,C.ukDay(first.held_start),C.hm(C.ukMinute(first.held_start)),C.hm(C.ukMinute(first.held_end)),(this.driver.name||'').trim()):'';
  this.dialog('Отправить предложения',
   (sms.length?`<p><b>${sms.length}</b> — уйдёт SMS с предложенным временем. Адрес встанет в маршрут после ответа YES.</p><ul>${sms.map(li).join('')}</ul>`
     +(sample?`<details><summary>Текст первой SMS</summary><textarea rows="9" readonly>${esc(sample)}</textarea></details>`:''):'')
   +(direct.length?`<p><b>${direct.length}</b> — от партнёра: сразу в маршрут, клиенту ничего не отправляется.</p><ul>${direct.map(li).join('')}</ul>`:'')
   +(blocked.length?`<p class="od-muted">Пропустим ${blocked.length}: нет британского мобильного — ${blocked.map(a=>esc(a.text)).join('; ')}</p>`:'')
   +(sms.length?`<label style="margin-top:10px"><input id="od-send-agree" type="checkbox"> Да, отправить ${sms.length} SMS живым клиентам</label>`:''),
   async w=>{
    if(sms.length&&!w.querySelector('#od-send-agree').checked)throw new Error('Отметьте подтверждение отправки.');
    await this.sendBatch(direct,sms);
   },'Отправить');
 }
 async sendOffer(a){
  if(!window.Ops?.api||!window.Ops.offerText)throw new Error('Модуль переписки не загружен. Обновите страницу.');
  const day=C.ukDay(a.held_start),start=C.hm(C.ukMinute(a.held_start)),end=C.hm(C.ukMinute(a.held_end));
  const name=(this.driver.name||'').trim();
  const body=Ops.offerText(a.collection_source,day,start,end,name);
  if(!body)throw new Error('Не удалось собрать текст предложения.');
  const thread=await Ops.api(this.sb,'create',{address_id:a.id});
  if(!thread?.thread_id)throw new Error('Не удалось открыть переписку по адресу.');
  const payload={thread_id:thread.thread_id,kind:'offer',body,day,start,end,version:a.collection_version,
   template:'wrc-v1',expected_source:a.collection_source,expected_driver_name:name,request_id:crypto.randomUUID()};
  Object.assign(payload,await preflight({...this.o,address:a},{dispatch:true,driver_id:this.driver.id,address_id:a.id,day,start,end},payload)||{});
  await Ops.api(this.sb,'send',payload);
 }
 async sendBatch(direct,sms){
  let routed=0,sent=0;const failed=[];
  for(let i=0;i<direct.length;i++){const a=direct[i];
   this.notice(`Ставлю в маршрут · ${i+1} из ${direct.length}`);
   try{await warm(this.o,C.ukDay(a.held_start),[a.id]);await this.call('confirm_partner',{address_id:a.id,agreed:true});routed++;}
   catch(e){failed.push(esc(a.text)+' — '+esc(error(e)));}
  }
  for(let i=0;i<sms.length;i++){const a=sms[i];
   this.notice(`Отправляю SMS · ${i+1} из ${sms.length}`);
   try{await this.sendOffer(a);sent++;}
   catch(e){failed.push(esc(a.text)+' — '+esc(error(e)));
    // Если не прошла самая первая — дело не в адресе. Останавливаемся, не рассылая ошибку дальше.
    if(i===0){failed.push('<b>Первая отправка не прошла — остальные не трогал.</b>');break;}}
  }
  await this.reload();this.render();await this.o.onChanged?.();
  const parts=[];if(sent)parts.push('отправлено '+sent);if(routed)parts.push('в маршрут '+routed);
  if(failed.length){
   this.notice((parts.join(', ')||'ничего не отправлено')+' · не прошло '+failed.length,true);
   this.dialog('Что не прошло','<ul>'+failed.map(f=>'<li>'+f+'</li>').join('')+'</ul>',null);
  }else this.notice(parts.join(', ')+'.');
 }
 available(a){return !a.hold_id&&!['preparing','awaiting','manual'].includes(a.offer_state)&&!a.date;}
 queue(){const free=this.requests.filter(a=>this.available(a)),shown=this.requests.slice(0,500),ready=this.sendable();
  const zcfg={zones:this.zones||[]};
  const state=a=>{if(a.held_start)return `<span class="od-slot">${label(C.ukDay(a.held_start))}, ${C.hm(C.ukMinute(a.held_start))}–${C.hm(C.ukMinute(a.held_end))}</span>`;
   if(a.offered_start)return `<span class="od-chip">Ждём YES · ${label(C.ukDay(a.offered_start))}</span>`;
   if(a.date)return '<span class="od-chip">В маршруте</span>';
   const z=C.zoneRule(zcfg,a.text);
   if(!z)return C.postcodeArea(a.text)?`<span class="od-chip" style="background:var(--crit-soft);color:var(--crit)">Район ${esc(C.postcodeArea(a.text))} не настроен</span>`:'<span class="od-chip" style="background:var(--crit-soft);color:var(--crit)">Неполный почтовый индекс</span>';
   if(z.mode==='off')return `<span class="od-chip">Район «${esc(z.name)}» выключен</span>`;
   if(z.mode==='monthly'){const d=C.nextTripDays(z,C.ukDay(),1)[0];return `<span class="od-chip" style="background:var(--far-soft);color:var(--far)">${esc(z.name)} · выезд ${d?label(d):'не задан'}</span>`;}
   return '<span class="od-muted">Ждёт распределения</span>';};
  const acts=a=>{const b=[];if(a.hold_id&&['partner_whatsapp','missing'].includes(C.sourceOf(a)))b.push(`<button data-action="partner" data-id="${a.id}">Согласовать</button>`);else if(a.hold_id||a.offer_state||a.date)b.push(`<button data-action="sms" data-id="${a.id}">SMS</button>`);if(a.hold_id&&!['preparing','awaiting','manual'].includes(a.offer_state))b.push(`<button data-action="release" data-id="${a.id}">Снять</button>`);if(this.available(a))b.push(`<button data-action="edit" data-id="${a.id}">Изменить</button>`);
   if(!['preparing','awaiting','manual'].includes(a.offer_state))b.push(`<button data-action="move" data-id="${a.id}">Перенести</button>`);
   b.push(`<button data-action="drop" data-id="${a.id}">Убрать</button>`);return b.join('');};
  return `<div class="od-intro od-between"><div><h3>Заявки без даты · ${this.requests.length}</h3><p>Отметьте адреса — приложение подберёт день и время, заполняя уже начатые дни вплотную к соседним адресам.</p></div><div class="od-actions"><button data-action="sendall" ${ready.total?'':'disabled data-locked="true"'}>Отправить предложения${ready.total?' · '+ready.total:''}</button>${ready.direct.length?`<button data-action="copypartner">Текст для WhatsApp · ${ready.direct.length}</button>`:''}<button data-action="refresh">Обновить</button></div></div>
  <details><summary>Искать места с ${label(this.from)}, на ${this.days} дней вперёд</summary><div class="od-grid"><label>Начиная с<input id="od-from" type="date" min="${C.ukDay()}" value="${this.from}"></label><label>Горизонт<select id="od-days"><option value="7" ${this.days===7?'selected':''}>7 дней</option><option value="14" ${this.days===14?'selected':''}>14 дней</option></select></label></div></details>
  ${this.requests.length>500?'<p class="od-warning">Показаны первые 500 заявок. Распределите их, затем обновите очередь.</p>':''}
  ${shown.length?`<div class="od-selection od-between"><label class="od-select"><input type="checkbox" id="od-all" ${free.length&&free.slice(0,40).every(a=>this.selected.has(a.id))?'checked':''}> Выбрать первые 40 свободных</label><b id="od-count">Выбрано: ${this.selected.size}</b></div>
  <div class="tscroll"><table class="t"><thead><tr><th style="width:34px"></th><th>Адрес</th><th>Источник</th><th>Мешки</th><th>Телефон</th><th>Состояние</th><th></th></tr></thead><tbody>${shown.map(a=>`<tr class="${this.selected.has(a.id)?'sel':''}" data-request="${esc(a.id)}"><td><input type="checkbox" data-select="${esc(a.id)}" ${this.selected.has(a.id)?'checked':''} ${this.available(a)?'':'disabled data-locked="true"'} aria-label="Выбрать заявку"></td><td class="addr"><b>${esc(a.text)}</b>${a.not_before?`<small>доступен с ${esc(label(a.not_before))}</small>`:''}${C.validPoint(a)?'':'<span class="warnrow">координаты определим перед расчётом</span>'}</td><td><span class="od-chip">${esc(C.sourceNames[C.sourceOf(a)])}</span>${a.charity?`<br><span class="od-muted" style="font-size:11.5px">${esc(a.charity)}</span>`:''}</td><td style="white-space:nowrap">${esc(a.bags_text||a.bags||'—')}</td><td class="mono" style="white-space:nowrap;font-size:12.3px">${esc(a.phone||'—')}</td><td>${state(a)}</td><td class="od-actions">${acts(a)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="od-empty">Очередь пуста. Добавьте один адрес или вставьте список из письма.</div>'}
  ${this.legacy.length?`<h3 style="margin-top:20px">Ранее переданные партнёрам</h3>${this.legacy.map(p=>`<article class="od-card od-between"><div><strong>${esc(p.address)}</strong><p class="od-muted">${label(C.ukDay(p.starts_at))} · ${C.hm(C.ukMinute(p.starts_at))}</p></div><button data-action="legacy" data-id="${p.id}">Партнёр подтвердил</button></article>`).join('')}`:''}
  <div class="od-footer"><span>Клиенту предлагается 30-минутное окно прибытия</span><button class="od-primary" data-action="calculate">Распределить по дням</button></div>`;}
 planView(){const m=this.plan.metrics,mm=v=>v>=60?Math.floor(v/60)+' ч '+(v%60?v%60+' мин':''):v+' мин';
  const days=this.plan.days.filter(d=>d.nodes.length),zcfg={zones:this.zones||[]};
  return `<div class="od-intro"><h3>Предложенный план</h3><p>Подтверждённые сборы не сдвигаются. При сохранении новые интервалы займут место до ответа клиента.</p>${m?`<div class="daystats" style="margin-top:12px"><div><div class="k">Распределено</div><div class="v">${m.assigned} <small>из ${m.assigned+m.unassigned}</small></div></div><div><div class="k">Дней занято</div><div class="v">${m.days_used}</div></div><div><div class="k">Дорога с запасом</div><div class="v">${mm(m.drive)}</div></div><div><div class="k">Простой в днях</div><div class="v">${mm(m.wait)}</div></div><div><div class="k">Общий интервал</div><div class="v">${m.shared||0} <small>соседних</small></div></div>${m.late?`<div><div class="k">Позже 7 дней</div><div class="v" style="color:var(--warn)">${m.late}</div></div>`:''}</div>`:''}</div>
  ${days.map(d=>{const trip=C.tripZoneOf(zcfg,d.day)||C.occupiedZoneOf(zcfg,d);return `<article class="od-card"><div class="od-between"><h3>${label(d.day)}${trip?` <span class="od-chip" style="background:var(--far-soft);color:var(--far)">выезд · ${esc(trip.name)}</span>`:''}</h3><b>${d.started_at?'Маршрут начат':d.fit.ok?d.fit.stops.length+' остановок'+(added=>added?' (+'+added+' новых)':'')(this.plan.assigned.filter(a=>a.day===d.day).length)+' · выезд '+C.hm(d.fit.departure)+', склад '+C.hm(d.fit.finish):'Требует внимания'}</b></div>${d.fit.ok?`<p class="od-muted">Дорога с запасом ${d.fit.drive} мин · сборы ${d.fit.service} мин · простой ${d.fit.wait??0} мин</p><ol class="od-stops">${d.fit.stops.map((stop,si)=>{const n=d.nodes.find(n=>n.key===stop.key),fresh=this.plan.assigned.some(a=>a.address_id===stop.address_id);const p=si?d.nodes.find(x=>x.key===d.fit.stops[si-1].key):null,together=p&&String(slotOf(p))===String(slotOf(n));return `<li><div><strong>${esc(stop.text)}</strong><small>${fresh?'<span class="od-slot">Новая заявка</span> · ':n.kind==='confirmed'?'Подтверждено · ':'Ожидаем ответ · '}${arrivalLabel(n)}${together?' · <span class="od-slot">вместе с предыдущим</span>':''}${stop.wait?' · простой '+stop.wait+' мин':''}</small></div><b>≈ ${C.hm(stop.arrival)}</b></li>`;}).join('')}</ol>`:`<p class="od-warning">${esc(error({code:d.fit.code,detail:d.fit}))}</p>`}</article>`;}).join('')}
  ${this.plan.unassigned.length?`<article class="od-card"><h3>Останутся в очереди · ${this.plan.unassigned.length}</h3>${this.plan.unassigned.map(a=>`<p><b>${esc(this.requests.find(r=>r.id===a.address_id)?.text||'')}</b><br><span class="od-muted">${esc(a.reason)}</span></p>`).join('')}</article>`:''}
  <div class="od-footer"><button data-action="queue">Вернуться к заявкам</button><button class="od-primary" data-action="reserve" ${this.plan.assigned.length?'':'disabled data-locked="true"'}>Сохранить предложения · ${this.plan.assigned.length}</button></div>`;}
 settings(){const c={capacity_kg:1500,travel_factor:1.2,leg_buffer_minutes:5,zone_penalty_minutes:12,day_penalty_minutes:2,home:this.o.home||{},depot:this.o.depot||{},...this.config,reserve_kg:0,reserve_minutes:0};
  const pt=(k,title,hint)=>{const p=c[k]||{},ok=C.validPoint(p);return `<fieldset data-point="${k}"><legend>${title}</legend><label>Адрес или почтовый индекс<input data-field="text" value="${esc(p.text||'')}" placeholder="${hint}"></label><input type="hidden" data-field="lat" data-num value="${p.lat??''}"><input type="hidden" data-field="lng" data-num value="${p.lng??''}"><div class="od-actions" style="margin-top:10px">${ok?`<span class="od-chip">✓ точка найдена</span><a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}" target="_blank" rel="noopener">Проверить на карте</a>`:'<span class="od-muted">Координаты найдутся автоматически при сохранении</span>'}</div></fieldset>`;};
  return `<div class="od-intro"><h3>Старт и склад</h3><p>Откуда водитель выезжает утром и куда возвращается вечером. Часы прибытия к клиентам задаются в разделе «Часы и доступ».</p></div>
  ${pt('home','Старт маршрута','Например: NP13 1DF')}${pt('depot','Склад — конец маршрута','Например: CF43 4SX')}
  <div id="od-config" hidden>${['capacity_kg','reserve_kg','reserve_minutes','travel_factor','leg_buffer_minutes','zone_penalty_minutes','day_penalty_minutes'].map(k=>`<input type="hidden" data-field="${k}" data-num value="${c[k]}">`).join('')}</div>
  <p class="od-muted">Ограничений по весу и свободному времени нет: день заполняется полностью, пока успевают дорога, сборы и рабочие часы. К расчётному времени в пути добавляется 20% и 5 минут на каждый переезд.</p>
  <div class="od-actions"><button class="od-primary" data-action="save-settings">Сохранить</button><button data-action="health">Проверить сервис дорог</button></div>`;}
 bind(){this.$('#od-paste')?.addEventListener('paste',e=>{this.pasteHtml=e.clipboardData?.getData('text/html')||'';});this.$('#od-paste')?.addEventListener('input',e=>{if(e.inputType!=='insertFromPaste')this.pasteHtml='';});this.$('#od-source')?.addEventListener('change',e=>this.source=e.target.value);this.$('#od-from')?.addEventListener('change',e=>this.from=e.target.value);this.$('#od-days')?.addEventListener('change',e=>this.days=+e.target.value);this.root.querySelectorAll('[data-select]').forEach(el=>el.onchange=()=>{if(el.checked&&this.selected.size>=40){el.checked=false;this.notice(errors.BATCH_LIMIT_40,true);return;}el.checked?this.selected.add(el.dataset.select):this.selected.delete(el.dataset.select);this.$('#od-count').textContent='Выбрано: '+this.selected.size;});this.$('#od-all')?.addEventListener('change',e=>{this.selected=new Set(e.target.checked?this.requests.filter(a=>this.available(a)).slice(0,40).map(a=>a.id):[]);this.render();});this.root.querySelectorAll('[data-row] [data-field]').forEach(el=>el.onchange=()=>{this.syncRows();this.updateIssues();});}
 fields(parent){return Object.fromEntries([...parent.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.type==='number'||el.dataset.num!==undefined||el.dataset.field==='service_minutes'?Number(el.value):el.value]));}
 syncRows(){this.root.querySelectorAll('[data-row]').forEach(box=>Object.assign(this.rows[+box.dataset.row],this.fields(box)));}
 updateIssues(){this.root.querySelectorAll('[data-row]').forEach(box=>{const i=+box.dataset.row,issues=C.issues(this.rows[i],this.o.addresses?.()||this.requests,this.rows.slice(0,i));box.classList.toggle('od-invalid',issues.length>0);box.querySelector('.od-row-issues').textContent=issues.join(' · ');});}
 async locate(text){const pc=C.postcode(text);if(!pc)throw new Error('Нужен полный postcode.');const r=await fetch('https://api.postcodes.io/postcodes/'+encodeURIComponent(pc),{signal:AbortSignal.timeout(12000)});const j=await r.json();if(!r.ok||!j.result)throw new Error('Индекс не найден. Проверьте адрес или введите координаты вручную.');return {lat:j.result.latitude,lng:j.result.longitude,geocode_source:'postcode'};}
 async calculate(){online(this.o);if(!this.selected.size)throw new Error('Выберите хотя бы одну свободную заявку.');if(!C.validPoint(this.config.home)||!C.validPoint(this.config.depot)){this.mode='settings';this.render();throw new Error('SETTINGS_REQUIRED');}const ids=[...this.selected];for(const id of ids){const a=this.requests.find(r=>r.id===id);if(!this.available(a))throw new Error('REQUEST_RESERVED');if(!C.validPoint(a)){this.notice('Определяю координаты: '+a.text);const p=await this.locate(a.text);await this.call('edit_request',{address_id:a.id,...p});Object.assign(a,p);}}
 let snap=await this.call('snapshot',{from_day:this.from,days:this.days,address_ids:ids});let roads={};const skipped=[];
 for(let i=0;i<snap.days.length;i++){const d=snap.days[i];if(d.started_at||d.hours?.closed)continue;this.notice(`Рассчитываю дорогу · ${i+1}/${snap.days.length} · ${label(d.day)}`);try{Object.assign(roads,(await warm(this.o,d.day,ids)).roads);}catch(e){skipped.push({day:d.day,error:error(e)});}}
 snap=await this.call('snapshot',{from_day:this.from,days:this.days,address_ids:ids});this.tokens=Object.fromEntries(snap.days.map(d=>[d.day,d.token]));this.notice('Распределяю заявки вокруг договорённостей…');this.plan=await C.planBatch(snap.days,snap.requests,{...snap.config,zones:this.zones||[]},roads,(n,total)=>this.notice(`Подобрано ${n} из ${total}`));this.reserveId=crypto.randomUUID();this.mode='plan';this.render();this.notice(skipped.length?'Некоторые дни не рассчитаны: '+skipped.map(d=>label(d.day)+' — '+d.error).join(' '):this.plan.assigned.length?'Проверьте порядок и время перед сохранением.':'Подходящих мест пока нет. Измените горизонт поиска или проверьте проблемные дни.',!!skipped.length);}
 dialog(title,body,onSave,saveLabel='Сохранить'){this.$('.od-dialog')?.remove();const wrap=document.createElement('div');wrap.className='od-dialog';wrap.innerHTML=`<section role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${body}<p class="od-dialog-error" role="alert"></p><div class="od-actions"><button class="od-dialog-cancel">Закрыть</button>${onSave?`<button class="od-dialog-save od-primary">${saveLabel}</button>`:''}</div></section>`;this.root.append(wrap);wrap.querySelector('.od-dialog-cancel').onclick=()=>{if(!this.modalBusy)wrap.remove();};if(onSave)wrap.querySelector('.od-dialog-save').onclick=async()=>{const btn=wrap.querySelector('.od-dialog-save');if(this.modalBusy)return;this.modalBusy=true;btn.disabled=true;try{await onSave(wrap);wrap.remove();}catch(e){wrap.querySelector('.od-dialog-error').textContent=error(e);btn.disabled=false;}finally{this.modalBusy=false;}};wrap.querySelector('input,textarea,button')?.focus();return wrap;}
 /* Перенос заявки: другая дата или возврат в очередь. Подтверждённое время
    двигается только с явной отметкой, что клиент согласовал перенос. */
 moveRequest(a){
  const confirmed=!!a.collection_start,day=a.date||(a.held_start?C.ukDay(a.held_start):''),
        start=a.held_start?C.hm(C.ukMinute(a.held_start)):'09:00';
  const w=this.dialog('Перенести заявку',`<p><b>${esc(a.text)}</b></p>
   ${confirmed?`<p class="od-muted">Сейчас согласовано: ${esc(label(a.date))}, ${esc(C.hm(C.ukMinute(a.collection_start)))}.</p>`:a.date?`<p class="od-muted">Сейчас в маршруте на ${esc(label(a.date))}.</p>`:''}
   <label>Куда<select id="od-move-mode"><option value="day">На другую дату и время</option><option value="queue">Вернуть в очередь без даты</option></select></label>
   <div class="od-grid" id="od-move-slot"><label>Дата<input id="od-move-date" type="date" min="${C.ukDay()}" value="${esc(day)}"></label><label>Время прибытия<input id="od-move-start" type="time" step="300" value="${esc(start)}"></label></div>
   <label id="od-move-nbwrap" hidden>Не раньше<input id="od-move-nb" type="date" min="${C.ukDay()}"></label>
   <p class="od-muted" id="od-move-help">Клиенту обещается интервал 30 минут. Новое место проверяется по дороге, рабочим часам и дню выезда зоны.</p>
   ${confirmed?'<label><input id="od-move-agreed" type="checkbox">Клиент согласовал перенос.</label>':''}`,
   async wrap=>{
    const queued=wrap.querySelector('#od-move-mode').value==='queue';
    if(confirmed&&!wrap.querySelector('#od-move-agreed').checked)throw new Error('CONFIRMED_CHANGE_REQUIRES_AGREEMENT');
    const data={address_id:a.id,version:a.collection_version,agreed:confirmed};
    if(queued){data.to_queue=true;data.not_before=wrap.querySelector('#od-move-nb').value||null;}
    else{
     const d=wrap.querySelector('#od-move-date').value,st=wrap.querySelector('#od-move-start').value;
     if(!d||!st)throw new Error('SLOT_INVALID');
     const m=C.minute(st);if(!Number.isFinite(m)||m+30>1440)throw new Error('SLOT_INVALID');
     Object.assign(data,{day:d,start:st,end:C.hm(m+30)});
     online(this.o);try{await warm(this.o,d,[a.id]);}catch(e){}
    }
    const r=await this.sb.rpc('subnex_move_request',{p_data:data});
    if(r.error)throw r.error;
    await this.reload();this.render();
    this.notice(queued?'Заявка вернулась в очередь — подберите время заново.':'Заявка перенесена.');
    await this.o.onChanged?.();
   },'Перенести');
  const mode=w.querySelector('#od-move-mode'),slot=w.querySelector('#od-move-slot'),nb=w.querySelector('#od-move-nbwrap'),help=w.querySelector('#od-move-help');
  mode.onchange=()=>{const q=mode.value==='queue';slot.hidden=q;nb.hidden=!q;
   help.textContent=q?'Дата снимется, заявка вернётся в очередь. Планировщик подберёт день заново.':'Клиенту обещается интервал 30 минут. Новое место проверяется по дороге, рабочим часам и дню выезда зоны.';};
 }
 /* Убрать заявку из базы. Это не «закрыть сбор»: история и переписка не сохраняются,
    поэтому для заявок с перепиской путь один — «Переписка → Закрыть заявку». */
 dropRequest(a){
  this.dialog('Убрать заявку',`<p><b>${esc(a.text)}</b></p>
   <p class="od-muted">Заявка исчезнет из базы вместе с фотографиями и заметками. Отменить это нельзя.</p>
   <p class="od-muted">Если клиенту что-то обещали или по адресу есть переписка — закройте заявку в разделе «Переписка» кнопкой «Закрыть заявку»: тогда история останется, а клиент получит SMS об отмене.</p>
   <label><input id="od-drop-sure" type="checkbox">Удалить эту заявку навсегда.</label>`,
   async wrap=>{
    if(!wrap.querySelector('#od-drop-sure').checked)throw new Error('Отметьте подтверждение удаления.');
    const {error}=await this.sb.from('addresses').delete().eq('id',a.id);
    if(error)throw new Error('Не удалось удалить: у заявки есть переписка или подтверждённый сбор. Закройте её в разделе «Переписка» кнопкой «Закрыть заявку».');
    await this.reload();this.render();this.notice('Заявка удалена.');await this.o.onChanged?.();
   },'Удалить');
 }
 partner(a){const text=`We can collect from ${a.text} on ${new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(C.ukDay(a.held_start)+'T12:00:00Z'))}, between ${C.hm(C.ukMinute(a.held_start))} and ${C.hm(C.ukMinute(a.held_end))} (UK time). Please confirm with the customer and let us know if this is suitable. Thank you.`;const w=this.dialog('Согласование с партнёром',`<textarea id="od-partner-text" rows="5" readonly>${esc(text)}</textarea><button id="od-copy">Скопировать для WhatsApp</button><p class="od-muted">Интервал уже зарезервирован. После ответа партнёра отметьте подтверждение.</p><label><input id="od-partner-agreed" type="checkbox">Партнёр подтвердил именно эти дату и интервал.</label>`,async w=>{if(!w.querySelector('#od-partner-agreed').checked)throw new Error('AGREEMENT_REQUIRED');online(this.o);await warm(this.o,C.ukDay(a.held_start),[a.id]);await this.call('confirm_partner',{address_id:a.id,agreed:true});await this.reload();this.render();this.notice('Подтверждено. Адрес добавлен в маршрут.');await this.o.onChanged?.();},'Добавить подтверждённый сбор');w.querySelector('#od-copy').onclick=async()=>{const b=w.querySelector('#od-copy');b.disabled=true;try{await warm(this.o,C.ukDay(a.held_start),[a.id]);await this.call('share',{address_id:a.id});await navigator.clipboard.writeText(text);b.textContent='Текст скопирован';a.shared_at=new Date().toISOString();}catch(e){w.querySelector('.od-dialog-error').textContent=error(e);w.querySelector('textarea').select();}finally{b.disabled=false;}};}
 action(act,b){if(this.busy)return;if(act==='close'){this.close();return;}if(['queue','one','batch','settings'].includes(act)){this.mode=act;this.notice('');this.render();return;}const a=this.requests.find(a=>a.id===b.dataset.id);
 if(act==='parse'){const text=this.$('#od-paste').value;this.rows=C.parseRows(text,this.pasteHtml,this.source);if(!this.rows.length||this.rows.length>200){this.notice('Вставьте от 1 до 200 заявок.',true);return;}this.importId=crypto.randomUUID();this.mode='review';this.render();return;}
 if(act==='review-one'){this.rows=[{...this.fields(this.$('.od-content')),intake_channel:this.source}];this.importId=crypto.randomUUID();this.mode='review';this.render();return;}
 if(act==='remove-row'){this.syncRows();this.rows.splice(+b.dataset.index,1);this.importId=crypto.randomUUID();this.render();return;}
 if(act==='partner'){this.partner(a);return;}
 if(act==='edit'){const ok=C.validPoint(a);this.dialog('Изменить заявку',`<p><b>${esc(a.text)}</b></p><div class="od-grid">${input('not_before','Клиент доступен начиная с',a.not_before,'date')}<label>Сбор на адресе<select data-field="service_minutes"><option value="5" ${a.service_minutes!==10?'selected':''}>5 минут</option><option value="10" ${a.service_minutes===10?'selected':''}>10 минут</option></select></label></div><input data-field="estimated_kg" data-num type="hidden" value="${esc(a.estimated_kg||10)}"><p class="od-muted">Точка на карте: ${ok?`определена${a.geocode_source==='postcode'?' по почтовому индексу — это центр индекса, дом может быть в стороне':''}. <a href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=18/${a.lat}/${a.lng}" target="_blank" rel="noopener">Проверить</a>`:'не определена — найдём автоматически перед расчётом.'}</p>`,async w=>{const data=this.fields(w);delete data.lat;delete data.lng;await this.call('edit_request',{address_id:a.id,...data});await this.reload();this.render();this.notice('Заявка обновлена.');});return;}
 if(act==='move'){this.moveRequest(a);return;}
 if(act==='drop'){this.dropRequest(a);return;}
 if(act==='release'){this.dialog('Снять предложение',`<p>${esc(a.text)}</p><label><input id="od-withdrawn" type="checkbox">${a.shared_at?'Я отозвал это время у партнёра.':'Предложение ещё не передано клиенту или уже отозвано.'}</label>`,async w=>{if(!w.querySelector('#od-withdrawn').checked)throw new Error('PARTNER_WITHDRAWAL_REQUIRED');await this.call('release',{address_id:a.id,acknowledged:true});await this.reload();this.render();},'Снять предложение');return;}
 if(act==='legacy'){const p=this.legacy.find(p=>p.id===b.dataset.id);this.dialog('Подтвердить прежнее предложение',`<p>${esc(p.address)} · ${label(C.ukDay(p.starts_at))} ${C.hm(C.ukMinute(p.starts_at))}</p><label><input id="od-legacy-agreed" type="checkbox">Партнёр подтвердил эту дату и время.</label>`,async w=>{if(!w.querySelector('#od-legacy-agreed').checked)throw new Error('AGREEMENT_REQUIRED');await warm(this.o,C.ukDay(p.starts_at));await this.call('legacy_confirm',{id:p.id,agreed:true});await this.reload();this.render();await this.o.onChanged?.();},'Подтвердить');return;}
 if(act==='sendall'){this.sendAll();return;}
 if(act==='copypartner'){this.copyForPartner();return;}
 if(act==='sms'){const plan=a.held_start?{dispatch:true,driver_id:this.driver.id,address_id:a.id,day:C.ukDay(a.held_start),start:C.hm(C.ukMinute(a.held_start)),end:C.hm(C.ukMinute(a.held_end))}:null;if(!this.inline)this.close();if(this.o.onChoose&&plan)this.o.onChoose(plan);else this.o.onSms?.(a.id,plan);return;}
 this.run(async()=>{if(act==='refresh'){await this.reload();this.render();this.notice('Список обновлён.');}
 else if(act==='import'){online(this.o);this.syncRows();if(!this.rows.length)throw new Error('В списке нет заявок.');const issues=this.rows.flatMap((r,i)=>C.issues(r,this.o.addresses?.()||this.requests,this.rows.slice(0,i)).map(m=>`${i+1}: ${m}`));if(issues.length){this.updateIssues();throw new Error(issues.join('\n'));}const rows=this.rows.map(({raw,row,...r})=>r);const signature=JSON.stringify(rows);if(this.importSignature&&this.importSignature!==signature)this.importId=crypto.randomUUID();this.importSignature=signature;const r=await this.call('import',{request_id:this.importId,rows});this.selected=new Set(r.ids.slice(0,40));await this.reload();this.mode='queue';this.render();this.notice(`Добавлено: ${r.imported}. Теперь можно подобрать время.`);await this.o.onChanged?.();}
 else if(act==='calculate')await this.calculate();
 else if(act==='reserve'){online(this.o);const orders=Object.fromEntries(this.plan.days.map(d=>[d.day,d.order]));const assignments=this.plan.assigned.map(({address_id,day,start,end,request_token})=>({address_id,day,start,end,request_token}));await this.call('reserve_plan',{request_id:this.reserveId,assignments,orders,tokens:this.tokens});await this.reload();this.mode='queue';this.render();this.notice('Предложения сохранены. Откройте SMS или скопируйте время для партнёра.');await this.o.onChanged?.();}
 else if(act==='save-settings'){const content=this.$('.od-content'),fields=this.fields(content),config={};for(const k of ['capacity_kg','travel_factor','leg_buffer_minutes','zone_penalty_minutes','day_penalty_minutes'])config[k]=fields[k];config.reserve_kg=0;config.reserve_minutes=0;config.capacity_kg=1600;config.zone_penalty_minutes=0;
  for(const k of ['home','depot']){const box=this.$('[data-point='+k+']'),text=box.querySelector('[data-field=text]').value.trim();if(!text)throw new Error('Укажите адрес старта и склада.');const point=this.fields(box);if(!C.validPoint(point)||text!==(this.config?.[k]?.text||'')){this.notice('Ищу точку: '+text);const found=await this.locate(text);config[k]={text,lat:found.lat,lng:found.lng};}else config[k]={text,lat:point.lat,lng:point.lng};}
  const r=await this.call('save_settings',{config});this.config=r.config;this.render();this.notice('Старт и склад сохранены.');}
 else if(act==='locate-point'){const box=this.$('fieldset[data-point='+b.dataset.point+']'),p=await this.locate(box.querySelector('[data-field=text]').value);box.querySelector('[data-field=lat]').value=p.lat;box.querySelector('[data-field=lng]').value=p.lng;this.notice('Найдена точка по postcode. Проверьте старт или склад на карте и сохраните параметры.');}
 else if(act==='health'){const r=await edge(this.sb,{action:'health',driver_id:this.driver.id});this.notice('Сервис дорог подключён: '+r.provider+'.');}
 },act==='calculate'?'Начинаю расчёт…':'Выполняю…');}
}
root.OpsDispatch={open:async o=>{if(!o.driver?.id)throw new Error('Выберите водителя.');if(o.mount){const d=new Dispatch(o);await d.start();return d;}if(instance)instance.close();if(instance)return;instance=new Dispatch(o);await instance.start();return instance;},close:()=>instance?.close(),rpc,edge,warm,preflight,routeDay,startDay,error,core:C};
})(window);
