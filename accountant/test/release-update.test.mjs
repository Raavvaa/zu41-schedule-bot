import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseUpdate} from '../release-update.mjs';
const target='a'.repeat(40),prior='b'.repeat(40),name='brat-sabunchi-accountant';
const url=`https://${name}.fixture.workers.dev`;
async function fixture(failure){
 const sourceDir=await mkdtemp(join(tmpdir(),'accountant-release-'));
 await mkdir(join(sourceDir,'accountant'));
 await writeFile(join(sourceDir,'accountant/wrangler.jsonc'),JSON.stringify({name,main:'src/index.mjs',vars:{GROQ_MODEL:'openai/gpt-oss-120b'},d1_databases:[{binding:'DB',database_id:'placeholder'}]}));
 const env={GITHUB_REPOSITORY:'Raavvaa/zu41-schedule-bot',GITHUB_REF:'refs/heads/deploy/brat-accountant',FREE_PLAN_CONFIRMED:'true',CLOUDFLARE_API_TOKEN:'fixture-key',CLOUDFLARE_ACCOUNT_ID:'fixture-account',TELEGRAM_BOT_TOKEN:'fixture-bot-key',OWNER_CHAT_ID:'1001',AUTHORIZED_SOURCE_SHA:target};
 const bindings=[{name:'DB',type:'d1',id:'fixture-db'},...['TELEGRAM_BOT_TOKEN','GROQ_API_KEY','OWNER_CHAT_ID','WEBHOOK_SECRET','ADMIN_SECRET'].map(name=>({name,type:'secret_text'}))];
 let active=prior,deployed=false,rollbacks=0,sends=0;const logs=[],paths=[];
 const fetcher=async(address,options)=>{
  const path=new URL(address).pathname;paths.push(path);
  assert.ok(!path.includes('/d1/'));assert.ok(!path.includes('/secrets'));assert.ok(!path.endsWith('/setWebhook'));
  const ok=result=>Response.json({success:true,result});
  if(path.endsWith('/health'))return Response.json({ok:true,enabled:true,private:true,agent_tools:true,sha:active});
  if(path.endsWith('/workers/subdomain'))return ok({subdomain:'fixture'});
  if(path.endsWith('/getWebhookInfo'))return Response.json({ok:true,result:{url:failure==='wrong-bot'?'https://other.invalid/telegram':url+'/telegram'}});
  if(path.endsWith('/getChat'))return Response.json({ok:true,result:{id:1001,type:'private'}});
  if(path.endsWith('/settings'))return ok({bindings:failure==='lost-binding'&&deployed?bindings.slice(0,1):bindings});
  if(path.endsWith('/schedules'))return ok({schedules:[{cron:'* * * * *'}]});
  if(path.endsWith('/deployments')){
   if(options.method==='POST'){
    const b=JSON.parse(options.body);assert.equal(b.versions[0].version_id,'previous-version');assert.equal(b.versions[0].percentage,100);
    active=prior;rollbacks++;return ok({});
   }
   return ok({deployments:[{versions:[{version_id:'previous-version',percentage:100}]}]});
  }
  if(path.endsWith('/sendMessage')){
   sends++;assert.equal(JSON.parse(options.body).chat_id,'1001');
   return failure==='delivery'?Response.json({ok:false},{status:429}):Response.json({ok:true,result:{message_id:1}});
  }
  assert.fail('Unexpected service request');
 };
 const run=(command,args)=>{
  if(command==='git')return target;
  assert.equal(command,'npx');assert.ok(args.includes('--keep-vars'));assert.ok(args.includes('--no-x-auto-create'));
  const config=JSON.parse(readFileSync(join(sourceDir,'accountant/.release.json'),'utf8'));
  assert.equal(config.name,name);assert.equal(config.d1_databases[0].database_id,'fixture-db');assert.equal(config.vars.ENABLED,'true');assert.equal(config.vars.SOURCE_SHA,target);
  deployed=true;active=failure==='wrong-health'?prior:target;return '';
 };
 try{
  let error;try{await releaseUpdate({env,sourceDir,fetcher,run,wait:async()=>{},emit:x=>logs.push(JSON.parse(x))});}catch(e){error=e;}
  await assert.rejects(access(join(sourceDir,'accountant/.release.json')));
  assert.ok(!JSON.stringify(logs).includes('fixture-key'));assert.ok(!JSON.stringify(logs).includes('fixture-db'));assert.ok(!JSON.stringify(logs).includes('1001'));
  return {error,logs,deployed,rollbacks,sends,active};
 }finally{await rm(sourceDir,{recursive:true,force:true});}
}
test('approved update preserves existing bindings and confirms owner delivery without D1 queries',async()=>{
 const r=await fixture();assert.equal(r.error,undefined);assert.equal(r.deployed,true);assert.equal(r.rollbacks,0);assert.equal(r.sends,1);assert.equal(r.logs.at(-1).telegram_confirmed,true);
});
test('another bot webhook blocks deployment before any mutation',async()=>{
 const r=await fixture('wrong-bot');assert.equal(r.error.message,'release_bot_mismatch');assert.equal(r.deployed,false);assert.equal(r.rollbacks,0);assert.equal(r.sends,0);
});
test('unverified new health restores the actual preceding version',async()=>{
 const r=await fixture('wrong-health');assert.equal(r.error.message,'release_health_failed');assert.equal(r.rollbacks,1);assert.equal(r.active,prior);assert.equal(r.sends,0);assert.equal(r.logs.at(-1).ok,true);
});
test('missing secret binding after deploy causes rollback',async()=>{
 const r=await fixture('lost-binding');assert.equal(r.error.message,'release_secret_missing_after_update');assert.equal(r.rollbacks,1);assert.equal(r.sends,0);
});
test('Telegram failure is never reported as verified delivery or silently retried',async()=>{
 const r=await fixture('delivery');assert.equal(r.error.message,'release_deployed_but_delivery_unconfirmed');assert.equal(r.sends,1);assert.equal(r.rollbacks,0);assert.equal(r.logs.at(-1).health_verified,true);assert.equal(r.logs.at(-1).telegram_confirmed,false);
});
