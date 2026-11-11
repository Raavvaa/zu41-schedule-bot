// Specific current owner instruction. No history or recipient identifiers leave D1.
import {readFile} from 'node:fs/promises';
export async function applyOwnerRequest({sql,tg,owner,now=Date.now(),request}){
 if(!request)try{request=JSON.parse(await readFile('panda/owner-request.json','utf8'));}catch{return {requested:false};}
 if(request.id!=='katya-autoreply-12h-20261111'||request.action!=='enable_katya_autoreply'||request.hours!==12||now>Date.parse(request.expires))return {requested:false};
 const previous=(await sql('SELECT * FROM owner_requests WHERE id=?',[request.id]))[0];if(previous?.applied_at)return {matched:true,applied:true,already_applied:true,until:new Date(previous.until_at).toISOString()};
 const chats=await sql("SELECT c.*,COALESCE((SELECT group_concat(alias) FROM chat_aliases WHERE chat_id=c.id),'') AS aliases FROM chats c WHERE c.kind='private'");
 const katya=/(?:^|[^\p{L}\p{N}_])(?:катя|катю|кате|кати|катей|катерина|екатерина|katya|ekaterina|katerina)(?:$|[^\p{L}\p{N}_])/iu;
 // Read only owner-authored references relevant to this exact recipient, not a bulk export.
 const references=await sql("SELECT body FROM messages WHERE scope='owner' AND role='user' AND manual=1 AND at>? AND (lower(body) LIKE '%кат%' OR body LIKE '%Кат%') ORDER BY at DESC",[now-72*3600000]);
 const handles=new Set();for(const row of references){const text=String(row.body);if(!katya.test(text.replace(/[.!?—-]/g,' '))||/(?:не|кроме)\s+(?:катя|катю|кате|кати)/iu.test(text))continue;const mentions=[...text.matchAll(/@([a-z0-9_]{3,32})/giu)];if(mentions.length===1&&text.length<=700)handles.add(mentions[0][1].toLowerCase());}
 const direct=chats.filter(c=>katya.test(c.title+' '+c.aliases));
 const normalize=t=>String(t).toLowerCase().replace(/[^\p{L}\p{N}_]+/gu,' ').trim();
 const byDefinition=chats.filter(c=>normalize(c.title).length>=3&&references.some(r=>katya.test(r.body)&&/(?:это|зовут|имя|ник|username)/iu.test(r.body)&&!/[?]/u.test(r.body)&&normalize(r.body).includes(normalize(c.title))));
 const byReference=chats.filter(c=>c.aliases.toLowerCase().split(',').some(a=>handles.has(a.replace(/^@/,''))));
 const candidates=[...new Map([...direct,...byReference,...byDefinition].map(c=>[c.id,c])).values()];
 if(candidates.length!==1)return {matched:false,applied:false,reason:candidates.length?'ambiguous_recipient':'recipient_not_resolved'};
 const c=candidates[0],live=await tg('getBusinessConnection',{business_connection_id:c.connection_id});
 if(!live.is_enabled||String(live.user?.id)!==String(owner)||!live.rights?.can_reply)return {matched:true,applied:false,reason:'reply_permission_missing'};
 await sql('INSERT OR IGNORE INTO owner_requests(id,chat_id,until_at) VALUES(?,?,?)',[request.id,c.id,now+12*3600000]);
 const record=(await sql('SELECT * FROM owner_requests WHERE id=?',[request.id]))[0];if(record.chat_id!==c.id)return {matched:false,applied:false,reason:'recipient_changed'};
 const style=(await sql('SELECT tone,instructions FROM chat_style WHERE chat_id=?',[c.id]))[0]||null;
 await sql('INSERT INTO chat_changes(chat_id,state,created_at) VALUES(?,?,?)',[c.id,JSON.stringify({mode:c.mode,until_at:c.until_at,instruction:c.instruction,style}),now]);
 const instruction=(c.instruction+'\nОтвечай в стиле ручных сообщений владельца именно этого чата за последние 72 часа: его язык, длина реплик, пунктуация и обращение. Не выдумывай личные факты и обещания.').slice(-1500);
 await sql("UPDATE chats SET mode='auto',consent=1,until_at=?,instruction=?,pause_until=0,revision=revision+1 WHERE id=?",[record.until_at,instruction,c.id]);
 await sql('UPDATE settings SET paused=0 WHERE id=1');
 await sql("UPDATE proposals SET status='cancelled' WHERE scope=? AND status='pending'",[c.id]);
 await sql("INSERT OR IGNORE INTO chat_aliases(chat_id,alias) VALUES(?,'катя')",[c.id]);
 const text='Для Кати включены автоответы на 12 часов в чате «'+c.title+'». Использую твои ручные сообщения этого чата за последние 72 часа. Остановить: /stop.';
 await sql("INSERT OR IGNORE INTO outbox(id,scope,method,payload,mode,revision,expires_at,at) VALUES(?,'owner','sendMessage',?,'owner',0,?,?)",['owner-request:'+request.id,JSON.stringify({chat_id:owner,text}),now+3600000,now]);
 await sql('UPDATE owner_requests SET applied_at=? WHERE id=?',[now,request.id]);
 const verified=(await sql('SELECT mode,consent,until_at FROM chats WHERE id=?',[c.id]))[0];
 return {matched:true,applied:verified.mode==='auto'&&verified.consent===1&&verified.until_at===record.until_at,until:new Date(record.until_at).toISOString(),style_window_hours:72};
}
