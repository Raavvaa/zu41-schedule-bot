import {one,run,clock,consumeBudget,audit} from './store.mjs';
export class ModelUnavailable extends Error{constructor(kind='unavailable'){super(kind);this.kind=kind;}}
export async function completion(env,messages,{tools,json=false,deadline=Date.now()+20000}={}){
 const chain=[{name:'groq',url:'https://api.groq.com/openai/v1/chat/completions',key:env.GROQ_API_KEY,model:env.GROQ_MODEL||'openai/gpt-oss-120b'},{name:'openrouter',url:'https://openrouter.ai/api/v1/chat/completions',key:env.OPENROUTER_API_KEY,model:env.OPENROUTER_MODEL||'openrouter/free'}];
 for(const p of chain){
  if(!p.key||Date.now()>deadline-1200)continue;
  const now=clock(env),state=await one(env,'SELECT blocked_until FROM providers WHERE name=?',[p.name]);
  if(state?.blocked_until>now)continue;
  const day=new Date(now).toISOString().slice(0,10),used=await one(env,'SELECT tokens FROM usage WHERE day=?',[day]);
  if(used?.tokens>=60000||!await consumeBudget(env))throw new ModelUnavailable('budget');
  const body={model:p.model,messages,temperature:0.35,...(p.name==='groq'?{max_completion_tokens:850,reasoning_effort:'low'}:{max_tokens:850,provider:{require_parameters:true}}),...(tools?{tools,tool_choice:'auto',parallel_tool_calls:false}:{}),...(json?{response_format:{type:'json_object'}}:{})};
  let response,data;
  try{response=await (env.FETCH||fetch)(p.url,{method:'POST',headers:{Authorization:'Bearer '+p.key,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1000,Math.min(p.name==='groq'?8000:10000,deadline-Date.now()-400)))});data=await response.json();}catch{await audit(env,'model_network');continue;}
  if(!response.ok){
   const retry=Number(response.headers.get('retry-after'));
   const wait=response.status===429?(Number.isFinite(retry)&&retry>0?Math.min(retry,86400)*1000:60000):[401,402,403].includes(response.status)?3600000:response.status>=500?15000:5000;
   await run(env,'INSERT INTO providers(name,blocked_until,kind) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET blocked_until=excluded.blocked_until,kind=excluded.kind',[p.name,now+wait,String(response.status)]);
   await audit(env,'model_http_'+response.status);continue;
  }
  const n=Number(data.usage?.total_tokens)||0;await run(env,'UPDATE usage SET tokens=tokens+? WHERE day=?',[n,day]);
  const message=data.choices?.[0]?.message;
  if(!message||(!message.content&&!message.tool_calls?.length)){await audit(env,'model_empty');continue;}
  return {message,provider:p.name,tokens:n};
 }
 throw new ModelUnavailable();
}
