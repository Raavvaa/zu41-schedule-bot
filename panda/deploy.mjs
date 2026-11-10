// Isolated Panda resources only. No credentials or owner identifiers in output.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
const e=process.env,name='panda-personal-agent';
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||e.GITHUB_REF!=='refs/heads/feat/panda-agent-20261110'||e.FREE_PLAN_CONFIRMED!=='true')throw Error('Repository, branch or free-plan gate failed');
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','PANDA_BOT_TOKEN','OWNER_ID','ADMIN_SECRET'])if(!e[k])throw Error('Missing secret '+k);
if(!e.GROQ_API_KEY&&!e.OPENROUTER_API_KEY)throw Error('No model credentials');
if(!/^[1-9]\d*$/.test(e.OWNER_ID)||!Number.isSafeInteger(Number(e.OWNER_ID)))throw Error('Invalid owner secret');
const sha=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid source revision');
async function request(url,{token='',method='GET',body}={}){
 let r,d,raw;try{r=await fetch(url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});raw=await r.text();}catch{throw Error('Remote transport failed; private details withheld');}
 try{d=JSON.parse(raw);}catch{const code=raw.match(/\b(1101|1102|1015)\b/)?.[1]||'none';throw Error('Non-JSON response HTTP '+r.status+' content-type '+String(r.headers.get('content-type')).slice(0,60)+' Cloudflare-code '+code);}
 if(!r.ok||d.success===false||d.ok===false)throw Error('Remote service HTTP '+r.status);return d;
}
const cf=async(path,method='GET',body)=>(await request('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,{token:e.CLOUDFLARE_API_TOKEN,method,body})).result;
const tg=async(method,body)=>(await request('https://api.telegram.org/bot'+e.PANDA_BOT_TOKEN+'/'+method,{method:'POST',body:body??{}})).result;
const bot=await tg('getMe');
if(!bot.is_bot||String(bot.id)!==e.PANDA_BOT_TOKEN.split(':')[0])throw Error('Panda identity check failed');
const hookSecret=createHmac('sha256',e.ADMIN_SECRET).update('panda-webhook:'+bot.id).digest('hex');
const adminSecret=createHmac('sha256',e.ADMIN_SECRET).update('panda-ops:'+bot.id).digest('hex');
let db=(await cf('/d1/database')).find(x=>x.name===name);
if(!db)db=await cf('/d1/database','POST',{name});
if(db.name!==name||!db.uuid)throw Error('Panda database guard');
const sql=async(statement,params=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query','POST',{sql:statement,params});if(!r?.[0]?.success)throw Error('Panda schema/query failed');return r[0].results;};
for(const statement of (await readFile('panda/migrations/0001.sql','utf8')).split(';').filter(x=>x.trim()))await sql(statement);
const sub=await cf('/workers/subdomain'),url=`https://${name}.${sub.subdomain}.workers.dev`;
const config=JSON.parse(await readFile('panda/wrangler.jsonc','utf8'));
if(config.name!==name||config.d1_databases.length!==1||config.d1_databases[0].database_name!==name)throw Error('Isolated resource guard');
config.d1_databases[0].database_id=db.uuid;config.vars={...config.vars,SOURCE_SHA:sha};
const cli=(args,input)=>{const r=spawnSync('npx',['--no-install','wrangler',...args,'--config','.deploy.json'],{cwd:'panda',env:{...e,WRANGLER_SEND_METRICS:'false'},...(input?{input}:{}),encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});if(r.status!==0)throw Error('Panda Wrangler '+args[0]+' failed; private output withheld');};
const save=()=>writeFile('panda/.deploy.json',JSON.stringify(config),{mode:0o600});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let activated=false;
try{
 config.vars.ENABLED='false';await save();cli(['deploy']);
 cli(['secret','bulk'],JSON.stringify({TELEGRAM_BOT_TOKEN:e.PANDA_BOT_TOKEN,OWNER_ID:e.OWNER_ID,GROQ_API_KEY:e.GROQ_API_KEY||'',OPENROUTER_API_KEY:e.OPENROUTER_API_KEY||'',WEBHOOK_SECRET:hookSecret,ADMIN_SECRET:adminSecret}));
 config.vars.ENABLED='true';await save();cli(['deploy']);activated=true;
 let health;for(let i=0;i<12;i++){try{health=await request(url+'/health');if(health.version===sha&&health.enabled)break;}catch{}await pause(1500);}
 if(health?.version!==sha||!health.enabled)throw Error('Live Panda version not confirmed');
 console.log('PANDA_STAGE live-model-probe');
 const probe=await request(url+'/ops/probe',{token:adminSecret,method:'POST',body:{}});
 if(!probe.ok)throw Error('Live Panda model not confirmed');
 await tg('setMyCommands',{commands:[{command:'start',description:'Знакомство и подключение'},{command:'chats',description:'Выбрать чат и режим'},{command:'status',description:'Состояние Панды'},{command:'memory',description:'Что я помню'},{command:'stop',description:'Остановить все автоответы'}]});
 await tg('setWebhook',{url:url+'/telegram',secret_token:hookSecret,allowed_updates:['message','callback_query','business_connection','business_message','edited_business_message','deleted_business_messages','my_chat_member'],max_connections:2,drop_pending_updates:false});
 const hook=await tg('getWebhookInfo');if(hook.url!==url+'/telegram')throw Error('Panda webhook not confirmed');
 // Owner-only /start exercises deployed ingestion, D1, outbox and Telegram.
 const id=-Date.now(),owner=Number(e.OWNER_ID);
 const res=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':hookSecret},body:JSON.stringify({update_id:id,message:{message_id:id,from:{id:owner},chat:{id:owner,type:'private'},text:'/start'}}),signal:AbortSignal.timeout(10000)});
 if(!res.ok)throw Error('Owner start check was not accepted');
 let out;for(let i=0;i<20;i++){out=(await sql('SELECT state,error FROM outbox WHERE id=?',['reply:'+id]))[0];if(out&&!['pending','sending'].includes(out.state))break;await pause(1000);}
 console.log('PANDA_LIVE '+JSON.stringify({worker:url,bot_username:bot.username,sha,model:probe.provider,webhook:true,telegram_confirmed:out?.state==='sent',delivery_state:out?.state??'pending',needs_start:out?.error==='403',business_mode_enabled:!!bot.can_connect_to_business,auto_default:false,isolated_database:true}));
 if(out?.state!=='sent')console.log('PHONE_STEP: Open the Panda bot and press Start. No delivery retry after an uncertain result.');
 if(!bot.can_connect_to_business)console.log('PHONE_STEP: Enable Business Mode in BotFather, then select Panda in Telegram Chat Automation.');
}catch(error){
 if(activated){try{config.vars.ENABLED='false';await save();cli(['deploy']);console.log('Panda disabled after failed verification. Other Workers untouched.');}catch{console.log('Panda disable not confirmed. Other Workers untouched.');}}
 throw error;
}finally{await unlink('panda/.deploy.json').catch(()=>{});}
