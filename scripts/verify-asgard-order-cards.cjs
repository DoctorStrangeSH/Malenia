// Exact external-order fallback, using synthetic DOM pages only.
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('browser-extension/automation.js','utf8');
const host='https://asgard.market.yandex-team.ru',code='61000000001';
const FF='Принят на ФФ';
const headers='<tr><th>Статус грузоместа</th><th>ID возврата</th><th>ID партнера</th><th>ID коробки</th><th>Дата создания</th><th>Дата обновления</th><th>Точка назначения</th></tr>';
async function check(options={}){
 let dom,timer,clicks=[],visited=[];
 const count=options.limit?21:4;
 const ids=Array.from({length:count},(_,i)=>String(501+i));
 const statuses=ids.map((_,i)=>options.mixed&&i===3?'В пути':FF);
 const page=(html,path)=>{
  dom?.window.close();
  dom=new JSDOM(html,{url:host+path,runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.getClientRects=function(){return [{}];};
 };
 function searchPage(){
  page('<label>Внешний ID заказа<input id="order" placeholder="Внешний ID заказа"></label><label>Внешний ID возврата<input></label><label>Штрихкод коробки<input id="barcode" placeholder="Штрихкод коробки"></label><button>Найти</button><section><table>'+headers+'</table></section>','/returnBox/search');
  dom.window.document.querySelector('button').onclick=()=>{
   const kind=dom.window.document.querySelector('#order').value?'order':'barcode';
   const value=dom.window.document.querySelector('#'+kind).value;
   clicks.push([kind,value]);
   timer=setTimeout(()=>{
    if(options.unrelated&&kind==='order'){dom.window.document.body.append(dom.window.document.createElement('aside'));return;}
    if(options.inputReset&&kind==='order')dom.window.document.querySelector('#order').value='61000000002';
    const empty=(kind==='barcode'&&!options.barcodeForeign)||options.emptyOrder;
    dom.window.document.querySelector('table').innerHTML=headers+(empty?'<tr><td colspan="7">Ничего не найдено</td></tr>':ids.map((id,i)=>'<tr><td>'+statuses[i].replace('ФФ','фф')+'</td><td>111</td><td>—</td><td><a href="'+(options.badOrigin&&kind==='order'?'https://other.invalid':'')+'/returnBox/'+(options.duplicate&&i===3?'501':id)+'">'+(options.duplicate&&i===3?'501':id)+'</a></td><td>01.09.2026</td><td>24.10.2026</td><td>'+(options.mixedDestination&&i===3?'Купишуз':'—')+'</td></tr>').join(''));
   },20);
  };
 }
 searchPage();
 const chrome={tabs:{
  async get(){return {url:dom.window.location.href,status:'complete'};},
  async update(tab,{url}){
   if(new URL(url).pathname==='/returnBox/search'){searchPage();return;}
   const id=new URL(url).pathname.split('/').pop();
   visited.push(id);
   const index=ids.indexOf(id),current=options.statusMismatch&&id==='504'?'Выдан':FF;
   const box=options.boxMismatch&&id==='504'?'999':id;
   const destination=options.mixedDestination&&id==='504'?'Купишуз':'—';
   const cargo=options.exactCargo?code:'PVZ_FBY_RET_'+(700+index);
   const history=options.historyMissing&&id==='504'?'Создан':FF;
   page('<h1>Грузоместо '+cargo+'</h1><span>'+current+'</span><aside>ID грузоместа '+box+' Точка назначения '+destination+'</aside><h3>История изменения статусов</h3><table><tr><th>Дата</th><th>Статус</th></tr><tr><td>24.10.2026 17:28:44</td><td>'+history+'</td></tr></table>',new URL(url).pathname);
  },
  onUpdated:{addListener(){},removeListener(){}}
 },scripting:{async executeScript({func,args,world}){
  assert.equal(world,'ISOLATED');dom.window.args=args;
  return [{result:await dom.window.eval('('+func.toString()+')(...args)')}];
 }}};
 const ctx={URL,setTimeout:(fn,ms)=>setTimeout(fn,ms/10),clearTimeout,Date:{now:()=>Date.now()*10}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 try{
  const search=()=>ctx.MaleniaAutomation.workplaceSearch(chrome,1,'asgard',code,host,true);
  if(options.mixed||options.boxMismatch||options.statusMismatch||options.historyMissing||options.duplicate||options.mixedDestination)
   await assert.rejects(search,/unverified_search_result_identity/);
  else if(options.badOrigin)await assert.rejects(search,/search_origin_mismatch/);
  else if(options.limit)await assert.rejects(search,/unmapped_search_results/);
  else if(options.unrelated||options.inputReset)await assert.rejects(search,/search_results_unconfirmed/);
  else{
   const result=await search();
   assert.equal(result.rows.length,1);
   assert.equal(result.rows[0][0],code);
   assert.equal(result.rows[0][1],options.emptyOrder?'Не найден':FF);
   assert.equal(result.rows[0][5],options.emptyOrder?'not_found':'card');
   if(!options.emptyOrder){
    assert.equal(result.rows[0][2],'501');
    assert.deepEqual(Array.from(visited.slice(-4)),ids,'Every linked FF card must be opened');
   }
  }
  assert.deepEqual(clicks,options.exactCargo?[['barcode',code]]:[['barcode',code],['order',code]]);
 }finally{clearTimeout(timer);dom.window.close();}
}
const scenarios=[{}, {barcodeForeign:true}, {barcodeForeign:true,exactCargo:true},
 {emptyOrder:true},{mixed:true},{boxMismatch:true},{statusMismatch:true},
 {historyMissing:true},{mixedDestination:true},{duplicate:true},{badOrigin:true},{limit:true},{unrelated:true},{inputReset:true}];
(async()=>{for(const scenario of scenarios)await check(scenario);console.log('Asgard external-order DOM: '+scenarios.length+' scenarios passed');})().catch(error=>{console.error(error);process.exit(1);});
