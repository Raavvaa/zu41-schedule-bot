// Manual, bounded smoke test: real Groq, disposable D1, fake Telegram only.
// No automatic workflow trigger and no production database or bot credentials.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {statedAmounts} from '../src/brain.mjs';

if(!process.env.GROQ_API_KEY)throw Error('GROQ_API_KEY is not available; no requests made');
const root=fileURLToPath(new URL('..',import.meta.url));
const dir=await mkdtemp(path.join(tmpdir(),'brat-intent-live-'));
let mf,calls=0,tokens=0,blocked=false,seq=1,passed=0;
const latencies=[];
try{
 await build({entryPoints:[path.join(root,'test/entry.mjs')],outfile:path.join(dir,'bundle.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:path.join(dir,'bundle.mjs'),modulesRoot:dir,compatibilityDate:'2026-07-01',d1Databases:['DB'],bindings:{GROQ_API_KEY:process.env.GROQ_API_KEY,GROQ_MODEL:'openai/gpt-oss-120b',TELEGRAM_BOT_TOKEN:'fixture',OWNER_CHAT_ID:'1001'},outboundService:async req=>{
  const u=new URL(req.url);
  if(u.hostname==='api.telegram.org')return Response.json({ok:true,result:{message_id:seq}});
  if(u.hostname!=='api.groq.com'||u.pathname!=='/openai/v1/chat/completions')throw Error('Unexpected outbound request');
  if(blocked||calls>=8){blocked=true;return Response.json({error:{code:'smoke_budget'}},{status:429});}
  calls++;
  try{
   const response=await fetch(req.url,{method:'POST',headers:{authorization:req.headers.get('authorization'),'content-type':'application/json'},body:await req.text(),signal:AbortSignal.timeout(15000)});
   if(!response.ok)blocked=true; // Stop the entire smoke run on the first provider error.
   const data=await response.clone().json();tokens+=data.usage?.total_tokens??0;
   return response;
  }catch{blocked=true;return Response.json({error:{code:'smoke_transport'}},{status:503});}
 }});
 const db=await mf.getD1Database('DB');
 await db.exec((await readFile(path.join(root,'migrations/0001.sql'),'utf8')).replace(/\n/g,' '));
 await db.exec('UPDATE wallets SET amount=0,initialized=1');
 const count=async table=>(await db.prepare('SELECT count(*) n FROM '+table).first()).n;
 async function turn(text,callback){
  const id=seq++,now=Date.now();
  await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(id,JSON.stringify({update_id:id,...(callback?{callback_query:{data:callback}}:{message:{text}})}),now).run();
  const r=await mf.dispatchFetch('https://fixture/test/drain',{method:'POST',body:JSON.stringify({now})});
  latencies.push(Date.now()-now);assert.equal(r.status,200);assert.equal(blocked,false,'Provider error or smoke budget reached');
  const row=await db.prepare('SELECT payload FROM outbox WHERE id=?').bind(String(id)).first();assert.ok(row);
  const reply=JSON.parse(row.payload).text;
  assert.doesNotMatch(reply,/Не буду угадывать|Модель не успела|не смог проверить|Сервис модели|исчерпан лимит/iu);
  return {id,reply};
 }
 if(process.argv.includes('--opinion')){
  const opinion=await turn('На праздник подарили 18 тысяч, 9 уже отложил в дом, норм? Как думаешь?');
  assert.doesNotMatch(opinion.reply,/Какую сумму нужно учесть|итоговый остаток|Всё верно/iu);
  assert.equal(await count('drafts'),0);assert.equal(await count('transactions'),0);passed++;
  await turn('Хочу куртку за 8300 рублей.');
  assert.equal(await count('drafts'),0);assert.equal(await count('transactions'),0);passed++;
  const proposal=await turn('За смену вышло всего 3700 рублей, запиши в карманные.');
  const draft=await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(proposal.id)).first();assert.ok(draft);
  const actions=JSON.parse(draft.payload).actions;assert.equal(actions.length,1);assert.equal(actions[0].type,'income');assert.equal(actions[0].wallet,'pocket');assert.equal(actions[0].currency,'RUB');assert.equal(actions[0].amount,370000);
  assert.equal(await count('transactions'),0);passed++;
  await turn('', 'yes:'+proposal.id);assert.equal(await count('transactions'),1);passed++;
  const ack=await turn('Чётко, спасибо.');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(ack.id)).first(),null);assert.equal(await count('transactions'),1);passed++;
 }else{
 await turn('На праздник подарили 6200 рублей. Никуда не добавляй, просто делюсь.');
 assert.equal(await count('drafts'),0);assert.equal(await count('transactions'),0);passed++;
 const recalled=await turn('Сколько мне подарили, помнишь?');
 assert.ok(statedAmounts(recalled.reply).includes(620000)||/шесть\s+тысяч\s+двести/iu.test(recalled.reply));
 assert.equal(await count('drafts'),0);assert.equal(await count('transactions'),0);passed++;
 const proposal=await turn('Теперь запиши этот подарок в карманные, рубли.');
 const draft=await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(proposal.id)).first();assert.ok(draft);
 const actions=JSON.parse(draft.payload).actions;assert.equal(actions.length,1);assert.equal(actions[0].type,'income');assert.equal(actions[0].wallet,'pocket');assert.equal(actions[0].currency,'RUB');assert.equal(actions[0].amount,620000);
 assert.equal(await count('transactions'),0);passed++;
 await turn('', 'yes:'+proposal.id);assert.equal(await count('transactions'),1);passed++;
 const ack=await turn('Чётко, брат.');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(ack.id)).first(),null);assert.equal(await count('transactions'),1);passed++;
 const last=await turn('Сколько денег было в последнем пополнении?');
 assert.ok(statedAmounts(last.reply).includes(620000)||/шесть\s+тысяч\s+двести/iu.test(last.reply));
 assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(last.id)).first(),null);assert.equal(await count('transactions'),1);passed++;
 }
 console.log(JSON.stringify({ok:true,scenarios:passed,groq_calls:calls,reported_total_tokens:tokens,turn_ms:latencies,telegram_network_calls:0,temporary_database:true}));
}catch{
 console.log(JSON.stringify({ok:false,scenarios:passed,groq_calls:calls,reported_total_tokens:tokens,provider_blocked:blocked,telegram_network_calls:0,temporary_database:true}));
 process.exitCode=1;
}finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
