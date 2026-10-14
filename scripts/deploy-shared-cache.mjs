// Controlled shared-cache rollout. Current Secrets only; logs contain aggregates only.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const e=process.env,name='mkgik-schedule-bot-v2';
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||e.FREE_PLAN_CONFIRMED!=='true')throw new Error('Repository/Free plan check failed');
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','OWNER_CHAT_ID','WEBHOOK_SECRET','ADMIN_SECRET','TELEGRAM_BOT_TOKEN','GH_TOKEN'])if(!e[k])throw new Error('Missing secret '+k);
const sha=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Source SHA missing');
async function request(url,token,body){
 let r,j;try{r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});j=await r.json();}catch{throw new Error('Service connection failed; private details withheld');}
 if(!r.ok||j.success===false||j.ok===false)throw new Error('Service check failed: HTTP '+r.status);return j;
}
const cf=async(path,body)=>(await request('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,e.CLOUDFLARE_API_TOKEN,body)).result;
const db=(await cf('/d1/database')).find(x=>x.name===name),sub=await cf('/workers/subdomain');
if(!db)throw new Error('Existing database missing');
const url=`https://${name}.${sub.subdomain}.workers.dev`;
const sql=async(query,params=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query',{sql:query,params});return r[0].results;};
const prefs=async()=>createHash('sha256').update(JSON.stringify(await sql('SELECT user_id,chat_id,group_id,group_name,subgroup,morning_time,morning_enabled,reminders_enabled,reminder_minutes,send_empty,paused_until,blocked,revision,changed_at FROM users ORDER BY user_id'))).digest('hex');
const before=await prefs();
const old=await request('https://api.github.com/repos/Raavvaa/zu41-schedule-bot/actions/workflows/schedule.yml',e.GH_TOKEN);
if(old.state!=='disabled_manually')throw new Error('Legacy sender unexpectedly enabled');
const health=await request(url+'/health','');
if(health.mode!=='active'||health.fast_reply!=='true')throw new Error('Existing public fast sender not active');
const hook=await request('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/getWebhookInfo','',{});
if(hook.result.url!==url+'/telegram')throw new Error('Unexpected webhook destination');
const config=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
config.d1_databases[0].database_id=db.uuid;
config.vars={...config.vars,DELIVERY_ENABLED:'true',FAST_REPLY:'true',ADMIN_ENABLED:'true',SHARED_CACHE:'true',SOURCE_SHA:sha};
for(const statement of (await readFile('worker/migrations/0002_shared_cache.sql','utf8')).split(';').filter(x=>x.trim()))await sql(statement);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function deploy(){
 await writeFile('worker/.cache-config.json',JSON.stringify(config),{mode:0o600});
 const r=spawnSync('npx',['--no-install','wrangler','deploy','--config','.cache-config.json'],{cwd:'worker',env:{...e,WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 if(r.status!==0)throw new Error('Worker deployment failed; raw output withheld');
 for(let i=0;i<15;i++){
  try{const h=await request(url+'/health','');if(h.source_sha===sha&&h.shared_cache===(config.vars.SHARED_CACHE==='true')&&h.owner_admin===true&&h.mode==='active'&&h.fast_reply==='true')return h;}catch{}
  await sleep(2000);
 }
 throw new Error('Deployed version/flags not confirmed');
}
async function ownerToday(){
 const owner=Number(e.OWNER_CHAT_ID),id=-Date.now();
 let r;try{r=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},body:JSON.stringify({update_id:id,message:{from:{id:owner},chat:{id:owner,type:'private'},text:'📅 Сегодня'}}),signal:AbortSignal.timeout(20000)});}catch{throw new Error('Owner test uncertain; no resend');}
 if(!r.ok)throw new Error('Owner request failed; no resend');
 for(let i=0;i<30;i++){
  const job=(await sql('SELECT state,message_id,sent_at,created_at FROM jobs WHERE job_key=?',[owner+'|reply|'+id+'|0']))[0];
  if(job?.state==='sent'&&Number.isInteger(job.message_id))return {telegram_confirmed:true,message_id:job.message_id,delivery_ms:job.sent_at-job.created_at};
  if(job&&['failed','blocked','uncertain'].includes(job.state))throw new Error('Owner delivery failed or uncertain; no resend');
  await sleep(1000);
 }
 throw new Error('Owner Telegram delivery not confirmed');
}
let attempted=false;
try{
 const baseline=await ownerToday();console.log('BASELINE_OWNER_TODAY '+JSON.stringify(baseline));
 attempted=true;const h=await deploy();
 const probe=await request(url+'/ops/probe',e.ADMIN_SECRET,{});
 if(!probe.ok)throw new Error('Real source unavailable from Cloudflare');
 const cache=await request(url+'/ops/cache-check',e.ADMIN_SECRET,{});
 if(!cache.ok||!cache.samples.every(x=>x.cache_hit&&x.status==='confirmed'))throw new Error('Cache read not confirmed');
 const live=await ownerToday();
 if(await prefs()!==before)throw new Error('Subscription preferences changed during verification');
 const status=await request(url+'/ops/status',e.ADMIN_SECRET,{});
 if(status.mode!=='true'||Date.now()-Number(status.last_cron)>180000||Date.now()-Number(status.last_consumer)>180000)throw new Error('Scheduler heartbeat stale');
 console.log('CACHE_LIVE '+JSON.stringify({source_status:probe.source_status,catalog_count:probe.catalog_count,group:probe.group,date:probe.date,lessons:probe.lessons,cache_samples:cache.samples,...live,preferences_unchanged:true}));
 console.log('FINAL_HEALTH '+JSON.stringify(h));
 console.log('Existing webhook, owner-only admin, Cron and queue preserved. No paid resources created.');
}catch(error){
 if(attempted){try{config.vars.SHARED_CACHE='false';await deploy();console.log('Rollback: shared cache disabled; public fast bot and owner admin remain active.');}catch{console.log('Rollback not confirmed; inspect health before retrying.');}}
 throw error;
}finally{await unlink('worker/.cache-config.json').catch(()=>{});}
