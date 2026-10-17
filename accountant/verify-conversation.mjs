// Owner-only production dialogue probe. Logs metadata, never text, IDs or credentials.
import {createHmac} from 'node:crypto';
const e=process.env,url='https://brat-sabunchi-accountant.loxazavr.workers.dev';
if(e.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||!/^\d+$/.test(e.OWNER_CHAT_ID??''))throw Error('Probe gate');
async function request(url,options={}){let r;try{r=await fetch(url,{...options,signal:AbortSignal.timeout(15000)});}catch{throw Error('Probe network failure');}if(!r.ok)throw Error('Probe HTTP '+r.status);return r.json();}
const headers={Authorization:'Bearer '+e.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
const api='https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID;
const health=await request(url+'/health');if(!health.enabled||health.sha!==e.EXPECTED_SHA)throw Error('Unexpected live source');
const databases=await request(api+'/d1/database',{headers});const db=databases.result.find(x=>x.name==='brat-sabunchi-accountant');if(!db)throw Error('Database not found');
async function sql(query,params){const d=await request(api+'/d1/database/'+db.uuid+'/query',{method:'POST',headers,body:JSON.stringify({sql:query,params})});if(!d.success)throw Error('Probe database failure');return d.result[0].results;}
const now=Date.now();console.log('QUEUE_STATE '+JSON.stringify({updates:await sql('SELECT state,count(*) n, min(created_at)-? oldest_offset FROM updates GROUP BY state',[now]),outbox:await sql('SELECT state,count(*) n,min(created_at)-? oldest_offset,min(due)-? due_offset FROM outbox GROUP BY state',[now,now]),locks:await sql('SELECT name,expires-? remaining_ms FROM locks',[now]),service:await sql('SELECT telegram_pause-? pause_ms,?-last_cron cron_age_ms FROM settings WHERE id=1',[now,now])}));
const secret=createHmac('sha256',e.ADMIN_SECRET).update('sabunchi-webhook:8805667658').digest('hex');
for(const [scenario,text] of [['recall','Брат, напомни че у меня там'],['conversation','Брат, что с тобой? Давай просто поговорим.']]){
 const started=Date.now(),id=-Date.now(),owner=Number(e.OWNER_CHAT_ID);
 await request(url+'/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:id,message:{from:{id:owner},chat:{id:owner,type:'private'},text}})});
 let row;for(let i=0;i<90;i++){row=(await sql('SELECT state,message_id,payload,last_error FROM outbox WHERE id=?',[String(id)]))[0];if(row&&row.state!=='pending'&&row.state!=='sending')break;await new Promise(r=>setTimeout(r,1000));}
 const reply=row?.payload?JSON.parse(row.payload).text:'';
 const valid=(scenario!=='conversation'||!/Брат, по записям|Подтверждённых записей/.test(reply))&&row?.state==='sent'&&reply.length>10&&!/уточни: это уже|Для записи нужны|Groq сейчас недоступен/.test(reply);
 const proposed=(await sql('SELECT id FROM drafts WHERE id=? UNION ALL SELECT id FROM transactions WHERE id=?',[String(id),String(id)])).length;
 console.log('CONVERSATION_LIVE '+JSON.stringify({scenario,elapsed_ms:Date.now()-started,balance_response:/Брат, по записям/.test(reply),telegram_confirmed:row?.state==='sent',message_id:row?.message_id??null,valid,no_ledger_proposal:proposed===0,delivery_state:row?.state??'absent',telegram_error:row?.last_error??null}));
 if(!valid||proposed)throw Error('Live conversation not verified');
}
