import {sql,one,rows,run,dayKey,addDays,lock} from './core.mjs';
import {planningTick,deliveryTick,refreshTick,cleanup} from './scheduler.mjs';
// <=2800 enqueued messages/day ~=8400 normal queue operations; reserve headroom
// for retries, and prioritize minute ticks and delivery over background refresh.
export async function reserveQueue(env,n,now,background=false){
 const date=new Date(now).toISOString().slice(0,10);const limit=background?2400:2800;
 const r=await run(env,'INSERT INTO queue_budgets(date,used) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET used=used+excluded.used WHERE used+excluded.used<=?',date,n,limit);
 return !!r.meta.changes;
}
export async function dispatch(env,now){
 // Repeated queue messages and cron minutes do not schedule the same work twice.
 if(!await lock(env,'dispatch:'+Math.floor(now/60000),now,3*60000))return;
 const today=dayKey(now);const active=env.DELIVERY_ENABLED==='true';
 await run(env,`UPDATE schedules SET next_refresh=MIN(next_refresh,?) WHERE date=? AND checked_at<? AND attempt_at<? AND group_id IN (SELECT group_id FROM jobs WHERE kind='reminder' AND state IN ('pending','retry') AND due_at>=? AND due_at<=?)`,now,today,now-60000,now-60000,now,now+2*60000);
 const lanes=await rows(env,`SELECT DISTINCT lane FROM jobs WHERE state IN ('pending','retry') AND due_at<=?${active?'':" AND kind='reply'"} LIMIT 8`,now);
 const waiting=await rows(env,"SELECT DISTINCT user_id%8 AS lane FROM updates WHERE state='pending' LIMIT 8");
 const users=active?await rows(env,'SELECT DISTINCT lane FROM users WHERE blocked=0 AND next_plan<=? LIMIT 8',now):[];
 const plans=[...new Set([...waiting,...users].map(x=>x.lane))].map(lane=>({lane}));
 const refresh=active?await rows(env,`SELECT DISTINCT s.group_id%4 AS lane FROM schedules s WHERE date>=? AND date<=? AND next_refresh<=?
  AND EXISTS(SELECT 1 FROM users u WHERE u.group_id=s.group_id AND u.blocked=0) LIMIT 4`,today,addDays(today,1),now):[];
 const urgent=lanes.map(x=>({body:{type:'deliver',lane:x.lane}}));
 const maintenance=[...plans.map(x=>({body:{type:'plan',lane:x.lane}})),...refresh.map(x=>({body:{type:'refresh',lane:x.lane}}))];
 if(urgent.length&&await reserveQueue(env,urgent.length,now))await env.TICKS.sendBatch(urgent);
 if(maintenance.length&&await reserveQueue(env,maintenance.length,now,true))await env.TICKS.sendBatch(maintenance);
 if(new Date(now).getUTCHours()===0&&new Date(now).getUTCMinutes()===17)await cleanup(env,now);
}
export async function consume(batch,env,now=Date.now()){
 for(const message of batch.messages){
  const b=message.body;
  try{
   if(b.type==='dispatch')await dispatch(env,now);
   else if(Number.isInteger(b.lane)&&b.lane>=0&&b.lane<8){
    if(b.type==='plan')await planningTick(env,b.lane,now);
    else if(b.type==='deliver')await deliveryTick(env,b.lane,now,null,()=>Date.now());
    else if(b.type==='refresh'&&b.lane<4)await refreshTick(env,b.lane,now);
   }
   message.ack();
  }catch{
   // D1 remains authoritative. Recovery happens via future cron, not unbounded retries.
   message.ack();
  }
 }
 await run(env,"INSERT INTO meta VALUES('last_consumer',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",String(now));
}
