import {captureDeletionSnapshot,deletionWatch,recordDeletions,setDeletionWatch} from './deletions.mjs';
import {formatDuration,MODE_DURATION_ERROR,validModeDuration} from './duration.mjs';
import {formatLetterCase,letterCase} from './preferences.mjs';
import {background} from './background.mjs';
import {one,all,run,batch,key,clock,OWNER,getChat,putMessage,queue,stop,maintenance,audit,createProposal,recentReplies,budgets,snapshotChat} from './store.mjs';
import {ownerTurn,peerTurn,proposalCard,PEER_SYSTEM,parsePeer} from './agent.mjs';
import {completion,providerConfig,providerNames,ModelUnavailable,parseJSON} from './providers.mjs';
import {telegram,setAvatar} from './telegram.mjs';
import {repeatedReply} from './dialogue.mjs';

export const prefix=text=>/^панда(?:[\s,!:]|$)/iu.test(text);
const strip=text=>text.replace(/^панда[\s,!:]*/iu,'').trim();
const helpHere=text=>/^(?:помогай|помоги|работай|включись)\s+здесь[.!\s]*$/iu.test(text.trim());
export const autoHere=text=>/^(?:отвечай(?:\s+на\s+все\s+сообщения)?|(?:включи|возобнови)\s+автоответы?|продолжай\s+отвечать)(?:\s+(?:здесь|в\s+этом\s+чате|этого\s+чата))?[.!\s]*$/iu.test(text.trim());
const slash=text=>text.trim().match(/^\/([\p{L}\w]+)(?:@\w+)?(?:\s+([\s\S]*))?$/u)?.[1]?.toLowerCase();
export const stopAllCommand=text=>/^(?:выключи|отключи|останови)\s+(?:автоответ(?:ы|чик)?|ответы)(?:\s+(?:во?|на)\s+всех\s+чатах)[.!\s]*$/iu.test(text.trim());
export const peerDelay=env=>Math.min(12000,Math.max(0,Number(env.PEER_DEBOUNCE_MS ?? 4000)||0));
export const stopCommand=text=>stopAllCommand(text)||/^(?:\/stop(?:@\w+)?|стоп|остановись|останови всё|останови все|выключись)[.!\s]*$/iu.test(text.trim());
const startText='Я Панда 🐼 Можно просто поговорить, попросить запомнить важное или поручить дело.\n\nЧтобы я помогала в твоих личных чатах: включи Secretary/Business Mode у этого бота в @BotFather → Bot Settings, затем Telegram → Настройки → Изменить → Автоматизация чатов → выбери меня и нужные чаты. После подключения напиши в нужном чате «панда, помогай здесь» или открой /chats.\n\nСначала покажу черновики тебе. Автоответ включается отдельно и на время. «панда, стоп» или /stop останавливает ответы. Голосовые не обрабатываю.\n/status — состояние, /memory — память, /chats — подключённые чаты.';

async function chatButtons(env,eventId){
 const [chats,watching]=await Promise.all([all(env,'SELECT * FROM chats ORDER BY title LIMIT 20'),deletionWatch(env)]);
 const journal=watching?'включён':'выключен';
 await queue(env,'reply:'+eventId,
  'Журнал удалений '+journal+' для всех подключённых личных чатов. Обычные сообщения сохраняются до 72 часов.\n\n'+
  (chats.length?'Выбери чат, чтобы настроить черновики или автоответ.':'Подключённые чаты появятся здесь после первого сообщения. По одному @имени я не могу открыть чужую личную переписку.'),
  {markup:{inline_keyboard:[
   [{text:(watching?'Выключить':'Включить')+' журнал для всех',callback_data:watching?'unwatch:all':'watch:all'}],
   ...chats.map(c=>[{text:c.title.slice(0,45)+' · '+c.mode,callback_data:'chat:'+c.id}])
  ]}});
}
async function status(env,eventId){
 const now=clock(env),day=new Date(now).toISOString().slice(0,10),[chats,usage,uncertain,s,connections]=await Promise.all([all(env,'SELECT title,mode,until_at FROM chats'),one(env,'SELECT * FROM usage WHERE day=?',[day]),one(env,"SELECT count(*) AS n FROM outbox WHERE state='unknown'"),one(env,'SELECT paused FROM settings WHERE id=1'),one(env,'SELECT count(*) AS n FROM connections WHERE enabled=1')]);
 await queue(env,'reply:'+eventId,`Панда работает. ${s.paused?'Автоответы остановлены.':''}\n${connections.n?'Профиль подключён.':'Сервер ещё не получил подключение профиля.'}\n${chats.map(c=>`${c.title}: ${c.mode==='off'||c.until_at<=now?'выключено':(c.mode==='auto'?'автоответ':'черновики')+' · ещё '+formatDuration(Math.ceil((c.until_at-now)/60000))}`).join('\n')||'Сообщения выбранных чатов пока не поступили.'}\nОбращений к моделям сегодня: ${(await budgets(env)).filter(b=>providerConfig(env).some(p=>p.key&&p.name===b.provider)).map(b=>b.provider+': остаток '+b.requests+' запросов / '+b.tokens+' токенов').join('; ')}.\nОтправок с неизвестным результатом: ${uncertain.n}.`);
}
async function enableAutoHere(env,scope){
 const c=await getChat(env,scope);
 const conn=c?.kind==='private'?await one(env,'SELECT * FROM connections WHERE id=? AND enabled=1',[c.connection_id]):null;
 if(!conn||!JSON.parse(conn.rights).can_reply)return 'В настройках подключения нужно разрешить ответы.';
 await snapshotChat(env,c.id);
 await batch(env,[
  ['UPDATE settings SET paused=0 WHERE id=1'],
  ["UPDATE chats SET mode='auto',consent=1,until_at=?,pause_until=0,revision=revision+CASE WHEN mode='auto' AND consent=1 AND until_at>? AND pause_until<=? THEN 0 ELSE 1 END WHERE id=?",[clock(env)+120*60000,clock(env),clock(env),c.id]],
  ["UPDATE proposals SET status='cancelled' WHERE scope=? AND kind='mode' AND status='pending'",[c.id]]
 ]);
 await audit(env,'owner_auto_enabled');
 return `В чате «${c.title}» включены автоответы на 2 часа. На новые текстовые сообщения отвечу автоматически. Твои сообщения больше не ставят чат на паузу. Остановить: «панда, стоп».`;
}
async function resolveConnection(env,id){
 if(typeof id!=='string'||!id)return null;
 const known=await one(env,'SELECT * FROM connections WHERE id=?',[id]);
 // A recorded revocation always wins over an old message or an in-flight lookup.
 if(known)return known.enabled?known:null;
 await audit(env,'business_connection_lookup');
 let live;
 try{live=await telegram(env,'getBusinessConnection',{business_connection_id:id});}
 catch(error){if(['400','403','404'].includes(error.code)){await audit(env,'business_connection_invalid');return null;}throw error;}
 if(live.id!==id||String(live.user?.id)!==String(env.OWNER_ID)){await audit(env,'business_connection_owner_mismatch');return null;}
 await run(env,'INSERT OR IGNORE INTO connections(id,enabled,rights,at) VALUES(?,?,?,?)',[id,live.is_enabled?1:0,JSON.stringify(live.rights??{}),clock(env)]);
 const current=await one(env,'SELECT * FROM connections WHERE id=?',[id]);
 if(current.enabled)await audit(env,'business_connection_recovered');
 return current.enabled?current:null;
}
export async function acceptUpdate(env,u){
 if(!Number.isSafeInteger(u.update_id))return;
 const id=String(u.update_id),now=clock(env),owner=String(env.OWNER_ID);
 if(await one(env,'SELECT id FROM inbox WHERE id=?',[id]))return;
 let event=null;
 if(u.business_connection){
  const c=u.business_connection;if(String(c.user?.id)!==owner){await audit(env,'business_connection_owner_mismatch');return;}
  await batch(env,[['INSERT OR IGNORE INTO inbox(id,scope,payload,state,at) VALUES(?,?,?, ?,?)',[id,OWNER,'{}','done',now]],['INSERT INTO connections(id,enabled,rights,at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,rights=excluded.rights,at=excluded.at',[c.id,c.is_enabled?1:0,JSON.stringify(c.rights??{}),now]]]);
  if(!c.is_enabled){for(const row of await all(env,'SELECT id FROM chats WHERE connection_id=?',[c.id]))await stop(env,row.id);}
  await queue(env,'reply:'+id,c.is_enabled?'Профиль подключён 🐼 Напиши «панда, помогай здесь» в выбранном чате — я предложу включить черновики.':'Подключение отключено. Автоответы остановлены.');return;
 }
 if(u.my_chat_member){
  const m=u.my_chat_member;if(String(m.from?.id)!==owner||m.chat?.type!=='channel')return;
  const me=m.new_chat_member,cid=await key('channel:'+m.chat.id);
  if(me.status==='administrator'&&me.can_post_messages)await run(env,"INSERT INTO chats(id,telegram_id,title,kind) VALUES(?,?,?,'channel') ON CONFLICT(id) DO UPDATE SET title=excluded.title",[cid,String(m.chat.id),m.chat.title||'Канал']);
  else await stop(env,cid);
  await run(env,"INSERT OR IGNORE INTO inbox(id,scope,payload,state,at) VALUES(?,?,?,'done',?)",[id,OWNER,'{}',now]);return;
 }
 if(u.deleted_business_messages){
  const d=u.deleted_business_messages;if(!await one(env,'SELECT id FROM connections WHERE id=?',[d.business_connection_id]))return;
  const scope=await key(d.business_connection_id+':'+d.chat.id);
  await recordDeletions(env,scope,id,d.message_ids??[]);return;
 }
 if(u.callback_query){
  const q=u.callback_query;if(String(q.from?.id)!==owner)return;
  event={id,scope:OWNER,type:'callback',data:String(q.data??''),callback_id:q.id};
  // Stop doesn't wait for an LLM or the queue lock.
  if(q.data==='stop:all')await stop(env);
  else if(String(q.data).startsWith('stop:'))await stop(env,String(q.data).slice(5));
 }else if(u.business_message||u.edited_business_message){
  const m=u.business_message||u.edited_business_message;
  if(m.chat?.type!=='private'||m.sender_business_bot)return;
  const conn=await resolveConnection(env,m.business_connection_id);
  if(!conn)return;
  await audit(env,'business_message_accepted');
  const scope=await key(m.business_connection_id+':'+m.chat.id),text=String(m.text??m.caption??''),isOwner=String(m.from?.id)===owner;
  await run(env,'INSERT INTO chats(id,connection_id,telegram_id,title) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title',[scope,m.business_connection_id,String(m.chat.id),[m.chat.first_name,m.chat.last_name].filter(Boolean).join(' ')||m.chat.username||'Личный чат']);
  await captureDeletionSnapshot(env,scope,m);
  if(m.chat.username)await run(env,'INSERT OR IGNORE INTO chat_aliases(chat_id,alias) VALUES(?,?)',[scope,String(m.chat.username).toLowerCase()]);
  if(isOwner&&prefix(text)&&!u.edited_business_message){
   const command=strip(text);if(stopCommand(command))await stop(env,stopAllCommand(command)?null:scope);
   // Explicit local activation is applied at ingestion, just like stop. The
   // queued receipt must never reactivate the chat after a later stop command.
   event=autoHere(command)?{id,scope:OWNER,type:'notice',text:await enableAutoHere(env,scope),target:scope}:{id,scope:OWNER,type:'owner',text:command,target:scope};
  }else{
   const c=await getChat(env,scope);
   const messageId=scope+':'+m.message_id;
   if(!u.edited_business_message&&await one(env,'SELECT id FROM messages WHERE id=?',[messageId]))return;
   // No third-party text retained or sent to LLM before per-chat opt-in.
   // Manual replies invalidate work already being generated, but do not mute
   // future incoming turns. Clear legacy ten-minute pauses on either new turn.
   if(isOwner)await run(env,'UPDATE chats SET last_manual=?,pause_until=0,revision=revision+1 WHERE id=?',[now,scope]);
   else await run(env,'UPDATE chats SET last_incoming=?,pause_until=0,revision=revision+1 WHERE id=?',[now,scope]);
   if(!c.consent||c.mode==='off'||c.until_at<=now)return;
   if(!text||m.voice||m.audio||m.video_note){if(!isOwner)await queue(env,'media:'+id,'В чате «'+c.title+'» пришло сообщение без текста. Я его не анализировала.');return;}
   if(u.edited_business_message)await batch(env,[['DELETE FROM messages WHERE id=?',[messageId]],['DELETE FROM chat_facts WHERE chat_id=? AND source_message_id=?',[scope,messageId]],['DELETE FROM conversation_state WHERE chat_id=?',[scope]]]);
   const quoted=m.reply_to_message,quoteText=quoted?.text??quoted?.caption;
   const replyContext=!isOwner&&quoted?(quoteText?'\n[Ответ на цитату: '+String(quoteText).slice(0,500)+']':quoted.voice||quoted.audio?'\n[Ответ на голосовое: содержимое не распознано]':''):'';
   await putMessage(env,{id:messageId,scope,role:isOwner?'assistant':'user',body:text+replyContext,manual:isOwner?1:0});
   // An edit corrects context and invalidates old drafts, but is not a new turn.
   if(isOwner){await run(env,"UPDATE inbox SET state='done',payload='{}' WHERE scope=? AND state='pending' AND json_extract(payload,'$.type')='peer'",[scope]);return;}
   if(u.edited_business_message)return;
   event={id,scope,type:'peer',message_id:messageId};
  }
 }else if(u.message){
  const m=u.message;if(String(m.from?.id)!==owner||String(m.chat?.id)!==owner||m.chat?.type!=='private')return;
  const text=String(m.text??m.caption??'');
  if(m.document){event={id,scope:OWNER,type:'import',file_id:m.document.file_id,size:m.document.file_size||0,name:m.document.file_name||'',text};}
  else if(m.voice||m.audio||m.video_note)event={id,scope:OWNER,type:'owner',text:'/no_voice'};
  else event={id,scope:OWNER,type:'owner',text:prefix(text)?strip(text):text,photo:m.photo?.at(-1)?.file_id,quoted_text:String(m.reply_to_message?.text||'').slice(0,1000)};
  if(stopCommand(event.text||''))await stop(env);
 }
 if(!event)return;
 if(event.type==='peer'){
  const due=now+peerDelay(env);
  await batch(env,[
   ["UPDATE inbox SET not_before=MAX(not_before,?) WHERE scope=? AND state='pending' AND json_extract(payload,'$.type')='peer'",[due,event.scope]],
   ['INSERT OR IGNORE INTO inbox(id,scope,payload,at,not_before) VALUES(?,?,?,?,?)',[id,event.scope,JSON.stringify(event),now,due]]
  ]);
 }else await run(env,'INSERT OR IGNORE INTO inbox(id,scope,payload,at) VALUES(?,?,?,?)',[id,event.scope,JSON.stringify(event),now]);
}

async function applyProposal(env,event,p){
 const now=clock(env);
 if(!p||p.status!=='pending'||p.expires_at<=now)return 'Предложение уже обработано или истекло. Создай новое.';
 const c=await getChat(env,p.scope),payload=JSON.parse(p.payload);
 if(p.scope!==OWNER&&(!c||c.revision!==p.revision))return 'В чате уже появились новые сообщения или изменился режим. Это предложение устарело.';
 const updates=[["UPDATE proposals SET status='accepted' WHERE id=? AND status='pending'",[p.id]]];
 if(p.kind==='mode'){
  if(!validModeDuration(payload.minutes))return MODE_DURATION_ERROR;
  const conn=await one(env,'SELECT * FROM connections WHERE id=? AND enabled=1',[c.connection_id]);
  if(!conn||!JSON.parse(conn.rights).can_reply)return 'В настройках подключения нужно разрешить ответы.';
  await snapshotChat(env,c.id);
  updates.push(['UPDATE settings SET paused=0 WHERE id=1'],['UPDATE chats SET mode=?,consent=1,until_at=?,instruction=?,pause_until=0,revision=revision+CASE WHEN mode=? AND consent=1 AND until_at>? AND instruction=? AND pause_until<=? THEN 0 ELSE 1 END WHERE id=?',[payload.mode,now+payload.minutes*60000,payload.instruction,payload.mode,now,payload.instruction,now,c.id]]);
  await batch(env,updates);return `В чате «${c.title}» включены ${payload.mode==='auto'?'автоответы':'черновики'} на ${formatDuration(payload.minutes,payload.unit,true)} Новые обязательства — через тебя. Остановить: /stop.`;
 }
 let method='sendMessage',body,mode='approved';
 if(p.kind==='avatar'){
  const conn=await one(env,'SELECT * FROM connections WHERE id=? AND enabled=1',[payload.connection]);
  if(!conn||!JSON.parse(conn.rights).can_edit_profile_photo)return 'Нет разрешения менять фото профиля.';
  method='setBusinessAccountProfilePhoto';mode='avatar';body={file_id:payload.file_id,business_connection_id:payload.connection};
 }else body={chat_id:c.telegram_id,text:payload.text,...(c.connection_id?{business_connection_id:c.connection_id}:{})};
 updates.push(['INSERT OR IGNORE INTO outbox(id,scope,method,payload,mode,revision,expires_at,at) VALUES(?,?,?,?,?,?,?,?)',['action:'+p.id,p.scope,method,JSON.stringify(body),mode,p.revision,now+120000,now]]);
 await batch(env,updates);return 'Приняла. Сообщу результат после подтверждения Telegram.';
}
async function callback(env,event){
 const [op,id]=event.data.split(':');let text='Неизвестная кнопка.';
 if(op==='chat'){
  const c=await getChat(env,id);if(c){await queue(env,'reply:'+event.id,`${c.title}\nРежим: ${c.mode}.\nКод чата для импорта: ${c.id}\nПри включении текст чата обрабатывается ${providerNames(env)}; нужно согласие участников.`,{markup:{inline_keyboard:c.kind==='channel'?[]:[[{text:'📝 Черновики на 2 ч',callback_data:'draft:'+c.id},{text:'🤖 Авто на 2 ч',callback_data:'auto:'+c.id}],[{text:'⏹ Стоп',callback_data:'stop:'+c.id}]]}});return;}
 }else if(op==='watch'||op==='unwatch'){
  if(id==='all'){
   await setDeletionWatch(env,op==='watch');
   try{await telegram(env,'answerCallbackQuery',{callback_query_id:event.callback_id,text:'Настройка обновлена для всех чатов.'});}catch{}
   return chatButtons(env,event.id);
  }
  text='Открой /chats для общей настройки журнала.';
 }else if(['draft','auto'].includes(op)){const c=await getChat(env,id);if(c){text=await proposalCard(env,event,id,'mode',{mode:op,minutes:120,instruction:'Коротко и естественно. Новые обещания, неизвестные факты и чувствительные темы согласовывать со мной.'});}}
 else if(op==='yes')text=await applyProposal(env,event,await one(env,'SELECT * FROM proposals WHERE id=?',[id]));
 else if(op==='no'){await run(env,"UPDATE proposals SET status='cancelled' WHERE id=? AND status='pending'",[id]);text='Отменено.';}
 else if(op==='stop')text='Автоответы остановлены.';
 text=formatLetterCase(text,await letterCase(env));
 try{await telegram(env,'answerCallbackQuery',{callback_query_id:event.callback_id,text:text.slice(0,160)});}catch{}
 if(!['draft','auto'].includes(op))await queue(env,'reply:'+event.id,text);
}
async function importHistory(env,event){
 // Import only via explicit /import <handle> caption, only owner's texts.
 const match=event.text.match(/^\/import\s+([a-f0-9]{24})$/i),c=match?await getChat(env,match[1]):null;
 if(!c||!c.consent||event.size>1024*1024||!event.name.endsWith('.json'))return 'Для импорта: выбери согласованный чат в /chats. Отправь JSON экспорта Telegram Desktop до 1 МБ с подписью /import и handle чата из списка памяти. Импортируются только твои текстовые сообщения за 72 часа.';
 const file=await telegram(env,'getFile',{file_id:event.file_id});if(!file.file_path||file.file_size>1024*1024||!/^[A-Za-z0-9_./-]+$/.test(file.file_path)||file.file_path.includes('..'))return 'Файл слишком большой или недоступен.';
 const r=await (env.FETCH||fetch)('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+file.file_path,{signal:AbortSignal.timeout(6000)});
 if(!r.ok)return 'Не удалось скачать экспорт.';const raw=await r.text();if(raw.length>1024*1024)return 'Экспорт должен быть до 1 МБ.';
 let data;try{data=JSON.parse(raw);}catch{return 'Это не JSON экспорта Telegram Desktop.';}
 if(String(data.id)!==c.telegram_id)return 'Экспорт относится к другому чату. Импорт остановлен.';
 let n=0;
 for(const m of (data.messages??[]).slice(-2000)){
  const at=Number(m.date_unixtime)*1000;if(m.from_id!=='user'+env.OWNER_ID||!Number.isFinite(at)||at<clock(env)-72*3600000||at>clock(env)||m.media_type||m.type!=='message')continue;
  const text=typeof m.text==='string'?m.text:Array.isArray(m.text)?m.text.map(t=>typeof t==='string'?t:t.text??'').join(''):'';
  if(!text||prefix(text)||n>=100)continue;
  await putMessage(env,{id:c.id+':'+m.id,scope:c.id,role:'assistant',body:text,manual:1,at});n++;
 }
 return `Импортировано твоих текстовых сообщений: ${n}. Голосовые и сообщения собеседника пропущены.`;
}
async function handle(env,event,deadline){
 if(event.type==='callback')return callback(env,event);
 if(event.type==='peer')return peerTurn(env,event,deadline);
 let text;
 if(event.type==='notice')text=event.text;
 else if(event.type==='import')text=await importHistory(env,event);
 else if(stopCommand(event.text))text='Остановила автоответы. Неотправленные предложения отменены.';
 else if(/^\/(start|help)(?:\s|$)/i.test(event.text))text=startText;
 else if(event.text==='/no_voice')text='Голос пока не разбираю. Напиши текстом — помогу.';
 else if(['chats','чаты'].includes(slash(event.text)))return chatButtons(env,event.id);
 else if(['status','статус'].includes(slash(event.text)))return status(env,event.id);
 else if(autoHere(event.text))return chatButtons(env,event.id);
 else if(helpHere(event.text)){
  if(!event.target)return chatButtons(env,event.id);
  await proposalCard(env,event,event.target,'mode',{mode:'draft',minutes:120,instruction:'Коротко и естественно. Новые обещания и неизвестные факты согласовывать со мной.'});return;
 }
 else if(['memory','память'].includes(slash(event.text))){
  const facts=[...await all(env,"SELECT key,value FROM facts WHERE scope='owner' ORDER BY at DESC LIMIT 50"),...await all(env,"SELECT c.title AS key,f.fact AS value FROM chat_facts f JOIN chats c ON c.id=f.chat_id ORDER BY f.created_at DESC LIMIT 50")];text=facts.length?facts.map(f=>f.key+': '+f.value).join('\n'):'Пока постоянных заметок нет. Напиши «запомни…».';
 }else{
  await putMessage(env,{id:'user:'+event.id,scope:OWNER,role:'user',body:event.text||'[фото]',manual:1});
  text=await ownerTurn(env,event,deadline);
 }
 if(text){text=formatLetterCase(text,await letterCase(env,event.target||OWNER));await queue(env,'reply:'+event.id,text);await putMessage(env,{id:'assistant:'+event.id,scope:OWNER,role:'assistant',body:text});}
}
export async function canSend(env,row){
 const now=clock(env);if(row.expires_at<=now)return false;if(row.mode==='owner')return true;
 if(row.mode==='avatar'){const p=JSON.parse(row.payload),c=await one(env,'SELECT * FROM connections WHERE id=? AND enabled=1',[p.business_connection_id]);return !!c&&!!JSON.parse(c.rights).can_edit_profile_photo;}
 const c=await getChat(env,row.scope);if(!c||c.revision!==row.revision)return false;
 if(c.kind==='channel')return row.mode==='approved';
 const conn=await one(env,'SELECT * FROM connections WHERE id=? AND enabled=1',[c.connection_id]);if(!conn||!JSON.parse(conn.rights).can_reply||now-c.last_incoming>=86400000)return false;
 if(row.mode==='auto'){const s=await one(env,'SELECT paused FROM settings WHERE id=1');return !s.paused&&c.consent&&c.mode==='auto'&&c.until_at>now&&c.pause_until<=now;}
 return row.mode==='approved';
}
export async function flush(env,deadline){
 for(let i=0;i<10&&Date.now()<deadline-1500;i++){
  const row=await one(env,"SELECT * FROM outbox WHERE state='pending' AND not_before<=? ORDER BY at,rowid LIMIT 1",[clock(env)]);if(!row)return;
  if(!await canSend(env,row)){await run(env,"UPDATE outbox SET state='cancelled' WHERE id=? AND state='pending'",[row.id]);if(row.mode==='approved'||row.mode==='avatar')await queue(env,'cancelled:'+row.id,'Не отправила: предложение устарело, отключено подключение или истекло разрешённое окно ответа.');continue;}
  if(row.mode==='auto'&&repeatedReply(JSON.parse(row.payload).text,await recentReplies(env,row.scope,row.id))){await run(env,"UPDATE outbox SET state='cancelled' WHERE id=? AND state='pending'",[row.id]);await audit(env,'repeated_send_blocked');continue;}
  const claimed=await run(env,"UPDATE outbox SET state='sending',lease_until=? WHERE id=? AND state='pending'",[clock(env)+25000,row.id]);if(!claimed.meta.changes)continue;
  // Recheck after claiming: stop/manual reply/new peer messages invalidate it.
  if(!await canSend(env,row)){await run(env,"UPDATE outbox SET state='cancelled' WHERE id=?",[row.id]);continue;}
  try{
   const body=JSON.parse(row.payload);
   if(row.mode==='approved'){const c=await getChat(env,row.scope);if(c.kind==='channel'){const rights=await telegram(env,'getChatMember',{chat_id:c.telegram_id,user_id:env.OWNER_ID});if(!['administrator','creator'].includes(rights.status))throw Error('channel_permission');}}
   const result=row.method==='setBusinessAccountProfilePhoto'?await setAvatar(env,body):await telegram(env,row.method,body);
   if(row.method==='setBusinessAccountProfilePhoto'?result!==true:!Number.isSafeInteger(result?.message_id))throw Error('unconfirmed_send');
   await run(env,"UPDATE outbox SET state='sent',message_id=? WHERE id=?",[String(result?.message_id??'confirmed'),row.id]);
   if(row.mode!=='owner'){
    if(body.text)await putMessage(env,{id:'sent:'+row.id,scope:row.scope,role:'assistant',body:body.text});
    if(row.mode==='approved'||row.mode==='avatar')await queue(env,'receipt:'+row.id,row.mode==='avatar'?'Фото профиля изменено — Telegram подтвердил.':'Отправлено — Telegram подтвердил.');
   }
  }catch(error){
   if(row.id.startsWith('deletion:')&&row.method!=='sendMessage'&&error.code==='400'){
    const payload=JSON.parse(row.payload);
    const text=(payload.caption||'В чате удалили вложение.')+'\nTelegram больше не отдаёт файл.';
    await run(env,"UPDATE outbox SET method='sendMessage',payload=?,state='pending' WHERE id=?",[JSON.stringify({chat_id:env.OWNER_ID,text,protect_content:true}),row.id]);
    continue;
   }
   if(error.code==='429'){
    await run(env,"UPDATE outbox SET state='pending',not_before=?,error='429' WHERE id=?",[clock(env)+Math.max(error.retry,2)*1000,row.id]);
    await audit(env,'telegram_send_retry');
   }
   else{const unknown=error.uncertain||!error.code;await run(env,'UPDATE outbox SET state=?,error=? WHERE id=?',[unknown?'unknown':'failed',unknown?'uncertain':error.code,row.id]);if(row.mode!=='owner')await queue(env,'failure:'+row.id,unknown?'Telegram не подтвердил результат отправки. Проверь чат: автоматически повторять не буду.':'Telegram отклонил действие. Ничего повторно не отправляю. Проверь доступ и /status.');}
  }
 }
}
export async function drain(env,deadline=Date.now()+24000){
 const token=crypto.randomUUID();
 const got=await run(env,'UPDATE settings SET lock_token=?,lock_until=? WHERE id=1 AND lock_until<?',[token,clock(env)+60000,clock(env)]);if(!got.meta.changes)return;
 try{
  await maintenance(env);await flush(env,deadline);
  while(Date.now()<deadline-4000){
   const row=await one(env,"SELECT * FROM inbox WHERE state='pending' AND not_before<=? ORDER BY at,rowid LIMIT 1",[clock(env)]);if(!row)break;
   let event=JSON.parse(row.payload),group=[row];
   if(event.type==='peer'){
    group=(await all(env,"SELECT * FROM inbox WHERE state='pending' AND scope=? ORDER BY at,rowid LIMIT 100",[row.scope])).filter(x=>JSON.parse(x.payload).type==='peer');
    if(!group.length)continue;
    // A concurrent webhook may have extended the quiet window after selection.
    const due=Math.max(...group.map(x=>x.not_before));
    if(due>clock(env)){await run(env,"UPDATE inbox SET not_before=MAX(not_before,?) WHERE scope=? AND state='pending' AND json_extract(payload,'$.type')='peer'",[due,row.scope]);continue;}
    event={...JSON.parse(group.at(-1).payload),message_ids:group.map(x=>JSON.parse(x.payload).message_id).filter(Boolean)};
   }
   await batch(env,group.map(x=>["UPDATE inbox SET state='processing',lease_until=?,attempts=attempts+1 WHERE id=? AND state='pending'",[clock(env)+28000,x.id]]));
   const finish=()=>batch(env,group.map(x=>["UPDATE inbox SET state='done',payload='{}' WHERE id=?",[x.id]]));
   try{await handle(env,event,deadline-1000);await finish();}
   catch(error){
    await audit(env,error.kind||'turn_failed');
    const text=error instanceof ModelUnavailable
     ? (event.type==='peer'?'Модели сейчас недоступны. Собеседнику ничего не отправила.':'Модели сейчас недоступны. Попробуй чуть позже. /stop и /status работают.')
     : 'Не удалось закончить этот шаг. /stop и /status работают.';
    await queue(env,'error:'+row.id,formatLetterCase(text,await letterCase(env,event.target||event.scope)));
    await finish();
   }
   await flush(env,deadline);
  }
 }finally{await run(env,'UPDATE settings SET lock_until=0,lock_token=NULL WHERE id=1 AND lock_token=?',[token]);}
 // A concurrent webhook can have queued work while this worker owned the lock.
 if(Date.now()<deadline-4000&&await one(env,"SELECT id FROM inbox WHERE state='pending' AND not_before<=? LIMIT 1",[clock(env)]))return drain(env,deadline);
}
export async function work(env){
 const deadline=Date.now()+28000;
 try{
  // D1 owns the queue; overlapping webhooks only wake it. The lock serializes
  // generation. A timer stays within waitUntil's lifetime; cron recovers crashes.
  while(Date.now()<deadline-4000){
   await drain(env,Math.min(deadline-1000,Date.now()+22000));
   const next=await one(env,`SELECT MIN(due) AS due FROM (
    SELECT MIN(not_before) AS due FROM inbox WHERE state='pending'
    UNION ALL
    SELECT MIN(not_before) AS due FROM outbox WHERE state='pending'
   )`);
   if(next?.due==null)break;
   const delay=Math.max(250,next.due-clock(env));
   if(Date.now()+delay>=deadline-4000)break;
   await (env.SLEEP||((ms)=>new Promise(resolve=>setTimeout(resolve,ms))))(delay);
  }
  await background(env,deadline);
 }catch{await audit(env,'worker_failed').catch(()=>{});}
}
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/health')return Response.json({ok:true,service:'panda',version:env.SOURCE_SHA||'development',enabled:env.ENABLED==='true',providers:providerConfig(env).filter(p=>p.key).map(p=>p.name),free_only:env.FREE_ONLY==='true',peer_debounce_ms:peerDelay(env),auto_default:false});
  if(env.ENABLED!=='true')return new Response('disabled',{status:503});
  if(url.pathname==='/ops/probe'&&request.method==='POST'){
   if(!env.ADMIN_SECRET||request.headers.get('authorization')!=='Bearer '+env.ADMIN_SECRET)return new Response('forbidden',{status:403});
   if(url.searchParams.get('provider')==='nvidia'){
    if(!env.NVIDIA_API)return Response.json({ok:true,available:false,provider:'nvidia',reason:'SECRET_MISSING'});
    const started=Date.now();
    try{
     const probeEnv=Object.assign(Object.create(env),{NVIDIA_ENABLED:'true'});
     const messages=[
      {role:'system',content:'Return JSON only with action and text. Use action draft_reply and write a short natural Russian draft. Do not promise anything.'},
      {role:'user',content:'Вымышленный тест: «Заедешь вечером?» Ответь, что пока не знаешь, и спроси, во сколько собираются.'}
     ];
     const result=await completion(probeEnv,messages,{json:true,only:'nvidia'});
     const draft=parseJSON(result.message.content);
     const available=draft?.action==='draft_reply'&&typeof draft.text==='string'&&/[а-яё]/iu.test(draft.text);
     return Response.json({ok:true,available,provider:'nvidia',latency_ms:Date.now()-started});
    }catch(error){
     if(error instanceof ModelUnavailable)return Response.json({ok:true,available:false,provider:'nvidia',failures:error.failures});
     return Response.json({ok:true,available:false,provider:'nvidia',reason:'INTERNAL_PROBE_ERROR'});
    }
   }
   try{const only=url.searchParams.get('provider')==='cloudflare'?'cloudflare':undefined;const started=Date.now();const r=await completion(env,[{role:'system',content:'Return JSON only: {\"ready\":true}'},{role:'user',content:'Synthetic deployment check. No personal data.'}],{json:true,only});let checks;if(only){const peer=await completion(env,[{role:'system',content:PEER_SYSTEM},{role:'user',content:JSON.stringify({history:[{role:'user',body:'Привет! Как дела?'}],facts:[],instruction:'Короткий тёплый ответ без выдуманных личных фактов.'})}],{json:true,only});const parsed=parsePeer(peer.message.content);const routed=await completion(env,[{role:'system',content:'Route the owner request. Return action=set_chat_style, params={style_patch:{tone:string,instructions:string}}, confidence=high, explanation:string.'},{role:'user',content:'Панда, общайся в этом чате мягко и без официоза.'}],{only,tools:[{type:'function',function:{name:'route',parameters:{type:'object'}}}]});const call=routed.message.tool_calls?.[0];const action=parseJSON(call?.function?.arguments);checks={peer_json:!!parsed,peer_reply:!!parsed?.reply,style_route:action?.action==='set_chat_style'};}
return Response.json({ok:true,available:checks?Object.values(checks).every(Boolean):true,checks,provider:r.provider,structured_object:typeof parseJSON(r.message.content)==='object'&&parseJSON(r.message.content)!==null,ready:parseJSON(r.message.content)?.ready===true,latency_ms:Date.now()-started});}catch(error){
    // An exhausted daily allowance must not prevent shipping controls/queue fixes.
    // Live synthetic quality checks still gate deployment; never reset usage here.
    if(url.searchParams.get('provider')==='cloudflare'&&error instanceof ModelUnavailable)return Response.json({ok:true,available:false,failures:error.failures});
    if(error instanceof ModelUnavailable&&error.failures.some(f=>f.kind==='BUDGET_INTERNAL'))return Response.json({ok:true,available:false,reason:'DAILY_BUDGET_EXHAUSTED',failures:error.failures.map(({provider,kind,status})=>({provider,kind,status}))});
    return Response.json({ok:false},{status:503});
   }
  }
  if(url.pathname!=='/telegram'||request.method!=='POST')return new Response('not found',{status:404});
  if(!env.WEBHOOK_SECRET||request.headers.get('x-telegram-bot-api-secret-token')!==env.WEBHOOK_SECRET)return new Response('forbidden',{status:403});
  try{const raw=await request.text();if(raw.length>120000)return new Response('too large',{status:413});const u=JSON.parse(raw);await acceptUpdate(env,u);ctx.waitUntil(work(env));return new Response('ok');}catch{return new Response('retry',{status:500});}
 },
 async scheduled(_controller,env,ctx){if(env.ENABLED==='true')ctx.waitUntil(work(env));}
};
