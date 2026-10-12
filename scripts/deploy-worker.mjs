// Run only through the explicit GitHub deployment workflow. Never prints credentials.
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,unlink} from 'node:fs/promises';
const env=process.env;const mode=env.DEPLOY_MODE??'staging';
if(env.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot')throw new Error('Unexpected repository');
if(env.FREE_PLAN_CONFIRMED!=='true')throw new Error('Confirm Workers Free in the Cloudflare dashboard before deploying');
for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','OWNER_CHAT_ID','WEBHOOK_SECRET','ADMIN_SECRET'])if(!env[key])throw new Error('Missing secret: '+key);
const name='mkgik-schedule-bot-v2';const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
async function api(path,method='GET',body){
 let r;try{r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}catch{throw new Error('Cloudflare connection failed');}
 const j=await r.json();if(!r.ok||!j.success)throw new Error('Cloudflare request failed: HTTP '+r.status);return j.result;
}
function command(args,input){
 const r=spawnSync('npx',['--no-install','wrangler',...args],{cwd:'worker',env:{...env,WRANGLER_SEND_METRICS:'false'},input,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 if(r.status!==0)throw new Error('Wrangler operation failed; credentials/output withheld: '+args[0]);return r.stdout;
}
async function workerApi(path){
 const r=await fetch(env.WORKER_URL+path,{method:'POST',headers:{Authorization:'Bearer '+env.ADMIN_SECRET,'content-type':'application/json'},body:'{}'});
 const data=await r.json();if(!r.ok||data.ok===false)throw new Error('Worker verification failed: '+path);return data;
}
const config=JSON.parse(await readFile('worker/wrangler.jsonc','utf8'));
const databases=await api('/d1/database');let db=databases.find(x=>x.name===name);
if(!db)db=await api('/d1/database','POST',{name});
const queues=await api('/queues');if(!queues.some(q=>q.queue_name===name+'-ticks'))await api('/queues','POST',{queue_name:name+'-ticks'});
config.d1_databases[0].database_id=db.uuid;
config.vars.DELIVERY_ENABLED='false';
await writeFile('worker/.deploy-config.json',JSON.stringify(config),{mode:0o600});
try{
 command(['d1','migrations','apply',name,'--remote','--config','.deploy-config.json']);
 command(['deploy','--config','.deploy-config.json']);
 command(['secret','bulk','--config','.deploy-config.json'],JSON.stringify({TELEGRAM_BOT_TOKEN:env.TELEGRAM_BOT_TOKEN,OWNER_CHAT_ID:env.OWNER_CHAT_ID,WEBHOOK_SECRET:env.WEBHOOK_SECRET,ADMIN_SECRET:env.ADMIN_SECRET,...(env.GROQ_API_KEY?{GROQ_API_KEY:env.GROQ_API_KEY}:{})}));
 const subdomain=await api('/workers/subdomain');env.WORKER_URL=`https://${name}.${subdomain.subdomain}.workers.dev`;
 const probe=await workerApi('/ops/probe');console.log('Remote source verified:',JSON.stringify(probe));
 if(mode==='staging'){
  const live=await workerApi('/ops/owner-test');console.log('Owner-only Telegram API confirmation:',JSON.stringify(live));
  console.log('Staging deployed:',env.WORKER_URL);console.log('Webhook unchanged. Existing Actions schedule remains active.');
 } else throw new Error('Only staging deployment is enabled until remote CPU/cron and owner dialogs are reviewed');
}finally{await unlink('worker/.deploy-config.json').catch(()=>{});}
