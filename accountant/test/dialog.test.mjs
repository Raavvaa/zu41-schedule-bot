import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceAmounts,groundedActions,operationDate} from '../src/amounts.mjs';
import {answerQuestion,agreement} from '../src/dialog.mjs';
test('amount evidence handles punctuation, slang, distributions and refuses invented amounts',()=>{
 assert.deepEqual(evidenceAmounts('4.5к, 5к.'),[450000,500000]);
 assert.ok(evidenceAmounts('четыре с половиной тысячи').includes(450000));
 const text='получил 2800, 1800 в дом, остаток себе';
 assert.ok(groundedActions([{amount:100000},{amount:180000}],text,text));
 assert.equal(groundedActions([{amount:930000}],text,text),false);
 assert.equal(groundedActions([{amount:280000}],text,'из старой истории'),false);
 assert.ok(groundedActions([{amount:400000}],'не пять а четыре','не пять а четыре',[500000]));
});
test('closed questions and exact confirmation do not consume topic changes',()=>{
 assert.equal(answerQuestion({type:'purchase_basis'},'после'),'after');
 assert.equal(answerQuestion({type:'purchase_basis'},'после работы устал'),null);
 assert.equal(answerQuestion({type:'delete_scope'},'2'),'balance');
 assert.equal(agreement('да, записывай'),true);assert.equal(agreement('да, но сумма другая'),false);
});
test('operation dates reject future, stale and invented backdating',()=>{
 const now=Date.parse('2026-06-15T15:00:00+03:00');
 assert.equal(new Date(operationDate(null,'вчера получил',now)).toISOString().slice(0,10),'2026-06-14');
 for(const value of ['2026-06-16','2026-05-01','2026-02-31','2026-06-12'])assert.throws(()=>operationDate(value,'вчера',now));
});

import {automaticEligible} from '../src/approval.mjs';
test('automatic eligibility bounds whole operations, rejects capital outflow and voice',()=>{
 const income={type:'income',wallet:'pocket',currency:'RUB',amount:280000},transfer={type:'transfer',wallet:'pocket',to:'capital',currency:'RUB',amount:180000};
 assert.equal(automaticEligible([income,transfer],{limit:500000,proven:true}),true);
 for(const options of [{voice:true},{limit:100000},{proven:false},{reversal:true},{reconcile:true}])assert.equal(automaticEligible([income],{limit:500000,proven:true,...options}),false);
 for(const a of [{...income,wallet:'capital',type:'expense'},{...income,currency:'AZN'},{...income,type:'opening'}])assert.equal(automaticEligible([a],{limit:500000,proven:true}),false);
});

import {redactSecrets} from '../src/tools.mjs';
test('model context redacts secrets and owner identifier without corrupting unrelated amounts',()=>{
 const text=redactSecrets('fake-key 1001 1001000 gsk_syntheticsecret',{GROQ_API_KEY:'fake-key',OWNER_CHAT_ID:'1001'});
 assert.doesNotMatch(text,/fake-key|gsk_syntheticsecret/);assert.match(text,/1001000/);assert.match(text,/идентификатор/);
});

test('spoken teen amounts parse and oversized amount lists are bounded',()=>{
 assert.ok(evidenceAmounts('семнадцать тысяч').includes(1700000));
 const text=Array.from({length:40},(_,i)=>String(i+1)).join(' ');assert.equal(groundedActions([{amount:100}],text,text),false);
});

import {assertDeploymentApproval} from '../deploy-gate.mjs';
test('deployment requires explicit source approval and the dedicated deployment branch',()=>{
 const sha='a'.repeat(40),env={GITHUB_REPOSITORY:'Raavvaa/zu41-schedule-bot',GITHUB_REF_NAME:'deploy/brat-accountant',ACCOUNTANT_APPROVED_SHA:sha};
 assert.doesNotThrow(()=>assertDeploymentApproval(env,sha));
 for(const patch of [{GITHUB_REF_NAME:'main'},{GITHUB_REF_NAME:'feat/brat-accountant'},{ACCOUNTANT_APPROVED_SHA:'b'.repeat(40)},{GITHUB_REPOSITORY:'different/repo'}])assert.throws(()=>assertDeploymentApproval({...env,...patch},sha));
});
