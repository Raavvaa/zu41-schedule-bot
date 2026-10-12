import {reserveQueue,consume} from './dispatch.mjs';
import {one,rows,run,dayKey,sql,telegram} from './core.mjs';
import {catalog,getSchedule} from './source.mjs';
import {cleanUpdate,processUpdate} from './dialog.mjs';
import {planningTick,deliveryTick,refreshTick,cleanup} from './scheduler.mjs';
const json=(x,status=200)=>Response.json(x,{status});
export async function safeEqual(a,b){
 if(!a||!b)return false;
 const digest=x=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));
 const [aa,bb]=await Promise.all([digest(a),digest(b)]);let diff=0;
 const x=new Uint8Array(aa),y=new Uint8Array(bb);for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return !diff;
}
export async function webhook(request,env,now=Date.now()){
 if(!await safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))return json({ok:false},403);
 if(Number(request.headers.get('content-length'))>65536)return json({ok:false},413);
 let raw;try{const text=await request.text();if(text.length>65536)return json({ok:false},413);raw=JSON.parse(text);}catch{return json({ok:false},400);}
 const update=cleanUpdate(raw);if(!update)return json({ok:true});
 if(update.callback==='start_v2'){update.callback='';update.text='/start';}
 // Closed staging does not subscribe real students or alter their settings.
 if(env.DELIVERY_ENABLED!=='true'&&String(update.user_id)!==String(env.OWNER_CHAT_ID))return json({ok:true});
 const inserted=await run(env,'INSERT OR IGNORE INTO updates(update_id,user_id,payload,created_at) VALUES(?,?,?,?)',update.update_id,update.user_id,JSON.stringify(update),now);
 if(inserted.meta.changes){await processUpdate(env,update,now);await deliveryTick(env,update.user_id%8,now,update.user_id);}
 return json({ok:true});
}
export default {
 async fetch(request,env){
  try{
   const url=new URL(request.url);
   if(url.pathname==='/health'&&request.method==='GET')return json({ok:true,version:'2.0.0',mode:env.DELIVERY_ENABLED==='true'?'active':'staging'});
   if(url.pathname==='/telegram'&&request.method==='POST')return await webhook(request,env);
   if(!url.pathname.startsWith('/ops/')||!await safeEqual(request.headers.get('Authorization'),`Bearer ${env.ADMIN_SECRET}`))return json({ok:false},404);
   if(!env.ADMIN_SECRET)return json({ok:false},403);
   if(url.pathname==='/ops/probe'&&request.method==='POST'){
    const now=Date.now();const gs=await catalog(env,now,true);const example=gs.find(g=>g.id===63&&g.name==='ЗУ-41/23');
    if(!example)return json({ok:false,error:'example_not_found'},502);
    const s=await getSchedule(env,example.id,dayKey(now),now,{force:true});
    return json({ok:s.status==='confirmed',source_status:s.status,catalog_count:gs.length,group:example.name,date:s.date,lessons:s.lessons?.length??0,checked_at:s.checked_at},s.status==='confirmed'?200:502);
   }
   if(url.pathname==='/ops/status'){
    const counts=await rows(env,'SELECT state,count(*) AS count FROM jobs GROUP BY state');
    return json({mode:env.DELIVERY_ENABLED,counts,last_cron:(await one(env,"SELECT value FROM meta WHERE name='last_cron'"))?.value??null,last_consumer:(await one(env,"SELECT value FROM meta WHERE name='last_consumer'"))?.value??null,queue_budget:(await one(env,'SELECT used FROM queue_budgets WHERE date=?',new Date().toISOString().slice(0,10)))?.used??0});
   }
   if(url.pathname==='/ops/owner-test'&&request.method==='POST'){
    const now=Date.now();const gs=await catalog(env,now);const g=gs.find(x=>x.id===63);if(!g)return json({ok:false},502);
    const s=await getSchedule(env,63,dayKey(now),now,{force:true});
    if(s.status!=='confirmed')return json({ok:false,source_status:s.status},502);
    const {formatDay,pack}=await import('./core.mjs');const part=pack(formatDay(s,{group_id:63,group_name:g.name,subgroup:'both'}))[0];
    const r=await telegram(env,'sendMessage',{chat_id:env.OWNER_CHAT_ID,...part,reply_markup:{inline_keyboard:[[{text:'Настроить свою группу',callback_data:'start_v2'}]]}});
    return json({ok:r.ok,message_id:r.message_id??null},r.ok?200:502);
   }
   if(url.pathname==='/ops/tick'&&request.method==='POST'){
    const now=Date.now();const b=await request.json();if(!Number.isInteger(b.lane)||b.lane<0||b.lane>7)return json({ok:false},400);
    if(b.type==='refresh'&&b.lane<4)await refreshTick(env,b.lane,now);
    else if(b.type==='plan')await planningTick(env,b.lane,now);
    else if(b.type==='deliver')await deliveryTick(env,b.lane,now);
    else return json({ok:false},400);
    return json({ok:true});
   }
   return json({ok:false},404);
  }catch{return json({ok:false,error:'temporary_failure'},503);}
 },
 async scheduled(controller,env,ctx){
  const now=Date.now();
  await run(env,"INSERT INTO meta VALUES('last_cron',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",String(now));
  if(await reserveQueue(env,1,now))await env.TICKS.send({type:'dispatch'});
 },
 async queue(batch,env){await consume(batch,env);}
};
