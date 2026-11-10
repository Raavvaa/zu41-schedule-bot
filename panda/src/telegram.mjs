export class TelegramError extends Error{constructor(code,{retry=0,uncertain=false}={}){super('telegram_'+code);this.code=String(code);this.retry=retry;this.uncertain=uncertain;}}
export async function telegram(env,method,body){
 const call=env.FETCH||fetch;let r,d;
 try{r=await call('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{method:'POST',headers:body instanceof FormData?{}:{'content-type':'application/json'},body:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(6500)});d=await r.json();}catch{throw new TelegramError('network',{uncertain:true});}
 if(!r.ok||!d.ok)throw new TelegramError(d.error_code||r.status,{retry:Number(d.parameters?.retry_after)||0,uncertain:r.status>=500});
 return d.result;
}
export async function setAvatar(env,payload){
 const connection=payload.business_connection_id,file=await telegram(env,'getFile',{file_id:payload.file_id});
 if(!file.file_path||file.file_size>5*1024*1024||!/^photos\/[A-Za-z0-9_./-]+$/.test(file.file_path)||file.file_path.includes('..'))throw new TelegramError('photo_format');
 let r;try{r=await (env.FETCH||fetch)('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+file.file_path,{signal:AbortSignal.timeout(6000)});}catch{throw new TelegramError('photo_download');}
 if(!r.ok)throw new TelegramError('photo_download');const data=await r.arrayBuffer();if(data.byteLength>5*1024*1024)throw new TelegramError('photo_size');
 const form=new FormData();form.set('business_connection_id',connection);form.set('photo',JSON.stringify({type:'static',photo:'attach://image'}));form.set('image',new Blob([data],{type:'image/jpeg'}),'avatar.jpg');
 return telegram(env,'setBusinessAccountProfilePhoto',form);
}
