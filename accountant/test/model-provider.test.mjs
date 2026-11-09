import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelProvider,modelSession,completionRequest,toolAssistant} from '../src/model-provider.mjs';

test('Groq remains the default even if an OpenRouter key is present',()=>{
 const p=modelProvider({GROQ_API_KEY:'groq-fixture',OPENROUTER_API_KEY:'router-fixture'});
 assert.equal(p.name,'groq');assert.equal(p.key,'groq-fixture');assert.equal(p.dailyLimit,200);
});
test('OpenRouter selects its own credential, fixed endpoint and free router',()=>{
 const p=modelProvider({CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:'router-fixture',GROQ_API_KEY:'groq-fixture'});
 assert.equal(p.key,'router-fixture');assert.equal(p.url,'https://openrouter.ai/api/v1/chat/completions');
 assert.equal(p.model,'openrouter/free');assert.equal(p.dailyLimit,50);
});
test('missing keys and unknown provider fail closed',()=>{
 for(const env of [{},{OPENROUTER_API_KEY:'fixture'},{CHAT_PROVIDER:'openrouter',GROQ_API_KEY:'fixture'},{CHAT_PROVIDER:'other',GROQ_API_KEY:'fixture'}])assert.throws(()=>modelProvider(env),/brain_config/);
});
test('only explicit free model IDs are accepted for OpenRouter',()=>{
 const env={CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:'fixture'};
 assert.equal(modelProvider({...env,OPENROUTER_MODEL:'example/model-v1:free'}).model,'example/model-v1:free');
 for(const model of ['example/paid','openrouter/auto','https://untrusted.invalid/model:free','example/model:free?fallback=paid','', 'example/model:free\n'])assert.throws(()=>modelProvider({...env,OPENROUTER_MODEL:model}),/brain_config/);
});
test('OpenRouter keeps tools optional and excludes providers collecting data',()=>{
 const p=modelProvider({CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:'fixture'});
 const request=completionRequest(p,[{role:'user',content:'fixture'}],[],5000),body=JSON.parse(request.body);
 assert.equal(request.redirect,'manual');assert.equal(request.headers.Authorization,'Bearer fixture');
 assert.equal(body.tool_choice,'auto');assert.equal(body.parallel_tool_calls,undefined);assert.equal(body.max_tokens,1600);
 assert.equal(body.max_completion_tokens,undefined);assert.deepEqual(body.provider,{require_parameters:true,data_collection:'deny'});
 assert.equal(request.body.includes('Bearer'),false);assert.equal(body.models,undefined);
});
test('Groq retains its supported output limit',()=>{
 const body=JSON.parse(completionRequest(modelProvider({GROQ_API_KEY:'fixture'}),[],[],5000).body);
 assert.equal(body.max_completion_tokens,1600);assert.equal(body.parallel_tool_calls,false);assert.equal(body.max_tokens,undefined);assert.equal(body.provider,undefined);
});
test('tool continuation preserves opaque reasoning without inventing it',()=>{
 const message={content:null,tool_calls:[{id:'fixture'}],reasoning_details:[{type:'reasoning.encrypted',data:'fixture'}]};
 assert.deepEqual(toolAssistant(message),{role:'assistant',...message});
 assert.equal(toolAssistant({tool_calls:[]}).reasoning_details,undefined);
});
test('Workers AI is the last resort and sees only the current text with no tools',async()=>{
 const budgets=[];let calls=0;
 const env={CHAT_PROVIDER:'openrouter',OPENROUTER_API_KEY:'fixture',GROQ_API_KEY:'fixture',
  DB:{prepare:()=>({bind:(key)=>({run:async()=>{budgets.push(key);return {meta:{changes:Number(key.startsWith('workers_ai:'))}};}})})},
  AI:{run:async(model,body)=>{calls++;assert.equal(model,'@cf/openai/gpt-oss-20b');assert.deepEqual(body.messages.map(m=>m.role),['system','user']);assert.equal(body.messages.at(-1).content,'Привет!');assert.equal(body.tools,undefined);return {output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Привет, брат!'}]}]};}}};
 const date='2026-10-01',deadline=Date.now()+2000;
 const result=await modelSession(env,date,deadline,'Привет!')([{role:'system',content:'fixture-private-state'}],[]);
 assert.deepEqual(result,{message:{content:'Привет, брат!'},textOnly:true});
 assert.deepEqual(budgets,['openrouter:'+date,date,'workers_ai:'+date]);
 await assert.rejects(modelSession(env,date,deadline,null)([],[]),/brain_budget/);
 assert.equal(calls,1);
});
