/* SUBNEX chat. No Twilio secrets in this file. All actions are checked by subnex-sms. */
(function(){
'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const codes={ACCESS_DENIED:'Нет доступа. Администратор должен назначить ваш аккаунт и водителя.',LOGIN_REQUIRED:'Войдите в аккаунт заново.',NOT_CONFIGURED:'Сервер ещё не настроен. Проверьте установку по инструкции.',UK_MOBILE_REQUIRED:'Укажите британский мобильный номер, например 07446 932887.',ADDRESS_REQUIRED:'Сначала привяжите адрес сбора к переписке.',DRIVER_REQUIRED:'Назначьте активного водителя.',SLOT_CONFLICT:'Этот промежуток уже занят или предложен другому клиенту. Выберите свободное время.',SLOT_IN_PAST:'Выберите будущую дату и время.',OUTSIDE_WORKING_HOURS:'Время выходит за рабочий график. Проверьте дату и часы.',SLOT_INVALID:'Проверьте дату и время.',STALE_ADDRESS:'Адрес или назначение изменились. Обновите переписку и проверьте время заново.',AGREEMENT_REQUIRED:'Подтвердите, что клиент согласовал дату и время.',CONFIRMED_CHANGE_REQUIRES_AGREEMENT:'Для переноса нужно отдельное согласие клиента.',USE_CHAT_TO_RESCHEDULE:'Согласованный срок защищён. Переносите его через подтверждение в SMS-чате.',ALREADY_SCHEDULED_USE_MANUAL:'Сбор уже запланирован. Для изменения используйте ручное подтверждение.',OPTED_OUT:'Клиент отказался от SMS. Отправка заблокирована до его START.',MESSAGE_LENGTH:'Введите от 1 до 1000 символов.',RATE_LIMIT:'Достигнут лимит отправки. Попробуйте позже.',REQUEST_ID_REUSED:'Запрос уже использован с другим текстом. Обновите переписку.',RECENT_DUPLICATE:'Такое сообщение уже отправлялось в последнюю минуту.',PHONE_HAS_ACTIVE_REQUEST:'На этот номер уже есть активная заявка. Откройте её переписку.',CREATE_AUTH_USER_FIRST:'Сначала создайте и подтвердите пользователя в Supabase → Authentication → Users.',CANNOT_DISABLE_YOURSELF:'Нельзя отключить или понизить собственный аккаунт.',DATABASE_ERROR:'Сервер не сохранил действие. Обновите экран и проверьте данные.',SERVICE_UNAVAILABLE:'Нет подтверждения от сервера. Обновите историю перед повторной отправкой.',NETWORK:'Нет подтверждения от сервера. Текст сохранён в этом окне; повтор использует тот же номер запроса.'};
const errText=e=>codes[e?.code||e?.message]||e?.message||'Не удалось выполнить действие.';
async function api(sb,action,data={}){
  const {data:result,error}=await sb.functions.invoke('subnex-sms',{body:{action,data}});
  if(error){let code='NETWORK';try{const j=await error.context.json();code=j.error||code;}catch{}
    const e=new Error(codes[code]||'Ошибка запроса: '+code);e.code=code;throw e;}
  if(result?.error){const e=new Error(codes[result.error]||result.error);e.code=result.error;throw e;}
  return result;
}
const photoCache=new Map();
async function signPhotos(sb,paths){
 const missing=[...new Set(paths)].filter(p=>p&&(!photoCache.has(p)||photoCache.get(p).expires<Date.now()));
 for(let offset=0;offset<missing.length;offset+=100){
   const {data,error}=await sb.storage.from('photos').createSignedUrls(missing.slice(offset,offset+100),3600);
   if(error) continue;
   (data||[]).forEach(x=>{if(x.signedUrl)photoCache.set(x.path,{url:x.signedUrl,expires:Date.now()+3300000});});
 }
}
const photoUrl=p=>photoCache.get(p)?.url||'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const ukDate=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d||Date.now()));
const ukTime=d=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'}).format(new Date(d));
const slotLabel=a=>a?.collection_start?ukDate(a.collection_start)+' · '+ukTime(a.collection_start)+'–'+ukTime(a.collection_end)+' UK':'';
const sources={subnex:'SUBNEX Collections',partner:'Partner Collections',missing:'Missing Collections'};
function partnerOffer(day,start,end,name){
 const d=new Date(day+'T12:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||isNaN(d)||d.toISOString().slice(0,10)!==day||!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end))return '';
 const n=d.getUTCDate(),suffix=n%100>=11&&n%100<=13?'th':({1:'st',2:'nd',3:'rd'}[n%10]||'th');
 const date=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()]+' '+n+suffix+' '+['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()]+' '+d.getUTCFullYear();
 const clock=t=>{const [h,m]=t.split(':').map(Number);return (h%12||12)+':'+String(m).padStart(2,'0')+(h<12?'am':'pm');};
 return "Good afternoon,\n\nI'm your We Recycle Clothes driver, here to collect your clothing donation.\n\nI can collect on "+date+", between "+clock(start)+" and "+clock(end)+".\n\nPlease reply YES to confirm, or let me know if you'd prefer a different day or time.\n\nThank you, and see you then!\n"+(name?.trim()?name.trim()+'\n':'')+'We Recycle Clothes';
}
const statuses={received:'Получено',dispatching:'Отправка начата — ожидаем статус',unknown:'Результат неизвестен — проверьте Twilio',accepted:'Принято Twilio',queued:'В очереди',sending:'Отправляется',sent:'Отправлено оператору',delivered:'Доставлено',read:'Прочитано',failed:'Ошибка отправки',undelivered:'Не доставлено',canceled:'Отменено'};
let current=null;
function close(){current?.close();current=null;}
async function open(options){close();current=new Chat(options);await current.start();return current;}
class Chat{
 constructor(o){this.o=o;this.sb=o.sb;this.profile=o.profile;this.admin=o.profile.role==='admin';this.threadId=null;this.data=null;this.mode='reply';this.drafts=new Map();this.offset=0;this.sendBusy=false;this.closed=false;this.listLoading=false;this.detailLoading=false;this.oldFocus=document.activeElement;}
 $(s){return this.root.querySelector(s);} 
 async call(action,data={}){return api(this.sb,action,data);}
 notice(s){if(this.closed)return;const n=this.$('.oc-notice');n.textContent=s||'';n.classList.toggle('on',!!s);}
 async run(fn){try{return await fn();}catch(e){this.notice(errText(e));return null;}}
 drivers(){return (this.o.drivers?.()||[]).filter(d=>d.active!==false);}
 driverOptions(selected=''){return '<option value="">Не назначен</option>'+this.drivers().map(d=>`<option value="${esc(d.id)}" ${d.id===selected?'selected':''}>${esc(d.name)}</option>`).join('');}
 async start(){
  this.root=document.createElement('div');this.root.className='ops-root';this.root.setAttribute('role','dialog');this.root.setAttribute('aria-modal','true');this.root.setAttribute('aria-label','SUBNEX SMS');
  this.root.innerHTML=`<header class="oc-top"><div class="oc-brand">SUBNEX <span style="color:#ffc400">SMS</span><small>Переписка и сборы</small></div><nav>${this.admin?'<button data-act="settings">График и доступ</button>':''}<button data-act="close">Закрыть ×</button></nav></header><div class="oc-notice" role="status"></div><div class="oc-body"><aside class="oc-side"><div class="oc-filters"><div class="oc-row oc-between"><b>Переписки</b><button class="oc-primary" data-act="new">+ Новая</button></div><input id="oc-search" type="search" placeholder="Телефон или адрес" aria-label="Поиск переписки"><select id="oc-source" aria-label="Категория"><option value="">Все категории</option>${Object.entries(sources).map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select>${this.admin?`<select id="oc-driver-filter" aria-label="Водитель"><option value="">Все водители</option>${this.driverOptions().replace('<option value="">Не назначен</option>','')}</select>`:''}<label><input type="checkbox" id="oc-attention">Требуют внимания</label></div><div class="oc-list"><div class="oc-empty">Загрузка…</div></div><div class="oc-row" style="padding:10px"><button data-act="prev">←</button><span class="oc-page oc-muted"></span><button data-act="next">→</button><button data-act="refresh">Обновить</button></div></aside><main class="oc-conversation"><div class="oc-empty"><strong>Каждая договорённость — в истории</strong>Выберите переписку или создайте запрос на сбор.</div></main></div>`;
  document.body.append(this.root);this.previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
  this.root.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled)this.action(b.dataset.act,b);});
  this.root.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();if(this.$('.oc-modal-wrap'))this.$('.oc-modal-wrap').remove();else this.close();}if(e.key==='Tab'){const focus=[...this.root.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);if(!focus.length)return;const first=focus[0],last=focus.at(-1);if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();}else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();}}});
  for(const id of ['#oc-source','#oc-attention','#oc-driver-filter'])this.$(id)?.addEventListener('change',()=>{this.offset=0;this.loadList();});
  this.$('#oc-search').addEventListener('input',()=>{clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>{this.offset=0;this.loadList();},350);});
  this.$('#oc-search').focus();await this.loadList();
  if(this.o.addressId)await this.run(async()=>{const t=await this.call('create',{address_id:this.o.addressId});await this.select(t.thread_id);});
  this.timer=setInterval(()=>{if(!document.hidden&&!this.closed&&!this.sendBusy){this.loadList();if(this.threadId)this.loadDetail();}},8000);
 }
 close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);clearTimeout(this.searchTimer);this.root?.remove();document.body.style.overflow=this.previousOverflow||'';this.oldFocus?.focus();this.o.onChanged?.();}
 async loadList(){if(this.listLoading||this.closed)return;this.listLoading=true;try{
  const result=await this.call('list',{search:this.$('#oc-search').value,source:this.$('#oc-source').value,attention:this.$('#oc-attention').checked,driver_id:this.$('#oc-driver-filter')?.value||'',limit:60,offset:this.offset});
  if(this.closed)return;this.hasNext=result.threads.length>60;const list=result.threads.slice(0,60);
  this.$('.oc-list').innerHTML=list.map(t=>`<button data-act="thread" data-id="${esc(t.id)}" class="oc-thread ${t.id===this.threadId?'active':''}"><strong>${t.needs_attention?'<span class="oc-dot"></span>':''}${esc(t.phone)}</strong><p>${esc(t.address||'Адрес не привязан')}</p><p>${esc(t.last_body||'Сообщений пока нет')}</p><small>${t.date?'В маршруте · '+esc(t.date):t.offer_state==='awaiting'?'Ожидаем YES':'Согласование'} · ${esc(ukTime(t.last_activity))}</small></button>`).join('')||'<div class="oc-empty">Переписок по этому фильтру нет.</div>';
  this.$('[data-act=prev]').disabled=this.offset===0;this.$('[data-act=next]').disabled=!this.hasNext;this.$('.oc-page').textContent=String(1+this.offset/60);
 }catch(e){this.notice(errText(e));}finally{this.listLoading=false;}}
 rememberDraft(){const b=this.$('#oc-body');if(b&&this.threadId){this.drafts.set(this.threadId,{mode:this.mode,body:b.value,day:this.$('#oc-day')?.value,start:this.$('#oc-start')?.value,end:this.$('#oc-end')?.value});}}
 async select(id){if(this.sendBusy)return;this.rememberDraft();this.threadId=id;this.data=null;this.root.classList.add('oc-selected');this.$('.oc-conversation').innerHTML='<div class="oc-empty">Загрузка переписки…</div>';await this.loadDetail(true);this.loadList();}
 async loadDetail(reset=false){if(!this.threadId||this.detailLoading||this.closed)return;this.detailLoading=true;const id=this.threadId;
  try{const data=await this.call('detail',{thread_id:id});if(this.closed||id!==this.threadId)return;
   if(!reset&&this.data?.thread.id===id)data.messages=[...new Map([...this.data.messages,...data.messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
   this.data=data;
   if(reset||!this.$('.oc-messages')){this.$('.oc-conversation').innerHTML='<div class="oc-head"></div><div class="oc-messages" aria-label="История сообщений"></div><div class="oc-compose"></div>';let draft=this.drafts.get(id);if(!draft){try{const pending=JSON.parse(sessionStorage.getItem('subnex_sms_pending_'+this.profile.user_id+'_'+id)||'null');if(pending){const payload=JSON.parse(pending.signature);draft={...payload,mode:payload.kind};}}catch{}}this.mode=draft?.mode||'reply';this.compose(draft);}
   this.renderHead();this.renderMessages(data.messages);this.$('#oc-send')?.toggleAttribute('disabled',this.sendBusy||data.thread.opted_out);
  }catch(e){if(['ACCESS_DENIED','LOGIN_REQUIRED'].includes(e.code)){this.data=null;this.threadId=null;this.$('.oc-conversation').innerHTML='<div class="oc-empty">Доступ к переписке закрыт. Войдите заново или проверьте назначение.</div>';}this.notice(errText(e));}finally{this.detailLoading=false;}
 }
 renderHead(){const {thread:t,address:a,offer:o}=this.data;this.$('.oc-head').innerHTML=`<div class="oc-row oc-between"><div class="oc-row"><button class="oc-back" data-act="back">←</button><strong>${esc(t.phone)}</strong></div><div class="oc-row"><button data-act="attach">${a?'Адрес':'Привязать адрес'}</button>${this.admin?'<button data-act="assign">Водитель</button>':''}<button data-act="refresh" aria-label="Обновить переписку">↻</button><button data-act="read" title="Отметить просмотренным">✓</button></div></div><p>${esc(a?.text||'Добавьте адрес, чтобы согласовать сбор.')}</p><div>${a?`${this.admin?`<button class="oc-chip" data-act="category" title="Изменить категорию" ${this.sendBusy?'disabled':''}>${esc(sources[a.collection_source]||sources.subnex)} ▾</button>`:`<span class="oc-chip">${esc(sources[a.collection_source]||sources.subnex)}</span>`}`:''}${a?.collection_start?`<span class="oc-chip ok">Согласовано: ${esc(slotLabel(a))}</span>`:a?.date?`<span class="oc-chip ok">В маршруте: ${esc(a.date)}</span>`:'<span class="oc-chip">Вне маршрута</span>'}${t.opted_out?'<span class="oc-chip warn">Отказ от SMS</span>':t.manual_mode?'<span class="oc-chip warn">Ручное согласование</span>':o?.state==='awaiting'?'<span class="oc-chip warn">Ожидаем точный ответ YES</span>':''}</div>`;}
 renderMessages(messages,prepend=false){const box=this.$('.oc-messages');const bottom=box.scrollHeight-box.scrollTop-box.clientHeight<90;const previous=box.scrollHeight;
  if(prepend){const all=[...messages,...this.data.messages];this.data.messages=[...new Map(all.map(x=>[x.id,x])).values()];messages=this.data.messages;}
  const html=`${messages.length>=100?'<button data-act="older">Более ранние сообщения</button>':''}`+messages.map(m=>`<article class="oc-message ${m.direction==='out'?'out':''}"><div class="oc-text">${esc(m.body)}</div>${m.num_media?'<div class="oc-help">Вложений: '+m.num_media+' (файлы не загружены)</div>':''}<footer><span class="${['unknown','failed','undelivered','dispatching'].includes(m.status)?'oc-error':''}">${esc(statuses[m.status]||m.status)}${m.error_code?' · '+esc(m.error_code):''}</span> · ${esc(ukDate(m.created_at))} ${esc(ukTime(m.created_at))}</footer></article>`).join('');
  if(box.innerHTML!==html)box.innerHTML=html||'<div class="oc-empty">Напишите первое сообщение.</div>';
  if(prepend)box.scrollTop=box.scrollHeight-previous;else if(bottom||!this.initialScroll){box.scrollTop=box.scrollHeight;this.initialScroll=true;}
 }
 compose(draft){const {address:a,thread:t}=this.data;this.formVersion=a?.collection_version;const isOffer=this.mode==='offer',manual=this.mode==='confirm';
  this.$('.oc-compose').innerHTML=`<div class="oc-controls"><button data-act="mode" data-mode="reply" class="${this.mode==='reply'?'active':''}">Сообщение</button><button data-act="mode" data-mode="offer" ${a?.date?'disabled':''} class="${isOffer?'active':''}">Предложить время</button><button data-act="mode" data-mode="confirm" class="${manual?'active':''}">Подтвердить вручную</button></div>${isOffer||manual?`<div class="oc-slots"><label>Дата<input id="oc-day" type="date" min="${ukDate()}" value="${esc(draft?.day||a?.date||(this.data.offer?.starts_at?ukDate(this.data.offer.starts_at):ukDate()))}"></label><label>С<input id="oc-start" type="time" value="${esc(draft?.start||(a?.collection_start?ukTime(a.collection_start):this.data.offer?.starts_at?ukTime(this.data.offer.starts_at):'09:00'))}"></label><label>До<input id="oc-end" type="time" value="${esc(draft?.end||(a?.collection_end?ukTime(a.collection_end):this.data.offer?.ends_at?ukTime(this.data.offer.ends_at):'10:00'))}"></label></div><div class="oc-help">Время Великобритании (Europe/London). Учитывается рабочий график.</div>`:''}${manual?`<label><input id="oc-agreed" type="checkbox">Клиент согласовал эту дату и время в переписке или по телефону.</label>${a?.date?'<label style="margin-top:10px"><input id="oc-change-agreed" type="checkbox">Клиент согласен изменить ранее назначенный срок.</label>':''}<p class="oc-help">Подтверждение добавит адрес в маршрут и сохранит выбранный срок. SMS при этом не отправляется.</p><button class="oc-green" id="oc-confirm" data-act="confirm">Подтвердить и добавить в маршрут</button>`:`<label for="oc-body">${isOffer?'Текст предложения':'Сообщение клиенту'}</label><textarea id="oc-body" maxlength="1000" placeholder="Текст SMS…"></textarea>${isOffer?'<div class="oc-preview" id="oc-preview"></div>':''}<div class="oc-row oc-between" style="margin-top:8px"><span class="oc-muted" id="oc-count"></span><button class="oc-primary" id="oc-send" data-act="send" ${t.opted_out?'disabled':''}>${isOffer?'Отправить предложение':'Отправить SMS'}</button></div><p class="oc-help">${isOffer?(t.manual_mode||t.active_offer_id?'Продолжается ручное согласование. После ответа подтвердите время кнопкой выше.':'Адрес попадёт в маршрут после точного ответа YES. Другой ответ откроет ручное согласование.'):'SMS отправляется с номера компании. Статус «Доставлено» не подтверждает сбор.'}</p>`}`;
  const body=this.$('#oc-body');if(body){body.value=draft?.body??(isOffer?`Hi, this is SUBNEX. We'd like to collect your bags${a?.text?' from '+a.text:''}.`:'');body.addEventListener('input',()=>this.preview());}
  for(const id of ['#oc-day','#oc-start','#oc-end'])this.$(id)?.addEventListener('input',()=>this.preview());this.preview();
 }
 partnerTemplate(){return this.mode==='offer'&&['partner','missing'].includes(this.data?.address?.collection_source);}
 driverName(){return this.drivers().find(d=>d.id===this.data?.thread.driver_id)?.name||(this.profile.driver_id===this.data?.thread.driver_id?this.profile.driver_name:'')||'';}
 preview(){const b=this.$('#oc-body');if(b&&this.partnerTemplate()){b.readOnly=true;b.value=partnerOffer(this.$('#oc-day').value,this.$('#oc-start').value,this.$('#oc-end').value,this.driverName());this.$('#oc-count').textContent=b.value.length+' / 1000 символов';this.$('#oc-preview').textContent='Готовая SMS от We Recycle Clothes. Дата и часы обновляются автоматически. Подпись: '+(this.driverName()||'без имени — назначьте водителя')+'.';return;}if(b)this.$('#oc-count').textContent=b.value.length+' / 1000 символов';if(!this.$('#oc-preview'))return;
  const day=this.$('#oc-day').value;const dt=day?new Date(day+'T12:00:00Z'):null;const date=dt&&!isNaN(dt)?dt.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}):'…';
  const manual=this.data.thread.manual_mode||this.data.thread.active_offer_id;
  this.$('#oc-preview').textContent='К SMS будет добавлено:\nCollection: '+date+', '+this.$('#oc-start').value+'-'+this.$('#oc-end').value+' (UK time).\n'+(manual?'Please reply to agree the day/time with our team.':'Reply YES to confirm, or reply to arrange a different day/time.');
 }
 async action(act,b){
  if(act==='close'){this.close();return;}if(act==='back'){this.rememberDraft();this.root.classList.remove('oc-selected');return;}
  if(act==='thread'){this.initialScroll=false;await this.select(b.dataset.id);return;}
  if(act==='mode'){if(this.sendBusy)return;const mode=b.dataset.mode;if(mode!=='reply'&&!this.data.address){this.notice(codes.ADDRESS_REQUIRED);return;}this.mode=mode;this.compose();return;}
  if(act==='refresh'){this.notice('');await this.loadList();await this.loadDetail();return;}
  if(act==='prev'||act==='next'){this.offset=Math.max(0,this.offset+(act==='next'?60:-60));await this.loadList();return;}
  if(act==='new'){this.newThread();return;}if(act==='attach'){if(this.data.address){this.notice('Адрес: '+this.data.address.text+'. Редактирование реквизитов доступно в разделе «Адреса».');}else this.newThread(this.data.thread.phone);return;}
  if(act==='category'){if(!this.sendBusy)this.changeCategory();return;}if(act==='assign'){this.assign();return;}if(act==='settings'){this.settings();return;}
  if(act==='read'){await this.run(()=>this.call('read',{thread_id:this.threadId}));await this.loadList();return;}
  if(act==='older'){b.disabled=true;const first=this.data.messages[0];const old=await this.run(()=>this.call('detail',{thread_id:this.threadId,before:first.created_at,before_id:first.id}));if(old){this.renderMessages(old.messages,true);if(!old.messages.length){this.notice('Начало переписки.');this.$('[data-act=older]')?.remove();}}return;}
  if(act==='send'){await this.send();return;}if(act==='confirm'){await this.confirm();return;}
 }
 async send(){if(this.sendBusy)return;const text=this.$('#oc-body').value.trim();if(!text){this.notice('Введите сообщение.');return;}
  const payload={thread_id:this.threadId,kind:this.mode,body:text};if(this.mode==='offer')Object.assign(payload,{day:this.$('#oc-day').value,start:this.$('#oc-start').value,end:this.$('#oc-end').value,version:this.formVersion});
  if(this.partnerTemplate()){payload.template='wrc-v1';payload.expected_source=this.data.address.collection_source;payload.expected_driver_name=this.driverName().trim();}
  const signature=JSON.stringify(payload);
  const key='subnex_sms_pending_'+this.profile.user_id+'_'+this.threadId;
  if(!this.pending){try{this.pending=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}}
  if(this.pending?.signature!==signature)this.pending={signature,id:crypto.randomUUID()};payload.request_id=this.pending.id;
  sessionStorage.setItem(key,JSON.stringify(this.pending));
  this.sendBusy=true;this.$('#oc-send').disabled=true;this.$('#oc-body').disabled=true;this.notice('Отправка…');
  try{const r=await this.call('send',payload);if(this.closed)return;this.$('#oc-body').value='';this.drafts.delete(this.threadId);this.pending=null;sessionStorage.removeItem(key);
   this.notice(r.uncertain?'Результат неизвестен. Проверьте Message logs в Twilio перед новой отправкой.':'Статус: '+(statuses[r.message.status]||r.message.status));
   this.o.onChanged?.();
  }catch(e){this.notice(errText(e));}finally{this.sendBusy=false;if(!this.closed){this.$('#oc-send').disabled=!!this.data?.thread.opted_out;this.$('#oc-body').disabled=false;await this.loadDetail();await this.loadList();this.preview();}}
 }
 async confirm(){const button=this.$('#oc-confirm');if(button.disabled)return;
  const data={thread_id:this.threadId,day:this.$('#oc-day').value,start:this.$('#oc-start').value,end:this.$('#oc-end').value,version:this.formVersion,agreed:this.$('#oc-agreed').checked,change_agreed:this.$('#oc-change-agreed')?.checked||false};
  button.disabled=true;const result=await this.run(()=>this.call('confirm',data));if(result){this.notice('Дата и время сохранены. Адрес добавлен в маршрут.');await this.loadDetail();await this.loadList();this.compose();this.o.onChanged?.();}else button.disabled=false;
 }
 modal(title,content,onSave,saveLabel='Сохранить'){
  this.$('.oc-modal-wrap')?.remove();const wrap=document.createElement('div');wrap.className='oc-modal-wrap';wrap.innerHTML=`<section class="oc-modal" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="oc-form">${content}</div><p class="oc-modal-error" role="alert"></p><div class="oc-actions"><button class="oc-cancel">Отмена</button>${onSave?`<button class="oc-primary oc-save">${esc(saveLabel)}</button>`:''}</div></section>`;this.root.append(wrap);
  wrap.querySelector('.oc-cancel').onclick=()=>wrap.remove();if(onSave)wrap.querySelector('.oc-save').onclick=async()=>{const save=wrap.querySelector('.oc-save');save.disabled=true;try{await onSave(wrap);wrap.remove();}catch(e){wrap.querySelector('.oc-modal-error').textContent=errText(e);save.disabled=false;}};
  wrap.querySelector('input,select,button')?.focus();return wrap;
 }
 newThread(phone=''){
  const addresses=(this.o.addresses?.()||[]).filter(a=>a.kind!=='bank'&&a.phone&&['new','planned'].includes(a.status));
  this.modal(phone?'Привязать адрес':'Новая переписка',`<label>Существующая заявка<select id="oc-existing"><option value="">Новый запрос</option>${addresses.map(a=>`<option value="${esc(a.id)}">${esc(a.text)} · ${esc(a.phone)}</option>`).join('')}</select></label><label>Мобильный телефон<input id="oc-new-phone" type="tel" value="${esc(phone)}" placeholder="07…"></label><label>Адрес нового сбора<input id="oc-new-address" placeholder="Улица, дом, город, индекс"></label><label>Категория<select id="oc-new-source">${Object.entries(sources).map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select></label>${this.admin?`<label>Водитель<select id="oc-new-driver">${this.driverOptions(this.profile.driver_id)}</select></label>`:''}<p class="oc-help">Новый адрес останется вне маршрута до согласования срока. Координаты можно уточнить в редакторе адреса.</p>`,async(w)=>{
   const data={address_id:w.querySelector('#oc-existing').value,phone:w.querySelector('#oc-new-phone').value,address:w.querySelector('#oc-new-address').value,source:w.querySelector('#oc-new-source').value,driver_id:w.querySelector('#oc-new-driver')?.value||this.profile.driver_id};
   if(!data.address_id&&data.address&&this.o.geocode){const point=await Promise.race([this.o.geocode(data.address),new Promise(resolve=>setTimeout(()=>resolve(null),12000))]);if(point){data.lat=point.lat;data.lng=point.lng;}}
   const r=await this.call('create',data);this.o.onChanged?.();await this.select(r.thread_id);await this.loadList();},'Открыть переписку');
 }
 changeCategory(){
  if(!this.admin||!this.data?.address||this.sendBusy)return;
  const address={...this.data.address},threadId=this.threadId;
  this.modal('Категория сбора',`<label>Категория<select id="oc-category">${Object.entries(sources).map(([v,n])=>`<option value="${v}" ${v===address.collection_source?'selected':''}>${esc(n)}</option>`).join('')}</select></label><p class="oc-help">Категория определяет шаблон новых SMS. Согласованные дата и время сохраняются.</p>`,async(w)=>{
   if(this.sendBusy)throw new Error('Дождитесь завершения отправки SMS.');
   const source=w.querySelector('#oc-category').value;
   if(!Object.hasOwn(sources,source))throw new Error('Выберите категорию из списка.');
   if(source===address.collection_source)return;
   const {data,error}=await this.sb.from('addresses').update({collection_source:source})
    .eq('id',address.id).eq('collection_source',address.collection_source)
    .eq('collection_version',address.collection_version).select('id');
   if(error)throw new Error('Не удалось сохранить категорию. Обновите переписку и проверьте доступ.');
   if(!data?.length)throw new Error('Адрес изменился или недоступен. Обновите переписку и повторите.');
   if(!this.closed&&this.threadId===threadId&&this.data?.address?.id===address.id){
    this.rememberDraft();const draft=this.drafts.get(threadId);
    this.data.address.collection_source=source;
    if(draft&&this.mode==='offer')delete draft.body;
    this.compose(draft);this.renderHead();
    this.notice('Категория сохранена: '+sources[source]+'.');
    await this.loadList();
   }
   this.o.onChanged?.();
  });
 }
 assign(){this.modal('Назначить водителя',`<label>Водитель<select id="oc-assignee">${this.driverOptions(this.data.thread.driver_id)}</select></label><p class="oc-help">История останется у компании. Доступ перейдёт назначенному водителю. Незавершённое предложение перейдёт в ручное согласование.</p>`,async(w)=>{await this.call('assign',{thread_id:this.threadId,driver_id:w.querySelector('#oc-assignee').value});await this.loadDetail();await this.loadList();this.o.onChanged?.();});}
 async settings(){const result=await this.run(async()=>({hours:await this.call('hours'),members:await this.call('members')}));if(!result)return;
  const days=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const w=this.modal('Рабочий график и доступ',`<h3>График · время Великобритании</h3><div class="oc-muted">Изменения графика не переносят существующие договорённости.</div><div class="oc-hours">${result.hours.week.map(x=>`<div class="oc-row oc-between oc-member"><span>${days[x.weekday]} · ${x.closed?'выходной':x.opens.slice(0,5)+'–'+x.closes.slice(0,5)}</span><button data-hour="${x.weekday}">Изменить</button></div>`).join('')}</div><button id="oc-day-override">Исключение на дату</button>${result.hours.days.map(x=>`<div class="oc-row oc-between">${esc(x.day)} · ${x.closed?'выходной':esc(x.opens.slice(0,5)+'–'+x.closes.slice(0,5))}<button data-remove-day="${esc(x.day)}">Сбросить</button></div>`).join('')}<h3>Аккаунты</h3>${result.members.members.map(m=>`<div class="oc-member"><b>${esc(m.email)}</b><br><small>${m.role==='admin'?'Администратор':'Водитель'} · ${m.active?'активен':'отключён'}</small></div>`).join('')}<button id="oc-manage-member">Назначить / изменить доступ</button>`,null);
  w.querySelectorAll('[data-hour]').forEach(b=>b.onclick=()=>{const day=Number(b.dataset.hour);const h=result.hours.week.find(x=>x.weekday===day);this.hoursForm(h,days[day]);});
  w.querySelector('#oc-day-override').onclick=()=>this.hoursForm({day:ukDate(),opens:'08:00',closes:'16:00',closed:false},'Исключение на дату');
  w.querySelectorAll('[data-remove-day]').forEach(b=>b.onclick=async()=>{const ok=await this.run(()=>this.call('save_hours',{day:b.dataset.removeDay,remove:true}));if(ok)this.settings();});
  w.querySelector('#oc-manage-member').onclick=()=>this.modal('Доступ пользователя',`<p class="oc-help">Сначала создайте пользователя с подтверждённым email в Supabase → Authentication → Users. Пароль передайте ему лично.</p><label>Email<input id="oc-member-email" type="email"></label><label>Роль<select id="oc-member-role"><option value="driver">Водитель</option><option value="admin">Администратор</option></select></label><label>Водитель<select id="oc-member-driver">${this.driverOptions()}</select></label><label><input id="oc-member-active" type="checkbox" checked>Доступ включён</label>`,async(m)=>{await this.call('save_member',{email:m.querySelector('#oc-member-email').value,role:m.querySelector('#oc-member-role').value,driver_id:m.querySelector('#oc-member-driver').value,active:m.querySelector('#oc-member-active').checked});this.notice('Доступ сохранён.');});
 }
 hoursForm(h,title){this.modal(title,`${h.day?`<label>Дата<input id="oc-hours-day" type="date" value="${esc(h.day)}"></label>`:''}<div class="oc-slots"><label>С<input id="oc-hours-open" type="time" value="${h.opens.slice(0,5)}"></label><label>До<input id="oc-hours-close" type="time" value="${h.closes.slice(0,5)}"></label></div><label><input id="oc-hours-closed" type="checkbox" ${h.closed?'checked':''}>Выходной</label>`,async(w)=>{await this.call('save_hours',{...(h.day?{day:w.querySelector('#oc-hours-day').value}:{weekday:h.weekday}),opens:w.querySelector('#oc-hours-open').value,closes:w.querySelector('#oc-hours-close').value,closed:w.querySelector('#oc-hours-closed').checked});this.notice('График сохранён.');});}
}
window.Ops={api,profile:sb=>api(sb,'profile'),open,close,esc,error:errText,signPhotos,photoUrl,slotLabel,ukDate,ukTime,clear:()=>{photoCache.clear();close();}};
})();
