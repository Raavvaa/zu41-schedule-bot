// Existing accountant only. No production D1 queries, migrations, secret writes,
// webhook rewrites, financial probes, or schedule-bot actions.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const name='brat-sabunchi-accountant';
const defaultRun=(command,args,options)=>{
 const r=spawnSync(command,args,{...options,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 if(r.status!==0)throw Error('release_command_failed');
 return r.stdout.trim(); // Do not log CLI output or private binding metadata.
};
export async function releaseUpdate({env=process.env,sourceDir,fetcher=fetch,run=defaultRun,wait=ms=>new Promise(r=>setTimeout(r,ms)),emit=console.log}){
 if(env.GITHUB_REPOSITORY!=='Raavvaa/zu41-schedule-bot'||env.GITHUB_REF!=='refs/heads/deploy/brat-accountant'||env.FREE_PLAN_CONFIRMED!=='true')throw Error('release_gate');
 for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','OWNER_CHAT_ID','AUTHORIZED_SOURCE_SHA'])if(!env[key])throw Error('release_missing_configuration');
 if(!/^[a-f0-9]{40}$/.test(env.AUTHORIZED_SOURCE_SHA)||!/^\d+$/.test(env.OWNER_CHAT_ID))throw Error('release_invalid_configuration');
 const sha=run('git',['rev-parse','HEAD'],{cwd:sourceDir});
 if(sha!==env.AUTHORIZED_SOURCE_SHA)throw Error('release_source_mismatch');
 const config=JSON.parse(await readFile(resolve(sourceDir,'accountant/wrangler.jsonc'),'utf8'));
 if(config.name!==name||config.main!=='src/index.mjs'||config.d1_databases?.length!==1||config.d1_databases[0].binding!=='DB')throw Error('release_target_mismatch');
 const request=async(url,options={})=>{
  let r,d;try{r=await fetcher(url,{...options,signal:AbortSignal.timeout(20000)});d=await r.json();}catch{throw Error('release_network_failure');}
  if(!r.ok||d.success===false||d.ok===false)throw Error('release_service_rejected');return d;
 };
 const cf=async(path,body)=>(await request('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})).result;
 const tg=async(method,body)=>request('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body??{})});
 const sub=await cf('/workers/subdomain');
 if(!/^[a-z0-9-]+$/.test(sub.subdomain))throw Error('release_domain_mismatch');
 const url='https://'+name+'.'+sub.subdomain+'.workers.dev';
 const health=await request(url+'/health');
 if(!health.ok||!health.enabled||!health.private||!health.agent_tools||!/^[a-f0-9]{40}$/.test(health.sha??''))throw Error('release_existing_worker_unhealthy');
 const hook=await tg('getWebhookInfo');if(hook.result?.url!==url+'/telegram')throw Error('release_bot_mismatch');
 const chat=await tg('getChat',{chat_id:env.OWNER_CHAT_ID});
 if(chat.result?.type!=='private'||String(chat.result.id)!==env.OWNER_CHAT_ID)throw Error('release_owner_mismatch');
 const settings=await cf('/workers/scripts/'+name+'/settings');
 const bindings=settings.bindings??[],db=bindings.find(b=>b.name==='DB'&&b.type==='d1');
 if(!db?.id)throw Error('release_database_binding_missing');
 for(const secret of ['TELEGRAM_BOT_TOKEN','GROQ_API_KEY','OWNER_CHAT_ID','WEBHOOK_SECRET','ADMIN_SECRET'])if(!bindings.some(b=>b.name===secret&&b.type==='secret_text'))throw Error('release_secret_binding_missing');
 if(bindings.some(b=>!['plain_text','json','secret_text','secret_key'].includes(b.type)&&!(b.name==='DB'&&b.type==='d1')))throw Error('release_unexpected_binding');
 const schedules=await cf('/workers/scripts/'+name+'/schedules');
 if(schedules.schedules?.length!==1||schedules.schedules[0].cron!=='* * * * *')throw Error('release_schedule_mismatch');
 const previous=(await cf('/workers/scripts/'+name+'/deployments')).deployments?.[0];
 if(previous?.versions?.length!==1||previous.versions[0].percentage!==100)throw Error('release_rollback_target_ambiguous');
 emit(JSON.stringify({event:'release_preflight',ok:true,previous_sha:health.sha,target_sha:sha}));
 config.d1_databases[0].database_id=db.id;
 config.vars={...config.vars,SOURCE_SHA:sha,ENABLED:'true'};
 const path=resolve(sourceDir,'accountant/.release.json');
 let attempted=false;
 async function verifiedHealth(expected){
  for(let i=0;i<15;i++){try{const h=await request(url+'/health');if(h.sha===expected&&h.enabled&&h.private&&h.agent_tools)return true;}catch{}await wait(2000);}
  return false;
 }
 try{
  await writeFile(path,JSON.stringify(config),{mode:0o600});
  attempted=true;
  run('npx',['--no-install','wrangler','deploy','--config','.release.json','--keep-vars','--no-x-auto-create'],{cwd:resolve(sourceDir,'accountant'),env:{...env,WRANGLER_SEND_METRICS:'false',CI:'true'}});
  if(!await verifiedHealth(sha))throw Error('release_health_failed');
  const after=await cf('/workers/scripts/'+name+'/settings');
  if(after.bindings?.find(b=>b.name==='DB'&&b.type==='d1')?.id!==db.id)throw Error('release_binding_changed');
  for(const b of bindings.filter(b=>b.type==='secret_text'||b.type==='secret_key'))if(!after.bindings.some(a=>a.name===b.name&&a.type===b.type))throw Error('release_secret_missing_after_update');
  if((await tg('getWebhookInfo')).result?.url!==hook.result.url)throw Error('release_webhook_changed');
 }catch(error){
  if(attempted){
   let rollback=false;
   try{await cf('/workers/scripts/'+name+'/deployments',{strategy:'percentage',versions:previous.versions,annotations:{'workers/message':'Restore preceding version after failed accountant update'}});rollback=await verifiedHealth(health.sha);}catch{}
   emit(JSON.stringify({event:'release_rollback',ok:rollback,restored_sha:rollback?health.sha:null}));
  }
  throw error;
 }finally{await unlink(path).catch(()=>{});}
 // One owner-only delivery check, without an inbound financial event.
 let delivered=false;
 try{const sent=await tg('sendMessage',{chat_id:env.OWNER_CHAT_ID,text:'Брат, обновление установлено. Поправил различие между разговором и просьбой записать деньги. Можешь писать обычным языком; записи по-прежнему требуют подтверждения.'});delivered=sent.ok===true&&Number.isSafeInteger(sent.result?.message_id);}catch{}
 emit(JSON.stringify({event:'release_result',health_verified:true,source_sha:sha,previous_sha:health.sha,telegram_confirmed:delivered,financial_test_in_production:false,production_d1_queries:0}));
 if(!delivered)throw Error('release_deployed_but_delivery_unconfirmed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 releaseUpdate({sourceDir:resolve(process.argv[2]??'.')}).catch(error=>{console.error(String(error.message).startsWith('release_')?error.message:'release_failed_private_details_withheld');process.exitCode=1;});
}
