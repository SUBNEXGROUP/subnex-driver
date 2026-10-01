// SUBNEX: authenticated road data only. This function never sends SMS or confirms a booking.
// 01.10.2026: matrix accepts an optional `from` point (driver GPS) for "route from me now".
type Json = Record<string, any>;
type Point = {lat:number;lng:number};
const key=(p:Point)=>p.lat.toFixed(5)+','+p.lng.toFixed(5);
const valid=(p:any):p is Point=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=49&&p.lat<=61&&p.lng>=-9&&p.lng<=3;
const json=(body:unknown,status:number,origin:string)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store'}});
async function fetchJson(url:string,init:RequestInit={}):Promise<any>{
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('ROUTING_HTTP_'+response.status);
 return await response.json();
}
export async function handler(request:Request):Promise<Response>{
 const allowed=Deno.env.get('SUBNEX_WEB_ORIGIN')||'https://subnexgroup.github.io';
 const origin=request.headers.get('Origin')||allowed;
 if(origin!==allowed)return json({error:'ORIGIN_NOT_ALLOWED'},403,allowed);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':allowed,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'}});
 if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405,allowed);
 try{
  const auth=request.headers.get('Authorization')||'';
  if(!/^Bearer \S+$/.test(auth))return json({error:'AUTH_REQUIRED'},401,allowed);
  const base=Deno.env.get('SUPABASE_URL'),anon=Deno.env.get('SUPABASE_ANON_KEY'),service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!base||!anon||!service)throw new Error('SUPABASE_NOT_CONFIGURED');
  const who=await fetch(base+'/auth/v1/user',{headers:{apikey:anon,Authorization:auth},signal:AbortSignal.timeout(10000)});
  if(!who.ok)return json({error:'AUTH_REQUIRED'},401,allowed);
  const user=await who.json();if(!user.id)return json({error:'AUTH_REQUIRED'},401,allowed);
  const body=await request.text();if(body.length>20000)return json({error:'REQUEST_TOO_LARGE'},413,allowed);
  const input:Json=JSON.parse(body);if(!['matrix','geometry','health'].includes(input.action))return json({error:'ACTION_INVALID'},400,allowed);
  const rpc=async(name:string,payload:Json,asService=false)=>{
   const r=await fetch(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:asService?service:anon,Authorization:asService?'Bearer '+service:auth,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
   const result=await r.json();if(!r.ok)throw new Error(result.message||'DATABASE_ERROR');return result;
  };
  // Membership/driver access is checked by the authenticated RPC even for health requests.
  const setup=await rpc('subnex_dispatch',{p_action:'settings',p_data:{driver_id:input.driver_id}});
  const ors=Deno.env.get('OPENROUTESERVICE_API_KEY');const osrm=Deno.env.get('ROUTING_OSRM_URL')?.replace(/\/$/,'');
  if(!ors&&!osrm)throw new Error('ROUTING_PROVIDER_REQUIRED');
  if(osrm){const u=new URL(osrm);if(u.protocol!=='https:'||['router.project-osrm.org','routing.openstreetmap.de'].includes(u.hostname))throw new Error('ROUTING_PROVIDER_REQUIRED');}
  if(input.action==='health')return json({ok:true,provider:ors?'openrouteservice':'osrm',enabled:setup.enabled},200,allowed);
  const driver=setup.driver_id;
  if(input.action==='matrix'){
   const context=await rpc('subnex_dispatch',{p_action:'road_context',p_data:{driver_id:driver,from_day:input.day,days:1,address_ids:input.address_ids||[]}});
   // Optional start point (driver GPS) for "route from me now". Only coordinates inside the UK box are accepted.
   const from=valid(input.from)?[{lat:Number(input.from.lat),lng:Number(input.from.lng)}]:[];
   const list=[...from,context.config.home,...context.days[0].nodes,...context.requests,context.config.depot];
   if(!list.every(valid))throw new Error('COORDINATES_REQUIRED');
   const points:Point[]=[...new Map<string,Point>(list.map((p:Point)=>[key(p),p])).values()];
   if(points.length>90)throw new Error('ROADS_LIMIT');
   const keys=points.map(key),cache=await rpc('subnex_dispatch_cached_roads',{p_data:{keys}});
   const locations=points.map(p=>[p.lng,p.lat]),pairs:Json[]=[];
   let lastProviderCall=0;
   for(let si=0;si<points.length;si+=40)for(let di=0;di<points.length;di+=40){
    const sources=Array.from({length:Math.min(40,points.length-si)},(_,i)=>si+i),destinations=Array.from({length:Math.min(40,points.length-di)},(_,i)=>di+i);
    if(sources.every(s=>destinations.every(d=>s===d||Object.hasOwn(cache,keys[s]+'>'+keys[d]))))continue;
    if(ors&&lastProviderCall)await new Promise(resolve=>setTimeout(resolve,Math.max(0,2000-(Date.now()-lastProviderCall))));lastProviderCall=Date.now();
    let response:Json;
    if(ors)response=await fetchJson('https://api.heigit.org/openrouteservice/v2/matrix/driving-car',{method:'POST',headers:{Authorization:ors,'Content-Type':'application/json'},body:JSON.stringify({locations,sources:sources.map(String),destinations:destinations.map(String),metrics:['duration']})});
    else response=await fetchJson(osrm+'/table/v1/driving/'+locations.map(p=>p.join(',')).join(';')+'?annotations=duration&sources='+sources.join(';')+'&destinations='+destinations.join(';'));
    const durations=response.durations;
    if(!Array.isArray(durations)||durations.length!==sources.length||durations.some((r:any)=>!Array.isArray(r)||r.length!==destinations.length))throw new Error('ROADS_INVALID');
    sources.forEach((s,i)=>destinations.forEach((d,j)=>{const seconds=durations[i][j];if(seconds!==null&&(!Number.isFinite(seconds)||seconds<0||seconds>=604800))throw new Error('ROADS_INVALID');pairs.push({a:keys[s],b:keys[d],seconds});}));
   }
   if(pairs.length)await rpc('subnex_dispatch_store_roads',{p_user:user.id,p_driver:driver,p_data:{pairs,provider:ors?'openrouteservice':'osrm'}},true);
   const roads=await rpc('subnex_dispatch_cached_roads',{p_data:{keys}});
   return json({roads,provider:ors?'openrouteservice':'osrm'},200,allowed);
  }
  const day=await rpc('subnex_dispatch',{p_action:'day',p_data:{driver_id:driver,day:input.day}});
  const nodes:Json[]=day.started_at?day.fit.nodes:day.nodes;
  const byId=new Map(nodes.map(n=>[n.key,n]));
  const order:string[]=day.fit?.ok?day.fit.order:day.order;
  const cfg=day.started_at?day.fit.config:day.config;
  const points=[cfg.home,...order.map(k=>byId.get(k)),cfg.depot];if(!points.every(valid))throw new Error('COORDINATES_REQUIRED');
  let geometry:number[][]=[],distance=0,duration=0;
  for(let start=0;start<points.length-1;start+=39){const locations=points.slice(start,start+40).map((p:Point)=>[p.lng,p.lat]);let coordinates:number[][];let summary:Json;
   if(ors){const r=await fetchJson('https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson',{method:'POST',headers:{Authorization:ors,'Content-Type':'application/json'},body:JSON.stringify({coordinates:locations,instructions:false})});coordinates=r.features?.[0]?.geometry?.coordinates;summary=r.features?.[0]?.properties?.summary;}
   else {const r=await fetchJson(osrm+'/route/v1/driving/'+locations.map((p:number[])=>p.join(',')).join(';')+'?overview=full&geometries=geojson&continue_straight=false');coordinates=r.routes?.[0]?.geometry?.coordinates;summary=r.routes?.[0];}
   if(!Array.isArray(coordinates)||coordinates.length<2||coordinates.some(p=>!Array.isArray(p)||!Number.isFinite(p[0])||!Number.isFinite(p[1]))||!Number.isFinite(summary?.distance)||!Number.isFinite(summary?.duration))throw new Error('ROADS_INVALID');
   geometry=geometry.concat((start?coordinates.slice(1):coordinates).map(p=>[p[1],p[0]]));distance+=summary.distance;duration+=summary.duration;
  }
  return json({geometry,km:distance/1000,min:duration/60,order:order.filter(k=>k.startsWith('a:')).map(k=>k.slice(2)),token:day.token,provider:ors?'openrouteservice':'osrm'},200,allowed);
 }catch(e){const message=e instanceof Error?e.message:'ROUTING_ERROR';return json({error:message},400,allowed);}
}
if(import.meta.main)Deno.serve(handler);
