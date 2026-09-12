/* A feasible-order heuristic: fixed windows are never shifted to fit a route. */
(function(root){
'use strict';
const minutes=iso=>{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);};
function plan(matrix,stops,opens,closes,service=4){
 const n=stops.length;if(matrix.length!==n+2||!Number.isFinite(opens)||!Number.isFinite(closes)||opens>=closes)return null;
 const travel=(a,b)=>{const v=matrix[a]?.[b];return typeof v==='number'&&Number.isFinite(v)&&v>=0?v/60*1.2:Infinity;}; // modest buffer, not a traffic prediction
 const evaluate=order=>{let at=opens,prev=0,driving=0;const arrivals={};
  for(const i of order){const s=stops[i-1],leg=travel(prev,i);at+=leg;driving+=leg;
   if(s.collection_start){at=Math.max(at,minutes(s.collection_start));if(at+service>minutes(s.collection_end))return null;}
   arrivals[s.id]=at;at+=service;prev=i;
  }
  at+=travel(prev,n+1);driving+=travel(prev,n+1);if(at>closes||!Number.isFinite(at))return null;
  return {order,minutes:at-opens,arrivals,score:driving+at*.05};
 };
 let order=stops.map((s,i)=>i+1).filter(i=>stops[i-1].collection_start).sort((a,b)=>Date.parse(stops[a-1].collection_end)-Date.parse(stops[b-1].collection_end));
 if(!evaluate(order))return null;
 const pending=stops.map((s,i)=>i+1).filter(i=>!stops[i-1].collection_start);
 while(pending.length){let best=null,chosen=-1;
  for(const i of pending)for(let p=0;p<=order.length;p++){const candidate=evaluate([...order.slice(0,p),i,...order.slice(p)]);if(candidate&&(!best||candidate.score<best.score)){best=candidate;chosen=i;}}
  if(!best)return null;order=best.order;pending.splice(pending.indexOf(chosen),1);
 }
 return evaluate(order);
}
const signature=(stops,home,depot)=>JSON.stringify([home?.lat,home?.lng,depot?.lat,depot?.lng,stops.map(a=>[a.id,a.lat,a.lng,a.date,a.status,a.collection_start,a.collection_end,a.collection_version||0]).sort((a,b)=>a[0].localeCompare(b[0]))]);
root.OpsRoute={plan,minutes,signature};
})(typeof window!=='undefined'?window:globalThis);
