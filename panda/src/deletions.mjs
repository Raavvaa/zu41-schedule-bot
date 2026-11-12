import {batch,clock,one,run,OWNER} from './store.mjs';

export const DELETION_RETENTION = 72 * 3600000;
const active = "kind='private' AND consent=1 AND mode<>'off' AND until_at>?";
const media = {
 photo:['sendPhoto','photo'], video:['sendVideo','video'], document:['sendDocument','document'],
 animation:['sendAnimation','animation'], audio:['sendAudio','audio'], voice:['sendVoice','voice'],
 video_note:['sendVideoNote','video_note'], sticker:['sendSticker','sticker']
};

export const deletionWatch = (env,scope) => one(env,'SELECT scope FROM deletion_watch WHERE scope=?',[scope]);

export async function setDeletionWatch(env,scope,enabled){
 if(enabled){
  const result=await run(env,`INSERT OR IGNORE INTO deletion_watch(scope)
   SELECT chats.id FROM chats JOIN connections ON connections.id=chats.connection_id
   WHERE chats.id=? AND connections.enabled=1 AND ${active}`,[scope,clock(env)]);
  return result.meta.changes>0||!!await deletionWatch(env,scope);
 }
 await batch(env,[
  ['DELETE FROM deletion_watch WHERE scope=?',[scope]],
  ['DELETE FROM deletion_snapshots WHERE scope=?',[scope]],
  ["UPDATE outbox SET state='cancelled',payload='{}' WHERE id GLOB ? AND state='pending'",['deletion:'+scope+':*']]
 ]);
 return true;
}

export async function captureDeletionSnapshot(env,scope,m){
 if(!Number.isSafeInteger(m.message_id))return;
 const now=clock(env),at=Number.isSafeInteger(m.date)?Math.min(m.date*1000,now):now;
 const type=Object.keys(media).find(name=>m[name]);
 const file=type==='photo'?m.photo.at(-1):m[type];
 if(m.has_protected_content||m.ttl_seconds||m.is_view_once||m.view_once||file?.ttl_seconds||file?.is_view_once||file?.view_once){
  if(m.edit_date)await run(env,'DELETE FROM deletion_snapshots WHERE scope=? AND message_id=?',[scope,m.message_id]);
  return;
 }
 const body=String(m.text??m.caption??'').slice(0,3000);
 const fileId=typeof file?.file_id==='string'?file.file_id:null;
 if(!body&&!fileId)return;
 await run(env,`INSERT INTO deletion_snapshots(scope,message_id,at,body,method,field,file_id)
  SELECT ?,?,?,?,?,?,? FROM chats JOIN deletion_watch ON deletion_watch.scope=chats.id
  WHERE chats.id=? AND ${active}
   AND NOT EXISTS(SELECT 1 FROM outbox WHERE id=?)
  ON CONFLICT(scope,message_id) DO UPDATE SET body=excluded.body,method=excluded.method,field=excluded.field,file_id=excluded.file_id
  WHERE ?=1`,[scope,m.message_id,at,body,media[type]?.[0]??null,media[type]?.[1]??null,fileId,scope,now,'deletion:'+scope+':'+m.message_id,m.edit_date?1:0]);
}

export async function recordDeletions(env,scope,updateId,messageIds){
 const now=clock(env);
 const ids=[...new Set(messageIds)].filter(Number.isSafeInteger);
 const chat=await one(env,`SELECT title FROM chats JOIN deletion_watch ON scope=chats.id
  JOIN connections ON connections.id=chats.connection_id
  WHERE chats.id=? AND connections.enabled=1 AND ${active}`,[scope,now]);
 const items=[['INSERT OR IGNORE INTO inbox(id,scope,payload,state,at) VALUES(?,?,?,?,?)',[updateId,OWNER,'{}','done',now]],
  ["UPDATE chats SET revision=revision+1,summary='' WHERE id=?",[scope]],
  ['DELETE FROM conversation_state WHERE chat_id=?',[scope]]];
 for(const mid of ids){
  if(chat){
   const snapshot=await one(env,'SELECT * FROM deletion_snapshots WHERE scope=? AND message_id=? AND at>?',[scope,mid,now-DELETION_RETENTION]);
   const title='Удалено в чате «'+chat.title.slice(0,150)+'».';
   const description=title+(snapshot?.body?'\n\n'+snapshot.body:'');
   const method=snapshot?.file_id?snapshot.method:'sendMessage';
   const body={chat_id:env.OWNER_ID,protect_content:true};
   if(method==='sendMessage')body.text=snapshot?description:title+' Сохранённой копии нет.';
   else {
    body[snapshot.field]=snapshot.file_id;
    if(method!=='sendSticker'&&method!=='sendVideoNote')body.caption=description.slice(0,1024);
    else items.push(notice('deletion:'+scope+':'+mid+':note','sendMessage',{...body,text:description,[snapshot.field]:undefined},now));
   }
   items.push(notice('deletion:'+scope+':'+mid,method,body,now));
  }
  items.push(['DELETE FROM deletion_snapshots WHERE scope=? AND message_id=?',[scope,mid]],
   ['DELETE FROM messages WHERE id=?',[scope+':'+mid]],
   ['DELETE FROM chat_facts WHERE chat_id=? AND source_message_id=?',[scope,scope+':'+mid]]);
 }
 await batch(env,items);
}

function notice(id,method,body,now){
 return ["INSERT OR IGNORE INTO outbox(id,scope,method,payload,mode,revision,expires_at,at) VALUES(?,?,?,?,'owner',0,?,?)",
  [id,OWNER,method,JSON.stringify(body),now+120000,now]];
}
