// One synthetic request. No D1, Telegram, or production prompt data.
import {workersChat} from '../src/model-provider.mjs';
const {FREE_PLAN_CONFIRMED,CLOUDFLARE_ACCOUNT_ID:id,CLOUDFLARE_API_TOKEN:token}=process.env;
let status=null,ok=false;
try{
 if(FREE_PLAN_CONFIRMED!=='true'||!(/^[a-f0-9]{32}$/i.test(id??''))||!token)throw Error('configuration');
 const reply=await workersChat({async run(model,body){
  const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${id}/ai/run/${model}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
  status=res.status;
  if(!res.ok)throw Error('unavailable');
  const data=await res.json();if(!data.success)throw Error('unavailable');return data.result;
 }},'Ответь одним словом: привет.',8000);
 ok=typeof reply==='string'&&/привет/iu.test(reply);
}catch{}
console.log(JSON.stringify({event:'workers_ai_probe',ok,status,synthetic:true}));
if(!ok)process.exitCode=1;
