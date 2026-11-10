import {all,getChat,clock,stop,putFact,forget,changeStyle,undoChat,chatContext,saveConversationState} from './store.mjs';
export const actions=['set_chat_style','enable_autoreply','enable_drafts','stop','remember','forget','send_once','update_conversation_note','answer_owner','undo_last','none'];
export const routeSchema={type:'object',properties:{action:{type:'string',enum:actions},params:{type:'object'},confidence:{type:'string',enum:['high','medium','low']},explanation:{type:'string'}},required:['action','params','confidence','explanation'],additionalProperties:false};
export function validRoute(x){return x&&actions.includes(x.action)&&['high','medium','low'].includes(x.confidence)&&typeof x.explanation==='string'&&x.explanation.length<=1000&&x.params&&typeof x.params==='object'&&!Array.isArray(x.params);}
export async function extendChatAction(env,x,event){if(x.action==='set_chat_style'){const style=await changeStyle(env,event.target,x.params.style_patch,event.id);return 'Ок, в этом чате: '+style.tone+'. '+style.instructions;}if(x.action==='undo_last')return await undoChat(env,event.target)?'Отменила последнее изменение в этом чате.':'В этом чате нечего отменять.';if(x.action==='update_conversation_note'){const note=x.params.note;if(typeof note!=='string'||note.length>1000)return 'Уточни заметку.';const c=await getChat(env,event.target),ctx=await chatContext(env,c.id);await saveConversationState(env,c.id,{topic:'',last_question:'',discussed:'',unanswered:'',...ctx.conversation_state,discussed:note},c.revision);return 'Обновила заметку этого разговора.';}return 'Эта настройка ещё не доступна.';}
export async function executeRoute(env,x,event,proposal,extend=extendChatAction){
 if(!validRoute(x))return {done:true,text:'Уточни, что именно нужно сделать?'};
 if(x.confidence==='low')return {done:true,text:'Уточни, что именно нужно сделать в этом чате?'};
 if(['answer_owner','none'].includes(x.action))return {done:true,text:String(x.params.text||x.explanation||'Уточни поручение.').slice(0,3000)};
 const target=event.target;
 if(!target){const chats=await all(env,"SELECT title FROM chats WHERE kind='private' ORDER BY title LIMIT 20");return {done:true,text:'Для какого чата? '+chats.map(c=>c.title).join(', ')};}
 const c=await getChat(env,target);if(!c||c.kind!=='private')return {done:true,text:'Выбери подключённый личный чат.'};
 if(x.params.chat&&x.params.chat!==target)return {done:true,text:'Поручение относится только к текущему чату. Уточни адресата.'};
 if(x.action==='send_once'){const text=x.params.draft_text;if(typeof text!=='string'||!text.trim()||text.length>2500)return {done:true,text:'Какой текст подготовить?'};return {proposal:true,text:await proposal(env,event,target,'send',{text})};}
 if(['enable_autoreply','enable_drafts'].includes(x.action)){const minutes=x.params.duration??120;if(!Number.isInteger(minutes)||minutes<1||minutes>720)return {done:true,text:'Укажи срок от 1 до 720 минут.'};return {proposal:true,text:await proposal(env,event,target,'mode',{mode:x.action==='enable_autoreply'?'auto':'draft',minutes,instruction:c.instruction})};}
 if(x.action==='stop'){await stop(env,target);return {done:true,text:'Остановила ответы в этом чате.'};}
 if(x.action==='remember'){if(typeof x.params.fact!=='string'||!event.text.includes(x.params.fact))return {done:true,text:'Уточни точный факт, который нужно запомнить.'};await putFact(env,{scope:target,key:x.params.key||'Заметка',value:x.params.fact,source:event.id});return {done:true,text:'Запомнила в этом чате.'};}
 if(x.action==='forget'){await forget(env,target,x.params.key||'Заметка');return {done:true,text:'Удалила заметку в этом чате.'};}
 return {done:true,text:await extend(env,x,event)};
}
