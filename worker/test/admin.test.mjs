import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminResponse,isOwner,isAdminCommand} from '../src/admin.mjs';
const owner={user_id:1001,chat_id:1001,text:'/admin stats'};
const env={ADMIN_ENABLED:'true',OWNER_CHAT_ID:'1001',DB:{prepare(){throw new Error('Unauthorized DB access');}}};
test('admin guard is fail-closed before any database read',async()=>{
 for(const e of [{...env,OWNER_CHAT_ID:undefined},{...env,OWNER_CHAT_ID:''},{...env,OWNER_CHAT_ID:'not-an-id'},{...env,OWNER_CHAT_ID:'-1001'},{...env,ADMIN_ENABLED:'false'},{...env,ADMIN_ENABLED:undefined}]){
  assert.equal(isOwner(e,owner),false);assert.equal(await adminResponse(e,owner,Date.now()),'⛔ Доступ запрещён.');
 }
 assert.equal(await adminResponse(env,{...owner,user_id:1002},Date.now()),'⛔ Доступ запрещён.');
 assert.equal(await adminResponse(env,{...owner,chat_id:1002},Date.now()),'⛔ Доступ запрещён.');
 assert.equal(isOwner(env,owner),true);
});
test('only command text activates admin; names and guessed callback roles do not',()=>{
 assert.equal(isAdminCommand('/admin'),true);assert.equal(isAdminCommand('/admin@net_5b0_bot status'),true);
 assert.equal(isAdminCommand('/administrator'),false);assert.equal(isAdminCommand('admin'),false);
});
