// Live read-only health checks + three real requests in the consenting owner's chat.
// No student messages, Telegram IDs, credentials or private service errors are logged.
import {createHash} from 'node:crypto';
const e=process.env,name='mkgik-schedule-bot-v2';
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot')throw new Error('Wrong repository');
for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','OWNER_CHAT_ID','WEBHOOK_SECRET'])if(!e[k])throw new Error('Missing secret '+k);
async function cf(path,body){
 let r,j;try{r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+e.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});j=await r.json();}catch{throw new Error('Cloudflare query failed; private details withheld');}
 if(!r.ok||j.success!==true)throw new Error('Cloudflare check rejected: HTTP '+r.status);return j.result;
}
const db=(await cf('/d1/database')).find(x=>x.name===name),sub=await cf('/workers/subdomain');if(!db)throw new Error('Database missing');
const url=`https://${name}.${sub.subdomain}.workers.dev`;
const h=await fetch(url+'/health',{signal:AbortSignal.timeout(15000)}).then(r=>r.json());
if(h.mode!=='active'||h.fast_reply!=='true'||!h.source_sha)throw new Error('Public fast replies are not active');
console.log('LIVE_VERSION '+JSON.stringify(h));
const sql=async(query,params=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query',{sql:query,params});return r[0].results;};
const prefs=async()=>createHash('sha256').update(JSON.stringify(await sql('SELECT user_id,chat_id,group_id,group_name,subgroup,morning_time,morning_enabled,reminders_enabled,reminder_minutes,send_empty,paused_until,blocked,revision,changed_at FROM users ORDER BY user_id'))).digest('hex');
const before=await prefs(),owner=Number(e.OWNER_CHAT_ID);
if(!(await sql('SELECT 1 AS yes FROM users WHERE user_id=? AND blocked=0',[owner])).length)throw new Error('Owner subscription missing');
const start=Date.now(),ids=[-start,-start-1,-start-2],texts=['/menu','📅 Сегодня','📆 Завтра'];
// Serial HTTP acknowledgements do not wait for background Telegram delivery.
// This exercises contention/continuation without racing changes to preferences.
const ack=[];
for(let i=0;i<ids.length;i++){
 let r;const t=Date.now();try{r=await fetch(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':e.WEBHOOK_SECRET},body:JSON.stringify({update_id:ids[i],message:{from:{id:owner},chat:{id:owner,type:'private'},text:texts[i]}}),signal:AbortSignal.timeout(20000)});}catch{throw new Error('Owner webhook ambiguous; no automatic resend');}
 if(!r.ok)throw new Error('Owner webhook failed; no automatic resend');ack.push(Date.now()-t);
}
const params=[owner,...ids.map(id=>owner+'|reply|'+id+'|%')];
const query="SELECT job_key,state,sent_at-created_at AS ms,message_id,last_error FROM jobs WHERE user_id=? AND kind='reply' AND (job_key LIKE ? OR job_key LIKE ? OR job_key LIKE ?) ORDER BY created_at,rowid";
let jobs=[];
for(let i=0;i<35;i++){
 jobs=await sql(query,params);
 const complete=ids.every(id=>jobs.some(j=>j.job_key.startsWith(owner+'|reply|'+id+'|')));
 if(complete&&jobs.every(j=>j.state==='sent'))break;
 if(jobs.some(j=>['failed','uncertain','blocked'].includes(j.state)))throw new Error('Telegram delivery failed/uncertain; no resend');
 await new Promise(r=>setTimeout(r,1000));
}
if(!ids.every(id=>jobs.some(j=>j.job_key.startsWith(owner+'|reply|'+id+'|')))||jobs.some(j=>j.state!=='sent'||!Number.isInteger(j.message_id)))throw new Error('Burst delivery not confirmed');
if(await prefs()!==before)throw new Error('Preferences changed during verification');
console.log('OWNER_BURST '+JSON.stringify({requests:ids.length,telegram_confirmed:true,message_ids:jobs.map(j=>j.message_id),delivery_ms:jobs.map(j=>j.ms),webhook_ack_ms:ack,total_observed_ms:Date.now()-start,preferences_unchanged:true}));
if(Math.max(...jobs.map(j=>j.ms))>20000)throw new Error('Burst delivery exceeded expected fast-path threshold');
const runtime=await sql("SELECT name,value FROM meta WHERE name IN ('last_cron','last_consumer')");
console.log('RUNTIME '+JSON.stringify({cron_recent:runtime.some(x=>x.name==='last_cron'&&Date.now()-Number(x.value)<180000),consumer_recent:runtime.some(x=>x.name==='last_consumer'&&Date.now()-Number(x.value)<180000)}));
