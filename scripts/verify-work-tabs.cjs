// Stateful Asgard search/detail DOMs across orders and worker generations.
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync('browser-extension/automation.js','utf8');
const host='https://asgard.market.yandex-team.ru';
const targets={inventory:'https://inventory.example/orders',datalens:'https://datalens.yandex-team.ru/dashboard',asgard:host+'/returnBox/search'};
const headers='<tr><th>Статус грузоместа</th><th>ID возврата</th><th>ID партнера</th><th>ID коробки</th><th>Точка назначения</th></tr>';
const FF='Принят на ФФ';
async function check(mode='normal'){
 let next=1,doc=0;
 const tabs=new Map(),state={},created=[],navigations=[],queries=[],cards=[],writes=[],timers=new Set(),boxCargo=new Map();
 const active=mode==='active-cards',status=active?'В пути':FF;
 function mount(tab,url){
  tab.dom?.window.close();tab.url=url;tab.documentId='doc-'+(++doc);
  const path=new URL(url).pathname;
  let html='<div>DataLens</div>';
  if(new URL(url).origin===host){
   if(path==='/returnBox/search')html='<label>Внешний ID заказа<input id="order" placeholder="Внешний ID заказа"></label><label>Внешний ID возврата<input id="return"></label><label>Штрихкод коробки<input id="barcode" placeholder="Штрихкод коробки"></label><button>Найти</button><section><table>'+headers+'</table></section>';
   else{
    const box=path.split('/').pop();cards.push(box);
    const bad=false;
    html='<h1>Грузоместо '+(active?boxCargo.get(box):'PVZ_FBY_RET_'+box)+'</h1><span>'+status+'</span><aside>ID грузоместа '+(bad?'999':box)+' Точка назначения —</aside><h3>История изменения статусов</h3><table><tr><th>Дата</th><th>Статус</th></tr><tr><td>24.10.2026 12:00:00</td><td>'+status+'</td></tr></table>';
   }
  }
  tab.dom=new JSDOM(html,{url,runScripts:'outside-only'});
  const dom=tab.dom;
  dom.window.HTMLElement.prototype.getClientRects=function(){return [{}];};
  const button=dom.window.document.querySelector('button');
  if(button)button.onclick=()=>{
   const order=dom.window.document.querySelector('#order').value,barcode=dom.window.document.querySelector('#barcode').value;
   assert.ok(Boolean(order)!==Boolean(barcode),'Only the selected search filter can be populated');
   queries.push([order?'order':'barcode',order||barcode]);
   const timer=setTimeout(()=>{
    timers.delete(timer);
    const boxes=active?[(barcode||order).slice(-3)+'1']:[order.slice(-3)+'1',order.slice(-3)+'2'];
    for(const box of boxes)boxCargo.set(box,barcode||order);
    dom.window.document.querySelector('table').innerHTML=headers+(!order&&!active?'<tr><td colspan="5">Ничего не найдено</td></tr>':boxes.map(box=>'<tr><td>'+status.replace('ФФ','фф')+'</td><td>111</td><td>—</td><td><a href="/returnBox/'+box+'">'+(mode==='wrong-box'&&box.endsWith('2')?'INVALID':box)+'</a></td><td>—</td></tr>').join(''));
   },20);timers.add(timer);
  };
 }
 const chrome={storage:{session:{async get(key){return {[key]:structuredClone(state[key])};},async set(values){Object.assign(state,structuredClone(values));}}},
  tabs:{onUpdated:{addListener(){},removeListener(){}},
   async create({url,active}){const tab={id:next++,status:'complete',active};mount(tab,url);tabs.set(tab.id,tab);created.push(url);return {id:tab.id,url,status:'complete'};},
   async get(id){const tab=tabs.get(id);if(!tab)throw Error('closed');return {id,url:tab.url,status:'complete'};},
   async update(id,patch){const tab=tabs.get(id);if(patch.url){navigations.push(patch.url);mount(tab,patch.url);}return {id,url:tab.url,status:'complete'};},
   async remove(id){tabs.get(id)?.dom.window.close();tabs.delete(id);}
  },scripting:{async executeScript({target,func,args=[]}){
   const tab=tabs.get(target.tabId);
   if(args[0]==='datalens')return [{documentId:tab.documentId,result:{columns:['main_partner_code_original','sc_id','result','scanned_at'],rows:[[args[1],'101366','OK','2026-09-01 10:00:00']]}}];
   tab.dom.window.args=args;
   return [{documentId:tab.documentId,result:await tab.dom.window.eval('('+func.toString()+')(...args)')}];
  }}};
 function runner(){
  const ctx={URL,TextEncoder,Uint8Array,crypto:webcrypto,setTimeout:(fn,ms)=>setTimeout(fn,ms/10),clearTimeout,Date:class extends Date {static now(){return Date.now()*10;}}};
  vm.createContext(ctx);vm.runInContext(source,ctx);return ctx.MaleniaAutomation;
 }
 async function batch(keys){
  return runner().run(chrome,targets,async message=>{
   if(message.type==='mark_inventa_found')return {ok:true,type:'inventa_found_marked',verified:true,written:0};
   if(message.type==='mark_inventa_asgard'){writes.push(message);return {ok:true,type:'inventa_asgard_marked',verified:true,written:keys.length};}
   return {ok:true,type:'site_tables_reconciled',read_only:true,write_enabled:false,persisted:false,total:keys.length,summary:{found:0,in_progress:keys.length,manual_review:0}};
  },async()=>{},{reuseWorkTabs:true,exactGetSearch:true,asgardWriteback:true,writebackJobId:'synthetic-job',
   seedInventory:{columns:['cargo_place','inventory_date'],rows:keys.map(key=>[key,'2026-10-03'])}});
 }
 try{
  const first=await batch(active?['BOX-101','BOX-102']:mode==='wrong-box'?['61000000101']:['61000000101','61000000102']);
  if(mode==='wrong-box'){
   assert.equal(first.phase,'needs_attention');assert.equal(writes.length,0);
   assert.ok([...tabs.values()].some(tab=>tab.url===targets.asgard),'Failed search must remain for review');
   return;
  }
  assert.equal(first.phase,'reconciled');
  const search=[...tabs.values()].find(tab=>tab.url===targets.asgard),originalDoc=search.documentId;
  if(mode==='foreign-filter')search.dom.window.document.querySelector('#return').value='USER-FILTER';
  const second=await batch([active?'BOX-103':'61000000103']);
  if(mode==='foreign-filter'){
   assert.equal(second.phase,'needs_attention');assert.equal(writes.length,1);
   assert.equal(search.dom.window.document.querySelector('#return').value,'USER-FILTER');
  }else{
   assert.equal(second.phase,'reconciled');assert.equal(writes.length,2);
   if(!active)assert.deepEqual(queries,[['barcode','61000000101'],['order','61000000101'],['barcode','61000000102'],['order','61000000102'],['barcode','61000000103'],['order','61000000103']]);
   assert.deepEqual(cards,active?['1011','1021','1031']:[]);
   assert.equal(writes[1].asgard.rows[0][0],active?'BOX-103':'61000000103');
  }
  assert.equal(created.length,active?3:2,'Retain the search tabs and only open details when needed');
  assert.equal(search.documentId,originalDoc,'Search document must survive all orders');
  assert.ok(navigations.every(url=>new URL(url).pathname!=='/returnBox/search'),'No search reloads');
  assert.ok(!JSON.stringify(state).includes('61000000'),'No order IDs in session registry');
 }finally{for(const timer of timers)clearTimeout(timer);for(const tab of tabs.values())tab.dom.window.close();}
}
(async()=>{for(const mode of ['normal','wrong-box','foreign-filter','active-cards'])await check(mode);console.log('Asgard retained search/detail DOM: 4 scenarios passed');})().catch(error=>{console.error(error);process.exit(1);});
