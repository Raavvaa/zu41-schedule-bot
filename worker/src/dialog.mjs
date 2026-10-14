import {catalog,getSchedule} from './source.mjs';
import {MS,ROOT,dayKey,at,addDays,monday,pack,formatDay,nextLesson,one,rows,run,sql,validTime,lock,unlock,telegram} from './core.mjs';
const menu={keyboard:[['📅 Сегодня','📆 Завтра'],['⏭ Сейчас / следующая пара','🗓 Неделя'],['🎓 Моя группа','⚙️ Настройки']],resize_keyboard:true};
const defaults={subgroup:'both',morning_time:'06:00',morning_enabled:1,reminders_enabled:1,reminder_minutes:10,send_empty:0,paused_until:0};
export function cleanUpdate(raw){
 if(!Number.isSafeInteger(raw.update_id))return null;
 const m=raw.message??raw.callback_query?.message;const f=raw.message?.from??raw.callback_query?.from;
 if(!m||m.chat?.type!=='private'||!Number.isSafeInteger(f?.id)||m.chat.id!==f.id)return null;
 return {update_id:raw.update_id,user_id:f.id,chat_id:m.chat.id,text:typeof raw.message?.text==='string'?raw.message.text.slice(0,100):'',callback:typeof raw.callback_query?.data==='string'?raw.callback_query.data.slice(0,64):'',callback_id:raw.callback_query?.id??null};
}
async function reply(env,u,text,now,id,keyboard){
 const parts=pack(text);
 await env.DB.batch(parts.map((part,i)=>sql(env,`INSERT OR IGNORE INTO jobs(job_key,user_id,chat_id,lane,date,kind,due_at,expires_at,revision,payload,created_at) VALUES(?,?,?,?,?,'reply',?,?,0,?,?)`,`${u.user_id}|reply|${id}|${i}`,u.user_id,u.chat_id,u.user_id%8,dayKey(now),now,now+10*MS,JSON.stringify({...part,...(i===parts.length-1&&keyboard?{reply_markup:keyboard}:{})}),now)));
}
async function saveDialog(env,id,state,draft,now){
 const nonce=crypto.randomUUID().slice(0,6);
 await run(env,'INSERT INTO dialogs VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,draft=excluded.draft,nonce=excluded.nonce,updated_at=excluded.updated_at',id,state,JSON.stringify(draft),nonce,now);
 return nonce;
}
function keyboard(id,nonce,rows){return {inline_keyboard:rows.map(row=>row.map(([text,action])=>({text,callback_data:`v:${id}:${nonce}:${action}`})))};}
function summary(d){return `Группа: ${d.group_name}\nПодгруппа: ${d.subgroup==='both'?'обе':d.subgroup}\nУтром: ${d.morning_enabled?d.morning_time+' МСК':'выключено'}\nНапоминания: ${d.reminders_enabled?'за '+d.reminder_minutes+' минут':'выключены'}\nВ дни без занятий: ${d.send_empty?'присылать':'не присылать'}\n${d.paused_until?'Пауза до '+dayKey(d.paused_until):'Пауза не включена'}`;}
export async function processUpdate(env,update,now=Date.now(),ctx=null){
 const owner=await lock(env,'user:'+update.user_id,now,30000);if(!owner)return false;
 try{
  const claim=await run(env,"UPDATE updates SET state='processing' WHERE update_id=? AND state='pending'",update.update_id);
  if(!claim.meta.changes)return true;
  await dialog(env,update,now,ctx);
  await run(env,"UPDATE updates SET state='done',payload='{}' WHERE update_id=?",update.update_id);
  return true;
 }catch{
  // A processed update is never replayed blindly. Its durable outbox is independent.
  await run(env,"UPDATE updates SET state='failed',payload='{}' WHERE update_id=?",update.update_id);
  await reply(env,update,'⚠️ Не удалось выполнить запрос. Попробуй ещё раз; сохранённые настройки не сброшены.',now,update.update_id+'-error',menu);
  return false;
 }finally{await unlock(env,'user:'+update.user_id,owner);}
}
async function dialog(env,u,now,ctx){
 const answer=async data=>{const p=telegram(env,'answerCallbackQuery',data);if(ctx)ctx.waitUntil(p);else await p;};
 let saved=await one(env,'SELECT * FROM users WHERE user_id=?',u.user_id);
 let session=await one(env,'SELECT * FROM dialogs WHERE user_id=?',u.user_id);
 let draft=session?JSON.parse(session.draft):{...defaults};let action=null;
 const send=(text,k)=>reply(env,u,text,now,u.update_id,k);
 const screen=async(state,d,text,rs)=>{const n=await saveDialog(env,u.user_id,state,d,now);return send(text,keyboard(u.user_id,n,rs));};
 if(u.callback){
  const m=u.callback.match(/^v:(\d+):([\da-f]{6}):([\w:-]+)$/);
  if(!m||Number(m[1])!==u.user_id||!session||m[2]!==session.nonce||now-session.updated_at>86400000){
   if(u.callback_id)await answer({callback_query_id:u.callback_id,text:'Кнопка устарела. Открой /start.',show_alert:false});
   return;
  }
  action=m[3];
  if(u.callback_id)await answer({callback_query_id:u.callback_id});
 }
 const groupList=async(query='',page=0,mode=draft.mode??'subscribe')=>{
  let gs;
  try{gs=await catalog(env,now);}catch{return screen('groups',{...draft,mode},'⚠️ Каталог групп временно недоступен. Попробуй позже.',[[['Повторить','list:0']],[['Назад','back']]]);}
  const normalized=query.toUpperCase().replace(/[\s–—]/g,'');
  const matches=gs.filter(g=>g.name.toUpperCase().replace(/[\s–—]/g,'').includes(normalized));
  const pages=Math.max(1,Math.ceil(matches.length/8));page=Math.max(0,Math.min(page,pages-1));
  const rs=matches.slice(page*8,page*8+8).map(g=>[[g.name,'group:'+g.id]]);
  const nav=[];if(page)nav.push(['←','list:'+(page-1)]);if(page+1<pages)nav.push(['→','list:'+(page+1)]);if(nav.length)rs.push(nav);
  rs.push([['Все группы','all'],['Назад','back']]);
  return screen('groups',{...draft,mode,query},`${matches.length?'Выбери группу':'Совпадений нет'}. Страница ${page+1}/${pages}.\nДля поиска напиши, например, ЗУ-41.`,rs);
 };
 const confirmation=()=>screen('confirm',draft,summary(draft),[[['✅ Сохранить','save']],[['Назад','settings'],['Отмена','back']]]);
 const morning=()=>screen('morning',draft,`Группа: ${draft.group_name}. Когда присылать расписание? Время московское.`,[[['🌅 Каждое утро в 06:00','time:06:00']],[['🕓 Выбрать другое время','custom_times']],[['🚫 Без утренней рассылки','time:off']],[['Назад','back']]]);
 const remind=()=>screen('reminders',draft,'Напоминать перед каждой парой?',[[['🔔 Да, за 10 минут','interval:10']],[['⚙️ Выбрать интервал','intervals']],[['🔕 Не напоминать','interval:off']],[['Назад','back']]]);
 const subgroup=()=>screen('subgroup',draft,'Какая подгруппа? Общие занятия показываются при любом выборе. Если разделения нет, выбери обе.',[[['1','sub:1'],['2','sub:2']],[['Показывать обе','sub:both']],[['Назад','back']]]);
 const settings=()=>{
  if(!saved)return groupList();draft={...saved,editing:true,mode:'subscribe'};
  return screen('settings',draft,summary(draft),[[['Сменить группу','change_group'],['Подгруппа','subgroup']],[['Время рассылки','morning'],['Напоминания','reminders']],[['Присылать и в дни без занятий','empty']],[['Пауза до завтра','pause']],[['Удалить мои настройки','delete']],[['Назад','back']]]);
 };
 if(u.text==='/start'||u.text==='/menu'||action==='back'){
  if(saved){if(saved.blocked)await run(env,'UPDATE users SET blocked=0,next_plan=? WHERE user_id=?',now,u.user_id);await saveDialog(env,u.user_id,'menu',{},now);return send('Твои настройки сохранены. Выбери действие.',menu);}
  draft={...defaults,mode:'subscribe'};await saveDialog(env,u.user_id,'groups',draft,now);
  return send('Привет! Я показываю расписание МКГиК и напоминаю о парах. Сначала выбери свою группу.\nНапиши название для поиска, например ЗУ-41.',{inline_keyboard:keyboard(u.user_id,(await one(env,'SELECT nonce FROM dialogs WHERE user_id=?',u.user_id)).nonce,[[['Все группы','all']]]).inline_keyboard});
 }
 if(u.text==='⚙️ Настройки'||u.text==='/settings'||action==='settings')return settings();
 if(u.text==='🎓 Моя группа'){
  if(!saved)return groupList();draft={...saved,editing:true};
  return screen('mygroup',draft,`Твоя группа: ${saved.group_name}. Подгруппа: ${saved.subgroup==='both'?'обе':saved.subgroup}`,[[['Сменить группу','change_group']],[['Посмотреть другую группу','preview']],[['Назад','back']]]);
 }
 if(['📅 Сегодня','📆 Завтра','⏭ Сейчас / следующая пара','🗓 Неделя'].includes(u.text)||['today','view'].includes(action)){
  const target=action==='view'?{...draft,subgroup:'both'}:saved;
  if(!target)return groupList();
  const today=dayKey(now),date=u.text==='📆 Завтра'?addDays(today,1):today;
  const s=await getSchedule(env,target.group_id,date,now);
  if(u.text==='⏭ Сейчас / следующая пара')return send(nextLesson(s,target,now),menu);
  if(u.text==='🗓 Неделя'){
   const start=monday(today);const all=await rows(env,'SELECT data,status,date,checked_at FROM schedules WHERE group_id=? AND date>=? AND date<=?',target.group_id,start,addDays(start,6));
   const text=Array.from({length:7},(_,i)=>{const d=addDays(start,i);const x=all.find(r=>r.date===d);return formatDay(x?{...JSON.parse(x.data??'{}'),status:x.status,date:d,checked_at:x.checked_at}:{date:d,status:'unpublished'},target);}).join('\n\n────────\n\n');
   return send(text,menu);
  }
  return send(formatDay(s,target),action==='view'?keyboard(u.user_id,session.nonce,[[['Подписаться на эту группу','subscribe_preview']],[['Назад','back']]]):menu);
 }
 if(action==='change_group'||action==='preview'||action==='subscribe_preview'){
  draft={...(saved??defaults),editing:!!saved,mode:action==='preview'?'preview':'subscribe'};
  if(action==='subscribe_preview'){
   draft.group_id=JSON.parse(session.draft).group_id;draft.group_name=JSON.parse(session.draft).group_name;draft.subgroup=null;
   return subgroup();
  }
  return groupList('',0,draft.mode);
 }
 if(action==='all')return groupList('',0);
 if(action?.startsWith('list:'))return groupList(draft.query??'',Number(action.split(':')[1]));
 if(action?.startsWith('group:')&&session.state==='groups'){
  const id=Number(action.split(':')[1]);const gs=await catalog(env,now);const selected=gs.find(g=>g.id===id);if(!selected)return send('Эта группа отсутствует в актуальном каталоге. Повтори поиск.',menu);
  draft={...draft,group_id:id,group_name:selected.name,subgroup:'both'};
  if(draft.mode==='preview')return screen('preview',draft,`Просмотр: ${draft.group_name}. Твоя подписка не изменена.`,[[['📅 Посмотреть сегодня','view']],[['Подписаться','subscribe_preview']],[['Назад','back']]]);
  const s=await getSchedule(env,id,dayKey(now),now);
  const cached=await rows(env,"SELECT data FROM schedules WHERE group_id=? AND status='confirmed'",id);
  const hasSubs=cached.some(c=>JSON.parse(c.data).lessons.some(l=>l.variants.some(v=>v.subgroup)));
  if(hasSubs||s.status!=='confirmed')return subgroup();
  return draft.editing?confirmation():morning();
 }
 if(action==='subgroup')return subgroup();
 if(action?.startsWith('sub:')&&session.state==='subgroup'){
  const sub=action.slice(4);if(!['1','2','both'].includes(sub))return;draft.subgroup=sub;return draft.editing?confirmation():morning();
 }
 if(action==='morning')return morning();
 if(action==='custom_times')return screen('time',draft,'Выбери время или напиши ЧЧ:ММ (например, 08:05). Время московское.',[[['06:30','time:06:30'],['07:00','time:07:00'],['07:30','time:07:30']],[['Назад','morning']]]);
 if(action?.startsWith('time:')&&['morning','time'].includes(session.state)||u.text&&session?.state==='time'){
  const time=action?.slice(5)??u.text;
  if(time!=='off'&&!validTime(time))return send('Нужно время в формате ЧЧ:ММ: часы 00–23, минуты 00–59. Например 06:30.');
  draft.morning_enabled=time==='off'?0:1;if(time!=='off')draft.morning_time=time;
  return draft.editing?confirmation():remind();
 }
 if(action==='reminders')return remind();
 if(action==='intervals')return screen('reminders',draft,'За сколько минут напоминать?',[[['5','interval:5'],['10','interval:10'],['15','interval:15'],['30','interval:30']],[['🔕 Не напоминать','interval:off']]]);
 if(action?.startsWith('interval:')&&session.state==='reminders'){
  const val=action.slice(9);if(val!=='off'&&![5,10,15,30].includes(Number(val)))return;
  draft.reminders_enabled=val==='off'?0:1;if(val!=='off')draft.reminder_minutes=Number(val);return confirmation();
 }
 if(action==='empty'){draft.send_empty=draft.send_empty?0:1;return confirmation();}
 if(action==='pause'){draft.paused_until=at(addDays(dayKey(now),1),'00:00');return confirmation();}
 if(action==='delete')return screen('delete',draft,'Удалить твои настройки и отменить все твои будущие уведомления?',[[['Да, удалить','delete_yes']],[['Отмена','back']]]);
 if(action==='delete_yes'&&session.state==='delete'){
  await env.DB.batch([
   sql(env,'DELETE FROM attempts WHERE job_key IN (SELECT job_key FROM jobs WHERE user_id=?)',u.user_id),
   sql(env,'DELETE FROM jobs WHERE user_id=?',u.user_id),sql(env,'DELETE FROM users WHERE user_id=?',u.user_id),
   sql(env,'DELETE FROM dialogs WHERE user_id=?',u.user_id),sql(env,'DELETE FROM updates WHERE user_id=?',u.user_id)
  ]);
  await telegram(env,'sendMessage',{chat_id:u.chat_id,text:'Твои настройки удалены, рассылка остановлена. Для новой регистрации — /start.',reply_markup:{remove_keyboard:true}});return;
 }
 if(action==='save'&&session.state==='confirm'){
  const group=await one(env,'SELECT name FROM groups WHERE group_id=?',draft.group_id);
  if(!group||!['both','1','2'].includes(draft.subgroup)||!validTime(draft.morning_time)||![5,10,15,30].includes(draft.reminder_minutes))return send('Настройки не прошли проверку. Открой /start.');
  const capacityOwner=saved?null:await lock(env,'registration',now,20000);
  if(!saved&&!capacityOwner)return send('Сейчас идёт другая регистрация. Через несколько секунд нажми «Сохранить» ещё раз.');
  const total=await one(env,'SELECT count(*) AS n FROM users');
  if(!saved&&total.n>=Math.min(50,Number(env.MAX_USERS)||50)){if(capacityOwner)await unlock(env,'registration',capacityOwner);return send('Пилотная версия пока заполнена. Попробуй позже.');}
  const revision=(saved?.revision??0)+1;
  await env.DB.batch([
   sql(env,`INSERT INTO users(user_id,chat_id,group_id,group_name,subgroup,morning_time,morning_enabled,reminders_enabled,reminder_minutes,send_empty,paused_until,blocked,revision,changed_at,next_plan,lane)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET group_id=excluded.group_id,group_name=excluded.group_name,subgroup=excluded.subgroup,morning_time=excluded.morning_time,morning_enabled=excluded.morning_enabled,reminders_enabled=excluded.reminders_enabled,reminder_minutes=excluded.reminder_minutes,send_empty=excluded.send_empty,paused_until=excluded.paused_until,blocked=0,revision=excluded.revision,changed_at=excluded.changed_at,next_plan=excluded.next_plan`,u.user_id,u.chat_id,draft.group_id,group.name,draft.subgroup,draft.morning_time,Number(!!draft.morning_enabled),Number(!!draft.reminders_enabled),draft.reminder_minutes,Number(!!draft.send_empty),draft.paused_until??0,revision,now,now,u.user_id%8),
   sql(env,"UPDATE jobs SET state='cancelled',last_error='settings_changed' WHERE user_id=? AND kind!='reply' AND state IN ('pending','retry')",u.user_id)
  ]);
  if(capacityOwner)await unlock(env,'registration',capacityOwner);
  await saveDialog(env,u.user_id,'menu',{},now);
  return send('✅ Настройки сохранены.\n'+summary({...draft,group_name:group.name})+'\n\nНажми «📅 Сегодня», чтобы посмотреть актуальное расписание. Прошедшие напоминания не отправляются.',menu);
 }
 if(u.text&&session?.state==='groups')return groupList(u.text,0);
 if(!saved)return groupList();
 return send('Выбери действие в меню. Для настроек — /settings.',menu);
}
