import {one,run} from './ledger.mjs';
export async function dialogState(env){const d=await one(env,'SELECT * FROM dialog_state WHERE id=1');return {...d,question:d.question?JSON.parse(d.question):null};}
export async function setDialog(env,mode,id,now,{pending=null,question=null,topic=null}={}){
 await run(env,'UPDATE dialog_state SET mode=?,pending_draft_id=?,question=?,last_topic=?,last_turn=?,updated_at=? WHERE id=1',mode,pending,question?JSON.stringify(question):null,topic,String(id),now);
}
export const agreement=t=>/^(?:да|ага|ок|окей|записывай|запиши|подтверждаю|давай)(?:[\s,!]+(?:да|ага|ок|окей|записывай|запиши|подтверждаю|давай))*[.!]*$/iu.test(t.trim())&&t.length<=70;
export async function canConfirm(env,text,now){
 if(!agreement(text))return null;const d=await dialogState(env);if(d.mode!=='proposal_ready'||now-d.updated_at>300000)return null;
 const p=await one(env,"SELECT * FROM drafts WHERE id=? AND state='ready' AND expires_at>? AND revision=(SELECT revision FROM settings WHERE id=1) AND (SELECT count(*) FROM drafts WHERE state='ready')=1",d.pending_draft_id,now);
 if(!p)return null;const data=JSON.parse(p.payload);if(data.entries.some(e=>e.wallet==='capital'&&e.delta<0))return null;return p.id;
}
export function answerQuestion(q,text){
 if(!q)return null;const t=text.trim().toLowerCase();
 if(q.type==='purchase_basis'){if(/^(?:уже\s+)?после(?:\s+покупки)?(?:[\s,]+карманные)?[.!]*$/u.test(t))return 'after';if(/^до(?:\s+покупки)?[.!]*$/u.test(t))return 'before';}
 if(q.type==='purchase_discrepancy'){if(/^(?:только\s+)?(?:расход|покупку|покупка)[.!]*$/u.test(t))return 'expense';if(/^(?:остаток|сверка|исправить остаток)[.!]*$/u.test(t))return 'reconcile';}
 if(q.type==='delete_scope'){if(/^(?:1|предложение|отменить предложение)[.!]*$/u.test(t))return 'cancel';if(/^(?:2|остаток|исправить остаток)[.!]*$/u.test(t))return 'balance';if(/^(?:3|последнюю|последнюю запись|отменить последнюю запись)[.!]*$/u.test(t))return 'undo';}
 return null;
}
