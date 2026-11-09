import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';

let mf,db,dir,id=0,calls=[],responses=[];
const say=content=>Response.json({choices:[{message:{content}}]});
const fail=status=>Response.json({error:{code:'fixture'}},{status});
const tool=(name,args,extra={})=>Response.json({choices:[{message:{...extra,tool_calls:[{id:'call_fixture',type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'brat-fallback-'));
 await build({entryPoints:['test/entry.mjs'],outfile:join(dir,'bundle.mjs'),bundle:true,format:'esm'});
 mf=new Miniflare({modules:true,scriptPath:join(dir,'bundle.mjs'),modulesRoot:dir,compatibilityDate:'2026-07-01',d1Databases:['DB'],bindings:{CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:'router-fixture',GROQ_API_KEY:'groq-fixture',TELEGRAM_BOT_TOKEN:'fixture',OWNER_CHAT_ID:'1001'},outboundService:async req=>{
  const host=new URL(req.url).hostname;
  if(host==='api.telegram.org')return Response.json({ok:true,result:{message_id:id}});
  assert.ok(['openrouter.ai','api.groq.com'].includes(host));
  assert.equal(req.headers.get('authorization'),host==='openrouter.ai'?'Bearer router-fixture':'Bearer groq-fixture');
  calls.push({host,body:await req.json()});
  return responses.shift()??fail(503);
 }});
 db=await mf.getD1Database('DB');await db.exec((await readFile('migrations/0001.sql','utf8')).replace(/\n/g,' '));
});
beforeEach(async()=>{
 calls=[];responses=[];
 await db.exec("DELETE FROM updates; DELETE FROM outbox; DELETE FROM memory; DELETE FROM drafts; DELETE FROM entries; DELETE FROM transactions; DELETE FROM budgets; UPDATE settings SET revision=0,claim=NULL; UPDATE wallets SET amount=0,initialized=1;");
});
after(async()=>{await mf?.dispose();if(dir)await rm(dir,{recursive:true,force:true});});
async function turn(text,callback,now=Date.now()){
 const n=++id;
 await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(n,JSON.stringify({update_id:n,...(callback?{callback_query:{data:callback}}:{message:{text}})}),now).run();
 const r=await mf.dispatchFetch('https://fixture/test/drain',{method:'POST',body:JSON.stringify({now})});
 assert.equal(r.status,200);assert.ok((await r.json()).requests<=48);
 const out=await db.prepare('SELECT payload FROM outbox WHERE id=?').bind(String(n)).first();
 return {id:n,...JSON.parse(out.payload)};
}
const count=async table=>(await db.prepare('SELECT count(*) n FROM '+table).first()).n;
const hosts=()=>calls.map(x=>x.host);
const chain=['openrouter.ai','api.groq.com'];

test('a successful OpenRouter reply makes no Groq call',async()=>{
 responses=[say('Я тут, брат.')];assert.equal((await turn('Как ты?')).text,'Я тут, брат.');assert.deepEqual(hosts(),chain.slice(0,1));
});
test('404, 429 and 503 each produce one conversational reply through Groq',async()=>{
 for(const status of [404,429,503]){
  responses=[fail(status),say('На связи, брат.')];assert.equal((await turn('Как ты?')).text,'На связи, брат.');
 }
 assert.deepEqual(hosts(),[...chain,...chain,...chain]);assert.equal(await count('outbox'),3);assert.equal(await count('transactions'),0);
});
test('malformed primary result falls back to a single draft requiring confirmation',async()=>{
 responses=[say(''),tool('propose_transaction',{actions:[{type:'income',wallet:'pocket',currency:'RUB',amount:'723',to:null,note:'Тестовый доход'}]})];
 const r=await turn('Запиши доход 723 рубля в карманные.');
 assert.match(r.text,/723/);assert.equal(await count('drafts'),1);assert.equal(await count('transactions'),0);assert.deepEqual(hosts(),chain);
 await turn('',`yes:${r.id}`);await turn('',`yes:${r.id}`);assert.equal(await count('transactions'),1);assert.deepEqual(hosts(),chain);
});
test('mid-turn fallback keeps tool results but drops the primary model’s opaque state',async()=>{
 responses=[tool('read_ledger',{}, {reasoning_details:[{data:'fixture-opaque'}]}),fail(503),say('Могу объяснить, как устроен журнал.')];
 assert.match((await turn('Объясни мне журнал')).text,/как устроен/);
 assert.deepEqual(hosts(),[chain[0],...chain]);
 const {messages}=calls.at(-1).body;
 assert.ok(messages.some(x=>x.role==='tool'&&x.tool_call_id==='call_fixture'));
 assert.ok(!JSON.stringify(messages).includes('fixture-opaque'));assert.equal(await count('drafts'),0);
});
test('the daily OpenRouter budget does not consume the Groq budget',async()=>{
 const now=Date.now(),day=new Date(now+10800000).toISOString().slice(0,10);
 await db.prepare('INSERT INTO budgets(day,used) VALUES(?,50)').bind('openrouter:'+day).run();
 responses=[say('Слушаю, брат.')];assert.equal((await turn('Ты здесь?',null,now)).text,'Слушаю, брат.');assert.deepEqual(hosts(),['api.groq.com']);
 assert.equal((await db.prepare('SELECT used FROM budgets WHERE day=?').bind(day).first()).used,1);
});
test('when both providers fail, confirmed dates and top-ups are still served locally',async()=>{
 const d=await turn('/доход карманные RUB 723 смена',null,Date.parse('2026-10-02T16:22:00Z'));
 await turn('',`yes:${d.id}`,Date.parse('2026-10-02T16:23:00Z'));
 responses=[fail(503),fail(503)];await turn('Запиши 613 рублей дохода в карманные.');assert.deepEqual(hosts(),chain);
 const r=await turn('В какое время я сколько добавлял?');
 assert.match(r.text,/02\.10\.2026.*19:23.*\+723/u);
 assert.match(r.text,/МСК/);assert.doesNotMatch(r.text,/613/);assert.deepEqual(hosts(),chain);
 assert.equal(await count('transactions'),1);assert.equal(await count('drafts'),1);
});
