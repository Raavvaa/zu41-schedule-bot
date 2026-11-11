import {one,run,clock,audit,budgets,reserveProvider,accountProvider} from './store.mjs';
export class ModelUnavailable extends Error {constructor(failures=[],remaining=[]){super('Provider request failed');this.failures=failures;this.remaining=remaining;this.kind=failures.at(-1)?.kind||'NETWORK_TIMEOUT';}}
export function parseJSON(text){try{return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{return null;}}
// Never echo arbitrary upstream text: it can contain prompts, identities or credentials.
const errorCodes=new Set(['tool_use_failed','invalid_request_error','invalid_api_key','model_not_found','model_not_available','rate_limit_exceeded','insufficient_quota','context_length_exceeded','content_policy_violation','authentication_error','permission_denied','unsupported_parameter','invalid_parameter']);
const errorTypes=new Set(['invalid_request_error','authentication_error','permission_error','rate_limit_error','server_error','api_error','not_found_error']);
export function safeErrorBody(data){const text=JSON.stringify(data??{}).toLowerCase(),e=data?.error;return [errorCodes.has(e?.code)?'code='+e.code:'',errorTypes.has(e?.type)?'type='+e.type:'',...['model','not found','unsupported','response_format','tools','invalid','rate limit','quota','authentication','permission','context length'].filter(s=>text.includes(s))].filter(Boolean).join('; ').slice(0,300)||'[upstream body withheld]';}
// Only documented assistant fields may re-enter a request or reach the agent.
// Reasoning, provider metadata and arbitrary response fields are never text.
export function assistantMessage(message){if(!message||typeof message!=='object')return null;const out={role:'assistant',content:typeof message.content==='string'?message.content:null};if(Array.isArray(message.tool_calls))out.tool_calls=message.tool_calls.filter(t=>t?.type==='function'&&typeof t.id==='string'&&typeof t.function?.name==='string'&&(typeof t.function.arguments==='string'||t.function.arguments&&typeof t.function.arguments==='object')).map(t=>({id:t.id,type:'function',function:{name:t.function.name,arguments:typeof t.function.arguments==='string'?t.function.arguments:JSON.stringify(t.function.arguments)}}));return out;}

const NVIDIA_BOLT='nvidia/nemotron-3.5-bolt-e4b';
const NVIDIA_GEMMA='google/gemma-4-31b-it';

function nvidiaConfig(env){
 const model=env.NVIDIA_MODEL||NVIDIA_BOLT;
 const supported=model===NVIDIA_BOLT||model===NVIDIA_GEMMA;
 return {
  name:'nvidia',
  base:'https://integrate.api.nvidia.com/v1',
  key:env.NVIDIA_ENABLED==='true'&&supported?env.NVIDIA_API:null,
  model
 };
}

export const providerConfig=env=>[
 nvidiaConfig(env),
 {name:'cloudflare',key:env.AI&&env.WORKERS_AI_ENABLED==='true'&&(!env.WORKERS_AI_MODEL||env.WORKERS_AI_MODEL==='@cf/meta/llama-3.3-70b-instruct-fp8-fast')?'binding':null,model:env.WORKERS_AI_MODEL||'@cf/meta/llama-3.3-70b-instruct-fp8-fast'},
 {name:'groq',base:'https://api.groq.com/openai/v1',key:env.GROQ_API_KEY,model:env.GROQ_MODEL||'openai/gpt-oss-120b'},
 {name:'siliconflow',base:(env.SILICONFLOW_BASE_URL||'https://api.siliconflow.com/v1').replace(/\/$/,''),key:env.SILICONFLOW_API_KEY,model:env.SILICONFLOW_CHAT_MODEL||'Qwen/Qwen2.5-7B-Instruct'},
 {name:'openrouter',base:'https://openrouter.ai/api/v1',key:env.OPENROUTER_API_KEY,model:env.OPENROUTER_MODEL||'openrouter/free'}].filter(p=>env.FREE_ONLY!=='true'||p.name==='nvidia'||p.name==='cloudflare'||p.name==='groq'||(p.name==='openrouter'&&(p.model==='openrouter/free'||p.model.endsWith(':free'))));
export function providerNames(env){
 const names={nvidia:'NVIDIA',cloudflare:'Cloudflare Workers AI',groq:'Groq',siliconflow:'SiliconFlow',openrouter:'OpenRouter'};
 return providerConfig(env).filter(provider=>provider.key).map(provider=>names[provider.name]).join(', ')||'доступным провайдером моделей';
}
export function diagnostic(error){if(!(error instanceof ModelUnavailable))return 'Не удалось обработать поручение. /stop и /status работают.';return error.failures.map(f=>`${f.kind}: ${f.provider}${f.status?' HTTP '+f.status:''}${f.retry_after?' retry_after='+f.retry_after+' сек.':''}${f.kind==='DEADLINE_EXCEEDED'?' запрос не отправлен: время обработки истекло':''}${f.body?' '+f.body:''}`).join('\n')+'\nОстатки внутренних лимитов: '+error.remaining.filter(b=>error.failures.some(f=>f.provider===b.provider)).map(b=>`${b.provider}: ${b.requests} запросов, ${b.tokens} токенов`).join('; ');}
export async function completion(env,messages,{tools,json=false,deadline=Date.now()+20000,only,retryLast}={}){
 const failures=[];
 const providers=providerConfig(env);
 if(retryLast){
  const index=providers.findIndex(provider=>provider.name===retryLast);
  if(index>=0)providers.push(...providers.splice(index,1));
 }
 for(const p of providers){
  if(!p.key||(only&&p.name!==only))continue;
  if(Date.now()>deadline-100){failures.push({kind:'DEADLINE_EXCEEDED',provider:p.name});continue;}
  const now=clock(env),state=await one(env,'SELECT * FROM providers WHERE name=?',[p.name]);
  if(state?.blocked_until>now){failures.push({kind:state.kind==='429'?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP_ERROR',provider:p.name,status:Number(state.kind)||undefined,retry_after:Math.ceil((state.blocked_until-now)/1000)});continue;}
  if(Date.now()>deadline-100){failures.push({kind:'DEADLINE_EXCEEDED',provider:p.name});continue;}
  const day=await reserveProvider(env,p.name);if(!day){failures.push({kind:'BUDGET_INTERNAL',provider:p.name});continue;}
  // D1 can consume the remaining time while reserving. Refund only this unsent
  // reservation; attempted HTTP requests still count, including 429/400.
  if(Date.now()>deadline-100){await run(env,'UPDATE provider_usage SET requests=MAX(0,requests-1) WHERE day=? AND provider=?',[day,p.name]);failures.push({kind:'DEADLINE_EXCEEDED',provider:p.name});continue;}
  let input=messages,body={model:p.model,messages:input,temperature:0.35,...(p.name==='groq'?{max_completion_tokens:850,reasoning_effort:'low'}:{max_tokens:850})};
  if(tools&&p.name==='groq')Object.assign(body,{tools,tool_choice:'required',parallel_tool_calls:false});
  else if(tools){body.messages=[{role:'system',content:'Select exactly one of the supplied tools. Return JSON {"name":"tool name","arguments":{...valid arguments for that tool...}}. For route, arguments contains action, params, confidence, explanation. Text and explanation are user-facing, in the user language; never output internal task summaries. Tool schemas: '+JSON.stringify(tools)},...messages.map(m=>m.role==='tool'?{role:'user',content:'Tool result: '+m.content}:m.tool_calls?{role:'assistant',content:'Previous tool request: '+JSON.stringify(m.tool_calls)}:m)];body.response_format={type:'json_object'};}
  if(json)body.response_format={type:'json_object'};
  // Free router models and the Workers AI binding differ in JSON-mode support.
  // Request JSON in the prompt and validate it locally instead of forwarding
  // an optional response_format that can make otherwise valid requests fail.
  if((json||tools)&&['cloudflare','openrouter','nvidia'].includes(p.name)){delete body.response_format;body.messages=[{role:'system',content:'Return exactly one JSON object, no markdown or prose. Follow the requested fields and tool schemas.'},...body.messages];}
  let response,data;
  try{if(p.name==='cloudflare'){
   const {model,...params}=body;let timer;
   try{const result=await Promise.race([env.AI.run(model,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),Math.max(1,Math.min(Number(env.WORKERS_AI_TIMEOUT_MS)||4500,deadline-Date.now())));})]);if(result?.success===false){const e=result.errors?.[0],code=String(e?.code||''),quota=['3036','3040'].includes(code);failures.push({kind:quota?'PROVIDER_RATE_LIMIT':'PROVIDER_RESPONSE_ERROR',provider:p.name,...(quota?{status:429,retry_after:60}:{}),body:(/^(?:30|50)\d{2}$/.test(code)?'Workers AI code '+code+'; ':'')+safeErrorBody({error:e})});await audit(env,'PROVIDER_RESPONSE_ERROR_cloudflare');await run(env,'INSERT INTO providers(name,blocked_until,kind) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blocked_until=excluded.blocked_until,kind=excluded.kind',[p.name,now+(quota?60000:5000),quota?'429':'binding']);continue;}else{data=result?.choices?result:{choices:[{message:{role:'assistant',content:typeof result?.response==='object'&&result.response!==null?JSON.stringify(result.response):result?.response}}],usage:result?.usage};response=Response.json(data);}}
   catch(error){if(/timeout/i.test(String(error?.message)))throw error;const code=String(error?.message).match(/\b(?:30\d{2}|50\d{2})\b/)?.[0];const status=({3036:429,3040:429,3042:404,5028:410,5035:403,3006:413,3007:408,3008:408})[code];const f={kind:status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP_ERROR',provider:p.name,...(status?{status}:{}),body:(code?'Workers AI code '+code+'; ':'')+safeErrorBody({message:error?.message}),...(status===429?{retry_after:60}:{})};failures.push(f);await audit(env,f.kind+'_cloudflare_'+(code||'binding'));await run(env,'INSERT INTO providers(name,blocked_until,kind) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blocked_until=excluded.blocked_until,kind=excluded.kind',[p.name,now+(status===429?60:5)*1000,String(status||'binding')]);continue;}finally{clearTimeout(timer);}
  }else{response=await (env.FETCH||fetch)(p.base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+p.key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1,Math.min(Number(env[p.name.toUpperCase()+'_TIMEOUT_MS'])||(p.name==='nvidia'?3000:p.name==='groq'?4000:p.name==='siliconflow'?10000:6000),deadline-Date.now())))});const raw=await response.text();data=parseJSON(raw)||{};}}catch{failures.push({kind:'NETWORK_TIMEOUT',provider:p.name});await audit(env,'NETWORK_TIMEOUT_'+p.name);continue;}
  if(!response.ok){const retry=Number(response.headers.get('retry-after'))||60;const f={kind:response.status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP_ERROR',provider:p.name,status:response.status,body:safeErrorBody(data),...(response.status===429?{retry_after:retry}:{})};failures.push(f);await run(env,'INSERT INTO providers(name,blocked_until,kind) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blocked_until=excluded.blocked_until,kind=excluded.kind',[p.name,now+(response.status===429?Math.min(retry,86400):5)*1000,String(response.status)]);await audit(env,f.kind+'_'+p.name+'_'+response.status);continue;}
  const n=Number(data.usage?.total_tokens)||new TextEncoder().encode(JSON.stringify(body)).length+850;await accountProvider(env,p.name,day,n);
  let message=assistantMessage(data.choices?.[0]?.message);
  if(tools&&p.name!=='groq'&&message?.content){let x=parseJSON(message.content);if(x?.action)x={name:'route',arguments:x};if(x&&tools.some(t=>t.function.name===x.name)&&x.arguments&&typeof x.arguments==='object')message={role:'assistant',tool_calls:[{id:'json-tool',type:'function',function:{name:x.name,arguments:JSON.stringify(x.arguments)}}]};}
  if((json&&!parseJSON(message?.content))||(tools&&p.name!=='groq'&&!message?.tool_calls?.length)||!message||(!message.content&&!message.tool_calls?.length)){failures.push({kind:'PROVIDER_HTTP_ERROR',provider:p.name,status:200,body:'invalid response'+(data.choices?.[0]?.finish_reason==='length'?'; finish_reason=length':'')});continue;}
  return {message,provider:p.name,tokens:n};
 }
 throw new ModelUnavailable(failures,await budgets(env));
}

export async function embedding(env,text){if(env.FREE_ONLY==='true')return null;const p=providerConfig(env).find(p=>p.name==='siliconflow');if(!p.key)return null;const day=await reserveProvider(env,p.name);if(!day)return null;try{const r=await (env.FETCH||fetch)(p.base+'/embeddings',{method:'POST',headers:{Authorization:'Bearer '+p.key,'content-type':'application/json'},body:JSON.stringify({model:env.SILICONFLOW_EMBED_MODEL||'BAAI/bge-m3',input:String(text).slice(0,4000)}),signal:AbortSignal.timeout(1500)});if(!r.ok)return null;const d=await r.json(),v=d.data?.[0]?.embedding;await accountProvider(env,p.name,day,d.usage?.total_tokens||new TextEncoder().encode(text).length);return Array.isArray(v)&&v.length>0&&v.length<=4096&&v.every(x=>typeof x==='number'&&Number.isFinite(x))?v:null;}catch{return null;}}
