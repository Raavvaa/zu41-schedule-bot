import {q,one,all,run,amount,money,validate,propose,apply,balances,balanceText,draftText,walletName} from './ledger.mjs';
import {brain} from './brain.mjs';
const json=(v,status=200)=>Response.json(v,{status});
const day=now=>new Date(now+10800000).toISOString().slice(0,10);
const menu={keyboard:[['💰 Баланс','✍️ Записать'],['🎯 Цель','📒 История'],['⚙️ Настройки','💬 Поговорим']],resize_keyboard:true};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function equal(a,b){if(!a||!b)return false;const hash=x=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(x));const [aa,bb]=await Promise.all([hash(a),hash(b)]);let diff=0;new Uint8Array(aa).forEach((x,i)=>{diff|=x^new Uint8Array(bb)[i];});return diff===0;}
export function owner(env,b){const m=b.message??b.callback_query?.message,from=b.message?.from??b.callback_query?.from;const id=String(env.OWNER_CHAT_ID??'');return /^[1-9]\d*$/.test(id)&&Number.isSafeInteger(Number(id))&&m?.chat?.type==='private'&&String(m.chat.id)===id&&String(from?.id)===id;}
async function lock(env,name,now,ttl=55000){const token=crypto.randomUUID();const r=await run(env,'INSERT INTO locks VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE expires<=?',name,token,now+ttl,now);return r.meta.changes?token:null;}
async function unlock(env,name,token){await run(env,'DELETE FROM locks WHERE name=? AND token=?',name,token);}
async function tg(env,method,body){try{const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const d=await r.json();return {ok:d.ok===true,id:d.result?.message_id,error:d.error_code??r.status,retry:Math.max(1,Number(d.parameters?.retry_after)||30)};}catch{return {ok:false,error:'uncertain'};}}
async function reply(env,id,text,now,markup=menu){await run(env,'INSERT OR IGNORE INTO outbox(id,payload,due,created_at) VALUES(?,?,?,?)',String(id),JSON.stringify({text:String(text).slice(0,3900),...(markup?{reply_markup:markup}:{}),link_preview_options:{is_disabled:true}}),now,now);}
async function memory(env,id,role,content,now){await run(env,'INSERT OR IGNORE INTO memory VALUES(?,?,?,?)',id,role,content.slice(0,2500),now);}
async function draft(env,id,actions,now,reversal=null){
 try{
  const p=await propose(env,id,actions,now,reversal);const protectedCapital=p.entries.some(x=>x.wallet==='capital'&&x.delta<0);
  return reply(env,id,(protectedCapital?'⚠️ Брат, это уменьшит капитал Сабунчи. Если трата уже была, учтём честно.\n\n':'')+draftText(p),now,{inline_keyboard:[[{text:protectedCapital?'⚠️ Подтверждаю снятие капитала':'✅ Записать',callback_data:'yes:'+id}],[{text:'❌ Отмена',callback_data:'no:'+id}]]});
 }catch(e){return reply(env,id,e.message==='insufficient'?'Брат, по записям в кошельке не хватает денег. Если остаток неверный — напиши «/остаток карманные RUB 5000» с реальной суммой.':e.message==='uninitialized'?'Сначала подтвердим остатки, брат. Пример: /остаток карманные RUB 5000\nДля капитала: /остаток капитал RUB 100000\nЭто примеры формата, не запись денег.':'Не смог надёжно разобрать сумму и кошелёк. Напиши проще: /доход карманные RUB 3500 смена',now);}
}
function localAction(t){
 const m=t.match(/^\/(доход|расход|остаток|перевод)\s+(капитал|карманные)\s+(RUB|AZN)\s+(\d+(?:[.,]\d{1,2})?)(?:\s+(.*))?$/i);if(!m)return null;
 const wallet=m[2].toLowerCase()==='капитал'?'capital':'pocket',type={доход:'income',расход:'expense',остаток:'opening',перевод:'transfer'}[m[1].toLowerCase()];
 return [{type,wallet,currency:m[3].toUpperCase(),amount:m[4],...(type==='transfer'?{to:wallet==='pocket'?'capital':'pocket'}:{}),note:m[5]??''}];
}
const help='Брат, можно писать как говоришь: «получил 4500 руб, трёшку в дом, остальное себе». Я покажу запись и спрошу подтверждение.\n\nЕсли Groq недоступен:\n/доход карманные RUB 3500 смена\n/расход карманные RUB 250 еда\n/перевод карманные RUB 3000\n/остаток капитал RUB 100000\n/цель 500000\n/план 25000\n/отмена — отменить последнюю запись с подтверждением\n/память текст — сохранить важное о себе\n/забыть — очистить контекст разговоров\n\nВсе суммы выше — примеры. Ничего не зачислено. RUB и AZN учитываются отдельно; курсы не выдумываю.\nСвободный текст и короткая история передаются Groq для понимания. ID и токены туда не отправляю.';
async function handle(env,b,now){
 const id=String(b.update_id),text=(b.message?.text??'').trim(),cb=b.callback_query?.data;
 await run(env,'UPDATE settings SET last_seen=?,active=1 WHERE id=1',now);
 if(cb){
  if(b.callback_query.id)await tg(env,'answerCallbackQuery',{callback_query_id:b.callback_query.id});
  const m=cb.match(/^(yes|no):(-?\d+)$/);if(m){
   if(m[1]==='no'){await run(env,"UPDATE drafts SET state='cancelled' WHERE id=? AND state='ready'",m[2]);return reply(env,id,'Не записываю, брат.',now);}
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
 if(text==='/start'||text==='/help')return reply(env,id,'С Бисмиллях, брат. Я твой личный бухгалтер: капитал Сабунчи отдельно, карманные отдельно.\n\n'+await balanceText(env)+'\n\n'+help,now);
 if(text==='💰 Баланс'||text==='/balance')return reply(env,id,await balanceText(env),now);
 if(text==='✍️ Записать')return reply(env,id,'Напиши, что уже получил или потратил, сумму и кошелёк. Если только хочешь купить — скажи «хочу», я ничего не спишу.\n\n'+help,now);
 if(text==='🎯 Цель')return reply(env,id,await balanceText(env)+'\n\nЧтобы задать личную цель в рублях: /цель 500000\nПлан накоплений на месяц: /план 25000\nСрок и бюджет сделки обсудим отдельно, без выдуманного курса.',now);
 const goal=text.match(/^\/(цель|план)\s+(\d+(?:[.,]\d{1,2})?)$/);
 if(goal){try{const n=amount(goal[2]);await run(env,`UPDATE settings SET ${goal[1]==='цель'?'goal':'monthly'}=? WHERE id=1`,n);return reply(env,id,'Принял: '+(goal[1]==='цель'?'цель ':'план на месяц ')+money(n)+'. Кошельки не менял.',now);}catch{return reply(env,id,'Нужна положительная сумма в рублях, например /цель 500000.',now);}}
 if(text==='⚙️ Настройки'||text==='/settings'){
  const s=await one(env,'SELECT * FROM settings WHERE id=1');return reply(env,id,`Поддержка: ${s.proactive?'включена':'выключена'} — пн/ср/сб в ${s.nudge_time} МСК, максимум одно сообщение в день, без догоняющей рассылки.\nРелигиозные напоминания: ${s.religion?'да':'нет'}.\nВремя: /время 19:00\nПауза: /тишина; вернуть: /общайся.`,now,{inline_keyboard:[[{text:s.proactive?'Не писать первым':'Пиши иногда',callback_data:s.proactive?'support:off':'support:on'}],[{text:s.religion?'Без религиозных напоминаний':'Добавить религиозные напоминания',callback_data:s.religion?'religion:off':'religion:on'}],[{text:'Пауза до завтра',callback_data:'quiet:today'}]]});
 }
 const time=text.match(/^\/время\s+((?:1[0-9]|20):[0-5][0-9])$/);if(time){await run(env,'UPDATE settings SET nudge_time=? WHERE id=1',time[1]);return reply(env,id,'Буду писать в '+time[1]+' МСК по пн/ср/сб.',now);}
 if(text==='/тишина'||text==='/общайся'){await run(env,'UPDATE settings SET proactive=? WHERE id=1',text==='/общайся'?1:0);return reply(env,id,text==='/тишина'?'Хорошо, первым не пишу.':'Хорошо, буду иногда выходить на связь.',now);}
 if(text.startsWith('/память ')){await run(env,'UPDATE settings SET context=? WHERE id=1',text.slice(8).slice(0,1500));return reply(env,id,'Запомнил для следующих разговоров. Посмотреть: /память. Удалить: /забыть.',now);}
 if(text==='/память')return reply(env,id,(await one(env,'SELECT context FROM settings WHERE id=1')).context||'Постоянных заметок пока нет.',now);
 if(text==='/забыть'){await env.DB.batch([q(env,'DELETE FROM memory'),q(env,"UPDATE settings SET context='' WHERE id=1")]);return reply(env,id,'Контекст разговоров и заметка очищены. Журнал денег сохранён.',now);}
 if(text==='📒 История'||text==='/history'){
  const rs=await all(env,'SELECT t.id,t.note,t.at,e.wallet,e.currency,e.delta FROM transactions t JOIN entries e ON e.tx_id=t.id ORDER BY t.at DESC,t.rowid DESC LIMIT 12');
  return reply(env,id,rs.length?rs.map(r=>`${day(r.at)} · ${walletName(r.wallet)} ${r.delta>=0?'+':'−'}${money(Math.abs(r.delta),r.currency)}${r.note?' · '+r.note:''}`).join('\n'):'Записей пока нет, брат.',now);
 }
 if(text==='/отмена'){
  const t=await one(env,'SELECT * FROM transactions t WHERE reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id) ORDER BY at DESC,rowid DESC LIMIT 1');
  if(!t)return reply(env,id,'Нет записи для отмены.',now);
  return draft(env,id,null,now,{id:t.id,entries:await all(env,'SELECT wallet,currency,delta FROM entries WHERE tx_id=?',t.id)});
 }
 const direct=localAction(text);if(direct)return draft(env,id,direct,now);
 if(text.startsWith('/'))return reply(env,id,help,now);
 if(!text)return reply(env,id,'Пока понимаю текст, брат. Голосовое можешь пересказать одним сообщением.',now);
 if(text.length>2500)return reply(env,id,'Брат, сократи сообщение до 2500 символов — так надёжнее разберу.',now);
 let result;
 try{result=await brain(env,text==='💬 Поговорим'?'Хочу поговорить. Спроси, как у меня дела.':text,now);}catch{return reply(env,id,'Брат, Groq сейчас недоступен или закончился дневной лимит. Деньги не потерялись: «Баланс», история и команды записи работают.\n\n'+help,now);}
 await memory(env,id+':user','user',text,now);
 if(result.kind==='proposal')return draft(env,id,result.actions,now);
 await memory(env,id+':assistant','assistant',result.reply,now+1);
 return reply(env,id,result.reply,now);
}
export async function sendPending(env,now=Date.now()){
 if(Number((await one(env,'SELECT telegram_pause FROM settings WHERE id=1'))?.telegram_pause)>now)return;
 const token=await lock(env,'send',now,25000);if(!token)return;
 try{
  await run(env,"UPDATE outbox SET state='uncertain' WHERE state='sending' AND lease<=?",now);
  const rows=await all(env,"SELECT * FROM outbox WHERE state='pending' AND due<=? ORDER BY created_at,rowid LIMIT 2",now);
  for(let i=0;i<rows.length;i++){
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
export async function drain(env,now=Date.now()){
 const token=await lock(env,'dialog',now);if(!token)return;
 try{
  const u=await one(env,"SELECT * FROM updates WHERE state='pending' OR state='processing' AND lease<=? ORDER BY created_at,id LIMIT 1",now);
  if(u){await run(env,"UPDATE updates SET state='processing',lease=? WHERE id=?",now+55000,u.id);
   try{await handle(env,JSON.parse(u.payload),now);await run(env,"UPDATE updates SET state='done',payload='{}' WHERE id=?",u.id);}
   catch{await reply(env,u.id,'Не удалось закончить запрос, брат. Проверь баланс перед повторной записью; подтверждённый журнал сохранён.',now);await run(env,"UPDATE updates SET state='failed',payload='{}' WHERE id=?",u.id);}
  }
 }finally{await unlock(env,'dialog',token);}
 await sendPending(env);
}
export async function nudge(env,now=Date.now()){
 const s=await one(env,'SELECT * FROM settings WHERE id=1');
 await run(env,'UPDATE settings SET last_cron=? WHERE id=1',now);
 const local=new Date(now+10800000),weekday=local.getUTCDay(),time=local.toISOString().slice(11,16);
 const mins=t=>Number(t.slice(0,2))*60+Number(t.slice(3)),elapsed=mins(time)-mins(s.nudge_time);
 if(!s.active||!s.proactive||s.quiet_until>now||![1,3,6].includes(weekday)||elapsed<0||elapsed>14||now-s.last_seen<3600000)return;
 const ws=await balances(env),c=ws.find(x=>x.wallet==='capital'&&x.currency==='RUB');
 const phrases=['Брат, как неделя идёт? Можно двигаться небольшими шагами.','Как ты, брат? Если была смена или расход — напиши одной строкой, разложим.','Брат, без гонки. Посмотрим, что получилось отложить, и выберем следующий посильный шаг.'];
 let text=phrases[Math.floor(now/86400000)%phrases.length];
 if(c.initialized&&s.goal)text+='\nВ Сабунчи по записям '+money(c.amount)+', до цели '+money(Math.max(0,s.goal-c.amount))+'.';
 if(s.monthly){const saved=await one(env,`SELECT COALESCE(sum(e.delta),0) AS n FROM entries e JOIN transactions t ON t.id=e.tx_id WHERE e.wallet='capital' AND e.currency='RUB' AND t.at>=? AND t.kind NOT LIKE '%opening%' AND NOT EXISTS(SELECT 1 FROM transactions orig WHERE orig.id=t.reversal_of AND orig.kind LIKE '%opening%')`,Date.parse(day(now).slice(0,7)+'-01T00:00:00+03:00'));text+='\nДо плана накоплений этого месяца: '+money(Math.max(0,s.monthly-saved.n))+'.';}
 if(s.religion&&weekday===6)text+='\nСабр, брат. Сделай посильное и уповай на Аллаха — без обещаний лёгких денег.';
 await reply(env,'nudge:'+day(now),text,now,{inline_keyboard:[[{text:'Сегодня без напоминаний',callback_data:'quiet:today'}]]});
}
export default {
 async fetch(req,env,ctx){
  try{
   const u=new URL(req.url);
   if(u.pathname==='/health')return json({ok:true,version:'1.0.0',sha:env.SOURCE_SHA,private:true,enabled:env.ENABLED==='true'});
   if(u.pathname==='/telegram'&&req.method==='POST'){
    if(env.ENABLED!=='true'||!await equal(req.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))return json({ok:false},403);
    if(Number(req.headers.get('content-length'))>16384)return json({ok:false},413);
    const text=await req.text();if(text.length>16384)return json({ok:false},413);let b;try{b=JSON.parse(text);}catch{return json({ok:false},400);}
    if(!owner(env,b)||!Number.isSafeInteger(b.update_id))return json({ok:true});
    // Persist the owner update before acknowledgement; Cron recovers interruption.
    await run(env,'INSERT OR IGNORE INTO updates(id,payload,created_at) VALUES(?,?,?)',b.update_id,JSON.stringify(b),Date.now());
    ctx.waitUntil(drain(env).catch(()=>{}));return json({ok:true});
   }
   if(u.pathname==='/ops/probe'&&req.method==='POST'&&env.ADMIN_SECRET&&await equal(req.headers.get('Authorization'),'Bearer '+env.ADMIN_SECRET)){
    const result=await brain(env,'Сегодня заработал 4500 рублей. Из них 3000 рублей в капитал Сабунчи, остальные 1500 рублей в карманные. Предложи запись дохода и перевода, а не начальные остатки.',Date.now());const a=validate(result.actions);return json({ok:result.kind==='proposal'&&a.length===2&&a.some(x=>x.type==='income'&&x.wallet==='pocket'&&x.amount===450000&&x.currency==='RUB')&&a.some(x=>x.type==='transfer'&&x.wallet==='pocket'&&x.to==='capital'&&x.amount===300000&&x.currency==='RUB'),model:env.GROQ_MODEL,slang_parse:true});
   }
   return json({ok:false},404);
  }catch{return json({ok:false},503);}
 },
 async scheduled(event,env,ctx){if(env.ENABLED==='true')ctx.waitUntil((async()=>{await drain(env);await nudge(env);await sendPending(env);const now=Date.now();await env.DB.batch([q(env,'DELETE FROM memory WHERE at<?',now-30*86400000),q(env,"DELETE FROM updates WHERE state IN ('done','failed') AND created_at<?",now-30*86400000),q(env,"DELETE FROM drafts WHERE state!='ready' AND created_at<?",now-30*86400000)]);})());}
};
