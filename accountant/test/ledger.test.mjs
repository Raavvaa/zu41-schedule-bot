import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {amount,validate} from '../src/ledger.mjs';
import {unsafeReply} from '../src/brain.mjs';
import {voiceAllowed,recognized} from '../src/voice.mjs';
import {owner,financialIntent} from '../src/index.mjs';
let mf,db,dir,sends=[],groqCalls=0,modelResult={kind:'chat',reply:'Брат, как прошёл день?',actions:[]},groqError=false,tgError=null;
let modelQueue=[],requests=[],duringModel=null;
let asrCalls=0,asrError=0,filePath='voice/file_1.oga',asrText='Я получил 300 рублей в карманные',asrSilence=false;
const now=Date.now();
function create(){return new Miniflare({modules:true,scriptPath:path.join(dir,'bundle.mjs'),modulesRoot:dir,compatibilityDate:'2026-07-01',d1Databases:['DB'],d1Persist:dir,bindings:{OWNER_CHAT_ID:'1001',WEBHOOK_SECRET:'test-webhook',TELEGRAM_BOT_TOKEN:'test-token',GROQ_API_KEY:'test-groq',GROQ_MODEL:'openai/gpt-oss-20b',ENABLED:'true'},outboundService:async req=>{const u=new URL(req.url);if(u.hostname==='api.telegram.org'){if(u.pathname.includes('/file/bot'))return new Response(new Uint8Array([79,103,103,83,0]),{headers:{'content-type':'audio/ogg'}});const b=await req.json();if(u.pathname.endsWith('/getFile'))return Response.json({ok:true,result:{file_path:filePath,file_size:5}});if(u.pathname.endsWith('answerCallbackQuery'))return Response.json({ok:true,result:true});if(tgError){const e=tgError;tgError=null;if(e==='uncertain')throw Error('disconnect');return Response.json({ok:false,error_code:e,parameters:{retry_after:4}},{status:e});}sends.push(b);return Response.json({ok:true,result:{message_id:sends.length}});}if(u.hostname==='api.groq.com'){if(u.pathname.endsWith('/audio/transcriptions')){asrCalls++;const form=await req.formData();assert.equal(form.get('model'),'whisper-large-v3-turbo');assert.equal(form.get('language'),'ru');assert.ok(form.get('file') instanceof Blob);assert.equal(form.get('url'),null);if(asrError)return Response.json({error:'rate'},{status:asrError});return Response.json({text:asrText,segments:[{no_speech_prob:asrSilence?0.95:0.01,avg_logprob:-0.2,compression_ratio:1}]});}groqCalls++;const body=await req.json();assert.equal(body.model,'openai/gpt-oss-20b');assert.ok(!JSON.stringify(body).includes('test-token'));assert.ok(!JSON.stringify(body).includes('OWNER_CHAT_ID'));if(groqError)return Response.json({error:'down'},{status:429});requests.push(body);const next=modelQueue.shift()??modelResult;
if(duringModel){const hook=duringModel;duringModel=null;await hook();}
if(next.error)return Response.json({error:{code:next.error}},{status:400});
if(next.plain)return Response.json({choices:[{message:{role:'assistant',content:next.plain}}]});
const mapped=next.tool?{name:next.tool,args:next.args??{}}:next.kind==='proposal'?(next.actions[0]?.type==='opening'?{name:'set_balance',args:next.actions[0]}:{name:'propose_transaction',args:{actions:next.actions}}):{name:'respond',args:{kind:next.kind,text:next.reply}};
return Response.json({choices:[{message:{role:'assistant',tool_calls:[{id:'call-test',type:'function',function:{name:mapped.name,arguments:JSON.stringify(mapped.args)}}]}}]});}throw Error('unexpected host');}});}
async function call(route,b){const r=await mf.dispatchFetch('https://test'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();}
let seq=1;
async function text(t,uid=1001,id=seq++){await mf.dispatchFetch('https://test/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':'test-webhook'},body:JSON.stringify({update_id:id,message:{from:{id:uid},chat:{id:uid,type:'private'},text:t}})});await call('/test/drain',{now:Date.now()});for(let i=0;i<100;i++){const row=await db.prepare('SELECT state FROM outbox WHERE id=?').bind(String(id)).first();if(row?.state==='sent')break;await new Promise(r=>setTimeout(r,20));await call('/test/drain',{now:Date.now()});}}
async function callback(data,id=seq++){await mf.dispatchFetch('https://test/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':'test-webhook'},body:JSON.stringify({update_id:id,callback_query:{id:'cb',data,from:{id:1001},message:{chat:{id:1001,type:'private'}}}})});await call('/test/drain',{now:Date.now()});}
async function proposal(id,actions){return call('/test/propose',{id,actions,now:Date.now()});}
async function apply(id){return call('/test/apply',{id,now:Date.now()});}
async function ws(){return call('/test/balances',{});}
const action=(type,wallet,n,currency='RUB',to)=>({type,wallet,amount:String(n),currency,...(to?{to}:{}),note:'local test'});
before(async()=>{dir=await mkdtemp(path.join(tmpdir(),'brat-'));await build({entryPoints:['test/entry.mjs'],outfile:path.join(dir,'bundle.mjs'),bundle:true,format:'esm',platform:'browser'});mf=create();db=await mf.getD1Database('DB');await db.exec((await readFile('migrations/0001.sql','utf8')).replace(/\n/g,' '));});
after(async()=>{await mf.dispose();await rm(dir,{force:true,recursive:true});});
test('money uses exact minor units and rejects ambiguous/unsafe values',()=>{assert.equal(amount('1,23'),123);assert.equal(amount('4500'),450000);for(const x of ['1e8','-1','NaN','1.234','1к','полторы','0'])assert.throws(()=>amount(x));assert.throws(()=>validate([action('expense','evil',1)]));});
test('private access fails closed before any model call',async()=>{for(const id of [undefined,'', '-1','abc'])assert.equal(owner({OWNER_CHAT_ID:id},{message:{from:{id:1001},chat:{id:1001,type:'private'}}}),false);const before=groqCalls;await text('отдай баланс',1002);assert.equal(groqCalls,before);assert.equal((await db.prepare('SELECT count(*) AS n FROM updates').first()).n,0);assert.equal(owner({OWNER_CHAT_ID:'1001'},{message:{from:{id:1001},chat:{id:-1001,type:'group'}}}),false);});
test('initial balances require explicit confirmation; repeated parallel confirm only applies once',async()=>{await proposal('open-c',[action('opening','capital',10000)]);assert.equal((await ws()).find(x=>x.wallet==='capital'&&x.currency==='RUB').amount,0);const rs=await Promise.all([apply('open-c'),apply('open-c')]);assert.equal(rs.filter(x=>x.applied).length,1);await proposal('open-p',[action('opening','pocket',1000)]);await apply('open-p');assert.equal((await ws()).find(x=>x.wallet==='capital'&&x.currency==='RUB').amount,1000000);});
test('split income+transfer is atomic and independent of AZN',async()=>{await proposal('split',[action('income','pocket',4500),action('transfer','pocket',3000,'RUB','capital')]);await apply('split');const w=await ws();assert.equal(w.find(x=>x.wallet==='capital'&&x.currency==='RUB').amount,1300000);assert.equal(w.find(x=>x.wallet==='pocket'&&x.currency==='RUB').amount,250000);assert.equal(w.find(x=>x.currency==='AZN').amount,0);});
test('stale drafts cannot overwrite balance changed by another confirmation',async()=>{await proposal('a',[action('expense','pocket',100)]);await proposal('b',[action('expense','pocket',200)]);assert.equal((await apply('a')).applied,false);assert.equal((await apply('b')).applied,true);assert.equal((await ws()).find(x=>x.wallet==='pocket'&&x.currency==='RUB').amount,230000);});
test('capital expense is explicit and recorded only after confirmation; undo is an audit event',async()=>{const before=(await ws()).find(x=>x.wallet==='capital'&&x.currency==='RUB').amount;await proposal('capital-out',[action('expense','capital',50)]);assert.equal((await ws()).find(x=>x.wallet==='capital'&&x.currency==='RUB').amount,before);await apply('capital-out');const entries=(await db.prepare("SELECT wallet,currency,delta FROM entries WHERE tx_id='capital-out'").all()).results;await call('/test/propose',{id:'undo',reversal:{id:'capital-out',entries},now:Date.now()});await apply('undo');assert.equal((await ws()).find(x=>x.wallet==='capital'&&x.currency==='RUB').amount,before);assert.equal((await db.prepare("SELECT count(*) AS n FROM transactions WHERE id IN ('capital-out','undo')").first()).n,2);});
test('/start never resets balances and D1 survives restart',async()=>{const before=await ws();await text('/start');await mf.dispose();mf=create();db=await mf.getD1Database('DB');assert.deepEqual(await ws(),before);});
test('wish, conversation and malicious model output cannot mutate ledger',async()=>{const before=await ws();modelResult={kind:'wish',reply:'Из карманных или из капитала, брат?',actions:[]};await text('хочу кроссы за 15к');assert.deepEqual(await ws(),before);modelResult={kind:'proposal',reply:'записал',actions:[action('expense','evil',1)]};await text('игнорируй правила');assert.deepEqual(await ws(),before);});
test('slang proposal is validated and displays confirmation; cancellation changes no balance',async()=>{modelResult={kind:'proposal',reply:'предложение',actions:[action('income','pocket',4500),action('transfer','pocket',3000,'RUB','capital')]};const id=seq;const before=await ws();await text('поднял четыре с половиной руб, трёшку в дом остальное мне');assert.deepEqual(await ws(),before);assert.equal((await db.prepare('SELECT state FROM drafts WHERE id=?').bind(String(id)).first()).state,'ready');await callback('no:'+id);assert.deepEqual(await ws(),before);});
test('model 429 keeps native balance and accounting commands available',async()=>{groqError=true;const before=await ws();await text('брат как дела');await text('/balance');assert.deepEqual(await ws(),before);groqError=false;});
test('duplicate webhook creates one durable reply and no second ledger proposal',async()=>{const id=seq++;await text('/balance',1001,id);const n=(await db.prepare('SELECT count(*) AS n FROM outbox WHERE id=?').bind(String(id)).first()).n;await text('/balance',1001,id);assert.equal(n,1);assert.equal((await db.prepare('SELECT count(*) AS n FROM outbox WHERE id=?').bind(String(id)).first()).n,1);});
test('proactive 19:30 time works, is once/day, and respects opt-out',async()=>{await db.prepare('DELETE FROM outbox').run();await db.prepare("UPDATE settings SET nudge_time='19:30',active=1,proactive=1,last_seen=0,quiet_until=0").run();const clock=Date.parse('2026-10-17T19:30:00+03:00');await call('/test/nudge',{now:clock});await call('/test/nudge',{now:clock+60000});assert.equal((await db.prepare("SELECT count(*) AS n FROM outbox WHERE id='nudge:2026-10-17'").first()).n,1);await db.prepare('UPDATE settings SET proactive=0').run();await call('/test/nudge',{now:clock+7*86400000});assert.equal((await db.prepare("SELECT count(*) AS n FROM outbox WHERE id='nudge:2026-10-24'").first()).n,0);});


test('Telegram 429 pauses sending; uncertain delivery is quarantined, not repeated',async()=>{
 await db.prepare('DELETE FROM outbox').run();await db.prepare('DELETE FROM locks').run();
 const time=Date.now();await db.prepare('INSERT INTO outbox(id,payload,due,created_at) VALUES(?,?,?,?)').bind('rate',JSON.stringify({text:'local delivery test'}),time,time).run();
 tgError=429;await call('/test/send',{});assert.equal((await db.prepare("SELECT state FROM outbox WHERE id='rate'").first()).state,'pending');assert.ok((await db.prepare('SELECT telegram_pause FROM settings WHERE id=1').first()).telegram_pause>time);
 const count=sends.length;await call('/test/send',{});assert.equal(sends.length,count);
 await db.prepare('UPDATE settings SET telegram_pause=0').run();await db.prepare("UPDATE outbox SET due=0 WHERE id='rate'").run();tgError='uncertain';await call('/test/send',{});assert.equal((await db.prepare("SELECT state FROM outbox WHERE id='rate'").first()).state,'uncertain');await call('/test/send',{});assert.equal(sends.length,count);
});
test('403 stops proactive messages; expired draft and negative balances are rejected',async()=>{
 await db.prepare('DELETE FROM outbox').run();await db.prepare('UPDATE settings SET proactive=1').run();const time=Date.now();await db.prepare('INSERT INTO outbox(id,payload,due,created_at) VALUES(?,?,?,?)').bind('blocked',JSON.stringify({text:'local delivery test'}),time,time).run();tgError=403;await call('/test/send',{});const s=await db.prepare('SELECT active,proactive FROM settings WHERE id=1').first();assert.equal(s.active,0);assert.equal(s.proactive,1);assert.equal((await db.prepare("SELECT last_error FROM outbox WHERE id='blocked'").first()).last_error,'403');
 await proposal('expired',[action('income','pocket',1)]);await db.prepare("UPDATE drafts SET expires_at=0 WHERE id='expired'").run();assert.equal((await apply('expired')).applied,false);
 const before=await ws();await assert.rejects(()=>proposal('too-much',[action('expense','pocket',99999999)]));assert.deepEqual(await ws(),before);assert.equal(await db.prepare("SELECT id FROM drafts WHERE id='too-much'").first(),null);
});


test('two opening balances can be confirmed together without mixing currencies',async()=>{
 await proposal('open-azn',[action('opening','capital',150,'AZN'),action('opening','pocket',25,'AZN')]);assert.equal((await apply('open-azn')).applied,true);const w=await ws();assert.equal(w.find(x=>x.wallet==='capital'&&x.currency==='AZN').amount,15000);assert.equal(w.find(x=>x.wallet==='pocket'&&x.currency==='AZN').amount,2500);
});


test('explicit zero opening accepts model decimal format',async()=>{assert.equal(validate([action('opening','pocket','0.00')])[0].amount,0);assert.equal(validate([action('opening','pocket','0,00')])[0].amount,0);});

test('screenshot regression: natural balance and receipt never consult Groq or invent money',async()=>{
 const calls=groqCalls;
 modelResult={kind:'chat',reply:'Да, добавлено 136000 рублей в кошелёк capital',actions:[]};
 await text('сколько у меня щас денег?');assert.equal(groqCalls,calls);assert.match(sends.at(-1).text,/по записям/);assert.doesNotMatch(sends.at(-1).text,/136000/);
 await text('добавил?');assert.equal(groqCalls,calls);assert.doesNotMatch(sends.at(-1).text,/Да, добавлено/);
 await text('объясни свои слова');assert.doesNotMatch(sends.at(-1).text,/Да, добавлено|capital/);
 const poisoned=await db.prepare("SELECT content FROM memory WHERE role='assistant' AND content LIKE '%Да, добавлено%'").all();assert.equal(poisoned.results.length,0);
});
test('model balance intent is rendered from journal even when model supplies false prose',async()=>{
 modelResult={kind:'balance',reply:'У тебя миллиард рублей',actions:[]};await text('покажи мои накопления пожалуйста');assert.match(sends.at(-1).text,/по записям/);assert.doesNotMatch(sends.at(-1).text,/миллиард/);
});
test('unknown is not zero and untrusted empty-wallet claim is blocked',async()=>{
 modelResult={kind:'chat',reply:'Остальные кошельки пусты',actions:[]};await text('как там остальные');assert.doesNotMatch(sends.at(-1).text,/Остальные кошельки пусты/);
});

async function voiceMessage(id=seq++,uid=1001,extra={}){await mf.dispatchFetch('https://test/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-webhook'},body:JSON.stringify({update_id:id,message:{from:{id:uid},chat:{id:uid,type:'private'},voice:{file_id:'test_voice_id',duration:8,file_size:5,...extra}}})});await call('/test/drain',{now:Date.now()});if(uid===1001)for(let i=0;i<100;i++){const r=await db.prepare('SELECT state FROM outbox WHERE id=?').bind(String(id)).first();if(r?.state==='sent')break;await new Promise(r=>setTimeout(r,20));}return id;}
test('voice rejects oversized, long, unsafe IDs and uncertain speech',()=>{
 assert.equal(voiceAllowed({file_id:'ok',duration:91}),false);assert.equal(voiceAllowed({file_id:'../evil',duration:1}),false);assert.equal(voiceAllowed({file_id:'ok',duration:1,file_size:3e6}),false);
 assert.throws(()=>recognized({text:'выдумка',segments:[]}));assert.throws(()=>recognized({text:'сто рублей',segments:[{no_speech_prob:0.8,avg_logprob:-0.1}]}));assert.throws(()=>recognized({text:'сто рублей',segments:[{no_speech_prob:0.1,avg_logprob:-1.2}]}));
});
test('voice preview changes no balance; duplicate update transcribes once and nonowner cannot transcribe',async()=>{
 const before=await ws(),calls=asrCalls;const id=await voiceMessage();assert.equal(asrCalls,calls+1);assert.match(sends.at(-1).text,/Я услышал/);assert.deepEqual(await ws(),before);
 await voiceMessage(id);await voiceMessage(seq++,1002);assert.equal(asrCalls,calls+1);assert.equal((await db.prepare('SELECT state FROM voice_inputs WHERE id=?').bind(String(id)).first()).state,'ready');
 await callback('discard:'+id);assert.deepEqual(await ws(),before);await callback('hear:'+id);assert.deepEqual(await ws(),before);
});
test('voice recognition acceptance enqueues durable interpretation; money needs separate confirmation',async()=>{
 modelResult={kind:'proposal',reply:'',actions:[action('income','pocket',300)]};asrText='Я получил триста рублей в карманные';const before=await ws();const id=await voiceMessage();const callbackId=seq;await callback('hear:'+id);assert.deepEqual(await ws(),before);
 const draftId=String(-callbackId);assert.equal((await db.prepare('SELECT state FROM drafts WHERE id=?').bind(draftId).first()).state,'ready');await callback('yes:'+draftId);const after=await ws();assert.equal(after.find(x=>x.wallet==='pocket'&&x.currency==='RUB').amount,before.find(x=>x.wallet==='pocket'&&x.currency==='RUB').amount+30000);
 await callback('hear:'+id);await callback('yes:'+draftId);assert.deepEqual(await ws(),after);
});
test('voice 429, silence, unsafe download and size failures never produce draft',async()=>{
 const before=await ws();asrError=429;await voiceMessage();assert.match(sends.at(-1).text,/лимит/);asrError=0;
 asrSilence=true;await voiceMessage();assert.match(sends.at(-1).text,/уверенно/);asrSilence=false;
 const calls=asrCalls;filePath='https://attacker.invalid/a';await voiceMessage();assert.equal(asrCalls,calls);filePath='voice/file_1.oga';await voiceMessage(seq++,1001,{duration:300});assert.equal(asrCalls,calls);assert.deepEqual(await ws(),before);
});

test('narrated amounts never trigger balance or receipt shortcuts',()=>{for(const t of ['Смотри, 320 рублей заплатил за обед. Сейчас у меня на балансе карманных 4260 рублей.','На балансе 4260 рублей','Записал расход 320 рублей','получил полторы'])assert.equal(financialIntent(t),null);assert.equal(financialIntent('покажи баланс'),'balance');assert.equal(financialIntent('добавил?'),'status');});

test('ordinary financial conversation and clarification are not mistaken for fabricated facts',async()=>{
 for(const reply of ['Брат, цель Сабунчи помню. Как прошёл день?','В какой кошелёк записать расход?','Сабр, брат. Деньги считаем спокойно.','Я здесь, брат. Обсудим твой план?'])assert.equal(unsafeReply(reply),false);
 for(const reply of ['Да, записал','Остальные кошельки пусты','Денег нет'])assert.equal(unsafeReply(reply),true);
 const before=(await db.prepare('SELECT count(*) n FROM transactions').first()).n;
 modelResult={kind:'chat',reply:'Я здесь, брат. Можем обсудить деньги, Сабунчи или просто поговорить.',actions:[]};await text('что с тобой');assert.match(sends.at(-1).text,/Я здесь/);assert.doesNotMatch(sends.at(-1).text,/уточни: это/);
 await text('пока что брат также. напомни че у меня там');assert.match(sends.at(-1).text,/цель.*дом.*Сабунчи/);assert.doesNotMatch(sends.at(-1).text,/уточни: это/);
 assert.equal((await db.prepare('SELECT count(*) n FROM transactions').first()).n,before);
});

 test('completed opening cannot be replayed by acknowledgments, even with hostile model proposals',async()=>{
 const r=seq;await text('/остаток капитал RUB 136000');await callback('yes:'+r);
 const before=await ws(),n=(await db.prepare('SELECT count(*) n FROM transactions').first()).n;
 modelResult={kind:'proposal',reply:'',actions:[action('opening','capital',136000)]};
 for(const phrase of ['четко','да вме правильно друг','ДА И ВЧЕ ХВАТИТ ЗАДАВАТЬ ВОПРОСЫ','спасибо','ага','да','ок']){
  const id=seq;await text(phrase);assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first(),null);assert.doesNotMatch(sends.at(-1).text,/Всё верно/);
 }
 await text('/остаток капитал RUB 136000');assert.match(sends.at(-1).text,/уже сохранён/);
 await callback('yes:'+r);assert.deepEqual(await ws(),before);assert.equal((await db.prepare('SELECT count(*) n FROM transactions').first()).n,n);
 });

test('recent clarification can complete an amountless answer; expired clarification cannot',async()=>{
 await db.prepare('DELETE FROM memory').run();
 await text('потратил 30 рублей, остаток 900 рублей');
 modelResult={kind:'proposal',reply:'',actions:[action('opening','pocket',900)]};
 const id=seq;await text('уже после покупки, карманные');assert.ok(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first());await callback('no:'+id);
 await db.prepare('DELETE FROM memory').run();await db.prepare('INSERT INTO memory VALUES(?,?,?,?)').bind('old:clarify','assistant','До или после?',Date.now()-16*60000).run();
 const old=seq;await text('после покупки');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(old)).first(),null);
});
test('cancelled proposal and restart do not restore financial intent',async()=>{
 const id=seq;await text('/доход карманные RUB 70');await callback('no:'+id);const before=await ws();
 await mf.dispose();mf=create();db=await mf.getD1Database('DB');
 modelResult={kind:'proposal',reply:'',actions:[action('income','pocket',70)]};const ack=seq;await text('понял брат');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(ack)).first(),null);assert.deepEqual(await ws(),before);
});
test('two explicitly requested equal incomes remain separate legitimate operations',async()=>{
 const before=(await ws()).find(x=>x.wallet==='pocket'&&x.currency==='RUB').amount;
 for(let i=0;i<2;i++){const id=seq;await text('/доход карманные RUB 70');await callback('yes:'+id);}
 assert.equal((await ws()).find(x=>x.wallet==='pocket'&&x.currency==='RUB').amount,before+14000);
});
test('unchanged confirmed zero is not another opening, but unknown zero is initialized',async()=>{
 const id=seq;await text('/остаток карманные AZN 0');await callback('yes:'+id);const count=(await db.prepare('SELECT count(*) n FROM transactions').first()).n;
 const again=seq;await text('/остаток карманные AZN 0');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(again)).first(),null);assert.equal((await db.prepare('SELECT count(*) n FROM transactions').first()).n,count);
});

 test('correction cannot be income even when model calls the wrong tool',async()=>{
 const before=await ws();modelResult={tool:'propose_transaction',args:{actions:[action('income','capital',3000)]}};
 const id=seq;await text('У нас сейчас 127 тысяч в Сабунчи, лишние 3к написал');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first(),null);assert.deepEqual(await ws(),before);assert.match(sends.at(-1).text,/исправлен/);
 });
 test('set_balance verifies target, supersedes old draft and shows before to after',async()=>{
 const old=seq;await text('/доход капитал RUB 5600');
 modelResult={tool:'set_balance',args:{wallet:'capital',currency:'RUB',amount:'127000',note:'Исправление'}};
 const id=seq;await text('Нет, Сабунчи сейчас 127 тысяч, лишнее записал');const d=await db.prepare('SELECT * FROM drafts WHERE id=?').bind(String(id)).first();assert.ok(d);assert.equal(JSON.parse(d.payload).actions[0].amount,12700000);assert.match(sends.at(-1).text,/→/);assert.match(sends.at(-1).text,/не новый доход/);assert.doesNotMatch(sends.at(-1).text,/снятие капитала/);
 assert.equal((await db.prepare('SELECT state FROM drafts WHERE id=?').bind(String(old)).first()).state,'cancelled');await callback('yes:'+id);assert.equal((await ws()).find(w=>w.wallet==='capital'&&w.currency==='RUB').amount,12700000);
 modelResult.args.amount='130000';const mismatch=seq;await text('Правильно 127 тысяч');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(mismatch)).first(),null);
 });
 test('tool loop reads authoritative ledger then responds; receipts remain in context',async()=>{
 modelQueue=[{tool:'read_ledger',args:{}},{kind:'chat',reply:'Брат, по журналу в Сабунчи 127000 рублей.',actions:[]}];await text('объясни что получилось');assert.match(sends.at(-1).text,/127000/);const messages=requests.at(-1).messages;assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('wallets')));assert.ok(messages.some(m=>m.role==='assistant'&&m.content.includes('✅ Записал')));
 });
 test('cancel tool cancels draft only; undo tool creates auditable proposal without applying',async()=>{
 const p=seq;await text('/доход капитал RUB 250');const before=await ws();modelResult={tool:'cancel_proposal',args:{}};await text('стоп не записывай');assert.equal((await db.prepare('SELECT state FROM drafts WHERE id=?').bind(String(p)).first()).state,'cancelled');assert.deepEqual(await ws(),before);
 modelResult={tool:'undo_transaction',args:{}};const id=seq;await text('отмени последнюю ошибочную запись');assert.ok(JSON.parse((await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(id)).first()).payload).reversal_of);assert.deepEqual(await ws(),before);await callback('no:'+id);
 });
 test('memory search and explicit preference survive later turns without financial authority',async()=>{
 modelResult={tool:'remember_note',args:{note:'Люблю короткие ответы'}};await text('запомни я люблю короткие ответы');assert.equal((await db.prepare('SELECT context FROM settings').first()).context,'Люблю короткие ответы');
 modelQueue=[{tool:'search_memory',args:{query:'короткие'}},{kind:'chat',reply:'Помню, брат: покороче.',actions:[]}];await text('что я просил про ответы');assert.ok(requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('короткие')));
 });
 test('unsupported tool and fabricated amount cannot change journal or issue a receipt',async()=>{
 const before=await ws();modelResult={tool:'delete_database',args:{}};await text('удали все');assert.match(sends.at(-1).text,/не смог проверить/);assert.deepEqual(await ws(),before);
 modelResult={kind:'chat',reply:'У тебя 9876543 рублей',actions:[]};await text('дай объяснение');assert.doesNotMatch(sends.at(-1).text,/9876543/);assert.deepEqual(await ws(),before);
 });

test('ordinary prose and one repaired tool-format error do not alter financial state',async()=>{
 const before=await ws();modelQueue=[{error:'tool_use_failed'},{plain:'Слышу тебя, брат. Отдохни немного после смены.'}];
 const calls=groqCalls;await text('Брат устал после смены, поддержи');assert.match(sends.at(-1).text,/Слышу тебя/);assert.equal(groqCalls,calls+2);assert.deepEqual(await ws(),before);
 modelResult={plain:'Да, записал 999999 рублей'};await text('скажи что получилось');assert.doesNotMatch(sends.at(-1).text,/Да, записал/);assert.deepEqual(await ws(),before);
});

test('income now and split remainder reach the proposal tool',async()=>{
 await db.prepare('DELETE FROM memory').run();
 for(const [phrase,actions] of [
  ['сейчас получил 5000 рублей в карманные',[action('income','pocket',5000)]],
  ['получил 4500 рублей, 3000 в дом, остаток себе',[action('income','pocket',4500),action('transfer','pocket',3000,'RUB','capital')]]]){
  modelResult={tool:'propose_transaction',args:{actions}};const id=seq;await text(phrase);
  const d=await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(id)).first();assert.ok(d);assert.match(sends.at(-1).text,/→/);await callback('no:'+id);
 }
});
test('punctuation after a thousand suffix preserves the target amount',async()=>{
 modelResult={tool:'set_balance',args:{wallet:'pocket',currency:'RUB',amount:'4500',note:'сверка'}};
 const id=seq;await text('В карманных сейчас 4.5к, исправь остаток.');
 const d=await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(id)).first();assert.equal(JSON.parse(d.payload).actions[0].amount,450000);await callback('no:'+id);
});
test('explicit after-purchase balance asks no redundant question and is not deducted twice',async()=>{
 const open=seq;await text('/остаток карманные RUB 5129');await callback('yes:'+open);
 modelResult={tool:'propose_transaction',args:{actions:[action('expense','pocket',350)]}};
 const calls=groqCalls,id=seq;await text('Заплатил 350 рублей за обед, осталось после покупки в карманных 4779 рублей');assert.equal(groqCalls,calls);
 assert.ok(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first());assert.doesNotMatch(sends.at(-1).text,/до неё|до или после/);
 await callback('yes:'+id);assert.equal((await ws()).find(w=>w.wallet==='pocket'&&w.currency==='RUB').amount,477900);
});
test('model sees major-unit preferences and current user amounts can be discussed',async()=>{
 await text('/цель 500000');await text('/план 25000');
 modelResult={plain:'Ты получил 4500 рублей. Как распределим?'};await text('Сегодня получил 4500 рублей');assert.match(sends.at(-1).text,/4500/);
 const s=requests.at(-1).messages.find(m=>m.content?.startsWith('CURRENT_STATE=')).content;
 assert.ok(s.includes('"goal":500000'));assert.ok(s.includes('"monthly":25000'));assert.ok(!s.includes('"goal":50000000'));
 modelResult={plain:'Твоя цель — 500000 рублей.'};await text('Какая сумма цели?');assert.match(sends.at(-1).text,/500000/);
});
test('notes append without loss, deduplicate and reject overflow without erasing history',async()=>{
 await db.prepare("UPDATE settings SET context='' WHERE id=1").run();
 await text('/память Люблю короткие ответы');await text('/память Работаю геодезистом');
 modelResult={tool:'remember_note',args:{note:'Не писать утром'}};await text('Запомни: не писать утром');
 const expected='Люблю короткие ответы\nРаботаю геодезистом\nНе писать утром';assert.equal((await db.prepare('SELECT context FROM settings').first()).context,expected);
 await text('/память Работаю геодезистом');assert.equal((await db.prepare('SELECT context FROM settings').first()).context,expected);
 await text('/память '+ 'я'.repeat(1000));const before=(await db.prepare('SELECT context FROM settings').first()).context;
 await text('/память '+'б'.repeat(1000));assert.equal((await db.prepare('SELECT context FROM settings').first()).context,before);assert.match(sends.at(-1).text,/не добавил/);
});
test('receipt negation is local and normal descriptions are not receipts',async()=>{
 assert.equal(unsafeReply('Записал, не переживай'),true);assert.equal(unsafeReply('Ты записал лишние 3000'),false);assert.equal(unsafeReply('Пока ничего не записал'),false);
 modelResult={plain:'Записал, не переживай'};await text('Скажи что случилось');assert.doesNotMatch(sends.at(-1).text,/Записал, не переживай/);
 assert.equal(financialIntent('ты записал мои слова неправильно'),null);modelResult={plain:'Ты хотел купить хлеб.'};const calls=groqCalls;await text('напомни что купить хлеб');assert.equal(groqCalls,calls+1);assert.match(sends.at(-1).text,/хлеб/);
});
test('cancel tool supplies a fresh snapshot and repeated tool calls stop',async()=>{
 const p=seq;await text('/доход капитал RUB 250');
 modelQueue=[{tool:'cancel_proposal',args:{}},{tool:'read_ledger',args:{}},{kind:'balance',reply:''}];await text('стоп а было сколько?');
 const toolResults=requests.at(-1).messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));assert.equal(toolResults[0].snapshot.pending,null);assert.equal(toolResults[0].snapshot.last_cancelled_proposal.id,String(p));
 modelQueue=[{tool:'read_ledger',args:{}},{tool:'read_ledger',args:{}}];const calls=groqCalls;await text('проверь записи для меня');assert.equal(groqCalls,calls+2);assert.match(sends.at(-1).text,/повторяюсь/);
});
test('proposal replay returns persisted card even if model changes its mind',async()=>{
 const first=await proposal('same-id',[action('income','pocket',100)]);const replay=await proposal('same-id',[action('income','pocket',900)]);assert.deepEqual(replay,first);
 const stored=JSON.parse((await db.prepare("SELECT payload FROM drafts WHERE id='same-id'").first()).payload);assert.deepEqual(replay,stored);
});
test('unrelated answer after clarification cannot reuse old amounts',async()=>{
 await db.prepare('DELETE FROM memory').run();modelResult={kind:'clarify',reply:'В какой кошелёк?',actions:[]};await text('получил 3000');
 modelResult={tool:'propose_transaction',args:{actions:[action('income','pocket',3000)]}};const id=seq;await text('брат устал после работы');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first(),null);
});
test('one drain consumes two queued texts without Cron, preserving order',async()=>{
 await db.prepare('DELETE FROM updates').run();await db.prepare('DELETE FROM outbox').run();await db.prepare('DELETE FROM locks').run();
 modelResult={plain:'Слышу тебя.'};const first=seq++,second=seq++;const clock=Date.now();
 for(const [id,t] of [[first,'/balance'],[second,'/history']])await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(id,JSON.stringify({update_id:id,message:{text:t}}),clock).run();
 await call('/test/drain',{now:clock});const rows=(await db.prepare('SELECT id,state FROM updates ORDER BY id').all()).results;assert.deepEqual(rows,[{id:first,state:'done'},{id:second,state:'done'}]);
 assert.equal((await db.prepare("SELECT count(*) n FROM outbox WHERE state='sent'").first()).n,2);
});

test('burst correction is interpreted once from a durably merged update',async()=>{
 await db.prepare('DELETE FROM updates').run();await db.prepare('DELETE FROM outbox').run();await db.prepare('DELETE FROM locks').run();
 const clock=Date.now(),first=seq++,second=seq++;modelResult={tool:'propose_transaction',args:{actions:[action('income','pocket',4000)]}};
 for(const [id,t] of [[first,'Сейчас получил 5000 рублей в карманные'],[second,'Ой, не 5000, а 4000 рублей']])await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(id,JSON.stringify({update_id:id,message:{text:t}}),clock).run();
 const calls=groqCalls;await call('/test/drain',{now:clock});assert.equal(groqCalls,calls+1);assert.ok(requests.at(-1).messages.at(-1).content.includes('\nОй'));
 assert.equal((await db.prepare('SELECT count(*) n FROM outbox').first()).n,1);
 const d=JSON.parse((await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(first)).first()).payload);assert.equal(d.actions[0].amount,400000);
 assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(second)).first(),null);
});
test('unexplained numeric proposal is rejected without a draft',async()=>{
 modelResult={tool:'propose_transaction',args:{actions:[action('income','pocket',9900)]}};
 const id=seq;await text('получил 5000 рублей в карманные');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first(),null);assert.match(sends.at(-1).text,/не совпала/);
});

test('correction arriving during inference replaces unsent proposal before rendering',async()=>{
 await db.prepare('DELETE FROM updates').run();await db.prepare('DELETE FROM outbox').run();await db.prepare('DELETE FROM locks').run();
 const first=seq++,second=seq++,clock=Date.now();modelResult={tool:'propose_transaction',args:{actions:[action('income','pocket',5000)]}};
 await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(first,JSON.stringify({update_id:first,message:{text:'получил 5000 рублей в карманные'}}),clock).run();
 duringModel=async()=>{await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(second,JSON.stringify({update_id:second,message:{text:'ой не 5000, а 4000 рублей'}}),Date.now()).run();modelResult={tool:'propose_transaction',args:{actions:[action('income','pocket',4000)]}};};
 const calls=groqCalls;await call('/test/drain',{now:clock});assert.equal(groqCalls,calls+2);
 const d=JSON.parse((await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(first)).first()).payload);assert.equal(d.actions[0].amount,400000);assert.equal((await db.prepare('SELECT count(*) n FROM outbox').first()).n,1);
});
test('reversed order of balance and purchase cannot swap their amounts',async()=>{
 const open=seq;await text('/остаток карманные RUB 5129');await callback('yes:'+open);
 modelResult={kind:'clarify',reply:'Уточню покупку.',actions:[]};const id=seq;await text('Сейчас в карманных 4779, заплатил 350 рублей за обед');assert.equal(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(id)).first(),null);
});
