import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {at,dayKey} from '../src/core.mjs';
let mf,db,dir;let maxQueries=0,totalRead=0,totalWritten=0;let sends=[],sourceCalls=0,nextError=null,sourceOverride=null;
const fixture=await readFile(new URL('./fixtures/zu41.html',import.meta.url),'utf8');
const other=await readFile(new URL('./fixtures/zu1.html',import.meta.url),'utf8');
const groups=await readFile(new URL('./fixtures/groups.html',import.meta.url),'utf8');
let scriptPath;
function create(){return new Miniflare({modules:true,scriptPath,modulesRoot:dir,compatibilityDate:'2026-07-01',d1Databases:['DB'],d1Persist:dir,bindings:{TELEGRAM_BOT_TOKEN:'test-token',WEBHOOK_SECRET:'test-secret',DELIVERY_ENABLED:'true',OWNER_CHAT_ID:'1001',ADMIN_ENABLED:'true',MAX_USERS:'50'},outboundService:async req=>{
 const url=new URL(req.url);
 if(url.hostname==='api.telegram.org'){
  const body=await req.json();if(url.pathname.endsWith('/answerCallbackQuery'))return Response.json({ok:true,result:true});
  if(nextError){const e=nextError;nextError=null;if(e==='uncertain')throw new Error('network interrupted');return Response.json({ok:false,error_code:e,parameters:e===429?{retry_after:3}:{}},{status:e});}
  sends.push(body);return Response.json({ok:true,result:{message_id:7000+sends.length}});
 }
 if(url.hostname==='site.mstimetables.ru'){
  sourceCalls++;if(sourceOverride==='network')return new Response('unavailable',{status:503});
  if(url.pathname.endsWith('/groups'))return new Response(groups);
  return new Response(sourceOverride??(url.pathname.endsWith('/49')?other:fixture));
 }
 return new Response('Unexpected outbound host',{status:502});
 }});}
async function call(url,body,headers={}){
 const r=await mf.dispatchFetch('https://test'+url,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
 const text=await r.text();if(r.status>=500)throw new Error(text.slice(0,400));return {status:r.status,data:JSON.parse(text)};
}
let updateSeq=1;const now=at('2026-10-12','08:00');
async function text(uid,text,clock=now,id=updateSeq++){return call('/test/webhook?now='+clock,{update_id:id,message:{from:{id:uid},chat:{id:uid,type:'private'},text}}, {'X-Telegram-Bot-Api-Secret-Token':'test-secret'});}
async function action(uid,a,clock=now){
 const d=await db.prepare('SELECT nonce FROM dialogs WHERE user_id=?').bind(uid).first();
 return call('/test/webhook?now='+clock,{update_id:updateSeq++,callback_query:{id:'test-'+updateSeq,from:{id:uid},message:{chat:{id:uid,type:'private'}},data:`v:${uid}:${d.nonce}:${a}`}}, {'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
}
async function user(uid){return db.prepare('SELECT * FROM users WHERE user_id=?').bind(uid).first();}
async function tick(type,lane,clock){const r=await call('/test/tick',{type,lane,now:clock});maxQueries=Math.max(maxQueries,r.data.budget.queries);totalRead+=r.data.budget.read;totalWritten+=r.data.budget.written;assert.ok(r.data.budget.queries<=45,'D1 query budget leaves room under 50');return r;}
async function clearJobs(){await db.prepare('DELETE FROM jobs').run();await db.prepare('DELETE FROM locks').run();await db.prepare("DELETE FROM meta WHERE name='telegram_pause'").run();await db.prepare('DELETE FROM rate_slots').run();sends=[];}
async function insertUser(uid,group=63,clock=now){return db.prepare(`INSERT OR REPLACE INTO users(user_id,chat_id,group_id,group_name,subgroup,changed_at,next_plan,lane) VALUES(?,?,?,?,'both',?,?,?)`).bind(uid,uid,group,group===63?'ЗУ-41/23':'ЗУ-1/26',clock,clock,uid%8).run();}
before(async()=>{dir=await mkdtemp(path.join(tmpdir(),'mkgik-d1-'));scriptPath=path.join(dir,'test-bundle.mjs');await build({entryPoints:['test/entry.mjs'],outfile:scriptPath,bundle:true,format:'esm',platform:'browser'});mf=create();db=await mf.getD1Database('DB');for(const file of ['0001.sql','0002_shared_cache.sql'])await db.exec((await readFile('migrations/'+file,'utf8')).replace(/\n/g,' '));});
after(async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});});
test('parse REAL college catalogue and REAL dated schedules in workerd HTMLRewriter',async()=>{
 const g=(await call('/test/groups',groups)).data;assert.equal(g.length,33);assert.ok(g.some(x=>x.id===63&&x.name==='ЗУ-41/23'));
 assert.equal((await call('/test/catalog?now='+now,{})).data.count,33);
 const ds=(await call('/test/parse?group='+encodeURIComponent('ЗУ-41/23'),fixture)).data;
 assert.equal(ds.find(x=>x.date==='2026-10-12').lessons.length,3);
 const tue=ds.find(x=>x.date==='2026-10-13');assert.deepEqual(tue.lessons[0].variants.map(x=>x.subgroup),['1','2']);
 assert.equal(tue.lessons[0].variants[0].teacher,'Славина Н. Г.');assert.equal(tue.lessons[0].variants[1].room,'401');
});
test('two independent private users register different groups with explicit preferences',async()=>{
 await text(1001,'/start');await text(1001,'ЗУ-41');assert.equal((await db.prepare('SELECT count(*) AS n FROM groups').first()).n,33,'catalog persisted');assert.equal((await db.prepare('SELECT state FROM dialogs WHERE user_id=1001').first()).state,'groups');await action(1001,'group:63');assert.equal((await db.prepare('SELECT state FROM dialogs WHERE user_id=1001').first()).state,'subgroup');await action(1001,'sub:2');await action(1001,'time:06:00');await action(1001,'interval:10');assert.equal((await db.prepare('SELECT state FROM dialogs WHERE user_id=1001').first()).state,'confirm');await action(1001,'save');
 assert.equal((await user(1001)).group_id,63);assert.equal((await user(1001)).subgroup,'2');
 await text(1002,'/start');await text(1002,'ЗУ-1/26');await action(1002,'group:49');
 const d=await db.prepare('SELECT state FROM dialogs WHERE user_id=1002').first();if(d.state==='subgroup')await action(1002,'sub:both');
 await action(1002,'time:07:30');await action(1002,'interval:15');await action(1002,'save');
 assert.equal((await user(1002)).group_id,49);assert.equal((await user(1002)).morning_time,'07:30');assert.equal((await user(1001)).morning_time,'06:00');
});
test('/start preserves saved settings and D1 survives real workerd restart',async()=>{
 const beforeUser=await user(1001);await text(1001,'/start');assert.deepEqual(await user(1001),beforeUser);
 await mf.dispose();mf=create();db=await mf.getD1Database('DB');assert.deepEqual(await user(1001),beforeUser);
});
test('webhook secret, private chat and callback ownership validation',async()=>{
 const bad=await call('/test/webhook?now='+now,{update_id:updateSeq++},{'X-Telegram-Bot-Api-Secret-Token':'wrong'});assert.equal(bad.status,403);
 const d=await db.prepare('SELECT nonce FROM dialogs WHERE user_id=1001').first();const beforeUser=await user(1002);
 await call('/test/webhook?now='+now,{update_id:updateSeq++,callback_query:{id:'fake',from:{id:1002},message:{chat:{id:1002,type:'private'}},data:`v:1001:${d.nonce}:save`}},{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.deepEqual(await user(1002),beforeUser);
 const before=await db.prepare('SELECT count(*) AS n FROM updates').first();
 await call('/test/webhook?now='+now,{update_id:updateSeq++,message:{from:{id:3001},chat:{id:-3001,type:'group'},text:'/start'}},{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.equal((await db.prepare('SELECT count(*) AS n FROM updates').first()).n,before.n);
});
test('repeated and parallel Telegram update IDs do not duplicate replies',async()=>{
 await clearJobs();const id=updateSeq++;await Promise.all([text(1001,'/start',now,id),text(1001,'/start',now,id)]);
 assert.equal(sends.length,1);assert.equal((await db.prepare('SELECT count(*) AS n FROM updates WHERE update_id=?').bind(id).first()).n,1);
});
test('preview another group does not change subscription',async()=>{
 await text(1001,'🎓 Моя группа');await action(1001,'preview');await action(1001,'group:49');await action(1001,'view');assert.equal((await user(1001)).group_id,63);
});
test('08:50 reminder for 09:00, late display uses actual time; cron/restart no repeats',async()=>{
 await clearJobs();await insertUser(1001);await tick('plan',1,now);
 const j=await db.prepare("SELECT * FROM jobs WHERE user_id=1001 AND kind='reminder' AND lesson_number=1 AND date='2026-10-12'").first();assert.equal(j.due_at,at('2026-10-12','08:50'));
 await db.prepare('UPDATE schedules SET checked_at=?,next_refresh=?').bind(at('2026-10-12','08:51'),at('2026-10-12','09:10')).run();
 await Promise.all([tick('deliver',1,at('2026-10-12','08:52')),tick('deliver',1,at('2026-10-12','08:52'))]);
 assert.equal(sends.length,1);assert.match(sends[0].text,/Через 8 мин/);assert.match(sends[0].text,/Романенко/);
 await mf.dispose();mf=create();db=await mf.getD1Database('DB');await tick('deliver',1,at('2026-10-12','08:53'));assert.equal(sends.length,1);
});
test('no historical reminders after class starts and late registration',async()=>{
 await clearJobs();const late=at('2026-10-12','09:05');await insertUser(1003,63,late);await tick('plan',3,late);
 const first=await db.prepare("SELECT count(*) AS n FROM jobs WHERE user_id=1003 AND kind='reminder' AND lesson_number=1 AND date='2026-10-12'").first();assert.equal(first.n,0);
 await insertUser(1004,63,now);await tick('plan',4,now);await tick('deliver',4,late);assert.equal(sends.length,0);
});
test('changing one group cancels its jobs and retains preferences without touching another user',async()=>{
 await clearJobs();await tick('plan',1,now);const otherUser=await user(1002);
 await text(1001,'🎓 Моя группа');await action(1001,'change_group');await action(1001,'group:49');
 const d=await db.prepare('SELECT state FROM dialogs WHERE user_id=1001').first();if(d.state==='subgroup')await action(1001,'sub:both');await action(1001,'save');
 assert.equal((await user(1001)).group_id,49);assert.equal((await user(1001)).morning_time,'06:00');assert.deepEqual(await user(1002),otherUser);
 assert.equal((await db.prepare("SELECT count(*) AS n FROM jobs WHERE user_id=1001 AND group_id=63 AND state='pending'").first()).n,0);
});
test('source failures and unpublished dates do not cancel confirmed future lessons',async()=>{
 await clearJobs();await insertUser(1001);const clock=at('2026-10-12','08:00');await tick('plan',1,clock);
 const count=(await db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='reminder' AND state='pending'").first()).n;
 sourceOverride='network';const s=(await call('/test/source?group=63&date=2026-10-12&now='+(clock+20*60000),{})).data;
 assert.equal(s.status,'network_error');assert.equal((await db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='reminder' AND state='pending'").first()).n,count);
 sourceOverride=null;
 const missing=(await call('/test/source?group=63&date=2027-01-04&now='+(clock+30*60000),{})).data;assert.equal(missing.status,'unpublished');
});
test('429 respects retry_after, 403 blocks user, ambiguous send is quarantined',async()=>{
 await clearJobs();await insertUser(1001);await text(1001,'/start',now);await clearJobs();
 const mk=async(key)=>db.prepare(`INSERT INTO jobs(job_key,user_id,chat_id,lane,date,kind,due_at,expires_at,revision,payload,created_at) VALUES(?,1001,1001,1,'2026-10-12','reply',?,?,0,?,?)`).bind(key,now,now+3600000,JSON.stringify({text:'Test only',parse_mode:'HTML'}),now).run();
 await mk('429');nextError=429;await tick('deliver',1,now);let j=await db.prepare("SELECT * FROM jobs WHERE job_key='429'").first();assert.equal(j.state,'retry');assert.equal(j.due_at,now+3000);
 await tick('deliver',1,now+2000);assert.equal(sends.length,0);await tick('deliver',1,now+4000);assert.equal(sends.length,1);
 await mk('403');nextError=403;await tick('deliver',1,now+6000);assert.equal((await user(1001)).blocked,1);
 await db.prepare('UPDATE users SET blocked=0 WHERE user_id=1001').run();await mk('uncertain');nextError='uncertain';await tick('deliver',1,now+8000);
 assert.equal((await db.prepare("SELECT state FROM jobs WHERE job_key='uncertain'").first()).state,'uncertain');await tick('deliver',1,now+10000);assert.equal(sends.length,1);
});
test('no classes day stays quiet by default; morning arbitrary time persisted once per day',async()=>{
 await clearJobs();const clock=at('2026-10-17','05:00');await insertUser(1005,63,clock);await tick('plan',5,clock);
 await tick('deliver',5,at('2026-10-17','06:00'));assert.equal(sends.length,0);
 await db.prepare("UPDATE users SET morning_time='07:35',send_empty=1,next_plan=?,revision=revision+1 WHERE user_id=1005").bind(clock).run();await tick('plan',5,clock);
 await tick('deliver',5,at('2026-10-17','07:35'));assert.equal(sends.length,1);assert.match(sends[0].text,/занятий нет/);
 await tick('deliver',5,at('2026-10-17','07:36'));assert.equal(sends.length,1);
});
test('real source cache shared between users; reminder batch limited to three jobs',async()=>{
 await clearJobs();const clock=at('2026-10-12','05:00');await db.prepare('DELETE FROM schedules').run();await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();sourceCalls=0;
 for(let uid=1010;uid<1020;uid++) {await insertUser(uid,63,clock);await tick('plan',uid%8,clock);}
 assert.ok(sourceCalls<=2,'one fetch per group/week, not one per student');
});
test('confirmed move/cabinet change and explicit cancellation rebuild future jobs',async()=>{
 await clearJobs();await insertUser(1006);await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();
 await tick('plan',6,now);
 sourceOverride=fixture.replace('>09:00-10:30<','>09:10-10:30<').replace('>305<','>777<');
 let clock=now+5*60000;await call('/test/source?group=63&date=2026-10-12&now='+clock,{});await tick('plan',6,clock);
 const moved=await db.prepare("SELECT due_at,state FROM jobs WHERE user_id=1006 AND date='2026-10-12' AND lesson_number=1").first();
 assert.equal(moved.due_at,at('2026-10-12','09:00'));assert.equal(moved.state,'pending');
 sourceOverride=sourceOverride.replace('МДК 02.03 Экономическая оценка объектов недвижимости','Занятие отменено');
 clock+=2*60000;await call('/test/source?group=63&date=2026-10-12&now='+clock,{});await tick('plan',6,clock);
 const cancelled=await db.prepare("SELECT state FROM jobs WHERE user_id=1006 AND date='2026-10-12' AND lesson_number=1").first();assert.equal(cancelled.state,'cancelled');
 sourceOverride=null;
});
test('pause and confirmed deletion affect only the selected test user',async()=>{
 await clearJobs();await insertUser(1006);const otherUser=JSON.stringify(await user(1002));
 await text(1006,'⚙️ Настройки');await action(1006,'pause');await action(1006,'save');
 assert.equal((await user(1006)).paused_until,at('2026-10-13','00:00'));
 await text(1006,'⚙️ Настройки');await action(1006,'delete');assert.ok(await user(1006));await action(1006,'delete_yes');assert.equal(await user(1006),null);
 assert.ok(JSON.stringify(await user(1002))===otherUser);
 assert.equal((await db.prepare('SELECT count(*) AS n FROM jobs WHERE user_id=1006').first()).n,0);
});
test('50-student simulated burst: independent groups, bounded batches and shared source cache',async()=>{
 await clearJobs();await db.prepare('DELETE FROM users').run();await db.prepare('DELETE FROM schedules').run();await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();
 sourceOverride=null;sourceCalls=0;const clock=at('2026-10-12','05:00');
 for(let i=0;i<50;i++)await insertUser(10000+i,i%2?49:63,clock);await db.prepare('UPDATE users SET send_empty=1').run();
 const usersCount=(await db.prepare('SELECT count(*) AS n FROM users').first()).n;assert.equal(usersCount,50);
 for(let round=0;round<7;round++)for(let lane=0;lane<8;lane++)await tick('plan',lane,clock);
 assert.ok(sourceCalls<=2,'cache shared between 50 subscriptions');
 const morning=at('2026-10-12','06:00');
 for(let minute=0;minute<4;minute++){
  const beforeCount=sends.length;
  await Promise.all(Array.from({length:8},(_,lane)=>tick('deliver',lane,morning+minute*60000)));
  assert.ok(sends.length-beforeCount<=24,'at most 8 lanes × 3 deliveries per cron minute');
 }
 assert.equal(sends.length,50);
 const unique=new Set(sends.map(s=>s.chat_id));assert.equal(unique.size,50);
 for(const s of sends)assert.ok(s.text.includes(s.chat_id%2?'ЗУ-1/26':'ЗУ-41/23'),'each recipient got its own group');
 const pending=(await db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='morning' AND state='pending' AND date='2026-10-12'").first()).n;assert.equal(pending,0);console.log('Aggregate local D1 budget:',JSON.stringify({maxQueries,totalRead,totalWritten,burstRecipients:sends.length,sharedSourceFetches:sourceCalls}));
});

test('queue dispatcher is idempotent and daily free-budget guard is atomic',async()=>{
 const clock=at('2026-10-12','08:50');
 const first=(await call('/test/dispatch?now='+clock,{})).data;assert.ok(first.queued<=20);assert.ok(first.budget.queries<45);
 const again=(await call('/test/dispatch?now='+clock,{})).data;assert.equal(again.queued,0);
 await db.prepare("INSERT OR REPLACE INTO queue_budgets VALUES('2026-10-12',2799)").run();
 const rs=await Promise.all([call('/test/reserve?now='+clock+'&n=1',{}),call('/test/reserve?now='+clock+'&n=1',{})]);assert.equal(rs.filter(r=>r.data.reserved).length,1);
});

async function replies(uid,count,clock=now){
 for(let i=0;i<count;i++)await db.prepare(`INSERT INTO jobs(job_key,user_id,chat_id,lane,date,kind,due_at,expires_at,revision,payload,created_at) VALUES(?,?,?,?,?,'reply',?,?,0,?,?)`).bind('fast-'+uid+'-'+i,uid,uid,uid%8,dayKey(clock),clock,clock+600000,JSON.stringify({text:'part '+i,parse_mode:'HTML'}),clock).run();
}
async function fast(uid,clock=now){
 const r=(await call('/test/fast?user='+uid+'&now='+clock,{})).data;
 assert.ok(r.budget.queries<=45,'fast consumer stays below 50 D1 subrequests');return r;
}
test('fast replies preserve order with second-level pacing, not minute Cron',async()=>{
 await clearJobs();await replies(1001,4);let a=await fast(1001);
 assert.equal(a.sent,2);assert.equal(a.pending,true);assert.ok(a.elapsed>=1000&&a.elapsed<2000);
 let b=await fast(1001,now+a.elapsed);assert.equal(b.sent,2);assert.ok(b.elapsed<3000);
 assert.deepEqual(sends.map(x=>x.text),['part 0','part 1','part 2','part 3']);
 assert.ok(a.elapsed+b.elapsed<5000,'four parts avoid old 1-3 minute delay');
 console.log('Fast four-part simulated time / D1 per invocation:',JSON.stringify({ms:a.elapsed+b.elapsed,queries:Math.max(a.budget.queries,b.budget.queries)}));
});
test('fast sender, duplicate fast sender and Cron share claims without duplicates',async()=>{
 await clearJobs();await replies(1001,1);
 await Promise.all([fast(1001),fast(1001),tick('deliver',1,now)]);
 assert.equal(sends.length,1);
 await fast(1001,now+40000);assert.equal(sends.length,1,'restart cannot resend completed job');
});
test('fast reply 429 waits until retry_after; unknown delivery is never resent',async()=>{
 await clearJobs();await replies(1001,1);nextError=429;
 const limited=await fast(1001);assert.equal(limited.delay,3);assert.equal(sends.length,0);
 await fast(1001,now+1000);assert.equal(sends.length,0);
 await fast(1001,now+3000);assert.equal(sends.length,1);
 await clearJobs();await replies(1001,1);nextError='uncertain';await fast(1001);await fast(1001,now+40000);
 assert.equal(sends.length,0);assert.equal((await db.prepare("SELECT state FROM jobs WHERE job_key='fast-1001-0'").first()).state,'uncertain');
});
test('fast path skips expired replies and respects an in-flight chat sender',async()=>{
 await clearJobs();await replies(1001,1);
 await db.prepare('INSERT INTO locks VALUES(?,?,?)').bind('chat-send:1001','another',now+20000).run();
 await fast(1001);assert.equal(sends.length,0);
 await fast(1001,now+700000);assert.equal(sends.length,0);
 assert.equal((await db.prepare("SELECT state FROM jobs WHERE job_key='fast-1001-0'").first()).state,'skipped');
});
test('full webhook fast path persists settings and stays within subrequest budget',async()=>{
 await clearJobs();const id=updateSeq++;
 const body={update_id:id,message:{from:{id:10001},chat:{id:10001,type:'private'},text:'/start'}};
 const result=await call('/test/fast-webhook',body,{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.equal(result.data.status,200);assert.equal(sends.length,1);assert.ok(result.data.budget.queries<=45);
 assert.equal((await db.prepare('SELECT state FROM updates WHERE update_id=?').bind(id).first()).state,'done');
 const count=sourceCalls;await call('/test/fast-webhook',{...body,update_id:updateSeq++},{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.equal(sourceCalls,count,'menu does not fetch timetable source');
 console.log('Full fast webhook D1 budget:',JSON.stringify(result.data.budget));
});

test('cached full week uses the fast path within D1 query allowance',async()=>{
 await clearJobs();
 const clock=Date.now();await insertUser(10001,63,clock);
 const result=await call('/test/fast-webhook',{update_id:updateSeq++,message:{from:{id:10001},chat:{id:10001,type:'private'},text:'🗓 Неделя'}},{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.ok(result.data.budget.queries<=45,JSON.stringify(result.data.budget));
 assert.ok(sends.length>=1);console.log('Full-week fast webhook D1 budget:',JSON.stringify(result.data.budget));
});

test('owner-only /admin never adds buttons or changes subscription/dialog state',async()=>{
 await clearJobs();await insertUser(1001);const before=JSON.stringify(await user(1001));
 const dialogBefore=await db.prepare('SELECT * FROM dialogs WHERE user_id=1001').first();
 await text(1001,'/admin');assert.equal(sends.length,1);
 assert.match(sends[0].text,/Админ-панель/);assert.equal(sends[0].reply_markup,undefined);
 assert.equal(JSON.stringify(await user(1001)),before);
 assert.deepEqual(await db.prepare('SELECT * FROM dialogs WHERE user_id=1001').first(),dialogBefore);
 for(const command of ['status','stats','groups','queue','errors','source']){
  await clearJobs();await text(1001,'/admin '+command);assert.equal(sends.length,1);
  assert.match(sends[0].text,/🔐/);assert.doesNotMatch(sends[0].text,/test-token|test-secret/);
  assert.equal(sends[0].reply_markup,undefined);
 }
});
test('another private user cannot access any admin operation, even with owner ID argument',async()=>{
 for(const command of ['/admin','/admin stats','/admin refresh','/admin 1001','/admin@net_5b0_bot status']){
  await clearJobs();const sourceBefore=sourceCalls;await text(1002,command);
  assert.equal(sends.length,1);assert.equal(sends[0].chat_id,1002);
  assert.equal(sends[0].text,'⛔ Доступ запрещён.');assert.equal(sourceCalls,sourceBefore);
 }
});
test('spoofed owner identity and group chat cannot create admin response',async()=>{
 await clearJobs();
 for(const body of [
  {message:{from:{id:1002},chat:{id:1001,type:'private'},text:'/admin'}},
  {message:{from:{id:1001},chat:{id:1001,type:'group'},text:'/admin'}}
 ])await call('/test/webhook?now='+now,{update_id:updateSeq++,...body},{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.equal(sends.length,0);assert.equal((await db.prepare('SELECT count(*) AS n FROM jobs').first()).n,0);
});
test('owner refresh uses saved group with a cooldown; ordinary menu has no admin buttons',async()=>{
 await clearJobs();await insertUser(1001);await text(1001,'/admin refresh');
 assert.match(sends[0].text,/Проверка источника/);
 const sourceBefore=sourceCalls;await text(1001,'/admin refresh',now+2000);assert.equal(sourceCalls,sourceBefore);assert.match(sends.at(-1).text,/через минуту/);
 await clearJobs();await text(1001,'/start');assert.doesNotMatch(JSON.stringify(sends[0].reply_markup),/admin|Админ/);
});


test('group 63 warms without subscribers; others require FOUR unblocked subscriptions',async()=>{
 await clearJobs();await db.prepare('DELETE FROM users').run();await db.prepare('DELETE FROM schedules').run();await db.prepare('DELETE FROM refresh_requests').run();await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();
 let cs=(await call('/test/cache-candidates?now='+now,{})).data;assert.deepEqual([...new Set(cs.map(x=>x.group_id))],[63]);
 for(let i=0;i<3;i++)await insertUser(2000+i,49);
 cs=(await call('/test/cache-candidates?now='+now,{})).data;assert.ok(!cs.some(x=>x.group_id===49));
 await insertUser(2003,49);cs=(await call('/test/cache-candidates?now='+now,{})).data;assert.ok(cs.some(x=>x.group_id===49));
 await db.prepare('UPDATE users SET blocked=1 WHERE user_id=2003').run();cs=(await call('/test/cache-candidates?now='+now,{})).data;assert.ok(!cs.some(x=>x.group_id===49));
});
test('expired week returns without source fetch; one durable refresh intent survives restart',async()=>{
 await call('/test/source?group=63&date=2026-10-12&now='+now,{});const oldCalls=sourceCalls,clock=now+20*60000;
 for(const date of ['2026-10-12','2026-10-13','2026-10-12']){
  const s=(await call('/test/cache-source?group=63&date='+date+'&now='+clock,{})).data;
  assert.equal(s.status,'confirmed');assert.equal(s.cached_stale,true);assert.ok(s.lessons.length);
 }
 assert.equal(sourceCalls,oldCalls);assert.equal((await db.prepare('SELECT count(*) AS n FROM refresh_requests').first()).n,1);
 await mf.dispose();mf=create();db=await mf.getD1Database('DB');assert.equal((await db.prepare('SELECT count(*) AS n FROM refresh_requests').first()).n,1);
 await call('/test/cache-refresh?lane=3&now='+clock,{});assert.equal(sourceCalls,oldCalls+1);assert.equal((await db.prepare('SELECT count(*) AS n FROM refresh_requests').first()).n,0);
});
test('cache miss downloads one week; second day reuses it',async()=>{
 await db.prepare('DELETE FROM schedules WHERE group_id=49').run();await db.prepare("DELETE FROM meta WHERE name LIKE 'source:49:%'").run();const oldCalls=sourceCalls;
 const s=(await call('/test/cache-source?group=49&date=2026-10-12&now='+now,{})).data;assert.equal(s.status,'confirmed');
 await call('/test/cache-source?group=49&date=2026-10-13&now='+now,{});assert.equal(sourceCalls,oldCalls+1);assert.equal((await db.prepare('SELECT count(*) AS n FROM schedules WHERE group_id=49').first()).n,7);
});
test('stale Today answers from D1 with last checked date even if source is broken',async()=>{
 await clearJobs();await insertUser(1001);sourceOverride='network';const oldCalls=sourceCalls;
 await call('/test/cache-webhook?now='+(now+40*60000),{update_id:updateSeq++,message:{from:{id:1001},chat:{id:1001,type:'private'},text:'📅 Сегодня'}},{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});
 assert.equal(sourceCalls,oldCalls);assert.equal(sends.length,1);assert.match(sends[0].text,/Сохранённая копия/);assert.match(sends[0].text,/Романенко/);assert.match(sends[0].text,/Последняя успешная проверка/);sourceOverride=null;
});
test('due reminder rechecks once per group and uses changed room without a duplicate',async()=>{
 await clearJobs();await db.prepare('DELETE FROM users').run();await insertUser(1001);await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();await call('/test/source?group=63&date=2026-10-12&now='+now,{});await tick('plan',1,now);
 const due=at('2026-10-12','08:50');sourceOverride=fixture.replace('>305<','>777<');const oldCalls=sourceCalls;
 const refreshed=await call('/test/cache-refresh?lane=3&now='+due,{});assert.ok(refreshed.data.budget.queries<=45);assert.equal(sourceCalls,oldCalls+1);
 await call('/test/cache-deliver?lane=1&now='+due,{});assert.equal(sends.length,1);assert.match(sends[0].text,/777/);assert.equal(sourceCalls,oldCalls+1);
 await call('/test/cache-deliver?lane=1&now='+(due+1000),{});assert.equal(sends.length,1);sourceOverride=null;
});
test('failed recheck preserves records and defers unverified reminder',async()=>{
 await clearJobs();await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();await insertUser(1001);await call('/test/source?group=63&date=2026-10-12&now='+now,{});await tick('plan',1,now);
 sourceOverride='network';const due=at('2026-10-12','08:50');await call('/test/cache-refresh?lane=3&now='+due,{});await call('/test/cache-deliver?lane=1&now='+due,{});assert.equal(sends.length,0);
 const j=await db.prepare("SELECT state,last_error FROM jobs WHERE user_id=1001 AND date='2026-10-12' AND lesson_number=1").first();assert.equal(j.state,'retry');assert.equal(j.last_error,'source_not_fresh');
 const s=await db.prepare("SELECT status,data FROM schedules WHERE group_id=63 AND date='2026-10-12'").first();assert.equal(s.status,'network_error');assert.ok(JSON.parse(s.data).lessons.length);sourceOverride=null;
});
test('Sunday and year boundary prewarm correct next week',async()=>{
 await clearJobs();await db.prepare('DELETE FROM schedules').run();await db.prepare('DELETE FROM refresh_requests').run();await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();
 let cs=(await call('/test/cache-candidates?now='+at('2026-10-18','20:00'),{})).data;assert.ok(cs.some(x=>x.group_id===63&&x.date==='2026-10-18'));assert.ok(cs.some(x=>x.group_id===63&&x.date==='2026-10-19'));
 cs=(await call('/test/cache-candidates?now='+at('2027-01-03','20:00'),{})).data;assert.ok(cs.some(x=>x.date==='2027-01-04'));assert.ok(cs.some(x=>x.date==='2027-01-03'));
});

test('confirmed earlier move rebuilds existing jobs immediately; explicit cancellation prevents reminder',async()=>{
 await clearJobs();await insertUser(1001);await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();await call('/test/source?group=63&date=2026-10-12&now='+now,{});await tick('plan',1,now);
 const check=at('2026-10-12','08:45');sourceOverride=fixture.replace('>09:00-10:30<','>08:54-10:30<');
 await call('/test/cache-refresh?lane=3&now='+check,{});
 let j=await db.prepare("SELECT due_at,start_at,state FROM jobs WHERE user_id=1001 AND date='2026-10-12' AND lesson_number=1").first();
 assert.equal(j.start_at,at('2026-10-12','08:54'));assert.equal(j.due_at,check);assert.equal(j.state,'pending');
 await call('/test/cache-deliver?lane=1&now='+check,{});assert.equal(sends.length,1);assert.match(sends[0].text,/Через 9 мин/);
 await clearJobs();sourceOverride=null;await db.prepare("DELETE FROM meta WHERE name LIKE 'source:%'").run();await call('/test/source?group=63&date=2026-10-12&now='+now,{});await tick('plan',1,now);
 sourceOverride=fixture.replace('МДК 02.03 Экономическая оценка объектов недвижимости','Занятие отменено');await call('/test/cache-refresh?lane=3&now='+at('2026-10-12','08:50'),{});await call('/test/cache-deliver?lane=1&now='+at('2026-10-12','08:50'),{});
 assert.equal(sends.length,0);j=await db.prepare("SELECT state FROM jobs WHERE user_id=1001 AND date='2026-10-12' AND lesson_number=1").first();assert.equal(j.state,'cancelled');sourceOverride=null;
});
