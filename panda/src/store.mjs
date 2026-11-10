export const one=(env,sql,args=[])=>env.DB.prepare(sql).bind(...args).first();
export const all=async(env,sql,args=[]) => (await env.DB.prepare(sql).bind(...args).all()).results;
export const run=(env,sql,args=[])=>env.DB.prepare(sql).bind(...args).run();
export const batch=(env,items)=>env.DB.batch(items.map(([sql,args=[]])=>env.DB.prepare(sql).bind(...args)));
export const clock=env=>env.NOW?env.NOW():Date.now();
export const OWNER='owner';
export async function key(value){const x=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(x)].slice(0,12).map(n=>n.toString(16).padStart(2,'0')).join('');}
export const audit=(env,kind)=>run(env,'INSERT INTO audit(kind,at) VALUES(?,?)',[kind,clock(env)]);
export const getChat=(env,id)=>one(env,'SELECT * FROM chats WHERE id=?',[id]);
export async function recentReplies(env,scope,excludeId=''){
 const since=clock(env)-30*60000;
 const [messages,outbox]=await Promise.all([
  all(env,"SELECT body FROM messages WHERE scope=? AND role='assistant' AND at>? ORDER BY at DESC,rowid DESC LIMIT 12",[scope,since]),
  all(env,"SELECT json_extract(payload,'$.text') AS body FROM outbox WHERE scope=? AND id<>? AND mode<>'owner' AND method='sendMessage' AND state IN ('pending','sending','sent','unknown') AND at>? ORDER BY at DESC,rowid DESC LIMIT 12",[scope,excludeId,since])
 ]);
 return [...messages,...outbox].map(x=>x.body).filter(Boolean);
}
export async function context(env,scope){
 const now=clock(env);
 const [history,facts,chat]=await Promise.all([
  all(env,'SELECT role,body,at,manual FROM messages WHERE scope=? AND at>? ORDER BY at DESC,rowid DESC LIMIT 14',[scope,now-72*3600000]),
  all(env,'SELECT key,value,source,at FROM facts WHERE scope=? ORDER BY at DESC LIMIT 50',[scope]),getChat(env,scope)
 ]);
 const examples=scope===OWNER?[]:await all(env,"SELECT body FROM messages WHERE scope=? AND manual=1 AND at>? ORDER BY at DESC LIMIT 20",[scope,now-72*3600000]);
 return {history:history.reverse(),facts,summary:chat?.summary??'',style_examples:examples.map(x=>x.body),style_confidence:examples.length>=15?'enough_examples':'limited',instruction:chat?.instruction??''};
}
export async function putMessage(env,{id,scope,role,body,manual=0,at=clock(env)}){
 await run(env,'INSERT OR IGNORE INTO messages(id,scope,role,body,at,manual) VALUES(?,?,?,?,?,?)',[id,scope,role,String(body).slice(0,6000),at,manual]);
}
export async function putFact(env,{scope,key:name,value,source}){
 if(!/^[\p{L}\p{N}_ .-]{1,60}$/u.test(name)||typeof value!=='string'||!value.trim()||value.length>400)throw Error('invalid_fact');
 const n=await one(env,'SELECT count(*) AS n FROM facts WHERE scope=?',[scope]);
 if(n.n>=50&&!await one(env,'SELECT key FROM facts WHERE scope=? AND key=?',[scope,name]))throw Error('memory_full');
 await run(env,'INSERT INTO facts(scope,key,value,source,at) VALUES(?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,source=excluded.source,at=excluded.at',[scope,name,value,source,clock(env)]);
}
export async function forget(env,scope,name){
 // Also clear ephemeral context so a deleted fact is not resurrected from it.
 await batch(env,[['DELETE FROM facts WHERE scope=? AND key=?',[scope,name]],['DELETE FROM messages WHERE scope=?',[scope]],['UPDATE chats SET summary=? WHERE id=?',['',scope]]]);
}
export async function queue(env,id,text,{scope=OWNER,mode='owner',revision=0,markup=null,expires=clock(env)+120000,method='sendMessage',payload=null}={}){
 let body=payload;
 if(!body){const c=scope===OWNER?null:await getChat(env,scope);body={chat_id:scope===OWNER?env.OWNER_ID:c.telegram_id,text:String(text).slice(0,3900),...(c?.connection_id?{business_connection_id:c.connection_id}:{}),...(markup?{reply_markup:markup}:{})};}
 await run(env,'INSERT OR IGNORE INTO outbox(id,scope,method,payload,mode,revision,expires_at,at) VALUES(?,?,?,?,?,?,?,?)',[id,scope,method,JSON.stringify(body),mode,revision,expires,clock(env)]);
}
export async function stop(env,scope=null){
 const now=clock(env),where=scope?' WHERE id=?':'',args=scope?[scope]:[];
 const items=[[`UPDATE chats SET mode='off',revision=revision+1${where}`,args],[`UPDATE proposals SET status='cancelled' WHERE status='pending'${scope?' AND scope=?':''}`,args],[`UPDATE outbox SET state='cancelled' WHERE state='pending' AND mode<>'owner'${scope?' AND scope=?':''}`,args]];
 if(!scope)items.unshift(['UPDATE settings SET paused=1 WHERE id=1']);
 await batch(env,items);await audit(env,'owner_stop');return now;
}
export async function createProposal(env,eventId,scope,kind,payload){
 const old=await one(env,'SELECT * FROM proposals WHERE event_id=? AND scope=? AND kind=?',[eventId,scope,kind]);if(old)return old;
 const id=await key(eventId+':'+scope+':'+kind),c=await getChat(env,scope),now=clock(env);
 await run(env,'INSERT OR IGNORE INTO proposals(id,event_id,scope,kind,payload,revision,expires_at,at) VALUES(?,?,?,?,?,?,?,?)',[id,eventId,scope,kind,JSON.stringify(payload),c?.revision??0,now+300000,now]);
 return one(env,'SELECT * FROM proposals WHERE id=?',[id]);
}
export async function consumeBudget(env){
 const day=new Date(clock(env)).toISOString().slice(0,10),limit=Math.min(120,Math.max(1,Number(env.DAILY_REQUEST_LIMIT)||120));
 await run(env,'INSERT OR IGNORE INTO usage(day) VALUES(?)',[day]);
 const r=await run(env,'UPDATE usage SET requests=requests+1 WHERE day=? AND requests<?',[day,limit]);return r.meta.changes===1;
}
export async function maintenance(env){
 const now=clock(env);
 await run(env,"UPDATE inbox SET state='pending' WHERE state='processing' AND lease_until<?",[now]);
 const uncertain=await all(env,"SELECT id FROM outbox WHERE state='sending' AND lease_until<?",[now]);
 for(const row of uncertain){await run(env,"UPDATE outbox SET state='unknown',error='interrupted' WHERE id=? AND state='sending'",[row.id]);await queue(env,'uncertain:'+row.id,'Не удалось подтвердить результат одной отправки. Повторять её автоматически не буду. Проверь чат; состояние видно в /status.');}
 const s=await one(env,'SELECT cleanup_at FROM settings WHERE id=1');
 if(now-s.cleanup_at<3600000)return;
 await batch(env,[['DELETE FROM messages WHERE at<?',[now-72*3600000]],["DELETE FROM inbox WHERE state='done' AND at<?",[now-7*86400000]],["UPDATE proposals SET status='expired',payload='{}' WHERE status='pending' AND expires_at<?",[now]],["UPDATE outbox SET state='expired',payload='{}' WHERE state='pending' AND expires_at<?",[now]],["UPDATE proposals SET payload='{}' WHERE status<>'pending' AND at<?",[now-86400000]],["UPDATE outbox SET payload='{}' WHERE state IN ('sent','failed','cancelled','expired') AND at<?",[now-86400000]],['DELETE FROM audit WHERE at<?',[now-30*86400000]],['UPDATE settings SET cleanup_at=? WHERE id=1',[now]]]);
}
