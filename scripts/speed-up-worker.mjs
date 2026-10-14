// Controlled in-place performance update. Only current Actions Secrets are used.
// No raw service errors, Telegram URLs, identifiers or message text enter logs.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const e=process.env,name='mkgik-schedule-bot-v2';
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||e.FREE_PLAN_CONFIRMED!=='true')throw new Error('Repository / confirmed Free plan required');
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','OWNER_CHAT_ID','ADMIN_SECRET','WEBHOOK_SECRET','GH_TOKEN'])if(!e[k])throw new Error('Missing secret '+k);
const sha=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Source SHA missing');
async function request(url,token,body,method=body?'POST':'GET'){
 let r,j;
 try{r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});j=await r.json();}catch{throw new Error('Service connection/response failed; private details withheld');}
 if(!r.ok||j.success===false||j.ok===false)throw new Error('Service check failed: HTTP '+r.status);
 return j;
}
const cf=async(path,body)=>(await request('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,e.CLOUDFLARE_API_TOKEN,body)).result;
const tg=(method,body={})=>request('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/'+method,'',body);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sub=await cf('/workers/subdomain'),url=`https://${name}.${sub.subdomain}.workers.dev`;
const ops=(path)=>request(url+path,e.ADMIN_SECRET,{});
const db=(await cf('/d1/database')).find(x=>x.name===name);
if(!db)throw new Error('Existing database missing');
const query=async(sql,params=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query',{sql,params});if(r[0].success===false)throw new Error('D1 query failed');return r[0].results;};
const old=await request('https://api.github.com/repos/Raavvaa/zu41-schedule-bot/actions/workflows/schedule.yml',e.GH_TOKEN);
if(old.state!=='disabled_manually')throw new Error('Legacy sender must remain disabled');
const initialHealth=await request(url+'/health','');
if(initialHealth.mode!=='active')throw new Error('Existing public bot is not active');
const initialHook=await tg('getWebhookInfo');
if(initialHook.result.url!==url+'/telegram')throw new Error('Unexpected webhook; refusing to replace it');
const probe=await ops('/ops/probe');
if(probe.source_status!=='confirmed')throw new Error('Live Cloudflare source access failed');
console.log('Cloudflare live source verified:',JSON.stringify(probe));
const history=await query("SELECT sent_at-created_at AS ms FROM jobs WHERE kind='reply' AND state='sent' AND created_at>=? ORDER BY ms",[Date.parse('2026-10-12T21:32:12Z')]);
const values=history.map(x=>x.ms).filter(x=>x>=0),percentile=p=>values.length?values[Math.ceil(values.length*p)-1]:null;
console.log('BASELINE_REPLY_LATENCY '+JSON.stringify({n:values.length,p50_ms:percentile(.5),p95_ms:percentile(.95),max_ms:values.at(-1)??null,over_5000:values.filter(x=>x>5000).length,over_20000:values.filter(x=>x>20000).length,note:'Old immediate-send timestamps precede the Telegram response; these are lower bounds, not end-to-end measurements.'}));
const prefs=async()=>createHash('sha256').update(JSON.stringify(await query('SELECT user_id,chat_id,group_id,group_name,subgroup,morning_time,morning_enabled,reminders_enabled,reminder_minutes,send_empty,paused_until,blocked,revision,changed_at FROM users ORDER BY user_id'))).digest('hex');
const before=await prefs();
if(!(await query('SELECT 1 AS yes FROM users WHERE user_id=? AND blocked=0',[Number(e.OWNER_CHAT_ID)])).length)throw new Error('Owner subscription missing');
// Additive index only. No preferences or historical jobs are rewritten.
await query(await readFile('worker/migrations/0002_reply_order.sql','utf8'));
const config=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
config.d1_databases[0].database_id=db.uuid;
config.vars={...config.vars,DELIVERY_ENABLED:'true',SOURCE_SHA:sha,FAST_REPLY:'owner'};
async function deploy(){
 await writeFile('worker/.speed-config.json',JSON.stringify(config),{mode:0o600});
 const r=spawnSync('npx',['--no-install','wrangler','deploy','--config','.speed-config.json'],{cwd:'worker',env:{...e,WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 if(r.status!==0)throw new Error('Deploy failed; raw output withheld');
 for(let i=0;i<15;i++){
  try{const h=await request(url+'/health','');if(h.source_sha===sha&&h.fast_reply===config.vars.FAST_REPLY&&h.mode==='active')return h;}catch{}
  await sleep(2000);
 }
 throw new Error('Exact deployed SHA / feature mode not confirmed');
}
async function ownerTrial(text,label){
 // Negative IDs cannot collide with normal Telegram-generated positive update IDs.
 const id=-Date.now();const started=Date.now();
 let response;
 try{response=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},body:JSON.stringify({update_id:id,message:{from:{id:Number(e.OWNER_CHAT_ID)},chat:{id:Number(e.OWNER_CHAT_ID),type:'private'},text}}),signal:AbortSignal.timeout(30000)});}catch{throw new Error('Owner webhook result uncertain; no automatic replay');}
 if(!response.ok)throw new Error('Owner webhook failed; no automatic replay');
 const ackMs=Date.now()-started;
 let jobs=[];
 for(let i=0;i<30;i++){
  jobs=await query("SELECT state,message_id,sent_at,created_at FROM jobs WHERE user_id=? AND kind='reply' AND job_key LIKE ? ORDER BY created_at,rowid",[Number(e.OWNER_CHAT_ID),String(e.OWNER_CHAT_ID)+'|reply|'+id+'|%']);
  if(jobs.length&&jobs.every(j=>j.state==='sent'))break;
  if(jobs.some(j=>['failed','uncertain','blocked'].includes(j.state)))throw new Error('Owner delivery failed or uncertain; no automatic resend');
  await sleep(1000);
 }
 if(!jobs.length||jobs.some(j=>j.state!=='sent'||!Number.isInteger(j.message_id)))throw new Error('Owner delivery not confirmed');
 const result={scenario:label,parts:jobs.length,webhook_ack_ms:ackMs,telegram_confirmed:true,message_ids:jobs.map(j=>j.message_id),delivery_ms:jobs.map(j=>j.sent_at-j.created_at),observed_ms:Date.now()-started};
 console.log('OWNER_FAST_REPLY '+JSON.stringify(result));
 if(Math.max(...result.delivery_ms)>25000)throw new Error('Owner fast reply exceeded canary threshold');
 // Exact webhook replay must not create another job or Telegram send.
 const previous=JSON.stringify(jobs);
 const duplicate=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},body:JSON.stringify({update_id:id,message:{from:{id:Number(e.OWNER_CHAT_ID)},chat:{id:Number(e.OWNER_CHAT_ID),type:'private'},text}}),signal:AbortSignal.timeout(15000)});
 if(!duplicate.ok)throw new Error('Duplicate webhook check failed');
 await sleep(1200);
 const after=await query("SELECT state,message_id,sent_at,created_at FROM jobs WHERE user_id=? AND kind='reply' AND job_key LIKE ? ORDER BY created_at,rowid",[Number(e.OWNER_CHAT_ID),String(e.OWNER_CHAT_ID)+'|reply|'+id+'|%']);
 if(JSON.stringify(after)!==previous)throw new Error('Duplicate webhook changed deliveries');
 console.log('Duplicate owner webhook: unchanged durable deliveries');
 return result;
}
let deployed=false;
try{
 await deploy();deployed=true;console.log('Canary active for owner; public subscriptions remain enabled. Source SHA:',sha);
 await ownerTrial('🗓 Неделя','owner real weekly schedule');
 if(await prefs()!==before)throw new Error('Subscription preferences changed during canary; public rollout stopped');
 config.vars.FAST_REPLY='true';const health=await deploy();
 await ownerTrial('/menu','owner menu after public rollout');
 if(await prefs()!==before)throw new Error('Subscription preferences changed during test');
 const info=await tg('getWebhookInfo');
 if(info.result.url!==initialHook.result.url||info.result.last_error_date>Math.floor(Date.now()/1000)-120)throw new Error('Webhook health check failed');
 const status=await ops('/ops/status');
 if(status.mode!=='true'||Date.now()-Number(status.last_cron)>180000||Date.now()-Number(status.last_consumer)>180000)throw new Error('Minute scheduler / consumer heartbeat stale');
 console.log('FINAL_HEALTH '+JSON.stringify(health));
 console.log('FINAL_RUNTIME '+JSON.stringify({webhook_verified:true,pending_updates:info.result.pending_update_count,cron_recent:true,consumer_recent:true,queue_used_today:status.queue_budget,preferences_unchanged:true,legacy_sender_disabled:true}));
 console.log('Public fast replies deployed:',url);
}catch(error){
 if(deployed){try{config.vars.FAST_REPLY='false';await deploy();console.log('Rollback: fast path disabled; public bot and minute scheduler remain active.');}catch{console.log('Rollback verification incomplete; inspect health before retrying.');}}
 throw error;
}finally{await unlink('worker/.speed-config.json').catch(()=>{});}
