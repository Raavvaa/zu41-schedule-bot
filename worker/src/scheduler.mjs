import {MS,ROOT,dayKey,addDays,at,visible,formatDay,lessonText,pack,one,rows,run,sql,lock,unlock,telegram} from './core.mjs';
import {getSchedule,refreshWeek,decode} from './source.mjs';
import {processUpdate} from './dialog.mjs';
export async function putJob(env,job,now){
 return run(env,`INSERT INTO jobs(job_key,user_id,chat_id,lane,date,group_id,lesson_number,kind,due_at,expires_at,start_at,revision,payload,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_key) DO UPDATE SET due_at=excluded.due_at,expires_at=excluded.expires_at,start_at=excluded.start_at,
 revision=excluded.revision,payload=excluded.payload,state='pending',last_error=NULL WHERE jobs.state IN ('pending','retry','cancelled','skipped') AND excluded.due_at>=?`,
 job.key,job.user_id,job.chat_id,job.user_id%8,job.date,job.group_id,job.number??null,job.kind,job.due,job.expires,job.start??null,job.revision,job.payload?JSON.stringify(job.payload):null,now,now);
}
export async function planUser(env,u,now){
 const today=dayKey(now);let incomplete=false;
 for(const date of [today,addDays(today,1)]){
  const s=await getSchedule(env,u.group_id,date,now);
  if(s.status!=='confirmed')incomplete=true;
  const common={user_id:u.user_id,chat_id:u.chat_id,date,group_id:u.group_id,revision:u.revision};
  if(u.morning_enabled&&!await one(env,"SELECT 1 AS done FROM jobs WHERE user_id=? AND date=? AND kind='morning' AND state IN ('sent','uncertain') LIMIT 1",u.user_id,date)){
   const due=at(date,u.morning_time);
   if(due>=Math.max(now,u.changed_at)&&due>=u.paused_until)
    await putJob(env,{...common,key:`${u.user_id}|${date}|${u.group_id}|morning`,kind:'morning',due,expires:due+15*MS},now);
  }
  if(u.reminders_enabled&&s.status==='confirmed'){
   for(const l of visible(s,u.subgroup)){
    const start=at(date,l.start),due=start-u.reminder_minutes*MS;
    if(due<Math.max(now,u.changed_at)||due<u.paused_until)continue;
    await putJob(env,{...common,key:`${u.user_id}|${date}|${u.group_id}|${l.number}|reminder`,number:l.number,kind:'reminder',due,expires:start,start},now);
   }
  }
 }
 await run(env,'UPDATE users SET next_plan=? WHERE user_id=? AND revision=?',incomplete?now+5*MS:at(addDays(today,1),'00:00')+(u.user_id%60)*1000,u.user_id,u.revision);
}
export async function planningTick(env,lane,now){
 const owner=await lock(env,'plan:'+lane,now,40000);if(!owner)return;
 try {
  // Recover durable webhook updates. Never replay a half-processed dialog blindly.
  const update=await one(env,"SELECT * FROM updates WHERE state='pending' AND user_id%8=? ORDER BY created_at LIMIT 1",lane);
  if(update)await processUpdate(env,JSON.parse(update.payload),now);
  const u=await one(env,'SELECT * FROM users WHERE lane=? AND blocked=0 AND next_plan<=? ORDER BY next_plan LIMIT 1',lane,now);
  if(u&&env.DELIVERY_ENABLED==='true')await planUser(env,u,now);
 }finally{await unlock(env,'plan:'+lane,owner);}
}
export async function refreshTick(env,lane,now){
 const owner=await lock(env,'refresh:'+lane,now,40000);if(!owner)return;
 try{
  const today=dayKey(now);
  // Fair bounded refresh; multiple students share one group/day source.
  const due=await one(env,`SELECT s.group_id,s.date,g.name FROM schedules s JOIN groups g ON g.group_id=s.group_id
   WHERE s.group_id%4=? AND s.date>=? AND s.date<=? AND s.next_refresh<=?
   AND EXISTS(SELECT 1 FROM users u WHERE u.group_id=s.group_id AND u.blocked=0)
   ORDER BY s.next_refresh LIMIT 1`,lane,today,addDays(today,1),now);
  if(due)await refreshWeek(env,{group_id:due.group_id,name:due.name},due.date,now);
  // Bring shared source refresh forward for approaching reminder slots.
  await run(env,`UPDATE schedules SET next_refresh=MIN(next_refresh,?) WHERE group_id IN
   (SELECT DISTINCT group_id FROM jobs WHERE kind='reminder' AND state IN ('pending','retry') AND due_at<=? AND due_at>=? AND group_id%4=?)
   AND date=? AND checked_at<?`,now,now+3*MS,now,lane,today,now-MS);
 }finally{await unlock(env,'refresh:'+lane,owner);}
}
async function finish(env,j,state,now,error=null,messageId=null){
 await env.DB.batch([
  sql(env,'UPDATE jobs SET state=?,lease_until=NULL,sent_at=?,message_id=?,last_error=? WHERE job_key=? AND state=\'sending\'',state,state==='sent'?now:null,messageId,error,j.job_key),
  sql(env,'INSERT INTO attempts(job_key,attempt,at,outcome,message_id) VALUES(?,?,?,?,?)',j.job_key,j.attempts+1,now,state,messageId)
 ]);
}
async function defer(env,j,now,delay,error){
 await env.DB.batch([
  sql(env,"UPDATE jobs SET state='retry',lease_until=NULL,due_at=?,last_error=? WHERE job_key=? AND state='sending'",now+delay,error,j.job_key),
  sql(env,'INSERT INTO attempts(job_key,attempt,at,outcome) VALUES(?,?,?,?)',j.job_key,j.attempts+1,now,error)
 ]);
}
export async function deliverJob(env,j,now,clock=()=>now){
 const claim=await run(env,"UPDATE jobs SET state='sending',attempts=attempts+1,lease_until=? WHERE job_key=? AND state IN ('pending','retry') AND due_at<=?",now+30000,j.job_key,now);
 if(!claim.meta.changes)return false;
 if(now>=j.expires_at)return finish(env,j,'skipped',now,'expired');
 let payload;
 if(j.kind==='reply'||j.kind==='part'){payload=JSON.parse(j.payload);if(payload._parent){const parent=await one(env,'SELECT state FROM jobs WHERE job_key=?',payload._parent);delete payload._parent;if(parent?.state!=='sent')return finish(env,j,'cancelled',now,'parent_not_sent');}}
 else {
  const u=await one(env,'SELECT * FROM users WHERE user_id=?',j.user_id);
  if(!u||u.blocked||u.group_id!==j.group_id||u.revision!==j.revision||u.paused_until>now||j.kind==='morning'&&!u.morning_enabled||j.kind==='reminder'&&!u.reminders_enabled)
   return finish(env,j,'cancelled',now,'subscription_changed');
  const c=await one(env,'SELECT * FROM schedules WHERE group_id=? AND date=?',j.group_id,j.date);
  const s=c?decode(c):{date:j.date,status:'unpublished'};
  if(j.kind==='reminder'){
   if(s.status!=='confirmed'||now-s.checked_at>3*MS){
    await run(env,'UPDATE schedules SET next_refresh=MIN(next_refresh,?) WHERE group_id=? AND date=?',now,j.group_id,j.date);
    return defer(env,j,now,MS,'source_not_fresh');
   }
   const l=visible(s,u.subgroup).find(l=>l.number===j.lesson_number);
   if(!l)return finish(env,j,'cancelled',now,'lesson_removed');
   const start=at(j.date,l.start),due=start-u.reminder_minutes*MS;
   if(start!==j.start_at||due!==j.due_at&&j.last_error!=='rate_limit'&&j.last_error!=='source_not_fresh'&&j.last_error!=='rate_budget'){
    await run(env,'UPDATE users SET next_plan=? WHERE user_id=?',now,u.user_id);
    return finish(env,j,'cancelled',now,'lesson_moved');
   }
   if(now>=start)return finish(env,j,'skipped',now,'already_started');
   const seconds=Math.max(1,Math.ceil((start-now)/1000));const remaining=seconds<60?seconds+' сек.':Math.ceil(seconds/60)+' мин.';
   const text=`🔔 Через ${remaining} — ${l.number}-я пара\n🕥 ${l.start}–${l.end}\n`+l.variants.map(v=>`${v.subgroup?'Подгруппа '+v.subgroup+'\n':''}📚 ${v.subject}${v.teacher?'\n👨‍🏫 '+v.teacher:''}${v.room?'\n📍 Кабинет '+v.room:''}`).join('\n')+`\n${ROOT}/groups/${u.group_id}?date=${j.date}`;
   payload=pack(text)[0];
   // Full oversized text is preserved as a multipart notification below.
   const parts=pack(text);if(parts.length>1)await createParts(env,j,parts.slice(1),now);
  } else {
   if(await one(env,"SELECT 1 AS done FROM jobs WHERE user_id=? AND date=? AND kind='morning' AND state IN ('sent','uncertain') AND job_key!=? LIMIT 1",j.user_id,j.date,j.job_key))return finish(env,j,'skipped',now,'already_sent_today');
   if(s.status==='confirmed'&&!visible(s,u.subgroup).length&&!u.send_empty)return finish(env,j,'skipped',now,'no_selected_classes');
   const parts=pack(formatDay(s,u));payload=parts[0];if(parts.length>1)await createParts(env,j,parts.slice(1),now);
  }
 }
 // Validate once more after source work and before issuing the external send.
 if(j.kind!=='reply'){
  const active=await one(env,'SELECT revision,group_id,blocked,paused_until FROM users WHERE user_id=?',j.user_id);
  if(!active||active.revision!==j.revision||active.group_id!==j.group_id||active.blocked||active.paused_until>now)return finish(env,j,'cancelled',now,'subscription_changed');
 }
 const pause=await one(env,"SELECT value FROM meta WHERE name='telegram_pause'");
 if(Number(pause?.value)>now)return defer(env,j,now,Number(pause.value)-now,'rate_limit');
 const allowed=await run(env,'INSERT INTO rate_slots(bucket,used) VALUES(?,1) ON CONFLICT(bucket) DO UPDATE SET used=used+1 WHERE used<25',Math.floor(now/1000));
 if(!allowed.meta.changes)return defer(env,j,now,1000,'rate_budget');
 const chatLock=await lock(env,'chat:'+j.chat_id,now,1000);
 if(!chatLock)return defer(env,j,now,1000,'rate_budget');
 const inFlight=await lock(env,'chat-send:'+j.chat_id,now,20000);
 if(!inFlight)return defer(env,j,now,1000,'rate_budget');
 let r;
 try{r=await telegram(env,'sendMessage',{chat_id:j.chat_id,...payload,link_preview_options:{is_disabled:true}});}
 finally{await unlock(env,'chat-send:'+j.chat_id,inFlight);}
 if(r.ok&&Number.isInteger(r.message_id)){await finish(env,j,'sent',clock(),null,r.message_id);return true;}
 if(r.type==='rate_limit'){
  await run(env,"INSERT INTO meta VALUES('telegram_pause',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",String(now+r.retry_after*1000));
  return defer(env,j,now,r.retry_after*1000,'rate_limit');
 }
 if(r.type==='blocked'){
  await env.DB.batch([sql(env,'UPDATE users SET blocked=1 WHERE user_id=?',j.user_id),sql(env,"UPDATE jobs SET state='cancelled' WHERE user_id=? AND state IN ('pending','retry')",j.user_id)]);
  return finish(env,j,'blocked',now,'telegram_403');
 }
 return finish(env,j,r.type==='uncertain'?'uncertain':'failed',now,r.type);
}
async function createParts(env,j,parts,now){
 await env.DB.batch(parts.map((payload,i)=>sql(env,`INSERT OR IGNORE INTO jobs(job_key,user_id,chat_id,lane,date,group_id,kind,due_at,expires_at,revision,payload,created_at) VALUES(?,?,?,?,?,?,'part',?,?,?,?,?)`,j.job_key+'|part|'+i,j.user_id,j.chat_id,j.lane,j.date,j.group_id,now+(i+1)*1000,j.expires_at,j.revision,JSON.stringify({...payload,_parent:j.job_key}),now)));
}
export async function deliveryTick(env,lane,now,onlyUser=null,clock=null){
 const owner=await lock(env,'delivery:'+lane,now,40000);if(!owner)return;
 try{
  // A network disconnect after Telegram accepted a message is indeterminate.
  // Do NOT retry stale sending leases: quarantine them, avoiding ordinary duplicates.
  await run(env,"UPDATE jobs SET state='uncertain',last_error='lease_expired' WHERE lane=? AND state='sending' AND lease_until<=?",lane,now);
  const jobs=await rows(env,`SELECT * FROM jobs WHERE lane=? AND state IN ('pending','retry') AND due_at<=?${onlyUser?' AND user_id=?':''} ${env.DELIVERY_ENABLED==='true'?'':" AND kind='reply'"} ORDER BY due_at LIMIT 3`,...(onlyUser?[lane,now,onlyUser]:[lane,now]));
  for(const j of jobs){
   if(j.kind==='part'){
    const u=await one(env,'SELECT * FROM users WHERE user_id=?',j.user_id);
    if(!u||u.revision!==j.revision||u.group_id!==j.group_id||u.blocked||u.paused_until>now){await run(env,"UPDATE jobs SET state='cancelled' WHERE job_key=?",j.job_key);continue;}
    await deliverJob(env,j,clock?clock():now);
   }else await deliverJob(env,j,clock?clock():now);
  }
 }finally{await unlock(env,'delivery:'+lane,owner);}
}
export async function cleanup(env,now){
 await env.DB.batch([
  sql(env,'DELETE FROM rate_slots WHERE bucket<?',Math.floor(now/1000)-120),
  sql(env,'DELETE FROM updates WHERE created_at<?',now-7*86400000),
  sql(env,'DELETE FROM dialogs WHERE updated_at<?',now-7*86400000),
  sql(env,'DELETE FROM attempts WHERE at<?',now-35*86400000),
  sql(env,'DELETE FROM jobs WHERE created_at<?',now-35*86400000),
  sql(env,'DELETE FROM schedules WHERE date<?',addDays(dayKey(now),-14)),
  sql(env,'DELETE FROM locks WHERE expires_at<?',now-86400000)
 ]);
}

// Replies have a small, paced fast path, independent of the minute/lane scheduler.
// D1 remains authoritative; every sender uses deliverJob's atomic claim and chat limit.
export async function fastReplies(env,userId,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))){
 const started=clock(),deadline=started+18000;
 const name='reply-drain:'+userId,owner=await lock(env,name,started,25000);
 if(!owner)return {pending:true,delay:2};
 let sent=0;
 try{
  for(let i=0;i<2;i++){
   const j=await one(env,`SELECT * FROM jobs WHERE user_id=? AND kind='reply'
    AND state IN ('pending','retry','sending') ORDER BY created_at,rowid LIMIT 1`,userId);
   if(!j)return {pending:false,sent};
   let now=clock();
   if(j.state==='sending'){
    if(j.lease_until<=now)await run(env,"UPDATE jobs SET state='uncertain',last_error='lease_expired' WHERE job_key=? AND state='sending' AND lease_until<=?",j.job_key,now);
    return {pending:true,delay:2,sent};
   }
   // A previous Cron sender can be using the same chat. Wait before claiming,
   // instead of turning a one-second cooldown into a one-minute retry.
   const cooldown=await one(env,'SELECT expires_at FROM locks WHERE name=?','chat:'+j.chat_id);
   const pause=await one(env,"SELECT value FROM meta WHERE name='telegram_pause'");
   const ready=Math.max(j.due_at,cooldown?.expires_at??0,Number(pause?.value)||0);
   const wait=Math.max(0,ready-now)+ (ready>now?100:0);
   if(wait>1500||now+wait+8500>deadline)return {pending:true,delay:Math.max(1,Math.ceil((ready-now)/1000)),sent};
   if(wait)await sleep(wait);
   if(await deliverJob(env,j,clock(),clock))sent++;
   // Stop on Telegram errors, including ambiguous delivery. Never blindly resend.
   const state=await one(env,'SELECT state,due_at FROM jobs WHERE job_key=?',j.job_key);
   if(state?.state==='retry')return {pending:true,delay:Math.max(1,Math.ceil((state.due_at-clock())/1000)),sent};
  }
  const pending=await one(env,"SELECT 1 AS yes FROM jobs WHERE user_id=? AND kind='reply' AND state IN ('pending','retry','sending') LIMIT 1",userId);
  return {pending:!!pending,delay:1,sent};
 }finally{await unlock(env,name,owner);}
}
