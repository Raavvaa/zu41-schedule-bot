import {one,all,run,q} from './ledger.mjs';
export function redactSecrets(text,env={}){
 let s=String(text);for(const key of ['TELEGRAM_BOT_TOKEN','GROQ_API_KEY','WEBHOOK_SECRET','ADMIN_SECRET'])if(env[key])s=s.split(String(env[key])).join('[скрыто]');
 if(/^\d+$/.test(String(env.OWNER_CHAT_ID??'')))s=s.replace(new RegExp('(?<!\\d)'+env.OWNER_CHAT_ID+'(?!\\d)','g'),'[идентификатор]');
 return s.replace(/\b(?:Bearer\s+\S+|(?:gsk_|sk-|cfut_)[A-Za-z0-9_-]+|\d{6,}:[A-Za-z0-9_-]+)/giu,'[секрет]');
}
export async function ledgerReport(env,days,now){
 if(!Number.isInteger(days)||days<1||days>90)throw Error('report_period');
 return all(env,`SELECT e.wallet,e.currency,sum(CASE WHEN e.delta>0 THEN e.delta ELSE 0 END)/100.0 AS incoming,sum(CASE WHEN e.delta<0 THEN -e.delta ELSE 0 END)/100.0 AS outgoing,sum(e.delta)/100.0 AS net FROM entries e JOIN transactions t ON t.id=e.tx_id WHERE e.tx_id IN (SELECT tx_id FROM operation_meta WHERE effective_at>=? UNION ALL SELECT id FROM transactions old WHERE at>=? AND NOT EXISTS(SELECT 1 FROM operation_meta WHERE tx_id=old.id)) AND t.kind NOT LIKE '%opening%' AND NOT EXISTS(SELECT 1 FROM transactions orig WHERE orig.id=t.reversal_of AND orig.kind LIKE '%opening%') GROUP BY e.wallet,e.currency`,now-days*86400000,now-days*86400000);
}
export async function addReminder(env,text,at,now){
 const due=Date.parse(at);if(typeof text!=='string'||!text.trim()||text.length>200||!Number.isFinite(due)||due<=now||due>now+90*86400000||!/(?:Z|[+-]\d{2}:\d{2})$/.test(at))throw Error('reminder_input');
 const id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text+'|'+due)))).slice(0,16).map(n=>n.toString(16).padStart(2,'0')).join('');
 if(await one(env,'SELECT id FROM reminders WHERE id=?',id))return {ok:true,id,due,already_exists:true};
 const r=await run(env,`INSERT OR IGNORE INTO reminders(id,text,due,created_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM reminders WHERE state='pending')<3 AND NOT EXISTS(SELECT 1 FROM reminders WHERE state='pending' AND abs(due-?)<3600000)`,id,text.trim(),due,now,due);
 return {ok:r.meta.changes>0,id:r.meta.changes?id:null,due,reason:r.meta.changes?null:'Лимит: три активных напоминания, интервал не меньше часа.'};
}
export async function deliverReminders(env,now){
 const s=await one(env,'SELECT active,quiet_until FROM settings WHERE id=1');if(!s.active||s.quiet_until>now)return;
 const r=await one(env,"SELECT * FROM reminders WHERE state='pending' AND due<=? ORDER BY due LIMIT 1",now);if(!r)return;
 if(now-r.due>3600000){await run(env,"UPDATE reminders SET state='expired' WHERE id=?",r.id);return;}
 await env.DB.batch([q(env,"INSERT OR IGNORE INTO outbox(id,payload,due,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM reminders WHERE id=? AND state='pending')",'reminder:'+r.id,JSON.stringify({text:'Напоминание: '+r.text}),now,now,r.id),q(env,"UPDATE reminders SET state='queued' WHERE id=? AND EXISTS(SELECT 1 FROM outbox WHERE id=?)",r.id,'reminder:'+r.id)]);
}
