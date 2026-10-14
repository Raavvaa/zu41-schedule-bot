import {decodeHTML} from 'entities';
import {ROOT,norm,validTime,sql,one,rows,run,fingerprint,lock,unlock,monday,addDays,dayKey} from './core.mjs';
const htmlNorm=s=>norm(decodeHTML(String(s??'')));
const dateOf = s => {const m=htmlNorm(s).match(/^(\d{2})\.(\d{2})\.(\d{4})\b/);return m?`${m[3]}-${m[2]}-${m[1]}`:null;};
export async function parseGroups(response){
 let title='',current=null;const groups=new Map();
 const rewriter=new HTMLRewriter().on('title',{text(t){title+=t.text;}}).on('a[href]',{element(e){
  const href=e.getAttribute('href');const m=href?.match(/^\/01a011c0a5b475b38b2f1e82c13ccb26\/groups\/(\d+)$/);
  if(m){current={id:Number(m[1]),name:''};const g=current;e.onEndTag(()=>{g.name=htmlNorm(g.name);if(g.name)groups.set(g.id,g);current=null;});}
 },text(t){if(current)current.name+=t.text;}});
 await rewriter.transform(response).arrayBuffer();
 title=decodeHTML(title);
 if(!title.includes('МКГиК')||!groups.size)throw new Error('invalid_catalog');
 return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true}));
}
export async function parseWeek(response,groupName){
 let title='',day=null,slot=null,item=null;const days=[];
 const textHandler = field => ({text(t){if(item)item[field]+=t.text;}});
 const rw=new HTMLRewriter().on('title',{text(t){title+=t.text;}})
 .on('[data-testid^="LessonsDay-"]',{element(e){day={title:'',empty:'',lessons:[],invalid:false};const d=day;days.push(d);e.onEndTag(()=>{day=null;});}})
 .on('[data-testid="LessonsDayTitle"]',{text(t){if(day)day.title+=t.text;}})
 .on('[data-testid="LessonsDayEmpty"]',{text(t){if(day)day.empty+=t.text;}})
 .on('[data-testid^="LessonsSlot-"]',{element(e){if(!day)return;slot={number:'',time:'',variants:[],invalid:false};const s=slot,d=day;d.lessons.push(s);e.onEndTag(()=>{slot=null;});}})
 .on('[data-testid="LessonNumber"]',{text(t){if(slot)slot.number+=t.text;}})
 .on('[data-testid="LessonSlotTime"]',{text(t){if(slot)slot.time+=t.text;}})
 .on('[data-testid="Lesson"]',{element(e){if(!slot)return;item={subject:'',teacher:'',room:'',subgroup:'',window:(e.getAttribute('class')??'').includes('info-lesson--window')};const v=item;slot.variants.push(v);e.onEndTag(()=>{item=null;});}})
 .on('[data-testid="LessonSubject"]',textHandler('subject'))
 .on('[data-testid="LessonPeople"]',textHandler('teacher'))
 .on('[data-testid="LessonPeople"] a',{element(){if(item&&item.teacher.trim())item.teacher+='; ';}})
 .on('[data-testid="LessonCabinet"]',textHandler('room'))
 .on('.lesson-subgroup',textHandler('subgroup'));
 await rw.transform(response).arrayBuffer();
 title=decodeHTML(title);
 if(!title.includes('МКГиК')||!title.includes(groupName)||!days.length)throw new Error('invalid_html');
 const result=[];const seen=new Set();
 for(const d of days){
  const date=dateOf(d.title);if(!date||seen.has(date))throw new Error('invalid_date');seen.add(date);
  const lessons=[];
  for(const s of d.lessons){
   const t=htmlNorm(s.time).match(/^(\d\d:\d\d)\s*[-–—]\s*(\d\d:\d\d)$/);const number=Number(htmlNorm(s.number));
   if(!t||!validTime(t[1])||!validTime(t[2])||t[1]>=t[2]||!Number.isInteger(number)||number<1||number>20||!s.variants.length)throw new Error('invalid_lesson');
   const variants=[];
   for(const v of s.variants){
    if(v.window)continue;
    let subgroup='';const sub=htmlNorm(v.subgroup);let subject=htmlNorm(v.subject);
    if(sub){const m=sub.match(/^(?:п\s*\/\s*гр|подгруппа)\s*([12])$/i);if(!m)throw new Error('invalid_subgroup');subgroup=m[1];if(subject.startsWith(sub))subject=norm(subject.slice(sub.length));}
    if(!subject)throw new Error('invalid_subject');
    // A cancellation is accepted only when explicitly rendered by the source.
    if(/^(?:Пары не будет|Занятие отменено)$/i.test(subject))continue;
    variants.push({subject,teacher:htmlNorm(v.teacher),room:htmlNorm(v.room),subgroup});
   }
   if(variants.length)lessons.push({number,start:t[1],end:t[2],variants});
  }
  const explicitEmpty=htmlNorm(d.empty).toLowerCase()==='нет занятий';
  if(explicitEmpty&&lessons.length||(!d.lessons.length&&!explicitEmpty))throw new Error('incomplete_day');
  lessons.sort((a,b)=>a.start.localeCompare(b.start)||a.number-b.number);
  if(new Set(lessons.map(l=>l.number)).size!==lessons.length)throw new Error('duplicate_lesson');
  result.push({date,status:'confirmed',lessons,explicitEmpty});
 }
 return result;
}
async function publicFetch(url){
 const r=await fetch(url,{headers:{'User-Agent':'MKGIKScheduleBot/2.0'},redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(r.status!==200)throw new Error('source_http');
 if(Number(r.headers.get('content-length'))>1500000)throw new Error('source_too_large');
 return r;
}
export async function catalog(env,now,force=false){
 const checked=await one(env,"SELECT value FROM meta WHERE name='catalog_checked'");
 let gs=await rows(env,'SELECT group_id AS id,name FROM groups ORDER BY name');
 if(!force&&gs.length&&now-Number(checked?.value)<86400000)return gs;
 const owner=await lock(env,'catalog',now,20000);if(!owner){if(gs.length)return gs;throw new Error('catalog_busy');}
 try{
  gs=await parseGroups(await publicFetch(ROOT+'/groups'));
  await run(env,`INSERT INTO groups(group_id,name,checked_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),? FROM json_each(?) WHERE 1 ON CONFLICT(group_id) DO UPDATE SET name=excluded.name,checked_at=excluded.checked_at`,now,JSON.stringify(gs));
  await run(env,`UPDATE users SET group_name=(SELECT name FROM groups WHERE groups.group_id=users.group_id) WHERE EXISTS(SELECT 1 FROM groups WHERE groups.group_id=users.group_id AND groups.name!=users.group_name)`);
  await run(env,"INSERT INTO meta VALUES('catalog_checked',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",String(now));
  return gs;
 } finally{await unlock(env,'catalog',owner);}
}
export async function getSchedule(env,groupId,date,now,{force=false,preferCache=false}={}){
 let c=await one(env,'SELECT * FROM schedules WHERE group_id=? AND date=?',groupId,date);
 if(!force&&c&&(now<c.next_refresh||preferCache&&env.SHARED_CACHE==='true')){
  if(preferCache&&env.SHARED_CACHE==='true'&&now>=c.next_refresh)await requestRefresh(env,groupId,date,now);
  return {...decode(c,now),cache_hit:true};
 }
 const group=await one(env,'SELECT group_id,name FROM groups WHERE group_id=?',groupId);
 if(!group)return {date,status:'invalid',lessons:[]};
 await refreshWeek(env,group,date,now);
 c=await one(env,'SELECT * FROM schedules WHERE group_id=? AND date=?',groupId,date);
 return c?decode(c,now):{date,status:'loading',lessons:[]};
}
export function decode(c,now=0){
 const old=c.data?JSON.parse(c.data):{};
 return {...old,date:c.date,status:c.status,checked_at:c.checked_at,error:c.error,cached_stale:now>=c.next_refresh};
}
export async function refreshWeek(env,group,date,now){
 const start=monday(date);const name='source:'+group.group_id+':'+start;
 const owner=await lock(env,name,now,20000);if(!owner)return false;
 try{
  // Avoid repeated fetches when separate dates of the same week are requested.
  const prior=await one(env,"SELECT value FROM meta WHERE name=?",name);
  if(prior&&now-Number(prior.value)<60000)return false;
  await run(env,'INSERT INTO meta VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',name,String(now));
  let data,error;
  try{data=await parseWeek(await publicFetch(`${ROOT}/groups/${group.group_id}?date=${date}`),group.name);if(start>monday(dayKey(now))&&data.every(d=>!d.lessons.length))data=[];}
  catch(e){error=['invalid_html','invalid_date','invalid_lesson','invalid_subgroup','invalid_subject','incomplete_day','duplicate_lesson'].includes(e.message)?'invalid':'network_error';}
  const existing=await rows(env,'SELECT date,fingerprint,status,checked_at,data FROM schedules WHERE group_id=? AND date>=? AND date<=?',group.group_id,start,addDays(start,6));
  const old=new Map(existing.map(x=>[x.date,x]));let changed=false;const statements=[];
  for(let i=0;i<7;i++){
   const d=addDays(start,i);const found=data?.find(x=>x.date===d);const status=error??(found?'confirmed':'unpublished');
   const hash=found?await fingerprint(found):null;const prev=old.get(d);
   if(found&&(prev?.status!=='confirmed'||prev.fingerprint!==hash))changed=true;
   statements.push(sql(env,`INSERT INTO schedules(group_id,date,status,data,fingerprint,checked_at,attempt_at,error,next_refresh) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(group_id,date) DO UPDATE SET status=excluded.status,data=CASE WHEN excluded.status='confirmed' THEN excluded.data ELSE schedules.data END,
    fingerprint=CASE WHEN excluded.status='confirmed' THEN excluded.fingerprint ELSE schedules.fingerprint END,
    checked_at=CASE WHEN excluded.status='confirmed' THEN excluded.checked_at ELSE schedules.checked_at END,
    attempt_at=excluded.attempt_at,error=excluded.error,next_refresh=excluded.next_refresh`,group.group_id,d,status,found?JSON.stringify(found):null,hash,found?now:0,now,error??null,now+(error?300000:900000)));
  }
  await env.DB.batch(statements);
  if(changed){
   if(env.SHARED_CACHE==='true'){
    // Reschedule EXISTING jobs in one batch, without waiting for each student's
    // planning lane. A room-only change must not cancel otherwise valid reminders.
    // Only confirmed dates participate: a missing date/network error is no cancellation.
    const confirmed=JSON.stringify(data);
    await run(env,`WITH revised AS (
     SELECT j.job_key,
      unixepoch(j.date||'T'||json_extract(l.value,'$.start')||':00+03:00')*1000 AS start,
      unixepoch(j.date||'T'||json_extract(l.value,'$.start')||':00+03:00')*1000-u.reminder_minutes*60000 AS due
     FROM jobs j JOIN users u ON u.user_id=j.user_id
     JOIN json_each(?) d ON json_extract(d.value,'$.date')=j.date
     JOIN json_each(d.value,'$.lessons') l ON json_extract(l.value,'$.number')=j.lesson_number
     WHERE j.group_id=? AND j.kind='reminder' AND j.state IN ('pending','retry')
      AND u.revision=j.revision AND u.group_id=j.group_id
      AND EXISTS(SELECT 1 FROM json_each(l.value,'$.variants') v WHERE u.subgroup='both' OR json_extract(v.value,'$.subgroup') IN ('',u.subgroup))
    ) UPDATE jobs SET
     state=CASE WHEN EXISTS(SELECT 1 FROM revised r WHERE r.job_key=jobs.job_key AND r.start>? AND r.due>=(SELECT changed_at FROM users WHERE user_id=jobs.user_id)) THEN 'pending' ELSE 'cancelled' END,
     start_at=COALESCE((SELECT start FROM revised WHERE job_key=jobs.job_key),start_at),
     due_at=MAX(?,COALESCE((SELECT due FROM revised WHERE job_key=jobs.job_key),due_at)),
     last_error='source_changed'
     WHERE group_id=? AND kind='reminder' AND state IN ('pending','retry')
      AND date IN (SELECT json_extract(value,'$.date') FROM json_each(?))`,confirmed,group.group_id,now,now,group.group_id,confirmed);
   }else await run(env,"UPDATE jobs SET state='cancelled',last_error='source_changed' WHERE group_id=? AND kind='reminder' AND state IN ('pending','retry') AND date>=? AND date<=? AND due_at>?",group.group_id,start,addDays(start,6),now);
   await run(env,'UPDATE users SET next_plan=? WHERE group_id=? AND blocked=0',now,group.group_id);
  }
  if(env.SHARED_CACHE==='true'&&!error)await run(env,'DELETE FROM refresh_requests WHERE group_id=? AND week=? AND requested_at<=?',group.group_id,start,now);
  return !error;
 }finally{await unlock(env,name,owner);}
}

// Durable refresh intents survive an interrupted webhook. Only trusted catalogue IDs
// enter here; the fetched URL is always constructed from ROOT and that ID.
export async function requestRefresh(env,groupId,date,now){
 return run(env,`INSERT INTO refresh_requests(group_id,week,date,requested_at) VALUES(?,?,?,?)
  ON CONFLICT(group_id,week) DO NOTHING`,groupId,monday(date),date,now);
}
export async function refreshCandidates(env,now,lane=null){
 const today=dayKey(now),tomorrow=addDays(today,1);
 return rows(env,`WITH warm AS (
  SELECT g.group_id,g.name FROM groups g WHERE g.group_id=63 OR
   (SELECT count(*) FROM users u WHERE u.group_id=g.group_id AND u.blocked=0)>3
 ), targets AS (
  SELECT group_id,name,? AS date,2 AS priority FROM warm
  UNION ALL SELECT group_id,name,?,2 FROM warm
  UNION ALL SELECT r.group_id,g.name,r.date,1 FROM refresh_requests r JOIN groups g USING(group_id)
  UNION ALL SELECT j.group_id,g.name,j.date,0 FROM jobs j JOIN groups g USING(group_id)
   WHERE j.kind IN ('reminder','morning') AND j.state IN ('pending','retry') AND j.due_at>=? AND j.due_at<=?
 ) SELECT t.group_id,t.name,t.date,MIN(t.priority) AS priority FROM targets t
 LEFT JOIN schedules s ON s.group_id=t.group_id AND s.date=t.date
 LEFT JOIN meta m ON m.name='source:'||t.group_id||':'||date(t.date,'weekday 0','-6 days')
 WHERE (? IS NULL OR t.group_id%4=?) AND (m.value IS NULL OR CAST(m.value AS INTEGER)<=?)
 AND (s.date IS NULL OR s.next_refresh<=? OR t.priority=0 AND s.attempt_at<=?
  OR t.priority=1 AND EXISTS(SELECT 1 FROM refresh_requests r WHERE r.group_id=t.group_id AND r.week=date(t.date,'weekday 0','-6 days') AND r.requested_at>s.attempt_at))
 GROUP BY t.group_id,date(t.date,'weekday 0','-6 days')
 ORDER BY priority,COALESCE(s.next_refresh,0),t.group_id LIMIT 4`,today,tomorrow,now-120000,now+60000,lane,lane,now-60000,now,now-60000);
}
