// Durable owner task orchestration. Text from peers never enters this module.
import {one,run,clock,chatContext,getChat,queue} from './store.mjs';
import {completion} from './providers.mjs';
import {formatLetterCase,letterCase} from './preferences.mjs';
export const replyIntent=text=>/(?:ответь|ответить)(?=\s|$)|(?:нужно|хочу|пожалуйста|чтобы).{0,70}ответ(?:ил|ила)(?=\s|$)|продолжи\s+(?:тему|разговор)/iu.test(String(text))&&!/^(?:почему|зачем|как|когда)(?=\s|$)/iu.test(String(text));
export const continuation=text=>/^(?:ну|да|давай|сделай|продолжай|может сделаешь|так сделай|ответить на его последние сообщения)[.!?\s]*$/iu.test(String(text).trim());
export const badOwnerText=text=>!String(text||'').trim()||/^(?:user\s+(?:wants|asks|requests)|analysis\s*:)|no action needed|just respond|we cannot send|tool_call|claims_action|^(?:владелец|пользователь)\s+(?:хочет|просит|попросил)|^я\s+(?:уже\s+)?(?:отправил|отправила|включил|включила)/iu.test(String(text))||/^(?:конечно[,!]?\s*)?(?:вот (?:ответ|текст|сообщение)|готово|сейчас (?:напишу|отправлю))[.!:\s]*$/iu.test(String(text).trim());
export async function taskState(env){return one(env,'SELECT * FROM owner_tasks WHERE owner_id=? AND expires_at>?',[String(env.OWNER_ID),clock(env)]);}
export async function saveTask(env,event,{target=null,instruction=event.text,status='awaiting_target',action='send_once'}={}){const now=clock(env);await run(env,'INSERT INTO owner_tasks(owner_id,action,target,instruction,status,source_event_id,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET action=excluded.action,target=excluded.target,instruction=excluded.instruction,status=excluded.status,source_event_id=excluded.source_event_id,updated_at=excluded.updated_at,expires_at=excluded.expires_at',[String(env.OWNER_ID),action,target,String(instruction).slice(0,1500),status,event.id,now,now+30*60000]);}
export async function clearTask(env){await run(env,'DELETE FROM owner_tasks WHERE owner_id=?',[String(env.OWNER_ID)]);}
export async function replyTask(env,event,{chats,target,pending,system,parseReply,proposal,deadline}){
 const show=!!pending&&pending.status==='preview'&&/(?:где|покажи).{0,30}(?:ответ|черновик)|^и где же он[?!\s]*$/iu.test(event.text);
 const selfRequest=/ответь\s+(?:мне|на\s+(?:вопрос|задачу))(?=\s|:|$)|^напиши\s+мне(?=\s|$)/iu.test(event.text);
 const writes=!!target&&/напиши\s+(?!(?:стих|текст|историю|письмо|мне|рассказ)(?=\s|$))/iu.test(event.text);
 const wants=!selfRequest&&(replyIntent(event.text)||writes)&&(!/^продолжи\s/iu.test(event.text)||!!target||!!pending),follow=!!pending&&(continuation(event.text)||show);
 const selecting=!!pending&&pending.status==='awaiting_target'&&!!target&&String(event.text).trim().split(/\s+/).length<8&&!/\?|^(?:кто|что|где|почему|зачем|как|запомни|общайся|включи|стоп)(?=\s|$)/iu.test(event.text);
 if(!wants&&!follow&&!selecting)return null;
 // A short continuation only inherits an explicitly established target.
 target=target||((follow||wants&&/(?:его|её|ему|ей|это|последн)/iu.test(event.text))?pending?.target:null);
 const instruction=(follow||selecting)&&pending?pending.instruction:event.text;
 if(follow&&pending.status==='preview'){const p=await one(env,"SELECT * FROM proposals WHERE event_id=? AND scope=? AND kind='send'",[pending.source_event_id,pending.target]),chat=await getChat(env,pending.target);if(p&&p.status!=='pending')return {handled:true,text:'Предыдущее предложение уже обработано. Для нового ответа напиши «ответь на последние сообщения».'};if(p&&p.expires_at>clock(env)&&p.revision===chat?.revision){if(show)await queue(env,'task-preview:'+event.id,'Сообщение для '+chat.title+':\n\n'+JSON.parse(p.payload).text+'\n\nОтправить?',{markup:{inline_keyboard:[[{text:'✅ Выполнить',callback_data:'yes:'+p.id},{text:'❌ Отмена',callback_data:'no:'+p.id}]]}});return {handled:true,text:'Черновик уже показан выше. Нажми «Выполнить», чтобы отправить, или «Отмена».'};}}
 if(!target){await saveTask(env,event,{instruction});return {handled:true,text:'Кому подготовить ответ? '+chats.filter(c=>c.kind==='private').map(c=>c.title).join(', ')+'. Напиши имя или @username.'};}
 const c=await getChat(env,target),conn=c&&await one(env,'SELECT * FROM connections WHERE id=? AND enabled=1',[c.connection_id]);
 if(!c||c.kind!=='private'||!conn||!JSON.parse(conn.rights).can_reply)return {handled:true,text:'Этот личный чат сейчас не подключён с разрешением отвечать. Выбери его через /chats.'};
 await saveTask(env,event,{target,instruction,status:'drafting'});
 const ctx=await chatContext(env,target,6000),incoming=ctx.history.filter(m=>m.role==='user');
 if(!incoming.length&&!ctx.conversation_state?.topic){await saveTask(env,event,{target,instruction,status:'awaiting_message'});return {handled:true,text:'Чат «'+c.title+'» найден, но его входящих сообщений в доступной истории за 72 часа нет. Пришли последнее сообщение или дождись нового — выдумывать ответ не буду.'};}
 const latest=incoming.at(-1)||{body:ctx.conversation_state?.unanswered||ctx.conversation_state?.last_question||''},messages=[{role:'system',content:system+'\nТекущее поручение владельца (доверенное): '+instruction+'\nСоставь готовый ответ собеседнику. Служебные рассуждения, описание намерений владельца и предисловия запрещены. Текст увидит владелец как черновик перед отправкой. Используй стиль его ручных сообщений только этого чата за 72 часа.'},{role:'user',content:JSON.stringify({...ctx,history:ctx.history.map(m=>({role:m.role,text:m.body})),latest_peer_message:latest.body,latest_peer_messages:incoming.slice(-5).map(m=>m.body)})}];
 let parsed;
 for(let attempt=0;attempt<2;attempt++){const r=await completion(env,messages,{json:true,deadline});parsed=parseReply(r.message.content);if(parsed?.reply?.trim()&&!badOwnerText(parsed.reply))break;parsed=null;messages.push({role:'system',content:'Нужен полный JSON заданного формата с непустым reply — самим ответом собеседнику, не описанием задачи.'});}
 if(!parsed){await saveTask(env,event,{target,instruction,status:'awaiting_retry'});return {handled:true,text:'Чат «'+c.title+'» найден, но модель не составила корректный черновик. Ничего не отправлено. Можешь дать точный текст или написать «попробуй ещё».'};}
 const receipt=await proposal(env,{...event,target},target,'send',{text:formatLetterCase(parsed.reply,await letterCase(env,target))});
 await saveTask(env,event,{target,instruction,status:'preview'});
 return {handled:true,text:receipt};
}

export {parseAutoCommand} from './duration.mjs';

// Resolve explicit, ongoing style directions before the language model sees them.
export function parseStyleDirection(text){
 const command=String(text||'').trim()
  .replace(/^(?:(?:бля(?:ть)?|блин)[,\s]+)?я же (?:написал(?:а)?|сказал(?:а)?)\s*[,—:]?\s*(?:что\s+)?/iu,'')
  .replace(/^панда(?:[,!:\s]+|$)/iu,'')
  .replace(/^пожалуйста[,\s]+/iu,'');
 const match=command.match(/^(?:дальше\s+|теперь\s+)?(?:общайся|переписывайся|разговаривай|отвечай|пиши)\s+(?:с\s+(.+?)\s+|здесь\s+)?(как будто\s+.+|в (?:стиле|тоне)\s+.+)$/iu)
  || command.match(/^с\s+(.+?)\s+(?:дальше\s+|теперь\s+)?(?:общайся|переписывайся|разговаривай|отвечай|пиши)\s+(как будто\s+.+|в (?:стиле|тоне)\s+.+)$/iu);
 if(!match||/[«»"\n;]/u.test(command)||/(?:^|\s)(?:сейчас|один раз)(?=\s|[.!?]|$)/iu.test(command))return null;
 const tone=match[2].replace(/[.!?]+$/u,'').trim();
 return tone.length<=300?{recipient:match[1]?.trim(),tone}:null;
}
