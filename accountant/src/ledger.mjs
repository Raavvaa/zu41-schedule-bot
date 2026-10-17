export const q=(env,s,...args)=>env.DB.prepare(s).bind(...args);
export const one=(env,s,...args)=>q(env,s,...args).first();
export const run=(env,s,...args)=>q(env,s,...args).run();
export const all=async(env,s,...args)=>(await q(env,s,...args).all()).results;
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
export function changes(actions,ws){
 const ds=new Map();
 const add=(w,c,n)=>{const k=w+':'+c;ds.set(k,(ds.get(k)??0)+n);};
 for(const a of actions){
  if(a.type==='opening'){
   if(actions.some(x=>x.type!=='opening')||new Set(actions.map(x=>x.wallet+':'+x.currency)).size!==actions.length)throw Error('opening_alone');
   add(a.wallet,a.currency,a.amount-(ws.find(w=>w.wallet===a.wallet&&w.currency===a.currency)?.amount??0));
  }else if(a.type==='income')add(a.wallet,a.currency,a.amount);
  else{add(a.wallet,a.currency,-a.amount);if(a.type==='transfer')add(a.to,a.currency,a.amount);}
 }
 return [...ds].map(([k,delta])=>{const [wallet,currency]=k.split(':');return {wallet,currency,delta};});
}
export async function propose(env,id,raw,now,reversal=null){
 const actions=reversal?null:validate(raw),ws=await balances(env),s=await one(env,'SELECT revision FROM settings WHERE id=1');
 if(!reversal&&actions.every(a=>a.type==='opening'&&ws.some(w=>w.wallet===a.wallet&&w.currency===a.currency&&w.initialized&&w.amount===a.amount)))throw Error('unchanged');
 const ds=reversal?reversal.entries.map(x=>({wallet:x.wallet,currency:x.currency,delta:-x.delta})):changes(actions,ws);
 for(const d of ds){const w=ws.find(x=>x.wallet===d.wallet&&x.currency===d.currency);
  if(!w||!Number.isSafeInteger(d.delta)||w.amount+d.delta<0)throw Error('insufficient');
  if(!reversal&&actions.every(a=>a.type!=='opening')&&!w.initialized)throw Error('uninitialized');
 }
 const payload={actions,entries:ds,reversal_of:reversal?.id??null};
 await run(env,'INSERT OR IGNORE INTO drafts(id,payload,revision,created_at,expires_at) VALUES(?,?,?,?,?)',id,JSON.stringify(payload),s.revision,now,now+15*60000);
 return payload;
}
export async function apply(env,id,now){
 const d=await one(env,"SELECT * FROM drafts WHERE id=? AND state='ready' AND expires_at>?",id,now);
 if(!d)return false;
 const p=JSON.parse(d.payload),conditions=[],args=[];
 for(const e of p.entries){conditions.push('(SELECT amount FROM wallets WHERE wallet=? AND currency=?)+?>=0');args.push(e.wallet,e.currency,e.delta);}
 const guard=`EXISTS(SELECT 1 FROM settings WHERE id=1 AND claim=?) AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND state='ready')`;
 const statements=[q(env,`UPDATE settings SET revision=revision+1,claim=? WHERE id=1 AND revision=? AND EXISTS(SELECT 1 FROM drafts WHERE id=? AND state='ready' AND expires_at>?) AND ${conditions.join(' AND ')}`,id,d.revision,id,now,...args),
 q(env,`INSERT OR IGNORE INTO transactions(id,kind,note,at,reversal_of) SELECT ?,?,?,?,? WHERE ${guard}`,id,p.reversal_of?'undo':p.actions.map(x=>x.type).join('+'),p.actions?.map(x=>x.note).filter(Boolean).join('; ').slice(0,300)??'Отмена записи',now,p.reversal_of,id,id)];
 for(const e of p.entries){
  statements.push(q(env,`INSERT OR IGNORE INTO entries(tx_id,wallet,currency,delta) SELECT ?,?,?,? WHERE ${guard}`,id,e.wallet,e.currency,e.delta,id,id));
  statements.push(q(env,`UPDATE wallets SET amount=amount+?,initialized=1 WHERE wallet=? AND currency=? AND ${guard}`,e.delta,e.wallet,e.currency,id,id));
 }
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
export function draftText(p){return (p.reversal_of?'Отменить прошлую запись?':p.actions.map(a=>`${a.type==='income'?'+':a.type==='expense'?'−':a.type==='opening'?'Остаток =':'Перевод'} ${money(a.amount,a.currency)} · ${walletName(a.wallet)}${a.to?' → '+walletName(a.to):''}${a.note?' · '+a.note:''}`).join('\n'))+'\n\nПока ничего не записано. Всё верно?';}
