// Fixed endpoints only. A configured key never silently changes the provider.
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

export function completionRequest(provider,messages,tools,remaining){
 const options=provider.name==='openrouter'
  ?{max_tokens:1600,provider:{require_parameters:true,data_collection:'deny'}}
  :{max_completion_tokens:1600};
 return {method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+provider.key,'content-type':'application/json'},
  body:JSON.stringify({model:provider.model,messages,tools,tool_choice:'auto',parallel_tool_calls:false,temperature:0.2,...options}),
  signal:AbortSignal.timeout(Math.min(15000,remaining))};
}

// Some reasoning models require these opaque details on tool continuations.
// They stay in this request's context, never in Telegram, logs or the ledger.
export function toolAssistant(message){
 return {role:'assistant',content:message.content??null,tool_calls:message.tool_calls,
  ...(Array.isArray(message.reasoning_details)?{reasoning_details:message.reasoning_details}:{})};
}
