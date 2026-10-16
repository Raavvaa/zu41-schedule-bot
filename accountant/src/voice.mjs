import {run} from './ledger.mjs';
export const VOICE_MODEL='whisper-large-v3-turbo';
const MAX_BYTES=2*1024*1024;
export function voiceAllowed(v){return v&&typeof v.file_id==='string'&&/^[A-Za-z0-9_-]{1,512}$/.test(v.file_id)&&Number.isFinite(v.duration)&&v.duration>0&&v.duration<=90&&(!v.file_size||Number.isSafeInteger(v.file_size)&&v.file_size>0&&v.file_size<=MAX_BYTES);}
export function recognized(d){
 const text=typeof d.text==='string'?d.text.trim():'';
 if(!text||text.length>2000||!Array.isArray(d.segments)||!d.segments.length)throw Error('voice_unclear');
 if(d.segments.some(s=>!Number.isFinite(s.no_speech_prob)||!Number.isFinite(s.avg_logprob)||s.no_speech_prob>0.6||s.avg_logprob < -1||s.compression_ratio>2.4))throw Error('voice_unclear');
 return text;
}
async function limitedBody(response){
 if(!response.ok||Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('voice_download');
 const reader=response.body.getReader(),parts=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw Error('voice_large');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
 if(!size)throw Error('voice_unclear');return new Blob(parts,{type:'audio/ogg'});
}
export async function transcribe(env,v,now){
 if(!voiceAllowed(v))throw Error('voice_large');
 const day='voice:'+new Date(now+10800000).toISOString().slice(0,10);
 const b=await run(env,'INSERT INTO budgets(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<20',day);
 if(!b.meta.changes||!env.GROQ_API_KEY)throw Error('voice_limit');
 try{
 const r=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getFile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file_id:v.file_id}),redirect:'manual',signal:AbortSignal.timeout(4000)});
 const f=await r.json(),p=f.result?.file_path;
 if(!r.ok||!f.ok||typeof p!=='string'||!/^voice\/[A-Za-z0-9_-]+\.(?:oga|ogg|opus)$/.test(p)||Number(f.result.file_size)>MAX_BYTES)throw Error('voice_download');
 const audio=await limitedBody(await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+p,{redirect:'manual',signal:AbortSignal.timeout(5000)}));
 const form=new FormData();form.set('file',audio,'voice.ogg');form.set('model',VOICE_MODEL);form.set('language','ru');form.set('response_format','verbose_json');form.set('temperature','0');
 const a=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+env.GROQ_API_KEY},body:form,redirect:'manual',signal:AbortSignal.timeout(14000)});
 if(a.status===429)throw Error('voice_limit');if(!a.ok)throw Error('voice_unavailable');return recognized(await a.json());
 }catch(e){if(['voice_limit','voice_large','voice_unclear'].includes(e.message))throw e;throw Error('voice_unavailable');}
}
export function voiceError(e){return e.message==='voice_large'?'Пришли голосовое до 90 секунд и 2 МБ, брат.':e.message==='voice_limit'?'Брат, достигнут лимит распознавания. Попробуй позже или напиши текстом. Ничего не записано.':e.message==='voice_unclear'?'Не смог уверенно разобрать речь. Запиши ещё раз без шума или напиши текстом — суммы угадывать не буду.':'Не удалось распознать голосовое. Попробуй позже или напиши текстом. Деньги не изменены.';}
