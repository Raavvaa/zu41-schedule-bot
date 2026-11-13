import {all,batch,clock,one,run,OWNER} from './store.mjs';

export const DELETION_RETENTION = 72 * 3600000;
const privateChat = "chats.kind='private'";
const media = {
 photo:['sendPhoto','photo'], video:['sendVideo','video'], document:['sendDocument','document'],
 animation:['sendAnimation','animation'], audio:['sendAudio','audio'], voice:['sendVoice','voice'],
 video_note:['sendVideoNote','video_note'], sticker:['sendSticker','sticker']
};

const watchEnabled = "EXISTS(SELECT 1 FROM deletion_watch WHERE scope='global:on')";
export const deletionWatch = env => one(env,"SELECT scope FROM deletion_watch WHERE scope='global:on'");

export async function setDeletionWatch(env,enabled){
 const changes=[
  ['DELETE FROM deletion_watch'],
  ['INSERT INTO deletion_watch(scope) VALUES(?)',[enabled?'global:on':'global:off']]
 ];
 if(!enabled)changes.push(
  ['DELETE FROM deletion_snapshots'],
  ["UPDATE outbox SET state='cancelled',payload='{}' WHERE id GLOB 'deletion:*' AND state='pending'"]
 );
 await batch(env,changes);
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
  SELECT ?,?,?,?,?,?,? FROM chats JOIN connections ON connections.id=chats.connection_id
  WHERE chats.id=? AND connections.enabled=1 AND ${privateChat} AND ${watchEnabled}
   AND NOT EXISTS(SELECT 1 FROM outbox WHERE id=?)
  ON CONFLICT(scope,message_id) DO UPDATE SET body=excluded.body,method=excluded.method,field=excluded.field,file_id=excluded.file_id
  WHERE ?=1`,[scope,m.message_id,at,body,media[type]?.[0]??null,media[type]?.[1]??null,fileId,scope,'deletion:'+scope+':'+m.message_id,m.edit_date?1:0]);
}

export async function recordDeletions(env,scope,updateId,messageIds){
 const now=clock(env);
 const ids=[...new Set(messageIds)].filter(Number.isSafeInteger);
 const chat=await one(env,`SELECT title FROM chats
  JOIN connections ON connections.id=chats.connection_id
  WHERE chats.id=? AND connections.enabled=1 AND ${privateChat} AND ${watchEnabled}`,[scope]);
 // Limit each database batch. Keep the update unacknowledged until every
 // group finishes; stable outbox IDs make a retried group idempotent.
 for(let offset=0;offset<ids.length;offset+=20){
  await recordDeletionGroup(env,scope,ids.slice(offset,offset+20),chat,now);
 }
 await batch(env,[
  ['INSERT INTO audit(kind,at) VALUES(?,?)',[chat?'deletion_watch_received':'deletion_watch_inactive',now]],
  ['INSERT OR IGNORE INTO inbox(id,scope,payload,state,at) VALUES(?,?,?,?,?)',[updateId,OWNER,'{}','done',now]]
 ]);
}

async function recordDeletionGroup(env,scope,ids,chat,now){
 const snapshots=chat?await all(env,`SELECT * FROM deletion_snapshots WHERE scope=? AND at>?
  AND message_id IN (${ids.map(()=>'?').join(',')})`,[scope,now-DELETION_RETENTION,...ids]):[];
 const byId=new Map(snapshots.map(snapshot=>[snapshot.message_id,snapshot]));
 const items=[
  ["UPDATE chats SET revision=revision+1,summary='' WHERE id=?",[scope]],
  ['DELETE FROM conversation_state WHERE chat_id=?',[scope]]
 ];
 for(const mid of ids){
  if(chat){
   const snapshot=byId.get(mid);
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
 return ["INSERT OR IGNORE INTO outbox(id,scope,method,payload,mode,revision,expires_at,at) SELECT ?,?,?,?,'owner',0,?,? WHERE EXISTS(SELECT 1 FROM deletion_watch WHERE scope='global:on')",
  [id,OWNER,method,JSON.stringify(body),now+120000,now]];
}
