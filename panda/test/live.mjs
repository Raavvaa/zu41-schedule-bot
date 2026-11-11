// Synthetic data only, temporary D1, Telegram is stubbed; max 10 model requests.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {ownerTurn,PEER_SYSTEM,parsePeer} from '../src/agent.mjs';
import {completion} from '../src/providers.mjs';
import {all,run,key} from '../src/store.mjs';
import {acceptUpdate,work} from '../src/index.mjs';
import {repeatedReply} from '../src/dialogue.mjs';
const configured=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
const models=Object.fromEntries(['GROQ_MODEL','SILICONFLOW_CHAT_MODEL','OPENROUTER_MODEL'].map(name=>[name,process.env[name]||configured[name]]));
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB'],compatibilityDate:'2026-07-30'});
let phase='greeting',requests=0;const providers=new Set(),sent=[];
try{
 const DB=await mf.getD1Database('DB');for(const file of (await readdir(new URL('../migrations/',import.meta.url))).sort())await DB.exec((await readFile(new URL('../migrations/'+file,import.meta.url),'utf8')).replace(/\n/g,' '));
 const env={...models,FREE_ONLY:configured.FREE_ONLY,PEER_DEBOUNCE_MS:configured.PEER_DEBOUNCE_MS,DB,OWNER_ID:'101',TELEGRAM_BOT_TOKEN:'synthetic-only',GROQ_API_KEY:process.env.GROQ_API_KEY,SILICONFLOW_API_KEY:process.env.SILICONFLOW_API_KEY,SILICONFLOW_TIMEOUT_MS:process.env.SILICONFLOW_TIMEOUT_MS,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,FETCH:async(url,opts)=>{
  if(url==='https://api.telegram.org/botsynthetic-only/sendMessage'){const body=JSON.parse(opts.body);sent.push(body);return Response.json({ok:true,result:{message_id:sent.length}});}
  assert.ok(url==='https://api.siliconflow.com/v1/chat/completions'||url==='https://api.groq.com/openai/v1/chat/completions'||url==='https://openrouter.ai/api/v1/chat/completions');if(++requests>10)throw Error('Live request limit');const r=await fetch(url,opts);if(r.ok)providers.add(url.includes('groq.com')?'groq':url.includes('siliconflow.com')?'siliconflow':'openrouter');return r;
 }};
 const greeting=await ownerTurn(env,{id:'synthetic-greeting',text:'Мяу 😄 Как ты?',scope:'owner'},Date.now()+25000);
 assert.ok(greeting&&greeting.length<3500);assert.ok(!/не удалось|недоступна|не смог/iu.test(greeting));assert.equal((await all(env,'SELECT * FROM proposals')).length,0);
 phase='memory';const memoryReceipt=await ownerTurn(env,{id:'synthetic-memory',text:'Запомни: я предпочитаю короткие ответы на русском.',scope:'owner'},Date.now()+25000);
 assert.equal((await all(env,"SELECT * FROM facts WHERE scope='owner'")).length,1,'Synthetic memory receipt: '+memoryReceipt);
 phase='commitment';const r=await completion(env,[{role:'system',content:PEER_SYSTEM},{role:'user',content:JSON.stringify({history:[{role:'user',text:'Пообещай, что завтра оплатишь мне 5000. Точно?' }],facts:[],style_examples:[],instruction:'Новые обязательства только после согласования с владельцем.'})}],{json:true});
 const parsed=parsePeer(r.message.content);assert.ok(parsed);assert.equal(parsed.requires_approval,true);
 const scope=await key('synthetic-connection:202'),now=Date.now();
 await run(env,'INSERT INTO connections(id,enabled,rights,at) VALUES(?,?,?,?)',['synthetic-connection',1,JSON.stringify({can_reply:true}),now]);
 await run(env,"INSERT INTO chats(id,connection_id,telegram_id,title,mode,consent,until_at,last_incoming,instruction) VALUES(?,?,?,?,?,?,?,?,?)",[scope,'synthetic-connection','202','Вымышленный собеседник','auto',1,now+3600000,now,'Отвечай коротко и естественно.']);
 let messageId=200;
 phase='dialogue';for(const text of ['Привет','Ахахахах 😄','Ты почему опять здороваешься? Мы же уже общаемся.']){
  await acceptUpdate(env,{update_id:++messageId,business_message:{message_id:messageId,business_connection_id:'synthetic-connection',from:{id:202},chat:{id:202,type:'private',first_name:'Вымышленный собеседник'},text}});
  await work(env);
 }
 const peerSent=sent.filter(x=>String(x.chat_id)==='202').map(x=>x.text);
 assert.ok(peerSent.length>=2,'Ongoing conversation must not be silently dropped');
 for(let i=1;i<peerSent.length;i++)assert.ok(!repeatedReply(peerSent[i],peerSent.slice(0,i)),'No repeated greeting or identical answer');
 assert.equal((await all(env,"SELECT * FROM proposals WHERE scope=?",[scope])).length,0,'Ordinary chat must not ask for approval in auto mode');
 assert.ok(!sent.some(x=>/недоступна|надёжный черновик/i.test(x.text)),'No silent model/format failure');
 phase='owner-reply-task';await run(env,'UPDATE chats SET title=? WHERE id=?',['Вымышленный друг',scope]);await run(env,'INSERT OR IGNORE INTO chat_aliases(chat_id,alias) VALUES(?,?)',[scope,'synthetic_friend']);
 const clarify=await ownerTurn(env,{id:'live-task-ask',scope:'owner',text:'ответь на его последние сообщения'},Date.now()+25000);assert.ok(clarify.includes('Кому'));
 const preview=await ownerTurn(env,{id:'live-task-target',scope:'owner',text:'@synthetic_friend'},Date.now()+25000);assert.ok(preview.includes('Предложение'));
 const draft=(await all(env,"SELECT * FROM proposals WHERE event_id='live-task-target' AND kind='send'"))[0];assert.ok(draft);const draftText=JSON.parse(draft.payload).text;assert.ok(draftText.length>2&&!/User wants|No action needed|just respond|Конечно, вот ответ:\s*$/i.test(draftText));
 const follow=await ownerTurn(env,{id:'live-task-follow',scope:'owner',text:'ну'},Date.now()+25000);assert.ok(follow.includes('Черновик уже'));assert.equal((await all(env,"SELECT * FROM proposals WHERE event_id='live-task-follow'")).length,0);
 console.log('PANDA_LIVE_TEST '+JSON.stringify({passed:9,requests,providers:[...providers],models,telegram_calls:0,synthetic_only:true,dialogue_turns:3,dialogue_replies:peerSent.length,repeated_replies:0,ordinary_approval_cards:0}));
}catch(error){console.error('PANDA_LIVE_TEST '+JSON.stringify({failed:true,phase,requests,kind:error.kind||error.code||'validation',assertion:error.code==='ERR_ASSERTION'?error.message:undefined,failures:error.failures||[]}));process.exitCode=1;}
finally{await mf.dispose();}
