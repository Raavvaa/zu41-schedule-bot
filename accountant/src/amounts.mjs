export const hasAmount=t=>/\d|(?<![а-яё])(?:ноль|нуль|один|одну|два|две|три|четыр|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|сто|двести|триста|сот|тысяч|тыщ|полтор|половин|тр[её]шк|пят[её]рк)[а-яё]*(?![а-яё])/iu.test(t)||evidenceAmounts(t).length>0;
export function statedAmounts(text){return [...text.matchAll(/\d+(?:[ \u00a0]\d{3})*(?:[.,]\d{1,2})?\s*((?:тыс(?:яч[аиу]?)?|тыщ|к|млн)(?![а-яё]))?/giu)].map(m=>Math.round(Number(m[0].replace(/[^\d.,]/g,'').replace(',','.'))*(m[1]?/млн/i.test(m[1])?1000000:1000:1)*100));}
const words={ноль:0,один:1,одну:1,одна:1,два:2,две:2,три:3,четыре:4,пять:5,шесть:6,семь:7,восемь:8,девять:9,десять:10,одиннадцать:11,двенадцать:12,тринадцать:13,четырнадцать:14,пятнадцать:15,шестнадцать:16,семнадцать:17,восемнадцать:18,девятнадцать:19,двадцать:20,тридцать:30,сорок:40,пятьдесят:50,шестьдесят:60,семьдесят:70,восемьдесят:80,девяносто:90,сто:100,двести:200,триста:300,четыреста:400,пятьсот:500,шестьсот:600,семьсот:700,восемьсот:800,девятьсот:900};
export function evidenceAmounts(text){
 const result=statedAmounts(text),ts=text.toLowerCase().replace(/ё/g,'е').match(/[а-я]+|\d+(?:[.,]\d+)?/g)??[];
 for(let i=0;i<ts.length;i++){
  if(/^трешк/.test(ts[i])){result.push(300000);continue;}if(/^полтор/.test(ts[i])){result.push(150000);continue;}
  if(words[ts[i]]===undefined)continue;let n=words[ts[i]];
  while(words[ts[i+1]]!==undefined&&words[ts[i+1]]<n)n+=words[ts[++i]];
  if(ts[i+1]==='с'&&ts[i+2]==='половиной'){n+=.5;i+=2;}
  if(/^тыс|^тыщ/.test(ts[i+1]??'')){n*=1000;i++;}
  result.push(Math.round(n*100));
 }
 return result;
}
export function groundedActions(actions,text,evidence,contextAmounts=[]){
 if(typeof evidence!=='string'||!evidence.trim()||!text.includes(evidence.trim()))return false;
 const ns=evidenceAmounts(text),known=new Set(ns);if(ns.length>32)return false;
 // Context may establish the thousands scale for an explicit correction only.
 if(/не\s+.+\s+а\s+/iu.test(text)&&contextAmounts.some(n=>n>=100000))for(const n of ns)if(n>0&&n<1000)known.add(n*1000);
 for(const a of ns)for(const b of ns){known.add(a+b);known.add(Math.abs(a-b));}
 return actions.every(a=>known.has(a.amount));
}
// Two allocations of one income have the same wallet deltas as one income
// followed by a transfer. Canonicalize only that equivalent, single-currency form.
export function canonicalIncomeAllocation(actions){
 if(actions.length===2){
  const income=actions.find(a=>a.type==='income'&&a.wallet==='capital'),transfer=actions.find(a=>a.type==='transfer'&&a.wallet==='capital'&&a.to==='pocket');
  if(income&&transfer&&income.currency===transfer.currency&&transfer.amount<=income.amount){
   const result=[{...income,wallet:'pocket'}],remaining=income.amount-transfer.amount;
   if(remaining)result.push({...transfer,wallet:'pocket',to:'capital',amount:remaining,note:'Распределение полученного дохода'});
   return result;
  }
 }
 if(actions.length<2||actions.some(a=>a.type!=='income')||new Set(actions.map(a=>a.currency)).size!==1||new Set(actions.map(a=>a.wallet)).size!==2)return actions;
 const total=actions.reduce((n,a)=>n+a.amount,0),capital=actions.filter(a=>a.wallet==='capital').reduce((n,a)=>n+a.amount,0),currency=actions[0].currency;
 return [{type:'income',wallet:'pocket',currency,amount:total,note:actions.map(a=>a.note).filter(Boolean).join('; ').slice(0,160)},{type:'transfer',wallet:'pocket',to:'capital',currency,amount:capital,note:'Распределение полученного дохода'}];
}
export function operationDate(value,text,now){
 const today=new Date(now+10800000).toISOString().slice(0,10);
 if(!value)return /вчера/iu.test(text)?Date.parse(today+'T12:00:00+03:00')-86400000:now;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('date');
 const t=Date.parse(value+'T12:00:00+03:00');
 if(!Number.isFinite(t)||value>today||t<now-30*86400000||new Date(t+10800000).toISOString().slice(0,10)!==value)throw Error('date');
 const yesterday=new Date(Date.parse(today+'T12:00:00+03:00')-86400000).toISOString().slice(0,10);
 if(!text.includes(value)&&value!==today&&!(value===yesterday&&/вчера/iu.test(text)))throw Error('date_evidence');return t;
}
