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
export async function context(env,scope,historyBudget=6000){
 const now=clock(env);
 const [history,facts,chat]=await Promise.all([
  all(env,'SELECT id,role,body,at,manual FROM messages WHERE scope=? AND at>? ORDER BY at DESC,rowid DESC LIMIT 200',[scope,now-72*3600000]),
  all(env,'SELECT key,value,source,at FROM facts WHERE scope=? ORDER BY at DESC LIMIT 50',[scope]),getChat(env,scope)
 ]);
 const examples=scope===OWNER?[]:await all(env,"SELECT body FROM messages WHERE scope=? AND manual=1 AND at>? ORDER BY at DESC LIMIT 20",[scope,now-72*3600000]);
 return {history:trimHistory(history.reverse(),historyBudget),facts,summary:chat?.summary??'',style_examples:examples.map(x=>x.body),style_confidence:examples.length>=15?'enough_examples':'limited',instruction:chat?.instruction??''};
}
export async function putMessage(env,{id,scope,role,body,manual=0,at=clock(env)}){
 const added=await run(env,'INSERT OR IGNORE INTO messages(id,scope,role,body,at,manual) VALUES(?,?,?,?,?,?)',[id,scope,role,String(body).slice(0,6000),at,manual]);
 if(added.meta.changes&&scope!==OWNER&&(manual||role==='user'))await scheduleFacts(env,scope);
 if(added.meta.changes&&scope!==OWNER&&role==='assistant'){const c=await getChat(env,scope);if(c?.consent&&c.mode!=='off'&&c.until_at>clock(env))await enqueueBackground(env,scope,'state');}
}
export async function putFact(env,{scope,key:name,value,source}){
 if(!/^[\p{L}\p{N}_ .-]{1,60}$/u.test(name)||typeof value!=='string'||!value.trim()||value.length>400)throw Error('invalid_fact');
 const n=await one(env,'SELECT count(*) AS n FROM facts WHERE scope=?',[scope]);
 if(n.n>=50&&!await one(env,'SELECT key FROM facts WHERE scope=? AND key=?',[scope,name]))throw Error('memory_full');
 await run(env,'INSERT INTO facts(scope,key,value,source,at) VALUES(?,?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,source=excluded.source,at=excluded.at',[scope,name,value,source,clock(env)]);
}
export async function forget(env,scope,name){
 // Also clear ephemeral context so a deleted fact is not resurrected from it.
 const forgotten=await one(env,'SELECT value FROM facts WHERE scope=? AND key=?',[scope,name]);
 await batch(env,[['DELETE FROM chat_facts WHERE chat_id=? AND (fact LIKE ? OR fact=?)',[scope,'%'+name+'%',forgotten?.value||'']],['DELETE FROM background_jobs WHERE chat_id=?',[scope]],['DELETE FROM conversation_state WHERE chat_id=?',[scope]],['UPDATE chats SET revision=revision+1 WHERE id=?',[scope]],['DELETE FROM facts WHERE scope=? AND key=?',[scope,name]],['DELETE FROM messages WHERE scope=?',[scope]],['UPDATE chats SET summary=? WHERE id=?',['',scope]]]);
}
export async function queue(env,id,text,{scope=OWNER,mode='owner',revision=0,markup=null,expires=clock(env)+120000,method='sendMessage',payload=null}={}){
 let body=payload;
 if(!body){const c=scope===OWNER?null:await getChat(env,scope);body={chat_id:scope===OWNER?env.OWNER_ID:c.telegram_id,text:String(text).slice(0,3900),...(c?.connection_id?{business_connection_id:c.connection_id}:{}),...(markup?{reply_markup:markup}:{})};}
 await run(env,'INSERT OR IGNORE INTO outbox(id,scope,method,payload,mode,revision,expires_at,at) VALUES(?,?,?,?,?,?,?,?)',[id,scope,method,JSON.stringify(body),mode,revision,expires,clock(env)]);
}
export async function stop(env,scope=null){
 if(scope)await snapshotChat(env,scope);
 const now=clock(env),where=scope?' WHERE id=?':'',args=scope?[scope]:[];
 const items=[[`UPDATE chats SET mode='off',revision=revision+1${where}`,args],[`UPDATE proposals SET status='cancelled' WHERE status='pending'${scope?' AND scope=?':''}`,args],[`UPDATE outbox SET state='cancelled' WHERE state='pending' AND mode<>'owner'${scope?' AND scope=?':''}`,args]];
 items.push(['DELETE FROM owner_tasks WHERE owner_id=?'+(scope?' AND target=?':''),scope?[String(env.OWNER_ID),scope]:[String(env.OWNER_ID)]]);
 items.push(
  ['DELETE FROM deletion_snapshots'+(scope?' WHERE scope=?':''),args],
  ["UPDATE outbox SET state='cancelled',payload='{}' WHERE state='pending' AND id GLOB ?",[scope?'deletion:'+scope+':*':'deletion:*']]);
 if(!scope)items.unshift(['UPDATE settings SET paused=1 WHERE id=1'],['DELETE FROM deletion_watch'],["INSERT INTO deletion_watch(scope) VALUES('global:off')"]);
 await batch(env,items);await audit(env,'owner_stop');return now;
}
export async function createProposal(env,eventId,scope,kind,payload){
 const old=await one(env,'SELECT * FROM proposals WHERE event_id=? AND scope=? AND kind=?',[eventId,scope,kind]);if(old)return old;
 const id=await key(eventId+':'+scope+':'+kind),c=await getChat(env,scope),now=clock(env);
 await run(env,'INSERT OR IGNORE INTO proposals(id,event_id,scope,kind,payload,revision,expires_at,at) VALUES(?,?,?,?,?,?,?,?)',[id,eventId,scope,kind,JSON.stringify(payload),c?.revision??0,now+300000,now]);
 return one(env,'SELECT * FROM proposals WHERE id=?',[id]);
}
export async function maintenance(env){
 const now=clock(env);
 await run(env,"UPDATE inbox SET state='pending' WHERE state='processing' AND lease_until<?",[now]);
 const uncertain=await all(env,"SELECT id FROM outbox WHERE state='sending' AND lease_until<?",[now]);
 for(const row of uncertain){await run(env,"UPDATE outbox SET state='unknown',error='interrupted' WHERE id=? AND state='sending'",[row.id]);await queue(env,'uncertain:'+row.id,'Не удалось подтвердить результат одной отправки. Повторять её автоматически не буду. Проверь чат; состояние видно в /status.');}
 const s=await one(env,'SELECT cleanup_at FROM settings WHERE id=1');
 if(now-s.cleanup_at<3600000)return;
 await batch(env,[['DELETE FROM deletion_snapshots WHERE at<?',[now-72*3600000]],['DELETE FROM messages WHERE at<?',[now-72*3600000]],["DELETE FROM inbox WHERE state='done' AND at<?",[now-7*86400000]],["UPDATE proposals SET status='expired',payload='{}' WHERE status='pending' AND expires_at<?",[now]],["UPDATE outbox SET state='expired',payload='{}' WHERE state='pending' AND expires_at<?",[now]],["UPDATE proposals SET payload='{}' WHERE status<>'pending' AND at<?",[now-86400000]],["UPDATE outbox SET payload='{}' WHERE state IN ('sent','failed','cancelled','expired') AND at<?",[now-86400000]],['DELETE FROM audit WHERE at<?',[now-30*86400000]],['UPDATE settings SET cleanup_at=? WHERE id=1',[now]]]);
}

export const providerDefaults={nvidia:[200000,250],cloudflare:[200000,500],groq:[200000,500],siliconflow:[500000,1000],openrouter:[50000,100]};
export async function budgets(env){
 const day=new Date(clock(env)).toISOString().slice(0,10),rows=await all(env,'SELECT * FROM provider_usage WHERE day=?',[day]);
 return Object.entries(providerDefaults).map(([provider,[tokens,requests]])=>{const used=rows.find(r=>r.provider===provider)||{};const limit=(suffix,fallback)=>{const n=Number(env[provider.toUpperCase()+'_DAILY_'+suffix]);return Number.isFinite(n)&&n>=0&&env[provider.toUpperCase()+'_DAILY_'+suffix]!==undefined?Math.floor(n):fallback;};return {provider,tokens:Math.max(0,limit('TOKENS',tokens)-(used.tokens||0)),requests:Math.max(0,limit('REQUESTS',requests)-(used.requests||0))};});
}
export async function reserveProvider(env,provider){
 const day=new Date(clock(env)).toISOString().slice(0,10),defaults=providerDefaults[provider];if(!defaults)return false;
 const limit=(suffix,fallback)=>{const raw=env[provider.toUpperCase()+'_DAILY_'+suffix],n=Number(raw);return raw!==undefined&&Number.isFinite(n)&&n>=0?Math.floor(n):fallback;};
 await run(env,'INSERT OR IGNORE INTO provider_usage(day,provider) VALUES(?,?)',[day,provider]);
 const r=await run(env,'UPDATE provider_usage SET requests=requests+1 WHERE day=? AND provider=? AND requests<? AND tokens<?',[day,provider,limit('REQUESTS',defaults[1]),limit('TOKENS',defaults[0])]);
 return r.meta.changes===1?day:false;
}
export async function accountProvider(env,provider,day,tokens){await run(env,'UPDATE provider_usage SET tokens=tokens+? WHERE day=? AND provider=?',[Math.max(0,Number(tokens)||0),day,provider]);}

// UTF-8 bytes are a conservative token upper bound, including serialized roles.
export function trimHistory(rows,budget){const out=[];let left=budget;for(const row of [...rows].reverse()){const cost=new TextEncoder().encode(JSON.stringify(row)).length;if(cost>left){if(!out.length){let body=row.body;while(body&&new TextEncoder().encode(JSON.stringify({...row,body})).length>left)body=body.slice(Math.ceil(body.length/10));if(body)out.unshift({...row,body});}break;}out.unshift(row);left-=cost;}return out;}
export async function optionalRows(env,table,chat){const exists=await one(env,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]);return exists?all(env,'SELECT * FROM '+table+' WHERE chat_id=?',[chat]):[];}
export async function chatContext(env,id,budget=4000){const c=await context(env,id,budget);const query=c.history.at(-1)?.body||'';return {...c,style:await activeStyle(env,id),peer_facts:(await relevantFacts(env,id,query)).map(({fact,source,source_message_id,confidence})=>({fact,source,source_message_id,confidence})),conversation_state:(await optionalRows(env,'conversation_state',id))[0]||null};}
const words=text=>String(text).toLowerCase().replace(/ё/g,'е').match(/[\p{L}\p{N}_]+/gu)||[];
const stem=w=>w.replace(/(?:ами|ями|ой|ей|ую|юю|ом|ем|а|я|у|ю|е|ы|и)$/u,'');
const transliterate=w=>String(w).replace(/[а-я]/g,c=>({а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ы:'y',э:'e',ю:'yu',я:'ya',ь:'',ъ:''})[c]??c);
export function resolveTarget(event,chats){
 if(event.target)return chats.find(c=>c.handle===event.target)?.handle||null;
 const text=String(event.text||'').toLowerCase(),handles=[...text.matchAll(/@([a-z0-9_]{3,32})/giu)].map(m=>m[1]);
 if(handles.length){const matches=chats.filter(c=>String(c.aliases||'').toLowerCase().split(',').some(a=>handles.includes(a.replace(/^@/,''))));return matches.length===1?matches[0].handle:null;}
 const groups=[['владислав','влад','владик'],['екатерина','катерина','катя'],['александр','саша'],['александра','саша'],['мария','маша']];
 const forms=w=>[transliterate(stem(w)),transliterate(w)],expand=items=>new Set(items.flatMap(w=>{const roots=forms(w);return [...roots,...groups.filter(g=>g.some(n=>forms(n).some(v=>roots.includes(v)))).flat().flatMap(forms)];}));
 const textGroups=words(text).map(w=>expand([w])),ranked=chats.map(c=>{const known=expand(words(c.title+' '+(c.aliases||'')));return {chat:c,score:textGroups.filter(group=>[...group].some(w=>w.length>=3&&known.has(w))).length};});
 const best=Math.max(0,...ranked.map(r=>r.score)),matches=ranked.filter(r=>best>0&&r.score===best);return matches.length===1?matches[0].chat.handle:null;
}

export async function snapshotChat(env,id){const c=await getChat(env,id);if(!c)return;const style=await one(env,'SELECT tone,instructions FROM chat_style WHERE chat_id=?',[id]);await run(env,'INSERT INTO chat_changes(chat_id,state,created_at) VALUES(?,?,?)',[id,JSON.stringify({mode:c.mode,until_at:c.until_at,instruction:c.instruction,style}),clock(env)]);}
export async function undoChat(env,id){const last=await one(env,'SELECT * FROM chat_changes WHERE chat_id=? AND undone=0 ORDER BY id DESC LIMIT 1',[id]);if(!last)return false;const old=JSON.parse(last.state);const statements=[['UPDATE chats SET mode=?,until_at=?,instruction=?,revision=revision+1 WHERE id=?',[old.mode,old.until_at,old.instruction,id]],['UPDATE chat_changes SET undone=1 WHERE id=?',[last.id]]];if(old.style)statements.push(['INSERT INTO chat_style(chat_id,tone,instructions,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET tone=excluded.tone,instructions=excluded.instructions,updated_at=excluded.updated_at',[id,old.style.tone,old.style.instructions,clock(env)]]);else statements.push(['DELETE FROM chat_style WHERE chat_id=?',[id]]);await batch(env,statements);return true;}
export async function changeStyle(env,id,patch,source){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['tone','instructions'].includes(k))||Object.values(patch).some(v=>typeof v!=='string'||v.length>1000))throw Error('invalid_style');const old=await one(env,'SELECT tone,instructions FROM chat_style WHERE chat_id=?',[id]);await snapshotChat(env,id);const next={tone:old?.tone||'',instructions:old?.instructions||'',...patch};await batch(env,[['INSERT INTO chat_style(chat_id,tone,instructions,previous_state,updated_at,source_message_id) VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET tone=excluded.tone,instructions=excluded.instructions,previous_state=excluded.previous_state,updated_at=excluded.updated_at,source_message_id=excluded.source_message_id',[id,next.tone,next.instructions,JSON.stringify(old),clock(env),source]],['UPDATE chats SET revision=revision+1 WHERE id=?',[id]]]);return next;}

export async function enqueueBackground(env,chat,kind,notBefore=0){await run(env,"INSERT INTO background_jobs(chat_id,kind,not_before) VALUES(?,?,?) ON CONFLICT(chat_id,kind) DO UPDATE SET version=version+1,not_before=MAX(not_before,excluded.not_before)",[chat,kind,notBefore]);}
export async function scheduleFacts(env,chat){const c=await getChat(env,chat);if(!c?.consent||c.mode==='off'||c.until_at<=clock(env))return;await run(env,'INSERT INTO fact_extraction(chat_id,new_messages) VALUES(?,1) ON CONFLICT(chat_id) DO UPDATE SET new_messages=new_messages+1',[chat]);const counter=await one(env,'SELECT * FROM fact_extraction WHERE chat_id=?',[chat]);if(counter.new_messages>=5)await enqueueBackground(env,chat,'facts',counter.last_attempt+600000);}
export async function saveExtractedFact(env,chat,item){if(!item||typeof item.fact!=='string'||!item.fact.trim()||item.fact.length>400||/^панда(?:[\s,!:]|$)/iu.test(item.fact)||!['owner','interlocutor'].includes(item.source)||item.confidence!=='high')return false;const m=await one(env,'SELECT * FROM messages WHERE id=? AND scope=?',[item.source_message_id,chat]);if(!m||!(m.role==='user'||m.manual===1)||!m.body.includes(item.fact)||(item.source==='owner')!==(m.manual===1))return false;const count=await one(env,'SELECT count(*) AS n FROM chat_facts WHERE chat_id=?',[chat]);if(count.n>=200)return false;const r=await run(env,'INSERT OR IGNORE INTO chat_facts(chat_id,fact,source,source_message_id,confidence,created_at) VALUES(?,?,?,?,?,?)',[chat,item.fact,item.source,item.source_message_id,'high',clock(env)]);if(r.meta.changes){const {embedding}=await import('./providers.mjs');const vector=await embedding(env,item.fact);if(vector)await run(env,'UPDATE chat_facts SET embedding_json=? WHERE chat_id=? AND source_message_id=? AND fact=?',[JSON.stringify(vector),chat,item.source_message_id,item.fact]);}return !!r.meta.changes;}

export async function saveConversationState(env,chat,state,revision){if(!state||['topic','last_question','discussed','unanswered'].some(k=>typeof state[k]!=='string'||state[k].length>1000))return false;const r=await run(env,'INSERT INTO conversation_state(chat_id,topic,last_question,discussed,unanswered,updated_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM chats WHERE id=? AND revision=?) ON CONFLICT(chat_id) DO UPDATE SET topic=excluded.topic,last_question=excluded.last_question,discussed=excluded.discussed,unanswered=excluded.unanswered,updated_at=excluded.updated_at',[chat,state.topic,state.last_question,state.discussed,state.unanswered,clock(env),chat,revision]);return !!r.meta.changes;}

export function cosine(a,b){if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||!a.length||[...a,...b].some(x=>!Number.isFinite(x)))return 0;const dot=a.reduce((s,x,i)=>s+x*b[i],0),norm=Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));return norm?dot/norm:0;}
export async function relevantFacts(env,chat,query){const rows=await optionalRows(env,'chat_facts',chat);if(!rows.length)return [];let vector=null;if(rows.some(r=>r.embedding_json)){const {embedding}=await import('./providers.mjs');vector=await embedding(env,query);}const terms=words(query).filter(w=>w.length>2);return rows.map(r=>{let v;try{v=JSON.parse(r.embedding_json);}catch{}return {row:r,score:vector&&Array.isArray(v)?cosine(vector,v):terms.filter(t=>r.fact.toLowerCase().includes(t)).length};}).sort((a,b)=>b.score-a.score||b.row.created_at-a.row.created_at).slice(0,12).map(x=>x.row);}

export async function activeStyle(env,id){const row=(await optionalRows(env,'chat_style',id))[0];return row?{tone:row.tone,instructions:row.instructions}:null;}
