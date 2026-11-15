// NODE_PATH=<directory containing jsdom> node scripts/verify-asgard-cards.cjs
// Synthetic source pages only; no corporate login or production identifiers.
const {JSDOM}=require('jsdom');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('browser-extension/automation.js','utf8');
const READY='Готов для отгрузки в заборную логистику';
async function check({empty=false,foreign=false,mismatch=false,duplicate=false,company=false,
 foreignTransit=false,serviceError=false,ready=false,wasIssued=false,multipleIssued=false,foreignGroup=false}={}){
 const host='https://asgard.market.yandex-team.ru';let dom,clicks=0,visited=[],renderTimer;
 const active=ready?READY:'В пути',dest=company?'Склад ООО "Купишуз"':'Склад партнера';
 function page(html,url){
  dom?.window.close();dom=new JSDOM(html,{url:host+url,runScripts:'outside-only'});
  dom.window.HTMLElement.prototype.getClientRects=function(){return [{}];};
 }
 const headers='<tr><th>Статус грузоместа</th><th>ID возврата</th><th>ID партнера</th><th>ID коробки</th><th>Точка назначения</th></tr>';
 page('<label>Штрихкод коробки<input></label><button>Найти</button><table>'+headers+'</table>','/returnBox/search');
 const statuses=foreign&&!foreignGroup?[active]:['Выдан',active,...(duplicate?[active]:multipleIssued?['Выдан']:[])];
 dom.window.document.querySelector('button').onclick=()=>{
  clicks++;
  if(serviceError){const el=dom.window.document.createElement('div');el.setAttribute('role','alert');el.textContent='Ошибка загрузки';dom.window.document.body.append(el);return;}
  renderTimer=setTimeout(()=>dom.window.document.querySelector('table').innerHTML=headers+(empty?'<tr><td colspan="5">Ничего не найдено</td></tr>':
   statuses.map((status,i)=>`<tr><td>${status}</td><td>111</td><td>222</td><td><a href="/returnBox/${100+i}">${100+i}</a></td><td>${dest}</td></tr>`).join('')),50);
 };
 const chrome={tabs:{
  async update(id,{url}){
   visited.push(url);const cardId=url.split('/').pop(),box=mismatch?'999':cardId;
   const cardStatus=statuses[Number(cardId)-100];
   const other=foreign||(foreignTransit&&cardId==='101');
   const history=[cardStatus,'Принят у отправителя',...(wasIssued?['Выдан']:[])];
   page(`<h1>Грузоместо ${other?'OTHER':'TEST-1'}</h1><span>${cardStatus}</span><aside>ID грузоместа ${box} Точка назначения ${dest}</aside>
    <section><h3>История изменения статусов</h3><table><tr><th>Дата</th><th>Статус</th></tr>
    ${history.map(s=>`<tr><td>23.09.2026 08:18:51</td><td>${s}</td></tr>`).join('')}</table></section>`,new URL(url).pathname);
  },
  async get(){return {status:'complete',url:dom.window.location.href};},
  onUpdated:{addListener(){},removeListener(){}}
 },scripting:{async executeScript({func,args,world}){
  assert.equal(world,'ISOLATED');dom.window.args=args;
  return [{result:await dom.window.eval('('+func.toString()+')(...args)')}];
 }}};
 const ctx={URL,setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(source,ctx);
 const search=()=>ctx.MaleniaAutomation.workplaceSearch(chrome,7,'asgard','TEST-1',host,true);
 try{
  if(serviceError)await assert.rejects(search,/search_results_unconfirmed/);
  else if((foreign&&!foreignGroup)||mismatch||duplicate)await assert.rejects(search,/unverified_search_result_identity/);
  else{
   const table=await search(),row=table.rows[0];assert.equal(row[0],'TEST-1');
   assert.equal(row[5],empty?'not_found':company?'search_destination':foreignGroup?'issued_group':'card');
   if(foreignGroup){assert.equal(row[1],'Выдан');assert.equal(row[2],'');}
   else if(company&&!empty){assert.equal(row[1],'Купишуз');assert.equal(visited.length,0);}
   else if(!empty){
    const expectedStatus=foreignTransit?'Выдан':active;
    assert.equal(row[2],foreignTransit?'100':'101');assert.equal(row[1],expectedStatus);
    assert.deepEqual(JSON.parse(row[4]),[expectedStatus,'Принят у отправителя',...(wasIssued?['Выдан']:[])]);
   }
  }
  assert.equal(clicks,1);
  if(!foreign&&!foreignTransit)assert.ok(visited.every(url=>!url.endsWith('/100')),'Issued neighbour was opened');
 }finally{clearTimeout(renderTimer);dom.window.close();}
}
const scenarios=[{},{empty:true},{foreign:true},{mismatch:true},{duplicate:true},{company:true},
 {foreignTransit:true},{serviceError:true},{ready:true},{ready:true,wasIssued:true},
 {wasIssued:true},{foreignTransit:true,multipleIssued:true},{company:true,ready:true},{foreign:true,foreignGroup:true}];
(async()=>{for(const scenario of scenarios)await check(scenario);console.log(`Asgard DOM integration: ${scenarios.length} scenarios passed`);})().catch(error=>{console.error(error);process.exit(1);});
