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
export async function getSchedule(env,groupId,date,now,{force=false}={}){
 const group=await one(env,'SELECT group_id,name FROM groups WHERE group_id=?',groupId);
 if(!group)return {date,status:'invalid',lessons:[]};
 let c=await one(env,'SELECT * FROM schedules WHERE group_id=? AND date=?',groupId,date);
 if(!force&&c&&now<c.next_refresh)return decode(c);
 await refreshWeek(env,group,date,now);
 c=await one(env,'SELECT * FROM schedules WHERE group_id=? AND date=?',groupId,date);
 return c?decode(c):{date,status:'loading',lessons:[]};
}
export function decode(c){
 const old=c.data?JSON.parse(c.data):{};
 return {...old,date:c.date,status:c.status,checked_at:c.checked_at,error:c.error};
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
  if(changed)await env.DB.batch([
   sql(env,"UPDATE jobs SET state='cancelled',last_error='source_changed' WHERE group_id=? AND kind='reminder' AND state IN ('pending','retry') AND due_at>?",group.group_id,now),
   sql(env,'UPDATE users SET next_plan=? WHERE group_id=? AND blocked=0',now,group.group_id)
  ]);
  return !error;
 }finally{await unlock(env,name,owner);}
}
