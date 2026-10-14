export const ROOT = 'https://site.mstimetables.ru/01a011c0a5b475b38b2f1e82c13ccb26';
export const MS = 60000;
export const esc = s => String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export const norm = s => String(s??'').replace(/\s+/g,' ').trim();
export const validTime = s => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
export const dayKey = ts => new Date(ts+3*3600000).toISOString().slice(0,10);
export const at = (date,time) => Date.parse(`${date}T${time}:00+03:00`);
export const addDays = (date,n) => new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const monday = date => addDays(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));
export const visible = (schedule,subgroup) => (schedule.lessons??[]).map(l=>({...l,variants:l.variants.filter(v=>!v.subgroup||subgroup==='both'||v.subgroup===subgroup)})).filter(l=>l.variants.length);
export const sql = (env,s,...args) => env.DB.prepare(s).bind(...args);
export const one = (env,s,...args) => sql(env,s,...args).first();
export const rows = async (env,s,...args) => (await sql(env,s,...args).all()).results;
export const run = (env,s,...args) => sql(env,s,...args).run();
export async function lock(env,name,now,ttl=60000) {
 const owner=crypto.randomUUID();
 const r=await run(env,'INSERT INTO locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE locks.expires_at<=?',name,owner,now+ttl,now);
 return r.meta.changes ? owner : null;
}
export const unlock=(env,name,owner)=>run(env,'DELETE FROM locks WHERE name=? AND owner=?',name,owner);
export async function fingerprint(value) {
 const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
 return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// Split raw text first, then escape each part, so HTML and entities never break.
export function pack(text) {
 const parts=[];let current='';
 for(const line of String(text).split('\n')) {
  for(let offset=0;offset<Math.max(1,line.length);offset+=650) {
   const fragment=line.slice(offset,offset+650);
   if(esc(current+'\n'+fragment).length>3700){parts.push({text:esc(current),parse_mode:'HTML'});current='';}
   current+=(current?'\n':'')+fragment;
  }
 }
 if(current)parts.push({text:esc(current),parse_mode:'HTML'});
 return parts;
}
export function lessonText(l){return `${l.number}-я пара · ${l.start}–${l.end}\n`+l.variants.map(v=>`${v.subgroup?'['+v.subgroup+'] ':''}📚 ${v.subject}${v.teacher?'\n👨‍🏫 '+v.teacher:''}${v.room?'\n📍 Кабинет '+v.room:''}`).join('\n');}
export function formatDay(s,u) {
 const link=`${ROOT}/groups/${u.group_id}?date=${s.date}`;
 const heading=`📅 ${s.date.split('-').reverse().join('.')}\n🎓 ${u.group_name}${u.subgroup==='both'?' · обе подгруппы':' · подгруппа '+u.subgroup}`;
 if(s.status!=='confirmed') {
  const labels={unpublished:'Дата ещё не опубликована',network_error:'Не удалось запросить сайт расписания',invalid:'Не удалось проверить структуру расписания',loading:'Расписание проверяется'};
  return `${heading}\n\n⚠️ ${labels[s.status]??'Нет надёжных данных'}. Это не означает выходной.\n${s.checked_at?'Последняя успешная проверка: '+new Date(s.checked_at+10800000).toISOString().replace('T',' ').slice(0,19)+' МСК.\n':''}${link}`;
 }
 const cached=s.cached_stale?'\n🕒 Сохранённая копия. Последняя успешная проверка: '+new Date(s.checked_at+10800000).toISOString().replace('T',' ').slice(0,19)+' МСК. Обновление запрошено.':'';
 const ls=visible(s,u.subgroup);
 if(!ls.length)return `${heading}\n\n${s.explicitEmpty?'На сайте указано: занятий нет.':'Для выбранной подгруппы занятия не указаны.'}${cached}\n${link}`;
 return heading+'\n\n'+ls.map(lessonText).join('\n\n')+`\n\nВсего пар: ${ls.length} · ${ls[0].start}–${ls.at(-1).end}${cached}\n${link}`;
}
export function nextLesson(s,u,now){
 if(s.status!=='confirmed'||s.cached_stale)return formatDay(s,u);
 const ls=visible(s,u.subgroup);const current=ls.find(l=>at(s.date,l.start)<=now&&now<at(s.date,l.end));
 const next=ls.find(l=>at(s.date,l.start)>now);
 return current?'Сейчас идёт:\n'+lessonText(current)+(next?'\n\nСледующая:\n'+lessonText(next):''):next?'Следующая пара:\n'+lessonText(next):'На сегодня следующих пар в проверенном расписании нет.\n'+ROOT+'/groups/'+u.group_id;
}
export async function telegram(env,method,data) {
 try {
  const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(8000)});
  const p=await res.json();
  if(p.ok===true)return {ok:true,message_id:p.result?.message_id,result:p.result};
  if(res.status===429||p.error_code===429)return {ok:false,type:'rate_limit',retry_after:Math.max(1,Number(p.parameters?.retry_after)||30)};
  if(res.status===403||p.error_code===403)return {ok:false,type:'blocked'};
  return {ok:false,type:'rejected',code:res.status};
 } catch {return {ok:false,type:'uncertain'};}
}
