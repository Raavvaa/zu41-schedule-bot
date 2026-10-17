// New isolated Worker/database only. Secrets are stdin, never arguments or public files.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
const e=process.env,name='brat-sabunchi-accountant';
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||e.FREE_PLAN_CONFIRMED!=='true')throw Error('Repository/free-plan gate');
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','GROQ_API_KEY','OWNER_CHAT_ID','ADMIN_SECRET'])if(!e[k])throw Error('Missing secret '+k);
if(!/^[1-9]\d*$/.test(e.OWNER_CHAT_ID)||!Number.isSafeInteger(Number(e.OWNER_CHAT_ID)))throw Error('Invalid owner secret');
const sha=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
async function req(url,{token='',method='GET',body}={}){
 let r,d;try{r=await fetch(url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});d=await r.json();}catch{throw Error('Service connection failed; private details withheld');}
 if(!r.ok||d.success===false||d.ok===false)throw Error('Service returned HTTP '+r.status);return d;
}
const cf=async(path,method='GET',body)=>(await req('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,{token:e.CLOUDFLARE_API_TOKEN,method,body})).result;
const bot=await req('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/getMe');
if(String(bot.result.id)!=='8805667658')throw Error('Unexpected bot identity; schedule bot is protected');
const hookSecret=createHmac('sha256',e.ADMIN_SECRET).update('sabunchi-webhook:'+bot.result.id).digest('hex');
const adminSecret=createHmac('sha256',e.ADMIN_SECRET).update('sabunchi-ops:'+bot.result.id).digest('hex');
const models=await req('https://api.groq.com/openai/v1/models',{token:e.GROQ_API_KEY});
if(!models.data.some(x=>x.id==='whisper-large-v3-turbo'))throw Error('Speech model unavailable');
if(!models.data.some(x=>x.id==='openai/gpt-oss-20b'))throw Error('Selected Groq model unavailable');
let db=(await cf('/d1/database')).find(x=>x.name===name);
if(!db)db=await cf('/d1/database','POST',{name});
const sql=async(s,params=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query','POST',{sql:s,params});return r[0].results;};
for(const statement of (await readFile('accountant/migrations/0001.sql','utf8')).split(';').filter(x=>x.trim()))await sql(statement);
if(!(await sql('PRAGMA table_info(outbox)')).some(x=>x.name==='last_error'))await sql('ALTER TABLE outbox ADD COLUMN last_error TEXT');
// Restore the default support preference only after a deployment first-contact 403,
// and only if there has never been a real owner update. Never override user settings.
await sql('UPDATE settings SET proactive=1 WHERE active=0 AND NOT EXISTS(SELECT 1 FROM updates WHERE id>=0)');
const sub=await cf('/workers/subdomain'),url=`https://${name}.${sub.subdomain}.workers.dev`;
const config=JSON.parse(await readFile('accountant/wrangler.jsonc','utf8'));
config.d1_databases[0].database_id=db.uuid;config.vars={...config.vars,SOURCE_SHA:sha};
const cli=(args,input)=>{const r=spawnSync('npx',['--no-install','wrangler',...args,'--config','.deploy.json'],{cwd:'accountant',env:{...e,WRANGLER_SEND_METRICS:'false'},...(input?{input}:{}),encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});if(r.status!==0)throw Error('Wrangler '+args[0]+' failed; output withheld');};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let activated=false;
try{
 config.vars.ENABLED='false';await writeFile('accountant/.deploy.json',JSON.stringify(config),{mode:0o600});cli(['deploy']);
 cli(['secret','bulk'],JSON.stringify({TELEGRAM_BOT_TOKEN:e.TELEGRAM_BOT_TOKEN,GROQ_API_KEY:e.GROQ_API_KEY,OWNER_CHAT_ID:e.OWNER_CHAT_ID,WEBHOOK_SECRET:hookSecret,ADMIN_SECRET:adminSecret,...(e.OWNER_CONTEXT?{OWNER_CONTEXT:e.OWNER_CONTEXT}:{})}));
 config.vars.ENABLED='true';await writeFile('accountant/.deploy.json',JSON.stringify(config),{mode:0o600});cli(['deploy']);activated=true;await sleep(15000);
 let health;
 for(let i=0;i<12;i++){try{health=await req(url+'/health');if(health.sha===sha&&health.enabled)break;}catch{}await sleep(1500);}
 if(health?.sha!==sha||!health.enabled)throw Error('Live version not confirmed');
 const probe=await req(url+'/ops/probe',{token:adminSecret,method:'POST',body:{}});if(!probe.ok)throw Error('Live Groq probe failed');
 await req('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/setWebhook',{method:'POST',body:{url:url+'/telegram',secret_token:hookSecret,allowed_updates:['message','callback_query'],max_connections:2,drop_pending_updates:false}});
 const hook=await req('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/getWebhookInfo');if(hook.result.url!==url+'/telegram')throw Error('Webhook not confirmed');
 await cf('/workers/scripts/'+name+'/schedules','PUT',[{cron:'* * * * *'}]);
 const id=-Date.now(),owner=Number(e.OWNER_CHAT_ID);
 let r;for(let attempt=0;attempt<3;attempt++){r=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':hookSecret},body:JSON.stringify({update_id:id,message:{from:{id:owner},chat:{id:owner,type:'private'},text:'/balance'}}),signal:AbortSignal.timeout(10000)});if(r.ok)break;await sleep(3000);}if(!r.ok)throw Error('Owner live test HTTP '+r.status);
 let out;
 for(let i=0;i<25;i++){out=(await sql('SELECT state,message_id,last_error FROM outbox WHERE id=?',[String(id)]))[0];if(out&&out.state!=='pending'&&out.state!=='sending')break;await sleep(1000);}
 let state;for(let i=0;i<20;i++){state=(await sql('SELECT last_cron,active FROM settings WHERE id=1'))[0];if(state.last_cron>0&&Date.now()-state.last_cron<180000)break;await sleep(3000);}
 console.log('ACCOUNTANT_LIVE '+JSON.stringify({worker:url,bot_username:bot.result.username,private:true,groq:probe.ok,model:probe.model,webhook:true,telegram_confirmed:out?.state==='sent',message_id:out?.message_id??null,delivery_state:out?.state??'pending',telegram_error:out?.last_error??null,needs_start:out?.last_error==='403',cron_configured:true,cron_seen:state.last_cron>0&&Date.now()-state.last_cron<180000,ledger_transactions:(await sql('SELECT count(*) AS n FROM transactions'))[0].n,sha}));
 // Synthetic Russian voice is sent only to owner; it requests a balance, never a ledger mutation.
 const voiceForm=new FormData();voiceForm.set('chat_id',e.OWNER_CHAT_ID);voiceForm.set('caption','Проверка голосового помощника: синтетический голос просит показать баланс. Деньги эта проверка не меняет.');voiceForm.set('voice',new Blob([await readFile('/tmp/accountant-voice.ogg')],{type:'audio/ogg'}),'check.ogg');
 let uploaded;try{const vr=await fetch('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/sendVoice',{method:'POST',body:voiceForm,signal:AbortSignal.timeout(15000)});uploaded=await vr.json();}catch{throw Error('Voice transport test failed');}
 if(!uploaded.ok||!uploaded.result?.voice)throw Error('Telegram voice upload not confirmed');
 const voiceId=-Date.now();const inbound=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':hookSecret},body:JSON.stringify({update_id:voiceId,message:{from:{id:owner},chat:{id:owner,type:'private'},voice:uploaded.result.voice}}),signal:AbortSignal.timeout(10000)});
 if(!inbound.ok)throw Error('Voice webhook rejected');let voiceOut;
 for(let i=0;i<35;i++){voiceOut=(await sql('SELECT state,message_id,payload,last_error FROM outbox WHERE id=?',[String(voiceId)]))[0];if(voiceOut&&voiceOut.state!=='pending'&&voiceOut.state!=='sending')break;await sleep(1000);}
 const voiceOk=voiceOut?.state==='sent'&&/Я услышал/.test(JSON.parse(voiceOut.payload).text)&&/баланс/i.test(JSON.parse(voiceOut.payload).text);
 console.log('VOICE_LIVE '+JSON.stringify({delivery_state:voiceOut?.state??'absent',telegram_error:voiceOut?.last_error??null,transcribed:voiceOk,telegram_confirmed:voiceOut?.state==='sent',message_id:voiceOut?.message_id??null,model:'whisper-large-v3-turbo',no_financial_confirmation_sent:true}));
 if(!voiceOk)throw Error('Voice preview not verified');
 const conversation=spawnSync('node',['accountant/verify-conversation.mjs'],{env:{...e,EXPECTED_SHA:sha},stdio:'inherit',timeout:240000});if(conversation.status!==0)throw Error('Production conversation not verified');
 if(out?.state!=='sent')console.log('PHONE_STEP: Open bot and press Start; Telegram may forbid first contact. No duplicate resend attempted.');
}catch(error){
 if(activated)console.log('Verification failed; accountant kept enabled to preserve availability. No ledger changes.');
 throw error;
}finally{await unlink('accountant/.deploy.json').catch(()=>{});}
