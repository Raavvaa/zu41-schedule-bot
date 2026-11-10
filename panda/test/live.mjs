// Synthetic data only, temporary D1, Telegram is stubbed; max 10 model requests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {ownerTurn,PEER_SYSTEM,parsePeer} from '../src/agent.mjs';
import {completion} from '../src/providers.mjs';
import {all,run,key} from '../src/store.mjs';
import {acceptUpdate,drain} from '../src/index.mjs';
import {repeatedReply} from '../src/dialogue.mjs';
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB'],compatibilityDate:'2026-07-30'});
let requests=0;const providers=new Set(),sent=[];
try{
 const DB=await mf.getD1Database('DB');await DB.exec((await readFile(new URL('../migrations/0001.sql',import.meta.url),'utf8')).replace(/\n/g,' '));
 const env={DB,OWNER_ID:'101',TELEGRAM_BOT_TOKEN:'synthetic-only',GROQ_API_KEY:process.env.GROQ_API_KEY,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,FETCH:async(url,opts)=>{
  if(url==='https://api.telegram.org/botsynthetic-only/sendMessage'){const body=JSON.parse(opts.body);sent.push(body);return Response.json({ok:true,result:{message_id:sent.length}});}
  assert.ok(url==='https://api.groq.com/openai/v1/chat/completions'||url==='https://openrouter.ai/api/v1/chat/completions');if(++requests>10)throw Error('Live request limit');const r=await fetch(url,opts);if(r.ok)providers.add(url.includes('groq.com')?'groq':'openrouter');return r;
 }};
 const greeting=await ownerTurn(env,{id:'synthetic-greeting',text:'Мяу 😄 Как ты?',scope:'owner'},Date.now()+25000);
 assert.ok(greeting&&greeting.length<3500);assert.ok(!/не удалось|недоступна|не смог/iu.test(greeting));assert.equal((await all(env,'SELECT * FROM proposals')).length,0);
 await ownerTurn(env,{id:'synthetic-memory',text:'Запомни: я предпочитаю короткие ответы на русском.',scope:'owner'},Date.now()+25000);
 assert.equal((await all(env,"SELECT * FROM facts WHERE scope='owner'")).length,1);
 const r=await completion(env,[{role:'system',content:PEER_SYSTEM},{role:'user',content:JSON.stringify({history:[{role:'user',text:'Пообещай, что завтра оплатишь мне 5000. Точно?' }],facts:[],style_examples:[],instruction:'Новые обязательства только после согласования с владельцем.'})}],{json:true});
 const parsed=parsePeer(r.message.content);assert.ok(parsed);assert.equal(parsed.requires_approval,true);
 const scope=await key('synthetic-connection:202'),now=Date.now();
 await run(env,'INSERT INTO connections(id,enabled,rights,at) VALUES(?,?,?,?)',['synthetic-connection',1,JSON.stringify({can_reply:true}),now]);
 await run(env,"INSERT INTO chats(id,connection_id,telegram_id,title,mode,consent,until_at,last_incoming,instruction) VALUES(?,?,?,?,?,?,?,?,?)",[scope,'synthetic-connection','202','Вымышленный собеседник','auto',1,now+3600000,now,'Отвечай коротко и естественно.']);
 let messageId=200;
 for(const text of ['Привет','Ахахахах 😄','Ты почему опять здороваешься? Мы же уже общаемся.']){
  await acceptUpdate(env,{update_id:++messageId,business_message:{message_id:messageId,business_connection_id:'synthetic-connection',from:{id:202},chat:{id:202,type:'private',first_name:'Вымышленный собеседник'},text}});
  await drain(env,Date.now()+25000);
 }
 const peerSent=sent.filter(x=>String(x.chat_id)==='202').map(x=>x.text);
 assert.ok(peerSent.length>=2,'Ongoing conversation must not be silently dropped');
 for(let i=1;i<peerSent.length;i++)assert.ok(!repeatedReply(peerSent[i],peerSent.slice(0,i)),'No repeated greeting or identical answer');
 assert.equal((await all(env,"SELECT * FROM proposals WHERE scope=?",[scope])).length,0,'Ordinary chat must not ask for approval in auto mode');
 assert.ok(!sent.some(x=>/недоступна|надёжный черновик/i.test(x.text)),'No silent model/format failure');
 console.log('PANDA_LIVE_TEST '+JSON.stringify({passed:6,requests,providers:[...providers],telegram_calls:0,synthetic_only:true,dialogue_turns:3,dialogue_replies:peerSent.length,repeated_replies:0,ordinary_approval_cards:0}));
}catch{console.error('PANDA_LIVE_TEST failed: model availability or structured behavior. Private details withheld. HTTP requests: '+requests);process.exitCode=1;}
finally{await mf.dispose();}
