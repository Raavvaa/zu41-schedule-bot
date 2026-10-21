import {nudge} from './proactive.mjs';
export {nudge} from './proactive.mjs';
import {deliverReminders} from './tools.mjs';
import {facts,rememberFact,appendFact,summarize} from './memory.mjs';
import {dialogState,setDialog,answerQuestion,canConfirm,continuationAnswer} from './dialog.mjs';
import {bugReport} from './diagnostics.mjs';
import {q,one,all,run,amount,money,validate,propose,apply,balances,balanceText,draftText,walletName,requestEnv,requestRemaining,consumeRequest,amendProposal,receiptText} from './ledger.mjs';
import {brain,unsafeReply,statedAmounts} from './brain.mjs';
import {transcribe,voiceError} from './voice.mjs';
const json=(v,status=200)=>Response.json(v,{status});
const day=now=>new Date(now+10800000).toISOString().slice(0,10);
const menu={keyboard:[['💰 Баланс','✍️ Записать'],['🎯 Цель','📒 История'],['⚙️ Настройки','💬 Поговорим']],resize_keyboard:true};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const batchable=b=>typeof b.message?.text==='string'&&!b.callback_query&&!b.message.voice&&!b.voice_source&&!/^(?:\/|💰|✍️|🎯|📒|⚙️|💬)/u.test(b.message.text)&&!financialIntent(b.message.text);
async function equal(a,b){if(!a||!b)return false;const hash=x=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));const [aa,bb]=await Promise.all([hash(a),hash(b)]);let diff=0;new Uint8Array(aa).forEach((x,i)=>{diff|=x^new Uint8Array(bb)[i];});return diff===0;}
export function owner(env,b){const m=b.message??b.callback_query?.message,from=b.message?.from??b.callback_query?.from;const id=String(env.OWNER_CHAT_ID??'');return /^[1-9]\d*$/.test(id)&&Number.isSafeInteger(Number(id))&&m?.chat?.type==='private'&&String(m.chat.id)===id&&String(from?.id)===id;}
async function lock(env,name,now,ttl=55000){const token=crypto.randomUUID();const r=await run(env,'INSERT INTO locks VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE expires<=?',name,token,now+ttl,now);return r.meta.changes?token:null;}
async function unlock(env,name,token){await run(env,'DELETE FROM locks WHERE name=? AND token=?',name,token);}
async function tg(env,method,body){consumeRequest(env);try{const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const d=await r.json();return {ok:d.ok===true,id:d.result?.message_id,error:d.error_code??r.status,retry:Math.max(1,Number(d.parameters?.retry_after)||30)};}catch{return {ok:false,error:'uncertain'};}}
async function reply(env,id,text,now,markup=menu){await run(env,'INSERT OR IGNORE INTO outbox(id,payload,due,created_at) VALUES(?,?,?,?)',String(id),JSON.stringify({text:((env.VOICE_TEXT?'🎤 «'+env.VOICE_TEXT.slice(0,900)+'»\n\n':'')+String(text)).slice(0,3900),...(markup?{reply_markup:markup}:{}),link_preview_options:{is_disabled:true}}),now,now);}
async function memory(env,id,role,content,now){await run(env,'INSERT OR IGNORE INTO memory VALUES(?,?,?,?)',id,role,content.slice(0,2500),now);}
async function draft(env,id,actions,now,reversal=null,options={}){
 try{
  const p=options.target?await amendProposal(env,id,options.target,actions,now,options):await propose(env,id,actions,now,reversal,options);
  const record=await one(env,'SELECT state FROM drafts WHERE id=?',String(id));
  if(record.state==='applied'||p.auto&&await apply(env,id,now))return reply(env,id,receiptText(p),now,{inline_keyboard:[[{text:'↩️ Отменить',callback_data:'undo:'+id}]]});
  await setDialog(env,'proposal_ready',id,now,{pending:String(id)});const protectedCapital=p.entries.some(x=>x.wallet==='capital'&&x.delta<0)&&!p.actions?.every(a=>a.type==='opening');
  return reply(env,id,(protectedCapital?'⚠️ Брат, это уменьшит капитал Сабунчи. Если трата уже была, учтём честно.\n\n':'')+draftText(p),now,{inline_keyboard:[[{text:protectedCapital?'⚠️ Подтверждаю снятие капитала':'✅ Записать',callback_data:'yes:'+id}],[{text:'❌ Отмена',callback_data:'no:'+id}]]});
 }catch(e){if(e.message==='request_budget')throw e;return reply(env,id,e.message==='unchanged'?'Этот остаток уже сохранён, брат. Повторная запись не нужна.':e.message==='insufficient'?'Брат, по записям в кошельке не хватает денег. Если остаток неверный — напиши «/остаток карманные RUB 5000» с реальной суммой.':e.message==='uninitialized'?'Сначала подтвердим остатки, брат. Пример: /остаток карманные RUB 5000\nДля капитала: /остаток капитал RUB 100000\nЭто примеры формата, не запись денег.':'Не смог надёжно разобрать сумму и кошелёк. Напиши проще: /доход карманные RUB 3500 смена',now);}
}
function localAction(t){
 const m=t.match(/^\/(доход|расход|остаток|перевод)\s+(капитал|карманные)\s+(RUB|AZN)\s+(\d+(?:[.,]\d{1,2})?)(?:\s+(.*))?$/i);if(!m)return null;
 const wallet=m[2].toLowerCase()==='капитал'?'capital':'pocket',type={доход:'income',расход:'expense',остаток:'opening',перевод:'transfer'}[m[1].toLowerCase()];
 return [{type,wallet,currency:m[3].toUpperCase(),amount:m[4],...(type==='transfer'?{to:wallet==='pocket'?'capital':'pocket'}:{}),note:m[5]??''}];
}
const help='Пиши как говоришь: что получил, потратил или хочешь обсудить. Голосовое — до 90 секунд. Покажу распознанный текст; деньги из голоса запишу только после подтверждения.\n\nОбычные текстовые операции до настроенного порога записываю с кнопкой отмены. Исправления остатка и снятие капитала сначала показываю на проверку.\n\n/память — заметки; /память текст — добавить факт\n/забыть ключ — удалить факт\n/авто 0 — отключить автозапись\n/баг — диагностика для разбора ошибки\nБаланс и история всегда берутся из журнала. RUB и AZN считаются отдельно.';
export function financialIntent(text){
 const t=text.toLowerCase().replace(/ё/g,'е');
 // Amounts and narrated transactions must reach interpretation, not keyword shortcuts.
 if(/\d|(?:заплатил|потратил|получил|заработал|перевел|добавь|запиши|тысяч|сотен|полторы|тр[её]шк)/u.test(t))return null;
 if(/^(?:(?:брат|ты|а|ну)\s+)*(?:добавил|записал|зачислил|сохранил|списал|подтвердил|получилось)[\s?!,.]*$/u.test(t))return 'status';
 if(/(?:баланс|сколько.{0,35}(?:денег|денеж|бабок|бабла|остал|накоп|карман|сабунчи|капитал)|(?:денег|денеж|бабок).{0,20}сколько|(?:что|че).{0,20}(?:по деньгам|в кошельк)|скок.{0,20}(?:денег|бабла))/u.test(t))return 'balance';
 return null;
}
async function recordStatus(env,now){
 const d=await one(env,"SELECT id,state,expires_at FROM drafts ORDER BY created_at DESC,rowid DESC LIMIT 1");
 let status='Подтверждённых записей пока нет. Слова в переписке сами по себе деньги в журнал не добавляют.';
 if(d?.state==='ready'&&d.expires_at>now)status='Запись ещё не подтверждена. Нажми «✅ Записать» под предложением; до этого баланс не меняется.';
 else if(d?.state==='applied')status='Последнее предложение подтверждено и записано в журнал.';
 else if(d?.state==='cancelled')status='Последнее предложение отменено. Оно не меняло баланс.';
 else if(d)status='Предложение устарело. Его нельзя подтвердить; предложи запись заново.';
 else if(await one(env,'SELECT id FROM transactions LIMIT 1'))status='В журнале есть подтверждённые записи. Текущие остатки — ниже.';
 return status+'\n\n'+await balanceText(env);
}
async function handleTurn(env,b,now,deadline){
 const id=String(b.update_id),text=(b.message?.text??'').trim(),cb=b.callback_query?.data;
 if(b.voice_source)env={...env,VOICE_TEXT:text};
 await run(env,'UPDATE settings SET last_seen=?,active=1 WHERE id=1',now);
 if(cb){
  const voice=cb.match(/^(hear|discard):(-?\d+)$/);
  if(voice){
   if(b.callback_query.id)await tg(env,'answerCallbackQuery',{callback_query_id:b.callback_query.id});
   const row=await one(env,"SELECT * FROM voice_inputs WHERE id=? AND state='ready' AND expires>?",voice[2],now);
   if(!row){const previous=await one(env,'SELECT state FROM voice_inputs WHERE id=?',voice[2]);return reply(env,id,previous?.state==='accepted'?'Этот текст уже передан на разбор. Ответ — ниже в переписке. Повторно ничего не записываю.':'Расшифровка отменена или устарела. Пришли новое голосовое.',now);}
   const state=voice[1]==='discard'?'cancelled':'accepted';
   const operations=[q(env,"UPDATE voice_inputs SET state=?,chosen_update=? WHERE id=? AND state='ready'",state,id,voice[2])];
   if(state==='accepted')operations.push(q(env,"INSERT OR IGNORE INTO updates(id,payload,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM voice_inputs WHERE id=? AND state='accepted' AND chosen_update=?)",-Math.abs(Number(id)),JSON.stringify({update_id:-Math.abs(Number(id)),message:{text:row.text},voice_source:true}),now,voice[2],id));
   const chosen=await env.DB.batch(operations);
   if(!chosen[0].meta.changes)return reply(env,id,'Голосовое уже обработано.',now);
   if(state==='cancelled')return reply(env,id,'Отменил расшифровку. Можешь написать исправленный текст.',now);
   return;
  }
  if(b.callback_query.id)await tg(env,'answerCallbackQuery',{callback_query_id:b.callback_query.id});
  const undo=cb.match(/^undo:(-?\d+)$/);if(undo){
   const target=undo[1],undoId='revert:'+target;
   if(await one(env,'SELECT id FROM transactions WHERE reversal_of=?',target))return reply(env,id,'Эта операция уже отменена или исправлена. Повторной отмены нет.',now);
   const original=await one(env,'SELECT id FROM transactions WHERE id=?',target);if(!original)return reply(env,id,'Запись не найдена.',now);
   await propose(env,undoId,null,now,{id:target,entries:await all(env,'SELECT wallet,currency,delta FROM entries WHERE tx_id=?',target)});
   const done=await apply(env,undoId,now);return reply(env,id,done?'↩️ Отменил отдельной корректировкой. История сохранена.\n\n'+await balanceText(env):'Операция уже обработана или баланс изменился.',now);
  }
  const m=cb.match(/^(yes|no):(-?\d+)$/);if(m){
   if(m[1]==='no'){await run(env,"UPDATE drafts SET state='cancelled' WHERE id=? AND state='ready'",m[2]);await run(env,"UPDATE dialog_state SET mode='just_cancelled',last_cancelled_draft=?,pending_draft_id=NULL,question=NULL,updated_at=? WHERE id=1",m[2],now);return reply(env,id,'Не записываю, брат.',now);}
   const done=await apply(env,m[2],now);return reply(env,id,done?'✅ Записал.\n\n'+await balanceText(env):'Эта запись уже обработана, устарела или баланс изменился. Проверь «Баланс» и предложи запись заново.',now);
  }
  if(['support:on','support:off','religion:on','religion:off','quiet:today'].includes(cb)){
   if(cb.startsWith('support:'))await run(env,'UPDATE settings SET proactive=? WHERE id=1',cb.endsWith('on')?1:0);
   if(cb.startsWith('religion:'))await run(env,'UPDATE settings SET religion=? WHERE id=1',cb.endsWith('on')?1:0);
   if(cb==='quiet:today')await run(env,'UPDATE settings SET quiet_until=? WHERE id=1',Date.parse(day(now)+'T00:00:00+03:00')+86400000);
   return reply(env,id,'Принял, брат. Настройки сохранены.',now);
  }
  return reply(env,id,'Кнопка устарела. Открой /start.',now);
 }
 if(b.message?.voice){
  let prior=await one(env,'SELECT text,state,confident FROM voice_inputs WHERE id=?',id);
  if(prior&&['cancelled','rejected'].includes(prior.state))return reply(env,id,'Расшифровка отменена.',now);
  if(!prior){let heard;try{heard=await transcribe(env,b.message.voice,now,true);}catch(e){if(e.message==='request_budget')throw e;return reply(env,id,voiceError(e),now);}
   await run(env,"INSERT OR IGNORE INTO voice_inputs(id,text,expires,confident) VALUES(?,?,?,?)",id,heard.text,now+15*60000,heard.confident?1:0);prior={text:heard.text,state:'ready',confident:heard.confident};
  }
  if(prior.confident){
   const next={update_id:b.update_id,message:{text:prior.text},voice_source:true};
   await env.DB.batch([q(env,"UPDATE voice_inputs SET state='accepted',chosen_update=? WHERE id=?",id,id),q(env,"UPDATE updates SET payload=? WHERE id=?",JSON.stringify(next),b.update_id)]);return {resume:true};
  }
  return reply(env,id,'🎙 Я услышал:\n'+prior.text+'\n\nРаспознавание неуверенное. Проверь слова и суммы. Передать на разбор?',now,{inline_keyboard:[[{text:'✅ Разобрать',callback_data:'hear:'+id}],[{text:'❌ Не так / отмена',callback_data:'discard:'+id}]]});
 }
 const beforeTurn=await dialogState(env);
 const approved=!b.voice_source?await canConfirm(env,text,now,beforeTurn):null;
 if(approved){const p=JSON.parse((await one(env,'SELECT payload FROM drafts WHERE id=?',approved)).payload);const done=await apply(env,approved,now);return reply(env,id,done?receiptText(p):'Предложение уже обработано или изменилось. Проверь баланс.',now,done?{inline_keyboard:[[{text:'↩️ Отменить',callback_data:'undo:'+approved}]]}:menu);}
 if(beforeTurn.mode==='proposal_ready'||beforeTurn.mode==='awaiting_answer'&&!continuationAnswer(beforeTurn.question,text,now))await setDialog(env,'idle',id,now);
 const auto=text.match(/^\/авто\s+(\d+(?:[.,]\d{1,2})?)$/);
 if(auto){const limit=Number(auto[1])===0?0:amount(auto[1]);await run(env,'UPDATE settings SET auto_limit=? WHERE id=1',limit);return reply(env,id,limit?'Автозапись обычных рублёвых операций до '+money(limit)+'. Голос, исправления остатков и снятие капитала требуют подтверждения.':'Автозапись выключена. Буду показывать предложение.',now);}
 if(text==='/баг')return reply(env,id,await bugReport(env),now);
 if(text==='/start'||text==='/help')return reply(env,id,'С Бисмиллях, брат. Я твой личный бухгалтер: капитал Сабунчи отдельно, карманные отдельно.\n\n'+await balanceText(env)+'\n\n'+help,now);
 if(financialIntent(text)==='status')return reply(env,id,await recordStatus(env,now),now);
 if(text==='💰 Баланс'||text==='/balance'||financialIntent(text)==='balance')return reply(env,id,await balanceText(env),now);
 if(text==='✍️ Записать')return reply(env,id,'Напиши, что уже получил или потратил, сумму и кошелёк. Если только хочешь купить — скажи «хочу», я ничего не спишу.\n\n'+help,now);
 if(/напомни\s+(?:(?:че|чё|что)\s+у меня\s+там|(?:мою\s+)?цель|(?:мой\s+)?план)[\s?!,.]*$/iu.test(text))return reply(env,id,'Брат, твоя цель — накопить на дом в Сабунчи. Капитал и карманные учитываем отдельно. Текущие подтверждённые суммы:\n\n'+await balanceText(env),now);
 if(text==='🎯 Цель')return reply(env,id,await balanceText(env)+'\n\nЧтобы задать личную цель в рублях: /цель 500000\nПлан накоплений на месяц: /план 25000\nСрок и бюджет сделки обсудим отдельно, без выдуманного курса.',now);
 const goal=text.match(/^\/(цель|план)\s+(\d+(?:[.,]\d{1,2})?)$/);
 if(goal){try{const n=amount(goal[2]);await run(env,`UPDATE settings SET ${goal[1]==='цель'?'goal':'monthly'}=? WHERE id=1`,n);return reply(env,id,'Принял: '+(goal[1]==='цель'?'цель ':'план на месяц ')+money(n)+'. Кошельки не менял.',now);}catch{return reply(env,id,'Нужна положительная сумма в рублях, например /цель 500000.',now);}}
 if(text==='⚙️ Настройки'||text==='/settings'){
  const s=await one(env,'SELECT * FROM settings WHERE id=1');return reply(env,id,`Поддержка: ${s.proactive?'включена':'выключена'} — иногда в ${s.nudge_time} МСК, максимум раз в день, не раньше шести часов после разговора.\nАвтозапись: до ${money(s.auto_limit)}; /авто 0 — выключить. Голос и исправления — с подтверждением.\nРелигиозные напоминания: ${s.religion?'да':'нет'}.\nВремя: /время 19:00\nПауза: /тишина; вернуть: /общайся.`,now,{inline_keyboard:[[{text:s.proactive?'Не писать первым':'Пиши иногда',callback_data:s.proactive?'support:off':'support:on'}],[{text:s.religion?'Без религиозных напоминаний':'Добавить религиозные напоминания',callback_data:s.religion?'religion:off':'religion:on'}],[{text:'Пауза до завтра',callback_data:'quiet:today'}]]});
 }
 const time=text.match(/^\/время\s+((?:1[0-9]|20):[0-5][0-9])$/);if(time){await run(env,'UPDATE settings SET nudge_time=? WHERE id=1',time[1]);return reply(env,id,'Буду писать в '+time[1]+' МСК, если будет уместный повод.',now);}
 if(text==='/тишина'||text==='/общайся'){await run(env,'UPDATE settings SET proactive=? WHERE id=1',text==='/общайся'?1:0);return reply(env,id,text==='/тишина'?'Хорошо, первым не пишу.':'Хорошо, буду иногда выходить на связь.',now);}
 if(text.startsWith('/память ')){const saved=await appendFact(env,text.slice(8),now);return reply(env,id,saved?'Добавил заметку, прежние сохранил. Посмотреть: /память.':'Заметки заполнены. Старые сохранил, новую не добавил. Посмотреть: /память.',now);}
 if(text==='/память')return reply(env,id,(await facts(env)).map(f=>f.key+': '+f.value).join('\n')||'Постоянных заметок пока нет.',now);
 if(text.startsWith('/забыть ')){await rememberFact(env,'delete',text.slice(8).trim(),'',now);return reply(env,id,'Заметку удалил. Журнал сохранён.',now);}
 if(text==='/забыть'){await env.DB.batch([q(env,'DELETE FROM memory'),q(env,'DELETE FROM facts'),q(env,"UPDATE digest SET content='',last_rowid=0,attempt_day=NULL WHERE id=1"),q(env,"UPDATE settings SET context='' WHERE id=1")]);return reply(env,id,'Контекст разговоров и заметка очищены. Журнал денег сохранён.',now);}
 if(text==='📒 История'||text==='/history'){
  const rs=await all(env,'SELECT t.id,t.note,t.at,e.wallet,e.currency,e.delta FROM transactions t JOIN entries e ON e.tx_id=t.id ORDER BY t.at DESC,t.rowid DESC LIMIT 12');
  return reply(env,id,rs.length?rs.map(r=>`${day(r.at)} · ${walletName(r.wallet)} ${r.delta>=0?'+':'−'}${money(Math.abs(r.delta),r.currency)}${r.note?' · '+r.note:''}`).join('\n'):'Записей пока нет, брат.',now);
 }
 if(text==='/отмена'){
  const t=await one(env,'SELECT * FROM transactions t WHERE reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id) ORDER BY at DESC,rowid DESC LIMIT 1');
  if(!t)return reply(env,id,'Нет записи для отмены.',now);
  return draft(env,id,null,now,{id:t.id,entries:await all(env,'SELECT wallet,currency,delta FROM entries WHERE tx_id=?',t.id)});
 }
 const direct=localAction(text);if(direct)return draft(env,id,direct,now,null,{proven:true,voice:!!b.voice_source});
 if(text.startsWith('/'))return reply(env,id,help,now);
 if(!text)return reply(env,id,'Пришли текст или голосовое, брат.',now);
 if(text.length>2500)return reply(env,id,'Брат, сократи сообщение до 2500 символов — так надёжнее разберу.',now);
 const dialog=await dialogState(env),question=dialog.mode==='awaiting_answer'&&dialog.question?.expires_at>now?dialog.question:null;
 const answered=answerQuestion(question,text);
 const ask=async(type,payload,message)=>{await setDialog(env,'awaiting_answer',id,now,{question:{type,payload,expires_at:now+15*60000}});return reply(env,id,message,now);};
 const purchaseDraft=async(p,basis,choice=null)=>{
  const w=await one(env,"SELECT amount,initialized FROM wallets WHERE wallet='pocket' AND currency='RUB'");
  const after=basis==='before'?p.remaining-p.expense:p.remaining;
  if(after<0)return ask('financial_detail',{evidence:p.evidence},'После расхода получается отрицательная сумма. Какой остаток верный?');
  const expense={type:'expense',wallet:'pocket',currency:'RUB',amount:String(p.expense/100),note:'Покупка'};
  if(w.initialized&&w.amount-p.expense!==after&&!choice)return ask('purchase_discrepancy',{...p,basis},'Остаток расходится с журналом. Учесть только расход или сверить остаток? Ответь «расход» или «остаток».');
  if(!w.initialized||choice==='reconcile')return draft(env,id,[{type:'opening',wallet:'pocket',currency:'RUB',amount:String((after+p.expense)/100),note:'Сверка перед покупкой'},expense],now,null,{reconcile:true,evidence:p.evidence});
  return draft(env,id,[expense],now,null,{evidence:p.evidence});
 };
 if(answered){
  if(question.type==='purchase_basis')return purchaseDraft(question.payload,answered);
  if(question.type==='purchase_discrepancy')return purchaseDraft(question.payload,question.payload.basis,answered);
  if(answered==='cancel'){await run(env,"UPDATE drafts SET state='cancelled' WHERE state='ready'");await setDialog(env,'just_cancelled',id,now);return reply(env,id,'Предложение отменено. Журнал сохранён.',now);}
  if(answered==='balance')return ask('financial_detail',{},'Какой правильный остаток и в каком кошельке?');
  if(answered==='undo')return handleTurn(env,{update_id:b.update_id,message:{text:'/отмена'}},now,deadline);
 }
 if(/(?:удали|сотри|обнули)\s+вс[её]|заново\s+начн/iu.test(text))return ask('delete_scope',{},'Что исправить: 1 — отменить предложение, 2 — исправить остаток, 3 — отменить последнюю запись? История сохранится.');
 const purchase=/(?:заплатил|потратил|оплатил|купил|расход)/iu.test(text)&&/(?:баланс|остаток|осталось|сейчас)/iu.test(text)&&!/(?:AZN|манат|Сабунчи|капитал|не покупал|не платил|хочу|получил|заработал)/iu.test(text);
 if(purchase&&text.search(/заплатил|потратил|оплатил|купил|расход/iu)<text.search(/баланс|остаток|осталось|сейчас/iu)){
  const ns=statedAmounts(text);
  if(ns.length===2&&ns[0]>0){
   const payload={expense:ns[0],remaining:ns[1],evidence:text};
   const basis=text.match(/(до|после)\s+(?:этой\s+)?(?:покупки|оплаты|обеда|траты|расхода)/iu)?.[1];
   if(basis)return purchaseDraft(payload,basis.toLowerCase()==='до'?'before':'after');
   return ask('purchase_basis',payload,'Названный остаток — до или после покупки?');
  }
 }
 let result;
 try{result=await brain(env,text==='💬 Поговорим'?'Хочу поговорить. Спроси, как у меня дела.':text,now,deadline);}catch(e){
  if(e.message==='request_budget')throw e;
  const reason={brain_budget:'Сегодня исчерпан лимит обращений бота к модели.',brain_rate:'Groq временно ограничил частоту запросов.',brain_timeout:'Модель не успела ответить.',brain_config:'Нет доступа к модели.',brain_invalid:'Модель вернула ответ, который я не смог проверить.'}[e.message]??'Сервис модели сейчас недоступен.';
  return reply(env,id,reason+' Журнал сохранён. Можно открыть «Баланс» или «Историю». Для исправления остатка: /остаток капитал RUB сумма. /help — остальные команды.',now);
 }
 // A correction arriving while the model was thinking supersedes this unsent
 // inference. The durable update will be joined with the new text on the next turn.
 if(batchable(b)&&(b.regenerations??0)<2&&Date.now()+5000<(deadline??0)){
  const newer=await one(env,"SELECT payload,created_at FROM updates WHERE state='pending' AND id!=? AND created_at>=? ORDER BY created_at,id LIMIT 1",Number(id),now-4000);
  if(newer&&newer.created_at-(b.batch_started??now)<=8000&&batchable(JSON.parse(newer.payload))&&text.length+JSON.parse(newer.payload).message.text.length<2400)return {defer:true};
 }
 
 if(result.kind==='proposal'||result.kind==='amend')return draft(env,id,result.actions,now,null,{target:result.target,evidence:result.evidence,effective_at:result.effective_at,proven:!!result.evidence,voice:!!b.voice_source||result.voice});
 if(result.kind==='undo'){
  const t=await one(env,'SELECT * FROM transactions t WHERE reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id) ORDER BY at DESC,rowid DESC LIMIT 1');
  if(!t)return reply(env,id,'В журнале пока нет записи для отмены.',now);
  return draft(env,id,null,now,{id:t.id,entries:await all(env,'SELECT wallet,currency,delta FROM entries WHERE tx_id=?',t.id)});
 }
 if(result.kind==='remember'){
  let saved=false;try{saved=result.fact?await rememberFact(env,result.fact.op,result.fact.key,result.fact.value,now):await appendFact(env,result.reply,now);}catch{}
  return reply(env,id,saved?'Запомнил заметку: '+result.reply:'Заметки заполнены. Старые сохранил, новую не добавил. Посмотреть: /память.',now);
 }
 if(result.kind==='balance')return reply(env,id,await balanceText(env),now);
 if(result.kind==='status')return reply(env,id,await recordStatus(env,now),now);
 if(result.kind==='history')return handle(env,{update_id:b.update_id,message:{text:'/history'}},now);
 // Only the program may issue a receipt. Ordinary numeric explanations are allowed.
 if(unsafeReply(result.reply))return reply(env,id,'Я не менял журнал этим сообщением, брат. Могу посмотреть последние записи или подготовить исправление.',now);
 if(result.kind==='clarify')await setDialog(env,'awaiting_answer',id,now,{question:{type:'financial_detail',payload:{evidence:question?.payload?.evidence??text},expires_at:now+15*60000}});
 else await setDialog(env,'idle',id,now);
 return reply(env,id,result.reply,now);
}
async function handle(env,b,now,deadline){
 const id=String(b.update_id);
 // Persist the actual dialogue, including tool receipts and button outcomes.
 // No replayed model inference is treated as a ledger fact.
 // A persisted answer is the result of this update. Never infer another draft on replay.
 const persisted=await one(env,'SELECT (SELECT id FROM outbox WHERE id=?) AS answer,(SELECT id FROM drafts WHERE id=?) AS draft',id,id);
 if(!persisted.answer){
  if(persisted.draft)await draft(env,id,null,now);
  else{const result=await handleTurn(env,b,now,deadline);if(result?.defer||result?.resume)return result;}
 }
 const text=b.message?.text;
 if(text&&text!=='/забыть')await memory(env,id+':user','user',text,now);
 if(b.callback_query?.data?.match(/^(yes|no):/))await memory(env,id+':user','user',b.callback_query.data.startsWith('yes:')?'Нажата кнопка подтверждения предложения.':'Нажата кнопка отмены предложения.',now);
 const out=await one(env,'SELECT payload FROM outbox WHERE id=?',id);
 if(out&&text!=='/забыть')await memory(env,id+':assistant','assistant',JSON.parse(out.payload).text,now+1);
}
export async function sendPending(env,now=Date.now(),deadline=Date.now()+23000){
 if(requestRemaining(env)<9)return;
 if(Number((await one(env,'SELECT telegram_pause FROM settings WHERE id=1'))?.telegram_pause)>now)return;
 const token=await lock(env,'send',now,25000);if(!token)return;
 try{
  await run(env,"UPDATE outbox SET state='uncertain' WHERE state='sending' AND lease<=?",now);
  const rows=await all(env,"SELECT * FROM outbox WHERE state='pending' AND due<=? ORDER BY created_at,rowid LIMIT 2",now);
  for(let i=0;i<rows.length;i++){
   if(Date.now()+8200+(i?1100:0)>deadline||requestRemaining(env)<5)break;
   const m=rows[i],time=Date.now();if(time-m.created_at>3600000){await run(env,"UPDATE outbox SET state='expired' WHERE id=?",m.id);continue;}
   if(i)await sleep(1100);
   const claim=await run(env,"UPDATE outbox SET state='sending',lease=? WHERE id=? AND state='pending' AND due<=?",time+20000,m.id,time);if(!claim.meta.changes)continue;
   const r=await tg(env,'sendMessage',{chat_id:env.OWNER_CHAT_ID,...JSON.parse(m.payload)});
   if(r.ok)await run(env,"UPDATE outbox SET state='sent',message_id=? WHERE id=?",r.id,m.id);
   else if(r.error===429){await run(env,'UPDATE settings SET telegram_pause=? WHERE id=1',Date.now()+r.retry*1000);await run(env,"UPDATE outbox SET state='pending',due=? WHERE id=?",Date.now()+r.retry*1000,m.id);break;}
   else{await run(env,'UPDATE outbox SET state=?,last_error=? WHERE id=?',r.error==='uncertain'?'uncertain':'failed',String(r.error),m.id);if(r.error===403){await run(env,'UPDATE settings SET active=0 WHERE id=1');break;}}
  }
 }finally{await unlock(env,'send',token);}
}
export async function drain(env,now=Date.now(),limits=null){
 env=requestEnv(env);
 const started=Date.now(),deadline=limits?.deadline??started+28000,interpretUntil=limits?.interpretUntil??started+19000;
 let token;
 // A concurrent webhook waits for the current turn and takes over instead of
 // abandoning its update until the next Cron. Every waiter has its own budget.
 for(let attempt=0;attempt<4&&Date.now()<interpretUntil-1000;attempt++){token=await lock(env,'dialog',Date.now());if(token)break;await sleep(1000*2**attempt);}
 if(!token)return;
 try{
  for(let turn=0;turn<8&&Date.now()<interpretUntil-1000&&requestRemaining(env)>=16;turn++){
   const clock=now+Date.now()-started;
   const u=await one(env,"SELECT * FROM updates WHERE state='pending' OR state='processing' AND lease<=? ORDER BY created_at,id LIMIT 1",clock);
   if(!u)break;
   let body=JSON.parse(u.payload);body.batch_started=u.created_at;
   if(batchable(body)&&!await one(env,'SELECT id FROM outbox WHERE id=?',String(u.id))){
    const waiting=await all(env,"SELECT id,payload,created_at FROM updates WHERE state='pending' AND id!=? AND created_at>=? ORDER BY created_at,id LIMIT 4",u.id,u.created_at);
    const ids=[];for(const next of waiting){
     const candidate=JSON.parse(next.payload);
     if(next.created_at-u.created_at>8000||!batchable(candidate)||body.message.text.length+candidate.message.text.length>2400)break;
     body.message.text+='\n'+candidate.message.text;ids.push(next.id);
    }
    if(ids.length){body.coalesced_ids=[...(body.coalesced_ids??[]),...ids];await env.DB.batch([
     q(env,'UPDATE updates SET payload=? WHERE id=?',JSON.stringify(body),u.id),
     ...ids.map(id=>q(env,"UPDATE updates SET state='done',payload='{}' WHERE id=? AND state='pending'",id))
    ]);}
   }
   await run(env,"UPDATE updates SET state='processing',lease=? WHERE id=?",clock+55000,u.id);
   try{const result=await handle(env,body,clock,interpretUntil);
    if(result?.resume){await run(env,"UPDATE updates SET state='pending' WHERE id=?",u.id);continue;}
    if(result?.defer){body.regenerations=(body.regenerations??0)+1;await run(env,"UPDATE updates SET state='pending',payload=? WHERE id=?",JSON.stringify(body),u.id);continue;}
    await run(env,"UPDATE updates SET state='done',payload='{}' WHERE id=?",u.id);
   }
   catch(e){if(e.message==='request_budget'){env.REQUEST_BUDGET.reserve=0;await run(env,"UPDATE updates SET state='pending' WHERE id=?",u.id);break;}await reply(env,u.id,'Не удалось закончить запрос, брат. Проверь баланс перед повторной записью; подтверждённый журнал сохранён.',clock);await run(env,"UPDATE updates SET state='failed',payload='{}' WHERE id=?",u.id);}
  }
 }finally{env.REQUEST_BUDGET.reserve=0;await unlock(env,'dialog',token);}
 // Close the empty-queue/unlock race within the original invocation budget.
 if(Date.now()<interpretUntil-1000&&requestRemaining(env)>=18&&await one(env,"SELECT id FROM updates WHERE state='pending' LIMIT 1"))return drain(env,Date.now(),{deadline,interpretUntil});
 await sendPending(env,Date.now(),deadline);
}
export default {
 async fetch(req,env,ctx){
  env=requestEnv(env);
  try{
   const u=new URL(req.url);
   if(u.pathname==='/health')return json({ok:true,version:'2.1.0',agent_tools:true,voice:true,sha:env.SOURCE_SHA,private:true,enabled:env.ENABLED==='true'});
   if(u.pathname==='/telegram'&&req.method==='POST'){
    if(env.ENABLED!=='true'||!await equal(req.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))return json({ok:false},403);
    if(Number(req.headers.get('content-length'))>16384)return json({ok:false},413);
    const text=await req.text();if(text.length>16384)return json({ok:false},413);let b;try{b=JSON.parse(text);}catch{return json({ok:false},400);}
    if(!owner(env,b)||!Number.isSafeInteger(b.update_id))return json({ok:true});
    // Persist the owner update before acknowledgement; Cron recovers interruption.
    await run(env,'INSERT OR IGNORE INTO updates(id,payload,created_at) VALUES(?,?,?)',b.update_id,JSON.stringify(b),Date.now());
    ctx.waitUntil((async()=>{const start=Date.now();await drain(env);console.log(JSON.stringify({event:'dialog_drain',duration_ms:Date.now()-start,request_units:env.REQUEST_BUDGET.used}));})().catch(()=>{}));return json({ok:true});
   }
   if(u.pathname==='/ops/probe'&&req.method==='POST'&&env.ADMIN_SECRET&&await equal(req.headers.get('Authorization'),'Bearer '+env.ADMIN_SECRET)){
    const result=await brain(env,'Сегодня заработал 4500 рублей. Из них 3000 рублей в капитал Сабунчи, остальные 1500 рублей в карманные. Предложи запись дохода и перевода, а не начальные остатки.',Date.now());const a=validate(result.actions);return json({ok:result.kind==='proposal'&&a.length===2&&a.some(x=>x.type==='income'&&x.wallet==='pocket'&&x.amount===450000&&x.currency==='RUB')&&a.some(x=>x.type==='transfer'&&x.wallet==='pocket'&&x.to==='capital'&&x.amount===300000&&x.currency==='RUB'),model:env.GROQ_MODEL,slang_parse:true});
   }
   return json({ok:false},404);
  }catch{return json({ok:false},503);}
 },
 async scheduled(event,env,ctx){env=requestEnv(env);if(env.ENABLED==='true')ctx.waitUntil((async()=>{
  await drain(env);const now=Date.now();
  if(requestRemaining(env)>=15)await nudge(env,now);
  if(requestRemaining(env)>=10)await deliverReminders(env,now);
  if(requestRemaining(env)>=10)await summarize(env,now);
  await sendPending(env);
  if(requestRemaining(env)>=5)await env.DB.batch([
   q(env,'DELETE FROM voice_inputs WHERE expires<?',now),
   q(env,'DELETE FROM memory WHERE at<? OR rowid NOT IN (SELECT rowid FROM memory ORDER BY at DESC,rowid DESC LIMIT 2000)',now-90*86400000),
   q(env,"DELETE FROM updates WHERE state IN ('done','failed') AND created_at<?",now-30*86400000),
   q(env,"DELETE FROM drafts WHERE state!='ready' AND created_at<?",now-30*86400000),
   q(env,'DELETE FROM guard_events WHERE rowid NOT IN (SELECT rowid FROM guard_events ORDER BY at DESC,rowid DESC LIMIT 2000)')
  ]);
 })());}
};
