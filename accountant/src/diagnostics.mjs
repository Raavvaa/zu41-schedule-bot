import {all,run} from './ledger.mjs';
const types=new Set(['false_receipt','missing_tool','invalid_tool','loop','budget','model_error','invalid_amount']);
const names=new Set(['respond','propose_transaction','set_balance','undo_transaction','amend_transaction','read_ledger','search_memory','remember_fact']);
export async function guardEvent(env,type,tool,now){
 if(!types.has(type))return;
 await run(env,'INSERT INTO guard_events(type,tool,at) VALUES(?,?,?)',type,names.has(tool)?tool:null,now);
}
export function sanitize(text){return String(text)
 .replace(/https?:\/\/\S+/giu,'[ссылка]')
 .replace(/\b(?:Bearer\s+\S+|(?:gsk_|sk-|cfut_)[A-Za-z0-9_-]+|\d{6,}:[A-Za-z0-9_-]+)/giu,'[секрет]')
 .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|@[\w]+/giu,'[контакт]')
 .replace(/[A-Za-z0-9_-]{24,}/g,'[идентификатор]')
 .replace(/\d+(?:[\s.,]\d+)*/g,'[число]')
 .replace(/\b(?:RUB|AZN)\b/gi,'[валюта]')
 .slice(0,400);}
export async function bugReport(env){
 const events=await all(env,'SELECT type,tool,at FROM guard_events ORDER BY at DESC,rowid DESC LIMIT 10');
 const turns=await all(env,'SELECT role,content FROM memory ORDER BY at DESC,rowid DESC LIMIT 6');
 return 'Диагностика: числа, ссылки и идентификаторы скрыты. Перед пересылкой проверь, нет ли личных деталей.\n'+events.map(e=>new Date(e.at).toISOString()+' '+e.type+(e.tool?' / '+e.tool:'')).join('\n')+'\n\nПоследние реплики:\n'+turns.reverse().map(t=>(t.role==='user'?'Ты: ':'Бот: ')+sanitize(t.content)).join('\n');
}
