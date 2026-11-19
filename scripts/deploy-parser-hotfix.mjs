import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const env=process.env;
const repo='Raavvaa/zu41-schedule-bot';
const branch='feat/shared-week-cache';
const name='mkgik-schedule-bot-v2';

if(env.GITHUB_REPOSITORY!==repo||env.GITHUB_REF_NAME!==branch)throw new Error('Unexpected repository or deployment branch');
if(env.FREE_PLAN_CONFIRMED!=='true')throw new Error('Workers Free plan must be confirmed before deployment');
for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','ADMIN_SECRET','TELEGRAM_BOT_TOKEN'])if(!env[key])throw new Error('Missing required Actions secret: '+key);

const sha=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Cannot determine source commit SHA');

async function request(url,{token='',method='GET',body}={}){
 let response,data;
 const headers={accept:'application/json'};
 if(token)headers.Authorization='Bearer '+token;
 if(body!==undefined)headers['content-type']='application/json';
 try{
  response=await fetch(url,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  data=await response.json();
 }catch{throw new Error('Service connection or JSON response failed; private details withheld');}
 if(!response.ok||data.success===false||data.ok===false)throw new Error('Service request failed: HTTP '+response.status);
 return data;
}
const cfBase='https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID;
const cf=async path=>(await request(cfBase+path,{token:env.CLOUDFLARE_API_TOKEN})).result;
const subdomain=await cf('/workers/subdomain');
const url=`https://${name}.${subdomain.subdomain}.workers.dev`;

const initial=await request(url+'/health');
if(initial.mode!=='active'||initial.shared_cache!==true||initial.owner_admin!==true||initial.fast_reply!=='true')throw new Error('Existing public Worker is not in the expected active configuration');

const db=(await cf('/d1/database')).find(x=>x.name===name);
if(!db)throw new Error('Existing D1 database not found; refusing to create or replace storage');
const queues=await cf('/queues');
if(!queues.some(x=>x.queue_name===name+'-ticks'))throw new Error('Existing queue not found; refusing to change queue topology');

const hook=await request('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getWebhookInfo');
if(hook.result?.url!==url+'/telegram')throw new Error('Telegram webhook points elsewhere; refusing to change it');

const config=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
config.d1_databases[0].database_id=db.uuid;
config.vars={
 ...config.vars,
 DELIVERY_ENABLED:'true',
 MAX_USERS:config.vars.MAX_USERS??'50',
 FAST_REPLY:'true',
 ADMIN_ENABLED:'true',
 SHARED_CACHE:'true',
 SOURCE_SHA:sha
};

const configName='.parser-hotfix-wrangler.json';
await writeFile('worker/'+configName,JSON.stringify(config),{mode:0o600});
try{
 const deployed=spawnSync('npx',['--no-install','wrangler','deploy','--config',configName],{
  cwd:'worker',env:{...env,WRANGLER_SEND_METRICS:'false'},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024
 });
 if(deployed.status!==0)throw new Error('Wrangler deployment failed; raw output withheld');

 let health=null;
 for(let i=0;i<15;i++){
  try{
   health=await request(url+'/health');
   if(health.source_sha===sha&&health.mode==='active'&&health.shared_cache===true&&health.owner_admin===true&&health.fast_reply==='true')break;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 if(!health||health.source_sha!==sha||health.mode!=='active')throw new Error('Exact deployed SHA and active mode were not confirmed');

 const ops=async path=>request(url+path,{token:env.ADMIN_SECRET,method:'POST',body:{}});
 const probe=await ops('/ops/probe');
 if(probe.source_status!=='confirmed'||probe.ok!==true)throw new Error('Live MS Timetables parser probe failed');
 const delivery=await ops('/ops/owner-test');
 if(delivery.ok!==true||!Number.isInteger(delivery.message_id))throw new Error('Telegram owner delivery was not confirmed');

 const finalHook=await request('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getWebhookInfo');
 if(finalHook.result?.url!==url+'/telegram')throw new Error('Telegram webhook changed unexpectedly');

 console.log('PARSER_HOTFIX_DEPLOYED '+JSON.stringify({
  source_sha:sha,version:health.version,mode:health.mode,shared_cache:health.shared_cache,
  group:probe.group,date:probe.date,lessons:probe.lessons,catalog_count:probe.catalog_count,
  live_source_confirmed:true,telegram_api_confirmed:true,owner_message_id:delivery.message_id,
  webhook_unchanged:true,d1_and_queue_preserved:true,free_plan_only:true
 }));
}finally{
 await unlink('worker/'+configName).catch(()=>{});
}
