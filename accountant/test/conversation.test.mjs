import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {unsafeReply,statedAmounts} from '../src/brain.mjs';

// Entirely synthetic conversations, disposable SQLite and fake external APIs.
let mf,db,dir,seq=1,queue=[],requests=[],defaultReply='Слушаю тебя.',sent=[];
const action=n=>({type:'income',wallet:'pocket',currency:'RUB',amount:String(n),to:null,note:'Вымышленный подарок'});
const tool=(name,args={})=>({tool_calls:[{id:'fixture-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const say=content=>({content});
before(async()=>{
 dir=await mkdtemp(path.join(tmpdir(),'brat-conversation-'));
 await build({entryPoints:['test/entry.mjs'],outfile:path.join(dir,'bundle.mjs'),bundle:true,format:'esm',platform:'browser'});
 mf=new Miniflare({modules:true,scriptPath:path.join(dir,'bundle.mjs'),modulesRoot:dir,compatibilityDate:'2026-07-01',d1Databases:['DB'],bindings:{GROQ_API_KEY:'fixture',TELEGRAM_BOT_TOKEN:'fixture',OWNER_CHAT_ID:'1001'},outboundService:async req=>{
  const host=new URL(req.url).hostname;
  if(host==='api.groq.com'){
   const body=await req.json();requests.push(body);assert.equal(body.tool_choice,'auto');
   const next=queue.shift()??say(defaultReply);
   if(next.http)return Response.json({error:{code:'fixture_rate'}},{status:next.http});
   return Response.json({choices:[{message:{role:'assistant',...next}}]});
  }
  if(host==='api.telegram.org'){sent.push(await req.json());return Response.json({ok:true,result:{message_id:sent.length}});}
  throw Error('Unexpected external request');
 }});
 db=await mf.getD1Database('DB');await db.exec((await readFile('migrations/0001.sql','utf8')).replace(/\n/g,' '));
});
beforeEach(async()=>{
 queue=[];requests=[];sent=[];defaultReply='Слушаю тебя.';
 await db.exec("DELETE FROM updates; DELETE FROM outbox; DELETE FROM locks; DELETE FROM memory; DELETE FROM drafts; DELETE FROM entries; DELETE FROM transactions; DELETE FROM budgets; UPDATE settings SET revision=0,claim=NULL,context='',goal=NULL,monthly=NULL,telegram_pause=0; UPDATE wallets SET amount=0,initialized=1;");
});
after(async()=>{await mf?.dispose();if(dir)await rm(dir,{recursive:true,force:true});});
async function turn(text,callback){
 const id=seq++,now=Date.now();
 await db.prepare('INSERT INTO updates(id,payload,created_at) VALUES(?,?,?)').bind(id,JSON.stringify({update_id:id,...(callback?{callback_query:{data:callback}}:{message:{text}})}),now).run();
 const r=await mf.dispatchFetch('https://fixture/test/drain',{method:'POST',body:JSON.stringify({now})});
 assert.equal(r.status,200);assert.ok((await r.json()).requests<=48);
 const row=await db.prepare('SELECT payload FROM outbox WHERE id=?').bind(String(id)).first();assert.ok(row,'durable reply missing');
 return {id,text:JSON.parse(row.payload).text,payload:JSON.parse(row.payload)};
}
const count=async table=>(await db.prepare('SELECT count(*) n FROM '+table).first()).n;
const wallet=async()=>(await db.prepare("SELECT amount FROM wallets WHERE wallet='pocket' AND currency='RUB'").first()).amount;
const noMoney=async()=>{assert.equal(await count('drafts'),0);assert.equal(await count('transactions'),0);assert.equal(await wallet(),0);};

test('gift story and recall keep conversational amounts without accounting fallback',async()=>{
 queue=[say('С днём рождения! Пусть новый год жизни будет хорошим.'),say('Понял, просто делишься.'),say('Ты говорил: подарили 6200 рублей. В учёт не вносили.')];
 await turn('Подарили 6200 рублей на день рождения, никуда не добавляй.');
 await turn('Нет, я просто поделился новостью.');
 const r=await turn('Сколько подарили, помнишь?');
 assert.equal(r.text,'Ты говорил: подарили 6200 рублей. В учёт не вносили.');
 assert.equal(requests.length,3);assert.ok(requests.at(-1).messages.some(m=>m.role==='user'&&m.content.includes('6200')));
 await noMoney();
});
test('respond tool can recall a conversational amount absent from every wallet',async()=>{
 queue=[say('Понял тебя.'),tool('respond',{kind:'chat',text:'Ты говорил про подарок: 6200 рублей.'})];
 await turn('6200 рублей подарили, не записывай.');
 assert.equal((await turn('Помнишь сумму подарка?')).text,'Ты говорил про подарок: 6200 рублей.');await noMoney();
});
test('no-record instruction blocks every money tool, including a wrong model decision',async()=>{
 for(const name of ['propose_transaction','set_balance','undo_transaction']){
  queue=[tool(name,name==='propose_transaction'?{actions:[action(6200)]}:{wallet:'pocket',currency:'RUB',amount:'6200',note:'fixture'}),say('Понял, просто обсуждаем подарок.')];
  const r=await turn('Подарили 6200 рублей. Никуда не добавляй.');
  assert.equal(r.text,'Понял, просто обсуждаем подарок.');
  assert.ok(requests.at(-1).messages.some(m=>m.role==='tool'&&JSON.parse(m.content).ledger_changed===false));
  await noMoney();
 }
});
test('no-record also bypasses the deterministic purchase-and-balance shortcut',async()=>{
 await db.prepare("UPDATE wallets SET amount=400000 WHERE wallet='pocket' AND currency='RUB'").run();
 queue=[say('Понял, обсуждаем обед.')];
 const r=await turn('Заплатил 240 рублей за обед, сейчас в карманных 3760 рублей. Не записывай.');
 assert.equal(r.text,'Понял, обсуждаем обед.');assert.equal(requests.length,1);
 assert.equal(await count('drafts'),0);assert.equal(await wallet(),400000);
});
test('an explicit no-record instruction also wins over a local accounting command',async()=>{
 queue=[say('Хорошо, сейчас не учитываем.')];
 assert.equal((await turn('/доход карманные RUB 730 не записывай пока')).text,'Хорошо, сейчас не учитываем.');await noMoney();
});
test('recall question with a number does not authorize a proposal',async()=>{
 queue=[tool('propose_transaction',{actions:[action(6200)]}),say('Ты спрашиваешь о подарке, а не просишь его записать.')];
 assert.equal((await turn('Помнишь, мне подарили 6200 рублей?')).text,'Ты спрашиваешь о подарке, а не просишь его записать.');await noMoney();
});
test('explicit later request may record one recent gift only after confirmation, once',async()=>{
 queue=[say('Понял, не учитываем.')];await turn('На праздник подарили 6200 рублей, пока не добавляй.');
 queue=[tool('propose_transaction',{actions:[action(6200)]})];
 const p=await turn('Теперь запиши этот подарок в карманные.');
 assert.match(p.text,/6\s?200/);assert.match(p.text,/Всё верно/);assert.equal(await wallet(),0);assert.equal(await count('transactions'),0);
 await turn('', 'yes:'+p.id);assert.equal(await wallet(),620000);assert.equal(await count('transactions'),1);
 await turn('', 'yes:'+p.id);assert.equal(await count('transactions'),1);
 queue=[tool('propose_transaction',{actions:[action(6200)]})];
 assert.match((await turn('Запиши этот подарок в карманные.')).text,/уже учтена/);
 assert.equal(await count('transactions'),1);assert.equal(await wallet(),620000);
});
test('ambiguous or stale conversation amounts cannot become new records',async()=>{
 for(const [id,n,at] of [['gift-a',6200,Date.now()],['gift-b',8400,Date.now()]])await db.prepare('INSERT INTO memory VALUES(?,?,?,?)').bind(id,'user',`Подарили ${n} рублей, не добавляй.`,at).run();
 queue=[tool('propose_transaction',{actions:[action(6200)]})];await turn('Запиши этот подарок в карманные.');await noMoney();
 await db.exec('DELETE FROM memory');await db.prepare('INSERT INTO memory VALUES(?,?,?,?)').bind('old','user','Подарили 6200 рублей, не добавляй.',Date.now()-16*60000).run();
 queue=[tool('propose_transaction',{actions:[action(6200)]})];await turn('Запиши этот подарок в карманные.');await noMoney();
});
test('a referenced gift cannot be duplicated inside one proposal or turned into a withdrawal',async()=>{
 queue=[say('Понял.')];await turn('Подарили 6200 рублей, не записывай.');
 for(const actions of [[action(6200),action(6200)],[{...action(6200),type:'expense'}]]){
  queue=[tool('propose_transaction',{actions})];await turn('Теперь запиши этот подарок в карманные.');await noMoney();
 }
});
test('an old expense story cannot be mistaken for a gift reference',async()=>{
 queue=[say('Понял.')];await turn('Потратил 240 рублей, пока не записывай.');
 queue=[tool('propose_transaction',{actions:[action(240)]})];await turn('Запиши тот подарок в карманные.');await noMoney();
});
test('computed totals keep currencies separate and unknown wallets stay unknown',async()=>{
 await db.exec("UPDATE wallets SET amount=130000 WHERE wallet='capital' AND currency='RUB'; UPDATE wallets SET amount=57000 WHERE wallet='pocket' AND currency='RUB'; UPDATE wallets SET amount=9100 WHERE wallet='capital' AND currency='AZN'; UPDATE wallets SET initialized=0 WHERE wallet='pocket' AND currency='AZN';");
 queue=[say('Всего по записям 1870 рублей. Остаток карманных в манатах пока неизвестен.')];
 assert.match((await turn('А всего сколько?')).text,/1870/);
 const state=JSON.parse(requests.at(-1).messages.find(m=>m.content?.startsWith('CURRENT_STATE=')).content.split('\n')[0].slice('CURRENT_STATE='.length));
 assert.deepEqual(state.totals,{RUB:1870,AZN:null});assert.equal(requests.length,1);
});
test('search result is conversational evidence and never an account balance',async()=>{
 await db.prepare('INSERT INTO memory VALUES(?,?,?,?)').bind('old-gift','user','На праздник подарили 6200 рублей, в учёт не добавляй.',Date.now()-86400000).run();
 queue=[tool('search_memory',{query:'подарили'}),say('Ты говорил, что подарили 6200 рублей.')];
 assert.equal((await turn('Что я рассказывал про подарок?')).text,'Ты говорил, что подарили 6200 рублей.');
 const result=JSON.parse(requests.at(-1).messages.find(m=>m.role==='tool').content);
 assert.equal(result.source,'conversation_only_not_ledger');assert.ok(result.messages.length);await noMoney();
});
test('small talk, support, humour, plans and thanks preserve the model reply',async()=>{
 for(const [phrase,answer] of [['салам','Салам, брат!'],['как ты?','Я на связи. Ты как?'],['мяу гав','Сегодня на двух языках общаемся?'],['устал после смены','Понимаю. Дай себе немного отдыха.'],['спасибо','Обращайся.'],['хочу куртку за 8300 рублей','Из карманных думаешь брать?'],['план накоплений на 3 месяца','Можно разделить цель на 3 этапа и уточнить доход.']]){
  queue=[say(answer)];assert.equal((await turn(phrase)).text,answer);await noMoney();
 }
});
test('receipt hallucination gets one repair, not a canned balance question',async()=>{
 queue=[say('Записал, не переживай.'),say('Понял, ты просто рассказываешь о подарке.')];
 const r=await turn('Дали 6200 рублей, не добавляй.');assert.equal(r.text,'Понял, ты просто рассказываешь о подарке.');assert.equal(requests.length,2);await noMoney();
});
test('unsupported current balance is repaired while an attributed past amount is allowed',async()=>{
 queue=[say('У тебя сейчас 8800 рублей.'),tool('respond',{kind:'balance',text:''})];
 assert.doesNotMatch((await turn('Объясни мои накопления')).text,/8800/);assert.equal(requests.length,2);await noMoney();
});
test('ordinary requested income still produces a single confirmable proposal',async()=>{
 queue=[tool('propose_transaction',{actions:[action(730)]})];const p=await turn('Получил 730 рублей, запиши в карманные.');
 assert.match(p.text,/730/);assert.equal(await wallet(),0);await turn('', 'yes:'+p.id);assert.equal(await wallet(),73000);assert.equal(await count('transactions'),1);
});
test('model limit on small talk returns a short availability answer without financial instructions',async()=>{
 queue=[{http:429}];const r=await turn('Как дела?');assert.match(r.text,/ограничил/);assert.doesNotMatch(r.text,/остаток|журнал|\/help|капитал|баланс/iu);assert.equal(requests.length,1);await noMoney();
});

async function commitFixture(actions,text){
 queue=[tool('propose_transaction',{actions})];const p=await turn(text);await turn('', 'yes:'+p.id);return p;
}
function currentState(){
 return JSON.parse(requests.at(-1).messages.find(m=>m.content?.startsWith('CURRENT_STATE=')).content.split('\n')[0].slice('CURRENT_STATE='.length));
}
test('acknowledgment after confirmation stays conversational and exposes the completed action',async()=>{
 await commitFixture([action(730)],'Получил 730 рублей, запиши в карманные.');
 const calls=requests.length;queue=[say('Отлично, брат. На связи!')];const r=await turn('Чётко');
 assert.equal(r.text,'Отлично, брат. На связи!');assert.equal(requests.length,calls+1);
 assert.equal(await count('transactions'),1);assert.equal(await count('drafts'),1);
 assert.equal(currentState().last_committed_operation.actions[0].amount,730);
});
test('last addition question reads the committed event and allows attributed past-tense prose',async()=>{
 assert.equal(unsafeReply('Ты в прошлый раз добавил 730 рублей.'),false);
 assert.equal(unsafeReply('Я в прошлый раз добавил 730 рублей.'),true);
 assert.equal(unsafeReply('Ты говорил, я уже записал. Не переживай.'),true);
 await commitFixture([action(730)],'Получил 730 рублей, запиши в карманные.');
 const calls=requests.length;queue=[tool('read_ledger'),say('Ты в прошлый раз добавил 730 рублей в карманные.')];
 const r=await turn('Сколько денег было в последнем пополнении?');
 assert.equal(r.text,'Ты в прошлый раз добавил 730 рублей в карманные.');assert.equal(requests.length,calls+2);
 const state=JSON.parse(requests.at(-1).messages.find(m=>m.role==='tool').content);
 assert.equal(state.last_committed_operation.actions[0].type,'income');
 assert.equal(state.last_committed_operation.actions[0].amount,730);
 assert.equal(await wallet(),73000);assert.equal(await count('transactions'),1);assert.equal(await count('drafts'),1);
});
test('split operation keeps original income distinct from net wallet deltas',async()=>{
 await commitFixture([action(730),{...action(300),type:'transfer',to:'capital'}],'Получил 730 рублей, 300 в дом, остальное себе.');
 queue=[say('Доход был 730 рублей, из него 300 ушли в Сабунчи.')];await turn('Что было в последней операции?');
 const last=currentState().last_committed_operation;
 assert.deepEqual(last.actions.map(a=>[a.type,a.amount]),[['income',730],['transfer',300]]);
 assert.deepEqual(last.entries.map(e=>[e.wallet,e.delta]),[['pocket',430],['capital',300]]);
 assert.equal(await count('transactions'),1);assert.equal(await count('drafts'),1);
});
test('balance correction is exposed as correction, never inferred as an income',async()=>{
 const p=await turn('/остаток капитал RUB 24100');await turn('', 'yes:'+p.id);
 queue=[say('Последняя запись — сверка остатка, а не новый доход.')];await turn('Что было в последней записи?');
 const last=currentState().last_committed_operation;
 assert.equal(last.kind,'opening');assert.equal(last.actions[0].type,'opening');assert.equal(last.actions[0].amount,24100);
 assert.equal(last.before.find(w=>w.wallet==='capital'&&w.currency==='RUB').amount,0);
 assert.equal(await count('transactions'),1);
});
test('expired proposal history does not fabricate original actions from net entries',async()=>{
 await commitFixture([action(730)],'Получил 730 рублей, запиши в карманные.');await db.exec('DELETE FROM drafts');
 queue=[say('В журнале сохранился доход 730 рублей.')];await turn('Что сохранилось о последней записи?');
 const last=currentState().last_committed_operation;
 assert.equal(last.actions,null);assert.equal(last.before,null);assert.equal(last.entries[0].delta,730);
 assert.equal(await count('transactions'),1);
});
test('a question naming an earlier amount cannot turn into a new proposal',async()=>{
 await commitFixture([action(730)],'Получил 730 рублей, запиши в карманные.');
 queue=[tool('propose_transaction',{actions:[action(730)]}),say('Ты спрашиваешь о прежнем доходе 730 рублей.')];
 const r=await turn('В последнем пополнении сколько было, 730 рублей?');
 assert.equal(r.text,'Ты спрашиваешь о прежнем доходе 730 рублей.');
 assert.equal(await count('transactions'),1);assert.equal(await count('drafts'),1);assert.equal(await wallet(),73000);
});

test('opinion requests reject every money tool and keep the actual conversational answer',async()=>{
 for(const name of ['propose_transaction','set_balance','undo_transaction']){
  queue=[tool(name,name==='propose_transaction'?{actions:[action(18000),{...action(9000),type:'transfer',to:'capital'}]}:{wallet:'capital',currency:'RUB',amount:'9000',note:'fixture'}),say('Если оставшегося хватает на твои расходы, такой шаг приближает к дому.')];
  const r=await turn('На праздник подарили 18 тысяч, 9 уже отложил в дом, норм? Как думаешь?');
  assert.equal(r.text,'Если оставшегося хватает на твои расходы, такой шаг приближает к дому.');
  await noMoney();
 }
});
test('opinion and arbitrary planned purchases stay read-only without a product-name whitelist',async()=>{
 for(const phrase of ['Отложил 9к в Сабунчи, нормально?','Как думаешь, правильно ли я 9 тысяч в дом кинул?','Хочу куртку за 8300','Хочу велосипед за 9100','Планирую аренду за 9400']){
  queue=[tool('propose_transaction',{actions:[action(9000)]}),say('Давай обсудим, насколько это подходит твоим планам.')];
  assert.equal((await turn(phrase)).text,'Давай обсудим, насколько это подходит твоим планам.');await noMoney();
 }
});
test('an opinion question bypasses the deterministic expense-and-balance shortcut',async()=>{
 await db.prepare("UPDATE wallets SET amount=400000 WHERE wallet='pocket' AND currency='RUB'").run();
 queue=[say('Если это нужная покупка и на остальное хватит, всё разумно.')];
 const r=await turn('Заплатил 240 рублей за обед, сейчас в карманных 3760 рублей. Нормально?');
 assert.equal(r.text,'Если это нужная покупка и на остальное хватит, всё разумно.');
 assert.equal(requests.length,1);assert.equal(await count('drafts'),0);assert.equal(await wallet(),400000);
});
test('a direct recording request can accompany an opinion without losing the proposal',async()=>{
 queue=[tool('propose_transaction',{actions:[action(730)]})];
 const p=await turn('Получил 730 рублей, запиши в карманные. Как думаешь, хорошая смена?');
 assert.match(p.text,/Всё верно/);assert.equal(await count('drafts'),1);assert.equal(await count('transactions'),0);
});
test('event totals are not automatically interpreted as a balance correction',async()=>{
 for(const text of ['За смену вышло всего 3700, запиши в карманные.','Дали премию, всего 3700 руб, закинь в дом.','Сейчас получил 3700 рублей.']){
  queue=[tool('propose_transaction',{actions:[action(3700)]})];
  const p=await turn(text);assert.match(p.text,/Всё верно/);assert.ok(await db.prepare('SELECT id FROM drafts WHERE id=?').bind(String(p.id)).first());
 }
 assert.equal(await count('transactions'),0);
});
test('recording imperatives do not turn a stated final balance into new income',async()=>{
 for(const text of ['Запиши: сейчас в Сабунчи всего 27400 рублей.','Получил 3700, сейчас остаток 27400, исправь баланс.']){
  queue=[tool('propose_transaction',{actions:[action(27400)]})];
  assert.doesNotMatch((await turn(text)).text,/Всё верно/);await noMoney();
 }
});
test('owner-attributed explanations are accepted without accepting a new bot receipt',async()=>{
 const replies=['Ты подаренные 18 тысяч грамотно распределил и добавил часть в дом.','Половину подарка ты отложил, то есть пополнил копилку.'];
 for(const reply of replies){assert.equal(unsafeReply(reply),false);queue=[say(reply)];assert.equal((await turn('Как думаешь, разумно поступил?')).text,reply);}
 for(const reply of ['Ты молодец, записал за тебя.','Ты попросил, добавлено в журнал.','Ты устал, поэтому я уже записал.','Ты говорил, я уже записал. Не переживай.','Записал, не переживай.','Ты попросил. Записал.','Ты попросил — записал.','Ты попросил и добавлено в журнал.'])assert.equal(unsafeReply(reply),true,reply);
 await noMoney();
});
test('explicit gift amount keeps its source and cannot be booked a second time by reference',async()=>{
 queue=[say('Понял, просто делишься.')];const gift=await turn('На праздник подарили 6200 рублей, пока не записывай.');
 queue=[tool('propose_transaction',{actions:[action(6200)]})];const p=await turn('Теперь запиши эти 6200 рублей в карманные.');
 const draft=await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(p.id)).first();assert.ok(draft);
 assert.equal(JSON.parse(draft.payload).source_message_id,gift.id+':user');
 await turn('', 'yes:'+p.id);
 queue=[tool('propose_transaction',{actions:[action(6200)]})];assert.match((await turn('Запиши тот подарок в карманные.')).text,/уже учтена/);
 assert.equal(await count('transactions'),1);assert.equal(await wallet(),620000);
});
test('a repeated reference cannot silently change the source amount',async()=>{
 queue=[say('Понял.')];await turn('Подарили 6200 рублей, не записывай.');
 queue=[tool('propose_transaction',{actions:[action(6200)]})];await turn('Теперь запиши этот подарок 7100 рублей в карманные.');await noMoney();
});
test('a numbered gift reference still needs an unambiguous recent source',async()=>{
 for(const [id,n] of [['a',6200],['b',8400]])await db.prepare('INSERT INTO memory VALUES(?,?,?,?)').bind(id,'user',`Подарили ${n} рублей, не записывай.`,Date.now()).run();
 queue=[tool('propose_transaction',{actions:[action(6200)]})];await turn('Запиши этот подарок 6200 рублей в карманные.');await noMoney();
});
test('an ambiguous shorthand is not silently authorized in either scale',async()=>{
 assert.deepEqual(statedAmounts('18 тысяч, 9'),[1800000,900]);
 for(const n of [9,9000]){
  queue=[tool('propose_transaction',{actions:[action(18000),{...action(n),type:'transfer',to:'capital'}]})];
  const r=await turn('Запиши: получил 18 тысяч, 9 в дом, остальное себе.');
  assert.match(r.text,/9.*(?:руб|тысяч)/iu);await noMoney();
 }
});
test('explicit split amounts and explicit small ruble amounts remain valid',async()=>{
 for(const [phrase,n] of [['Запиши: получил 18 тысяч, 9 тысяч в дом, остальное себе.',9000],['Запиши: получил 18 тысяч, 9 рублей в дом, остальное себе.',9]]){
  queue=[tool('propose_transaction',{actions:[action(18000),{...action(n),type:'transfer',to:'capital'}]})];
  const r=await turn(phrase);assert.match(r.text,/Всё верно/);assert.equal(await count('transactions'),0);
 }
});
test('one direct answer resolves the scale once without reopening it after a topic change',async()=>{
 const actions=[action(18000),{...action(9000),type:'transfer',to:'capital'}];
 queue=[tool('propose_transaction',{actions})];await turn('Запиши: получил 18 тысяч, 9 в дом, остальное себе.');await noMoney();
 queue=[tool('propose_transaction',{actions})];const p=await turn('9 тысяч');
 assert.match(p.text,/Всё верно/);assert.equal(await count('drafts'),1);
 await turn('', 'no:'+p.id);
 queue=[tool('propose_transaction',{actions}),say('О какой сумме ты сейчас говоришь?')];
 assert.equal((await turn('тысяч')).text,'О какой сумме ты сейчас говоришь?');assert.equal(await count('drafts'),1);assert.equal(await count('transactions'),0);
});
test('a fresh income with a demonstrative is not attached to an earlier gift',async()=>{
 queue=[say('Понял.')];await turn('Подарили 6200 рублей, не записывай.');
 queue=[tool('propose_transaction',{actions:[action(730)]})];
 const p=await turn('Получил за смену 730 рублей, запиши эти 730 в карманные.');
 const d=JSON.parse((await db.prepare('SELECT payload FROM drafts WHERE id=?').bind(String(p.id)).first()).payload);
 assert.equal(d.source_message_id,undefined);assert.equal(d.actions[0].amount,73000);
});
