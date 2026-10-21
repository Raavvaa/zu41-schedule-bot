export function automaticEligible(actions,{limit,voice=false,proven=false,reversal=false,reconcile=false}={}){
 if(!proven||voice||reversal||reconcile||!Number.isSafeInteger(limit)||limit<=0||!actions?.length)return false;
 if(actions.some(a=>!['income','expense','transfer'].includes(a.type)||a.currency!=='RUB'||a.wallet==='capital'&&a.type!=='income'))return false;
 const cash=actions.filter(a=>a.type!=='transfer').reduce((n,a)=>n+a.amount,0),moved=actions.filter(a=>a.type==='transfer').reduce((n,a)=>n+a.amount,0);
 return Math.max(cash,moved)<=limit;
}
