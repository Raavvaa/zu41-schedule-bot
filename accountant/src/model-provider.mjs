import {consumeRequest,run} from './ledger.mjs';

// Fixed endpoints only. The selected provider is always tried first.
export function modelProvider(env){
 const name=env.CHAT_PROVIDER??'groq';
 if(name==='groq'){
  if(!env.GROQ_API_KEY)throw Error('brain_config');
  return {name,key:env.GROQ_API_KEY,model:env.GROQ_MODEL??'openai/gpt-oss-120b',url:'https://api.groq.com/openai/v1/chat/completions',dailyLimit:200};
 }
 if(name==='openrouter'){
  const model=env.OPENROUTER_MODEL??'openrouter/free';
  if(!env.OPENROUTER_API_KEY||!(model==='openrouter/free'||/^[a-z0-9_-]+\/[a-z0-9._-]+:free$(?![\s\S])/i.test(model)))throw Error('brain_config');
  return {name,key:env.OPENROUTER_API_KEY,model,url:'https://openrouter.ai/api/v1/chat/completions',dailyLimit:50};
 }
 throw Error('brain_config');
}

const WORKERS_MODEL='@cf/openai/gpt-oss-20b';
export function modelCandidates(env){
 const primary=env.CHAT_PROVIDER??'groq';
 const names=primary==='openrouter'?['openrouter','groq']:primary==='groq'?['groq']:[];
 const candidates=names.flatMap(CHAT_PROVIDER=>{
  try{return [modelProvider({...env,CHAT_PROVIDER})];}catch{return [];}
 });
 if(names.length&&typeof env.AI?.run==='function')candidates.push({name:'workers_ai',model:WORKERS_MODEL,dailyLimit:20});
 return candidates;
}

export function completionRequest(provider,messages,tools,remaining){
 const options=provider.name==='openrouter'
  ?{max_tokens:1600,provider:{require_parameters:true,data_collection:'deny'}}
  :{max_completion_tokens:1600,...(tools.length?{parallel_tool_calls:false}:{}),...(/^openai\/gpt-oss-(?:20|120)b$/.test(provider.model)?{include_reasoning:false,reasoning_effort:'low'}:{})};
 return {method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+provider.key,'content-type':'application/json'},
  body:JSON.stringify({model:provider.model,messages,...(tools.length?{tools,tool_choice:'auto'}:{}),temperature:0.2,...options}),
  signal:AbortSignal.timeout(Math.min(15000,remaining))};
}

// Some reasoning models require these opaque details on tool continuations.
// They stay in this request's context, never in Telegram, logs or the ledger.
export function toolAssistant(message){
 return {role:'assistant',content:message.content??null,tool_calls:message.tool_calls,
  ...(Array.isArray(message.reasoning_details)?{reasoning_details:message.reasoning_details}:{})};
}

function validMessage(message,tools){
 if(message?.tool_calls==null||Array.isArray(message.tool_calls)&&!message.tool_calls.length){
  return typeof message?.content==='string'&&!!message.content.trim();
 }
 if(!Array.isArray(message.tool_calls)||message.tool_calls.length!==1)return false;
 const call=message.tool_calls[0];
 if(typeof call?.id!=='string'||!call.id||!tools.some(t=>t.function.name===call.function?.name)||typeof call.function.arguments!=='string')return false;
 try{const args=JSON.parse(call.function.arguments);return args!=null&&typeof args==='object'&&!Array.isArray(args);}catch{return false;}
}
export function toolGenerationFailed(status,data){
 return status===400&&(data?.error?.code==='tool_use_failed'||data?.error?.failed_generation!=null);
}

function workersText(response){
 if(typeof response?.response==='string')return response.response;
 return Array.isArray(response?.output)?response.output.filter(x=>x.type==='message'&&x.role==='assistant').flatMap(x=>Array.isArray(x.content)?x.content:[]).filter(x=>x.type==='output_text'&&typeof x.text==='string').map(x=>x.text).join('\n'):null;
}

// Workers AI is deliberately a text-only reserve. No tool transcript, ledger
// snapshot, private profile or provider-specific reasoning is forwarded to it.
export async function workersChat(ai,text,timeout){
 let timer;
 try{
  const result=await Promise.race([ai.run(WORKERS_MODEL,{messages:[{role:'system',content:'Ответь по-русски, тепло и коротко. У тебя нет доступа к журналу: не называй баланс и не утверждай, что провёл запись. На просьбу записать скажи, что сейчас не можешь её разобрать.'},{role:'user',content:text.slice(0,2500)}],max_tokens:512}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('brain_timeout')),timeout);})]);
  return workersText(result);
 }finally{clearTimeout(timer);}
}

export function modelSession(env,day,deadline,userText){
 const providers=modelCandidates(env).filter(p=>p.name!=='workers_ai'||userText!==null);
 const smallTalk=/^(?:(?:привет|салам)(?:[, ]+брат)?[.!?]?\s*)?(?:(?:как (?:ты|дела)|ты здесь)[?!.]?)?$/iu.test(userText??'');
 let index=0,attempts=0,formatRetry=false,plainRetry=false,last='brain_config';
 return async (messages,tools)=>{
  while(index<providers.length&&attempts<6){
   const provider=providers[index],left=providers.length-index-1;
   const remaining=deadline-Date.now();if(remaining<1000)throw Error('brain_timeout');
   const key=provider.name==='groq'?day:provider.name+':'+day;
   const budget=await run(env,'INSERT INTO budgets(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<?',key,provider.dailyLimit);
   if(!budget.meta.changes){last='brain_budget';index++;continue;}
   const time=deadline-Date.now();if(time<1000)throw Error('brain_timeout');
   const timeout=Math.min(15000,Math.max(Math.floor(time/(left+1)),time-left*5500));
   consumeRequest(env);attempts++;
   let status=0;
   try{
    if(provider.name==='workers_ai'){
     const content=await workersChat(env.AI,userText,timeout);
     if(validMessage({content},[]))return {message:{content},textOnly:true};
     last='brain_invalid';
    }else{
     // Only the originating provider can read its opaque reasoning state.
     const transcript=index===0?messages:messages.map(({reasoning_details,...message})=>message);
     const noToolTranscript=!messages.some(m=>m.role==='tool'||m.tool_calls?.length);
     const requestedTools=provider.name==='groq'&&noToolTranscript&&(plainRetry||index>0&&userText!==null&&smallTalk)?[]:tools;
     const res=await fetch(provider.url,completionRequest(provider,transcript,requestedTools,timeout));status=res.status;
     const data=await res.json().catch(()=>null);
     if(res.ok&&validMessage(data?.choices?.[0]?.message,requestedTools))return {message:data.choices[0].message};
     if(toolGenerationFailed(status,data)&&provider.name==='groq'&&requestedTools.length&&!formatRetry){
      formatRetry=true;
      plainRetry=userText!==null&&noToolTranscript;
      messages.push({role:'system',content:'Предыдущая генерация не прошла проверку формата. Для обычного разговора ответь текстом. Для записи вызови только один инструмент с точными именами параметров.'});
      continue;
     }
     last=status===429?'brain_rate':res.ok?'brain_invalid':'brain_unavailable';
    }
   }catch(error){last=error?.name==='TimeoutError'||error?.name==='AbortError'||error?.message==='brain_timeout'?'brain_timeout':'brain_unavailable';}
   if(left)console.log(JSON.stringify({event:'model_fallback',from:provider.name,to:providers[index+1].name,reason:last,status:status||null}));
   index++;
  }
  throw Error(last);
 };
}
