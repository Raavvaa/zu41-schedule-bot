// Read-only operational metadata. Never logs IDs, messages, tokens or API URLs.
const e=process.env;
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||e.GITHUB_REF!=='refs/heads/feat/panda-agent-20261110')throw Error('Diagnostic repository/branch guard');
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','PANDA_BOT_TOKEN','OWNER_ID'])if(!e[k])throw Error('Missing '+k);
async function request(url,body,token){
 let r,d;try{r=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});d=await r.json();}catch{throw Error('Diagnostic transport failed; private details withheld');}
 if(!r.ok||d.ok===false||d.success===false)throw Error('Diagnostic API status '+r.status);
 return d.result;
}
const tg=(method,body={})=>request('https://api.telegram.org/bot'+e.PANDA_BOT_TOKEN+'/'+method,body);
const cf=(path,body)=>request('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,body,e.CLOUDFLARE_API_TOKEN);
const bot=await tg('getMe');if(String(bot.id)!=='8976655600')throw Error('Diagnostic bot identity guard');
const hook=await tg('getWebhookInfo');
console.log('PANDA_DIAG_HOOK '+JSON.stringify({username:bot.username,business_mode:!!bot.can_connect_to_business,expected_url:hook.url==='https://panda-personal-agent.loxazavr.workers.dev/telegram',pending:hook.pending_update_count,last_error_date:hook.last_error_date??null,last_error_http:hook.last_error_message?.match(/\b[45]\d\d\b/)?.[0]??null,allowed_updates:hook.allowed_updates}));
const db=(await cf('/d1/database')).find(x=>x.name==='panda-personal-agent-'+bot.id);if(!db)throw Error('Panda database missing');
const sql=async(statement,params=[])=>{if(!/^SELECT\s/i.test(statement))throw Error('Read-only guard');const r=await cf('/d1/database/'+db.uuid+'/query',{sql:statement,params});if(!r[0]?.success)throw Error('Diagnostic query failed');return r[0].results;};
const connections=await sql('SELECT id,enabled,rights FROM connections');
const state={connections:connections.length,chats:await sql('SELECT kind,mode,count(*) AS n FROM chats GROUP BY kind,mode'),inbox:await sql('SELECT state,count(*) AS n FROM inbox GROUP BY state'),outbox:await sql('SELECT state,error,count(*) AS n FROM outbox GROUP BY state,error'),audit:await sql('SELECT kind,count(*) AS n FROM audit GROUP BY kind')};
console.log('PANDA_DIAG_STATE '+JSON.stringify(state));
const since=Date.now()-2*3600000;
console.log('PANDA_DIAG_DIALOGUE '+JSON.stringify({
 deliveries:await sql("SELECT mode,state,count(*) AS n,sum(CASE WHEN json_extract(payload,'$.text')='Привет!' THEN 1 ELSE 0 END) AS repeated_greeting FROM outbox WHERE scope<>'owner' AND at>? GROUP BY mode,state",[since]),
 duplicate_text_groups:await sql("SELECT count(*) AS n FROM (SELECT scope,json_extract(payload,'$.text'),count(*) AS copies FROM outbox WHERE scope<>'owner' AND state='sent' AND at>? GROUP BY scope,json_extract(payload,'$.text') HAVING copies>1)",[since]),
 context_rows:await sql("SELECT role,manual,count(*) AS n FROM messages WHERE scope<>'owner' AND at>? GROUP BY role,manual",[since]),
 proposals:await sql("SELECT kind,status,count(*) AS n FROM proposals WHERE at>? GROUP BY kind,status",[since])
}));
for(const c of connections){try{const live=await tg('getBusinessConnection',{business_connection_id:c.id});console.log('PANDA_DIAG_CONNECTION '+JSON.stringify({stored_enabled:!!c.enabled,live_enabled:!!live.is_enabled,owner_matches:String(live.user?.id)===String(e.OWNER_ID),can_reply:!!live.rights?.can_reply,can_read:!!live.rights?.can_read_messages}));}catch{console.log('PANDA_DIAG_CONNECTION lookup_failed');}}
