// Read-only runtime diagnosis except adding this bot's missing minute trigger and
// an optional plain-text owner delivery check after Telegram recognizes the chat.
const e=process.env,name='brat-sabunchi-accountant';
const call=async(url,method='GET',body,token='')=>{let r,d;try{r=await fetch(url,{method,headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});d=await r.json();}catch{throw Error('Connection failed; private details withheld');}return {http:r.status,...d};};
const cf=async(path,method='GET',body)=>{const r=await call('https://api.cloudflare.com/client/v4/accounts/'+e.CLOUDFLARE_ACCOUNT_ID+path,method,body,e.CLOUDFLARE_API_TOKEN);if(!r.success)throw Error('Cloudflare check failed: '+r.http);return r.result;};
const db=(await cf('/d1/database')).find(x=>x.name===name);if(!db)throw Error('Accountant database missing');
const sql=async(s,p=[])=>{const r=await cf('/d1/database/'+db.uuid+'/query','POST',{sql:s,params:p});return r[0].results;};
const getChat=await call('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/getChat','POST',{chat_id:e.OWNER_CHAT_ID});
const classify=d=>/chat not found/i.test(d??'')?'chat_not_found':/blocked/i.test(d??'')?'blocked':/keyboard|markup/i.test(d??'')?'keyboard_invalid':'other';
console.log('TELEGRAM_CHAT '+JSON.stringify({ok:getChat.ok===true,error:getChat.error_code??null,reason:getChat.ok?null:classify(getChat.description)}));
if(getChat.ok){const sent=await call('https://api.telegram.org/bot'+e.TELEGRAM_BOT_TOKEN+'/sendMessage','POST',{chat_id:e.OWNER_CHAT_ID,text:'Брат, проверка связи: личный бухгалтер развёрнут. Начнём с реальных остатков, деньги без подтверждения не записываю.'});console.log('OWNER_PLAIN_SEND '+JSON.stringify({ok:sent.ok===true,error:sent.error_code??null,reason:sent.ok?null:classify(sent.description),message_id:sent.result?.message_id??null}));}
let schedules=(await cf('/workers/scripts/'+name+'/schedules')).schedules;
if(!schedules.some(s=>s.cron==='* * * * *'))schedules=(await cf('/workers/scripts/'+name+'/schedules','PUT',[{cron:'* * * * *'}])).schedules;
console.log('CRON_REGISTERED '+JSON.stringify({minute:schedules.some(s=>s.cron==='* * * * *')}));
let state;
for(let i=0;i<45;i++){state=(await sql('SELECT last_cron,active,proactive FROM settings WHERE id=1'))[0];if(state.last_cron>0&&Date.now()-state.last_cron<180000)break;await new Promise(r=>setTimeout(r,3000));}
console.log('CRON_RUNTIME '+JSON.stringify({seen:state.last_cron>0,age_seconds:state.last_cron?Math.round((Date.now()-state.last_cron)/1000):null,active:!!state.active,proactive_preference:!!state.proactive}));
