import {one,run,clock,audit,budgets,reserveProvider,accountProvider} from './store.mjs';
export class ModelUnavailable extends Error {constructor(failures=[],remaining=[]){super('Provider request failed');this.failures=failures;this.remaining=remaining;this.kind=failures.at(-1)?.kind||'NETWORK_TIMEOUT';}}
export function parseJSON(text){try{return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{return null;}}
// Never echo arbitrary upstream text: it can contain prompts, identities or credentials.
export function safeErrorBody(data){const text=JSON.stringify(data).toLowerCase();return ['model','not found','unsupported','response_format','tools','invalid','rate limit','quota','authentication','permission','context length'].filter(s=>text.includes(s)).join('; ').slice(0,200)||'[upstream body withheld]';}
export const providerConfig=env=>[
 {name:'cloudflare',key:env.AI&&env.WORKERS_AI_ENABLED==='true'&&(!env.WORKERS_AI_MODEL||env.WORKERS_AI_MODEL==='@cf/meta/llama-3.3-70b-instruct-fp8-fast')?'binding':null,model:env.WORKERS_AI_MODEL||'@cf/meta/llama-3.3-70b-instruct-fp8-fast'},
 {name:'groq',base:'https://api.groq.com/openai/v1',key:env.GROQ_API_KEY,model:env.GROQ_MODEL||'openai/gpt-oss-120b'},
 {name:'siliconflow',base:(env.SILICONFLOW_BASE_URL||'https://api.siliconflow.com/v1').replace(/\/$/,''),key:env.SILICONFLOW_API_KEY,model:env.SILICONFLOW_CHAT_MODEL||'Qwen/Qwen2.5-7B-Instruct'},
 {name:'openrouter',base:'https://openrouter.ai/api/v1',key:env.OPENROUTER_API_KEY,model:env.OPENROUTER_MODEL||'openrouter/free'}].filter(p=>env.FREE_ONLY!=='true'||p.name==='cloudflare'||p.name==='groq'||(p.name==='openrouter'&&(p.model==='openrouter/free'||p.model.endsWith(':free'))));
export function diagnostic(error){if(!(error instanceof ModelUnavailable))return 'Не удалось обработать поручение. /stop и /status работают.';return error.failures.map(f=>`${f.kind}: ${f.provider}${f.status?' HTTP '+f.status:''}${f.retry_after?' retry_after='+f.retry_after+' сек.':''}${f.body?' '+f.body:''}`).join('\n')+'\nОстатки внутренних лимитов: '+error.remaining.filter(b=>error.failures.some(f=>f.provider===b.provider)).map(b=>`${b.provider}: ${b.requests} запросов, ${b.tokens} токенов`).join('; ');}
export async function completion(env,messages,{tools,json=false,deadline=Date.now()+20000,only}={}){
 const failures=[];
 for(const p of providerConfig(env)){
  if(!p.key||(only&&p.name!==only))continue;
  const now=clock(env),state=await one(env,'SELECT * FROM providers WHERE name=?',[p.name]);
  if(state?.blocked_until>now){failures.push({kind:state.kind==='429'?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP_ERROR',provider:p.name,status:Number(state.kind)||undefined,retry_after:Math.ceil((state.blocked_until-now)/1000)});continue;}
  const day=await reserveProvider(env,p.name);if(!day){failures.push({kind:'BUDGET_INTERNAL',provider:p.name});continue;}
  if(Date.now()>deadline-100){failures.push({kind:'NETWORK_TIMEOUT',provider:p.name});continue;}
  let input=messages,body={model:p.model,messages:input,temperature:0.35,...(p.name==='groq'?{max_completion_tokens:850,reasoning_effort:'low'}:{max_tokens:850})};
  if(tools&&p.name==='groq')Object.assign(body,{tools,tool_choice:'required',parallel_tool_calls:false});
  else if(tools){body.messages=[{role:'system',content:'Select exactly one of the supplied tools. Return JSON {"name":"tool name","arguments":{...valid arguments for that tool...}}. For route, arguments contains action, params, confidence, explanation. Text and explanation are user-facing, in the user language; never output internal task summaries. Tool schemas: '+JSON.stringify(tools)},...messages.map(m=>m.role==='tool'?{role:'user',content:'Tool result: '+m.content}:m.tool_calls?{role:'assistant',content:'Previous tool request: '+JSON.stringify(m.tool_calls)}:m)];body.response_format={type:'json_object'};}
  if(json)body.response_format={type:'json_object'};
  // Free router models and the Workers AI binding differ in JSON-mode support.
  // Request JSON in the prompt and validate it locally instead of forwarding
  // an optional response_format that can make otherwise valid requests fail.
  if((json||tools)&&['cloudflare','openrouter'].includes(p.name)){delete body.response_format;body.messages=[{role:'system',content:'Return exactly one JSON object, no markdown or prose. Follow the requested fields and tool schemas.'},...body.messages];}
  let response,data;
  try{if(p.name==='cloudflare'){
   const {model,...params}=body;let timer;
   try{const result=await Promise.race([env.AI.run(model,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),Math.max(1,Math.min(Number(env.WORKERS_AI_TIMEOUT_MS)||4500,deadline-Date.now())));})]);data=result.choices?result:{choices:[{message:{role:'assistant',content:typeof result.response==='object'&&result.response!==null?JSON.stringify(result.response):result.response}}],usage:result.usage};response=Response.json(data);}
   catch(error){if(/timeout/i.test(String(error?.message)))throw error;const code=String(error?.message).match(/\b(?:30\d{2}|50\d{2})\b/)?.[0];const status=({3036:429,3040:429,3042:404,5028:410,5035:403,3006:413,3007:408,3008:408})[code];const f={kind:status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP_ERROR',provider:p.name,...(status?{status}:{}),body:(code?'Workers AI code '+code+'; ':'')+safeErrorBody({message:error?.message}),...(status===429?{retry_after:60}:{})};failures.push(f);await audit(env,f.kind+'_cloudflare_'+(code||'binding'));await run(env,'INSERT INTO providers(name,blocked_until,kind) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blocked_until=excluded.blocked_until,kind=excluded.kind',[p.name,now+(status===429?60:5)*1000,String(status||'binding')]);continue;}finally{clearTimeout(timer);}
  }else{response=await (env.FETCH||fetch)(p.base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+p.key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1,Math.min(Number(env[p.name.toUpperCase()+'_TIMEOUT_MS'])||(p.name==='groq'?4000:p.name==='siliconflow'?10000:6000),deadline-Date.now())))});const raw=await response.text();data=parseJSON(raw)||{};}}catch{failures.push({kind:'NETWORK_TIMEOUT',provider:p.name});await audit(env,'NETWORK_TIMEOUT_'+p.name);continue;}
  if(!response.ok){const retry=Number(response.headers.get('retry-after'))||60;const f={kind:response.status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_HTTP_ERROR',provider:p.name,status:response.status,body:safeErrorBody(data),...(response.status===429?{retry_after:retry}:{})};failures.push(f);await run(env,'INSERT INTO providers(name,blocked_until,kind) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blocked_until=excluded.blocked_until,kind=excluded.kind',[p.name,now+(response.status===429?Math.min(retry,86400):5)*1000,String(response.status)]);await audit(env,f.kind+'_'+p.name+'_'+response.status);continue;}
  const n=Number(data.usage?.total_tokens)||new TextEncoder().encode(JSON.stringify(body)).length+850;await accountProvider(env,p.name,day,n);
  let message=data.choices?.[0]?.message;
  if(tools&&p.name!=='groq'&&message?.content){let x=parseJSON(message.content);if(x?.action)x={name:'route',arguments:x};if(x&&tools.some(t=>t.function.name===x.name)&&x.arguments&&typeof x.arguments==='object')message={role:'assistant',tool_calls:[{id:'json-tool',type:'function',function:{name:x.name,arguments:JSON.stringify(x.arguments)}}]};}
  if((json&&!parseJSON(message?.content))||(tools&&p.name!=='groq'&&!message?.tool_calls?.length)||!message||(!message.content&&!message.tool_calls?.length)){failures.push({kind:'PROVIDER_HTTP_ERROR',provider:p.name,status:200,body:'invalid response'});continue;}
  return {message,provider:p.name,tokens:n};
 }
 throw new ModelUnavailable(failures,await budgets(env));
}

export async function embedding(env,text){if(env.FREE_ONLY==='true')return null;const p=providerConfig(env).find(p=>p.name==='siliconflow');if(!p.key)return null;const day=await reserveProvider(env,p.name);if(!day)return null;try{const r=await (env.FETCH||fetch)(p.base+'/embeddings',{method:'POST',headers:{Authorization:'Bearer '+p.key,'content-type':'application/json'},body:JSON.stringify({model:env.SILICONFLOW_EMBED_MODEL||'BAAI/bge-m3',input:String(text).slice(0,4000)}),signal:AbortSignal.timeout(1500)});if(!r.ok)return null;const d=await r.json(),v=d.data?.[0]?.embedding;await accountProvider(env,p.name,day,d.usage?.total_tokens||new TextEncoder().encode(text).length);return Array.isArray(v)&&v.length>0&&v.length<=4096&&v.every(x=>typeof x==='number'&&Number.isFinite(x))?v:null;}catch{return null;}}
