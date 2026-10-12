// Controlled public cutover. Credentials come exclusively from Actions Secrets.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const env=process.env,repo='Raavvaa/zu41-schedule-bot',name='mkgik-schedule-bot-v2';
if(env.GITHUB_REPOSITORY!==repo||env.FREE_PLAN_CONFIRMED!=='true')throw new Error('Repository/Free plan check failed');
for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','OWNER_CHAT_ID','ADMIN_SECRET','WEBHOOK_SECRET','GH_TOKEN'])if(!env[key])throw new Error('Missing secret: '+key);
async function request(url,token,method='GET',body){
 let r;try{r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});}catch{throw new Error('Service connection failed');}
 if(r.status===204)return null;
 let j;try{j=await r.json();}catch{throw new Error('Service returned non-JSON: HTTP '+r.status);}
 if(!r.ok||j.success===false||j.ok===false)throw new Error('Service request failed: HTTP '+r.status);
 return j;
}
const cf=async(path,method='GET',body)=>(await request('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+path,env.CLOUDFLARE_API_TOKEN,method,body)).result;
const gh=(path,method='GET',body)=>request('https://api.github.com/repos/'+repo+path,env.GH_TOKEN,method,body);
async function tg(method,body){
 // Never include the token-bearing URL in exceptions or logs.
 return request('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,'','POST',body);
}
function deploy(){
 const r=spawnSync('npx',['--no-install','wrangler','deploy','--config','.deploy-config.json'],{cwd:'worker',env:{...env,WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 if(r.status!==0)throw new Error('Worker deploy failed; raw output withheld');
}
const sub=await cf('/workers/subdomain'),url=`https://${name}.${sub.subdomain}.workers.dev`;
const worker=(path,body={})=>request(url+path,env.ADMIN_SECRET,'POST',body);
const probe=await worker('/ops/probe');
console.log('Confirmed source:',JSON.stringify(probe));
const before=await worker('/ops/status');
if(!before.last_cron||!before.last_consumer)throw new Error('Cron/queue execution is not confirmed');
const db=(await cf('/d1/database')).find(x=>x.name===name);
if(!db||(await cf('/queues')).filter(x=>x.queue_name===name+'-ticks').length!==1)throw new Error('Existing storage/queue missing');
const config=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
config.d1_databases[0].database_id=db.uuid;
config.vars.DELIVERY_ENABLED='false';
const old=await gh('/actions/workflows/schedule.yml');
for(const status of ['queued','in_progress']){
 const runs=await gh('/actions/workflows/schedule.yml/runs?per_page=5&status='+status);
 if(runs.workflow_runs.length)throw new Error('Old sender is still running; cutover postponed');
}
const webhook=await tg('getWebhookInfo',{});
if(webhook.result.url!==url+'/telegram')throw new Error('Unexpected webhook destination');
let disabled=false,attempted=false,activeVerified=false;
await writeFile('worker/.deploy-config.json',JSON.stringify(config),{mode:0o600});
try{
 if(old.state==='active'){await gh('/actions/workflows/schedule.yml/disable','PUT');disabled=true;}
 if((await gh('/actions/workflows/schedule.yml')).state==='active')throw new Error('Old morning workflow was not disabled');
 config.vars.DELIVERY_ENABLED='true';
 await writeFile('worker/.deploy-config.json',JSON.stringify(config),{mode:0o600});attempted=true;deploy();
 let health;
 for(let i=0;i<12;i++){
  try{health=await request(url+'/health','');if(health.mode==='active')break;}catch{}
  await new Promise(r=>setTimeout(r,2000));
 }
 if(health?.mode!=='active')throw new Error('Public mode was not confirmed');
 await tg('setWebhook',{url:url+'/telegram',secret_token:env.WEBHOOK_SECRET,allowed_updates:['message','callback_query'],max_connections:4,drop_pending_updates:false});
 const info=await tg('getWebhookInfo',{});
 if(info.result.url!==url+'/telegram'||info.result.last_error_date>Math.floor(Date.now()/1000)-120)throw new Error('Webhook check failed');
 const status=await worker('/ops/status');
 if(status.mode!=='true')throw new Error('Scheduler is not active');
 // Replan existing subscriptions, with no historical reminders. Only aggregate data is logged.
 const count=await cf('/d1/database/'+db.uuid+'/query','POST',{sql:'SELECT count(*) AS n FROM users WHERE blocked=0'});
 console.log('Existing active subscriptions:',count[0].results[0].n);
 activeVerified=true;
 const live=await worker('/ops/owner-test');
 console.log('Owner Telegram API delivery:',JSON.stringify(live));
 console.log('Public access enabled:',url);
 console.log('Webhook verified; minute scheduler active; old morning Actions disabled.');
 console.log('Initial registration capacity: 50; full-college load has not been verified.');
}catch(error){
 if(!activeVerified){
  let stopped=!attempted;
  if(attempted){
   try{config.vars.DELIVERY_ENABLED='false';await writeFile('worker/.deploy-config.json',JSON.stringify(config),{mode:0o600});deploy();stopped=(await request(url+'/health','')).mode==='staging';}catch{}
  }
  if(stopped&&disabled)await gh('/actions/workflows/schedule.yml/enable','PUT');
  console.log(stopped?'Rollback: staging restored; old sender restored if disabled by this run.':'Rollback incomplete; old sender remains disabled to prevent duplicates.');
 }else console.log('Public access remains active; final owner delivery check failed or uncertain. No automatic resend.');
 throw error;
}finally{await unlink('worker/.deploy-config.json').catch(()=>{});}
