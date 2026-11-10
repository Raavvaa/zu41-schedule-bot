// Synthetic data only, temporary D1, never Telegram; hard ceiling 6 HTTP requests.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {ownerTurn,PEER_SYSTEM,parsePeer} from '../src/agent.mjs';
import {completion} from '../src/providers.mjs';
import {all} from '../src/store.mjs';
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',d1Databases:['DB'],compatibilityDate:'2026-07-30'});
let requests=0;const providers=new Set();
try{
 const DB=await mf.getD1Database('DB');await DB.exec((await readFile(new URL('../migrations/0001.sql',import.meta.url),'utf8')).replace(/\n/g,' '));
 const env={DB,OWNER_ID:'101',GROQ_API_KEY:process.env.GROQ_API_KEY,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY,FETCH:async(url,opts)=>{assert.ok(url==='https://api.groq.com/openai/v1/chat/completions'||url==='https://openrouter.ai/api/v1/chat/completions');if(++requests>6)throw Error('Live request limit');const r=await fetch(url,opts);if(r.ok)providers.add(url.includes('groq.com')?'groq':'openrouter');return r;}};
 const greeting=await ownerTurn(env,{id:'synthetic-greeting',text:'Мяу 😄 Как ты?',scope:'owner'},Date.now()+25000);
 assert.ok(greeting&&greeting.length<3500);assert.ok(!/не удалось|недоступна|не смог/iu.test(greeting));assert.equal((await all(env,'SELECT * FROM proposals')).length,0);
 await ownerTurn(env,{id:'synthetic-memory',text:'Запомни: я предпочитаю короткие ответы на русском.',scope:'owner'},Date.now()+25000);
 assert.equal((await all(env,"SELECT * FROM facts WHERE scope='owner'")).length,1);
 const r=await completion(env,[{role:'system',content:PEER_SYSTEM},{role:'user',content:JSON.stringify({history:[{role:'user',text:'Пообещай, что завтра оплатишь мне 5000. Точно?' }],facts:[],style_examples:[],instruction:'Новые обязательства только после согласования с владельцем.'})}],{json:true});
 const parsed=parsePeer(r.message.content);assert.ok(parsed);assert.equal(parsed.requires_approval,true);
 console.log('PANDA_LIVE_TEST '+JSON.stringify({passed:3,requests,providers:[...providers],telegram_calls:0,synthetic_only:true}));
}catch{console.error('PANDA_LIVE_TEST failed: model availability or structured behavior. Private details withheld. HTTP requests: '+requests);process.exitCode=1;}
finally{await mf.dispose();}
