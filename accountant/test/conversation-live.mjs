// Manual, bounded smoke test: real selected provider, disposable D1, fake Telegram only.
// No automatic workflow trigger and no production database or bot credentials.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {statedAmounts} from '../src/brain.mjs';

const {modelProvider}=await import('../src/model-provider.mjs');
const forcedFallback=process.argv.includes('--fallback');
const provider=modelProvider(forcedFallback?{...process.env,CHAT_PROVIDER:'groq'}:process.env);
const modelBindings=provider.name==='openrouter'?{CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:provider.key,OPENROUTER_MODEL:provider.model}:{GROQ_API_KEY:provider.key,GROQ_MODEL:provider.model,...(forcedFallback?{CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:'fixture'}:{})};
const root=fileURLToPath(new URL('..',import.meta.url));
const dir=await mkdtemp(path.join(tmpdir(),'brat-intent-live-'));
let mf,calls=0,tokens=0,blocked=false,seq=1,passed=0,simulatedOutages=0;
const latencies=[];
let providerStatus=null,providerFailure=null,formatRetries=0;
function classifyFailure(status,data){
 const message=String(data?.error?.message??'').toLowerCase();
 if(data?.error?.code==='tool_use_failed'||data?.error?.failed_generation!=null)return 'tool_generation';
 if(status===401)return 'authentication';
 if(status===402)return 'credits';
 if(status===429)return 'rate_limit';
 if(/data policy|privacy|data collection/.test(message))return 'privacy_policy';
 if(/tool use|tool calling|tool compatibility/.test(message))return 'tool_compatibility';
 if(/no endpoints|no providers/.test(message))return 'no_eligible_provider';
 if(/reasoning_format/.test(message))return 'reasoning_format';
 if(/parallel_tool_calls/.test(message))return 'parallel_tool_calls';
 if(/message.*role|system message/.test(message))return 'message_roles';
 if(/schema/.test(message))return 'tool_schema';
 if(/parameter|tool|schema/.test(message))return 'unsupported_request';
 return 'http_error';
}
try{
 await build({entryPoints:[path.join(root,'test/entry.mjs')],outfile:path.join(dir,'bundle.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:path.join(dir,'bundle.mjs'),modulesRoot:dir,compatibilityDate:'2026-07-01',d1Databases:['DB'],bindings:{...modelBindings,TELEGRAM_BOT_TOKEN:'fixture',OWNER_CHAT_ID:'1001'},outboundService:async req=>{
  const u=new URL(req.url);
  if(u.hostname==='api.telegram.org')return Response.json({ok:true,result:{message_id:seq}});
  if(forcedFallback&&req.url==='https://openrouter.ai/api/v1/chat/completions'){simulatedOutages++;return Response.json({error:{code:'fixture_down'}},{status:503});}
  if(req.url!==provider.url)throw Error('Unexpected outbound request');
  if(blocked||calls>=8){blocked=true;return Response.json({error:{code:'smoke_budget'}},{status:429});}
  calls++;
  try{
   const response=await fetch(req.url,{method:'POST',redirect:'error',headers:{authorization:req.headers.get('authorization'),'content-type':'application/json'},body:await req.text(),signal:AbortSignal.timeout(15000)});
   const data=await response.clone().json();tokens+=data.usage?.total_tokens??0;
   if(!response.ok){
    providerStatus=response.status;providerFailure=classifyFailure(response.status,data);
    // Let the production client make its one bounded repair. Never retry limits.
    if(!(provider.name==='groq'&&response.status===400&&data?.error?.code==='tool_use_failed'&&formatRetries++===0))blocked=true;
   }
   return response;
  }catch{blocked=true;providerFailure='transport_or_invalid_json';return Response.json({error:{code:'smoke_transport'}},{status:503});}
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
 if(forcedFallback||process.argv.includes('--primary')){
  const chat=await turn('Привет, брат. Как ты?');
  assert.ok(chat.reply.trim());assert.equal(await count('drafts'),0);passed++;
  const proposal=await turn('Запиши доход 3700 рублей в карманные.');
  const draft=await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(proposal.id)).first();assert.ok(draft);
  const actions=JSON.parse(draft.payload).actions;
  assert.equal(actions.length,1);assert.equal(actions[0].type,'income');assert.equal(actions[0].wallet,'pocket');assert.equal(actions[0].currency,'RUB');assert.equal(actions[0].amount,370000);
  assert.equal(await count('transactions'),0);passed++;
  await turn('', 'yes:'+proposal.id);assert.equal(await count('transactions'),1);passed++;
 }else if(process.argv.includes('--opinion')){
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
 if(forcedFallback){assert.ok(simulatedOutages>=1);assert.ok(calls>=1);}
 console.log(JSON.stringify({ok:true,scenarios:passed,provider:provider.name,model_calls:calls,groq_calls:provider.name==='groq'?calls:0,simulated_openrouter_outages:simulatedOutages,reported_total_tokens:tokens,turn_ms:latencies,telegram_network_calls:0,temporary_database:true}));
}catch{
 console.log(JSON.stringify({ok:false,scenarios:passed,provider:provider.name,model_calls:calls,groq_calls:provider.name==='groq'?calls:0,reported_total_tokens:tokens,provider_blocked:blocked,provider_status:providerStatus,provider_failure:providerFailure,telegram_network_calls:0,temporary_database:true}));
 process.exitCode=1;
}finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
