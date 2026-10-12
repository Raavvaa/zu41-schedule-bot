import {dispatch,reserveQueue} from '../src/dispatch.mjs';
import {countedDB} from './budget.mjs';
// Local workerd-only test entry. This file is NEVER the deployed Worker entry.
import worker,{webhook} from '../src/index.mjs';
import {parseWeek,parseGroups,getSchedule,catalog} from '../src/source.mjs';
import {planningTick,planUser,deliveryTick,refreshTick,deliverJob} from '../src/scheduler.mjs';
import {one} from '../src/core.mjs';
export default {async fetch(req,env,ctx){
 const stats={queries:0,read:0,written:0};env={...env,DB:countedDB(env.DB,stats)};
 const url=new URL(req.url);
 if(url.pathname==='/test/parse')return Response.json(await parseWeek(new Response(await req.text()),url.searchParams.get('group')));
 if(url.pathname==='/test/catalog'){const gs=await catalog(env,Number(url.searchParams.get('now')));return Response.json({count:gs.length,hasExample:gs.some(g=>g.id===63)});}
 if(url.pathname==='/test/groups')return Response.json(await parseGroups(new Response(await req.text())));
 if(url.pathname==='/test/webhook')return webhook(req,env,Number(url.searchParams.get('now')));
 if(url.pathname==='/test/dispatch'){const queued=[];env.TICKS={sendBatch:async batch=>queued.push(...batch)};await dispatch(env,Number(url.searchParams.get('now')));return Response.json({queued:queued.length,budget:stats});}
 if(url.pathname==='/test/reserve'){return Response.json({reserved:await reserveQueue(env,Number(url.searchParams.get('n')),Number(url.searchParams.get('now')))});}
 if(url.pathname==='/test/tick'){
  const b=await req.json();
  if(b.type==='plan')await planningTick(env,b.lane,b.now);
  if(b.type==='deliver')await deliveryTick(env,b.lane,b.now);
  if(b.type==='refresh')await refreshTick(env,b.lane,b.now);
  return Response.json({ok:true,budget:stats});
 }
 if(url.pathname==='/test/source')return Response.json(await getSchedule(env,Number(url.searchParams.get('group')),url.searchParams.get('date'),Number(url.searchParams.get('now')),{force:true}));
 return worker.fetch(req,env,ctx);
}};
