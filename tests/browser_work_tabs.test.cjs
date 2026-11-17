const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync('browser-extension/automation.js','utf8');
const targets={inventory:'https://inventory.example/orders',
 datalens:'https://datalens.yandex-team.ru/dashboard',asgard:'https://asgard.market.yandex-team.ru/returnBox/search'};
function runner(){
 const ctx={URL,TextEncoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout};
 vm.createContext(ctx);vm.runInContext(source,ctx);return ctx.MaleniaAutomation;
}
function fixture(){
 let next=10,serial=0;
 const tabs=new Map([[1,{id:1,url:targets.datalens,status:'complete',documentId:'user-document'}]]);
 const state={},created=[],removed=[],updates=[],queries=[];
 const mode={found:false,error:false,block:false,started:null};
 const chrome={storage:{session:{async get(key){return {[key]:structuredClone(state[key])};},async set(value){Object.assign(state,structuredClone(value));}}},
  tabs:{onUpdated:{addListener(){},removeListener(){}},
   async create({url,active}){const tab={id:next++,url,active,status:'complete',documentId:'document-'+(++serial)};tabs.set(tab.id,tab);created.push(tab.id);return {...tab};},
   async get(id){if(!tabs.has(id))throw Error('closed');return {...tabs.get(id)};},
   async update(id,patch){const tab=tabs.get(id);if(!tab)throw Error('closed');updates.push({id,...patch});Object.assign(tab,patch);if(patch.url)tab.documentId='document-'+(++serial);return {...tab};},
   async remove(id){removed.push(id);tabs.delete(id);}
  },scripting:{async executeScript({target,func,args}){
   const tab=tabs.get(target.tabId);assert.ok(tab);
   if(func.toString().includes('workOrigin'))return [{documentId:tab.documentId,result:{workOrigin:new URL(tab.url).origin}}];
   const [role,key]=args;queries.push({id:tab.id,role,key});
   if(mode.block){mode.started?.();return new Promise(()=>{});}
   if(mode.error)return [{result:{error:'search_results_unconfirmed'}}];
   return [{result:role==='datalens'?{
    columns:['main_partner_code_original','sc_id','result','scanned_at'],
    rows:[[key,'101366','OK',mode.found?'2026-10-05 10:00:00':'2026-09-01 10:00:00']]
   }:{columns:['cargo_place','status'],rows:[[key,'Выдан']]}}];
  }}};
 return {chrome,tabs,state,created,removed,updates,queries,mode};
}
async function run(api,f,keys,extra={}){
 return api.run(f.chrome,targets,async message=>message.type==='reconcile_site_tables'?{
  ok:true,type:'site_tables_reconciled',read_only:true,write_enabled:false,persisted:false,
  total:keys.length,summary:{found:0,in_progress:0,manual_review:keys.length}
 }:{},async()=>{},{exactGetSearch:true,reuseWorkTabs:true,
  seedInventory:{columns:['cargo_place','inventory_date'],rows:keys.map(key=>[key,'2026-10-03'])},...extra});
}
test('one work tab per service survives orders, batches and worker recreation',async()=>{
 const f=fixture();
 assert.equal((await run(runner(),f,['BOX-A','BOX-B','BOX-C'])).phase,'reconciled');
 assert.equal(f.created.length,2);assert.equal(f.removed.length,0);
 assert.equal((await run(runner(),f,['BOX-D','BOX-E'])).phase,'reconciled');
 assert.equal(f.created.length,2);assert.equal(f.removed.length,0);
 for(const role of ['datalens','asgard'])assert.equal(new Set(f.queries.filter(q=>q.role===role).map(q=>q.id)).size,1);
 assert.equal(f.updates.filter(u=>u.url).length,0,'Search pages must not be reloaded between orders');
 assert.ok(f.tabs.has(1),'Existing user tab must never be borrowed');
 assert.ok(!f.queries.some(q=>q.id===1));
 const saved=JSON.stringify(f.state);
 assert.ok(!saved.includes('BOX-'));assert.ok(!saved.includes('2026-09-01'));
});
test('closed work tab is recreated, while the other service tab is reused',async()=>{
 const f=fixture(),api=runner();await run(api,f,['BOX-A']);
 const old=f.created[0];f.tabs.delete(old);
 await run(api,f,['BOX-B']);assert.equal(f.created.length,3);assert.equal(f.removed.length,0);
});
test('manual full navigation or SPA route change relinquishes the old work tab',async()=>{
 for(const full of [false,true]){
  const f=fixture(),api=runner();await run(api,f,['BOX-A']);
  const old=f.created[0],tab=f.tabs.get(old),count=f.queries.length;
  if(full)tab.documentId='manually-reloaded-document';else tab.url+='?manual=1';
  await run(api,f,['BOX-B']);
  assert.equal(f.created.length,3);assert.ok(f.tabs.has(old));assert.ok(!f.removed.includes(old));
  assert.ok(!f.queries.slice(count).some(q=>q.id===old));
 }
});
test('failure page stays open and the next explicit run reuses it',async()=>{
 const f=fixture(),api=runner();f.mode.error=true;
 const result=await run(api,f,['BOX-A']);
 assert.equal(result.phase,'needs_attention');assert.equal(result.results.at(-1).review_available,true);
 assert.equal(f.created.length,1);assert.equal(f.removed.length,0);
 f.mode.error=false;await run(api,f,['BOX-A']);
 assert.equal(f.created.length,2);assert.equal(f.removed.length,0);
});
test('cancellation adopts and closes only work tabs used by the current job',async()=>{
 const f=fixture(),api=runner();await run(api,f,['BOX-A']);
 const controller=new AbortController();
 const entered=new Promise(resolve=>{f.mode.started=resolve;});
 f.mode.block=true;
 const task=run(api,f,['BOX-B'],{signal:controller.signal,checkActive:async()=>true});
 await entered;controller.abort('audit_cancelled');
 await assert.rejects(task,/audit_cancelled/);
 assert.ok(f.removed.includes(f.created[0]));
 assert.ok(f.tabs.has(f.created[1]),'Unused Asgard work tab must remain');
 assert.ok(f.tabs.has(1));
 f.mode.block=false;await run(api,f,['BOX-C']);
 assert.equal(f.created.length,3);
});
test('confirmed post-inventory scans never create an Asgard work tab',async()=>{
 const f=fixture();f.mode.found=true;
 await run(runner(),f,['BOX-A','BOX-B']);
 assert.equal(f.created.length,1);assert.ok(f.queries.every(q=>q.role==='datalens'));
});
