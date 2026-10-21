export const q=(env,s,...args)=>env.DB.prepare(s).bind(...args);
export const one=(env,s,...args)=>q(env,s,...args).first();
export const run=(env,s,...args)=>q(env,s,...args).run();
export const all=async(env,s,...args)=>(await q(env,s,...args).all()).results;
// Invocation-local meter: count statements conservatively, even inside batch.
// Reserve five calls for durable requeue/unlock after an exhausted turn.
export function consumeRequest(env,n=1){const b=env.REQUEST_BUDGET;if(b){if(b.used+n>48-b.reserve)throw Error('request_budget');b.used+=n;}}
export const requestRemaining=env=>env.REQUEST_BUDGET?48-env.REQUEST_BUDGET.reserve-env.REQUEST_BUDGET.used:Infinity;
export function requestEnv(env){
 if(env.REQUEST_BUDGET)return env;
 const scoped={...env,REQUEST_BUDGET:{used:0,reserve:5}},raw=env.DB;
 const wrap=statement=>({rawStatement:statement,bind(...args){return wrap(statement.bind(...args));},first(...args){consumeRequest(scoped);return statement.first(...args);},all(...args){consumeRequest(scoped);return statement.all(...args);},run(...args){consumeRequest(scoped);return statement.run(...args);}});
 scoped.DB={prepare(sql){return wrap(raw.prepare(sql));},batch(statements){consumeRequest(scoped,statements.length);return raw.batch(statements.map(s=>s.rawStatement??s));}};
 return scoped;
}
export const money=(n,c='RUB')=>(n/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' '+(c==='RUB'?'₽':'AZN');
export function amount(value){
 const t=String(value).trim().replace(/\s/g,'').replace(',','.');
 if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(t))throw Error('amount');
 const [a,b='']=t.split('.'),n=Number(a)*100+Number(b.padEnd(2,'0'));
 if(!Number.isSafeInteger(n)||n<=0||n>10000000000)throw Error('amount');return n;
}
export function validate(actions){
 if(!Array.isArray(actions)||!actions.length||actions.length>4)throw Error('actions');
 return actions.map(a=>{
  if(!['income','expense','transfer','opening'].includes(a.type)||!['capital','pocket'].includes(a.wallet)||!['RUB','AZN'].includes(a.currency))throw Error('action');
  const n=a.type==='opening'&&/^0(?:[.,]0{1,2})?$/.test(String(a.amount).trim())?0:amount(a.amount);
  if(a.type==='transfer'&&(!['capital','pocket'].includes(a.to)||a.to===a.wallet))throw Error('transfer');
  return {type:a.type,wallet:a.wallet,currency:a.currency,amount:n,...(a.type==='transfer'?{to:a.to}:{}),note:String(a.note??'').slice(0,160)};
 });
}
export async function balances(env){return all(env,'SELECT * FROM wallets ORDER BY currency DESC,wallet');}
export function changes(actions,ws,reconcile=false){
 const ds=new Map();
 const add=(w,c,n)=>{const k=w+':'+c;ds.set(k,(ds.get(k)??0)+n);};
 for(const a of actions){
  if(a.type==='opening'){
   if(!reconcile&&(actions.some(x=>x.type!=='opening')||new Set(actions.map(x=>x.wallet+':'+x.currency)).size!==actions.length))throw Error('opening_alone');
   add(a.wallet,a.currency,a.amount-(ws.find(w=>w.wallet===a.wallet&&w.currency===a.currency)?.amount??0));
  }else if(a.type==='income')add(a.wallet,a.currency,a.amount);
  else{add(a.wallet,a.currency,-a.amount);if(a.type==='transfer')add(a.to,a.currency,a.amount);}
 }
 return [...ds].map(([k,delta])=>{const [wallet,currency]=k.split(':');return {wallet,currency,delta};});
}
export async function propose(env,id,raw,now,reversal=null,options={}){
 const existing=await one(env,'SELECT payload FROM drafts WHERE id=?',id);
 if(existing)return JSON.parse(existing.payload);
 const actions=reversal&&!options.amend?null:validate(raw),ws=await balances(env),s=await one(env,'SELECT revision,(SELECT effective_at FROM operation_meta WHERE tx_id=?) AS original_at FROM settings WHERE id=1',reversal?.id??null);
 if(!reversal&&actions.every(a=>a.type==='opening'&&ws.some(w=>w.wallet===a.wallet&&w.currency===a.currency&&w.initialized&&w.amount===a.amount)))throw Error('unchanged');
 let ds=reversal?reversal.entries.map(x=>({wallet:x.wallet,currency:x.currency,delta:-x.delta})):changes(actions,ws,options.reconcile);
 if(options.amend){
  const virtual=ws.map(w=>({...w,amount:w.amount+(ds.find(e=>e.wallet===w.wallet&&e.currency===w.currency)?.delta??0)}));
  const replacement=changes(actions,virtual),combined=new Map();for(const e of [...ds,...replacement]){const key=e.wallet+':'+e.currency;combined.set(key,{...e,delta:(combined.get(key)?.delta??0)+e.delta});}ds=[...combined.values()];
 }
 for(const d of ds){const w=ws.find(x=>x.wallet===d.wallet&&x.currency===d.currency);
  if(!w||!Number.isSafeInteger(d.delta)||w.amount+d.delta<0)throw Error('insufficient');
  if(!reversal&&actions.every(a=>a.type!=='opening')&&!w.initialized)throw Error('uninitialized');
 }
 const payload={actions,entries:ds,before:ws.map(w=>({wallet:w.wallet,currency:w.currency,amount:w.initialized?w.amount:null})),reversal_of:reversal?.id??null,amend:!!options.amend,effective_at:s.original_at??options.effective_at??now,evidence:options.evidence??null,reconcile:!!options.reconcile};
 await env.DB.batch([
 q(env,"UPDATE drafts SET state='cancelled' WHERE state='ready' AND id!=? AND NOT EXISTS(SELECT 1 FROM drafts WHERE id=?)",id,id),
 q(env,'INSERT OR IGNORE INTO drafts(id,payload,revision,created_at,expires_at) VALUES(?,?,?,?,?)',id,JSON.stringify(payload),s.revision,now,now+15*60000)]);
 // Concurrent/retried inference must display the exact persisted proposal.
 return JSON.parse((await one(env,'SELECT payload FROM drafts WHERE id=?',id)).payload);
}
export async function apply(env,id,now){
 const d=await one(env,"SELECT * FROM drafts WHERE id=? AND state='ready' AND expires_at>?",id,now);
 if(!d)return false;
 const p=JSON.parse(d.payload),conditions=[],args=[];
 for(const e of p.entries){conditions.push('(SELECT amount FROM wallets WHERE wallet=? AND currency=?)+?>=0');args.push(e.wallet,e.currency,e.delta);}
 if(p.reversal_of){conditions.push('EXISTS(SELECT 1 FROM transactions WHERE id=?) AND NOT EXISTS(SELECT 1 FROM transactions WHERE reversal_of=?)');args.push(p.reversal_of,p.reversal_of);}
 const guard=`EXISTS(SELECT 1 FROM settings WHERE id=1 AND claim=?) AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND state='ready')`;
 const statements=[q(env,`UPDATE settings SET revision=revision+1,claim=? WHERE id=1 AND revision=? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND state='ready' AND expires_at>?) AND ${conditions.join(' AND ')}`,id,d.revision,id,now,...args),
 q(env,`INSERT OR IGNORE INTO transactions(id,kind,note,at,reversal_of) SELECT ?,?,?,?,? WHERE ${guard}`,id,p.amend?'amend':p.reversal_of?'undo':p.actions.map(x=>x.type).join('+'),p.actions?.map(x=>x.note).filter(Boolean).join('; ').slice(0,300)??'Отмена записи',now,p.reversal_of,id,id)];
 for(const e of p.entries){
  statements.push(q(env,`INSERT OR IGNORE INTO entries(tx_id,wallet,currency,delta) SELECT ?,?,?,? WHERE ${guard}`,id,e.wallet,e.currency,e.delta,id,id));
  statements.push(q(env,`UPDATE wallets SET amount=amount+?,initialized=1 WHERE wallet=? AND currency=? AND ${guard}`,e.delta,e.wallet,e.currency,id,id));
 }
 statements.push(q(env,`INSERT OR IGNORE INTO operation_meta(tx_id,actions,effective_at) SELECT ?,?,? WHERE ${guard}`,id,JSON.stringify(p.actions),p.effective_at??now,id,id));
 statements.push(q(env,`UPDATE dialog_state SET mode='just_applied',pending_draft_id=NULL,question=NULL,last_applied_tx=?,last_turn=?,updated_at=? WHERE id=1 AND ${guard}`,id,id,now,id,id));
 statements.push(q(env,`UPDATE drafts SET state='applied' WHERE id=? AND ${guard}`,id,id,id));
 const results=await env.DB.batch(statements);return results[0].meta.changes===1;
}
export const walletName=w=>w==='capital'?'🏠 Сабунчи':'👛 Карманные';
export async function balanceText(env){
 const ws=await balances(env),s=await one(env,'SELECT goal FROM settings WHERE id=1');
 let text='Брат, по записям сейчас:\n'+ws.filter(w=>w.currency==='RUB'||w.initialized).map(w=>walletName(w.wallet)+': '+(w.initialized?money(w.amount,w.currency):'остаток ещё не подтверждён')).join('\n');
 const capital=ws.find(x=>x.wallet==='capital'&&x.currency==='RUB');
 if(s.goal&&capital.initialized)text+='\n\n🎯 До цели: '+money(Math.max(0,s.goal-capital.amount))+' · '+Math.min(100,Math.floor(capital.amount/s.goal*100))+'%';
 return text;
}
export function draftText(p){
 const text=p.amend?'Исправить проведённую операцию. Прежняя запись остаётся в истории.':p.reversal_of?'Отменить последнюю запись отдельной корректировкой? История сохранится.':p.actions.map(a=>{
 const before=p.before?.find(w=>w.wallet===a.wallet&&w.currency===a.currency)?.amount;
 if(a.type==='opening')return `${walletName(a.wallet)}: ${before==null?'остаток неизвестен':money(before,a.currency)} → ${money(a.amount,a.currency)}\nЭто установка правильного остатка, не новый доход.`;
 return `${a.type==='income'?'+':a.type==='expense'?'−':'Перевод'} ${money(a.amount,a.currency)} · ${walletName(a.wallet)}${a.to?' → '+walletName(a.to):''}${a.note?' · '+a.note:''}`;
 }).join('\n');
 const preview=p.actions?.every(a=>a.type==='opening')?'':p.entries.map(e=>{const before=p.before?.find(w=>w.wallet===e.wallet&&w.currency===e.currency)?.amount;return before==null?'':`${walletName(e.wallet)}: ${money(before,e.currency)} → ${money(before+e.delta,e.currency)}`;}).filter(Boolean).join('\n');
 return text+(preview?'\n\n'+preview:'')+'\n\nПока ничего не записано. Всё верно?';
}

export async function amendProposal(env,id,target,raw,now,options={}){
 const original=await one(env,'SELECT t.id,t.kind,m.actions,m.effective_at FROM transactions t LEFT JOIN operation_meta m ON m.tx_id=t.id WHERE t.id=? AND NOT EXISTS(SELECT 1 FROM transactions r WHERE r.reversal_of=t.id)',target);
 if(!original)throw Error('already_reversed');if(original.kind.includes('opening'))throw Error('use_set_balance');
 const entries=original.kind==='amend'&&original.actions?changes(JSON.parse(original.actions),await balances(env)):await all(env,'SELECT wallet,currency,delta FROM entries WHERE tx_id=?',target);
 options.effective_at=original.effective_at??options.effective_at??now;
 return propose(env,id,raw,now,{id:target,entries},{...options,amend:true});
}
